// Runs in the page's own world while a browser-assisted task is active.
// It keeps a bounded copy of media responses the player already received, so the
// task page can save the exact bytes instead of requesting a one-time URL again.
(function () {
  if (window.__webKeeperCapture) return;

  const MAX_TOTAL_BYTES = 96 * 1024 * 1024;
  const MAX_ITEM_BYTES = 24 * 1024 * 1024;
  const buffer = new Map();
  let totalBytes = 0;

  function absoluteUrl(value) {
    try { return new URL(String(value || ""), window.location.href).href; }
    catch { return String(value || ""); }
  }

  function isSubtitleResponse(url) {
    return /subtitle/i.test(String(url || ""));
  }

  function isMediaResponse(url, contentType) {
    // A subtitle API answers a POST with a body we cannot reproduce with a plain GET, so keep
    // whatever the player already received.
    if (isSubtitleResponse(url)) return true;
    const type = String(contentType || "").toLowerCase();
    if (/mpegurl|dash\+xml|text\/html|application\/json|text\/vtt/.test(type)) return false;
    if (/^(?:video|audio)\//.test(type)) return true;
    if (/octet-stream|iso\.segment|mp2t/.test(type)) return true;
    return /\.(?:ts|m4s|mp4|m4v|m4a|aac|cmfv|cmfa|webm)(?:[?#]|$)/i.test(String(url || ""));
  }

  function remember(urls, bytes) {
    if (!bytes || !bytes.byteLength || bytes.byteLength > MAX_ITEM_BYTES) return;
    for (const url of new Set(urls.filter(Boolean))) {
      const existing = buffer.get(url);
      if (existing) {
        totalBytes -= existing.bytes.byteLength;
        buffer.delete(url);
      }
      buffer.set(url, { bytes, at: Date.now() });
      totalBytes += bytes.byteLength;
    }
    while (totalBytes > MAX_TOTAL_BYTES && buffer.size) {
      const oldest = buffer.keys().next().value;
      totalBytes -= buffer.get(oldest).bytes.byteLength;
      buffer.delete(oldest);
    }
  }

  const originalFetch = window.fetch;
  const originalXhr = window.XMLHttpRequest;

  function patchedFetch(...args) {
    const promise = originalFetch.apply(this, args);
    try {
      const input = args[0];
      const requestUrl = absoluteUrl(typeof input === "string" ? input : input?.url || "");
      promise.then((response) => {
        try {
          if (!response || !response.ok) return;
          const contentType = typeof response.headers?.get === "function" ? response.headers.get("content-type") : "";
          if (!isMediaResponse(requestUrl, contentType)) return;
          const responseUrl = response.url ? absoluteUrl(response.url) : "";
          response.clone().arrayBuffer()
            .then((data) => remember([requestUrl, responseUrl], new Uint8Array(data)))
            .catch(() => { /* body already consumed or aborted */ });
        } catch { /* never disturb the player */ }
      }).catch(() => { /* the player handles its own failures */ });
    } catch { /* never disturb the player */ }
    return promise;
  }

  function PatchedXhr() {
    const request = new originalXhr();
    let requestUrl = "";
    const open = request.open;
    request.open = function (method, url, ...rest) {
      requestUrl = absoluteUrl(url);
      return open.call(this, method, url, ...rest);
    };
    request.addEventListener("load", () => {
      try {
        if (request.status < 200 || request.status >= 300) return;
        if (!isMediaResponse(requestUrl, request.getResponseHeader("content-type") || "")) return;
        const body = request.response;
        const responseUrl = request.responseURL ? absoluteUrl(request.responseURL) : "";
        if (body instanceof ArrayBuffer) remember([requestUrl, responseUrl], new Uint8Array(body));
        else if (typeof Blob === "function" && body instanceof Blob) {
          body.arrayBuffer().then((data) => remember([requestUrl, responseUrl], new Uint8Array(data))).catch(() => { /* blob gone */ });
        } else if (typeof body === "string" || typeof request.responseText === "string") {
          // A grpc-web-text reply is read as text, so the default responseType hands back a string.
          // Dropping those meant the player's own copy was never buffered and we fell back to
          // re-requesting it, which the server answers with a short preview.
          const text = typeof body === "string" ? body : request.responseText;
          if (text) remember([requestUrl, responseUrl], new TextEncoder().encode(text));
        }
      } catch { /* never disturb the player */ }
    });
    return request;
  }

  window.__webKeeperCapture = {
    version: 1,
    take(url) {
      const key = absoluteUrl(url);
      const item = buffer.get(key);
      if (!item) return null;
      buffer.delete(key);
      totalBytes -= item.bytes.byteLength;
      return item.bytes;
    },
    stats() {
      return { count: buffer.size, bytes: totalBytes };
    },
    stop() {
      buffer.clear();
      totalBytes = 0;
      try {
        window.fetch = originalFetch;
        if (typeof originalXhr === "function") window.XMLHttpRequest = originalXhr;
      } catch { /* page replaced them again */ }
      delete window.__webKeeperCapture;
    }
  };

  try {
    window.fetch = patchedFetch;
    if (typeof originalXhr === "function") {
      PatchedXhr.prototype = originalXhr.prototype;
      for (const name of ["UNSENT", "OPENED", "HEADERS_RECEIVED", "LOADING", "DONE"]) PatchedXhr[name] = originalXhr[name];
      window.XMLHttpRequest = PatchedXhr;
    }
  } catch {
    window.fetch = originalFetch;
    if (typeof originalXhr === "function") window.XMLHttpRequest = originalXhr;
  }
})();
