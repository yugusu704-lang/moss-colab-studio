"""Google Drive integration for MOSS-Image Studio (rclone OAuth + local folder mode)."""

from __future__ import annotations

import asyncio
import configparser
import json
import os
import re
import shutil
import time
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Callable
from urllib.parse import parse_qsl, urlencode, urljoin, urlparse, urlunparse

import aiohttp

DEFAULT_GDRIVE_TARGET_DIR = "ComfyUI_Data/models/loras"
DEFAULT_COLAB_NOTEBOOK_REMOTE = "Colab Notebooks/MOSS_Studio_Colab.ipynb"
DEFAULT_DRIVE_DATA_ROOT = "ComfyUI_Data"
COLAB_ENDPOINT_FILENAME = ".moss_studio_endpoint.json"
ALLOWED_MODEL_EXTS = (".safetensors", ".pth", ".pt", ".ckpt")
_UNSAFE_FILENAME_RE = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_AUTH_URL_RE = re.compile(r"https?://127\.0\.0\.1:\d+/auth\S*")
_PCT_RE = re.compile(r"(\d+(?:\.\d+)?)%")
_SPEED_RE = re.compile(r"(\d+(?:\.\d+)?)\s*(KiB|MiB|GiB|kB|MB|GB|B)/s", re.IGNORECASE)


def find_rclone(base_dir: Path | None = None) -> str | None:
    """Locate rclone executable in local bin/, PATH, or WinGet installation dirs."""
    module_dir = Path(__file__).resolve().parent
    candidates: list[Path] = [module_dir / "bin" / "rclone.exe"]
    if base_dir is not None:
        candidates.append(Path(base_dir) / "bin" / "rclone.exe")

    for cand in candidates:
        if cand.is_file():
            return str(cand)

    which_path = shutil.which("rclone")
    if which_path:
        return which_path

    local_app = os.environ.get("LOCALAPPDATA", "")
    if local_app:
        winget_link = Path(local_app) / "Microsoft" / "WinGet" / "Links" / "rclone.exe"
        if winget_link.is_file():
            return str(winget_link)
        pkg_root = Path(local_app) / "Microsoft" / "WinGet" / "Packages"
        if pkg_root.is_dir():
            for match in pkg_root.glob("Rclone.Rclone*/*/rclone.exe"):
                if match.is_file():
                    return str(match)
            for match in pkg_root.glob("Rclone.Rclone*/rclone.exe"):
                if match.is_file():
                    return str(match)

    return None


def _normalize_proxy_url(raw: str) -> str | None:
    val = (raw or "").strip()
    if not val:
        return None
    if "://" not in val:
        val = f"http://{val}"
    parsed = urlparse(val)
    if parsed.scheme in ("http", "https", "socks4", "socks5", "socks5h") and parsed.netloc:
        return val
    return None


def get_proxy_env() -> dict[str, str]:
    """Return environment dict including Windows system proxy settings if unset."""
    env = dict(os.environ)
    has_http = bool(env.get("HTTP_PROXY") or env.get("http_proxy"))
    has_https = bool(env.get("HTTPS_PROXY") or env.get("https_proxy"))
    if has_http and has_https:
        return env

    try:
        sys_proxies = urllib.request.getproxies()
    except Exception:
        sys_proxies = {}

    http_proxy = _normalize_proxy_url(sys_proxies.get("http", ""))
    https_proxy = _normalize_proxy_url(sys_proxies.get("https", "")) or http_proxy

    if not has_http and http_proxy:
        env["HTTP_PROXY"] = http_proxy
        env["http_proxy"] = http_proxy
    if not has_https and https_proxy:
        env["HTTPS_PROXY"] = https_proxy
        env["https_proxy"] = https_proxy
    return env


def get_aiohttp_proxy() -> str | None:
    """Return an HTTP/HTTPS proxy URL usable by aiohttp, or None."""
    env = get_proxy_env()
    for key in ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"):
        cand = _normalize_proxy_url(env.get(key, ""))
        if cand and cand.startswith(("http://", "https://")):
            return cand
    return None


def sanitize_target_dir(raw: str) -> str:
    """Normalize a Google Drive relative folder path and prevent traversal."""
    cleaned = str(raw or "").strip().replace("\\", "/").strip("/")
    if not cleaned:
        return DEFAULT_GDRIVE_TARGET_DIR
    parts: list[str] = []
    for part in cleaned.split("/"):
        seg = part.strip()
        if not seg:
            continue
        if seg in (".", "..") or ":" in seg:
            raise ValueError("目标目录路径不能包含 '..'、'.' 或盘符")
        parts.append(seg)
    if not parts:
        return DEFAULT_GDRIVE_TARGET_DIR
    return "/".join(parts)


def sanitize_filename(raw: str) -> str:
    """Validate and sanitize a model filename."""
    text = str(raw or "").strip().replace("\\", "/")
    base = text.split("/")[-1].strip()
    cleaned = _UNSAFE_FILENAME_RE.sub("_", base).strip(". ")
    if not cleaned or cleaned in (".", "..") or ".." in cleaned:
        raise ValueError("文件名不合法")
    if not any(cleaned.lower().endswith(ext) for ext in ALLOWED_MODEL_EXTS):
        raise ValueError(f"仅支持模型文件格式: {', '.join(ALLOWED_MODEL_EXTS)}")
    return cleaned


