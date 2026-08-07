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
        # Qualities came only from URLs the browser happened to request, so a rendition the player
        # never switched to was invisible. The master playlist lists them all.
        self.assertIn("function masterPlaylistVariants(", background)
        self.assertIn("async function expandMasterPlaylist(", background)
        self.assertIn("fromMasterPlaylist", background)
        # The endpoint carrying the rest of a subtitle is not named "subtitle", so every API call
        # is listed — by path and size only, never by body, since these carry session tokens.
        self.assertIn("function noteApiActivity(", background)
        self.assertIn('const API_ACTIVITY_KEY = "wkApiActivity";', background)
        note_activity = background[background.index("function noteApiActivity("):]
        note_activity = note_activity[:note_activity.index("\n}")]
        self.assertNotIn("body", note_activity, "the endpoint list must never carry request bodies")
        self.assertNotIn("requestBody", note_activity)

    def test_every_referenced_element_exists_in_the_markup(self) -> None:
        # The UI rewrite left listeners bound to buttons that no longer existed, and the resulting
        # TypeError killed page init: the download centre came up blank. One missing element is
        # enough to break the whole page, so the reference set must close.
        for page in ("download", "settings", "popup"):
            script = (ROOT / "extension" / f"{page}.js").read_text(encoding="utf-8")
            markup = (ROOT / "extension" / f"{page}.html").read_text(encoding="utf-8")
            # Some elements are injected by the script itself, so those ids count as present too.
            present = set(re.findall(r'id="([A-Za-z0-9_-]+)"', markup))
            present |= set(re.findall(r'id="([A-Za-z0-9_-]+)"', script))
            referenced = set(re.findall(r'\$\("([A-Za-z0-9_-]+)"\)', script))
            referenced |= set(re.findall(r'document\.getElementById\("([A-Za-z0-9_-]+)"\)', script))
            missing = sorted(referenced - present)
            self.assertEqual([], missing, f"{page}.js references elements {page}.html does not define: {missing}")

    def test_master_playlist_lists_every_rendition(self) -> None:
        node = shutil.which("node")
        if not node:
            self.skipTest("Node.js is not available")
        # A player offering 1080p/720p/404p appeared as "1 quality" because only the rendition it
        # actually fetched was ever seen. Every STREAM-INF must be picked up, including the one
        # whose URL carries no resolution and one written with attributes on later lines.
        source = r"""
global.chrome = {
  runtime: { id: 't', getURL: (p) => p, onInstalled: { addListener() {} }, onMessage: { addListener() {} } },
  storage: { local: { get: async () => ({}), set: async () => {} } },
  tabs: { create: async () => ({}), get: async () => ({}) },
  action: {},
  i18n: { getMessage: () => '' },
  webRequest: { onBeforeRequest: { addListener() {} }, onBeforeSendHeaders: { addListener() {} }, onHeadersReceived: { addListener() {} } }
};
const fs = require('fs');
const vm = require('vm');
const context = vm.createContext(global);
vm.runInContext(fs.readFileSync('./extension/background.js', 'utf8'), context);
const master = [
  '#EXTM3U',
  '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080',
  '1920x1080/index.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720',
  '/v/abc/1280x720/index.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=400000',
  '',
  'low/index.m3u8',
  '#EXT-X-MEDIA:TYPE=SUBTITLES,URI="sub.m3u8"'
].join('\n');
const variants = vm.runInContext('masterPlaylistVariants', context)(master, 'https://cdn.example.com/v/abc/master.m3u8');
console.log(JSON.stringify(variants));
"""
        completed = subprocess.run([node, "-e", source], cwd=ROOT, check=True, capture_output=True, text=True, encoding="utf-8")
        variants = json.loads(completed.stdout)
        background = (ROOT / "extension" / "background.js").read_text(encoding="utf-8")
        self.assertEqual(3, len(variants), "every STREAM-INF must be offered, not only the fetched one")
        self.assertEqual(
            ["https://cdn.example.com/v/abc/1920x1080/index.m3u8", "https://cdn.example.com/v/abc/1280x720/index.m3u8", "https://cdn.example.com/v/abc/low/index.m3u8"],
            [variant["url"] for variant in variants])
        self.assertEqual(["1920x1080", "1280x720", "auto"], [variant["resolution"] for variant in variants])
        # A "720p" path can carry 720x404: the manifest's RESOLUTION is the real size and must win
        # over the marketing label in the URL, or the folder name misreports the quality.
        source = background[background.index("async function expandMasterPlaylist("):]
        self.assertIn('variant.resolution && variant.resolution !== "auto" ? variant.resolution : identity.resolution', source)
        self.assertEqual(400000, variants[2]["bandwidth"])

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
    onBeforeRequest: { addListener() {} },
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
    onBeforeRequest: { addListener() {} },
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
        # The validity check deletes what it condemns, so an unreadable or still-encrypted segment
        # must never be condemned: that destroyed segments that were perfectly good.
        self.assertIn('if (verdict === "bad") bad.push(record);', script)
        self.assertIn("verifyUndecided", script)
        # One failing segment used to reject the whole batch and end the run.
        self.assertIn("const DIRECT_SEGMENT_RETRIES = 3;", script)
        self.assertIn("directSegmentsSkipped", script)
        # The download centre started whichever candidate happened to be first, and subtitles could
        # only be reached by downloading the whole video first.
        self.assertIn("data-quality-for=", script)
        self.assertIn("function qualityHeight(", script)
        self.assertIn('location.href = `download.html?candidate=${encodeURIComponent(candidateId)}&mode=subtitles`;', script)
        self.assertIn('if (state.mode === "subtitles") {', script)
        self.assertIn("saveSubtitlesOnly", script)
        # A blocked well-known folder was swallowed as a cancel, so the user retried it forever.
        self.assertIn("async function reportFolderPickFailure(", script)
        self.assertIn("folderBlocked", script)
        # The remembered root becomes the parent of every later task, so name it as such.
        self.assertIn("chosenRootFolder", script)
        # Internal verdict codes must not reach the user, and a source whose clock jumps hours must
        # not leave hours of blank timeline in the finished file.
        self.assertIn("function describeTimelineJump(", script)
        # A discontinuity is not actionable, so it must not take over the status line.
        self.assertNotIn("state.message = message;" + chr(10) + "  log(message);", script)
        # The real invariant: an internal verdict code must never end up in a user-facing string.
        for locale in ("zh_CN", "en"):
            messages = (ROOT / "extension" / "_locales" / locale / "messages.json").read_text(encoding="utf-8")
            self.assertNotIn("PTS_", messages, f"{locale} exposes an internal verdict code")
        self.assertNotIn('verdict.reason || ""], `', script)
        self.assertIn("function remainingTimeText(", script)
        # The page title is the site's name, not the video's, so the product id names the output.
        self.assertIn("const product = String(state?.product || candidate?.product || \"\").trim();", script)
        self.assertIn("safeName(directBase || product || pageTitle || \"video\")", script)
        # Subtitles are saved before the merge, so they must be named from the same base the merge
        # uses; falling back to the page title produced a name unrelated to the video file.
        self.assertIn("const base = state.outputName ? state.outputName.replace(/\.[^.]+$/, \"\") : preferredOutputBaseName();", script)
        # The site answers an anonymous request with a five-minute preview (5547 bytes) and the
        # page's own session with the whole track (246 kB), so the call must run inside the page.
        self.assertIn("async function postInPage(", script)
        self.assertIn("subtitleViaPage", script)
        # The API sits on another subdomain, so even the page's fetch is cross-origin: what decides
        # preview-vs-whole-track is the header set, and the playlist request's headers have none.
        self.assertIn("function subtitleCallHeaders(", script)
        # The AES IV comes from the signed-in id, which is not always in a header. Every id the
        # page holds is tried and the decrypted text decides which was right.
        self.assertIn("async function pageIdentityCandidates(", script)
        # The AES key is a literal in the site's own bundle, so it is discovered and verified too
        # rather than hard-coded per site.
        self.assertIn("async function pageDecryptionKeys(", script)
        # An empty reply arrives at a fixed period on some sites; throwing made it fail forever
        # instead of being judged the same way every other gap is.
        self.assertIn('const verdict = await maybeMarkSkippable(segment, { tinySize: encrypted.byteLength });', script)
        self.assertIn("downloadedItemEmpty", script)
        # On a source with hundreds of discontinuities the continuity test can never decide, so a
        # segment the server answers empty twice must be accepted rather than retried forever.
        self.assertIn("const emptySegmentCounts = new Map();", script)
        self.assertIn("segmentConfirmedEmpty", script)
        # The player's own copy needs the hook in place before the page asks for it.
        self.assertIn("async function registerPageCaptureOnLoad(", script)
        self.assertIn('runAt: "document_start"', script)
        # With a custom folder nothing is exported, so a "subtitles" subfolder just hid the file,
        # and the result line never said where it went.
        self.assertIn('? await workDirectory.getDirectoryHandle("subtitles", { create: true })', script)
        self.assertIn("subtitleSavedAt", script)
        # Players auto-load an external track only when the name matches the video exactly, so a
        # lone track must not carry a "subtitle-01" suffix.
        self.assertIn("const label = urls.length > 1", script)
        self.assertIn('const subtitleName = `${safeName(base || "video")}${label}.${safeName(ext, "vtt")}`;', script)
        self.assertIn('if (!sample.includes("-->")) continue;', script)
        self.assertIn("call.headers || candidate?.headers || {}", script)
        self.assertIn('headers: { ...(observed.headers || {}) }', (ROOT / "extension" / "background.js").read_text(encoding="utf-8"))
        self.assertIn("navigator.storage.getDirectory()", script)
        self.assertIn("chrome.downloads.download", script)
        self.assertIn("chrome.downloads.show", script)
        self.assertIn('state.mode = "browser-assisted"', script)
        self.assertNotIn("nativeMessaging", script)
        # Legacy data/captures can be imported into the pure-extension task model.
        self.assertIn("async function importLegacyCapture()", script)
        self.assertIn("async function importLegacyVariant(", script)
        # A work folder holds several quality folders; importing them all unasked copied gigabytes.
        self.assertIn("async function chooseLegacyVariants(", script)
        # Importing must not duplicate gigabytes: segments are referenced in place by default.
        self.assertIn('const LEGACY_LINK_SOURCE = "legacy-link"', script)
        self.assertIn("async function readStoredSegment(", script)
        # An imported playlist only has placeholder URLs, so gaps can only be filled by attaching
        # the task to the live page instead of trying to download legacy.local.
        self.assertIn("async function bindLegacyTaskToLivePlaylist(", script)
        # A hand-typed import name (atkd431) must still match the URL id (atkd00431), and a
        # manual attach button must exist for when even that fails.
        self.assertIn("function normalizedWorkKey(", script)
        self.assertIn("async function bindToDetectedVideo(", script)
        # Thin gaps must not each claim a whole pixel, or the bar reads far emptier than it is.
        self.assertIn("const columns = new Float32Array(width);", script)
        self.assertNotIn("Math.max(1, right - left)", script)
        # Removing a task must be able to reclaim its data, and private windows must warn.
        self.assertIn("removeTaskDataConfirm", script)
        self.assertIn("function inPrivateWindow(", script)
        # The job list is persistent while task state is not, so orphaned rows must not
        # advertise a "continue" link that dead-ends.
        self.assertIn("const liveJobIds = new Set();", script)
        self.assertIn("taskEntryLost", script)
        self.assertIn("privateWindowEphemeral", script)
        # One click must move a task onto real disk and carry the already-saved segments.
        self.assertIn("async function switchTaskToFolder(", script)
        # A folder of .ts files alone cannot describe its own gaps, so the playlist is kept
        # beside them and the importer also looks one level up.
        self.assertIn("async function persistPlaylistBesideSegments(", script)
        self.assertIn("variant.parentHandle", script)
        self.assertIn("legacySyntheticNote", script)
        self.assertIn('{ id: "switchFolder"', script)
        self.assertIn('  switchFolder: ', script)
        self.assertIn('dbPut("handles", { id: "default-root", handle: picked })', script)
        self.assertIn("taskLostPrivate", script)
        self.assertIn("async function publishImportedSubtitles(", script)
        # Sidecar subtitles are often an HLS playlist or an extensionless API URL; both were
        # detected and then thrown away by the extension-only filter.
        self.assertIn("async function fetchSubtitleContent(", script)
        # An imported task carries its own candidate, so subtitles seen on the page must be
        # merged into it and searchable on demand from the master playlist.
        self.assertIn("async function discoverSubtitles(", script)
        # This site wraps subtitles in protobuf + base64 + AES-CBC; without that the API
        # response is unreadable and looked like "no subtitles".
        self.assertIn("async function decodeEncryptedSubtitle(", script)
        # Text conversion and the segmented timeline offset live in the engine and are settable.
        self.assertIn("WebKeeperMediaEngine.mergeWebVttParts(parts, subtitleConvertMode)", script)
        self.assertIn("subtitleConvertMode = WebKeeperMediaEngine.SUBTITLE_MODES.includes(", script)
        self.assertIn('id="subtitleConvert"', (ROOT / "extension" / "settings.html").read_text(encoding="utf-8"))
        # The Chinese table is incomplete, so both the settings page and the run must say so.
        self.assertIn("subtitleConvertHint", (ROOT / "extension" / "settings.html").read_text(encoding="utf-8"))
        self.assertIn("subtitleConvertPartial", script)
        # The built-in table has 90 entries and gets one-to-many characters wrong (头发 -> 頭發,
        # 皇后 -> 皇後), so real conversion uses OpenCC's dictionaries and the table is only a
        # fallback whose warning fires only when it actually ran.
        self.assertIn("async function ensureOpenCC(", script)
        self.assertIn('tag.src = "vendor/opencc/opencc-full.js";', script)
        self.assertIn('if (!openCcConverters && ["zh-hans", "zh-hant"].includes(subtitleConvertMode)', script)
        bundle = ROOT / "extension" / "vendor" / "opencc" / "opencc-full.js"
        self.assertTrue(bundle.is_file(), "the OpenCC dictionaries must ship with the extension")
        self.assertGreater(bundle.stat().st_size, 500_000)
        self.assertIn('id="subtitleFormat"', (ROOT / "extension" / "settings.html").read_text(encoding="utf-8"))
        self.assertIn("function applySubtitleFormat(", script)
        # "0/1 saved" with the reason only in the log gives the user nothing to act on.
        self.assertIn("subtitlesSavedWithError", script)
        self.assertIn("subtitleUnknownFormat", script)
        self.assertIn("subtitleDecryptFailed", script)
        # The subtitle endpoint is gRPC-style: a plain GET answers 415, so the original POST
        # body is recorded and replayed, and the page's own copy is preferred.
        self.assertIn("candidate?.subtitleRequests?.[url]", script)
        self.assertIn("subtitleFromPageBuffer", script)
        # Copying only the URLs left the replay without its body and hit 415 again.
        self.assertIn("candidate.subtitleRequests = { ...(candidate.subtitleRequests || {}), ...(item.subtitleRequests || {}) };", script)
        self.assertIn("subtitleNeedsReplay", script)
        self.assertIn("WebKeeperMediaEngine.grpcWebPayload(", script)
        # The track arrives in chunks, so every recorded call is replayed and merged.
        self.assertIn("candidate?.subtitleCalls", script)
        self.assertIn("WebKeeperMediaEngine.mergeVttDocuments(", script)
        # A track that stops where playback stopped must be reported, not silently saved.
        self.assertIn("WebKeeperMediaEngine.subtitleCoverageSeconds(", script)
        self.assertIn("subtitleCoverageShort", script)
        # Short coverage must be fixable without replaying playback by hand: the paging cursor is
        # extrapolated directly, and the player sweep is the fallback that always works.
        self.assertIn("async function extendSubtitleByPaging(", script)
        self.assertIn("async function sweepPlayerForSubtitles(", script)
        self.assertIn("WebKeeperMediaEngine.inferSubtitlePaging(", script)
        self.assertIn('{ id: "sweepSubtitles"', script)
        self.assertIn('  sweepSubtitles: ', script)
        self.assertIn("{ ignorePause: true }", script)
        # An imported task is named after its folder, so matching calls by product alone loses
        # every call recorded on the page it is attached to.
        self.assertIn("const sameTab = Number(candidate.tabId) >= 0", script)
        # Zero recorded calls has several causes and only the right one is actionable.
        self.assertIn("subtitleSweepNeedsDiscover", script)
        self.assertIn("subtitleSweepNoCalls", script)
        self.assertIn("subtitleSweepNoNew", script)
        self.assertIn('{ id: "extractSubtitles"', script)
        self.assertIn('  extractSubtitles: ', script)
        self.assertIn("async function extractSubtitlesDirectly(", script)
        # A candidate stored by an older build only has the one-per-URL map; those are real calls.
        self.assertIn("seed(candidate.subtitleRequests);", script)
        # One recorded call is enough: the cursor is found by probing and verified by the reply.
        self.assertIn("async function probeSubtitlePaging(", script)
        self.assertIn("WebKeeperMediaEngine.subtitlePagingProbes(", script)
        self.assertIn("subtitleProbeFailed", script)
        # The page's buffered copy is one chunk of a chunked API, not the whole track; returning it
        # early skipped the extension entirely and silently reproduced the short save.
        self.assertIn("if (asDocument) documents.push(asDocument);", script)
        self.assertIn("if (calls.length) await extendSubtitleByPaging(url, calls, documents);", script)
        self.assertIn("subtitleAssembled", script)
        # log() writes into a collapsed <details>, so the result and the reason must also reach
        # the status line, and the panel starts open.
        self.assertIn('state.message = [headline, reach, where, subtitleNote].filter(Boolean).join(" ");', script)
        self.assertIn("subtitleReach", script)
        # The remuxer emits a fragmented MP4; without an index a player must walk every fragment
        # before it can start, which on a network share is minutes of waiting.
        self.assertIn("async function writeSegmentIndex(", script)
        # Leftover reserved space becomes a free box after sidx; first_offset must skip that gap.
        self.assertIn("WebKeeperMediaEngine.buildSidx(references, { firstOffset })", script)
        self.assertIn("const firstOffset = leftover >= 8 ? leftover : 0;", script)
        self.assertIn('await writable.write({ type: "write", position: sidxPosition, data: sidx });', script)
        # Space is reserved before the fragments, because a sidx has to precede what it indexes.
        self.assertIn("sidxCapacity = WebKeeperMediaEngine.sidxByteLength(expected.length + 16);", script)
        # The remuxer emits one fragment per track, so indexing each separately would double the
        # duration the index reports; one entry covers everything a source segment produced.
        self.assertIn("if (subsegmentBytes > 0) {", script)
        # The rewrite's contract: one place decides what is offered, one place places it, and the
        # ranking is bounded. Forty-four scattered .hidden assignments were the old failure mode.
        self.assertIn("function availableActions(", script)
        self.assertIn("function actionsFor(", script)
        self.assertIn("function renderActions(", script)
        self.assertIn("const ACTION_HANDLERS = {", script)
        self.assertIn("if (secondary.length >= 2) break;", script)
        # Every declared action must be dispatchable, and nothing may be wired that is not declared.
        import re as _re
        declared = set(_re.findall(r'\{ id: "([a-zA-Z]+)", when:', script))
        handlers = script[script.index("const ACTION_HANDLERS = {"):]
        wired = set(_re.findall(r"^  ([a-zA-Z]+): ", handlers[:handlers.index("};")], _re.M))
        self.assertEqual(declared, wired, "declared actions and wired handlers must match exactly")
        self.assertGreaterEqual(len(declared), 18)
        # A gRPC-Web reply can be server-streaming and a protobuf field can repeat; taking only the
        # first of either is what made a whole track look like its opening minutes.
        self.assertIn("WebKeeperMediaEngine.grpcWebPayloads(", script)
        self.assertIn("WebKeeperMediaEngine.protobufStringFields(", script)
        self.assertIn("subtitleFramesDecoded", script)
        # Several indistinguishable explanations for a short track mean the real shape has to be
        # observable rather than guessed at.
        self.assertIn("async function dumpSubtitleDiagnostics(", script)
        self.assertIn("WebKeeperMediaEngine.protobufShape(", script)
        # An id-only request has no cursor, so probing it wastes requests and the advice to replay
        # playback is simply wrong.
        self.assertIn("WebKeeperMediaEngine.subtitlePagingAbsent(", script)
        self.assertIn("subtitleNoPaging", script)
        # A track that already spans the video must not be probed, and its "why not more" note must
        # not be shown: both only make a complete result look broken.
        self.assertIn("if (videoSeconds > 0 && coverage >= videoSeconds * 0.9) return 0;", script)
        self.assertIn('if (coverageSeconds > 0 && videoSeconds > 0 && coverageSeconds >= videoSeconds * 0.9) subtitleNote = "";', script)
        # A neighbouring part may restart its clock at zero, so the probe accepts new cues rather
        # than a later timestamp, and the diagnostics show what the neighbours actually return.
        self.assertIn("if (fresh.count > 0 && grew) {", script)
        self.assertIn("SAME as base", script)
        self.assertIn('{ id: "subtitleDiagnostics"', script)
        self.assertIn('  subtitleDiagnostics: ', script)
        # The log is reachable in one click; it no longer starts expanded because the result and the
        # reason now reach the status line on their own.
        markup = (ROOT / "extension" / "download.html").read_text(encoding="utf-8")
        self.assertIn('<details id="diagnosticsPanel" class="card">', markup)
        # Detail panels collapse instead of all standing open at once.
        self.assertIn('<details id="missingPanel" class="panel"', markup)
        self.assertIn('<details id="sourcePanel" class="panel"', markup)
        # Actions are rendered from the matrix into one container, not hard-coded in the markup.
        self.assertIn('<div id="actionBar"></div>', markup)
        self.assertNotIn('<button id=', markup)
        self.assertIn("item.subtitleCalls = calls.slice(-200);", (ROOT / "extension" / "background.js").read_text(encoding="utf-8"))
        hook = (ROOT / "extension" / "page-capture.js").read_text(encoding="utf-8")
        self.assertIn("isSubtitleResponse", hook)
        # A grpc-web-text reply arrives as a string, so buffering only ArrayBuffer/Blob dropped the
        # player's own copy and left us re-requesting a short preview.
        self.assertIn("request.responseText", hook)
        self.assertIn("new TextEncoder().encode(text)", hook)
        self.assertIn('subtitleConvertMode: $("subtitleConvert").value', (ROOT / "extension" / "settings.js").read_text(encoding="utf-8"))
        self.assertIn("WebKeeperMediaEngine.subtitleUserIdFromHeaders", script)
        self.assertIn('if (event.kind === "subtitle" && event.url)', script)
        self.assertIn("function mergeWebVttParts(", (ROOT / "extension" / "media-engine.js").read_text(encoding="utf-8"))
        self.assertIn("candidate?.subtitleTypes", script)
        background = (ROOT / "extension" / "background.js").read_text(encoding="utf-8")
        self.assertIn("item.subtitleTypes = {", background)
        self.assertIn("isKnownSubtitleUrl(url, confirmed = null)", background)
        self.assertIn("/subtitle/i.test(new URL(details.url).pathname)", background)
        self.assertIn("pendingSubtitleRequests", background)
        self.assertIn('["requestBody"]', background)
        self.assertIn("const DIRECT_FILL_BATCH", script)
        self.assertIn('{ id: "bindPage"', script)
        self.assertIn('state.source === "legacy-import" && !state.legacyBoundPlaylistUrl', script)
        self.assertIn('state.errorCode = "LEGACY_PLAYLIST_MISMATCH"', script)
        # Binding used to only relabel the status, which left the task idle; it must start capture.
        self.assertIn("await runCapture();", script.split("async function bindLegacyTaskToLivePlaylist")[1].split("async function ")[0])
        # The page must show whether it is attached to a page and where segments come from.
        self.assertIn("function connectionLines(", script)
        # Waiting for a playlist event never fires on VOD, so any matching request must bind.
        self.assertIn("async function liveCandidatePlaylistUrls(", script)
        self.assertNotIn('state.source === "legacy-import" && event.kind === "playlist"', script)
        # Actions that drive the page must be disabled while nothing is attached.
        self.assertIn("function attachedToPage(", script)
        # Availability now lives in the matrix rather than in a scattered .disabled assignment.
        self.assertIn("disabled: smartFillRunning || !attached", script)
        self.assertIn("noVideoPageKnown", script)
        # A gap that was downloaded-but-empty needs a different fix than one never downloaded.
        self.assertIn("function rangeTinyCount(", script)
        self.assertIn("missingKindNever", script)
        self.assertIn("missingKindTiny", script)
        # Thousands of gaps cannot all be rendered, so they are sortable and exportable.
        self.assertIn("function sortedMissingRanges(", script)
        self.assertIn("data-missing-sort", script)
        self.assertIn("async function copyMissingList(", script)
        # The list must not reshuffle and reset its scroll on every saved segment.
        self.assertIn("function refreshMissingSnapshot(", script)
        self.assertIn("if (missingKey !== missingRenderedKey)", script)
        # Order stays put while the numbers keep moving, and the arriving gap breathes.
        self.assertIn("data-range-count", script)
        self.assertIn('row.classList.toggle("live"', script)
        self.assertIn("data-missing-page", script)
        self.assertIn('id="missingPageInput"', script)
        # A gap splitting in two must not reshuffle the list under the reader.
        self.assertIn("const rankFor = (range) =>", script)
        # The bar shows the whole timeline with the gaps punched out.
        self.assertIn("function drawCoverage(", script)
        self.assertIn("function coverageInfoAt(", script)
        # A DevTools-style feed of what is being fetched right now, with sequence and timeline position.
        self.assertIn("function noteSegmentActivity(", script)
        # A strictly serial queue could never keep up with a player seeking ahead.
        self.assertIn("function runCaptureSegment(", script)
        # Scattered one-segment gaps are mostly seek overhead; fetch them directly instead.
        self.assertIn("async function fillGapsDirectly(", script)
        # The merge aborts on the first bad segment; the verify pass reports them all and
        # turns them back into gaps instead.
        self.assertIn("async function verifyAllSegments(", script)
        # The minutes of commit/validate/export work after 100% must not be silent.
        self.assertIn("mergeCommitting", script)
        self.assertIn("mergeValidating", script)
        self.assertIn("alert(state.message);\n  } catch (error) {", script.replace("    alert(state.message);", "alert(state.message);"))
        # A large output must stream into a user-picked file instead of dying on the OPFS quota.
        self.assertIn("async function outputSpaceShortfall(", script)
        self.assertIn("async function chooseExternalOutputHandle(", script)
        self.assertIn("async function noteMergeProgress(", script)
        # TDZ regression guard: render() must declare `merging` before the status pill uses it.
        render_src = script.split("function render() {")[1].split("\nfunction ")[0]
        self.assertLess(render_src.index('const merging = '), render_src.index('merging ? `'))
        self.assertIn("externalOutputHandle", script)
        self.assertIn("outputFailedQuota", script)
        # After a quota failure there must be a way out: pick a file inside the click gesture.
        self.assertIn("presetExternalHandle", script)
        merge_src = script.split("async function mergeOutput")[1].split("\nasync function saveSubtitles")[0]
        self.assertIn('state.errorCode = "OUTPUT_QUOTA"', merge_src)
        # Big outputs must pick their destination inside the click gesture, before slow work.
        self.assertIn("const LARGE_OUTPUT_BYTES", script)
        finalize_src = script.split("async function finalizeDownloadedTask")[1].split("\nasync function ")[0]
        self.assertIn("chooseExternalOutputHandle", finalize_src)
        self.assertIn('{ id: "mergeExternal"', script)
        # Continue on a fully saved task must point at merging, not silently re-run capture.
        self.assertIn("allSavedCreateNow", script)
        self.assertIn('{ id: "verifySegments"', script)
        self.assertIn("function hasRealSegmentUrls(", script)
        self.assertIn("if (authFailures >= 8)", script)
        # Back off under pressure instead of hammering until the site cuts the session off.
        self.assertIn("if (pacingMs) await waitFor(pacingMs);", script)
        self.assertIn('const rateLimited = /\b429\b/.test(error.message);', script)
        # Both pacing knobs are user settings.
        settings_html = (ROOT / "extension" / "settings.html").read_text(encoding="utf-8")
        self.assertIn('id="pageBufferWait"', settings_html)
        self.assertIn('id="captureConcurrency"', settings_html)
        self.assertIn('{ id: "fillDirect"', script)
        # Sending ArrowRight as well as moving currentTime made those sites jump twice per step.
        self.assertIn("if (Math.abs(video.currentTime - before) < 0.25) {", script)
        # One alert per unfinished gap is an alert storm when there are hundreds of them.
        self.assertNotIn("alert(remainMsg);", script)
        self.assertNotIn("alert(nextMsg);", script)
        self.assertIn("smartFillRunningPill", script)
        # A gap that cannot be filled must be skipped, not end the whole run.
        self.assertIn("smartFillGaveUp.add(rangeKey(range));", script)
        self.assertIn("const range = ranges.find((item) => !smartFillGaveUp.has(rangeKey(item)));", script)
        self.assertNotIn("throw new Error(stuck)", script)
        self.assertNotIn("alert(skewMessage)", script)
        # Capture concurrency is a user setting, not a constant.
        self.assertIn("if (captureActive < captureConcurrency) start();", script)
        self.assertIn("captureConcurrency = [1, 2, 4, 6, 8].includes(", script)
        settings_html = (ROOT / "extension" / "settings.html").read_text(encoding="utf-8")
        settings_js = (ROOT / "extension" / "settings.js").read_text(encoding="utf-8")
        self.assertIn('id="captureConcurrency"', settings_html)
        self.assertIn('captureConcurrency: Number($("captureConcurrency").value)', settings_js)
        self.assertIn("function renderActivity(", script)
        self.assertIn('lastSegmentSource = "page-buffer"', script)
        self.assertIn('lastSegmentSource = "task-fetch"', script)
        self.assertIn('lastSegmentSource = "page-session"', script)
        self.assertIn('id="activityList"', (ROOT / "extension" / "download.html").read_text(encoding="utf-8"))
        self.assertIn("data-live-mark", script)
        # Rereading every stored record per saved segment is what made capture feel slow.
        self.assertIn("async function savedSequenceSet(", script)
        self.assertIn("function noteSavedSequence(", script)
        self.assertIn("if (!force && Date.now() - lastMissingComputeAt < 700)", script)
        self.assertIn('id="coverage"', (ROOT / "extension" / "download.html").read_text(encoding="utf-8"))
        # A bound task must never fetch the imported placeholder playlist again.
        self.assertIn('if (state?.legacyBoundPlaylistUrl) urls = urls.filter(', script)
        self.assertIn("const MISSING_PAGE_SIZE = 50;", script)
        self.assertIn(".range.live", (ROOT / "extension" / "download.html").read_text(encoding="utf-8"))
        # A player inside a shadow root must still be found, and a not-yet-ready one not filtered out.
        self.assertEqual(4, script.count("if (node.shadowRoot) collect(node.shadowRoot, out);"))
        self.assertNotIn('querySelectorAll("video")].filter', script)
        # A closed tab and a page without a player need different advice.
        self.assertIn("async function reattachVideoTab(", script)
        self.assertIn('return { ok: false, reason: "NO_TAB" };', script)
        self.assertIn("function playerFailureMessage(", script)
        self.assertIn("state.lastSeenAt = Date.now();", script)
        self.assertIn('id="sourcePanel"', (ROOT / "extension" / "download.html").read_text(encoding="utf-8"))
        self.assertNotIn("ofje", script)
        self.assertIn("async function ensureLegacySource(", script)
        self.assertIn("copyIntoStorage = false", script)
        self.assertIn('dbPut("handles", { id: `legacy:${jobId}`, handle: variant.handle })', script)
        # The merge paths must read through the resolver, or a linked task cannot produce a video.
        merge_source = script.split("async function createMp4FromTransportStream")[1].split("async function saveSubtitles")[0]
        self.assertEqual(3, merge_source.count("await readStoredSegment("))
        self.assertNotIn("segmentDirectory.getFileHandle(record.fileName)", merge_source)
        self.assertIn("for (const variant of chosen)", script)
        # These three made a 9k-segment import quadratic or unyielding, which crashed the tab.
        self.assertIn("function recordSkipVerdict(", script)
        self.assertNotIn("state.segmentSkipVerdicts = { ...(state.segmentSkipVerdicts", script)
        self.assertIn("if (examined >= MAX_RECLASSIFY_PER_PASS)", script)
        self.assertIn("if (skippableCache.jobId !== (state?.id || null))", script)
        self.assertIn('source: "legacy-import"', script)
        self.assertIn("https://legacy.local/aes-key/", script)
        self.assertIn('id="importLegacy"', script)
        # Detections that were never downloaded must be dismissable, one work or all of them.
        self.assertIn("async function dismissCandidates(", script)
        self.assertIn("data-dismiss-candidates", script)
        self.assertIn('type: "remove-candidates"', script)
        background = (ROOT / "extension" / "background.js").read_text(encoding="utf-8")
        self.assertIn('message?.type === "remove-candidates"', background)
        handler = background.split('message?.type === "remove-candidates"')[1].split('message?.type ===')[0]
        # Dismissing a detection must never reach jobs, files or checkpoints.
        self.assertIn("CANDIDATES_KEY", handler)
        self.assertNotIn("JOBS_KEY", handler)
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
