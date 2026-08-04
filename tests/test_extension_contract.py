from __future__ import annotations

import json
from pathlib import Path
import re
import shutil
import subprocess
import unittest


ROOT = Path(__file__).resolve().parents[1]


class ExtensionContractTests(unittest.TestCase):
    def test_manifest_uses_pure_extension_runtime(self) -> None:
        manifest = json.loads((ROOT / "extension" / "manifest.json").read_text(encoding="utf-8"))
        self.assertNotIn("nativeMessaging", manifest["permissions"])
        self.assertIn("unlimitedStorage", manifest["permissions"])
        self.assertIn("downloads", manifest["permissions"])
        self.assertIn("scripting", manifest["permissions"])
        self.assertEqual(["<all_urls>"], manifest["host_permissions"])
        self.assertEqual("zh_CN", manifest["default_locale"])
        self.assertEqual("split", manifest["incognito"])
        self.assertEqual("__MSG_appName__", manifest["name"])
        version = manifest["version"]
        self.assertEqual("0.4.6", version)
        # These three drifted apart before: the engine version and the READMEs must follow the manifest.
        background = (ROOT / "extension" / "background.js").read_text(encoding="utf-8")
        self.assertIn(f'const SCRIPT_VERSION = "web-keeper-extension-{version}"', background)
        for readme in ("README.md", "README.zh-CN.md"):
            text = (ROOT / readme).read_text(encoding="utf-8")
            self.assertIn(f"**{version}**", text, f"{readme} states a different version")
            self.assertIn(f"dist/Web-Keeper-{version}.zip", text, f"{readme} points at a different package")

    def test_declared_icons_exist_at_their_declared_size(self) -> None:
        manifest = json.loads((ROOT / "extension" / "manifest.json").read_text(encoding="utf-8"))
        declared = {**manifest["icons"], **manifest["action"]["default_icon"]}
        self.assertEqual({"16", "24", "32", "48", "128"}, set(declared))
        for size, relative in declared.items():
            path = ROOT / "extension" / relative
            # A manifest pointing at a missing icon makes the whole extension fail to load.
            self.assertTrue(path.is_file(), f"missing icon: {relative}")
            header = path.read_bytes()[:24]
            self.assertEqual(b"\x89PNG\r\n\x1a\n", header[:8], f"not a PNG: {relative}")
            width = int.from_bytes(header[16:20], "big")
            height = int.from_bytes(header[20:24], "big")
            self.assertEqual((int(size), int(size)), (width, height), f"wrong size: {relative}")
        package = (ROOT / "scripts" / "package_extension.ps1").read_text(encoding="utf-8")
        self.assertIn('"icons",', package)

    def test_popup_does_not_load_native_helper(self) -> None:
        html = (ROOT / "extension" / "popup.html").read_text(encoding="utf-8")
        self.assertNotIn('src="native-helper.js"', html)
        self.assertLess(html.index('src="i18n.js"'), html.index('src="popup.js"'))
        self.assertIn('src="popup.js"', html)
        script = (ROOT / "extension" / "popup.js").read_text(encoding="utf-8")
        self.assertIn("siteRules", script)
        self.assertIn('data-role="multiple-qualities"', script)
        self.assertIn("repeat(2, minmax(0, 1fr))", html)
        self.assertIn('html, body { margin: 0; width: 410px; min-width: 410px; max-width: 410px; overflow-x: hidden; }', html)
        self.assertIn('type: "open-extension-page"', script)
        self.assertIn("windowId: currentWindowId", script)
        self.assertIn('window.open(fallbackUrl, "_blank")', script)
        self.assertNotIn('chrome.tabs.create({ url: chrome.runtime.getURL', script)
        self.assertIn('href="download.html" target="_blank"', html)
        self.assertIn('href="settings.html" target="_blank"', html)
        self.assertIn('item.ignoredUntil = Date.now() + 30 * 60 * 1000', script)

    def test_locales_have_matching_keys_and_product_shell_has_settings(self) -> None:
        zh = json.loads((ROOT / "extension" / "_locales" / "zh_CN" / "messages.json").read_text(encoding="utf-8"))
        en = json.loads((ROOT / "extension" / "_locales" / "en" / "messages.json").read_text(encoding="utf-8"))
        self.assertEqual(set(zh), set(en))
        self.assertGreater(len(zh), 80)
        settings = (ROOT / "extension" / "settings.html").read_text(encoding="utf-8")
        settings_script = (ROOT / "extension" / "settings.js").read_text(encoding="utf-8")
        self.assertIn('data-i18n="language"', settings)
        self.assertIn('id="chooseDirectory"', settings)
        self.assertIn('src="settings.js"', settings)
        self.assertIn('startIn: "downloads"', settings_script)
        self.assertIn('id="destination"', settings)
        self.assertIn('value="browser-downloads"', settings)
        self.assertIn('saveDestination: "browser-downloads"', settings_script)

    def test_all_ui_translation_keys_exist(self) -> None:
        zh = json.loads((ROOT / "extension" / "_locales" / "zh_CN" / "messages.json").read_text(encoding="utf-8"))
        referenced: set[str] = set()
        for path in (ROOT / "extension").glob("*.html"):
            text = path.read_text(encoding="utf-8")
            referenced.update(re.findall(r'data-i18n(?:-[a-z-]+)?="([A-Za-z0-9_]+)"', text))
        for path in (ROOT / "extension").glob("*.js"):
            text = path.read_text(encoding="utf-8")
            referenced.update(re.findall(r'\bt\("([A-Za-z0-9_]+)"', text))
            referenced.update(re.findall(r'chrome\.i18n\.getMessage\("([A-Za-z0-9_]+)"', text))
        self.assertEqual(set(), referenced - set(zh), f"missing i18n keys: {sorted(referenced - set(zh))}")

    def test_background_discovery_still_waits_for_a_user_choice(self) -> None:
        background = (ROOT / "extension" / "background.js").read_text(encoding="utf-8")
        self.assertIn('const CANDIDATES_KEY = "wkCandidates"', background)
        self.assertIn('message?.type === "set-candidate-decision"', background)
        self.assertIn('message?.type === "open-extension-page"', background)
        self.assertIn('startsWith(`chrome-extension://${chrome.runtime.id}`)', background)
        self.assertNotIn("WebKeeperNative", background)

    def test_background_opens_whitelisted_extension_pages(self) -> None:
        node = shutil.which("node")
        if not node:
            self.skipTest("Node.js is not available")
        source = r"""
let listener;
let created;
global.chrome = {
  runtime: {
    id: 'test-extension',
    getURL: (path) => `chrome-extension://test-extension/${path}`,
    onInstalled: { addListener() {} },
    onMessage: { addListener(fn) { listener = fn; } }
  },
  storage: { local: { get: async () => ({}), set: async () => {} } },
  tabs: { create: async (options) => { created = options; return { id: 42 }; }, get: async () => ({}) },
  action: {},
  i18n: { getMessage: () => '' },
  webRequest: {
    onBeforeSendHeaders: { addListener() {} },
    onHeadersReceived: { addListener() {} }
  }
};
require('./extension/background.js');
(async () => {
  let response;
  const keepChannel = listener({ type: 'open-extension-page', path: 'settings.html', windowId: 23 }, {}, (value) => { response = value; });
  await new Promise((resolve) => setImmediate(resolve));
  console.log(JSON.stringify({ keepChannel, response, created }));
})();
"""
        completed = subprocess.run([node, "-e", source], cwd=ROOT, check=True, capture_output=True, text=True, encoding="utf-8")
        result = json.loads(completed.stdout)
        self.assertTrue(result["keepChannel"])
        self.assertTrue(result["response"]["ok"])
        self.assertEqual("chrome-extension://test-extension/settings.html", result["created"]["url"])
        self.assertTrue(result["created"]["active"])
        self.assertEqual(23, result["created"]["windowId"])

    def test_background_queues_extensionless_hls_segments(self) -> None:
        node = shutil.which("node")
        if not node:
            self.skipTest("Node.js is not available")
        source = r"""
let headersReceived;
const now = Date.now();
const state = {
  wkCandidates: [{
    id: '7:watch.example-video:auto', tabId: 7, product: 'watch.example-video', resolution: 'auto',
    playlistUrl: 'https://cdn.example/master.m3u8', playlistUrls: ['https://cdn.example/master.m3u8'],
    headers: {}, subtitles: [], directFiles: [], lastSeen: now, decision: 'browser-assisted'
  }],
  wkMediaEvents: [], discover: true
};
global.chrome = {
  runtime: {
    id: 'test-extension', lastError: null,
    onInstalled: { addListener() {} }, onMessage: { addListener() {} },
    sendMessage(message, callback) { if (callback) callback(); },
    getURL: (path) => `chrome-extension://test-extension/${path}`
  },
  storage: { local: {
    async get(defaults) { return { ...defaults, ...state }; },
    async set(values) { Object.assign(state, values); }
  } },
  tabs: { async get() { return { url: 'https://watch.example/video', title: 'Example video' }; }, async create() {} },
  action: { async setBadgeBackgroundColor() {}, async setBadgeText() {}, async setTitle() {} },
  i18n: { getMessage: () => '' },
  webRequest: {
    onBeforeSendHeaders: { addListener() {} },
    onHeadersReceived: { addListener(fn) { headersReceived = fn; } }
  }
};
require('./extension/background.js');
headersReceived({
  requestId: 'segment-1', tabId: 7, type: 'xmlhttprequest',
  url: 'https://cdn.example/chunk?id=42', initiator: 'https://watch.example', timeStamp: now + 1,
  responseHeaders: [
    { name: 'content-type', value: 'video/mp4' },
    { name: 'content-length', value: '1048576' }
  ]
});
headersReceived({
  requestId: 'direct-1', tabId: 8, type: 'media',
  url: 'https://files.example/file?id=complete', initiator: 'https://watch.example', timeStamp: now + 2,
  responseHeaders: [
    { name: 'content-type', value: 'video/mp4' },
    { name: 'content-length', value: '83886080' }
  ]
});
setTimeout(() => {
  const event = state.wkMediaEvents.find((item) => item.url.includes('chunk?id=42'));
  const direct = state.wkCandidates.find((item) => item.tabId === 8);
  console.log(JSON.stringify({ kind: event?.kind, candidateId: event?.candidateId, count: state.wkMediaEvents.length, directUrl: direct?.directUrl }));
}, 80);
"""
        completed = subprocess.run([node, "-e", source], cwd=ROOT, check=True, capture_output=True, text=True, encoding="utf-8")
        result = json.loads(completed.stdout)
        self.assertEqual("segment", result["kind"])
        self.assertEqual("7:watch.example-video:auto", result["candidateId"])
        self.assertEqual(1, result["count"])
        self.assertEqual("https://files.example/file?id=complete", result["directUrl"])

    def test_download_page_has_resume_encryption_and_safe_delete_contracts(self) -> None:
        html = (ROOT / "extension" / "download.html").read_text(encoding="utf-8")
        script = (ROOT / "extension" / "download.js").read_text(encoding="utf-8")
        self.assertIn('src="download.js"', html)
        self.assertIn('indexedDB.open(DB_NAME', script)
        self.assertIn('segment.key.method !== "AES-128"', script)
        self.assertIn('showDirectoryPicker', script)
        self.assertIn('startIn: "downloads"', script)
        self.assertIn('removeEntry("segments", { recursive: true })', script)
        self.assertIn('id: "default-root"', script)
        self.assertIn("async function deleteOutput()", script)
        self.assertIn("navigator.storage.getDirectory()", script)
        self.assertIn("chrome.downloads.download", script)
        self.assertIn("chrome.downloads.show", script)
        self.assertIn('state.mode = "browser-assisted"', script)
        self.assertNotIn("nativeMessaging", script)
        # Legacy data/captures can be imported into the pure-extension task model.
        self.assertIn("async function importLegacyCapture()", script)
        self.assertIn("async function importLegacyVariant(", script)
        self.assertIn('source: "legacy-import"', script)
        self.assertIn("https://legacy.local/aes-key/", script)
        self.assertIn('id="importLegacy"', script)
        self.assertIn("importLegacyCapture", (ROOT / "extension" / "_locales" / "zh_CN" / "messages.json").read_text(encoding="utf-8"))

    def test_capture_recovers_quality_switches_and_session_bound_segments(self) -> None:
        download = (ROOT / "extension" / "download.js").read_text(encoding="utf-8")
        engine = (ROOT / "extension" / "media-engine.js").read_text(encoding="utf-8")
        html = (ROOT / "extension" / "download.html").read_text(encoding="utf-8")
        self.assertIn("function segmentLookup", engine)
        self.assertIn("async function adoptPlaylistForSegment", download)
        self.assertIn("async function locateCaptureSegment", download)
        self.assertIn("function deferCaptureSegment", download)
        self.assertIn("async function replayPendingCaptureSegments", download)
        # A failed save must come back on its own, and only a bounded number of times.
        self.assertIn("async function reportCaptureItemError", download)
        self.assertIn("if (attempts > MAX_CAPTURE_RETRIES) return false;", download)
        self.assertIn("captureRetryCounts.delete(event.url);", download)
        self.assertIn("assistedItemGaveUp", download)
        # An unfinished task must keep working when the same video is reopened in a new tab.
        self.assertIn("if (event.product !== candidate.product) return false;", download)
        self.assertIn("if (event.pageUrl && candidate.pageUrl && event.pageUrl !== candidate.pageUrl) return false;", download)
        self.assertIn("candidate.tabId = Number(event.tabId);", download)
        # Faster playback makes the player request segments sooner; it must survive a resume.
        self.assertIn("async function applyCaptureSpeed", download)
        self.assertIn("video.playbackRate = wanted;", download)
        self.assertIn("state.captureSpeed = wanted;", download)
        self.assertIn('id="captureSpeed"', html)
        # When the site blocks playbackRate, fall back to +10s/sec seeking (ArrowRight-style).
        self.assertIn("function startSeekBoost", download)
        self.assertIn("async function stepSeekForward", download)
        self.assertIn("function normalizedSeekBoostSettings", download)
        self.assertIn("async function applySeekBoostSettingsFromInputs", download)
        self.assertIn('value="seek10"', html)
        self.assertIn('id="seekBoostInterval"', html)
        self.assertIn('id="seekBoostStep"', html)
        self.assertIn("captureSpeedMode = \"seek\"", download)
        self.assertIn("const MIN_SEGMENT_BYTES = 188", download)
        self.assertIn("function startProgressWatchdog", download)
        self.assertIn("async function checkProgressStall", download)
        self.assertIn("stallCaptureAlert", download)
        self.assertIn("smartFillNextRange", download)
        self.assertIn("smartFillSeekSkew", download)
        self.assertIn("downloadedItemTooSmall", download)
        self.assertIn("allFrames: true", download)
        self.assertIn("async function classifySkippedSequence", download)
        self.assertIn("async function reclassifySkippableGaps", download)
        self.assertIn("assessSkippedSegmentContinuity", download)
        self.assertIn("assessAdjacentSegmentContinuity", engine)
        self.assertIn("async function checkAdjacentTimeline", download)
        self.assertIn("async function prepareTimelineAfterIdle", download)
        self.assertIn("async function adjustTimelineShiftAndContinue", download)
        self.assertIn("timelineShiftAdjusted", download)
        self.assertIn("transportTimestamps", engine)
        # Subtitles declared in an MPD must reach the same saving path as HLS ones.
        self.assertIn("function adoptDashSubtitles", download)
        self.assertIn("item.url && !item.segmented", download)
        # Both stream types must retry deferred items when the task resumes.
        self.assertEqual(2, download.count("    await replayQueuedCaptureEvents(queued);\n    await replayPendingCaptureSegments();"))
        # Pausing aborts requests on purpose; that is not a failed item.
        self.assertIn("  if (paused) {\n    deferCaptureSegment(event);\n    return;\n  }", download)
        self.assertIn("async function fetchSegmentInPage", download)
        self.assertIn('cacheMode: "force-cache"', download)
        self.assertIn("capturePlaylistLocked = Number(state.done || 0) > 0", download)
        self.assertIn("captureQualityAdopted", download)
        self.assertIn("captureQualityChanged", download)
        # A locked task must never adopt another quality, otherwise the output mixes resolutions.
        self.assertIn("if (!capturePlaylistLocked && await adoptPlaylistForSegment(event.url))", download)

    def test_dash_capture_locks_one_representation_per_track(self) -> None:
        download = (ROOT / "extension" / "download.js").read_text(encoding="utf-8")
        engine = (ROOT / "extension" / "media-engine.js").read_text(encoding="utf-8")
        background = (ROOT / "extension" / "background.js").read_text(encoding="utf-8")
        self.assertIn("function dashCaptureIndex", engine)
        self.assertIn("async function runDashCapture", download)
        self.assertIn("async function captureObservedDashSegment", download)
        self.assertIn("async function lockDashTrack", download)
        self.assertIn("async function switchCaptureToDash", download)
        self.assertIn("async function refreshDashCaptureManifest", download)
        self.assertIn("async function finalizeDashCapture", download)
        self.assertIn("if (captureUsesDash()) return runDashCapture();", download)
        self.assertIn("if (dashCapture) return captureObservedDashSegment(event);", download)
        # The selected representations must survive a task page restart.
        self.assertIn("state.dashTrackIds", download)
        # Discovery of extensionless segments must work on DASH pages too, not only HLS ones.
        self.assertIn('["playlist", "manifest"].includes(kind)', background)
        self.assertIn('["playlist", "manifest", "segment"].includes(observed.kind)', background)
        self.assertIn("hasRecentStream", background)

    def test_page_capture_hook_buffers_player_responses(self) -> None:
        node = shutil.which("node")
        if not node:
            self.skipTest("Node.js is not available")
        source = r"""
global.window = global;
window.location = { href: 'https://watch.example/video' };
const served = new Uint8Array([0x47, 0x40, 0x11, 0x10, 0x42, 0x43]);
window.fetch = async (url) => {
  const playlist = String(url).includes('.m3u8');
  return new Response(playlist ? '#EXTM3U' : served, { headers: { 'content-type': playlist ? 'application/vnd.apple.mpegurl' : 'video/mp2t' } });
};
require('./extension/page-capture.js');
(async () => {
  const playlist = await window.fetch('https://cdn.example/index.m3u8');
  const response = await window.fetch('https://cdn.example/chunk?id=7');
  const playerCopy = new Uint8Array(await response.arrayBuffer());
  await new Promise((resolve) => setTimeout(resolve, 30));
  const api = window.__webKeeperCapture;
  const buffered = api.take('https://cdn.example/chunk?id=7');
  const second = api.take('https://cdn.example/chunk?id=7');
  const statsBeforeStop = api.stats();
  api.stop();
  console.log(JSON.stringify({
    playerStillReadable: Array.from(playerCopy),
    buffered: buffered ? Array.from(buffered) : null,
    takenTwice: second,
    emptyAfterTake: statsBeforeStop.count,
    playlistBuffered: api.take('https://cdn.example/index.m3u8') !== null,
    hookRemoved: window.__webKeeperCapture === undefined,
    fetchRestored: typeof window.fetch === 'function',
    playlistStatus: playlist.status
  }));
})();
"""
        completed = subprocess.run([node, "-e", source], cwd=ROOT, check=True, capture_output=True, text=True, encoding="utf-8")
        result = json.loads(completed.stdout)
        # The player must still be able to read its own response body.
        self.assertEqual([0x47, 0x40, 0x11, 0x10, 0x42, 0x43], result["playerStillReadable"])
        self.assertEqual([0x47, 0x40, 0x11, 0x10, 0x42, 0x43], result["buffered"])
        self.assertIsNone(result["takenTwice"])
        self.assertEqual(0, result["emptyAfterTake"])
        self.assertFalse(result["playlistBuffered"])
        self.assertTrue(result["hookRemoved"])
        self.assertTrue(result["fetchRestored"])

    def test_capture_prefers_bytes_the_player_already_received(self) -> None:
        download = (ROOT / "extension" / "download.js").read_text(encoding="utf-8")
        hook = (ROOT / "extension" / "page-capture.js").read_text(encoding="utf-8")
        package = (ROOT / "scripts" / "package_extension.ps1").read_text(encoding="utf-8")
        self.assertIn("window.__webKeeperCapture", hook)
        self.assertIn("response.clone().arrayBuffer()", hook)
        self.assertIn("window.XMLHttpRequest = PatchedXhr", hook)
        self.assertIn("MAX_TOTAL_BYTES", hook)
        self.assertIn("async function ensurePageCaptureHook", download)
        self.assertIn("async function takeBufferedSegment", download)
        self.assertIn("async function stopPageCaptureHook", download)
        self.assertIn('world: "MAIN", files: ["page-capture.js"]', download)
        self.assertIn("preferPageBuffer: true", download)
        # The observed event fires when the request starts, so the body needs a bounded wait.
        self.assertIn("const bytes = await readBufferedSegment(tabId, url);", download)
        self.assertIn("if (paused || Date.now() >= deadline) return null;", download)
        # A request the player cancelled must never consume the wait twice.
        self.assertIn("pageBufferGaveUp.has(url) ? 0 : pageBufferWaitMs", download)
        # A live stream never ends by itself, so it must not finalise on its own.
        self.assertIn("if (!state.isLive && state.total && coveredSegmentCount() >= state.total && autoFinalize)", download)
        self.assertIn('const isLive = dashCapture.manifest.type === "dynamic"', download)
        self.assertIn('"page-capture.js",', package)

    def test_media_provider_registry_and_direct_range_resume_exist(self) -> None:
        engine = (ROOT / "extension" / "media-engine.js").read_text(encoding="utf-8")
        download = (ROOT / "extension" / "download.js").read_text(encoding="utf-8")
        background = (ROOT / "extension" / "background.js").read_text(encoding="utf-8")
        html = (ROOT / "extension" / "download.html").read_text(encoding="utf-8")
        self.assertIn('id: "direct-file"', engine)
        self.assertIn('id: "hls"', engine)
        self.assertIn('id: "dash"', engine)
        self.assertLess(html.index('src="media-engine.js"'), html.index('src="download.js"'))
        self.assertIn('range: `bytes=${offset}-`', download)
        self.assertIn('response.status !== 206', download)
        self.assertIn("async function runDashDirect()", download)
        self.assertIn("async function runHlsSeparatedCmaf", download)
        self.assertIn("mergeCmafInitializations", engine)
        self.assertIn('state.mode = "browser-assisted"', download)
        self.assertIn('state.errorCode = "PLAYLIST_STALLED"', download)
        self.assertIn("interruptedReadyToResume", download)
        self.assertIn("saveSubtitles({ automatic: true })", download)
        self.assertIn("chrome.scripting.executeScript", download)
        self.assertIn("chrome.webRequest.onHeadersReceived.addListener", background)
        self.assertIn('["media", "xmlhttprequest", "other"].includes(details.type)', background)
        self.assertIn("contentDisposition", background)
        self.assertIn("speedMbps: state.speedMbps", download)
        self.assertIn("createMp4FromTransportStream", download)
        self.assertIn("validateSavedVideo", download)
        self.assertIn("preferredOutputBaseName", download)
        self.assertIn('id="speed"', html)
        self.assertIn("patchMp4InitDuration", download)
        self.assertIn('const MEDIA_EVENTS_KEY = "wkMediaEvents"', background)
        self.assertIn("replayQueuedCaptureEvents", download)
        self.assertIn("WebKeeperMediaEngine.segmentLookup", download)
        self.assertIn("playlistUrls", background)
        self.assertIn("directFiles", background)


if __name__ == "__main__":
    unittest.main()
