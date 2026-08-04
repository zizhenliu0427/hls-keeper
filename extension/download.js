const CANDIDATES_KEY = "wkCandidates";
const JOBS_KEY = "wkJobs";
const MEDIA_EVENTS_KEY = "wkMediaEvents";
const DB_NAME = "web-keeper-downloads";
const PAGE_BUFFER_WAIT_COLD_MS = 6000;
const PAGE_BUFFER_WAIT_PROVEN_MS = 2500;
const DB_VERSION = 1;
const query = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const { t } = WebKeeperI18n;

let db;
let state;
let candidate;
let rootHandle;
let workDirectory;
let segmentDirectory;
let paused = false;
let activeController = null;
const activeControllers = new Set();
let captureQueue = Promise.resolve();
let mediaPlaylist = null;
let hlsAudioPlaylist = null;
let segmentIndex = WebKeeperMediaEngine.segmentLookup([]);
let knownPlaylistSources = [];
let pinnedPlaylistUrl = "";
let pendingCaptureSegments = [];
let replayingCaptureSegments = false;
let capturePlaylistLocked = false;
let qualitySwitchReportedAt = 0;
let lastCaptureRefreshAt = 0;
let lastAdoptAttemptAt = 0;
let lastDashSwitchAt = 0;
let lastHookInjectionAt = 0;
const MAX_CAPTURE_RETRIES = 3;
const captureRetryCounts = new Map();
let pageBufferWaitMs = PAGE_BUFFER_WAIT_COLD_MS;
let pageBufferMisses = 0;
let pageBufferGaveUp = new Set();
let dashCapture = null;
let logs = [];
let showDiagnostics = false;
const responseControllers = new WeakMap();
let smartFillRunning = false;
let autoFinalize = true;
let cleanupAfterMerge = true;
let directConcurrency = 4;
let saveDestination = "browser-downloads";
let speedSampleAt = Date.now();
let speedSampleBytes = 0;
let seekBoostTimer = null;
let progressWatchTimer = null;
let lastProgressAt = Date.now();
let lastProgressMark = { done: 0, bytes: 0 };
let stallAlertShown = false;
let smartFillActiveRange = null;
const SEEK_BOOST_STEP_SECONDS = 10;
const SEEK_BOOST_INTERVAL_MS = 1000;
const MIN_SEGMENT_BYTES = 188;
const STALL_WARN_MS = 45000;
const SMART_FILL_SEEK_SKEW_SECONDS = 20;
const TS_TIMESTAMP_SAMPLE_BYTES = 512 * 1024;
const LONG_PAUSE_MS = 5 * 60 * 1000;
let skippableClassifyRunning = false;
let timelineShiftAlertShown = false;

function updateTransferSpeed() {
  const now = Date.now();
  const bytes = Number(state?.bytes || 0);
  if (!["downloading", "capturing"].includes(state?.status)) {
    state.speedMbps = 0;
    speedSampleAt = now;
    speedSampleBytes = bytes;
    return;
  }
  const elapsed = now - speedSampleAt;
  if (elapsed < 500) return;
  const instant = Math.max(0, bytes - speedSampleBytes) / 1048576 / (elapsed / 1000);
  state.speedMbps = Number(state.speedMbps || 0) ? Number(state.speedMbps) * 0.35 + instant * 0.65 : instant;
  speedSampleAt = now;
  speedSampleBytes = bytes;
}

function waitFor(milliseconds) {
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (paused || Date.now() - started >= milliseconds) { clearInterval(timer); resolve(); }
    }, Math.min(250, milliseconds));
  });
}

async function mapConcurrent(items, limit, worker) {
  const queue = [...items];
  let cursor = 0;
  let firstError = null;
  const runners = Array.from({ length: Math.max(1, Math.min(Number(limit || 1), queue.length || 1)) }, async () => {
    while (!paused && !firstError) {
      const index = cursor;
      cursor += 1;
      if (index >= queue.length) return;
      try { await worker(queue[index], index); }
      catch (error) { firstError ||= error; }
    }
  });
  await Promise.all(runners);
  if (firstError) throw firstError;
}

function log(message) {
  const stamp = new Date().toLocaleTimeString();
  logs.push(`[${stamp}] ${message}`);
  logs = logs.slice(-160);
  $("log").textContent = logs.join("\n");
  $("log").scrollTop = $("log").scrollHeight;
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error("数据库事务已取消"));
  });
}

async function openDatabase() {
  db = await new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("handles")) database.createObjectStore("handles", { keyPath: "id" });
      if (!database.objectStoreNames.contains("states")) database.createObjectStore("states", { keyPath: "id" });
      if (!database.objectStoreNames.contains("segments")) {
        const store = database.createObjectStore("segments", { keyPath: "id" });
        store.createIndex("jobId", "jobId", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function dbGet(storeName, key) {
  const transaction = db.transaction(storeName, "readonly");
  return requestResult(transaction.objectStore(storeName).get(key));
}

async function dbPut(storeName, value) {
  const transaction = db.transaction(storeName, "readwrite");
  transaction.objectStore(storeName).put(value);
  await transactionDone(transaction);
}

async function dbDelete(storeName, key) {
  const transaction = db.transaction(storeName, "readwrite");
  transaction.objectStore(storeName).delete(key);
  await transactionDone(transaction);
}

async function listSegmentRecords(jobId) {
  const transaction = db.transaction("segments", "readonly");
  const request = transaction.objectStore("segments").index("jobId").getAll(jobId);
  return requestResult(request);
}

async function deleteSegmentRecords(jobId) {
  const transaction = db.transaction("segments", "readwrite");
  const index = transaction.objectStore("segments").index("jobId");
  const request = index.openKeyCursor(IDBKeyRange.only(jobId));
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    transaction.objectStore("segments").delete(cursor.primaryKey);
    cursor.continue();
  };
  await transactionDone(transaction);
}

function safeName(value, fallback = "video") {
  const cleaned = String(value || "").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/g, "").trim();
  return (cleaned || fallback).slice(0, 120);
}

function preferredOutputBaseName() {
  const directName = WebKeeperMediaEngine.directFile(candidate)?.fileName || candidate?.fileName || "";
  const directBase = directName.replace(/\.[a-z0-9]{2,5}$/i, "");
  const pageTitle = String(candidate?.pageTitle || state?.title || "").trim();
  let base = directBase || pageTitle || state?.product || candidate?.product || "video";
  base = safeName(base);
  const quality = String(state?.resolution || candidate?.resolution || "").trim();
  if (quality && quality !== "auto" && !base.toLowerCase().includes(quality.toLowerCase())) base = `${base}_${safeName(quality)}`;
  return safeName(base);
}

function validSubtitleUrls(urls = []) {
  return Array.from(new Set(urls.filter((url) => {
    try { return /\.(?:vtt|srt|ttml|dfxp|ass|ssa)(?:[?#]|$)/i.test(new URL(url).href); }
    catch { return false; }
  })));
}

function normalizedMediaUrl(value) {
  return WebKeeperMediaEngine.normalizeMediaUrl(value);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1048576) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1073741824) return `${(value / 1048576).toFixed(1)} MB`;
  return `${(value / 1073741824).toFixed(2)} GB`;
}

function formatTime(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds || 0)));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor(value % 3600 / 60);
  const secs = value % 60;
  return hours ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}` : `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function statusLabel(status) {
  return ({
    ready: saveDestination === "browser-downloads" ? t("readyToStart", null, "准备开始") : t("waitingForFolder", null, "等待选择保存位置"), downloading: t("downloading", null, "正在下载"),
    capturing: t("followingPlayback", null, "正在跟随网页播放"), waiting: t("waitingForPlayback", null, "等待网页继续播放"),
    paused: t("paused", null, "已暂停"), merging: t("creatingVideo", null, "正在生成视频"),
    downloaded: t("downloadedReady", null, "已下载，等待生成视频"),
    exporting: t("exportingToDownloads", null, "正在保存到浏览器 Downloads"),
    complete: t("complete", null, "已完成"), error: t("needsAttention", null, "需要处理")
  })[status] || status || t("statusPreparing", null, "准备中");
}

function noteDownloadProgress() {
  if (!state) return;
  const done = Number(state.done || 0);
  const bytes = Number(state.bytes || 0);
  if (done === lastProgressMark.done && bytes === lastProgressMark.bytes) return;
  lastProgressMark = { done, bytes };
  lastProgressAt = Date.now();
  stallAlertShown = false;
  if (state.stalled) state.stalled = false;
}

function stopProgressWatchdog() {
  if (progressWatchTimer) {
    clearInterval(progressWatchTimer);
    progressWatchTimer = null;
  }
}

function startProgressWatchdog() {
  stopProgressWatchdog();
  lastProgressMark = { done: Number(state?.done || 0), bytes: Number(state?.bytes || 0) };
  lastProgressAt = Date.now();
  stallAlertShown = false;
  if (state) state.stalled = false;
  progressWatchTimer = setInterval(() => { void checkProgressStall(); }, 5000);
}

async function inspectPlayerTime() {
  const tabId = Number(candidate?.tabId);
  if (!(tabId >= 0)) return null;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        const videos = [...document.querySelectorAll("video")].filter((item) => item.duration || item.readyState || item.clientWidth);
        const video = videos.sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))[0];
        if (!video) return null;
        return { currentTime: Number(video.currentTime || 0), duration: Number.isFinite(video.duration) ? video.duration : 0, paused: Boolean(video.paused) };
      }
    });
    return (results || []).map((item) => item?.result).find(Boolean) || null;
  } catch {
    return null;
  }
}

function nearestMissingHint(playerTime = null) {
  const ranges = state?.missingRanges || [];
  if (!ranges.length) return "";
  if (playerTime == null || !Number.isFinite(playerTime)) {
    const first = ranges[0];
    return t("stallNextMissingHint", [formatTime(first.startSeconds), formatTime(first.endSeconds)], `下一处缺口约在 ${formatTime(first.startSeconds)} – ${formatTime(first.endSeconds)}。`);
  }
  let best = ranges[0];
  let bestDist = Math.abs(Number(best.startSeconds || 0) - playerTime);
  for (const range of ranges) {
    const start = Number(range.startSeconds || 0);
    const end = Number(range.endSeconds || start);
    const dist = playerTime < start ? start - playerTime : playerTime > end ? playerTime - end : 0;
    if (dist < bestDist) {
      best = range;
      bestDist = dist;
    }
  }
  if (bestDist <= SMART_FILL_SEEK_SKEW_SECONDS) {
    return t("stallAtMissingHint", [formatTime(best.startSeconds), formatTime(best.endSeconds)], `播放器大致在缺口 ${formatTime(best.startSeconds)} – ${formatTime(best.endSeconds)} 附近。`);
  }
  return t("stallFarFromMissingHint", [formatTime(playerTime), formatTime(best.startSeconds), formatTime(best.endSeconds), Math.round(bestDist)], `播放器约在 ${formatTime(playerTime)}，距最近缺口 ${formatTime(best.startSeconds)} – ${formatTime(best.endSeconds)} 约偏 ${Math.round(bestDist)} 秒。`);
}

async function checkProgressStall() {
  if (!state || paused) return;
  const watching = ["downloading", "capturing", "waiting"].includes(state.status) || smartFillRunning;
  if (!watching) return;
  if (state.status === "waiting" && state.mode === "direct" && !state.isLive) return;
  if (Date.now() - lastProgressAt < STALL_WARN_MS) return;
  const idleSec = Math.round((Date.now() - lastProgressAt) / 1000);
  let player = null;
  if (state.mode === "browser-assisted" || smartFillRunning) player = await inspectPlayerTime();
  const hint = nearestMissingHint(player?.currentTime);
  const playerPart = player
    ? t("stallPlayerTimePart", [formatTime(player.currentTime), player.paused ? t("stallPlayerPaused", null, "已暂停") : t("stallPlayerPlaying", null, "播放中")], `网页进度约 ${formatTime(player.currentTime)}（${player.paused ? "已暂停" : "播放中"}）。`)
    : "";
  state.stalled = true;
  state.message = smartFillRunning
    ? t("stallSmartFillAlert", [idleSec, playerPart, hint], `进度已约 ${idleSec} 秒没有增加。${playerPart}${hint}请确认网页仍在加载，或手动播放缺口后再继续智能补全。`)
    : state.mode === "direct"
      ? t("stallDirectAlert", idleSec, `进度已约 ${idleSec} 秒没有增加。可稍后继续，或改用网页辅助。`)
      : t("stallCaptureAlert", [idleSec, playerPart, hint], `进度已约 ${idleSec} 秒没有增加。${playerPart}${hint}请回到网页播放、开启自动快进，或使用智能补全。`);
  await mirrorJob();
  if (!stallAlertShown) {
    stallAlertShown = true;
    alert(state.message);
  }
}

async function mirrorJob() {
  updateTransferSpeed();
  noteDownloadProgress();
  state.updatedAt = Date.now();
  await dbPut("states", state);
  const stored = await chrome.storage.local.get({ [JOBS_KEY]: [] });
  const jobs = Array.isArray(stored[JOBS_KEY]) ? stored[JOBS_KEY] : [];
  const summary = {
    id: state.id, candidateId: state.candidateId, mode: state.mode, product: state.product,
    title: state.title, pageUrl: candidate?.pageUrl || state.candidate?.pageUrl || "", resolution: state.resolution, status: state.status, done: state.done || 0,
    total: state.total || 0, bytes: state.bytes || 0, failed: state.failed || 0,
    totalBytes: state.totalBytes || 0, progressUnit: state.progressUnit || "items",
    providerId: state.providerId || "", outputName: state.outputName || "", speedMbps: state.speedMbps || 0,
    saveDestination: state.saveDestination || saveDestination, browserDownloadId: state.browserDownloadId || null, updatedAt: state.updatedAt
  };
  const index = jobs.findIndex((item) => item.id === state.id);
  if (index >= 0) jobs[index] = summary; else jobs.push(summary);
  jobs.sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt));
  await chrome.storage.local.set({ [JOBS_KEY]: jobs.slice(0, 100) });
  render();
}

function render() {
  if (!state) return;
  $("taskView").hidden = false;
  $("listView").hidden = true;
  $("title").textContent = state.title || state.product || t("downloadTask", null, "视频下载");
  $("subtitle").textContent = `${state.resolution || t("automaticQuality", null, "自动清晰度")} · ${
    state.source === "legacy-import"
      ? t("downloadMethodLegacyImport", null, "旧捕获导入")
      : (state.mode === "direct" ? t("downloadMethodDirect", null, "直接下载") : t("downloadMethodAssisted", null, "网页辅助"))
  }`;
  $("status").textContent = statusLabel(state.status);
  $("status").className = `pill ${state.status === "complete" ? "ok" : state.status === "error" ? "bad" : ""}`;
  const byteProgress = state.progressUnit === "bytes";
  const total = byteProgress ? Number(state.totalBytes || 0) : Number(state.total || 0);
  const done = byteProgress ? Number(state.bytes || 0) : Number(state.done || 0);
  $("progress").max = total || 1;
  $("progress").value = done;
  $("progressText").textContent = byteProgress
    ? t("byteProgress", [formatBytes(done), total ? formatBytes(total) : "?"], `${formatBytes(done)} / ${total ? formatBytes(total) : "?"}`)
    : total ? t("progressCount", [done, total, Math.round(done / total * 100)], `${done}/${total}（${Math.round(done / total * 100)}%）`) : t("itemsSavedCount", done, `已完成 ${done} 项`);
  $("saved").textContent = byteProgress ? (state.status === "complete" ? "1" : "0") : String(done);
  const missingCount = byteProgress
    ? (state.status === "complete" ? 0 : 1)
    : (Array.isArray(state.missingRanges) ? Number(state.missing || 0) : (total ? Math.max(total - done, 0) : null));
  $("missing").textContent = missingCount == null ? "—" : String(missingCount);
  $("bytes").textContent = formatBytes(state.bytes);
  $("speed").textContent = ["downloading", "capturing"].includes(state.status) ? `${Number(state.speedMbps || 0).toFixed(2)} MB/s` : "—";
  $("notice").textContent = state.message || t("chooseFolderShort", null, "请选择保存位置。");
  $("notice").className = `notice ${state.status === "error" || state.stalled ? "bad" : ""}`;
  if (state.stalled) $("status").className = "pill bad";
  const hasHandle = Boolean(rootHandle);
  $("choose").hidden = saveDestination === "browser-downloads" || hasHandle || ["downloading", "capturing", "merging", "exporting"].includes(state.status);
  $("choose").textContent = state.done ? t("chooseFolderAndContinue", null, "重新选择位置并继续") : t("chooseFolderAndStart", null, "选择位置并开始");
  $("resume").hidden = !hasHandle || !["paused", "error", "ready", "waiting"].includes(state.status);
  $("pause").hidden = !["downloading", "capturing", "waiting"].includes(state.status);
  $("backToVideo").hidden = state.mode !== "browser-assisted" || !["capturing", "waiting", "paused"].includes(state.status);
  const legacyNeedsAssist = state.source === "legacy-import" && Number(state.missing || 0) > 0 && ["paused", "downloaded", "ready", "waiting"].includes(state.status);
  $("switchAssisted").hidden = !(
    (state.mode === "direct" && ["error", "waiting"].includes(state.status) && ["AUTH_REQUIRED", "URL_EXPIRED", "PLAYLIST_STALLED", "NETWORK_ERROR", "SEPARATE_TRACKS"].includes(state.errorCode || ""))
    || legacyNeedsAssist
  );
  const ranges = state.missingRanges || [];
  const skippableCount = Number(state.skippableCount || skippableSequenceSet().size || 0);
  const breakCount = timelineBreakSet().size;
  $("missingPanel").hidden = !ranges.length && !skippableCount && !breakCount;
  $("missingRanges").innerHTML = (breakCount
    ? `<div class="muted">${escapeHtml(t("timelineBreaksNote", breakCount, `已自动标记 ${breakCount} 处时间轴断点（暂停后片源变化），下载会继续。`))}</div>`
    : "")
    + (skippableCount
    ? `<div class="muted">${escapeHtml(t("skippableSegmentsNote", skippableCount, `已确认 ${skippableCount} 个空壳/可跳过分片（前后时间轴连贯，不再重试）。`))}</div>`
    : "")
    + ranges.slice(0, 12).map((range) => {
      const active = smartFillActiveRange
        && Number(range.sequenceFrom) === Number(smartFillActiveRange.sequenceFrom)
        && Number(range.sequenceTo) === Number(smartFillActiveRange.sequenceTo);
      return `<div class="range${active ? " active" : ""}"><span>${escapeHtml(formatTime(range.startSeconds))} – ${escapeHtml(formatTime(range.endSeconds))}${active ? ` · ${escapeHtml(t("smartFillCurrentRangeMark", null, "正在补"))}` : ""}</span><span class="muted">${escapeHtml(t("missingItemsCount", range.count, `${range.count} 项`))}</span></div>`;
    }).join("")
    + (ranges.length > 12 ? `<div class="muted">${escapeHtml(t("moreMissingRanges", ranges.length - 12, `另有 ${ranges.length - 12} 处`))}</div>` : "");
  $("smartFill").hidden = state.mode !== "browser-assisted" || !ranges.length || !["capturing", "waiting", "paused"].includes(state.status);
  const showSpeed = state.mode === "browser-assisted" && ["capturing", "waiting", "paused"].includes(state.status);
  $("captureSpeedPanel").hidden = !showSpeed;
  $("captureSpeed").value = state.captureSpeedMode === "seek" ? "seek10" : String(Number(state.captureSpeed || 1) || 1);
  const seekSettings = normalizedSeekBoostSettings();
  $("seekBoostPanel").hidden = !showSpeed || state.captureSpeedMode !== "seek";
  if (!$("seekBoostInterval").matches(":focus")) $("seekBoostInterval").value = String(seekSettings.intervalSec);
  if (!$("seekBoostStep").matches(":focus")) $("seekBoostStep").value = String(seekSettings.stepSeconds);
  $("smartFill").disabled = smartFillRunning;
  $("merge").hidden = state.providerId === "direct-file" || !hasHandle || !state.done || Boolean(state.outputName) || ["downloading", "merging"].includes(state.status);
  $("openOutput").hidden = !hasHandle || !state.outputName || state.status === "merging";
  $("openOutput").textContent = state.browserDownloadId ? t("showInFolder", null, "在文件夹中显示") : t("openGeneratedVideo", null, "打开生成的视频");
  $("subtitles").hidden = !hasHandle || !(candidate?.subtitles || []).length;
  $("deleteSegments").hidden = state.providerId === "direct-file" || !hasHandle || !state.outputName || state.temporaryCleaned || ["downloading", "merging"].includes(state.status);
  $("deleteOutput").hidden = !hasHandle || !state.outputName || ["downloading", "capturing", "merging", "exporting"].includes(state.status);
  $("removeTask").hidden = ["downloading", "capturing", "merging", "exporting"].includes(state.status);
  $("locationPanel").hidden = !hasHandle;
  $("locationText").textContent = hasHandle ? (saveDestination === "browser-downloads"
    ? [t("browserDownloadsLocation", null, "浏览器 Downloads"), state.outputName].filter(Boolean).join(" / ")
    : [rootHandle.name, state.directoryName, state.outputName].filter(Boolean).join(" / ")) : "";
  $("diagnosticsPanel").hidden = !showDiagnostics && state.status !== "error";
}

