"""PaintDeck-inspired MOSS-Image comic BSP layout engine and prompt compiler."""

from __future__ import annotations

from typing import Any

MAX_PANELS = 8
MAX_INSETS = 2
MAX_DEPTH = 8
MAX_CHARS = 4
AT_MIN = 0.15
AT_MAX = 0.85
SLANT_MAX = 0.2
MOSS_COMIC_SIZE = (832, 1248)

TOP_EDGE = 1
BOTTOM_EDGE = 2
LEFT_EDGE = 4
RIGHT_EDGE = 8

SHOTS: list[tuple[str, str]] = [
    ("a medium shot", "半身"),
    ("a close-up", "特写"),
    ("an extreme close-up", "大特写"),
    ("a full-body view", "全身"),
    ("a cowboy shot", "七分身"),
    ("a wide shot", "远景"),
    ("a dynamic wide shot", "动态大场面"),
    ("a low-angle view", "仰角"),
    ("a high-angle view", "俯角"),
    ("a side view", "侧面"),
    ("a first-person point-of-view shot", "第一人称视角"),
]
VALID_SHOTS = {en for en, _ in SHOTS}

BUBBLES: list[tuple[str, str]] = [
    ("top", "上方"),
    ("top left", "左上角"),
    ("top right", "右上角"),
    ("left side", "左侧"),
    ("right side", "右侧"),
    ("bottom", "下方"),
]
VALID_BUBBLES = {en for en, _ in BUBBLES}

STYLE_MODES: dict[str, tuple[str, str]] = {
    "color_anime": (
        "vertical full-color anime manga page",
        "with saturated colors and clean anime line art",
    ),
    "bw_manga": (
        "vertical black-and-white Japanese manga page",
        "with crisp black ink line art and detailed manga screentones",
    ),
    "watercolor": (
        "vertical full-color watercolor comic page",
        "with delicate ink outlines and expressive watercolor washes",
    ),
}

TEXT_LANGS: dict[str, str] = {
    "zh_cn_v": "vertical black Simplified Chinese text",
    "zh_cn_h": "horizontal black Simplified Chinese text",
    "zh_tw_v": "vertical black Traditional Chinese text",
    "ja_v": "vertical black Japanese text",
    "en_h": "horizontal black English text",
}


def _leaf(cell_id: str, brk: bool = False) -> dict[str, Any]:
    return {"id": cell_id, "brk": brk}


def _cut(
    split: str,
    at: float,
    a: dict[str, Any],
    b: dict[str, Any],
    slant: float = 0.0,
) -> dict[str, Any]:
    return {"split": split, "at": at, "slant": slant, "a": a, "b": b}


PRESET_LAYOUTS: dict[str, dict[str, Any]] = {
    "L3": {
        "v": 2,
        "tree": _cut("col", 0.5, _cut("row", 0.5, _leaf("p2"), _leaf("p3")), _leaf("p1")),
        "insets": [],
    },
    "L4": {
        "v": 2,
        "tree": _cut("row", 0.3, _cut("col", 0.5, _leaf("p2"), _leaf("p1")), _leaf("p3")),
        "insets": [{"id": "p4", "x0": 0.6, "y0": 0.68, "x1": 0.97, "y1": 0.97, "brk": False}],
    },
    "L4w": {
        "v": 2,
        "tree": _cut(
            "row",
            0.25,
            _leaf("p1"),
            _cut("row", 0.4, _cut("col", 0.5, _leaf("p3"), _leaf("p2")), _leaf("p4")),
        ),
        "insets": [],
    },
    "L5": {
        "v": 2,
        "tree": _cut(
            "row",
            0.3,
            _leaf("p1"),
            _cut(
                "row",
                0.5,
                _cut("col", 0.5, _leaf("p3"), _leaf("p2")),
                _cut("col", 0.5, _leaf("p5"), _leaf("p4")),
            ),
        ),
        "insets": [],
    },
    "L6": {
        "v": 2,
        "tree": _cut(
            "row",
            0.333,
            _cut("col", 0.5, _leaf("p2"), _leaf("p1")),
            _cut(
                "row",
                0.5,
                _cut("col", 0.5, _leaf("p4"), _leaf("p3")),
                _cut("col", 0.5, _leaf("p6"), _leaf("p5")),
            ),
        ),
        "insets": [],
    },
    "K4": {
        "v": 2,
        "tree": _cut(
            "row",
            0.25,
            _leaf("p1"),
            _cut("row", 0.333, _leaf("p2"), _cut("row", 0.5, _leaf("p3"), _leaf("p4"))),
        ),
        "insets": [],
    },
    "ONE": {
        "v": 2,
        "tree": _leaf("p1"),
        "insets": [],
    },
}

