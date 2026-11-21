(function () {
  "use strict";

  const SVGNS = "http://www.w3.org/2000/svg";
  const VW = 1000;
  const VH = 1500;
  const MAX_PANELS = 8;
  const MAX_INSETS = 2;
  const AT_MIN = 0.15;
  const AT_MAX = 0.85;
  const SLANT_MAX = 0.2;
  const SNAPS = [1 / 3, 0.5, 2 / 3];
  const LOCAL_STORAGE_KEY = "moss_studio_comic_draft_v1";

  const TOP_EDGE = 1;
  const BOTTOM_EDGE = 2;
  const LEFT_EDGE = 4;
  const RIGHT_EDGE = 8;

  const SHOTS = [
    ["a medium shot", "半身"],
    ["a close-up", "特写"],
    ["an extreme close-up", "大特写"],
    ["a full-body view", "全身"],
    ["a cowboy shot", "七分身"],
    ["a wide shot", "远景"],
    ["a dynamic wide shot", "动态大场面"],
    ["a low-angle view", "仰角"],
    ["a high-angle view", "俯角"],
    ["a side view", "侧面"],
    ["a first-person point-of-view shot", "第一人称视角"],
  ];

  const BUBBLES = [
    ["top", "上方"],
    ["top left", "左上角"],
    ["top right", "右上角"],
    ["left side", "左侧"],
    ["right side", "右侧"],
    ["bottom", "下方"],
  ];

  const STYLE_MODES = {
    color_anime: [
      "vertical full-color anime manga page",
      "with saturated colors and clean anime line art",
    ],
    bw_manga: [
      "vertical black-and-white Japanese manga page",
      "with crisp black ink line art and detailed manga screentones",
    ],
    watercolor: [
      "vertical full-color watercolor comic page",
      "with delicate ink outlines and expressive watercolor washes",
    ],
  };

  const TEXT_LANGS = {
    zh_cn_v: "vertical black Simplified Chinese text",
    zh_cn_h: "horizontal black Simplified Chinese text",
    zh_tw_v: "vertical black Traditional Chinese text",
    ja_v: "vertical black Japanese text",
    en_h: "horizontal black English text",
  };

  const TEMPLATE_ORDER = [
    ["L3", "三格：右长左二"],
    ["L4", "四格：上二中大＋右下画中画"],
    ["L4w", "四格：上宽中二下大"],
    ["L5", "五格：上宽下二排"],
    ["L6", "六格：三排两列"],
    ["K4", "四格漫画：竖向四格"],
    ["ONE", "单页整格（从零切分）"],
  ];

  const NUM_EN = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight"];
  const ORD_EN = ["", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth"];

  const clone = (v) => JSON.parse(JSON.stringify(v));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const leaf = (id, brk = false) => ({ id, brk: Boolean(brk) });
  const cut = (split, at, a, b, slant = 0) => ({ split, at, slant, a, b });
  const isSplit = (n) => Boolean(n && (n.split === "row" || n.split === "col"));
  const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
  const esc = (s) =>
    String(s).replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));

  function blankPanel() {
    return { shot: "a medium shot", what: "", line: "", bubble: "top", sfx: "" };
  }

  function isFree(custom) {
    return Boolean(custom && typeof custom === "object" && (custom.v === 2 || (custom.tree && typeof custom.tree === "object")));
  }

  function presetCustom(id) {
    const L = leaf;
    const map = {
      L3: cut("col", 0.5, cut("row", 0.5, L("p2"), L("p3")), L("p1")),
      L4: cut("row", 0.3, cut("col", 0.5, L("p2"), L("p1")), L("p3")),
      L4w: cut("row", 0.25, L("p1"), cut("row", 0.4, cut("col", 0.5, L("p3"), L("p2")), L("p4"))),
      L5: cut("row", 0.3, L("p1"), cut("row", 0.5, cut("col", 0.5, L("p3"), L("p2")), cut("col", 0.5, L("p5"), L("p4")))),
      L6: cut("row", 0.333, cut("col", 0.5, L("p2"), L("p1")), cut("row", 0.5, cut("col", 0.5, L("p4"), L("p3")), cut("col", 0.5, L("p6"), L("p5")))),
      K4: cut("row", 0.25, L("p1"), cut("row", 0.333, L("p2"), cut("row", 0.5, L("p3"), L("p4")))),
      ONE: L("p1"),
    };
    const t = map[id];
    if (!t) return null;
    const insets = id === "L4" ? [{ id: "p4", x0: 0.6, y0: 0.68, x1: 0.97, y1: 0.97, brk: false }] : [];
    return { v: 2, tree: clone(t), insets };
  }

  function blank() {
    return {
      v: 2,
      tree: cut("row", 0.6, cut("col", 0.5, leaf("p2"), leaf("p1")), leaf("p3")),
      insets: [],
    };
  }

  function clipPoly(poly, p, q) {
    const side = (v) => (q[0] - p[0]) * (v[1] - p[1]) - (q[1] - p[1]) * (v[0] - p[0]);
    const neg = [];
    const pos = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const sa = side(a);
      const sb = side(b);
      if (sa <= 0) neg.push(a);
      if (sa >= 0) pos.push(a);
      if ((sa < 0 && sb > 0) || (sa > 0 && sb < 0)) {
        const t = sa / (sa - sb);
        const x = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        neg.push(x);
        pos.push(x);
      }
    }
    return [neg, pos];
  }

  function segIn(poly, p, q) {
    const d = [q[0] - p[0], q[1] - p[1]];
    const ts = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const e = [b[0] - a[0], b[1] - a[1]];
      const den = cross(d, e);
      if (Math.abs(den) < 1e-12) continue;
      const ap = [a[0] - p[0], a[1] - p[1]];
      const t = cross(ap, e) / den;
      const u = cross(ap, d) / den;
      if (u >= -1e-9 && u <= 1 + 1e-9) ts.push(t);
    }
    if (ts.length < 2) return [p, q];
    const t0 = Math.min(...ts);
    const t1 = Math.max(...ts);
    return [
      [p[0] + d[0] * t0, p[1] + d[1] * t0],
      [p[0] + d[0] * t1, p[1] + d[1] * t1],
    ];
  }

  function cutLine(n, r) {
    const [x0, y0, x1, y1] = r;
    const s = n.slant || 0;
    if (n.split === "row") {
      return [
        [x0, y0 + (y1 - y0) * (n.at - s)],
        [x1, y0 + (y1 - y0) * (n.at + s)],
      ];
    }
    return [
      [x0 + (x1 - x0) * (n.at - s), y0],
      [x0 + (x1 - x0) * (n.at + s), y1],
    ];
  }

  function inPoly(poly, x, y) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i];
      const [xj, yj] = poly[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  }

  function geometry(custom, readDir = "rtl") {
    const c = isFree(custom) ? custom : blank();
    const dir = String(readDir || "rtl").toLowerCase() === "ltr" ? "ltr" : "rtl";
    const cells = [];
    const cuts = [];

    const walk = (n, rect, poly, path, edges) => {
      if (isSplit(n)) {
        const [x0, y0, x1, y1] = rect;
        const at = clamp(Number.isFinite(+n.at) ? +n.at : 0.5, AT_MIN, AT_MAX);
        const slant = clamp(+n.slant || 0, -SLANT_MAX, SLANT_MAX);
        const cutSlant = Math.abs(slant) >= 0.01 ? 1 : 0;
        const line = cutLine({ split: n.split, at, slant }, rect);
        cuts.push({ path, split: n.split, at, slant, rect, seg: segIn(poly, line[0], line[1]) });
        const [neg, pos] = clipPoly(poly, line[0], line[1]);
        if (n.split === "row") {
          const y = y0 + (y1 - y0) * at;
          walk(n.a, [x0, y0, x1, y], neg, [...path, "a"], (edges & ~BOTTOM_EDGE) | (cutSlant * BOTTOM_EDGE));
          walk(n.b, [x0, y, x1, y1], pos, [...path, "b"], (edges & ~TOP_EDGE) | (cutSlant * TOP_EDGE));
        } else {
          const x = x0 + (x1 - x0) * at;
          const rightRect = [x, y0, x1, y1];
          const leftRect = [x0, y0, x, y1];
          const rightEdges = (edges & ~LEFT_EDGE) | (cutSlant * LEFT_EDGE);
          const leftEdges = (edges & ~RIGHT_EDGE) | (cutSlant * RIGHT_EDGE);
          if (dir === "ltr") {
            walk(n.a, leftRect, pos, [...path, "a"], leftEdges);
            walk(n.b, rightRect, neg, [...path, "b"], rightEdges);
          } else {
            walk(n.b, rightRect, neg, [...path, "b"], rightEdges);
            walk(n.a, leftRect, pos, [...path, "a"], leftEdges);
          }
        }
        return;
      }
      cells.push({
        id: String(n?.id ?? ""),
        rect,
        poly,
        brk: Boolean(n?.brk),
        slant: edges !== 0,
        inset: false,
        path,
      });
    };

    walk(
      c.tree,
      [0, 0, 1, 1],
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ],
      [],
      0
    );

    for (const s of (Array.isArray(c.insets) ? c.insets : []).slice(0, MAX_INSETS)) {
      const r = [Math.min(s.x0, s.x1), Math.min(s.y0, s.y1), Math.max(s.x0, s.x1), Math.max(s.y0, s.y1)];
      const cx = (r[0] + r[2]) / 2;
      const cy = (r[1] + r[3]) / 2;
      const host = cells.findIndex((k) => !k.inset && cx >= k.rect[0] && cx <= k.rect[2] && cy >= k.rect[1] && cy <= k.rect[3]);
      let at = host < 0 ? cells.length : host + 1;
      while (at < cells.length && cells[at].inset) at++;
      cells.splice(at, 0, {
        id: String(s.id),
        rect: r,
        poly: [
          [r[0], r[1]],
          [r[2], r[1]],
          [r[2], r[3]],
          [r[0], r[3]],
        ],
        brk: Boolean(s.brk),
        slant: false,
        inset: true,
        path: null,
      });
    }
    return { cells, cuts };
  }

  const readingIds = (custom, readDir = "rtl") => geometry(custom, readDir).cells.map((c) => c.id);
  const count = (custom) => geometry(custom).cells.length;

  function nextId(custom) {
    const used = readingIds(custom).map((id) => +(/^p(\d+)$/.exec(id)?.[1] || 0));
    return `p${Math.max(0, ...used) + 1}`;
  }

  function nodeAt(tree, path) {
    let n = tree;
    for (const k of path) n = n?.[k];
    return n;
  }

  function setAt(custom, path, node) {
    if (!path.length) {
      custom.tree = node;
      return;
    }
    nodeAt(custom.tree, path.slice(0, -1))[path[path.length - 1]] = node;
  }

  function leafPath(tree, id, path = []) {
    if (isSplit(tree)) return leafPath(tree.a, id, [...path, "a"]) || leafPath(tree.b, id, [...path, "b"]);
    return String(tree?.id ?? "") === id ? path : null;
  }

  function snapAt(v) {
    const s = SNAPS.find((k) => Math.abs(k - v) <= 0.025);
    return r3(clamp(s ?? v, AT_MIN, AT_MAX));
  }

  const slantOf = (s) => (Math.abs(s) < 0.01 ? 0 : r3(clamp(s, -SLANT_MAX, SLANT_MAX)));

  function splitCell(custom, id, split, at, slant = 0, readDir = "rtl") {
    if (count(custom) >= MAX_PANELS) return null;
    const c = clone(custom);
    const path = leafPath(c.tree, id);
    if (!path) return null;
    const old = nodeAt(c.tree, path);
    const add = leaf(nextId(custom));
    const a = r3(clamp(at, AT_MIN, AT_MAX));
    const s = slantOf(slant);
    let newNode;
    if (split === "row") {
      newNode = cut("row", a, old, add, s);
    } else if (String(readDir || "rtl").toLowerCase() === "ltr") {
      newNode = cut("col", a, old, add, s);
    } else {
      newNode = cut("col", a, add, old, s);
    }
    setAt(c, path, newNode);
    return c;
  }

  function removeCell(custom, id) {
    const c = clone(custom);
    const k = (c.insets || []).findIndex((s) => String(s.id) === id);
    if (k >= 0) {
      c.insets.splice(k, 1);
      return c;
    }
    const path = leafPath(c.tree, id);
    if (!path || !path.length) return null;
    const sib = nodeAt(c.tree, [...path.slice(0, -1), path[path.length - 1] === "a" ? "b" : "a"]);
    setAt(c, path.slice(0, -1), sib);
    return c;
  }

  function setCut(custom, path, opts = {}) {
    const c = clone(custom);
    const n = nodeAt(c.tree, path);
    if (!isSplit(n)) return c;
    if (opts.at !== undefined) n.at = r3(clamp(opts.at, AT_MIN, AT_MAX));
    if (opts.slant !== undefined) n.slant = slantOf(opts.slant);
    return c;
  }

  function parentCut(custom, id) {
    const p = leafPath(custom.tree, id);
    return p && p.length ? p.slice(0, -1) : null;
  }

  const nextSlant = (s) => (Math.abs(s) < 0.01 ? 0.08 : s > 0 ? -0.08 : 0);

  function toggleBrk(custom, id) {
    const c = clone(custom);
    const s = (c.insets || []).find((x) => String(x.id) === id);
    if (s) s.brk = !s.brk;
    else {
      const p = leafPath(c.tree, id);
      if (p) {
        const n = nodeAt(c.tree, p);
        n.brk = !n.brk;
      }
    }
    return c;
  }

  function insetBox([a, b, c, d]) {
    const fit = (lo, hi, min, max) => {
      lo = clamp(lo, 0, 1);
      const w = clamp(hi - lo, min, max);
      if (lo + w > 1) lo = 1 - w;
      return [r3(lo), r3(lo + w)];
    };
    const [x0, x1] = fit(Math.min(a, c), Math.max(a, c), 0.1, 0.7);
    const [y0, y1] = fit(Math.min(b, d), Math.max(b, d), 0.08, 0.7);
    return { x0, y0, x1, y1 };
  }

  function addInset(custom, rect) {
    if (count(custom) >= MAX_PANELS || (custom.insets || []).length >= MAX_INSETS) return null;
    const c = clone(custom);
    c.insets = Array.isArray(c.insets) ? c.insets : [];
    c.insets.push({ id: nextId(custom), ...insetBox(rect), brk: false });
    return c;
  }

  function moveInset(custom, id, rect) {
    const c = clone(custom);
    const s = (c.insets || []).find((x) => String(x.id) === id);
    if (s) Object.assign(s, insetBox(rect));
    return c;
  }

  function remap(oldIds, newIds, panels) {
    const list = Array.isArray(panels) ? panels : [];
    const by = new Map(oldIds.map((id, i) => [id, list[i]]));
    return [...newIds.map((id) => clone(by.get(id) || blankPanel())), ...list.slice(oldIds.length)];
  }

  function knife(r, p0, p1) {
    const [x0, y0, x1, y1] = r;
    const w = x1 - x0;
    const h = y1 - y0;
    const dx = p1[0] - p0[0];
    const dy = p1[1] - p0[1];
    const deg = (Math.atan2(Math.abs(dy) * 1.5, Math.abs(dx)) * 180) / Math.PI;
    if (deg <= 45) {
      const m = dy / (dx || 1e-9);
      const yl = p0[1] + m * (x0 - p0[0]);
      const yr = p0[1] + m * (x1 - p0[0]);
      return {
        split: "row",
        at: ((yl + yr) / 2 - y0) / h,
        slant: deg < 8 ? 0 : slantOf((yr - yl) / 2 / h),
        long: Math.abs(dx) >= w * 0.3,
      };
    }
    const m = dx / (dy || 1e-9);
    const xt = p0[0] + m * (y0 - p0[1]);
    const xb = p0[0] + m * (y1 - p0[1]);
    return {
      split: "col",
      at: ((xt + xb) / 2 - x0) / w,
      slant: 90 - deg < 8 ? 0 : slantOf((xb - xt) / 2 / w),
      long: Math.abs(dy) >= h * 0.3,
    };
  }

  const pts = (poly) => poly.map(([x, y]) => `${(x * VW).toFixed(1)},${(y * VH).toFixed(1)}`).join(" ");
  const center = (poly) => [
    poly.reduce((a, p) => a + p[0], 0) / poly.length,
    poly.reduce((a, p) => a + p[1], 0) / poly.length,
  ];

  function insetPoly(poly, k) {
    let P = poly.map(([x, y]) => [x * VW, y * VH]);
    P = P.filter((p, i) => {
      const q = P[(i + P.length - 1) % P.length];
      return Math.hypot(p[0] - q[0], p[1] - q[1]) > 0.5;
    });
    if (P.length < 3 || !k) return poly;
    let area = 0;
    P.forEach((a, i) => {
      area += cross(a, P[(i + 1) % P.length]);
    });
    const sg = area > 0 ? 1 : -1;
    const lines = P.map((a, i) => {
      const b = P[(i + 1) % P.length];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const d = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
      return { p: [a[0] - d[1] * sg * k, a[1] + d[0] * sg * k], d };
    });
    return lines.map((L, i) => {
      const M = lines[(i + lines.length - 1) % lines.length];
      const den = cross(M.d, L.d);
      if (Math.abs(den) < 1e-6) return [L.p[0] / VW, L.p[1] / VH];
      const t = cross([L.p[0] - M.p[0], L.p[1] - M.p[1]], L.d) / den;
      return [(M.p[0] + M.d[0] * t) / VW, (M.p[1] + M.d[1] * t) / VH];
    });
  }

  function draw(svg, custom, { sel = null, edit = false, readDir = "rtl" } = {}) {
    const g = geometry(custom, readDir);
    svg.setAttribute("viewBox", `0 0 ${VW} ${VH}`);
    const out = [`<rect class="cl-page" x="0" y="0" width="${VW}" height="${VH}"/>`];
    const order = g.cells.map((c, i) => [c, i]).sort((a, b) => Number(a[0].inset) - Number(b[0].inset));
    order.forEach(([c, i]) => {
      const id = esc(c.id);
      const [cx, cy] = c.inset ? [(c.rect[0] + c.rect[2]) / 2, (c.rect[1] + c.rect[3]) / 2] : center(c.poly);
      if (c.inset) out.push(`<polygon class="cl-halo" points="${pts(insetPoly(c.poly, -14))}"/>`);
      out.push(
        `<polygon class="cl-cell${c.inset ? " inset" : ""}${c.id === sel ? " sel" : ""}${c.brk ? " brk" : ""}" data-id="${id}" points="${pts(insetPoly(c.poly, c.inset ? 0 : 10))}"/>`
      );
      out.push(`<text class="cl-no" x="${(cx * VW).toFixed(1)}" y="${(cy * VH).toFixed(1)}">${i + 1}</text>`);
      if (c.brk) {
        out.push(`<text class="cl-brk" x="${(cx * VW).toFixed(1)}" y="${(cy * VH + 68).toFixed(1)}">破格</text>`);
      }
    });
    if (edit) {
      g.cuts.forEach((k, i) => {
        const [[ax, ay], [bx, by]] = k.seg;
        out.push(
          `<line class="cl-gut ${k.split}" data-cut="${i}" x1="${(ax * VW).toFixed(1)}" y1="${(ay * VH).toFixed(1)}" x2="${(bx * VW).toFixed(1)}" y2="${(by * VH).toFixed(1)}"/>`
        );
      });
      g.cells
        .filter((c) => c.inset)
        .forEach((c) => {
          out.push(
            `<rect class="cl-ih" data-id="${esc(c.id)}" x="${(c.rect[2] * VW - 30).toFixed(1)}" y="${(c.rect[3] * VH - 30).toFixed(1)}" width="40" height="40" rx="6"/>`
          );
        });
    }
    svg.innerHTML = out.join("");
    return g;
  }

  // ---- Mirror of comic_layout.py prompt compiler ----
  function vpos(r) {
    const cy = (r[1] + r[3]) / 2;
    if (r[3] - r[1] >= 0.9) return "full";
    if (cy < 0.36) return "top";
    if (cy > 0.64) return "bottom";
    return "middle";
  }

  function hpos(r) {
    const cx = (r[0] + r[2]) / 2;
    if (r[2] - r[0] >= 0.9) return "full";
    if (cx < 0.4) return "left";
    if (cx > 0.6) return "right";
    return "center";
  }

  function sizeWord(cell) {
    const r = cell.rect;
    const w = r[2] - r[0];
    const h = r[3] - r[1];
    if (cell.inset) return "small";
    if (h >= 0.9 && w < 0.75) return "tall";
    if (w >= 0.9 && h < 0.45) return "wide";
    if (w * h >= 0.3) return "large";
    if (w * h <= 0.08) return "small";
    return "";
  }

  function placeEn(vp, hp) {
    if (vp === "middle" && hp === "center") return "middle";
    if (vp === "full" && hp === "center") return "center";
    const vs = vp === "full" ? "" : vp;
    const hs = hp === "left" || hp === "right" ? hp : "";
    return [vs, hs].filter(Boolean).join(" ");
  }

  function cellEn(cell) {
    const vp = vpos(cell.rect);
    const hp = hpos(cell.rect);
    const slant = cell.slant ? "slanted " : "";
    if (cell.inset) {
      const p = placeEn(vp, hp) || "center";
      return `small ${slant}inset panel at the ${p}`;
    }
    if (vp === "full" && hp === "full") return "full-page panel";
    return [slant.trim(), sizeWord(cell), placeEn(vp, hp), "panel"].filter(Boolean).join(" ");
  }

  function cellZh(cell) {
    const vp = vpos(cell.rect);
    const hp = hpos(cell.rect);
    if (!cell.inset && vp === "full" && hp === "full") return "整页格";
    const placeMap = {
      "full:left": "左侧",
      "full:right": "右侧",
      "full:center": "中间",
      "full:full": "中间",
      "top:full": "顶部",
      "bottom:full": "底部",
      "middle:full": "中部",
      "top:left": "左上",
      "top:right": "右上",
      "bottom:left": "左下",
      "bottom:right": "右下",
      "middle:left": "中左",
      "middle:right": "中右",
      "top:center": "上中",
      "bottom:center": "下中",
      "middle:center": "中央",
    };
    const place = placeMap[`${vp}:${hp}`] || "分格";
    const slant = cell.slant ? "斜切" : "";
    if (cell.inset) return `${place}${slant}画中画`;
    const sizeZh = { tall: "竖长格", wide: "横宽格", large: "主格", small: "小格" }[sizeWord(cell)] || "格";
    return `${place}${slant}${sizeZh}`;
  }

  function cellPhrase(cell, name, hostName) {
    const vp = vpos(cell.rect);
    const hp = hpos(cell.rect);
    const slant = cell.slant ? "slanted " : "";
    if (cell.inset) {
      return hostName ? `a ${name} overlapping the ${hostName}` : `a ${name}`;
    }
    const sz = sizeWord(cell);
    if (vp === "full" && hp === "full") return "one full-page panel";
    if (vp === "full" && sz === "tall") {
      const side = hp === "left" ? "on the left" : hp === "right" ? "on the right" : "in the middle";
      return `a ${slant}tall panel ${side} that spans the full height of the page`;
    }
    if (hp === "full" && sz === "wide") {
      const at = vp === "top" ? "the top" : vp === "bottom" ? "the bottom" : "the middle of the page";
      return `a ${slant}wide panel across ${at}`;
    }
    return `a ${name}`;
  }

  function describeLayout(custom, readDir = "rtl") {
    const { cells } = geometry(custom, readDir);
    const rawEn = cells.map(cellEn);
    const rawZh = cells.map(cellZh);
    const slots = cells.map((_, i) => {
      const sameEn = [];
      rawEn.forEach((v, j) => {
        if (v === rawEn[i]) sameEn.push(j);
      });
      const en = sameEn.length > 1 ? `${ORD_EN[Math.min(8, sameEn.indexOf(i) + 1)]} ${rawEn[i]}` : rawEn[i];
      const zhCount = rawZh.filter((v) => v === rawZh[i]).length;
      const zh = zhCount > 1 ? `${rawZh[i]}（第${i + 1}格）` : rawZh[i];
      return { en, zh };
    });

    const phrases = cells.map((cell, i) => {
      let hostName = null;
      if (cell.inset) {
        for (let j = i - 1; j >= 0; j--) {
          if (!cells[j].inset) {
            hostName = slots[j].en;
            break;
          }
        }
      }
      return cellPhrase(cell, slots[i].en, hostName);
    });

    const n = cells.length;
    const desc = n === 1 ? phrases[0] : `${NUM_EN[Math.min(n, 8)]} panels: ${phrases.slice(0, -1).join(", ")}, and ${phrases[phrases.length - 1]}`;
    return { desc, slots, cells };
  }

  function sentence(text) {
    const clean = String(text || "").trim().replace(/[,，]+$/, "");
    if (!clean) return "";
    if (/[.!?。！？]$/.test(clean)) return clean;
    return `${clean}.`;
  }

  function compileComicPrompt(page) {
    const dir = String(page.read_dir || "rtl").toLowerCase() === "ltr" ? "ltr" : "rtl";
    const [styleOpen, styleClose] = STYLE_MODES[page.style_mode] || STYLE_MODES.color_anime;
    const textLangEn = TEXT_LANGS[page.text_lang] || TEXT_LANGS.zh_cn_v;
    const { desc, slots, cells } = describeLayout(page.custom, dir);
    const readPhrase = dir === "ltr" ? "left to right" : "right to left";
    const sentences = [
      `The image is a ${styleOpen} divided into ${desc}, separated by thin black borders with white gutters, read from ${readPhrase}.`,
    ];

    const charParts = [];
    for (const ch of (Array.isArray(page.chars) ? page.chars : []).slice(0, 4)) {
      const name = String(ch?.name || "").trim();
      if (!name) continue;
      const trig = String(ch?.trigger || "").trim().replace(/[,.]+$/, "");
      const txt = String(ch?.text || "").trim().replace(/[,.]+$/, "");
      const head = trig ? `${name} (${trig})` : name;
      charParts.push(sentence(txt ? `${head}: ${txt}` : head));
    }
    const freeCast = String(page.cast || "").trim();
    if (freeCast) charParts.push(sentence(freeCast));
    if (charParts.length) sentences.push(charParts.join(" "));

    const panels = Array.isArray(page.panels) ? page.panels : [];
    cells.forEach((cell, i) => {
      const p = panels[i] || {};
      const what = String(p.what || "").trim().replace(/[.,]+$/, "");
      const line = String(p.line || "").trim();
      const sfx = String(p.sfx || "").trim();
      if (!what && !line && !sfx) return;
      const shot = SHOTS.some(([en]) => en === p.shot) ? p.shot : "a medium shot";
      const bubble = BUBBLES.some(([en]) => en === p.bubble) ? p.bubble : "top";
      let s = what ? `The ${slots[i].en} shows ${shot} of ${what}` : `In the ${slots[i].en}`;
      if (line) {
        const safeLine = line.replace(/"/g, "\u201D");
        s += `; a white oval speech bubble at the ${bubble} of the panel contains the ${textLangEn} "${safeLine}"`;
      }
      if (sfx) {
        const safeSfx = sfx.replace(/"/g, "\u201D");
        s += `; a large hand-lettered sound effect "${safeSfx}" floats nearby`;
      }
      if (cell.brk) {
        s += "; the character bursts out of the panel border, overlapping the gutter";
      }
      sentences.push(sentence(s));
    });

    const light = String(page.light || "").trim();
    if (light) sentences.push(sentence(light));

    const mood = String(page.mood || "").trim() || "lively";
    sentences.push(`The page has a ${mood} mood ${styleClose}.`);

    const body = sentences.join(" ");
    const trigger = String(page.trigger || "").trim().replace(/[.,]+$/, "");
    return {
      prompt: trigger ? `${trigger}. ${body}` : body,
      slots,
      cells,
    };
  }

  // ---- Interactive Editor State & DOM Wiring ----
  const $ = (id) => document.getElementById(id);

  function defaultPageState() {
    return {
      custom: presetCustom("L4"),
      style_mode: "color_anime",
      text_lang: "zh_cn_v",
      read_dir: "rtl",
      trigger: "",
      cast: "",
      light: "",
      mood: "",
      chars: [],
      panels: [blankPanel(), blankPanel(), blankPanel(), blankPanel()],
    };
  }

  let callbacks = { onApply: null, onGenerate: null };
  let page = defaultPageState();
  let sel = null;
  let drag = null;
  let geo = null;
  let insetMode = false;
  let activeDraftId = "";
  let savedDrafts = [];
  const undoStack = [];
  const redoStack = [];

  let knifeLine = null;
  let ghostRect = null;

  function loadLocalDraft() {
    try {
      const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && isFree(parsed.custom)) {
        page = {
          ...defaultPageState(),
          ...parsed,
          chars: Array.isArray(parsed.chars) ? parsed.chars : [],
          panels: Array.isArray(parsed.panels) ? parsed.panels : [],
        };
      }
    } catch (_) {}
  }

  function saveLocalDraft() {
    try {
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(page));
    } catch (_) {}
  }

  function pushUndo(snapshot) {
    undoStack.push(clone(snapshot));
    if (undoStack.length > 60) undoStack.shift();
    redoStack.length = 0;
  }

  function updateUndoRedoButtons() {
    if ($("comicUndoBtn")) $("comicUndoBtn").disabled = undoStack.length === 0;
    if ($("comicRedoBtn")) $("comicRedoBtn").disabled = redoStack.length === 0;
  }

  function setInsetMode(on) {
    insetMode = Boolean(on);
    const btn = $("comicInsetBtn");
    const svg = $("comicCanvas");
    if (btn) {
      btn.classList.toggle("active", insetMode);
      btn.setAttribute("aria-pressed", String(insetMode));
    }
    if (svg) svg.classList.toggle("adding", insetMode);
  }

  function ensureOverlays() {
    if (!knifeLine) {
      knifeLine = document.createElementNS(SVGNS, "line");
      knifeLine.classList.add("cl-knife");
    }
    if (!ghostRect) {
      ghostRect = document.createElementNS(SVGNS, "rect");
      ghostRect.classList.add("cl-ghost");
    }
  }

  function toPage(x, y) {
    const svg = $("comicCanvas");
    const m = svg && svg.getScreenCTM();
    if (!m) return [0, 0];
    const pt = new DOMPoint(x, y).matrixTransform(m.inverse());
    return [clamp(pt.x / VW, 0, 1), clamp(pt.y / VH, 0, 1)];
  }

  function toScreen(x, y) {
    const svg = $("comicCanvas");
    const m = svg && svg.getScreenCTM();
    return m ? new DOMPoint(x * VW, y * VH).matrixTransform(m) : new DOMPoint(0, 0);
  }

  function showTip(e, text) {
    const tip = $("comicTip");
    const stage = $("comicStage");
    if (!tip || !stage) return;
    if (!text) {
      tip.classList.add("hidden");
      return;
    }
    const s = stage.getBoundingClientRect();
    tip.textContent = text;
    tip.classList.remove("hidden");
    const left = clamp(e.clientX - s.left + 14, 6, Math.max(6, s.width - tip.offsetWidth - 8));
    const top = clamp(e.clientY - s.top + 14, 6, Math.max(6, s.height - tip.offsetHeight - 8));
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  }

  function flashTip(text) {
    const tip = $("comicTip");
    if (!tip) return;
    tip.textContent = text;
    tip.style.left = "12px";
    tip.style.top = "12px";
    tip.classList.remove("hidden");
    setTimeout(() => {
      if (!drag && $("comicTip")) $("comicTip").classList.add("hidden");
    }, 1800);
  }

  function renderTools() {
    const tools = $("comicTools");
    const stage = $("comicStage");
    if (!tools || !stage || !geo) return;
    const cell = geo.cells.find((k) => k.id === sel);
    if (!cell) {
      tools.classList.add("hidden");
      return;
    }
    const pc = cell.inset ? null : parentCut(page.custom, cell.id);
    const k = pc && geo.cuts.find((x) => x.path.join() === pc.join());

    tools.innerHTML = "";
    const makeBtn = (label, title, fn, active = false) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `btn-mini${active ? " on" : ""}`;
      btn.textContent = label;
      btn.title = title;
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        fn();
      });
      return btn;
    };

    tools.appendChild(
      makeBtn(
        cell.inset ? "删除小格" : "合并",
        cell.inset ? "删除此画中画小格 (Delete)" : "删除当前格并将空间归并到相邻格 (Delete)",
        () => removeSelectedCell(cell.id)
      )
    );
    if (k) {
      const slantLabel = Math.abs(k.slant) > 0.01 ? (k.slant > 0 ? "斜切 /" : "斜切 \\") : "斜切";
      tools.appendChild(
        makeBtn(
          slantLabel,
          "切换分割线斜率（直 -> 左倾 -> 右倾 -> 直）",
          () => cycleCutSlant(pc),
          Math.abs(k.slant) > 0.01
        )
      );
    }
    tools.appendChild(
      makeBtn(
        "破格",
        "角色冲出格框线并压住留白（适合高潮分镜）",
        () => toggleCellBrk(cell.id),
        cell.brk
      )
    );

    tools.classList.remove("hidden");
    const s = stage.getBoundingClientRect();
    const p = toScreen(cell.rect[2], cell.rect[1]);
    const rawLeft = p.x - s.left - tools.offsetWidth - 6;
    const rawTop = p.y - s.top + 6;
    tools.style.left = `${clamp(rawLeft, 4, Math.max(4, s.width - tools.offsetWidth - 4))}px`;
    tools.style.top = `${clamp(rawTop, 4, Math.max(4, s.height - tools.offsetHeight - 4))}px`;
  }

  function refreshPromptOnly() {
    const compiled = compileComicPrompt(page);
    if ($("comicPromptPreview")) {
      $("comicPromptPreview").value = compiled.prompt;
    }
    saveLocalDraft();
    return compiled;
  }

  function renderPresetStrip() {
    const strip = $("comicPresets");
    if (!strip) return;
    strip.innerHTML = "";
    for (const [id, label] of TEMPLATE_ORDER) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cl-preset";
      btn.title = label;
      btn.setAttribute("aria-label", label);
      btn.setAttribute("data-template-id", id);
      const mini = document.createElementNS(SVGNS, "svg");
      mini.setAttribute("aria-hidden", "true");
      draw(mini, presetCustom(id), { edit: false, readDir: page.read_dir });
      btn.appendChild(mini);
      btn.addEventListener("click", () => applyTemplate(id));
      strip.appendChild(btn);
    }
  }

  function renderCanvas(liveCustom = null) {
    const svg = $("comicCanvas");
    if (!svg) return;
    ensureOverlays();
    geo = draw(svg, liveCustom || page.custom, { sel, edit: true, readDir: page.read_dir });
    svg.append(knifeLine, ghostRect);

    if ($("comicCountBadge")) {
      $("comicCountBadge").textContent = `${geo.cells.length} / ${MAX_PANELS} 格`;
    }
    const insetCount = geo.cells.filter((c) => c.inset).length;
    if ($("comicInsetBtn")) {
      $("comicInsetBtn").disabled = geo.cells.length >= MAX_PANELS || insetCount >= MAX_INSETS;
      if ($("comicInsetBtn").disabled && insetMode) setInsetMode(false);
    }
    updateUndoRedoButtons();
    if (!liveCustom) {
      renderTools();
    }
  }

  function syncActivePanelHighlight() {
    document.querySelectorAll(".comic-panel-card").forEach((card) => {
      card.classList.toggle("active", Boolean(sel && card.getAttribute("data-cell-id") === sel));
    });
  }

  function selectCell(id, { scrollCard = false } = {}) {
    sel = id;
    renderCanvas();
    syncActivePanelHighlight();
    if (scrollCard && id) {
      const card = document.querySelector(`.comic-panel-card[data-cell-id="${id}"]`);
      if (card) card.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }

  function renderGlobalInputs() {
    if ($("comicStyleSelect")) $("comicStyleSelect").value = page.style_mode || "color_anime";
    if ($("comicTextLangSelect")) $("comicTextLangSelect").value = page.text_lang || "zh_cn_v";
    if ($("comicReadDirSelect")) $("comicReadDirSelect").value = page.read_dir || "rtl";
    if ($("comicCastInput")) $("comicCastInput").value = page.cast || "";
    if ($("comicTriggerInput")) $("comicTriggerInput").value = page.trigger || "";
    if ($("comicLightInput")) $("comicLightInput").value = page.light || "";
    if ($("comicMoodInput")) $("comicMoodInput").value = page.mood || "";
    renderCharsList();
  }

  function renderCharsList() {
    const box = $("comicCharsList");
    if (!box) return;
    box.innerHTML = "";
    const chars = Array.isArray(page.chars) ? page.chars : [];
    if ($("comicAddCharBtn")) $("comicAddCharBtn").disabled = chars.length >= 4;

    if (chars.length === 0) {
      const empty = document.createElement("div");
      empty.className = "muted-text";
      empty.textContent = "尚未添加角色卡；点击「+ 添加角色」可固定主角外貌与 LoRA 触发词。";
      box.appendChild(empty);
      return;
    }

    chars.forEach((ch, idx) => {
      const row = document.createElement("div");
      row.className = "comic-char-row";

      const topRow = document.createElement("div");
      topRow.className = "comic-char-top";

      const nameInp = document.createElement("input");
      nameInp.type = "text";
      nameInp.placeholder = "角色名 (如 Lin)";
      nameInp.value = ch.name || "";
      nameInp.addEventListener("input", () => {
        page.chars[idx].name = nameInp.value;
        refreshPromptOnly();
      });

      const trigInp = document.createElement("input");
      trigInp.type = "text";
      trigInp.placeholder = "触发词 (可选)";
      trigInp.value = ch.trigger || "";
      trigInp.addEventListener("input", () => {
        page.chars[idx].trigger = trigInp.value;
        refreshPromptOnly();
      });

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "btn-mini btn-danger";
      delBtn.textContent = "删除";
      delBtn.addEventListener("click", () => {
        page.chars.splice(idx, 1);
        renderCharsList();
        refreshPromptOnly();
      });

      topRow.append(nameInp, trigInp, delBtn);

      const descInp = document.createElement("input");
      descInp.type = "text";
      descInp.placeholder = "英文外貌特征（如 long silver hair, red eyes, school uniform）";
      descInp.value = ch.text || "";
      descInp.addEventListener("input", () => {
        page.chars[idx].text = descInp.value;
        refreshPromptOnly();
      });

      row.append(topRow, descInp);
      box.appendChild(row);
    });
  }

  function renderPanelsList() {
    const box = $("comicPanelsList");
    if (!box) return;
    const compiled = compileComicPrompt(page);
    if ($("comicPromptPreview")) $("comicPromptPreview").value = compiled.prompt;

    while (page.panels.length < compiled.cells.length) {
      page.panels.push(blankPanel());
    }

    box.innerHTML = "";
    compiled.cells.forEach((cell, idx) => {
      const slot = compiled.slots[idx];
      const pData = page.panels[idx] || blankPanel();

      const card = document.createElement("div");
      card.className = `comic-panel-card${sel === cell.id ? " active" : ""}`;
      card.setAttribute("data-panel-idx", String(idx));
      card.setAttribute("data-cell-id", cell.id);

      card.addEventListener("focusin", () => {
        if (sel !== cell.id) {
          sel = cell.id;
          renderCanvas();
          syncActivePanelHighlight();
        }
      });
      card.addEventListener("click", (ev) => {
        if (ev.target.closest("input, textarea, select, button")) return;
        if (sel !== cell.id) {
          sel = cell.id;
          renderCanvas();
          syncActivePanelHighlight();
        }
      });

      const head = document.createElement("div");
      head.className = "comic-panel-head";

      const numBadge = document.createElement("span");
      numBadge.className = "comic-panel-num";
      numBadge.textContent = String(idx + 1).padStart(2, "0");

      const posLabel = document.createElement("span");
      posLabel.className = "comic-panel-pos";
      posLabel.textContent = slot.zh;

      const tagsWrap = document.createElement("span");
      tagsWrap.className = "comic-panel-tags";
      if (cell.inset) {
        const tag = document.createElement("span");
        tag.className = "badge";
        tag.textContent = "画中画";
        tagsWrap.appendChild(tag);
      }
      if (cell.brk) {
        const tag = document.createElement("span");
        tag.className = "badge comic-brk-badge";
        tag.textContent = "破格";
        tagsWrap.appendChild(tag);
      }

      const shotSel = document.createElement("select");
      shotSel.className = "comic-shot-select";
      shotSel.setAttribute("aria-label", `第 ${idx + 1} 格景别`);
      for (const [en, zh] of SHOTS) {
        const opt = document.createElement("option");
        opt.value = en;
        opt.textContent = zh;
        shotSel.appendChild(opt);
      }
      shotSel.value = SHOTS.some(([en]) => en === pData.shot) ? pData.shot : "a medium shot";
      shotSel.addEventListener("change", () => {
        page.panels[idx].shot = shotSel.value;
        refreshPromptOnly();
      });

      head.append(numBadge, posLabel, tagsWrap, shotSel);

      const whatInput = document.createElement("textarea");
      whatInput.className = "comic-panel-what";
      whatInput.rows = 2;
      whatInput.spellcheck = false;
      whatInput.placeholder = `第 ${idx + 1} 格画面描述（英文），例如：Lin looking surprised at the doorway`;
      whatInput.value = pData.what || "";
      whatInput.addEventListener("input", () => {
        page.panels[idx].what = whatInput.value;
        refreshPromptOnly();
      });

      const lineRow = document.createElement("div");
      lineRow.className = "comic-panel-line-row";

      const lineInput = document.createElement("input");
      lineInput.type = "text";
      lineInput.className = "comic-panel-line";
      lineInput.placeholder = "对白台词（中文短句，可空）";
      lineInput.value = pData.line || "";
      lineInput.addEventListener("input", () => {
        page.panels[idx].line = lineInput.value;
        refreshPromptOnly();
      });

      const bubbleSel = document.createElement("select");
      bubbleSel.setAttribute("aria-label", `第 ${idx + 1} 格气泡位置`);
      for (const [en, zh] of BUBBLES) {
        const opt = document.createElement("option");
        opt.value = en;
        opt.textContent = `气泡:${zh}`;
        bubbleSel.appendChild(opt);
      }
      bubbleSel.value = BUBBLES.some(([en]) => en === pData.bubble) ? pData.bubble : "top";
      bubbleSel.addEventListener("change", () => {
        page.panels[idx].bubble = bubbleSel.value;
        refreshPromptOnly();
      });

      const sfxInput = document.createElement("input");
      sfxInput.type = "text";
      sfxInput.placeholder = "拟声词 (如 ドキッ)";
      sfxInput.value = pData.sfx || "";
      sfxInput.addEventListener("input", () => {
        page.panels[idx].sfx = sfxInput.value;
        refreshPromptOnly();
      });

      lineRow.append(lineInput, bubbleSel, sfxInput);
      card.append(head, whatInput, lineRow);
      box.appendChild(card);
    });
  }

  function renderAll({ liveCustom = null } = {}) {
    renderCanvas(liveCustom);
    if (!liveCustom) {
      renderPanelsList();
      saveLocalDraft();
    }
  }

  function commitLayout(nextCustom, { byOrder = false } = {}) {
    const oldIds = readingIds(page.custom, page.read_dir);
    const newIds = readingIds(nextCustom, page.read_dir);
    if (!byOrder) {
      page.panels = remap(oldIds, newIds, page.panels);
    } else {
      while (page.panels.length < newIds.length) page.panels.push(blankPanel());
    }
    page.custom = nextCustom;
    if (sel && !newIds.includes(sel)) sel = null;
    renderAll();
  }

  function applyTemplate(templateId) {
    const tmpl = presetCustom(templateId);
    if (!tmpl) return;
    pushUndo(page);
    sel = null;
    commitLayout(tmpl, { byOrder: true });
    if ($("comicPresets")) {
      $("comicPresets")
        .querySelectorAll(".cl-preset")
        .forEach((b) => b.classList.toggle("active", b.getAttribute("data-template-id") === templateId));
    }
  }

  function removeSelectedCell(id) {
    const next = removeCell(page.custom, id);
    if (!next) {
      flashTip("整页至少需要保留 1 格");
      return;
    }
    pushUndo(page);
    sel = null;
    commitLayout(next, { byOrder: false });
  }

  function cycleCutSlant(path) {
    if (!geo) return;
    const k = geo.cuts.find((x) => x.path.join() === path.join());
    pushUndo(page);
    const next = setCut(page.custom, path, { slant: nextSlant(k?.slant || 0) });
    commitLayout(next, { byOrder: false });
  }

  function toggleCellBrk(id) {
    pushUndo(page);
    const next = toggleBrk(page.custom, id);
    commitLayout(next, { byOrder: false });
  }

  function doUndo() {
    if (!undoStack.length) return;
    redoStack.push(clone(page));
    page = undoStack.pop();
    sel = null;
    renderGlobalInputs();
    renderAll();
  }

  function doRedo() {
    if (!redoStack.length) return;
    undoStack.push(clone(page));
    page = redoStack.pop();
    sel = null;
    renderGlobalInputs();
    renderAll();
  }

  // ---- Saved Drafts API ----
  async function loadDraftsList() {
    try {
      const resp = await fetch("/api/comic-pages");
      const data = await resp.json();
      savedDrafts = Array.isArray(data.items) ? data.items : [];
      renderDraftSelect();
    } catch (_) {}
  }

  function renderDraftSelect() {
    const selEl = $("comicDraftSelect");
    if (!selEl) return;
    const prev = activeDraftId;
    selEl.innerHTML = `<option value="">选择已存草稿...</option>`;
    for (const item of savedDrafts) {
      const opt = document.createElement("option");
      opt.value = item.id;
      opt.textContent = item.name;
      selEl.appendChild(opt);
    }
    if (prev && savedDrafts.some((d) => d.id === prev)) {
      selEl.value = prev;
    } else {
      activeDraftId = "";
      selEl.value = "";
    }
    if ($("comicDelDraftBtn")) $("comicDelDraftBtn").disabled = !activeDraftId;
  }

  async function saveDraft() {
    const nameEl = $("comicDraftNameInput");
    let name = nameEl ? nameEl.value.trim() : "";
    if (!name && activeDraftId) {
      const cur = savedDrafts.find((d) => d.id === activeDraftId);
      if (cur) name = cur.name;
    }
    if (!name) {
      name = `分镜草稿 ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`;
      if (nameEl) nameEl.value = name;
    }
    const resp = await fetch("/api/comic-pages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: activeDraftId || undefined,
        name,
        page,
      }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      flashTip(data.error || "保存失败");
      return;
    }
    savedDrafts = Array.isArray(data.items) ? data.items : [];
    activeDraftId = data.item?.id || "";
    renderDraftSelect();
    flashTip(`已保存「${name}」`);
  }

  async function deleteCurrentDraft() {
    if (!activeDraftId) return;
    const resp = await fetch(`/api/comic-pages/${encodeURIComponent(activeDraftId)}`, {
      method: "DELETE",
    });
    const data = await resp.json();
    if (!resp.ok) {
      flashTip(data.error || "删除失败");
      return;
    }
    savedDrafts = Array.isArray(data.items) ? data.items : [];
    activeDraftId = "";
    if ($("comicDraftNameInput")) $("comicDraftNameInput").value = "";
    renderDraftSelect();
    flashTip("已删除草稿");
  }

  function applyDraftById(draftId) {
    if (!draftId) {
      activeDraftId = "";
      if ($("comicDelDraftBtn")) $("comicDelDraftBtn").disabled = true;
      return;
    }
    const found = savedDrafts.find((d) => d.id === draftId);
    if (!found || !found.page) return;
    pushUndo(page);
    activeDraftId = found.id;
    if ($("comicDraftNameInput")) $("comicDraftNameInput").value = found.name || "";
    if ($("comicDelDraftBtn")) $("comicDelDraftBtn").disabled = false;
    page = {
      ...defaultPageState(),
      ...clone(found.page),
      custom: isFree(found.page.custom) ? clone(found.page.custom) : presetCustom("L4"),
    };
    sel = null;
    renderGlobalInputs();
    renderPresetStrip();
    renderAll();
  }

  // ---- Canvas Pointer Events ----
  function bindCanvasEvents() {
    const svg = $("comicCanvas");
    if (!svg) return;
    const cellAt = ([x, y]) => (geo ? [...geo.cells].reverse().find((c) => inPoly(c.poly, x, y)) : null);
    const far = (a, b) => Math.hypot((a[0] - b[0]) * VW, (a[1] - b[1]) * VH) > 24;

    svg.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || !geo) return;
      e.preventDefault();
      svg.focus({ preventScroll: true });
      try {
        svg.setPointerCapture(e.pointerId);
      } catch (_) {}
      const p = toPage(e.clientX, e.clientY);
      const t = e.target;
      const start = clone(page);

      if (t.classList?.contains("cl-gut")) {
        drag = { mode: "gut", k: geo.cuts[Number(t.dataset.cut)], p, start };
        return;
      }
      if (t.classList?.contains("cl-ih")) {
        const c = geo.cells.find((x) => x.id === t.dataset.id);
        if (c) drag = { mode: "resize", id: c.id, r0: [...c.rect], p, start };
        return;
      }
      const c = cellAt(p);
      const adding = e.shiftKey || insetMode;
      if (!c) return;
      if (c.inset && !adding) {
        drag = { mode: "move", id: c.id, r0: [...c.rect], p, start };
        return;
      }
      drag = { mode: adding ? "inset" : "knife", c, p, q: p, start };
    });

    svg.addEventListener("pointermove", (e) => {
      const p = toPage(e.clientX, e.clientY);
      if (!drag) {
        const t = e.target.classList;
        showTip(e, t?.contains("cl-gut") ? "拖动调整分格比例" : t?.contains("cl-ih") ? "拖动调整小格尺寸" : "");
        return;
      }
      drag.moved = drag.moved || far(p, drag.p);
      drag.q = p;
      ensureOverlays();

      if (drag.mode === "gut") {
        const { k } = drag;
        const [x0, y0, x1, y1] = k.rect;
        drag.at = snapAt(k.split === "row" ? (p[1] - y0) / (y1 - y0) : (p[0] - x0) / (x1 - x0));
        renderCanvas(setCut(page.custom, k.path, { at: drag.at }));
        showTip(e, `${Math.round(drag.at * 100)}%`);
      } else if (drag.mode === "knife") {
        if (!drag.moved) return;
        knifeLine.setAttribute("x1", (drag.p[0] * VW).toFixed(1));
        knifeLine.setAttribute("y1", (drag.p[1] * VH).toFixed(1));
        knifeLine.setAttribute("x2", (p[0] * VW).toFixed(1));
        knifeLine.setAttribute("y2", (p[1] * VH).toFixed(1));
        knifeLine.classList.add("on");
        const kf = knife(drag.c.rect, drag.p, p);
        showTip(e, kf.long ? `松开＝${kf.split === "row" ? "横切" : "竖切"}${kf.slant ? "（斜切）" : ""}` : "继续拖动超过 30%");
      } else if (drag.mode === "inset") {
        const [a, b] = drag.p;
        ghostRect.setAttribute("x", (Math.min(a, p[0]) * VW).toFixed(1));
        ghostRect.setAttribute("y", (Math.min(b, p[1]) * VH).toFixed(1));
        ghostRect.setAttribute("width", (Math.abs(p[0] - a) * VW).toFixed(1));
        ghostRect.setAttribute("height", (Math.abs(p[1] - b) * VH).toFixed(1));
        ghostRect.classList.toggle("on", Boolean(drag.moved));
        showTip(e, drag.moved ? "松开＝叠加画中画小格" : "");
      } else {
        const dx = p[0] - drag.p[0];
        const dy = p[1] - drag.p[1];
        const [x0, y0, x1, y1] = drag.r0;
        if (drag.mode === "move") {
          const w = x1 - x0;
          const h = y1 - y0;
          const nx = clamp(x0 + dx, 0, 1 - w);
          const ny = clamp(y0 + dy, 0, 1 - h);
          drag.rect = [nx, ny, nx + w, ny + h];
        } else {
          drag.rect = [x0, y0, x1 + dx, y1 + dy];
        }
        if (drag.moved) renderCanvas(moveInset(page.custom, drag.id, drag.rect));
      }
    });

    const finish = (e, cancel = false) => {
      const d = drag;
      drag = null;
      ensureOverlays();
      knifeLine.classList.remove("on");
      ghostRect.classList.remove("on");
      showTip(e, "");
      if (!d) return;
      if (cancel) {
        renderCanvas();
        return;
      }

      if (d.mode === "gut") {
        if (d.at !== undefined && d.at !== d.k.at) {
          pushUndo(d.start);
          commitLayout(setCut(page.custom, d.k.path, { at: d.at }), { byOrder: false });
        } else {
          renderCanvas();
        }
        return;
      }
      if (d.mode === "move" || d.mode === "resize") {
        if (!d.moved) {
          selectCell(d.id, { scrollCard: true });
          return;
        }
        pushUndo(d.start);
        commitLayout(moveInset(page.custom, d.id, d.rect), { byOrder: false });
        return;
      }
      if (!d.moved) {
        selectCell(d.c.id, { scrollCard: true });
        return;
      }
      if (d.mode === "inset") {
        setInsetMode(false);
        const addedId = nextId(page.custom);
        const next = addInset(page.custom, [d.p[0], d.p[1], d.q[0], d.q[1]]);
        if (!next) {
          flashTip((page.custom.insets || []).length >= MAX_INSETS ? `最多叠加 ${MAX_INSETS} 个小格` : `整页最多 ${MAX_PANELS} 格`);
          renderCanvas();
          return;
        }
        pushUndo(d.start);
        sel = addedId;
        commitLayout(next, { byOrder: false });
        syncActivePanelHighlight();
        return;
      }

      const kf = knife(d.c.rect, d.p, d.q);
      if (!kf.long) {
        selectCell(d.c.id, { scrollCard: true });
        return;
      }
      const next = splitCell(page.custom, d.c.id, kf.split, kf.at, kf.slant, page.read_dir);
      if (!next) {
        flashTip(`整页最多 ${MAX_PANELS} 格`);
        renderCanvas();
        return;
      }
      pushUndo(d.start);
      sel = null;
      commitLayout(next, { byOrder: false });
    };

    svg.addEventListener("pointerup", (e) => finish(e, false));
    svg.addEventListener("pointercancel", (e) => finish(e, true));
    svg.addEventListener("pointerleave", (e) => {
      if (!drag) showTip(e, "");
    });
  }

  function bindModalEvents() {
    const modal = $("comicModal");
    const backdrop = $("comicBackdrop");
    let downOnBack = false;
    if (backdrop) {
      backdrop.addEventListener("pointerdown", () => {
        downOnBack = true;
      });
      backdrop.addEventListener("click", () => {
        if (downOnBack) close();
        downOnBack = false;
      });
    }
    if (modal) {
      modal.addEventListener("pointerup", () => {
        setTimeout(() => (downOnBack = false), 0);
      });
    }

    $("comicCloseBtn")?.addEventListener("click", close);
    $("comicInsetBtn")?.addEventListener("click", () => setInsetMode(!insetMode));
    $("comicUndoBtn")?.addEventListener("click", doUndo);
    $("comicRedoBtn")?.addEventListener("click", doRedo);

    $("comicStyleSelect")?.addEventListener("change", () => {
      page.style_mode = $("comicStyleSelect").value;
      refreshPromptOnly();
    });
    $("comicTextLangSelect")?.addEventListener("change", () => {
      page.text_lang = $("comicTextLangSelect").value;
      refreshPromptOnly();
    });
    $("comicReadDirSelect")?.addEventListener("change", () => {
      page.read_dir = $("comicReadDirSelect").value;
      renderPresetStrip();
      renderAll();
    });

    $("comicCastInput")?.addEventListener("input", () => {
      page.cast = $("comicCastInput").value;
      refreshPromptOnly();
    });
    $("comicTriggerInput")?.addEventListener("input", () => {
      page.trigger = $("comicTriggerInput").value;
      refreshPromptOnly();
    });
    $("comicLightInput")?.addEventListener("input", () => {
      page.light = $("comicLightInput").value;
      refreshPromptOnly();
    });
    $("comicMoodInput")?.addEventListener("input", () => {
      page.mood = $("comicMoodInput").value;
      refreshPromptOnly();
    });

    $("comicAddCharBtn")?.addEventListener("click", () => {
      if (!Array.isArray(page.chars)) page.chars = [];
      if (page.chars.length >= 4) return;
      page.chars.push({ name: "", trigger: "", text: "" });
      renderCharsList();
      refreshPromptOnly();
    });

    $("comicDraftSelect")?.addEventListener("change", () => applyDraftById($("comicDraftSelect").value));
    $("comicSaveDraftBtn")?.addEventListener("click", saveDraft);
    $("comicDelDraftBtn")?.addEventListener("click", deleteCurrentDraft);

    $("comicCopyPromptBtn")?.addEventListener("click", async () => {
      const compiled = refreshPromptOnly();
      try {
        await navigator.clipboard.writeText(compiled.prompt);
        const btn = $("comicCopyPromptBtn");
        btn.textContent = "已复制";
        setTimeout(() => (btn.textContent = "复制提示词"), 1500);
      } catch (_) {}
    });

    $("comicApplyBtn")?.addEventListener("click", () => {
      const compiled = refreshPromptOnly();
      const autoSize = Boolean($("comicAutoSizeCheck")?.checked);
      if (callbacks.onApply) callbacks.onApply(compiled.prompt, { autoSize, width: 832, height: 1248 });
      close();
    });

    $("comicGenerateBtn")?.addEventListener("click", () => {
      const compiled = refreshPromptOnly();
      const autoSize = Boolean($("comicAutoSizeCheck")?.checked);
      close();
      if (callbacks.onGenerate) callbacks.onGenerate(compiled.prompt, { autoSize, width: 832, height: 1248 });
    });

    document.addEventListener(
      "keydown",
      (e) => {
        if (!isOpen()) return;
        const typing = Boolean(e.target?.closest?.("input, textarea, select"));
        const mod = e.ctrlKey || e.metaKey;
        const key = (e.key || "").toLowerCase();

        if (mod && key === "z" && !typing) {
          e.preventDefault();
          e.stopPropagation();
          if (e.shiftKey) doRedo();
          else doUndo();
        } else if (mod && key === "y" && !typing) {
          e.preventDefault();
          e.stopPropagation();
          doRedo();
        } else if ((e.key === "Delete" || e.key === "Backspace") && sel && !typing) {
          e.preventDefault();
          e.stopPropagation();
          removeSelectedCell(sel);
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          if (drag) {
            drag = null;
            ensureOverlays();
            knifeLine.classList.remove("on");
            ghostRect.classList.remove("on");
            renderCanvas();
          } else if (insetMode) {
            setInsetMode(false);
          } else if (sel) {
            selectCell(null);
          } else {
            close();
          }
        }
      },
      true
    );

    if (typeof ResizeObserver !== "undefined" && $("comicStage")) {
      const ro = new ResizeObserver(() => {
        if (isOpen() && !drag && geo) renderTools();
      });
      ro.observe($("comicStage"));
    }
  }

  function isOpen() {
    const modal = $("comicModal");
    return Boolean(modal && !modal.classList.contains("hidden"));
  }

  async function open() {
    const modal = $("comicModal");
    if (!modal) return;
    modal.classList.remove("hidden");
    renderGlobalInputs();
    renderPresetStrip();
    renderAll();
    requestAnimationFrame(() => renderTools());
    await loadDraftsList();
  }

  function close() {
    const modal = $("comicModal");
    if (!modal) return;
    setInsetMode(false);
    modal.classList.add("hidden");
  }

  function init(opts = {}) {
    callbacks = {
      onApply: typeof opts.onApply === "function" ? opts.onApply : null,
      onGenerate: typeof opts.onGenerate === "function" ? opts.onGenerate : null,
    };
    loadLocalDraft();
    bindCanvasEvents();
    bindModalEvents();
  }

  window.MossComicEditor = {
    init,
    open,
    close,
    isOpen,
    compileComicPrompt,
    _internal: {
      presetCustom,
      blank,
      geometry,
      splitCell,
      removeCell,
      toggleBrk,
      addInset,
      knife,
      compileComicPrompt,
    },
  };
})();
