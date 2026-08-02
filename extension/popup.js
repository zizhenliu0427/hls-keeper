const CANDIDATES_KEY = "wkCandidates";
const JOBS_KEY = "wkJobs";
const $ = (id) => document.getElementById(id);
const { t } = WebKeeperI18n;
let currentTabId = null;
let currentWindowId = null;
let candidateIndex = new Map();
let preferredMethod = "ask";
let defaultQuality = "highest";
let lastQualityBySite = {};
let siteRules = {};

function setMessage(text) { $("message").textContent = text; }

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function displayTitle(value, fallback = "Video") {
  const compact = String(value || fallback).replace(/\s+/g, " ").trim();
  return compact.length > 90 ? `${compact.slice(0, 87)}…` : compact;
}

async function openExtensionPage(path) {
  const fallbackUrl = chrome.runtime.getURL(path);
  const opened = window.open(fallbackUrl, "_blank");
  if (opened) {
    try { opened.opener = null; } catch { /* already isolated */ }
    return;
  }
  try {
    const response = await chrome.runtime.sendMessage({ type: "open-extension-page", path, windowId: currentWindowId });
    if (response?.ok) return;
    throw new Error(response?.error || "Unable to open extension page");
  } catch {
    location.href = fallbackUrl;
  }
}

async function loadSettings() {
  const settings = await chrome.storage.local.get({ discover: true, enabled: false, preferredMethod: "ask", defaultQuality: "highest", lastQualityBySite: {}, siteRules: {} });
  preferredMethod = settings.preferredMethod;
  defaultQuality = settings.defaultQuality;
  lastQualityBySite = settings.lastQualityBySite || {};
  siteRules = settings.siteRules || {};
  if (settings.enabled) await chrome.storage.local.set({ enabled: false, discover: true });
  $("discover").checked = Boolean(settings.discover);
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tabs[0]?.id ?? null;
  currentWindowId = tabs[0]?.windowId ?? null;
  await chrome.action.setBadgeText({ text: "" });
  await chrome.action.setTitle({ title: "Web Keeper" });
}

function visibleCandidates(candidates) {
  const now = Date.now();
  const recent = candidates.filter((item) => now - Number(item.lastSeen || 0) < 30 * 60 * 1000 && !(item.decision === "ignored" && Number(item.ignoredUntil || 0) > now));
  const current = recent.filter((item) => Number(item.tabId) === Number(currentTabId));
  return current.length ? current : recent.slice(0, 12);
}

function groupWorks(candidates) {
  const grouped = new Map();
  for (const item of visibleCandidates(candidates)) {
    candidateIndex.set(item.id, item);
    const key = `${item.tabId}:${item.product}`;
    if (!grouped.has(key)) grouped.set(key, { product: item.product, title: item.pageTitle, variants: [], subtitles: new Set() });
    const work = grouped.get(key);
    work.variants.push(item);
    for (const subtitle of item.subtitles || []) work.subtitles.add(subtitle);
  }
  for (const work of grouped.values()) {
    work.variants.sort((a, b) => {
      const ah = Number(String(a.resolution).match(/\d+x(\d+)/)?.[1] || String(a.resolution).match(/(\d+)p/)?.[1] || 0);
      const bh = Number(String(b.resolution).match(/\d+x(\d+)/)?.[1] || String(b.resolution).match(/(\d+)p/)?.[1] || 0);
      return bh - ah;
    });
  }
  return [...grouped.values()];
}

