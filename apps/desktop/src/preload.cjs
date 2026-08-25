// Narrow, capability-oriented preload. No raw IPC object, local path, port,
// token or decrypted credential crosses into the renderer.
const { contextBridge, ipcRenderer } = require("electron");

const updates = Object.freeze({
  getState: () => ipcRenderer.invoke("updates:get-state"),
  setChannel: channel => ipcRenderer.invoke("updates:set-channel", channel),
  check: () => ipcRenderer.invoke("updates:check"),
  download: () => ipcRenderer.invoke("updates:download"),
  install: () => ipcRenderer.invoke("updates:install"),
  onStateChange: callback => {
    if (typeof callback !== "function") throw new TypeError("Update state listener must be a function");
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("updates:state-changed", listener);
    return () => ipcRenderer.removeListener("updates:state-changed", listener);
  }
});

contextBridge.exposeInMainWorld("consistencyDesktop", Object.freeze({
  appVersion: () => ipcRenderer.invoke("app:version"),
  buildInfo: () => ipcRenderer.invoke("app:build-info"),
  selectRepository: () => ipcRenderer.invoke("repositories:select"),
  credentialStatus: () => ipcRenderer.invoke("credentials:status"),
  setCredential: (key, value) => ipcRenderer.invoke("credentials:set", { key, value }),
  showFromTray: () => ipcRenderer.invoke("tray:show"),
  restartRuntime: () => ipcRenderer.invoke("runtime:restart"),
  openLogsFolder: () => ipcRenderer.invoke("logs:open"),
  updates
}));
