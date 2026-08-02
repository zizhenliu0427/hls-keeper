(function () {
  let explicitMessages = null;
  let currentLocale = "auto";

  function substitutionsArray(substitutions) {
    if (substitutions == null) return [];
    return Array.isArray(substitutions) ? substitutions.map(String) : [String(substitutions)];
  }

  function messageFromCatalog(key, substitutions) {
    const entry = explicitMessages?.[key];
    if (!entry?.message) return "";
    const values = substitutionsArray(substitutions);
    let message = entry.message;
    for (const [name, placeholder] of Object.entries(entry.placeholders || {})) {
      const index = Number(String(placeholder.content || "").replace("$", "")) - 1;
      message = message.replaceAll(`$${name.toUpperCase()}$`, values[index] ?? "");
      message = message.replaceAll(`$${name.toLowerCase()}$`, values[index] ?? "");
    }
    values.forEach((value, index) => { message = message.replaceAll(`$${index + 1}`, value); });
    return message;
  }

  function t(key, substitutions, fallback = "") {
    const local = messageFromCatalog(key, substitutions);
    if (local) return local;
    const browser = chrome.i18n?.getMessage(key, substitutionsArray(substitutions));
    return browser || fallback || key;
  }

  function apply(root = document) {
    root.querySelectorAll("[data-i18n]").forEach((element) => {
      element.textContent = t(element.dataset.i18n, null, element.textContent);
    });
    for (const attribute of ["title", "placeholder", "aria-label"]) {
      root.querySelectorAll(`[data-i18n-${attribute}]`).forEach((element) => {
        const dataName = `i18n${attribute.split("-").map((part) => part[0].toUpperCase() + part.slice(1)).join("")}`;
        element.setAttribute(attribute, t(element.dataset[dataName], null, element.getAttribute(attribute) || ""));
      });
    }
  }

  async function init() {
    const { uiLanguage = "auto" } = await chrome.storage.local.get({ uiLanguage: "auto" });
    currentLocale = ["zh_CN", "en"].includes(uiLanguage) ? uiLanguage : "auto";
    if (currentLocale !== "auto") {
      try {
        const response = await fetch(chrome.runtime.getURL(`_locales/${currentLocale}/messages.json`));
        explicitMessages = await response.json();
      } catch {
        explicitMessages = null;
      }
    }
    const browserLanguage = chrome.i18n?.getUILanguage?.() || "zh-CN";
    document.documentElement.lang = currentLocale === "zh_CN" ? "zh-CN" : currentLocale === "en" ? "en" : browserLanguage;
    apply(document);
    return currentLocale;
  }

  globalThis.WebKeeperI18n = { init, apply, t, get locale() { return currentLocale; } };
})();
