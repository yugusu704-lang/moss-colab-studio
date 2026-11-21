"""PNG metadata embedding, ComfyUI/WebUI metadata parsing, and WebP thumbnail cache."""

from __future__ import annotations

import io
import json
import os
import re
from pathlib import Path
from typing import Any

from PIL import Image, ImageOps, PngImagePlugin

_LORA_TAG_RE = re.compile(r"<lora:([^:>]+):([0-9.+-]+)>", re.IGNORECASE)
_KV_RE = re.compile(r"([A-Za-z0-9 _/-]+):\s*([^,]+)")


def embed_png_metadata(
    img_bytes: bytes,
    params: dict[str, Any],
    workflow: dict[str, Any] | None = None,
) -> bytes:
    """Embed compact studio params and ComfyUI prompt graph into PNG text chunks."""
    try:
        with Image.open(io.BytesIO(img_bytes)) as im:
            out = im.copy()
            pnginfo = PngImagePlugin.PngInfo()
            pnginfo.add_text(
                "moss_studio",
                json.dumps(params, ensure_ascii=False, separators=(",", ":")),
            )
            if workflow:
                pnginfo.add_text(
                    "prompt",
                    json.dumps(workflow, ensure_ascii=False, separators=(",", ":")),
                )
            buf = io.BytesIO()
            out.save(buf, format="PNG", pnginfo=pnginfo, compress_level=6)
            return buf.getvalue()
    except Exception:
        return img_bytes


def _decode_exif_user_comment(raw: Any) -> str:
    if isinstance(raw, str):
        return raw.strip()
    if not isinstance(raw, (bytes, bytearray)):
        return ""
    b = bytes(raw)
    if b.startswith(b"ASCII\x00\x00\x00"):
        return b[8:].decode("utf-8", errors="ignore").strip("\x00 \r\n")
    if b.startswith(b"UNICODE\x00"):
        payload = b[8:]
        for enc in ("utf-16-be", "utf-16-le", "utf-8"):
            try:
                decoded = payload.decode(enc).strip("\x00 \r\n")
                if decoded:
                    return decoded
            except UnicodeDecodeError:
                continue
    return b.decode("utf-8", errors="ignore").strip("\x00 \r\n")


def _extract_linked_node_id(value: Any) -> str | None:
    if isinstance(value, list) and value and isinstance(value[0], (str, int)):
        return str(value[0])
    return None


def _read_linked_text(nodes: dict[str, Any], node_ref: Any, depth: int = 0) -> str:
    if depth > 6:
        return ""
    nid = _extract_linked_node_id(node_ref)
    if not nid or nid not in nodes:
        return ""
    node = nodes[nid] if isinstance(nodes[nid], dict) else {}
    inputs = node.get("inputs") if isinstance(node.get("inputs"), dict) else {}
    for key in ("text", "prompt", "clip_l", "t5xxl"):
        val = inputs.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    for key in ("conditioning", "positive", "negative"):
        linked = _read_linked_text(nodes, inputs.get(key), depth + 1)
        if linked:
            return linked
    return ""


def _walk_model_chain(nodes: dict[str, Any], start_ref: Any) -> tuple[list[dict[str, Any]], str]:
    loras: list[dict[str, Any]] = []
    unet_name = ""
    visited: set[str] = set()
    cur_ref = start_ref
    while len(visited) < 24:
        nid = _extract_linked_node_id(cur_ref)
        if not nid or nid in visited or nid not in nodes:
            break
        visited.add(nid)
        node = nodes[nid] if isinstance(nodes[nid], dict) else {}
        ctype = str(node.get("class_type") or "")
        inputs = node.get("inputs") if isinstance(node.get("inputs"), dict) else {}
        if "Lora" in ctype or inputs.get("lora_name"):
            lname = str(inputs.get("lora_name") or "").strip()
            strength = inputs.get("strength_model", inputs.get("strength", 1.0))
            if lname:
                try:
                    s_val = float(strength)
                except (TypeError, ValueError):
                    s_val = 1.0
                loras.append({"enabled": True, "name": lname, "strength": s_val})
        if inputs.get("unet_name") and not unet_name:
            unet_name = str(inputs["unet_name"]).strip()
        elif inputs.get("ckpt_name") and not unet_name:
            unet_name = str(inputs["ckpt_name"]).strip()
        cur_ref = inputs.get("model")
    loras.reverse()
    return loras, unet_name


