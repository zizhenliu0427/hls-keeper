// ==UserScript==
// @name         Web Keeper Auto Seek (+10s / 1s)
// @namespace    https://github.com/local/web-keeper
// @version      0.1.0
// @description  Every 1s, seek HTML5 video +10s to keep HLS segments loading for capture.
// @match        *://*/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const STEP_SEC = 10;
  const INTERVAL_MS = 1000;
  let timer = null;

  function activeVideo() {
    const videos = [...document.querySelectorAll("video")].filter((v) => {
      const r = v.getBoundingClientRect();
      return r.width > 80 && r.height > 80;
    });
    if (!videos.length) return null;
    return videos.find((v) => !v.paused) || videos[0];
  }

  function tick() {
    const v = activeVideo();
    if (!v) return;
    try {
      const duration = Number.isFinite(v.duration) ? v.duration : Infinity;
      const next = Math.min((v.currentTime || 0) + STEP_SEC, Math.max(duration - 0.25, 0));
      if (next <= (v.currentTime || 0) + 0.05) {
        // Reached end: jump near start of remaining gaps manually, or stop.
        stop();
        console.info("[Web Keeper Auto Seek] reached end, stopped");
        return;
      }
      v.currentTime = next;
      if (v.paused) v.play().catch(() => {});
    } catch (err) {
      console.warn("[Web Keeper Auto Seek]", err);
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(tick, INTERVAL_MS);
    console.info("[Web Keeper Auto Seek] ON");
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
    console.info("[Web Keeper Auto Seek] OFF");
  }

  function toggle() {
    if (timer) stop();
    else start();
  }

  window.addEventListener("keydown", (ev) => {
    if (ev.key === "F8" && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
      ev.preventDefault();
      toggle();
    }
  });

  // Optional: expose for console
  window.__webKeeperAutoSeek = { start, stop, toggle, STEP_SEC, INTERVAL_MS };
})();