function parseAttributeList(text) {
  return WebKeeperMediaEngine.parseAttributeList(text);
}

function parsePlaylist(text, playlistUrl) {
  return WebKeeperMediaEngine.parseHlsPlaylist(text, playlistUrl);
}

function allowedHeaders(source = {}, extra = {}) {
  const headers = new Headers();
  const allowed = /^(accept|accept-language|authorization|cache-control|pragma|range|x-[a-z0-9-]+)$/i;
  for (const [name, value] of Object.entries({ ...source, ...extra })) {
    if (allowed.test(name) && value) {
      try { headers.set(name, value); } catch { /* forbidden by this browser */ }
    }
  }
  return headers;
}

function byteRangeHeader(value) {
  return WebKeeperMediaEngine.rangeHeader(value);
}

async function fetchResponse(url, { byteRange = "", attempts = 3, headers = {}, cacheMode = "no-store" } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (paused) throw new Error(t("downloadPausedError", null, "下载已暂停"));
    const controller = new AbortController();
    activeController = controller;
    activeControllers.add(controller);
    let handedToCaller = false;
    try {
      const range = byteRangeHeader(byteRange);
      const response = await fetch(url, {
        method: "GET",
        headers: allowedHeaders({ ...(candidate?.headers || {}), ...headers }, range ? { range } : {}),
        credentials: "include",
        cache: range ? "no-store" : cacheMode,
        signal: controller.signal
      });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      if (range && response.status !== 206) throw new Error(t("rangeNotSupported", null, "网站没有按指定范围返回媒体内容，已停止以避免生成损坏的视频。"));
      responseControllers.set(response, controller);
      handedToCaller = true;
      return response;
    } catch (error) {
      lastError = error;
      if (paused || error.name === "AbortError") throw new Error(t("downloadPausedError", null, "下载已暂停"));
      if ([401, 403, 404, 410].includes(Number(error.status || 0))) break;
      if (attempt < attempts) await waitFor(attempt * 900);
    } finally {
      if (!handedToCaller) activeControllers.delete(controller);
      if (!handedToCaller && activeController === controller) activeController = null;
    }
  }
  throw new Error(`${lastError?.message || t("requestFailed", null, "请求失败")}：${url}`);
}

async function consumeResponse(response, method) {
  const controller = responseControllers.get(response);
  try {
    return await response[method]();
  } finally {
    responseControllers.delete(response);
    if (controller) activeControllers.delete(controller);
    if (controller && activeController === controller) activeController = null;
  }
}

async function fetchText(url, options) {
  const response = await fetchResponse(url, options);
  return consumeResponse(response, "text");
}

function targetHeight(resolution) {
  return Number(String(resolution || "").match(/\d+x(\d+)/)?.[1] || String(resolution || "").match(/(\d+)p/)?.[1] || 0);
}

function indexMediaPlaylist(parsed) {
  mediaPlaylist = parsed;
  segmentIndex = WebKeeperMediaEngine.segmentLookup(parsed.segments);
  state.total = parsed.segments.filter((item) => !item.gap).length;
  state.duration = parsed.duration || state.duration || 0;
  state.isLive = parsed.isLive;
  state.wasLive = Boolean(state.wasLive || parsed.isLive);
}

function rememberPlaylistSources(parsed) {
  const discovered = [...(parsed.variants || []).map((item) => item.url), ...(parsed.audios || []).map((item) => item.url)];
  knownPlaylistSources = Array.from(new Set([...knownPlaylistSources, ...discovered.filter(Boolean)])).slice(-40);
}

async function loadLocalLegacyPlaylist() {
  if (!workDirectory || state?.source !== "legacy-import") return null;
  try {
    const playlistHandle = await workDirectory.getFileHandle("source.m3u8");
    const text = await (await playlistHandle.getFile()).text();
    const baseUrl = candidate.playlistUrl || `https://legacy.local/${encodeURIComponent(state.product)}/${encodeURIComponent(state.resolution)}/source.m3u8`;
    const parsed = parsePlaylist(text, baseUrl);
    if (state.legacyKeyUrl) {
      try {
        const keyHandle = await workDirectory.getFileHandle("file.key");
        await cacheLegacyAesKey(await (await keyHandle.getFile()).arrayBuffer(), state.legacyKeyUrl);
        for (const segment of parsed.segments) {
          if (segment.key) segment.key = { ...segment.key, url: state.legacyKeyUrl };
        }
      } catch { /* key optional for clear segments */ }
    }
    return { url: baseUrl, text, parsed };
  } catch {
    return null;
  }
}

async function loadMediaPlaylist() {
  const localLegacy = await loadLocalLegacyPlaylist();
  if (localLegacy?.parsed?.segments?.length) {
    candidate.playlistUrl = localLegacy.url;
    indexMediaPlaylist(localLegacy.parsed);
    rememberPlaylistSources(localLegacy.parsed);
    return mediaPlaylist;
  }
  const urls = pinnedPlaylistUrl ? [pinnedPlaylistUrl] : Array.from(new Set([...(candidate.playlistUrls || []), candidate.playlistUrl].filter(Boolean)));
  if (!urls.length && candidate.segmentUrl) {
    const parsed = new URL(candidate.segmentUrl);
    parsed.pathname = parsed.pathname.replace(/\/[^/]+$/, "/first.m3u8");
    urls.push(parsed.href);
  }
  if (!urls.length) throw new Error(t("playlistNotFound", null, "尚未找到完整的视频信息，请回到网页播放几秒后重试。"));
  const available = [];
  let lastError = null;
  for (const itemUrl of urls.slice(-20)) {
    try {
      log(`读取播放列表 ${itemUrl}`);
      const itemText = await fetchText(itemUrl);
      const itemParsed = parsePlaylist(itemText, itemUrl);
      if (itemParsed.variants.length || itemParsed.segments.length) available.push({ url: itemUrl, text: itemText, parsed: itemParsed });
    } catch (error) {
      lastError = error;
      log(`跳过不可用的播放列表：${error.message}`);
    }
  }
  if (!available.length) throw lastError || new Error(t("playlistEmpty", null, "没有找到可下载的视频内容。"));
  const chosenSource = [...available].sort((a, b) => {
    const master = Number(Boolean(b.parsed.variants.length)) - Number(Boolean(a.parsed.variants.length));
    if (master) return master;
    const videoHint = (value) => /video|avc|hevc|h264|h265|\d{3,4}p|\d{3,5}x\d{3,5}/i.test(value.url) ? 1 : /audio|aac|m4a|sound/i.test(value.url) ? -1 : 0;
    return videoHint(b) - videoHint(a) || b.parsed.segments.length - a.parsed.segments.length;
  })[0];
  let { url, text, parsed } = chosenSource;
  candidate.playlistUrl = url;
  hlsAudioPlaylist = null;
  let discoveredSubtitles = [...(parsed.subtitles || [])];
  rememberPlaylistSources(parsed);
  if (parsed.variants.length) {
    const wanted = targetHeight(candidate.resolution);
    const ordered = [...parsed.variants].sort((a, b) => targetHeight(b.resolution) - targetHeight(a.resolution) || b.bandwidth - a.bandwidth);
    const chosen = ordered.find((item) => targetHeight(item.resolution) === wanted) || ordered[0];
    const selectedAudio = chosen.audioGroup
      ? (parsed.audios || []).find((item) => item.groupId === chosen.audioGroup && item.default) || (parsed.audios || []).find((item) => item.groupId === chosen.audioGroup)
      : null;
    log(`选择清晰度 ${chosen.resolution || t("automaticQuality", null, "自动清晰度")}`);
    url = chosen.url;
    text = await fetchText(url);
    parsed = parsePlaylist(text, url);
    if (selectedAudio?.url) hlsAudioPlaylist = parsePlaylist(await fetchText(selectedAudio.url), selectedAudio.url);
    state.resolution = chosen.resolution || state.resolution;
    if (selectedAudio) state.audioTrack = { language: selectedAudio.language, label: selectedAudio.label, url: selectedAudio.url };
  }
  if (!parsed.segments.length) throw new Error(t("playlistEmpty", null, "没有找到可下载的视频内容。"));
  discoveredSubtitles = [...discoveredSubtitles, ...(parsed.subtitles || [])];
  candidate.subtitles = Array.from(new Set([...(candidate.subtitles || []), ...discoveredSubtitles.map((item) => item.url)]));
  indexMediaPlaylist(parsed);
  state.candidate = { ...candidate };
  await updateMissingTimeline();
  await mirrorJob();
  return parsed;
}

function ivBytes(ivText, sequence) {
  if (ivText) {
    const hex = ivText.replace(/^0x/i, "").padStart(32, "0").slice(-32);
    return Uint8Array.from(hex.match(/.{2}/g).map((pair) => Number.parseInt(pair, 16)));
  }
  const iv = new Uint8Array(16);
  let value = BigInt(sequence);
  for (let index = 15; index >= 0; index -= 1) { iv[index] = Number(value & 255n); value >>= 8n; }
  return iv;
}

const keyCache = new Map();
async function cacheLegacyAesKey(rawKey, cacheUrl) {
  const bytes = rawKey instanceof ArrayBuffer ? new Uint8Array(rawKey) : rawKey;
  if (bytes.byteLength !== 16) throw new Error(t("keyLengthInvalid", bytes.byteLength, `视频解密信息异常（${bytes.byteLength} 字节）。`));
  const cryptoKey = await crypto.subtle.importKey("raw", bytes, { name: "AES-CBC" }, false, ["decrypt"]);
  keyCache.set(cacheUrl, cryptoKey);
  return cryptoKey;
}

async function decryptIfNeeded(segment, bytes) {
  if (!segment.key || segment.key.method === "NONE") return bytes;
  if (segment.key.method !== "AES-128") throw new Error(t("unsupportedEncryption", segment.key.method, `暂不支持这种视频加密方式：${segment.key.method}`));
  let cryptoKey = keyCache.get(segment.key.url);
  if (!cryptoKey) {
    if (/^https:\/\/legacy\.local\/aes-key\//i.test(String(segment.key.url || ""))) {
      throw new Error(t("legacyKeyMissing", null, "旧捕获的解密密钥尚未加载。请重新导入该目录，或打开任务后等待自动恢复密钥。"));
    }
    cryptoKey = (async () => {
      const response = await fetchResponse(segment.key.url);
      const raw = await consumeResponse(response, "arrayBuffer");
      if (raw.byteLength !== 16) throw new Error(t("keyLengthInvalid", raw.byteLength, `视频解密信息异常（${raw.byteLength} 字节）。`));
      return crypto.subtle.importKey("raw", raw, { name: "AES-CBC" }, false, ["decrypt"]);
    })();
    keyCache.set(segment.key.url, cryptoKey);
  }
  try { cryptoKey = await cryptoKey; } catch (error) { keyCache.delete(segment.key.url); throw error; }
  keyCache.set(segment.key.url, cryptoKey);
  return crypto.subtle.decrypt({ name: "AES-CBC", iv: ivBytes(segment.key.iv, segment.sequence) }, cryptoKey, bytes);
}

async function ensureDirectories({ requestPermission = true } = {}) {
  if (!rootHandle) throw new Error(t("selectFolderFirst", null, "请先选择保存位置。"));
  const permission = typeof rootHandle.queryPermission === "function" ? await rootHandle.queryPermission({ mode: "readwrite" }) : "granted";
  if (permission !== "granted") {
    if (!requestPermission) throw new Error(t("folderNeedsPermission", null, "保存位置需要重新授权。"));
    const granted = await rootHandle.requestPermission({ mode: "readwrite" });
    if (granted !== "granted") throw new Error(t("folderPermissionDenied", null, "没有获得保存位置的写入权限。"));
  }
  const folderName = preferredOutputBaseName();
  workDirectory = await rootHandle.getDirectoryHandle(folderName, { create: true });
  segmentDirectory = await workDirectory.getDirectoryHandle("segments", { create: true });
  state.directoryName = folderName;
}

async function writeFile(directory, name, data) {
  const fileHandle = await directory.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(data);
  await writable.close();
  return fileHandle;
}

function segmentFileName(segment) {
  const ext = new URL(segment.url).pathname.match(/\.([a-z0-9]+)$/i)?.[1] || "bin";
  return `${String(segment.sequence).padStart(8, "0")}.${ext === "m4s" ? "m4s" : "ts"}`;
}

function isValidSegmentSize(size) {
  return Number(size || 0) >= MIN_SEGMENT_BYTES;
}

function skippableSequenceSet() {
  return new Set((state?.skippableSequences || []).map(Number).filter((value) => Number.isFinite(value)));
}

function coveredSegmentCount() {
  return Number(state?.done || 0) + skippableSequenceSet().size;
}

async function markSkippableSegment(sequence, verdict = {}) {
  const set = skippableSequenceSet();
  set.add(Number(sequence));
  state.skippableSequences = [...set].sort((a, b) => a - b);
  state.skippableCount = set.size;
  state.segmentSkipVerdicts = { ...(state.segmentSkipVerdicts || {}), [sequence]: { status: "skippable", ...verdict, at: Date.now() } };
  log(t("segmentMarkedSkippable", [sequence, Number(verdict.deltaSeconds || 0).toFixed(2), Number(verdict.expectedSeconds || 0).toFixed(2)], `分片 ${sequence} 可跳过：前后有效片时间轴已连贯（间隔约 ${Number(verdict.deltaSeconds || 0).toFixed(2)}s，播放列表约 ${Number(verdict.expectedSeconds || 0).toFixed(2)}s），不再重试下载。`));
}

function clearSkippableVerdicts(reason = "") {
  if (!state) return false;
  const had = skippableSequenceSet().size > 0 || Object.keys(state.segmentSkipVerdicts || {}).length > 0;
  state.skippableSequences = [];
  state.skippableCount = 0;
  state.segmentSkipVerdicts = {};
  if (had) log(t("skippableVerdictsCleared", reason || "resume", `已清除旧的可跳过结论（${reason || "resume"}），将按当前分片时间轴重新判断。`));
  return had;
}

function timelineBreakSet() {
  return new Set((state?.timelineBreaks || []).map(Number).filter((value) => Number.isFinite(value)));
}

function hasTimelineBreakAt(sequence) {
  return timelineBreakSet().has(Number(sequence));
}

async function adjustTimelineShiftAndContinue(breakSequence, verdict = {}) {
  if (!state) return;
  const sequence = Number(breakSequence);
  if (!Number.isFinite(sequence)) return;
  if (hasTimelineBreakAt(sequence)) return;
  const breaks = timelineBreakSet();
  breaks.add(sequence);
  state.timelineBreaks = [...breaks].sort((a, b) => a - b);
  clearSkippableVerdicts("timeline-shift-adjust");
  state.timelineShift = true;
  state.timelineShiftAt = Date.now();
  state.timelineShiftSequence = sequence;
  state.stalled = false;
  const message = t("timelineShiftAdjusted", [sequence, Number(verdict.deltaSeconds || 0).toFixed(2), verdict.reason || ""], `检测到分片 ${sequence} 接缝处时间轴变化（间隔约 ${Number(verdict.deltaSeconds || 0).toFixed(2)}s，${verdict.reason || ""}）。已在此处标记断点、清除旧可跳过结论，并继续下载。`);
  state.message = message;
  log(message);
  await reclassifySkippableGaps();
  await updateMissingTimeline();
  await mirrorJob();
}

async function checkAdjacentTimeline(segment, decryptedBytes) {
  if (!segment || !mediaPlaylist) return null;
  const sequence = Number(segment.sequence);
  const prev = playlistSegmentBySequence(sequence - 1);
  const next = playlistSegmentBySequence(sequence + 1);
  const headBytes = decryptedBytes
    ? new Uint8Array(decryptedBytes.buffer, decryptedBytes.byteOffset, Math.min(decryptedBytes.byteLength, TS_TIMESTAMP_SAMPLE_BYTES))
    : await readSegmentTimestampSample(sequence, "head");
  const tailBytes = decryptedBytes && decryptedBytes.byteLength > TS_TIMESTAMP_SAMPLE_BYTES
    ? decryptedBytes.subarray(Math.max(0, decryptedBytes.byteLength - TS_TIMESTAMP_SAMPLE_BYTES))
    : (decryptedBytes || await readSegmentTimestampSample(sequence, "tail"));
  const currentHead = headBytes ? WebKeeperMediaEngine.transportTimestamps(headBytes) : null;
  const currentTail = tailBytes ? WebKeeperMediaEngine.transportTimestamps(tailBytes) : null;

  if (prev && !hasTimelineBreakAt(sequence)
    && Number(segment.discontinuity || 0) === Number(prev.discontinuity || 0)) {
    const prevBytes = await readSegmentTimestampSample(sequence - 1, "tail");
    if (prevBytes && currentHead?.ok) {
      const prevTs = WebKeeperMediaEngine.transportTimestamps(prevBytes);
      const verdict = WebKeeperMediaEngine.assessAdjacentSegmentContinuity({
        previousLastPts: prevTs.lastPts,
        nextFirstPts: currentHead.firstPts,
        previousLastPcr: prevTs.lastPcr,
        nextFirstPcr: currentHead.firstPcr,
        previousDurationSeconds: Number(prev.duration || mediaPlaylist.targetDuration || 2),
        playlistDiscontinuity: false
      });
      if (verdict.status === "shifted") {
        await adjustTimelineShiftAndContinue(sequence, verdict);
        return verdict;
      }
    }
  }

  if (next && !hasTimelineBreakAt(Number(next.sequence))
    && Number(next.discontinuity || 0) === Number(segment.discontinuity || 0)) {
    const nextBytes = await readSegmentTimestampSample(sequence + 1, "head");
    if (nextBytes && currentTail?.ok) {
      const nextTs = WebKeeperMediaEngine.transportTimestamps(nextBytes);
      const verdict = WebKeeperMediaEngine.assessAdjacentSegmentContinuity({
        previousLastPts: currentTail.lastPts,
        nextFirstPts: nextTs.firstPts,
        previousLastPcr: currentTail.lastPcr,
        nextFirstPcr: nextTs.firstPcr,
        previousDurationSeconds: Number(segment.duration || mediaPlaylist.targetDuration || 2),
        playlistDiscontinuity: false
      });
      if (verdict.status === "shifted") {
        await adjustTimelineShiftAndContinue(Number(next.sequence), verdict);
        return verdict;
      }
    }
  }
  return null;
}

async function prepareTimelineAfterIdle({ reason = "resume" } = {}) {
  if (!state) return;
  const pausedAt = Number(state.pausedAt || 0);
  const idleFrom = pausedAt || Number(state.updatedAt || 0);
  const idleMs = idleFrom ? Date.now() - idleFrom : 0;
  const longPause = idleMs >= LONG_PAUSE_MS;
  clearSkippableVerdicts(longPause ? "long-pause" : reason);
  state.pausedAt = 0;
  state.timelineShift = false;
  timelineShiftAlertShown = false;
  if (longPause) {
    state.message = t("timelineRecheckAfterPause", Math.round(idleMs / 60000), `已暂停约 ${Math.round(idleMs / 60000)} 分钟。继续下载前已清除旧的可跳过结论，并将检查新旧分片时间轴是否仍对齐；若对不上会自动标记断点并继续。`);
    log(state.message);
  }
  if (mediaPlaylist) {
    await reclassifySkippableGaps();
    await updateMissingTimeline();
  }
}

