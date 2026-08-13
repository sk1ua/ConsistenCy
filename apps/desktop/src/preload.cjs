// Minimal preload: exposes only version/userData info to the renderer.
// The renderer never gets Node access (contextIsolation + sandbox).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("consistencyDesktop", {
  appVersion: () => ipcRenderer.invoke("app:version"),
  userDataPath: () => ipcRenderer.invoke("app:userDataPath")
});
