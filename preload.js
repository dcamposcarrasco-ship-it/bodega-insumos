const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  showSaveDialog: (options) => ipcRenderer.invoke('show-save-dialog', options),
  writeFile: (filePath, data) => ipcRenderer.invoke('write-file', filePath, data),
  getVersion: () => ipcRenderer.invoke('get-version'),
  onUpdateAvailable: (callback) => {
    ipcRenderer.on('update-available', (event, data) => callback(data));
  },
  onUpdateProgress: (callback) => {
    ipcRenderer.on('update-progress', (event, data) => callback(data));
  },
  onUpdateReady: (callback) => {
    ipcRenderer.on('update-ready', (event, data) => callback(data));
  },
  startDownload: () => ipcRenderer.invoke('start-download'),
  startUpdate: () => ipcRenderer.invoke('start-update')
});