_NUM_EN = ("zero", "one", "two", "three", "four", "five", "six", "seven", "eight")
_ORD_EN = ("", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth")


def blank_custom() -> dict[str, Any]:
    """Return default 3-panel storyboard layout (2 top + 1 wide bottom)."""
    return {
        "v": 2,
        "tree": _cut("row", 0.6, _cut("col", 0.5, _leaf("p2"), _leaf("p1")), _leaf("p3")),
        "insets": [],
    }


def _r3(val: float) -> float:
    return round(val * 1000.0) / 1000.0


def _clamp(val: float, lo: float, hi: float) -> float:
    return min(hi, max(lo, val))


def _clean_id(raw_id: Any) -> str:
    text = str(raw_id or "")
    cleaned = "".join(ch for ch in text if ch.isascii() and (ch.isalnum() or ch in ("_", "-")))
    return cleaned[:16]


def _to_float(val: Any, default: float | None = None) -> float | None:
    try:
        num = float(val)
    except (TypeError, ValueError):
        return default
    if num != num or num in (float("inf"), float("-inf")):
        return default
    return num


def _inset_rect(raw: Any) -> list[float] | None:
    if not isinstance(raw, dict):
        return None
    coords: list[float] = []
    for key in ("x0", "y0", "x1", "y1"):
        val = _to_float(raw.get(key))
        if val is None:
            return None
        coords.append(_clamp(val, 0.0, 1.0))
    r = [
        min(coords[0], coords[2]),
        min(coords[1], coords[3]),
        max(coords[0], coords[2]),
        max(coords[1], coords[3]),
    ]
    w, h = r[2] - r[0], r[3] - r[1]
    if w < 0.08 or h < 0.06 or w > 0.7 or h > 0.7:
        return None
    return r


def _clean_tree(
    node: Any,
    depth: int,
    room: list[int],
    seen: set[str],
    next_idx: list[int],
) -> dict[str, Any]:
    node_dict = node if isinstance(node, dict) else {}
    split = str(node_dict.get("split") or "")
    if split in ("row", "col") and depth < MAX_DEPTH and room[0] > 0:
        room[0] -= 1
        at_raw = _to_float(node_dict.get("at"), 0.5)
        at = _clamp(at_raw if at_raw is not None else 0.5, AT_MIN, AT_MAX)
        slant_raw = _to_float(node_dict.get("slant"), 0.0)
        slant = _clamp(slant_raw if slant_raw is not None else 0.0, -SLANT_MAX, SLANT_MAX)
        if abs(slant) < 0.01:
            slant = 0.0
        a = _clean_tree(node_dict.get("a"), depth + 1, room, seen, next_idx)
        b = _clean_tree(node_dict.get("b"), depth + 1, room, seen, next_idx)
        return {
            "split": split,
            "at": _r3(at),
            "slant": _r3(slant),
            "a": a,
            "b": b,
        }

    cid = _clean_id(node_dict.get("id"))
    while not cid or cid in seen:
        next_idx[0] += 1
        cid = f"p{next_idx[0]}"
    seen.add(cid)
    return {"id": cid, "brk": bool(node_dict.get("brk") is True)}


def clean_free(custom: Any) -> dict[str, Any]:
    """Validate and normalize a v2 BSP + inset comic layout object."""
    if not isinstance(custom, dict) or not isinstance(custom.get("tree"), dict):
        return blank_custom()

    raw_insets = custom.get("insets") if isinstance(custom.get("insets"), list) else []
    valid_rects: list[tuple[dict[str, Any], list[float]]] = []
    for item in raw_insets:
        rect = _inset_rect(item)
        if rect is not None:
            valid_rects.append((item, rect))
            if len(valid_rects) >= MAX_INSETS:
                break

    room = [max(0, MAX_PANELS - len(valid_rects) - 1)]
    seen: set[str] = set()
    next_idx = [0]
    tree = _clean_tree(custom.get("tree"), 0, room, seen, next_idx)

    insets_out: list[dict[str, Any]] = []
    for raw_item, rect in valid_rects:
        cid = _clean_id(raw_item.get("id"))
        while not cid or cid in seen:
            next_idx[0] += 1
            cid = f"p{next_idx[0]}"
        seen.add(cid)
        insets_out.append(
            {
                "id": cid,
                "x0": _r3(rect[0]),
                "y0": _r3(rect[1]),
                "x1": _r3(rect[2]),
                "y1": _r3(rect[3]),
                "brk": bool(raw_item.get("brk") is True),
            }
        )
    return {"v": 2, "tree": tree, "insets": insets_out}


def _walk_tree(
    node: dict[str, Any],
    rect: list[float],
    edges: int,
    read_dir: str,
    out: list[dict[str, Any]],
) -> None:
    split = node.get("split")
    if split in ("row", "col"):
        at = float(node.get("at", 0.5))
        cut_slant = 1 if abs(float(node.get("slant", 0.0))) >= 0.01 else 0
        x0, y0, x1, y1 = rect
        if split == "row":
            y = y0 + (y1 - y0) * at
            _walk_tree(
                node["a"],
                [x0, y0, x1, y],
                (edges & ~BOTTOM_EDGE) | (cut_slant * BOTTOM_EDGE),
                read_dir,
                out,
            )
            _walk_tree(
                node["b"],
                [x0, y, x1, y1],
                (edges & ~TOP_EDGE) | (cut_slant * TOP_EDGE),
                read_dir,
                out,
            )
        else:
            x = x0 + (x1 - x0) * at
            right_rect = [x, y0, x1, y1]
            left_rect = [x0, y0, x, y1]
            right_edges = (edges & ~LEFT_EDGE) | (cut_slant * LEFT_EDGE)
            left_edges = (edges & ~RIGHT_EDGE) | (cut_slant * RIGHT_EDGE)
            if read_dir == "ltr":
                _walk_tree(node["a"], left_rect, left_edges, read_dir, out)
                _walk_tree(node["b"], right_rect, right_edges, read_dir, out)
            else:
                _walk_tree(node["b"], right_rect, right_edges, read_dir, out)
                _walk_tree(node["a"], left_rect, left_edges, read_dir, out)
        return

    out.append(
        {
            "id": str(node.get("id") or ""),
            "rect": rect,
            "slant": edges != 0,
            "brk": bool(node.get("brk")),
            "inset": False,
        }
    )


def free_cells(custom: Any, read_dir: str = "rtl") -> list[dict[str, Any]]:
    """Return ordered panel cells from a v2 BSP+inset layout."""
    cleaned = clean_free(custom)
    direction = "ltr" if str(read_dir or "").lower() == "ltr" else "rtl"
    cells: list[dict[str, Any]] = []
    _walk_tree(cleaned["tree"], [0.0, 0.0, 1.0, 1.0], 0, direction, cells)

    for ins in cleaned["insets"]:
        rect = [ins["x0"], ins["y0"], ins["x1"], ins["y1"]]
        cx = (rect[0] + rect[2]) / 2.0
        cy = (rect[1] + rect[3]) / 2.0
        host = next(
            (
                idx
                for idx, cell in enumerate(cells)
                if not cell["inset"]
                and cell["rect"][0] <= cx <= cell["rect"][2]
                and cell["rect"][1] <= cy <= cell["rect"][3]
            ),
            None,
        )
        at = len(cells) if host is None else host + 1
        while at < len(cells) and cells[at]["inset"]:
            at += 1
        cells.insert(
            at,
            {
                "id": ins["id"],
                "rect": rect,
                "slant": False,
                "brk": bool(ins.get("brk")),
                "inset": True,
            },
        )
    return cells


def _vpos(r: list[float]) -> str:
    cy = (r[1] + r[3]) / 2.0
    if r[3] - r[1] >= 0.9:
        return "full"
    if cy < 0.36:
        return "top"
    if cy > 0.64:
        return "bottom"
    return "middle"


def _hpos(r: list[float]) -> str:
    cx = (r[0] + r[2]) / 2.0
    if r[2] - r[0] >= 0.9:
        return "full"
    if cx < 0.4:
        return "left"
    if cx > 0.6:
        return "right"
    return "center"


def _size_word(cell: dict[str, Any]) -> str:
    r = cell["rect"]
    w, h = r[2] - r[0], r[3] - r[1]
    if cell["inset"]:
        return "small"
    if h >= 0.9 and w < 0.75:
        return "tall"
    if w >= 0.9 and h < 0.45:
        return "wide"
    if w * h >= 0.3:
        return "large"
    if w * h <= 0.08:
        return "small"
    return ""


def _place_en(vp: str, hp: str) -> str:
    if vp == "middle" and hp == "center":
        return "middle"
    if vp == "full" and hp == "center":
        return "center"
    vs = "" if vp == "full" else vp
    hs = hp if hp in ("left", "right") else ""
    return " ".join(p for p in (vs, hs) if p)


def _cell_en(cell: dict[str, Any]) -> str:
    vp, hp = _vpos(cell["rect"]), _hpos(cell["rect"])
    slant = "slanted " if cell["slant"] else ""
    if cell["inset"]:
        p = _place_en(vp, hp) or "center"
        return f"small {slant}inset panel at the {p}"
    if vp == "full" and hp == "full":
        return "full-page panel"
    words = [slant.strip(), _size_word(cell), _place_en(vp, hp), "panel"]
    return " ".join(w for w in words if w)


def _cell_zh(cell: dict[str, Any]) -> str:
    vp, hp = _vpos(cell["rect"]), _hpos(cell["rect"])
    if not cell["inset"] and vp == "full" and hp == "full":
        return "整页格"
    place_map = {
        ("full", "left"): "左侧",
        ("full", "right"): "右侧",
        ("full", "center"): "中间",
        ("full", "full"): "中间",
        ("top", "full"): "顶部",
        ("bottom", "full"): "底部",
        ("middle", "full"): "中部",
        ("top", "left"): "左上",
        ("top", "right"): "右上",
        ("bottom", "left"): "左下",
        ("bottom", "right"): "右下",
        ("middle", "left"): "中左",
        ("middle", "right"): "中右",
        ("top", "center"): "上中",
        ("bottom", "center"): "下中",
        ("middle", "center"): "中央",
    }
    place = place_map.get((vp, hp), "分格")
    slant = "斜切" if cell["slant"] else ""
    if cell["inset"]:
        return f"{place}{slant}画中画"
    size_zh = {
        "tall": "竖长格",
        "wide": "横宽格",
        "large": "主格",
        "small": "小格",
    }.get(_size_word(cell), "格")
    return f"{place}{slant}{size_zh}"


def _cell_phrase(cell: dict[str, Any], name: str, host_name: str | None) -> str:
    vp, hp = _vpos(cell["rect"]), _hpos(cell["rect"])
    slant = "slanted " if cell["slant"] else ""
    if cell["inset"]:
        return f"a {name} overlapping the {host_name}" if host_name else f"a {name}"
    sz = _size_word(cell)
    if vp == "full" and hp == "full":
        return "one full-page panel"
    if vp == "full" and sz == "tall":
        side = "on the left" if hp == "left" else ("on the right" if hp == "right" else "in the middle")
        return f"a {slant}tall panel {side} that spans the full height of the page"
    if hp == "full" and sz == "wide":
        at = "the top" if vp == "top" else ("the bottom" if vp == "bottom" else "the middle of the page")
        return f"a {slant}wide panel across {at}"
    return f"a {name}"


def free_layout(custom: Any, read_dir: str = "rtl") -> tuple[str, list[tuple[str, str]], list[dict[str, Any]]]:
    """Generate overall layout sentence, ordered (en, zh) names, and cell list."""
    cells = free_cells(custom, read_dir=read_dir)
    raw_en = [_cell_en(c) for c in cells]
    raw_zh = [_cell_zh(c) for c in cells]
    slots: list[tuple[str, str]] = []
    for i in range(len(cells)):
        same_en = [j for j, name in enumerate(raw_en) if name == raw_en[i]]
        if len(same_en) > 1:
            ord_idx = min(8, same_en.index(i) + 1)
            en_name = f"{_ORD_EN[ord_idx]} {raw_en[i]}"
        else:
            en_name = raw_en[i]
        zh_name = f"{raw_zh[i]}（第{i + 1}格）" if raw_zh.count(raw_zh[i]) > 1 else raw_zh[i]
        slots.append((en_name, zh_name))

    phrases: list[str] = []
    for i, cell in enumerate(cells):
        host_name = None
        if cell["inset"]:
            for j in range(i - 1, -1, -1):
                if not cells[j]["inset"]:
                    host_name = slots[j][0]
                    break
        phrases.append(_cell_phrase(cell, slots[i][0], host_name))

    n = len(cells)
    if n == 1:
        desc = phrases[0]
    else:
        desc = f"{_NUM_EN[min(n, 8)]} panels: {', '.join(phrases[:-1])}, and {phrases[-1]}"
    return desc, slots, cells


def _sentence(text: str) -> str:
    clean = str(text or "").strip().rstrip(",，")
    if not clean:
        return ""
    if clean.endswith((".", "!", "?", "。", "！", "？")):
        return clean
    return f"{clean}."


def _cast_text(page: dict[str, Any]) -> str:
    parts: list[str] = []
    raw_chars = page.get("chars") if isinstance(page.get("chars"), list) else []
    for ch in raw_chars[:MAX_CHARS]:
        if not isinstance(ch, dict):
            continue
        name = str(ch.get("name") or "").strip()
        if not name:
            continue
        trig = str(ch.get("trigger") or "").strip().rstrip(",.")
        desc = str(ch.get("text") or "").strip().rstrip(",.")
        head = f"{name} ({trig})" if trig else name
        parts.append(_sentence(f"{head}: {desc}" if desc else head))
    free_cast = str(page.get("cast") or "").strip()
    if free_cast:
        parts.append(_sentence(free_cast))
    return " ".join(p for p in parts if p)


def compile_comic_prompt(page: Any) -> dict[str, Any]:
    """Compile a PaintDeck-style storyboard page definition into a MOSS-Image prompt."""
    if not isinstance(page, dict):
        raise ValueError("分镜数据结构无效")

    read_dir = "ltr" if str(page.get("read_dir") or "").lower() == "ltr" else "rtl"
    style_key = str(page.get("style_mode") or "color_anime")
    style_open, style_close = STYLE_MODES.get(style_key, STYLE_MODES["color_anime"])
    text_lang_key = str(page.get("text_lang") or "zh_cn_v")
    text_lang_en = TEXT_LANGS.get(text_lang_key, TEXT_LANGS["zh_cn_v"])

    desc_en, slots, cells = free_layout(page.get("custom"), read_dir=read_dir)
    read_phrase = "left to right" if read_dir == "ltr" else "right to left"
    sentences = [
        f"The image is a {style_open} divided into {desc_en}, separated by thin black borders with white gutters, read from {read_phrase}."
    ]

    cast = _cast_text(page)
    if cast:
        sentences.append(cast)

    panels = page.get("panels") if isinstance(page.get("panels"), list) else []
    for i, ((slot_en, _), cell) in enumerate(zip(slots, cells)):
        panel = panels[i] if i < len(panels) and isinstance(panels[i], dict) else {}
        what = str(panel.get("what") or "").strip().rstrip(".,")
        line = str(panel.get("line") or "").strip()
        sfx = str(panel.get("sfx") or "").strip()
        if not what and not line and not sfx:
            continue
        shot = str(panel.get("shot") or "").strip()
        if shot not in VALID_SHOTS:
            shot = "a medium shot"
        bubble = str(panel.get("bubble") or "").strip()
        if bubble not in VALID_BUBBLES:
            bubble = "top"

        if what:
            s = f"The {slot_en} shows {shot} of {what}"
        else:
            s = f"In the {slot_en}"
        if line:
            safe_line = line.replace('"', "\u201D")
            s += (
                f'; a white oval speech bubble at the {bubble} of the panel '
                f'contains the {text_lang_en} "{safe_line}"'
            )
        if sfx:
            safe_sfx = sfx.replace('"', "\u201D")
            s += f'; a large hand-lettered sound effect "{safe_sfx}" floats nearby'
        if cell["brk"]:
            s += "; the character bursts out of the panel border, overlapping the gutter"
        sentences.append(_sentence(s))

    light = str(page.get("light") or "").strip()
    if light:
        sentences.append(_sentence(light))

    mood = str(page.get("mood") or "").strip() or "lively"
    sentences.append(f"The page has a {mood} mood {style_close}.")

    body = " ".join(sentences)
    trigger = str(page.get("trigger") or "").strip().rstrip(".,")
    full_prompt = f"{trigger}. {body}" if trigger else body

    slot_items = [
        {
            "id": cell["id"],
            "en": slot_en,
            "zh": slot_zh,
            "brk": cell["brk"],
            "inset": cell["inset"],
            "slant": cell["slant"],
        }
        for (slot_en, slot_zh), cell in zip(slots, cells)
    ]
    return {
        "prompt": full_prompt,
        "layout_desc": desc_en,
        "slots": slot_items,
        "panel_count": len(cells),
    }
