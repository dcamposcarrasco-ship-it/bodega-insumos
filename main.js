const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'Bodega de Insumos — Sala Toma de Muestras',
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.loadFile('index.html');
  mainWindow.setTitle('Bodega de Insumos — Sala Toma de Muestras');

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

ipcMain.handle('show-save-dialog', async (event, options) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: options.title || 'Guardar archivo',
    defaultPath: options.defaultPath || '',
    filters: options.filters || []
  });
  return result;
});

ipcMain.handle('write-file', async (event, filePath, data) => {
  try {
    fs.writeFileSync(filePath, Buffer.from(data));
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('get-version', () => {
  return app.getVersion();
});

app.whenReady().then(() => {
  createWindow();

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.setFeedURL({
    provider: 'github',
    owner: 'dcamposcarrasco-ship-it',
    repo: 'bodega-insumos'
  });

  autoUpdater.checkForUpdatesAndNotify();
});

autoUpdater.on('checking-for-update', () => {
  console.log('[Updater] Buscando actualizaciones...');
});

autoUpdater.on('update-available', (info) => {
  console.log('[Updater] Actualización disponible:', info.version);
});

autoUpdater.on('update-not-available', (info) => {
  console.log('[Updater] Ya tienes la última versión:', info.version);
});

autoUpdater.on('error', (err) => {
  console.error('[Updater] Error:', err.message || err);
});

autoUpdater.on('download-progress', (progressObj) => {
  console.log(`[Updater] Descargando: ${progressObj.percent.toFixed(1)}%`);
});

autoUpdater.on('update-downloaded', (info) => {
  console.log('[Updater] Actualización descargada:', info.version);
  if (mainWindow) {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Actualización disponible',
      message: `Versión ${info.version} descargada. ¿Reiniciar ahora para instalarla?`,
      buttons: ['Reiniciar ahora', 'Más tarde']
    }).then(result => {
      if (result.response === 0) {
        setImmediate(() => autoUpdater.quitAndInstall());
      }
    });
  }
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
