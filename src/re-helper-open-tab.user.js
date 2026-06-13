// ==UserScript==
// @name         RE Helper - Open Tab
// @namespace    https://github.com/poison-cookie/
// @version      0.1.0
// @description  サイト上の図面・PDF・物件詳細リンクを別タブで開きやすくする業務補助ツール
// @match        http://*/*
// @match        https://*/*
// @match        file:///*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_openInTab
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const SCRIPT_PREFIX = "reHelperOpenTab";
  const SETTINGS_KEY = `${SCRIPT_PREFIX}:settings`;
  const SITE_SETTINGS_KEY = `${SCRIPT_PREFIX}:siteSettings`;
  const ENABLED_HOSTS_KEY = `${SCRIPT_PREFIX}:enabledHosts`;
  const PANEL_COLLAPSED_KEY = `${SCRIPT_PREFIX}:panelCollapsed`;

  const PANEL_CLASS = "re-helper-open-tab-panel";
  const BUTTON_CLASS = "re-helper-open-tab-button";
  const PROCESSED_ATTR = "data-re-helper-open-tab-processed";
  const BUTTON_ADDED_ATTR = "data-re-helper-open-tab-button-added";
  const CLICK_HANDLER_ADDED_ATTR = "data-re-helper-open-tab-click-handler-added";
  const RESERVED_TARGETS = new Set(["_blank", "_self", "_top", "_parent"]);
  const FIXED_WINDOW_TARGETS = new Set([
    "zumen",
    "preview",
    "pdf",
    "print",
    "detail",
    "window",
    "sub",
  ]);

  const DRAWING_KEYWORDS = [
    "図面",
    "募集図面",
    "間取",
    "間取り",
    "間取図",
    "間取り図",
    "物件資料",
    "販売図面",
    "マイソク",
    "チラシ",
  ];

  const DETAIL_KEYWORDS = [
    "詳細",
    "物件詳細",
    "部屋詳細",
    "号室詳細",
    "詳しく見る",
    "詳細を見る",
  ];

  const DEFAULT_SETTINGS = {
    normalLinks: true,
    drawingLinks: true,
    pdfLinks: true,
    detailLinks: true,
    imageLinks: false,
    jsLinkButtons: true,
    forceWindowOpenUnique: false,
    focusNewTabs: false,
    addOpenButtons: true,
  };

  const DEFAULT_SITE_SETTINGS = {
    enabled: false,
    targetSelectors: [],
    excludeSelectors: [],
  };

  const currentHost = location.hostname || "local-file";
  const processedElements = new WeakSet();
  let observer = null;
  let observerTimer = 0;
  let windowOpenPatched = false;
  let originalWindowOpen = window.open;
  let panel = null;

  function gmGet(key, fallbackValue) {
    try {
      if (typeof GM_getValue === "function") {
        return GM_getValue(key, fallbackValue);
      }
    } catch (error) {
      // Fall through to localStorage.
    }

    try {
      const rawValue = localStorage.getItem(key);
      return rawValue ? JSON.parse(rawValue) : fallbackValue;
    } catch (error) {
      return fallbackValue;
    }
  }

  function gmSet(key, value) {
    try {
      if (typeof GM_setValue === "function") {
        GM_setValue(key, value);
        return;
      }
    } catch (error) {
      // Fall through to localStorage.
    }

    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      // Ignore storage failures.
    }
  }

  function normalizeSelectorList(value) {
    if (Array.isArray(value)) {
      return value.map((item) => String(item).trim()).filter(Boolean);
    }

    if (typeof value === "string") {
      return value
        .split(/\r?\n|,/)
        .map((item) => item.trim())
        .filter(Boolean);
    }

    return [];
  }

  function getEnabledHosts() {
    const enabledHosts = gmGet(ENABLED_HOSTS_KEY, []);
    return Array.isArray(enabledHosts) ? enabledHosts : [];
  }

  function setHostEnabled(host, enabled) {
    const enabledHosts = new Set(getEnabledHosts());

    if (enabled) {
      enabledHosts.add(host);
    } else {
      enabledHosts.delete(host);
    }

    gmSet(ENABLED_HOSTS_KEY, Array.from(enabledHosts));

    const siteSettings = getAllSiteSettings();
    siteSettings[host] = {
      ...DEFAULT_SITE_SETTINGS,
      ...siteSettings[host],
      enabled,
    };
    gmSet(SITE_SETTINGS_KEY, siteSettings);
  }

  function removeHostEnabled(host) {
    const enabledHosts = new Set(getEnabledHosts());
    enabledHosts.delete(host);
    gmSet(ENABLED_HOSTS_KEY, Array.from(enabledHosts));
  }

  function getAllSiteSettings() {
    const siteSettings = gmGet(SITE_SETTINGS_KEY, {});
    return siteSettings && typeof siteSettings === "object" && !Array.isArray(siteSettings)
      ? siteSettings
      : {};
  }

  function getGlobalSettings() {
    const savedSettings = gmGet(SETTINGS_KEY, {});
    return {
      ...DEFAULT_SETTINGS,
      ...(savedSettings && typeof savedSettings === "object" ? savedSettings : {}),
    };
  }

  function getCurrentSiteSettings() {
    const siteSettings = getAllSiteSettings()[currentHost] || {};
    return {
      ...DEFAULT_SITE_SETTINGS,
      ...siteSettings,
      targetSelectors: normalizeSelectorList(siteSettings.targetSelectors),
      excludeSelectors: normalizeSelectorList(siteSettings.excludeSelectors),
    };
  }

  function getEffectiveSettings() {
    const globalSettings = getGlobalSettings();
    const siteSettings = getCurrentSiteSettings();
    const enabled =
      getEnabledHosts().includes(currentHost) ||
      siteSettings.enabled === true;

    return {
      ...globalSettings,
      ...siteSettings,
      enabled,
    };
  }

  function saveCurrentSiteSettings(partialSettings) {
    const allSiteSettings = getAllSiteSettings();
    const previousSettings = allSiteSettings[currentHost] || {};

    allSiteSettings[currentHost] = {
      ...DEFAULT_SITE_SETTINGS,
      ...previousSettings,
      ...partialSettings,
      targetSelectors: normalizeSelectorList(partialSettings.targetSelectors ?? previousSettings.targetSelectors),
      excludeSelectors: normalizeSelectorList(partialSettings.excludeSelectors ?? previousSettings.excludeSelectors),
    };

    gmSet(SITE_SETTINGS_KEY, allSiteSettings);

    if (Object.prototype.hasOwnProperty.call(partialSettings, "enabled")) {
      setHostEnabled(currentHost, partialSettings.enabled === true);
    }
  }

  function createUniqueTargetName() {
    return `re_helper_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  }

  function normalizeTargetName(target) {
    return typeof target === "string" ? target.trim().toLowerCase() : "";
  }

  function isNamedBrowsingTarget(target) {
    const normalizedTarget = normalizeTargetName(target);
    return Boolean(normalizedTarget) && !RESERVED_TARGETS.has(normalizedTarget);
  }

  function shouldRewriteWindowTarget(target) {
    if (!target || typeof target !== "string") {
      return true;
    }

    const normalizedTarget = normalizeTargetName(target);
    return !RESERVED_TARGETS.has(normalizedTarget) && FIXED_WINDOW_TARGETS.has(normalizedTarget);
  }

  function patchWindowOpenIfNeeded(settings) {
    if (windowOpenPatched || !settings.enabled || !settings.forceWindowOpenUnique) {
      return;
    }

    originalWindowOpen = window.open;
    window.open = function (url, target, features) {
      const safeTarget = shouldRewriteWindowTarget(target)
        ? createUniqueTargetName()
        : target;

      return originalWindowOpen.call(window, url, safeTarget || "_blank", features);
    };

    windowOpenPatched = true;
  }

  function getElementHaystack(element) {
    const text = element.textContent || element.value || "";
    const href = element.getAttribute("href") || "";
    const title = element.getAttribute("title") || "";
    const ariaLabel = element.getAttribute("aria-label") || "";
    const onclick = element.getAttribute("onclick") || "";

    return `${text} ${href} ${title} ${ariaLabel} ${onclick}`;
  }

  function isPdfLike(value) {
    return /\.pdf(?:\?|#|$)/i.test(value) || /\bpdf\b/i.test(value);
  }

  function isImageLike(value) {
    return /\.(jpg|jpeg|png|webp|gif)(?:\?|#|$)/i.test(value);
  }

  function isPlainNavigableLink(element) {
    if (!element || element.tagName !== "A") {
      return false;
    }

    if (isJavaScriptLink(element) || element.hasAttribute("download")) {
      return false;
    }

    const href = (element.getAttribute("href") || "").trim();
    if (!href || href.startsWith("#") || /^(mailto|tel):/i.test(href)) {
      return false;
    }

    const target = normalizeTargetName(element.getAttribute("target") || "");
    if (target && target !== "_self" && target !== "_blank" && !isNamedBrowsingTarget(target)) {
      return false;
    }

    return Boolean(toAbsoluteUrl(href));
  }

  function isDetailLike(value) {
    return (
      DETAIL_KEYWORDS.some((keyword) => value.includes(keyword)) ||
      /\/(detail|property|room|bukken)(?:\/|[?#]|$)/i.test(value)
    );
  }

  function isDrawingLike(value) {
    return DRAWING_KEYWORDS.some((keyword) => value.includes(keyword));
  }

  function shouldOpenInNewTab(element, settings) {
    const haystack = getElementHaystack(element);

    if (settings.jsLinkButtons && isJavaScriptLink(element) && getElementUrl(element)) {
      return true;
    }

    if (settings.normalLinks && isPlainNavigableLink(element)) {
      return true;
    }

    if (settings.drawingLinks && isDrawingLike(haystack)) {
      return true;
    }

    if (settings.pdfLinks && isPdfLike(haystack)) {
      return true;
    }

    if (settings.detailLinks && isDetailLike(haystack)) {
      return true;
    }

    return Boolean(settings.imageLinks && isImageLike(haystack));
  }

  function isJavaScriptLink(element) {
    const href = element.getAttribute("href") || "";
    const onclick = element.getAttribute("onclick") || "";

    return /^javascript:/i.test(href.trim()) || onclick.trim().length > 0;
  }

  function toAbsoluteUrl(url) {
    try {
      return new URL(url, location.href).href;
    } catch (error) {
      return "";
    }
  }

  function extractUrlFromOnclick(onclick) {
    const match = onclick.match(
      /['"]([^'"]+\.(?:pdf|jpg|jpeg|png|webp|gif)(?:\?[^'"]*)?)['"]/i,
    );
    return match ? match[1] : "";
  }

  function getElementUrl(element) {
    if (element.tagName === "A") {
      const href = element.getAttribute("href") || "";
      const trimmedHref = href.trim();

      if (trimmedHref && !/^javascript:/i.test(trimmedHref) && !trimmedHref.startsWith("#")) {
        return toAbsoluteUrl(element.href || href);
      }
    }

    const onclickUrl = extractUrlFromOnclick(element.getAttribute("onclick") || "");
    return onclickUrl ? toAbsoluteUrl(onclickUrl) : "";
  }

  function openUrlInNewTab(url) {
    if (!url) {
      return false;
    }

    const settings = getEffectiveSettings();
    const focusNewTab = settings.focusNewTabs === true;

    if (typeof GM_openInTab === "function") {
      try {
        GM_openInTab(url, {
          active: focusNewTab,
          insert: true,
          setParent: true,
        });
        return true;
      } catch (error) {
        try {
          GM_openInTab(url, !focusNewTab);
          return true;
        } catch (innerError) {
          // Fall through to window.open.
        }
      }
    }

    if (typeof GM !== "undefined" && typeof GM.openInTab === "function") {
      try {
        GM.openInTab(url, {
          active: focusNewTab,
          insert: true,
          setParent: true,
        });
        return true;
      } catch (error) {
        // Fall through to window.open.
      }
    }

    const openedWindow = window.open(url, createUniqueTargetName(), "noopener,noreferrer");
    if (!focusNewTab) {
      try {
        openedWindow?.blur?.();
        window.focus();
      } catch (error) {
        // Browser focus policy may block this fallback.
      }
    }
    return true;
  }

  function makeAnchorOpenInSeparateTab(element) {
    if (element.getAttribute(CLICK_HANDLER_ADDED_ATTR) === "true") {
      return;
    }

    if (isNamedBrowsingTarget(element.getAttribute("target") || "")) {
      element.setAttribute("target", createUniqueTargetName());
    } else {
      element.removeAttribute("target");
    }

    element.setAttribute("rel", "noopener noreferrer");
    element.addEventListener("click", (event) => {
      const url = getElementUrl(element);
      if (!url) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      if (isNamedBrowsingTarget(element.getAttribute("target") || "")) {
        element.setAttribute("target", createUniqueTargetName());
      }

      if (!openUrlInNewTab(url)) {
        location.href = url;
        return;
      }
    }, true);

    element.setAttribute(CLICK_HANDLER_ADDED_ATTR, "true");
  }

  function makeClickOpenInSeparateTab(element) {
    if (element.getAttribute(CLICK_HANDLER_ADDED_ATTR) === "true") {
      return;
    }

    element.addEventListener("click", (event) => {
      const url = getElementUrl(element);
      if (!url) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      openUrlInNewTab(url);
    }, true);

    element.setAttribute(CLICK_HANDLER_ADDED_ATTR, "true");
  }

  function withTemporaryWindowOpenPatch(callback) {
    const previousOpen = window.open;

    window.open = function (url, target, features) {
      const safeTarget = shouldRewriteWindowTarget(target)
        ? createUniqueTargetName()
        : target;

      return previousOpen.call(window, url, safeTarget || "_blank", features);
    };

    try {
      callback();
    } finally {
      if (!windowOpenPatched) {
        window.open = previousOpen;
      }
    }
  }

  function shouldExcludeElement(element, settings) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) {
      return true;
    }

    if (
      element.closest(
        `script, style, noscript, iframe, textarea, select, option, code, pre, [contenteditable="true"], .${PANEL_CLASS}, .${BUTTON_CLASS}, [class*="re-helper-"]`,
      )
    ) {
      return true;
    }

    return settings.excludeSelectors.some((selector) => {
      try {
        return Boolean(element.closest(selector));
      } catch (error) {
        return false;
      }
    });
  }

  function addOpenButton(element, settings) {
    if (
      element.getAttribute(BUTTON_ADDED_ATTR) === "true" ||
      !settings.addOpenButtons ||
      !settings.jsLinkButtons
    ) {
      return;
    }

    if (element.nextElementSibling?.classList.contains(BUTTON_CLASS)) {
      element.setAttribute(BUTTON_ADDED_ATTR, "true");
      return;
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = BUTTON_CLASS;
    button.textContent = "別タブ";
    button.title = "別タブで開く";

    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();

      const url = getElementUrl(element);
      if (openUrlInNewTab(url)) {
        return;
      }

      try {
        withTemporaryWindowOpenPatch(() => {
          element.click();
        });
      } catch (error) {
        try {
          element.click();
        } catch (innerError) {
          // Ignore click failures.
        }
      }
    });

    element.insertAdjacentElement("afterend", button);
    element.setAttribute(BUTTON_ADDED_ATTR, "true");
  }

  function removeOpenButton(element) {
    if (element.nextElementSibling?.classList.contains(BUTTON_CLASS)) {
      element.nextElementSibling.remove();
    }

    element.removeAttribute(BUTTON_ADDED_ATTR);
  }

  function processElement(element, settings) {
    if (shouldExcludeElement(element, settings)) {
      return;
    }

    if (!settings.addOpenButtons || !settings.jsLinkButtons) {
      removeOpenButton(element);
    }

    const matchesTarget =
      element.matches("a, button, input[type='button'], input[type='submit']") &&
      shouldOpenInNewTab(element, settings);

    if (!matchesTarget) {
      removeOpenButton(element);
      return;
    }

    if (element.tagName === "A" && !isJavaScriptLink(element)) {
      makeAnchorOpenInSeparateTab(element);
    }

    if (isJavaScriptLink(element) && getElementUrl(element)) {
      makeClickOpenInSeparateTab(element);
    }

    if (element.tagName !== "A" || isJavaScriptLink(element)) {
      addOpenButton(element, settings);
    }

    element.setAttribute(PROCESSED_ATTR, "true");
  }

  function getProcessingRoots(settings, root) {
    const baseRoot = root && root.nodeType === Node.ELEMENT_NODE ? root : document.body;

    if (!settings.targetSelectors.length) {
      return [baseRoot];
    }

    return settings.targetSelectors.flatMap((selector) => {
      try {
        const matches = [];

        if (baseRoot.matches?.(selector)) {
          matches.push(baseRoot);
        } else if (baseRoot.closest?.(selector)) {
          matches.push(baseRoot);
        }

        matches.push(...baseRoot.querySelectorAll(selector));
        return matches;
      } catch (error) {
        return [];
      }
    });
  }

  function scan(root) {
    const settings = getEffectiveSettings();

    patchWindowOpenIfNeeded(settings);

    if (!settings.enabled || !document.body) {
      return;
    }

    const roots = getProcessingRoots(settings, root);
    roots.forEach((processingRoot) => {
      if (processingRoot.matches?.("a, button, input[type='button'], input[type='submit']")) {
        processElement(processingRoot, settings);
      }

      processingRoot
        .querySelectorAll("a, button, input[type='button'], input[type='submit']")
        .forEach((element) => processElement(element, settings));
    });
  }

  function scheduleScan(root) {
    window.clearTimeout(observerTimer);
    observerTimer = window.setTimeout(() => scan(root), 100);
  }

  function startObserver() {
    if (observer || !document.body) {
      return;
    }

    observer = new MutationObserver((mutations) => {
      const addedElement = mutations
        .flatMap((mutation) => Array.from(mutation.addedNodes))
        .find((node) => node.nodeType === Node.ELEMENT_NODE);

      if (addedElement) {
        scheduleScan(addedElement);
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  function injectStyles() {
    if (document.getElementById(`${SCRIPT_PREFIX}-styles`)) {
      return;
    }

    const style = document.createElement("style");
    style.id = `${SCRIPT_PREFIX}-styles`;
    style.textContent = `
      .${PANEL_CLASS} {
        position: fixed;
        right: 14px;
        bottom: 14px;
        z-index: 2147483647;
        width: 300px;
        max-width: calc(100vw - 28px);
        max-height: calc(100vh - 28px);
        overflow: auto;
        box-sizing: border-box;
        border: 1px solid #94a3b8;
        border-radius: 8px;
        background: #ffffff;
        color: #0f172a;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-size: 12px;
        line-height: 1.35;
        box-shadow: 0 8px 24px rgba(15, 23, 42, 0.18);
      }
      .${PANEL_CLASS} * {
        box-sizing: border-box;
      }
      .${PANEL_CLASS} header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 8px 10px;
        border-bottom: 1px solid #e2e8f0;
        font-weight: 700;
      }
      .${PANEL_CLASS} .re-hot-title {
        display: grid;
        gap: 1px;
        min-width: 0;
      }
      .${PANEL_CLASS} .re-hot-title-main {
        font-size: 13px;
        line-height: 1.2;
      }
      .${PANEL_CLASS} .re-hot-title-sub {
        max-width: 190px;
        overflow: hidden;
        color: #64748b;
        font-size: 11px;
        font-weight: 500;
        line-height: 1.2;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .${PANEL_CLASS} header button,
      .${PANEL_CLASS} .re-hot-actions button {
        border: 1px solid #cbd5e1;
        border-radius: 4px;
        background: #f8fafc;
        color: #0f172a;
        cursor: pointer;
        font-size: 12px;
        padding: 4px 8px;
      }
      .${PANEL_CLASS} .re-hot-body {
        padding: 8px 10px 10px;
      }
      .${PANEL_CLASS} label {
        display: flex;
        align-items: flex-start;
        gap: 7px;
        margin: 4px 0;
      }
      .${PANEL_CLASS} input[type="checkbox"] {
        margin-top: 2px;
      }
      .${PANEL_CLASS} textarea {
        width: 100%;
        min-height: 46px;
        resize: vertical;
        border: 1px solid #cbd5e1;
        border-radius: 6px;
        padding: 5px 7px;
        font: inherit;
      }
      .${PANEL_CLASS} .re-hot-section {
        margin-top: 8px;
        padding-top: 8px;
        border-top: 1px solid #e2e8f0;
      }
      .${PANEL_CLASS} .re-hot-section-title {
        margin-bottom: 4px;
        color: #334155;
        font-weight: 700;
      }
      .${PANEL_CLASS} .re-hot-note {
        margin: 2px 0 6px;
        color: #64748b;
        font-size: 11px;
      }
      .${PANEL_CLASS} .re-hot-check-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        column-gap: 10px;
      }
      .${PANEL_CLASS} .re-hot-check-grid label {
        min-width: 0;
      }
      .${PANEL_CLASS} details.re-hot-section {
        display: block;
      }
      .${PANEL_CLASS} details.re-hot-section > summary {
        cursor: pointer;
        color: #334155;
        font-weight: 700;
        list-style-position: inside;
      }
      .${PANEL_CLASS} .re-hot-actions {
        display: flex;
        justify-content: flex-end;
        gap: 6px;
        margin-top: 8px;
      }
      .${PANEL_CLASS}.is-collapsed {
        width: auto;
      }
      .${PANEL_CLASS}.is-collapsed .re-hot-body {
        display: none;
      }
      .${PANEL_CLASS}.is-collapsed .re-hot-title-sub {
        display: none;
      }
      .${BUTTON_CLASS} {
        margin-left: 4px;
        padding: 2px 6px;
        border: 1px solid #0284c7;
        border-radius: 4px;
        background: #e0f2fe;
        color: #0369a1;
        font-size: 11px;
        line-height: 1.3;
        cursor: pointer;
      }
    `;

    document.head.appendChild(style);
  }

  function createCheckbox(name, labelText, checked) {
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.name = name;
    checkbox.checked = Boolean(checked);
    label.append(checkbox, document.createTextNode(labelText));
    return label;
  }

  function createSection(titleText) {
    const section = document.createElement("div");
    section.className = "re-hot-section";

    const title = document.createElement("div");
    title.className = "re-hot-section-title";
    title.textContent = titleText;
    section.appendChild(title);

    return section;
  }

  function createDetailsSection(titleText, open = false) {
    const details = document.createElement("details");
    details.className = "re-hot-section";
    details.open = Boolean(open);

    const summary = document.createElement("summary");
    summary.textContent = titleText;
    details.appendChild(summary);

    return details;
  }

  function appendNote(parent, text) {
    const note = document.createElement("div");
    note.className = "re-hot-note";
    note.textContent = text;
    parent.appendChild(note);
  }

  function renderPanel() {
    injectStyles();

    if (panel) {
      panel.remove();
    }

    const settings = getEffectiveSettings();
    if (!settings.enabled) {
      panel = null;
      return;
    }

    const collapsed = Boolean(gmGet(PANEL_COLLAPSED_KEY, true));

    panel = document.createElement("aside");
    panel.className = `${PANEL_CLASS}${collapsed ? " is-collapsed" : ""}`;

    const header = document.createElement("header");
    const title = document.createElement("span");
    title.className = "re-hot-title";
    const titleMain = document.createElement("span");
    titleMain.className = "re-hot-title-main";
    titleMain.textContent = "別タブで開く";
    const titleSub = document.createElement("span");
    titleSub.className = "re-hot-title-sub";
    titleSub.textContent = currentHost;
    title.append(titleMain, titleSub);

    const collapseButton = document.createElement("button");
    collapseButton.type = "button";
    collapseButton.textContent = collapsed ? "開く" : "閉じる";
    collapseButton.addEventListener("click", () => {
      gmSet(PANEL_COLLAPSED_KEY, !panel.classList.contains("is-collapsed"));
      renderPanel();
    });

    header.append(title, collapseButton);

    const body = document.createElement("div");
    body.className = "re-hot-body";

    body.appendChild(createCheckbox("enabled", "このページで有効にする", settings.enabled));

    const targetSection = createSection("別タブ化するリンク");
    appendNote(targetSection, "チェックした種類のリンクを、現在のタブを残して開きます。");
    const targetGrid = document.createElement("div");
    targetGrid.className = "re-hot-check-grid";
    [
      ["normalLinks", "通常リンク"],
      ["drawingLinks", "図面っぽいリンク"],
      ["pdfLinks", "PDFリンク"],
      ["detailLinks", "物件詳細リンク"],
      ["imageLinks", "画像リンク"],
      ["jsLinkButtons", "JavaScriptで開くリンク"],
    ].forEach(([name, label]) => {
      targetGrid.appendChild(createCheckbox(name, label, settings[name]));
    });
    targetSection.appendChild(targetGrid);

    const patchSection = createDetailsSection("開き方の補正");
    appendNote(patchSection, "連続確認しやすいように、同じタブ名への上書きを避けます。");
    const patchGrid = document.createElement("div");
    patchGrid.className = "re-hot-check-grid";
    [
      ["forceWindowOpenUnique", "window.open の固定タブ名を毎回変える"],
      ["focusNewTabs", "開いたタブへ移動する"],
      ["addOpenButtons", "JSリンクの横に「別タブ」ボタンを出す"],
    ].forEach(([name, label]) => {
      patchGrid.appendChild(createCheckbox(name, label, settings[name]));
    });
    patchSection.appendChild(patchGrid);

    const selectorSection = createDetailsSection("処理する範囲");
    appendNote(selectorSection, "空欄ならページ全体を対象にします。CSSセレクタを1行ずつ指定できます。");
    const targetLabel = document.createElement("label");
    targetLabel.style.display = "block";
    targetLabel.textContent = "対象にする場所";
    const targetTextarea = document.createElement("textarea");
    targetTextarea.name = "targetSelectors";
    targetTextarea.placeholder = ".search-result\n#main";
    targetTextarea.value = settings.targetSelectors.join("\n");
    targetLabel.appendChild(targetTextarea);

    const excludeLabel = document.createElement("label");
    excludeLabel.style.display = "block";
    excludeLabel.textContent = "除外する場所";
    const excludeTextarea = document.createElement("textarea");
    excludeTextarea.name = "excludeSelectors";
    excludeTextarea.placeholder = ".header\n.footer";
    excludeTextarea.value = settings.excludeSelectors.join("\n");
    excludeLabel.appendChild(excludeTextarea);
    selectorSection.append(targetLabel, excludeLabel);

    const actions = document.createElement("div");
    actions.className = "re-hot-actions";

    const resetButton = document.createElement("button");
    resetButton.type = "button";
    resetButton.textContent = "このページの設定をリセット";
    resetButton.addEventListener("click", () => {
      const allSiteSettings = getAllSiteSettings();
      delete allSiteSettings[currentHost];
      gmSet(SITE_SETTINGS_KEY, allSiteSettings);
      removeHostEnabled(currentHost);
      renderPanel();
    });

    actions.append(resetButton);
    body.append(targetSection, patchSection, selectorSection, actions);
    panel.append(header, body);
    document.body.appendChild(panel);
    bindInstantSettings(body);
  }

  function readPanelValues(root) {
    const values = {};

    root.querySelectorAll("input[type='checkbox']").forEach((input) => {
      values[input.name] = input.checked;
    });

    values.targetSelectors = normalizeSelectorList(
      root.querySelector("textarea[name='targetSelectors']")?.value || "",
    );
    values.excludeSelectors = normalizeSelectorList(
      root.querySelector("textarea[name='excludeSelectors']")?.value || "",
    );

    return values;
  }

  function applyPanelValues(root, options = {}) {
    saveCurrentSiteSettings(readPanelValues(root));

    if (options.render) {
      renderPanel();
    }

    scan(document.body);
  }

  function bindInstantSettings(root) {
    let inputTimer = 0;

    root.addEventListener("change", (event) => {
      if (event.target instanceof HTMLInputElement) {
        applyPanelValues(root, { render: event.target.name === "enabled" });
      }
    });

    root.addEventListener("input", (event) => {
      if (!(event.target instanceof HTMLTextAreaElement)) {
        return;
      }

      window.clearTimeout(inputTimer);
      inputTimer = window.setTimeout(() => {
        applyPanelValues(root);
      }, 250);
    });
  }

  function registerMenus() {
    if (typeof GM_registerMenuCommand !== "function") {
      return;
    }

    GM_registerMenuCommand("このサイトでON/OFF切り替え", () => {
      const settings = getEffectiveSettings();
      setHostEnabled(currentHost, !settings.enabled);
      renderPanel();
      scan(document.body);
    });

    GM_registerMenuCommand("RE Open Tab 設定リセット", () => {
      const allSiteSettings = getAllSiteSettings();
      delete allSiteSettings[currentHost];
      gmSet(SITE_SETTINGS_KEY, allSiteSettings);
      removeHostEnabled(currentHost);
      renderPanel();
    });
  }

  function init() {
    if (!document.body) {
      window.setTimeout(init, 50);
      return;
    }

    registerMenus();
    renderPanel();
    scan(document.body);
    startObserver();
  }

  init();
})();
