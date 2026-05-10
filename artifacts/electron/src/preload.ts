import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  checkForUpdates: () => ipcRenderer.invoke("check-for-updates"),
  openLog: () => ipcRenderer.invoke("open-log"),
  createBackup: () => ipcRenderer.invoke("backup-create"),
  listBackups: () => ipcRenderer.invoke("backup-list"),
  restoreBackup: (id: string) => ipcRenderer.invoke("backup-restore", id),
  deleteBackup: (id: string) => ipcRenderer.invoke("backup-delete", id),
  openBackupDir: () => ipcRenderer.invoke("backup-open-dir"),
  updateBackupSchedule: (enabled: boolean, intervalDays: number) =>
    ipcRenderer.send("backup-schedule-update", { enabled, intervalDays }),
  openBrowserWindow: (profileId: number, username: string, userAgent: string) =>
    ipcRenderer.invoke("open-browser-window", { profileId, username, userAgent }),
});
