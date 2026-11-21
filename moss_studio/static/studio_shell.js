(function () {
  "use strict";

  const INSPECTOR_KEY = "moss_studio_inspector_tab";
  const GALLERY_KEY = "moss_studio_gallery_collapsed";
  const byId = (id) => document.getElementById(id);

  function setInspectorTab(tabName, persist = true) {
    const tabs = Array.from(document.querySelectorAll("[data-inspector-tab]"));
    const panels = Array.from(document.querySelectorAll("[data-inspector-panel]"));
    if (!tabs.length) return;

    const valid = tabs.some((t) => t.getAttribute("data-inspector-tab") === tabName)
      ? tabName
      : "core";

    tabs.forEach((tab) => {
      const active = tab.getAttribute("data-inspector-tab") === valid;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", active ? "true" : "false");
    });

    panels.forEach((panel) => {
      const active = panel.getAttribute("data-inspector-panel") === valid;
      panel.classList.toggle("hidden", !active);
    });

    const img2imgDetails = byId("img2imgDetails");
    if (img2imgDetails) {
      img2imgDetails.open = valid === "img2img";
    }

    if (persist) {
      try {
        localStorage.setItem(INSPECTOR_KEY, valid);
      } catch (_) {}
    }
  }

  function syncLoraBadge() {
    const badge = byId("loraTabBadge");
    const list = byId("loraList");
    if (!badge || !list) return;
    const count = list.querySelectorAll(".lora-item").length;
    badge.textContent = String(count);
    badge.classList.toggle("hidden", count === 0);
  }

  function syncUpscaleDot() {
    const dot = byId("upscaleTabDot");
    const mode = byId("upscaleModeSelect");
    const grain = byId("filmGrainCheck");
    if (!dot || !mode) return;
    const active = mode.value !== "none" || Boolean(grain && grain.checked);
    dot.classList.toggle("hidden", !active);
  }

  function syncImg2ImgDot() {
    const dot = byId("img2imgTabDot");
    const badge = byId("initBadge");
    if (!dot || !badge) return;
    const hasInit = !badge.classList.contains("hidden");
    dot.classList.toggle("hidden", !hasInit);
    return hasInit;
  }

  function positionConnectPopover() {
    const pill = byId("statusPill");
    const pop = byId("connectPopover");
    if (!pill || !pop || pop.classList.contains("hidden")) return;
    const rect = pill.getBoundingClientRect();
    const width = Math.min(360, window.innerWidth - 24);
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
    pop.style.width = `${width}px`;
    pop.style.left = `${left}px`;
    pop.style.top = `${rect.bottom + 8}px`;
  }

  function setConnectPopoverOpen(open) {
    const pill = byId("statusPill");
    const pop = byId("connectPopover");
    if (!pill || !pop) return;
    pop.classList.toggle("hidden", !open);
    pill.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) {
      positionConnectPopover();
      const input = byId("comfyUrlInput");
      if (input) setTimeout(() => input.focus(), 10);
    }
  }

  function syncGalleryToggleState() {
    const root = byId("workspaceRoot");
    const btn = byId("toggleGalleryBtn");
    if (!root || !btn) return;
    const isTablet = window.innerWidth <= 1180 && window.innerWidth > 860;
    const expanded = isTablet
      ? root.classList.contains("gallery-drawer-open")
      : !root.classList.contains("gallery-collapsed");
    btn.classList.toggle("active", expanded);
    btn.setAttribute("aria-pressed", expanded ? "true" : "false");
  }

  function toggleGalleryRail(forceState) {
    const root = byId("workspaceRoot");
    if (!root) return;
    const isTablet = window.innerWidth <= 1180 && window.innerWidth > 860;
    if (isTablet) {
      const next = typeof forceState === "boolean" ? forceState : !root.classList.contains("gallery-drawer-open");
      root.classList.toggle("gallery-drawer-open", next);
    } else {
      const nextCollapsed = typeof forceState === "boolean" ? !forceState : !root.classList.contains("gallery-collapsed");
      root.classList.toggle("gallery-collapsed", nextCollapsed);
      try {
        localStorage.setItem(GALLERY_KEY, nextCollapsed ? "1" : "0");
      } catch (_) {}
    }
    syncGalleryToggleState();
  }

  function syncNegativeButton() {
    const btn = byId("toggleNegPromptBtn");
    const wrap = byId("negativeWrap");
    const input = byId("negativeInput");
    if (!btn || !wrap) return;
    const isOpen = !wrap.classList.contains("hidden");
    const hasText = Boolean(input && input.value.trim());
    btn.setAttribute("aria-expanded", isOpen ? "true" : "false");
    btn.classList.toggle("active", isOpen);
    btn.classList.toggle("has-value", hasText);
  }

  function setMobileView(view) {
    const root = byId("workspaceRoot");
    if (!root) return;
    const valid = ["stage", "inspector", "gallery"].includes(view) ? view : "stage";
    root.setAttribute("data-mobile-active", valid);
    document.querySelectorAll("[data-mobile-view]").forEach((btn) => {
      const active = btn.getAttribute("data-mobile-view") === valid;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    let savedTab = "core";
    try {
      savedTab = localStorage.getItem(INSPECTOR_KEY) || "core";
    } catch (_) {}
    setInspectorTab(savedTab, false);

    try {
      if (localStorage.getItem(GALLERY_KEY) === "1" && byId("workspaceRoot")) {
        byId("workspaceRoot").classList.add("gallery-collapsed");
      }
    } catch (_) {}
    syncGalleryToggleState();

    const tabs = Array.from(document.querySelectorAll("[data-inspector-tab]"));
    tabs.forEach((tab, idx) => {
      tab.addEventListener("click", () => {
        setInspectorTab(tab.getAttribute("data-inspector-tab"));
      });
      tab.addEventListener("keydown", (e) => {
        if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
          e.preventDefault();
          const dir = e.key === "ArrowRight" ? 1 : -1;
          const nextTab = tabs[(idx + dir + tabs.length) % tabs.length];
          setInspectorTab(nextTab.getAttribute("data-inspector-tab"));
          nextTab.focus();
        }
      });
    });

    const loraList = byId("loraList");
    if (loraList) {
      new MutationObserver(syncLoraBadge).observe(loraList, { childList: true });
      syncLoraBadge();
    }

    const initBadge = byId("initBadge");
    if (initBadge) {
      let wasHidden = initBadge.classList.contains("hidden");
      new MutationObserver(() => {
        const hasInit = syncImg2ImgDot();
        if (wasHidden && hasInit) {
          setInspectorTab("img2img");
        }
        wasHidden = !hasInit;
      }).observe(initBadge, { attributes: true, attributeFilter: ["class"] });
      syncImg2ImgDot();
    }

    byId("upscaleModeSelect")?.addEventListener("change", syncUpscaleDot);
    byId("filmGrainCheck")?.addEventListener("change", syncUpscaleDot);
    syncUpscaleDot();

    const statusPill = byId("statusPill");
    const connectPopover = byId("connectPopover");
    if (statusPill && connectPopover) {
      statusPill.addEventListener("click", (e) => {
        e.stopPropagation();
        setConnectPopoverOpen(connectPopover.classList.contains("hidden"));
      });
      byId("closeConnectPopoverBtn")?.addEventListener("click", () => setConnectPopoverOpen(false));
      document.addEventListener("click", (e) => {
        if (
          !connectPopover.classList.contains("hidden") &&
          !connectPopover.contains(e.target) &&
          !statusPill.contains(e.target)
        ) {
          setConnectPopoverOpen(false);
        }
      });
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && !connectPopover.classList.contains("hidden")) {
          setConnectPopoverOpen(false);
        }
      });
      window.addEventListener("resize", () => {
        positionConnectPopover();
        syncGalleryToggleState();
      });

      let prevOnline = statusPill.classList.contains("status-online");
      new MutationObserver(() => {
        const nowOnline = statusPill.classList.contains("status-online");
        if (!prevOnline && nowOnline && !connectPopover.classList.contains("hidden")) {
          setConnectPopoverOpen(false);
        }
        prevOnline = nowOnline;
      }).observe(statusPill, { attributes: true, attributeFilter: ["class"] });
    }

    byId("toggleGalleryBtn")?.addEventListener("click", () => toggleGalleryRail());
    byId("collapseGalleryRailBtn")?.addEventListener("click", () => toggleGalleryRail(false));

    byId("toggleNegPromptBtn")?.addEventListener("click", () => {
      const wrap = byId("negativeWrap");
      if (!wrap) return;
      const open = wrap.classList.contains("hidden");
      wrap.classList.toggle("hidden", !open);
      syncNegativeButton();
      if (open) byId("negativeInput")?.focus();
    });
    byId("negativeInput")?.addEventListener("input", syncNegativeButton);
    syncNegativeButton();

    document.querySelectorAll("[data-mobile-view]").forEach((btn) => {
      btn.addEventListener("click", () => {
        setMobileView(btn.getAttribute("data-mobile-view"));
      });
    });

    const img2imgDetails = byId("img2imgDetails");
    if (img2imgDetails) {
      img2imgDetails.addEventListener("toggle", () => {
        const activeTab = document.querySelector("[data-inspector-tab].active")?.getAttribute("data-inspector-tab");
        if (activeTab === "img2img" && !img2imgDetails.open) {
          img2imgDetails.open = true;
        }
      });
    }

    const galTabs = ["galTabAll", "galTabFav", "galTabTrash"].map(byId).filter(Boolean);
    const syncGalAria = () => {
      galTabs.forEach((t) => {
        t.setAttribute("aria-selected", t.classList.contains("active") ? "true" : "false");
      });
    };
    galTabs.forEach((tab) => {
      tab.addEventListener("click", () => setTimeout(syncGalAria, 0));
    });
    syncGalAria();
  });
})();
