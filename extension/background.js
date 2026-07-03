const DEFAULT_SERVER = "http://127.0.0.1:17888";
const SCRIPT_VERSION = "hls-keeper-0.1.2";
const pendingRequestBodies = new Map();

function isInterestingMedia(url) {
  return /\.(m3u8|ts|key|vtt|srt|ttml|dfxp|ass|ssa)(?:[?#]|$)/i.test(url);
}

function isSubtitleHint(url) {
  const text = decodeURIComponent(url).toLowerCase();
  return /subtitle|caption|closed.?caption|text.?track|timed.?text|webvtt|cue|\/cc(?:[/?#=&_.-]|$)|[?&]cc=/.test(text);
}

function isLocalServerUrl(url, serverUrl) {
  return url.startsWith(serverUrl) || /^https?:\/\/127\.0\.0\.1:17888\//.test(url) || /^https?:\/\/localhost:17888\//.test(url);
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function getServer() {
  const value = await chrome.storage.local.get({ serverUrl: DEFAULT_SERVER, enabled: false, discover: false });
  return value;
}

async function ping(reason, extra = {}) {
  const { serverUrl, discover } = await getServer();
  if (!discover) return;
  fetch(`${serverUrl}/ping`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      reason,
      scriptVersion: SCRIPT_VERSION,
      time: Date.now(),
      ...extra
    })
  }).catch(() => {});
}

chrome.runtime.onStartup.addListener(() => ping("startup"));
chrome.runtime.onInstalled.addListener(() => ping("installed"));
chrome.alarms.create("hls-keeper-heartbeat", { periodInMinutes: 0.1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "hls-keeper-heartbeat") ping("heartbeat");
});
ping("loaded");

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (!isSubtitleHint(details.url)) return;
    if (!details.requestBody) return;
    const body = { method: details.method || "GET" };
    if (details.requestBody.raw && details.requestBody.raw.length) {
      const raw = details.requestBody.raw
        .filter(part => part.bytes)
        .map(part => bytesToBase64(new Uint8Array(part.bytes)));
      if (raw.length) body.rawBase64 = raw.join("");
    }
    if (details.requestBody.formData) {
      body.formData = details.requestBody.formData;
    }
    pendingRequestBodies.set(details.requestId, body);
    setTimeout(() => pendingRequestBodies.delete(details.requestId), 60000);
  },
  { urls: ["<all_urls>"] },
  ["requestBody"]
);

chrome.webRequest.onBeforeSendHeaders.addListener(
  async (details) => {
    const media = isInterestingMedia(details.url);
    const subtitleHint = isSubtitleHint(details.url);
    if (!media && !subtitleHint) return;
    const { serverUrl, enabled, discover } = await getServer();
    if (isLocalServerUrl(details.url, serverUrl)) return;
    if (!discover && !enabled) return;

    const endpoint = enabled && media ? "capture" : "candidate";
    const reason = subtitleHint && !media ? "subtitle-hint-seen" : (enabled ? "capture-media-seen" : "candidate-media-seen");
    const requestBody = pendingRequestBodies.get(details.requestId) || {};
    pendingRequestBodies.delete(details.requestId);
    ping(reason, { url: details.url });
    fetch(`${serverUrl}/${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: details.url,
        method: details.method || requestBody.method || "GET",
        kindHint: subtitleHint && !media ? "subtitle-hint" : "",
        requestBody,
        requestHeaders: details.requestHeaders || [],
        initiator: details.initiator || "",
        tabId: details.tabId,
        timeStamp: details.timeStamp
      })
    }).catch(() => {});
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders", "extraHeaders"]
);
