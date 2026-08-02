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
        self.assertEqual("0.3.6", manifest["version"])

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
        self.assertIn("playlistUrls", background)
        self.assertIn("directFiles", background)


if __name__ == "__main__":
    unittest.main()
