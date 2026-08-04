const SCRIPT_VERSION = "web-keeper-extension-0.4.6";
const CANDIDATES_KEY = "wkCandidates";
const JOBS_KEY = "wkJobs";
const MEDIA_EVENTS_KEY = "wkMediaEvents";
const API_ACTIVITY_KEY = "wkApiActivity";
const MAX_CANDIDATES = 120;
const MAX_PENDING_REQUESTS = 500;
const MAX_MEDIA_EVENTS = 600;
const MEDIA_EVENT_TTL_MS = 30 * 60 * 1000;
let candidateWriteChain = Promise.resolve();
const pendingMediaHeaders = new Map();
const recentStreamTabs = new Map();
const expandedPlaylists = new Set();
const apiActivity = new Map();
let apiActivityFlushedAt = 0;

// Records which endpoints a page talks to, without their bodies. Enough to spot "the subtitle
// really comes from this other method", not enough to leak a session.
function noteApiActivity(details, responseHeaders) {
  try {
    const url = new URL(details.url);
    if (!/\/(?:gapi|api|rpc)\//i.test(url.pathname)) return;
    const key = `${details.tabId}|${details.method} ${url.pathname}`;
    const entry = apiActivity.get(key) || { tabId: details.tabId, label: `${details.method} ${url.pathname}`, count: 0 };
    entry.count += 1;
    entry.contentType = responseHeaders?.["content-type"] || entry.contentType || "";
    entry.bytes = Number(responseHeaders?.["content-length"] || 0) || entry.bytes || 0;
    entry.lastSeen = Date.now();
    apiActivity.set(key, entry);
    while (apiActivity.size > 200) apiActivity.delete(apiActivity.keys().next().value);
    if (Date.now() - apiActivityFlushedAt < 2000) return;
    apiActivityFlushedAt = Date.now();
    void chrome.storage.local.set({ [API_ACTIVITY_KEY]: [...apiActivity.values()].slice(-200) });
  } catch { /* not a URL we can classify */ }
}

// The quality list is built from URLs the browser actually requested, so a rendition the player
// never switched to simply does not exist as far as the popup is concerned — a player offering
// 1080p/720p/404p shows up as "1 quality". The master playlist lists them all, so read it.
function masterPlaylistVariants(text, baseUrl) {
  const lines = String(text || "").split(/\r?\n/);
  const variants = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^#EXT-X-STREAM-INF:/i.test(lines[index])) continue;
    const attributes = lines[index];
    const resolution = /RESOLUTION=(\d+x\d+)/i.exec(attributes)?.[1] || "";
    const bandwidth = Number(/BANDWIDTH=(\d+)/i.exec(attributes)?.[1] || 0);
    let uri = "";
    for (let next = index + 1; next < lines.length; next += 1) {
      const line = lines[next].trim();
      if (!line) continue;
      if (line.startsWith("#")) break;
      uri = line;
      break;
    }
    if (!uri) continue;
    try { variants.push({ url: new URL(uri, baseUrl).href, resolution: resolution || "auto", bandwidth }); }
    catch { /* unresolvable variant */ }
  }
  return variants;
}