async function invalidateTinySegment(record, size = 0) {
  if (!record) return;
  try { await dbDelete("segments", record.id); } catch { /* already gone */ }
  log(t("tinySegmentDiscarded", [record.sequence, size || record.size || 0], `分片 ${record.sequence} 只有 ${size || record.size || 0} 字节（小于 ${MIN_SEGMENT_BYTES}），已视为无效并等待重试。`));
}

async function readSegmentTimestampSample(sequence, side = "head") {
  if (!segmentDirectory || sequence == null) return null;
  if (skippableSequenceSet().has(Number(sequence))) return null;
  const record = await dbGet("segments", `${state.id}:${sequence}`);
  if (!record || !isValidSegmentSize(record.size)) return null;
  try {
    const file = await (await segmentDirectory.getFileHandle(record.fileName)).getFile();
    if (!isValidSegmentSize(file.size)) return null;
    if (side === "tail") {
      const start = Math.max(0, file.size - TS_TIMESTAMP_SAMPLE_BYTES);
      return new Uint8Array(await file.slice(start).arrayBuffer());
    }
    return new Uint8Array(await file.slice(0, Math.min(file.size, TS_TIMESTAMP_SAMPLE_BYTES)).arrayBuffer());
  } catch {
    return null;
  }
}

function playlistSegmentBySequence(sequence) {
  return (mediaPlaylist?.segments || []).find((item) => Number(item.sequence) === Number(sequence)) || null;
}

async function classifySkippedSequence(segment) {
  if (!segment || segment.gap) return { status: "unknown", reason: "NOT_A_SEGMENT" };
  const sequence = Number(segment.sequence);
  const cached = state?.segmentSkipVerdicts?.[sequence];
  if (cached?.status === "skippable") return cached;
  const previous = playlistSegmentBySequence(sequence - 1);
  const next = playlistSegmentBySequence(sequence + 1);
  if (!previous || !next) return { status: "unknown", reason: "EDGE_SEGMENT" };
  if (Number(next.discontinuity || 0) !== Number(previous.discontinuity || 0)
    || Number(segment.discontinuity || 0) !== Number(previous.discontinuity || 0)
    || hasTimelineBreakAt(sequence)
    || hasTimelineBreakAt(sequence + 1)) {
    return { status: "unknown", reason: "DISCONTINUITY" };
  }
  const prevBytes = await readSegmentTimestampSample(sequence - 1, "tail");
  const nextBytes = await readSegmentTimestampSample(sequence + 1, "head");
  if (!prevBytes || !nextBytes) return { status: "unknown", reason: "NEIGHBOR_MISSING" };
  const prevTs = WebKeeperMediaEngine.transportTimestamps(prevBytes);
  const nextTs = WebKeeperMediaEngine.transportTimestamps(nextBytes);
  if (!prevTs.ok || !nextTs.ok) return { status: "unknown", reason: "NO_TIMESTAMPS" };
  return WebKeeperMediaEngine.assessSkippedSegmentContinuity({
    previousLastPts: prevTs.lastPts,
    nextFirstPts: nextTs.firstPts,
    previousLastPcr: prevTs.lastPcr,
    nextFirstPcr: nextTs.firstPcr,
    expectedDurationSeconds: Number(segment.duration || mediaPlaylist?.targetDuration || 2)
  });
}

async function maybeMarkSkippable(segment, { tinySize = null } = {}) {
  const verdict = await classifySkippedSequence(segment);
  state.segmentSkipVerdicts = { ...(state.segmentSkipVerdicts || {}), [segment.sequence]: { ...verdict, tinySize, at: Date.now() } };
  if (verdict.status === "skippable") {
    await markSkippableSegment(segment.sequence, verdict);
    return verdict;
  }
  if (tinySize != null) {
    log(t("tinySegmentNeedsRetry", [segment.sequence, tinySize, verdict.reason || ""], `分片 ${segment.sequence} 只有 ${tinySize} 字节，且前后片时间轴不连贯（${verdict.reason || "unknown"}），需要重试下载。`));
  }
  return verdict;
}

async function reclassifySkippableGaps() {
  if (!mediaPlaylist || !state || skippableClassifyRunning) return;
  skippableClassifyRunning = true;
  try {
    const records = (await listSegmentRecords(state.id)).filter((item) => item.kind !== "dash" && isValidSegmentSize(item.size));
    const saved = new Set(records.map((item) => Number(item.sequence)));
    const skippable = skippableSequenceSet();
    let changed = false;
    for (const segment of mediaPlaylist.segments) {
      if (segment.gap || saved.has(Number(segment.sequence)) || skippable.has(Number(segment.sequence))) continue;
      if (!saved.has(Number(segment.sequence) - 1) || !saved.has(Number(segment.sequence) + 1)) continue;
      const verdict = await classifySkippedSequence(segment);
      if (verdict.status === "skippable") {
        await markSkippableSegment(segment.sequence, verdict);
        skippable.add(Number(segment.sequence));
        changed = true;
      } else {
        state.segmentSkipVerdicts = { ...(state.segmentSkipVerdicts || {}), [segment.sequence]: { ...verdict, at: Date.now() } };
      }
    }
    if (changed) await updateMissingTimeline();
  } finally {
    skippableClassifyRunning = false;
  }
}

async function savedSegment(sequence) {
  if (skippableSequenceSet().has(Number(sequence))) return { skipped: true, sequence: Number(sequence) };
  const record = await dbGet("segments", `${state.id}:${sequence}`);
  if (!record || !segmentDirectory) return null;
  try {
    const handle = await segmentDirectory.getFileHandle(record.fileName);
    const file = await handle.getFile();
    if (isValidSegmentSize(file.size)) return { ...record, size: file.size };
    const meta = playlistSegmentBySequence(sequence) || { sequence, duration: mediaPlaylist?.targetDuration || 2 };
    const verdict = await maybeMarkSkippable(meta, { tinySize: file.size });
    await invalidateTinySegment(record, file.size);
    if (verdict.status === "skippable") return { skipped: true, sequence: Number(sequence) };
    return null;
  } catch {
    return null;
  }
}

function base64ToArrayBuffer(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

async function ensurePageCaptureHook(tabId, { announce = false } = {}) {
  if (!(Number(tabId) >= 0)) return false;
  if (!announce && Date.now() - lastHookInjectionAt < 10000) return false;
  lastHookInjectionAt = Date.now();
  try {
    await chrome.scripting.executeScript({ target: { tabId: Number(tabId), allFrames: true }, world: "MAIN", files: ["page-capture.js"] });
    if (announce) log("已在网页中开启播放数据直取，播放器收到的分片会被直接保留");
    return true;
  } catch (error) {
    if (announce) log(`网页数据直取暂不可用：${error.message}`);
    return false;
  }
}

async function stopPageCaptureHook(tabId) {
  if (!(Number(tabId) >= 0)) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: Number(tabId), allFrames: true },
      world: "MAIN",
      func: () => { window.__webKeeperCapture?.stop(); }
    });
  } catch { /* tab already gone */ }
}

async function takeBufferedSegment(tabId, url, { waitMs = 0 } = {}) {
  if (!(Number(tabId) >= 0)) return null;
  const deadline = Date.now() + Math.max(0, waitMs);
  for (;;) {
    const bytes = await readBufferedSegment(tabId, url);
    if (bytes) return bytes;
    if (paused || Date.now() >= deadline) return null;
    await waitFor(250);
  }
}

async function readBufferedSegment(tabId, url) {
  if (!(Number(tabId) >= 0)) return null;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: Number(tabId), allFrames: true },
      world: "MAIN",
      args: [url],
      func: (target) => {
        const api = window.__webKeeperCapture;
        if (!api) return { hook: false };
        const bytes = api.take(target);
        if (!bytes) return { hook: true };
        let binary = "";
        for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
        return { hook: true, data: btoa(binary) };
      }
    });
    const frames = (results || []).map((item) => item?.result).filter(Boolean);
    const hit = frames.find((item) => item.data);
    if (hit) return base64ToArrayBuffer(hit.data);
    if (!frames.some((item) => item.hook)) void ensurePageCaptureHook(tabId);
    return null;
  } catch {
    return null;
  }
}

async function fetchSegmentInPage(tabId, url, byteRange = "") {
  if (!(Number(tabId) >= 0)) return null;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: Number(tabId) },
      args: [url, byteRangeHeader(byteRange) || ""],
      func: async (target, range) => {
        try {
          const response = await fetch(target, {
            credentials: "include",
            cache: range ? "no-store" : "force-cache",
            headers: range ? { range } : {}
          });
          if (!response.ok || (range && response.status !== 206)) return { ok: false, status: response.status };
          const bytes = new Uint8Array(await response.arrayBuffer());
          let binary = "";
          for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
          return { ok: true, data: btoa(binary) };
        } catch (error) {
          return { ok: false, reason: String(error?.message || error) };
        }
      }
    });
    const result = results?.[0]?.result;
    if (!result?.ok) return null;
    return base64ToArrayBuffer(result.data);
  } catch {
    return null;
  }
}

async function saveSegment(segment, observedHeaders = {}, options = {}) {
  const existing = await savedSegment(segment.sequence);
  if (existing) return existing;
  const encrypted = await fetchMediaBytes(segment.url, { byteRange: segment.byteRange, headers: observedHeaders, ...options });
  if (encrypted.byteLength < 16) throw new Error(t("downloadedItemInvalid", segment.sequence, `下载到的第 ${segment.sequence} 项内容异常。`));
  const decrypted = await decryptIfNeeded(segment, encrypted);
  if (!isValidSegmentSize(decrypted.byteLength)) {
    const verdict = await maybeMarkSkippable(segment, { tinySize: decrypted.byteLength });
    await updateMissingTimeline();
    await mirrorJob();
    if (verdict.status === "skippable") return { skipped: true, sequence: segment.sequence, verdict };
    throw new Error(t("downloadedItemTooSmall", [segment.sequence, decrypted.byteLength], `下载到的第 ${segment.sequence} 项只有 ${decrypted.byteLength} 字节，小于有效分片下限 ${MIN_SEGMENT_BYTES}，已忽略。`));
  }
  const fileName = segmentFileName(segment);
  await writeFile(segmentDirectory, fileName, decrypted);
  const record = { id: `${state.id}:${segment.sequence}`, jobId: state.id, sequence: segment.sequence, fileName, size: decrypted.byteLength, url: segment.url, savedAt: Date.now() };
  await dbPut("segments", record);
  state.done = Number(state.done || 0) + 1;
  state.bytes = Number(state.bytes || 0) + decrypted.byteLength;
  const decryptedView = decrypted instanceof Uint8Array ? decrypted : new Uint8Array(decrypted);
  await checkAdjacentTimeline(segment, decryptedView);
  await reclassifySkippableGaps();
  await updateMissingTimeline();
  await mirrorJob();
  return record;
}

async function savedRecordDirectory(record, cache) {
  const kind = record.kind || "hls";
  if (!["dash", "hls-cmaf"].includes(kind)) return segmentDirectory;
  const key = `${kind}:${record.trackId}`;
  if (cache.has(key)) return cache.get(key);
  let directory = null;
  try {
    const parent = await workDirectory.getDirectoryHandle(kind === "dash" ? "dash" : "hls-tracks");
    directory = await parent.getDirectoryHandle(safeName(`${record.contentType}_${record.trackId}`));
  } catch { directory = null; }
  cache.set(key, directory);
  return directory;
}

async function reconcileSaved() {
  if (state.status === "complete") {
    await mirrorJob();
    return;
  }
  if (state.providerId === "direct-file") {
    try {
      const handle = await workDirectory.getFileHandle(state.outputName);
      state.bytes = (await handle.getFile()).size;
    } catch (error) {
      if (error.name !== "NotFoundError") throw error;
      if (!state.browserDownloadId) state.bytes = 0;
    }
    await mirrorJob();
    return;
  }
  const records = await listSegmentRecords(state.id);
  const directories = new Map();
  let count = 0;
  let bytes = 0;
  for (const record of records) {
    try {
      const directory = await savedRecordDirectory(record, directories);
      if (!directory) continue;
      const handle = await directory.getFileHandle(record.fileName);
      const file = await handle.getFile();
      if (record.kind === "dash" || record.kind === "hls-cmaf") {
        if (file.size > 0) { count += 1; bytes += file.size; }
      } else if (isValidSegmentSize(file.size)) {
        count += 1;
        bytes += file.size;
        if (Number(record.size || 0) !== file.size) await dbPut("segments", { ...record, size: file.size });
      } else {
        const meta = playlistSegmentBySequence(record.sequence) || { sequence: record.sequence, duration: mediaPlaylist?.targetDuration || 2 };
        await maybeMarkSkippable(meta, { tinySize: file.size });
        await invalidateTinySegment(record, file.size);
      }
    } catch { /* ledger entry without file */ }
  }
  state.done = count;
  state.bytes = bytes;
  await reclassifySkippableGaps();
  await updateMissingTimeline();
  await mirrorJob();
}

async function updateMissingTimeline() {
  if (!mediaPlaylist) return [];
  const records = (await listSegmentRecords(state.id)).filter((item) => item.kind !== "dash" && isValidSegmentSize(item.size));
  const saved = new Set(records.map((item) => item.sequence));
  const skippable = skippableSequenceSet();
  state.skippableCount = skippable.size;
  state.missingRanges = WebKeeperMediaEngine.missingTimeline(mediaPlaylist.segments, saved, skippable);
  state.missing = state.missingRanges.reduce((sum, range) => sum + range.count, 0);
  return state.missingRanges;
}

async function browserVideoMetadata(file, timeoutMs = 12000) {
  const objectUrl = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.preload = "metadata";
  video.muted = true;
  video.playsInline = true;
  try {
    return await new Promise((resolve) => {
      const finish = (result) => { clearTimeout(timer); video.removeAttribute("src"); video.load(); resolve(result); };
      const timer = setTimeout(() => finish(null), timeoutMs);
      video.addEventListener("loadedmetadata", () => finish({ width: video.videoWidth, height: video.videoHeight, duration: video.duration }), { once: true });
      video.addEventListener("error", () => finish(null), { once: true });
      video.src = objectUrl;
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function inspectSavedFile(file) {
  const headSize = Math.min(file.size, 4 * 1024 * 1024);
  const head = new Uint8Array(await file.slice(0, headSize).arrayBuffer());
  let inspection = WebKeeperMediaEngine.inspectMediaBytes(head);
  if (inspection.container === "mp4" && !inspection.trackTypes.length && file.size > headSize) {
    const tailSize = Math.min(file.size, 8 * 1024 * 1024);
    const tail = new Uint8Array(await file.slice(file.size - tailSize).arrayBuffer());
    for (let index = 4; index + 4 <= tail.byteLength; index += 1) {
      if (tail[index] !== 0x6d || tail[index + 1] !== 0x6f || tail[index + 2] !== 0x6f || tail[index + 3] !== 0x76) continue;
      const start = index - 4;
      const size = new DataView(tail.buffer, tail.byteOffset, tail.byteLength).getUint32(start);
      if (size >= 8 && start + size <= tail.byteLength) {
        const trackTypes = WebKeeperMediaEngine.mp4TrackTypes(tail.subarray(start, start + size));
        if (trackTypes.length) inspection = { ...inspection, hasVideo: trackTypes.includes("video"), hasAudio: trackTypes.includes("audio"), trackTypes };
        break;
      }
    }
  }
  return inspection;
}

async function validateSavedVideo(fileHandle) {
  const file = await fileHandle.getFile();
  if (file.size < 4096) throw new Error(t("savedFileTooSmall", formatBytes(file.size), `下载结果只有 ${formatBytes(file.size)}，不像完整视频。`));
  const inspection = await inspectSavedFile(file);
  if (inspection.container === "document") throw new Error(t("downloadReturnedDocument", null, "网站返回了网页或错误信息，而不是视频数据。"));
  if (inspection.hasVideo === true) return inspection;
  if (inspection.hasAudio === true && inspection.hasVideo === false) throw new Error(t("videoTrackMissing", null, "检测到的内容只有音频轨，没有视频画面。请重新播放网页后选择完整视频，或改用网页辅助抓取。"));
  const metadata = await browserVideoMetadata(file);
  if (metadata?.width > 0 && metadata?.height > 0) return { ...inspection, metadata };
  throw new Error(t("videoValidationFailed", null, "下载内容未通过视频轨检查，已保留文件和任务，但不会标记为完成或清理临时内容。"));
}

async function waitForBrowserDownload(downloadId) {
  const current = await chrome.downloads.search({ id: downloadId });
  if (current[0]?.state === "complete") return current[0];
  if (current[0]?.state === "interrupted") throw new Error(current[0].error || "interrupted");
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error("Browser download timed out")), 30 * 60 * 1000);
    const listener = (delta) => {
      if (delta.id !== downloadId) return;
      if (delta.error?.current) finish(new Error(delta.error.current));
      else if (delta.state?.current === "interrupted") finish(new Error("interrupted"));
      else if (delta.state?.current === "complete") finish(null, delta);
    };
    const finish = (error, value) => {
      clearTimeout(timeout);
      chrome.downloads.onChanged.removeListener(listener);
      if (error) reject(error); else resolve(value);
    };
    chrome.downloads.onChanged.addListener(listener);
  });
}

