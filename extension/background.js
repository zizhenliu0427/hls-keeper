const SCRIPT_VERSION = "web-keeper-extension-0.3.6";
const CANDIDATES_KEY = "wkCandidates";
const JOBS_KEY = "wkJobs";
const MAX_CANDIDATES = 120;
const MAX_PENDING_REQUESTS = 500;
let candidateWriteChain = Promise.resolve();
const pendingMediaHeaders = new Map();

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

function isKnownSubtitleUrl(url) {
  try { return /\.(?:vtt|srt|ttml|dfxp|ass|ssa)(?:[?#]|$)/i.test(new URL(url).href); }
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

async function recordCandidate(details, forcedKind = "") {
  if (String(details.initiator || "").startsWith(`chrome-extension://${chrome.runtime.id}`)) return;
  const kind = forcedKind || mediaKind(details.url, details.type);
  if (!kind) return;
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
    const stored = await chrome.storage.local.get({ [CANDIDATES_KEY]: [] });
    const candidates = Array.isArray(stored[CANDIDATES_KEY]) ? stored[CANDIDATES_KEY] : [];

    if (kind === "subtitle") {
      const related = candidates.filter((item) => item.tabId === details.tabId && now - item.lastSeen < 10 * 60 * 1000);
      for (const item of related) {
        item.subtitles = Array.from(new Set([...(item.subtitles || []), details.url])).slice(-20);
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
    candidate.subtitles = Array.from(new Set((candidate.subtitles || []).filter(isKnownSubtitleUrl)));
    candidate.lastSeen = now;
    candidate.seen = Number(candidate.seen || 0) + 1;
    candidate.pageUrl = context.pageUrl || candidate.pageUrl;
    candidate.pageTitle = context.pageTitle || candidate.pageTitle;
    candidate.headers = { ...(candidate.headers || {}), ...observed.headers };
    candidate.contentType = observed.contentType || candidate.contentType || "";
    if (kind === "playlist") {
      candidate.playlistUrls = Array.from(new Set([...(candidate.playlistUrls || []), candidate.playlistUrl, details.url].filter(Boolean))).slice(-20);
      candidate.playlistUrl ||= details.url;
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
    await chrome.storage.local.set({ [CANDIDATES_KEY]: candidates.slice(0, MAX_CANDIDATES) });
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
    const subtitles = Array.from(new Set((item.subtitles || []).filter(isKnownSubtitleUrl)));
    if (subtitles.length !== (item.subtitles || []).length) changed = true;
    item.subtitles = subtitles;
    item.playlistUrls = Array.from(new Set([...(item.playlistUrls || []), item.playlistUrl].filter(Boolean)));
    item.manifestUrls = Array.from(new Set([...(item.manifestUrls || []), item.manifestUrl].filter(Boolean)));
  }
  if (changed) await chrome.storage.local.set({ [CANDIDATES_KEY]: candidates });
}

void sanitizeStoredCandidates().catch((error) => console.warn("Web Keeper candidate cleanup failed", error));

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
    const contentType = (details.responseHeaders || []).find((item) => String(item.name).toLowerCase() === "content-type")?.value || "";
    const contentDisposition = (details.responseHeaders || []).find((item) => String(item.name).toLowerCase() === "content-disposition")?.value || "";
    const explicitMedia = /^(video|audio)\//i.test(contentType) && !/mpegurl|dash\+xml/i.test(contentType);
    const mediaAttachment = /filename\*?\s*=.*\.(?:mp4|webm|mkv|mov|m4v|mp3|m4a|flac|ogg|wav)(?:["';\s]|$)/i.test(contentDisposition);
    const obviousSegment = /\.(?:ts|m4s|cmfv|cmfa|aac)(?:[?#]|$)/i.test(details.url);
    const headers = responseHeaderObject(details);
    const size = responseSize(headers);
    const browserMedia = details.type === "media" && (!size || size >= 500000);
    const explicitSubtitle = /^(?:text\/vtt|application\/(?:ttml\+xml|x-subrip)|text\/srt)/i.test(contentType);
    if (explicitSubtitle) {
      const pending = pendingMediaHeaders.get(details.requestId) || {};
      pendingMediaHeaders.delete(details.requestId);
      void recordCandidate({ ...details, ...pending }, "subtitle");
      return;
    }
    if (!["media", "xmlhttprequest", "other"].includes(details.type) || (!explicitMedia && !mediaAttachment && !browserMedia) || obviousSegment) return;
    const pending = pendingMediaHeaders.get(details.requestId) || {};
    pendingMediaHeaders.delete(details.requestId);
    void recordCandidate({ ...details, ...pending }, "direct");
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders", "extraHeaders"]
);

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
  if (message?.type === "get-extension-state") {
    chrome.storage.local.get({ [CANDIDATES_KEY]: [], [JOBS_KEY]: [] }).then(sendResponse);
    return true;
  }
  return false;
});
