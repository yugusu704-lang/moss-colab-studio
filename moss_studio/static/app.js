const DEFAULT_MODELS = {
  unet: "moss_image_sft_int8_convrot.safetensors",
  clip: "qwen3.5_9b_int8_convrot.safetensors",
  vae: "flux2-vae.safetensors",
  turboLora: "moss_image_sft_4step_v2.0.safetensors",
  dmd2Loras: ["lodestones-8-steps-dmd2-lora.safetensors", "8-steps-dmd2-lora.safetensors"],
  remacriModels: ["4x_foolhardy_Remacri.pth", "remacri_original.safetensors", "remacri_original.pth"],
  seedvr2Dit: "seedvr2_ema_7b_sharp_fp16.safetensors",
  seedvr2Vae: "ema_vae_fp16.safetensors",
};

const PRESETS = {
  poster:
    '一张现代极简风格的品牌展览海报，米白色肌理纸张背景，画面中央是一只橘猫戴着黑色墨镜，上方用醒目的黑色粗体中文写着："今天也要开心"，下方写着小字"MOSS IMAGE STUDIO"，干净排版，高清晰度。',
  portrait:
    "电影级人像摄影，傍晚柔和的黄金逆光，一位身穿米色风衣的年轻亚洲女性站在城市天台边缘，微风吹动发丝，背景是虚化的都市霓虹夜景，85mm f/1.4 镜头，胶片颗粒质感，肤质细腻真实。",
  anime:
    "日系精美二次元插画，阳光洒进安静的图书馆靠窗座位，少女坐在木桌前翻看旧书，窗外是盛开的樱花树与湛蓝天空，通透清新的赛璐璐光影，丰富发丝细节，新海诚风格氛围感。",
  courtyard:
    "江南水乡雨后古风庭院，青石板地面带着水洼倒影，白墙黛瓦，一棵古梅树探出红墙，石桌上放着冒热气的青瓷茶壶，柔和阴天散射光，建筑摄影，写实细节。",
};

const state = {
  mode: "shinobisat",
  connected: false,
  supportsBypassLora: true,
  supportsSeedvr2: false,
  supportsCloudDownload: false,
  availableLoras: [],
  availableUpscalers: [],
  loras: [],
  loraMeta: {},
  presets: [],
  parsedMeta: null,
  initImage: null,
  lastSeed: null,
  currentJobId: null,
  pollTimer: null,
  ws: null,
  wsConnected: false,
  wsReconnectTimer: null,
  queueSnapshot: { active_job_id: null, queued_count: 0, jobs: [] },
  galleryTab: "all",
  gallerySearch: "",
  trashCount: 0,
  currentImages: [],
  currentImageIdx: 0,
  compareView: "compare",
  historyItems: [],
  lightboxItem: null,
  lanUrl: "http://127.0.0.1:7860",
  suggestedSpeedLora: null,
  civitaiApiKey: "",
  civitaiCursor: "",
  civitaiHasMore: false,
  civitaiLoading: false,
  civitaiQuerySeq: 0,
  civitaiItems: [],
  civitaiDownloads: {},
  gdriveStatus: null,
  gdriveLoras: [],
  gdriveLoraItems: [],
  downloadChannel: "gdrive",
  colabUrl: "",
  colabNotebookRemote: "Colab Notebooks/MOSS_Studio_Colab.ipynb",
  colabNotebooks: [],
  colabWaiting: false,
};

const $ = (id) => document.getElementById(id);

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasPromptWord(text, word) {
  if (!text || !word) return false;
  const re = new RegExp(`(?:^|[,，\\s])${escapeRegExp(word.trim())}(?:$|[,，\\s])`, "i");
  return re.test(text);
}

function toggleTriggerWordInPrompt(word) {
  const input = $("positiveInput");
  if (!input || !word) return;
  const clean = word.trim();
  const cur = input.value;
  if (hasPromptWord(cur, clean)) {
    const rmRe = new RegExp(`(?:^|\\s*[,，]\\s*)${escapeRegExp(clean)}(?=\\s*[,，]|\\s*$)`, "gi");
    let next = cur.replace(rmRe, "").replace(/^[\s,，]+|[\s,，]+$/g, "").replace(/\s*,\s*,\s*/g, ", ");
    input.value = next;
  } else {
    const trimmed = cur.trim();
    if (!trimmed) {
      input.value = clean;
    } else {
      const sep = /[,，\s]$/.test(trimmed) ? " " : ", ";
      input.value = `${trimmed}${sep}${clean}`;
    }
  }
  renderLoraTriggerBar();
}

function renderLoraTriggerBar() {
  const bar = $("loraTriggerBar");
  if (!bar) return;
  const promptText = $("positiveInput") ? $("positiveInput").value : "";
  const seen = new Set();
  const words = [];

  for (const l of state.loras) {
    if (!l || l.enabled === false || !l.name) continue;
    const baseName = l.name.split(/[\\/]/).pop();
    const meta = state.loraMeta[l.name] || state.loraMeta[baseName];
    const list = meta && Array.isArray(meta.trained_words) ? meta.trained_words : [];
    for (const w of list) {
      const clean = String(w || "").trim();
      if (clean && !seen.has(clean.toLowerCase())) {
        seen.add(clean.toLowerCase());
        words.push(clean);
      }
    }
  }

  bar.innerHTML = "";
  if (words.length === 0) {
    bar.classList.add("hidden");
    return;
  }
  bar.classList.remove("hidden");
  for (const word of words.slice(0, 18)) {
    const chip = document.createElement("button");
    chip.type = "button";
    const used = hasPromptWord(promptText, word);
    chip.className = `lora-trigger-chip${used ? " used" : ""}`;
    chip.textContent = word;
    chip.title = used ? `点击移除触发词：${word}` : `点击加入触发词：${word}`;
    chip.addEventListener("click", () => toggleTriggerWordInPrompt(word));
    bar.appendChild(chip);
  }
}

function bindDropZone(zoneEl, inputEl, onFile) {
  if (!zoneEl || !inputEl) return;
  zoneEl.addEventListener("click", () => inputEl.click());
  zoneEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      inputEl.click();
    }
  });
  inputEl.addEventListener("change", () => {
    const file = inputEl.files && inputEl.files[0];
    if (file) onFile(file);
    inputEl.value = "";
  });
  zoneEl.addEventListener("dragover", (e) => {
    e.preventDefault();
    zoneEl.classList.add("is-dragover");
  });
  zoneEl.addEventListener("dragleave", () => {
    zoneEl.classList.remove("is-dragover");
  });
  zoneEl.addEventListener("drop", (e) => {
    e.preventDefault();
    zoneEl.classList.remove("is-dragover");
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) onFile(file);
  });
}

function handleAutoPunctInput(textareaEl) {
  if (!$("autoPunctCheck") || !$("autoPunctCheck").checked || !textareaEl) return;
  const val = textareaEl.value;
  const pos = textareaEl.selectionStart ?? val.length;
  const mapPunct = { "，": ",", "、": ",", "：": ":", "（": "(", "）": ")" };
  const replaced = val.replace(/([A-Za-z0-9_)\]])([，、：（）])/g, (_, prev, p) => prev + mapPunct[p]);
  if (replaced !== val) {
    textareaEl.value = replaced;
    try {
      textareaEl.setSelectionRange(pos, pos);
    } catch (_) {}
  }
}

function updateBridgeBadge() {
  const driveReady = Boolean(state.gdriveStatus && state.gdriveStatus.mounted);
  const colabReady = Boolean(state.connected && state.supportsCloudDownload);

  const badge = $("bridgeStatusBadge");
  if (badge) {
    if (driveReady && colabReady) {
      badge.className = "bridge-badge online";
      badge.textContent = "Drive 已挂载 · Colab 已就绪";
    } else if (driveReady) {
      badge.className = "bridge-badge online";
      badge.textContent = "Google Drive 已挂载（免开 Colab）";
    } else if (colabReady) {
      badge.className = "bridge-badge online";
      badge.textContent = "支持 Colab 云端桥接";
    } else if (state.connected) {
      badge.className = "bridge-badge offline";
      badge.textContent = "未挂载 Drive（未检测到云端桥接）";
    } else {
      badge.className = "bridge-badge offline";
      badge.textContent = "未挂载 Drive（可搜索与复制直链）";
    }
  }

  const pathText = $("civitaiDrivePathText");
  if (pathText) {
    if (driveReady && state.gdriveStatus) {
      const dest =
        state.gdriveStatus.mode === "local"
          ? state.gdriveStatus.local_dir
          : state.gdriveStatus.target_dir;
      pathText.textContent = `目标：${dest}`;
      pathText.title = dest;
    } else {
      pathText.textContent = "目标：未挂载 Google Drive（点击右侧配置）";
      pathText.title = "";
    }
  }
}

function mountLoraByName(targetLora, strength) {
  if (!targetLora) return;
  const baseName = targetLora.split(/[\\/]/).pop();
  const meta = state.loraMeta[targetLora] || state.loraMeta[baseName];
  const resolvedStrength =
    typeof strength === "number"
      ? strength
      : Number(meta && meta.default_strength ? meta.default_strength : 1.0);
  const existing = state.loras.find((l) => l.name === targetLora);
  if (existing) {
    existing.enabled = true;
    existing.strength = resolvedStrength;
  } else {
    state.loras.unshift({ enabled: true, name: targetLora, strength: resolvedStrength });
  }
  renderLoras();
}

function setStatus(kind, text) {
  const pill = $("statusPill");
  pill.classList.remove("status-offline", "status-online", "status-error");
  pill.classList.add(
    kind === "online" ? "status-online" : kind === "error" ? "status-error" : "status-offline"
  );
  $("statusText").textContent = text;
}

function showError(msg, action = null) {
  const banner = $("errorBanner");
  if (!banner) return;
  banner.innerHTML = "";
  if (!msg) {
    banner.classList.add("hidden");
    return;
  }
  const textSpan = document.createElement("span");
  textSpan.textContent = msg;
  banner.appendChild(textSpan);
  if (action && action.label && typeof action.onClick === "function") {
    const actBtn = document.createElement("button");
    actBtn.type = "button";
    actBtn.className = "btn-mini btn-accent";
    actBtn.textContent = action.label;
    actBtn.addEventListener("click", () => action.onClick());
    banner.appendChild(actBtn);
  }
  banner.classList.remove("hidden");
}

function snap16(val, fallback = 896, maxDim = 2560) {
  const n = parseInt(val, 10);
  if (Number.isNaN(n)) return fallback;
  const clamped = Math.max(256, Math.min(maxDim, n));
  return Math.max(256, Math.floor(clamped / 16) * 16);
}

function updateResSummary() {
  const w = snap16($("widthInput").value, 896);
  const h = snap16($("heightInput").value, 1152);
  $("resSummary").textContent = `${w} × ${h}`;

  const mode = $("upscaleModeSelect").value;
  if (mode === "hires") {
    const factor = parseFloat($("upscaleFactorSelect").value) || 1.5;
    const upW = snap16(Math.round(w * factor), 1344, 3072);
    const upH = snap16(Math.round(h * factor), 1728, 3072);
    $("targetResPreview").textContent = `${w}×${h} → ${upW}×${upH}`;
  } else if (mode === "seedvr2") {
    const r = $("seedvr2ResInput").value || 2048;
    $("targetResPreview").textContent = `${w}×${h} → SeedVR2 (${r}p)`;
  } else {
    $("targetResPreview").textContent = `直出 ${w}×${h}`;
  }
}

function updateUpscalePanels() {
  const mode = $("upscaleModeSelect").value;
  $("hiresPanel").classList.toggle("hidden", mode !== "hires");
  $("seedvr2Panel").classList.toggle("hidden", mode !== "seedvr2");
  $("seedvr2Warn").classList.toggle("hidden", !state.connected || state.supportsSeedvr2);
  updateResSummary();
}

function populateSelect(selectEl, items, preferred) {
  const prev = selectEl.value;
  const merged = [];
  const seen = new Set();
  for (const name of [...(items || []), preferred, prev].filter(Boolean)) {
    if (!seen.has(name)) {
      seen.add(name);
      merged.push(name);
    }
  }
  selectEl.innerHTML = "";
  for (const name of merged) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    selectEl.appendChild(opt);
  }
  if (preferred && seen.has(preferred)) {
    selectEl.value = preferred;
  } else if (prev && seen.has(prev)) {
    selectEl.value = prev;
  }
}

function populateUpscaleSelect(items) {
  const selectEl = $("upscaleModelSelect");
  const prev = selectEl.value;
  selectEl.innerHTML = "";

  const noneOpt = document.createElement("option");
  noneOpt.value = "none";
  noneOpt.textContent = "无（直接 Lanczos 放大）";
  selectEl.appendChild(noneOpt);

  const seen = new Set(["none"]);
  for (const name of items || []) {
    if (name && !seen.has(name)) {
      seen.add(name);
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      selectEl.appendChild(opt);
    }
  }

  const preferredRemacri = DEFAULT_MODELS.remacriModels.find((m) => seen.has(m));
  if (prev && prev !== "none" && seen.has(prev)) {
    selectEl.value = prev;
  } else if (preferredRemacri) {
    selectEl.value = preferredRemacri;
  } else if (items && items.length > 0) {
    selectEl.value = items[0];
  } else {
    selectEl.value = "none";
  }
}

function getMergedAvailableLoras() {
  const seen = new Set();
  const merged = [];
  for (const name of [...(state.availableLoras || []), ...(state.gdriveLoras || [])]) {
    const clean = String(name || "").trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    merged.push(clean);
  }
  return merged;
}

function updateSpeedLoraNotice() {
  const notice = $("speedLoraNotice");
  const txt = $("speedLoraNoticeText");
  const btn = $("autoMountSpeedBtn");
  const allLoras = getMergedAvailableLoras();

  if (state.mode === "shinobisat") {
    notice.classList.remove("hidden");
    const foundDmd = DEFAULT_MODELS.dmd2Loras.find((n) => allLoras.includes(n));
    state.suggestedSpeedLora = foundDmd || null;
    const mounted = foundDmd && state.loras.some((l) => l.name === foundDmd && l.enabled);
    if (mounted) {
      txt.innerHTML = `已挂载加速 LoRA：<code>${foundDmd}</code>`;
      btn.classList.add("hidden");
    } else if (foundDmd) {
      txt.innerHTML = `检测到云盘已有 <code>${foundDmd}</code>，建议挂载（10~16 步，CFG 1.0）`;
      btn.classList.remove("hidden");
    } else {
      txt.innerHTML =
        "建议搭配 <code>8-steps-dmd2-lora</code>（10~16 步，CFG 1.0），无加速 LoRA 可切换「高精度」";
      btn.classList.add("hidden");
    }
  } else if (state.mode === "turbo") {
    notice.classList.remove("hidden");
    const hasTurbo = allLoras.includes(DEFAULT_MODELS.turboLora);
    state.suggestedSpeedLora = hasTurbo ? DEFAULT_MODELS.turboLora : null;
    const mounted = state.loras.some((l) => l.name === DEFAULT_MODELS.turboLora && l.enabled);
    if (mounted) {
      txt.innerHTML = `已挂载 4 步加速 LoRA：<code>${DEFAULT_MODELS.turboLora}</code>`;
      btn.classList.add("hidden");
    } else {
      txt.innerHTML = `4 步极速模式需配合 <code>${DEFAULT_MODELS.turboLora}</code> 使用`;
      btn.classList.toggle("hidden", !hasTurbo);
    }
  } else {
    notice.classList.add("hidden");
    state.suggestedSpeedLora = null;
  }
}

function setRatioPreset(w, h) {
  $("widthInput").value = w;
  $("heightInput").value = h;
  document.querySelectorAll(".ratio-btn").forEach((b) => {
    const bw = parseInt(b.getAttribute("data-w"), 10);
    const bh = parseInt(b.getAttribute("data-h"), 10);
    b.classList.toggle("active", bw === w && bh === h);
  });
  updateResSummary();
}