async function publishSavedFile(fileHandle, fileName, { removeInternal = false, sourceDirectory = workDirectory, trackAsOutput = true } = {}) {
  if (saveDestination !== "browser-downloads") return null;
  if (trackAsOutput) {
    state.status = "exporting";
    state.message = t("exportingToDownloads", null, "正在把已验证的视频交给浏览器，保存到 Downloads。");
    await mirrorJob();
  }
  const file = await fileHandle.getFile();
  const objectUrl = URL.createObjectURL(file);
  try {
    const downloadId = await chrome.downloads.download({ url: objectUrl, filename: safeName(fileName), conflictAction: "uniquify", saveAs: false });
    await waitForBrowserDownload(downloadId);
    if (trackAsOutput) state.browserDownloadId = downloadId;
    if (removeInternal) {
      await sourceDirectory.removeEntry(fileName);
      if (trackAsOutput) state.outputInternalDeleted = true;
    }
    return downloadId;
  } catch (error) {
    throw new Error(t("browserDownloadFailed", error.message, `浏览器未能保存成品：${error.message}`));
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function runDirectFile() {
  paused = false;
  await ensureDirectories();
  const selectedFile = WebKeeperMediaEngine.directFile(candidate);
  const url = selectedFile?.url || "";
  if (!url) throw new Error(t("directFileUrlMissing", null, "没有找到这个文件的下载地址，请回到网页重新播放后再试。"));
  const extension = WebKeeperMediaEngine.extensionForCandidate(candidate, "mp4");
  const suppliedName = safeName(selectedFile?.fileName || "", "");
  const outputName = state.outputName || (suppliedName && /\.[a-z0-9]{2,5}$/i.test(suppliedName) ? suppliedName : `${safeName(suppliedName || state.title || state.product || "video")}.${extension}`);
  const outputHandle = await workDirectory.getFileHandle(outputName, { create: true });
  const existing = await outputHandle.getFile();
  let offset = existing.size;
  state.providerId = "direct-file";
  state.progressUnit = "bytes";
  state.outputName = outputName;
  state.bytes = offset;
  state.done = 0;
  state.total = 1;
  state.status = "downloading";
  state.message = t("directFileWorking", null, "正在直接保存视频文件。中断后可以从已经写入的位置继续。");
  await mirrorJob();

  let writable = null;
  let lastCheckpoint = Date.now();
  activeController = new AbortController();
  activeControllers.add(activeController);
  try {
    const extraHeaders = offset ? { range: `bytes=${offset}-` } : {};
    let response = await fetch(url, {
      method: "GET", headers: allowedHeaders({ ...(candidate.headers || {}), ...(selectedFile?.headers || {}) }, extraHeaders),
      credentials: "include", cache: "no-store", signal: activeController.signal
    });
    if (response.status === 416 && offset) {
      const totalFromRange = Number(response.headers.get("content-range")?.match(/\*\/(\d+)/)?.[1] || 0);
      if (totalFromRange && offset === totalFromRange) {
        state.totalBytes = totalFromRange;
        state.bytes = offset;
        state.done = 1;
        await validateSavedVideo(outputHandle);
        state.validationVersion = 1;
        await publishSavedFile(outputHandle, outputName, { removeInternal: true });
        await saveSubtitles({ automatic: true });
        state.status = "complete";
        state.message = t("directFileComplete", outputName, `视频已保存为 ${outputName}。`);
        await mirrorJob();
        return;
      }
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (offset && response.status !== 206) {
      offset = 0;
      state.bytes = 0;
    }
    const contentRangeTotal = Number(response.headers.get("content-range")?.match(/\/(\d+)$/)?.[1] || 0);
    const contentLength = Number(response.headers.get("content-length") || 0);
    state.totalBytes = contentRangeTotal || (contentLength ? offset + contentLength : 0);
    writable = await outputHandle.createWritable({ keepExistingData: offset > 0 });
    if (offset) await writable.seek(offset);
    const reader = response.body?.getReader();
    if (!reader) throw new Error(t("requestFailed", null, "请求失败"));
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await writable.write(value);
      state.bytes += value.byteLength;
      if (Date.now() - lastCheckpoint >= 1000) {
        lastCheckpoint = Date.now();
        await mirrorJob();
      }
    }
    await writable.close();
    writable = null;
    if (state.totalBytes && state.bytes < state.totalBytes) throw new Error(`${t("requestFailed", null, "请求失败")} (${formatBytes(state.bytes)} / ${formatBytes(state.totalBytes)})`);
    await validateSavedVideo(outputHandle);
    state.validationVersion = 1;
    await publishSavedFile(outputHandle, outputName, { removeInternal: true });
    state.done = 1;
    state.totalBytes ||= state.bytes;
    state.errorCode = "";
    await saveSubtitles({ automatic: true });
    state.status = "complete";
    state.message = t("directFileComplete", outputName, `视频已保存为 ${outputName}。`);
    log(state.message);
    await mirrorJob();
  } catch (error) {
    if (writable) {
      try { await writable.close(); } catch { /* keep last committed file */ }
    }
    if (paused || error.name === "AbortError") {
      state.status = "paused";
      state.message = t("taskPausedMessage", null, "下载已暂停，已经保存的内容不会删除。");
    } else {
      state.status = "error";
      state.errorCode = WebKeeperMediaEngine.classifyMediaError(error);
      state.message = t("recoverableDownloadError", error.message, `${error.message} 已保存的内容不会删除，可以回到网页刷新后继续。`);
    }
    await mirrorJob();
  } finally {
    if (activeController) activeControllers.delete(activeController);
    activeController = null;
  }
}

async function runHlsDirect() {
  paused = false;
  state.providerId = "hls";
  state.progressUnit = "items";
  await ensureDirectories();
  await reconcileSaved();
  await prepareTimelineAfterIdle({ reason: "direct-start" });
  state.status = "downloading";
  state.message = t("directDownloadWorking", null, "正在获取视频内容并保存未完成的部分。可以把此页面留在后台，但请不要关闭浏览器。");
  await mirrorJob();
  startProgressWatchdog();
  try {
    const knownSegments = new Map();
    let stalledRounds = 0;
    while (!paused) {
      const playlist = await loadMediaPlaylist();
      if (hlsAudioPlaylist) {
        const isCmaf = !playlist.isLive && !hlsAudioPlaylist.isLive && playlist.map?.url && hlsAudioPlaylist.map?.url
          && [...playlist.segments, ...hlsAudioPlaylist.segments].every((item) => /\.(?:m4s|mp4|cmfv|cmfa)(?:[?#]|$)/i.test(item.url));
        if (!isCmaf) {
          const error = new Error(t("hlsSeparateTracksUnsupported", null, "这个 HLS 视频使用当前无法在浏览器内可靠合并的独立音轨，请确认改用网页辅助。"));
          error.code = "SEPARATE_TRACKS";
          throw error;
        }
        await runHlsSeparatedCmaf(playlist, hlsAudioPlaylist);
        return;
      }
      await writeFile(workDirectory, "source.m3u8", playlist.text);
      for (const segment of playlist.segments) knownSegments.set(segment.sequence, segment);
      mediaPlaylist = { ...playlist, segments: [...knownSegments.values()].sort((a, b) => a.sequence - b.sequence) };
      state.total = mediaPlaylist.segments.filter((item) => !item.gap).length;
      let savedThisRound = 0;
      const pendingSegments = [];
      for (const segment of playlist.segments) {
        if (paused) return;
        if (segment.gap || await savedSegment(segment.sequence)) continue;
        pendingSegments.push(segment);
      }
      await mapConcurrent(pendingSegments, playlist.isLive ? Math.min(2, directConcurrency) : directConcurrency, async (segment) => {
        log(`下载分片 ${segment.sequence}`);
        await saveSegment(segment);
        savedThisRound += 1;
      });
      if (playlist.endList || !playlist.isLive) break;
      stalledRounds = savedThisRound ? 0 : stalledRounds + 1;
      if (stalledRounds >= 5) {
        state.status = "waiting";
        state.errorCode = "PLAYLIST_STALLED";
        state.stalled = true;
        state.message = t("directStalled", null, "直接下载暂时没有新内容。你可以稍后继续，或确认改用网页辅助。");
        await mirrorJob();
        if (!stallAlertShown) {
          stallAlertShown = true;
          alert(t("stallDirectAlert", Math.round(STALL_WARN_MS / 1000), `进度已约 ${Math.round(STALL_WARN_MS / 1000)} 秒没有增加。可稍后继续，或改用网页辅助。`));
        }
        stopProgressWatchdog();
        return;
      }
      state.message = t("liveWaiting", null, "正在等待网站发布后续内容，已经保存的部分不会丢失。");
      await mirrorJob();
      await waitFor(Math.max(1500, Math.min(8000, Number(playlist.targetDuration || 4) * 750)));
    }
    if (paused) return;
    await reclassifySkippableGaps();
    await updateMissingTimeline();
    if (Number(state.missing || 0) > 0 && coveredSegmentCount() < Number(state.total || 0)) {
      state.status = "waiting";
      state.message = t("remainingCount", state.missing, `仍有 ${state.missing} 项待补。`);
      await mirrorJob();
      return;
    }
    state.errorCode = "";
    state.stalled = false;
    state.message = t("allContentSaved", null, "视频内容已全部保存，正在生成可播放文件。");
    await mirrorJob();
    if (autoFinalize) await mergeOutput(false);
    else {
      state.status = "downloaded";
      state.message = t("readyToCreateMessage", null, "下载内容完整，等待你手动生成视频。");
      await mirrorJob();
    }
  } catch (error) {
    if (paused) return;
    state.status = "error";
    state.errorCode = WebKeeperMediaEngine.classifyMediaError(error);
    state.message = t("recoverableDownloadError", error.message, `${error.message} 已保存的内容不会删除，可以回到网页刷新后继续。`);
    log(`失败：${error.message}`);
    await mirrorJob();
  } finally {
    if (!["downloading", "capturing", "waiting"].includes(state?.status) || paused) stopProgressWatchdog();
  }
}

function dashRecordId(trackId, index) {
  return `${state.id}:dash:${trackId}:${index}`;
}

function dashPartName(index, url) {
  const extension = WebKeeperMediaEngine.extensionFromUrl(url, "m4s");
  return `${String(index).padStart(8, "0")}.${safeName(extension, "m4s")}`;
}

async function dashTrackDirectory(dashDirectory, track) {
  return dashDirectory.getDirectoryHandle(safeName(`${track.contentType}_${track.id}`), { create: true });
}

async function fetchMediaBytes(url, { byteRange = "", headers = {}, pageTabId = null, cacheMode = "no-store", preferPageBuffer = false } = {}) {
  if (preferPageBuffer && !byteRange && pageTabId != null) {
    // A URL that already consumed a full wait was most likely cancelled by the player, so never wait for it twice.
    const waitMs = pageBufferGaveUp.has(url) ? 0 : pageBufferWaitMs;
    const buffered = await takeBufferedSegment(pageTabId, url, { waitMs });
    if (buffered) {
      pageBufferMisses = 0;
      pageBufferWaitMs = PAGE_BUFFER_WAIT_PROVEN_MS;
      pageBufferGaveUp.delete(url);
      state.fromPageBuffer = Number(state.fromPageBuffer || 0) + 1;
      if (state.fromPageBuffer === 1) log("正在直接使用播放器已经收到的数据，不再重新请求这些分片");
      return buffered;
    }
    if (waitMs) {
      pageBufferMisses += 1;
      pageBufferGaveUp.add(url);
      if (pageBufferGaveUp.size > 300) pageBufferGaveUp.delete(pageBufferGaveUp.values().next().value);
      if (!Number(state.fromPageBuffer || 0) && pageBufferMisses >= 3) {
        pageBufferWaitMs = 0;
        log("网页数据直取一直没有命中，先改回由任务页重新请求；之后命中会自动恢复等待");
      }
    }
  }
  try {
    const response = await fetchResponse(url, { byteRange, headers, cacheMode });
    return await consumeResponse(response, "arrayBuffer");
  } catch (error) {
    if (paused || pageTabId == null) throw error;
    const fromPage = await fetchSegmentInPage(pageTabId, url, byteRange);
    if (!fromPage) throw error;
    log(`任务页请求失败（${error.message}），改由原网页会话取得 ${url}`);
    return fromPage;
  }
}

async function saveDashInitialization(directory, track, options = {}) {
  if (!track.initializationUrl) throw new Error(t("dashInitMissing", null, "这个视频没有提供可用的轨道初始化信息。"));
  const handle = await directory.getFileHandle("init.mp4", { create: true });
  const existing = await handle.getFile();
  if (existing.size > 0 && !track.initializationKey) return existing.size;
  let bytes = await fetchMediaBytes(track.initializationUrl, { byteRange: track.initializationByteRange || "", ...options });
  if (!bytes.byteLength) throw new Error(t("downloadedItemInvalid", 0, "下载到的媒体初始化内容异常。"));
  if (track.initializationKey) {
    if (!track.initializationKey.iv) throw new Error(t("hlsMapIvRequired"));
    bytes = await decryptIfNeeded({ key: track.initializationKey, sequence: 0 }, bytes);
  }
  await writeFile(directory, "init.mp4", bytes);
  return bytes.byteLength;
}

async function saveDashSegment(directory, track, segment, index, options = {}) {
  const recordKind = track.recordKind || "dash";
  const id = recordKind === "dash" ? dashRecordId(track.id, index) : `${state.id}:${recordKind}:${track.id}:${index}`;
  const existingRecord = await dbGet("segments", id);
  if (existingRecord) {
    try {
      const handle = await directory.getFileHandle(existingRecord.fileName);
      const file = await handle.getFile();
      if (file.size > 0) return existingRecord;
    } catch { /* retry missing file */ }
  }
  let bytes = await fetchMediaBytes(segment.url, { byteRange: segment.byteRange || "", ...options });
  if (!bytes.byteLength) throw new Error(t("downloadedItemInvalid", index + 1, `下载到的第 ${index + 1} 项内容异常。`));
  if (segment.key) bytes = await decryptIfNeeded(segment, bytes);
  const fileName = dashPartName(index, segment.url);
  await writeFile(directory, fileName, bytes);
  const record = {
    id, jobId: state.id, kind: recordKind, trackId: track.id, contentType: track.contentType,
    index, sequence: segment.sequence, fileName, size: bytes.byteLength, url: segment.url,
    startSeconds: segment.startSeconds || 0, endSeconds: segment.endSeconds || 0, savedAt: Date.now()
  };
  await dbPut("segments", record);
  state.done = Number(state.done || 0) + 1;
  state.bytes = Number(state.bytes || 0) + bytes.byteLength;
  await mirrorJob();
  return record;
}

async function reconcileDashSaved(dashDirectory, tracks) {
  const recordKind = tracks[0]?.recordKind || "dash";
  const records = (await listSegmentRecords(state.id)).filter((item) => item.kind === recordKind);
  const trackMap = new Map(tracks.map((track) => [track.id, track]));
  let done = 0;
  let bytes = 0;
  for (const record of records) {
    const track = trackMap.get(record.trackId);
    if (!track) continue;
    try {
      const directory = await dashTrackDirectory(dashDirectory, track);
      const file = await (await directory.getFileHandle(record.fileName)).getFile();
      if (file.size > 0) { done += 1; bytes += file.size; }
    } catch { /* ledger entry without file */ }
  }
  state.done = done;
  state.bytes = bytes;
  await mirrorJob();
}

async function mergeDashOutput(dashDirectory, tracks) {
  state.status = "merging";
  state.message = t("dashMerging", null, "视频和音频已下载，正在生成一个可播放文件。");
  await mirrorJob();
  const trackDirectories = new Map();
  for (const track of tracks) trackDirectories.set(track.id, await dashTrackDirectory(dashDirectory, track));
  const video = tracks.find((track) => track.contentType === "video") || null;
  const audio = tracks.find((track) => track.contentType === "audio") || null;
  if (!video) throw new Error(t("videoTrackMissing", null, "检测到的内容只有音频轨，没有视频画面。请重新播放网页后选择完整视频，或改用网页辅助抓取。"));
  const mainTrack = video || audio;
  const outputName = `${preferredOutputBaseName()}.${video ? "mp4" : "m4a"}`;
  const outputHandle = await workDirectory.getFileHandle(outputName, { create: true });
  const writable = await outputHandle.createWritable();
  try {
    const initBytes = new Map();
    for (const track of tracks) initBytes.set(track.id, new Uint8Array(await (await (await trackDirectories.get(track.id).getFileHandle("init.mp4")).getFile()).arrayBuffer()));
    let audioTrackMapping = null;
    if (video && audio) {
      audioTrackMapping = WebKeeperMediaEngine.mergeCmafInitializations(initBytes.get(video.id), initBytes.get(audio.id));
      await writable.write(WebKeeperMediaEngine.patchMp4InitDuration(audioTrackMapping.bytes, state.duration));
    } else {
      await writable.write(WebKeeperMediaEngine.patchMp4InitDuration(initBytes.get(mainTrack.id), state.duration));
    }
    const recordKind = tracks[0]?.recordKind || "dash";
    const records = (await listSegmentRecords(state.id)).filter((item) => item.kind === recordKind && tracks.some((track) => track.id === item.trackId));
    records.sort((a, b) => Number(a.startSeconds || 0) - Number(b.startSeconds || 0)
      || (a.contentType === "video" ? 0 : 1) - (b.contentType === "video" ? 0 : 1)
      || a.index - b.index);
    for (const record of records) {
      const directory = trackDirectories.get(record.trackId);
      const file = await (await directory.getFileHandle(record.fileName)).getFile();
      let bytes = new Uint8Array(await file.arrayBuffer());
      if (audioTrackMapping && record.trackId === audio.id) {
        bytes = WebKeeperMediaEngine.patchCmafFragmentTrackId(bytes, audioTrackMapping.oldAudioTrackId, audioTrackMapping.audioTrackId);
      }
      await writable.write(bytes);
    }
    await writable.close();
    await validateSavedVideo(outputHandle);
    state.validationVersion = 1;
    state.outputName = outputName;
    await publishSavedFile(outputHandle, outputName, { removeInternal: true });
    await saveSubtitles({ automatic: true });
    state.status = "complete";
    state.validationVersion = 1;
    if (state.mode === "browser-assisted") await stopPageCaptureHook(candidate.tabId);
    state.message = t("dashComplete", outputName, `视频已保存为 ${outputName}。`);
    await mirrorJob();
    if (cleanupAfterMerge) {
      await removeTemporaryData();
      state.temporaryCleaned = true;
      state.message = t("outputCompleteAndCleaned", outputName, `已生成并检查 ${outputName}，临时切片已自动清理。`);
      await mirrorJob();
    }
  } catch (error) {
    try { await writable.abort(); } catch { /* no partial output to keep */ }
    throw error;
  }
}

async function runHlsSeparatedCmaf(videoPlaylist, audioPlaylist) {
  state.separateTracks = true;
  const tracks = [
    { id: "hls-video", contentType: "video", initializationUrl: videoPlaylist.map.url, initializationByteRange: videoPlaylist.map.byteRange || "", initializationKey: videoPlaylist.map.key || null, segments: videoPlaylist.segments.filter((item) => !item.gap), recordKind: "hls-cmaf" },
    { id: "hls-audio", contentType: "audio", initializationUrl: audioPlaylist.map.url, initializationByteRange: audioPlaylist.map.byteRange || "", initializationKey: audioPlaylist.map.key || null, segments: audioPlaylist.segments.filter((item) => !item.gap), recordKind: "hls-cmaf" }
  ];
  state.total = tracks.reduce((sum, track) => sum + track.segments.length, 0);
  state.duration = Math.max(videoPlaylist.duration || 0, audioPlaylist.duration || 0);
  const directory = await workDirectory.getDirectoryHandle("hls-tracks", { create: true });
  await reconcileDashSaved(directory, tracks);
  const items = [];
  for (const track of tracks) {
    const trackDirectory = await dashTrackDirectory(directory, track);
    await saveDashInitialization(trackDirectory, track);
    for (const [index, segment] of track.segments.entries()) items.push({ track, trackDirectory, segment, index });
  }
  await mapConcurrent(items, directConcurrency, ({ track, trackDirectory, segment, index }) => saveDashSegment(trackDirectory, track, segment, index));
  if (autoFinalize) await mergeDashOutput(directory, tracks);
  else {
    state.status = "downloaded";
    state.message = t("readyToCreateMessage", null, "下载内容完整，等待你手动生成视频。");
    await mirrorJob();
  }
}

async function runDashDirect() {
  paused = false;
  state.providerId = "dash";
  state.progressUnit = "items";
  await ensureDirectories();
  const manifestUrl = candidate.manifestUrl || (/\.mpd(?:[?#]|$)/i.test(candidate.lastUrl || "") ? candidate.lastUrl : "");
  if (!manifestUrl) throw new Error(t("dashManifestMissing", null, "尚未找到完整的 DASH 视频信息，请回到网页播放几秒后重试。"));
  state.status = "downloading";
  state.message = t("dashWorking", null, "正在下载视频与音频轨道，已完成的部分可以断点继续。");
  await mirrorJob();
  startProgressWatchdog();
  try {
    const text = await fetchText(manifestUrl);
    const manifest = WebKeeperMediaEngine.parseDashManifest(text, manifestUrl);
    if (manifest.drm) throw new Error(t("drmUnsupported", null, "这个视频受 DRM 保护，Web Keeper 不会尝试绕过网站的访问控制。"));
    adoptDashSubtitles(manifest);
    const tracks = WebKeeperMediaEngine.selectDashTracks(manifest, targetHeight(candidate.resolution));
    if (!tracks.length || tracks.some((track) => !track.segments.length)) throw new Error(t("dashNoTracks", null, "没有找到可直接保存的 DASH 音视频轨道。"));
    state.resolution = tracks.find((track) => track.contentType === "video")?.height ? `${tracks.find((track) => track.contentType === "video").height}p` : state.resolution;
    state.total = tracks.reduce((sum, track) => sum + track.segments.length, 0);
    state.duration = manifest.duration || 0;
    state.selectedTracks = tracks.map((track) => ({ id: track.id, contentType: track.contentType, codecs: track.codecs, bandwidth: track.bandwidth, segmentCount: track.segments.length }));
    const dashDirectory = await workDirectory.getDirectoryHandle("dash", { create: true });
    await reconcileDashSaved(dashDirectory, tracks);
    const items = [];
    for (const track of tracks) {
      if (paused) return;
      const directory = await dashTrackDirectory(dashDirectory, track);
      await saveDashInitialization(directory, track);
      for (const [index, segment] of track.segments.entries()) items.push({ track, directory, segment, index });
    }
    await mapConcurrent(items, directConcurrency, ({ track, directory, segment, index }) => saveDashSegment(directory, track, segment, index));
    if (autoFinalize) await mergeDashOutput(dashDirectory, tracks);
    else {
      state.status = "downloaded";
      state.message = t("readyToCreateMessage", null, "下载内容完整，等待你手动生成视频。");
      await mirrorJob();
    }
  } catch (error) {
    if (paused) return;
    state.status = "error";
    state.errorCode = WebKeeperMediaEngine.classifyMediaError(error);
    state.message = t("recoverableDownloadError", error.message, `${error.message} 已保存的内容不会删除，可以回到网页刷新后继续。`);
    log(`DASH: ${error.message}`);
    await mirrorJob();
  } finally {
    if (!["downloading", "capturing", "waiting"].includes(state?.status) || paused) stopProgressWatchdog();
  }
}

async function runDirect() {
  await refreshCandidateFromStorage();
  const provider = WebKeeperMediaEngine.selectProvider(candidate, "direct");
  const previousProvider = state.providerId;
  if (provider?.id === "direct-file") {
    const sourceUrl = WebKeeperMediaEngine.directFileUrl(candidate);
    if ((previousProvider && previousProvider !== "direct-file") || (state.directSourceUrl && state.directSourceUrl !== sourceUrl) || state.errorCode === "MEDIA_INVALID") {
      state.outputName = "";
      state.bytes = 0;
      state.totalBytes = 0;
      state.done = 0;
      state.validationVersion = 0;
      state.errorCode = "";
    }
    state.directSourceUrl = sourceUrl;
  }
  state.providerId = provider?.id || "unknown";
  await mirrorJob();
  if (provider?.id === "direct-file") return runDirectFile();
  if (provider?.id === "hls") return runHlsDirect();
  if (provider?.id === "dash") return runDashDirect();
  state.status = "error";
  state.message = t("mediaTypeUnsupported", null, "已经找到视频请求，但当前版本还不能识别这种保存方式。");
  await mirrorJob();
}

async function refreshCandidateFromStorage() {
  const stored = await chrome.storage.local.get({ [CANDIDATES_KEY]: [] });
  const latest = (stored[CANDIDATES_KEY] || []).find((item) => item.id === candidate?.id);
  if (!latest) return;
  candidate = { ...candidate, ...latest, headers: { ...(candidate.headers || {}), ...(latest.headers || {}) } };
  state.candidate = { ...candidate };
}

async function refreshCapturePlaylist() {
  try {
    try {
      await loadMediaPlaylist();
    } catch (error) {
      if (!pinnedPlaylistUrl) throw error;
      log(`已选清晰度的播放列表暂时不可用（${error.message}），改回浏览器最近发现的列表`);
      pinnedPlaylistUrl = "";
      await loadMediaPlaylist();
    }
    state.status = "capturing";
    state.message = t("assistedWorking", null, "正在跟随网页播放保存内容，不会提前请求后续部分。");
    await mirrorJob();
    log(`已取得 ${mediaPlaylist.segments.length} 个分片的解密信息`);
  } catch (error) {
    state.status = "waiting";
    state.message = t("assistedWaiting", error.message, `${error.message} 请回到视频页面继续播放，Web Keeper 会等待新的内容。`);
    log(`等待播放列表：${error.message}`);
    await mirrorJob();
  }
}

async function adoptPlaylistForSegment(segmentUrl) {
  if (Date.now() - lastAdoptAttemptAt < 15000) return false;
  lastAdoptAttemptAt = Date.now();
  const wanted = normalizedMediaUrl(segmentUrl);
  const queue = Array.from(new Set([...(candidate.playlistUrls || []), ...knownPlaylistSources].filter(Boolean))).filter((item) => item !== mediaPlaylist?.url);
  const visited = new Set();
  while (queue.length && visited.size < 24) {
    const source = queue.shift();
    if (visited.has(source)) continue;
    visited.add(source);
    let parsed;
    try { parsed = parsePlaylist(await fetchText(source), source); }
    catch (error) { log(`跳过无法读取的播放列表 ${source}：${error.message}`); continue; }
    if (parsed.variants.length) {
      rememberPlaylistSources(parsed);
      queue.push(...[...parsed.variants.map((item) => item.url), ...(parsed.audios || []).map((item) => item.url)].filter((item) => item && !visited.has(item)));
      continue;
    }
    if (!parsed.segments.some((item) => normalizedMediaUrl(item.url) === wanted)) continue;
    pinnedPlaylistUrl = source;
    candidate.playlistUrl = source;
    indexMediaPlaylist(parsed);
    state.candidate = { ...candidate };
    log(`播放器实际使用的清晰度与之前选择的不同，已改用 ${source}`);
    state.message = t("captureQualityAdopted", null, "已改为按网页播放器实际使用的清晰度保存。");
    await updateMissingTimeline();
    await mirrorJob();
    return true;
  }
  return false;
}

async function locateCaptureSegment(event) {
  const known = segmentIndex.exact(event.url);
  if (known) return known;
  if (Date.now() - lastCaptureRefreshAt >= 8000) {
    lastCaptureRefreshAt = Date.now();
    await refreshCapturePlaylist();
    const refreshed = segmentIndex.exact(event.url);
    if (refreshed) return refreshed;
  }
  if (!capturePlaylistLocked && await adoptPlaylistForSegment(event.url)) {
    const adopted = segmentIndex.exact(event.url);
    if (adopted) return adopted;
  }
  return segmentIndex.find(event.url);
}

function scheduleCaptureRetry(event) {
  const attempts = Number(captureRetryCounts.get(event.url) || 0) + 1;
  if (attempts > MAX_CAPTURE_RETRIES) return false;
  captureRetryCounts.set(event.url, attempts);
  if (captureRetryCounts.size > 500) captureRetryCounts.delete(captureRetryCounts.keys().next().value);
  return deferCaptureSegment(event);
}

async function reportCaptureItemError(event, error) {
  // Pausing aborts the request in flight; that is the user's own action, not a failure.
  if (paused) {
    deferCaptureSegment(event);
    return;
  }
  state.failed = Number(state.failed || 0) + 1;
  state.message = scheduleCaptureRetry(event)
    ? t("assistedItemFailed", error.message, `有一部分暂时未能保存：${error.message}。稍后会自动重试。`)
    : t("assistedItemGaveUp", error.message, `有一部分多次未能保存：${error.message}。可以用智能补全，或回到网页重新播放这一段。`);
  log(state.message);
  await mirrorJob();
}

function deferCaptureSegment(event) {
  if (pendingCaptureSegments.some((item) => item.url === event.url)) return false;
  pendingCaptureSegments = [...pendingCaptureSegments, event].slice(-300);
  return true;
}

async function replayPendingCaptureSegments() {
  if (replayingCaptureSegments || !pendingCaptureSegments.length) return;
  replayingCaptureSegments = true;
  const queued = pendingCaptureSegments;
  pendingCaptureSegments = [];
  try {
    for (const event of queued) {
      if (paused || !["capturing", "waiting"].includes(state.status)) { deferCaptureSegment(event); continue; }
      await captureObservedSegment(event);
    }
  } finally {
    replayingCaptureSegments = false;
  }
}

function captureManifestUrl() {
  return candidate.manifestUrl || (/\.mpd(?:[?#]|$)/i.test(candidate.lastUrl || "") ? candidate.lastUrl : "");
}

function captureUsesDash() {
  return Boolean(captureManifestUrl()) && !candidate.playlistUrl && !(candidate.playlistUrls || []).length;
}

function dashSelectedTracks() {
  return [...(dashCapture?.selected.values() || [])];
}

function updateDashCaptureTotals() {
  const tracks = dashSelectedTracks();
  state.total = tracks.reduce((sum, track) => sum + track.segments.length, 0);
  state.selectedTracks = tracks.map((track) => ({ id: track.id, contentType: track.contentType, codecs: track.codecs, bandwidth: track.bandwidth, segmentCount: track.segments.length }));
}

function adoptDashSubtitles(manifest) {
  const usable = (manifest.subtitles || []).filter((item) => item.url && !item.segmented);
  const segmented = (manifest.subtitles || []).filter((item) => item.segmented).length;
  if (segmented) log(`清单里有 ${segmented} 条分片式字幕轨，当前版本无法生成可用字幕文件，已跳过`);
  if (!usable.length) return;
  const before = (candidate.subtitles || []).length;
  candidate.subtitles = Array.from(new Set([...(candidate.subtitles || []), ...usable.map((item) => item.url)]));
  if (candidate.subtitles.length > before) log(`从清单中发现 ${candidate.subtitles.length - before} 条字幕`);
  state.candidate = { ...candidate };
}

async function loadDashCaptureManifest() {
  const manifestUrl = captureManifestUrl();
  if (!manifestUrl) throw new Error(t("dashManifestMissing", null, "尚未找到完整的 DASH 视频信息，请回到网页播放几秒后重试。"));
  const manifest = WebKeeperMediaEngine.parseDashManifest(await fetchText(manifestUrl), manifestUrl);
  if (manifest.drm) throw new Error(t("drmUnsupported", null, "这个视频受 DRM 保护，Web Keeper 不会尝试绕过网站的访问控制。"));
  adoptDashSubtitles(manifest);
  const tracks = WebKeeperMediaEngine.mergeDashCaptureTracks(dashCapture?.index.tracks || [], manifest.tracks);
  const index = WebKeeperMediaEngine.dashCaptureIndex({ tracks });
  if (!index.tracks.length) throw new Error(t("dashNoTracks", null, "没有找到可直接保存的 DASH 音视频轨道。"));
  const directory = await workDirectory.getDirectoryHandle("dash", { create: true });
  const selected = new Map();
  for (const [contentType, trackId] of Object.entries(state.dashTrackIds || {})) {
    const track = index.track(trackId);
    if (track) selected.set(contentType, track);
  }
  dashCapture = { manifestUrl, manifest, index, directory, selected, initialized: new Set(), loadedAt: Date.now() };
  state.duration = manifest.duration || state.duration || 0;
  updateDashCaptureTotals();
  log(`已读取 DASH 清单：${index.tracks.length} 条可用轨道`);
  return dashCapture;
}

async function refreshDashCaptureManifest() {
  if (!dashCapture || Date.now() - dashCapture.loadedAt < 8000) return false;
  try {
    await loadDashCaptureManifest();
    return true;
  } catch (error) {
    log(`DASH 清单暂时无法更新：${error.message}`);
    return false;
  }
}

async function lockDashTrack(track) {
  const current = dashCapture.selected.get(track.contentType);
  if (current) return current.id === track.id ? current : null;
  dashCapture.selected.set(track.contentType, track);
  state.dashTrackIds = { ...(state.dashTrackIds || {}), [track.contentType]: track.id };
  if (track.contentType === "video" && track.height) state.resolution = `${track.height}p`;
  updateDashCaptureTotals();
  log(`播放器正在使用${track.contentType === "video" ? "视频" : "音频"}轨道 ${track.id}，本任务固定保存这一条`);
  await mirrorJob();
  return track;
}

async function updateDashMissingTimeline() {
  const video = dashCapture?.selected.get("video");
  if (!video) return [];
  const records = (await listSegmentRecords(state.id)).filter((item) => item.kind === "dash" && item.trackId === video.id);
  const saved = new Set(records.map((item) => Number(item.index)));
  state.missingRanges = WebKeeperMediaEngine.missingTimeline(video.segments.map((segment, index) => ({ ...segment, sequence: index })), saved);
  state.missing = state.missingRanges.reduce((sum, range) => sum + range.count, 0);
  return state.missingRanges;
}

async function captureObservedDashSegment(event) {
  let located = dashCapture.index.find(event.url);
  if (!located && await refreshDashCaptureManifest()) located = dashCapture.index.find(event.url);
  if (!located) {
    if (deferCaptureSegment(event)) log(`暂无法在 DASH 清单中定位：${event.url}`);
    return;
  }
  const track = dashCapture.index.track(located.trackId);
  if (!track) return;
  const selected = await lockDashTrack(track);
  if (!selected) {
    if (Date.now() - qualitySwitchReportedAt > 60000) {
      qualitySwitchReportedAt = Date.now();
      state.message = t("captureQualityChanged", null, "网页播放器换了清晰度，本任务只保存最初的清晰度。请在网页上固定清晰度，避免出现缺口。");
      await mirrorJob();
    }
    return;
  }
  const directory = await dashTrackDirectory(dashCapture.directory, track);
  const options = { pageTabId: event.tabId ?? candidate.tabId, cacheMode: "force-cache", preferPageBuffer: true };
  try {
    if (located.kind === "initialization") {
      await saveDashInitialization(directory, track, options);
      dashCapture.initialized.add(track.id);
      return;
    }
    if (!dashCapture.initialized.has(track.id)) {
      try {
        await saveDashInitialization(directory, track, options);
        dashCapture.initialized.add(track.id);
      } catch (error) { log(`轨道初始化内容稍后重试：${error.message}`); }
    }
    const recorded = await dbGet("segments", dashRecordId(track.id, located.index));
    if (recorded) {
      try {
        const file = await (await directory.getFileHandle(recorded.fileName)).getFile();
        if (file.size > 0) return;
      } catch { /* ledger entry without file, save it again */ }
    }
    log(`播放器已请求 ${track.contentType} 第 ${located.index + 1} 项，开始保存`);
    await saveDashSegment(directory, track, track.segments[located.index], located.index, options);
    captureRetryCounts.delete(event.url);
    const isLive = dashCapture.manifest.type === "dynamic";
    state.status = "capturing";
    state.message = isLive
      ? t("captureLiveWaiting", null, "直播内容会持续保存；想结束时点“检查并生成视频”。")
      : t("assistedSaving", null, "正在跟随网页播放保存；已经完成的内容会保留，可随时暂停。");
    await updateDashMissingTimeline();
    await mirrorJob();
    await replayPendingCaptureSegments();
    if (!isLive && state.total && state.done >= state.total && autoFinalize) await finalizeDashCapture();
  } catch (error) {
    await reportCaptureItemError(event, error);
  }
}

async function finalizeDashCapture() {
  const tracks = dashSelectedTracks();
  if (!tracks.length) throw new Error(t("dashNoTracks", null, "没有找到可直接保存的 DASH 音视频轨道。"));
  const missing = Math.max(0, Number(state.total || 0) - Number(state.done || 0));
  if (missing && !confirm(t("createPartialConfirm", missing, `仍有 ${missing} 项待补。要先按现有内容生成一个不完整视频吗？`))) return;
  paused = false;
  try {
    for (const track of tracks) {
      const directory = await dashTrackDirectory(dashCapture.directory, track);
      await saveDashInitialization(directory, track, { pageTabId: candidate.tabId, cacheMode: "force-cache", preferPageBuffer: true });
    }
    await mergeDashOutput(dashCapture.directory, tracks);
  } catch (error) {
    state.status = "error";
    state.message = t("outputFailed", error.message, `生成视频失败：${error.message}`);
    log(state.message);
    await mirrorJob();
  }
}

async function switchCaptureToDash(event) {
  if (dashCapture || Number(state.done || 0) > 0 || !captureManifestUrl()) return false;
  if (Date.now() - lastDashSwitchAt < 15000) return false;
  lastDashSwitchAt = Date.now();
  try { await loadDashCaptureManifest(); }
  catch (error) { log(`暂时无法按 DASH 处理：${error.message}`); return false; }
  if (!dashCapture.index.find(event.url)) {
    dashCapture = null;
    return false;
  }
  state.providerId = "dash";
  log("这个视频使用 DASH，网页辅助保存已切换到 DASH 轨道模式");
  await mirrorJob();
  return true;
}

async function runDashCapture() {
  paused = false;
  state.providerId = "dash";
  state.progressUnit = "items";
  await ensureDirectories();
  await ensurePageCaptureHook(candidate.tabId, { announce: true });
  await prepareTimelineAfterIdle({ reason: "dash-capture-start" });
  state.status = "waiting";
  state.message = t("assistedPreparing", null, "正在准备网页辅助保存。");
  await mirrorJob();
  startProgressWatchdog();
  const queued = await queuedCaptureEvents();
  try {
    await loadDashCaptureManifest();
    await reconcileDashSaved(dashCapture.directory, dashSelectedTracks());
    await updateDashMissingTimeline();
    await restoreCaptureAcceleration();
    state.status = "capturing";
    state.message = t("assistedWorking", null, "正在跟随网页播放保存内容，不会提前请求后续部分。");
  } catch (error) {
    state.status = "waiting";
    state.message = t("assistedWaiting", error.message, `${error.message} 请回到视频页面继续播放，Web Keeper 会等待新的内容。`);
    log(`等待 DASH 清单：${error.message}`);
  }
  await mirrorJob();
  if (state.status === "capturing") {
    await replayQueuedCaptureEvents(queued);
    await replayPendingCaptureSegments();
  }
}

async function adoptQueuedManifests() {
  const manifests = (await queuedCaptureEvents()).filter((event) => event.kind === "manifest").map((event) => event.url);
  if (!manifests.length) return;
  candidate.manifestUrls = Array.from(new Set([...(candidate.manifestUrls || []), ...manifests]));
  candidate.manifestUrl ||= manifests[manifests.length - 1];
}

async function runCapture() {
  await adoptQueuedManifests();
  if (captureUsesDash()) return runDashCapture();
  dashCapture = null;
  paused = false;
  state.providerId = "browser-assisted";
  state.progressUnit = "items";
  await ensureDirectories();
  await ensurePageCaptureHook(candidate.tabId, { announce: true });
  await reconcileSaved();
  await prepareTimelineAfterIdle({ reason: "capture-start" });
  capturePlaylistLocked = Number(state.done || 0) > 0;
  qualitySwitchReportedAt = 0;
  state.status = "waiting";
  state.message = t("assistedPreparing", null, "正在准备网页辅助保存。");
  await mirrorJob();
  startProgressWatchdog();
  const queued = await queuedCaptureEvents();
  const queuedPlaylists = queued.filter((event) => event.kind === "playlist").map((event) => event.url);
  candidate.playlistUrls = Array.from(new Set([...(candidate.playlistUrls || []), ...queuedPlaylists]));
  await refreshCapturePlaylist();
  await restoreCaptureAcceleration();
  if (state.status === "capturing") {
    await replayQueuedCaptureEvents(queued);
    await replayPendingCaptureSegments();
  }
}

async function queuedCaptureEvents() {
  const stored = await chrome.storage.local.get({ [MEDIA_EVENTS_KEY]: [] });
  const cutoff = Date.now() - 30 * 60 * 1000;
  return (stored[MEDIA_EVENTS_KEY] || []).filter((event) => Number(event.timeStamp || 0) >= cutoff && matchesCandidate(event)).sort((a, b) => Number(a.timeStamp || 0) - Number(b.timeStamp || 0));
}

async function replayQueuedCaptureEvents(events = []) {
  const segments = events.filter((event) => event.kind === "segment");
  if (!segments.length) return;
  log(`恢复处理任务页关闭期间记录的 ${segments.length} 个媒体请求`);
  for (const event of segments) {
    if (paused || !["capturing", "waiting"].includes(state.status)) break;
    await captureObservedSegment(event);
  }
  if (pendingCaptureSegments.length) log(`其中 ${pendingCaptureSegments.length} 个请求暂时无法对应到播放列表，会在播放列表更新后重试`);
}

function matchesCandidate(event) {
  if (!state || !event || !candidate) return false;
  if (event.candidateId && candidate.id && event.candidateId === candidate.id) return true;
  // The candidate id carries the tab id, so an unfinished task must also match the same
  // work reopened in a new tab. The page URL keeps sites apart whose paths share a product.
  if (event.product !== candidate.product) return false;
  if (event.pageUrl && candidate.pageUrl && event.pageUrl !== candidate.pageUrl) return false;
  return candidate.resolution === "auto" || event.resolution === candidate.resolution || event.resolution === "auto";
}

async function captureObservedSegment(event) {
  if (paused || !["capturing", "waiting"].includes(state.status)) return;
  if (event.kind === "manifest") {
    if (dashCapture && await refreshDashCaptureManifest()) await replayPendingCaptureSegments();
    return;
  }
  if (event.kind === "playlist") {
    if (!pinnedPlaylistUrl) candidate.playlistUrl = event.url;
    if (Date.now() - lastCaptureRefreshAt < 4000) return;
    lastCaptureRefreshAt = Date.now();
    await refreshCapturePlaylist();
    await replayPendingCaptureSegments();
    return;
  }
  if (event.kind !== "segment") return;
  if (dashCapture) return captureObservedDashSegment(event);
  if (!segmentDirectory) return;
  const meta = await locateCaptureSegment(event);
  if (!meta) {
    if (await switchCaptureToDash(event)) return captureObservedDashSegment(event);
    if (deferCaptureSegment(event)) log(`暂无法定位分片，已记下稍后重试：${event.url}`);
    if (capturePlaylistLocked && !segmentIndex.sameLocation(event.url) && Date.now() - qualitySwitchReportedAt > 60000) {
      qualitySwitchReportedAt = Date.now();
      state.message = t("captureQualityChanged", null, "网页播放器换了清晰度，本任务只保存最初的清晰度。请在网页上固定清晰度，避免出现缺口。");
      await mirrorJob();
    }
    return;
  }
  const sequence = meta.sequence;
  try {
    const existing = await savedSegment(sequence);
    if (existing) return;
    log(`播放器已请求分片 ${sequence}，开始保存`);
    await saveSegment({ ...meta, url: event.url }, event.headers || {}, { pageTabId: event.tabId ?? candidate.tabId, cacheMode: "force-cache", preferPageBuffer: true });
    captureRetryCounts.delete(event.url);
    capturePlaylistLocked = true;
    state.status = "capturing";
    state.message = state.isLive
      ? t("captureLiveWaiting", null, "直播内容会持续保存；想结束时点“检查并生成视频”。")
      : t("assistedSaving", null, "正在跟随网页播放保存；已经完成的内容会保留，可随时暂停。");
    await mirrorJob();
    await replayPendingCaptureSegments();
    if (!state.isLive && state.total && coveredSegmentCount() >= state.total && autoFinalize) await mergeOutput(false);
  } catch (error) {
    await reportCaptureItemError(event, error);
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "media-observed" || !matchesCandidate(message.event)) return;
  const event = message.event;
  if (Number(event.tabId) >= 0 && Number(event.tabId) !== Number(candidate.tabId)) {
    candidate.tabId = Number(event.tabId);
    log("这个视频正在新的标签页播放，已跟随过去继续保存");
    void ensurePageCaptureHook(candidate.tabId, { announce: true });
  }
  candidate.headers = { ...(candidate.headers || {}), ...(event.headers || {}) };
  if (event.kind === "playlist" && !pinnedPlaylistUrl) candidate.playlistUrl = event.url;
  if (event.kind === "manifest") candidate.manifestUrl = event.url;
  if (event.kind === "direct") candidate.directUrl = event.url;
  if (event.kind === "segment") candidate.segmentUrl = event.url;
  state.candidate = { ...candidate };
  captureQueue = captureQueue.then(() => captureObservedSegment(message.event)).catch((error) => log(error.message));
});

async function createMp4FromTransportStream(expected, bySequence, outputName, durationSeconds) {
  const Transmuxer = globalThis.muxjs?.mp4?.Transmuxer || globalThis.muxjs?.Transmuxer;
  if (!Transmuxer) throw new Error(t("transmuxerUnavailable", null, "视频封装组件没有加载，无法生成可播放的 MP4。"));
  const outputHandle = await workDirectory.getFileHandle(outputName, { create: true });
  const writable = await outputHandle.createWritable();
  const transmuxer = new Transmuxer({ remux: true, keepOriginalTimestamps: false });
  let emitted = [];
  let hasVideo = false;
  let wroteInit = false;
  transmuxer.on("trackinfo", (info) => { hasVideo ||= Boolean(info?.hasVideo); });
  transmuxer.on("data", (segment) => {
    if (segment?.type === "video" || segment?.type === "combined") hasVideo = true;
    emitted.push(segment);
  });
  try {
    for (const sequence of expected) {
      const record = bySequence.get(sequence);
      if (!record) continue;
      const handle = await segmentDirectory.getFileHandle(record.fileName);
      const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer());
      const inspection = WebKeeperMediaEngine.inspectTransportStream(bytes);
      if (inspection.container !== "mpegts") throw new Error(t("unexpectedSegmentFormat", null, "下载到的切片不是可识别的 MPEG-TS 视频，已停止生成文件。"));
      if (inspection.hasVideo) hasVideo = true;
      emitted = [];
      transmuxer.push(bytes);
      transmuxer.flush();
      for (const segment of emitted) {
        if (!wroteInit && segment?.initSegment?.byteLength) {
          await writable.write(WebKeeperMediaEngine.patchMp4InitDuration(segment.initSegment, durationSeconds));
          wroteInit = true;
        }
        if (segment?.data?.byteLength) await writable.write(segment.data);
      }
    }
    if (!hasVideo || !wroteInit) throw new Error(t("videoTrackMissing", null, "检测到的内容只有音频轨，没有视频画面。请重新播放网页后选择完整视频，或改用网页辅助抓取。"));
    await writable.close();
    await validateSavedVideo(outputHandle);
    return outputHandle;
  } catch (error) {
    try { await writable.abort(); } catch { /* already closed */ }
    try { await workDirectory.removeEntry(outputName); } catch { /* no incomplete output */ }
    throw error;
  }
}

async function mergeOutput(allowPartial = true) {
  await ensureDirectories();
  if (!mediaPlaylist) await loadMediaPlaylist();
  await reclassifySkippableGaps();
  const records = (await listSegmentRecords(state.id)).filter((item) => item.kind !== "dash" && isValidSegmentSize(item.size));
  const bySequence = new Map(records.map((item) => [item.sequence, item]));
  const skippable = skippableSequenceSet();
  const playlistExpected = mediaPlaylist.segments.filter((item) => !item.gap).map((item) => item.sequence);
  const expected = state.wasLive
    ? Array.from(new Set([...records.map((item) => item.sequence), ...playlistExpected])).sort((a, b) => a - b)
    : playlistExpected;
  const missing = expected.filter((sequence) => !bySequence.has(sequence) && !skippable.has(Number(sequence)));
  if (missing.length && !allowPartial) throw new Error(t("remainingCount", missing.length, `仍有 ${missing.length} 项待补。`));
  if (missing.length && !confirm(t("createPartialConfirm", missing.length, `仍有 ${missing.length} 项待补。要先按现有内容生成一个不完整视频吗？`))) return;
  paused = false;
  state.status = "merging";
  const skipNote = skippable.size ? t("creatingWithSkippable", skippable.size, `将跳过 ${skippable.size} 个已确认空壳分片。`) : "";
  const breakNote = timelineBreakSet().size
    ? t("creatingWithTimelineBreaks", timelineBreakSet().size, `接缝处有 ${timelineBreakSet().size} 处已标记的时间轴断点，封装时会尽量重排时间戳以继续生成。`)
    : "";
  state.message = missing.length
    ? t("creatingPartial", missing.length, `正在按现有内容生成视频，将跳过 ${missing.length} 处缺口。`) + (skipNote ? ` ${skipNote}` : "") + (breakNote ? ` ${breakNote}` : "")
    : (skippable.size || breakNote
      ? `${skippable.size ? t("creatingPlayableVideoSkippable", skippable.size, `正在生成可播放视频；已确认可跳过 ${skippable.size} 个空壳分片。`) : t("creatingPlayableVideo", null, "正在生成可播放视频。")}${breakNote ? ` ${breakNote}` : ""}`
      : t("creatingPlayableVideo", null, "正在生成可播放视频。"));
  await mirrorJob();
  try {
    const firstRecord = expected.map((sequence) => bySequence.get(sequence)).find(Boolean);
    if (!firstRecord) throw new Error(t("playlistEmpty", null, "没有找到可生成视频的下载内容。"));
    const firstFile = await segmentDirectory.getFileHandle(firstRecord.fileName);
    const firstBytes = new Uint8Array(await (await firstFile.getFile()).slice(0, 4 * 1024 * 1024).arrayBuffer());
    const firstInspection = WebKeeperMediaEngine.inspectMediaBytes(firstBytes);
    const isFragmentedMp4 = firstInspection.container === "mp4" || mediaPlaylist.segments.some((item) => /\.m4s(?:[?#]|$)/i.test(item.url));
    const isTransportStream = firstInspection.container === "mpegts";
    if (!isFragmentedMp4 && !isTransportStream) throw new Error(t("unexpectedSegmentFormat", null, "下载到的切片不是可识别的视频格式，已停止生成文件。"));
    if (firstInspection.hasAudio === true && firstInspection.hasVideo === false) throw new Error(t("videoTrackMissing", null, "检测到的内容只有音频轨，没有视频画面。请重新播放网页后选择完整视频，或改用网页辅助抓取。"));
    const extension = "mp4";
    const outputName = `${preferredOutputBaseName()}.${extension}`;
    const savedSequences = new Set([...bySequence.keys()]);
    const outputDuration = mediaPlaylist.segments.filter((item) => !item.gap && savedSequences.has(item.sequence)).reduce((sum, item) => sum + Number(item.duration || 0), 0);
    let outputHandle;
    if (isTransportStream) {
      outputHandle = await createMp4FromTransportStream(expected, bySequence, outputName, outputDuration);
    } else {
      outputHandle = await workDirectory.getFileHandle(outputName, { create: true });
      const writable = await outputHandle.createWritable();
      try {
        if (mediaPlaylist.map?.url) {
          const initResponse = await fetchResponse(mediaPlaylist.map.url, { byteRange: mediaPlaylist.map.byteRange });
          const initBytes = new Uint8Array(await consumeResponse(initResponse, "arrayBuffer"));
          await writable.write(WebKeeperMediaEngine.patchMp4InitDuration(initBytes, outputDuration));
        }
        for (const [sequenceIndex, sequence] of expected.entries()) {
          const record = bySequence.get(sequence);
          if (!record) continue;
          const handle = await segmentDirectory.getFileHandle(record.fileName);
          const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer());
          await writable.write(!mediaPlaylist.map?.url && sequenceIndex === 0 ? WebKeeperMediaEngine.patchMp4InitDuration(bytes, outputDuration) : bytes);
        }
        await writable.close();
        await validateSavedVideo(outputHandle);
      } catch (error) {
        try { await writable.abort(); } catch { /* already closed */ }
        try { await workDirectory.removeEntry(outputName); } catch { /* no incomplete output */ }
        throw error;
      }
    }
    state.outputName = outputName;
    await publishSavedFile(outputHandle, outputName, { removeInternal: true });
    await saveSubtitles({ automatic: true });
    state.status = "complete";
    state.validationVersion = 1;
    state.missing = missing.length;
    state.skippableCount = skippable.size;
    if (state.mode === "browser-assisted") await stopPageCaptureHook(candidate.tabId);
    if (missing.length) {
      state.message = t("outputPartial", [outputName, missing.length], `已生成 ${outputName}，但仍有 ${missing.length} 处缺口。`);
    } else if (skippable.size) {
      state.message = t("outputCompleteSkippable", [outputName, skippable.size], `已生成 ${outputName}。其中 ${skippable.size} 个空壳分片因前后时间轴连贯已跳过，无需重试。`);
    } else {
      state.message = t("outputComplete", outputName, `已生成 ${outputName}。确认播放正常后，可以清理临时下载文件。`);
    }
    log(state.message);
    await mirrorJob();
    if (!missing.length && cleanupAfterMerge) {
      await removeTemporaryData();
      state.temporaryCleaned = true;
      state.message = t("outputCompleteAndCleaned", outputName, `已生成并检查 ${outputName}，临时切片已自动清理。`);
      await mirrorJob();
    }
  } catch (error) {
    state.status = "error";
    state.message = t("outputFailed", error.message, `生成视频失败：${error.message}`);
    log(state.message);
    await mirrorJob();
  }
}

async function saveSubtitles({ automatic = false } = {}) {
  await ensureDirectories();
  const urls = validSubtitleUrls(candidate.subtitles || []);
  if (!urls.length) return;
  const directory = await workDirectory.getDirectoryHandle("subtitles", { create: true });
  let saved = 0;
  for (const [index, url] of urls.entries()) {
    try {
      const response = await fetchResponse(url);
      const data = await consumeResponse(response, "arrayBuffer");
      const ext = new URL(url).pathname.match(/\.([a-z0-9]+)$/i)?.[1] || "vtt";
      const subtitleName = `${safeName(state.outputName?.replace(/\.[^.]+$/, "") || state.title || "video")}.subtitle-${String(index + 1).padStart(2, "0")}.${safeName(ext, "vtt")}`;
      const fileHandle = await writeFile(directory, subtitleName, data);
      await publishSavedFile(fileHandle, subtitleName, { removeInternal: true, sourceDirectory: directory, trackAsOutput: false });
      saved += 1;
    } catch (error) { log(`字幕保存失败：${error.message}`); }
  }
  state.subtitlesSaved = saved;
  state.subtitlesTotal = urls.length;
  if (!automatic) state.message = t("subtitlesSaved", [saved, urls.length], `已保存 ${saved}/${urls.length} 条字幕。`);
  await mirrorJob();
  return { saved, total: urls.length };
}

async function chooseDirectoryAndStart() {
  if (!("showDirectoryPicker" in window)) {
    state.status = "error";
    state.message = t("browserUnsupportedFolder", null, "当前浏览器不支持直接选择保存目录，请使用最新版 Chrome 或 Edge。");
    await mirrorJob();
    return;
  }
  try {
    rootHandle = await window.showDirectoryPicker({ mode: "readwrite", id: "web-keeper-downloads", startIn: "downloads" });
    saveDestination = "custom-folder";
    state.saveDestination = saveDestination;
    await dbPut("handles", { id: state.id, handle: rootHandle });
    await dbPut("handles", { id: "default-root", handle: rootHandle });
    await ensureDirectories();
    await (state.mode === "direct" ? runDirect() : runCapture());
  } catch (error) {
    if (error.name === "AbortError") return;
    state.status = "error";
    state.message = error.message;
    await mirrorJob();
  }
}

async function resumeTask() {
  try {
    paused = false;
    await ensureDirectories();
    await (state.mode === "direct" ? runDirect() : runCapture());
  } catch (error) {
    state.status = "error";
    state.message = error.message;
    await mirrorJob();
  }
}

async function pauseTask() {
  paused = true;
  smartFillRunning = false;
  smartFillActiveRange = null;
  stopSeekBoost();
  stopProgressWatchdog();
  for (const controller of activeControllers) controller.abort();
  activeControllers.clear();
  activeController = null;
  state.status = "paused";
  state.pausedAt = Date.now();
  state.stalled = false;
  state.message = t("taskPausedMessage", null, "下载已暂停，已经保存的内容不会删除。");
  await mirrorJob();
}

async function switchToAssisted() {
  if (!confirm(t("switchToAssistedConfirm", null, "改用网页辅助保存？需要保持此任务页开启，并回到原网页继续播放。"))) return;
  try { await chrome.runtime.sendMessage({ type: "set-candidate-decision", candidateId: candidate.id, decision: "browser-assisted" }); } catch { /* task can continue without popup sync */ }
  state.mode = "browser-assisted";
  state.errorCode = "";
  state.status = "waiting";
  state.message = t("assistedReadyMessage", null, "返回网页继续播放，Web Keeper 会从已保存内容之后继续。");
  await mirrorJob();
  await runCapture();
}

async function seekVideoAndInspect(tabId, targetTime) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      args: [targetTime],
      func: async (time) => {
        const videos = [...document.querySelectorAll("video")].filter((video) => video.duration || video.readyState || video.clientWidth || video.clientHeight);
        const video = videos.sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))[0];
        if (!video) return { ok: false, reason: "NO_VIDEO" };
        const duration = Number.isFinite(video.duration) ? video.duration : 0;
        const target = duration ? Math.min(Math.max(0, time), Math.max(0, duration - 0.25)) : Math.max(0, time);
        video.currentTime = target;
        try { await video.play(); } catch { /* page may require a manual play gesture */ }
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 2200);
          const done = () => { clearTimeout(timer); resolve(); };
          video.addEventListener("loadeddata", done, { once: true });
          video.addEventListener("canplay", done, { once: true });
          video.addEventListener("seeked", done, { once: true });
        });
        let bufferedEnd = 0;
        for (let index = 0; index < video.buffered.length; index += 1) {
          if (video.buffered.start(index) <= video.currentTime + 0.5) bufferedEnd = Math.max(bufferedEnd, video.buffered.end(index));
        }
        return { ok: true, readyState: video.readyState, currentTime: video.currentTime, bufferedEnd, paused: video.paused, duration };
      }
    });
    return (results || []).map((item) => item?.result).find((item) => item?.ok) || (results || []).map((item) => item?.result).find(Boolean) || { ok: false, reason: "NO_RESULT" };
  } catch {
    return { ok: false, reason: "NO_RESULT" };
  }
}

function stopSeekBoost() {
  if (seekBoostTimer) {
    clearInterval(seekBoostTimer);
    seekBoostTimer = null;
  }
}

async function stepSeekForward(stepSeconds = SEEK_BOOST_STEP_SECONDS) {
  const tabId = Number(candidate?.tabId);
  if (!(tabId >= 0) || paused) return null;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      args: [Number(stepSeconds) || 10],
      func: (step) => {
        const videos = [...document.querySelectorAll("video")].filter((item) => item.duration || item.readyState || item.clientWidth);
        const video = videos.sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))[0];
        if (!video) return { ok: false, reason: "NO_VIDEO" };
        const duration = Number.isFinite(video.duration) ? video.duration : 0;
        const next = duration ? Math.min(video.currentTime + step, Math.max(0, duration - 0.25)) : video.currentTime + step;
        video.muted = true;
        video.currentTime = next;
        try { void video.play(); } catch { /* gesture may be required */ }
        // Also dispatch ArrowRight for players that only listen to keyboard seeking.
        try {
          video.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", code: "ArrowRight", keyCode: 39, which: 39, bubbles: true }));
          document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", code: "ArrowRight", keyCode: 39, which: 39, bubbles: true }));
        } catch { /* some pages block synthetic keys */ }
        return { ok: true, currentTime: video.currentTime, duration, ended: Boolean(duration && next >= duration - 0.3) };
      }
    });
    return (results || []).map((item) => item?.result).find((item) => item?.ok) || (results || []).map((item) => item?.result).find(Boolean) || null;
  } catch {
    return null;
  }
}

