// Smoke test: load the real download page scripts in a stub DOM and execute render()
// across the main states. This is what catches load-order and TDZ mistakes that pure
// string-contract tests cannot see (a real one shipped once: "Cannot access 'merging'
// before initialization" broke the whole page while every contract test stayed green).
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");

function makeElement(id) {
  return {
    id,
    hidden: false,
    disabled: false,
    textContent: "",
    innerHTML: "",
    className: "",
    title: "",
    value: "",
    lang: "",
    max: 0,
    width: 0,
    height: 26,
    clientWidth: 600,
    parentElement: null,
    scrollTop: 0,
    scrollHeight: 0,
    dataset: {},
    style: {},
    classList: { toggle() {}, add() {}, remove() {} },
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    getAttribute() { return null; },
    matches() { return false; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    insertAdjacentHTML() {},
    appendChild() {},
    remove() {},
    getBoundingClientRect() { return { width: 600, left: 0 }; },
    getContext() {
      return { fillStyle: "", setTransform() {}, clearRect() {}, fillRect() {} };
    }
  };
}

const elements = new Map();
const documentStub = {
  getElementById(id) {
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id);
  },
  querySelectorAll() { return []; },
  createElement(tag) { return makeElement(`<${tag}>`); },
  addEventListener() {},
  documentElement: makeElement("<html>")
};

const sandbox = {
  console,
  document: documentStub,
  URL,
  URLSearchParams,
  TextEncoder,
  TextDecoder,
  setTimeout,
  clearTimeout,
  setInterval: () => ({}),
  clearInterval: () => {},
  getComputedStyle: () => ({ getPropertyValue: () => "" }),
  CSS: { escape: (value) => String(value) },
  confirm: () => false,
  alert: () => {},
  prompt: () => null,
  devicePixelRatio: 1,
  location: { search: "", href: "" },
  navigator: {
    storage: { estimate: async () => ({ usage: 0, quota: 1e15 }), getDirectory: async () => ({}) },
    clipboard: { writeText: async () => {} }
  },
  indexedDB: { open: () => ({}) },
  chrome: {
    runtime: {
      id: "smoke",
      lastError: null,
      onMessage: { addListener() {} },
      sendMessage(message, callback) { if (callback) callback(); },
      getURL: (p) => `chrome-extension://smoke/${p}`,
      getManifest: () => ({ version: "0.0.0" })
    },
    storage: { local: { async get(defaults) { return { ...defaults }; }, async set() {} } },
    i18n: { getMessage: () => "", getUILanguage: () => "zh-CN" },
    tabs: {
      async get() { return {}; },
      async query() { return []; },
      async create() { return { id: 1 }; },
      async update() {}
    },
    scripting: { async executeScript() { return []; } },
    downloads: {
      async download() { return 1; },
      async search() { return []; },
      async show() {},
      onChanged: { addListener() {} }
    }
  }
};
sandbox.window = sandbox;
vm.createContext(sandbox);

for (const file of ["extension/i18n.js", "extension/media-engine.js", "extension/download.js"]) {
  vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), sandbox, { filename: file });
}

