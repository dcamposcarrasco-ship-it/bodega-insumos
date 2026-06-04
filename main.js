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

ipcMain.handle('start-download', async () => {
  dbg('Iniciando descarga desde el renderer...');
  await performDownload(mainWindow);
});

ipcMain.handle('start-update', async () => {
  const currentExe = process.execPath;
  const dlPath = _pendingDlPath;
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
  const updaterScript = path.join(app.getPath('temp'), 'actualizar.bat');
  fs.writeFileSync(updaterScript, batContent);
  dbg('Ejecutando reemplazo y saliendo...');
  require('child_process').exec(updaterScript, () => app.quit());
});

let _pendingDlPath = '';

function semverCompare(a, b) {
  const pa = a.replace('v', '').split('.').map(Number);
  const pb = b.replace('v', '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

const debugLog = path.join(app.getPath('home'), 'updater-debug.log');
function dbg(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFileSync(debugLog, line);
  console.log(msg);
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'bodega-insumos' } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

async function checkForUpdates(mainWindow) {
  try {
    const currentVer = app.getVersion();
    dbg(`Versión actual: v${currentVer}`);

    dbg('Consultando GitHub API...');
    let body;
    try {
      body = await httpGet(
        'https://api.github.com/repos/dcamposcarrasco-ship-it/bodega-insumos/releases/latest'
      );
      dbg(`Respuesta GitHub: ${body.slice(0, 200)}`);
    } catch (netErr) {
      dbg(`Error de red: ${netErr.message}`);
      return;
    }

    let release;
    try {
      release = JSON.parse(body);
    } catch (parseErr) {
      dbg(`Error parseando JSON: ${body.slice(0, 300)}`);
      return;
    }

    const latestTag = release.tag_name.replace('v', '');
    dbg(`Última versión en GitHub: v${latestTag}`);

    if (semverCompare(latestTag, currentVer) <= 0) {
      dbg('Ya tienes la última versión.');
      return;
    }

    dbg('Nueva versión detectada. Buscando latest.yml...');
    const ymlAsset = release.assets.find(a => a.name === 'latest.yml');
    if (!ymlAsset) { dbg('No se encontró latest.yml en los assets'); return; }

    const ymlBody = await httpGet(ymlAsset.browser_download_url);
    const exeMatch = ymlBody.match(/url:\s*(\S+)/);
    if (!exeMatch) { dbg('No se encontró URL en latest.yml'); return; }

    const exeUrl = release.assets.find(a => a.name === exeMatch[1]);
    if (!exeUrl) { dbg(`No se encontró asset: ${exeMatch[1]}`); return; }

    dbg('Notificando al renderizador...');
    if (mainWindow) {
      mainWindow.webContents.send('update-available', {
        version: latestTag,
        exeName: exeMatch[1],
        exeUrl: exeUrl.browser_download_url
      });
    }
  } catch (err) {
    dbg(`Error: ${err.message || err}`);
    dbg(err.stack || '');
  }
}

async function performDownload(mainWindow) {
  try {
    dbg('performDownload iniciado');
    const body = await httpGet(
      'https://api.github.com/repos/dcamposcarrasco-ship-it/bodega-insumos/releases/latest'
    );
    const release = JSON.parse(body);
    const latestTag = release.tag_name.replace('v', '');
    const ymlAsset = release.assets.find(a => a.name === 'latest.yml');
    if (!ymlAsset) { dbg('No latest.yml'); return; }
    const ymlBody = await httpGet(ymlAsset.browser_download_url);
    const exeMatch = ymlBody.match(/url:\s*(\S+)/);
    if (!exeMatch) { dbg('No exe in yml'); return; }
    const exeUrl = release.assets.find(a => a.name === exeMatch[1]);
    if (!exeUrl) { dbg('No exe asset'); return; }

    const dlPath = path.join(app.getPath('temp'), exeMatch[1]);
    _pendingDlPath = dlPath;
    dbg(`Descargando a: ${dlPath}`);

    await new Promise((resolve, reject) => {
      const file = fs.createWriteStream(dlPath);
      const req = https.get(exeUrl.browser_download_url, { headers: { 'User-Agent': 'bodega-insumos' } }, (res) => {
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let downloaded = 0;
        res.on('data', (chunk) => {
          downloaded += chunk.length;
          if (total && mainWindow) {
            mainWindow.webContents.send('update-progress', {
              percent: (downloaded / total) * 100
            });
          }
        });
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
      });
      req.on('error', reject);
    });

    dbg('Descarga completada.');
    if (mainWindow) {
      mainWindow.webContents.send('update-ready', {
        version: latestTag,
        ready: true,
        dlPath: dlPath
      });
    }
  } catch (err) {
    dbg(`Error en descarga: ${err.message || err}`);
  }
}

app.whenReady().then(() => {
  dbg('App iniciada');
  createWindow();
  dbg('Ventana creada, programando checkForUpdates...');
  setTimeout(() => checkForUpdates(mainWindow), 5000);
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