function normalizedSeekBoostSettings() {
  const intervalSec = Math.min(30, Math.max(0.25, Number(state?.captureSeekIntervalSec ?? SEEK_BOOST_INTERVAL_MS / 1000) || 1));
  const stepSeconds = Math.min(120, Math.max(1, Math.round(Number(state?.captureSeekStepSeconds ?? SEEK_BOOST_STEP_SECONDS) || 10)));
  if (state) {
    state.captureSeekIntervalSec = intervalSec;
    state.captureSeekStepSeconds = stepSeconds;
  }
  return { intervalSec, stepSeconds, intervalMs: Math.round(intervalSec * 1000) };
}

function startSeekBoost(overrides = {}) {
  const settings = normalizedSeekBoostSettings();
  const stepSeconds = Number(overrides.stepSeconds) || settings.stepSeconds;
  const intervalMs = Number(overrides.intervalMs) || settings.intervalMs;
  stopSeekBoost();
  state.captureSpeedMode = "seek";
  seekBoostTimer = setInterval(() => {
    if (paused || !state || !["capturing", "waiting"].includes(state.status)) return;
    void stepSeekForward(stepSeconds).then((result) => {
      if (result?.ended) {
        stopSeekBoost();
        state.message = t("captureSeekBoostEnded", null, "已快进到接近结尾；若仍有缺口，可用智能补全。");
        void mirrorJob();
      }
    });
  }, Math.max(250, intervalMs));
}