async function expandMasterPlaylist(observed, context) {
  if (expandedPlaylists.has(observed.url)) return;
  expandedPlaylists.add(observed.url);
  while (expandedPlaylists.size > 80) expandedPlaylists.delete(expandedPlaylists.values().next().value);
  let body = "";
  try {
    const response = await fetch(observed.url, { credentials: "include", cache: "no-store" });
    if (!response.ok) return;
    body = await response.text();
  } catch { return; }
  const variants = masterPlaylistVariants(body, observed.url);
  if (variants.length < 2) return;
  candidateWriteChain = candidateWriteChain.then(async () => {
    const stored = await chrome.storage.local.get({ [CANDIDATES_KEY]: [] });
    const candidates = Array.isArray(stored[CANDIDATES_KEY]) ? stored[CANDIDATES_KEY] : [];
    const now = Date.now();
    let added = 0;
    for (const variant of variants) {
      const identity = parseIdentity(variant.url, observed.tabId, context.pageUrl);
      // RESOLUTION in the master is the real encoded size; the URL label is a marketing name and
      // lies about it (a "720p" path carrying 720x404). Prefer the manifest, fall back to the URL.
      const resolution = variant.resolution && variant.resolution !== "auto" ? variant.resolution : identity.resolution;
      const id = `${observed.tabId}:${identity.product}:${resolution}`;
      if (candidates.some((item) => item.id === id)) continue;
      candidates.push({
        id,
        product: identity.product,
        resolution,
        kind: "playlist",
        url: variant.url,
        tabId: observed.tabId,
        pageUrl: context.pageUrl,
        pageTitle: context.pageTitle,
        playlistUrl: variant.url,
        playlistUrls: [variant.url, observed.url],
        manifestUrl: "",
        manifestUrls: [],
        directUrl: "",
        directFiles: [],
        segmentUrl: "",
        keyUrl: "",
        subtitles: [],
        // The master was fetched with the page's own session; reuse the headers we already saw.
        headers: { ...(observed.headers || {}) },
        fromMasterPlaylist: true,
        decision: "pending",
        firstSeen: now,
        lastSeen: now,
        seen: 1
      });
      added += 1;
    }
    if (!added) return;
    await chrome.storage.local.set({ [CANDIDATES_KEY]: candidates.slice(-MAX_CANDIDATES) });
  });
}

function mediaKind(url, requestType = "") {
  try {
    const path = new URL(url).pathname.toLowerCase();
    const match = path.match(/\.([a-z0-9]+)$/);
    const ext = match?.[1] || "";
    if (ext === "m3u8") return "playlist";
    if (ext === "mpd") return "manifest";
    if (["mp4", "webm", "mkv", "mov", "m4v", "mp3", "m4a", "flac", "ogg", "wav"].includes(ext) && requestType === "media") return "direct";
    if (["ts", "m4s", "mp4", "aac", "cmfv", "cmfa"].includes(ext)) return "segment";
    if (ext === "key") return "key";
    if (["vtt", "srt", "ttml", "dfxp", "ass", "ssa"].includes(ext)) return "subtitle";
  } catch {
    return "";
  }
  return "";
}

