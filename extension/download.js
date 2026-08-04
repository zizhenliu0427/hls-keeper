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
const MAX_SKIP_VERDICTS = 400;
const MAX_RECLASSIFY_PER_PASS = 120;
let skippableCache = { jobId: null, set: new Set() };
let lastImportMirrorAt = 0;
let legacySourceDirectory = null;
let legacyCopyIntoStorage = false;
let playlistSequenceIndex = { playlist: null, map: new Map() };
let missingSort = "time";
let missingShowAll = false;
let missingOrder = new Map();
let missingSnapshotAt = 0;
let missingRenderedKey = "";
let missingPage = 0;
let savedSequenceCache = { jobId: null, set: new Set() };
let lastMissingComputeAt = 0;
let playlistPersistedFor = null;
let recentSegments = [];
let recentSegmentsKey = "";
let lastSegmentSource = "";
let captureSpans = [];
const MISSING_PAGE_SIZE = 50;
const captureRetryCounts = new Map();
// How many times the server has answered a given segment with nothing.
const emptySegmentCounts = new Map();
let pageBufferWaitMs = PAGE_BUFFER_WAIT_COLD_MS;
let pageBufferProvenWaitMs = PAGE_BUFFER_WAIT_PROVEN_MS;
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
let subtitleConvertMode = "none";
let subtitleFormat = "source";
let speedSampleAt = Date.now();
let speedSampleBytes = 0;
let seekBoostTimer = null;
let subtitleSweepRunning = false;

let overflowOpen = false;
// A subtitle cursor that never terminates would otherwise loop forever; the real stop condition
// is "this page added no new cues".
const SUBTITLE_SWEEP_LIMIT = 400;
const SUBTITLE_PLAYER_STEPS = 900;
// Each probe is one real request to the site, so the search stays small.
const SUBTITLE_PROBE_LIMIT = 24;
// Identities proven to decrypt this site's subtitles, newest first. In memory only.
let subtitleKeyCache = [];
// Site secrets proven to decrypt, newest first. In memory only.
let subtitleSecretCache = [];
// Direct downloads retry a segment on their own before giving up on it and moving on.
const DIRECT_SEGMENT_RETRIES = 3;
// Why a subtitle ended up the length it did. The log lives in a collapsed panel, so the reason
// has to travel back to the status line with the result.
let subtitleNote = "";
let progressWatchTimer = null;
let lastProgressAt = Date.now();
let lastProgressMark = { done: 0, bytes: 0 };
let stallAlertShown = false;
let smartFillActiveRange = null;
let smartFillDone = 0;
let smartFillSkipped = 0;
let smartFillGaveUp = new Set();
let directFillRunning = false;
let verifyRunning = false;
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
  if (bytes === speedSampleBytes && elapsed >= 5000) {
    // Nothing arrived for a while: show a real zero instead of a stale trickle.
    state.speedMbps = 0;
    speedSampleAt = now;
    return;
  }
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
  invalidateSavedSequences();
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

// showDirectoryPicker only exposes a folder's name, and a drive root's name is "\\", which on its
// own looks like a bug rather than a location.
function rootFolderLabel(handle) {
  const name = String(handle?.name || "").trim();
  if (!name || name === "\\" || name === "/") return t("driveRootFolder", null, "磁盘根目录（浏览器不提供完整路径）");
  return name;
}

function preferredOutputBaseName() {
  const directName = WebKeeperMediaEngine.directFile(candidate)?.fileName || candidate?.fileName || "";
  const directBase = directName.replace(/\.[a-z0-9]{2,5}$/i, "");
  const pageTitle = String(candidate?.pageTitle || state?.title || "").trim();
  // The page title is usually the site's own name ("AV+ …發片平台"), not the video's, and it
  // sanitises down to junk. The product id (atkd00431) identifies the video and matches what the
  // legacy imports were called, so it comes first.
  const product = String(state?.product || candidate?.product || "").trim();
  let base = safeName(directBase || product || pageTitle || "video");
  if (base.replace(/[^0-9A-Za-z一-鿿]/g, "").length < 3) base = safeName(product || pageTitle || "video");
  const quality = String(state?.resolution || candidate?.resolution || "").trim();
  if (quality && quality !== "auto" && !base.toLowerCase().includes(quality.toLowerCase())) base = `${base}_${safeName(quality)}`;
  return safeName(base);
}