async function applySeekBoostSettingsFromInputs({ restart = true } = {}) {
  if (!state) return;
  state.captureSeekIntervalSec = Number($("seekBoostInterval").value);
  state.captureSeekStepSeconds = Number($("seekBoostStep").value);
  const settings = normalizedSeekBoostSettings();
  $("seekBoostInterval").value = String(settings.intervalSec);
  $("seekBoostStep").value = String(settings.stepSeconds);
  if (restart && state.captureSpeedMode === "seek" && !paused && ["capturing", "waiting"].includes(state.status)) {
    await applyCaptureSpeed(1);
    startSeekBoost(settings);
    state.message = t("captureSeekBoostApplied", [settings.intervalSec, settings.stepSeconds], `已改为每 ${settings.intervalSec} 秒快进约 ${settings.stepSeconds} 秒（类似连续按右方向键），不依赖播放器倍速。`);
    log(state.message);
  }
  await mirrorJob();
}

async function restoreCaptureAcceleration() {
  if (state?.captureSpeedMode === "seek" || String(state?.captureSpeed) === "seek10") {
    await applyCaptureSpeed(1);
    startSeekBoost();
    return { mode: "seek" };
  }
  const wanted = Number(state?.captureSpeed || 1);
  if (wanted > 1) {
    const applied = await applyCaptureSpeed(wanted);
    if (!applied?.ok || Math.abs(Number(applied.rate) - wanted) > 0.05) {
      startSeekBoost();
      return { mode: "seek", fallback: true, applied };
    }
    state.captureSpeedMode = "rate";
    return { mode: "rate", applied };
  }
  stopSeekBoost();
  state.captureSpeedMode = "rate";
  await applyCaptureSpeed(1);
  return { mode: "rate" };
}

