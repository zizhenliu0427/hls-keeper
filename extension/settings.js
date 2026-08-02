const $ = (id) => document.getElementById(id);
const { t } = WebKeeperI18n;
const DB_NAME = "web-keeper-downloads";

function syncCompletionOptions() {
  $("cleanupAfterMerge").disabled = !$("autoFinalize").checked;
}

function syncDestinationOptions() {
  $("customFolderOptions").hidden = $("destination").value !== "custom-folder";
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
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

async function handleRecord(action, value) {
  const database = await openDatabase();
  const transaction = database.transaction("handles", action === "get" ? "readonly" : "readwrite");
  const store = transaction.objectStore("handles");
  const request = action === "get" ? store.get("default-root") : action === "put" ? store.put({ id: "default-root", handle: value }) : store.delete("default-root");
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function refreshDirectory() {
  const record = await handleRecord("get");
  $("directoryName").textContent = record?.handle?.name || t("noDefaultSaveLocation", null, "首次下载时选择");
  $("forgetDirectory").disabled = !record?.handle;
}

async function load() {
  await WebKeeperI18n.init();
  const settings = await chrome.storage.local.get({ uiLanguage: "auto", preferredMethod: "ask", defaultQuality: "highest", showDiagnostics: false, autoFinalize: true, cleanupAfterMerge: true, directConcurrency: 4, saveDestination: "browser-downloads" });
  $("language").value = settings.uiLanguage;
  $("method").value = settings.preferredMethod;
  $("quality").value = settings.defaultQuality;
  $("diagnostics").checked = Boolean(settings.showDiagnostics);
  $("autoFinalize").checked = settings.autoFinalize !== false;
  $("cleanupAfterMerge").checked = settings.cleanupAfterMerge !== false;
  $("concurrency").value = String([2, 4, 6].includes(Number(settings.directConcurrency)) ? Number(settings.directConcurrency) : 4);
  $("destination").value = settings.saveDestination === "custom-folder" ? "custom-folder" : "browser-downloads";
  syncCompletionOptions();
  syncDestinationOptions();
  await refreshDirectory();
}

$("chooseDirectory").addEventListener("click", async () => {
  if (!("showDirectoryPicker" in window)) return void ($("message").textContent = t("browserUnsupportedFolder", null, "当前浏览器不支持直接选择保存目录。"));
  try {
    const handle = await window.showDirectoryPicker({ mode: "readwrite", id: "web-keeper-downloads", startIn: "downloads" });
    await handleRecord("put", handle);
    $("destination").value = "custom-folder";
    await chrome.storage.local.set({ saveDestination: "custom-folder" });
    syncDestinationOptions();
    await refreshDirectory();
    $("message").textContent = t("saveLocationUpdated", null, "保存位置已更新；已有文件不会移动。" );
  } catch (error) { if (error.name !== "AbortError") $("message").textContent = error.message; }
});

$("forgetDirectory").addEventListener("click", async () => {
  await handleRecord("delete");
  await refreshDirectory();
  $("message").textContent = t("saveLocationForgotten", null, "已忘记保存位置；磁盘文件没有删除。" );
});

$("autoFinalize").addEventListener("change", syncCompletionOptions);
$("destination").addEventListener("change", syncDestinationOptions);

$("save").addEventListener("click", async () => {
  await chrome.storage.local.set({
    uiLanguage: $("language").value,
    preferredMethod: $("method").value,
    defaultQuality: $("quality").value,
    showDiagnostics: $("diagnostics").checked,
    autoFinalize: $("autoFinalize").checked,
    cleanupAfterMerge: $("cleanupAfterMerge").checked,
    directConcurrency: Number($("concurrency").value),
    saveDestination: $("destination").value
  });
  $("message").textContent = $("language").value === WebKeeperI18n.locale ? t("settingsSaved", null, "设置已保存") : t("reloadForLanguage", null, "语言已更新，重新打开后生效。");
});

load().catch((error) => { $("message").textContent = error.message; });