function validSubtitleUrls(urls = []) {
  const confirmed = candidate?.subtitleTypes || {};
  return Array.from(new Set(urls.filter((url) => {
    if (confirmed[String(url)]) return true;
    // .m3u8 is allowed because an HLS sidecar subtitle track is a playlist of WebVTT parts.
    try { return /\.(?:vtt|srt|ttml|dfxp|ass|ssa|m3u8)(?:[?#]|$)/i.test(new URL(url).href); }
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

// Estimated from the average size of what is already saved, so it works for a segment count as
// well as for a byte total.
function remainingTimeText() {
  const done = Number(state?.done || 0);
  const total = Number(state?.total || 0);
  const speed = Number(state?.speedMbps || 0) * 1024 * 1024;
  if (!(done > 0) || !(total > done) || !(speed > 0)) return "";
  const averageBytes = Number(state?.bytes || 0) / done;
  if (!(averageBytes > 0)) return "";
  const seconds = (total - done) * averageBytes / speed;
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  return t("remainingTime", formatTime(seconds), `剩余约 ${formatTime(seconds)}`);
}

function formatTime(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds || 0)));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor(value % 3600 / 60);
  const secs = value % 60;
  return hours ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}` : `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function qualityHeight(resolution) {
  const value = String(resolution || "");
  return Number(value.match(/\d+x(\d+)/)?.[1] || value.match(/(\d+)p/)?.[1] || 0);
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
  // Also re-render so the "last request seen" age keeps counting up between events.
  progressWatchTimer = setInterval(() => { updateTransferSpeed(); render(); void checkProgressStall(); }, 5000);
}

async function inspectPlayerTime() {
  const tabId = Number(candidate?.tabId);
  if (!(tabId >= 0)) return null;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        const collect = (root, out = []) => { for (const node of root.querySelectorAll("*")) { if (node.tagName === "VIDEO") out.push(node); if (node.shadowRoot) collect(node.shadowRoot, out); } return out; };
        const videos = collect(document);
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

function attachedToPage() {
  return Number(candidate?.tabId) >= 0 && Boolean(state?.lastSeenAt || candidate?.pageUrl);
}

function rangeTinyCount(range) {
  const verdicts = state?.segmentSkipVerdicts || {};
  let tiny = 0;
  for (let sequence = Number(range.sequenceFrom); sequence <= Number(range.sequenceTo); sequence += 1) {
    if (verdicts[sequence]?.tinySize != null) tiny += 1;
  }
  return tiny;
}

function rangeKey(range) {
  return `${range.sequenceFrom}-${range.sequenceTo}`;
}

// The order is only recomputed on an explicit action, so rows never jump around while reading;
// the numbers inside them keep updating live.
function refreshMissingSnapshot() {
  missingOrder = new Map(orderedMissingRanges().map((range, index) => [rangeKey(range), index]));
  missingSnapshotAt = Date.now();
}

function orderedMissingRanges() {
  const ranges = [...(state?.missingRanges || [])];
  if (missingSort === "size") return ranges.sort((a, b) => Number(b.count || 0) - Number(a.count || 0) || Number(a.startSeconds || 0) - Number(b.startSeconds || 0));
  return ranges.sort((a, b) => Number(a.startSeconds || 0) - Number(b.startSeconds || 0));
}

function sortedMissingRanges() {
  const ranges = [...(state?.missingRanges || [])];
  if (!missingOrder.size) refreshMissingSnapshot();
  // Filling part of a gap splits it into new keys. Rank those next to the gap they came from,
  // otherwise every save would shuffle the list under the reader.
  const rankFor = (range) => {
    const exact = missingOrder.get(rangeKey(range));
    if (exact != null) return exact;
    let best = null;
    for (const [key, rank] of missingOrder) {
      const from = Number(String(key).split("-")[0]);
      const to = Number(String(key).split("-")[1]);
      if (Number(range.sequenceFrom) >= from && Number(range.sequenceTo) <= to) { best = rank; break; }
    }
    return best == null ? Number.MAX_SAFE_INTEGER : best;
  };
  return ranges.sort((a, b) => rankFor(a) - rankFor(b) || Number(a.sequenceFrom) - Number(b.sequenceFrom));
}

function missingPageCount() {
  return Math.max(1, Math.ceil(sortedMissingRanges().length / MISSING_PAGE_SIZE));
}

function missingRangeText() {
  return sortedMissingRanges().map((range) => {
    const tiny = rangeTinyCount(range);
    return `${formatTime(range.startSeconds)} - ${formatTime(range.endSeconds)}	#${range.sequenceFrom}-#${range.sequenceTo}	${range.count}	${tiny ? `tiny:${tiny}` : "never-downloaded"}`;
  }).join(String.fromCharCode(10));
}

async function copyMissingList() {
  const text = missingRangeText();
  try {
    await navigator.clipboard.writeText(text);
    state.message = t("missingListCopied", String(sortedMissingRanges().length), `已复制 ${sortedMissingRanges().length} 处缺口的完整清单（时间、分片编号、数量、类型）。`);
  } catch {
    state.message = t("missingListCopyFailed", null, "无法写入剪贴板，缺口清单已输出到诊断日志。");
    log(text);
  }
  await mirrorJob();
}

function connectionLines() {
  const lines = [];
  if (inPrivateWindow()) {
    lines.push(saveDestination === "browser-downloads"
      ? t("privateWindowEphemeral", null, "注意：当前是私密窗口，且保存位置是「浏览器 Downloads」——新下载的分片写在内存里，崩溃或关窗即全部丢失。点下面的「改为保存到文件夹」即可当场切换，已保存的分片会一并搬过去。")
      : t("privateWindowFolderOk", null, "当前是私密窗口：任务记录关窗后会丢失，但分片直接写入你选的文件夹，崩溃后可用「导入旧捕获目录」把它接回来继续。"));
  }
  let host = "";
  try { host = new URL(candidate?.pageUrl || "").hostname; } catch { host = ""; }
  const attached = attachedToPage();
  lines.push(attached
    ? t("connectionAttached", [host || t("connectionUnknownHost", null, "已发现的页面"), String(candidate.tabId)], `网页连接：已接上 ${host || "已发现的页面"}（标签页 ${candidate.tabId}）`)
    : t("connectionDetached", null, "网页连接：尚未接上原网页。请打开这个视频的网页并开始播放。"));
  if (state?.lastSeenSequence != null) {
    lines.push(t("connectionLastSequence", String(state.lastSeenSequence), `播放器最近请求的分片：#${state.lastSeenSequence}`));
  }
  const seenAt = Number(state?.lastSeenAt || 0);
  lines.push(seenAt
    ? t("connectionLastSeen", [String(Math.max(0, Math.round((Date.now() - seenAt) / 1000))), state.lastSeenKind || "media"], `最近收到网页的媒体请求：${Math.max(0, Math.round((Date.now() - seenAt) / 1000))} 秒前（${state.lastSeenKind || "media"}）`)
    : t("connectionNothingSeen", null, "还没有收到这个视频的任何媒体请求。"));
  if (state?.legacySourceLabel) {
    lines.push(t("connectionLegacySource", state.legacySourceLabel, `分片来源：就地引用旧目录 ${state.legacySourceLabel}（未复制）`));
  }
  return lines;
}

function coverageInfoAt(fraction) {
  const total = Number(state?.total || 0);
  if (!total || !mediaPlaylist) return "";
  const first = Number(mediaPlaylist.segments?.[0]?.sequence ?? 0);
  const sequence = Math.min(total - 1, Math.max(0, Math.floor(fraction * total))) + first;
  const segment = playlistSegmentBySequence(sequence);
  const at = formatTime(Number(segment?.startSeconds || (fraction * Number(state.duration || 0))));
  const hit = (state?.missingRanges || []).find((range) => sequence >= Number(range.sequenceFrom) && sequence <= Number(range.sequenceTo));
  if (!hit) return t("coverageSaved", [at, String(sequence)], `${at} · #${sequence} · 已保存`);
  return t("coverageMissing", [at, String(hit.sequenceFrom), String(hit.sequenceTo), String(hit.count), formatTime(hit.startSeconds), formatTime(hit.endSeconds)],
    `${at} · 缺口 #${hit.sequenceFrom}–#${hit.sequenceTo}（${hit.count} 项，${formatTime(hit.startSeconds)}–${formatTime(hit.endSeconds)}）`);
}

function drawCoverage() {
  const canvas = $("coverage");
  const total = Number(state?.total || 0);
  const ranges = state?.missingRanges || [];
  const usable = total > 0 && state?.progressUnit !== "bytes";
  canvas.hidden = !usable;
  $("coverageLegend").hidden = !usable;
  if (!usable) return;
  const width = Math.max(1, Math.round(canvas.clientWidth || canvas.parentElement?.clientWidth || 600));
  const ratio = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(width * ratio)) {
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(26 * ratio);
  }
  const context = canvas.getContext("2d");
  if (!context) return;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  const styles = getComputedStyle(document.documentElement);
  context.clearRect(0, 0, width, 26);
  // Saved everywhere first, then punch the gaps out: 1600 gaps as DOM nodes would be far heavier.
  context.fillStyle = styles.getPropertyValue("--blue").trim() || "#2563eb";
  context.fillRect(0, 0, width, 26);
  const first = Number(mediaPlaylist?.segments?.[0]?.sequence ?? 0);
  const columns = new Float32Array(width);
  for (const range of ranges) {
    const from = Math.max(0, Math.min(width, ((Number(range.sequenceFrom) - first) / total) * width));
    const to = Math.max(0, Math.min(width, ((Number(range.sequenceTo) + 1 - first) / total) * width));
    for (let column = Math.floor(from); column < Math.min(width, Math.ceil(to)); column += 1) {
      columns[column] += Math.min(column + 1, to) - Math.max(column, from);
    }
  }
  const gapColor = styles.getPropertyValue("--line").trim() || "#d5dae6";
  for (let column = 0; column < width; column += 1) {
    const missingShare = Math.min(1, columns[column]);
    if (missingShare <= 0.02) continue;
    context.globalAlpha = missingShare;
    context.fillStyle = gapColor;
    context.fillRect(column, 0, 1, 26);
  }
  context.globalAlpha = 1;
}

const RECENT_SEGMENT_LIMIT = 60;

function noteSegmentActivity(entry) {
  const index = recentSegments.findIndex((item) => Number(item.sequence) === Number(entry.sequence));
  if (index >= 0) recentSegments[index] = { ...recentSegments[index], ...entry, at: Date.now() };
  else recentSegments = [{ ...entry, at: Date.now() }, ...recentSegments].slice(0, RECENT_SEGMENT_LIMIT);
  recentSegments.sort((a, b) => Number(b.at) - Number(a.at));
}

function segmentSourceLabel(source) {
  return ({
    "page-buffer": t("sourcePageBuffer", null, "页面已收到"),
    "task-fetch": t("sourceTaskFetch", null, "任务页请求"),
    "page-session": t("sourcePageSession", null, "网页会话请求")
  })[source] || "";
}

function captureSpanFor(range) {
  // A gap shrinks and splits while it is being filled, so remember the span it started as
  // and report progress against that instead of against the ever-changing remainder.
  for (const span of captureSpans) {
    if (Number(range.sequenceFrom) >= span.from && Number(range.sequenceTo) <= span.to) return span;
  }
  const span = { from: Number(range.sequenceFrom), to: Number(range.sequenceTo), total: Number(range.count || 0) };
  captureSpans = [span, ...captureSpans].slice(0, 50);
  return span;
}

function captureSpanProgress(range) {
  const span = captureSpanFor(range);
  const remaining = (state?.missingRanges || [])
    .filter((item) => Number(item.sequenceFrom) >= span.from && Number(item.sequenceTo) <= span.to)
    .reduce((sum, item) => sum + Number(item.count || 0), 0);
  return { done: Math.max(0, span.total - remaining), total: span.total };
}

function renderActivity() {
  const visible = state?.mode === "browser-assisted" && recentSegments.length > 0;
  $("activityPanel").hidden = !visible;
  if (!visible) return;
  const key = recentSegments.map((item) => `${item.sequence}:${item.status}`).join(",");
  if (key === recentSegmentsKey) return;
  recentSegmentsKey = key;
  $("activityList").innerHTML = recentSegments.map((item) => {
    const segment = playlistSegmentBySequence(item.sequence);
    const at = segment ? formatTime(segment.startSeconds) : "—";
    const status = ({
      saving: t("activitySaving", null, "正在保存"),
      saved: t("activitySaved", null, "已保存"),
      failed: t("activityFailed", null, "失败"),
      skipped: t("activitySkipped", null, "已跳过")
    })[item.status] || item.status;
    const details = [item.size ? formatBytes(item.size) : "", item.ms ? `${item.ms} ms` : "", segmentSourceLabel(item.source), item.reason || ""].filter(Boolean).join(" · ");
    return `<div class="activity ${escapeHtml(item.status)}"><span>#${escapeHtml(String(item.sequence))}</span><span class="muted">${escapeHtml(at)}</span><span>${escapeHtml(status)}</span><span class="muted">${escapeHtml(details)}</span></div>`;
  }).join("");
}

function render() {
  if (!state) return;
  const merging = state.status === "merging" && state.mergePercent != null;
  $("taskView").hidden = false;
  $("listView").hidden = true;
  $("title").textContent = state.title || state.product || t("downloadTask", null, "视频下载");
  $("subtitle").textContent = `${state.resolution || t("automaticQuality", null, "自动清晰度")} · ${
    state.source === "legacy-import"
      ? t("downloadMethodLegacyImport", null, "旧捕获导入")
      : (state.mode === "direct" ? t("downloadMethodDirect", null, "直接下载") : t("downloadMethodAssisted", null, "网页辅助"))
  }`;
  $("status").textContent = smartFillRunning
    ? t("smartFillRunningPill", [String(smartFillDone), String(smartFillSkipped)], `智能补全中（已处理 ${smartFillDone}，跳过 ${smartFillSkipped}）`)
    : merging ? `${statusLabel(state.status)} ${state.mergePercent}%` : statusLabel(state.status);
  $("status").className = `pill ${state.status === "complete" ? "ok" : state.status === "error" ? "bad" : ""}`;
  const byteProgress = state.progressUnit === "bytes";
  const total = byteProgress ? Number(state.totalBytes || 0) : Number(state.total || 0);
  const done = byteProgress ? Number(state.bytes || 0) : Number(state.done || 0);
  $("progress").max = merging ? 100 : (total || 1);
  $("progress").value = merging ? state.mergePercent : done;
  $("progressText").textContent = byteProgress
    ? t("byteProgress", [formatBytes(done), total ? formatBytes(total) : "?"], `${formatBytes(done)} / ${total ? formatBytes(total) : "?"}`)
    : total ? (() => {
      // Only show 100% when done plus confirmed-skippable really covers the playlist;
      // rounding alone must never hide a real gap.
      const covered = done + skippableSequenceSet().size >= total;
      const percent = covered ? 100 : Math.min(99, Math.round(done / total * 100));
      const suffix = covered && done < total ? t("progressSkippableSuffix", String(total - done), `（含 ${total - done} 个空壳，无需下载）`) : "";
      return t("progressCount", [done, total, percent], `${done}/${total}（${percent}%）`) + suffix;
    })() : t("itemsSavedCount", done, `已完成 ${done} 项`);
  $("saved").textContent = byteProgress ? (state.status === "complete" ? "1" : "0") : String(done);
  const missingCount = byteProgress
    ? (state.status === "complete" ? 0 : 1)
    : (Array.isArray(state.missingRanges) ? Number(state.missing || 0) : (total ? Math.max(total - done, 0) : null));
  $("missing").textContent = missingCount == null ? "—" : String(missingCount);
  $("bytes").textContent = formatBytes(state.bytes);
  $("speed").textContent = ["downloading", "capturing"].includes(state.status)
    ? [`${Number(state.speedMbps || 0).toFixed(2)} MB/s`, remainingTimeText()].filter(Boolean).join(" · ")
    : "—";
  $("notice").textContent = state.message || t("chooseFolderShort", null, "请选择保存位置。");
  $("notice").className = `notice ${state.status === "error" || state.stalled ? "bad" : ""}`;
  if (state.stalled) $("status").className = "pill bad";
  const hasHandle = Boolean(rootHandle);
  const legacyNeedsAssist = state.source === "legacy-import" && Number(state.missing || 0) > 0 && ["paused", "downloaded", "ready", "waiting"].includes(state.status);
  const ranges = state.missingRanges || [];
  const skippableCount = Number(state.skippableCount || skippableSequenceSet().size || 0);
  const breakCount = timelineBreakSet().size;
  $("missingPanel").hidden = !ranges.length && !skippableCount && !breakCount;
  const pageRanges = sortedMissingRanges().slice(missingPage * MISSING_PAGE_SIZE, (missingPage + 1) * MISSING_PAGE_SIZE);
  const activeSequence = Number(state?.lastSavedSequence);
  const missingKey = `${missingSort}|${missingPage}|${missingSnapshotAt}|${breakCount}|${skippableCount}|${pageRanges.map(rangeKey).join(",")}`;
  // Rebuilding this on every saved segment reshuffled the rows and threw away the scroll
  // position, which made a long gap list impossible to read.
  if (missingKey !== missingRenderedKey) {
    missingRenderedKey = missingKey;
    $("missingRanges").innerHTML = (breakCount
    ? `<div class="muted">${escapeHtml(t("timelineBreaksNote", String(breakCount), `片源有 ${breakCount} 处时间不连续，不影响下载和生成。`))}</div>`
    : "")
    + (skippableCount
    ? `<div class="muted">${escapeHtml(t("skippableSegmentsNote", skippableCount, `已确认 ${skippableCount} 个空壳/可跳过分片（前后时间轴连贯，不再重试）。`))}</div>`
    : "")
    + `<div class="muted">${escapeHtml(t("missingSummary", [String(ranges.length), String(ranges.reduce((sum, item) => sum + Number(item.count || 0), 0))], `共 ${ranges.length} 处缺口，合计 ${ranges.reduce((sum, item) => sum + Number(item.count || 0), 0)} 个分片。`))}</div>`
    + `<div class="actions" style="margin:8px 0"><button data-missing-sort="${missingSort === "size" ? "time" : "size"}">${escapeHtml(missingSort === "size" ? t("missingSortByTime", null, "按时间排序") : t("missingSortBySize", null, "按缺口大小排序"))}</button><button data-missing-page="prev"${missingPage <= 0 ? " disabled" : ""}>${escapeHtml(t("missingPrevPage", null, "上一页"))}</button><span class="chip"><input id="missingPageInput" type="number" min="1" max="${missingPageCount()}" value="${missingPage + 1}" style="width:64px" aria-label="${escapeHtml(t("missingPageOf", [String(missingPage + 1), String(missingPageCount())], `第 ${missingPage + 1} / ${missingPageCount()} 页`))}"> / ${missingPageCount()}</span><button data-missing-page="next"${missingPage + 1 >= missingPageCount() ? " disabled" : ""}>${escapeHtml(t("missingNextPage", null, "下一页"))}</button><button data-missing-copy="1">${escapeHtml(t("missingCopyList", null, "复制完整清单"))}</button></div>`
    + pageRanges.map((range) => {
      const active = smartFillActiveRange
        && Number(range.sequenceFrom) === Number(smartFillActiveRange.sequenceFrom)
        && Number(range.sequenceTo) === Number(smartFillActiveRange.sequenceTo);
      // Breathing highlight on the gap the player is feeding right now.
      const live = Number.isFinite(activeSequence) && activeSequence >= Number(range.sequenceFrom) - 2 && activeSequence <= Number(range.sequenceTo) + 2;
      const tiny = rangeTinyCount(range);
      // A gap can mean two very different things, and the fix differs, so name which one it is.
      const kind = tiny === Number(range.count || 0)
        ? t("missingKindTiny", null, "下载过但内容为空，需要重下")
        : tiny
          ? t("missingKindMixed", String(tiny), `其中 ${tiny} 个下载过但为空`)
          : t("missingKindNever", null, "从未下载");
      return `<div class="range${active ? " active" : ""}${live ? " live" : ""}" data-range-key="${escapeHtml(rangeKey(range))}"><span>${escapeHtml(formatTime(range.startSeconds))} – ${escapeHtml(formatTime(range.endSeconds))} · #${escapeHtml(String(range.sequenceFrom))}–#${escapeHtml(String(range.sequenceTo))}${active ? ` · ${escapeHtml(t("smartFillCurrentRangeMark", null, "正在补"))}` : ""}<span data-live-mark${live ? "" : " hidden"}> · ${escapeHtml(live ? t("capturingNowProgress", [String(captureSpanProgress(range).done), String(captureSpanProgress(range).total)], `正在捕获 ${captureSpanProgress(range).done}/${captureSpanProgress(range).total}`) : t("capturingNowMark", null, "正在捕获"))}</span><div class="muted">${escapeHtml(kind)}</div></span><span class="muted" data-range-count>${escapeHtml(t("missingItemsCount", range.count, `${range.count} 项`))}</span></div>`;
    }).join("")
    ;
  } else {
    // Same rows in the same order: refresh the live numbers in place so nothing jumps.
    for (const range of pageRanges) {
      const row = $("missingRanges").querySelector(`[data-range-key="${CSS.escape(rangeKey(range))}"]`);
      if (!row) continue;
      const counter = row.querySelector("[data-range-count]");
      if (counter) counter.textContent = t("missingItemsCount", range.count, `${range.count} 项`);
      const mark = row.querySelector("[data-live-mark]");
      const isLive = Number.isFinite(activeSequence) && activeSequence >= Number(range.sequenceFrom) - 2 && activeSequence <= Number(range.sequenceTo) + 2;
      if (mark) {
        mark.hidden = !isLive;
        if (isLive) {
          const progress = captureSpanProgress(range);
          mark.textContent = ` · ${t("capturingNowProgress", [String(progress.done), String(progress.total)], `正在捕获 ${progress.done}/${progress.total}`)}`;
        }
      }
      row.classList.toggle("live", Number.isFinite(activeSequence) && activeSequence >= Number(range.sequenceFrom) - 2 && activeSequence <= Number(range.sequenceTo) + 2);
    }
  }
  // Changing where things land must stay reachable even when a folder is already chosen: the
  // remembered root is otherwise impossible to get away from.
  const showSpeed = state.mode === "browser-assisted" && ["capturing", "waiting", "paused"].includes(state.status);
  $("captureSpeedPanel").hidden = !showSpeed;
  $("captureSpeed").value = state.captureSpeedMode === "seek" ? "seek10" : String(Number(state.captureSpeed || 1) || 1);
  const seekSettings = normalizedSeekBoostSettings();
  $("seekBoostPanel").hidden = !showSpeed || state.captureSpeedMode !== "seek";
  if (!$("seekBoostInterval").matches(":focus")) $("seekBoostInterval").value = String(seekSettings.intervalSec);
  if (!$("seekBoostStep").matches(":focus")) $("seekBoostStep").value = String(seekSettings.stepSeconds);
  drawCoverage();
  renderActivity();
  $("captureSpeed").disabled = !attachedToPage();
  const blockedReason = attachedToPage() ? "" : t("needsPageAttached", null, "需要先接上原网页：打开该视频的网页并开始播放。");
  $("captureSpeed").title = $("captureSpeed").disabled ? blockedReason : "";
  // Always offer it once there is a workspace: with nothing known yet the click searches first.
  // Media controls have nothing to act on in a subtitles-only task.
  if (state.mode === "subtitles") {
    for (const id of ["progressWrap", "coverage", "coverageHint", "progressText", "stats", "missingPanel"]) {
      const element = $(id);
      if (element) element.hidden = true;
    }
  }
  renderActions();
  $("sourcePanel").hidden = state.mode !== "browser-assisted" && state.source !== "legacy-import";
  $("sourceText").innerHTML = connectionLines().map((line) => `<div>${escapeHtml(line)}</div>`).join("");
  $("locationPanel").hidden = !hasHandle;
  $("locationText").textContent = hasHandle ? (saveDestination === "browser-downloads"
    ? [t("browserDownloadsLocation", null, "浏览器 Downloads"), state.outputName].filter(Boolean).join(" / ")
    // The root is remembered across tasks, so a folder picked for one work silently becomes the
    // parent of the next. Name it as the chosen root rather than letting it look task-specific.
    : `${t("chosenRootFolder", rootFolderLabel(rootHandle), `已选根目录：${rootHandle.name}`)} / ${[state.directoryName, state.outputName].filter(Boolean).join(" / ")}`) : "";
  $("diagnosticsPanel").hidden = !showDiagnostics && state.status !== "error";
}

// Without this the finished file has no index at all: a player has to walk every fragment in an
// eight-gigabyte file before it can start, which over a network share is minutes of waiting.
async function writeSegmentIndex(writable, { sidxPosition, sidxCapacity, fragmentSizes, fragmentDurations }) {
  if (!(sidxPosition >= 0) || !fragmentSizes.length) return;
  const references = fragmentSizes.map((size, index) => ({ size, duration: fragmentDurations[index] || 0 }));
  const sidx = WebKeeperMediaEngine.buildSidx(references);
  if (sidx.byteLength > sidxCapacity) {
    // Fewer fragments than segments is normal; more is not, and a short write would corrupt the file.
    log(t("segmentIndexSkipped", null, "\u5206\u7247\u6570\u8d85\u51fa\u9884\u7559\u7d22\u5f15\u7a7a\u95f4\uff0c\u672c\u6b21\u672a\u5199\u5165\u7d22\u5f15\u3002"));
    return;
  }
  await writable.write({ type: "write", position: sidxPosition, data: sidx });
  // Whatever is left of the reservation stays a valid, ignored box.
  const leftover = sidxCapacity - sidx.byteLength;
  if (leftover >= 8) {
    await writable.write({ type: "write", position: sidxPosition + sidx.byteLength, data: WebKeeperMediaEngine.buildFreeBox(leftover) });
  }
  log(t("segmentIndexWritten", String(references.length), `\u5df2\u5199\u5165\u5206\u7247\u7d22\u5f15\uff08${references.length} \u4e2a\u7247\u6bb5\uff09\uff0c\u64ad\u653e\u5668\u4e0d\u7528\u626b\u5168\u7247\u5c31\u80fd\u5f00\u59cb\u64ad\u653e\u3002`));
}

async function retryMergeToExternalLocation() {
  // The save picker needs the click gesture, so it must run before anything scans records.
  const handle = await chooseExternalOutputHandle(`${preferredOutputBaseName()}.mp4`);
  if (!handle) return;
  state.errorCode = "";
  await mergeOutput(true, { presetExternalHandle: handle });
}

// ---------------------------------------------------------------------------------------------

// Action layer. Every button the task page can show is declared once, with the condition that

// makes it available and what it does. render() no longer decides visibility button by button:

// it asks for the list and places it. The ranking below is the whole point — at most one primary

// and two secondary actions, everything else behind "more", so there is always an obvious answer

// to "what do I click now?".

// ---------------------------------------------------------------------------------------------



// Highest first. The first available action becomes the primary one.

const PRIMARY_ORDER = ["mergeExternal", "choose", "bindPage", "fillDirect", "merge", "openOutput", "resume", "subtitles"];

// Everything here that is available and not already primary fills the two secondary slots.

const SECONDARY_ORDER = ["pause", "smartFill", "backToVideo", "verifySegments", "switchAssisted", "subtitles", "switchFolder"];

const DANGER_ACTIONS = new Set(["deleteSegments", "deleteOutput", "removeTask"]);



function availableActions() {

  const status = state.status;

  const has = (...names) => names.includes(status);

  const busy = has("downloading", "capturing", "merging", "exporting");

  const hasHandle = Boolean(workDirectory);

  const ranges = state.missingRanges || [];

  const attached = attachedToPage();

  const subtitlesOnly = state.mode === "subtitles";

  const legacyNeedsAssist = state.source === "legacy-import" && Number(state.missing || 0) > 0

    && has("paused", "downloaded", "ready", "waiting");

  const blockedReason = attached ? "" : t("needsPageAttached", null, "\u9700\u8981\u5148\u63a5\u4e0a\u539f\u7f51\u9875\uff1a\u6253\u5f00\u8be5\u89c6\u9891\u7684\u7f51\u9875\u5e76\u5f00\u59cb\u64ad\u653e\u3002");

  const media = !subtitlesOnly;



  const declared = [

    { id: "choose", when: media && saveDestination !== "browser-downloads" && !hasHandle && !busy,

      label: () => state.done ? t("chooseFolderAndContinue", null, "\u91cd\u65b0\u9009\u62e9\u4f4d\u7f6e\u5e76\u7ee7\u7eed") : t("chooseFolderAndStart", null, "\u9009\u62e9\u4f4d\u7f6e\u5e76\u5f00\u59cb") },

    { id: "resume", when: media && hasHandle && has("paused", "error", "ready", "waiting"),

      label: () => t("continueDownload", null, "\u7ee7\u7eed") },

    { id: "pause", when: media && has("downloading", "capturing", "waiting"),

      label: () => t("pauseDownload", null, "\u6682\u505c") },

    { id: "backToVideo", when: media && state.mode === "browser-assisted" && has("capturing", "waiting", "paused"),

      disabled: !attached && !candidate?.pageUrl, title: blockedReason,

      label: () => t("returnToVideo", null, "\u8fd4\u56de\u7f51\u9875\u7ee7\u7eed\u64ad\u653e") },

    { id: "switchAssisted", when: media && ((state.mode === "direct" && has("error", "waiting")

        && ["AUTH_REQUIRED", "URL_EXPIRED", "PLAYLIST_STALLED", "NETWORK_ERROR", "SEPARATE_TRACKS"].includes(state.errorCode || ""))

        || legacyNeedsAssist),

      label: () => t("switchToAssisted", null, "\u6539\u7528\u7f51\u9875\u8f85\u52a9") },

    { id: "switchFolder", when: media && has("ready", "paused", "waiting", "capturing", "downloaded", "error"),

      label: () => t("switchFolder", null, "\u6539\u4e3a\u4fdd\u5b58\u5230\u6587\u4ef6\u5939") },

    { id: "bindPage", when: media && state.source === "legacy-import" && !state.legacyBoundPlaylistUrl

        && !has("merging", "exporting", "complete", "downloading"),

      label: () => t("bindPage", null, "\u63a5\u4e0a\u6b63\u5728\u64ad\u653e\u7684\u89c6\u9891") },

    { id: "fillDirect", when: media && ranges.length > 0 && hasRealSegmentUrls() && has("capturing", "waiting", "paused", "downloaded"),

      disabled: directFillRunning,

      label: () => t("fillDirect", null, "\u76f4\u63a5\u8865\u9f50\u7f3a\u53e3\uff08\u4e0d\u7528\u64ad\u653e\uff09") },

    { id: "smartFill", when: media && state.mode === "browser-assisted" && ranges.length > 0 && has("capturing", "waiting", "paused"),

      disabled: smartFillRunning || !attached, title: blockedReason,

      label: () => t("smartFill", null, "\u667a\u80fd\u8865\u5168\u7f3a\u5931\u4f4d\u7f6e") },

    { id: "verifySegments", when: media && state.providerId !== "direct-file" && Number(state.done || 0) > 0

        && !has("downloading", "merging", "exporting"),

      disabled: verifyRunning || directFillRunning,

      label: () => t("verifySegments", null, "\u68c0\u67e5\u5206\u7247\u6709\u6548\u6027") },

    { id: "merge", when: media && state.providerId !== "direct-file" && hasHandle && Number(state.done || 0) > 0

        && !state.outputName && !has("downloading", "merging", "exporting"),

      label: () => t("checkAndCreateVideo", null, "\u68c0\u67e5\u5e76\u751f\u6210\u89c6\u9891") },

    { id: "mergeExternal", when: media && state.errorCode === "OUTPUT_QUOTA" && !busy,

      label: () => t("mergeExternalRetry", null, "\u9009\u62e9\u4f4d\u7f6e\u5e76\u91cd\u65b0\u751f\u6210") },

    // While exporting there is no finished file yet, so offering to open it is a lie.
    { id: "openOutput", when: media && hasHandle && Boolean(state.outputName) && !has("merging", "exporting") && !state.outputExternal,

      label: () => state.browserDownloadId ? t("showInFolder", null, "\u5728\u6587\u4ef6\u5939\u4e2d\u663e\u793a") : t("openGeneratedVideo", null, "\u6253\u5f00\u751f\u6210\u7684\u89c6\u9891") },

    { id: "subtitles", when: hasHandle && !has("merging", "exporting"),

      label: () => t("saveSubtitles", null, "\u4fdd\u5b58\u5b57\u5e55") },

    // Subtitle recovery tools: needed only when the automatic path fails, so never on the surface.

    { id: "extractSubtitles", when: hasHandle && !has("merging", "exporting"),

      label: () => t("subtitleDirectStartLabel", null, "\u76f4\u63a5\u62bd\u53d6\u5b8c\u6574\u5b57\u5e55") },

    { id: "sweepSubtitles", when: hasHandle && !has("merging", "exporting") && attached,

      label: () => subtitleSweepRunning ? t("subtitleSweepStop", null, "\u505c\u6b62\u8d70\u4e00\u904d") : t("subtitleSweepStart", null, "\u8ba9\u64ad\u653e\u5668\u8d70\u4e00\u904d\u8865\u5b57\u5e55") },

    { id: "subtitleDiagnostics", when: hasHandle && !has("merging", "exporting"),

      label: () => t("subtitleDiagnosticsLabel", null, "\u5b57\u5e55\u63a5\u53e3\u8bca\u65ad") },

    { id: "deleteSegments", when: media && state.providerId !== "direct-file" && hasHandle && Boolean(state.outputName)

        && !state.temporaryCleaned && !has("downloading", "merging"),

      label: () => t("cleanTemporaryFiles", null, "\u6e05\u7406\u4e34\u65f6\u4e0b\u8f7d\u6587\u4ef6") },

    { id: "deleteOutput", when: media && hasHandle && Boolean(state.outputName) && !state.outputExternal && !busy,

      label: () => t("deleteOutput", null, "\u5220\u9664\u751f\u6210\u7684\u89c6\u9891") },

    { id: "removeTask", when: !busy, label: () => t("removeTask", null, "\u4ece\u5217\u8868\u79fb\u9664") }

  ];



  return declared.filter((item) => item.when).map((item) => ({

    id: item.id,

    label: item.label(),

    disabled: Boolean(item.disabled),

    title: item.disabled ? (item.title || "") : "",

    danger: DANGER_ACTIONS.has(item.id)

  }));

}



// Ranks the available actions into one primary, at most two secondary, and the rest.

function actionsFor() {

  const available = availableActions();

  const byId = new Map(available.map((item) => [item.id, item]));

  const primary = PRIMARY_ORDER.map((id) => byId.get(id)).find((item) => item && !item.disabled) || null;

  const secondary = [];

  for (const id of SECONDARY_ORDER) {

    if (secondary.length >= 2) break;

    const item = byId.get(id);

    if (item && item !== primary) secondary.push(item);

  }

  const shown = new Set([primary, ...secondary].filter(Boolean).map((item) => item.id));

  const overflow = available.filter((item) => !shown.has(item.id));

  return { primary, secondary, overflow };

}



function actionButtonHtml(action, kind) {

  const classes = kind === "primary" ? "primary" : action.danger ? "danger" : "";

  return `<button type="button" class="${classes}" data-action="${escapeHtml(action.id)}"${action.disabled ? " disabled" : ""}${action.title ? ` title="${escapeHtml(action.title)}"` : ""}>${escapeHtml(action.label)}</button>`;

}



function renderActions() {

  const { primary, secondary, overflow } = actionsFor();

  $("actionBar").innerHTML = [

    primary ? actionButtonHtml(primary, "primary") : "",

    ...secondary.map((action) => actionButtonHtml(action, "secondary")),

    overflow.length

      ? `<div class="overflow"><button type="button" class="overflow-toggle" data-overflow-toggle aria-expanded="${overflowOpen}" aria-haspopup="true">${escapeHtml(t("moreActions", null, "\u66f4\u591a"))}</button><div class="overflow-menu"${overflowOpen ? "" : " hidden"}>${overflow.map((action) => actionButtonHtml(action, "overflow")).join("")}</div></div>`

      : ""

  ].filter(Boolean).join("");

}



function parseAttributeList(text) {
  return WebKeeperMediaEngine.parseAttributeList(text);
}

function parsePlaylist(text, playlistUrl) {
  return WebKeeperMediaEngine.parseHlsPlaylist(text, playlistUrl);
}

function allowedHeaders(source = {}, extra = {}) {
  const headers = new Headers();
  const allowed = /^(accept|accept-language|authorization|cache-control|content-type|pragma|range|x-[a-z0-9-]+)$/i;
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
  if (!workDirectory || state?.source !== "legacy-import" || state?.legacyBoundPlaylistUrl) return null;
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

async function persistPlaylistBesideSegments(parsed) {
  // A folder of .ts files alone cannot say which segments are missing; keep the playlist with
  // them so re-importing this folder after a crash reconstructs the real gaps.
  if (!segmentDirectory || !parsed?.text || playlistPersistedFor === state?.id) return;
  playlistPersistedFor = state?.id || null;
  try {
    await writeFile(segmentDirectory, "source.m3u8", new TextEncoder().encode(parsed.text));
  } catch (error) {
    log(`未能在分片目录写入播放列表副本：${error.message}`);
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
  let urls = pinnedPlaylistUrl ? [pinnedPlaylistUrl] : Array.from(new Set([...(candidate.playlistUrls || []), candidate.playlistUrl].filter(Boolean)));
  // Once attached to the real page, the imported placeholder URL can only produce fetch errors.
  if (state?.legacyBoundPlaylistUrl) urls = urls.filter((item) => !String(item).startsWith("https://legacy.local/"));
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
  candidate.subtitles = Array.from(new Set([...(candidate.subtitles || []), ...discoveredSubtitles.map((item) => item.url).filter(Boolean)]));
  candidate.subtitleLabels = { ...(candidate.subtitleLabels || {}) };
  for (const item of discoveredSubtitles) {
    if (item.url) candidate.subtitleLabels[item.url] = [item.language, item.label].filter(Boolean).join("-") || "subtitle";
  }
  indexMediaPlaylist(parsed);
  void persistPlaylistBesideSegments(parsed);
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
  // Rebuilding this per call was O(saved x skippable) during a large import.
  if (skippableCache.jobId !== (state?.id || null)) {
    skippableCache = { jobId: state?.id || null, set: new Set((state?.skippableSequences || []).map(Number).filter((value) => Number.isFinite(value))) };
  }
  return skippableCache.set;
}

function recordSkipVerdict(sequence, verdict) {
  if (!state) return;
  // Mutate in place: copying the whole map per segment made a big import quadratic.
  const verdicts = state.segmentSkipVerdicts || (state.segmentSkipVerdicts = {});
  verdicts[sequence] = verdict;
  const keys = Object.keys(verdicts);
  if (keys.length <= MAX_SKIP_VERDICTS) return;
  const skippable = skippableSequenceSet();
  for (const key of keys) {
    if (Object.keys(verdicts).length <= MAX_SKIP_VERDICTS) break;
    if (!skippable.has(Number(key))) delete verdicts[key];
  }
}

function coveredSegmentCount() {
  return Number(state?.done || 0) + skippableSequenceSet().size;
}

async function markSkippableSegment(sequence, verdict = {}) {
  const set = skippableSequenceSet();
  if (!set.has(Number(sequence))) {
    set.add(Number(sequence));
    (state.skippableSequences || (state.skippableSequences = [])).push(Number(sequence));
  }
  state.skippableCount = set.size;
  recordSkipVerdict(sequence, { status: "skippable", ...verdict, at: Date.now() });
  log(t("segmentMarkedSkippable", [sequence, Number(verdict.deltaSeconds || 0).toFixed(2), Number(verdict.expectedSeconds || 0).toFixed(2)], `分片 ${sequence} 可跳过：前后有效片时间轴已连贯（间隔约 ${Number(verdict.deltaSeconds || 0).toFixed(2)}s，播放列表约 ${Number(verdict.expectedSeconds || 0).toFixed(2)}s），不再重试下载。`));
}

function clearSkippableVerdicts(reason = "") {
  if (!state) return false;
  const had = skippableSequenceSet().size > 0 || Object.keys(state.segmentSkipVerdicts || {}).length > 0;
  state.skippableSequences = [];
  state.skippableCount = 0;
  state.segmentSkipVerdicts = {};
  skippableCache = { jobId: state.id || null, set: new Set() };
  if (had) log(t("skippableVerdictsCleared", reason || "resume", `已清除旧的可跳过结论（${reason || "resume"}），将按当前分片时间轴重新判断。`));
  return had;
}

// Turns an engine verdict into something a person can act on.
function describeTimelineJump(verdict) {
  const delta = Number(verdict?.deltaSeconds || 0);
  const size = formatTime(Math.abs(delta));
  if (verdict?.reason === "PTS_RESET_OR_JUMP_BACK") {
    return t("timelineJumpBack", size, `倒退 ${size}`);
  }
  return t("timelineJumpForward", size, `前跳 ${size}`);
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
  // "PTS_FORWARD_JUMP, delta 16159.18s" meant nothing to anyone but me. Say what happened and
  // what was done about it.
  const jumpText = describeTimelineJump(verdict);
  // Nothing here is actionable: the download continues either way. It belongs in the log, not in
  // the one line the user actually reads, where it only looks alarming.
  log(t("timelineShiftAdjusted", [String(sequence), jumpText], `分片 ${sequence} 处片源时间不连续（${jumpText}），已标记，下载继续。`));
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
  if (savedSequenceCache.jobId === state?.id) savedSequenceCache.set.delete(Number(record.sequence));
  log(t("tinySegmentDiscarded", [record.sequence, size || record.size || 0], `分片 ${record.sequence} 只有 ${size || record.size || 0} 字节（小于 ${MIN_SEGMENT_BYTES}），已视为无效并等待重试。`));
}

async function readSegmentTimestampSample(sequence, side = "head") {
  if (!segmentDirectory || sequence == null) return null;
  if (skippableSequenceSet().has(Number(sequence))) return null;
  const record = await dbGet("segments", `${state.id}:${sequence}`);
  if (!record || !isValidSegmentSize(record.size)) return null;
  try {
    // A linked legacy segment is encrypted on disk, so it has to be decrypted whole before sampling.
    if (record.source === LEGACY_LINK_SOURCE) {
      const bytes = await readStoredSegment(record);
      if (!isValidSegmentSize(bytes.byteLength)) return null;
      return side === "tail"
        ? bytes.subarray(Math.max(0, bytes.byteLength - TS_TIMESTAMP_SAMPLE_BYTES))
        : bytes.subarray(0, Math.min(bytes.byteLength, TS_TIMESTAMP_SAMPLE_BYTES));
    }
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
  // Linear scans here were called once per segment during a merge, which is quadratic on long works.
  if (playlistSequenceIndex.playlist !== mediaPlaylist) {
    playlistSequenceIndex = {
      playlist: mediaPlaylist,
      map: new Map((mediaPlaylist?.segments || []).map((item) => [Number(item.sequence), item]))
    };
  }
  return playlistSequenceIndex.map.get(Number(sequence)) || null;
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
  recordSkipVerdict(segment.sequence, { ...verdict, tinySize, at: Date.now() });
  if (verdict.status === "skippable") {
    await markSkippableSegment(segment.sequence, verdict);
    return verdict;
  }
  if (tinySize != null) {
    log(t("tinySegmentNeedsRetry", [String(segment.sequence), String(tinySize), describeTimelineJump(verdict)], `分片 ${segment.sequence} 只有 ${tinySize} 字节且前后时间不连续（${describeTimelineJump(verdict)}），重试中。`));
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
    let examined = 0;
    for (const segment of mediaPlaylist.segments) {
      if (segment.gap || saved.has(Number(segment.sequence)) || skippable.has(Number(segment.sequence))) continue;
      if (!saved.has(Number(segment.sequence) - 1) || !saved.has(Number(segment.sequence) + 1)) continue;
      // Each check reads ~1 MB from two neighbours, so a task with thousands of gaps must not
      // run them all in one uninterrupted pass; the rest are examined on later passes.
      if (examined >= MAX_RECLASSIFY_PER_PASS) {
        log(`本轮已检查 ${examined} 处缺口，其余缺口会在后续继续判断`);
        break;
      }
      examined += 1;
      if (examined % 10 === 0) await waitFor(0);
      const verdict = await classifySkippedSequence(segment);
      if (verdict.status === "skippable") {
        await markSkippableSegment(segment.sequence, verdict);
        skippable.add(Number(segment.sequence));
        changed = true;
      } else {
        recordSkipVerdict(segment.sequence, { ...verdict, at: Date.now() });
      }
    }
    if (changed) await updateMissingTimeline();
  } finally {
    skippableClassifyRunning = false;
  }
}

const LEGACY_LINK_SOURCE = "legacy-link";

async function ensureLegacySource({ requestPermission = false } = {}) {
  if (legacySourceDirectory) return legacySourceDirectory;
  const record = await dbGet("handles", `legacy:${state?.id}`);
  const handle = record?.handle;
  if (!handle) return null;
  if (typeof handle.queryPermission === "function") {
    let permission = await handle.queryPermission({ mode: "read" });
    if (permission !== "granted" && requestPermission) permission = await handle.requestPermission({ mode: "read" });
    if (permission !== "granted") return null;
  }
  legacySourceDirectory = handle;
  return legacySourceDirectory;
}

// Every place that reads a stored segment goes through here: a linked legacy segment still
// lives in the user's own folder and is decrypted on the way out instead of being copied.
async function readStoredSegment(record, meta = null) {
  if (record?.source === LEGACY_LINK_SOURCE) {
    const directory = await ensureLegacySource({ requestPermission: true });
    if (!directory) throw new Error(t("legacySourceUnavailable", state?.legacySourceLabel || "", `旧捕获目录${state?.legacySourceLabel ? `（${state.legacySourceLabel}）` : ""}暂时不可读，请重新授权该文件夹后再试。`));
    const raw = await (await (await directory.getFileHandle(record.fileName)).getFile()).arrayBuffer();
    const segment = meta || playlistSegmentBySequence(record.sequence) || { sequence: record.sequence };
    return new Uint8Array(await decryptIfNeeded(segment, raw));
  }
  return new Uint8Array(await (await (await segmentDirectory.getFileHandle(record.fileName)).getFile()).arrayBuffer());
}

async function storedSegmentSize(record) {
  if (record?.source === LEGACY_LINK_SOURCE) {
    const directory = await ensureLegacySource();
    if (!directory) return Number(record.size || 0);
    try { return (await (await directory.getFileHandle(record.fileName)).getFile()).size; }
    catch { return 0; }
  }
  return (await (await segmentDirectory.getFileHandle(record.fileName)).getFile()).size;
}

async function savedSegment(sequence) {
  if (skippableSequenceSet().has(Number(sequence))) return { skipped: true, sequence: Number(sequence) };
  const record = await dbGet("segments", `${state.id}:${sequence}`);
  if (!record || (!segmentDirectory && record.source !== LEGACY_LINK_SOURCE)) return null;
  try {
    const size = await storedSegmentSize(record);
    if (isValidSegmentSize(size)) return { ...record, size };
    const meta = playlistSegmentBySequence(sequence) || { sequence, duration: mediaPlaylist?.targetDuration || 2 };
    const verdict = await maybeMarkSkippable(meta, { tinySize: size });
    await invalidateTinySegment(record, size);
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

// Injecting after the fact misses whatever the player already fetched — which is exactly the
// subtitle, requested once at page load. Registering the same script at document_start means a
// reload captures it, which is why reloading used to "just work".
async function registerPageCaptureOnLoad() {
  const origin = (() => {
    try { return `${new URL(candidate?.pageUrl || "").origin}/*`; } catch { return ""; }
  })();
  if (!origin || !chrome.scripting?.registerContentScripts) return false;
  const id = "web-keeper-page-capture";
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] }).catch(() => []);
    const definition = { id, matches: [origin], js: ["page-capture.js"], runAt: "document_start", world: "MAIN", allFrames: true, persistAcrossSessions: false };
    if (existing.length) await chrome.scripting.updateContentScripts([definition]);
    else await chrome.scripting.registerContentScripts([definition]);
    return true;
  } catch {
    return false;
  }
}

async function ensurePageCaptureHook(tabId, { announce = false } = {}) {
  if (!(Number(tabId) >= 0)) return false;
  if (!announce && Date.now() - lastHookInjectionAt < 10000) return false;
  lastHookInjectionAt = Date.now();
  void registerPageCaptureOnLoad();
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

// The subtitle endpoint answers a membership-gated request with the full track and an anonymous
// one with a five-minute preview, and a request from the extension page is anonymous no matter
// what headers it copies. Running the fetch inside the page uses the page's own session.
async function postInPage(tabId, url, bodyBase64, contentType, extraHeaders = {}) {
  if (!(Number(tabId) >= 0)) return null;
  // fetch refuses to set these; the browser fills them in itself.
  const forbidden = /^(host|connection|content-length|origin|referer|user-agent|cookie|sec-|accept-encoding|proxy-|te$|upgrade$)/i;
  const headers = { "content-type": contentType || "application/grpc-web+proto" };
  for (const [name, value] of Object.entries(extraHeaders || {})) {
    if (!forbidden.test(name) && name.toLowerCase() !== "content-type") headers[name] = value;
  }
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: Number(tabId) },
      world: "MAIN",
      args: [url, bodyBase64, headers],
      func: async (target, body, sendHeaders) => {
        try {
          const bytes = Uint8Array.from(atob(body), (character) => character.charCodeAt(0));
          const response = await fetch(target, { method: "POST", credentials: "include", headers: sendHeaders, body: bytes });
          if (!response.ok) return { ok: false, status: response.status };
          const buffer = new Uint8Array(await response.arrayBuffer());
          let binary = "";
          for (let index = 0; index < buffer.length; index += 8192) binary += String.fromCharCode(...buffer.subarray(index, index + 8192));
          return { ok: true, data: btoa(binary), contentType: response.headers.get("content-type") || "" };
        } catch (error) {
          return { ok: false, error: String(error?.message || error) };
        }
      }
    });
    const hit = (results || []).map((item) => item?.result).find((item) => item?.ok && item.data);
    if (!hit) return null;
    return { bytes: new Uint8Array(base64ToArrayBuffer(hit.data)), contentType: hit.contentType };
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
  if (encrypted.byteLength < 16) {
    // An empty reply is usually an empty segment on the server, not a failure: these arrive at a
    // fixed period and would otherwise fail forever no matter how often they are retried. Judge it
    // by whether the neighbours join cleanly, the same way every other gap is judged.
    const verdict = await maybeMarkSkippable(segment, { tinySize: encrypted.byteLength });
    if (verdict.status === "skippable") return { sequence: segment.sequence, skipped: true, size: 0 };
    // The continuity test cannot decide anything on a source with hundreds of discontinuities, so
    // it kept these in a retry loop forever. Two independent requests both coming back empty is
    // the server's answer, not chance.
    const seen = Number(emptySegmentCounts.get(segment.sequence) || 0) + 1;
    emptySegmentCounts.set(segment.sequence, seen);
    if (seen >= 2) {
      await markSkippableSegment(segment.sequence, { ...verdict, status: "skippable", reason: "SERVER_EMPTY" });
      log(t("segmentConfirmedEmpty", String(segment.sequence), `\u5206\u7247 ${segment.sequence} \u8fde\u7eed\u4e24\u6b21\u8bf7\u6c42\u90fd\u662f\u7a7a\u7684\uff0c\u5f53\u4f5c\u7a7a\u7247\u8df3\u8fc7\u3002`));
      return { sequence: segment.sequence, skipped: true, size: 0 };
    }
    throw new Error(t("downloadedItemEmpty", [String(segment.sequence), String(encrypted.byteLength)], `第 ${segment.sequence} 项服务器只返回了 ${encrypted.byteLength} 字节，且前后时间接不上，无法判定为空片。`));
  }
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
  noteSavedSequence(segment.sequence);
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
  if (record.source === LEGACY_LINK_SOURCE) return ensureLegacySource();
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
  invalidateSavedSequences();
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
      if (record.source === LEGACY_LINK_SOURCE) {
        // Linked segments live in the user's own folder; stating every one of them made opening
        // a large imported task take minutes, so the recorded size is trusted here.
        if (isValidSegmentSize(record.size)) { count += 1; bytes += Number(record.size || 0); }
        continue;
      }
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
  await updateMissingTimeline({ force: true });
  await mirrorJob();
}

function invalidateSavedSequences() {
  savedSequenceCache = { jobId: null, set: new Set() };
}

function noteSavedSequence(sequence) {
  if (savedSequenceCache.jobId === state?.id) savedSequenceCache.set.add(Number(sequence));
}

async function savedSequenceSet() {
  if (savedSequenceCache.jobId === state?.id) return savedSequenceCache.set;
  const records = (await listSegmentRecords(state.id)).filter((item) => item.kind !== "dash" && isValidSegmentSize(item.size));
  savedSequenceCache = { jobId: state?.id || null, set: new Set(records.map((item) => Number(item.sequence))) };
  return savedSequenceCache.set;
}

async function updateMissingTimeline({ force = false } = {}) {
  if (!mediaPlaylist) return [];
  // Reading every stored record and rescanning the whole playlist per saved segment made
  // capture crawl on long works, so the saved set is cached and the rebuild is throttled.
  if (!force && Date.now() - lastMissingComputeAt < 700) return state.missingRanges || [];
  lastMissingComputeAt = Date.now();
  const saved = await savedSequenceSet();
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
      // A single failing segment used to reject the whole batch and end the run, which is why a
      // download with many gaps "got stuck": one expired URL took the other thousands with it.
      const roundFailures = new Map();
      await mapConcurrent(pendingSegments, playlist.isLive ? Math.min(2, directConcurrency) : directConcurrency, async (segment) => {
        for (let attempt = 1; attempt <= DIRECT_SEGMENT_RETRIES; attempt += 1) {
          if (paused) return;
          try {
            log(`下载分片 ${segment.sequence}`);
            await saveSegment(segment);
            savedThisRound += 1;
            return;
          } catch (error) {
            if (attempt >= DIRECT_SEGMENT_RETRIES) {
              roundFailures.set(segment.sequence, error.message);
              log(`分片 ${segment.sequence} 暂时未能保存：${error.message}`);
              return;
            }
            await waitFor(400 * attempt);
          }
        }
      });
      // Everything failing is a different problem — expired URLs or a lost session — and must be
      // reported rather than silently looped over.
      if (pendingSegments.length >= 5 && roundFailures.size === pendingSegments.length) {
        throw new Error(roundFailures.values().next().value);
      }
      if (roundFailures.size) {
        state.failed = roundFailures.size;
        state.message = t("directSegmentsSkipped", [String(roundFailures.size), String(pendingSegments.length), roundFailures.values().next().value],
          `\u672c\u8f6e ${pendingSegments.length} \u4e2a\u5206\u7247\u4e2d\u6709 ${roundFailures.size} \u4e2a\u6682\u672a\u4fdd\u5b58\uff08${roundFailures.values().next().value}\uff09\uff0c\u5df2\u7ee7\u7eed\u5904\u7406\u5176\u4f59\u90e8\u5206\uff0c\u7a0d\u540e\u53ef\u518d\u6b21\u7ee7\u7eed\u6216\u7528\u667a\u80fd\u8865\u5168\u3002`);
        await mirrorJob();
      }
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
      pageBufferWaitMs = pageBufferProvenWaitMs;
      pageBufferGaveUp.delete(url);
      lastSegmentSource = "page-buffer";
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
    lastSegmentSource = "task-fetch";
    return await consumeResponse(response, "arrayBuffer");
  } catch (error) {
    if (paused || pageTabId == null) throw error;
    const fromPage = await fetchSegmentInPage(pageTabId, url, byteRange);
    if (!fromPage) throw error;
    log(`任务页请求失败（${error.message}），改由原网页会话取得 ${url}`);
    lastSegmentSource = "page-session";
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
  if (state.source === "legacy-import" && !state.legacyBoundPlaylistUrl) {
    // The imported playlist only carries placeholder URLs, so there is nothing to fetch yet.
    state.status = "waiting";
    state.mode = "browser-assisted";
    state.message = t("legacyNeedsBinding", null, "导入的分片没有可下载的网址。请打开这个视频的原网页并开始播放，Web Keeper 会自动接上真实播放列表，然后补齐缺口。");
    log(state.message);
    await mirrorJob();
    return;
  }
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
    noteSegmentActivity({ sequence, status: paused ? "skipped" : "failed", reason: paused ? "" : error.message });
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
    state.mergePercent = null;
    const quotaHit = /quota/i.test(error.message || "");
    if (quotaHit) state.errorCode = "OUTPUT_QUOTA";
    state.message = quotaHit
      ? t("outputFailedQuota", error.message, `生成视频失败：扩展存储空间不足。可在下载中心清理其他任务的临时内容，或重试后选择直接保存到文件夹。（${error.message}）`)
      : t("outputFailed", error.message, `生成视频失败：${error.message}`);
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

function normalizedWorkKey(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "").replace(/(^|[a-z])0+(\d)/g, "$1$2");
}

function matchesCandidate(event) {
  if (!state || !event || !candidate) return false;
  if (event.candidateId && candidate.id && event.candidateId === candidate.id) return true;
  if (state.source === "legacy-import" && !state.legacyBoundPlaylistUrl) {
    if (normalizedWorkKey(event.product) !== normalizedWorkKey(candidate.product)) return false;
    return candidate.resolution === "auto" || event.resolution === candidate.resolution || event.resolution === "auto";
  }
  // The candidate id carries the tab id, so an unfinished task must also match the same
  // work reopened in a new tab. The page URL keeps sites apart whose paths share a product.
  if (event.product !== candidate.product) return false;
  if (event.pageUrl && candidate.pageUrl && event.pageUrl !== candidate.pageUrl) return false;
  return candidate.resolution === "auto" || event.resolution === candidate.resolution || event.resolution === "auto";
}

let captureConcurrency = 6;
let captureActive = 0;
const captureWaiting = [];

// Segment saves are independent, but they used to run one strictly after another, so a player
// racing ahead always outran the queue. Playlist work still goes through captureQueue in order.
function runCaptureSegment(event) {
  return new Promise((resolve) => {
    const start = async () => {
      captureActive += 1;
      try { await captureObservedSegment(event); }
      catch (error) { log(error.message); }
      finally {
        captureActive -= 1;
        const next = captureWaiting.shift();
        if (next) next();
        resolve();
      }
    };
    if (captureActive < captureConcurrency) start();
    else captureWaiting.push(start);
  });
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
    state.lastSeenSequence = sequence;
    noteSegmentActivity({ sequence, status: "saving" });
    render();
    const startedAt = Date.now();
    lastSegmentSource = "";
    log(`播放器已请求分片 ${sequence}，开始保存`);
    await saveSegment({ ...meta, url: event.url }, event.headers || {}, { pageTabId: event.tabId ?? candidate.tabId, cacheMode: "force-cache", preferPageBuffer: true });
    captureRetryCounts.delete(event.url);
    state.lastSavedSequence = sequence;
    noteSegmentActivity({ sequence, status: "saved", size: (await savedSegment(sequence))?.size || 0, ms: Date.now() - startedAt, source: lastSegmentSource });
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
  state.lastSeenAt = Date.now();
  state.lastSeenKind = event.kind || "";
  if (state.source === "legacy-import" && !state.legacyBoundPlaylistUrl) {
    // A VOD playlist is usually fetched once at start, so waiting for a playlist event never
    // fires; any matching request is enough to go find the live playlist for this work.
    captureQueue = captureQueue.then(() => bindLegacyTaskToLivePlaylist(event)).catch((error) => log(error.message));
    return;
  }
  if (event.kind === "subtitle" && event.url) {
    candidate.subtitles = Array.from(new Set([...(candidate.subtitles || []), event.url]));
    candidate.subtitleTypes = { ...(candidate.subtitleTypes || {}), [event.url]: event.contentType || "text/vtt" };
    state.candidate = { ...candidate };
    void mirrorJob();
    return;
  }
  if (event.kind === "playlist" && !pinnedPlaylistUrl) candidate.playlistUrl = event.url;
  if (event.kind === "manifest") candidate.manifestUrl = event.url;
  if (event.kind === "direct") candidate.directUrl = event.url;
  if (event.kind === "segment") candidate.segmentUrl = event.url;
  state.candidate = { ...candidate };
  if (message.event.kind === "segment") void runCaptureSegment(message.event);
  else captureQueue = captureQueue.then(() => captureObservedSegment(message.event)).catch((error) => log(error.message));
});

async function outputSpaceShortfall(estimatedBytes) {
  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    const free = Math.max(0, quota - usage);
    // Leave headroom: the writable keeps a temporary copy until close() commits it.
    return estimatedBytes * 1.2 > free ? { free, needed: Math.round(estimatedBytes * 1.2) } : null;
  } catch { return null; }
}

async function chooseExternalOutputHandle(outputName) {
  if (!window.showSaveFilePicker) return null;
  try {
    return await window.showSaveFilePicker({ suggestedName: outputName, types: [{ description: "MP4 video", accept: { "video/mp4": [".mp4"] } }] });
  } catch { return null; }
}

async function noteMergeProgress(processed, total) {
  if (processed % 100 !== 0 && processed !== total) return;
  state.mergePercent = total ? Math.min(100, Math.round(processed / total * 100)) : 0;
  state.message = t("mergeProgress", [String(processed), String(total), String(state.mergePercent)], `正在生成视频：${processed}/${total}（${state.mergePercent}%）`);
  await mirrorJob();
}

async function createMp4FromTransportStream(expected, bySequence, outputName, durationSeconds, externalHandle = null) {
  const Transmuxer = globalThis.muxjs?.mp4?.Transmuxer || globalThis.muxjs?.Transmuxer;
  if (!Transmuxer) throw new Error(t("transmuxerUnavailable", null, "视频封装组件没有加载，无法生成可播放的 MP4。"));
  const outputHandle = externalHandle || await workDirectory.getFileHandle(outputName, { create: true });
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
  let processed = 0;
  // Tracked so a segment index can be written into the space reserved after moov.
  let bytesWritten = 0;
  let sidxPosition = -1;
  let sidxCapacity = 0;
  const fragmentSizes = [];
  const fragmentDurations = [];
  try {
    for (const sequence of expected) {
      processed += 1;
      await noteMergeProgress(processed, expected.length);
      const record = bySequence.get(sequence);
      if (!record) continue;
      const bytes = await readStoredSegment(record);
      const inspection = WebKeeperMediaEngine.inspectTransportStream(bytes);
      if (inspection.container !== "mpegts") throw new Error(t("unexpectedSegmentFormat", null, "下载到的切片不是可识别的 MPEG-TS 视频，已停止生成文件。"));
      if (inspection.hasVideo) hasVideo = true;
      emitted = [];
      let subsegmentBytes = 0;
      transmuxer.push(bytes);
      transmuxer.flush();
      for (const segment of emitted) {
        if (!wroteInit && segment?.initSegment?.byteLength) {
          const init = WebKeeperMediaEngine.patchMp4InitDuration(segment.initSegment, durationSeconds);
          await writable.write(init);
          bytesWritten += init.byteLength;
          // Reserve the index now; it can only be filled in once every fragment size is known.
          sidxPosition = bytesWritten;
          // The remuxer emits a separate fragment per track, so a source segment can produce more
          // than one; reserve with headroom rather than assume one-to-one.
          sidxCapacity = WebKeeperMediaEngine.sidxByteLength(expected.length + 16);
          await writable.write(WebKeeperMediaEngine.buildFreeBox(sidxCapacity));
          bytesWritten += sidxCapacity;
          wroteInit = true;
        }
        if (segment?.data?.byteLength) {
          await writable.write(segment.data);
          bytesWritten += segment.data.byteLength;
          subsegmentBytes += segment.data.byteLength;
        }
      }
      // One index entry per source segment, covering every fragment the remuxer produced for it.
      // Counting each track's fragment separately would double the indexed duration.
      if (subsegmentBytes > 0) {
        fragmentSizes.push(subsegmentBytes);
        fragmentDurations.push(Math.round(Number(playlistSegmentBySequence(sequence)?.duration || mediaPlaylist?.targetDuration || 0) * 90000));
      }
    }
    await writeSegmentIndex(writable, { sidxPosition, sidxCapacity, fragmentSizes, fragmentDurations });
    if (!hasVideo || !wroteInit) throw new Error(t("videoTrackMissing", null, "检测到的内容只有音频轨，没有视频画面。请重新播放网页后选择完整视频，或改用网页辅助抓取。"));
    // After 100% there are still minutes of silent work on a large file; say what is happening.
    state.message = t("mergeCommitting", null, "分片已全部处理，正在写入并提交文件（大文件可能需要几分钟）…");
    await mirrorJob();
    await writable.close();
    state.message = t("mergeValidating", null, "正在校验成品视频…");
    await mirrorJob();
    await validateSavedVideo(outputHandle);
    return outputHandle;
  } catch (error) {
    try { await writable.abort(); } catch { /* already closed */ }
    if (!externalHandle) { try { await workDirectory.removeEntry(outputName); } catch { /* no incomplete output */ } }
    throw error;
  }
}

async function mergeOutput(allowPartial = true, { presetExternalHandle = null } = {}) {
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
    const firstBytes = (await readStoredSegment(firstRecord)).subarray(0, 4 * 1024 * 1024);
    const firstInspection = WebKeeperMediaEngine.inspectMediaBytes(firstBytes);
    const isFragmentedMp4 = firstInspection.container === "mp4" || mediaPlaylist.segments.some((item) => /\.m4s(?:[?#]|$)/i.test(item.url));
    const isTransportStream = firstInspection.container === "mpegts";
    if (!isFragmentedMp4 && !isTransportStream) throw new Error(t("unexpectedSegmentFormat", null, "下载到的切片不是可识别的视频格式，已停止生成文件。"));
    if (firstInspection.hasAudio === true && firstInspection.hasVideo === false) throw new Error(t("videoTrackMissing", null, "检测到的内容只有音频轨，没有视频画面。请重新播放网页后选择完整视频，或改用网页辅助抓取。"));
    const extension = "mp4";
    const outputName = `${preferredOutputBaseName()}.${extension}`;
    const savedSequences = new Set([...bySequence.keys()]);
    const outputDuration = mediaPlaylist.segments.filter((item) => !item.gap && savedSequences.has(item.sequence)).reduce((sum, item) => sum + Number(item.duration || 0), 0);
    // The private workspace also holds the segments, so a large output can blow the quota mid-write.
    // Detect that up front and stream straight into a user-picked file instead of failing later.
    let externalOutputHandle = presetExternalHandle;
    const shortfall = externalOutputHandle ? null : await outputSpaceShortfall(Number(state.bytes || 0));
    if (shortfall) {
      state.message = t("mergeNeedsExternal", [formatBytes(shortfall.needed), formatBytes(shortfall.free)], `扩展存储放不下成品（约需 ${formatBytes(shortfall.needed)}，可用 ${formatBytes(shortfall.free)}）。请选择一个保存位置，成品会直接写到那里。`);
      await mirrorJob();
      externalOutputHandle = await chooseExternalOutputHandle(outputName);
      if (!externalOutputHandle) throw new Error(t("mergeExternalCancelled", null, "没有选择保存位置。可以清理其他任务的临时内容释放空间后重试。"));
    }
    state.mergePercent = 0;
    let outputHandle;
    if (isTransportStream) {
      outputHandle = await createMp4FromTransportStream(expected, bySequence, outputName, outputDuration, externalOutputHandle);
    } else {
      outputHandle = externalOutputHandle || await workDirectory.getFileHandle(outputName, { create: true });
      const writable = await outputHandle.createWritable();
      try {
        if (mediaPlaylist.map?.url) {
          const initResponse = await fetchResponse(mediaPlaylist.map.url, { byteRange: mediaPlaylist.map.byteRange });
          const initBytes = new Uint8Array(await consumeResponse(initResponse, "arrayBuffer"));
          await writable.write(WebKeeperMediaEngine.patchMp4InitDuration(initBytes, outputDuration));
        }
        for (const [sequenceIndex, sequence] of expected.entries()) {
          await noteMergeProgress(sequenceIndex + 1, expected.length);
          const record = bySequence.get(sequence);
          if (!record) continue;
          const bytes = await readStoredSegment(record);
          await writable.write(!mediaPlaylist.map?.url && sequenceIndex === 0 ? WebKeeperMediaEngine.patchMp4InitDuration(bytes, outputDuration) : bytes);
        }
        state.message = t("mergeCommitting", null, "分片已全部处理，正在写入并提交文件（大文件可能需要几分钟）…");
        await mirrorJob();
        await writable.close();
        state.message = t("mergeValidating", null, "正在校验成品视频…");
        await mirrorJob();
        await validateSavedVideo(outputHandle);
      } catch (error) {
        try { await writable.abort(); } catch { /* already closed */ }
        if (!externalOutputHandle) { try { await workDirectory.removeEntry(outputName); } catch { /* no incomplete output */ } }
        throw error;
      }
    }
    state.outputName = outputName;
    state.mergePercent = null;
    if (externalOutputHandle) {
      state.outputExternal = true;
      state.browserDownloadId = null;
      log(t("outputSavedExternal", outputName, `成品已直接保存到你选择的位置：${outputName}`));
    } else {
      await publishSavedFile(outputHandle, outputName, { removeInternal: true });
    }
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
    alert(state.message);
  } catch (error) {
    state.status = "error";
    state.mergePercent = null;
    const quotaHit = /quota/i.test(error.message || "");
    if (quotaHit) state.errorCode = "OUTPUT_QUOTA";
    state.message = quotaHit
      ? t("outputFailedQuota", error.message, `生成视频失败：扩展存储空间不足。点「选择位置并重新生成」可直接写到你选的文件。（${error.message}）`)
      : t("outputFailed", error.message, `生成视频失败：${error.message}`);
    log(state.message);
    await mirrorJob();
  }
}

function extensionForSubtitle(url, contentType = "") {
  const fromUrl = (() => { try { return new URL(url).pathname.match(/\.([a-z0-9]+)$/i)?.[1] || ""; } catch { return ""; } })();
  if (fromUrl && fromUrl.toLowerCase() !== "m3u8") return fromUrl;
  const type = String(contentType).toLowerCase();
  if (type.includes("x-subrip") || type.includes("text/srt")) return "srt";
  if (type.includes("ttml") || type.includes("dfxp")) return "ttml";
  return "vtt";
}

const JK_SUBTITLE_KEY = "mYq3t6w9y$B&E)H@";

// This site wraps subtitles in protobuf + base64 + AES-128-CBC, keyed by a constant with the
// viewer id as IV. Ported from the legacy Python path, which is where this was first worked out.
// Reads the ids the page is signed in with. The values are session data: they are used to build
// a decryption IV in memory and are never logged, stored or reported.
async function pageIdentityCandidates(tabId) {
  if (!(Number(tabId) >= 0)) return [];
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: Number(tabId) },
      world: "MAIN",
      func: () => {
        const ids = new Set();
        const fromJwt = (token) => {
          const parts = String(token || "").split(".");
          if (parts.length < 2) return;
          try {
            const base = parts[1].replace(/-/g, "+").replace(/_/g, "/");
            const payload = JSON.parse(decodeURIComponent(escape(atob(base + "=".repeat((4 - base.length % 4) % 4)))));
            for (const key of ["uid", "userId", "user_id", "id", "sub", "memberId", "member_id"]) {
              if (payload?.[key] != null) ids.add(String(payload[key]));
            }
          } catch { /* not a JWT */ }
        };
        const scan = (value) => {
          const text = String(value || "");
          for (const match of text.matchAll(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g)) fromJwt(match[0]);
          if (/^\d{3,12}$/.test(text)) ids.add(text);
        };
        try { for (let index = 0; index < localStorage.length; index += 1) scan(localStorage.getItem(localStorage.key(index))); } catch { /* blocked */ }
        try { for (let index = 0; index < sessionStorage.length; index += 1) scan(sessionStorage.getItem(sessionStorage.key(index))); } catch { /* blocked */ }
        try { for (const pair of document.cookie.split(";")) scan(pair.split("=").slice(1).join("=")); } catch { /* blocked */ }
        return [...ids].slice(0, 24);
      }
    });
    return (results || []).flatMap((item) => item?.result || []);
  } catch {
    return [];
  }
}