def _load_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _save_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def _speed_to_mbps(value: float, unit: str) -> float:
    u = unit.lower()
    if u in ("kib", "kb"):
        return round(value / 1024.0, 2)
    if u in ("mib", "mb"):
        return round(value, 2)
    if u in ("gib", "gb"):
        return round(value * 1024.0, 2)
    if u == "b":
        return round(value / (1024.0 * 1024.0), 4)
    return 0.0


class GDriveManager:
    """Manages Google Drive mounting (rclone OAuth or local folder) and direct model transfers."""

    def __init__(
        self,
        data_dir: Path,
        config_path: Path,
        http_getter: Callable[[], aiohttp.ClientSession] | None = None,
        base_dir: Path | None = None,
    ) -> None:
        self.data_dir = Path(data_dir)
        self.config_path = Path(config_path)
        self.base_dir = Path(base_dir) if base_dir else Path(__file__).resolve().parent.parent
        self.rclone_conf_path = self.data_dir / "rclone.conf"
        self.tmp_dir = self.data_dir / "tmp_downloads"
        self._http_getter = http_getter
        self.tasks: dict[str, dict[str, Any]] = {}
        self._task_handles: dict[str, asyncio.Task[None]] = {}
        self._task_procs: dict[str, asyncio.subprocess.Process] = {}
        self._auth_proc: asyncio.subprocess.Process | None = None
        self._auth_task: asyncio.Task[None] | None = None
        self._auth_state: dict[str, Any] = {
            "state": "idle",
            "auth_url": "",
            "error": "",
        }
        self._rclone_version_cache: str | None = None

    def get_config(self) -> dict[str, str]:
        """Load persisted Google Drive settings with safe defaults."""
        cfg = _load_json(self.config_path)
        mode = str(cfg.get("gdrive_mode") or "rclone").strip().lower()
        if mode not in ("rclone", "local"):
            mode = "rclone"
        try:
            target_dir = sanitize_target_dir(str(cfg.get("gdrive_target_dir") or ""))
        except ValueError:
            target_dir = DEFAULT_GDRIVE_TARGET_DIR
        local_dir = str(cfg.get("gdrive_local_dir") or "").strip()
        return {
            "mode": mode,
            "target_dir": target_dir,
            "local_dir": local_dir,
        }

    def update_config(
        self,
        *,
        mode: str | None = None,
        target_dir: str | None = None,
        local_dir: str | None = None,
    ) -> dict[str, str]:
        """Validate and persist Google Drive settings into config.json."""
        cfg = _load_json(self.config_path)
        if mode is not None:
            norm_mode = str(mode).strip().lower()
            if norm_mode not in ("rclone", "local"):
                raise ValueError("挂载模式仅支持 rclone 或 local")
            cfg["gdrive_mode"] = norm_mode
        if target_dir is not None:
            cfg["gdrive_target_dir"] = sanitize_target_dir(target_dir)
        elif "gdrive_target_dir" not in cfg:
            cfg["gdrive_target_dir"] = DEFAULT_GDRIVE_TARGET_DIR
        if local_dir is not None:
            cfg["gdrive_local_dir"] = str(local_dir).strip()
        _save_json(self.config_path, cfg)
        return self.get_config()

    def is_rclone_configured(self) -> bool:
        """Check whether rclone.conf contains a non-empty [gdrive] token."""
        if not self.rclone_conf_path.is_file():
            return False
        parser = configparser.ConfigParser(interpolation=None)
        try:
            parser.read(self.rclone_conf_path, encoding="utf-8")
        except (configparser.Error, OSError):
            return False
        if not parser.has_section("gdrive"):
            return False
        token = parser.get("gdrive", "token", fallback="").strip()
        return bool(token)

    def _write_rclone_token(self, token_json_str: str) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        parser = configparser.ConfigParser(interpolation=None)
        if self.rclone_conf_path.is_file():
            try:
                parser.read(self.rclone_conf_path, encoding="utf-8")
            except (configparser.Error, OSError):
                parser = configparser.ConfigParser(interpolation=None)
        if not parser.has_section("gdrive"):
            parser.add_section("gdrive")
        parser.set("gdrive", "type", "drive")
        parser.set("gdrive", "scope", "drive")
        parser.set("gdrive", "token", token_json_str)
        tmp = self.rclone_conf_path.with_suffix(".conf.tmp")
        with tmp.open("w", encoding="utf-8") as fh:
            parser.write(fh)
        tmp.replace(self.rclone_conf_path)

    async def _run_rclone(
        self,
        args: list[str],
        *,
        timeout_sec: float = 20.0,
        use_config: bool = True,
    ) -> tuple[int, str, str]:
        rclone_exe = find_rclone(self.base_dir)
        if not rclone_exe:
            raise RuntimeError("未找到 rclone，请先安装 rclone")
        cmd = [rclone_exe]
        if use_config:
            cmd.extend(["--config", str(self.rclone_conf_path)])
        cmd.extend(args)
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=get_proxy_env(),
        )
        try:
            stdout_b, stderr_b = await asyncio.wait_for(proc.communicate(), timeout=timeout_sec)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            raise RuntimeError("rclone 命令执行超时，请检查网络连接或代理设置")
        return (
            proc.returncode or 0,
            stdout_b.decode("utf-8", errors="ignore"),
            stderr_b.decode("utf-8", errors="ignore"),
        )

    async def get_rclone_version(self) -> str:
        if self._rclone_version_cache:
            return self._rclone_version_cache
        try:
            rc, out, _ = await self._run_rclone(["version"], timeout_sec=5.0, use_config=False)
            if rc == 0 and out.strip():
                self._rclone_version_cache = out.strip().splitlines()[0].strip()
                return self._rclone_version_cache
        except Exception:
            pass
        return ""

    async def get_quota(self) -> dict[str, float] | None:
        """Query Google Drive storage quota via rclone about."""
        if not find_rclone(self.base_dir) or not self.is_rclone_configured():
            return None
        try:
            rc, out, _ = await self._run_rclone(["about", "gdrive:", "--json"], timeout_sec=25.0)
        except Exception:
            return None
        if rc != 0 or not out.strip():
            return None
        try:
            data = json.loads(out)
        except json.JSONDecodeError:
            return None
        gb = float(1024 ** 3)
        total = data.get("total")
        used = data.get("used")
        free = data.get("free")
        if total is None and used is None and free is None:
            return None
        return {
            "total_gb": round(float(total) / gb, 1) if total is not None else 0.0,
            "used_gb": round(float(used) / gb, 1) if used is not None else 0.0,
            "free_gb": round(float(free) / gb, 1) if free is not None else 0.0,
        }

    async def get_status(self, include_quota: bool = True) -> dict[str, Any]:
        """Return full Google Drive status for the frontend UI."""
        rclone_path = find_rclone(self.base_dir)
        cfg = self.get_config()
        mode = cfg["mode"]
        local_dir = cfg["local_dir"]
        rclone_ready = bool(rclone_path and self.is_rclone_configured())
        local_ready = bool(local_dir and Path(local_dir).is_dir())

        mounted = rclone_ready if mode == "rclone" else local_ready
        quota: dict[str, float] | None = None
        if include_quota and mode == "rclone" and rclone_ready:
            quota = await self.get_quota()
        elif mode == "local" and local_ready:
            try:
                usage = shutil.disk_usage(local_dir)
                gb = float(1024 ** 3)
                quota = {
                    "total_gb": round(usage.total / gb, 1),
                    "used_gb": round(usage.used / gb, 1),
                    "free_gb": round(usage.free / gb, 1),
                }
            except OSError:
                quota = None

        rclone_version = ""
        if rclone_path:
            rclone_version = await self.get_rclone_version()

        return {
            "rclone_installed": bool(rclone_path),
            "rclone_path": rclone_path or "",
            "rclone_version": rclone_version,
            "mode": mode,
            "mounted": mounted,
            "rclone_configured": rclone_ready,
            "target_dir": cfg["target_dir"],
            "local_dir": local_dir,
            "quota": quota,
            "auth": dict(self._auth_state),
        }

    async def _terminate_auth_proc(self) -> None:
        proc = self._auth_proc
        self._auth_proc = None
        if proc is not None and proc.returncode is None:
            try:
                proc.terminate()
                await asyncio.wait_for(proc.wait(), timeout=2.5)
            except asyncio.TimeoutError:
                proc.kill()
                await proc.wait()
            except ProcessLookupError:
                pass
        task = self._auth_task
        self._auth_task = None
        if task is not None and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    async def start_auth(self) -> dict[str, Any]:
        """Launch rclone browser OAuth flow and return current auth state."""
        rclone_exe = find_rclone(self.base_dir)
        if not rclone_exe:
            raise RuntimeError("未检测到 rclone，请确认 rclone.exe 已安装")

        await self._terminate_auth_proc()
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self._auth_state = {"state": "pending", "auth_url": "", "error": ""}

        proc = await asyncio.create_subprocess_exec(
            rclone_exe,
            "authorize",
            "drive",
            "--config",
            str(self.rclone_conf_path),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=get_proxy_env(),
        )
        self._auth_proc = proc

        async def _watch_auth() -> None:
            stdout_lines: list[str] = []
            stderr_lines: list[str] = []

            async def _read_stream(
                stream: asyncio.StreamReader | None, bucket: list[str]
            ) -> None:
                if stream is None:
                    return
                while True:
                    line_b = await stream.readline()
                    if not line_b:
                        break
                    line = line_b.decode("utf-8", errors="ignore").rstrip("\r\n")
                    bucket.append(line)
                    url_match = _AUTH_URL_RE.search(line)
                    if url_match and not self._auth_state["auth_url"]:
                        self._auth_state["auth_url"] = url_match.group(0)

            try:
                await asyncio.wait_for(
                    asyncio.gather(
                        _read_stream(proc.stdout, stdout_lines),
                        _read_stream(proc.stderr, stderr_lines),
                        proc.wait(),
                    ),
                    timeout=300.0,
                )
            except asyncio.TimeoutError:
                if proc.returncode is None:
                    proc.kill()
                    await proc.wait()
                self._auth_state = {
                    "state": "error",
                    "auth_url": self._auth_state.get("auth_url", ""),
                    "error": "Google Drive 浏览器授权超时（超过 5 分钟），请重试。",
                }
                self._auth_proc = None
                return
            except asyncio.CancelledError:
                return

            self._auth_proc = None
            token_compact = ""
            joined_out = "\n".join(stdout_lines)
            for line in stdout_lines:
                s = line.strip()
                if s.startswith("{") and "access_token" in s:
                    try:
                        parsed_tok = json.loads(s)
                        if isinstance(parsed_tok, dict) and parsed_tok.get("access_token"):
                            token_compact = json.dumps(parsed_tok, separators=(",", ":"))
                            break
                    except json.JSONDecodeError:
                        pass
            if not token_compact:
                json_match = re.search(r"\{[^{}]*\"access_token\"[^{}]*\}", joined_out)
                if json_match:
                    try:
                        parsed_tok = json.loads(json_match.group(0))
                        if isinstance(parsed_tok, dict) and parsed_tok.get("access_token"):
                            token_compact = json.dumps(parsed_tok, separators=(",", ":"))
                    except json.JSONDecodeError:
                        pass

            if proc.returncode == 0 and token_compact:
                self._write_rclone_token(token_compact)
                self.update_config(mode="rclone")
                await self.get_quota()
                self._auth_state = {
                    "state": "authorized",
                    "auth_url": self._auth_state.get("auth_url", ""),
                    "error": "",
                }
            else:
                err_tail = " | ".join(
                    [l for l in stderr_lines[-4:] if l.strip()]
                )[:240]
                self._auth_state = {
                    "state": "error",
                    "auth_url": self._auth_state.get("auth_url", ""),
                    "error": err_tail or f"授权未完成 (退出码 {proc.returncode})",
                }

        self._auth_task = asyncio.create_task(_watch_auth())

        # Briefly wait for rclone to emit the local OAuth callback URL.
        for _ in range(15):
            if self._auth_state["auth_url"] or self._auth_state["state"] != "pending":
                break
            await asyncio.sleep(0.1)

        return dict(self._auth_state)

    def get_auth_status(self) -> dict[str, Any]:
        return dict(self._auth_state)

    async def cancel_auth(self) -> dict[str, Any]:
        await self._terminate_auth_proc()
        self._auth_state = {"state": "idle", "auth_url": "", "error": ""}
        return dict(self._auth_state)

    async def disconnect(self) -> dict[str, Any]:
        """Remove saved rclone [gdrive] credentials and reset auth state."""
        await self._terminate_auth_proc()
        if self.rclone_conf_path.is_file():
            parser = configparser.ConfigParser(interpolation=None)
            try:
                parser.read(self.rclone_conf_path, encoding="utf-8")
                if parser.has_section("gdrive"):
                    parser.remove_section("gdrive")
                    if parser.sections():
                        with self.rclone_conf_path.open("w", encoding="utf-8") as fh:
                            parser.write(fh)
                    else:
                        self.rclone_conf_path.unlink(missing_ok=True)
            except (configparser.Error, OSError):
                self.rclone_conf_path.unlink(missing_ok=True)
        self._auth_state = {"state": "idle", "auth_url": "", "error": ""}
        return await self.get_status(include_quota=False)

    async def list_loras(self, target_dir: str | None = None) -> list[dict[str, Any]]:
        """List model files currently stored in the configured Google Drive target folder."""
        cfg = self.get_config()
        mode = cfg["mode"]
        resolved_target = sanitize_target_dir(
            target_dir if target_dir is not None else cfg["target_dir"]
        )

        if mode == "local":
            local_dir = cfg["local_dir"]
            if not local_dir or not Path(local_dir).is_dir():
                raise RuntimeError("本地 Google Drive 目标目录不存在或未设置")
            root = Path(local_dir)
            items: list[dict[str, Any]] = []
            for entry in root.iterdir():
                if entry.is_file() and entry.name.lower().endswith(ALLOWED_MODEL_EXTS):
                    st = entry.stat()
                    items.append(
                        {
                            "name": entry.name,
                            "size_mb": round(st.st_size / (1024 * 1024), 1),
                            "mod_time": time.strftime(
                                "%Y-%m-%d %H:%M:%S", time.localtime(st.st_mtime)
                            ),
                        }
                    )
            items.sort(key=lambda x: x["name"].lower())
            return items

        if not self.is_rclone_configured():
            raise RuntimeError("尚未挂载 Google Drive，请先完成浏览器授权")

        rc, out, err = await self._run_rclone(
            ["lsjson", f"gdrive:{resolved_target}", "--files-only"],
            timeout_sec=25.0,
        )
        if rc != 0:
            low_err = err.lower()
            if rc == 3 or "directory not found" in low_err or "not found" in low_err:
                return []
            raise RuntimeError(err.strip()[:240] or f"rclone lsjson 失败 (退出码 {rc})")

        try:
            raw_list = json.loads(out or "[]")
        except json.JSONDecodeError:
            return []

        items = []
        for entry in raw_list:
            if not isinstance(entry, dict) or entry.get("IsDir"):
                continue
            name = str(entry.get("Name") or "").strip()
            if not name or not name.lower().endswith(ALLOWED_MODEL_EXTS):
                continue
            size_b = int(entry.get("Size") or 0)
            mod_t = str(entry.get("ModTime") or "")[:19].replace("T", " ")
            items.append(
                {
                    "name": name,
                    "size_mb": round(size_b / (1024 * 1024), 1),
                    "mod_time": mod_t,
                }
            )
        items.sort(key=lambda x: x["name"].lower())
        return items

    def _get_session(self) -> aiohttp.ClientSession:
        if self._http_getter is not None:
            return self._http_getter()
        return aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=1800.0))

    async def _download_http_to_file(
        self,
        task: dict[str, Any],
        url: str,
        dest_file: Path,
        civitai_token: str,
        hf_token: str,
    ) -> None:
        parsed = urlparse(url)
        host = (parsed.hostname or "").lower()
        cur_url = url
        if (host == "civitai.com" or host.endswith(".civitai.com")) and civitai_token:
            qp = dict(parse_qsl(parsed.query))
            if "token" not in qp:
                qp["token"] = civitai_token
                cur_url = urlunparse(parsed._replace(query=urlencode(qp)))

        own_session = self._http_getter is None
        session = self._get_session()
        proxy = get_aiohttp_proxy()
        dl_timeout = aiohttp.ClientTimeout(total=None, sock_connect=30.0, sock_read=120.0)

        def _headers_for_url(target_url: str) -> dict[str, str]:
            hdrs = {"User-Agent": "MOSS-Image-Studio/1.0"}
            thost = (urlparse(target_url).hostname or "").lower()
            if (thost == "huggingface.co" or thost.endswith(".huggingface.co") or thost == "hf.co") and hf_token:
                hdrs["Authorization"] = f"Bearer {hf_token}"
            elif (thost == "civitai.com" or thost.endswith(".civitai.com")) and civitai_token:
                hdrs["Authorization"] = f"Bearer {civitai_token}"
            return hdrs

        resp: aiohttp.ClientResponse | None = None
        try:
            for _ in range(10):
                resp = await session.get(
                    cur_url,
                    headers=_headers_for_url(cur_url),
                    allow_redirects=False,
                    proxy=proxy,
                    timeout=dl_timeout,
                )
                if resp.status in (301, 302, 303, 307, 308):
                    loc = resp.headers.get("Location")
                    await resp.release()
                    resp = None
                    if not loc:
                        raise RuntimeError("下载链接重定向缺少目标地址")
                    cur_url = urljoin(cur_url, loc)
                    continue
                break

            if resp is None:
                raise RuntimeError("下载重定向次数过多")

            try:
                if resp.status in (401, 403):
                    raise RuntimeError(
                        f"下载被拒绝 (HTTP {resp.status})，请检查 Civitai API Key 或模型访问权限"
                    )
                if resp.status != 200:
                    body_snip = (await resp.text(errors="ignore"))[:200]
                    raise RuntimeError(f"下载失败 (HTTP {resp.status}): {body_snip}")

                ctype = (resp.headers.get("Content-Type") or "").lower()
                if "text/html" in ctype:
                    raise RuntimeError(
                        "返回了网页而非模型文件，请检查 Civitai API Key 是否有效或链接是否正确"
                    )

                total_bytes = int(resp.headers.get("Content-Length") or 0)
                if total_bytes > 0:
                    task["total_mb"] = round(total_bytes / (1024 * 1024), 1)

                dest_file.parent.mkdir(parents=True, exist_ok=True)
                downloaded = 0
                start_t = time.monotonic()
                last_t = start_t
                last_bytes = 0

                with dest_file.open("wb") as fh:
                    async for chunk in resp.content.iter_chunked(1024 * 1024):
                        fh.write(chunk)
                        downloaded += len(chunk)
                        now = time.monotonic()
                        dt = now - last_t
                        if dt >= 0.4 or (total_bytes and downloaded >= total_bytes):
                            mb_done = round(downloaded / (1024 * 1024), 1)
                            task["downloaded_mb"] = mb_done
                            if total_bytes > 0:
                                task["percent"] = round(
                                    min(99.9, (downloaded / total_bytes) * 100.0), 1
                                )
                            if dt > 0:
                                task["speed_mbps"] = round(
                                    ((downloaded - last_bytes) / (1024 * 1024)) / dt, 2
                                )
                            task["stage_text"] = (
                                f"正在下载到本地缓存 {mb_done:.1f}"
                                + (f" / {task['total_mb']:.1f} MB" if task["total_mb"] else " MB")
                            )
                            last_t = now
                            last_bytes = downloaded

                if downloaded <= 0:
                    raise RuntimeError("下载文件为空 (0 字节)")
                task["downloaded_mb"] = round(downloaded / (1024 * 1024), 1)
                if not task["total_mb"]:
                    task["total_mb"] = task["downloaded_mb"]
            finally:
                await resp.release()
        finally:
            if own_session and not session.closed:
                await session.close()

    async def _upload_to_rclone(
        self, task_id: str, task: dict[str, Any], src_file: Path, target_dir: str, filename: str
    ) -> None:
        rclone_exe = find_rclone(self.base_dir)
        if not rclone_exe:
            raise RuntimeError("未找到 rclone")

        # Ensure remote directory exists (ignore benign errors; copyto also creates parents).
        try:
            await self._run_rclone(["mkdir", f"gdrive:{target_dir}"], timeout_sec=15.0)
        except Exception:
            pass

        task["status"] = "uploading"
        task["percent"] = 0.0
        task["speed_mbps"] = 0.0
        task["stage_text"] = f"正在上传到 Google Drive ({target_dir})..."

        proc = await asyncio.create_subprocess_exec(
            rclone_exe,
            "--config",
            str(self.rclone_conf_path),
            "copyto",
            str(src_file),
            f"gdrive:{target_dir}/{filename}",
            "--drive-chunk-size",
            "64M",
            "--stats=1s",
            "--stats-one-line",
            "-v",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=get_proxy_env(),
        )
        self._task_procs[task_id] = proc
        err_lines: list[str] = []

        try:
            if proc.stderr is not None:
                while True:
                    line_b = await proc.stderr.readline()
                    if not line_b:
                        break
                    line = line_b.decode("utf-8", errors="ignore").strip()
                    if not line:
                        continue
                    err_lines.append(line)
                    if len(err_lines) > 20:
                        err_lines.pop(0)
                    pct_m = _PCT_RE.search(line)
                    if pct_m:
                        raw_pct = float(pct_m.group(1))
                        if raw_pct >= 100.0:
                            task["percent"] = 99.5
                            task["speed_mbps"] = 0.0
                            task["stage_text"] = "正在等待 Google Drive 校验落盘..."
                        else:
                            shown_pct = min(99.0, raw_pct)
                            task["percent"] = round(shown_pct, 1)
                            spd_m = _SPEED_RE.search(line)
                            if spd_m:
                                task["speed_mbps"] = _speed_to_mbps(
                                    float(spd_m.group(1)), spd_m.group(2)
                                )
                            else:
                                task["speed_mbps"] = 0.0
                            task["stage_text"] = (
                                f"正在上传到 Google Drive ({int(shown_pct)}%)"
                            )
            await proc.wait()
        finally:
            self._task_procs.pop(task_id, None)

        if proc.returncode != 0:
            err_msg = " | ".join(err_lines[-3:])[:240]
            raise RuntimeError(err_msg or f"rclone 上传失败 (退出码 {proc.returncode})")

    async def start_download(
        self,
        url: str,
        filename: str,
        *,
        target_dir: str | None = None,
        civitai_token: str = "",
        hf_token: str = "",
    ) -> dict[str, Any]:
        """Queue an async download-then-upload transfer of a LoRA to Google Drive."""
        clean_url = str(url or "").strip()
        parsed = urlparse(clean_url)
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            raise ValueError("请输入有效的 http/https 模型下载直链")

        safe_name = sanitize_filename(filename)
        cfg = self.get_config()
        mode = cfg["mode"]
        resolved_target = sanitize_target_dir(
            target_dir if target_dir is not None else cfg["target_dir"]
        )
        local_dir = cfg["local_dir"]

        if mode == "rclone":
            if not find_rclone(self.base_dir):
                raise RuntimeError("未检测到 rclone，请先确认 rclone 已安装")
            if not self.is_rclone_configured():
                raise RuntimeError("尚未挂载 Google Drive，请先点击顶部「Google Drive」完成授权")
        else:
            if not local_dir or not Path(local_dir).is_dir():
                raise RuntimeError("本地 Google Drive 目录不存在，请检查挂载设置")

        task_id = uuid.uuid4().hex[:12]
        task: dict[str, Any] = {
            "task_id": task_id,
            "filename": safe_name,
            "target_dir": local_dir if mode == "local" else resolved_target,
            "mode": mode,
            "status": "downloading",
            "percent": 0.0,
            "downloaded_mb": 0.0,
            "total_mb": 0.0,
            "speed_mbps": 0.0,
            "stage_text": "准备下载...",
            "error": "",
        }
        self.tasks[task_id] = task

        async def _worker() -> None:
            task_tmp_dir = self.tmp_dir / task_id
            tmp_file = task_tmp_dir / safe_name
            try:
                await self._download_http_to_file(
                    task, clean_url, tmp_file, civitai_token, hf_token
                )
                if mode == "local":
                    task["status"] = "uploading"
                    task["percent"] = 50.0
                    task["stage_text"] = "正在保存到本地 Drive 目录..."
                    dst_dir = Path(local_dir)
                    dst_dir.mkdir(parents=True, exist_ok=True)
                    dst_file = dst_dir / safe_name
                    await asyncio.to_thread(shutil.move, str(tmp_file), str(dst_file))
                else:
                    await self._upload_to_rclone(
                        task_id, task, tmp_file, resolved_target, safe_name
                    )
                task["status"] = "completed"
                task["percent"] = 100.0
                task["speed_mbps"] = 0.0
                task["stage_text"] = f"已保存到 Google Drive ({task['target_dir']})"
            except asyncio.CancelledError:
                task["status"] = "failed"
                task["error"] = "用户已取消下载"
                task["stage_text"] = "已取消"
            except Exception as exc:
                task["status"] = "failed"
                task["error"] = str(exc)[:300]
                task["stage_text"] = "下载失败"
            finally:
                self._task_handles.pop(task_id, None)
                shutil.rmtree(task_tmp_dir, ignore_errors=True)

        self._task_handles[task_id] = asyncio.create_task(_worker())
        return dict(task)

    def get_download_status(self, task_id: str) -> dict[str, Any] | None:
        t = self.tasks.get(task_id)
        return dict(t) if t is not None else None

    async def cancel_download(self, task_id: str) -> dict[str, Any] | None:
        task = self.tasks.get(task_id)
        if task is None:
            return None
        proc = self._task_procs.pop(task_id, None)
        if proc is not None and proc.returncode is None:
            try:
                proc.terminate()
            except ProcessLookupError:
                pass
        handle = self._task_handles.pop(task_id, None)
        if handle is not None and not handle.done():
            handle.cancel()
            try:
                await handle
            except asyncio.CancelledError:
                pass
        task["status"] = "failed"
        task["error"] = "用户已取消下载"
        task["stage_text"] = "已取消"
        return dict(task)

    async def cleanup(self) -> None:
        """Cancel active auth or transfer tasks on server shutdown."""
        await self._terminate_auth_proc()
        for tid in list(self._task_handles.keys()):
            await self.cancel_download(tid)

    def get_colab_config(self) -> dict[str, str]:
        """Load persisted Colab Notebook URL and remote path."""
        cfg = _load_json(self.config_path)
        colab_url = str(cfg.get("colab_url") or "").strip()
        notebook_remote = str(
            cfg.get("colab_notebook_remote") or DEFAULT_COLAB_NOTEBOOK_REMOTE
        ).strip()
        try:
            notebook_remote = sanitize_target_dir(notebook_remote)
        except ValueError:
            notebook_remote = DEFAULT_COLAB_NOTEBOOK_REMOTE
        if not notebook_remote.lower().endswith(".ipynb"):
            notebook_remote = DEFAULT_COLAB_NOTEBOOK_REMOTE
        return {
            "colab_url": colab_url,
            "colab_notebook_remote": notebook_remote,
        }

    def update_colab_config(
        self,
        *,
        colab_url: str | None = None,
        notebook_remote: str | None = None,
    ) -> dict[str, str]:
        """Validate and persist Colab Notebook URL and remote path in config.json."""
        cfg = _load_json(self.config_path)
        if colab_url is not None:
            clean_url = str(colab_url).strip()
            if clean_url:
                parsed = urlparse(clean_url)
                if parsed.scheme not in ("http", "https") or not parsed.netloc:
                    raise ValueError("Colab 链接必须以 http:// 或 https:// 开头")
            cfg["colab_url"] = clean_url
        if notebook_remote is not None:
            norm_remote = sanitize_target_dir(notebook_remote)
            if not norm_remote.lower().endswith(".ipynb"):
                raise ValueError("云盘 Notebook 路径必须以 .ipynb 结尾")
            cfg["colab_notebook_remote"] = norm_remote
        elif "colab_notebook_remote" not in cfg:
            cfg["colab_notebook_remote"] = DEFAULT_COLAB_NOTEBOOK_REMOTE
        _save_json(self.config_path, cfg)
        return self.get_colab_config()

    def _derive_drive_data_root(self) -> str:
        target_dir = self.get_config()["target_dir"]
        if "/models/" in target_dir:
            prefix = target_dir.split("/models/", 1)[0].strip("/")
            if prefix:
                return prefix
        if target_dir.endswith("/models"):
            prefix = target_dir[: -len("/models")].strip("/")
            if prefix:
                return prefix
        return DEFAULT_DRIVE_DATA_ROOT

    async def list_colab_notebooks(self) -> list[dict[str, Any]]:
        """List .ipynb notebooks in Google Drive's Colab Notebooks directory."""
        if not self.is_rclone_configured():
            raise RuntimeError("尚未挂载 Google Drive，请先完成浏览器授权")

        rc, out, err = await self._run_rclone(
            ["lsjson", "gdrive:Colab Notebooks", "--files-only"],
            timeout_sec=25.0,
        )
        if rc != 0:
            low_err = err.lower()
            if rc == 3 or "directory not found" in low_err or "not found" in low_err:
                return []
            raise RuntimeError(err.strip()[:240] or f"读取 Colab Notebooks 目录失败 (退出码 {rc})")

        try:
            raw_list = json.loads(out or "[]")
        except json.JSONDecodeError:
            return []

        items: list[dict[str, Any]] = []
        for entry in raw_list:
            if not isinstance(entry, dict) or entry.get("IsDir"):
                continue
            name = str(entry.get("Name") or "").strip()
            file_id = str(entry.get("ID") or "").strip()
            if not name or not name.lower().endswith(".ipynb") or not file_id:
                continue
            size_b = int(entry.get("Size") or 0)
            mod_t = str(entry.get("ModTime") or "")[:19].replace("T", " ")
            items.append(
                {
                    "id": file_id,
                    "name": name,
                    "remote_path": f"Colab Notebooks/{name}",
                    "size_kb": round(size_b / 1024.0, 1),
                    "mod_time": mod_t,
                    "colab_url": f"https://colab.research.google.com/drive/{file_id}",
                }
            )
        items.sort(key=lambda x: x["mod_time"], reverse=True)
        return items

    async def sync_colab_notebook(
        self,
        local_ipynb: Path,
        remote_path: str | None = None,
    ) -> dict[str, Any]:
        """Upload local Notebook to Google Drive and bind its direct Colab URL."""
        src = Path(local_ipynb)
        if not src.is_file():
            raise RuntimeError(f"未找到本地 Notebook 文件: {src}")
        if not self.is_rclone_configured():
            raise RuntimeError("尚未挂载 Google Drive，请先完成浏览器授权")

        target_remote = sanitize_target_dir(
            remote_path or self.get_colab_config()["colab_notebook_remote"]
        )
        if not target_remote.lower().endswith(".ipynb"):
            raise ValueError("云盘 Notebook 路径必须以 .ipynb 结尾")

        rc, _, err = await self._run_rclone(
            ["copyto", str(src), f"gdrive:{target_remote}", "-v"],
            timeout_sec=45.0,
        )
        if rc != 0:
            raise RuntimeError(err.strip()[:240] or f"上传 Notebook 到云盘失败 (退出码 {rc})")

        rc_ls, out_ls, err_ls = await self._run_rclone(
            ["lsjson", f"gdrive:{target_remote}"],
            timeout_sec=25.0,
        )
        entry: dict[str, Any] | None = None
        if rc_ls == 0 and out_ls.strip():
            try:
                parsed_ls = json.loads(out_ls)
                if isinstance(parsed_ls, list) and parsed_ls and isinstance(parsed_ls[0], dict):
                    entry = parsed_ls[0]
                elif isinstance(parsed_ls, dict):
                    entry = parsed_ls
            except json.JSONDecodeError:
                entry = None

        if entry is None or not entry.get("ID"):
            parent_dir = str(Path(target_remote).parent).replace("\\", "/")
            fname = Path(target_remote).name
            ls_target = f"gdrive:{parent_dir}" if parent_dir and parent_dir != "." else "gdrive:"
            rc_p, out_p, _ = await self._run_rclone(
                ["lsjson", ls_target, "--files-only"],
                timeout_sec=25.0,
            )
            if rc_p == 0 and out_p.strip():
                try:
                    for cand in json.loads(out_p):
                        if isinstance(cand, dict) and cand.get("Name") == fname:
                            entry = cand
                            break
                except json.JSONDecodeError:
                    pass

        if not entry or not entry.get("ID"):
            raise RuntimeError(
                err_ls.strip()[:200] or "Notebook 已上传，但未能读取 Google Drive 文件 ID"
            )

        file_id = str(entry["ID"]).strip()
        name = str(entry.get("Name") or Path(target_remote).name).strip()
        size_b = int(entry.get("Size") or src.stat().st_size)
        mod_t = str(entry.get("ModTime") or "")[:19].replace("T", " ")
        colab_url = f"https://colab.research.google.com/drive/{file_id}"

        self.update_colab_config(colab_url=colab_url, notebook_remote=target_remote)
        return {
            "ok": True,
            "id": file_id,
            "name": name,
            "remote_path": target_remote,
            "colab_url": colab_url,
            "size_kb": round(size_b / 1024.0, 1),
            "mod_time": mod_t,
        }

    async def fetch_colab_endpoint(self) -> dict[str, Any]:
        """Read the live Colab ComfyUI tunnel endpoint written by Cell 4 in Google Drive."""
        cfg = self.get_config()
        raw_text = ""

        if cfg["mode"] == "local":
            local_dir = cfg["local_dir"]
            if not local_dir or not Path(local_dir).is_dir():
                return {
                    "found": False,
                    "status": "none",
                    "comfy_url": "",
                    "message": "本地 Google Drive 目录未挂载或不存在。",
                }
            root = Path(local_dir)
            found_file: Path | None = None
            for cand_dir in [root, *list(root.parents)[:3]]:
                cand = cand_dir / COLAB_ENDPOINT_FILENAME
                if cand.is_file():
                    found_file = cand
                    break
            if found_file is None:
                return {
                    "found": False,
                    "status": "none",
                    "comfy_url": "",
                    "message": "云盘暂未发现 Colab 启动记录，请先在 Colab 运行 Cell 4。",
                }
            try:
                raw_text = found_file.read_text(encoding="utf-8")
            except OSError as exc:
                return {
                    "found": False,
                    "status": "none",
                    "comfy_url": "",
                    "message": f"读取云盘端点文件失败: {exc}",
                }
        else:
            if not self.is_rclone_configured():
                return {
                    "found": False,
                    "status": "none",
                    "comfy_url": "",
                    "message": "尚未挂载 Google Drive，请先完成授权挂载。",
                }
            endpoint_remote = f"{self._derive_drive_data_root()}/{COLAB_ENDPOINT_FILENAME}"
            rc, out, err = await self._run_rclone(
                ["cat", f"gdrive:{endpoint_remote}"],
                timeout_sec=25.0,
            )
            if rc != 0:
                low_err = err.lower()
                if rc == 3 or "not found" in low_err or "object not found" in low_err:
                    return {
                        "found": False,
                        "status": "none",
                        "comfy_url": "",
                        "message": "云盘暂未发现 Colab 启动记录，请先在 Colab 运行 Cell 4。",
                    }
                raise RuntimeError(err.strip()[:240] or f"读取云盘端点失败 (退出码 {rc})")
            raw_text = out

        try:
            data = json.loads(raw_text)
        except json.JSONDecodeError:
            return {
                "found": False,
                "status": "invalid",
                "comfy_url": "",
                "message": "云盘端点记录格式无效，请在 Colab 重新运行 Cell 4。",
            }
        if not isinstance(data, dict) or not str(data.get("comfy_url") or "").strip():
            return {
                "found": False,
                "status": "invalid",
                "comfy_url": "",
                "message": "云盘端点记录缺少 ComfyUI 地址。",
            }

        updated_at = int(data.get("updated_at") or 0)
        return {
            "found": True,
            "comfy_url": str(data.get("comfy_url") or "").strip().rstrip("/"),
            "status": str(data.get("status") or "running").strip().lower(),
            "gpu_name": str(data.get("gpu_name") or "").strip(),
            "tunnel_type": str(data.get("tunnel_type") or "").strip(),
            "started_at": str(data.get("started_at") or "").strip(),
            "updated_at": updated_at,
            "age_sec": max(0, int(time.time() - updated_at)) if updated_at > 0 else 0,
        }