function applyMode(mode) {
  state.mode = mode;
  $("modeShinobiBtn").classList.toggle("active", mode === "shinobisat");
  $("modeQualityBtn").classList.toggle("active", mode === "quality");
  $("modeTurboBtn").classList.toggle("active", mode === "turbo");

  if (mode === "shinobisat") {
    $("modeHint").textContent = "ShinobiSat";
    setRatioPreset(896, 1152);
    $("stepsInput").value = 16;
    $("cfgInput").value = 1.0;
    populateSelect($("samplerSelect"), [], "euler");
    populateSelect($("schedulerSelect"), [], "normal");
    $("useFlowShiftCheck").checked = false;
    $("useSlgCheck").checked = false;
    $("upscaleModeSelect").value = "hires";
    $("upscaleFactorSelect").value = "1.5";
    $("hiresStepsInput").value = 4;
    $("hiresCfgInput").value = 1.0;
    $("hiresDenoiseSlider").value = 0.15;
    $("hiresDenoiseVal").textContent = "0.15";
  } else if (mode === "quality") {
    $("modeHint").textContent = "高精度";
    setRatioPreset(896, 1152);
    $("stepsInput").value = 50;
    $("cfgInput").value = 3.0;
    populateSelect($("samplerSelect"), [], "euler");
    populateSelect($("schedulerSelect"), [], "sgm_uniform");
    $("useFlowShiftCheck").checked = true;
    $("flowShiftInput").value = 5.0;
    $("useSlgCheck").checked = true;
    $("slgLayersInput").value = "22";
    $("upscaleModeSelect").value = "hires";
    $("upscaleFactorSelect").value = "1.5";
    $("hiresStepsInput").value = 10;
    $("hiresCfgInput").value = 3.0;
    $("hiresDenoiseSlider").value = 0.2;
    $("hiresDenoiseVal").textContent = "0.20";
  } else {
    $("modeHint").textContent = "4步极速";
    setRatioPreset(1024, 1024);
    $("stepsInput").value = 4;
    $("cfgInput").value = 1.0;
    populateSelect($("samplerSelect"), [], "euler");
    populateSelect($("schedulerSelect"), [], "simple");
    $("useFlowShiftCheck").checked = false;
    $("useSlgCheck").checked = false;
    $("upscaleModeSelect").value = "none";
  }

  updateUpscalePanels();
  updateSpeedLoraNotice();
}

function renderLoraQuickPicker() {
  const allLoras = getMergedAvailableLoras();
  const countBadge = $("myLoraCountBadge");
  if (countBadge) {
    countBadge.textContent = String(allLoras.length);
  }
  const sel = $("loraQuickPickSelect");
  const addBtn = $("loraQuickAddBtn");
  if (!sel) return;

  const prevVal = sel.value;
  const mountedSet = new Set(state.loras.map((l) => l.name).filter(Boolean));
  sel.innerHTML = "";

  if (allLoras.length === 0) {
    const emptyOpt = document.createElement("option");
    emptyOpt.value = "";
    emptyOpt.textContent = "暂无可选 LoRA（可点刷新或从 Civitai 库下载）";
    sel.appendChild(emptyOpt);
    if (addBtn) addBtn.disabled = true;
    return;
  }

  if (addBtn) addBtn.disabled = false;
  for (const name of allLoras) {
    const baseName = name.split(/[\\/]/).pop();
    const meta = state.loraMeta[name] || state.loraMeta[baseName] || {};
    const labelBase =
      meta.name && meta.name !== name ? `${meta.name} (${baseName})` : name;
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = mountedSet.has(name) ? `${labelBase}（已挂载）` : labelBase;
    sel.appendChild(opt);
  }

  const firstUnmounted = allLoras.find((n) => !mountedSet.has(n));
  if (prevVal && allLoras.includes(prevVal) && !mountedSet.has(prevVal)) {
    sel.value = prevVal;
  } else if (firstUnmounted) {
    sel.value = firstUnmounted;
  } else if (prevVal && allLoras.includes(prevVal)) {
    sel.value = prevVal;
  } else {
    sel.value = allLoras[0];
  }
}

function renderMyLorasModal() {
  const grid = $("myLorasGrid");
  const countEl = $("myLorasModalCount");
  const allLoras = getMergedAvailableLoras();
  const q = ($("myLoraSearchInput") ? $("myLoraSearchInput").value : "")
    .trim()
    .toLowerCase();

  const driveItemMap = new Map(
    (state.gdriveLoraItems || []).map((it) => [it.name, it])
  );
  const mountedSet = new Set(state.loras.map((l) => l.name).filter(Boolean));

  const filtered = allLoras.filter((name) => {
    if (!q) return true;
    const baseName = name.split(/[\\/]/).pop();
    const meta = state.loraMeta[name] || state.loraMeta[baseName] || {};
    const hay = `${name} ${meta.name || ""} ${(meta.trained_words || []).join(" ")}`.toLowerCase();
    return hay.includes(q);
  });

  if (countEl) {
    countEl.textContent = q
      ? `${filtered.length} / ${allLoras.length} 个`
      : `${allLoras.length} 个`;
  }
  if (!grid) return;
  grid.innerHTML = "";

  if (filtered.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-lora";
    empty.textContent =
      allLoras.length === 0
        ? "暂无已有 LoRA，可先挂载 Google Drive、连接 Colab 或从「Civitai 库」下载。"
        : "未找到匹配的已有 LoRA，可尝试调整筛选关键词。";
    grid.appendChild(empty);
    return;
  }

  for (const name of filtered) {
    const baseName = name.split(/[\\/]/).pop();
    const meta = state.loraMeta[name] || state.loraMeta[baseName] || {};
    const driveItem = driveItemMap.get(name) || driveItemMap.get(baseName);
    const inColab = (state.availableLoras || []).includes(name);
    const inDrive = (state.gdriveLoras || []).includes(name) || (state.gdriveLoras || []).includes(baseName);
    const isMounted = mountedSet.has(name);

    const card = document.createElement("div");
    card.className = `my-lora-card${isMounted ? " is-mounted" : ""}`;

    const thumbWrap = document.createElement("div");
    thumbWrap.className = "civitai-thumb-wrap";
    if (meta.preview_url) {
      const img = document.createElement("img");
      img.className = "my-lora-thumb";
      img.src = meta.preview_url;
      img.alt = meta.name || name;
      img.loading = "lazy";
      img.referrerPolicy = "no-referrer";
      img.addEventListener("error", () => {
        const ph = document.createElement("div");
        ph.className = "civitai-thumb-placeholder";
        ph.textContent = "无预览图";
        img.replaceWith(ph);
      });
      thumbWrap.appendChild(img);
    } else {
      const ph = document.createElement("div");
      ph.className = "civitai-thumb-placeholder";
      ph.textContent = "本地 / 云盘 LoRA";
      thumbWrap.appendChild(ph);
    }

    const baseTag = document.createElement("span");
    baseTag.className = "civitai-base-tag";
    baseTag.textContent = meta.base_model || "LORA";
    thumbWrap.appendChild(baseTag);

    const srcBadge = document.createElement("span");
    srcBadge.className = `my-lora-badge${inColab ? " is-ready" : ""}`;
    srcBadge.textContent =
      inColab && inDrive ? "Colab & Drive" : inColab ? "Colab 云端" : "Drive 云盘";
    thumbWrap.appendChild(srcBadge);

    const body = document.createElement("div");
    body.className = "civitai-card-body";

    const title = document.createElement("div");
    title.className = "civitai-card-title";
    if (meta.model_url) {
      const a = document.createElement("a");
      a.href = meta.model_url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = meta.name || baseName;
      title.appendChild(a);
    } else {
      title.textContent = meta.name || baseName;
    }

    const metaLine = document.createElement("div");
    metaLine.className = "civitai-card-meta";
    const sizeStr =
      driveItem && driveItem.size_mb ? ` (${driveItem.size_mb} MB)` : "";
    metaLine.textContent = `${name}${sizeStr}`;
    body.append(title, metaLine);

    const words = Array.isArray(meta.trained_words)
      ? meta.trained_words.filter(Boolean).slice(0, 6)
      : [];
    if (words.length > 0) {
      const trigWrap = document.createElement("div");
      trigWrap.className = "civitai-triggers";
      for (const word of words) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "trigger-chip";
        chip.textContent = `+ ${word}`;
        chip.title = `点击追加触发词：${word}`;
        chip.addEventListener("click", () => appendTriggerWord(word));
        trigWrap.appendChild(chip);
      }
      body.appendChild(trigWrap);
    }

    const footer = document.createElement("div");
    footer.className = "civitai-card-footer";
    const actions = document.createElement("div");
    actions.className = "civitai-card-actions";

    const toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    toggleBtn.className = isMounted ? "btn-mini" : "btn-mini btn-accent";
    toggleBtn.textContent = isMounted ? "已挂载（点击移除）" : "+ 挂载到工作台";
    toggleBtn.addEventListener("click", () => {
      if (isMounted) {
        state.loras = state.loras.filter((l) => l.name !== name);
        renderLoras();
      } else {
        mountLoraByName(name, 1.0);
      }
    });
    actions.appendChild(toggleBtn);
    footer.appendChild(actions);
    body.appendChild(footer);
    card.append(thumbWrap, body);
    grid.appendChild(card);
  }
}

async function refreshAllLoras() {
  const btns = [$("refreshLoraBtn"), $("myLoraRefreshBtn")].filter(Boolean);
  btns.forEach((b) => (b.disabled = true));
  try {
    const tasks = [];
    const driveMounted = Boolean(state.gdriveStatus && state.gdriveStatus.mounted);
    if (driveMounted) {
      tasks.push(refreshGDriveLoras());
    }
    const comfyUrl = $("comfyUrlInput") ? $("comfyUrlInput").value.trim() : "";
    if (comfyUrl) {
      tasks.push(connectComfy(!driveMounted ? false : true));
    } else if (!driveMounted) {
      showError("请先挂载 Google Drive 或输入 Colab 地址后再刷新 LoRA 列表");
    }
    await Promise.all(tasks);
    renderLoras();
  } finally {
    btns.forEach((b) => (b.disabled = false));
  }
}

function renderLoras() {
  const allLoras = getMergedAvailableLoras();
  const container = $("loraList");
  container.innerHTML = "";
  if (state.loras.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-lora";
    empty.textContent =
      allLoras.length > 0
        ? "暂未挂载 LoRA，请在上方下拉框选一个或点「已有」批量挑选。"
        : "暂未挂载 LoRA，可从 Civitai 库下载或点击「+ 添加」。";
    container.appendChild(empty);
    updateSpeedLoraNotice();
    renderLoraTriggerBar();
    renderLoraQuickPicker();
    if ($("myLorasModal") && !$("myLorasModal").classList.contains("hidden")) {
      renderMyLorasModal();
    }
    return;
  }

  state.loras.forEach((lora, idx) => {
    const card = document.createElement("div");
    card.className = "lora-item";

    const top = document.createElement("div");
    top.className = "lora-item-top";

    const chk = document.createElement("input");
    chk.type = "checkbox";
    chk.checked = lora.enabled !== false;
    chk.title = "启用或暂禁此 LoRA";
    chk.addEventListener("change", () => {
      state.loras[idx].enabled = chk.checked;
      updateSpeedLoraNotice();
      renderLoraTriggerBar();
    });

    let nameControl;
    if (allLoras.length > 0) {
      nameControl = document.createElement("select");
      const options = [...allLoras];
      if (lora.name && !options.includes(lora.name)) {
        options.unshift(lora.name);
      }
      for (const optName of options) {
        const baseName = optName.split(/[\\/]/).pop();
        const meta = state.loraMeta[optName] || state.loraMeta[baseName] || {};
        const opt = document.createElement("option");
        opt.value = optName;
        opt.textContent =
          meta.name && meta.name !== optName ? `${meta.name} (${baseName})` : optName;
        nameControl.appendChild(opt);
      }
      if (!lora.name && options.length > 0) {
        lora.name = options[0];
      }
      nameControl.value = lora.name;
      nameControl.addEventListener("change", () => {
        state.loras[idx].name = nameControl.value;
        updateSpeedLoraNotice();
        renderLoraTriggerBar();
        renderLoraQuickPicker();
        if ($("myLorasModal") && !$("myLorasModal").classList.contains("hidden")) {
          renderMyLorasModal();
        }
      });
    } else {
      nameControl = document.createElement("input");
      nameControl.type = "text";
      nameControl.placeholder = "连接云端或挂载 Drive 后自动列出，或手动填入 .safetensors 文件名";
      nameControl.value = lora.name || "";
      nameControl.addEventListener("input", () => {
        state.loras[idx].name = nameControl.value;
        renderLoraTriggerBar();
      });
    }

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "btn-icon";
    delBtn.textContent = "✕";
    delBtn.title = "移除此 LoRA";
    delBtn.addEventListener("click", () => {
      state.loras.splice(idx, 1);
      renderLoras();
    });

    top.append(chk, nameControl, delBtn);

    const bottom = document.createElement("div");
    bottom.className = "lora-item-bottom";

    const label = document.createElement("span");
    label.textContent = "权重强度";

    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "-2";
    slider.max = "2";
    slider.step = "0.05";
    slider.value = String(lora.strength ?? 1.0);

    const valSpan = document.createElement("span");
    valSpan.className = "lora-strength-val";
    valSpan.textContent = Number(slider.value).toFixed(2);

    slider.addEventListener("input", () => {
      const v = parseFloat(slider.value);
      state.loras[idx].strength = v;
      valSpan.textContent = v.toFixed(2);
    });

    bottom.append(label, slider, valSpan);
    card.append(top, bottom);
    container.appendChild(card);
  });

  updateSpeedLoraNotice();
  renderLoraTriggerBar();
  renderLoraQuickPicker();
  if ($("myLorasModal") && !$("myLorasModal").classList.contains("hidden")) {
    renderMyLorasModal();
  }
}

function collectPayload() {
  const width = snap16($("widthInput").value, 896);
  const height = snap16($("heightInput").value, 1152);
  $("widthInput").value = width;
  $("heightInput").value = height;
  updateResSummary();

  return {
    comfy_url: $("comfyUrlInput").value.trim(),
    mode: state.mode,
    positive: $("positiveInput").value,
    negative: $("negativeInput").value,
    width,
    height,
    batch_size: parseInt($("batchSelect").value, 10) || 1,
    steps: parseInt($("stepsInput").value, 10) || 16,
    cfg: parseFloat($("cfgInput").value) || 1.0,
    seed: parseInt($("seedInput").value, 10),
    sampler_name: $("samplerSelect").value,
    scheduler: $("schedulerSelect").value,
    use_flow_shift: $("useFlowShiftCheck").checked,
    flow_shift: parseFloat($("flowShiftInput").value) || 5.0,
    use_slg: $("useSlgCheck").checked,
    slg_layers: $("slgLayersInput").value.trim(),
    lora_mode: $("loraModeSelect").value,
    loras: state.loras.map((l) => ({
      enabled: l.enabled !== false,
      name: (l.name || "").trim(),
      strength: Number(l.strength ?? 1.0),
    })),
    unet_name: $("unetSelect").value || DEFAULT_MODELS.unet,
    clip_name: $("clipSelect").value || DEFAULT_MODELS.clip,
    vae_name: $("vaeSelect").value || DEFAULT_MODELS.vae,
    upscale_mode: $("upscaleModeSelect").value,
    upscale_model: $("upscaleModelSelect").value || "none",
    upscale_factor: parseFloat($("upscaleFactorSelect").value) || 1.5,
    hires_steps: parseInt($("hiresStepsInput").value, 10) || 4,
    hires_cfg: parseFloat($("hiresCfgInput").value) || 1.0,
    hires_denoise: parseFloat($("hiresDenoiseSlider").value) || 0.15,
    seedvr2_dit: $("seedvr2DitSelect").value || DEFAULT_MODELS.seedvr2Dit,
    seedvr2_vae: $("seedvr2VaeSelect").value || DEFAULT_MODELS.seedvr2Vae,
    seedvr2_resolution: parseInt($("seedvr2ResInput").value, 10) || 2048,
    seedvr2_max_resolution: parseInt($("seedvr2MaxResInput").value, 10) || 3072,
    film_grain_enabled: $("filmGrainCheck").checked,
    film_grain_intensity: parseFloat($("filmGrainSlider").value) || 0.022,
    init_image_id: state.initImage ? state.initImage.init_id : "",
    img2img_denoise: parseFloat($("img2imgDenoiseSlider").value) || 0.65,
  };
}

function applyComfyConnectionSuccess(data, fallbackUrl = "") {
  stopColabAutoWait(true);
  state.connected = true;
  state.supportsBypassLora = Boolean(data.supports_bypass_lora);
  state.supportsSeedvr2 = Boolean(data.supports_seedvr2);
  state.supportsCloudDownload = Boolean(data.supports_cloud_download);
  state.availableLoras = data.loras || [];
  state.availableUpscalers = data.upscale_models || [];
  $("comfyUrlInput").value = data.comfy_url || fallbackUrl || "";

  const gpuLabel = data.gpu_name ? `${data.gpu_name} · ${data.vram_total_gb}GB` : "已连接云端";
  setStatus("online", gpuLabel);

  populateSelect($("unetSelect"), data.unets, DEFAULT_MODELS.unet);
  populateSelect($("clipSelect"), data.clips, DEFAULT_MODELS.clip);
  populateSelect($("vaeSelect"), data.vaes, DEFAULT_MODELS.vae);
  populateSelect($("samplerSelect"), data.samplers, "euler");
  populateSelect(
    $("schedulerSelect"),
    data.schedulers,
    state.mode === "quality" ? "sgm_uniform" : state.mode === "turbo" ? "simple" : "normal"
  );
  populateUpscaleSelect(state.availableUpscalers);
  populateSelect($("seedvr2DitSelect"), data.seedvr2_dits, DEFAULT_MODELS.seedvr2Dit);
  populateSelect($("seedvr2VaeSelect"), data.seedvr2_vaes, DEFAULT_MODELS.seedvr2Vae);

  $("bypassWarn").classList.toggle("hidden", state.supportsBypassLora);
  updateUpscalePanels();
  renderLoras();
  updateBridgeBadge();
  if (!$("civitaiModal").classList.contains("hidden")) {
    renderCivitaiGrid();
  }

  $("stageText").textContent = `已连接（${gpuLabel}）· ${state.availableLoras.length} 个 LoRA · ${state.availableUpscalers.length} 个超分模型`;
}

