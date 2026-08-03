const CANDIDATES_KEY = "wkCandidates";
const JOBS_KEY = "wkJobs";
const MEDIA_EVENTS_KEY = "wkMediaEvents";
const DB_NAME = "web-keeper-downloads";
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
let playlistByPath = new Map();
let playlistByUrl = new Map();
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
  try {
    const url = new URL(value);
    url.hash = "";
    return url.href;
  } catch { return String(value || ""); }
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

async function mirrorJob() {
  updateTransferSpeed();
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
  $("subtitle").textContent = `${state.resolution || t("automaticQuality", null, "自动清晰度")} · ${state.mode === "direct" ? t("downloadMethodDirect", null, "直接下载") : t("downloadMethodAssisted", null, "网页辅助")}`;
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
  $("missing").textContent = byteProgress ? (state.status === "complete" ? "0" : "1") : total ? String(Math.max(total - done, 0)) : "—";
  $("bytes").textContent = formatBytes(state.bytes);
  $("speed").textContent = ["downloading", "capturing"].includes(state.status) ? `${Number(state.speedMbps || 0).toFixed(2)} MB/s` : "—";
  $("notice").textContent = state.message || t("chooseFolderShort", null, "请选择保存位置。");
  $("notice").className = `notice ${state.status === "error" ? "bad" : ""}`;
  const hasHandle = Boolean(rootHandle);
  $("choose").hidden = saveDestination === "browser-downloads" || hasHandle || ["downloading", "capturing", "merging", "exporting"].includes(state.status);
  $("choose").textContent = state.done ? t("chooseFolderAndContinue", null, "重新选择位置并继续") : t("chooseFolderAndStart", null, "选择位置并开始");
  $("resume").hidden = !hasHandle || !["paused", "error", "ready", "waiting"].includes(state.status);
  $("pause").hidden = !["downloading", "capturing", "waiting"].includes(state.status);
  $("backToVideo").hidden = state.mode !== "browser-assisted" || !["capturing", "waiting", "paused"].includes(state.status);
  $("switchAssisted").hidden = state.mode !== "direct" || !["error", "waiting"].includes(state.status) || !["AUTH_REQUIRED", "URL_EXPIRED", "PLAYLIST_STALLED", "NETWORK_ERROR", "SEPARATE_TRACKS"].includes(state.errorCode || "");
  const ranges = state.missingRanges || [];
  $("missingPanel").hidden = !ranges.length;
  $("missingRanges").innerHTML = ranges.slice(0, 12).map((range) => `<div class="range"><span>${escapeHtml(formatTime(range.startSeconds))} – ${escapeHtml(formatTime(range.endSeconds))}</span><span class="muted">${escapeHtml(t("missingItemsCount", range.count, `${range.count} 项`))}</span></div>`).join("")
    + (ranges.length > 12 ? `<div class="muted">${escapeHtml(t("moreMissingRanges", ranges.length - 12, `另有 ${ranges.length - 12} 处`))}</div>` : "");
  $("smartFill").hidden = state.mode !== "browser-assisted" || !ranges.length || !["capturing", "waiting", "paused"].includes(state.status);
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

async function fetchResponse(url, { byteRange = "", attempts = 3, headers = {} } = {}) {
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
        cache: "no-store",
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

async function loadMediaPlaylist() {
  const urls = Array.from(new Set([...(candidate.playlistUrls || []), candidate.playlistUrl].filter(Boolean)));
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
  mediaPlaylist = parsed;
  playlistByUrl = new Map(parsed.segments.map((item) => [normalizedMediaUrl(item.url), item]));
  playlistByPath = new Map();
  for (const item of parsed.segments) {
    const path = new URL(item.url).pathname;
    playlistByPath.set(path, playlistByPath.has(path) ? null : item);
  }
  state.total = parsed.segments.filter((item) => !item.gap).length;
  state.duration = parsed.duration || state.duration || 0;
  state.isLive = parsed.isLive;
  state.wasLive = Boolean(state.wasLive || parsed.isLive);
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
async function decryptIfNeeded(segment, bytes) {
  if (!segment.key || segment.key.method === "NONE") return bytes;
  if (segment.key.method !== "AES-128") throw new Error(t("unsupportedEncryption", segment.key.method, `暂不支持这种视频加密方式：${segment.key.method}`));
  let cryptoKey = keyCache.get(segment.key.url);
  if (!cryptoKey) {
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

async function savedSegment(sequence) {
  const record = await dbGet("segments", `${state.id}:${sequence}`);
  if (!record || !segmentDirectory) return null;
  try {
    const handle = await segmentDirectory.getFileHandle(record.fileName);
    const file = await handle.getFile();
    return file.size > 0 ? { ...record, size: file.size } : null;
  } catch {
    return null;
  }
}

async function saveSegment(segment, observedHeaders = {}) {
  const existing = await savedSegment(segment.sequence);
  if (existing) return existing;
  const response = await fetchResponse(segment.url, { byteRange: segment.byteRange, headers: observedHeaders });
  const encrypted = await consumeResponse(response, "arrayBuffer");
  if (encrypted.byteLength < 16) throw new Error(t("downloadedItemInvalid", segment.sequence, `下载到的第 ${segment.sequence} 项内容异常。`));
  const decrypted = await decryptIfNeeded(segment, encrypted);
  const fileName = segmentFileName(segment);
  await writeFile(segmentDirectory, fileName, decrypted);
  const record = { id: `${state.id}:${segment.sequence}`, jobId: state.id, sequence: segment.sequence, fileName, size: decrypted.byteLength, url: segment.url, savedAt: Date.now() };
  await dbPut("segments", record);
  state.done = Number(state.done || 0) + 1;
  state.bytes = Number(state.bytes || 0) + decrypted.byteLength;
  await updateMissingTimeline();
  await mirrorJob();
  return record;
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
  let count = 0;
  let bytes = 0;
  for (const record of records) {
    try {
      const handle = await segmentDirectory.getFileHandle(record.fileName);
      const file = await handle.getFile();
      if (file.size > 0) { count += 1; bytes += file.size; }
    } catch { /* ledger entry without file */ }
  }
  state.done = count;
  state.bytes = bytes;
  await updateMissingTimeline();
  await mirrorJob();
}

async function updateMissingTimeline() {
  if (!mediaPlaylist) return [];
  const records = (await listSegmentRecords(state.id)).filter((item) => item.kind !== "dash");
  state.missingRanges = WebKeeperMediaEngine.missingTimeline(mediaPlaylist.segments, new Set(records.map((item) => item.sequence)));
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
  state.status = "downloading";
  state.message = t("directDownloadWorking", null, "正在获取视频内容并保存未完成的部分。可以把此页面留在后台，但请不要关闭浏览器。");
  await mirrorJob();
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
        state.message = t("directStalled", null, "直接下载暂时没有新内容。你可以稍后继续，或确认改用网页辅助。");
        await mirrorJob();
        return;
      }
      state.message = t("liveWaiting", null, "正在等待网站发布后续内容，已经保存的部分不会丢失。");
      await mirrorJob();
      await waitFor(Math.max(1500, Math.min(8000, Number(playlist.targetDuration || 4) * 750)));
    }
    if (paused) return;
    state.errorCode = "";
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

async function saveDashInitialization(directory, track) {
  if (!track.initializationUrl) throw new Error(t("dashInitMissing", null, "这个视频没有提供可用的轨道初始化信息。"));
  const handle = await directory.getFileHandle("init.mp4", { create: true });
  const existing = await handle.getFile();
  if (existing.size > 0 && !track.initializationKey) return existing.size;
  const response = await fetchResponse(track.initializationUrl, { byteRange: track.initializationByteRange || "" });
  let bytes = await consumeResponse(response, "arrayBuffer");
  if (!bytes.byteLength) throw new Error(t("downloadedItemInvalid", 0, "下载到的媒体初始化内容异常。"));
  if (track.initializationKey) {
    if (!track.initializationKey.iv) throw new Error(t("hlsMapIvRequired"));
    bytes = await decryptIfNeeded({ key: track.initializationKey, sequence: 0 }, bytes);
  }
  await writeFile(directory, "init.mp4", bytes);
  return bytes.byteLength;
}

async function saveDashSegment(directory, track, segment, index) {
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
  const response = await fetchResponse(segment.url, { byteRange: segment.byteRange || "" });
  let bytes = await consumeResponse(response, "arrayBuffer");
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
  try {
    const text = await fetchText(manifestUrl);
    const manifest = WebKeeperMediaEngine.parseDashManifest(text, manifestUrl);
    if (manifest.drm) throw new Error(t("drmUnsupported", null, "这个视频受 DRM 保护，Web Keeper 不会尝试绕过网站的访问控制。"));
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

function sequenceFromUrl(url) {
  try {
    const name = new URL(url).pathname.split("/").pop() || "";
    const match = name.match(/(?:^|[_-])(\d{1,10})(?:\.[a-z0-9]+)?$/i) || name.match(/(\d{1,10})/);
    return match ? Number(match[1]) : null;
  } catch { return null; }
}

async function refreshCapturePlaylist() {
  try {
    await loadMediaPlaylist();
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

async function runCapture() {
  paused = false;
  state.providerId = "browser-assisted";
  state.progressUnit = "items";
  await ensureDirectories();
  await reconcileSaved();
  state.status = "waiting";
  state.message = t("assistedPreparing", null, "正在准备网页辅助保存。");
  await mirrorJob();
  const queued = await queuedCaptureEvents();
  const queuedPlaylists = queued.filter((event) => event.kind === "playlist").map((event) => event.url);
  candidate.playlistUrls = Array.from(new Set([...(candidate.playlistUrls || []), ...queuedPlaylists]));
  await refreshCapturePlaylist();
  if (state.status === "capturing") await replayQueuedCaptureEvents(queued);
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
}

function matchesCandidate(event) {
  if (event?.candidateId && candidate?.id) return event.candidateId === candidate.id;
  return state && event && Number(event.tabId) === Number(candidate.tabId) && event.product === candidate.product && (candidate.resolution === "auto" || event.resolution === candidate.resolution || event.resolution === "auto");
}

async function captureObservedSegment(event) {
  if (paused || !["capturing", "waiting"].includes(state.status)) return;
  if (event.kind === "playlist") {
    candidate.playlistUrl = event.url;
    await refreshCapturePlaylist();
    return;
  }
  if (event.kind !== "segment") return;
  if (!segmentDirectory) return;
  let sequence = sequenceFromUrl(event.url);
  let meta = playlistByUrl.get(normalizedMediaUrl(event.url)) || playlistByPath.get(new URL(event.url).pathname);
  if (!meta && sequence != null && mediaPlaylist) meta = mediaPlaylist.segments.find((item) => item.sequence === sequence);
  if (!meta) {
    log(`暂无法定位分片：${event.url}`);
    return;
  }
  sequence = meta.sequence;
  try {
    const existing = await savedSegment(sequence);
    if (existing) return;
    log(`播放器已请求分片 ${sequence}，开始保存`);
    await saveSegment({ ...meta, url: event.url }, event.headers || {});
    state.status = "capturing";
    state.message = t("assistedSaving", null, "正在跟随网页播放保存；已经完成的内容会保留，可随时暂停。");
    await mirrorJob();
    if (state.total && state.done >= state.total && autoFinalize) await mergeOutput(false);
  } catch (error) {
    state.failed = Number(state.failed || 0) + 1;
    state.message = t("assistedItemFailed", error.message, `有一部分暂时未能保存：${error.message}。再次播放到这里时会重试。`);
    log(state.message);
    await mirrorJob();
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "media-observed" || !matchesCandidate(message.event)) return;
  const event = message.event;
  candidate.headers = { ...(candidate.headers || {}), ...(event.headers || {}) };
  if (event.kind === "playlist") candidate.playlistUrl = event.url;
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
  const records = await listSegmentRecords(state.id);
  const bySequence = new Map(records.map((item) => [item.sequence, item]));
  const playlistExpected = mediaPlaylist.segments.filter((item) => !item.gap).map((item) => item.sequence);
  const expected = state.wasLive
    ? Array.from(new Set([...records.map((item) => item.sequence), ...playlistExpected])).sort((a, b) => a - b)
    : playlistExpected;
  const missing = expected.filter((sequence) => !bySequence.has(sequence));
  if (missing.length && !allowPartial) throw new Error(t("remainingCount", missing.length, `仍有 ${missing.length} 项待补。`));
  if (missing.length && !confirm(t("createPartialConfirm", missing.length, `仍有 ${missing.length} 项待补。要先按现有内容生成一个不完整视频吗？`))) return;
  paused = false;
  state.status = "merging";
  state.message = missing.length ? t("creatingPartial", missing.length, `正在按现有内容生成视频，将跳过 ${missing.length} 处缺口。`) : t("creatingPlayableVideo", null, "正在生成可播放视频。");
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
    state.message = missing.length ? t("outputPartial", [outputName, missing.length], `已生成 ${outputName}，但仍有 ${missing.length} 处缺口。`) : t("outputComplete", outputName, `已生成 ${outputName}。确认播放正常后，可以清理临时下载文件。`);
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
  for (const controller of activeControllers) controller.abort();
  activeControllers.clear();
  activeController = null;
  state.status = "paused";
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
  const results = await chrome.scripting.executeScript({
    target: { tabId },
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
  return results?.[0]?.result || { ok: false, reason: "NO_RESULT" };
}

async function smartFillMissing() {
  if (smartFillRunning) return;
  if (!confirm(t("smartFillConfirm", null, "开始智能补全？Web Keeper 会在原网页中跳到缺失位置；加载跟不上时会自动减速或停止。"))) return;
  if (state.status === "paused") await runCapture();
  await updateMissingTimeline();
  smartFillRunning = true;
  paused = false;
  state.message = t("smartFillWorking", null, "正在按缺失位置辅助播放；播放器加载慢时会等待。");
  await mirrorJob();
  try {
    const ranges = [...(state.missingRanges || [])];
    for (const range of ranges) {
      let cursor = Math.max(0, Number(range.startSeconds || 0) - 2);
      let step = 8;
      let noProgress = 0;
      while (smartFillRunning && !paused && cursor < Number(range.endSeconds || cursor + 1) + 1) {
        const before = Number(state.done || 0);
        const player = await seekVideoAndInspect(Number(candidate.tabId), cursor);
        if (!player.ok) throw new Error(t("videoElementNotFound", null, "原网页中没有找到可控制的视频播放器，请手动播放到提示位置。"));
        const loaded = player.readyState >= 2 && (!player.bufferedEnd || player.bufferedEnd >= player.currentTime + 0.5);
        await waitFor(loaded ? 1400 : 3200);
        if (Number(state.done || 0) > before) {
          noProgress = 0;
          step = Math.min(10, step + 1);
        } else {
          noProgress += 1;
          step = Math.max(2, Math.floor(step / 2));
        }
        if (noProgress >= 5) throw new Error(t("smartFillNoProgress", formatTime(cursor), `在 ${formatTime(cursor)} 附近没有取得新内容，已停止自动跳转。请手动播放这里后继续。`));
        cursor += step;
      }
    }
    await updateMissingTimeline();
    state.message = state.missing
      ? t("smartFillStillMissing", state.missing, `自动补全结束，仍有 ${state.missing} 项需要手动播放。`)
      : t("smartFillComplete", null, "缺失位置已经补全，正在检查视频。");
    await mirrorJob();
    if (!state.missing && autoFinalize) await mergeOutput(false);
  } catch (error) {
    state.status = "waiting";
    state.message = error.message;
    await mirrorJob();
  } finally {
    smartFillRunning = false;
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
  if (state.providerId === "hls" && !state.separateTracks) return mergeOutput(true);
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

async function showTaskList() {
  $("taskView").hidden = true;
  $("listView").hidden = false;
  $("diagnosticsPanel").hidden = !showDiagnostics;
  const stored = await chrome.storage.local.get({ [JOBS_KEY]: [], [CANDIDATES_KEY]: [] });
  const jobs = stored[JOBS_KEY] || [];
  const candidates = stored[CANDIDATES_KEY] || [];
  if (!jobs.length && !candidates.length) {
    $("taskList").innerHTML = `<div class="muted">${t("noDownloadTasks", null, "还没有下载。打开监听并播放视频后，从扩展创建任务。")}</div>`;
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
    $("taskList").innerHTML = [...groups.values()].map((work) => {
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
$("merge").addEventListener("click", () => void finalizeDownloadedTask());
$("openOutput").addEventListener("click", () => void openGeneratedVideo());
$("subtitles").addEventListener("click", () => void saveSubtitles());
$("deleteSegments").addEventListener("click", () => void deleteTaskSegments());
$("deleteOutput").addEventListener("click", () => void deleteOutput());
$("removeTask").addEventListener("click", () => void removeTask());
$("taskList").addEventListener("click", (event) => {
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