// Reads AES-key-shaped literals out of the page's own scripts. Ranked so strings sitting next to
// crypto code are tried first, because every candidate costs a decrypt attempt. Keys stay in
// memory: they are never logged, stored or reported.
async function pageDecryptionKeys(tabId) {
  if (!(Number(tabId) >= 0)) return [];
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: Number(tabId) },
      world: "MAIN",
      func: async () => {
        const MAX_TOTAL = 8 * 1024 * 1024;
        const sources = [];
        let budget = MAX_TOTAL;
        for (const node of document.querySelectorAll("script")) {
          if (budget <= 0) break;
          if (!node.src) { sources.push(node.textContent || ""); continue; }
          try {
            const url = new URL(node.src, location.href);
            if (url.origin !== location.origin) continue;
            // Already in the browser cache, so this costs nothing extra.
            const response = await fetch(url.href, { credentials: "include", cache: "force-cache" });
            if (!response.ok) continue;
            const text = await response.text();
            budget -= text.length;
            sources.push(text);
          } catch { /* unreadable script */ }
        }
        const near = new Set();
        const far = new Set();
        for (const source of sources) {
          for (const match of source.matchAll(/["'`]([\x21-\x7e]{16}|[\x21-\x7e]{32})["'`]/g)) {
            const value = match[1];
            // Base64/hex blobs and paths are not keys; a key is a mixed literal.
            if (/^[0-9]+$/.test(value) || /[\\/]/.test(value)) continue;
            const around = source.slice(Math.max(0, match.index - 200), match.index + 200);
            (/AES|CryptoJS|decrypt|Utf8\.parse|createDecipher/i.test(around) ? near : far).add(value);
          }
        }
        return [...near].slice(0, 24).concat([...far].slice(0, 16));
      }
    });
    return (results || []).flatMap((item) => item?.result || []);
  } catch {
    return [];
  }
}