def _parse_comfy_prompt_graph(
    graph: dict[str, Any], img_w: int, img_h: int
) -> dict[str, Any] | None:
    if not isinstance(graph, dict) or not graph:
        return None
    samplers: list[tuple[str, dict[str, Any]]] = []
    clip_name = ""
    vae_name = ""
    latent_w, latent_h = img_w, img_h

    for nid, raw_node in graph.items():
        if not isinstance(raw_node, dict):
            continue
        ctype = str(raw_node.get("class_type") or "")
        inputs = raw_node.get("inputs") if isinstance(raw_node.get("inputs"), dict) else {}
        if "KSampler" in ctype or (
            "positive" in inputs and ("steps" in inputs or "seed" in inputs)
        ):
            samplers.append((str(nid), raw_node))
        if not clip_name and isinstance(inputs.get("clip_name"), str):
            clip_name = inputs["clip_name"].strip()
        if not vae_name and isinstance(inputs.get("vae_name"), str):
            vae_name = inputs["vae_name"].strip()
        if "LatentImage" in ctype:
            if isinstance(inputs.get("width"), int):
                latent_w = inputs["width"]
            if isinstance(inputs.get("height"), int):
                latent_h = inputs["height"]

    if not samplers:
        return None

    # Prefer base pass (denoise == 1.0 or lowest numeric node id) over hires refine pass
    samplers.sort(
        key=lambda item: (
            0 if float(item[1].get("inputs", {}).get("denoise", 1.0) or 1.0) >= 0.99 else 1,
            int(item[0]) if item[0].isdigit() else 999999,
        )
    )
    _, base_node = samplers[0]
    s_inputs = base_node.get("inputs") if isinstance(base_node.get("inputs"), dict) else {}

    positive = _read_linked_text(graph, s_inputs.get("positive"))
    negative = _read_linked_text(graph, s_inputs.get("negative"))
    loras, unet_name = _walk_model_chain(graph, s_inputs.get("model"))

    seed_val = s_inputs.get("seed", s_inputs.get("noise_seed", -1))
    params: dict[str, Any] = {
        "positive": positive,
        "negative": negative,
        "width": latent_w,
        "height": latent_h,
        "steps": int(s_inputs["steps"]) if isinstance(s_inputs.get("steps"), (int, float)) else 16,
        "cfg": float(s_inputs["cfg"]) if isinstance(s_inputs.get("cfg"), (int, float)) else 1.0,
        "seed": int(seed_val) if isinstance(seed_val, (int, float)) else -1,
        "sampler_name": str(s_inputs.get("sampler_name") or "euler"),
        "scheduler": str(s_inputs.get("scheduler") or "normal"),
        "loras": loras,
    }
    if unet_name:
        params["unet_name"] = unet_name
    if clip_name:
        params["clip_name"] = clip_name
    if vae_name:
        params["vae_name"] = vae_name
    return params


def _parse_webui_parameters(text: str, img_w: int, img_h: int) -> dict[str, Any] | None:
    clean = (text or "").strip()
    if not clean:
        return None
    lines = clean.splitlines()
    settings_line = ""
    if lines and re.search(r"\bSteps:\s*\d+", lines[-1]):
        settings_line = lines.pop().strip()

    body = "\n".join(lines).strip()
    neg_split = re.split(r"\nNegative prompt:\s*", body, maxsplit=1)
    positive = neg_split[0].strip()
    negative = neg_split[1].strip() if len(neg_split) > 1 else ""

    loras: list[dict[str, Any]] = []
    for match in _LORA_TAG_RE.finditer(positive):
        lname = match.group(1).strip()
        try:
            strength = float(match.group(2))
        except ValueError:
            strength = 1.0
        loras.append({"enabled": True, "name": lname, "strength": strength})
    positive = _LORA_TAG_RE.sub("", positive)
    positive = re.sub(r"\s*,\s*,\s*", ", ", positive).strip(" ,\n")

    kv: dict[str, str] = {}
    for k, v in _KV_RE.findall(settings_line):
        kv[k.strip().lower()] = v.strip()

    width, height = img_w, img_h
    if "size" in kv and "x" in kv["size"].lower():
        parts = kv["size"].lower().split("x", 1)
        try:
            width = int(parts[0].strip())
            height = int(parts[1].strip())
        except ValueError:
            pass

    params: dict[str, Any] = {
        "positive": positive,
        "negative": negative,
        "width": width,
        "height": height,
        "loras": loras,
    }
    if "steps" in kv:
        try:
            params["steps"] = int(float(kv["steps"]))
        except ValueError:
            pass
    if "cfg scale" in kv:
        try:
            params["cfg"] = float(kv["cfg scale"])
        except ValueError:
            pass
    if "seed" in kv:
        try:
            params["seed"] = int(float(kv["seed"]))
        except ValueError:
            pass
    if "sampler" in kv:
        params["sampler_name"] = kv["sampler"]
    if "schedule type" in kv:
        params["scheduler"] = kv["schedule type"]
    if "model" in kv:
        params["unet_name"] = kv["model"]
    return params