function renderWorks(candidates) {
  candidateIndex = new Map();
  const works = groupWorks(candidates);
  $("workCount").textContent = t("videosCount", works.length, `${works.length} 个`);
  if (!works.length) {
    $("works").innerHTML = `<div class="muted">${escapeHtml($("discover").checked ? t("noVideosListening", null, "正在监听。播放视频后，这里会出现保存选项。") : t("noVideosOff", null, "开启监听后即可发现视频。"))}</div>`;
    return works;
  }
  $("works").innerHTML = works.map((work) => {
    const decided = work.variants.find((item) => ["direct", "browser-assisted", "ignored"].includes(item.decision));
    let selected = decided || work.variants[0];
    let site = "";
    try { site = new URL(work.variants[0].pageUrl).hostname; } catch { /* no site rule */ }
    const siteRule = siteRules[site] || null;
    if (!decided && defaultQuality === "last") {
      try {
        selected = work.variants.find((item) => item.resolution === lastQualityBySite[site]) || selected;
      } catch { /* use highest */ }
    }
    if (!decided && siteRule?.quality) selected = work.variants.find((item) => item.resolution === siteRule.quality) || selected;
    const recommended = siteRule?.mode || preferredMethod;
    const options = work.variants.map((variant) => `<option value="${escapeHtml(variant.id)}" ${variant.id === selected.id ? "selected" : ""}>${escapeHtml(variant.resolution || "auto")}</option>`).join("");
    let controls = `<div class="actions">
      <button class="${recommended === "browser-assisted" ? "" : "primary"}" data-action="direct">${escapeHtml(t("directDownload", null, "直接下载（推荐）"))}</button>
      <button class="${recommended === "browser-assisted" ? "primary" : ""}" data-action="browser-assisted">${escapeHtml(t("browserAssisted", null, "网页辅助保存"))}</button>
      <button class="wide" data-action="ignore">${escapeHtml(t("ignoreThisTime", null, "本次忽略"))}</button></div>
      <label class="remember"><input type="checkbox" data-role="remember-site">${escapeHtml(t("rememberForSite", null, "记住这个网站的推荐方式和清晰度"))}</label>
      ${work.variants.length > 1 ? `<label class="remember"><input type="checkbox" data-role="multiple-qualities">${escapeHtml(t("downloadMultipleQualities", null, "同时保存所有已发现清晰度（高级）"))}</label>` : ""}`;
    if (decided?.decision === "direct" || decided?.decision === "browser-assisted") {
      controls = `<div class="detail">${escapeHtml(decided.decision === "direct" ? t("directTaskCreated", null, "已创建直接下载任务。") : t("assistedTaskCreated", null, "已创建网页辅助任务，请保持下载页面开启并继续播放。"))}</div>
        <div class="actions"><a class="button primary" target="_blank" href="download.html?candidate=${encodeURIComponent(decided.id)}&mode=${encodeURIComponent(decided.decision)}">${escapeHtml(t("openTask", null, "查看下载"))}</a><button data-action="reset">${escapeHtml(t("chooseAgain", null, "重新选择"))}</button></div>`;
    } else if (decided?.decision === "ignored") {
      controls = `<div class="detail">${escapeHtml(t("ignoredThisTime", null, "本次已忽略，不会下载。"))}</div><button class="link" data-action="reset">${escapeHtml(t("chooseAgain", null, "重新选择"))}</button>`;
    }
    const subtitleText = work.subtitles.size ? t("subtitlesFound", work.subtitles.size, `发现 ${work.subtitles.size} 条字幕`) : t("subtitlesNotFound", null, "暂未发现字幕");
    return `<article class="work" data-product="${escapeHtml(work.product)}">
      <div class="row between"><div class="work-name" title="${escapeHtml(work.title || work.product)}">${escapeHtml(displayTitle(work.title, work.product))}</div>
      <select data-role="candidate" aria-label="quality" ${decided ? "disabled" : ""}>${options}</select></div>
      <div class="detail">${escapeHtml(t("qualityCount", work.variants.length, `${work.variants.length} 个清晰度`))} · ${escapeHtml(subtitleText)}</div>
      ${controls}</article>`;
  }).join("");
  return works;
}

function renderJobs(jobs) {
  const sorted = [...jobs].sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  const active = sorted.filter((job) => !["complete", "cancelled"].includes(job.status));
  const shown = (active.length ? active : sorted).slice(0, 3);
  const running = shown.filter((job) => ["downloading", "capturing"].includes(job.status));
  const speed = running.reduce((sum, job) => sum + Number(job.speedMbps || 0), 0);
  $("speed").textContent = running.length ? `${speed.toFixed(2)} MB/s` : "";
  if (!shown.length) {
    $("jobs").innerHTML = `<div class="muted">${escapeHtml(t("noTasks", null, "目前没有下载。"))}</div>`;
    return;
  }
  const labels = {
    ready: t("waitingForFolder", null, "等待选择保存位置"), downloading: t("downloading", null, "正在下载"),
    capturing: t("followingPlayback", null, "正在跟随网页播放"), paused: t("paused", null, "已暂停"),
    waiting: t("waitingForPlayback", null, "等待网页继续播放"), merging: t("creatingVideo", null, "正在生成视频"),
    complete: t("complete", null, "已完成"), error: t("needsAttention", null, "需要处理")
  };
  $("jobs").innerHTML = shown.map((job) => {
    const byteProgress = job.progressUnit === "bytes";
    const total = byteProgress ? Number(job.totalBytes || 0) : Number(job.total || 0);
    const done = byteProgress ? Number(job.bytes || 0) : Number(job.done || 0);
    const percent = total ? Math.round(done / total * 100) : 0;
    const detail = job.status === "ready"
      ? (job.mode === "browser-assisted" ? t("assistedReadyMessage", null, "打开任务并选择专用子文件夹，然后返回网页继续播放。") : t("directReadyMessage", null, "打开任务并选择专用子文件夹后开始下载。"))
      : job.status === "waiting" ? (labels.waiting || t("waitingForPlayback", null, "等待网页继续播放"))
        : byteProgress ? `${(done / 1048576).toFixed(1)} / ${total ? (total / 1048576).toFixed(1) : "?"} MB · ${percent}%`
          : `${done}/${total || "?"} · ${percent}% · ${Number(job.bytes || 0) ? (Number(job.bytes) / 1048576).toFixed(1) + " MB" : labels[job.status] || ""}`;
    return `<div class="work"><div class="row between"><div class="work-name" title="${escapeHtml(job.title || job.product || "")}">${escapeHtml(displayTitle(job.title || job.product, t("downloadTask", null, "视频下载")))}</div><span class="muted">${escapeHtml(labels[job.status] || job.status)}</span></div>
      <progress value="${done}" max="${total || 1}"></progress>
      <div class="detail">${escapeHtml(detail)}</div>
      <a class="button link" target="_blank" href="download.html?job=${encodeURIComponent(job.id)}">${escapeHtml(job.status === "ready" ? t("chooseFolderAndStart", null, "选择位置并开始") : t("openTask", null, "查看下载"))}</a></div>`;
  }).join("");
}

