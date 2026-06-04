const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
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

function semverCompare(a, b) {
  const pa = a.replace('v', '').split('.').map(Number);
  const pb = b.replace('v', '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'bodega-insumos' } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

async function checkForUpdates(mainWindow) {
  try {
    const currentVer = app.getVersion();
    console.log(`[Updater] Versión actual: v${currentVer}`);

    const body = await httpGet(
      'https://api.github.com/repos/dcamposcarrasco-ship-it/bodega-insumos/releases/latest'
    );
    const release = JSON.parse(body);
    const latestTag = release.tag_name.replace('v', '');
    console.log(`[Updater] Última versión en GitHub: v${latestTag}`);

    if (semverCompare(latestTag, currentVer) <= 0) {
      console.log('[Updater] Ya tienes la última versión.');
      return;
    }

    const ymlAsset = release.assets.find(a => a.name === 'latest.yml');
    if (!ymlAsset) { console.log('[Updater] No se encontró latest.yml'); return; }

    const ymlBody = await httpGet(ymlAsset.browser_download_url);
    const exeMatch = ymlBody.match(/url:\s*(\S+)/);
    const shaMatch = ymlBody.match(/sha512:\s*(\S+)/);
    const sizeMatch = ymlBody.match(/size:\s*(\d+)/);
    if (!exeMatch) { console.log('[Updater] No se encontró URL en latest.yml'); return; }

    const exeUrl = release.assets.find(a => a.name === exeMatch[1]);
    if (!exeUrl) { console.log('[Updater] No se encontró el asset del .exe'); return; }

    const result = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Actualización disponible',
      message: `Nueva versión v${latestTag} disponible. ¿Descargar ahora?`,
      detail: `Actual: v${currentVer}\nNueva: v${latestTag}`,
      buttons: ['Descargar', 'Más tarde']
    });
    if (result.response !== 0) return;

    const dlPath = path.join(app.getPath('temp'), exeMatch[1]);
    console.log(`[Updater] Descargando a: ${dlPath}`);

    await new Promise((resolve, reject) => {
      const file = fs.createWriteStream(dlPath);
      https.get(exeUrl.browser_download_url, { headers: { 'User-Agent': 'bodega-insumos' } }, (res) => {
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
      }).on('error', reject);
    });

    console.log('[Updater] Descarga completada.');

    const installResult = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Descarga completada',
      message: `Versión v${latestTag} descargada. ¿Reemplazar el ejecutable ahora?`,
      detail: 'La aplicación se cerrará y se abrirá la nueva versión.',
      buttons: ['Reemplazar y reiniciar', 'Más tarde']
    });
    if (installResult.response !== 0) return;

    const currentExe = process.execPath;
    const updaterScript = path.join(app.getPath('temp'), 'actualizar.bat');
    const pid = process.pid;
    const dq = String.fromCharCode(34);
    const batContent =
`@echo off
:wait
tasklist /fi ${dq}PID eq ${pid}${dq} 2>nul | find ${dq}${pid}${dq} >nul
if not errorlevel 1 (
  timeout /t 1 /nobreak >nul
  goto wait
)
copy /y ${dq}${dlPath}${dq} ${dq}${currentExe}${dq} >nul
start ${dq}${dq} ${dq}${currentExe}${dq}
del ${dq}%~f0${dq}`;
    fs.writeFileSync(updaterScript, batContent);
    require('child_process').exec(updaterScript, () => app.quit());
  } catch (err) {
    console.error('[Updater] Error:', err.message || err);
  }
}

app.whenReady().then(() => {
  createWindow();
  setTimeout(() => checkForUpdates(mainWindow), 3000);
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