// The built-in character table is 90 entries and gets one-to-many characters wrong: it turned
// 头发 into 頭發 and 皇后 into 皇後. Real conversion needs phrase context, so use OpenCC's own
// dictionaries. Loaded on demand because they are 1.2 MB.
let openCcConverters = null;
let openCcLoadAttempted = false;

async function ensureOpenCC() {
  if (openCcConverters || openCcLoadAttempted) return openCcConverters;
  if (!["zh-hans", "zh-hant"].includes(subtitleConvertMode)) return null;
  openCcLoadAttempted = true;
  if (!globalThis.OpenCC) {
    await new Promise((resolve) => {
      const tag = document.createElement("script");
      tag.src = "vendor/opencc/opencc-full.js";
      tag.onload = resolve;
      tag.onerror = resolve;
      document.head.appendChild(tag);
    });
  }
  if (!globalThis.OpenCC?.Converter) {
    log(t("subtitleConvertFallback", null, "繁简转换词库没能加载，本次用内置字表（会有错误）。"));
    return null;
  }
  openCcConverters = {
    "zh-hans": globalThis.OpenCC.Converter({ from: "tw", to: "cn" }),
    "zh-hant": globalThis.OpenCC.Converter({ from: "cn", to: "tw" })
  };
  return openCcConverters;
}

function convertSubtitleTextNow(text, mode) {
  const converter = openCcConverters?.[mode];
  if (converter) return converter(String(text || ""));
  return WebKeeperMediaEngine.convertSubtitleText(text, mode);
}

async function decodeEncryptedSubtitle(buffer) {
  // One reply can be several gRPC-Web DATA frames, and one frame can repeat the ciphertext field.
  // Reading only the first of either is what turned an eight-hour track into five minutes.
  const frames = WebKeeperMediaEngine.grpcWebPayloads(new Uint8Array(buffer));
  const ciphertexts = [];
  for (const frame of frames) {
    for (const field of [1, 2, 3, 4]) {
      const values = WebKeeperMediaEngine.protobufStringFields(frame, field)
        .filter((value) => /^[A-Za-z0-9+/=\s]{32,}$/.test(value));
      if (values.length) { ciphertexts.push(...values); break; }
    }
  }
  if (!ciphertexts.length) {
    const bytes = frames[0] || new Uint8Array(0);
    const head = [...bytes.subarray(0, 16)].map((value) => value.toString(16).padStart(2, "0")).join(" ");
    throw new Error(t("subtitleUnknownFormat", [String(bytes.byteLength), head], `字幕内容不是已知格式（${bytes.byteLength} 字节，开头：${head}）。`));
  }
  const headerId = WebKeeperMediaEngine.subtitleUserIdFromHeaders({ ...(candidate?.headers || {}), ...subtitleCallHeaders() });
  // The right id is whichever one decrypts to actual cues, so try them all and let the text decide
  // rather than failing on the first guess.
  const identities = Array.from(new Set([headerId, ...subtitleKeyCache, ...(await pageIdentityCandidates(candidate?.tabId))].filter(Boolean)));
  if (!identities.length) throw new Error(t("subtitleNeedsSession", null, "字幕是加密的，需要网页的登录信息才能解开。请在已登录的页面上播放一次该视频后重试。"));
  const rawParts = ciphertexts.map((ciphertext) => Uint8Array.from(atob(ciphertext.replace(/\s+/g, "")), (character) => character.charCodeAt(0)));
  // The key is a literal in the site's own bundle, so it is discovered rather than hard-coded.
  // The built-in one is only a head start; a site that uses a different key still works.
  const secrets = Array.from(new Set([JK_SUBTITLE_KEY, ...subtitleSecretCache, ...(await pageDecryptionKeys(candidate?.tabId))]
    .filter((value) => typeof value === "string" && [16, 32].includes(value.length))));
  const probe = rawParts.reduce((smallest, item) => (!smallest || item.length < smallest.length ? item : smallest), null);
  let parts = [];
  let usedId = "";
  let usedSecret = "";
  outer:
  for (const secret of secrets) {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "AES-CBC" }, false, ["decrypt"]);
    for (const identity of identities) {
      const iv = new TextEncoder().encode(String(identity).padStart(secret.length, "0")).subarray(0, 16);
      // Verify on the smallest chunk first: a wrong pair fails padding immediately.
      try {
        const sample = new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-CBC", iv }, key, probe));
        if (!sample.includes("-->")) continue;
      } catch { continue; }
      const attempt = [];
      for (const raw of rawParts) {
        try { attempt.push(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-CBC", iv }, key, raw))); }
        catch { /* one bad chunk must not discard the rest */ }
      }
      parts = attempt;
      usedId = String(identity);
      usedSecret = secret;
      break outer;
    }
  }
  if (usedSecret) subtitleSecretCache = [usedSecret, ...subtitleSecretCache.filter((item) => item !== usedSecret)].slice(0, 4);
  if (!parts.length) {
    throw new Error(t("subtitleDecryptFailed", [String(secrets.length), String(identities.length)], `字幕解密失败（试过 ${secrets.length} 个密钥 × ${identities.length} 个身份）。请确保原网页已登录并播放过该视频，再重试。`));
  }
  // Remember what worked so later tracks decrypt on the first try.
  subtitleKeyCache = [usedId, ...subtitleKeyCache.filter((item) => item !== usedId)].slice(0, 4);
  if (parts.length > 1) log(t("subtitleFramesDecoded", [String(parts.length), String(frames.length)], `这一次回复里解出 ${parts.length} 段字幕（${frames.length} 个数据帧）。`));
  const plain = parts.length > 1 ? WebKeeperMediaEngine.mergeVttDocuments(parts) : parts[0];
  if (!plain.includes("-->")) throw new Error(t("subtitleDecryptNotVtt", null, "字幕解密后不是可识别的字幕文本，可能这个站点换了字幕格式。"));
  return plain;
}

function applySubtitleFormat(data, extension) {
  // Only text formats can be rewritten; anything else is passed through untouched.
  if (subtitleFormat === "source" || !["vtt", "srt"].includes(extension)) return { data, extension };
  const plain = new TextDecoder().decode(data instanceof Uint8Array ? data : new Uint8Array(data));
  if (subtitleFormat === "srt") {
    if (extension === "srt") return { data, extension };
    return { data: new TextEncoder().encode(WebKeeperMediaEngine.webVttToSrt(plain)), extension: "srt" };
  }
  return { data, extension };
}

async function fetchSubtitleContent(url) {
  let contentType = "";
  let buffer = null;
  const calls = (candidate?.subtitleCalls || []).filter((item) => item.url === url && item.body);
  const single = candidate?.subtitleRequests?.[url];
  if (!calls.length && single?.body) calls.push({ ...single, url });
  const documents = [];
  // 1. Whatever the player already received is the most reliable copy — but only of the one chunk
  //    it asked for. When this endpoint has recorded calls it is a chunked API, so the buffered
  //    copy becomes the first part rather than the whole answer; returning it here was exactly
  //    what made a completed save still cover only a few minutes.
  const buffered = await takeBufferedSegment(candidate?.tabId, url, { waitMs: 0 });
  if (buffered) {
    let asDocument = "";
    if (calls.length) {
      const decoded = await decodeEncryptedSubtitle(buffered);
      const text = decoded ?? new TextDecoder().decode(new Uint8Array(buffered));
      if (text.includes("-->")) asDocument = text;
    }
    // A five-minute preview buffered from an earlier anonymous load must not shadow the real
    // track, so keep it only until the page has answered with something longer.
    if (asDocument) documents.push(asDocument);
    else buffer = buffered;
    log(t("subtitleFromPageBuffer", null, "字幕直接取自网页已经收到的数据。"));
  }
  // 2. Replay every recorded call for this endpoint and merge the parts: the player fetches the
  //    track in chunks, so a single reply only covers a few minutes.
  if (!buffer) {
    for (const call of calls) {
      try {
        const part = await requestSubtitlePart(url, call);
        contentType = part.contentType || contentType;
        documents.push(part.text);
      } catch (error) {
        log(`字幕分段读取失败：${error.message}`);
      }
    }
    if (documents.length) {
      if (documents.length > 1) log(t("subtitleMergedParts", String(documents.length), `已合并 ${documents.length} 段字幕。`));
      // 3. The player only asked for what was played. The paging parameter is visible in those
      //    calls, so ask for the rest of the track directly instead of replaying playback.
      if (calls.length) await extendSubtitleByPaging(url, calls, documents);
      const merged = WebKeeperMediaEngine.mergeVttDocuments(documents);
      const span = WebKeeperMediaEngine.subtitleCueSpan(merged);
      // Always state what was actually produced, so "it saved but it is short" is never a guess.
      log(t("subtitleAssembled", [String(documents.length), String(span.count), formatTime(span.start), formatTime(span.end)],
        `字幕由 ${documents.length} 段拼成，共 ${span.count} 条，覆盖 ${formatTime(span.start)} – ${formatTime(span.end)}。`));
      return { data: new TextEncoder().encode(convertSubtitleTextNow(merged, subtitleConvertMode)), extension: "vtt" };
    }
  }
  if (!buffer) {
    if (/\/gapi\/|grpc/i.test(url) || candidate?.subtitleTypes?.[url]?.includes("grpc")) {
      // A plain GET on a gRPC endpoint always answers 415; name that instead of reporting it.
      throw new Error(t("subtitleNeedsReplay", null, "这个站点的字幕接口只接受网页发出的调用。请回到视频页打开字幕播放几秒（让浏览器真正请求一次），再回来保存。"));
    }
    const response = await fetchResponse(url);
    contentType = response.headers?.get?.("content-type") || "";
    buffer = await consumeResponse(response, "arrayBuffer");
  }
  const text = new TextDecoder().decode(new Uint8Array(buffer).subarray(0, 512));
  const looksLikePlaylist = text.trimStart().startsWith("#EXTM3U");
  if (!looksLikePlaylist) {
    if (!text.includes("-->") && !text.trimStart().startsWith("<")) {
      const decoded = await decodeEncryptedSubtitle(buffer);
      if (decoded) {
        log(t("subtitleDecrypted", null, "字幕是加密格式，已用网页登录信息解开。"));
        return { data: new TextEncoder().encode(convertSubtitleTextNow(decoded, subtitleConvertMode)), extension: "vtt" };
      }
    }
    if (subtitleConvertMode !== "none" && /vtt|srt/i.test(extensionForSubtitle(url, contentType))) {
      const plain = new TextDecoder().decode(new Uint8Array(buffer));
      return { data: new TextEncoder().encode(convertSubtitleTextNow(plain, subtitleConvertMode)), extension: extensionForSubtitle(url, contentType) };
    }
    return { data: buffer, extension: extensionForSubtitle(url, contentType) };
  }
  // An HLS sidecar subtitle track: fetch every part and join them into one file.
  const playlistText = new TextDecoder().decode(new Uint8Array(buffer));
  const parsed = parsePlaylist(playlistText, url);
  const parts = [];
  for (const segment of parsed.segments) {
    try { parts.push(await fetchText(segment.url, { byteRange: segment.byteRange })); }
    catch (error) { log(`字幕分片读取失败：${error.message}`); }
  }
  if (!parts.length) throw new Error(t("subtitlePlaylistEmpty", null, "字幕播放列表里没有可读取的内容。"));
  log(t("subtitleMerged", String(parts.length), `已合并 ${parts.length} 个字幕分片。`));
  return { data: new TextEncoder().encode(WebKeeperMediaEngine.mergeWebVttParts(parts, subtitleConvertMode)), extension: "vtt" };
}