async function connectComfy(silent = false) {
  const rawUrl = $("comfyUrlInput").value.trim();
  if (!rawUrl) {
    if (!silent) showError("请先输入 Colab Cell 4 输出的 ComfyUI 公网链接");
    return false;
  }
  showError("");
  setStatus("offline", "正在连接云端...");
  $("connectBtn").disabled = true;

  try {
    const resp = await fetch("/api/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ comfy_url: rawUrl }),
    });
    const data = await resp.json();
    if (!resp.ok || !data.connected) {
      throw new Error(data.error || "连接失败");
    }
    applyComfyConnectionSuccess(data, rawUrl);
    return true;
  } catch (err) {
    state.connected = false;
    state.supportsCloudDownload = false;
    updateBridgeBadge();
    setStatus("error", "连接失败");
    if (!silent) showError(err.message);
    return false;
  } finally {
    $("connectBtn").disabled = false;
  }
}

function setRunningUI(running) {
  if ($("generateBtn")) $("generateBtn").disabled = false;
  $("interruptBtn").classList.toggle("hidden", !running);
}

function updateAbSlider(pct) {
  const val = Math.max(0, Math.min(100, Number(pct)));
  const rightInset = 100 - val;
  $("abOverlay").style.clipPath = `inset(0 ${rightInset}% 0 0)`;
  $("abDivider").style.left = `${val}%`;
}

function renderPreviewDisplay() {
  const current = state.currentImages[state.currentImageIdx];
  if (!current) return;

  const hasCompare = Boolean(current.base_url);
  $("compareModeBar").classList.toggle("hidden", !hasCompare);
  document.querySelectorAll(".view-btn").forEach((b) => {
    b.classList.toggle("active", b.getAttribute("data-view") === state.compareView);
  });

  if (hasCompare && state.compareView === "compare") {
    $("mainPreviewImg").classList.add("hidden");
    $("abCompareBox").classList.remove("hidden");
    $("abBaseImg").src = current.base_url;
    $("abFinalImg").src = current.url;
    updateAbSlider($("abRange").value);
  } else {
    $("abCompareBox").classList.add("hidden");
    $("mainPreviewImg").classList.remove("hidden");
    $("mainPreviewImg").src =
      hasCompare && state.compareView === "base" ? current.base_url : current.url;
  }

  $("downloadLink").href =
    hasCompare && state.compareView === "base" ? current.base_url : current.url;
  $("downloadLink").download =
    hasCompare && state.compareView === "base"
      ? current.base_filename || "moss_base.png"
      : current.filename || "moss_output.png";
}

function showMainPreviewImages(images, activeIndex = 0) {
  if (!images || images.length === 0) return;
  state.currentImages = images;
  state.currentImageIdx = Math.max(0, Math.min(activeIndex, images.length - 1));
  const current = state.currentImages[state.currentImageIdx];

  $("previewEmpty").classList.add("hidden");
  $("previewStage").classList.remove("hidden");
  $("previewBadge").classList.add("hidden");

  if (current.base_url && state.compareView !== "upscaled" && state.compareView !== "base") {
    state.compareView = "compare";
  }
  renderPreviewDisplay();

  const p = current.params || {};
  const loraCount = (p.loras || []).filter((l) => l.enabled && l.name).length;
  const resText =
    p.out_width && p.out_width !== p.width
      ? `${p.width}×${p.height} → ${p.out_width}×${p.out_height}`
      : `${p.width}×${p.height}`;
  $("previewMeta").textContent = `种子 ${p.seed ?? "-"} · ${resText} · ${p.steps}步 · CFG ${p.cfg}${
    loraCount ? ` · 挂载 ${loraCount} 个LoRA` : ""
  } · 耗时 ${current.elapsed_sec ?? "-"}s`;

  const strip = $("batchStrip");
  strip.innerHTML = "";
  if (images.length > 1) {
    strip.classList.remove("hidden");
    images.forEach((img, idx) => {
      const thumb = document.createElement("img");
      thumb.src = img.url;
      thumb.className = `batch-thumb${idx === state.currentImageIdx ? " active" : ""}`;
      thumb.addEventListener("click", () => showMainPreviewImages(images, idx));
      strip.appendChild(thumb);
    });
  } else {
    strip.classList.add("hidden");
  }
}

function applyParamsToForm(params) {
  if (!params) return;
  if (["shinobisat", "quality", "turbo"].includes(params.mode)) {
    applyMode(params.mode);
  }
  $("positiveInput").value = params.positive || "";
  $("negativeInput").value = params.negative || "";
  setRatioPreset(params.width || 896, params.height || 1152);
  $("stepsInput").value = params.steps || 16;
  $("cfgInput").value = params.cfg || 1.0;
  $("seedInput").value = params.seed ?? -1;
  if (params.sampler_name) populateSelect($("samplerSelect"), [], params.sampler_name);
  if (params.scheduler) populateSelect($("schedulerSelect"), [], params.scheduler);
  if (params.lora_mode) $("loraModeSelect").value = params.lora_mode;
  $("useFlowShiftCheck").checked = Boolean(params.use_flow_shift);
  if (params.flow_shift !== undefined) $("flowShiftInput").value = params.flow_shift;
  $("useSlgCheck").checked = Boolean(params.use_slg);
  if (params.slg_layers !== undefined) $("slgLayersInput").value = params.slg_layers;
  if (params.unet_name) populateSelect($("unetSelect"), [], params.unet_name);
  if (params.clip_name) populateSelect($("clipSelect"), [], params.clip_name);
  if (params.vae_name) populateSelect($("vaeSelect"), [], params.vae_name);

  if (params.upscale_mode) $("upscaleModeSelect").value = params.upscale_mode;
  if (params.upscale_model) $("upscaleModelSelect").value = params.upscale_model;
  if (params.upscale_factor) $("upscaleFactorSelect").value = String(params.upscale_factor);
  if (params.hires_steps !== undefined) $("hiresStepsInput").value = params.hires_steps;
  if (params.hires_cfg !== undefined) $("hiresCfgInput").value = params.hires_cfg;
  if (params.hires_denoise !== undefined) {
    $("hiresDenoiseSlider").value = params.hires_denoise;
    $("hiresDenoiseVal").textContent = Number(params.hires_denoise).toFixed(2);
  }
  $("filmGrainCheck").checked = Boolean(params.film_grain_enabled);
  $("grainSliderWrap").classList.toggle("hidden", !$("filmGrainCheck").checked);
  if (params.film_grain_intensity !== undefined) {
    $("filmGrainSlider").value = params.film_grain_intensity;
    $("filmGrainVal").textContent = Number(params.film_grain_intensity).toFixed(3);
  }
  if (params.img2img_denoise !== undefined && $("img2imgDenoiseSlider")) {
    $("img2imgDenoiseSlider").value = params.img2img_denoise;
    $("img2imgDenoiseVal").textContent = Number(params.img2img_denoise).toFixed(2);
  }
  updateUpscalePanels();

  state.loras = (params.loras || []).map((l) => ({
    enabled: l.enabled !== false,
    name: l.name || "",
    strength: Number(l.strength ?? 1.0),
  }));
  renderLoras();
}

function loadUiPrefs() {
  try {
    const raw = localStorage.getItem("moss_studio_prefs");
    if (!raw) return;
    const prefs = JSON.parse(raw);
    if ($("autoPunctCheck") && prefs.autoPunct !== undefined) {
      $("autoPunctCheck").checked = Boolean(prefs.autoPunct);
    }
    if ($("notifySoundCheck") && prefs.notifySound !== undefined) {
      $("notifySoundCheck").checked = Boolean(prefs.notifySound);
    }
    if ($("notifyDesktopCheck") && prefs.notifyDesktop !== undefined) {
      $("notifyDesktopCheck").checked =
        Boolean(prefs.notifyDesktop) &&
        typeof Notification !== "undefined" &&
        Notification.permission === "granted";
    }
    if ($("colabAutoWaitCheck") && prefs.colabAutoWait !== undefined) {
      $("colabAutoWaitCheck").checked = Boolean(prefs.colabAutoWait);
    }
  } catch (_) {}
}

function saveUiPrefs() {
  try {
    localStorage.setItem(
      "moss_studio_prefs",
      JSON.stringify({
        autoPunct: Boolean($("autoPunctCheck") && $("autoPunctCheck").checked),
        notifySound: Boolean($("notifySoundCheck") && $("notifySoundCheck").checked),
        notifyDesktop: Boolean($("notifyDesktopCheck") && $("notifyDesktopCheck").checked),
        colabAutoWait: $("colabAutoWaitCheck") ? Boolean($("colabAutoWaitCheck").checked) : true,
      })
    );
  } catch (_) {}
}

function playDoneBeep(isErr = false) {
  if (!$("notifySoundCheck") || !$("notifySoundCheck").checked) return;
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const notes = isErr ? [280, 220] : [523.25, 659.25];
    notes.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const t0 = ctx.currentTime + idx * 0.11;
      gain.gain.setValueAtTime(0.001, t0);
      gain.gain.exponentialRampToValueAtTime(0.08, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.16);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.18);
    });
  } catch (_) {}
}

function sendDesktopNotify(title, body) {
  if (!$("notifyDesktopCheck") || !$("notifyDesktopCheck").checked) return;
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  if (!document.hidden) return;
  try {
    new Notification(title, { body, tag: "moss-studio-done" });
  } catch (_) {}
}

function applyJobProgressUI(job) {
  if (!job) return;
  $("stageText").textContent = job.stage || "处理中...";
  const etaPart = job.eta_sec && job.eta_sec > 0 ? ` · 预计剩余 ${job.eta_sec}s` : "";
  $("elapsedText").textContent = `${job.elapsed_sec ?? 0}s${etaPart}`;
  $("progressBar").style.width = `${job.progress || 0}%`;
}

function updateQueueUI(snapshot) {
  if (!snapshot) return;
  state.queueSnapshot = snapshot;
  const activeCount = snapshot.active_job_id ? 1 : 0;
  const pendingTotal = activeCount + Number(snapshot.queued_count || 0);
  if ($("queueCountBadge")) {
    $("queueCountBadge").textContent = String(pendingTotal);
  }
  setRunningUI(pendingTotal > 0);
  if ($("queueModal") && !$("queueModal").classList.contains("hidden")) {
    renderQueueModal();
  }
}

async function loadQueueSnapshot() {
  try {
    const resp = await fetch("/api/jobs");
    if (!resp.ok) return;
    const data = await resp.json();
    updateQueueUI(data);
  } catch (_) {}
}

async function cancelJobById(jobId) {
  try {
    await fetch(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST" });
    await loadQueueSnapshot();
  } catch (err) {
    showError(err.message);
  }
}

async function clearJobQueue() {
  try {
    await fetch("/api/queue/clear", { method: "POST" });
    setRunningUI(false);
    $("stageText").textContent = "队列已停止并清空";
    await loadQueueSnapshot();
  } catch (err) {
    showError(err.message);
  }
}

function renderQueueModal() {
  const listEl = $("queueList");
  if (!listEl) return;
  listEl.innerHTML = "";
  const jobs = (state.queueSnapshot && state.queueSnapshot.jobs) || [];
  if (jobs.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-lora";
    empty.textContent = "暂无生成任务";
    listEl.appendChild(empty);
    return;
  }

  const STATUS_MAP = {
    queued: "排队中",
    running: "生成中",
    completed: "已完成",
    failed: "失败",
    interrupted: "已取消",
  };
  for (const job of jobs) {
    const row = document.createElement("div");
    row.className = "queue-item";

    const main = document.createElement("div");
    main.className = "queue-item-main";
    const title = document.createElement("div");
    title.className = "queue-item-title";
    title.textContent = `[${STATUS_MAP[job.status] || job.status}] ${job.positive_preview || job.job_id}`;
    const meta = document.createElement("div");
    meta.className = "queue-item-meta";
    const pctText = job.status === "running" ? ` · ${job.progress || 0}%` : "";
    const etaText = job.eta_sec && job.eta_sec > 0 ? ` · 预计剩余 ${job.eta_sec}s` : "";
    meta.textContent = `${job.stage || "-"} · ${job.elapsed_sec ?? 0}s${pctText}${etaText}`;
    main.append(title, meta);
    row.appendChild(main);

    if (job.status === "queued" || job.status === "running") {
      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "btn-mini btn-danger";
      cancelBtn.textContent = job.status === "running" ? "停止" : "取消";
      cancelBtn.addEventListener("click", () => cancelJobById(job.job_id));
      row.appendChild(cancelBtn);
    }
    listEl.appendChild(row);
  }
}

function connectStudioWs() {
  if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  try {
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    state.ws = ws;
    ws.addEventListener("open", () => {
      state.wsConnected = true;
    });
    ws.addEventListener("message", async (evt) => {
      let msg;
      try {
        msg = JSON.parse(evt.data);
      } catch (_) {
        return;
      }
      if (msg.type === "hello") {
        updateQueueUI(msg.queue);
        if (msg.active_job) {
          state.currentJobId = msg.active_job.job_id;
          applyJobProgressUI(msg.active_job);
          if (msg.active_job.preview_data_url) {
            $("previewEmpty").classList.add("hidden");
            $("previewStage").classList.remove("hidden");
            $("compareModeBar").classList.add("hidden");
            $("abCompareBox").classList.add("hidden");
            $("mainPreviewImg").classList.remove("hidden");
            $("mainPreviewImg").src = msg.active_job.preview_data_url;
            $("previewBadge").classList.remove("hidden");
          }
        }
      } else if (msg.type === "queue_update") {
        updateQueueUI(msg.queue);
      } else if (msg.type === "job_progress") {
        const j = msg.job;
        if (j) {
          state.currentJobId = j.job_id;
          applyJobProgressUI(j);
          const idx = (state.queueSnapshot.jobs || []).findIndex((x) => x.job_id === j.job_id);
          if (idx >= 0) state.queueSnapshot.jobs[idx] = j;
          if ($("queueModal") && !$("queueModal").classList.contains("hidden")) {
            renderQueueModal();
          }
        }
      } else if (msg.type === "job_preview") {
        if (msg.preview_data_url) {
          $("previewEmpty").classList.add("hidden");
          $("previewStage").classList.remove("hidden");
          $("compareModeBar").classList.add("hidden");
          $("abCompareBox").classList.add("hidden");
          $("mainPreviewImg").classList.remove("hidden");
          $("mainPreviewImg").src = msg.preview_data_url;
          $("previewBadge").classList.remove("hidden");
        }
      } else if (msg.type === "job_completed") {
        const j = msg.job;
        if (j) {
          state.lastSeed = j.seed;
          applyJobProgressUI(j);
        }
        $("progressBar").style.width = "100%";
        if (msg.images && msg.images.length > 0) {
          showMainPreviewImages(msg.images, 0);
        }
        await loadHistory();
        await loadQueueSnapshot();
        playDoneBeep(false);
        sendDesktopNotify("MOSS-Image 生成完成", (j && j.positive_preview) || "新图片已保存到本地画廊");
      } else if (msg.type === "job_failed") {
        const j = msg.job;
        if (j && j.error) showError(j.error);
        playDoneBeep(true);
        await loadQueueSnapshot();
      } else if (msg.type === "job_cancelled") {
        await loadQueueSnapshot();
      } else if (msg.type === "history_updated") {
        await loadHistory();
      }
    });
    ws.addEventListener("close", () => {
      state.wsConnected = false;
      state.ws = null;
      if (state.wsReconnectTimer) clearTimeout(state.wsReconnectTimer);
      state.wsReconnectTimer = setTimeout(connectStudioWs, 2000);
    });
    ws.addEventListener("error", () => {
      state.wsConnected = false;
    });
  } catch (_) {
    state.wsConnected = false;
  }
}

async function pollJob(jobId) {
  if (state.wsConnected) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
    return;
  }
  try {
    const resp = await fetch(`/api/jobs/${jobId}`);
    if (!resp.ok) throw new Error("获取任务状态失败");
    const job = await resp.json();

    applyJobProgressUI(job);

    if (job.preview_data_url && job.status === "running") {
      $("previewEmpty").classList.add("hidden");
      $("previewStage").classList.remove("hidden");
      $("compareModeBar").classList.add("hidden");
      $("abCompareBox").classList.add("hidden");
      $("mainPreviewImg").classList.remove("hidden");
      $("mainPreviewImg").src = job.preview_data_url;
      $("previewBadge").classList.remove("hidden");
    }

    if (job.status === "completed") {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
      state.lastSeed = job.seed;
      $("progressBar").style.width = "100%";
      showMainPreviewImages(job.images, 0);
      await loadHistory();
      await loadQueueSnapshot();
    } else if (job.status === "failed" || job.status === "interrupted") {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
      await loadQueueSnapshot();
      if (job.status === "failed") {
        showError(job.error || "生成失败");
      }
    }
  } catch (err) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
    setRunningUI(false);
    showError(err.message);
  }
}

