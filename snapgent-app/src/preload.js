// SPDX-License-Identifier: GPL-3.0-or-later
// Page preload for the AI site view. contextIsolation is OFF so the extension
// scripts see the real page DOM, exactly like content scripts do.
// Security: only allow-listed provider hosts get the bridge shim; ipcRenderer
// stays inside this closure and is never attached to window.
const { ipcRenderer, webFrame } = require("electron");
const fs = require("fs");
const path = require("path");

const EXT = path.join(__dirname, "..", "extension");
const VERSION = "3.9.4";

// hostname -> provider file (mirrors manifest.json content_scripts)
const PROVIDERS = {
  "chat.deepseek.com": "deepseek",
  "chatgpt.com": "chatgpt",
  "chat.openai.com": "chatgpt",
  "claude.ai": "claude",
  "gemini.google.com": "gemini",
  "www.kimi.ai": "kimi",
  "kimi.ai": "kimi",
  "chat.z.ai": "glm",
  "chat.qwen.ai": "qwen",
  "arena.ai": "arena",
  "www.meta.ai": "meta",
  "meta.ai": "meta",
  "ptero.pro": "ptero",
  "grok.com": "grok",
  "chat.mistral.ai": "mistral",
};
// MAIN-world helper scripts that run at document_start
const MAIN_WORLD = {
  "chatgpt.com": "chatgpt-cm",
  "chat.openai.com": "chatgpt-cm",
  "chat.qwen.ai": "qwen-net",
};

const host = location.hostname;
const provider = PROVIDERS[host];
const isTop = window.top === window;

function read(rel) {
  try { return fs.readFileSync(path.join(EXT, rel), "utf-8"); } catch { return null; }
}

if (provider && isTop && location.protocol === "https:") {
  // ---- keep the agent running when the window is minimised / covered
  try {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.hasFocus = () => true;
  } catch {}

  // ---- chrome.* shim (only what the extension code uses)
  const listeners = new Set();
  let lastError = undefined;
  const runtime = {
    get lastError() { return lastError; },
    getManifest: () => ({ version: VERSION }),
    sendMessage(msg, cb) {
      const p = ipcRenderer.invoke("zs:runtime", msg).then(
        (resp) => { lastError = undefined; if (cb) cb(resp); return resp; },
        (err) => { lastError = { message: String(err && err.message || err) }; if (cb) cb(undefined); lastError = undefined; }
      );
      return cb ? undefined : p;
    },
    onMessage: { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn) },
  };
  const local = {
    get(keys, cb) {
      const p = ipcRenderer.invoke("zs:storage-get", keys);
      if (cb) { p.then(cb); return undefined; }
      return p;
    },
    set(items, cb) {
      const p = ipcRenderer.invoke("zs:storage-set", items).then(() => { if (cb) cb(); });
      return cb ? undefined : p;
    },
  };
  const chromeShim = Object.freeze({ runtime: Object.freeze(runtime), storage: Object.freeze({ local: Object.freeze(local) }) });
  Object.defineProperty(window, "chrome", { value: chromeShim, writable: false, configurable: false });

  ipcRenderer.on("zs:push", (_e, msg) => {
    for (const fn of [...listeners]) { try { fn(msg, {}, () => {}); } catch {} }
  });

  // ---- MAIN-world helper scripts (document_start)
  const mainName = MAIN_WORLD[host];
  if (mainName) {
    const code = read(`providers/${mainName}.js`);
    if (code) webFrame.executeJavaScript(code).catch(() => {});
  }

  // ---- content scripts (document_idle), same order as manifest.json
  async function inject() {
    const css = read("overlay.css");
    if (css) { try { webFrame.insertCSS(css); } catch {} }
    for (const rel of ["core/config.js", "core/parser.js", `providers/${provider}.js`, "core/main.js"]) {
      const code = read(rel);
      if (!code) { console.error("[snapgent] missing", rel); return; }
      try { await webFrame.executeJavaScript(code); } catch (e) { console.error("[snapgent] inject failed", rel, e); return; }
    }
  }
  const run = () => setTimeout(inject, 300);
  if (document.readyState === "complete" || document.readyState === "interactive") run();
  else window.addEventListener("DOMContentLoaded", run, { once: true });
}
