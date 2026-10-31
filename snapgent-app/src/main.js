// SPDX-License-Identifier: GPL-3.0-or-later
// Snapgent standalone app - main process.
// The bridge is built in: BridgeCore talks MCP over stdio to the app's own child
// process (vscode_mcp.exe). No port, no WebSocket, nothing outside the app can connect.
const { app, BrowserWindow, BrowserView, ipcMain, dialog, session } = require("electron");
const path = require("path");
const fs = require("fs");
const { BridgeCore, VERSION } = require("./bridge-core");

const START_URL = "https://claude.ai/";
const TOP_BAR_H = 44;

// Never let the renderer be throttled when the window is minimised or covered.
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("disable-background-timer-throttling");

let win = null;
let view = null; // the AI site

// ---------------------------------------------------------------- data dir
const DATA_DIR = path.join(app.getPath("userData"), "snapgent-data");
fs.mkdirSync(DATA_DIR, { recursive: true });
const STORE_FILE = path.join(DATA_DIR, "storage.json");
const HISTORY_FILE = path.join(DATA_DIR, "history.json");

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf-8")); } catch { return fallback; }
}
function writeJson(file, value) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf-8");
  fs.renameSync(tmp, tmp.slice(0, -4));
}

let store = readJson(STORE_FILE, {});
let history = readJson(HISTORY_FILE, []);
let workspace = store.__workspace || "";

// ---------------------------------------------------------------- built-in bridge
function binPath(name) {
  const packaged = path.join(process.resourcesPath || "", "bin", name);
  const dev = path.join(__dirname, "..", "bin", name);
  return fs.existsSync(packaged) ? packaged : dev;
}

function mcpConfig() {
  return {
    vscode: { command: binPath("vscode_mcp.exe"), args: [], env: { ZS_WORKSPACE: workspace }, cwd: workspace || DATA_DIR },
  };
}

function logLine(m) {
  try { fs.appendFileSync(path.join(DATA_DIR, "app.log"), new Date().toISOString() + " " + m + "\n"); } catch {}
}

// Crash diagnostics: everything below is written to snapgent-data/app.log
process.on("uncaughtException", (e) => logLine("uncaughtException: " + ((e && e.stack) || e)));
process.on("unhandledRejection", (e) => logLine("unhandledRejection: " + ((e && e.stack) || e)));
app.on("render-process-gone", (_e, wc, d) => logLine("render-process-gone: " + JSON.stringify(d) + " url=" + (wc && !wc.isDestroyed() ? wc.getURL() : "?")));
app.on("child-process-gone", (_e, d) => logLine("child-process-gone: " + JSON.stringify(d)));

const core = new BridgeCore({ log: logLine, onChange: () => broadcastStatus() });

function statusObj() {
  return {
    type: "zs-status", connected: true, mcpAlive: core.mcpAlive(), bridgeVersion: VERSION,
    studio: null, studioApp: null, studioProc: null,
    tools: core.catalog.length, servers: core.serverStatus(),
  };
}
function broadcastStatus() {
  if (view && !view.webContents.isDestroyed()) view.webContents.send("zs:push", statusObj());
}

// Same message contract as extension background.js
async function handleRuntimeMessage(msg) {
  switch (msg.type) {
    case "status": return statusObj();
    case "list_tools": return { ok: true, tools: core.catalog };
    case "call_tool": return core.callTool(msg);
    case "restart_mcp": {
      const r = await core.restart(mcpConfig());
      return { ...r, tools: core.catalog, servers: core.serverStatus() };
    }
    case "reconnect": return { ok: true };
    default: return { ok: false, error: "unknown message" };
  }
}

// Only the main frame of an allow-listed provider host may talk to the bridge.
const PROVIDER_HOSTS = new Set([
  "chat.deepseek.com", "chatgpt.com", "chat.openai.com", "claude.ai", "gemini.google.com",
  "www.kimi.ai", "kimi.ai", "chat.z.ai", "chat.qwen.ai", "arena.ai", "www.meta.ai",
  "meta.ai", "ptero.pro", "grok.com", "chat.mistral.ai",
]);
function trustedSender(e) {
  try {
    if (!view || e.sender !== view.webContents) return false;
    if (e.senderFrame && e.senderFrame !== view.webContents.mainFrame) return false;
    const u = new URL(e.senderFrame ? e.senderFrame.url : view.webContents.getURL());
    return u.protocol === "https:" && PROVIDER_HOSTS.has(u.hostname);
  } catch { return false; }
}
// add_server/remove_server do not exist in the built-in bridge: pages can never
// make the app launch arbitrary programs.
const ALLOWED_RUNTIME = new Set(["status", "list_tools", "call_tool", "restart_mcp", "reconnect"]);

