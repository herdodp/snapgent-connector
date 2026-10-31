// SPDX-License-Identifier: GPL-3.0-or-later
// Preload for the app toolbar window (local file, not a remote site).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("app", {
  navigate: (url) => ipcRenderer.invoke("app:navigate", url),
  back: () => ipcRenderer.invoke("app:back"),
  forward: () => ipcRenderer.invoke("app:forward"),
  reload: () => ipcRenderer.invoke("app:reload"),
  getHistory: () => ipcRenderer.invoke("app:get-history"),
  clearHistory: () => ipcRenderer.invoke("app:clear-history"),
  getWorkspace: () => ipcRenderer.invoke("app:get-workspace"),
  pickWorkspace: () => ipcRenderer.invoke("app:pick-workspace"),
  onUrl: (fn) => ipcRenderer.on("app:url", (_e, v) => fn(v)),
  onHistory: (fn) => ipcRenderer.on("app:history", (_e, v) => fn(v)),
  onWorkspace: (fn) => ipcRenderer.on("app:workspace", (_e, v) => fn(v)),
});
