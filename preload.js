const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("symbiot", {
  status: () => ipcRenderer.invoke("status"),
  run: (cmd) => ipcRenderer.invoke("run", cmd),
  last: () => ipcRenderer.invoke("last"),
  getPrefs: () => ipcRenderer.invoke("get-prefs"),
  saveConnection: (cfg) => ipcRenderer.invoke("save-connection", cfg),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  onOpenTab: (fn) => ipcRenderer.on("open-tab", (_e, tab) => fn(tab)),
  onResult: (fn) => ipcRenderer.on("result", (_e, data) => fn(data)),
});