function renderNotice(works) {
  $("notice").className = "notice";
  if (works.length) {
    $("notice").classList.add("found");
    $("noticeIcon").textContent = "✓";
    $("noticeTitle").textContent = t("videosFound", works.length, `找到 ${works.length} 个视频`);
    $("noticeDetail").textContent = t("chooseSaveMethod", null, "推荐直接下载；如果网站需要保持播放，可以选择网页辅助。");
  } else {
    $("noticeIcon").textContent = $("discover").checked ? "●" : "○";
    $("noticeTitle").textContent = $("discover").checked ? t("listeningNow", null, "正在监听页面视频") : t("listeningOff", null, "监听尚未开启");
    $("noticeDetail").textContent = $("discover").checked ? t("listeningHelp", null, "开始播放后，找到的视频会显示在这里。") : t("listeningOffHelp", null, "开启监听，再播放你想保存的视频。");
  }
}

async function refresh() {
  const stored = await chrome.storage.local.get({ [CANDIDATES_KEY]: [], [JOBS_KEY]: [] });
  $("connection").textContent = `${t("statusReady", null, "可以使用")} · v${chrome.runtime.getManifest().version}`;
  $("connection").className = "pill ok";
  const works = renderWorks(stored[CANDIDATES_KEY] || []);
  renderJobs(stored[JOBS_KEY] || []);
  renderNotice(works);
  setMessage(t("readyWithoutService", null, "无需启动其他程序"));
}

function openTask(candidate, mode) {
  return openExtensionPage(`download.html?candidate=${encodeURIComponent(candidate.id)}&mode=${encodeURIComponent(mode)}`);
}

async function setDecision(candidateId, decision) {
  const stored = await chrome.storage.local.get({ [CANDIDATES_KEY]: [] });
  const candidates = Array.isArray(stored[CANDIDATES_KEY]) ? stored[CANDIDATES_KEY] : [];
  const selected = candidates.find((item) => item.id === candidateId);
  if (!selected) throw new Error(t("candidateGone", null, "没有找到这个视频，请重新播放后再试。"));
  const related = candidates.filter((item) => item.tabId === selected.tabId && item.product === selected.product);
  for (const item of related) {
    item.decision = decision === "reset" ? "pending" : item.id === selected.id || decision === "ignored" ? decision : "not-selected";
    if (decision === "ignored") item.ignoredUntil = Date.now() + 30 * 60 * 1000;
    else delete item.ignoredUntil;
  }
  await chrome.storage.local.set({ [CANDIDATES_KEY]: candidates });
  return selected;
}

async function choose(button) {
  const card = button.closest("[data-product]");
  const candidateId = card?.querySelector('[data-role="candidate"]')?.value;
  const candidate = candidateIndex.get(candidateId);
  const action = button.dataset.action;
  if (!candidate || !action) return;
  button.disabled = true;
  try {
    if (action === "reset") await setDecision(candidate.id, "reset");
    else if (action === "ignore") await setDecision(candidate.id, "ignored");
    else {
      const selectedIds = card.querySelector('[data-role="multiple-qualities"]')?.checked
        ? [...card.querySelector('[data-role="candidate"]').options].map((option) => option.value)
        : [candidate.id];
      const opening = action === "ignored" ? [] : selectedIds.map((selectedId) => {
        const selectedCandidate = candidateIndex.get(selectedId);
        return selectedCandidate ? openTask(selectedCandidate, action) : Promise.resolve();
      });
      await setDecision(candidate.id, action);
      try {
        const site = new URL(candidate.pageUrl).hostname;
        lastQualityBySite[site] = candidate.resolution;
        if (card.querySelector('[data-role="remember-site"]')?.checked) siteRules[site] = { mode: action, quality: candidate.resolution };
        await chrome.storage.local.set({ lastQualityBySite, siteRules });
      } catch { /* no site preference */ }
      await Promise.all(opening);
    }
    await refresh();
  } catch (error) {
    setMessage(error.message || t("needsAttention", null, "需要处理"));
    button.disabled = false;
  }
}

$("discover").addEventListener("change", async () => { await chrome.storage.local.set({ discover: $("discover").checked, enabled: false }); await refresh(); });
$("refresh").addEventListener("click", refresh);
$("works").addEventListener("click", (event) => { const button = event.target.closest("button[data-action]"); if (button) void choose(button); });
chrome.storage.onChanged.addListener((changes, area) => { if (area === "local" && (changes[CANDIDATES_KEY] || changes[JOBS_KEY])) void refresh(); });

WebKeeperI18n.init().then(loadSettings).then(refresh).catch((error) => setMessage(error.message));