// A task created from a master playlist carries the playlist request's headers, which have no
// session token at all; the subtitle call's own headers do.
function subtitleCallHeaders() {
  for (const call of candidate?.subtitleCalls || []) {
    if (call?.headers && Object.keys(call.headers).length) return call.headers;
  }
  for (const call of Object.values(candidate?.subtitleRequests || {})) {
    if (call?.headers && Object.keys(call.headers).length) return call.headers;
  }
  return {};
}

async function requestSubtitleRaw(url, call, payload = null) {
  const body = payload
    ? WebKeeperMediaEngine.grpcWebFrame(payload)
    : Uint8Array.from(atob(call.body), (character) => character.charCodeAt(0));
  // Try the page first: only its own session gets the full track.
  let binary = "";
  for (let index = 0; index < body.length; index += 8192) binary += String.fromCharCode(...body.subarray(index, index + 8192));
  const viaPage = await postInPage(candidate?.tabId, url, btoa(binary), call.contentType, call.headers || candidate?.headers || {});
  if (viaPage) {
    log(t("subtitleViaPage", String(viaPage.bytes.length), `\u5b57\u5e55\u7531\u7f51\u9875\u81ea\u5df1\u8bf7\u6c42\uff08${viaPage.bytes.length} \u5b57\u8282\uff09\u3002`));
    return viaPage;

  }
  const response = await fetch(url, {
    method: call.method || "POST",
    credentials: "include",
    headers: allowedHeaders({ ...(candidate?.headers || {}), ...(call.headers || {}) }, { "content-type": call.contentType || "application/grpc-web+proto" }),
    body
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return { bytes: new Uint8Array(await response.arrayBuffer()), contentType: response.headers.get("content-type") || "" };
}

// Reports what the endpoint actually sends, because three plausible explanations for a short
// subtitle (paging, a streaming reply, a repeated field) all looked the same from the outside.
async function dumpSubtitleDiagnostics() {
  await refreshSubtitleCalls();
  const urls = validSubtitleUrls(candidate.subtitles || []);
  const lines = [`Web Keeper subtitle diagnostics — ${new Date().toISOString()}`];
  if (!urls.length) lines.push("no subtitle URL known");
  for (const url of urls.slice(0, 3)) {
    const calls = (candidate.subtitleCalls || []).filter((item) => item.url === url && item.body);
    lines.push("", `URL path: ${new URL(url).pathname}`, `recorded calls: ${calls.length}`);
    for (const [index, call] of calls.slice(0, 4).entries()) {
      const payload = WebKeeperMediaEngine.grpcWebPayload(Uint8Array.from(atob(call.body), (character) => character.charCodeAt(0)));
      lines.push(`  request #${index + 1}: ${WebKeeperMediaEngine.protobufShape(payload)}`);
    }
    if (!calls.length) continue;
    try {
      const raw = await requestSubtitleRaw(url, calls[0]);
      const frames = WebKeeperMediaEngine.grpcWebPayloads(raw.bytes);
      lines.push(`  response: ${raw.bytes.length} bytes, ${frames.length} frame(s), ${raw.contentType || "no content-type"}`);
      frames.slice(0, 4).forEach((frame, index) => lines.push(`    frame #${index + 1} (${frame.length} bytes): ${WebKeeperMediaEngine.protobufShape(frame)}`));
      let baseline = "";
      try {
        baseline = await decodeEncryptedSubtitle(raw.bytes);
        const span = WebKeeperMediaEngine.subtitleCueSpan(baseline);
        lines.push(`  decoded: ${baseline.length} chars, ${span.count} cues, ${formatTime(span.start)} - ${formatTime(span.end)}`);
      } catch (error) {
        lines.push(`  decode failed: ${error.message}`);
      }
      // The single integer is the only thing that can select a different part, so show plainly
      // what its neighbours return instead of only reporting that a probe was rejected.
      const payload = WebKeeperMediaEngine.grpcWebPayload(Uint8Array.from(atob(calls[0].body), (character) => character.charCodeAt(0)));
      for (const [field, value] of Object.entries(WebKeeperMediaEngine.protobufVarintFields(payload)).slice(0, 2)) {
        for (const delta of [1, -1, 2]) {
          const changed = WebKeeperMediaEngine.protobufSetVarint(payload, Number(field), value + delta);
          if (!changed) continue;
          try {
            const probe = await requestSubtitleRaw(url, calls[0], changed);
            let detail = `${probe.bytes.length} bytes`;
            try {
              const plain = await decodeEncryptedSubtitle(probe.bytes);
              const span = WebKeeperMediaEngine.subtitleCueSpan(plain);
              detail += `, ${span.count} cues, ${formatTime(span.start)} - ${formatTime(span.end)}, ${plain === baseline ? "SAME as base" : "DIFFERENT"}`;
            } catch (error) { detail += `, undecodable: ${error.message}`; }
            lines.push(`  field ${field} ${delta > 0 ? "+" : ""}${delta} (${value + delta}): ${detail}`);
          } catch (error) {
            lines.push(`  field ${field} ${delta > 0 ? "+" : ""}${delta} (${value + delta}): ${error.message}`);
          }
          await waitFor(150);
        }
      }
    } catch (error) {
      lines.push(`  request failed: ${error.message}`);
    }
  }
  // The endpoint that carries the rest of the track will not be called "subtitle", so list what
  // the page actually talks to and let the sizes point at it.
  const stored = await chrome.storage.local.get({ wkApiActivity: [] });
  const activity = (stored.wkApiActivity || [])
    .filter((item) => !(Number(candidate?.tabId) >= 0) || Number(item.tabId) === Number(candidate.tabId))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);
  if (activity.length) {
    lines.push("", "API endpoints seen on this tab (method path, calls, last size, type):");
    for (const item of activity) lines.push(`  ${item.label}  x${item.count}  ${item.bytes || "?"} bytes  ${item.contentType || "?"}`);
  } else {
    lines.push("", "no API activity recorded yet — play the page with subtitles on, then run this again");
  }
  // Preview-vs-whole-track is decided by the header set, so list which ones we hold. Names and
  // lengths only: the values are session tokens and this report is meant to be pasted.
  const held = subtitleCallHeaders();
  const fallback = candidate?.headers || {};
  lines.push("", `headers on the subtitle call: ${Object.keys(held).length ? Object.entries(held).map(([name, value]) => `${name}(${String(value).length})`).join(", ") : "none recorded"}`);
  lines.push(`headers on the task candidate: ${Object.keys(fallback).map((name) => name).join(", ") || "none"}`);
  const report = lines.join(String.fromCharCode(10));
  log(report);
  try {
    await navigator.clipboard.writeText(report);
    state.message = t("subtitleDiagnosticsCopied", null, "\u5b57\u5e55\u63a5\u53e3\u8bca\u65ad\u5df2\u590d\u5236\u5230\u526a\u8d34\u677f\uff08\u4e5f\u5199\u5728\u4e0b\u65b9\u201c\u8bca\u65ad\u4fe1\u606f\u201d\u91cc\uff09\u3002");
  } catch {
    state.message = t("subtitleDiagnosticsLogged", null, "\u5b57\u5e55\u63a5\u53e3\u8bca\u65ad\u5df2\u5199\u5728\u4e0b\u65b9\u201c\u8bca\u65ad\u4fe1\u606f\u201d\u91cc\u3002");
  }
  await mirrorJob();
}

async function requestSubtitlePart(url, call, payload = null) {
  const raw = await requestSubtitleRaw(url, call, payload);
  const decoded = await decodeEncryptedSubtitle(raw.bytes);
  return { text: decoded ?? new TextDecoder().decode(raw.bytes), contentType: raw.contentType };
}

// One recorded call gives nothing to difference, so the cursor is found by experiment instead:
// bump one integer field, ask again, and keep the field only if the reply actually reached
// further into the video. A field the server ignores returns the same chunk and is rejected.
async function probeSubtitlePaging(url, call, payload, sample) {
  const span = WebKeeperMediaEngine.subtitleCueSpan(sample);
  if (!span.count) return null;
  const probes = WebKeeperMediaEngine.subtitlePagingProbes(payload, span).slice(0, SUBTITLE_PROBE_LIMIT);
  state.message = t("subtitleProbing", String(probes.length), `\u6b63\u5728\u8bd5\u63a2\u5b57\u5e55\u63a5\u53e3\u7684\u5206\u9875\u53c2\u6570\uff08\u6700\u591a ${probes.length} \u6b21\u8bf7\u6c42\uff09\u2026`);
  await mirrorJob();
  for (const probe of probes) {
    const next = WebKeeperMediaEngine.protobufSetVarint(payload, probe.field, probe.value);
    if (!next) continue;
    let part;
    try { part = await requestSubtitlePart(url, call, next); }
    catch { continue; }
    // A neighbouring part may restart its timestamps at zero, so "reaches further" would throw
    // away a perfectly good new chunk. What matters is whether it carries cues we do not have.
    const fresh = WebKeeperMediaEngine.subtitleCueSpan(part.text);
    const grew = WebKeeperMediaEngine.subtitleCueSpan(WebKeeperMediaEngine.mergeVttDocuments([sample, part.text])).count > span.count;
    const reached = WebKeeperMediaEngine.subtitleCoverageSeconds(part.text);
    if (fresh.count > 0 && grew) {
      subtitleNote = "";
      log(t("subtitleProbeFound", [String(probe.field), String(probe.step)], `\u8bd5\u63a2\u6210\u529f\uff1a\u5206\u9875\u6e38\u6807\u662f\u7b2c ${probe.field} \u4e2a\u5b57\u6bb5\uff0c\u6b65\u957f ${probe.step}\u3002`));
      return { fields: [{ field: probe.field, max: probe.value }], step: probe.step, text: part.text, coverage: reached };
    }
    await waitFor(120);
  }
  if (WebKeeperMediaEngine.subtitlePagingAbsent(payload)) {
    subtitleNote = t("subtitleNoPaging", null, "\u8fd9\u4e2a\u63a5\u53e3\u7684\u8bf7\u6c42\u91cc\u53ea\u6709\u89c6\u9891 ID\uff0c\u6ca1\u6709\u4efb\u4f55\u5206\u9875\u53c2\u6570\uff0c\u8fd4\u56de\u7684\u5c31\u662f\u7ad9\u70b9\u4e3a\u8fd9\u4e2a\u89c6\u9891\u63d0\u4f9b\u7684\u5168\u90e8\u5b57\u5e55\u3002\u82e5\u7f51\u9875\u64ad\u5230\u8fd9\u4e4b\u540e\u4ecd\u6709\u5b57\u5e55\uff0c\u8bf7\u7528\u201c\u5b57\u5e55\u63a5\u53e3\u8bca\u65ad\u201d\u518d\u5bfc\u4e00\u6b21\u3002");
    log(subtitleNote);
    return null;
  }
  subtitleNote = WebKeeperMediaEngine.subtitlePagingAbsent(payload)
    ? t("subtitleNoPaging", null, "\u8fd9\u4e2a\u63a5\u53e3\u7684\u8bf7\u6c42\u91cc\u53ea\u6709\u4e00\u4e2a ID\uff0c\u6539\u5b83\u4e5f\u62ff\u4e0d\u5230\u65b0\u5185\u5bb9\u3002\u65e2\u7136\u7f51\u9875\u4e0a\u540e\u9762\u7684\u5b57\u5e55\u80fd\u6b63\u5e38\u663e\u793a\uff0c\u8bf7\u5728\u7f51\u9875\u91cc\u62d6\u5230\u540e\u9762\u7684\u4f4d\u7f6e\u3001\u7b49\u5b57\u5e55\u771f\u7684\u51fa\u73b0\uff0c\u518d\u70b9\u4e00\u6b21\u201c\u5b57\u5e55\u63a5\u53e3\u8bca\u65ad\u201d\uff1a\u6b64\u65f6\u5e94\u8be5\u4f1a\u591a\u51fa\u4e00\u6761\u8c03\u7528\uff0c\u4e24\u6b21\u7684\u53c2\u6570\u5dee\u522b\u5c31\u662f\u7b54\u6848\u3002")
    : t("subtitleProbeFailed", null, "\u8bd5\u63a2\u4e86\u6240\u6709\u6574\u6570\u53c2\u6570\uff0c\u63a5\u53e3\u90fd\u8fd4\u56de\u540c\u4e00\u6bb5\uff0c\u8bf4\u660e\u6e38\u6807\u4e0d\u662f\u7b80\u5355\u6570\u5b57\uff08\u53ef\u80fd\u662f\u5b57\u7b26\u4e32 token\uff09\u3002\u8bf7\u7528\u201c\u8ba9\u64ad\u653e\u5668\u8d70\u4e00\u904d\u201d\u3002");
  log(t("subtitleProbeFailed", null, "\u8bd5\u63a2\u4e86\u6240\u6709\u6574\u6570\u53c2\u6570\uff0c\u63a5\u53e3\u90fd\u8fd4\u56de\u540c\u4e00\u6bb5\uff0c\u8bf4\u660e\u6e38\u6807\u4e0d\u662f\u7b80\u5355\u6570\u5b57\uff08\u53ef\u80fd\u662f\u5b57\u7b26\u4e32 token\uff09\u3002\u8bf7\u7528\u201c\u8ba9\u64ad\u653e\u5668\u8d70\u4e00\u904d\u201d\u3002"));
  return null;
}

// Walks the paging cursor past what the player ever requested, so a track can be completed
// without touching the page. It stops as soon as a page adds no new cues, which is how the end
// of the track announces itself; SUBTITLE_SWEEP_LIMIT only guards against a cursor that never
// terminates.
async function extendSubtitleByPaging(url, calls, documents) {
  const payloads = calls.map((call) => WebKeeperMediaEngine.grpcWebPayload(Uint8Array.from(atob(call.body), (character) => character.charCodeAt(0))));
  const template = payloads[payloads.length - 1];
  let coverage = WebKeeperMediaEngine.subtitleCoverageSeconds(WebKeeperMediaEngine.mergeVttDocuments(documents));
  let added = 0;
  // A track that already spans the video has nothing to extend, and probing it would spend two
  // dozen requests only to report a paging scheme the user does not need.
  const videoSeconds = (mediaPlaylist?.segments || []).reduce((total, segment) => total + Number(segment.duration || 0), 0);
  if (videoSeconds > 0 && coverage >= videoSeconds * 0.9) return 0;
  let paging = WebKeeperMediaEngine.inferSubtitlePaging(payloads);
  if (!paging && template) {
    const probed = await probeSubtitlePaging(url, calls[calls.length - 1], template, documents[documents.length - 1]);
    if (probed) {
      paging = { fields: probed.fields, step: probed.step };
      documents.push(probed.text);
      coverage = Math.max(coverage, probed.coverage);
      added = 1;
    }
  }
  if (!paging) {
    if (!subtitleNote) subtitleNote = t("subtitleSweepUnavailable", null, "\u8fd9\u4e2a\u5b57\u5e55\u63a5\u53e3\u7684\u5206\u9875\u53c2\u6570\u770b\u4e0d\u51fa\u89c4\u5f8b\uff0c\u53ea\u80fd\u7528\u201c\u8ba9\u64ad\u653e\u5668\u8d70\u4e00\u904d\u201d\u8865\u9f50\u3002");
    log(t("subtitleSweepUnavailable", null, "\u8fd9\u4e2a\u5b57\u5e55\u63a5\u53e3\u7684\u5206\u9875\u53c2\u6570\u770b\u4e0d\u51fa\u89c4\u5f8b\uff0c\u53ea\u80fd\u7528\u201c\u8ba9\u64ad\u653e\u5668\u8d70\u4e00\u904d\u201d\u8865\u9f50\u3002"));
    return 0;
  }
  for (let index = 1; index <= SUBTITLE_SWEEP_LIMIT; index += 1) {
    let payload = template;
    for (const field of paging.fields) payload = payload && WebKeeperMediaEngine.protobufSetVarint(payload, field.field, field.max + index * paging.step);
    if (!payload) break;
    let part;
    try { part = await requestSubtitlePart(url, calls[calls.length - 1], payload); }
    catch { break; }
    // Only this page's own reach matters: re-merging everything each round would be quadratic,
    // and a forward cursor that stops advancing is exactly how the end of the track shows up.
    const next = WebKeeperMediaEngine.subtitleCoverageSeconds(part.text);
    if (!(next > coverage + 0.001)) break;
    documents.push(part.text);
    coverage = next;
    added += 1;
    state.message = t("subtitleSweepDirect", [String(added), formatTime(coverage)], `正在直接抽取字幕：已多取 ${added} 段，覆盖到 ${formatTime(coverage)}。`);
    await mirrorJob();
    // These are extra requests the player never made, so keep them at a human pace.
    await waitFor(120);
  }
  if (added) subtitleNote = "";
  if (added) log(t("subtitleSweptDirect", [String(added), formatTime(coverage)], `直接抽取补了 ${added} 段字幕，覆盖到 ${formatTime(coverage)}。`));
  return added;
}

// The recorded calls live in the shared candidate list and keep growing while the page plays.
async function refreshSubtitleCalls() {
  const known = new Map((candidate.subtitleCalls || []).map((call) => [`${call.url}|${call.body}`, call]));
  // Calls recorded before the list existed live in the one-per-URL map, and a candidate stored by
  // an earlier version has only those. They are real calls, so seed the list from them.
  const seed = (source) => {
    for (const [url, call] of Object.entries(source || {})) {
      if (call?.body) known.set(`${url}|${call.body}`, { ...call, url });
    }
  };
  seed(candidate.subtitleRequests);
  const stored = await chrome.storage.local.get({ [CANDIDATES_KEY]: [], discover: false });
  let onThisTab = 0;
  for (const item of stored[CANDIDATES_KEY] || []) {
    // An imported task is named after its folder, which need not match the live page's product,
    // so the tab it is explicitly attached to counts as the same work.
    const sameWork = normalizedWorkKey(item.product) === normalizedWorkKey(candidate.product);
    const sameTab = Number(candidate.tabId) >= 0 && Number(item.tabId) === Number(candidate.tabId);
    if (sameTab) onThisTab += (item.subtitleCalls || []).length + Object.keys(item.subtitleRequests || {}).length;
    if (!sameWork && !sameTab) continue;
    for (const call of item.subtitleCalls || []) known.set(`${call.url}|${call.body}`, call);
    seed(item.subtitleRequests);
  }
  candidate.subtitleCalls = Array.from(known.values());
  return { total: candidate.subtitleCalls.length, onThisTab, discover: Boolean(stored.discover) };
}

// The fallback that always works: drive the player through the whole video the same way capture
// does, and let the site issue its own subtitle calls, which the background records.
async function sweepPlayerForSubtitles() {
  if (!attachedToPage()) {
    state.message = t("subtitleSweepNeedsPage", null, "让播放器走一遍需要先接上原网页。");
    await mirrorJob();
    return { added: 0 };
  }
  const start = await refreshSubtitleCalls();
  // Nothing is ever recorded with discovery off, so a sweep would silently report zero forever.
  if (!start.discover) {
    state.message = t("subtitleSweepNeedsDiscover", null, "\u626b\u63cf\u5f00\u5173\u662f\u5173\u7684\uff0c\u6d4f\u89c8\u5668\u53d1\u51fa\u7684\u5b57\u5e55\u8bf7\u6c42\u4e0d\u4f1a\u88ab\u8bb0\u5f55\u3002\u5148\u5728\u6269\u5c55\u56fe\u6807\u91cc\u6253\u5f00\u201c\u53d1\u73b0\u89c6\u9891\u201d\uff0c\u518d\u8d70\u4e00\u904d\u3002");
    await mirrorJob();
    return { added: 0 };
  }
  log(t("subtitleSweepHint", null, "\u8d70\u4e00\u904d\u524d\u8bf7\u5148\u5728\u7f51\u9875\u64ad\u653e\u5668\u91cc\u628a\u5b57\u5e55\u6253\u5f00\uff1a\u5b57\u5e55\u5173\u7740\u65f6\u64ad\u653e\u5668\u6839\u672c\u4e0d\u4f1a\u53bb\u8bf7\u6c42\u5b57\u5e55\uff0c\u8fdb\u5ea6\u518d\u600e\u4e48\u8d70\u90fd\u662f 0 \u6bb5\u3002"));
  const before = start.total;
  const settings = normalizedSeekBoostSettings();
  const stepSeconds = Math.max(5, settings.stepSeconds);
  const intervalMs = Math.max(400, settings.intervalMs);
  let seen = before;
  let idle = 0;
  subtitleSweepRunning = true;
  render();
  try {
    for (let step = 0; step < SUBTITLE_PLAYER_STEPS && subtitleSweepRunning; step += 1) {
      const result = await stepSeekForward(stepSeconds, { ignorePause: true });
      await waitFor(intervalMs);
      const now = (await refreshSubtitleCalls()).total;
      if (now > seen) { seen = now; idle = 0; } else idle += 1;
      state.message = t("subtitleSweepPlayer", [String(seen - before), formatTime(result?.currentTime || 0)], `正在让播放器走一遍：新录到 ${seen - before} 段，当前 ${formatTime(result?.currentTime || 0)}。`);
      await mirrorJob();
      if (result?.ended) break;
      // A player that cannot be driven at all never reports a position; stop instead of spinning.
      if (!result?.ok && idle >= 8) break;
    }
  } finally {
    subtitleSweepRunning = false;
    render();
  }
  log(t("subtitleSweepPlayerDone", String(seen - before), `播放器走完一遍，新录到 ${seen - before} 段字幕调用。`));
  if (seen === before) {
    const detail = await refreshSubtitleCalls();
    // Zero has two very different causes and the user can only act on the right one.
    log(detail.onThisTab
      ? t("subtitleSweepNoNew", null, "\u8fd9\u4e2a\u6807\u7b7e\u9875\u5df2\u7ecf\u5f55\u5230\u8fc7\u5b57\u5e55\u8c03\u7528\uff0c\u4f46\u8fd9\u6b21\u6ca1\u6709\u65b0\u7684\uff1a\u64ad\u653e\u5668\u53ef\u80fd\u5df2\u7ecf\u628a\u6574\u6761\u5b57\u5e55\u7f13\u5b58\u5728\u672c\u5730\u4e86\u3002\u76f4\u63a5\u70b9\u201c\u4fdd\u5b58\u5b57\u5e55\u201d\u8bd5\u8bd5\u3002")
      : t("subtitleSweepNoCalls", null, "\u6574\u4e2a\u8fc7\u7a0b\u6ca1\u6709\u770b\u5230\u4efb\u4f55\u5b57\u5e55\u8bf7\u6c42\u3002\u6700\u5e38\u89c1\u7684\u539f\u56e0\u662f\u64ad\u653e\u5668\u91cc\u7684\u5b57\u5e55\u6ca1\u5f00\uff08\u5b57\u5e55\u5173\u7740\u5c31\u4e0d\u4f1a\u53d1\u8bf7\u6c42\uff09\uff0c\u5176\u6b21\u662f\u63a5\u9519\u4e86\u6807\u7b7e\u9875\u3002\u628a\u5b57\u5e55\u6253\u5f00\u3001\u624b\u52a8\u62d6\u4e00\u4e0b\u8fdb\u5ea6\u6761\u786e\u8ba4\u5b57\u5e55\u771f\u7684\u5728\u663e\u793a\uff0c\u518d\u8d70\u4e00\u904d\u3002"));
  }
  return { added: seen - before };
}

// The direct path is otherwise invisible: it runs inside a normal save, and its precondition
// (at least two recorded calls) is not something the user can see.
async function extractSubtitlesDirectly() {
  const found = await refreshSubtitleCalls();
  if (!found.discover) {
    state.message = t("subtitleSweepNeedsDiscover", null, "\u626b\u63cf\u5f00\u5173\u662f\u5173\u7684\uff0c\u6d4f\u89c8\u5668\u53d1\u51fa\u7684\u5b57\u5e55\u8bf7\u6c42\u4e0d\u4f1a\u88ab\u8bb0\u5f55\u3002\u5148\u5728\u6269\u5c55\u56fe\u6807\u91cc\u6253\u5f00\u201c\u53d1\u73b0\u89c6\u9891\u201d\uff0c\u518d\u8d70\u4e00\u904d\u3002");
    await mirrorJob();
    return;
  }
  if (found.total < 1) {
    state.message = t("subtitleDirectNeedsCalls", String(found.total), `\u8fd8\u6ca1\u6709\u5f55\u5230\u4efb\u4f55\u5b57\u5e55\u8c03\u7528\u3002\u5148\u5728\u7f51\u9875\u64ad\u653e\u5668\u91cc\u628a\u5b57\u5e55\u6253\u5f00\u5e76\u64ad\u653e\u51e0\u79d2\uff0c\u8ba9\u6d4f\u89c8\u5668\u771f\u7684\u8bf7\u6c42\u4e00\u6b21\uff0c\u518d\u56de\u6765\u70b9\u8fd9\u91cc\u3002`);
    await mirrorJob();
    return;
  }
  log(t("subtitleDirectStart", String(found.total), `\u5df2\u5f55\u5230 ${found.total} \u6bb5\u5b57\u5e55\u8c03\u7528\uff0c\u5f00\u59cb\u76f4\u63a5\u62bd\u53d6\u5b8c\u6574\u5b57\u5e55\u3002`));
  await saveSubtitles();
}

async function discoverSubtitles() {
  const before = new Set(candidate.subtitles || []);
  const found = new Map();
  const stored = await chrome.storage.local.get({ [CANDIDATES_KEY]: [] });
  for (const item of stored[CANDIDATES_KEY] || []) {
    if (normalizedWorkKey(item.product) !== normalizedWorkKey(candidate.product)) continue;
    for (const url of item.subtitles || []) found.set(url, (item.subtitleTypes || {})[url] || "");
    // Carry the recorded call and the page headers as well, or the URL alone cannot be fetched.
    candidate.subtitleRequests = { ...(candidate.subtitleRequests || {}), ...(item.subtitleRequests || {}) };
    if (item.subtitleCalls?.length) {
      const known = new Map((candidate.subtitleCalls || []).map((call) => [`${call.url}|${call.body}`, call]));
      for (const call of item.subtitleCalls) known.set(`${call.url}|${call.body}`, call);
      candidate.subtitleCalls = Array.from(known.values());
    }
    if (Number(item.tabId) >= 0 && !(Number(candidate.tabId) >= 0)) candidate.tabId = Number(item.tabId);
    candidate.headers = { ...(item.headers || {}), ...(candidate.headers || {}) };
  }
  // The bound playlist is usually a media playlist; the master is where subtitle tracks live.
  const playlistUrls = Array.from(new Set([...(candidate.playlistUrls || []), candidate.playlistUrl].filter(Boolean)))
    .filter((url) => !String(url).startsWith("https://legacy.local/"));
  for (const url of playlistUrls.slice(-8)) {
    try {
      const parsed = parsePlaylist(await fetchText(url), url);
      for (const track of parsed.subtitles || []) {
        if (!track.url) continue;
        found.set(track.url, "");
        candidate.subtitleLabels = { ...(candidate.subtitleLabels || {}), [track.url]: [track.language, track.label].filter(Boolean).join("-") || "subtitle" };
      }
    } catch { /* skip unreadable playlist */ }
  }
  if (found.size) {
    candidate.subtitles = Array.from(new Set([...(candidate.subtitles || []), ...found.keys()]));
    candidate.subtitleTypes = { ...(candidate.subtitleTypes || {}), ...Object.fromEntries([...found].filter(([, type]) => type)) };
    state.candidate = { ...candidate };
  }
  const added = validSubtitleUrls(candidate.subtitles || []).filter((url) => !before.has(url)).length;
  return { total: validSubtitleUrls(candidate.subtitles || []).length, added };
}

async function publishImportedSubtitles() {
  // Legacy imports copy subtitle files into the workspace; give them a way out to Downloads.
  let published = 0;
  try {
    const directory = await workDirectory.getDirectoryHandle("subtitles");
    for await (const [name, handle] of directory.entries()) {
      if (handle.kind !== "file") continue;
      await publishSavedFile(handle, name, { removeInternal: false, sourceDirectory: directory, trackAsOutput: false });
      published += 1;
    }
  } catch { /* no imported subtitles */ }
  return published;
}

async function saveSubtitles({ automatic = false } = {}) {
  await ensureDirectories();
  if (!automatic && !validSubtitleUrls(candidate.subtitles || []).length) {
    state.message = t("subtitleSearching", null, "正在查找这个视频的字幕…");
    await mirrorJob();
    const result = await discoverSubtitles();
    log(t("subtitleSearchDone", [String(result.total), String(result.added)], `字幕查找完成：共 ${result.total} 条（新发现 ${result.added} 条）。`));
  }
  const urls = validSubtitleUrls(candidate.subtitles || []);
  if (!urls.length) {
    const published = await publishImportedSubtitles();
    if (!automatic) {
      state.message = published
        ? t("subtitlesPublished", String(published), `已把 ${published} 个导入的字幕文件保存到 Downloads。`)
        : t("subtitlesNone", null, "这个任务没有可保存的字幕。");
      await mirrorJob();
    }
    return { saved: published, total: published };
  }
  // With a custom folder nothing is exported anywhere, so a "subtitles" subfolder just hides the
  // file. Put it beside the video, which is also where players look for an external track.
  await ensureOpenCC();
  const directory = saveDestination === "browser-downloads"
    ? await workDirectory.getDirectoryHandle("subtitles", { create: true })
    : workDirectory;
  let saved = 0;
  const savedNames = [];
  let conversionWarned = false;
  let coverageSeconds = 0;
  let coverageStart = 0;
  let cueCount = 0;
  subtitleNote = "";
  const failures = [];
  for (const [index, url] of urls.entries()) {
    try {
      const raw = await fetchSubtitleContent(url);
      if (!openCcConverters && ["zh-hans", "zh-hant"].includes(subtitleConvertMode) && !conversionWarned) {
        const sample = new TextDecoder().decode((raw.data instanceof Uint8Array ? raw.data : new Uint8Array(raw.data)).subarray(0, 20000));
        const unmapped = WebKeeperMediaEngine.unconvertedChineseCount(sample, subtitleConvertMode);
        if (unmapped > 0) {
          conversionWarned = true;
          log(t("subtitleConvertPartial", String(unmapped), `简繁转换用的是内置字表，覆盖常用字；本次样本中约有 ${unmapped} 个汉字没有对应规则，保持了原样。专业词汇可能未转换。`));
        }
      }
      const span = WebKeeperMediaEngine.subtitleCueSpan(
        new TextDecoder().decode(raw.data instanceof Uint8Array ? raw.data : new Uint8Array(raw.data))
      );
      if (span.end > coverageSeconds) { coverageSeconds = span.end; coverageStart = span.start; }
      cueCount = Math.max(cueCount, span.count);
      const fetched = applySubtitleFormat(raw.data, raw.extension);
      const data = fetched.data;
      const ext = fetched.extension;
      // Players auto-load an external track only when its name matches the video exactly, so a
      // single track gets the bare name and only extra tracks carry a distinguishing label.
      const modeSuffix = subtitleConvertMode === "none" ? "" : `.${subtitleConvertMode}`;
      const label = urls.length > 1
        ? `.${safeName((candidate.subtitleLabels?.[url] || `subtitle-${String(index + 1).padStart(2, "0")}`) + modeSuffix, `subtitle-${index + 1}`)}`
        : (modeSuffix ? safeName(modeSuffix, "") : "");
      // Subtitles are usually saved before the merge, when state.outputName is still empty. Falling
      // back to the page title produced a name unrelated to the video file, so use the same base
      // name the merge will use.
      const base = state.outputName ? state.outputName.replace(/\.[^.]+$/, "") : preferredOutputBaseName();
      const subtitleName = `${safeName(base || "video")}${label}.${safeName(ext, "vtt")}`;
      const fileHandle = await writeFile(directory, subtitleName, data);
      await publishSavedFile(fileHandle, subtitleName, { removeInternal: true, sourceDirectory: directory, trackAsOutput: false });
      savedNames.push(subtitleName);
      saved += 1;
    } catch (error) {
      failures.push(error.message);
      log(`字幕保存失败（${url}）：${error.message}`);
    }
  }
  state.subtitlesSaved = saved;
  state.subtitlesTotal = urls.length;
  // A bare "0/1" leaves no way to act; the reason has to be on screen, not only in the log.
  if (!automatic) {
    const videoSeconds = (mediaPlaylist?.segments || []).reduce((total, segment) => total + Number(segment.duration || 0), 0);
    // "Saved 1/1" says nothing about whether the track is complete, which is the only thing the
    // user actually wants to know here.
    // The note only explains a short result; keeping it on a complete one just alarms people.
    if (coverageSeconds > 0 && videoSeconds > 0 && coverageSeconds >= videoSeconds * 0.9) subtitleNote = "";
    const reach = coverageSeconds <= 0
      ? ""
      : videoSeconds
        ? t("subtitleReach", [String(cueCount), formatTime(coverageStart), formatTime(coverageSeconds), formatTime(videoSeconds)],
          `（${cueCount} 条，覆盖 ${formatTime(coverageStart)} – ${formatTime(coverageSeconds)}，视频长 ${formatTime(videoSeconds)}）`)
        : t("subtitleReachNoDuration", [String(cueCount), formatTime(coverageStart), formatTime(coverageSeconds)],
          `（${cueCount} 条，覆盖 ${formatTime(coverageStart)} – ${formatTime(coverageSeconds)}）`);
    // A track that stops where playback stopped looks fine until it is opened, so say it here.
    if (saved && !subtitleNote && coverageSeconds > 0 && videoSeconds > 0 && coverageSeconds < videoSeconds * 0.9) {
      log(t("subtitleCoverageShort", [formatTime(coverageSeconds), formatTime(videoSeconds)], `\u5b57\u5e55\u53ea\u8986\u76d6\u5230 ${formatTime(coverageSeconds)}\uff0c\u89c6\u9891\u957f ${formatTime(videoSeconds)}\u3002\u5b57\u5e55\u63a5\u53e3\u662f\u8ddf\u7740\u64ad\u653e\u8fdb\u5ea6\u5206\u6bb5\u8fd4\u56de\u7684\uff0c\u628a\u7f51\u9875\u5b8c\u6574\u8d70\u4e00\u904d\uff08\u53ef\u4ee5\u5f00\u500d\u901f\u6216\u62d6\u52a8\u8fdb\u5ea6\u6761\uff09\u540e\u518d\u4fdd\u5b58\u4e00\u6b21\uff0c\u5df2\u6709\u7684\u90e8\u5206\u4f1a\u81ea\u52a8\u5408\u5e76\u3002`));
    }
    const recordedCalls = (candidate?.subtitleCalls || []).length;
    if (saved && recordedCalls <= 1) log(t("subtitlePartialCoverage", null, "只录到一次字幕请求，保存的可能只是播放过的那一段。让网页从头播放或用播放加速走一遍，再保存一次即可补齐。"));
    const headline = failures.length
      ? t("subtitlesSavedWithError", [String(saved), String(urls.length), failures[0]], `已保存 ${saved}/${urls.length} 条字幕。失败原因：${failures[0]}`)
      : t("subtitlesSaved", [saved, urls.length], `已保存 ${saved}/${urls.length} 条字幕。`);
    // "Saved 1/1" with no path sent the user hunting through folders.
    const where = savedNames.length
      ? t("subtitleSavedAt", [savedNames[0], saveDestination === "browser-downloads"
        ? t("browserDownloadsLocation", null, "浏览器 Downloads")
        : [rootFolderLabel(rootHandle), state.directoryName].filter(Boolean).join(" / ")], `文件：${savedNames[0]}（在 ${[rootFolderLabel(rootHandle), state.directoryName].filter(Boolean).join(" / ")}）`)
      : "";
    state.message = [headline, reach, where, subtitleNote].filter(Boolean).join(" ");
  }
  await mirrorJob();
  return { saved, total: urls.length };
}

// Switch this task to a real folder on disk, right now, and carry over whatever is already
// saved. In a private window the browser-Downloads destination is memory-only, so this is the
// difference between keeping the bytes across a crash and losing them.
async function switchTaskToFolder() {
  if (!window.showDirectoryPicker) {
    state.message = t("browserUnsupportedFolder", null, "当前浏览器不支持直接选择保存目录，请使用最新版 Chrome 或 Edge。");
    await mirrorJob();
    return;
  }
  let picked = null;
  try { picked = await window.showDirectoryPicker({ id: "web-keeper-root", mode: "readwrite", startIn: "downloads" }); }
  catch (error) {
    await reportFolderPickFailure(error);
    return;
  }
  if (!picked) return;
  const previousSegmentDirectory = segmentDirectory;
  const previousDestination = saveDestination;
  rootHandle = picked;
  saveDestination = "custom-folder";
  state.saveDestination = "custom-folder";
  await dbPut("handles", { id: state.id, handle: picked });
  await dbPut("handles", { id: "default-root", handle: picked });
  await ensureDirectories({ requestPermission: true });
  await chrome.storage.local.set({ saveDestination: "custom-folder" });

  // Carry over segments that only exist in the ephemeral workspace.
  if (previousDestination === "browser-downloads" && previousSegmentDirectory && previousSegmentDirectory !== segmentDirectory) {
    const records = (await listSegmentRecords(state.id)).filter((item) => item.source !== LEGACY_LINK_SOURCE && item.kind !== "dash");
    let moved = 0;
    for (const record of records) {
      try {
        const bytes = new Uint8Array(await (await (await previousSegmentDirectory.getFileHandle(record.fileName)).getFile()).arrayBuffer());
        await writeFile(segmentDirectory, record.fileName, bytes);
        moved += 1;
        if (moved % 100 === 0) {
          state.message = t("switchFolderMoving", [String(moved), String(records.length)], `正在把已保存的分片搬到新目录：${moved}/${records.length}`);
          await mirrorJob();
        }
      } catch { /* nothing to carry for this record */ }
    }
    state.message = t("switchFolderDone", [String(moved), rootHandle.name || ""], `已改为保存到「${rootHandle.name || ""}」，并搬过去 ${moved} 个已保存分片。之后下载的内容会直接写入磁盘。`);
  } else {
    state.message = t("switchFolderReady", rootHandle.name || "", `已改为保存到「${rootHandle.name || ""}」。之后下载的内容会直接写入磁盘。`);
  }
  invalidateSavedSequences();
  await reconcileSaved();
  log(state.message);
  await mirrorJob();
}

// Chrome refuses Downloads, Desktop, Documents and the home folder for a directory picker
// ("contains system files"). Swallowing that as a cancel left the user retrying the same folder.
async function reportFolderPickFailure(error) {
  if (!error || error.name === "AbortError") return false;
  const blocked = error.name === "SecurityError" || /system files|not allowed|blocklist/i.test(String(error.message || ""));
  state.message = blocked
    ? t("folderBlocked", null, "浏览器不允许直接选择 Downloads、桌面、文档等系统文件夹。请在其中新建一个子文件夹（例如 Downloads\WebKeeper），再选那个子文件夹。")
    : t("folderPickFailed", error.message, `无法使用这个文件夹：${error.message}`);
  log(state.message);
  await mirrorJob();
  return true;
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
    if (await reportFolderPickFailure(error)) return;
    state.status = "error";
    state.message = error.message;
    await mirrorJob();
  }
}