async function startGenerate() {
  showError("");
  const basePayload = collectPayload();
  if (!basePayload.comfy_url) {
    showError("请先在顶部输入并连接 Colab 的 ComfyUI 地址");
    return;
  }
  const batchByLine = Boolean($("batchLinesCheck") && $("batchLinesCheck").checked);
  const prompts = batchByLine
    ? basePayload.positive
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
    : [basePayload.positive];

  if (prompts.length === 0 || !prompts[0].trim()) {
    showError("请先输入正向提示词");
    return;
  }

  setRunningUI(true);
  $("progressBar").style.width = "2%";
  $("stageText").textContent =
    prompts.length > 1 ? `正在将 ${prompts.length} 条任务加入队列...` : "正在加入生成队列...";
  $("elapsedText").textContent = "0s";

  try {
    let lastJobData = null;
    for (const pText of prompts) {
      const resp = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...basePayload, positive: pText }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        throw new Error(data.error || "提交任务失败");
      }
      lastJobData = data;
      state.currentJobId = data.job_id;
      state.lastSeed = data.seed;
    }

    await loadQueueSnapshot();
    if (lastJobData && lastJobData.queue_position > 1) {
      $("stageText").textContent = `已加入队列（当前第 ${lastJobData.queue_position} 位）`;
    }
    if (!state.wsConnected && lastJobData) {
      if (state.pollTimer) clearInterval(state.pollTimer);
      state.pollTimer = setInterval(() => pollJob(lastJobData.job_id), 1000);
      await pollJob(lastJobData.job_id);
    }
  } catch (err) {
    await loadQueueSnapshot();
    showError(err.message);
  }
}

async function interruptGenerate() {
  try {
    await fetch("/api/interrupt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ comfy_url: $("comfyUrlInput").value.trim() }),
    });
    $("stageText").textContent = "已发送停止请求...";
  } catch (err) {
    showError(err.message);
  }
}

function setInitImage(data) {
  state.initImage = data || null;
  const has = Boolean(data && data.url);
  $("initBadge").classList.toggle("hidden", !has);
  $("initPreviewImg").classList.toggle("hidden", !has);
  $("initDropHint").classList.toggle("hidden", has);
  $("initActionsRow").classList.toggle("hidden", !has);
  if (has) {
    $("initPreviewImg").src = data.url;
    $("initSizeText").textContent = `${data.width || "?"}×${data.height || "?"}`;
    if ($("img2imgDetails")) $("img2imgDetails").open = true;
  } else {
    $("initPreviewImg").removeAttribute("src");
    $("initSizeText").textContent = "";
  }
}

function clearInitImage() {
  setInitImage(null);
}

async function uploadInitFile(file) {
  if (!file) return;
  showError("");
  const fd = new FormData();
  fd.append("file", file, file.name || "init.png");
  try {
    const resp = await fetch("/api/upload-init", { method: "POST", body: fd });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "上传参考底图失败");
    setInitImage(data);
  } catch (err) {
    showError(err.message);
  }
}

async function sendHistoryToImg2Img(item) {
  if (!item || !item.filename) return;
  showError("");
  try {
    const resp = await fetch("/api/upload-init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ history_filename: item.filename }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "设置图生图底图失败");
    setInitImage(data);
    if ($("img2imgDetails")) {
      $("img2imgDetails").scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  } catch (err) {
    showError(err.message);
  }
}

async function readImageMetaFile(file) {
  if (!file) return;
  const previewUrl = URL.createObjectURL(file);
  $("imgMetaPreview").src = previewUrl;
  $("imgMetaPreview").classList.remove("hidden");
  $("imgMetaDropHint").classList.add("hidden");
  $("imgMetaResult").innerHTML = '<div class="muted-text">正在读取图片参数...</div>';
  $("imgMetaApplyBtn").disabled = true;
  $("imgMetaCopyBtn").disabled = true;
  state.parsedMeta = null;

  const fd = new FormData();
  fd.append("file", file, file.name || "image.png");
  try {
    const resp = await fetch("/api/image/meta", { method: "POST", body: fd });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "读取失败");
    state.parsedMeta = data;
    renderParsedMetaResult(data);
  } catch (err) {
    $("imgMetaResult").innerHTML = "";
    const errDiv = document.createElement("div");
    errDiv.className = "hint-warn";
    errDiv.textContent = err.message;
    $("imgMetaResult").appendChild(errDiv);
  }
}

function renderParsedMetaResult(data) {
  const box = $("imgMetaResult");
  box.innerHTML = "";
  const p = data && data.params;
  if (!p) {
    const msg = document.createElement("div");
    msg.className = "muted-text";
    msg.textContent = `未在此图片（${data.width || "?"}×${data.height || "?"}）中检测到生成参数。`;
    box.appendChild(msg);
    return;
  }

  const SOURCE_NAMES = {
    moss_studio: "MOSS-Image Studio",
    comfyui: "ComfyUI 工作流",
    webui: "WebUI / Civitai 参数",
    other: "其他格式",
  };
  const loraSummary =
    (p.loras || [])
      .map((l) => {
        const mark = l.available === false ? "（云端未找到）" : "";
        return `${l.name} (${Number(l.strength ?? 1.0).toFixed(2)})${mark}`;
      })
      .join("、") || "无";

  const rows = [
    ["来源格式", `${SOURCE_NAMES[data.source] || data.source} · ${data.width || p.width}×${data.height || p.height}`],
    ["正向提示词", p.positive || "（空）"],
    ["负向提示词", p.negative || "（空）"],
    ["采样参数", `${p.width || data.width}×${p.height || data.height} · ${p.steps ?? "-"} 步 · CFG ${p.cfg ?? "-"} · ${p.sampler_name || "-"} / ${p.scheduler || "-"}`],
    ["随机种子", String(p.seed ?? "-")],
    ["LoRA 列表", loraSummary],
  ];
  for (const [k, v] of rows) {
    const div = document.createElement("div");
    div.className = "meta-field";
    const st = document.createElement("strong");
    st.textContent = k;
    const sp = document.createElement("span");
    sp.textContent = v;
    div.append(st, sp);
    box.appendChild(div);
  }
  $("imgMetaApplyBtn").disabled = false;
  $("imgMetaCopyBtn").disabled = !p.positive;
}

function applyParsedMeta() {
  const p = state.parsedMeta && state.parsedMeta.params;
  if (!p) return;
  applyParamsToForm(p);
  $("imgMetaModal").classList.add("hidden");
}

async function loadLoraMeta() {
  try {
    const resp = await fetch("/api/lora-meta");
    if (!resp.ok) return;
    const data = await resp.json();
    state.loraMeta = data.items || {};
    renderLoraTriggerBar();
    renderLoras();
  } catch (_) {}
}

async function loadPresets() {
  try {
    const resp = await fetch("/api/presets");
    if (!resp.ok) return;
    const data = await resp.json();
    state.presets = data.items || [];
    renderPresetsList();
  } catch (_) {}
}

function renderPresetsList() {
  const listEl = $("presetsList");
  if (!listEl) return;
  listEl.innerHTML = "";
  if (!state.presets || state.presets.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-lora";
    empty.textContent = "暂无已保存的参数预设，上方输入名称即可保存当前参数与 LoRA 组合。";
    listEl.appendChild(empty);
    return;
  }

  for (const preset of state.presets) {
    const p = preset.params || {};
    const row = document.createElement("div");
    row.className = "preset-row-item";

    const main = document.createElement("div");
    main.className = "preset-item-main";
    const nameEl = document.createElement("div");
    nameEl.className = "preset-item-name";
    nameEl.textContent = preset.name;
    const metaEl = document.createElement("div");
    metaEl.className = "preset-item-meta";
    const loraCount = (p.loras || []).filter((l) => l.enabled !== false && l.name).length;
    metaEl.textContent = `${p.mode || "shinobisat"} · ${p.width || 896}×${p.height || 1152} · ${p.steps || 16} 步 · ${loraCount} 个 LoRA`;
    main.append(nameEl, metaEl);

    const actions = document.createElement("div");
    actions.className = "inline-actions";
    const applyBtn = document.createElement("button");
    applyBtn.type = "button";
    applyBtn.className = "btn-mini btn-accent";
    applyBtn.textContent = "套用";
    applyBtn.addEventListener("click", () => {
      applyParamsToForm(p);
      $("presetsModal").classList.add("hidden");
    });
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "btn-mini btn-danger";
    delBtn.textContent = "删除";
    delBtn.addEventListener("click", () => deletePreset(preset.id));
    actions.append(applyBtn, delBtn);

    row.append(main, actions);
    listEl.appendChild(row);
  }
}

async function saveCurrentPreset() {
  const name = $("presetNameInput").value.trim();
  if (!name) return;
  $("savePresetBtn").disabled = true;
  try {
    const resp = await fetch("/api/presets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, params: collectPayload() }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "保存失败");
    $("presetNameInput").value = "";
    state.presets = data.items || [];
    renderPresetsList();
  } catch (err) {
    showError(err.message);
  } finally {
    $("savePresetBtn").disabled = false;
  }
}

async function deletePreset(presetId) {
  try {
    const resp = await fetch(`/api/presets/${encodeURIComponent(presetId)}`, { method: "DELETE" });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "删除失败");
    state.presets = data.items || [];
    renderPresetsList();
  } catch (err) {
    showError(err.message);
  }
}

function openLightbox(item) {
  state.lightboxItem = item;
  const p = item.params || {};
  $("lightboxImg").src = item.url;
  $("lightboxDownload").href = item.url;
  $("lightboxDownload").download = item.filename || "moss_output.png";

  const hasBase = Boolean(item.base_url);
  $("lightboxSwitchRow").classList.toggle("hidden", !hasBase);
  $("lbFinalBtn").classList.add("btn-accent");
  $("lbBaseBtn").classList.remove("btn-accent");
  if ($("lightboxDeleteBtn")) {
    $("lightboxDeleteBtn").textContent = item.deleted ? "彻底删除" : "移入回收站";
  }
  if ($("lightboxImg2ImgBtn")) {
    $("lightboxImg2ImgBtn").classList.toggle("hidden", Boolean(item.deleted));
  }

  const lorasText =
    (p.loras || [])
      .filter((l) => l.enabled && l.name)
      .map((l) => `${l.name} (${Number(l.strength).toFixed(2)})`)
      .join("、") || "无";

  const upLabel =
    p.upscale_mode === "hires"
      ? `二修放大 (${p.upscale_model || "Lanczos"} · ${p.out_width}×${p.out_height} · Denoise ${p.hires_denoise})`
      : p.upscale_mode === "seedvr2"
      ? `SeedVR2 (${p.seedvr2_resolution}p)`
      : "无";

  const details = $("lightboxDetails");
  details.innerHTML = "";
  const blocks = [
    ["正向提示词", p.positive || "(空)"],
    ["参数", `${p.width}×${p.height} · ${p.steps} 步 · CFG ${p.cfg} · ${p.sampler_name} / ${p.scheduler}`],
    ["放大与颗粒", `${upLabel}${p.film_grain_enabled ? ` + 胶片颗粒 (${p.film_grain_intensity})` : ""}`],
    ["随机种子", String(p.seed ?? "-")],
    ["挂载 LoRA", `${lorasText}（${p.lora_mode === "bypass" ? "INT8 旁路" : "标准模式"}）`],
    ["保存时间", `${item.created_at || "-"}（耗时 ${item.elapsed_sec ?? "-"}s）`],
  ];
  for (const [title, text] of blocks) {
    const div = document.createElement("div");
    div.className = "detail-block";
    const st = document.createElement("strong");
    st.textContent = title;
    const span = document.createElement("span");
    span.textContent = text;
    div.append(st, span);
    details.appendChild(div);
  }
  $("lightboxModal").classList.remove("hidden");
}

async function toggleHistoryFavorite(item) {
  try {
    const resp = await fetch(`/api/history/${encodeURIComponent(item.id)}/favorite`, {
      method: "POST",
    });
    const data = await resp.json();
    if (!resp.ok) return;
    item.favorite = Boolean(data.favorite);
    renderHistory();
  } catch (_) {}
}

async function deleteHistoryItem(item, permanent = false) {
  try {
    const qs = permanent || item.deleted ? "?permanent=1" : "";
    const resp = await fetch(`/api/history/${encodeURIComponent(item.id)}${qs}`, {
      method: "DELETE",
    });
    if (!resp.ok) return;
    if (state.lightboxItem && state.lightboxItem.id === item.id) {
      $("lightboxModal").classList.add("hidden");
    }
    await loadHistory();
    if (
      state.currentImages[state.currentImageIdx] &&
      state.currentImages[state.currentImageIdx].id === item.id
    ) {
      state.currentImages = [];
      if (state.galleryTab !== "trash" && state.historyItems.length > 0) {
        showMainPreviewImages([state.historyItems[0]], 0);
      } else {
        $("previewStage").classList.add("hidden");
        $("previewEmpty").classList.remove("hidden");
      }
    }
  } catch (_) {}
}

async function restoreTrashItem(item) {
  try {
    const resp = await fetch(`/api/history/${encodeURIComponent(item.id)}/restore`, {
      method: "POST",
    });
    if (resp.ok) await loadHistory();
  } catch (_) {}
}

async function emptyTrash() {
  try {
    const resp = await fetch("/api/history/empty-trash", { method: "POST" });
    if (resp.ok) await loadHistory();
  } catch (_) {}
}

function getFilteredHistory() {
  const q = (state.gallerySearch || "").trim().toLowerCase();
  return state.historyItems.filter((item) => {
    if (state.galleryTab === "fav" && !item.favorite) return false;
    if (!q) return true;
    const p = item.params || {};
    const hay = [
      p.positive || "",
      String(p.seed ?? ""),
      item.filename || "",
      ...(p.loras || []).map((l) => l.name || ""),
    ]
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  });
}

function renderHistory() {
  const grid = $("galleryGrid");
  grid.innerHTML = "";
  const items = getFilteredHistory();
  $("galleryCount").textContent = String(items.length);
  $("galleryEmpty").textContent =
    state.galleryTab === "trash"
      ? "回收站为空"
      : state.galleryTab === "fav"
      ? "暂无收藏作品"
      : state.gallerySearch.trim()
      ? "没有匹配的作品"
      : "暂无本地作品";
  $("galleryEmpty").classList.toggle("hidden", items.length > 0);

  for (const item of items) {
    const card = document.createElement("div");
    card.className = "gallery-item";

    const img = document.createElement("img");
    img.src = item.thumb_url || item.url;
    img.loading = "lazy";
    img.alt = item.filename || "MOSS output";

    const cap = document.createElement("div");
    cap.className = "gallery-caption";
    const promptDiv = document.createElement("div");
    promptDiv.className = "gallery-prompt";
    promptDiv.textContent = (item.params && item.params.positive) || item.filename;

    const sub = document.createElement("div");
    sub.className = "gallery-sub";
    const s1 = document.createElement("span");
    s1.textContent = `Seed ${(item.params && item.params.seed) ?? "-"}`;
    const s2 = document.createElement("span");
    const pw = (item.params && (item.params.out_width || item.params.width)) || 896;
    const ph = (item.params && (item.params.out_height || item.params.height)) || 1152;
    s2.textContent = `${pw}×${ph}`;
    sub.append(s1, s2);

    const actions = document.createElement("div");
    actions.className = "gallery-card-actions";
    if (state.galleryTab === "trash") {
      const restoreBtn = document.createElement("button");
      restoreBtn.type = "button";
      restoreBtn.className = "gallery-card-btn";
      restoreBtn.textContent = "恢复";
      restoreBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        restoreTrashItem(item);
      });
      const permBtn = document.createElement("button");
      permBtn.type = "button";
      permBtn.className = "gallery-card-btn is-danger";
      permBtn.textContent = "彻底删除";
      permBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteHistoryItem(item, true);
      });
      actions.append(restoreBtn, permBtn);
    } else {
      const favBtn = document.createElement("button");
      favBtn.type = "button";
      favBtn.className = `gallery-card-btn${item.favorite ? " is-fav" : ""}`;
      favBtn.textContent = item.favorite ? "已收藏" : "收藏";
      favBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleHistoryFavorite(item);
      });
      const trashBtn = document.createElement("button");
      trashBtn.type = "button";
      trashBtn.className = "gallery-card-btn is-danger";
      trashBtn.textContent = "移除";
      trashBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteHistoryItem(item, false);
      });
      actions.append(favBtn, trashBtn);
    }

    cap.append(promptDiv, sub, actions);
    card.append(img, cap);
    card.addEventListener("click", () => {
      if (!item.deleted) showMainPreviewImages([item], 0);
      openLightbox(item);
    });
    grid.appendChild(card);
  }
}