ipcMain.handle("zs:runtime", (e, msg) => {
  if (!trustedSender(e)) return { ok: false, error: "untrusted sender" };
  if (!msg || typeof msg !== "object" || !ALLOWED_RUNTIME.has(msg.type)) return { ok: false, error: "message not allowed" };
  if (msg.type === "call_tool") {
    if (typeof msg.name !== "string" || (msg.server && msg.server !== "vscode")) return { ok: false, error: "tool not allowed" };
    msg = { ...msg, server: "vscode" };
  }
  return handleRuntimeMessage(msg);
});
ipcMain.handle("zs:storage-get", (e, keys) => {
  if (!trustedSender(e)) return {};
  if (keys == null) return Object.fromEntries(Object.entries(store).filter(([k]) => !k.startsWith("__")));
  const list = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
  const out = {};
  for (const k of list) if (!String(k).startsWith("__") && k in store) out[k] = store[k];
  return out;
});
ipcMain.handle("zs:storage-set", (e, items) => {
  if (!trustedSender(e)) return false;
  if (!items || typeof items !== "object") return false;
  // Keys starting with "__" are app-internal (workspace, last URL); pages may not write them.
  for (const [k, v] of Object.entries(items)) {
    if (k.startsWith("__")) continue;
    store[k] = v;
  }
  writeJson(STORE_FILE, store);
  return true;
});

// ---------------------------------------------------------------- history / toolbar
function addHistory(url, title) {
  if (!/^https?:/.test(url)) return;
  history = history.filter((h) => h.url !== url);
  history.unshift({ url, title: title || url, at: Date.now() });
  history = history.slice(0, 500);
  writeJson(HISTORY_FILE, history);
  if (win && !win.isDestroyed()) win.webContents.send("app:history", history);
}
ipcMain.handle("app:get-history", () => history);
ipcMain.handle("app:clear-history", () => { history = []; writeJson(HISTORY_FILE, history); return true; });
ipcMain.handle("app:navigate", (_e, url) => { if (view && /^https?:\/\//i.test(String(url))) view.webContents.loadURL(url); });
ipcMain.handle("app:back", () => { if (view && view.webContents.canGoBack()) view.webContents.goBack(); });
ipcMain.handle("app:forward", () => { if (view && view.webContents.canGoForward()) view.webContents.goForward(); });
ipcMain.handle("app:reload", () => { if (view) view.webContents.reload(); });
ipcMain.handle("app:get-workspace", () => workspace);
ipcMain.handle("app:pick-workspace", async () => {
  const r = await dialog.showOpenDialog(win, { properties: ["openDirectory"], title: "Choose the project folder" });
  if (r.canceled || !r.filePaths[0]) return workspace;
  workspace = r.filePaths[0];
  store.__workspace = workspace; writeJson(STORE_FILE, store);
  core.restart(mcpConfig());
  win.webContents.send("app:workspace", workspace);
  return workspace;
});

// ---------------------------------------------------------------- window
function layout() {
  if (!win || !view) return;
  const [w, h] = win.getContentSize();
  view.setBounds({ x: 0, y: TOP_BAR_H, width: w, height: Math.max(0, h - TOP_BAR_H) });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 860, title: "Snapgent",
    webPreferences: { preload: path.join(__dirname, "toolbar-preload.js"), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.loadFile(path.join(__dirname, "toolbar.html"));

  view = new BrowserView({
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: false, // content scripts must share the page's DOM
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      partition: "persist:snapgent", // dedicated profile: logins stay inside the app
    },
  });
  win.setBrowserView(view);
  layout();
  win.on("resize", layout);
  win.on("closed", () => { win = null; view = null; });

  view.webContents.on("did-navigate", (_e, url) => {
    addHistory(url, view.webContents.getTitle());
    store.__lastUrl = url; writeJson(STORE_FILE, store);
    if (win) win.webContents.send("app:url", url);
  });
  view.webContents.on("did-navigate-in-page", (_e, url) => { if (win) win.webContents.send("app:url", url); });
  view.webContents.on("page-title-updated", (_e, title) => addHistory(view.webContents.getURL(), title));
  // Login popups (Sign in with Google) need a real child window so window.opener works.
  view.webContents.setWindowOpenHandler(({ url }) => {
    let host = "";
    try { host = new URL(url).hostname; } catch {}
    if (host === "accounts.google.com") {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          width: 500, height: 680, parent: win, title: "Sign in",
          webPreferences: { partition: "persist:snapgent", contextIsolation: true, nodeIntegration: false },
        },
      };
    }
    if (/^https?:\/\//i.test(url)) view.webContents.loadURL(url);
    return { action: "deny" };
  });

  // Google refuses sign-in from embedded browsers that announce "Electron" in the user agent.
  const ua = view.webContents.getUserAgent().replace(/\sElectron\/\S+/, "").replace(/\ssnapgent-app\/\S+/, "");
  view.webContents.setUserAgent(ua);
  session.fromPartition("persist:snapgent").setUserAgent(ua);

  let startUrl = START_URL;
  try {
    const u = new URL(store.__lastUrl || "");
    if (u.protocol === "https:" && PROVIDER_HOSTS.has(u.hostname)) startUrl = u.href;
  } catch {}
  view.webContents.loadURL(startUrl);
}

app.whenReady().then(() => {
  createWindow();
  core.start(mcpConfig()).then(broadcastStatus);
});

app.on("before-quit", () => { core.stop(); });
app.on("window-all-closed", () => app.quit());