async function resumeTask() {
  try {
    if (Number(state?.done || 0) > 0 && Number(state?.missing || 0) === 0 && state.status !== "complete"
      && (state.mode === "browser-assisted" || state.source === "legacy-import")) {
      // Everything is saved already; the only useful next step is creating the video.
      state.status = "downloaded";
      state.errorCode = "";
      state.message = t("allSavedCreateNow", null, "内容已全部保存。点「检查并生成视频」即可；空间不够时会让你选择保存位置。");
      await mirrorJob();
      return;
    }
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
        const collect = (root, out = []) => { for (const node of root.querySelectorAll("*")) { if (node.tagName === "VIDEO") out.push(node); if (node.shadowRoot) collect(node.shadowRoot, out); } return out; };
        const videos = collect(document);
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
    // Scripting throws when the tab is gone or cannot be scripted, which is a different
    // problem from a page that simply has no video element.
    return { ok: false, reason: "NO_TAB" };
  }
}

async function reattachVideoTab() {
  if (!candidate?.pageUrl) return false;
  try {
    const tabs = await chrome.tabs.query({ url: candidate.pageUrl });
    const tab = tabs?.[0];
    if (!(Number(tab?.id) >= 0)) return false;
    candidate.tabId = Number(tab.id);
    state.candidate = { ...candidate };
    log(`原标签页已变化，已重新找到该视频页面（标签页 ${candidate.tabId}）`);
    await ensurePageCaptureHook(candidate.tabId, { announce: true });
    return true;
  } catch {
    return false;
  }
}

async function playerFailureMessage(result) {
  if (result?.reason !== "NO_TAB") return t("videoElementNotFound", null, "原网页中没有找到可控制的视频播放器，请手动播放到提示位置。");
  // Capture keeps working through webRequest even when this page cannot script that tab, which
  // is exactly what happens across the InPrivate/normal split, so name that case explicitly.
  let reachable = false;
  try { reachable = Boolean(await chrome.tabs.get(Number(candidate.tabId))); } catch { reachable = false; }
  if (!reachable && Number(state?.lastSeenAt || 0) > Date.now() - 120000) {
    return t("videoTabOtherContext", null, "仍在收到这个视频的请求，但本页无法控制那个标签页。通常是视频开在 InPrivate 窗口而任务页在普通窗口（或反过来）。请把视频页和任务页放在同一种窗口里再试。");
  }
  return t("videoTabUnavailable", null, "原网页的标签页已关闭或无法访问。请重新打开该视频页面并开始播放。");
}

function stopSeekBoost() {
  if (seekBoostTimer) {
    clearInterval(seekBoostTimer);
    seekBoostTimer = null;
  }
}

async function stepSeekForward(stepSeconds = SEEK_BOOST_STEP_SECONDS, { ignorePause = false } = {}) {
  const tabId = Number(candidate?.tabId);
  // A subtitle sweep drives the player on a finished or paused task, where the capture guard
  // would otherwise turn every step into a no-op.
  if (!(tabId >= 0) || (paused && !ignorePause)) return null;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      args: [Number(stepSeconds) || 10],
      func: (step) => {
        const collect = (root, out = []) => { for (const node of root.querySelectorAll("*")) { if (node.tagName === "VIDEO") out.push(node); if (node.shadowRoot) collect(node.shadowRoot, out); } return out; };
        const videos = collect(document);
        const video = videos.sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))[0];
        if (!video) return { ok: false, reason: "NO_VIDEO" };
        const duration = Number.isFinite(video.duration) ? video.duration : 0;
        const next = duration ? Math.min(video.currentTime + step, Math.max(0, duration - 0.25)) : video.currentTime + step;
        video.muted = true;
        const before = video.currentTime;
        video.currentTime = next;
        try { void video.play(); } catch { /* gesture may be required */ }
        // Only fall back to the keyboard for players that ignore currentTime; sending it as well
        // made sites that map ArrowRight to +10s jump twice per step.
        if (Math.abs(video.currentTime - before) < 0.25) {
          try {
            video.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", code: "ArrowRight", keyCode: 39, which: 39, bubbles: true }));
            document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", code: "ArrowRight", keyCode: 39, which: 39, bubbles: true }));
          } catch { /* some pages block synthetic keys */ }
        }
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
        const collect = (root, out = []) => { for (const node of root.querySelectorAll("*")) { if (node.tagName === "VIDEO") out.push(node); if (node.shadowRoot) collect(node.shadowRoot, out); } return out; };
        const videos = collect(document);
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
  let applied = await applyCaptureSpeed(wanted);
  if (!applied && await reattachVideoTab()) applied = await applyCaptureSpeed(wanted);
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

function hasRealSegmentUrls() {
  const first = mediaPlaylist?.segments?.[0]?.url || "";
  return Boolean(first) && !String(first).startsWith("https://legacy.local/");
}