async function loadHistory() {
  try {
    const qs = state.galleryTab === "trash" ? "?trash=1" : "";
    const resp = await fetch(`/api/history${qs}`);
    if (!resp.ok) return;
    const data = await resp.json();
    state.historyItems = data.items || [];
    state.trashCount = Number(data.trash_count || 0);
    if ($("trashCountBadge")) {
      $("trashCountBadge").textContent = String(state.trashCount);
    }
    if ($("emptyTrashBtn")) {
      $("emptyTrashBtn").classList.toggle("hidden", state.galleryTab !== "trash");
    }
    renderHistory();
    if (
      state.galleryTab !== "trash" &&
      state.currentImages.length === 0 &&
      state.historyItems.length > 0
    ) {
      showMainPreviewImages([state.historyItems[0]], 0);
    }
  } catch (_) {}
}

async function loadInitialConfig() {
  populateSelect($("unetSelect"), [DEFAULT_MODELS.unet], DEFAULT_MODELS.unet);
  populateSelect($("clipSelect"), [DEFAULT_MODELS.clip], DEFAULT_MODELS.clip);
  populateSelect($("vaeSelect"), [DEFAULT_MODELS.vae], DEFAULT_MODELS.vae);
  populateSelect($("seedvr2DitSelect"), [DEFAULT_MODELS.seedvr2Dit], DEFAULT_MODELS.seedvr2Dit);
  populateSelect($("seedvr2VaeSelect"), [DEFAULT_MODELS.seedvr2Vae], DEFAULT_MODELS.seedvr2Vae);
  populateUpscaleSelect([]);

  try {
    const resp = await fetch("/api/config");
    if (!resp.ok) return;
    const cfg = await resp.json();
    state.lanUrl = cfg.lan_url || state.lanUrl;
    $("lanUrlText").textContent = state.lanUrl;
    state.civitaiApiKey = cfg.civitai_api_key || "";
    if ($("civitaiApiKeyInput")) {
      $("civitaiApiKeyInput").value = state.civitaiApiKey;
    }
    state.colabUrl = cfg.colab_url || "";
    state.colabNotebookRemote = cfg.colab_notebook_remote || state.colabNotebookRemote;
    renderColabHeaderState();
    await refreshGDriveStatus(false);
    if (state.gdriveStatus && state.gdriveStatus.mounted) {
      refreshGDriveLoras();
    }
    updateBridgeBadge();
    if (cfg.comfy_url) {
      $("comfyUrlInput").value = cfg.comfy_url;
      const ok = await connectComfy(true);
      if (!ok && state.gdriveStatus && state.gdriveStatus.mounted) {
        await autoConnectColab({ silent: true });
      }
    } else if (state.gdriveStatus && state.gdriveStatus.mounted) {
      await autoConnectColab({ silent: true });
    }
  } catch (_) {}
}

const civitaiDownloadTimers = {};
let gdriveAuthPollTimer = null;
let colabAutoWaitTimer = null;
let colabAutoWaitAttempts = 0;

function setColabStatusMsg(msg, kind = "") {
  const el = $("colabStatusMsg");
  if (!el) return;
  if (!msg) {
    el.textContent = "";
    el.classList.add("hidden");
    el.classList.remove("is-error", "is-ok");
    return;
  }
  el.textContent = msg;
  el.classList.remove("hidden", "is-error", "is-ok");
  if (kind === "error") el.classList.add("is-error");
  else if (kind === "ok") el.classList.add("is-ok");
}

function renderColabHeaderState() {
  const cleanUrl = (state.colabUrl || "").trim();
  const hasUrl = Boolean(cleanUrl);
  const badge = $("colabModalBadge");
  if (badge) {
    badge.className = `bridge-badge ${hasUrl ? "online" : "offline"}`;
    badge.textContent = hasUrl ? "已绑定 Colab" : "未同步";
  }
  const directBtn = $("openColabDirectBtn");
  if (directBtn) {
    directBtn.href = hasUrl ? cleanUrl : "#";
    directBtn.title = hasUrl
      ? `在新标签页打开 ${cleanUrl}`
      : "尚未绑定 Colab 链接，点击进入联动中心一键同步";
  }
  if ($("colabUrlInput") && document.activeElement !== $("colabUrlInput")) {
    $("colabUrlInput").value = state.colabUrl || "";
  }
  const modalOpenBtn = $("colabOpenFromModalBtn");
  if (modalOpenBtn) {
    modalOpenBtn.href = hasUrl ? cleanUrl : "#";
    modalOpenBtn.classList.toggle("is-disabled", !hasUrl);
    modalOpenBtn.setAttribute("aria-disabled", hasUrl ? "false" : "true");
  }
  if ($("colabStopWaitBtn")) {
    $("colabStopWaitBtn").classList.toggle("hidden", !state.colabWaiting);
  }
}

function renderColabEndpointCard(ep) {
  const el = $("colabEndpointStatusText");
  if (!el) return;
  if (!ep || !ep.found) {
    el.textContent =
      (ep && ep.message) ||
      "云盘暂未发现 Colab 启动记录。在 Colab 运行新版 Cell 4 后，公网地址会自动写入云盘。";
    return;
  }
  const statusMap = {
    running: "运行中",
    stopped: "已停止",
  };
  const stText = statusMap[ep.status] || ep.status || "未知";
  const gpuText = ep.gpu_name ? ` · GPU: ${ep.gpu_name}` : "";
  const ageMin = ep.age_sec ? `${Math.floor(ep.age_sec / 60)} 分钟前` : "刚刚";
  el.textContent = `状态：${stText}${gpuText} · 更新于 ${ageMin} · 地址：${ep.comfy_url}`;
}

async function refreshColabEndpoint() {
  try {
    const resp = await fetch("/api/colab/endpoint");
    const ep = await resp.json();
    renderColabEndpointCard(ep);
    return ep;
  } catch (_) {
    return null;
  }
}

async function refreshColabNotebooks() {
  const sel = $("colabNotebookSelect");
  if (!sel) return;
  if ($("colabRefreshNbsBtn")) $("colabRefreshNbsBtn").disabled = true;
  try {
    const resp = await fetch("/api/colab/notebooks");
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "读取云盘 Notebook 列表失败");
    state.colabNotebooks = data.items || [];
    sel.innerHTML = "";
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent =
      state.colabNotebooks.length > 0
        ? "选择云盘中的 Colab Notebook..."
        : "云盘 Colab Notebooks 下暂无 .ipynb 文件";
    sel.appendChild(placeholder);

    for (const nb of state.colabNotebooks) {
      const opt = document.createElement("option");
      opt.value = nb.colab_url;
      opt.textContent = `${nb.name} (${nb.mod_time || nb.size_kb + " KB"})`;
      if (state.colabUrl && nb.colab_url === state.colabUrl) {
        opt.selected = true;
      }
      sel.appendChild(opt);
    }
  } catch (err) {
    setColabStatusMsg(`读取云盘 Notebook 列表失败：${err.message}`, "error");
  } finally {
    if ($("colabRefreshNbsBtn")) $("colabRefreshNbsBtn").disabled = false;
  }
}

async function saveColabUrl(overrideUrl = null) {
  const urlVal =
    overrideUrl !== null
      ? String(overrideUrl).trim()
      : ($("colabUrlInput")?.value || "").trim();
  try {
    const resp = await fetch("/api/colab/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ colab_url: urlVal }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "保存失败");
    state.colabUrl = data.colab_url || "";
    renderColabHeaderState();
    setColabStatusMsg(
      state.colabUrl ? "已保存 Colab 直达链接。" : "已清空 Colab 直达链接。",
      "ok"
    );
  } catch (err) {
    setColabStatusMsg(`保存 Colab 链接失败：${err.message}`, "error");
  }
}

async function syncColabNotebook() {
  if ($("colabSyncNbBtn")) $("colabSyncNbBtn").disabled = true;
  setColabStatusMsg("正在将本地最新版 Notebook 同步到 Google Drive...");
  try {
    const resp = await fetch("/api/colab/sync-notebook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "同步失败");
    state.colabUrl = data.colab_url || state.colabUrl;
    state.colabNotebookRemote = data.remote_path || state.colabNotebookRemote;
    renderColabHeaderState();
    await refreshColabNotebooks();
    setColabStatusMsg(
      `已同步至云盘 ${data.remote_path}，并绑定直达链接！点击「立即打开 Colab ↗」即可使用新版自动握手。`,
      "ok"
    );
  } catch (err) {
    setColabStatusMsg(`同步 Notebook 失败：${err.message}`, "error");
  } finally {
    if ($("colabSyncNbBtn")) $("colabSyncNbBtn").disabled = false;
  }
}

function stopColabAutoWait(quiet = false) {
  if (colabAutoWaitTimer) {
    clearInterval(colabAutoWaitTimer);
    colabAutoWaitTimer = null;
  }
  colabAutoWaitAttempts = 0;
  if (state.colabWaiting) {
    state.colabWaiting = false;
    renderColabHeaderState();
    if (!state.connected) {
      setStatus("offline", "未连接");
    }
    if (!quiet) {
      setColabStatusMsg("已停止等待 Colab 自动连接。");
    }
  }
}

async function autoConnectColab({ silent = false, force = false } = {}) {
  const btn = $("autoConnectColabBtn");
  const modalBtn = $("colabAutoConnectModalBtn");
  if (!silent) {
    if (btn) btn.disabled = true;
    if (modalBtn) modalBtn.disabled = true;
    setStatus("offline", "正在读取云盘地址...");
    setColabStatusMsg("正在从 Google Drive 读取最新 Colab 隧道地址并探测连接...");
  }

  try {
    const resp = await fetch("/api/colab/auto-connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force }),
    });
    const data = await resp.json();
    if (data.endpoint) {
      renderColabEndpointCard(data.endpoint);
    }
    if (data.connected) {
      applyComfyConnectionSuccess(data, data.comfy_url);
      setColabStatusMsg(
        `已自动连接到 Colab ComfyUI（${data.comfy_url}）！`,
        "ok"
      );
      return true;
    }

    if (!silent) {
      setStatus("offline", state.colabWaiting ? "等待 Colab 启动..." : "未连接");
      const errMsg = data.error || "暂未检测到可用的 Colab 隧道地址。";
      setColabStatusMsg(errMsg, "error");
      if ($("colabModal") && $("colabModal").classList.contains("hidden")) {
        showError(errMsg, {
          label: "新标签页打开 Colab ↗",
          onClick: () => openColabDirect({ mode: "newtab" }),
        });
      }
    }
    return false;
  } catch (err) {
    if (!silent) {
      setStatus("error", "自动连接失败");
      setColabStatusMsg(`自动连接失败：${err.message}`, "error");
    }
    return false;
  } finally {
    if (!silent) {
      if (btn) btn.disabled = false;
      if (modalBtn) modalBtn.disabled = false;
    }
  }
}

function startColabAutoWait() {
  stopColabAutoWait(true);
  state.colabWaiting = true;
  colabAutoWaitAttempts = 0;
  renderColabHeaderState();
  setStatus("offline", "等待 Colab 启动...");
  setColabStatusMsg("已进入自动等待模式：在 Colab 运行 Cell 4 后，本地会自动检测并连接（每 6 秒检查一次）...");

  const pollOnce = async () => {
    if (!state.colabWaiting || state.connected) {
      stopColabAutoWait(true);
      return;
    }
    colabAutoWaitAttempts += 1;
    if (colabAutoWaitAttempts > 100) {
      stopColabAutoWait(true);
      setColabStatusMsg("等待 Colab 超时（10 分钟），启动 Cell 4 后可随时点「自动连接」。");
      return;
    }
    await autoConnectColab({ silent: true });
  };

  colabAutoWaitTimer = setInterval(pollOnce, 6000);
}

async function openColabModal(hintMsg = "") {
  setColabStatusMsg(hintMsg || "");
  renderColabHeaderState();
  $("colabModal").classList.remove("hidden");
  refreshColabEndpoint();
  if (state.gdriveStatus && state.gdriveStatus.rclone_configured) {
    refreshColabNotebooks();
  }
}

async function openColabDirect({ mode = "newtab", forceWait = false } = {}) {
  let url = (state.colabUrl || "").trim();
  if (!url) {
    try {
      const resp = await fetch("/api/colab/config");
      if (resp.ok) {
        const cfg = await resp.json();
        state.colabUrl = (cfg.colab_url || "").trim();
        url = state.colabUrl;
        renderColabHeaderState();
      }
    } catch (_) {}
  }
  if (!url) {
    openColabModal("尚未绑定 Colab 直达链接：请点击「同步本地最新版到云盘」自动生成直达链接，或粘贴已有 Colab URL。");
    return;
  }

  if (mode !== "external") {
    const win = window.open(url, "_blank", "noopener,noreferrer");
    if (!win) {
      openColabModal(
        "浏览器拦截了新标签页弹窗，请点击上方「新标签页打开 Colab ↗」或复制链接打开。"
      );
    }
    return;
  }

  const isLocalHost = ["127.0.0.1", "localhost", "::1"].includes(
    window.location.hostname
  );
  let opened = false;
  if (isLocalHost) {
    try {
      const resp = await fetch("/api/colab/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      if (resp.ok) {
        opened = true;
        if ($("stageText")) {
          $("stageText").textContent =
            "已在系统浏览器打开 Colab，请运行 Cell 1 → Cell 2 → Cell 4...";
        }
        setColabStatusMsg("已在系统浏览器打开 Colab Notebook。", "ok");
      }
    } catch (_) {}
  }
  if (!opened) {
    const win = window.open(url, "_blank", "noopener,noreferrer");
    if (!win) {
      openColabModal(
        "浏览器拦截了弹窗，请点击上方「新标签页打开 Colab ↗」或复制链接打开。"
      );
    }
  }

  const shouldWait =
    forceWait || Boolean($("colabAutoWaitCheck") && $("colabAutoWaitCheck").checked);
  if (!state.connected && shouldWait) {
    startColabAutoWait();
  }
}

function setGDriveStatusMsg(msg, kind = "") {
  const el = $("gdriveStatusMsg");
  if (!el) return;
  if (!msg) {
    el.textContent = "";
    el.classList.add("hidden");
    el.classList.remove("is-error", "is-ok");
    return;
  }
  el.textContent = msg;
  el.classList.remove("hidden", "is-error", "is-ok");
  if (kind === "error") el.classList.add("is-error");
  else if (kind === "ok") el.classList.add("is-ok");
}

function syncGDriveModeInputs() {
  const mode = $("gdriveModeSelect") ? $("gdriveModeSelect").value : "rclone";
  const isLocal = mode === "local";
  if ($("gdriveRcloneTargetWrap")) {
    $("gdriveRcloneTargetWrap").classList.toggle("hidden", isLocal);
  }
  if ($("gdriveLocalDirWrap")) {
    $("gdriveLocalDirWrap").classList.toggle("hidden", !isLocal);
  }
  if ($("gdriveAuthBtn")) {
    $("gdriveAuthBtn").classList.toggle("hidden", isLocal);
  }
}

function renderGDriveModalState() {
  const st = state.gdriveStatus || {};
  const mounted = Boolean(st.mounted);

  const dot = $("gdriveDot");
  if (dot) {
    dot.classList.remove("online", "offline");
    dot.classList.add(mounted ? "online" : "offline");
  }

  const badge = $("gdriveModalBadge");
  if (badge) {
    badge.className = `bridge-badge ${mounted ? "online" : "offline"}`;
    badge.textContent = mounted ? "已挂载" : "未挂载";
  }

  if ($("gdriveStatusLabel")) {
    if (mounted) {
      $("gdriveStatusLabel").textContent =
        st.mode === "local" ? "已挂载（本地 Drive 目录）" : "已挂载（rclone 云端直连）";
    } else {
      $("gdriveStatusLabel").textContent = "未挂载";
    }
  }

  if ($("gdriveRcloneInfo")) {
    $("gdriveRcloneInfo").textContent = st.rclone_installed
      ? st.rclone_version || "rclone 已就绪"
      : "未检测到 rclone";
  }

  const quotaRow = $("gdriveQuotaRow");
  if (quotaRow) {
    if (st.quota && st.quota.total_gb > 0) {
      quotaRow.classList.remove("hidden");
      const used = Number(st.quota.used_gb || 0);
      const total = Number(st.quota.total_gb || 1);
      const free = Number(st.quota.free_gb || 0);
      const pct = Math.min(100, Math.max(0, (used / total) * 100));
      $("gdriveQuotaText").textContent = `云盘空间：已用 ${used.toFixed(1)} GB / 总计 ${total.toFixed(1)} GB（剩余 ${free.toFixed(1)} GB）`;
      $("gdriveQuotaFill").style.width = `${pct.toFixed(1)}%`;
    } else {
      quotaRow.classList.add("hidden");
    }
  }

  if ($("gdriveModeSelect") && st.mode) {
    $("gdriveModeSelect").value = st.mode;
  }
  if ($("gdriveTargetDirInput") && document.activeElement !== $("gdriveTargetDirInput")) {
    $("gdriveTargetDirInput").value = st.target_dir || "ComfyUI_Data/models/loras";
  }
  if ($("gdriveLocalDirInput") && document.activeElement !== $("gdriveLocalDirInput")) {
    $("gdriveLocalDirInput").value = st.local_dir || "";
  }
  syncGDriveModeInputs();

  const auth = st.auth || {};
  const isPending = auth.state === "pending";
  if ($("gdriveAuthBtn")) {
    $("gdriveAuthBtn").disabled = isPending || !st.rclone_installed;
    $("gdriveAuthBtn").textContent = st.rclone_configured ? "重新授权 Google 账号" : "一键浏览器授权挂载";
  }
  if ($("gdriveAuthCancelBtn")) {
    $("gdriveAuthCancelBtn").classList.toggle("hidden", !isPending);
  }
  if ($("gdriveDisconnectBtn")) {
    $("gdriveDisconnectBtn").classList.toggle("hidden", !st.rclone_configured);
  }
  if ($("gdriveAuthLinkBox")) {
    if (isPending && auth.auth_url) {
      $("gdriveAuthLinkBox").classList.remove("hidden");
      $("gdriveAuthLink").href = auth.auth_url;
      $("gdriveAuthLink").textContent = auth.auth_url;
    } else {
      $("gdriveAuthLinkBox").classList.add("hidden");
    }
  }
}

function renderGDriveLoraList() {
  const list = $("gdriveLoraList");
  const countBadge = $("gdriveLoraCountBadge");
  if (countBadge) {
    countBadge.textContent = String((state.gdriveLoraItems || []).length);
  }
  if (!list) return;
  list.innerHTML = "";

  const mounted = Boolean(state.gdriveStatus && state.gdriveStatus.mounted);
  if (!mounted) {
    const empty = document.createElement("div");
    empty.className = "empty-lora";
    empty.textContent = "挂载 Google Drive 后可在此查看目标目录内的 LoRA 文件。";
    list.appendChild(empty);
    return;
  }

  if (!state.gdriveLoraItems || state.gdriveLoraItems.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-lora";
    empty.textContent = "当前目标目录内暂无 LoRA 文件，可在「Civitai 库」直接下载。";
    list.appendChild(empty);
    return;
  }

  for (const item of state.gdriveLoraItems) {
    const row = document.createElement("div");
    row.className = "gdrive-lora-item";
    const nameEl = document.createElement("span");
    nameEl.className = "gdrive-lora-name";
    nameEl.textContent = item.name;
    const metaEl = document.createElement("span");
    metaEl.className = "gdrive-lora-meta";
    metaEl.textContent = `${item.size_mb ?? 0} MB${item.mod_time ? ` · ${item.mod_time}` : ""}`;
    row.append(nameEl, metaEl);
    list.appendChild(row);
  }
}

async function refreshGDriveStatus(includeQuota = true) {
  try {
    const resp = await fetch(`/api/gdrive/status?quota=${includeQuota ? "1" : "0"}`);
    if (!resp.ok) return null;
    const data = await resp.json();
    state.gdriveStatus = data;
    renderGDriveModalState();
    updateBridgeBadge();
    if ($("civitaiModal") && !$("civitaiModal").classList.contains("hidden")) {
      renderCivitaiGrid();
    }
    return data;
  } catch (_) {
    return null;
  }
}

async function refreshGDriveLoras() {
  if (!state.gdriveStatus || !state.gdriveStatus.mounted) {
    state.gdriveLoras = [];
    state.gdriveLoraItems = [];
    renderGDriveLoraList();
    renderLoras();
    return;
  }
  try {
    const resp = await fetch("/api/gdrive/loras");
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "获取 Drive 列表失败");
    state.gdriveLoraItems = data.items || [];
    state.gdriveLoras = data.names || state.gdriveLoraItems.map((it) => it.name);
    renderGDriveLoraList();
    renderLoras();
    if ($("civitaiModal") && !$("civitaiModal").classList.contains("hidden")) {
      renderCivitaiGrid();
    }
  } catch (err) {
    setGDriveStatusMsg(`刷新 Drive LoRA 列表失败：${err.message}`, "error");
  }
}

