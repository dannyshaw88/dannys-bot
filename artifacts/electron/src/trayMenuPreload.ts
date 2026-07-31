import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("trayMenuAPI", {
  openApp:    () => ipcRenderer.send("tray-open"),
  restartApp: () => ipcRenderer.send("tray-restart"),
  closeApp:   () => ipcRenderer.send("tray-close"),
});
