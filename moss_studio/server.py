"""MOSS-Image Studio local web server and ShinobiSat v2 ComfyUI API proxy."""

from __future__ import annotations

import argparse
import asyncio
import base64
from collections import OrderedDict
import io
import ipaddress
import json
import os
import random
import re
import shutil
import socket
import struct
import sys
import time
import uuid
import webbrowser
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

import aiohttp
import numpy as np
from aiohttp import web
from PIL import Image

try:
    from moss_studio.comic_layout import clean_free as clean_comic_layout, compile_comic_prompt
    from moss_studio.gdrive import GDriveManager
    from moss_studio.imgmeta import embed_png_metadata, ensure_webp_thumb, parse_image_metadata
except ImportError:
    from comic_layout import clean_free as clean_comic_layout, compile_comic_prompt
    from gdrive import GDriveManager
    from imgmeta import embed_png_metadata, ensure_webp_thumb, parse_image_metadata

BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = Path(__file__).resolve().parent / "static"
APP_STATE_KEY = web.AppKey("moss_studio_state", dict)

DEFAULT_UNET = "moss_image_sft_int8_convrot.safetensors"
DEFAULT_CLIP = "qwen3.5_9b_int8_convrot.safetensors"
DEFAULT_VAE = "flux2-vae.safetensors"
CIVITAI_CACHE_TTL = 90.0
CIVITAI_CACHE_MAX = 64


def _get_http(state: dict[str, Any]) -> aiohttp.ClientSession:
    """Return shared persistent aiohttp session, lazily creating one in test environments."""
    sess = state.get("http")
    if isinstance(sess, aiohttp.ClientSession) and not sess.closed:
        return sess
    sess = aiohttp.ClientSession(
        connector=aiohttp.TCPConnector(limit=32, ttl_dns_cache=300),
        timeout=aiohttp.ClientTimeout(total=60.0),
    )
    state["http"] = sess
    return sess


def get_lan_ip() -> str:
    """Return a real LAN IPv4 address for mobile/iPad access, skipping VPN/TUN ranges."""
    candidates: list[str] = []
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip_str = info[4][0]
            try:
                ip_obj = ipaddress.ip_address(ip_str)
            except ValueError:
                continue
            if (
                ip_obj.is_loopback
                or ip_obj.is_link_local
                or ip_obj in ipaddress.ip_network("198.18.0.0/15")
            ):
                continue
            if ip_obj.is_private:
                candidates.append(ip_str)
    except OSError:
        pass

    non_hotspot = [ip for ip in candidates if ip != "192.168.137.1"]
    if non_hotspot:
        return non_hotspot[0]
    if candidates:
        return candidates[0]

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("8.8.8.8", 80))
        ip = sock.getsockname()[0]
        if ip and not ip.startswith(("198.18.", "198.19.")):
            return ip
        return "127.0.0.1"
    except OSError:
        return "127.0.0.1"
    finally:
        sock.close()


def normalize_comfy_url(raw_url: str) -> str:
    """Normalize a ComfyUI base URL, stripping whitespace and trailing slashes."""
    url = (raw_url or "").strip().rstrip("/")
    if not url:
        return ""
    if not url.startswith(("http://", "https://")):
        url = "https://" + url
    parsed = urlparse(url)
    if not parsed.netloc:
        return ""
    return f"{parsed.scheme}://{parsed.netloc}{parsed.path}".rstrip("/")


def to_ws_url(comfy_url: str, client_id: str) -> str:
    """Convert an HTTP(S) ComfyUI URL to a WS(S) URL with clientId query."""
    parsed = urlparse(comfy_url)
    ws_scheme = "wss" if parsed.scheme == "https" else "ws"
    base_path = parsed.path.rstrip("/")
    return f"{ws_scheme}://{parsed.netloc}{base_path}/ws?clientId={client_id}"


