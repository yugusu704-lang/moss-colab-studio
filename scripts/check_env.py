#!/usr/bin/env python3
"""Environment preflight check for MOSS-Colab-Studio (stdlib-only)."""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import platform
import shutil
import socket
import subprocess
import sys
from pathlib import Path

REQUIRED_PACKAGES = (
    ("aiohttp", "aiohttp"),
    ("numpy", "numpy"),
    ("PIL", "Pillow"),
)

REQUIRED_FILES = (
    "moss_studio/server.py",
    "ComfyUI_Colab_Hybrid.ipynb",
    "requirements.txt",
)


def _rclone_install_hint() -> str:
    sys_name = platform.system().lower()
    if sys_name == "windows":
        return "winget install -e --id Rclone.Rclone"
    if sys_name == "darwin":
        return "brew install rclone"
    return "curl https://rclone.org/install.sh | sudo bash"


def _find_rclone_bin(repo_root: Path) -> tuple[str | None, str]:
    on_path = shutil.which("rclone")
    if on_path:
        return on_path, "PATH"

    ext = ".exe" if platform.system().lower() == "windows" else ""
    bundled = repo_root / "moss_studio" / "bin" / f"rclone{ext}"
    if bundled.is_file():
        return str(bundled), "moss_studio/bin"

    if platform.system().lower() == "windows":
        local_app = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        winget_link = Path(local_app) / "Microsoft" / "WinGet" / "Links" / "rclone.exe"
        if winget_link.is_file():
            return str(winget_link), "winget"

    return None, "missing"


def _get_rclone_version(rclone_exe: str | None) -> str:
    if not rclone_exe:
        return ""
    try:
        res = subprocess.run(
            [rclone_exe, "version"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if res.returncode == 0 and res.stdout.strip():
            return res.stdout.strip().splitlines()[0].strip()
    except Exception:
        pass
    return ""


def _check_port(port: int) -> str:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.6)
        return "listening" if sock.connect_ex(("127.0.0.1", port)) == 0 else "available"


def run_checks(port: int = 7860) -> tuple[dict, bool]:
    repo_root = Path(__file__).resolve().parent.parent
    py_ver = sys.version_info
    py_ok = py_ver >= (3, 10)

    packages = {}
    missing_packages = []
    for mod_name, pip_name in REQUIRED_PACKAGES:
        found = importlib.util.find_spec(mod_name) is not None
        packages[pip_name] = found
        if not found:
            missing_packages.append(pip_name)

    files = {}
    missing_files = []
    for rel in REQUIRED_FILES:
        exists = (repo_root / rel).is_file()
        files[rel] = exists
        if not exists:
            missing_files.append(rel)

    rclone_exe, rclone_source = _find_rclone_bin(repo_root)
    rclone_version = _get_rclone_version(rclone_exe)
    port_status = _check_port(port)

    ready = py_ok and not missing_packages and not missing_files
    report = {
        "ready": ready,
        "platform": platform.system(),
        "python": {
            "version": f"{py_ver.major}.{py_ver.minor}.{py_ver.micro}",
            "ok": py_ok,
            "required": ">=3.10",
        },
        "packages": packages,
        "missing_packages": missing_packages,
        "files": files,
        "missing_files": missing_files,
        "rclone": {
            "available": bool(rclone_exe),
            "source": rclone_source,
            "version": rclone_version,
            "recommended": True,
            "install_command": _rclone_install_hint(),
        },
        "server": {
            "port": port,
            "status": port_status,
            "url": f"http://127.0.0.1:{port}",
            "start_command": "python moss_studio/server.py",
        },
        "next_command": "" if not missing_packages else "pip install -r requirements.txt",
    }
    return report, ready


def _print_human(report: dict) -> None:
    print("MOSS-Colab-Studio Environment Preflight")
    print("=" * 40)
    py = report["python"]
    print(f"Python   : {py['version']} ({'OK' if py['ok'] else 'NEED >= 3.10'})")
    for pkg, ok in report["packages"].items():
        print(f"Package  : {pkg:<10} -> {'OK' if ok else 'MISSING'}")
    for rel, ok in report["files"].items():
        print(f"File     : {rel:<28} -> {'OK' if ok else 'MISSING'}")
    rc = report["rclone"]
    rc_desc = f"OK ({rc['source']}: {rc['version'] or 'installed'})" if rc["available"] else f"NOT FOUND (optional; install via: {rc['install_command']})"
    print(f"rclone   : {rc_desc}")
    srv = report["server"]
    print(f"Port {srv['port']}: {srv['status']} ({srv['url']})")
    print("-" * 40)
    if report["ready"]:
        if srv["status"] == "listening":
            print(f"READY: Server already listening at {srv['url']}")
        else:
            print(f"READY: Start with `{srv['start_command']}` then open {srv['url']}")
    else:
        if report["missing_packages"]:
            print("ACTION: Run `pip install -r requirements.txt`")
        if not py["ok"]:
            print("ACTION: Upgrade to Python 3.10+")
        if report["missing_files"]:
            print(f"ACTION: Missing files: {', '.join(report['missing_files'])}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Preflight check for MOSS-Colab-Studio")
    parser.add_argument("--json", action="store_true", help="Output JSON report")
    parser.add_argument("--port", type=int, default=7860, help="Local server port (default: 7860)")
    args = parser.parse_args()

    report, ready = run_checks(port=args.port)
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        _print_human(report)
    return 0 if ready else 1


if __name__ == "__main__":
    raise SystemExit(main())