async function applyCaptureSpeed(rate = Number(state?.captureSpeed || 1)) {
  const tabId = Number(candidate?.tabId);
  if (!(tabId >= 0)) return null;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      args: [Number(rate) || 1],
      func: (wanted) => {
        const videos = [...document.querySelectorAll("video")].filter((item) => item.duration || item.readyState || item.clientWidth);
        const video = videos.sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))[0];
        if (!video) return null;
        try {
          if (wanted > 1) video.muted = true;
          video.playbackRate = wanted;
          void video.play().catch(() => {});
        } catch (error) {
          return { ok: false, reason: String(error?.message || error) };
        }
        return { ok: true, rate: video.playbackRate };
      }
    });
    return (results || []).map((item) => item?.result).find(Boolean) || null;
  } catch {
    return null;
  }
}

async function changeCaptureSpeed(rate) {
  const raw = String(rate || "1");
  if (raw === "seek10") {
    stopSeekBoost();
    const settings = normalizedSeekBoostSettings();
    state.captureSpeed = settings.stepSeconds;
    state.captureSpeedMode = "seek";
    await applyCaptureSpeed(1);
    startSeekBoost(settings);
    state.message = t("captureSeekBoostApplied", [settings.intervalSec, settings.stepSeconds], `已改为每 ${settings.intervalSec} 秒快进约 ${settings.stepSeconds} 秒（类似连续按右方向键），不依赖播放器倍速。`);
    log(state.message);
    await mirrorJob();
    render();
    return;
  }
  const wanted = Number(raw) || 1;
  stopSeekBoost();
  state.captureSpeed = wanted;
  state.captureSpeedMode = "rate";
  if (wanted <= 1) {
    await applyCaptureSpeed(1);
    state.message = t("captureSpeedNormal", null, "正常速度");
    log(state.message);
    await mirrorJob();
    render();
    return;
  }
  const applied = await applyCaptureSpeed(wanted);
  const settings = normalizedSeekBoostSettings();
  if (!applied) {
    startSeekBoost(settings);
    state.message = t("captureSpeedFallbackSeek", [settings.intervalSec, settings.stepSeconds], `找不到可倍速的播放器，已改为自动快进（每 ${settings.intervalSec} 秒约 +${settings.stepSeconds}s）。`);
  } else if (!applied.ok || Math.abs(Number(applied.rate) - wanted) > 0.05) {
    startSeekBoost(settings);
    state.message = t("captureSpeedFallbackSeekLimited", [wanted, applied.rate || 1, settings.intervalSec, settings.stepSeconds], `网站不支持 ${wanted}x（当前约 ${applied.rate || 1}x），已改为自动快进（每 ${settings.intervalSec} 秒约 +${settings.stepSeconds}s）。`);
  } else {
    state.message = t("captureSpeedApplied", wanted, `已按 ${wanted}x 静音播放来加快保存；速度过高时播放器可能来不及请求，出现缺口可用智能补全。`);
  }
  log(state.message);
  await mirrorJob();
  render();
}

async function smartFillMissing() {
  if (smartFillRunning) return;
  if (!confirm(t("smartFillConfirm", null, "开始智能补全？Web Keeper 会在原网页中跳到缺失位置；加载跟不上时会自动减速或停止。"))) return;
  if (state.status === "paused") await runCapture();
  await updateMissingTimeline();
  if (!(state.missingRanges || []).length) {
    alert(t("smartFillNothingMissing", null, "当前没有检测到缺失分片。"));
    return;
  }
  smartFillRunning = true;
  paused = false;
  state.stalled = false;
  state.message = t("smartFillWorking", null, "正在按缺失位置辅助播放；播放器加载慢时会等待。");
  await mirrorJob();
  startProgressWatchdog();
  try {
    while (smartFillRunning && !paused) {
      await updateMissingTimeline();
      const ranges = state.missingRanges || [];
      if (!ranges.length) break;
      const range = ranges[0];
      const remainingRanges = ranges.length;
      smartFillActiveRange = range;
      const rangeStart = Number(range.startSeconds || 0);
      const rangeEnd = Number(range.endSeconds || rangeStart);
      state.message = t("smartFillRangeWorking", [formatTime(rangeStart), formatTime(rangeEnd), range.count, remainingRanges], `正在补 ${formatTime(rangeStart)} – ${formatTime(rangeEnd)}（${range.count} 项）；还剩 ${remainingRanges} 处缺口。`);
      await mirrorJob();
      let cursor = Math.max(0, rangeStart - 2);
      let step = 8;
      let noProgress = 0;
      let skewWarned = false;
      while (smartFillRunning && !paused && cursor < rangeEnd + 1) {
        const before = Number(state.done || 0);
        const player = await seekVideoAndInspect(Number(candidate.tabId), cursor);
        if (state.captureSpeedMode !== "seek" && Number(state.captureSpeed || 1) > 1) await applyCaptureSpeed();
        if (!player?.ok) throw new Error(t("videoElementNotFound", null, "原网页中没有找到可控制的视频播放器，请手动播放到提示位置。"));
        const actual = Number(player.currentTime || 0);
        const inRange = actual >= rangeStart - SMART_FILL_SEEK_SKEW_SECONDS && actual <= rangeEnd + SMART_FILL_SEEK_SKEW_SECONDS + step;
        if (!inRange && !skewWarned) {
          skewWarned = true;
          const skewMessage = t("smartFillSeekSkew", [formatTime(actual), formatTime(rangeStart), formatTime(rangeEnd)], `播放器停在 ${formatTime(actual)}，与目标缺口 ${formatTime(rangeStart)} – ${formatTime(rangeEnd)} 差距较大。将重试跳转；若反复失败请手动拖到该时间。`);
          state.message = skewMessage;
          state.stalled = true;
          await mirrorJob();
          alert(skewMessage);
          state.stalled = false;
        }
        const loaded = player.readyState >= 2 && (!player.bufferedEnd || player.bufferedEnd >= player.currentTime + 0.5);
        await waitFor(loaded ? 1400 : 3200);
        if (Number(state.done || 0) > before) {
          noProgress = 0;
          step = Math.min(10, step + 1);
          state.message = t("smartFillRangeWorking", [formatTime(rangeStart), formatTime(rangeEnd), Math.max(1, Number(state.missing || 1)), remainingRanges], `正在补 ${formatTime(rangeStart)} – ${formatTime(rangeEnd)}；还剩 ${remainingRanges} 处缺口。`);
          await mirrorJob();
        } else {
          noProgress += 1;
          step = Math.max(2, Math.floor(step / 2));
        }
        if (noProgress >= 5) {
          const stuck = t("smartFillNoProgress", formatTime(actual || cursor), `在 ${formatTime(actual || cursor)} 附近没有取得新内容，已停止自动跳转。请手动播放这里后继续。`);
          state.stalled = true;
          throw new Error(stuck);
        }
        await updateMissingTimeline();
        const stillThisRange = (state.missingRanges || []).some((item) => (
          Number(item.sequenceFrom) <= Number(range.sequenceTo)
          && Number(item.sequenceTo) >= Number(range.sequenceFrom)
        ));
        if (!stillThisRange) break;
        cursor += step;
      }
      await updateMissingTimeline();
      const nextRanges = state.missingRanges || [];
      if (!nextRanges.length) break;
      const next = nextRanges[0];
      const sameGap = Number(next.sequenceFrom) === Number(range.sequenceFrom);
      if (sameGap) {
        const remainMsg = t("smartFillRangeStillMissing", [formatTime(next.startSeconds), formatTime(next.endSeconds), next.count], `这段缺口仍未补齐（约 ${formatTime(next.startSeconds)} – ${formatTime(next.endSeconds)}，还缺 ${next.count} 项）。请确认网页已播到该时间后再继续。`);
        state.message = remainMsg;
        state.stalled = true;
        await mirrorJob();
        alert(remainMsg);
        break;
      }
      const nextMsg = t("smartFillNextRange", [formatTime(next.startSeconds), formatTime(next.endSeconds), nextRanges.length, next.count], `本段已处理。下一处缺口约在 ${formatTime(next.startSeconds)} – ${formatTime(next.endSeconds)}（${next.count} 项，共剩 ${nextRanges.length} 处）。将继续自动跳转。`);
      state.message = nextMsg;
      await mirrorJob();
      alert(nextMsg);
    }
    await updateMissingTimeline();
    smartFillActiveRange = null;
    state.stalled = Boolean(state.missing);
    state.message = state.missing
      ? t("smartFillStillMissing", state.missing, `自动补全结束，仍有 ${state.missing} 项需要手动播放。`)
      : t("smartFillComplete", null, "缺失位置已经补全，正在检查视频。");
    await mirrorJob();
    if (state.missing) alert(state.message);
    if (!state.missing && autoFinalize) await mergeOutput(false);
  } catch (error) {
    state.status = "waiting";
    state.stalled = true;
    state.message = error.message;
    await mirrorJob();
    alert(error.message);
  } finally {
    smartFillRunning = false;
    smartFillActiveRange = null;
    if (paused || !["downloading", "capturing", "waiting"].includes(state?.status)) stopProgressWatchdog();
    else startProgressWatchdog();
    render();
  }
}

async function removeTemporaryData() {
  try { await workDirectory.removeEntry("segments", { recursive: true }); } catch (error) { if (error.name !== "NotFoundError") throw error; }
  if (state.providerId === "dash") {
    try { await workDirectory.removeEntry("dash", { recursive: true }); } catch (error) { if (error.name !== "NotFoundError") throw error; }
  }
  if (state.separateTracks) {
    try { await workDirectory.removeEntry("hls-tracks", { recursive: true }); } catch (error) { if (error.name !== "NotFoundError") throw error; }
  }
  await deleteSegmentRecords(state.id);
}

async function finalizeDownloadedTask() {
  if (dashCapture) return finalizeDashCapture();
  if (state.mode === "browser-assisted" || (state.providerId === "hls" && !state.separateTracks)) return mergeOutput(true);
  const previous = autoFinalize;
  autoFinalize = true;
  try { await runDirect(); }
  finally { autoFinalize = previous; }
}

async function deleteTaskSegments() {
  if (!confirm(t("deleteTemporaryConfirm", null, "清理这个下载的临时文件？生成的视频和以前保存的其他内容都不会删除。"))) return;
  await ensureDirectories();
  await removeTemporaryData();
  segmentDirectory = await workDirectory.getDirectoryHandle("segments", { create: true });
  state.temporaryCleaned = true;
  state.message = t("temporaryFilesDeleted", null, "这个下载的临时文件已清理；生成的视频仍然保留。");
  await mirrorJob();
}

async function openGeneratedVideo() {
  if (!state.outputName) return;
  if (state.browserDownloadId) {
    await chrome.downloads.show(state.browserDownloadId);
    return;
  }
  await ensureDirectories();
  const handle = await workDirectory.getFileHandle(state.outputName);
  const file = await handle.getFile();
  const objectUrl = URL.createObjectURL(file);
  window.open(objectUrl, "_blank", "noopener");
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
}

async function deleteOutput() {
  if (!state.outputName || !confirm(t("deleteOutputConfirm", state.outputName, `删除生成的视频 ${state.outputName}？临时下载内容和任务记录会保留。`))) return;
  await ensureDirectories();
  if (state.browserDownloadId) {
    try { await chrome.downloads.removeFile(state.browserDownloadId); } catch (error) { if (!/not found/i.test(error.message || "")) throw error; }
  }
  try { await workDirectory.removeEntry(state.outputName); } catch (error) { if (error.name !== "NotFoundError") throw error; }
  const deletedName = state.outputName;
  state.outputName = "";
  state.browserDownloadId = null;
  state.outputInternalDeleted = false;
  if (state.providerId === "direct-file") { state.done = 0; state.bytes = 0; state.totalBytes = 0; }
  state.status = "ready";
  state.message = t("outputDeleted", deletedName, `${deletedName} 已删除；其他已保存内容仍然保留。`);
  await mirrorJob();
}

async function removeTask(jobId = state?.id) {
  if (!jobId || !confirm(t("removeTaskConfirm", null, "从下载中心移除这条任务记录？已经保存的文件和断点内容都会保留。"))) return;
  if (state?.id === jobId && state.mode === "browser-assisted") await stopPageCaptureHook(candidate?.tabId);
  await dbDelete("states", jobId);
  await dbDelete("handles", jobId);
  const stored = await chrome.storage.local.get({ [JOBS_KEY]: [] });
  const jobs = (stored[JOBS_KEY] || []).filter((item) => item.id !== jobId);
  await chrome.storage.local.set({ [JOBS_KEY]: jobs });
  if (state?.id === jobId) location.href = "download.html";
  else await showTaskList();
}

async function openVideoTab() {
  if (candidate.tabId >= 0) {
    try { await chrome.tabs.update(candidate.tabId, { active: true }); } catch { /* tab closed */ }
  }
}

async function readDirectoryFiles(directoryHandle) {
  const files = [];
  for await (const [name, handle] of directoryHandle.entries()) {
    if (handle.kind === "file") files.push({ name, handle });
  }
  return files;
}

async function readDirectoryDirs(directoryHandle) {
  const dirs = [];
  for await (const [name, handle] of directoryHandle.entries()) {
    if (handle.kind === "directory") dirs.push({ name, handle });
  }
  return dirs;
}

function legacySequenceFromName(name) {
  const match = String(name || "").match(/(?:^|[_\-.])(\d{1,10})\.ts$/i) || String(name || "").match(/(\d{1,10})/);
  return match ? Number(match[1]) : null;
}

async function directoryLooksLikeVariant(directoryHandle) {
  for await (const [name, handle] of directoryHandle.entries()) {
    if (handle.kind === "file" && /\.ts$/i.test(name)) return true;
  }
  return false;
}

async function collectLegacyVariants(directoryHandle) {
  if (await directoryLooksLikeVariant(directoryHandle)) {
    const parentName = directoryHandle.name || "video";
    const resolution = /^\d{2,5}x\d{2,5}$/i.test(parentName) ? parentName : "auto";
    return [{ product: resolution === "auto" ? parentName : "imported", resolution, handle: directoryHandle, label: parentName }];
  }
  const variants = [];
  const children = await readDirectoryDirs(directoryHandle);
  for (const child of children) {
    if (await directoryLooksLikeVariant(child.handle)) {
      variants.push({
        product: directoryHandle.name || "imported",
        resolution: child.name,
        handle: child.handle,
        label: `${directoryHandle.name}/${child.name}`
      });
      continue;
    }
    const grandchildren = await readDirectoryDirs(child.handle);
    for (const grand of grandchildren) {
      if (await directoryLooksLikeVariant(grand.handle)) {
        variants.push({
          product: child.name,
          resolution: grand.name,
          handle: grand.handle,
          label: `${child.name}/${grand.name}`
        });
      }
    }
  }
  return variants;
}

function rewriteLegacyPlaylistKey(text, keyUrl) {
  return String(text || "").replace(/#EXT-X-KEY:([^\r\n]+)/g, (full, attrs) => {
    if (!/METHOD=AES-128/i.test(attrs)) return full;
    if (/URI="/i.test(attrs)) return `#EXT-X-KEY:${attrs.replace(/URI="[^"]*"/i, `URI="${keyUrl}"`)}`;
    return `#EXT-X-KEY:${attrs},URI="${keyUrl}"`;
  });
}

function buildSyntheticLegacyPlaylist(fileNames, duration = 2.002, keyUrl = "", iv = "") {
  const numbered = fileNames
    .map((name) => ({ name, sequence: legacySequenceFromName(name) }))
    .filter((item) => item.sequence != null)
    .sort((a, b) => a.sequence - b.sequence);
  const lines = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-TARGETDURATION:3", "#EXT-X-MEDIA-SEQUENCE:0", "#EXT-X-PLAYLIST-TYPE:VOD"];
  if (keyUrl) lines.push(`#EXT-X-KEY:METHOD=AES-128,URI="${keyUrl}"${iv ? `,IV=${iv}` : ""}`);
  for (const item of numbered) {
    lines.push(`#EXTINF:${duration},`);
    lines.push(item.name);
  }
  lines.push("#EXT-X-ENDLIST");
  return { text: `${lines.join("\n")}\n`, sequences: numbered };
}

async function ensureImportWorkspace(jobId) {
  const uiSettings = await chrome.storage.local.get({ saveDestination: "browser-downloads" });
  saveDestination = uiSettings.saveDestination === "custom-folder" ? "custom-folder" : "browser-downloads";
  if (saveDestination === "browser-downloads") {
    if (!navigator.storage?.getDirectory) throw new Error(t("browserStorageUnavailable", null, "浏览器无法提供扩展内部下载空间。"));
    rootHandle = await navigator.storage.getDirectory();
  } else {
    const handleRecord = await dbGet("handles", "default-root");
    rootHandle = handleRecord?.handle || null;
    if (!rootHandle) throw new Error(t("selectFolderFirst", null, "请先在设置里选择保存位置，或改回浏览器 Downloads。"));
  }
  await dbPut("handles", { id: jobId, handle: rootHandle });
}