def parse_image_metadata(img_bytes: bytes) -> dict[str, Any]:
    """Extract generation parameters from MOSS-Image Studio PNGs, ComfyUI PNGs, or WebUI parameters."""
    with Image.open(io.BytesIO(img_bytes)) as im:
        width, height = im.size
        info = {str(k): v for k, v in (im.info or {}).items()}
        user_comment = ""
        try:
            exif = im.getexif()
            if exif:
                ifd_exif = exif.get_ifd(0x8769)
                raw_uc = (ifd_exif or {}).get(0x9286) or exif.get(0x9286)
                user_comment = _decode_exif_user_comment(raw_uc)
        except Exception:
            user_comment = ""

    moss_raw = info.get("moss_studio")
    if isinstance(moss_raw, str) and moss_raw.strip():
        try:
            parsed = json.loads(moss_raw)
            if isinstance(parsed, dict):
                return {
                    "source": "moss_studio",
                    "width": width,
                    "height": height,
                    "params": parsed,
                    "raw_text": info.get("prompt") if isinstance(info.get("prompt"), str) else moss_raw,
                }
        except json.JSONDecodeError:
            pass

    prompt_raw = info.get("prompt")
    if isinstance(prompt_raw, str) and prompt_raw.strip():
        try:
            prompt_graph = json.loads(prompt_raw)
            parsed = _parse_comfy_prompt_graph(prompt_graph, width, height)
            if parsed:
                return {
                    "source": "comfyui",
                    "width": width,
                    "height": height,
                    "params": parsed,
                    "raw_text": prompt_raw,
                }
        except json.JSONDecodeError:
            pass

    webui_text = ""
    if isinstance(info.get("parameters"), str) and info["parameters"].strip():
        webui_text = info["parameters"].strip()
    elif user_comment:
        if user_comment.lstrip().startswith("{"):
            try:
                maybe_json = json.loads(user_comment)
                if isinstance(maybe_json, dict):
                    parsed = _parse_comfy_prompt_graph(maybe_json, width, height) or maybe_json
                    return {
                        "source": "comfyui" if "positive" in parsed else "other",
                        "width": width,
                        "height": height,
                        "params": parsed if isinstance(parsed, dict) and "positive" in parsed else None,
                        "raw_text": user_comment,
                    }
            except json.JSONDecodeError:
                pass
        webui_text = user_comment

    if webui_text:
        parsed_webui = _parse_webui_parameters(webui_text, width, height)
        return {
            "source": "webui" if parsed_webui else "other",
            "width": width,
            "height": height,
            "params": parsed_webui,
            "raw_text": webui_text,
        }

    return {
        "source": "none",
        "width": width,
        "height": height,
        "params": None,
        "raw_text": "",
    }


def ensure_webp_thumb(src_path: Path, thumb_path: Path, max_side: int = 380) -> Path:
    """Create or reuse an atomic WebP thumbnail for fast gallery loading."""
    src_mtime = src_path.stat().st_mtime
    if thumb_path.is_file() and thumb_path.stat().st_mtime >= src_mtime:
        return thumb_path

    thumb_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = thumb_path.with_name(thumb_path.name + ".tmp")
    with Image.open(src_path) as im:
        im = ImageOps.exif_transpose(im)
        has_alpha = im.mode in ("RGBA", "LA") or (
            im.mode == "P" and "transparency" in im.info
        )
        converted = im.convert("RGBA" if has_alpha else "RGB")
        converted.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
        converted.save(tmp_path, format="WEBP", quality=82, method=4)
    os.replace(tmp_path, thumb_path)
    return thumb_path
