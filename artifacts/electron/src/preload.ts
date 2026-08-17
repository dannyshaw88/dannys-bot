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
  openSignupBrowserWindow: (opts: { username?: string; userAgent?: string; proxyHost?: string; proxyPort?: number; proxyUsername?: string; proxyPassword?: string }) =>
    ipcRenderer.invoke("open-signup-browser-window", opts),
  clearSignupBrowserCache: () => ipcRenderer.invoke("clear-signup-browser-cache"),
  openCsvTemp: (args: { content: string; filename: string }) =>
    ipcRenderer.invoke("open-csv-temp", args),
  saveCsvDialog: (args: { content: string; filename: string }) =>
    ipcRenderer.invoke("save-csv-dialog", args),
  pickEqxFolder: () =>
    ipcRenderer.invoke("pick-eqx-folder"),
  writeEqxFiles: (args: { folder: string; files: Array<{ filename: string; data: string }> }) =>
    ipcRenderer.invoke("write-eqx-files", args),
  exportEqxToFolder: (files: Array<{ filename: string; data: string }>) =>
    ipcRenderer.invoke("export-eqx-folder", files),
  writeEqxToDownloads: (files: Array<{ filename: string; data: string }>) =>
    ipcRenderer.invoke("write-eqx-downloads", files),
  saveDiagnosticSnapshot: (args: { filename: string; content: string }) =>
    ipcRenderer.invoke("save-diagnostic-snapshot", args),
  focusBrowserWindow: (profileId: number) =>
    ipcRenderer.invoke("focus-browser-window", profileId),
  getAutostart: () => ipcRenderer.invoke("get-autostart"),
  setAutostart: (enable: boolean) => ipcRenderer.invoke("set-autostart", enable),
  settingsGet: (key: string) => ipcRenderer.invoke("settings-get", key),
  settingsSet: (key: string, value: unknown) => ipcRenderer.invoke("settings-set", key, value),
  settingsGetAll: () => ipcRenderer.invoke("settings-get-all"),
  openFolderDialog: (defaultPath?: string) => ipcRenderer.invoke("open-folder-dialog", defaultPath),
  openMediaFileDialog: () => ipcRenderer.invoke("open-media-file-dialog"),
  saveProcessedImages: (files: Array<{ filename: string; dataUrl: string }>) =>
    ipcRenderer.invoke("save-processed-images", files),
  openWallpaperFileDialog: () => ipcRenderer.invoke("open-wallpaper-file-dialog"),
  countFolderFiles: (folderPath: string) => ipcRenderer.invoke("count-folder-files", folderPath),
  readClipboardText: () => ipcRenderer.invoke("clipboard-read-text"),
});