async function saveGDriveConfig() {
  const mode = $("gdriveModeSelect").value;
  const targetDir = $("gdriveTargetDirInput").value.trim();
  const localDir = $("gdriveLocalDirInput").value.trim();
  $("gdriveSaveConfigBtn").disabled = true;
  try {
    const resp = await fetch("/api/gdrive/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode,
        target_dir: targetDir || "ComfyUI_Data/models/loras",
        local_dir: localDir,
      }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "保存失败");
    state.gdriveStatus = data.status;
    renderGDriveModalState();
    updateBridgeBadge();
    setGDriveStatusMsg("Google Drive 目录配置已保存。", "ok");
    if (state.gdriveStatus && state.gdriveStatus.mounted) {
      await refreshGDriveStatus(true);
      await refreshGDriveLoras();
    } else {
      renderGDriveLoraList();
    }
  } catch (err) {
    setGDriveStatusMsg(`保存配置失败：${err.message}`, "error");
  } finally {
    $("gdriveSaveConfigBtn").disabled = false;
  }
}

function stopGDriveAuthPoll() {
  if (gdriveAuthPollTimer) {
    clearInterval(gdriveAuthPollTimer);
    gdriveAuthPollTimer = null;
  }
}

function pollGDriveAuth() {
  stopGDriveAuthPoll();
  const tick = async () => {
    try {
      const resp = await fetch("/api/gdrive/auth/status");
      if (!resp.ok) return;
      const data = await resp.json();
      const auth = data.auth || {};
      if (state.gdriveStatus) {
        state.gdriveStatus.auth = auth;
      }
      if (auth.state === "authorized") {
        stopGDriveAuthPoll();
        if (data.status) {
          state.gdriveStatus = data.status;
        } else {
          await refreshGDriveStatus(true);
        }
        renderGDriveModalState();
        updateBridgeBadge();
        setGDriveStatusMsg("Google Drive 授权挂载成功！现在可以直接下载 LoRA 到云盘。", "ok");
        await refreshGDriveLoras();
      } else if (auth.state === "error") {
        stopGDriveAuthPoll();
        renderGDriveModalState();
        setGDriveStatusMsg(`授权失败：${auth.error || "未知错误"}`, "error");
      } else if (auth.state === "idle") {
        stopGDriveAuthPoll();
        renderGDriveModalState();
      } else {
        renderGDriveModalState();
      }
    } catch (_) {}
  };
  gdriveAuthPollTimer = setInterval(tick, 1000);
}

async function startGDriveAuth() {
  setGDriveStatusMsg("正在启动 Google 浏览器授权...");
  $("gdriveAuthBtn").disabled = true;
  try {
    const targetDir = $("gdriveTargetDirInput").value.trim() || "ComfyUI_Data/models/loras";
    await fetch("/api/gdrive/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "rclone", target_dir: targetDir }),
    });
    const resp = await fetch("/api/gdrive/auth/start", { method: "POST" });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "启动授权失败");
    if (!state.gdriveStatus) state.gdriveStatus = {};
    state.gdriveStatus.auth = data.auth || { state: "pending", auth_url: "" };
    renderGDriveModalState();
    setGDriveStatusMsg("已调起浏览器授权页，请在浏览器中登录 Google 账号并点击允许。");
    pollGDriveAuth();
  } catch (err) {
    setGDriveStatusMsg(`启动授权失败：${err.message}`, "error");
    $("gdriveAuthBtn").disabled = false;
  }
}

async function cancelGDriveAuth() {
  stopGDriveAuthPoll();
  try {
    await fetch("/api/gdrive/auth/cancel", { method: "POST" });
    await refreshGDriveStatus(false);
    setGDriveStatusMsg("已取消 Google Drive 授权。");
  } catch (_) {}
}

async function disconnectGDrive() {
  stopGDriveAuthPoll();
  try {
    const resp = await fetch("/api/gdrive/disconnect", { method: "POST" });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "断开失败");
    state.gdriveStatus = data.status;
    state.gdriveLoras = [];
    state.gdriveLoraItems = [];
    renderGDriveModalState();
    renderGDriveLoraList();
    updateBridgeBadge();
    if ($("civitaiModal") && !$("civitaiModal").classList.contains("hidden")) {
      renderCivitaiGrid();
    }
    setGDriveStatusMsg("已断开 Google Drive 挂载。");
  } catch (err) {
    setGDriveStatusMsg(`断开挂载失败：${err.message}`, "error");
  }
}

function setCivitaiStatus(msg, kind = "") {
  const el = $("civitaiStatusMsg");
  if (!el) return;
  el.textContent = msg;
  el.classList.remove("is-error", "is-ok");
  if (kind === "error") el.classList.add("is-error");
  else if (kind === "ok") el.classList.add("is-ok");
}

function appendTriggerWord(word) {
  const input = $("positiveInput");
  if (!input || !word) return;
  const cur = input.value.trim();
  if (!cur) {
    input.value = word;
  } else if (!cur.toLowerCase().includes(word.toLowerCase())) {
    const sep = /[,，\s]$/.test(cur) ? " " : ", ";
    input.value = `${cur}${sep}${word}`;
  }
  setCivitaiStatus(`已追加触发词「${word}」到正向提示词`, "ok");
}

async function saveCivitaiKey() {
  const key = $("civitaiApiKeyInput").value.trim();
  $("saveCivitaiKeyBtn").disabled = true;
  try {
    const resp = await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ civitai_api_key: key }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "保存失败");
    state.civitaiApiKey = key;
    setCivitaiStatus(
      key ? "Civitai API Key 已保存到本地配置。" : "已清空 Civitai API Key。",
      "ok"
    );
    if (!$("civitaiModal").classList.contains("hidden")) {
      await searchCivitai(true);
    }
  } catch (err) {
    setCivitaiStatus(`保存 API Key 失败：${err.message}`, "error");
  } finally {
    $("saveCivitaiKeyBtn").disabled = false;
  }
}

function pollCloudDownload(taskId, dlKey, comfyUrl) {
  if (civitaiDownloadTimers[dlKey]) {
    clearInterval(civitaiDownloadTimers[dlKey]);
  }
  const tick = async () => {
    try {
      const resp = await fetch(
        `/api/cloud/download/${encodeURIComponent(taskId)}?comfy_url=${encodeURIComponent(comfyUrl)}`
      );
      const data = await resp.json();
      if (!resp.ok) {
        throw new Error(data.error || "查询云端下载进度失败");
      }
      const prev = state.civitaiDownloads[dlKey] || {};
      const nextStatus = data.status || prev.status || "downloading";
      const dlName = data.filename || prev.filename || dlKey;
      const changed = prev.status !== nextStatus || prev.error !== data.error;

      state.civitaiDownloads[dlKey] = {
        status: nextStatus,
        taskId,
        filename: dlName,
        size_mb: data.size_mb ?? prev.size_mb ?? null,
        error: data.error || "",
      };

      if (nextStatus === "completed") {
        clearInterval(civitaiDownloadTimers[dlKey]);
        delete civitaiDownloadTimers[dlKey];
        setCivitaiStatus(
          `${dlName} 已写入云盘并同步到 Colab，正在刷新列表...`,
          "ok"
        );
        await connectComfy(true);
        setCivitaiStatus(
          `${dlName} 下载完成，点击「一键挂载」即可使用。`,
          "ok"
        );
        renderCivitaiGrid();
      } else if (nextStatus === "failed") {
        clearInterval(civitaiDownloadTimers[dlKey]);
        delete civitaiDownloadTimers[dlKey];
        setCivitaiStatus(`下载失败：${data.error || "云端下载错误"}`, "error");
        renderCivitaiGrid();
      } else if (changed) {
        renderCivitaiGrid();
      }
    } catch (err) {
      clearInterval(civitaiDownloadTimers[dlKey]);
      delete civitaiDownloadTimers[dlKey];
      state.civitaiDownloads[dlKey] = {
        status: "failed",
        taskId,
        filename: dlKey,
        error: err.message,
      };
      setCivitaiStatus(`轮询下载状态失败：${err.message}`, "error");
      renderCivitaiGrid();
    }
  };
  civitaiDownloadTimers[dlKey] = setInterval(tick, 1200);
}

function pollGDriveDownload(taskId, dlKey) {
  if (civitaiDownloadTimers[dlKey]) {
    clearInterval(civitaiDownloadTimers[dlKey]);
  }
  const tick = async () => {
    try {
      const resp = await fetch(`/api/gdrive/download/${encodeURIComponent(taskId)}`);
      const data = await resp.json();
      if (!resp.ok) {
        throw new Error(data.error || "查询 Google Drive 下载进度失败");
      }
      const prev = state.civitaiDownloads[dlKey] || {};
      const nextStatus = data.status || prev.status || "downloading";
      const dlName = data.filename || prev.filename || dlKey;

      state.civitaiDownloads[dlKey] = {
        status: nextStatus,
        channel: "gdrive",
        taskId,
        filename: dlName,
        size_mb: data.total_mb || prev.size_mb || null,
        downloaded_mb: data.downloaded_mb || 0,
        percent: Number(data.percent || 0),
        speed_mbps: Number(data.speed_mbps || 0),
        stage_text: data.stage_text || "",
        error: data.error || "",
      };

      if (nextStatus === "completed") {
        clearInterval(civitaiDownloadTimers[dlKey]);
        delete civitaiDownloadTimers[dlKey];
        await refreshGDriveLoras();
        setCivitaiStatus(
          `${dlName} 已直接下载到 Google Drive (${data.target_dir || "ComfyUI_Data/models/loras"})！`,
          "ok"
        );
        renderCivitaiGrid();
      } else if (nextStatus === "failed") {
        clearInterval(civitaiDownloadTimers[dlKey]);
        delete civitaiDownloadTimers[dlKey];
        setCivitaiStatus(`下载到 Drive 失败：${data.error || "传输错误"}`, "error");
        renderCivitaiGrid();
      } else {
        setCivitaiStatus(`${dlName}: ${data.stage_text || "传输中..."}`);
        renderCivitaiGrid();
      }
    } catch (err) {
      clearInterval(civitaiDownloadTimers[dlKey]);
      delete civitaiDownloadTimers[dlKey];
      state.civitaiDownloads[dlKey] = {
        status: "failed",
        channel: "gdrive",
        taskId,
        filename: dlKey,
        error: err.message,
      };
      setCivitaiStatus(`轮询 Drive 下载状态失败：${err.message}`, "error");
      renderCivitaiGrid();
    }
  };
  civitaiDownloadTimers[dlKey] = setInterval(tick, 800);
}

async function cancelGDriveDownload(taskId, dlKey) {
  if (!taskId) return;
  try {
    await fetch(`/api/gdrive/download/${encodeURIComponent(taskId)}/cancel`, {
      method: "POST",
    });
  } catch (_) {}
  if (civitaiDownloadTimers[dlKey]) {
    clearInterval(civitaiDownloadTimers[dlKey]);
    delete civitaiDownloadTimers[dlKey];
  }
  state.civitaiDownloads[dlKey] = {
    ...(state.civitaiDownloads[dlKey] || {}),
    status: "failed",
    error: "已取消",
  };
  setCivitaiStatus(`已取消下载 ${dlKey}`);
  renderCivitaiGrid();
}

function resolveActiveDownloadChannel() {
  const preferred = $("downloadChannelSelect")
    ? $("downloadChannelSelect").value
    : state.downloadChannel;
  const driveMounted = Boolean(state.gdriveStatus && state.gdriveStatus.mounted);
  const colabReady = Boolean(state.connected && state.supportsCloudDownload);

  if (preferred === "gdrive" && driveMounted) return "gdrive";
  if (preferred === "colab" && colabReady) return "colab";
  if (driveMounted) return "gdrive";
  if (colabReady) return "colab";
  return null;
}

