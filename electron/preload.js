import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("tracker", {
  getState: () => ipcRenderer.invoke("tracker:get-state"),
  rescan: () => ipcRenderer.invoke("tracker:rescan"),
  addSource: () => ipcRenderer.invoke("tracker:add-source"),
  updateSource: (sourceId, patch) => ipcRenderer.invoke("tracker:update-source", sourceId, patch),
  removeSource: (sourceId) => ipcRenderer.invoke("tracker:remove-source", sourceId),
  exportJson: () => ipcRenderer.invoke("tracker:export-json"),
  openDataFolder: () => ipcRenderer.invoke("tracker:open-data-folder"),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("tracker:state", listener);
    return () => ipcRenderer.removeListener("tracker:state", listener);
  }
});