async function importLegacyVariant(variant, { onProgress } = {}) {
  let product = safeName(variant.product, "imported");
  const resolution = safeName(variant.resolution, "auto");
  if (product === "imported" && /^\d{2,5}x\d{2,5}$/i.test(resolution)) {
    const typed = window.prompt(t("legacyAskProduct", null, "你选的是清晰度文件夹。请输入作品名（例如 ofje00435）："), "");
    if (typed && typed.trim()) product = safeName(typed.trim(), "imported");
  }
  const candidateId = `legacy:${product}:${resolution}`;
  const jobId = `job:${candidateId}:direct`;
  const existing = await dbGet("states", jobId);
  if (existing?.source === "legacy-import" && Number(existing.done || 0) > 0) {
    return { jobId, skipped: true, product, resolution, done: existing.done, total: existing.total };
  }

  const files = await readDirectoryFiles(variant.handle);
  const tsFiles = files.filter((item) => /\.ts$/i.test(item.name));
  if (!tsFiles.length) throw new Error(t("legacyNoSegments", variant.label, `目录 ${variant.label} 里没有找到 .ts 分片。`));

  const playlistFile = files.find((item) => /^(first|index|playlist|source)\.m3u8$/i.test(item.name)) || files.find((item) => /\.m3u8$/i.test(item.name));
  const keyFile = files.find((item) => /^file\.key$/i.test(item.name));
  const legacyKeyUrl = `https://legacy.local/aes-key/${encodeURIComponent(candidateId)}`;
  let playlistText = "";
  if (playlistFile) playlistText = await (await playlistFile.handle.getFile()).text();
  else {
    playlistText = buildSyntheticLegacyPlaylist(tsFiles.map((item) => item.name), 2.002, keyFile ? legacyKeyUrl : "").text;
  }
  if (keyFile) playlistText = rewriteLegacyPlaylistKey(playlistText, legacyKeyUrl);

  const baseUrl = `https://legacy.local/${encodeURIComponent(product)}/${encodeURIComponent(resolution)}/source.m3u8`;
  const parsed = parsePlaylist(playlistText, baseUrl);
  if (!parsed.segments.length) throw new Error(t("legacyPlaylistEmpty", variant.label, `无法从 ${variant.label} 解析分片列表。`));
  if (keyFile) {
    await cacheLegacyAesKey(await (await keyFile.handle.getFile()).arrayBuffer(), legacyKeyUrl);
    for (const segment of parsed.segments) {
      if (segment.key) segment.key = { ...segment.key, url: legacyKeyUrl };
    }
  }

  const byName = new Map(tsFiles.map((item) => [item.name.toLowerCase(), item]));
  const importable = parsed.segments.filter((segment) => {
    let name = "";
    try { name = decodeURIComponent(new URL(segment.url).pathname.split("/").pop() || ""); } catch { name = ""; }
    return byName.has(name.toLowerCase());
  });
  if (!importable.length) throw new Error(t("legacySegmentsUnmatched", variant.label, `${variant.label} 的播放列表与目录中的分片对不上。`));

  await ensureImportWorkspace(jobId);
  state = {
    id: jobId,
    candidateId,
    candidate: null,
    mode: "direct",
    product,
    title: product,
    resolution,
    status: "downloading",
    done: 0,
    total: parsed.segments.filter((item) => !item.gap).length,
    bytes: 0,
    failed: 0,
    providerId: "hls",
    progressUnit: "items",
    source: "legacy-import",
    legacyKeyUrl: keyFile ? legacyKeyUrl : "",
    saveDestination,
    message: t("legacyImportWorking", [product, resolution], `正在导入旧捕获 ${product} / ${resolution}…`)
  };
  candidate = {
    id: candidateId,
    product,
    resolution,
    pageTitle: product,
    pageUrl: "",
    tabId: -1,
    playlistUrl: baseUrl,
    playlistUrls: [baseUrl],
    headers: {},
    subtitles: [],
    decision: "direct",
    providerHint: "hls"
  };
  state.candidate = { ...candidate };
  await ensureDirectories({ requestPermission: true });
  await writeFile(workDirectory, "source.m3u8", playlistText);
  if (keyFile) await writeFile(workDirectory, "file.key", await (await keyFile.handle.getFile()).arrayBuffer());

  indexMediaPlaylist(parsed);
  let imported = 0;
  let bytes = 0;
  for (const [index, segment] of importable.entries()) {
    let name = "";
    try { name = decodeURIComponent(new URL(segment.url).pathname.split("/").pop() || ""); } catch { name = ""; }
    const source = byName.get(name.toLowerCase());
    if (!source) continue;
    const existingSegment = await savedSegment(segment.sequence);
    if (existingSegment?.skipped) continue;
    if (existingSegment) {
      imported += 1;
      bytes += Number(existingSegment.size || 0);
    } else {
      const encrypted = await (await source.handle.getFile()).arrayBuffer();
      const decrypted = await decryptIfNeeded(segment, encrypted);
      if (!isValidSegmentSize(decrypted.byteLength)) {
        await maybeMarkSkippable(segment, { tinySize: decrypted.byteLength });
        continue;
      }
      const fileName = segmentFileName(segment);
      await writeFile(segmentDirectory, fileName, decrypted);
      const record = {
        id: `${jobId}:${segment.sequence}`,
        jobId,
        sequence: segment.sequence,
        fileName,
        size: decrypted.byteLength,
        url: segment.url,
        savedAt: Date.now(),
        source: "legacy-import"
      };
      await dbPut("segments", record);
      imported += 1;
      bytes += decrypted.byteLength;
    }
    state.done = imported;
    state.bytes = bytes;
    if (index % 12 === 0 || index === importable.length - 1) {
      state.message = t("legacyImportProgress", [imported, importable.length, product, resolution], `已导入 ${imported}/${importable.length} · ${product} / ${resolution}`);
      await mirrorJob();
      if (onProgress) onProgress(state);
      await waitFor(0);
    }
  }

  try {
    const subtitleSource = await variant.handle.getDirectoryHandle("subtitles");
    const target = await workDirectory.getDirectoryHandle("subtitles", { create: true });
    let subtitleCount = 0;
    const walk = async (dir, prefix = "") => {
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind === "directory") {
          await walk(handle, `${prefix}${name}/`);
          continue;
        }
        if (!/\.(vtt|srt|ttml|dfxp|ass|ssa)$/i.test(name)) continue;
        const data = await (await handle.getFile()).arrayBuffer();
        await writeFile(target, safeName(`${prefix.replace(/\//g, "_")}${name}`, `subtitle-${subtitleCount + 1}.vtt`), data);
        subtitleCount += 1;
      }
    };
    await walk(subtitleSource);
    state.subtitlesSaved = subtitleCount;
  } catch { /* no local subtitles */ }

  await reclassifySkippableGaps();
  await updateMissingTimeline();
  const missing = Number(state.missing || 0);
  const skipped = Number(state.skippableCount || 0);
  state.status = missing ? "paused" : "downloaded";
  state.message = missing
    ? t("legacyImportMissing", [imported, missing], `已导入 ${imported} 个分片，仍有 ${missing} 处缺口。打开原网页播放后可用网页辅助/智能补全继续；分片齐了再生成视频。`)
      + (skipped ? ` ${t("skippableSegmentsNote", skipped, `已确认 ${skipped} 个空壳/可跳过分片（前后时间轴连贯，不再重试）。`)}` : "")
    : t("legacyImportReady", imported, `已导入 ${imported} 个分片，可直接检查并生成视频。字幕与播放加速/智能补全在绑定原网页后仍可使用。`)
      + (skipped ? ` ${t("skippableSegmentsNote", skipped, `已确认 ${skipped} 个空壳/可跳过分片（前后时间轴连贯，不再重试）。`)}` : "");
  const storedCandidates = await chrome.storage.local.get({ [CANDIDATES_KEY]: [] });
  const candidateList = Array.isArray(storedCandidates[CANDIDATES_KEY]) ? storedCandidates[CANDIDATES_KEY] : [];
  const candidateIndex = candidateList.findIndex((item) => item.id === candidateId);
  if (candidateIndex >= 0) candidateList[candidateIndex] = { ...candidateList[candidateIndex], ...candidate };
  else candidateList.unshift(candidate);
  await chrome.storage.local.set({ [CANDIDATES_KEY]: candidateList.slice(0, 100) });
  await mirrorJob();
  return { jobId, skipped: false, product, resolution, done: imported, total: state.total, missing };
}

async function importLegacyCapture() {
  if (!window.showDirectoryPicker) throw new Error(t("directoryPickerUnavailable", null, "当前浏览器不支持选择文件夹。"));
  const directory = await window.showDirectoryPicker({ id: "web-keeper-legacy-import", mode: "read" });
  const variants = await collectLegacyVariants(directory);
  if (!variants.length) throw new Error(t("legacyFolderUnrecognized", null, "没有识别到旧捕获目录。请选择 data\\\\captures、作品文件夹，或具体清晰度文件夹（内含 .ts）。"));
  $("taskView").hidden = false;
  $("listView").hidden = true;
  $("notice").className = "notice";
  $("notice").textContent = t("legacyImportStarting", variants.length, `准备导入 ${variants.length} 个旧清晰度目录…`);
  $("status").textContent = t("legacyImportStatus", null, "正在导入旧捕获");
  const results = [];
  for (const variant of variants) {
    results.push(await importLegacyVariant(variant));
  }
  const first = results.find((item) => !item.skipped) || results[0];
  if (first?.jobId) location.href = `download.html?job=${encodeURIComponent(first.jobId)}`;
  else await showTaskList();
}

async function showTaskList() {
  $("taskView").hidden = true;
  $("listView").hidden = false;
  $("diagnosticsPanel").hidden = !showDiagnostics;
  const stored = await chrome.storage.local.get({ [JOBS_KEY]: [], [CANDIDATES_KEY]: [] });
  const jobs = stored[JOBS_KEY] || [];
  const candidates = stored[CANDIDATES_KEY] || [];
  const importBar = `<div class="actions" style="margin:12px 0 4px"><button id="importLegacy" class="primary">${escapeHtml(t("importLegacyCapture", null, "导入旧捕获目录"))}</button><span class="muted">${escapeHtml(t("importLegacyCaptureHint", null, "选择 data\\\\captures、作品夹或清晰度文件夹，继续补洞/生成视频。"))}</span></div>`;
  if (!jobs.length && !candidates.length) {
    $("taskList").innerHTML = `${importBar}<div class="muted">${t("noDownloadTasks", null, "还没有下载。打开监听并播放视频后，从扩展创建任务；也可导入旧的 data\\\\captures 目录。")}</div>`;
  } else {
    const groups = new Map();
    const candidateById = new Map(candidates.map((item) => [item.id, item]));
    const keyFor = (item) => {
      let site = "";
      const source = item.candidateId ? candidateById.get(item.candidateId) : item;
      try { site = new URL(source?.pageUrl || item.pageUrl || "").hostname; } catch { /* no source page */ }
      return `${site}|${item.product || item.title || "video"}`;
    };
    for (const item of candidates) {
      const key = keyFor(item);
      if (!groups.has(key)) groups.set(key, { title: item.pageTitle || item.product, product: item.product, candidates: [], jobs: [] });
      groups.get(key).candidates.push(item);
    }
    for (const job of jobs) {
      const key = keyFor(job);
      if (!groups.has(key)) groups.set(key, { title: job.title || job.product, product: job.product, candidates: [], jobs: [] });
      groups.get(key).jobs.push(job);
    }
    $("taskList").innerHTML = importBar + [...groups.values()].map((work) => {
      const resolutions = Array.from(new Set([...work.candidates.map((item) => item.resolution), ...work.jobs.map((item) => item.resolution)].filter(Boolean)));
      const subtitleCount = new Set(work.candidates.flatMap((item) => item.subtitles || [])).size;
      const latestJob = [...work.jobs].sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))[0];
      const status = latestJob ? statusLabel(latestJob.status) : t("waitingForChoice", null, "等待选择保存方式");
      const candidate = work.candidates.find((item) => item.decision === "pending") || work.candidates[0];
      const chips = [
        t("qualityCount", resolutions.length, `${resolutions.length} 个清晰度`),
        subtitleCount ? t("subtitlesFound", subtitleCount, `发现 ${subtitleCount} 条字幕`) : t("subtitlesNotFound", null, "暂未发现字幕")
      ];
      const taskRows = work.jobs.map((job) => {
        const progress = job.progressUnit === "bytes" ? `${formatBytes(job.bytes)} / ${job.totalBytes ? formatBytes(job.totalBytes) : "?"}` : `${job.done || 0}/${job.total || "?"}`;
        return `<div class="task"><div><strong>${escapeHtml(job.resolution || t("automaticQuality", null, "自动清晰度"))}</strong><div class="muted">${escapeHtml(statusLabel(job.status))} · ${escapeHtml(progress)} · ${escapeHtml(formatBytes(job.bytes))}${job.outputName ? ` · ${escapeHtml(job.outputName)}` : ""}</div></div><div class="actions"><a class="button" href="?job=${encodeURIComponent(job.id)}">${escapeHtml(t("openTask", null, "查看下载"))}</a><button class="danger" data-remove-job="${encodeURIComponent(job.id)}">${escapeHtml(t("removeTask", null, "从列表移除"))}</button></div></div>`;
      }).join("");
      const newActions = !latestJob && candidate ? `<div class="actions"><button class="primary" data-new-candidate="${encodeURIComponent(candidate.id)}" data-mode="direct">${escapeHtml(t("directDownload", null, "直接下载（推荐）"))}</button><button data-new-candidate="${encodeURIComponent(candidate.id)}" data-mode="browser-assisted">${escapeHtml(t("browserAssisted", null, "网页辅助保存"))}</button></div>` : "";
      return `<section class="work-card"><div class="work-head"><div><strong>${escapeHtml(safeName(work.title || work.product || t("downloadTask", null, "视频下载")))}</strong><div class="muted">${escapeHtml(status)}</div></div></div><div class="chips">${chips.map((item) => `<span class="chip">${escapeHtml(item)}</span>`).join("")}</div>${taskRows || `<div class="muted">${escapeHtml(t("noTaskForVideo", null, "这个视频还没有创建下载。"))}</div>`}${newActions}</section>`;
    }).join("");
  }
  log("任务列表已加载");
}

async function initialize() {
  await openDatabase();
  const uiSettings = await chrome.storage.local.get({ showDiagnostics: false, autoFinalize: true, cleanupAfterMerge: true, directConcurrency: 4, saveDestination: "browser-downloads" });
  showDiagnostics = Boolean(uiSettings.showDiagnostics);
  autoFinalize = uiSettings.autoFinalize !== false;
  cleanupAfterMerge = uiSettings.cleanupAfterMerge !== false;
  directConcurrency = [2, 4, 6].includes(Number(uiSettings.directConcurrency)) ? Number(uiSettings.directConcurrency) : 4;
  const requestedJobId = query.get("job");
  const candidateId = query.get("candidate");
  const mode = query.get("mode");
  let shouldAutoStart = false;
  let storedHandleReady = false;
  if (!requestedJobId && !candidateId) return showTaskList();

  if (requestedJobId) state = await dbGet("states", requestedJobId);
  if (state && ["downloading", "capturing", "merging", "exporting"].includes(state.status)) {
    state.status = "paused";
    state.errorCode = "";
    state.message = t("interruptedReadyToResume", null, "上次任务在页面关闭时中断，已保存内容仍然保留。点击继续即可恢复。");
  }
  const stored = await chrome.storage.local.get({ [CANDIDATES_KEY]: [] });
  if (state) candidate = (stored[CANDIDATES_KEY] || []).find((item) => item.id === state.candidateId) || state.candidate;
  else candidate = (stored[CANDIDATES_KEY] || []).find((item) => item.id === candidateId);
  if (!candidate) throw new Error(t("taskNotFound", null, "找不到这个视频。请回到网页重新播放几秒，再从扩展打开。"));
  candidate.subtitles = validSubtitleUrls(candidate.subtitles || []);
  const detectedProvider = WebKeeperMediaEngine.selectProvider(candidate, mode || state?.mode || "direct");

  if (!state) {
    const jobId = `job:${candidate.id}:${mode}`;
    const existingState = await dbGet("states", jobId);
    shouldAutoStart = !existingState;
    state = existingState || {
      id: jobId, candidateId: candidate.id, candidate: { ...candidate }, mode,
      product: candidate.product, title: candidate.pageTitle || candidate.product,
      resolution: candidate.resolution, status: "ready", done: 0, total: 0, bytes: 0,
      failed: 0, providerId: detectedProvider?.id || "unknown", progressUnit: detectedProvider?.id === "direct-file" ? "bytes" : "items",
      saveDestination: uiSettings.saveDestination === "custom-folder" ? "custom-folder" : "browser-downloads",
      message: mode === "direct" ? t("directReadyMessage", null, "准备开始直接下载。") : t("assistedReadyMessage", null, "准备好后，请返回网页继续播放。")
    };
  }
  state.candidate = { ...candidate };
  state.providerId ||= detectedProvider?.id || "unknown";
  state.progressUnit ||= state.providerId === "direct-file" ? "bytes" : "items";
  const handleRecord = await dbGet("handles", state.id) || await dbGet("handles", "default-root");
  saveDestination = ["browser-downloads", "custom-folder"].includes(state.saveDestination)
    ? state.saveDestination
    : (requestedJobId && handleRecord?.handle ? "custom-folder" : (uiSettings.saveDestination === "custom-folder" ? "custom-folder" : "browser-downloads"));
  state.saveDestination = saveDestination;
  if (saveDestination === "browser-downloads") {
    if (!navigator.storage?.getDirectory) throw new Error(t("browserStorageUnavailable", null, "浏览器无法提供扩展内部下载空间。"));
    rootHandle = await navigator.storage.getDirectory();
  } else {
    rootHandle = handleRecord?.handle || null;
    if (rootHandle && handleRecord.id === "default-root") await dbPut("handles", { id: state.id, handle: rootHandle });
  }
  if (rootHandle) {
    try {
      await ensureDirectories({ requestPermission: false });
      await reconcileSaved();
      if (state.source === "legacy-import" || state.providerId === "hls" || state.providerId === "browser-assisted") {
        try {
          if (!mediaPlaylist) await loadMediaPlaylist();
          await prepareTimelineAfterIdle({ reason: "reopen" });
          await updateMissingTimeline();
        } catch (error) {
          if (state.source === "legacy-import") log(`旧捕获播放列表恢复失败：${error.message}`);
          else log(`重新打开任务时时间轴复核跳过：${error.message}`);
        }
      }
      if (state.outputName && state.status === "complete" && !state.validationVersion && !state.outputInternalDeleted) {
        try {
          const legacyOutput = await workDirectory.getFileHandle(state.outputName);
          await validateSavedVideo(legacyOutput);
          state.validationVersion = 1;
        } catch (error) {
          state.status = "error";
          state.errorCode = "MEDIA_INVALID";
          state.message = t("legacyOutputInvalid", error.message, `旧版生成文件未通过视频检查：${error.message}。文件和切片都已保留；重新播放网页后点击继续，会优先尝试完整文件直链。`);
        }
      }
      storedHandleReady = true;
    } catch {
      state.status = ["downloading", "capturing", "merging", "exporting"].includes(state.status) ? "paused" : state.status;
      state.message = t("folderPermissionNeeded", null, "保存位置需要重新授权，请点击继续。");
    }
  }
  await mirrorJob();
  log(`任务已加载：${state.mode === "direct" ? "直接下载" : "浏览器辅助抓取"}`);
  if (shouldAutoStart && storedHandleReady && state.status === "ready") await (state.mode === "direct" ? runDirect() : runCapture());
}

$("choose").addEventListener("click", () => void chooseDirectoryAndStart());
$("resume").addEventListener("click", () => void resumeTask());
$("pause").addEventListener("click", () => void pauseTask());
$("backToVideo").addEventListener("click", () => void openVideoTab());
$("switchAssisted").addEventListener("click", () => void switchToAssisted());
$("smartFill").addEventListener("click", () => void smartFillMissing());
$("captureSpeed").addEventListener("change", (event) => void changeCaptureSpeed(event.target.value));
$("seekBoostInterval").addEventListener("change", () => void applySeekBoostSettingsFromInputs());
$("seekBoostStep").addEventListener("change", () => void applySeekBoostSettingsFromInputs());
$("seekBoostInterval").addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); void applySeekBoostSettingsFromInputs(); } });
$("seekBoostStep").addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); void applySeekBoostSettingsFromInputs(); } });
$("merge").addEventListener("click", () => void finalizeDownloadedTask());
$("openOutput").addEventListener("click", () => void openGeneratedVideo());
$("subtitles").addEventListener("click", () => void saveSubtitles());
$("deleteSegments").addEventListener("click", () => void deleteTaskSegments());
$("deleteOutput").addEventListener("click", () => void deleteOutput());
$("removeTask").addEventListener("click", () => void removeTask());
$("taskList").addEventListener("click", (event) => {
  const importButton = event.target.closest("#importLegacy, #importLegacyEmpty");
  if (importButton) {
    void importLegacyCapture().catch((error) => {
      $("taskView").hidden = true;
      $("listView").hidden = false;
      $("taskList").insertAdjacentHTML("afterbegin", `<div class="notice bad">${escapeHtml(error.message)}</div>`);
      log(error.stack || error.message);
    });
    return;
  }
  const button = event.target.closest("button[data-remove-job]");
  if (button) void removeTask(decodeURIComponent(button.dataset.removeJob));
  const createButton = event.target.closest("button[data-new-candidate]");
  if (createButton) {
    const candidateId = decodeURIComponent(createButton.dataset.newCandidate);
    const mode = createButton.dataset.mode;
    void chrome.runtime.sendMessage({ type: "set-candidate-decision", candidateId, decision: mode }).then((response) => {
      if (!response?.ok) throw new Error(response?.error || t("candidateGone", null, "没有找到这个视频，请重新播放后再试。"));
      location.href = `download.html?candidate=${encodeURIComponent(candidateId)}&mode=${encodeURIComponent(mode)}`;
    }).catch((error) => { $("taskList").insertAdjacentHTML("afterbegin", `<div class="notice bad">${escapeHtml(error.message)}</div>`); });
  }
});

WebKeeperI18n.init().then(initialize).catch((error) => {
  $("taskView").hidden = false;
  $("title").textContent = t("cannotOpenTask", null, "无法打开下载");
  $("status").textContent = t("errorLabel", null, "错误");
  $("status").className = "pill bad";
  $("notice").textContent = error.message;
  $("notice").className = "notice bad";
  $("choose").hidden = true;
  log(error.stack || error.message);
});