async function startCloudDownload(item) {
  if (!item || !item.download_url || !item.filename) {
    setCivitaiStatus("该模型缺少有效下载直链或文件名。", "error");
    return;
  }
  const dlKey = item.filename;
  const channel = resolveActiveDownloadChannel();
  if (!channel) {
    setCivitaiStatus(
      "尚未挂载 Google Drive 且未连接新版 Colab：请点击右上方「配置 Drive」完成一键授权，或先「复制直链」。",
      "error"
    );
    return;
  }
  const civitaiToken = $("civitaiApiKeyInput").value.trim() || state.civitaiApiKey;

  if (Array.isArray(item.trained_words) && item.trained_words.length > 0) {
    state.loraMeta[item.filename] = {
      ...(state.loraMeta[item.filename] || {}),
      trained_words: item.trained_words,
      name: item.name || "",
      base_model: item.base_model || "",
      model_url: item.model_url || "",
      preview_url: item.preview_url || "",
    };
    renderLoraTriggerBar();
  }

  if (channel === "gdrive") {
    state.civitaiDownloads[dlKey] = {
      status: "downloading",
      channel: "gdrive",
      taskId: "",
      filename: item.filename,
      size_mb: item.size_mb || null,
      percent: 0,
      stage_text: "正在发起下载...",
      error: "",
    };
    setCivitaiStatus(`正在下载 ${item.filename} 并直传 Google Drive...`);
    renderCivitaiGrid();

    try {
      const resp = await fetch("/api/gdrive/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: item.download_url,
          filename: item.filename,
          civitai_token: civitaiToken,
          trained_words: item.trained_words || [],
          name: item.name || "",
          base_model: item.base_model || "",
          model_url: item.model_url || "",
          preview_url: item.preview_url || "",
        }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        throw new Error(data.error || "发起 Google Drive 下载失败");
      }
      state.civitaiDownloads[dlKey] = {
        status: data.status || "downloading",
        channel: "gdrive",
        taskId: data.task_id,
        filename: data.filename || item.filename,
        size_mb: data.total_mb || item.size_mb || null,
        percent: Number(data.percent || 0),
        stage_text: data.stage_text || "正在下载...",
        error: "",
      };
      renderCivitaiGrid();
      pollGDriveDownload(data.task_id, dlKey);
    } catch (err) {
      state.civitaiDownloads[dlKey] = {
        status: "failed",
        channel: "gdrive",
        taskId: "",
        filename: item.filename,
        error: err.message,
      };
      setCivitaiStatus(`启动 Drive 下载失败：${err.message}`, "error");
      renderCivitaiGrid();
    }
    return;
  }

  const comfyUrl = $("comfyUrlInput").value.trim();
  state.civitaiDownloads[dlKey] = {
    status: "downloading",
    channel: "colab",
    taskId: "",
    filename: item.filename,
    size_mb: item.size_mb || null,
    error: "",
  };
  setCivitaiStatus(`正在推送 ${item.filename} 到 Colab 云端下载队列...`);
  renderCivitaiGrid();

  try {
    const resp = await fetch("/api/cloud/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        comfy_url: comfyUrl,
        url: item.download_url,
        filename: item.filename,
        subfolder: item.subfolder || "loras",
        civitai_token: civitaiToken,
        trained_words: item.trained_words || [],
        name: item.name || "",
        base_model: item.base_model || "",
        model_url: item.model_url || "",
        preview_url: item.preview_url || "",
      }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      throw new Error(data.error || "发起云端下载失败");
    }
    state.civitaiDownloads[dlKey] = {
      status: "downloading",
      channel: "colab",
      taskId: data.task_id,
      filename: data.filename || item.filename,
      size_mb: item.size_mb || null,
      error: "",
    };
    setCivitaiStatus(`正在云端下载 ${item.filename} 到 Google Drive（完成后会自动同步到 SSD）...`);
    renderCivitaiGrid();
    pollCloudDownload(data.task_id, dlKey, comfyUrl);
  } catch (err) {
    state.civitaiDownloads[dlKey] = {
      status: "failed",
      channel: "colab",
      taskId: "",
      filename: item.filename,
      error: err.message,
    };
    setCivitaiStatus(`云端下载启动失败：${err.message}`, "error");
    renderCivitaiGrid();
  }
}

async function quickResolveAndDownload() {
  const rawInput = $("civitaiQuickUrlInput").value.trim();
  if (!rawInput) {
    setCivitaiStatus("请先粘贴 Civitai 模型链接 / ID / 下载链接，或 HuggingFace .safetensors 直链。", "error");
    return;
  }
  $("civitaiQuickDownloadBtn").disabled = true;
  setCivitaiStatus("正在解析模型地址...");
  try {
    const resp = await fetch("/api/civitai/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: rawInput,
        civitai_api_key: $("civitaiApiKeyInput").value.trim() || state.civitaiApiKey,
      }),
    });
    const resolved = await resp.json();
    if (!resp.ok) {
      throw new Error(resolved.error || "解析失败");
    }

    state.civitaiItems = [
      resolved,
      ...state.civitaiItems.filter((it) => it.filename !== resolved.filename),
    ];
    renderCivitaiGrid();

    if (resolveActiveDownloadChannel()) {
      await startCloudDownload(resolved);
    } else {
      const sizeStr = resolved.size_mb ? `${resolved.size_mb} MB · ` : "";
      setCivitaiStatus(
        `已解析 ${resolved.filename}（${sizeStr}${resolved.base_model || "LORA"}），已置顶到下方列表。挂载 Google Drive 后即可一键下载。`,
        "ok"
      );
    }
  } catch (err) {
    setCivitaiStatus(`解析失败：${err.message}`, "error");
  } finally {
    $("civitaiQuickDownloadBtn").disabled = false;
  }
}

function _civitaiItemKey(it) {
  if (!it) return "";
  return String(it.version_id || it.model_id || it.filename || "");
}

function updateCivitaiLoadState() {
  const el = $("civitaiLoadState");
  if (!el) return;
  if (state.civitaiLoading) {
    el.textContent = state.civitaiItems.length > 0 ? "正在加载更多..." : "正在加载...";
  } else if (state.civitaiItems.length === 0) {
    el.textContent = "";
  } else if (state.civitaiHasMore) {
    el.textContent = "向下滑动加载更多";
  } else {
    el.textContent = "已显示全部结果";
  }
}

function createCivitaiCard(item) {
  const card = document.createElement("div");
  card.className = "civitai-card";

  const thumbWrap = document.createElement("div");
  thumbWrap.className = "civitai-thumb-wrap";
  if (item.preview_url) {
    const img = document.createElement("img");
    img.className = "civitai-thumb";
    img.src = item.preview_url;
    img.alt = item.name || item.filename || "LoRA preview";
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    img.addEventListener("error", () => {
      const ph = document.createElement("div");
      ph.className = "civitai-thumb-placeholder";
      ph.textContent = "无预览图";
      img.replaceWith(ph);
    });
    thumbWrap.appendChild(img);
  } else {
    const ph = document.createElement("div");
    ph.className = "civitai-thumb-placeholder";
    ph.textContent = "无预览图";
    thumbWrap.appendChild(ph);
  }
  const baseTag = document.createElement("span");
  baseTag.className = "civitai-base-tag";
  baseTag.textContent = item.base_model || "LORA";
  thumbWrap.appendChild(baseTag);
  if (item.nsfw) {
    const r18Tag = document.createElement("span");
    r18Tag.className = "civitai-r18-tag";
    r18Tag.textContent = "R18";
    thumbWrap.appendChild(r18Tag);
  }

  const body = document.createElement("div");
  body.className = "civitai-card-body";

  const title = document.createElement("div");
  title.className = "civitai-card-title";
  if (item.model_url) {
    const link = document.createElement("a");
    link.href = item.model_url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = item.name || item.filename;
    title.appendChild(link);
  } else {
    title.textContent = item.name || item.filename;
  }

  const meta = document.createElement("div");
  meta.className = "civitai-card-meta";
  const sizeText = item.size_mb ? `${item.size_mb} MB` : "大小未知";
  const dlCount = item.downloads ? ` · ${item.downloads} 次下载` : "";
  meta.textContent = `${item.filename || "-"} (${sizeText}${dlCount})`;

  body.append(title, meta);

  const words = Array.isArray(item.trained_words) ? item.trained_words.filter(Boolean).slice(0, 6) : [];
  if (words.length > 0) {
    const trigWrap = document.createElement("div");
    trigWrap.className = "civitai-triggers";
    for (const word of words) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "trigger-chip";
      chip.title = `点击追加触发词：${word}`;
      chip.textContent = `+ ${word}`;
      chip.addEventListener("click", () => appendTriggerWord(word));
      trigWrap.appendChild(chip);
    }
    body.appendChild(trigWrap);
  }

  const footer = document.createElement("div");
  footer.className = "civitai-card-footer";
  const actions = document.createElement("div");
  actions.className = "civitai-card-actions";
  const note = document.createElement("div");
  note.className = "civitai-dl-note";

  const dlKey = item.filename || item.download_url;
  const dlState = state.civitaiDownloads[dlKey];
  const inCloud = Boolean(item.filename && state.availableLoras.includes(item.filename));
  const inGDrive = Boolean(item.filename && state.gdriveLoras.includes(item.filename));
  const isTransferring =
    dlState &&
    (dlState.status === "downloading" ||
      dlState.status === "uploading" ||
      dlState.status === "syncing_ssd");

  if ((inCloud || inGDrive) && !isTransferring) {
    const mountBtn = document.createElement("button");
    mountBtn.type = "button";
    mountBtn.className = "btn-mini btn-accent";
    mountBtn.textContent = "一键挂载";
    mountBtn.addEventListener("click", () => {
      mountLoraByName(item.filename, 1.0);
      setCivitaiStatus(`已将 ${item.filename} 挂载到主界面的 LoRA 列表。`, "ok");
    });
    actions.appendChild(mountBtn);
    if (!inCloud && inGDrive) {
      const dlBtn = document.createElement("button");
      dlBtn.type = "button";
      dlBtn.className = "btn-mini";
      dlBtn.textContent = "重下";
      dlBtn.addEventListener("click", () => startCloudDownload(item));
      actions.appendChild(dlBtn);
    }
    note.textContent =
      inCloud && inGDrive
        ? "已在云端 & Drive"
        : inCloud
        ? "已在云端"
        : "已在 Drive · 可挂载";
  } else if (isTransferring) {
    const busyBtn = document.createElement("button");
    busyBtn.type = "button";
    busyBtn.className = "btn-mini";
    busyBtn.disabled = true;
    busyBtn.textContent =
      dlState.status === "syncing_ssd"
        ? "同步 SSD..."
        : dlState.status === "uploading"
        ? "上传 Drive..."
        : "下载中...";
    actions.appendChild(busyBtn);

    if (dlState.channel === "gdrive" && dlState.taskId) {
      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "btn-mini";
      cancelBtn.textContent = "取消";
      cancelBtn.addEventListener("click", () => cancelGDriveDownload(dlState.taskId, dlKey));
      actions.appendChild(cancelBtn);
    }

    if (dlState.channel === "gdrive") {
      const pct = Math.min(100, Math.max(0, Number(dlState.percent || 0)));
      const prog = document.createElement("div");
      prog.className = "civitai-dl-progress";
      const fill = document.createElement("div");
      fill.className = "civitai-dl-progress-fill";
      fill.style.width = `${pct.toFixed(1)}%`;
      prog.appendChild(fill);
      footer.appendChild(prog);

      const speedTxt =
        dlState.speed_mbps >= 0.05 ? ` · ${dlState.speed_mbps.toFixed(1)} MB/s` : "";
      note.textContent = `${dlState.stage_text || "传输中..."}${speedTxt}`;
    } else {
      note.textContent =
        dlState.status === "syncing_ssd" ? "正在同步到 Colab 本地 SSD..." : "正在写入 Google Drive...";
    }
  } else {
    const activeCh = resolveActiveDownloadChannel();
    const dlBtn = document.createElement("button");
    dlBtn.type = "button";
    dlBtn.className = inGDrive ? "btn-mini" : "btn-mini btn-accent";
    dlBtn.textContent =
      dlState && dlState.status === "failed"
        ? "重试下载"
        : inGDrive
        ? "覆盖重下"
        : activeCh === "colab"
        ? "下载到云端"
        : "下载到 Drive";
    dlBtn.addEventListener("click", () => startCloudDownload(item));
    actions.appendChild(dlBtn);

    if (item.download_url) {
      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "btn-mini";
      copyBtn.textContent = "复制直链";
      copyBtn.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(item.download_url);
          copyBtn.textContent = "已复制";
          setTimeout(() => (copyBtn.textContent = "复制直链"), 1500);
        } catch (_) {}
      });
      actions.appendChild(copyBtn);
    }

    if (dlState && dlState.status === "failed") {
      note.textContent = `失败：${dlState.error || "下载失败"}`;
    } else if (inGDrive) {
      note.textContent = "已存入 Google Drive";
    } else if (dlState && dlState.status === "completed") {
      note.textContent = "下载完成，如未显示请点刷新";
    }
  }

  footer.append(actions, note);
  body.appendChild(footer);
  card.append(thumbWrap, body);
  return card;
}

function renderCivitaiGrid() {
  const grid = $("civitaiGrid");
  if (!grid) return;
  grid.innerHTML = "";

  if (!state.civitaiItems || state.civitaiItems.length === 0) {
    if (!state.civitaiLoading) {
      const empty = document.createElement("div");
      empty.className = "empty-lora";
      empty.textContent = "暂无匹配的 Civitai LoRA 结果，可尝试调整关键词或筛选条件。";
      grid.appendChild(empty);
    }
    updateCivitaiLoadState();
    return;
  }

  for (const item of state.civitaiItems) {
    grid.appendChild(createCivitaiCard(item));
  }
  updateCivitaiLoadState();
}

async function searchCivitai(reset = true) {
  if (!reset) {
    if (state.civitaiLoading || !state.civitaiHasMore || !state.civitaiCursor) {
      return;
    }
  } else {
    state.civitaiQuerySeq += 1;
    state.civitaiCursor = "";
    state.civitaiHasMore = false;
    state.civitaiItems = [];
    if ($("civitaiScrollWrap")) $("civitaiScrollWrap").scrollTop = 0;
    if ($("civitaiGrid")) $("civitaiGrid").innerHTML = "";
    $("civitaiSearchBtn").disabled = true;
    setCivitaiStatus("正在从 Civitai 检索 MOSS-Image LoRA...");
  }

  const seq = state.civitaiQuerySeq;
  state.civitaiLoading = true;
  updateCivitaiLoadState();
  let errorOccurred = false;

  const q = $("civitaiSearchInput").value.trim();
  const sort = $("civitaiSortSelect").value;
  const onlyMoss = $("civitaiOnlyMossCheck").checked ? "1" : "0";
  const onlyR18 = $("civitaiOnlyR18Check").checked ? "1" : "0";
  const onlyAnime = $("civitaiOnlyAnimeCheck").checked ? "1" : "0";

  try {
    const params = new URLSearchParams({
      q,
      sort,
      only_moss: onlyMoss,
      only_r18: onlyR18,
      only_anime: onlyAnime,
      limit: "12",
    });
    if (!reset && state.civitaiCursor) {
      params.set("cursor", state.civitaiCursor);
    }
    const resp = await fetch(`/api/civitai/search?${params.toString()}`);
    const data = await resp.json();
    if (seq !== state.civitaiQuerySeq) return;
    if (!resp.ok) {
      throw new Error(data.error || "搜索失败");
    }

    const existingKeys = new Set(state.civitaiItems.map(_civitaiItemKey));
    const added = [];
    for (const item of data.items || []) {
      const k = _civitaiItemKey(item);
      if (k && existingKeys.has(k)) continue;
      if (k) existingKeys.add(k);
      state.civitaiItems.push(item);
      added.push(item);
    }

    state.civitaiCursor = String(data.next_cursor || "");
    state.civitaiHasMore = Boolean(data.has_more && state.civitaiCursor);

    if (reset || state.civitaiItems.length === 0) {
      renderCivitaiGrid();
    } else if (added.length > 0 && $("civitaiGrid")) {
      const grid = $("civitaiGrid");
      for (const item of added) {
        grid.appendChild(createCivitaiCard(item));
      }
    }

    setCivitaiStatus(
      `已加载 ${state.civitaiItems.length} 个模型，点击触发词可加入正向提示词。`
    );
  } catch (err) {
    if (seq !== state.civitaiQuerySeq) return;
    errorOccurred = true;
    setCivitaiStatus(`检索失败：${err.message}`, "error");
    if (reset) renderCivitaiGrid();
  } finally {
    if (seq === state.civitaiQuerySeq) {
      state.civitaiLoading = false;
      $("civitaiSearchBtn").disabled = false;
      updateCivitaiLoadState();
      const wrap = $("civitaiScrollWrap");
      if (
        !errorOccurred &&
        wrap &&
        !$("civitaiModal").classList.contains("hidden") &&
        state.civitaiHasMore &&
        state.civitaiCursor &&
        wrap.scrollHeight <= wrap.clientHeight + 40
      ) {
        setTimeout(() => searchCivitai(false), 60);
      }
    }
  }
}

