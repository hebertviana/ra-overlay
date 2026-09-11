const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ra', {
  onData: cb => ipcRenderer.on('data', (_e, payload) => cb(payload)),
  onToast: cb => ipcRenderer.on('toast', (_e, msg) => cb(msg)),
  reportHeight: h => ipcRenderer.send('content-height', h),
  getConfig: () => ipcRenderer.invoke('get-config'),
  setConfig: patch => ipcRenderer.invoke('set-config', patch),
  openSettings: () => ipcRenderer.invoke('open-settings'),
  toggleLock: () => ipcRenderer.invoke('toggle-lock'),
  refresh: () => ipcRenderer.invoke('refresh'),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  backupNow: () => ipcRenderer.invoke('backup-now'),
  openBackups: () => ipcRenderer.invoke('open-backups'),
  setInteractive: flag => ipcRenderer.send('set-interactive', flag),
  openAchievement: id => ipcRenderer.send('open-achievement', id)
});
