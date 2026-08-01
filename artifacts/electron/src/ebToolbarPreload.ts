import { contextBridge, ipcRenderer } from "electron";

/**
 * Exposes window.__eq to the EB renderer (Instagram page).
 * The toolbar buttons call window.__eq.command(cmd, payload) which
 * routes through IPC to the main process eb-toolbar-cmd handler.
 */
contextBridge.exposeInMainWorld("__eq", {
  command: (cmd: string, payload?: unknown) =>
    ipcRenderer.invoke("eb-toolbar-cmd", cmd, payload),
});