function bindEvents() {
  $("connectBtn").addEventListener("click", () => connectComfy(false));
  $("comfyUrlInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") connectComfy(false);
  });

  $("modeShinobiBtn").addEventListener("click", () => applyMode("shinobisat"));
  $("modeQualityBtn").addEventListener("click", () => applyMode("quality"));
  $("modeTurboBtn").addEventListener("click", () => applyMode("turbo"));

  $("autoMountSpeedBtn").addEventListener("click", () => {
    mountLoraByName(state.suggestedSpeedLora, 1.0);
  });

  document.querySelectorAll(".preset-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.getAttribute("data-preset");
      if (PRESETS[key]) {
        $("positiveInput").value = PRESETS[key];
        renderLoraTriggerBar();
      }
    });
  });

  $("positiveInput").addEventListener("input", () => {
    handleAutoPunctInput($("positiveInput"));
    renderLoraTriggerBar();
  });
  $("negativeInput").addEventListener("input", () => {
    handleAutoPunctInput($("negativeInput"));
  });
  $("autoPunctCheck").addEventListener("change", saveUiPrefs);

  $("addLoraBtn").addEventListener("click", () => {
    const allLoras = getMergedAvailableLoras();
    if (allLoras.length === 0) {
      state.loras.push({
        enabled: true,
        name: "",
        strength: 1.0,
      });
      renderLoras();
      return;
    }
    const mountedSet = new Set(state.loras.map((l) => l.name).filter(Boolean));
    const nextUnmounted = allLoras.find((n) => !mountedSet.has(n));
    if (nextUnmounted) {
      mountLoraByName(nextUnmounted, 1.0);
    } else {
      renderMyLorasModal();
      $("myLorasModal")?.classList.remove("hidden");
    }
  });

  $("loraQuickAddBtn")?.addEventListener("click", () => {
    const picked = $("loraQuickPickSelect") ? $("loraQuickPickSelect").value : "";
    if (!picked) {
      renderMyLorasModal();
      $("myLorasModal")?.classList.remove("hidden");
      return;
    }
    mountLoraByName(picked, 1.0);
  });

  $("openMyLorasBtn")?.addEventListener("click", () => {
    renderMyLorasModal();
    $("myLorasModal")?.classList.remove("hidden");
  });
  $("myLoraSearchInput")?.addEventListener("input", renderMyLorasModal);
  $("myLoraRefreshBtn")?.addEventListener("click", refreshAllLoras);
  $("refreshLoraBtn").addEventListener("click", refreshAllLoras);

  bindDropZone($("initDropZone"), $("initFileInput"), uploadInitFile);
  $("clearInitBtn").addEventListener("click", clearInitImage);
  $("img2imgDenoiseSlider").addEventListener("input", () => {
    $("img2imgDenoiseVal").textContent = Number($("img2imgDenoiseSlider").value).toFixed(2);
  });

  $("sendToImg2ImgBtn").addEventListener("click", async () => {
    const current = state.currentImages[state.currentImageIdx];
    if (current) await sendHistoryToImg2Img(current);
  });

  $("lightboxImg2ImgBtn").addEventListener("click", async () => {
    if (!state.lightboxItem) return;
    const item = state.lightboxItem;
    $("lightboxModal").classList.add("hidden");
    await sendHistoryToImg2Img(item);
  });

  $("upscaleModeSelect").addEventListener("change", updateUpscalePanels);
  $("upscaleFactorSelect").addEventListener("change", updateResSummary);
  $("seedvr2ResInput").addEventListener("change", updateResSummary);
  $("hiresDenoiseSlider").addEventListener("input", () => {
    $("hiresDenoiseVal").textContent = Number($("hiresDenoiseSlider").value).toFixed(2);
  });

  $("filmGrainCheck").addEventListener("change", () => {
    $("grainSliderWrap").classList.toggle("hidden", !$("filmGrainCheck").checked);
  });
  $("filmGrainSlider").addEventListener("input", () => {
    $("filmGrainVal").textContent = Number($("filmGrainSlider").value).toFixed(3);
  });

  document.querySelectorAll(".ratio-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      setRatioPreset(
        parseInt(btn.getAttribute("data-w"), 10),
        parseInt(btn.getAttribute("data-h"), 10)
      );
    });
  });

  $("widthInput").addEventListener("change", updateResSummary);
  $("heightInput").addEventListener("change", updateResSummary);

  $("randomSeedBtn").addEventListener("click", () => {
    $("seedInput").value = -1;
  });
  $("reuseSeedBtn").addEventListener("click", () => {
    if (state.lastSeed !== null) {
      $("seedInput").value = state.lastSeed;
    }
  });

  $("generateBtn").addEventListener("click", startGenerate);
  $("interruptBtn").addEventListener("click", interruptGenerate);

  document.addEventListener("keydown", (e) => {
    if (window.MossComicEditor && window.MossComicEditor.isOpen()) return;
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      if (!$("generateBtn").disabled) startGenerate();
    } else if (e.key === "Escape") {
      [
        "myLorasModal",
        "colabModal",
        "gdriveModal",
        "civitaiModal",
        "lightboxModal",
        "queueModal",
        "imgMetaModal",
        "presetsModal",
        "jsonModal",
        "lanModal",
      ].forEach((id) => {
        if ($(id)) $(id).classList.add("hidden");
      });
    }
  });

  document.addEventListener("paste", (e) => {
    const items = [...((e.clipboardData && e.clipboardData.files) || [])];
    const imgFile = items.find((f) => f && f.type && f.type.startsWith("image/"));
    if (!imgFile) return;
    if ($("imgMetaModal") && !$("imgMetaModal").classList.contains("hidden")) {
      e.preventDefault();
      readImageMetaFile(imgFile);
    } else if ($("img2imgDetails") && $("img2imgDetails").open) {
      e.preventDefault();
      uploadInitFile(imgFile);
    }
  });

  document.querySelectorAll(".view-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.compareView = btn.getAttribute("data-view") || "compare";
      renderPreviewDisplay();
    });
  });

  $("abRange").addEventListener("input", () => {
    updateAbSlider($("abRange").value);
  });

  $("mainPreviewImg").addEventListener("click", () => {
    const current = state.currentImages[state.currentImageIdx];
    if (current) openLightbox(current);
  });

  $("fullscreenBtn").addEventListener("click", () => {
    const current = state.currentImages[state.currentImageIdx];
    if (current) openLightbox(current);
  });

  $("reuseParamsBtn").addEventListener("click", () => {
    const current = state.currentImages[state.currentImageIdx];
    if (current && current.params) applyParamsToForm(current.params);
  });

  $("lbFinalBtn").addEventListener("click", () => {
    if (!state.lightboxItem) return;
    $("lightboxImg").src = state.lightboxItem.url;
    $("lightboxDownload").href = state.lightboxItem.url;
    $("lightboxDownload").download = state.lightboxItem.filename || "moss_output.png";
    $("lbFinalBtn").classList.add("btn-accent");
    $("lbBaseBtn").classList.remove("btn-accent");
  });

  $("lbBaseBtn").addEventListener("click", () => {
    if (!state.lightboxItem || !state.lightboxItem.base_url) return;
    $("lightboxImg").src = state.lightboxItem.base_url;
    $("lightboxDownload").href = state.lightboxItem.base_url;
    $("lightboxDownload").download = state.lightboxItem.base_filename || "moss_base.png";
    $("lbBaseBtn").classList.add("btn-accent");
    $("lbFinalBtn").classList.remove("btn-accent");
  });

  $("lightboxReuseBtn").addEventListener("click", () => {
    if (state.lightboxItem && state.lightboxItem.params) {
      applyParamsToForm(state.lightboxItem.params);
      $("lightboxModal").classList.add("hidden");
    }
  });

  $("lightboxDeleteBtn").addEventListener("click", async () => {
    if (!state.lightboxItem) return;
    await deleteHistoryItem(state.lightboxItem, Boolean(state.lightboxItem.deleted));
  });

  $("gallerySearchInput").addEventListener("input", () => {
    state.gallerySearch = $("gallerySearchInput").value;
    renderHistory();
  });

  const switchGalleryTab = async (tab) => {
    state.galleryTab = tab;
    $("galTabAll").classList.toggle("active", tab === "all");
    $("galTabFav").classList.toggle("active", tab === "fav");
    $("galTabTrash").classList.toggle("active", tab === "trash");
    await loadHistory();
  };
  $("galTabAll").addEventListener("click", () => switchGalleryTab("all"));
  $("galTabFav").addEventListener("click", () => switchGalleryTab("fav"));
  $("galTabTrash").addEventListener("click", () => switchGalleryTab("trash"));
  $("emptyTrashBtn").addEventListener("click", emptyTrash);

  $("queueBtn").addEventListener("click", async () => {
    await loadQueueSnapshot();
    renderQueueModal();
    $("queueModal").classList.remove("hidden");
  });
  $("queueClearBtn").addEventListener("click", clearJobQueue);
  $("notifySoundCheck").addEventListener("change", saveUiPrefs);
  $("notifyDesktopCheck").addEventListener("change", async () => {
    if ($("notifyDesktopCheck").checked) {
      if (typeof Notification === "undefined") {
        $("notifyDesktopCheck").checked = false;
      } else if (Notification.permission !== "granted") {
        const res = await Notification.requestPermission();
        if (res !== "granted") $("notifyDesktopCheck").checked = false;
      }
    }
    saveUiPrefs();
  });

  $("openImgMetaBtn").addEventListener("click", () => {
    $("imgMetaModal").classList.remove("hidden");
  });
  bindDropZone($("imgMetaDropZone"), $("imgMetaFileInput"), readImageMetaFile);
  $("imgMetaApplyBtn").addEventListener("click", applyParsedMeta);
  $("imgMetaCopyBtn").addEventListener("click", async () => {
    const pos = state.parsedMeta && state.parsedMeta.params && state.parsedMeta.params.positive;
    if (!pos) return;
    try {
      await navigator.clipboard.writeText(pos);
      $("imgMetaCopyBtn").textContent = "已复制";
      setTimeout(() => ($("imgMetaCopyBtn").textContent = "复制提示词"), 1500);
    } catch (_) {}
  });

  $("openPresetsBtn").addEventListener("click", async () => {
    await loadPresets();
    $("presetsModal").classList.remove("hidden");
  });
  $("savePresetBtn").addEventListener("click", saveCurrentPreset);
  $("presetNameInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveCurrentPreset();
  });

  $("lanBtn").addEventListener("click", () => {
    $("lanUrlText").textContent = state.lanUrl;
    $("lanModal").classList.remove("hidden");
  });

  $("copyLanBtn").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(state.lanUrl);
      $("copyLanBtn").textContent = "已复制";
      setTimeout(() => ($("copyLanBtn").textContent = "复制地址"), 1500);
    } catch (_) {}
  });

  $("openOutputsBtn").addEventListener("click", async () => {
    await fetch("/api/open-outputs", { method: "POST" });
  });

  $("inspectWorkflowBtn").addEventListener("click", async () => {
    showError("");
    const payload = collectPayload();
    if (!payload.positive.trim()) {
      payload.positive = "(示例提示词预览)";
    }
    const resp = await fetch("/api/workflow-preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    $("jsonPreviewCode").textContent = JSON.stringify(data, null, 2);
    $("jsonModal").classList.remove("hidden");
  });

  $("copyJsonBtn").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("jsonPreviewCode").textContent);
      $("copyJsonBtn").textContent = "已复制";
      setTimeout(() => ($("copyJsonBtn").textContent = "复制 JSON"), 1500);
    } catch (_) {}
  });

  const openGDriveModal = async () => {
    setGDriveStatusMsg("");
    $("gdriveModal").classList.remove("hidden");
    await refreshGDriveStatus(true);
    await refreshGDriveLoras();
  };

  $("gdriveBtn")?.addEventListener("click", openGDriveModal);
  $("civitaiOpenGDriveBtn")?.addEventListener("click", openGDriveModal);
  const handleColabAnchorClick = (e) => {
    if (!(state.colabUrl || "").trim()) {
      e.preventDefault();
      openColabModal(
        "尚未绑定 Colab 直达链接：请点击「同步本地最新版到云盘」自动生成直达链接，或粘贴已有 Colab URL。"
      );
    }
  };
  $("openColabDirectBtn")?.addEventListener("click", handleColabAnchorClick);
  $("colabConfigBtn")?.addEventListener("click", () => openColabModal());
  $("autoConnectColabBtn")?.addEventListener("click", () => autoConnectColab({ silent: false }));
  $("saveColabUrlBtn")?.addEventListener("click", () => saveColabUrl());
  $("colabOpenFromModalBtn")?.addEventListener("click", handleColabAnchorClick);
  $("colabRefreshNbsBtn")?.addEventListener("click", refreshColabNotebooks);
  $("colabSyncNbBtn")?.addEventListener("click", syncColabNotebook);
  $("colabNotebookSelect")?.addEventListener("change", () => {
    const picked = $("colabNotebookSelect").value;
    if (picked) {
      $("colabUrlInput").value = picked;
      saveColabUrl(picked);
    }
  });
  $("colabAutoConnectModalBtn")?.addEventListener("click", () => autoConnectColab({ silent: false }));
  $("colabLaunchWaitBtn")?.addEventListener("click", () =>
    openColabDirect({ mode: "external", forceWait: true })
  );
  $("colabStopWaitBtn")?.addEventListener("click", () => stopColabAutoWait(false));
  $("colabAutoWaitCheck")?.addEventListener("change", saveUiPrefs);
  $("gdriveModeSelect")?.addEventListener("change", syncGDriveModeInputs);
  $("gdriveSaveConfigBtn")?.addEventListener("click", saveGDriveConfig);
  $("gdriveAuthBtn")?.addEventListener("click", startGDriveAuth);
  $("gdriveAuthCancelBtn")?.addEventListener("click", cancelGDriveAuth);
  $("gdriveDisconnectBtn")?.addEventListener("click", disconnectGDrive);
  $("gdriveRefreshLorasBtn")?.addEventListener("click", refreshGDriveLoras);

  $("downloadChannelSelect")?.addEventListener("change", () => {
    state.downloadChannel = $("downloadChannelSelect").value;
    renderCivitaiGrid();
  });

  $("openCivitaiBtn").addEventListener("click", async () => {
    updateBridgeBadge();
    $("civitaiModal").classList.remove("hidden");
    refreshGDriveStatus(false).then((st) => {
      if (st && st.mounted) refreshGDriveLoras();
    });
    if (state.civitaiItems.length === 0) {
      await searchCivitai(true);
    } else {
      renderCivitaiGrid();
    }
  });

  $("toggleCivitaiKeyBtn").addEventListener("click", () => {
    const inp = $("civitaiApiKeyInput");
    const isPwd = inp.type === "password";
    inp.type = isPwd ? "text" : "password";
    $("toggleCivitaiKeyBtn").textContent = isPwd ? "隐藏" : "显示";
  });

  $("saveCivitaiKeyBtn").addEventListener("click", saveCivitaiKey);
  $("civitaiQuickDownloadBtn").addEventListener("click", quickResolveAndDownload);
  $("civitaiQuickUrlInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") quickResolveAndDownload();
  });

  $("civitaiSearchBtn").addEventListener("click", () => searchCivitai(true));
  $("civitaiSearchInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") searchCivitai(true);
  });
  $("civitaiSortSelect").addEventListener("change", () => searchCivitai(true));
  $("civitaiOnlyMossCheck").addEventListener("change", () => searchCivitai(true));
  $("civitaiOnlyR18Check").addEventListener("change", () => searchCivitai(true));
  $("civitaiOnlyAnimeCheck").addEventListener("change", () => searchCivitai(true));

  const scrollWrap = $("civitaiScrollWrap");
  const loadSentinel = $("civitaiLoadState");
  if (scrollWrap && loadSentinel && typeof IntersectionObserver !== "undefined") {
    const observer = new IntersectionObserver(
      (entries) => {
        if (
          entries.some((entry) => entry.isIntersecting) &&
          !$("civitaiModal").classList.contains("hidden")
        ) {
          searchCivitai(false);
        }
      },
      { root: scrollWrap, rootMargin: "220px" }
    );
    observer.observe(loadSentinel);
  }
  if (scrollWrap) {
    scrollWrap.addEventListener(
      "scroll",
      () => {
        if ($("civitaiModal").classList.contains("hidden")) return;
        if (scrollWrap.scrollTop + scrollWrap.clientHeight >= scrollWrap.scrollHeight - 240) {
          searchCivitai(false);
        }
      },
      { passive: true }
    );
  }

  $("openComicBtn")?.addEventListener("click", () => {
    if (window.MossComicEditor) window.MossComicEditor.open();
  });

  if (window.MossComicEditor) {
    const applyComicResult = (promptText, opts = {}) => {
      $("positiveInput").value = promptText;
      renderLoraTriggerBar();
      if (opts.autoSize) {
        setRatioPreset(opts.width || 832, opts.height || 1248);
      }
    };
    window.MossComicEditor.init({
      onApply: (promptText, opts) => applyComicResult(promptText, opts),
      onGenerate: (promptText, opts) => {
        applyComicResult(promptText, opts);
        startGenerate();
      },
    });
  }

  document.querySelectorAll("[data-close]").forEach((el) => {
    el.addEventListener("click", () => {
      const targetId = el.getAttribute("data-close");
      if (targetId) $(targetId).classList.add("hidden");
    });
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  loadUiPrefs();
  bindEvents();
  applyMode("shinobisat");
  renderLoras();
  connectStudioWs();
  await Promise.all([
    loadInitialConfig(),
    loadHistory(),
    loadLoraMeta(),
    loadPresets(),
    loadQueueSnapshot(),
  ]);
});