// Seeking the player to fill 1600 one-segment gaps is mostly seek overhead. Once the task knows
// the real segment URLs, the gaps can simply be fetched, in parallel, with no player involved.
// Merging reads every segment and aborts on the first bad one. This checks them all first and
// reports every bad one, turning them back into gaps so they can simply be re-filled.
async function verifyAllSegments() {
  if (verifyRunning) return;
  if (!mediaPlaylist) await loadMediaPlaylist();
  const records = (await listSegmentRecords(state.id)).filter((item) => item.kind !== "dash");
  if (!records.length) {
    state.message = t("verifyNothing", null, "还没有可检查的分片。");
    await mirrorJob();
    return;
  }
  if (!confirm(t("verifyConfirm", String(records.length), `检查 ${records.length} 个分片的有效性？需要完整读取一遍（旧目录的分片还要解密），可能耗时数分钟。`))) return;
  verifyRunning = true;
  paused = false;
  let checked = 0;
  const bad = [];
  const unknown = [];
  state.status = "downloading";
  state.message = t("verifyWorking", ["0", String(records.length)], `正在检查分片：0/${records.length}`);
  await mirrorJob();
  try {
    records.sort((a, b) => Number(a.sequence) - Number(b.sequence));
    await mapConcurrent(records, Math.min(4, captureConcurrency), async (record) => {
      if (paused || !verifyRunning) return;
      // "Does not look like TS" only means "corrupt" when we know the bytes were readable in the
      // clear. Encrypted segments we could not decrypt, and reads that threw, are undecided —
      // deleting those threw away segments that were fine.
      let verdict = "unknown";
      const meta = playlistSegmentBySequence(record.sequence);
      try {
        const bytes = await readStoredSegment(record, meta);
        if (!isValidSegmentSize(bytes.byteLength)) verdict = "bad";
        else {
          const head = bytes.subarray(0, Math.min(bytes.byteLength, 4 * 188));
          const inspection = WebKeeperMediaEngine.inspectMediaBytes(head);
          if (inspection.container === "mpegts" || inspection.container === "mp4") verdict = "ok";
          else verdict = meta?.key && meta.key.method !== "NONE" ? "unknown" : (meta ? "bad" : "unknown");
        }
      } catch { verdict = "unknown"; }
      if (verdict === "bad") bad.push(record);
      else if (verdict === "unknown") unknown.push(record);
      checked += 1;
      if (checked % 50 === 0) {
        state.message = t("verifyWorking", [String(checked), String(records.length)], `正在检查分片：${checked}/${records.length}`);
        await mirrorJob();
      }
    });
    for (const record of bad) {
      try { await dbDelete("segments", record.id); } catch { /* already gone */ }
      if (savedSequenceCache.jobId === state?.id) savedSequenceCache.set.delete(Number(record.sequence));
    }
    const undecided = unknown.length
      ? t("verifyUndecided", String(unknown.length), `\u53e6\u6709 ${unknown.length} \u4e2a\u65e0\u6cd5\u5224\u5b9a\uff08\u52a0\u5bc6\u4f46\u672a\u80fd\u89e3\u5f00\uff0c\u6216\u8bfb\u4e0d\u5230\u539f\u6587\u4ef6\uff09\uff0c\u5df2\u539f\u6837\u4fdd\u7559\u3001\u672a\u5220\u9664\u3002`)
      : "";
    if (bad.length) {
      await reconcileSaved();
      state.message = [t("verifyFoundBad", [String(bad.length), String(records.length)], `检查完成：${records.length} 个分片中有 ${bad.length} 个无效，已重新标为缺口，可再次补齐。`), undecided].filter(Boolean).join(" ");
    } else {
      state.message = [t("verifyAllGood", String(records.length), `检查完成：${records.length} 个分片全部有效，可以生成视频。`), undecided].filter(Boolean).join(" ");
    }
  } catch (error) {
    state.message = t("verifyFailed", error.message, `检查中断：${error.message}`);
  } finally {
    verifyRunning = false;
    await updateMissingTimeline({ force: true });
    state.status = Number(state.missing || 0) ? "waiting" : "downloaded";
    await mirrorJob();
  }
}

async function fillGapsDirectly() {
  if (directFillRunning) return;
  if (!mediaPlaylist) await loadMediaPlaylist();
  if (!hasRealSegmentUrls()) {
    state.message = t("directFillNeedsUrls", null, "还没有真实的分片地址。请先打开原网页播放，让任务接上网页的播放列表。");
    await mirrorJob();
    return;
  }
  const skippable = skippableSequenceSet();
  const saved = await savedSequenceSet();
  const pending = mediaPlaylist.segments.filter((segment) => !segment.gap
    && !saved.has(Number(segment.sequence))
    && !skippable.has(Number(segment.sequence)));
  if (!pending.length) {
    state.message = t("directFillNothing", null, "没有需要补的分片。");
    await mirrorJob();
    return;
  }
  if (!confirm(t("directFillConfirm", String(pending.length), `直接补齐 ${pending.length} 个缺片？不需要播放网页，会按设置的并发直接请求。`))) return;
  directFillRunning = true;
  paused = false;
  startProgressWatchdog();
  let done = 0;
  let failed = 0;
  let authFailures = 0;
  // Sites cut off a steady stream of direct requests, so pace adaptively: slow down on any
  // refusal, speed back up while it keeps working. Everything is checkpointed either way.
  let pacingMs = 0;
  let sinceSlowdown = 0;
  state.status = "downloading";
  await mirrorJob();
  try {
    const batches = [];
    for (let index = 0; index < pending.length; index += DIRECT_FILL_BATCH) batches.push(pending.slice(index, index + DIRECT_FILL_BATCH));
    for (const batch of batches) {
      if (paused || !directFillRunning) break;
      await mapConcurrent(batch, captureConcurrency, async (segment) => {
      if (paused || !directFillRunning) return;
      if (pacingMs) await waitFor(pacingMs);
      noteSegmentActivity({ sequence: segment.sequence, status: "saving" });
      const startedAt = Date.now();
      lastSegmentSource = "";
      try {
        const saved = await saveSegment(segment, candidate.headers || {}, { pageTabId: candidate.tabId, preferPageBuffer: false });
        done += 1;
        authFailures = 0;
        sinceSlowdown += 1;
        if (pacingMs && sinceSlowdown >= 25) {
          pacingMs = Math.max(0, pacingMs - 150);
          sinceSlowdown = 0;
        }
        state.lastSavedSequence = segment.sequence;
        noteSegmentActivity({ sequence: segment.sequence, status: "saved", size: Number(saved?.size || 0), ms: Date.now() - startedAt, source: lastSegmentSource });
      } catch (error) {
        failed += 1;
        sinceSlowdown = 0;
        const rateLimited = /429/.test(error.message);
        pacingMs = Math.min(5000, rateLimited ? Math.max(1500, pacingMs * 2 || 1500) : (pacingMs * 2 || 250));
        if (/(401|403|410)/.test(error.message)) authFailures += 1;
        noteSegmentActivity({ sequence: segment.sequence, status: "failed", reason: error.message });
        // A run of authorisation failures means the site wants the player session; stop early
        // instead of hammering it for thousands of segments.
        if (authFailures >= 8) {
          directFillRunning = false;
          throw new Error(t("directFillBlocked", null, "站点连续拒绝了直接请求，可能要求播放器会话。已停止直接补齐，请改用智能补全。"));
        }
      }
      if (done % 10 === 0) {
        state.message = t("directFillProgress", [String(done), String(pending.length), String(failed), pacingMs ? `${(pacingMs / 1000).toFixed(1)}s` : "0"], `直接补齐中：已补 ${done}/${pending.length}，失败 ${failed}，当前间隔 ${(pacingMs / 1000).toFixed(1)}s。`);
        await mirrorJob();
      }
      });
      await updateMissingTimeline({ force: true });
      await mirrorJob();
      await waitFor(50);
    }
    state.message = t("directFillDone", [String(done), String(failed)], `直接补齐结束：成功 ${done}，失败 ${failed}。`);
  } catch (error) {
    state.message = error.message;
  } finally {
    directFillRunning = false;
    await updateMissingTimeline({ force: true });
    state.status = Number(state.missing || 0) ? "waiting" : "downloaded";
    await mirrorJob();
  }
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
  smartFillDone = 0;
  smartFillSkipped = 0;
  smartFillGaveUp = new Set();
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
      // A gap that cannot be filled must not stop the run, and must not be picked again.
      const range = ranges.find((item) => !smartFillGaveUp.has(rangeKey(item)));
      if (!range) break;
      const remainingRanges = ranges.length;
      smartFillActiveRange = range;
      const rangeStart = Number(range.startSeconds || 0);
      const rangeEnd = Number(range.endSeconds || rangeStart);
      state.message = t("smartFillRangeWorking", [formatTime(rangeStart), formatTime(rangeEnd), range.count, remainingRanges], `正在补 ${formatTime(rangeStart)} – ${formatTime(rangeEnd)}（${range.count} 项）；还剩 ${remainingRanges} 处缺口。`);
      await mirrorJob();
      let cursor = Math.max(0, rangeStart - 2);
      let step = 8;
      let dwell = 1100;
      let noProgress = 0;
      let skewWarned = false;
      while (smartFillRunning && !paused && cursor < rangeEnd + 1) {
        const before = Number(state.done || 0);
        let player = await seekVideoAndInspect(Number(candidate.tabId), cursor);
        if (!player?.ok && player?.reason === "NO_TAB" && await reattachVideoTab()) {
          player = await seekVideoAndInspect(Number(candidate.tabId), cursor);
        }
        if (state.captureSpeedMode !== "seek" && Number(state.captureSpeed || 1) > 1) await applyCaptureSpeed();
        if (!player?.ok) throw new Error(await playerFailureMessage(player));
        const actual = Number(player.currentTime || 0);
        const inRange = actual >= rangeStart - SMART_FILL_SEEK_SKEW_SECONDS && actual <= rangeEnd + SMART_FILL_SEEK_SKEW_SECONDS + step;
        if (!inRange && !skewWarned) {
          skewWarned = true;
          const skewMessage = t("smartFillSeekSkew", [formatTime(actual), formatTime(rangeStart), formatTime(rangeEnd)], `播放器停在 ${formatTime(actual)}，与目标缺口 ${formatTime(rangeStart)} – ${formatTime(rangeEnd)} 差距较大。将重试跳转；若反复失败请手动拖到该时间。`);
          state.message = skewMessage;
          state.stalled = true;
          await mirrorJob();
          state.stalled = false;
        }
        const loaded = player.readyState >= 2 && (!player.bufferedEnd || player.bufferedEnd >= player.currentTime + 0.5);
        await waitFor(loaded ? dwell : Math.max(dwell, 2600));
        if (Number(state.done || 0) > before) {
          noProgress = 0;
          step = Math.min(10, step + 1);
          dwell = Math.max(500, dwell - 200);
          state.message = t("smartFillRangeWorking", [formatTime(rangeStart), formatTime(rangeEnd), Math.max(1, Number(state.missing || 1)), remainingRanges], `正在补 ${formatTime(rangeStart)} – ${formatTime(rangeEnd)}；还剩 ${remainingRanges} 处缺口。`);
          await mirrorJob();
        } else {
          noProgress += 1;
          step = Math.max(2, Math.floor(step / 2));
          dwell = Math.min(4000, dwell + 500);
        }
        if (noProgress >= 5) {
          smartFillGaveUp.add(rangeKey(range));
          smartFillSkipped += 1;
          state.message = t("smartFillRangeSkipped", [formatTime(actual || cursor), String(smartFillSkipped)], `在 ${formatTime(actual || cursor)} 附近取不到新内容，先跳过这处缺口继续下一处（已跳过 ${smartFillSkipped} 处）。`);
          log(state.message);
          await mirrorJob();
          break;
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
        smartFillGaveUp.add(rangeKey(range));
        smartFillSkipped += 1;
        await mirrorJob();
        continue;
      }
      smartFillDone += 1;
      const nextMsg = t("smartFillNextRange", [formatTime(next.startSeconds), formatTime(next.endSeconds), nextRanges.length, next.count], `本段已处理。下一处缺口约在 ${formatTime(next.startSeconds)} – ${formatTime(next.endSeconds)}（${next.count} 项，共剩 ${nextRanges.length} 处）。将继续自动跳转。`);
      state.message = nextMsg;
      await mirrorJob();
    }
    await updateMissingTimeline();
    smartFillActiveRange = null;
    state.stalled = Boolean(state.missing);
    state.message = state.missing
      ? t("smartFillStillMissing", [String(state.missing), String(smartFillSkipped)], `自动补全结束，仍有 ${state.missing} 项需要手动播放（其中 ${smartFillSkipped} 处缺口本轮没能补上）。`)
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

const LARGE_OUTPUT_BYTES = 1024 * 1024 * 1024;
const DIRECT_FILL_BATCH = 300;

async function finalizeDownloadedTask() {
  if (dashCapture) return finalizeDashCapture();
  if (state.mode === "browser-assisted" || (state.providerId === "hls" && !state.separateTracks)) {
    let preset = null;
    const estimated = Number(state.bytes || 0);
    if (estimated > LARGE_OUTPUT_BYTES && window.showSaveFilePicker) {
      // The picker must run inside the click gesture; scanning 14k records first would consume it.
      preset = await chooseExternalOutputHandle(`${preferredOutputBaseName()}.mp4`);
      if (!preset) {
        state.message = t("largeOutputNeedsLocation", formatBytes(estimated), `成品约 ${formatBytes(estimated)}，需要先选择保存位置才能生成（会直接写入该文件，不占扩展存储）。`);
        await mirrorJob();
        return;
      }
    }
    return mergeOutput(true, { presetExternalHandle: preset });
  }
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
  // Removing only the record used to strand gigabytes of segments with no way to reclaim them.
  if (state?.id === jobId && Number(state.done || 0) > 0
    && confirm(t("removeTaskDataConfirm", null, "同时删除这个任务已保存的分片和临时内容？（就地引用的旧目录不会被动，成品文件也保留）"))) {
    try { await removeTemporaryData(); } catch (error) { log(`清理临时内容失败：${error.message}`); }
  }
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
  if (Number(candidate.tabId) >= 0) {
    try {
      await chrome.tabs.update(Number(candidate.tabId), { active: true });
      return;
    } catch { /* tab closed since it was seen */ }
  }
  if (candidate.pageUrl) {
    try {
      const tab = await chrome.tabs.create({ url: candidate.pageUrl, active: true });
      if (Number(tab?.id) >= 0) candidate.tabId = Number(tab.id);
      return;
    } catch { /* fall through to the notice below */ }
  }
  // Silently doing nothing was indistinguishable from a broken button.
  state.message = t("noVideoPageKnown", null, "还不知道这个视频的网页地址。请自己打开该视频的网页并开始播放，Web Keeper 会自动接上。");
  log(state.message);
  await mirrorJob();
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
        parentHandle: directoryHandle,
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
          parentHandle: child.handle,
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
    if (!rootHandle && window.showDirectoryPicker) {
      try { rootHandle = await window.showDirectoryPicker({ id: "web-keeper-root", mode: "readwrite", startIn: "downloads" }); }
      catch { rootHandle = null; }
      if (rootHandle) await dbPut("handles", { id: "default-root", handle: rootHandle });
    }
    if (!rootHandle) throw new Error(t("selectFolderFirst", null, "请先在设置里选择保存位置，或改回浏览器 Downloads。"));
  }
  await dbPut("handles", { id: jobId, handle: rootHandle });
}

async function liveCandidatePlaylistUrls(event) {
  if (event?.kind === "playlist" && event.url) return [event.url];
  const urls = [];
  if (event?.playlistUrl) urls.push(event.playlistUrl);
  const stored = await chrome.storage.local.get({ [CANDIDATES_KEY]: [] });
  for (const item of stored[CANDIDATES_KEY] || []) {
    if (item.product !== candidate.product) continue;
    urls.push(...[item.playlistUrl, ...(item.playlistUrls || [])].filter(Boolean));
  }
  return Array.from(new Set(urls.filter((item) => !String(item).startsWith("https://legacy.local/"))));
}

async function bindToDetectedVideo() {
  const stored = await chrome.storage.local.get({ [CANDIDATES_KEY]: [] });
  const now = Date.now();
  const options = (stored[CANDIDATES_KEY] || []).filter((item) => (item.playlistUrl || (item.playlistUrls || []).length)
    && now - Number(item.lastSeen || 0) < 30 * 60 * 1000);
  if (!options.length) {
    state.message = t("bindNoCandidates", null, "浏览器最近没有发现正在播放的视频。请确认扩展的「监听网页视频」已开启，然后播放目标视频几秒后再试。");
    await mirrorJob();
    return;
  }
  options.sort((a, b) => Number(b.lastSeen || 0) - Number(a.lastSeen || 0));
  let chosen = options[0];
  if (options.length > 1) {
    const lines = options.slice(0, 9).map((item, index) => `${index + 1}. ${item.pageTitle || item.product}（${item.resolution || "auto"}）`).join("\n");
    const typed = window.prompt(t("bindPickPrompt", lines, `检测到多个正在播放的视频，输入编号选择要接上的那个：\n${lines}`), "1");
    if (!typed) return;
    const pick = Math.min(options.length, Math.max(1, Math.round(Number(typed) || 1)));
    chosen = options[pick - 1];
  }
  const url = chosen.playlistUrl || (chosen.playlistUrls || [])[0];
  // The playlist-length gate inside the binder still rejects a wrong pick.
  await bindLegacyTaskToLivePlaylist({
    url, kind: "playlist", tabId: chosen.tabId, pageUrl: chosen.pageUrl,
    product: candidate.product, resolution: candidate.resolution, candidateId: candidate.id
  });
}

async function bindLegacyTaskToLivePlaylist(event) {
  if (!state || state.legacyBoundPlaylistUrl || state.source !== "legacy-import") return false;
  const liveCandidates = await liveCandidatePlaylistUrls(event);
  if (!liveCandidates.length) {
    log("已收到这个作品的媒体请求，但还没拿到网页的播放列表地址，继续等待");
    return false;
  }
  const previousTotal = Number(state.total || 0);
  const liveUrls = (candidate.playlistUrls || []).filter((item) => !String(item).startsWith("https://legacy.local/"));
  candidate.playlistUrls = Array.from(new Set([...liveUrls, ...liveCandidates]));
  candidate.playlistUrl = liveCandidates[liveCandidates.length - 1];
  candidate.pageUrl = event.pageUrl || candidate.pageUrl;
  if (Number(event.tabId) >= 0) candidate.tabId = Number(event.tabId);
  state.legacyBoundPlaylistUrl = candidate.playlistUrl;
  state.candidate = { ...candidate };
  try {
    const parsed = await loadMediaPlaylist();
    // Imported files are keyed by sequence, so a live playlist of a different length cannot be
    // trusted to line up with them; say so instead of quietly filling the wrong positions.
    const liveTotal = parsed.segments.filter((item) => !item.gap).length;
    if (previousTotal && liveTotal !== previousTotal) {
      state.legacyBoundPlaylistUrl = "";
      state.status = "error";
      state.errorCode = "LEGACY_PLAYLIST_MISMATCH";
      state.message = t("legacyPlaylistMismatch", [previousTotal, liveTotal], `网页上的播放列表有 ${liveTotal} 个分片，导入的旧目录按 ${previousTotal} 个编号，两者对不上，已停止自动接续以免把内容填错位置。`);
      log(state.message);
      await mirrorJob();
      return false;
    }
    state.mode = "browser-assisted";
    log(t("legacyBoundToPage", null, "已接上网页的真实播放列表，继续播放即可补齐缺口。"));
    // Starting capture properly matters: it clears the paused flag, replays queued requests
    // and injects the page hook. Only relabelling the status left the task doing nothing.
    await runCapture();
    state.message = t("legacyBoundToPage", null, "已接上网页的真实播放列表，继续播放即可补齐缺口。");
    await mirrorJob();
    return true;
  } catch (error) {
    state.legacyBoundPlaylistUrl = "";
    log(`接入网页播放列表失败：${error.message}`);
    await mirrorJob();
    return false;
  }
}