function isKnownSubtitleUrl(url, confirmed = null) {
  // A subtitle served from an API path has no extension, so a URL the response already proved
  // to be a subtitle must survive this filter too.
  if (confirmed && confirmed[String(url)]) return true;
  try { return /\.(?:vtt|srt|ttml|dfxp|ass|ssa|m3u8)(?:[?#]|$)/i.test(new URL(url).href); }
  catch { return false; }
}

function responseHeaderObject(details) {
  return headersToObject(details.responseHeaders || []);
}

function responseSize(headers = {}) {
  const rangeTotal = String(headers["content-range"] || "").match(/\/(\d+)\s*$/)?.[1];
  return Number(rangeTotal || headers["content-length"] || 0) || 0;
}

function responseFileName(headers = {}, url = "") {
  const disposition = String(headers["content-disposition"] || "");
  const match = disposition.match(/filename\*=(?:UTF-8'')?["']?([^"';]+)|filename=["']?([^"';]+)/i);
  if (match) {
    try { return decodeURIComponent(match[1] || match[2] || "").trim(); }
    catch { return (match[1] || match[2] || "").trim(); }
  }
  try {
    const pathName = decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
    return /\.(?:mp4|webm|mkv|mov|m4v|mp3|m4a|flac|ogg|wav)$/i.test(pathName) ? pathName : "";
  }
  catch { return ""; }
}

function directFileScore(item = {}) {
  const type = String(item.contentType || "").toLowerCase();
  const name = String(item.fileName || item.url || "").toLowerCase();
  let score = Math.log2(Math.max(1, Number(item.contentLength || 0)));
  if (type.startsWith("video/")) score += 1000;
  if (type.startsWith("audio/")) score -= 1000;
  if (/\.(?:mp4|webm|mkv|mov|m4v)(?:[?#]|$)/i.test(name)) score += 500;
  if (/\.(?:mp3|m4a|aac|flac|ogg|wav)(?:[?#]|$)/i.test(name)) score -= 500;
  if (item.requestType === "media") score += 100;
  return score;
}

function bestDirectFile(items = []) {
  return [...items].sort((a, b) => directFileScore(b) - directFileScore(a) || Number(b.contentLength || 0) - Number(a.contentLength || 0) || Number(b.lastSeen || 0) - Number(a.lastSeen || 0))[0] || null;
}

function parseIdentity(url, tabId, pageUrl = "") {
  try {
    const parsed = new URL(url);
    const known = parsed.pathname.match(/\/v\/([^/]+)\/(\d{2,5}x\d{2,5})\//i);
    const resolutionMatch = parsed.pathname.match(/(?:^|\/)(\d{2,5}x\d{2,5})(?:\/|$)/i);
    const heightMatch = parsed.pathname.match(/(?:^|\/)(\d{3,4})p(?:\/|$)/i);
    let product = known?.[1] || "";
    let resolution = known?.[2] || resolutionMatch?.[1] || (heightMatch ? `${heightMatch[1]}p` : "auto");
    if (!product) {
      const page = pageUrl ? new URL(pageUrl) : null;
      const pagePart = page?.pathname.split("/").filter(Boolean).pop() || "video";
      product = `${page?.hostname || parsed.hostname}-${pagePart}`;
    }
    product = product.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "video";
    return { id: `${tabId}:${product}:${resolution}`, product, resolution };
  } catch {
    return { id: `${tabId}:video:auto`, product: "video", resolution: "auto" };
  }
}

function derivePlaylistUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.pathname.toLowerCase().endsWith(".m3u8")) return parsed.href;
    if (/\.(ts|m4s|aac|mp4)$/i.test(parsed.pathname)) {
      parsed.pathname = parsed.pathname.replace(/\/[^/]+$/, "/first.m3u8");
      parsed.hash = "";
      return parsed.href;
    }
  } catch { /* no derived URL */ }
  return "";
}

function headersToObject(headers = []) {
  const result = {};
  for (const item of headers) {
    const name = String(item.name || "").trim().toLowerCase();
    if (!name || item.value == null) continue;
    result[name] = String(item.value);
  }
  return result;
}

function headerValue(headers = [], wantedName = "") {
  return headers.find((item) => String(item.name || "").toLowerCase() === wantedName.toLowerCase())?.value || "";
}

async function tabContext(tabId) {
  if (tabId < 0) return { pageUrl: "", pageTitle: "" };
  try {
    const tab = await chrome.tabs.get(tabId);
    return { pageUrl: tab.url || "", pageTitle: tab.title || "" };
  } catch {
    return { pageUrl: "", pageTitle: "" };
  }
}

function broadcastMedia(event) {
  chrome.runtime.sendMessage({ type: "media-observed", event }, () => void chrome.runtime.lastError);
}

function queuedMediaEvents(events, observed, candidateId) {
  const now = Date.now();
  const recent = (Array.isArray(events) ? events : []).filter((item) => Number(item.timeStamp || 0) >= now - MEDIA_EVENT_TTL_MS);
  if (!["playlist", "manifest", "segment"].includes(observed.kind)) return recent.slice(-MAX_MEDIA_EVENTS);
  const queued = {
    ...observed,
    id: `${observed.tabId}:${observed.kind}:${observed.timeStamp}:${observed.url}`,
    candidateId
  };
  const withoutDuplicate = recent.filter((item) => item.id !== queued.id && !(item.kind === queued.kind && item.tabId === queued.tabId && item.url === queued.url && Math.abs(Number(item.timeStamp || 0) - Number(queued.timeStamp || 0)) < 1000));
  withoutDuplicate.push(queued);
  return withoutDuplicate.slice(-MAX_MEDIA_EVENTS);
}

async function recordCandidate(details, forcedKind = "") {
  if (String(details.initiator || "").startsWith(`chrome-extension://${chrome.runtime.id}`)) return;
  const kind = forcedKind || mediaKind(details.url, details.type);
  if (!kind) return;
  if (["playlist", "manifest"].includes(kind) && details.tabId >= 0) recentStreamTabs.set(details.tabId, Date.now());
  const { discover = false } = await chrome.storage.local.get({ discover: false });
  if (!discover) return;
  const context = await tabContext(details.tabId);
  const identity = parseIdentity(details.url, details.tabId, context.pageUrl);
  const now = Date.now();
  const responseHeaders = responseHeaderObject(details);
  const observed = {
    ...identity,
    kind,
    url: details.url,
    tabId: details.tabId,
    pageUrl: context.pageUrl,
    pageTitle: context.pageTitle,
    headers: headersToObject(details.requestHeaders),
    responseHeaders,
    contentType: headerValue(details.responseHeaders, "content-type").split(";", 1)[0].trim().toLowerCase(),
    contentLength: responseSize(responseHeaders),
    fileName: responseFileName(responseHeaders, details.url),
    requestType: details.type || "",
    timeStamp: details.timeStamp || now
  };

  candidateWriteChain = candidateWriteChain.then(async () => {
    const stored = await chrome.storage.local.get({ [CANDIDATES_KEY]: [], [MEDIA_EVENTS_KEY]: [] });
    const candidates = Array.isArray(stored[CANDIDATES_KEY]) ? stored[CANDIDATES_KEY] : [];

    if (kind === "subtitle") {
      const related = candidates.filter((item) => item.tabId === details.tabId && now - item.lastSeen < 10 * 60 * 1000);
      for (const item of related) {
        item.subtitles = Array.from(new Set([...(item.subtitles || []), details.url])).slice(-20);
        // Remember that this URL was proven to be a subtitle by its response type.
        item.subtitleTypes = { ...(item.subtitleTypes || {}), [details.url]: observed.contentType || "text/vtt" };
        const call = pendingSubtitleRequests.get(details.requestId);
        if (call) {
          // Keep the subtitle request's own headers: the membership token that decides whether the
          // server answers with the whole track or a five-minute preview is in there, and so is
          // the JWT the payload is encrypted against.
          const entry = { url: details.url, method: call.method, body: call.body, headers: { ...(observed.headers || {}) }, contentType: observed.headers?.["content-type"] || "application/grpc-web+proto" };
          // The player calls the same endpoint once per subtitle chunk, so every distinct body
          // is a different part of the track and all of them are needed.
          const calls = (item.subtitleCalls || []).filter((existing) => existing.body !== entry.body);
          calls.push(entry);
          item.subtitleCalls = calls.slice(-200);
          item.subtitleRequests = { ...(item.subtitleRequests || {}), [details.url]: entry };
        }
        item.lastSeen = now;
      }
      await chrome.storage.local.set({ [CANDIDATES_KEY]: candidates });
      broadcastMedia(observed);
      return;
    }

    let candidate = candidates.find((item) => item.id === identity.id);
    const isNew = !candidate;
    if (!candidate) {
      candidate = {
        ...identity,
        tabId: details.tabId,
        pageUrl: context.pageUrl,
        pageTitle: context.pageTitle,
        playlistUrl: "",
        playlistUrls: [],
        manifestUrl: "",
        manifestUrls: [],
        directUrl: "",
        directFiles: [],
        segmentUrl: "",
        keyUrl: "",
        subtitles: [],
        headers: {},
        decision: "pending",
        firstSeen: now,
        lastSeen: now,
        seen: 0
      };
      candidates.push(candidate);
    }
    if (candidate.decision === "ignored" && Number(candidate.ignoredUntil || 0) <= now) {
      candidate.decision = "pending";
      delete candidate.ignoredUntil;
    }
    candidate.subtitles = Array.from(new Set((candidate.subtitles || []).filter((item) => isKnownSubtitleUrl(item, candidate.subtitleTypes))));
    candidate.lastSeen = now;
    candidate.seen = Number(candidate.seen || 0) + 1;
    candidate.pageUrl = context.pageUrl || candidate.pageUrl;
    candidate.pageTitle = context.pageTitle || candidate.pageTitle;
    candidate.headers = { ...(candidate.headers || {}), ...observed.headers };
    candidate.contentType = observed.contentType || candidate.contentType || "";
    if (kind === "playlist") {
      candidate.playlistUrls = Array.from(new Set([...(candidate.playlistUrls || []), candidate.playlistUrl, details.url].filter(Boolean))).slice(-20);
      candidate.playlistUrl ||= details.url;
      if (!candidate.fromMasterPlaylist) void expandMasterPlaylist(observed, context);
    }
    if (kind === "manifest") {
      candidate.manifestUrls = Array.from(new Set([...(candidate.manifestUrls || []), candidate.manifestUrl, details.url].filter(Boolean))).slice(-10);
      candidate.manifestUrl ||= details.url;
    }
    if (kind === "direct") {
      const direct = {
        url: details.url,
        contentType: observed.contentType,
        contentLength: observed.contentLength,
        fileName: observed.fileName,
        requestType: observed.requestType,
        headers: observed.headers,
        lastSeen: now
      };
      const directFiles = (candidate.directFiles || []).filter((item) => item?.url && item.url !== direct.url);
      directFiles.push(direct);
      candidate.directFiles = directFiles.slice(-20);
      const best = bestDirectFile(candidate.directFiles);
      candidate.directUrl = best?.url || details.url;
      candidate.contentType = best?.contentType || candidate.contentType || "";
      candidate.contentLength = best?.contentLength || 0;
      candidate.fileName = best?.fileName || candidate.fileName || "";
    }
    if (kind === "segment") {
      candidate.segmentUrl = details.url;
      candidate.playlistUrl ||= derivePlaylistUrl(details.url);
    }
    if (kind === "key") candidate.keyUrl = details.url;
    candidate.lastUrl = details.url;
    candidate.mediaKind = kind;

    candidates.sort((a, b) => Number(b.lastSeen || 0) - Number(a.lastSeen || 0));
    const mediaEvents = queuedMediaEvents(stored[MEDIA_EVENTS_KEY], observed, candidate.id);
    await chrome.storage.local.set({ [CANDIDATES_KEY]: candidates.slice(0, MAX_CANDIDATES), [MEDIA_EVENTS_KEY]: mediaEvents });
    if (isNew) {
      await chrome.action.setBadgeBackgroundColor({ color: "#2563eb" });
      await chrome.action.setBadgeText({ text: "!" });
      await chrome.action.setTitle({ title: chrome.i18n.getMessage("badgeVideoFound") || "Web Keeper" });
    }
    broadcastMedia({ ...observed, playlistUrl: candidate.playlistUrl, manifestUrl: candidate.manifestUrl, directUrl: candidate.directUrl, candidateId: candidate.id });
  }).catch((error) => console.warn("Web Keeper candidate storage failed", error));
  await candidateWriteChain;
}

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await chrome.storage.local.get({ discover: true });
  await chrome.storage.local.set({ discover: Boolean(settings.discover), engineVersion: SCRIPT_VERSION });
});

async function sanitizeStoredCandidates() {
  const stored = await chrome.storage.local.get({ [CANDIDATES_KEY]: [] });
  const candidates = Array.isArray(stored[CANDIDATES_KEY]) ? stored[CANDIDATES_KEY] : [];
  let changed = false;
  for (const item of candidates) {
    const subtitles = Array.from(new Set((item.subtitles || []).filter((url) => isKnownSubtitleUrl(url, item.subtitleTypes))));
    if (subtitles.length !== (item.subtitles || []).length) changed = true;
    item.subtitles = subtitles;
    item.playlistUrls = Array.from(new Set([...(item.playlistUrls || []), item.playlistUrl].filter(Boolean)));
    item.manifestUrls = Array.from(new Set([...(item.manifestUrls || []), item.manifestUrl].filter(Boolean)));
  }
  if (changed) await chrome.storage.local.set({ [CANDIDATES_KEY]: candidates });
}

void sanitizeStoredCandidates().catch((error) => console.warn("Web Keeper candidate cleanup failed", error));

const pendingSubtitleRequests = new Map();

function bytesToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return btoa(binary);
}

// A gRPC-style subtitle endpoint only answers POST with its own protobuf body, so the call has
// to be recorded before it can ever be replayed.
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    try {
      if (details.method !== "POST" || !/subtitle/i.test(new URL(details.url).pathname)) return;
      const raw = details.requestBody?.raw?.[0]?.bytes;
      if (!raw) return;
      pendingSubtitleRequests.set(details.requestId, { url: details.url, method: details.method, body: bytesToBase64(raw) });
      while (pendingSubtitleRequests.size > 50) pendingSubtitleRequests.delete(pendingSubtitleRequests.keys().next().value);
      setTimeout(() => pendingSubtitleRequests.delete(details.requestId), 120000);
    } catch { /* body not readable */ }
  },
  { urls: ["<all_urls>"] },
  ["requestBody"]
);

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (["media", "xmlhttprequest", "other"].includes(details.type) && !String(details.initiator || "").startsWith(`chrome-extension://${chrome.runtime.id}`)) {
      pendingMediaHeaders.set(details.requestId, { requestHeaders: details.requestHeaders || [], type: details.type, initiator: details.initiator || "" });
      while (pendingMediaHeaders.size > MAX_PENDING_REQUESTS) pendingMediaHeaders.delete(pendingMediaHeaders.keys().next().value);
      setTimeout(() => pendingMediaHeaders.delete(details.requestId), 60000);
    }
    void recordCandidate(details);
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders", "extraHeaders"]
);

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    void recordResponseCandidate(details);
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders", "extraHeaders"]
);

async function recordResponseCandidate(details) {
  noteApiActivity(details, responseHeaderObject(details));
  const contentType = ((details.responseHeaders || []).find((item) => String(item.name).toLowerCase() === "content-type")?.value || "").toLowerCase();
  const contentDisposition = (details.responseHeaders || []).find((item) => String(item.name).toLowerCase() === "content-disposition")?.value || "";
  const pending = pendingMediaHeaders.get(details.requestId) || {};
  pendingMediaHeaders.delete(details.requestId);
  const enriched = { ...details, ...pending };
  if (/mpegurl/i.test(contentType)) return recordCandidate(enriched, "playlist");
  if (/dash\+xml/i.test(contentType)) return recordCandidate(enriched, "manifest");
  if (/^(?:text\/vtt|application\/(?:ttml\+xml|x-subrip)|text\/srt)/i.test(contentType)) return recordCandidate(enriched, "subtitle");
  // Some sites serve subtitles from an API with a protobuf/octet-stream content type; the path
  // is the only honest hint, so accept it and let the task page work out the payload.
  if (/subtitle/i.test(new URL(details.url).pathname) && ["xmlhttprequest", "other"].includes(details.type)) {
    return recordCandidate(enriched, "subtitle");
  }
  if (!["media", "xmlhttprequest", "other"].includes(details.type)) return;

  const obviousSegment = /\.(?:ts|m4s|cmfv|cmfa|aac)(?:[?#]|$)/i.test(details.url);
  if (obviousSegment) return;
  const stored = await chrome.storage.local.get({ [CANDIDATES_KEY]: [] });
  const now = Date.now();
  const hasRecentStream = Number(recentStreamTabs.get(details.tabId) || 0) >= now - 10 * 60 * 1000 || (stored[CANDIDATES_KEY] || []).some((item) => Number(item.tabId) === Number(details.tabId)
    && Number(item.lastSeen || 0) >= now - 10 * 60 * 1000
    && Boolean(item.playlistUrl || (item.playlistUrls || []).length || item.manifestUrl || (item.manifestUrls || []).length));
  const hasMediaExtension = /\.(?:mp4|webm|mkv|mov|m4v|mp3|m4a|flac|ogg|wav)(?:[?#]|$)/i.test(details.url);
  const strongSegmentMime = /(?:video\/(?:mp2t|iso\.segment)|audio\/aac)/i.test(contentType);
  const segmentMime = strongSegmentMime || /(?:video\/mp4|audio\/mp4|application\/(?:octet-stream|mp4))/i.test(contentType);
  const headers = responseHeaderObject(details);
  const size = responseSize(headers);
  const likelyExtensionlessSegment = hasRecentStream && !hasMediaExtension && segmentMime
    && (details.type !== "media" || strongSegmentMime) && (!size || (size >= 16 && size <= 64 * 1024 * 1024));
  if (likelyExtensionlessSegment) return recordCandidate(enriched, "segment");

  const explicitMedia = /^(video|audio)\//i.test(contentType) && !/mpegurl|dash\+xml/i.test(contentType);
  const mediaAttachment = /filename\*?\s*=.*\.(?:mp4|webm|mkv|mov|m4v|mp3|m4a|flac|ogg|wav)(?:["';\s]|$)/i.test(contentDisposition);
  const browserMedia = details.type === "media" && (!size || size >= 500000);
  if (explicitMedia || mediaAttachment || browserMedia) return recordCandidate(enriched, "direct");
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "open-extension-page") {
    const path = String(message.path || "");
    if (!/^(?:download\.html(?:\?[^#]*)?|settings\.html)$/.test(path)) {
      sendResponse({ ok: false, error: "Unsupported extension page" });
      return false;
    }
    const windowId = Number(message.windowId);
    const createProperties = { url: chrome.runtime.getURL(path), active: true };
    if (Number.isInteger(windowId) && windowId >= 0) createProperties.windowId = windowId;
    chrome.tabs.create(createProperties)
      .then((tab) => sendResponse({ ok: true, tabId: tab.id }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "set-candidate-decision") {
    candidateWriteChain = candidateWriteChain.then(async () => {
      const stored = await chrome.storage.local.get({ [CANDIDATES_KEY]: [] });
      const candidates = stored[CANDIDATES_KEY] || [];
      const selected = candidates.find((item) => item.id === message.candidateId);
      if (!selected) throw new Error(chrome.i18n.getMessage("candidateGone") || "Video candidate is no longer available");
      const related = candidates.filter((item) => item.tabId === selected.tabId && item.product === selected.product);
      for (const item of related) item.decision = item.id === selected.id ? message.decision : "not-selected";
      if (message.decision === "reset") for (const item of related) item.decision = "pending";
      await chrome.storage.local.set({ [CANDIDATES_KEY]: candidates });
      return selected;
    });
    candidateWriteChain.then((candidate) => sendResponse({ ok: true, candidate })).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "remove-candidates") {
    const wanted = new Set((message.candidateIds || []).map(String));
    candidateWriteChain = candidateWriteChain.then(async () => {
      const stored = await chrome.storage.local.get({ [CANDIDATES_KEY]: [] });
      const candidates = stored[CANDIDATES_KEY] || [];
      const kept = candidates.filter((item) => !wanted.has(String(item.id)));
      // Only the discovery record goes away; tasks, checkpoints and finished files are untouched.
      await chrome.storage.local.set({ [CANDIDATES_KEY]: kept });
      return candidates.length - kept.length;
    });
    candidateWriteChain.then((removed) => sendResponse({ ok: true, removed })).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "get-extension-state") {
    chrome.storage.local.get({ [CANDIDATES_KEY]: [], [JOBS_KEY]: [] }).then(sendResponse);
    return true;
  }
  return false;
});