def snap_multiple_16(value: Any, default: int = 1024, max_dim: int = 2560) -> int:
    """Clamp resolution to [256, max_dim] and snap to a multiple of 16."""
    try:
        num = int(value)
    except (TypeError, ValueError):
        num = default
    num = max(256, min(max_dim, num))
    return max(256, (num // 16) * 16)


def clamp_int(value: Any, low: int, high: int, default: int) -> int:
    try:
        num = int(value)
    except (TypeError, ValueError):
        return default
    return max(low, min(high, num))


def clamp_float(value: Any, low: float, high: float, default: float) -> float:
    try:
        num = float(value)
    except (TypeError, ValueError):
        return default
    return max(low, min(high, num))


def apply_film_grain(
    img_bytes: bytes, intensity: float = 0.022, saturation_mix: float = 0.03
) -> bytes:
    """Apply subtle photographic film grain (FastFilmGrain style) locally with PIL + numpy."""
    strength = clamp_float(intensity, 0.001, 0.2, 0.022)
    sat_mix = clamp_float(saturation_mix, 0.0, 1.0, 0.03)
    with Image.open(io.BytesIO(img_bytes)) as im:
        rgb = im.convert("RGB")
        arr = np.asarray(rgb, dtype=np.float32) / 255.0
        h, w, _ = arr.shape
        rng = np.random.default_rng()
        luma_noise = rng.normal(0.0, strength, (h, w, 1)).astype(np.float32)
        color_noise = rng.normal(0.0, strength, (h, w, 3)).astype(np.float32)
        grain = luma_noise * (1.0 - sat_mix) + color_noise * sat_mix
        luma = np.mean(arr, axis=2, keepdims=True)
        midtone_weight = 1.0 - np.abs(2.0 * luma - 1.0) * 0.4
        out = np.clip(arr + grain * midtone_weight, 0.0, 1.0)
        out_img = Image.fromarray((out * 255.0).round().astype(np.uint8), mode="RGB")
        buf = io.BytesIO()
        out_img.save(buf, format="PNG")
        return buf.getvalue()


def extract_combo_options(
    object_info: dict[str, Any], node_name: str, field_name: str
) -> list[str]:
    """Extract dropdown options across ComfyUI legacy and V3 object_info schemas."""
    if not isinstance(object_info, dict):
        return []
    node_info = object_info.get(node_name)
    if not isinstance(node_info, dict):
        if "input" in object_info:
            node_info = object_info
        else:
            return []

    input_block = node_info.get("input", {})
    spec = None
    for section in ("required", "optional"):
        sec_dict = input_block.get(section)
        if isinstance(sec_dict, dict) and field_name in sec_dict:
            spec = sec_dict[field_name]
            break

    if not isinstance(spec, (list, tuple)) or not spec:
        return []

    raw_options: list[Any] = []
    first = spec[0]
    if isinstance(first, list):
        raw_options = first
    elif first == "COMBO" and len(spec) > 1 and isinstance(spec[1], dict):
        opts = spec[1].get("options", [])
        if isinstance(opts, list):
            raw_options = opts

    seen: set[str] = set()
    result: list[str] = []
    for item in raw_options:
        if isinstance(item, str) and item not in seen:
            seen.add(item)
            result.append(item)
    return result


def build_moss_workflow(
    params: dict[str, Any],
    supports_bypass_lora: bool = True,
    supports_seedvr2: bool = False,
    init_image_comfy_name: str | None = None,
) -> tuple[dict[str, Any], int, dict[str, str]]:
    """Build a ComfyUI API prompt dict replicating ShinobiSat v2 + MOSS-Image SFT INT8."""
    unet_name = str(params.get("unet_name") or DEFAULT_UNET).strip()
    clip_name = str(params.get("clip_name") or DEFAULT_CLIP).strip()
    vae_name = str(params.get("vae_name") or DEFAULT_VAE).strip()

    positive = str(params.get("positive") or "").strip()
    if not positive:
        raise ValueError("正向提示词不能为空")
    negative = str(params.get("negative") or "")

    width = snap_multiple_16(params.get("width"), 896, max_dim=2560)
    height = snap_multiple_16(params.get("height"), 1152, max_dim=2560)
    batch_size = clamp_int(params.get("batch_size"), 1, 4, 1)
    steps = clamp_int(params.get("steps"), 1, 120, 16)
    cfg = clamp_float(params.get("cfg"), 0.1, 20.0, 1.0)
    sampler_name = str(params.get("sampler_name") or "euler").strip() or "euler"
    scheduler = str(params.get("scheduler") or "normal").strip() or "normal"

    raw_seed = params.get("seed", -1)
    try:
        parsed_seed = int(raw_seed)
    except (TypeError, ValueError):
        parsed_seed = -1
    resolved_seed = parsed_seed if parsed_seed >= 0 else random.randint(1, 2**48 - 1)

    lora_mode = str(params.get("lora_mode") or "bypass").strip().lower()
    use_flow_shift = bool(params.get("use_flow_shift", False))
    flow_shift = clamp_float(params.get("flow_shift"), 0.0, 100.0, 5.0)
    use_slg = bool(params.get("use_slg", False))
    slg_layers = str(
        params.get("slg_layers") if params.get("slg_layers") is not None else "22"
    ).strip()

    upscale_mode = str(params.get("upscale_mode") or "hires").strip().lower()
    if upscale_mode not in ("none", "hires", "seedvr2"):
        upscale_mode = "hires"

    workflow: dict[str, Any] = {
        "1": {
            "class_type": "UNETLoader",
            "inputs": {
                "unet_name": unet_name,
                "weight_dtype": "default",
            },
            "_meta": {"title": "Load MOSS DiT Model"},
        },
        "2": {
            "class_type": "CLIPLoader",
            "inputs": {
                "clip_name": clip_name,
                "type": "moss_image",
                "device": "default",
            },
            "_meta": {"title": "Load Qwen3.5 Text Encoder"},
        },
        "3": {
            "class_type": "VAELoader",
            "inputs": {
                "vae_name": vae_name,
            },
            "_meta": {"title": "Load FLUX.2 VAE"},
        },
    }

    stage_labels: dict[str, str] = {
        "1": "正在加载 MOSS 主模型 (DiT)...",
        "2": "正在加载 Qwen3.5 文本编码器...",
        "3": "正在加载 FLUX.2 VAE...",
        "4": "正在应用 Flow Shift 采样调度...",
        "5": "正在配置 SLG 防伪影引导...",
        "6": "正在编码正向提示词 (Qwen3.5)...",
        "7": "正在编码负向提示词...",
        "8": "正在准备潜空间画布...",
        "9": "一阶阶段: 正在采样生成底图...",
        "10": "一阶阶段: 正在解码底图...",
        "11": "一阶阶段: 正在输出底图...",
    }

    current_model_node = "1"
    loras_input = params.get("loras") or []
    lora_idx = 0
    for item in loras_input:
        if not isinstance(item, dict):
            continue
        if not item.get("enabled", True):
            continue
        lora_name = str(item.get("name") or "").strip()
        if not lora_name:
            continue
        strength = clamp_float(item.get("strength"), -3.0, 3.0, 1.0)
        if abs(strength) < 1e-6:
            continue
        node_id = str(100 + lora_idx)
        lora_idx += 1
        use_bypass = lora_mode == "bypass" and supports_bypass_lora
        class_type = "LoraLoaderBypassModelOnly" if use_bypass else "LoraLoaderModelOnly"
        workflow[node_id] = {
            "class_type": class_type,
            "inputs": {
                "model": [current_model_node, 0],
                "lora_name": lora_name,
                "strength_model": strength,
            },
            "_meta": {"title": f"LoRA {lora_idx}: {lora_name}"},
        }
        stage_labels[node_id] = f"正在挂载 LoRA: {lora_name}..."
        current_model_node = node_id

    if use_flow_shift:
        workflow["4"] = {
            "class_type": "ModelSamplingSD3",
            "inputs": {
                "model": [current_model_node, 0],
                "shift": flow_shift,
            },
            "_meta": {"title": "ModelSamplingSD3 (Flow Shift)"},
        }
        current_model_node = "4"

    if use_slg and slg_layers:
        workflow["5"] = {
            "class_type": "SkipLayerGuidanceDiTSimple",
            "inputs": {
                "model": [current_model_node, 0],
                "double_layers": "",
                "single_layers": slg_layers,
                "start_percent": 0.0,
                "end_percent": 1.0,
            },
            "_meta": {"title": "SkipLayerGuidanceDiTSimple"},
        }
        current_model_node = "5"

    workflow["6"] = {
        "class_type": "CLIPTextEncode",
        "inputs": {
            "text": positive,
            "clip": ["2", 0],
        },
        "_meta": {"title": "Positive Prompt"},
    }
    workflow["7"] = {
        "class_type": "CLIPTextEncode",
        "inputs": {
            "text": negative,
            "clip": ["2", 0],
        },
        "_meta": {"title": "Negative Prompt"},
    }
    if init_image_comfy_name:
        img2img_denoise = clamp_float(params.get("img2img_denoise"), 0.05, 1.0, 0.65)
        workflow["80"] = {
            "class_type": "LoadImage",
            "inputs": {"image": init_image_comfy_name},
            "_meta": {"title": "Load Init Image"},
        }
        workflow["81"] = {
            "class_type": "ImageScale",
            "inputs": {
                "image": ["80", 0],
                "upscale_method": "lanczos",
                "width": width,
                "height": height,
                "crop": "center",
            },
            "_meta": {"title": "Resize Init Image"},
        }
        workflow["8"] = {
            "class_type": "VAEEncode",
            "inputs": {
                "pixels": ["81", 0],
                "vae": ["3", 0],
            },
            "_meta": {"title": "VAE Encode Init Image"},
        }
        latent_source = "8"
        if batch_size > 1:
            workflow["82"] = {
                "class_type": "RepeatLatentBatch",
                "inputs": {"samples": ["8", 0], "amount": batch_size},
                "_meta": {"title": "Repeat Init Latent Batch"},
            }
            latent_source = "82"
        stage_labels["80"] = "正在加载参考底图..."
        stage_labels["81"] = "正在对齐参考底图尺寸..."
        stage_labels["8"] = "正在编码参考底图潜空间..."
        base_denoise = img2img_denoise
    else:
        workflow["8"] = {
            "class_type": "EmptyFlux2LatentImage",
            "inputs": {
                "width": width,
                "height": height,
                "batch_size": batch_size,
            },
            "_meta": {"title": "Empty Flux2 Latent"},
        }
        latent_source = "8"
        base_denoise = 1.0

    workflow["9"] = {
        "class_type": "KSampler",
        "inputs": {
            "model": [current_model_node, 0],
            "positive": ["6", 0],
            "negative": ["7", 0],
            "latent_image": [latent_source, 0],
            "seed": resolved_seed,
            "steps": steps,
            "cfg": cfg,
            "sampler_name": sampler_name,
            "scheduler": scheduler,
            "denoise": base_denoise,
        },
        "_meta": {"title": "KSampler (Base Pass)"},
    }
    workflow["10"] = {
        "class_type": "VAEDecode",
        "inputs": {
            "samples": ["9", 0],
            "vae": ["3", 0],
        },
        "_meta": {"title": "VAE Decode (Base)"},
    }
    workflow["11"] = {
        "class_type": "SaveImage",
        "inputs": {
            "images": ["10", 0],
            "filename_prefix": "MOSS_ShinobiSat_Base",
        },
        "_meta": {"title": "Save Image (Base)"},
    }

    if upscale_mode == "hires":
        upscale_factor = clamp_float(params.get("upscale_factor"), 1.0, 4.0, 1.5)
        up_w = snap_multiple_16(round(width * upscale_factor), default=1344, max_dim=3072)
        up_h = snap_multiple_16(round(height * upscale_factor), default=1728, max_dim=3072)
        upscale_model = str(params.get("upscale_model") or "").strip()
        hires_steps = clamp_int(params.get("hires_steps"), 1, 60, 4)
        hires_cfg = clamp_float(params.get("hires_cfg"), 0.1, 20.0, 1.0)
        hires_denoise = clamp_float(params.get("hires_denoise"), 0.01, 1.0, 0.15)

        workflow["20"] = {
            "class_type": "VAEDecodeTiled",
            "inputs": {
                "samples": ["9", 0],
                "vae": ["3", 0],
                "tile_size": 512,
                "overlap": 64,
                "temporal_size": 64,
                "temporal_overlap": 8,
            },
            "_meta": {"title": "VAE Decode (Tiled)"},
        }
        if upscale_model and upscale_model.lower() != "none":
            workflow["21"] = {
                "class_type": "UpscaleModelLoader",
                "inputs": {"model_name": upscale_model},
                "_meta": {"title": "Load Upscale Model"},
            }
            workflow["22"] = {
                "class_type": "ImageUpscaleWithModel",
                "inputs": {
                    "upscale_model": ["21", 0],
                    "image": ["20", 0],
                },
                "_meta": {"title": "Image Upscale With Model"},
            }
            workflow["23"] = {
                "class_type": "ImageScale",
                "inputs": {
                    "image": ["22", 0],
                    "upscale_method": "nearest-exact",
                    "width": up_w,
                    "height": up_h,
                    "crop": "disabled",
                },
                "_meta": {"title": "Resize to Target Hires"},
            }
        else:
            workflow["23"] = {
                "class_type": "ImageScale",
                "inputs": {
                    "image": ["20", 0],
                    "upscale_method": "lanczos",
                    "width": up_w,
                    "height": up_h,
                    "crop": "disabled",
                },
                "_meta": {"title": "Lanczos Scale to Hires"},
            }

        workflow["24"] = {
            "class_type": "VAEEncodeTiled",
            "inputs": {
                "pixels": ["23", 0],
                "vae": ["3", 0],
                "tile_size": 512,
                "overlap": 64,
                "temporal_size": 64,
                "temporal_overlap": 8,
            },
            "_meta": {"title": "VAE Encode (Tiled)"},
        }
        workflow["25"] = {
            "class_type": "KSampler",
            "inputs": {
                "model": [current_model_node, 0],
                "positive": ["6", 0],
                "negative": ["7", 0],
                "latent_image": ["24", 0],
                "seed": resolved_seed,
                "steps": hires_steps,
                "cfg": hires_cfg,
                "sampler_name": sampler_name,
                "scheduler": scheduler,
                "denoise": hires_denoise,
            },
            "_meta": {"title": "KSampler (Hires Refine)"},
        }
        workflow["26"] = {
            "class_type": "VAEDecode",
            "inputs": {
                "samples": ["25", 0],
                "vae": ["3", 0],
            },
            "_meta": {"title": "VAE Decode (Hires)"},
        }
        workflow["27"] = {
            "class_type": "SaveImage",
            "inputs": {
                "images": ["26", 0],
                "filename_prefix": "MOSS_ShinobiSat_Upscale",
            },
            "_meta": {"title": "Save Image (Hires)"},
        }
        stage_labels.update(
            {
                "20": "二修阶段: 正在分块解码底图...",
                "21": "二修阶段: 正在加载超分放大模型...",
                "22": "二修阶段: 正在超分放大图像...",
                "23": "二修阶段: 正在调整高清目标分辨率...",
                "24": "二修阶段: 正在分块编码潜空间...",
                "25": "二修阶段: 正在进行细节精修采样...",
                "26": "二修阶段: 正在解码高清大图...",
                "27": "二修阶段: 正在保存高清成品...",
            }
        )

    elif upscale_mode == "seedvr2":
        if not supports_seedvr2:
            raise ValueError(
                "云端 ComfyUI 尚未安装 SeedVR2 插件，请在 Colab Cell 2 勾选 INSTALL_SEEDVR2_NODE 后重试，或先切换为 ShinobiSat 轻量化二修放大"
            )
        seedvr2_dit = str(
            params.get("seedvr2_dit") or "seedvr2_ema_7b_sharp_fp16.safetensors"
        ).strip()
        seedvr2_vae = str(params.get("seedvr2_vae") or "ema_vae_fp16.safetensors").strip()
        seedvr2_res = clamp_int(params.get("seedvr2_resolution"), 512, 4096, 2048)
        seedvr2_max_res = clamp_int(params.get("seedvr2_max_resolution"), 512, 4096, 3072)

        workflow["30"] = {
            "class_type": "SeedVR2LoadDiTModel",
            "inputs": {
                "model": seedvr2_dit,
                "device": "cuda:0",
                "blocks_to_swap": 36,
                "swap_io_components": True,
                "offload_device": "cpu",
                "cache_model": True,
                "attention_mode": "sdpa",
            },
            "_meta": {"title": "SeedVR2 Load DiT"},
        }
        workflow["31"] = {
            "class_type": "SeedVR2LoadVAEModel",
            "inputs": {
                "model": seedvr2_vae,
                "device": "cuda:0",
                "encode_tiled": True,
                "encode_tile_size": 1024,
                "encode_tile_overlap": 128,
                "decode_tiled": True,
                "decode_tile_size": 1024,
                "decode_tile_overlap": 128,
                "tile_debug": "false",
                "offload_device": "cpu",
                "cache_model": False,
            },
            "_meta": {"title": "SeedVR2 Load VAE"},
        }
        workflow["32"] = {
            "class_type": "SeedVR2VideoUpscaler",
            "inputs": {
                "image": ["10", 0],
                "dit": ["30", 0],
                "vae": ["31", 0],
                "seed": resolved_seed,
                "resolution": seedvr2_res,
                "max_resolution": seedvr2_max_res,
                "batch_size": 1,
                "uniform_batch_size": False,
                "color_correction": "lab",
                "temporal_overlap": 0,
                "prepend_frames": 0,
                "input_noise_scale": 0.0,
                "latent_noise_scale": 0.0,
                "offload_device": "cpu",
                "enable_debug": False,
            },
            "_meta": {"title": "SeedVR2 Video/Image Upscaler"},
        }
        workflow["33"] = {
            "class_type": "SaveImage",
            "inputs": {
                "images": ["32", 0],
                "filename_prefix": "MOSS_ShinobiSat_SeedVR2",
            },
            "_meta": {"title": "Save Image (SeedVR2)"},
        }
        stage_labels.update(
            {
                "30": "SeedVR2 阶段: 正在加载 7B 扩散超分模型...",
                "31": "SeedVR2 阶段: 正在加载超分 VAE...",
                "32": "SeedVR2 阶段: 正在执行 2K/3K 高清重建...",
                "33": "SeedVR2 阶段: 正在保存超分成品...",
            }
        )

    return workflow, resolved_seed, stage_labels


def load_json_file(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default


def save_json_file(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(".tmp")
    tmp_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp_path.replace(path)


async def fetch_json_optional(
    session: aiohttp.ClientSession, url: str, timeout_sec: float = 15.0
) -> dict[str, Any] | list[Any] | None:
    try:
        async with session.get(url, timeout=aiohttp.ClientTimeout(total=timeout_sec)) as resp:
            if resp.status == 200:
                return await resp.json()
    except Exception:
        return None
    return None


def dedup_merge(*lists: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for lst in lists:
        for item in lst:
            if isinstance(item, str) and item and item not in seen:
                seen.add(item)
                out.append(item)
    return out


async def probe_comfy_server(
    comfy_url: str, session: aiohttp.ClientSession | None = None
) -> dict[str, Any]:
    """Query ComfyUI system stats and available model/upscale/SeedVR2/sampler options."""
    timeout = aiohttp.ClientTimeout(total=20.0)
    own_session = session is None
    sess = session or aiohttp.ClientSession(timeout=timeout)
    try:
        async with sess.get(f"{comfy_url}/system_stats", timeout=timeout) as resp:
            if resp.status != 200:
                body = await resp.text()
                raise RuntimeError(f"ComfyUI 返回状态 {resp.status}: {body[:200]}")
            stats = await resp.json()

        results = await asyncio.gather(
            fetch_json_optional(sess, f"{comfy_url}/object_info/UNETLoader"),
            fetch_json_optional(sess, f"{comfy_url}/object_info/CLIPLoader"),
            fetch_json_optional(sess, f"{comfy_url}/object_info/VAELoader"),
            fetch_json_optional(sess, f"{comfy_url}/object_info/LoraLoaderModelOnly"),
            fetch_json_optional(sess, f"{comfy_url}/object_info/LoraLoaderBypassModelOnly"),
            fetch_json_optional(sess, f"{comfy_url}/object_info/KSampler"),
            fetch_json_optional(sess, f"{comfy_url}/object_info/UpscaleModelLoader"),
            fetch_json_optional(sess, f"{comfy_url}/object_info/SeedVR2LoadDiTModel"),
            fetch_json_optional(sess, f"{comfy_url}/object_info/SeedVR2LoadVAEModel"),
            fetch_json_optional(sess, f"{comfy_url}/object_info/SeedVR2VideoUpscaler"),
            fetch_json_optional(sess, f"{comfy_url}/models/diffusion_models"),
            fetch_json_optional(sess, f"{comfy_url}/models/text_encoders"),
            fetch_json_optional(sess, f"{comfy_url}/models/vae"),
            fetch_json_optional(sess, f"{comfy_url}/models/loras"),
            fetch_json_optional(sess, f"{comfy_url}/models/upscale_models"),
            fetch_json_optional(sess, f"{comfy_url}/moss_studio/ping"),
        )
    finally:
        if own_session:
            await sess.close()

    (
        unet_info,
        clip_info,
        vae_info,
        lora_info,
        bypass_lora_info,
        sampler_info,
        upscale_info,
        seed_dit_info,
        seed_vae_info,
        seed_up_info,
        models_unet,
        models_clip,
        models_vae,
        models_loras,
        models_upscale,
        bridge_ping,
    ) = results

    unets = dedup_merge(
        extract_combo_options(unet_info or {}, "UNETLoader", "unet_name"),
        models_unet if isinstance(models_unet, list) else [],
    )
    clips = dedup_merge(
        extract_combo_options(clip_info or {}, "CLIPLoader", "clip_name"),
        models_clip if isinstance(models_clip, list) else [],
    )
    vaes = dedup_merge(
        extract_combo_options(vae_info or {}, "VAELoader", "vae_name"),
        models_vae if isinstance(models_vae, list) else [],
    )
    supports_bypass_lora = bool(
        isinstance(bypass_lora_info, dict) and "LoraLoaderBypassModelOnly" in bypass_lora_info
    )
    loras = dedup_merge(
        extract_combo_options(lora_info or {}, "LoraLoaderModelOnly", "lora_name"),
        extract_combo_options(bypass_lora_info or {}, "LoraLoaderBypassModelOnly", "lora_name"),
        models_loras if isinstance(models_loras, list) else [],
    )
    upscale_models = dedup_merge(
        extract_combo_options(upscale_info or {}, "UpscaleModelLoader", "model_name"),
        models_upscale if isinstance(models_upscale, list) else [],
    )
    supports_seedvr2 = bool(
        isinstance(seed_dit_info, dict)
        and "SeedVR2LoadDiTModel" in seed_dit_info
        and isinstance(seed_vae_info, dict)
        and "SeedVR2LoadVAEModel" in seed_vae_info
        and isinstance(seed_up_info, dict)
        and "SeedVR2VideoUpscaler" in seed_up_info
    )
    seedvr2_dits = extract_combo_options(seed_dit_info or {}, "SeedVR2LoadDiTModel", "model")
    seedvr2_vaes = extract_combo_options(seed_vae_info or {}, "SeedVR2LoadVAEModel", "model")

    samplers = extract_combo_options(sampler_info or {}, "KSampler", "sampler_name") or [
        "euler",
        "er_sde",
        "dpmpp_2m",
        "res_multistep",
    ]
    schedulers = extract_combo_options(sampler_info or {}, "KSampler", "scheduler") or [
        "normal",
        "sgm_uniform",
        "simple",
        "beta",
    ]

    devices = stats.get("devices") or []
    gpu_name = "CPU / Unknown"
    vram_total_gb = 0.0
    vram_free_gb = 0.0
    if devices and isinstance(devices[0], dict):
        dev = devices[0]
        gpu_name = str(dev.get("name") or gpu_name)
        vram_total_gb = round(float(dev.get("vram_total") or 0) / (1024**3), 1)
        vram_free_gb = round(float(dev.get("vram_free") or 0) / (1024**3), 1)

    sys_info = stats.get("system") or {}
    return {
        "connected": True,
        "comfy_url": comfy_url,
        "comfyui_version": str(sys_info.get("comfyui_version") or ""),
        "gpu_name": gpu_name,
        "vram_total_gb": vram_total_gb,
        "vram_free_gb": vram_free_gb,
        "unets": unets,
        "clips": clips,
        "vaes": vaes,
        "loras": loras,
        "upscale_models": upscale_models,
        "supports_seedvr2": supports_seedvr2,
        "seedvr2_dits": seedvr2_dits,
        "seedvr2_vaes": seedvr2_vaes,
        "samplers": samplers,
        "schedulers": schedulers,
        "supports_bypass_lora": supports_bypass_lora,
        "supports_cloud_download": bool(isinstance(bridge_ping, dict) and bridge_ping.get("ok")),
    }


def _collect_node_images(outputs: dict[str, Any], node_id: str) -> list[dict[str, str]]:
    node_out = outputs.get(node_id)
    if not isinstance(node_out, dict):
        return []
    result: list[dict[str, str]] = []
    for img in node_out.get("images") or []:
        if isinstance(img, dict) and img.get("filename"):
            result.append(
                {
                    "filename": str(img["filename"]),
                    "subfolder": str(img.get("subfolder") or ""),
                    "type": str(img.get("type") or "output"),
                }
            )
    return result


def extract_stage_images_from_history(
    history_entry: dict[str, Any], upscale_mode: str = "none"
) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    """Return (base_images, final_images) from a ComfyUI /history/{prompt_id} record."""
    outputs = history_entry.get("outputs")
    if not isinstance(outputs, dict):
        return [], []

    base_images = _collect_node_images(outputs, "11")
    if upscale_mode == "seedvr2":
        final_images = _collect_node_images(outputs, "33")
    elif upscale_mode == "hires":
        final_images = _collect_node_images(outputs, "27")
    else:
        final_images = base_images

    if not final_images and upscale_mode == "none":
        for k in outputs.keys():
            if k != "11":
                final_images.extend(_collect_node_images(outputs, k))
    return base_images, final_images


def decode_preview_binary(payload: bytes) -> str | None:
    """Decode ComfyUI binary WebSocket preview frame into a data URL."""
    if len(payload) <= 8:
        return None
    event_type, img_format = struct.unpack(">II", payload[:8])
    if event_type != 1:
        return None
    mime = "image/png" if img_format == 2 else "image/jpeg"
    b64 = base64.b64encode(payload[8:]).decode("ascii")
    return f"data:{mime};base64,{b64}"


async def download_comfy_image(
    session: aiohttp.ClientSession, comfy_url: str, img_meta: dict[str, str]
) -> bytes:
    query = urlencode(
        {
            "filename": img_meta["filename"],
            "subfolder": img_meta["subfolder"],
            "type": img_meta["type"],
        }
    )
    async with session.get(
        f"{comfy_url}/view?{query}", timeout=aiohttp.ClientTimeout(total=120)
    ) as img_resp:
        if img_resp.status != 200:
            raise RuntimeError(
                f"拉取图片 {img_meta['filename']} 失败 (HTTP {img_resp.status})"
            )
        return await img_resp.read()


async def broadcast_ws(
    state: dict[str, Any], event_type: str, payload: dict[str, Any] | None = None
) -> None:
    """Broadcast a JSON event to all connected Studio WebSocket clients."""
    clients = list(state.get("ws_clients") or ())
    if not clients:
        return
    raw = json.dumps({"type": event_type, **(payload or {})}, ensure_ascii=False)
    dead: list[web.WebSocketResponse] = []
    for ws in clients:
        if ws.closed:
            dead.append(ws)
            continue
        try:
            await ws.send_str(raw)
        except Exception:
            dead.append(ws)
    for ws in dead:
        state["ws_clients"].discard(ws)


def _summarize_job(job: dict[str, Any]) -> dict[str, Any]:
    elapsed = (
        round(time.monotonic() - job["started_at"], 1)
        if job.get("status") in ("queued", "running")
        else job.get("elapsed_sec", 0.0)
    )
    return {
        "job_id": job["job_id"],
        "status": job["status"],
        "stage": job.get("stage", ""),
        "progress": job.get("progress", 0.0),
        "step": job.get("step", 0),
        "max_steps": job.get("max_steps", 0),
        "seed": job.get("seed", -1),
        "elapsed_sec": elapsed,
        "eta_sec": job.get("eta_sec"),
        "error": job.get("error"),
        "positive_preview": str(job.get("positive_preview") or "")[:60],
        "created_at": job.get("created_at", ""),
    }


def build_queue_snapshot(state: dict[str, Any]) -> dict[str, Any]:
    jobs_map: dict[str, dict[str, Any]] = state.get("jobs") or {}
    active_id = state.get("active_job_id")
    queued_ids: list[str] = list(state.get("queued_ids") or [])

    ordered: list[dict[str, Any]] = []
    seen: set[str] = set()
    if active_id and active_id in jobs_map:
        seen.add(active_id)
        ordered.append(_summarize_job(jobs_map[active_id]))
    for qid in queued_ids:
        if qid in jobs_map and qid not in seen:
            seen.add(qid)
            ordered.append(_summarize_job(jobs_map[qid]))

    recent = [
        _summarize_job(j)
        for jid, j in reversed(list(jobs_map.items()))
        if jid not in seen
    ][:10]
    ordered.extend(recent)
    return {
        "active_job_id": active_id,
        "queued_count": len(queued_ids),
        "jobs": ordered,
    }


async def _upload_init_to_comfy(
    session: aiohttp.ClientSession, comfy_url: str, init_path: Path
) -> str:
    data = init_path.read_bytes()
    form = aiohttp.FormData()
    form.add_field("image", data, filename=init_path.name, content_type="image/png")
    form.add_field("type", "input")
    form.add_field("overwrite", "true")
    async with session.post(
        f"{comfy_url}/upload/image",
        data=form,
        timeout=aiohttp.ClientTimeout(total=60),
    ) as resp:
        text = await resp.text()
        if resp.status != 200:
            raise RuntimeError(f"上传参考底图到云端失败 (HTTP {resp.status}): {text[:200]}")
        parsed = json.loads(text)
        name = str(parsed.get("name") or init_path.name).strip()
        sub = str(parsed.get("subfolder") or "").strip()
        return f"{sub}/{name}" if sub else name


async def run_generation_job(
    state: dict[str, Any],
    job_id: str,
    comfy_url: str,
    workflow: dict[str, Any],
    params: dict[str, Any],
    resolved_seed: int,
    stage_labels: dict[str, str],
) -> None:
    """Execute a ComfyUI prompt, stream progress/previews, embed PNG metadata, and archive WebP thumbs."""
    job = state["jobs"][job_id]
    client_id = uuid.uuid4().hex
    ws_url = to_ws_url(comfy_url, client_id)
    outputs_dir: Path = state["outputs_dir"]
    thumbs_dir: Path = state["thumbs_dir"]
    history_path: Path = state["history_path"]
    upscale_mode = str(params.get("upscale_mode") or "none").strip().lower()
    if upscale_mode not in ("none", "hires", "seedvr2"):
        upscale_mode = "none"
    film_grain_enabled = bool(params.get("film_grain_enabled", False))
    film_grain_intensity = clamp_float(params.get("film_grain_intensity"), 0.001, 0.2, 0.022)

    job["status"] = "running"
    job["stage"] = "正在提交任务到云端 ComfyUI..."
    job["eta_sec"] = None
    await broadcast_ws(state, "job_progress", {"job": _summarize_job(job)})

    prompt_id: str | None = None
    execution_done = asyncio.Event()
    execution_error_msg: str | None = None
    current_node_id: str | None = None
    stage_t0 = time.monotonic()
    last_step = 0
    session = _get_http(state)

    try:
        ws_task: asyncio.Task[Any] | None = None
        ws_conn = None
        try:
            ws_conn = await session.ws_connect(
                ws_url,
                heartbeat=20.0,
                max_msg_size=32 * 1024 * 1024,
                timeout=15.0,
            )
        except Exception:
            ws_conn = None

        async def listen_ws() -> None:
            nonlocal execution_error_msg, current_node_id, stage_t0, last_step
            if ws_conn is None:
                return
            try:
                async for msg in ws_conn:
                    if job.get("cancel_requested"):
                        break
                    if msg.type == aiohttp.WSMsgType.BINARY:
                        data_url = decode_preview_binary(msg.data)
                        if data_url:
                            job["preview_data_url"] = data_url
                            await broadcast_ws(
                                state,
                                "job_preview",
                                {"job_id": job_id, "preview_data_url": data_url},
                            )
                        continue
                    if msg.type != aiohttp.WSMsgType.TEXT:
                        continue
                    try:
                        packet = json.loads(msg.data)
                    except json.JSONDecodeError:
                        continue
                    mtype = packet.get("type")
                    pdata = packet.get("data") or {}
                    msg_pid = pdata.get("prompt_id")
                    if prompt_id and msg_pid and msg_pid != prompt_id:
                        continue
                    if mtype == "executing":
                        node_id = pdata.get("node")
                        if node_id is None and msg_pid == prompt_id:
                            execution_done.set()
                            break
                        if node_id is not None:
                            current_node_id = str(node_id)
                            stage_t0 = time.monotonic()
                            last_step = 0
                            job["eta_sec"] = None
                            job["stage"] = stage_labels.get(
                                current_node_id, f"正在执行节点 {current_node_id}..."
                            )
                            await broadcast_ws(state, "job_progress", {"job": _summarize_job(job)})
                    elif mtype == "progress":
                        val = int(pdata.get("value") or 0)
                        mx = int(pdata.get("max") or 0)
                        if val < last_step or last_step == 0:
                            stage_t0 = time.monotonic()
                        last_step = val
                        job["step"] = val
                        job["max_steps"] = mx
                        if mx > 0:
                            pct = round(min(99.0, (val / mx) * 100.0), 1)
                            job["progress"] = pct
                            elapsed_stage = max(0.0, time.monotonic() - stage_t0)
                            if val > 0 and mx > val and elapsed_stage > 0.2:
                                job["eta_sec"] = round((elapsed_stage / val) * (mx - val), 1)
                            else:
                                job["eta_sec"] = None
                            if current_node_id == "25":
                                job["stage"] = f"二修阶段: 细节精修采样 (第 {val} / {mx} 步)..."
                            elif current_node_id == "32":
                                job["stage"] = f"SeedVR2 阶段: 超分重建 (第 {val} / {mx} 步)..."
                            else:
                                job["stage"] = f"一阶阶段: 基础采样 (第 {val} / {mx} 步)..."
                            await broadcast_ws(state, "job_progress", {"job": _summarize_job(job)})
                    elif mtype == "execution_error":
                        err_text = str(
                            pdata.get("exception_message")
                            or pdata.get("message")
                            or "ComfyUI 执行出错"
                        )
                        execution_error_msg = err_text
                        execution_done.set()
                        break
                    elif mtype == "execution_interrupted":
                        execution_error_msg = "已手动停止生成"
                        execution_done.set()
                        break
            except Exception:
                return

        if ws_conn is not None:
            ws_task = asyncio.create_task(listen_ws())

        try:
            async with session.post(
                f"{comfy_url}/prompt",
                json={"prompt": workflow, "client_id": client_id},
                timeout=aiohttp.ClientTimeout(total=60),
            ) as resp:
                resp_text = await resp.text()
                if resp.status != 200:
                    raise RuntimeError(f"提交任务失败 (HTTP {resp.status}): {resp_text[:300]}")
                resp_json = json.loads(resp_text)
                node_errors = resp_json.get("node_errors")
                if node_errors:
                    raise RuntimeError(
                        f"工作流节点校验失败: {json.dumps(node_errors, ensure_ascii=False)[:300]}"
                    )
                prompt_id = str(resp_json.get("prompt_id") or "")
                if not prompt_id:
                    raise RuntimeError("ComfyUI 未返回有效的 prompt_id")

            job["prompt_id"] = prompt_id
            job["stage"] = "任务已进入云端队列，首次加载模型可能需要 1~2 分钟..."
            await broadcast_ws(state, "job_progress", {"job": _summarize_job(job)})

            history_record: dict[str, Any] | None = None
            start_wait = time.monotonic()
            while not job.get("cancel_requested"):
                if execution_error_msg:
                    raise RuntimeError(execution_error_msg)

                hist_resp = await fetch_json_optional(
                    session, f"{comfy_url}/history/{prompt_id}", timeout_sec=15.0
                )
                if isinstance(hist_resp, dict) and prompt_id in hist_resp:
                    entry = hist_resp[prompt_id]
                    if isinstance(entry, dict):
                        status_info = entry.get("status") or {}
                        status_str = status_info.get("status_str")
                        if status_str == "error":
                            msgs = status_info.get("messages") or []
                            raise RuntimeError(f"云端执行失败: {msgs}")
                        _, final_imgs = extract_stage_images_from_history(entry, upscale_mode)
                        if final_imgs or execution_done.is_set() or status_info.get("completed"):
                            history_record = entry
                            break

                if execution_done.is_set() and history_record is None:
                    await asyncio.sleep(0.5)
                    hist_resp = await fetch_json_optional(
                        session, f"{comfy_url}/history/{prompt_id}", timeout_sec=15.0
                    )
                    if isinstance(hist_resp, dict) and prompt_id in hist_resp:
                        history_record = hist_resp[prompt_id]
                    break

                if time.monotonic() - start_wait > 1200:
                    raise RuntimeError("等待云端出图超时（超过 20 分钟）")

                try:
                    await asyncio.wait_for(execution_done.wait(), timeout=2.0)
                except asyncio.TimeoutError:
                    pass

            if job.get("cancel_requested"):
                job["status"] = "interrupted"
                job["stage"] = "已取消生成"
                job["eta_sec"] = 0.0
                await broadcast_ws(state, "job_cancelled", {"job": _summarize_job(job)})
                return

            if execution_error_msg:
                raise RuntimeError(execution_error_msg)

            base_images, final_images = extract_stage_images_from_history(
                history_record or {}, upscale_mode
            )
            if not final_images:
                raise RuntimeError("任务已结束，但未从 ComfyUI 获取到输出图片")

            job["stage"] = (
                "正在处理胶片颗粒并保存到本地 outputs 目录..."
                if film_grain_enabled
                else "正在将成品图保存到本地 outputs 目录..."
            )
            job["progress"] = 99.0
            job["eta_sec"] = 0.5
            await broadcast_ws(state, "job_progress", {"job": _summarize_job(job)})

            outputs_dir.mkdir(parents=True, exist_ok=True)
            thumbs_dir.mkdir(parents=True, exist_ok=True)
            ts_tag = datetime.now().strftime("%Y%m%d_%H%M%S")
            saved_items: list[dict[str, Any]] = []

            base_w = snap_multiple_16(params.get("width"), 896, max_dim=2560)
            base_h = snap_multiple_16(params.get("height"), 1152, max_dim=2560)
            upscale_factor = clamp_float(params.get("upscale_factor"), 1.0, 4.0, 1.5)
            out_w = (
                snap_multiple_16(round(base_w * upscale_factor), default=1344, max_dim=3072)
                if upscale_mode == "hires"
                else base_w
            )
            out_h = (
                snap_multiple_16(round(base_h * upscale_factor), default=1728, max_dim=3072)
                if upscale_mode == "hires"
                else base_h
            )

            for idx, img_meta in enumerate(final_images):
                img_bytes = await download_comfy_image(session, comfy_url, img_meta)
                if film_grain_enabled:
                    img_bytes = await asyncio.to_thread(
                        apply_film_grain, img_bytes, film_grain_intensity, 0.03
                    )

                record_params = {
                    "positive": params.get("positive", ""),
                    "negative": params.get("negative", ""),
                    "mode": params.get("mode", "shinobisat"),
                    "width": base_w,
                    "height": base_h,
                    "out_width": out_w,
                    "out_height": out_h,
                    "steps": clamp_int(params.get("steps"), 1, 120, 16),
                    "cfg": clamp_float(params.get("cfg"), 0.1, 20.0, 1.0),
                    "seed": resolved_seed,
                    "sampler_name": params.get("sampler_name", "euler"),
                    "scheduler": params.get("scheduler", "normal"),
                    "lora_mode": params.get("lora_mode", "bypass"),
                    "loras": params.get("loras", []),
                    "unet_name": params.get("unet_name", DEFAULT_UNET),
                    "clip_name": params.get("clip_name", DEFAULT_CLIP),
                    "vae_name": params.get("vae_name", DEFAULT_VAE),
                    "use_flow_shift": bool(params.get("use_flow_shift", False)),
                    "flow_shift": clamp_float(params.get("flow_shift"), 0.0, 100.0, 5.0),
                    "use_slg": bool(params.get("use_slg", False)),
                    "slg_layers": str(params.get("slg_layers") or "22"),
                    "upscale_mode": upscale_mode,
                    "upscale_model": str(params.get("upscale_model") or "none"),
                    "upscale_factor": upscale_factor,
                    "hires_steps": clamp_int(params.get("hires_steps"), 1, 60, 4),
                    "hires_cfg": clamp_float(params.get("hires_cfg"), 0.1, 20.0, 1.0),
                    "hires_denoise": clamp_float(params.get("hires_denoise"), 0.01, 1.0, 0.15),
                    "seedvr2_dit": str(
                        params.get("seedvr2_dit") or "seedvr2_ema_7b_sharp_fp16.safetensors"
                    ),
                    "seedvr2_vae": str(
                        params.get("seedvr2_vae") or "ema_vae_fp16.safetensors"
                    ),
                    "seedvr2_resolution": clamp_int(
                        params.get("seedvr2_resolution"), 512, 4096, 2048
                    ),
                    "seedvr2_max_resolution": clamp_int(
                        params.get("seedvr2_max_resolution"), 512, 4096, 3072
                    ),
                    "film_grain_enabled": film_grain_enabled,
                    "film_grain_intensity": film_grain_intensity,
                    "init_image_id": str(params.get("init_image_id") or ""),
                    "img2img_denoise": clamp_float(params.get("img2img_denoise"), 0.05, 1.0, 0.65),
                }

                img_bytes = await asyncio.to_thread(
                    embed_png_metadata, img_bytes, record_params, workflow
                )
                local_name = f"moss_{ts_tag}_{resolved_seed}_{idx + 1}.png"
                local_path = outputs_dir / local_name
                local_path.write_bytes(img_bytes)
                thumb_path = thumbs_dir / f"{local_path.stem}.webp"
                try:
                    await asyncio.to_thread(ensure_webp_thumb, local_path, thumb_path)
                except Exception:
                    pass

                base_filename: str | None = None
                base_url: str | None = None
                if upscale_mode != "none" and idx < len(base_images):
                    try:
                        base_bytes = await download_comfy_image(
                            session, comfy_url, base_images[idx]
                        )
                        b_ext = Path(base_images[idx]["filename"]).suffix or ".png"
                        base_filename = f"moss_{ts_tag}_{resolved_seed}_{idx + 1}_base{b_ext}"
                        (outputs_dir / base_filename).write_bytes(base_bytes)
                        base_url = f"/outputs/{base_filename}"
                    except Exception:
                        base_filename = None
                        base_url = None

                item_id = uuid.uuid4().hex[:12]
                record = {
                    "id": item_id,
                    "filename": local_name,
                    "url": f"/outputs/{local_name}",
                    "thumb_url": f"/api/thumb/{local_name}",
                    "base_filename": base_filename,
                    "base_url": base_url,
                    "favorite": False,
                    "deleted": False,
                    "created_at": datetime.now().isoformat(timespec="seconds"),
                    "elapsed_sec": round(time.monotonic() - job["started_at"], 1),
                    "params": record_params,
                }
                saved_items.append(record)

            trash_count = 0
            async with state["history_lock"]:
                history_list = load_json_file(history_path, [])
                if not isinstance(history_list, list):
                    history_list = []
                for rec in reversed(saved_items):
                    history_list.insert(0, rec)
                trimmed = history_list[:500]
                save_json_file(history_path, trimmed)
                trash_count = sum(1 for x in trimmed if isinstance(x, dict) and x.get("deleted"))

            job["images"] = saved_items
            job["progress"] = 100.0
            job["eta_sec"] = 0.0
            job["stage"] = "生成完成，已自动保存到本地！"
            job["status"] = "completed"
            job["elapsed_sec"] = round(time.monotonic() - job["started_at"], 1)

            await broadcast_ws(
                state,
                "job_completed",
                {
                    "job": _summarize_job(job),
                    "images": saved_items,
                },
            )
            await broadcast_ws(state, "history_updated", {"trash_count": trash_count})
        finally:
            if ws_conn is not None and not ws_conn.closed:
                await ws_conn.close()
            if ws_task is not None and not ws_task.done():
                ws_task.cancel()
                try:
                    await ws_task
                except asyncio.CancelledError:
                    pass
    except asyncio.CancelledError:
        job["status"] = "interrupted"
        job["stage"] = "任务已停止"
        job["eta_sec"] = 0.0
        await broadcast_ws(state, "job_cancelled", {"job": _summarize_job(job)})
    except Exception as exc:
        job["status"] = "failed"
        job["error"] = str(exc)
        job["stage"] = f"生成失败: {exc}"
        job["eta_sec"] = 0.0
        job["elapsed_sec"] = round(time.monotonic() - job["started_at"], 1)
        await broadcast_ws(state, "job_failed", {"job": _summarize_job(job)})
    finally:
        job["elapsed_sec"] = round(time.monotonic() - job["started_at"], 1)
        if state.get("active_job_id") == job_id:
            state["active_job_id"] = None


async def queue_worker(state: dict[str, Any]) -> None:
    """Process queued generation jobs sequentially (FIFO) without HTTP blocking."""
    q: asyncio.Queue[tuple[str, str, dict[str, Any], int]] = state["job_queue"]
    while True:
        job_id, comfy_url, params, resolved_seed = await q.get()
        job = state["jobs"].get(job_id)
        try:
            if job_id in state["queued_ids"]:
                state["queued_ids"].remove(job_id)
            if not job or job.get("cancel_requested"):
                if job:
                    job["status"] = "interrupted"
                    job["stage"] = "已取消生成"
                    await broadcast_ws(state, "job_cancelled", {"job": _summarize_job(job)})
                continue

            state["active_job_id"] = job_id
            job["started_at"] = time.monotonic()
            await broadcast_ws(state, "queue_update", {"queue": build_queue_snapshot(state)})

            init_comfy_name: str | None = None
            init_id = str(params.get("init_image_id") or "").strip()
            if init_id:
                safe_name = Path(init_id).name
                init_path = (state["init_dir"] / safe_name).resolve()
                if init_path.parent != state["init_dir"].resolve() or not init_path.is_file():
                    raise ValueError("参考底图不存在或已被清理，请重新上传")
                job["stage"] = "正在上传参考底图到云端..."
                await broadcast_ws(state, "job_progress", {"job": _summarize_job(job)})
                init_comfy_name = await _upload_init_to_comfy(
                    _get_http(state), comfy_url, init_path
                )

            merged_params = dict(params)
            merged_params["seed"] = resolved_seed
            workflow, _, stage_labels = build_moss_workflow(
                merged_params,
                supports_bypass_lora=state.get("supports_bypass_lora", True),
                supports_seedvr2=state.get("supports_seedvr2", False),
                init_image_comfy_name=init_comfy_name,
            )
            await run_generation_job(
                state=state,
                job_id=job_id,
                comfy_url=comfy_url,
                workflow=workflow,
                params=merged_params,
                resolved_seed=resolved_seed,
                stage_labels=stage_labels,
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            if job:
                job["status"] = "failed"
                job["error"] = str(exc)
                job["stage"] = f"生成失败: {exc}"
                job["elapsed_sec"] = round(time.monotonic() - job["started_at"], 1)
                await broadcast_ws(state, "job_failed", {"job": _summarize_job(job)})
        finally:
            if state.get("active_job_id") == job_id:
                state["active_job_id"] = None
            q.task_done()
            await broadcast_ws(state, "queue_update", {"queue": build_queue_snapshot(state)})


async def handle_index(_: web.Request) -> web.Response:
    return web.FileResponse(STATIC_DIR / "index.html")


async def handle_get_config(request: web.Request) -> web.Response:
    state = request.app[APP_STATE_KEY]
    cfg = load_json_file(state["config_path"], {})
    if not isinstance(cfg, dict):
        cfg = {}
    gd_cfg = state["gdrive"].get_config()
    colab_cfg = state["gdrive"].get_colab_config()
    lan_ip = get_lan_ip()
    port = state["port"]
    return web.json_response(
        {
            "comfy_url": cfg.get("comfy_url", ""),
            "civitai_api_key": cfg.get("civitai_api_key", ""),
            "gdrive_mode": gd_cfg["mode"],
            "gdrive_target_dir": gd_cfg["target_dir"],
            "gdrive_local_dir": gd_cfg["local_dir"],
            "colab_url": colab_cfg["colab_url"],
            "colab_notebook_remote": colab_cfg["colab_notebook_remote"],
            "defaults": cfg.get(
                "defaults",
                {
                    "unet_name": DEFAULT_UNET,
                    "clip_name": DEFAULT_CLIP,
                    "vae_name": DEFAULT_VAE,
                    "lora_mode": "bypass",
                },
            ),
            "lan_url": f"http://{lan_ip}:{port}",
            "local_url": f"http://127.0.0.1:{port}",
            "outputs_dir": str(state["outputs_dir"]),
        }
    )


async def handle_post_config(request: web.Request) -> web.Response:
    state = request.app[APP_STATE_KEY]
    body = await request.json()
    cfg = load_json_file(state["config_path"], {})
    if not isinstance(cfg, dict):
        cfg = {}
    if "comfy_url" in body:
        cfg["comfy_url"] = normalize_comfy_url(str(body.get("comfy_url") or ""))
    if "civitai_api_key" in body:
        cfg["civitai_api_key"] = str(body.get("civitai_api_key") or "").strip()
        cache = state.get("civitai_cache")
        if isinstance(cache, OrderedDict):
            cache.clear()
    if isinstance(body.get("defaults"), dict):
        defaults = cfg.get("defaults") or {}
        defaults.update(body["defaults"])
        cfg["defaults"] = defaults
    save_json_file(state["config_path"], cfg)
    if any(k in body for k in ("gdrive_mode", "gdrive_target_dir", "gdrive_local_dir")):
        try:
            state["gdrive"].update_config(
                mode=body.get("gdrive_mode") if "gdrive_mode" in body else None,
                target_dir=body.get("gdrive_target_dir") if "gdrive_target_dir" in body else None,
                local_dir=body.get("gdrive_local_dir") if "gdrive_local_dir" in body else None,
            )
            cfg = load_json_file(state["config_path"], cfg)
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=400)
    return web.json_response({"ok": True, "config": cfg})


def _apply_comfy_connection(
    state: dict[str, Any], comfy_url: str, info: dict[str, Any]
) -> dict[str, Any]:
    state["supports_bypass_lora"] = info["supports_bypass_lora"]
    state["supports_seedvr2"] = info["supports_seedvr2"]
    state["supports_cloud_download"] = info["supports_cloud_download"]
    state["known_loras"] = set(info.get("loras") or [])
    state["last_comfy_url"] = comfy_url
    cfg = load_json_file(state["config_path"], {})
    if not isinstance(cfg, dict):
        cfg = {}
    cfg["comfy_url"] = comfy_url
    save_json_file(state["config_path"], cfg)
    return info


async def handle_connect(request: web.Request) -> web.Response:
    state = request.app[APP_STATE_KEY]
    body = await request.json()
    raw_url = str(body.get("comfy_url") or "")
    comfy_url = normalize_comfy_url(raw_url)
    if not comfy_url:
        return web.json_response(
            {
                "connected": False,
                "error": "请输入有效的 ComfyUI 公网或本地地址（如 https://xxxx.trycloudflare.com）",
            },
            status=400,
        )

    try:
        info = await probe_comfy_server(comfy_url, session=_get_http(state))
    except Exception as exc:
        return web.json_response(
            {"connected": False, "error": f"无法连接 ComfyUI: {exc}"},
            status=502,
        )

    _apply_comfy_connection(state, comfy_url, info)
    return web.json_response(info)


async def handle_workflow_preview(request: web.Request) -> web.Response:
    state = request.app[APP_STATE_KEY]
    body = await request.json()
    init_id = str(body.get("init_image_id") or "").strip()
    try:
        workflow, seed, _ = build_moss_workflow(
            body,
            supports_bypass_lora=state.get("supports_bypass_lora", True),
            supports_seedvr2=state.get("supports_seedvr2", False),
            init_image_comfy_name=Path(init_id).name if init_id else None,
        )
    except ValueError as exc:
        return web.json_response({"error": str(exc)}, status=400)
    return web.json_response({"seed": seed, "prompt": workflow})


def _ensure_worker(state: dict[str, Any]) -> None:
    wt = state.get("worker_task")
    if wt is None or wt.done():
        wt = asyncio.create_task(queue_worker(state))
        state["worker_task"] = wt


async def handle_ws(request: web.Request) -> web.WebSocketResponse:
    state = request.app[APP_STATE_KEY]
    ws = web.WebSocketResponse(heartbeat=25.0)
    await ws.prepare(request)
    state["ws_clients"].add(ws)
    try:
        active_id = state.get("active_job_id")
        active_job = state["jobs"].get(active_id) if active_id else None
        await ws.send_str(
            json.dumps(
                {
                    "type": "hello",
                    "queue": build_queue_snapshot(state),
                    "active_job": {
                        **_summarize_job(active_job),
                        "preview_data_url": active_job.get("preview_data_url"),
                    }
                    if active_job
                    else None,
                },
                ensure_ascii=False,
            )
        )
        async for msg in ws:
            if msg.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.ERROR):
                break
    except Exception:
        pass
    finally:
        state["ws_clients"].discard(ws)
    return ws


async def handle_generate(request: web.Request) -> web.Response:
    state = request.app[APP_STATE_KEY]
    body = await request.json()
    comfy_url = normalize_comfy_url(
        str(body.get("comfy_url") or load_json_file(state["config_path"], {}).get("comfy_url", ""))
    )
    if not comfy_url:
        return web.json_response(
            {"error": "请先填写并连接 Colab 输出的 ComfyUI 链接"},
            status=400,
        )
    state["last_comfy_url"] = comfy_url

    init_id = str(body.get("init_image_id") or "").strip()
    if init_id:
        init_path = (state["init_dir"] / Path(init_id).name).resolve()
        if init_path.parent != state["init_dir"].resolve() or not init_path.is_file():
            return web.json_response({"error": "参考底图不存在，请重新上传"}, status=400)

    try:
        _, resolved_seed, _ = build_moss_workflow(
            body,
            supports_bypass_lora=state.get("supports_bypass_lora", True),
            supports_seedvr2=state.get("supports_seedvr2", False),
            init_image_comfy_name=Path(init_id).name if init_id else None,
        )
    except ValueError as exc:
        return web.json_response({"error": str(exc)}, status=400)

    _ensure_worker(state)
    job_id = uuid.uuid4().hex[:12]
    state["jobs"][job_id] = {
        "job_id": job_id,
        "status": "queued",
        "stage": "已在队列等待执行...",
        "progress": 0.0,
        "step": 0,
        "max_steps": clamp_int(body.get("steps"), 1, 120, 16),
        "seed": resolved_seed,
        "preview_data_url": None,
        "images": [],
        "error": None,
        "started_at": time.monotonic(),
        "elapsed_sec": 0.0,
        "eta_sec": None,
        "cancel_requested": False,
        "prompt_id": None,
        "positive_preview": str(body.get("positive") or "").strip()[:60],
        "created_at": datetime.now().isoformat(timespec="seconds"),
    }
    state["queued_ids"].append(job_id)
    queue_pos = len(state["queued_ids"]) + (1 if state.get("active_job_id") else 0)
    await state["job_queue"].put((job_id, comfy_url, body, resolved_seed))
    await broadcast_ws(state, "queue_update", {"queue": build_queue_snapshot(state)})
    return web.json_response({"job_id": job_id, "seed": resolved_seed, "queue_position": queue_pos})


async def handle_get_jobs(request: web.Request) -> web.Response:
    state = request.app[APP_STATE_KEY]
    return web.json_response(build_queue_snapshot(state))


async def handle_get_job(request: web.Request) -> web.Response:
    state = request.app[APP_STATE_KEY]
    job_id = request.match_info["job_id"]
    job = state["jobs"].get(job_id)
    if not job:
        return web.json_response({"error": "任务不存在"}, status=404)
    return web.json_response(
        {
            **_summarize_job(job),
            "preview_data_url": job["preview_data_url"],
            "images": job["images"],
        }
    )


async def _send_comfy_interrupt(state: dict[str, Any], comfy_url: str) -> None:
    if not comfy_url:
        return
    try:
        session = _get_http(state)
        await session.post(f"{comfy_url}/interrupt", timeout=aiohttp.ClientTimeout(total=10))
    except Exception:
        pass


async def handle_cancel_job(request: web.Request) -> web.Response:
    state = request.app[APP_STATE_KEY]
    job_id = request.match_info["job_id"]
    job = state["jobs"].get(job_id)
    if not job:
        return web.json_response({"error": "任务不存在"}, status=404)

    job["cancel_requested"] = True
    if job_id in state["queued_ids"]:
        state["queued_ids"].remove(job_id)
        job["status"] = "interrupted"
        job["stage"] = "已从队列移除"
        await broadcast_ws(state, "job_cancelled", {"job": _summarize_job(job)})
        await broadcast_ws(state, "queue_update", {"queue": build_queue_snapshot(state)})
    elif state.get("active_job_id") == job_id:
        job["stage"] = "正在请求停止生成..."
        comfy_url = normalize_comfy_url(
            str(state.get("last_comfy_url") or load_json_file(state["config_path"], {}).get("comfy_url", ""))
        )
        await _send_comfy_interrupt(state, comfy_url)
    return web.json_response({"ok": True})


async def handle_clear_queue(request: web.Request) -> web.Response:
    state = request.app[APP_STATE_KEY]
    for qid in list(state["queued_ids"]):
        qjob = state["jobs"].get(qid)
        if qjob:
            qjob["cancel_requested"] = True
            qjob["status"] = "interrupted"
            qjob["stage"] = "已从队列移除"
    state["queued_ids"].clear()

    active_id = state.get("active_job_id")
    if active_id and active_id in state["jobs"]:
        state["jobs"][active_id]["cancel_requested"] = True
        state["jobs"][active_id]["stage"] = "正在请求停止生成..."

    comfy_url = normalize_comfy_url(
        str(state.get("last_comfy_url") or load_json_file(state["config_path"], {}).get("comfy_url", ""))
    )
    if active_id:
        await _send_comfy_interrupt(state, comfy_url)
    await broadcast_ws(state, "queue_update", {"queue": build_queue_snapshot(state)})
    return web.json_response({"ok": True})


async def handle_interrupt(request: web.Request) -> web.Response:
    state = request.app[APP_STATE_KEY]
    body = await request.json() if request.can_read_body else {}
    comfy_url = normalize_comfy_url(
        str(
            (body or {}).get("comfy_url")
            or state.get("last_comfy_url")
            or load_json_file(state["config_path"], {}).get("comfy_url", "")
        )
    )
    active_id = state.get("active_job_id")
    if active_id and active_id in state["jobs"]:
        state["jobs"][active_id]["cancel_requested"] = True
        state["jobs"][active_id]["stage"] = "正在请求停止生成..."

    await _send_comfy_interrupt(state, comfy_url)
    return web.json_response({"ok": True})


def _enrich_history_record(item: dict[str, Any]) -> dict[str, Any]:
    out = dict(item)
    fname = str(out.get("filename") or "")
    is_deleted = bool(out.get("deleted"))
    if fname:
        out["url"] = f"/api/trash/{fname}" if is_deleted else f"/outputs/{fname}"
        out["thumb_url"] = f"/api/thumb/{fname}" + ("?trash=1" if is_deleted else "")
    out["favorite"] = bool(out.get("favorite"))
    out["deleted"] = is_deleted
    return out


async def handle_get_history(request: web.Request) -> web.Response:
    state = request.app[APP_STATE_KEY]
    outputs_dir: Path = state["outputs_dir"]
    trash_dir: Path = outputs_dir / "_trash"
    want_trash = (request.query.get("trash") or "0").strip() == "1"

    valid_items: list[dict[str, Any]] = []
    trash_count = 0
    async with state["history_lock"]:
        raw_list = load_json_file(state["history_path"], [])
        if not isinstance(raw_list, list):
            raw_list = []
        for item in raw_list:
            if not isinstance(item, dict) or not item.get("filename"):
                continue
            fname = str(item["filename"])
            is_del = bool(item.get("deleted"))
            src_dir = trash_dir if is_del else outputs_dir
            if not (src_dir / fname).is_file():
                continue
            if is_del:
                trash_count += 1
            if is_del == want_trash:
                valid_items.append(_enrich_history_record(item))
    return web.json_response({"items": valid_items, "trash_count": trash_count})


async def handle_toggle_favorite(request: web.Request) -> web.Response:
    state = request.app[APP_STATE_KEY]
    item_id = request.match_info["item_id"]
    found_val: bool | None = None
    async with state["history_lock"]:
        raw_list = load_json_file(state["history_path"], [])
        if not isinstance(raw_list, list):
            raw_list = []
        for item in raw_list:
            if isinstance(item, dict) and item.get("id") == item_id:
                item["favorite"] = not bool(item.get("favorite"))
                found_val = bool(item["favorite"])
                break
        if found_val is not None:
            save_json_file(state["history_path"], raw_list)
    if found_val is None:
        return web.json_response({"error": "记录不存在"}, status=404)
    return web.json_response({"ok": True, "favorite": found_val})


def _safe_unlink_output(folder: Path, fname: Any) -> None:
    if not isinstance(fname, str) or not fname or Path(fname).name != fname:
        return
    candidate = (folder / fname).resolve()
    if candidate.parent == folder.resolve() and candidate.is_file():
        candidate.unlink(missing_ok=True)


def _safe_move_output(src_dir: Path, dst_dir: Path, fname: Any) -> None:
    if not isinstance(fname, str) or not fname or Path(fname).name != fname:
        return
    src = (src_dir / fname).resolve()
    if src.parent == src_dir.resolve() and src.is_file():
        dst_dir.mkdir(parents=True, exist_ok=True)
        dst = (dst_dir / fname).resolve()
        shutil.move(str(src), str(dst))


async def handle_delete_history(request: web.Request) -> web.Response:
    state = request.app[APP_STATE_KEY]
    item_id = request.match_info["item_id"]
    permanent = (request.query.get("permanent") or "0").strip() == "1"
    outputs_dir: Path = state["outputs_dir"].resolve()
    trash_dir: Path = (outputs_dir / "_trash").resolve()
    thumbs_dir: Path = state["thumbs_dir"].resolve()
    changed = False
    trash_count = 0

    async with state["history_lock"]:
        raw_list = load_json_file(state["history_path"], [])
        if not isinstance(raw_list, list):
            raw_list = []
        remaining: list[dict[str, Any]] = []
        for item in raw_list:
            if not isinstance(item, dict):
                continue
            if item.get("id") == item_id:
                changed = True
                if permanent or item.get("deleted"):
                    _safe_unlink_output(outputs_dir, item.get("filename"))
                    _safe_unlink_output(outputs_dir, item.get("base_filename"))
                    _safe_unlink_output(trash_dir, item.get("filename"))
                    _safe_unlink_output(trash_dir, item.get("base_filename"))
                    fname = str(item.get("filename") or "")
                    if fname:
                        _safe_unlink_output(thumbs_dir, f"{Path(fname).stem}.webp")
                    continue
                item["deleted"] = True
                item["deleted_at"] = datetime.now().isoformat(timespec="seconds")
                _safe_move_output(outputs_dir, trash_dir, item.get("filename"))
                _safe_move_output(outputs_dir, trash_dir, item.get("base_filename"))
            if item.get("deleted"):
                trash_count += 1
            remaining.append(item)
        if changed:
            save_json_file(state["history_path"], remaining)
    if not changed:
        return web.json_response({"error": "记录不存在"}, status=404)
    await broadcast_ws(state, "history_updated", {"trash_count": trash_count})
    return web.json_response({"ok": True, "trash_count": trash_count})


async def handle_restore_history(request: web.Request) -> web.Response:
    state = request.app[APP_STATE_KEY]
    item_id = request.match_info["item_id"]
    outputs_dir: Path = state["outputs_dir"].resolve()
    trash_dir: Path = (outputs_dir / "_trash").resolve()
    restored = False
    trash_count = 0

    async with state["history_lock"]:
        raw_list = load_json_file(state["history_path"], [])
        if not isinstance(raw_list, list):
            raw_list = []
        for item in raw_list:
            if not isinstance(item, dict):
                continue
            if item.get("id") == item_id and item.get("deleted"):
                restored = True
                item["deleted"] = False
                item.pop("deleted_at", None)
                _safe_move_output(trash_dir, outputs_dir, item.get("filename"))
                _safe_move_output(trash_dir, outputs_dir, item.get("base_filename"))
            elif item.get("deleted"):
                trash_count += 1
        if restored:
            save_json_file(state["history_path"], raw_list)
    if not restored:
        return web.json_response({"error": "回收站中未找到该记录"}, status=404)
    await broadcast_ws(state, "history_updated", {"trash_count": trash_count})
    return web.json_response({"ok": True, "trash_count": trash_count})


async def handle_empty_trash(request: web.Request) -> web.Response:
    state = request.app[APP_STATE_KEY]
    outputs_dir: Path = state["outputs_dir"].resolve()
    trash_dir: Path = (outputs_dir / "_trash").resolve()
    thumbs_dir: Path = state["thumbs_dir"].resolve()
    removed_count = 0

    async with state["history_lock"]:
        raw_list = load_json_file(state["history_path"], [])
        if not isinstance(raw_list, list):
            raw_list = []
        remaining = []
        for item in raw_list:
            if isinstance(item, dict) and item.get("deleted"):
                removed_count += 1
                _safe_unlink_output(trash_dir, item.get("filename"))
                _safe_unlink_output(trash_dir, item.get("base_filename"))
                fname = str(item.get("filename") or "")
                if fname:
                    _safe_unlink_output(thumbs_dir, f"{Path(fname).stem}.webp")
            elif isinstance(item, dict):
                remaining.append(item)
        save_json_file(state["history_path"], remaining)
    await broadcast_ws(state, "history_updated", {"trash_count": 0})
    return web.json_response({"ok": True, "removed": removed_count})


async def handle_serve_trash(request: web.Request) -> web.StreamResponse:
    state = request.app[APP_STATE_KEY]
    filename = request.match_info["filename"]
    if not filename or Path(filename).name != filename or ".." in filename:
        raise web.HTTPBadRequest(text="Invalid filename")
    trash_dir = (state["outputs_dir"] / "_trash").resolve()
    target = (trash_dir / filename).resolve()
    if target.parent != trash_dir or not target.is_file():
        raise web.HTTPNotFound(text="File not found")
    return web.FileResponse(target)


async def handle_serve_thumb(request: web.Request) -> web.StreamResponse:
    state = request.app[APP_STATE_KEY]
    filename = request.match_info["filename"]
    if not filename or Path(filename).name != filename or ".." in filename:
        raise web.HTTPBadRequest(text="Invalid filename")
    in_trash = (request.query.get("trash") or "0").strip() == "1"
    src_dir = (state["outputs_dir"] / "_trash" if in_trash else state["outputs_dir"]).resolve()
    src_path = (src_dir / filename).resolve()
    if src_path.parent != src_dir or not src_path.is_file():
        raise web.HTTPNotFound(text="Source image not found")

    thumb_path = (state["thumbs_dir"] / f"{src_path.stem}.webp").resolve()
    if thumb_path.parent != state["thumbs_dir"].resolve():
        raise web.HTTPBadRequest(text="Invalid thumbnail path")
    try:
        await asyncio.to_thread(ensure_webp_thumb, src_path, thumb_path)
    except Exception:
        return web.FileResponse(src_path)

    return web.FileResponse(
        thumb_path,
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


async def handle_upload_init(request: web.Request) -> web.Response:
    state = request.app[APP_STATE_KEY]
    init_dir: Path = state["init_dir"].resolve()
    init_dir.mkdir(parents=True, exist_ok=True)
    raw_bytes: bytes | None = None

    ctype = (request.content_type or "").lower()
    if "application/json" in ctype:
        body = await request.json()
        hist_fname = str(body.get("history_filename") or "").strip()
        safe_hist = Path(hist_fname).name
        if not safe_hist or safe_hist != hist_fname:
            return web.json_response({"error": "无效的文件名"}, status=400)
        candidate = (state["outputs_dir"] / safe_hist).resolve()
        if candidate.parent != state["outputs_dir"].resolve() or not candidate.is_file():
            return web.json_response({"error": "找不到原输出图片"}, status=404)
        raw_bytes = candidate.read_bytes()
    else:
        reader = await request.multipart()
        while True:
            part = await reader.next()
            if part is None:
                break
            if part.name in ("file", "image"):
                raw_bytes = await part.read(decode=False)
                break

    if not raw_bytes:
        return web.json_response({"error": "未收到图片数据"}, status=400)

    def _convert_and_save(data: bytes) -> tuple[str, int, int]:
        with Image.open(io.BytesIO(data)) as im:
            rgb = im.convert("RGB")
            w, h = rgb.size
            fname = f"init_{uuid.uuid4().hex[:12]}.png"
            rgb.save(init_dir / fname, format="PNG")
            return fname, w, h

    try:
        fname, w, h = await asyncio.to_thread(_convert_and_save, raw_bytes)
    except Exception as exc:
        return web.json_response({"error": f"图片格式无法解析: {exc}"}, status=400)

    return web.json_response(
        {"init_id": fname, "url": f"/api/init-images/{fname}", "width": w, "height": h}
    )


async def handle_serve_init(request: web.Request) -> web.StreamResponse:
    state = request.app[APP_STATE_KEY]
    filename = request.match_info["filename"]
    if not filename or Path(filename).name != filename or ".." in filename:
        raise web.HTTPBadRequest(text="Invalid filename")
    init_dir = state["init_dir"].resolve()
    target = (init_dir / filename).resolve()
    if target.parent != init_dir or not target.is_file():
        raise web.HTTPNotFound(text="Init image not found")
    return web.FileResponse(target)


async def handle_image_meta(request: web.Request) -> web.Response:
    state = request.app[APP_STATE_KEY]
    raw_bytes: bytes | None = None
    reader = await request.multipart()
    while True:
        part = await reader.next()
        if part is None:
            break
        if part.name in ("file", "image"):
            raw_bytes = await part.read(decode=False)
            break
    if not raw_bytes:
        return web.json_response({"error": "请上传需要读取参数的图片"}, status=400)

    try:
        meta = await asyncio.to_thread(parse_image_metadata, raw_bytes)
    except Exception as exc:
        return web.json_response({"error": f"解析图片元数据失败: {exc}"}, status=400)

    known_loras: set[str] = set(state.get("known_loras") or ())
    known_stems = {Path(x).stem.lower(): x for x in known_loras}
    params = meta.get("params")
    if isinstance(params, dict) and isinstance(params.get("loras"), list):
        annotated: list[dict[str, Any]] = []
        for l_item in params["loras"]:
            if not isinstance(l_item, dict):
                continue
            lname = str(l_item.get("name") or "").strip()
            matched = (
                lname
                if lname in known_loras
                else known_stems.get(Path(lname).stem.lower())
            )
            annotated.append(
                {
                    **l_item,
                    "name": matched or lname,
                    "available": bool(matched) if known_loras else None,
                }
            )
        params["loras"] = annotated
    return web.json_response(meta)


def _upsert_lora_meta(state: dict[str, Any], filename: str, fields: dict[str, Any]) -> dict[str, Any]:
    path: Path = state["lora_meta_path"]
    meta_map = load_json_file(path, {})
    if not isinstance(meta_map, dict):
        meta_map = {}
    safe_name = Path(filename).name
    if not safe_name:
        return meta_map
    cur = dict(meta_map.get(safe_name) or {})
    for key in ("trained_words", "default_strength", "name", "base_model", "model_url", "preview_url", "note"):
        if key in fields and fields[key] is not None:
            cur[key] = fields[key]
    meta_map[safe_name] = cur
    save_json_file(path, meta_map)
    return meta_map


async def handle_get_lora_meta(request: web.Request) -> web.Response:
    state = request.app[APP_STATE_KEY]
    meta_map = load_json_file(state["lora_meta_path"], {})
    return web.json_response({"items": meta_map if isinstance(meta_map, dict) else {}})


async def handle_post_lora_meta(request: web.Request) -> web.Response:
    state = request.app[APP_STATE_KEY]
    body = await request.json()
    filename = str(body.get("filename") or "").strip()
    if not filename:
        return web.json_response({"error": "缺少 filename"}, status=400)
    updated = _upsert_lora_meta(state, filename, body)
    return web.json_response({"ok": True, "items": updated})


async def handle_get_presets(request: web.Request) -> web.Response:
    state = request.app[APP_STATE_KEY]
    presets = load_json_file(state["presets_path"], [])
    return web.json_response({"items": presets if isinstance(presets, list) else []})


async def handle_post_presets(request: web.Request) -> web.Response:
    state = request.app[APP_STATE_KEY]
    body = await request.json()
    name = str(body.get("name") or "").strip()
    params = body.get("params")
    if not name or not isinstance(params, dict):
        return web.json_response({"error": "预设名称与参数不能为空"}, status=400)
    presets = load_json_file(state["presets_path"], [])
    if not isinstance(presets, list):
        presets = []
    entry = {
        "id": uuid.uuid4().hex[:10],
        "name": name[:60],
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "params": params,
    }
    presets.insert(0, entry)
    save_json_file(state["presets_path"], presets[:100])
    return web.json_response({"ok": True, "item": entry, "items": presets[:100]})


async def handle_delete_preset(request: web.Request) -> web.Response:
    state = request.app[APP_STATE_KEY]
    preset_id = request.match_info["preset_id"]
    presets = load_json_file(state["presets_path"], [])
    if not isinstance(presets, list):
        presets = []
    remaining = [p for p in presets if isinstance(p, dict) and p.get("id") != preset_id]
    if len(remaining) == len(presets):
        return web.json_response({"error": "预设不存在"}, status=404)
    save_json_file(state["presets_path"], remaining)
    return web.json_response({"ok": True, "items": remaining})


async def handle_get_comic_pages(request: web.Request) -> web.Response:
    state = request.app[APP_STATE_KEY]
    pages = load_json_file(state["comic_pages_path"], [])
    return web.json_response({"items": pages if isinstance(pages, list) else []})


async def handle_post_comic_pages(request: web.Request) -> web.Response:
    state = request.app[APP_STATE_KEY]
    body = await request.json()
    name = str(body.get("name") or "").strip()
    page = body.get("page")
    if not name or not isinstance(page, dict):
        return web.json_response({"error": "分镜草稿名称与数据不能为空"}, status=400)

    sanitized_page = {**page, "custom": clean_comic_layout(page.get("custom"))}
    pages = load_json_file(state["comic_pages_path"], [])
    if not isinstance(pages, list):
        pages = []

    req_id = str(body.get("id") or "").strip()
    now_iso = datetime.now().isoformat(timespec="seconds")
    entry: dict[str, Any] | None = None
    if req_id:
        for idx, existing in enumerate(pages):
            if isinstance(existing, dict) and existing.get("id") == req_id:
                entry = {
                    **existing,
                    "name": name[:60],
                    "updated_at": now_iso,
                    "page": sanitized_page,
                }
                pages[idx] = entry
                break
    if entry is None:
        entry = {
            "id": uuid.uuid4().hex[:10],
            "name": name[:60],
            "created_at": now_iso,
            "updated_at": now_iso,
            "page": sanitized_page,
        }
        pages.insert(0, entry)

    pages = pages[:60]
    save_json_file(state["comic_pages_path"], pages)
    return web.json_response({"ok": True, "item": entry, "items": pages})


async def handle_delete_comic_page(request: web.Request) -> web.Response:
    state = request.app[APP_STATE_KEY]
    page_id = request.match_info["page_id"]
    pages = load_json_file(state["comic_pages_path"], [])
    if not isinstance(pages, list):
        pages = []
    remaining = [p for p in pages if isinstance(p, dict) and p.get("id") != page_id]
    if len(remaining) == len(pages):
        return web.json_response({"error": "分镜草稿不存在"}, status=404)
    save_json_file(state["comic_pages_path"], remaining)
    return web.json_response({"ok": True, "items": remaining})


async def handle_compile_comic(request: web.Request) -> web.Response:
    body = await request.json()
    try:
        result = compile_comic_prompt(body)
    except ValueError as exc:
        return web.json_response({"error": str(exc)}, status=400)
    return web.json_response(result)


async def handle_serve_output(request: web.Request) -> web.StreamResponse:
    state = request.app[APP_STATE_KEY]
    filename = request.match_info["filename"]
    if not filename or Path(filename).name != filename or ".." in filename:
        raise web.HTTPBadRequest(text="Invalid filename")
    outputs_dir = state["outputs_dir"].resolve()
    target = (outputs_dir / filename).resolve()
    if target.parent != outputs_dir or not target.is_file():
        raise web.HTTPNotFound(text="File not found")
    return web.FileResponse(target)


async def handle_open_outputs(request: web.Request) -> web.Response:
    state = request.app[APP_STATE_KEY]
    outputs_dir: Path = state["outputs_dir"]
    outputs_dir.mkdir(parents=True, exist_ok=True)
    if sys.platform.startswith("win"):
        os.startfile(str(outputs_dir))
    return web.json_response({"ok": True, "path": str(outputs_dir)})


def _get_civitai_key(state: dict[str, Any], override: str = "") -> str:
    if override and override.strip():
        return override.strip()
    cfg = load_json_file(state["config_path"], {})
    if isinstance(cfg, dict):
        return str(cfg.get("civitai_api_key") or "").strip()
    return ""


def _pick_civitai_version(versions: list[dict[str, Any]], only_moss: bool = True) -> dict[str, Any]:
    if not versions:
        return {}
    if only_moss:
        for v in versions:
            if "moss" in str(v.get("baseModel") or "").lower():
                return v
    return versions[0]


def _format_civitai_item(
    model_id: Any,
    model_name: str,
    creator_name: str,
    downloads: int,
    version: dict[str, Any],
    is_nsfw: bool = False,
) -> dict[str, Any]:
    files = version.get("files") or []
    chosen_file = None
    for f in files:
        if isinstance(f, dict) and str(f.get("name") or "").lower().endswith(".safetensors"):
            if f.get("primary") or chosen_file is None:
                chosen_file = f
    if chosen_file is None and files and isinstance(files[0], dict):
        chosen_file = files[0]
    chosen_file = chosen_file or {}

    images = version.get("images") or []
    preview_url = ""
    for img in images:
        if isinstance(img, dict) and img.get("url"):
            u = str(img["url"])
            if img.get("type") == "image" or not u.lower().endswith((".mp4", ".webm")):
                preview_url = u
                break
    if not preview_url and images and isinstance(images[0], dict):
        preview_url = str(images[0].get("url") or "")

    ver_id = version.get("id")
    dl_url = str(chosen_file.get("downloadUrl") or "")
    if not dl_url and ver_id:
        dl_url = f"https://civitai.com/api/download/models/{ver_id}"

    filename = str(chosen_file.get("name") or "").strip()
    if not filename and ver_id:
        filename = f"civitai_lora_{ver_id}.safetensors"

    return {
        "model_id": model_id,
        "version_id": ver_id,
        "name": model_name,
        "creator": creator_name,
        "base_model": str(version.get("baseModel") or ""),
        "filename": filename,
        "size_mb": round(float(chosen_file.get("sizeKB") or 0) / 1024.0, 1),
        "download_url": dl_url,
        "trained_words": [str(w) for w in (version.get("trainedWords") or []) if w],
        "preview_url": preview_url,
        "downloads": downloads,
        "nsfw": bool(is_nsfw),
        "model_url": f"https://civitai.com/models/{model_id}" if model_id else "",
    }


def _collect_civitai_page_items(
    raw_items: list[Any],
    *,
    only_moss: bool,
    only_r18: bool,
    seen_ids: set[Any],
) -> list[dict[str, Any]]:
    collected: list[dict[str, Any]] = []
    for item in raw_items or []:
        if not isinstance(item, dict):
            continue
        mid = item.get("id")
        if mid is not None:
            if mid in seen_ids:
                continue
            seen_ids.add(mid)
        item_nsfw = bool(item.get("nsfw"))
        if only_r18 and not item_nsfw:
            continue
        versions = item.get("modelVersions") or []
        if not versions:
            continue
        ver = _pick_civitai_version(versions, only_moss=only_moss)
        if only_moss and "moss" not in str(ver.get("baseModel") or "").lower():
            continue
        collected.append(
            _format_civitai_item(
                model_id=mid,
                model_name=str(item.get("name") or "Untitled LoRA"),
                creator_name=str((item.get("creator") or {}).get("username") or ""),
                downloads=int((item.get("stats") or {}).get("downloadCount") or 0),
                version=ver,
                is_nsfw=item_nsfw,
            )
        )
    return collected


async def _civitai_get_json(
    url: str, api_key: str, session: aiohttp.ClientSession | None = None
) -> dict[str, Any]:
    headers = {"User-Agent": "MOSS-Image-Studio/1.0"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    timeout = aiohttp.ClientTimeout(total=20.0)
    own = session is None
    sess = session or aiohttp.ClientSession(timeout=timeout)
    try:
        async with sess.get(url, headers=headers, timeout=timeout) as resp:
            text = await resp.text()
            if resp.status != 200:
                raise RuntimeError(f"Civitai API HTTP {resp.status}: {text[:240]}")
            return json.loads(text)
    finally:
        if own:
            await sess.close()


def _build_civitai_search_url(
    *,
    limit: int,
    sort: str,
    cursor: str,
    q: str,
    only_moss: bool,
    only_anime: bool,
    nsfw_true: bool = False,
) -> str:
    params_list: list[tuple[str, str]] = [
        ("types", "LORA"),
        ("limit", str(limit)),
        ("sort", sort),
    ]
    if nsfw_true:
        params_list.append(("nsfw", "true"))
    if cursor:
        params_list.append(("cursor", cursor))
    if q:
        params_list.append(("query", q))
    if only_moss:
        params_list.append(("baseModels", "MOSS Image"))
    if only_anime:
        params_list.append(("tag", "anime"))
    return f"https://civitai.com/api/v1/models?{urlencode(params_list)}"


async def handle_civitai_search(request: web.Request) -> web.Response:
    state = request.app[APP_STATE_KEY]
    api_key = _get_civitai_key(state)
    q = (request.query.get("q") or "").strip()
    sort = (request.query.get("sort") or "Most Downloaded").strip()
    only_moss = (request.query.get("only_moss") or "1").strip() != "0"
    only_r18 = (request.query.get("only_r18") or "0").strip() == "1"
    only_anime = (request.query.get("only_anime") or "0").strip() == "1"
    cursor = (request.query.get("cursor") or "").strip()
    limit = clamp_int(request.query.get("limit"), 1, 24, 12)

    cache: OrderedDict[Any, tuple[float, dict[str, Any]]] = state.setdefault(
        "civitai_cache", OrderedDict()
    )
    cache_key = (q, sort, only_moss, only_r18, only_anime, cursor, limit, bool(api_key))
    now_ts = time.monotonic()
    cached = cache.get(cache_key)
    if cached and (now_ts - cached[0]) < CIVITAI_CACHE_TTL:
        cache.move_to_end(cache_key)
        return web.json_response(cached[1])

    session = _get_http(state)
    payload: dict[str, Any]

    if not only_r18:
        url = _build_civitai_search_url(
            limit=limit,
            sort=sort,
            cursor=cursor,
            q=q,
            only_moss=only_moss,
            only_anime=only_anime,
            nsfw_true=False,
        )
        try:
            data = await _civitai_get_json(url, api_key, session=session)
        except Exception as exc:
            return web.json_response({"error": f"搜索 Civitai 失败: {exc}"}, status=502)

        items_out = _collect_civitai_page_items(
            data.get("items") or [],
            only_moss=only_moss,
            only_r18=False,
            seen_ids=set(),
        )
        next_cursor = str((data.get("metadata") or {}).get("nextCursor") or "").strip()
        payload = {"items": items_out, "next_cursor": next_cursor, "has_more": bool(next_cursor)}
    else:
        cur = cursor
        matched: list[dict[str, Any]] = []
        seen_ids: set[Any] = set()

        for _ in range(4):
            url = _build_civitai_search_url(
                limit=48,
                sort=sort,
                cursor=cur,
                q=q,
                only_moss=only_moss,
                only_anime=only_anime,
                nsfw_true=True,
            )
            try:
                data = await _civitai_get_json(url, api_key, session=session)
            except Exception as exc:
                return web.json_response({"error": f"搜索 Civitai 失败: {exc}"}, status=502)

            matched.extend(
                _collect_civitai_page_items(
                    data.get("items") or [],
                    only_moss=only_moss,
                    only_r18=True,
                    seen_ids=seen_ids,
                )
            )
            cur = str((data.get("metadata") or {}).get("nextCursor") or "").strip()
            if len(matched) >= limit or not cur:
                break

        payload = {"items": matched, "next_cursor": cur, "has_more": bool(cur)}

    cache[cache_key] = (time.monotonic(), payload)
    cache.move_to_end(cache_key)
    while len(cache) > CIVITAI_CACHE_MAX:
        cache.popitem(last=False)
    return web.json_response(payload)


async def handle_civitai_resolve(request: web.Request) -> web.Response:
    state = request.app[APP_STATE_KEY]
    body = await request.json()
    raw_input = str(body.get("input") or "").strip()
    api_key = _get_civitai_key(state, str(body.get("civitai_api_key") or ""))
    if not raw_input:
        return web.json_response({"error": "请输入 Civitai 模型链接 / ID 或 HuggingFace 直链"}, status=400)

    session = _get_http(state)
    parsed = urlparse(raw_input)
    host = (parsed.hostname or "").lower()
    if parsed.scheme in ("http", "https") and (
        "huggingface.co" in host or host == "hf.co"
    ):
        clean_url = raw_input if parsed.scheme == "https" else raw_input.replace("http://", "https://", 1)
        fname = Path(parsed.path).name or "custom_lora.safetensors"
        return web.json_response(
            {
                "name": fname,
                "filename": fname,
                "download_url": clean_url,
                "base_model": "Direct URL",
                "size_mb": 0.0,
                "trained_words": [],
                "subfolder": "loras",
            }
        )

    try:
        dl_match = re.search(r"civitai\.com/api/download/models/(\d+)", raw_input)
        ver_query = dict(parse_qsl(parsed.query)).get("modelVersionId")
        model_match = re.search(r"civitai\.com/models/(\d+)", raw_input)
        ver_id = dl_match.group(1) if dl_match else (ver_query if ver_query and ver_query.isdigit() else None)

        if ver_id:
            ver_data = await _civitai_get_json(
                f"https://civitai.com/api/v1/model-versions/{ver_id}", api_key, session=session
            )
            model_info = ver_data.get("model") or {}
            formatted = _format_civitai_item(
                model_id=ver_data.get("modelId"),
                model_name=str(model_info.get("name") or ver_data.get("name") or f"Model {ver_id}"),
                creator_name="",
                downloads=0,
                version=ver_data,
                is_nsfw=bool(model_info.get("nsfw")),
            )
            formatted["subfolder"] = "loras"
            return web.json_response(formatted)

        model_id = model_match.group(1) if model_match else (raw_input if raw_input.isdigit() else None)
        if not model_id:
            return web.json_response(
                {"error": "无法识别链接格式，请粘贴 Civitai 模型页面链接、下载链接或 HuggingFace 直链"},
                status=400,
            )

        try:
            m_data = await _civitai_get_json(
                f"https://civitai.com/api/v1/models/{model_id}", api_key, session=session
            )
            ver = _pick_civitai_version(m_data.get("modelVersions") or [], only_moss=True)
            if not ver:
                raise RuntimeError("该模型没有可用的文件版本")
            formatted = _format_civitai_item(
                model_id=m_data.get("id"),
                model_name=str(m_data.get("name") or f"Model {model_id}"),
                creator_name=str((m_data.get("creator") or {}).get("username") or ""),
                downloads=int((m_data.get("stats") or {}).get("downloadCount") or 0),
                version=ver,
                is_nsfw=bool(m_data.get("nsfw")),
            )
            formatted["subfolder"] = "loras"
            return web.json_response(formatted)
        except RuntimeError:
            if raw_input.isdigit():
                ver_data = await _civitai_get_json(
                    f"https://civitai.com/api/v1/model-versions/{raw_input}",
                    api_key,
                    session=session,
                )
                model_info = ver_data.get("model") or {}
                formatted = _format_civitai_item(
                    model_id=ver_data.get("modelId"),
                    model_name=str(model_info.get("name") or ver_data.get("name") or f"Version {raw_input}"),
                    creator_name="",
                    downloads=0,
                    version=ver_data,
                    is_nsfw=bool(model_info.get("nsfw")),
                )
                formatted["subfolder"] = "loras"
                return web.json_response(formatted)
            raise
    except Exception as exc:
        return web.json_response({"error": f"解析模型信息失败: {exc}"}, status=502)


async def handle_cloud_download(request: web.Request) -> web.Response:
    state = request.app[APP_STATE_KEY]
    body = await request.json()
    comfy_url = normalize_comfy_url(
        str(body.get("comfy_url") or load_json_file(state["config_path"], {}).get("comfy_url", ""))
    )
    if not comfy_url:
        return web.json_response({"error": "请先在顶部输入并连接 Colab 的 ComfyUI 链接"}, status=400)

    url = str(body.get("url") or "").strip()
    filename = str(body.get("filename") or "").strip()
    subfolder = str(body.get("subfolder") or "loras").strip()
    if not url or not filename:
        return web.json_response({"error": "缺少下载地址或文件名"}, status=400)

    civitai_token = _get_civitai_key(state, str(body.get("civitai_token") or ""))
    if not civitai_token:
        return web.json_response({"error": "请先配置 Civitai API Key（同时也用作云端桥接鉴权令牌）"}, status=400)

    if any(k in body for k in ("trained_words", "name", "base_model", "model_url", "preview_url")):
        _upsert_lora_meta(state, filename, body)

    session = _get_http(state)
    try:
        async with session.post(
            f"{comfy_url}/moss_studio/download",
            headers={"X-Bridge-Token": civitai_token},
            json={
                "url": url,
                "filename": filename,
                "subfolder": subfolder,
                "civitai_token": civitai_token,
                "hf_token": str(body.get("hf_token") or "").strip(),
            },
            timeout=aiohttp.ClientTimeout(total=20.0),
        ) as resp:
            text = await resp.text()
            if resp.status == 404:
                return web.json_response(
                    {
                        "error": "当前云端 ComfyUI 尚未加载新版桥接插件（moss_studio_bridge）。请在 Colab 使用最新 Notebook 重新运行 Cell 2 和 Cell 4，或复制直链放到 Cell 3 下载。"
                    },
                    status=502,
                )
            if resp.status != 200:
                return web.json_response(
                    {"error": f"云端桥接返回 HTTP {resp.status}: {text[:240]}"},
                    status=resp.status if resp.status < 500 else 502,
                )
            return web.json_response(json.loads(text))
    except Exception as exc:
        return web.json_response({"error": f"调用云端下载桥接失败: {exc}"}, status=502)


async def handle_cloud_download_status(request: web.Request) -> web.Response:
    state = request.app[APP_STATE_KEY]
    task_id = request.match_info["task_id"]
    comfy_url = normalize_comfy_url(
        str(
            request.query.get("comfy_url")
            or load_json_file(state["config_path"], {}).get("comfy_url", "")
        )
    )
    if not comfy_url:
        return web.json_response({"error": "未配置 ComfyUI 链接"}, status=400)
    civitai_token = _get_civitai_key(state)
    session = _get_http(state)
    try:
        async with session.get(
            f"{comfy_url}/moss_studio/download/{task_id}",
            headers={"X-Bridge-Token": civitai_token},
            timeout=aiohttp.ClientTimeout(total=15.0),
        ) as resp:
            text = await resp.text()
            if resp.status != 200:
                return web.json_response(
                    {"error": f"查询云端下载状态失败 (HTTP {resp.status}): {text[:200]}"},
                    status=resp.status if resp.status < 500 else 502,
                )
            return web.json_response(json.loads(text))
    except Exception as exc:
        return web.json_response({"error": f"查询云端下载状态失败: {exc}"}, status=502)


async def handle_gdrive_status(request: web.Request) -> web.Response:
    state = request.app[APP_STATE_KEY]
    include_quota = (request.query.get("quota") or "1").strip() != "0"
    status = await state["gdrive"].get_status(include_quota=include_quota)
    return web.json_response(status)


async def handle_gdrive_config(request: web.Request) -> web.Response:
    state = request.app[APP_STATE_KEY]
    body = await request.json()
    mode = body.get("mode") if "mode" in body else body.get("gdrive_mode")
    target_dir = (
        body.get("target_dir") if "target_dir" in body else body.get("gdrive_target_dir")
    )
    local_dir = (
        body.get("local_dir") if "local_dir" in body else body.get("gdrive_local_dir")
    )
    try:
        state["gdrive"].update_config(
            mode=mode,
            target_dir=target_dir,
            local_dir=local_dir,
        )
    except ValueError as exc:
        return web.json_response({"error": str(exc)}, status=400)
    status = await state["gdrive"].get_status(include_quota=False)
    return web.json_response({"ok": True, "status": status})


async def handle_gdrive_auth_start(request: web.Request) -> web.Response:
    state = request.app[APP_STATE_KEY]
    try:
        auth = await state["gdrive"].start_auth()
    except Exception as exc:
        return web.json_response({"error": f"启动 Google Drive 授权失败: {exc}"}, status=500)
    return web.json_response({"ok": True, "auth": auth})


async def handle_gdrive_auth_status(request: web.Request) -> web.Response:
    state = request.app[APP_STATE_KEY]
    auth = state["gdrive"].get_auth_status()
    payload: dict[str, Any] = {"auth": auth}
    if auth.get("state") == "authorized":
        payload["status"] = await state["gdrive"].get_status(include_quota=True)
    return web.json_response(payload)


async def handle_gdrive_auth_cancel(request: web.Request) -> web.Response:
    state = request.app[APP_STATE_KEY]
    auth = await state["gdrive"].cancel_auth()
    return web.json_response({"ok": True, "auth": auth})


async def handle_gdrive_disconnect(request: web.Request) -> web.Response:
    state = request.app[APP_STATE_KEY]
    status = await state["gdrive"].disconnect()
    return web.json_response({"ok": True, "status": status})


async def handle_gdrive_loras(request: web.Request) -> web.Response:
    state = request.app[APP_STATE_KEY]
    target_dir = request.query.get("target_dir")
    try:
        items = await state["gdrive"].list_loras(target_dir=target_dir)
    except ValueError as exc:
        return web.json_response({"error": str(exc)}, status=400)
    except Exception as exc:
        return web.json_response({"error": f"读取 Google Drive LoRA 列表失败: {exc}"}, status=502)
    return web.json_response({"items": items, "names": [it["name"] for it in items]})


async def handle_gdrive_download(request: web.Request) -> web.Response:
    state = request.app[APP_STATE_KEY]
    body = await request.json()
    url = str(body.get("url") or "").strip()
    filename = str(body.get("filename") or "").strip()
    target_dir = body.get("target_dir")
    if not url or not filename:
        return web.json_response({"error": "缺少下载地址或文件名"}, status=400)

    civitai_token = _get_civitai_key(state, str(body.get("civitai_token") or ""))
    hf_token = str(body.get("hf_token") or "").strip()

    if any(k in body for k in ("trained_words", "name", "base_model", "model_url", "preview_url")):
        _upsert_lora_meta(state, filename, body)

    try:
        task = await state["gdrive"].start_download(
            url=url,
            filename=filename,
            target_dir=target_dir,
            civitai_token=civitai_token,
            hf_token=hf_token,
        )
    except (ValueError, RuntimeError) as exc:
        return web.json_response({"error": str(exc)}, status=400)
    except Exception as exc:
        return web.json_response({"error": f"发起 Google Drive 下载失败: {exc}"}, status=502)
    return web.json_response(task)


async def handle_gdrive_download_status(request: web.Request) -> web.Response:
    state = request.app[APP_STATE_KEY]
    task_id = request.match_info["task_id"]
    task = state["gdrive"].get_download_status(task_id)
    if task is None:
        return web.json_response({"error": "未找到该下载任务"}, status=404)
    return web.json_response(task)


async def handle_gdrive_download_cancel(request: web.Request) -> web.Response:
    state = request.app[APP_STATE_KEY]
    task_id = request.match_info["task_id"]
    task = await state["gdrive"].cancel_download(task_id)
    if task is None:
        return web.json_response({"error": "未找到该下载任务"}, status=404)
    return web.json_response(task)


async def _read_json_optional(request: web.Request) -> dict[str, Any]:
    if not request.can_read_body:
        return {}
    try:
        data = await request.json()
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


async def handle_get_colab_config(request: web.Request) -> web.Response:
    state = request.app[APP_STATE_KEY]
    colab_cfg = state["gdrive"].get_colab_config()
    gd_status = await state["gdrive"].get_status(include_quota=False)
    local_nb = BASE_DIR / "ComfyUI_Colab_Hybrid.ipynb"
    return web.json_response(
        {
            "colab_url": colab_cfg["colab_url"],
            "colab_notebook_remote": colab_cfg["colab_notebook_remote"],
            "local_notebook_exists": local_nb.is_file(),
            "gdrive_mounted": bool(gd_status.get("mounted")),
            "rclone_configured": bool(gd_status.get("rclone_configured")),
        }
    )


async def handle_post_colab_config(request: web.Request) -> web.Response:
    state = request.app[APP_STATE_KEY]
    body = await _read_json_optional(request)
    try:
        colab_cfg = state["gdrive"].update_colab_config(
            colab_url=body.get("colab_url") if "colab_url" in body else None,
            notebook_remote=(
                body.get("colab_notebook_remote")
                if "colab_notebook_remote" in body
                else None
            ),
        )
    except ValueError as exc:
        return web.json_response({"error": str(exc)}, status=400)
    return web.json_response({"ok": True, **colab_cfg})


async def handle_colab_notebooks(request: web.Request) -> web.Response:
    state = request.app[APP_STATE_KEY]
    try:
        items = await state["gdrive"].list_colab_notebooks()
    except Exception as exc:
        return web.json_response(
            {"error": f"读取云盘 Colab Notebooks 失败: {exc}"}, status=502
        )
    return web.json_response({"items": items})


async def handle_colab_sync_notebook(request: web.Request) -> web.Response:
    state = request.app[APP_STATE_KEY]
    body = await _read_json_optional(request)
    remote_path = body.get("remote_path")
    local_nb = BASE_DIR / "ComfyUI_Colab_Hybrid.ipynb"
    try:
        result = await state["gdrive"].sync_colab_notebook(
            local_nb, remote_path=str(remote_path) if remote_path else None
        )
    except (ValueError, RuntimeError) as exc:
        return web.json_response({"error": str(exc)}, status=400)
    except Exception as exc:
        return web.json_response(
            {"error": f"同步 Notebook 到 Google Drive 失败: {exc}"}, status=502
        )
    return web.json_response(result)


async def handle_colab_endpoint(request: web.Request) -> web.Response:
    state = request.app[APP_STATE_KEY]
    try:
        ep = await state["gdrive"].fetch_colab_endpoint()
    except Exception as exc:
        return web.json_response(
            {"found": False, "status": "error", "comfy_url": "", "error": str(exc)},
            status=502,
        )
    return web.json_response(ep)


async def handle_colab_auto_connect(request: web.Request) -> web.Response:
    state = request.app[APP_STATE_KEY]
    body = await _read_json_optional(request)
    force = bool(body.get("force"))
    try:
        ep = await state["gdrive"].fetch_colab_endpoint()
    except Exception as exc:
        return web.json_response(
            {
                "connected": False,
                "waiting": True,
                "endpoint": {"found": False, "status": "error"},
                "error": f"读取云盘 Colab 地址失败: {exc}",
            }
        )

    if not ep.get("found") or not ep.get("comfy_url"):
        return web.json_response(
            {
                "connected": False,
                "waiting": True,
                "endpoint": ep,
                "error": ep.get("message") or "未找到运行中的 Colab 隧道地址",
            }
        )

    if ep.get("status") == "stopped" and not force:
        return web.json_response(
            {
                "connected": False,
                "waiting": True,
                "stopped": True,
                "endpoint": ep,
                "error": "上次 Colab 运行时已停止，请在 Colab 重新运行 Cell 4",
            }
        )

    comfy_url = normalize_comfy_url(str(ep["comfy_url"]))
    try:
        info = await probe_comfy_server(comfy_url, session=_get_http(state))
    except Exception as exc:
        return web.json_response(
            {
                "connected": False,
                "waiting": True,
                "stale": True,
                "endpoint": ep,
                "error": f"云盘记录的地址暂不可达（可能仍在启动或已过期）：{exc}",
            }
        )

    _apply_comfy_connection(state, comfy_url, info)
    return web.json_response({**info, "endpoint": ep})


async def handle_colab_open(request: web.Request) -> web.Response:
    state = request.app[APP_STATE_KEY]
    body = await _read_json_optional(request)
    target_url = str(body.get("url") or "").strip()
    if not target_url:
        target_url = state["gdrive"].get_colab_config().get("colab_url", "").strip()
    parsed = urlparse(target_url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        return web.json_response(
            {"error": "无效的 Colab 地址，请先同步或保存有效的 http/https 链接"},
            status=400,
        )
    if sys.platform.startswith("win"):
        import ctypes

        ret = await asyncio.to_thread(
            ctypes.windll.shell32.ShellExecuteW, None, "open", target_url, None, None, 1
        )
        if int(ret) <= 32:
            os.startfile(target_url)
    else:
        await asyncio.to_thread(webbrowser.open, target_url, 2)
    return web.json_response({"ok": True, "url": target_url})


@web.middleware
async def _no_cache_static_middleware(
    request: web.Request, handler: Any
) -> web.StreamResponse:
    resp = await handler(request)
    if request.path == "/" or request.path.startswith("/static/"):
        resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
    return resp


def create_app(
    outputs_dir: Path | None = None,
    data_dir: Path | None = None,
    port: int = 7860,
) -> web.Application:
    """Create and configure the aiohttp web application."""
    resolved_outputs = Path(outputs_dir) if outputs_dir else BASE_DIR / "outputs"
    resolved_data = Path(data_dir) if data_dir else Path(__file__).resolve().parent / "data"
    thumbs_dir = resolved_data / "thumbs"
    init_dir = resolved_data / "init_images"
    trash_dir = resolved_outputs / "_trash"
    resolved_outputs.mkdir(parents=True, exist_ok=True)
    resolved_data.mkdir(parents=True, exist_ok=True)
    thumbs_dir.mkdir(parents=True, exist_ok=True)
    init_dir.mkdir(parents=True, exist_ok=True)
    trash_dir.mkdir(parents=True, exist_ok=True)

    app = web.Application(
        client_max_size=16 * 1024 * 1024,
        middlewares=[_no_cache_static_middleware],
    )
    gdrive_mgr = GDriveManager(
        data_dir=resolved_data,
        config_path=resolved_data / "config.json",
        http_getter=lambda: _get_http(app[APP_STATE_KEY]),
        base_dir=BASE_DIR,
    )
    app[APP_STATE_KEY] = {
        "outputs_dir": resolved_outputs,
        "data_dir": resolved_data,
        "thumbs_dir": thumbs_dir,
        "init_dir": init_dir,
        "config_path": resolved_data / "config.json",
        "history_path": resolved_data / "history.json",
        "lora_meta_path": resolved_data / "lora_meta.json",
        "presets_path": resolved_data / "presets.json",
        "comic_pages_path": resolved_data / "comic_pages.json",
        "gdrive": gdrive_mgr,
        "port": port,
        "jobs": {},
        "active_job_id": None,
        "queued_ids": [],
        "job_queue": asyncio.Queue(),
        "worker_task": None,
        "ws_clients": set(),
        "last_comfy_url": "",
        "known_loras": set(),
        "civitai_cache": OrderedDict(),
        "http": None,
        "supports_bypass_lora": True,
        "supports_seedvr2": False,
        "supports_cloud_download": False,
        "history_lock": asyncio.Lock(),
        "tasks": set(),
    }

    async def on_startup(application: web.Application) -> None:
        st = application[APP_STATE_KEY]
        _get_http(st)
        _ensure_worker(st)

    async def on_cleanup(application: web.Application) -> None:
        st = application[APP_STATE_KEY]
        await st["gdrive"].cleanup()
        wt = st.get("worker_task")
        if wt is not None and not wt.done():
            wt.cancel()
            try:
                await wt
            except asyncio.CancelledError:
                pass
        tasks = list(st["tasks"])
        for t in tasks:
            t.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        for ws in list(st.get("ws_clients") or ()):
            if not ws.closed:
                try:
                    await ws.close()
                except Exception:
                    pass
        st["ws_clients"].clear()
        sess = st.get("http")
        if isinstance(sess, aiohttp.ClientSession) and not sess.closed:
            await sess.close()

    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)

    app.router.add_get("/", handle_index)
    app.router.add_get("/ws", handle_ws)
    app.router.add_static("/static", STATIC_DIR, show_index=False)
    app.router.add_get("/outputs/{filename}", handle_serve_output)
    app.router.add_get("/api/thumb/{filename}", handle_serve_thumb)
    app.router.add_get("/api/trash/{filename}", handle_serve_trash)
    app.router.add_get("/api/config", handle_get_config)
    app.router.add_post("/api/config", handle_post_config)
    app.router.add_post("/api/connect", handle_connect)
    app.router.add_post("/api/workflow-preview", handle_workflow_preview)
    app.router.add_post("/api/generate", handle_generate)
    app.router.add_get("/api/jobs", handle_get_jobs)
    app.router.add_get("/api/jobs/{job_id}", handle_get_job)
    app.router.add_post("/api/jobs/{job_id}/cancel", handle_cancel_job)
    app.router.add_post("/api/queue/clear", handle_clear_queue)
    app.router.add_post("/api/interrupt", handle_interrupt)
    app.router.add_post("/api/upload-init", handle_upload_init)
    app.router.add_get("/api/init-images/{filename}", handle_serve_init)
    app.router.add_post("/api/image/meta", handle_image_meta)
    app.router.add_get("/api/history", handle_get_history)
    app.router.add_post("/api/history/empty-trash", handle_empty_trash)
    app.router.add_post("/api/history/{item_id}/favorite", handle_toggle_favorite)
    app.router.add_post("/api/history/{item_id}/restore", handle_restore_history)
    app.router.add_delete("/api/history/{item_id}", handle_delete_history)
    app.router.add_get("/api/lora-meta", handle_get_lora_meta)
    app.router.add_post("/api/lora-meta", handle_post_lora_meta)
    app.router.add_get("/api/presets", handle_get_presets)
    app.router.add_post("/api/presets", handle_post_presets)
    app.router.add_delete("/api/presets/{preset_id}", handle_delete_preset)
    app.router.add_get("/api/comic-pages", handle_get_comic_pages)
    app.router.add_post("/api/comic-pages", handle_post_comic_pages)
    app.router.add_delete("/api/comic-pages/{page_id}", handle_delete_comic_page)
    app.router.add_post("/api/comic/compile", handle_compile_comic)
    app.router.add_post("/api/open-outputs", handle_open_outputs)
    app.router.add_get("/api/civitai/search", handle_civitai_search)
    app.router.add_post("/api/civitai/resolve", handle_civitai_resolve)
    app.router.add_post("/api/cloud/download", handle_cloud_download)
    app.router.add_get("/api/cloud/download/{task_id}", handle_cloud_download_status)
    app.router.add_get("/api/gdrive/status", handle_gdrive_status)
    app.router.add_post("/api/gdrive/config", handle_gdrive_config)
    app.router.add_post("/api/gdrive/auth/start", handle_gdrive_auth_start)
    app.router.add_get("/api/gdrive/auth/status", handle_gdrive_auth_status)
    app.router.add_post("/api/gdrive/auth/cancel", handle_gdrive_auth_cancel)
    app.router.add_post("/api/gdrive/disconnect", handle_gdrive_disconnect)
    app.router.add_get("/api/gdrive/loras", handle_gdrive_loras)
    app.router.add_post("/api/gdrive/download", handle_gdrive_download)
    app.router.add_get("/api/gdrive/download/{task_id}", handle_gdrive_download_status)
    app.router.add_post("/api/gdrive/download/{task_id}/cancel", handle_gdrive_download_cancel)
    app.router.add_get("/api/colab/config", handle_get_colab_config)
    app.router.add_post("/api/colab/config", handle_post_colab_config)
    app.router.add_get("/api/colab/notebooks", handle_colab_notebooks)
    app.router.add_post("/api/colab/sync-notebook", handle_colab_sync_notebook)
    app.router.add_get("/api/colab/endpoint", handle_colab_endpoint)
    app.router.add_post("/api/colab/auto-connect", handle_colab_auto_connect)
    app.router.add_post("/api/colab/open", handle_colab_open)
    return app


def main() -> None:
    parser = argparse.ArgumentParser(description="MOSS-Image Studio local web server")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=7860)
    parser.add_argument("--outputs-dir", default=None)
    parser.add_argument("--data-dir", default=None)
    args = parser.parse_args()

    app = create_app(
        outputs_dir=Path(args.outputs_dir) if args.outputs_dir else None,
        data_dir=Path(args.data_dir) if args.data_dir else None,
        port=args.port,
    )
    lan_ip = get_lan_ip()
    print("MOSS-Image Studio running at:")
    print(f"  Local:   http://127.0.0.1:{args.port}")
    print(f"  Mobile:  http://{lan_ip}:{args.port}")
    web.run_app(app, host=args.host, port=args.port, print=None)


if __name__ == "__main__":
    main()