vm.runInContext(`
  candidate = { id: "c", tabId: 3, pageUrl: "https://example.test/v", subtitles: [], headers: {} };

  // 1. Merging with a live percent: this exact state hit the shipped TDZ bug.
  state = {
    id: "job:smoke", status: "merging", mergePercent: 37, progressUnit: "items",
    total: 100, done: 50, bytes: 1234567, missing: 0, missingRanges: [],
    mode: "browser-assisted", source: "legacy-import", skippableSequences: [], candidate: {}
  };
  render();
  if (!document.getElementById("status").textContent.includes("37%")) throw new Error("merge percent missing from pill");
  if (document.getElementById("progress").value !== 37) throw new Error("progress bar does not follow merge percent");

  // 2. Capturing with gaps, live highlight and activity feed.
  state.status = "capturing";
  state.mergePercent = null;
  state.missing = 5;
  state.missingRanges = [{ sequenceFrom: 5, sequenceTo: 9, startSeconds: 10, endSeconds: 20, count: 5 }];
  state.lastSeenAt = Date.now();
  state.lastSavedSequence = 6;
  noteSegmentActivity({ sequence: 6, status: "saved", size: 1000, ms: 50, source: "task-fetch" });
  render();
  if (document.getElementById("missingRanges").innerHTML.indexOf("#5") < 0) throw new Error("gap rows not rendered");

  // 3. Quota failure state must surface the retry button as the primary action.
  state.status = "error";
  state.errorCode = "OUTPUT_QUOTA";
  render();
  if (actionsFor().primary?.id !== "mergeExternal") throw new Error("quota retry is not the primary action");

  // 4. Paused and downloaded states render without throwing.
  state.errorCode = "";
  for (const status of ["paused", "waiting", "downloaded", "complete"]) { state.status = status; render(); }

  // 4b. The action matrix is the whole point of the rewrite, so hold it to its contract across
  //     every state: at most one primary, at most two secondary, no duplicates, and every action
  //     offered must actually be wired to something.
  const seenPrimaries = new Set();
  // Two shapes of task, because the primary action depends on both: an unbound legacy import with
  // no workspace, and an ordinary task that already has a folder and a finished file.
  const fixtures = [
    () => { workDirectory = null; state.source = "legacy-import"; state.legacyBoundPlaylistUrl = ""; state.outputName = ""; state.done = 50; },
    () => { workDirectory = {}; state.source = ""; state.legacyBoundPlaylistUrl = "https://x/i.m3u8"; state.outputName = "out.mp4"; state.done = 50; },
    () => { workDirectory = {}; state.source = ""; state.legacyBoundPlaylistUrl = "https://x/i.m3u8"; state.outputName = ""; state.done = 50; }
  ];
  for (const applyFixture of fixtures)
  for (const mode of ["direct", "browser-assisted", "subtitles"]) {
    for (const status of ["ready", "downloading", "capturing", "waiting", "paused", "downloaded", "merging", "exporting", "complete", "error"]) {
      applyFixture();
      state.mode = mode;
      state.status = status;
      render();
      const plan = actionsFor();
      const where = mode + "/" + status + ": ";
      if (plan.secondary.length > 2) throw new Error(where + plan.secondary.length + " secondary actions, max is 2");
      const ids = [plan.primary].concat(plan.secondary, plan.overflow).filter(Boolean).map((item) => item.id);
      if (new Set(ids).size !== ids.length) throw new Error(where + "an action appears twice");
      for (const id of ids) {
        if (!ACTION_HANDLERS[id]) throw new Error(where + 'action "' + id + '" has no handler');
      }
      if (["merging", "exporting"].includes(status) && plan.primary) throw new Error(where + "primary action while working: " + plan.primary.id);
      if (plan.primary) seenPrimaries.add(plan.primary.id);
      const bar = document.getElementById("actionBar").innerHTML;
      if (plan.primary && bar.indexOf('data-action="' + plan.primary.id + '"') < 0) throw new Error(where + "primary action missing from the bar");
      if (plan.overflow.length && bar.indexOf("data-overflow-toggle") < 0) throw new Error(where + "overflow actions with no menu");
    }
  }
  if (seenPrimaries.size < 3) throw new Error("the matrix never varies its primary action");

  // 5. Loose work-key matching: zero padding must not break it, real differences must.
  if (normalizedWorkKey("atkd431") !== normalizedWorkKey("ATKD00431")) throw new Error("zero-padded ids should match");
  if (normalizedWorkKey("abc102") === normalizedWorkKey("abc12")) throw new Error("distinct ids must not collide");

  console.log("SMOKE_OK");
`, sandbox, { filename: "smoke-scenarios.js" });