async function importLegacyVariant(variant, { onProgress, copyIntoStorage = false } = {}) {
  let product = safeName(variant.product, "imported");
  const resolution = safeName(variant.resolution, "auto");
  if (product === "imported" && /^\d{2,5}x\d{2,5}$/i.test(resolution)) {
    const typed = window.prompt(t("legacyAskProduct", null, "你选的是清晰度文件夹。请输入这个作品的名字（会用作文件名）："), "");
    if (typed && typed.trim()) product = safeName(typed.trim(), "imported");
  }
  const candidateId = `legacy:${product}:${resolution}`;
  const jobId = `job:${candidateId}:direct`;
  const existing = await dbGet("states", jobId);
  if (existing?.source === "legacy-import" && Number(existing.done || 0) > 0) {
    return { jobId, skipped: true, product, resolution, done: existing.done, total: existing.total };
  }

  let syntheticPlaylistUsed = false;
  const files = await readDirectoryFiles(variant.handle);
  const tsFiles = files.filter((item) => /\.ts$/i.test(item.name));
  if (!tsFiles.length) throw new Error(t("legacyNoSegments", variant.label, `目录 ${variant.label} 里没有找到 .ts 分片。`));

  let playlistFile = files.find((item) => /^(first|index|playlist|source)\.m3u8$/i.test(item.name)) || files.find((item) => /\.m3u8$/i.test(item.name));
  if (!playlistFile && variant.parentHandle) {
    // A task workspace keeps segments in <work>/segments/ with the playlist one level up.
    const parentFiles = await readDirectoryFiles(variant.parentHandle);
    playlistFile = parentFiles.find((item) => /^(first|index|playlist|source)\.m3u8$/i.test(item.name)) || parentFiles.find((item) => /\.m3u8$/i.test(item.name));
  }
  const keyFile = files.find((item) => /^file\.key$/i.test(item.name));
  const legacyKeyUrl = `https://legacy.local/aes-key/${encodeURIComponent(candidateId)}`;
  let playlistText = "";
  if (playlistFile) playlistText = await (await playlistFile.handle.getFile()).text();
  else {
    playlistText = buildSyntheticLegacyPlaylist(tsFiles.map((item) => item.name), 2.002, keyFile ? legacyKeyUrl : "").text;
    syntheticPlaylistUsed = true;
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

  if (!copyIntoStorage) {
    await dbPut("handles", { id: `legacy:${jobId}`, handle: variant.handle });
    legacySourceDirectory = variant.handle;
    state.legacySourceLabel = variant.label;
    state.legacyLinked = true;
  }
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
    } else if (copyIntoStorage) {
      const encrypted = await (await source.handle.getFile()).arrayBuffer();
      const decrypted = await decryptIfNeeded(segment, encrypted);
      if (!isValidSegmentSize(decrypted.byteLength)) {
        await maybeMarkSkippable(segment, { tinySize: decrypted.byteLength });
        continue;
      }
      const fileName = segmentFileName(segment);
      await writeFile(segmentDirectory, fileName, decrypted);
      await dbPut("segments", {
        id: `${jobId}:${segment.sequence}`,
        jobId,
        sequence: segment.sequence,
        fileName,
        size: decrypted.byteLength,
        url: segment.url,
        savedAt: Date.now(),
        source: "legacy-import"
      });
      imported += 1;
      bytes += decrypted.byteLength;
    } else {
      // Linked import: keep the bytes where they already are and only record where to find them.
      const size = (await source.handle.getFile()).size;
      if (!isValidSegmentSize(size)) {
        await maybeMarkSkippable(segment, { tinySize: size });
        continue;
      }
      await dbPut("segments", {
        id: `${jobId}:${segment.sequence}`,
        jobId,
        sequence: segment.sequence,
        fileName: source.name,
        size,
        url: segment.url,
        savedAt: Date.now(),
        source: LEGACY_LINK_SOURCE
      });
      imported += 1;
      bytes += size;
    }
    state.done = imported;
    state.bytes = bytes;
    if (Date.now() - lastImportMirrorAt >= 500 || index === importable.length - 1) {
      lastImportMirrorAt = Date.now();
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
  const syntheticNote = syntheticPlaylistUsed
    ? ` ${t("legacySyntheticNote", null, "该目录里没有播放列表文件，缺片信息只能按现有文件推断，可能漏掉真正缺失的分片。接上原网页后会用真实播放列表重新计算。")}`
    : "";
  const linkNote = copyIntoStorage ? "" : ` ${t("legacyLinkedNote", variant.label, `分片直接引用 ${variant.label}，没有复制副本；生成视频前请不要移动或删除该目录。`)}`;
  state.status = missing ? "paused" : "downloaded";
  state.message = missing
    ? t("legacyImportMissing", [imported, missing], `已导入 ${imported} 个分片，仍有 ${missing} 处缺口。打开原网页播放后可用网页辅助/智能补全继续；分片齐了再生成视频。`)
      + (skipped ? ` ${t("skippableSegmentsNote", skipped, `已确认 ${skipped} 个空壳/可跳过分片（前后时间轴连贯，不再重试）。`)}` : "") + linkNote
    : t("legacyImportReady", imported, `已导入 ${imported} 个分片，可直接检查并生成视频。字幕与播放加速/智能补全在绑定原网页后仍可使用。`)
      + (skipped ? ` ${t("skippableSegmentsNote", skipped, `已确认 ${skipped} 个空壳/可跳过分片（前后时间轴连贯，不再重试）。`)}` : "") + linkNote;
  const storedCandidates = await chrome.storage.local.get({ [CANDIDATES_KEY]: [] });
  const candidateList = Array.isArray(storedCandidates[CANDIDATES_KEY]) ? storedCandidates[CANDIDATES_KEY] : [];
  const candidateIndex = candidateList.findIndex((item) => item.id === candidateId);
  if (candidateIndex >= 0) candidateList[candidateIndex] = { ...candidateList[candidateIndex], ...candidate };
  else candidateList.unshift(candidate);
  await chrome.storage.local.set({ [CANDIDATES_KEY]: candidateList.slice(0, 100) });
  await mirrorJob();
  return { jobId, skipped: false, product, resolution, done: imported, total: state.total, missing };
}

async function legacyVariantSummary(variant) {
  let segments = 0;
  let bytes = 0;
  try {
    for await (const [name, handle] of variant.handle.entries()) {
      if (handle.kind !== "file" || !/\.ts$/i.test(name)) continue;
      segments += 1;
      bytes += (await handle.getFile()).size;
    }
  } catch { /* unreadable folder */ }
  return { ...variant, segments, bytes };
}

async function chooseLegacyVariants(variants) {
  $("taskView").hidden = true;
  $("listView").hidden = false;
  $("taskList").innerHTML = `<div class="muted">${escapeHtml(t("legacyScanning", null, "正在统计所选目录…"))}</div>`;
  const summaries = [];
  for (const variant of variants) summaries.push(await legacyVariantSummary(variant));
  const usable = summaries.filter((item) => item.segments > 0);
  if (!usable.length) throw new Error(t("legacyFolderUnrecognized", null, "没有识别到旧捕获目录。请选择 data\\captures、作品文件夹，或具体清晰度文件夹（内含 .ts）。"));
  if (usable.length === 1) {
    legacyCopyIntoStorage = false;
    return usable;
  }
  // Importing copies every segment into extension storage, so picking all qualities silently
  // would duplicate several GB and take a very long time. Make the choice explicit.
  const best = usable.reduce((top, item) => (item.segments > top.segments ? item : top), usable[0]);
  const rows = usable.map((item, index) => `<label class="task" style="display:flex;gap:10px;align-items:center"><input type="checkbox" data-legacy-index="${index}"${item === best ? " checked" : ""}><span><strong>${escapeHtml(item.label)}</strong><div class="muted">${escapeHtml(t("legacySegmentsAndSize", [item.segments, formatBytes(item.bytes)], `${item.segments} 个分片 · ${formatBytes(item.bytes)}`))}</div></span></label>`).join("");
  $("taskList").innerHTML = `<section class="work-card"><div class="work-head"><div><strong>${escapeHtml(t("legacyChooseVariants", null, "选择要导入的清晰度"))}</strong><div class="muted">${escapeHtml(t("legacyChooseVariantsHint", null, "导入会把分片复制进扩展存储，请只选你真正需要的那一档。"))}</div></div></div>${rows}<label class="task" style="display:flex;gap:10px;align-items:center"><input type="checkbox" id="legacyCopyIntoStorage"><span><strong>${escapeHtml(t("legacyCopyIntoStorage", null, "复制一份到扩展存储"))}</strong><div class="muted">${escapeHtml(t("legacyCopyIntoStorageHint", null, "默认直接引用原目录，不额外占空间，但原目录不能移动或删除。"))}</div></span></label><div class="actions"><button id="legacyImportStart" class="primary">${escapeHtml(t("legacyImportSelected", null, "导入选中的清晰度"))}</button><button id="legacyImportCancel">${escapeHtml(t("cancel", null, "取消"))}</button></div></section>`;
  return new Promise((resolve) => {
    $("taskList").addEventListener("click", function handler(event) {
      if (event.target.closest("#legacyImportCancel")) {
        $("taskList").removeEventListener("click", handler);
        resolve([]);
        return;
      }
      if (!event.target.closest("#legacyImportStart")) return;
      const picked = [...$("taskList").querySelectorAll("input[data-legacy-index]")]
        .filter((box) => box.checked)
        .map((box) => usable[Number(box.dataset.legacyIndex)]);
      if (!picked.length) return;
      legacyCopyIntoStorage = Boolean($("legacyCopyIntoStorage")?.checked);
      $("taskList").removeEventListener("click", handler);
      $("taskView").hidden = false;
      $("listView").hidden = true;
      $("notice").className = "notice";
      $("notice").textContent = t("legacyImportStarting", picked.length, `准备导入 ${picked.length} 个旧清晰度目录…`);
      $("status").textContent = t("legacyImportStatus", null, "正在导入旧捕获");
      resolve(picked);
    });
  });
}

async function importLegacyCapture() {
  if (!window.showDirectoryPicker) throw new Error(t("directoryPickerUnavailable", null, "当前浏览器不支持选择文件夹。"));
  const directory = await window.showDirectoryPicker({ id: "web-keeper-legacy-import", mode: "read" });
  const variants = await collectLegacyVariants(directory);
  if (!variants.length) throw new Error(t("legacyFolderUnrecognized", null, "没有识别到旧捕获目录。请选择 data\\\\captures、作品文件夹，或具体清晰度文件夹（内含 .ts）。"));
  const chosen = await chooseLegacyVariants(variants);
  if (!chosen.length) return showTaskList();
  const results = [];
  for (const variant of chosen) {
    results.push(await importLegacyVariant(variant, { copyIntoStorage: legacyCopyIntoStorage }));
  }
  const first = results.find((item) => !item.skipped) || results[0];
  if (first?.jobId) location.href = `download.html?job=${encodeURIComponent(first.jobId)}`;
  else await showTaskList();
}

async function dismissCandidates(candidateIds, { bulk = false } = {}) {
  if (!candidateIds.length) return;
  if (bulk && !confirm(t("dismissAllCandidatesConfirm", candidateIds.length, `清除 ${candidateIds.length} 条未开始的发现记录？已创建的下载、已保存文件和断点都不会受影响。`))) return;
  try {
    const response = await chrome.runtime.sendMessage({ type: "remove-candidates", candidateIds });
    if (!response?.ok) throw new Error(response?.error || t("candidateGone", null, "没有找到这个视频，请重新播放后再试。"));
    await showTaskList();
  } catch (error) {
    $("taskList").insertAdjacentHTML("afterbegin", `<div class="notice bad">${escapeHtml(error.message)}</div>`);
  }
}

async function showTaskList() {
  $("taskView").hidden = true;
  $("listView").hidden = false;
  $("diagnosticsPanel").hidden = !showDiagnostics;
  const stored = await chrome.storage.local.get({ [JOBS_KEY]: [], [CANDIDATES_KEY]: [] });
  const jobs = stored[JOBS_KEY] || [];
  const candidates = stored[CANDIDATES_KEY] || [];
  const liveJobIds = new Set();
  for (const job of jobs) {
    try { if (await dbGet("states", job.id)) liveJobIds.add(job.id); } catch { /* treat as lost */ }
  }
  const importBar = `<div class="actions" style="margin:12px 0 4px"><button id="importLegacy" class="primary">${escapeHtml(t("importLegacyCapture", null, "导入旧捕获目录"))}</button><span class="muted">${escapeHtml(t("importLegacyCaptureHint", null, "选择 data\\\\captures、作品夹或清晰度文件夹，继续补洞/生成视频。"))}</span></div>`;
  const jobCandidateIds = new Set(jobs.map((item) => item.candidateId).filter(Boolean));
  const clearableIds = candidates.filter((item) => !jobCandidateIds.has(item.id)).map((item) => item.id);
  const clearBar = clearableIds.length
    ? `<div class="actions" style="margin:0 0 10px"><button class="danger" data-dismiss-candidates="${encodeURIComponent(clearableIds.join(","))}" data-bulk="1">${escapeHtml(t("dismissAllCandidates", clearableIds.length, `清除全部未开始的发现（${clearableIds.length}）`))}</button><span class="muted">${escapeHtml(t("dismissCandidateHint", null, "只清掉发现记录，不影响已创建的下载、已保存文件和断点。"))}</span></div>`
    : "";
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
      if (!groups.has(key)) groups.set(key, { key, title: item.pageTitle || item.product, product: item.product, candidates: [], jobs: [] });
      groups.get(key).candidates.push(item);
    }
    for (const job of jobs) {
      const key = keyFor(job);
      if (!groups.has(key)) groups.set(key, { key, title: job.title || job.product, product: job.product, candidates: [], jobs: [] });
      groups.get(key).jobs.push(job);
    }
    $("taskList").innerHTML = importBar + clearBar + [...groups.values()].map((work) => {
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
        const lost = !liveJobIds.has(job.id);
        const detail = lost
          ? `<div class="muted">${escapeHtml(t("taskEntryLost", null, "详细记录已丢失，无法继续。私密窗口中的任务数据只存在内存里。"))}</div>`
          : `<div class="muted">${escapeHtml(statusLabel(job.status))} · ${escapeHtml(progress)} · ${escapeHtml(formatBytes(job.bytes))}${job.outputName ? ` · ${escapeHtml(job.outputName)}` : ""}</div>`;
        const open = lost ? "" : `<a class="button" href="?job=${encodeURIComponent(job.id)}">${escapeHtml(t("openTask", null, "查看下载"))}</a>`;
        return `<div class="task${lost ? " lost" : ""}"><div><strong>${escapeHtml(job.resolution || t("automaticQuality", null, "自动清晰度"))}</strong>${detail}</div><div class="actions">${open}<button class="danger" data-remove-job="${encodeURIComponent(job.id)}">${escapeHtml(t("removeTask", null, "从列表移除"))}</button></div></div>`;
      }).join("");
      const dismissIds = work.jobs.length ? [] : work.candidates.map((item) => item.id);
      // The centre used to hard-wire one candidate, so a work with four renditions could only be
      // started at whichever one happened to be first.
      const choosable = [...work.candidates].sort((a, b) => qualityHeight(b.resolution) - qualityHeight(a.resolution));
      const picker = choosable.length > 1
        ? `<select data-quality-for="${escapeHtml(work.key)}">${choosable.map((item) => `<option value="${escapeHtml(item.id)}"${item.id === choosable[0].id ? " selected" : ""}>${escapeHtml(item.resolution || t("automaticQuality", null, "自动清晰度"))}</option>`).join("")}</select>`
        : "";
      // Subtitles are a separate deliverable: needing a full video download first was absurd.
      const subtitleAction = candidate
        ? `<button data-subtitles-for="${escapeHtml(work.key)}" data-new-candidate="${encodeURIComponent(candidate.id)}">${escapeHtml(t("saveSubtitlesOnly", null, "只保存字幕"))}</button>`
        : "";
      const newActions = candidate ? `<div class="actions">${picker}${latestJob ? "" : `<button class="primary" data-new-candidate="${encodeURIComponent(candidate.id)}" data-quality-from="${escapeHtml(work.key)}" data-mode="direct">${escapeHtml(t("directDownload", null, "直接下载（推荐）"))}</button><button data-new-candidate="${encodeURIComponent(candidate.id)}" data-quality-from="${escapeHtml(work.key)}" data-mode="browser-assisted">${escapeHtml(t("browserAssisted", null, "网页辅助保存"))}</button>`}${subtitleAction}${dismissIds.length ? `<button class="danger" data-dismiss-candidates="${encodeURIComponent(dismissIds.join(","))}">${escapeHtml(t("dismissCandidate", null, "移除这个发现"))}</button>` : ""}</div>` : "";
      return `<section class="work-card"><div class="work-head"><div><strong>${escapeHtml(safeName(work.title || work.product || t("downloadTask", null, "视频下载")))}</strong><div class="muted">${escapeHtml(status)}</div></div></div><div class="chips">${chips.map((item) => `<span class="chip">${escapeHtml(item)}</span>`).join("")}</div>${taskRows || `<div class="muted">${escapeHtml(t("noTaskForVideo", null, "这个视频还没有创建下载。"))}</div>`}${newActions}</section>`;
    }).join("");
  }
  log("任务列表已加载");
}

function inPrivateWindow() {
  try { return Boolean(chrome.extension?.inIncognitoContext); } catch { return false; }
}

async function initialize() {
  await openDatabase();
  const uiSettings = await chrome.storage.local.get({ showDiagnostics: false, autoFinalize: true, cleanupAfterMerge: true, directConcurrency: 4, captureConcurrency: 6, pageBufferWaitSec: 2.5, subtitleConvertMode: "none", subtitleFormat: "source", saveDestination: "browser-downloads" });
  showDiagnostics = Boolean(uiSettings.showDiagnostics);
  autoFinalize = uiSettings.autoFinalize !== false;
  cleanupAfterMerge = uiSettings.cleanupAfterMerge !== false;
  directConcurrency = [2, 4, 6].includes(Number(uiSettings.directConcurrency)) ? Number(uiSettings.directConcurrency) : 4;
  subtitleConvertMode = WebKeeperMediaEngine.SUBTITLE_MODES.includes(uiSettings.subtitleConvertMode) ? uiSettings.subtitleConvertMode : "none";
  subtitleFormat = ["source", "vtt", "srt"].includes(uiSettings.subtitleFormat) ? uiSettings.subtitleFormat : "source";
  captureConcurrency = [1, 2, 4, 6, 8].includes(Number(uiSettings.captureConcurrency)) ? Number(uiSettings.captureConcurrency) : 6;
  const wantedWait = [0, 1, 2.5, 6].includes(Number(uiSettings.pageBufferWaitSec)) ? Number(uiSettings.pageBufferWaitSec) : 2.5;
  pageBufferProvenWaitMs = Math.round(wantedWait * 1000);
  pageBufferWaitMs = pageBufferProvenWaitMs ? Math.max(pageBufferProvenWaitMs, PAGE_BUFFER_WAIT_COLD_MS) : 0;
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
  if (!candidate && requestedJobId) {
    // The task record is gone. In a private window all extension storage is memory-only and
    // is discarded when the last such window closes, which looks exactly like this.
    const jobsStored = await chrome.storage.local.get({ [JOBS_KEY]: [] });
    const summary = (jobsStored[JOBS_KEY] || []).find((item) => item.id === requestedJobId);
    throw new Error(inPrivateWindow()
      ? t("taskLostPrivate", null, "这个任务的记录已经不存在了。当前是 InPrivate/无痕窗口，扩展在这种窗口里的数据只保存在内存中，窗口全部关闭后就会丢失。请在普通窗口里重新导入并下载。")
      : summary
        ? t("taskRecordLost", summary.title || summary.product || "", `任务「${summary.title || summary.product || ""}」的详细记录已丢失，只剩列表条目。请重新导入该作品目录；已在磁盘上的分片不会重复下载。`)
        : t("taskNotFound", null, "找不到这个视频。请回到网页重新播放几秒，再从扩展打开。"));
  }
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
      message: mode === "subtitles"
        ? t("subtitlesOnlyReady", null, "只保存字幕：不会下载视频内容。")
        : mode === "direct" ? t("directReadyMessage", null, "准备开始直接下载。") : t("assistedReadyMessage", null, "准备好后，请返回网页继续播放。")
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
  if (state.mode === "subtitles") {
    // No playlist, no segments, no merge: this task exists only to fetch the subtitle tracks.
    state.status = "downloaded";
    state.total = 0;
    state.done = 0;
    await mirrorJob();
    if (shouldAutoStart && storedHandleReady) await saveSubtitles();
    return;
  }
  if (shouldAutoStart && storedHandleReady && state.status === "ready") await (state.mode === "direct" ? runDirect() : runCapture());
}

const ACTION_HANDLERS = {

  choose: () => chooseDirectoryAndStart(),

  resume: () => resumeTask(),

  pause: () => pauseTask(),

  backToVideo: () => openVideoTab(),

  switchAssisted: () => switchToAssisted(),

  switchFolder: () => switchTaskToFolder().catch((error) => { state.message = error.message; return mirrorJob(); }),

  bindPage: () => bindToDetectedVideo().catch((error) => { state.message = error.message; return mirrorJob(); }),

  fillDirect: () => fillGapsDirectly(),

  smartFill: () => smartFillMissing(),

  verifySegments: () => verifyAllSegments(),

  merge: () => finalizeDownloadedTask(),

  mergeExternal: () => retryMergeToExternalLocation(),

  openOutput: () => openGeneratedVideo(),

  subtitles: () => saveSubtitles(),

  extractSubtitles: () => extractSubtitlesDirectly(),

  subtitleDiagnostics: () => dumpSubtitleDiagnostics(),

  sweepSubtitles: () => {

    if (subtitleSweepRunning) { subtitleSweepRunning = false; return Promise.resolve(); }

    return sweepPlayerForSubtitles().then((result) => (result.added ? saveSubtitles() : null));

  },

  deleteSegments: () => deleteTaskSegments(),

  deleteOutput: () => deleteOutput(),

  removeTask: () => removeTask()

};



$("actionBar").addEventListener("click", (event) => {

  if (event.target.closest("[data-overflow-toggle]")) {

    overflowOpen = !overflowOpen;

    renderActions();

    return;

  }

  const button = event.target.closest("button[data-action]");

  if (!button || button.disabled) return;

  const run = ACTION_HANDLERS[button.dataset.action];

  if (!run) return;

  overflowOpen = false;

  void Promise.resolve(run()).catch((error) => {

    state.message = error.message;

    void mirrorJob();

  });

});



// Clicking anywhere else closes the overflow menu, the way a menu is expected to behave.

document.addEventListener("click", (event) => {

  if (!overflowOpen || event.target.closest("#actionBar")) return;

  overflowOpen = false;

  renderActions();

});



$("captureSpeed").addEventListener("change", (event) => void changeCaptureSpeed(event.target.value));

$("seekBoostInterval").addEventListener("change", () => void applySeekBoostSettingsFromInputs());

$("seekBoostStep").addEventListener("change", () => void applySeekBoostSettingsFromInputs());

$("seekBoostInterval").addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); void applySeekBoostSettingsFromInputs(); } });

$("seekBoostStep").addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); void applySeekBoostSettingsFromInputs(); } });

$("missingRanges").addEventListener("click", (event) => {

  if (event.target.closest("#missingPageInput")) return;
  const pageButton = event.target.closest("button[data-missing-page]");
  if (pageButton) {
    missingPage = pageButton.dataset.missingPage === "next" ? Math.min(missingPageCount() - 1, missingPage + 1) : Math.max(0, missingPage - 1);
    render();
    return;
  }
  const sortButton = event.target.closest("button[data-missing-sort]");
  if (sortButton) { missingSort = sortButton.dataset.missingSort; missingPage = 0; refreshMissingSnapshot(); render(); return; }
  if (event.target.closest("button[data-missing-copy]")) void copyMissingList();
});
$("missingRanges").addEventListener("change", (event) => {
  const input = event.target.closest("#missingPageInput");
  if (!input) return;
  const wanted = Math.round(Number(input.value) || 1);
  missingPage = Math.max(0, Math.min(missingPageCount() - 1, wanted - 1));
  render();
});
$("coverage").addEventListener("mousemove", (event) => {
  const box = $("coverage").getBoundingClientRect();
  if (!box.width) return;
  $("coverage").title = coverageInfoAt((event.clientX - box.left) / box.width);
});
$("captureSpeed").addEventListener("change", (event) => void changeCaptureSpeed(event.target.value));
$("seekBoostInterval").addEventListener("change", () => void applySeekBoostSettingsFromInputs());
$("seekBoostStep").addEventListener("change", () => void applySeekBoostSettingsFromInputs());
$("seekBoostInterval").addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); void applySeekBoostSettingsFromInputs(); } });
$("seekBoostStep").addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); void applySeekBoostSettingsFromInputs(); } });
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
  const dismissButton = event.target.closest("button[data-dismiss-candidates]");
  if (dismissButton) {
    void dismissCandidates(decodeURIComponent(dismissButton.dataset.dismissCandidates).split(",").filter(Boolean), { bulk: dismissButton.dataset.bulk === "1" });
    return;
  }
  const button = event.target.closest("button[data-remove-job]");
  if (button) void removeTask(decodeURIComponent(button.dataset.removeJob));
  const createButton = event.target.closest("button[data-new-candidate]");
  if (createButton) {
    const picked = createButton.dataset.qualityFrom || createButton.dataset.subtitlesFor;
    const select = picked ? document.querySelector(`select[data-quality-for="${CSS.escape(picked)}"]`) : null;
    const candidateId = select?.value || decodeURIComponent(createButton.dataset.newCandidate);
    // Saving subtitles never touches the media, so it does not claim the work's download decision.
    if (createButton.dataset.subtitlesFor != null) {
      location.href = `download.html?candidate=${encodeURIComponent(candidateId)}&mode=subtitles`;
      return;
    }
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
  $("actionBar").innerHTML = "";
  log(error.stack || error.message);
});
