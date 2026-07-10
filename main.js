const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');

let mainWindow;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.exit(0);
}
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

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

ipcMain.handle('start-update', () => {
  const dlPath = _pendingDlPath;
  dbg(`start-update: pid=${process.pid}, dlPath=${dlPath}`);

  // Ejecutar el Setup.exe en modo silencioso (/S)
  // NSIS oneClick per-user no necesita elevación, /S es completamente invisible
  try {
    const cp = require('child_process');
    cp.spawn(dlPath, ['/S'], { detached: true, stdio: 'ignore' }).unref();
    dbg('Setup lanzado con /S');
  } catch (e) {
    dbg(`Error lanzando Setup: ${e.message}`);
  }
  setImmediate(() => { dbg('Saliendo con app.exit(0)'); app.exit(0); });
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

// NOTA: NO usar api.github.com/repos/.../releases/latest para chequear
// actualizaciones: esa API tiene un limite de 60 solicitudes/hora POR IP
// sin autenticacion, compartido por todo lo que use esa IP (navegador,
// otras apps, etc.). Se agota muy facil y la app deja de detectar
// actualizaciones sin avisar. En su lugar se usa el alias estable
// releases/latest/download/<archivo>, que sirve los assets directo desde
// el CDN de releases y no esta sujeto a ese limite.
const REPO_OWNER = 'dcamposcarrasco-ship-it';
const REPO_NAME = 'bodega-insumos';
const LATEST_YML_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/latest/download/latest.yml`;

function httpGet(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) { reject(new Error('Demasiadas redirecciones')); return; }
    const req = https.get(url, { headers: { 'User-Agent': 'bodega-insumos' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        dbg(`httpGet redirigiendo a: ${res.headers.location}`);
        res.resume();
        resolve(httpGet(res.headers.location, redirectCount + 1));
        return;
      }
      let data = '';
      dbg(`httpGet status: ${res.statusCode} for ${url}`);
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0,200)}`));
        } else {
          resolve(data);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

async function fetchLatestInfo() {
  const body = await httpGet(LATEST_YML_URL);
  const verMatch = body.match(/^version:\s*(.+)$/m);
  const pathMatch = body.match(/^path:\s*(.+)$/m);
  if (!verMatch || !pathMatch) throw new Error(`latest.yml invalido: ${body.slice(0, 200)}`);
  const version = verMatch[1].trim();
  const exeName = pathMatch[1].trim();
  return {
    version,
    exeName,
    exeUrl: `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/latest/download/${exeName}`
  };
}

async function checkForUpdates(mainWindow) {
  try {
    const currentVer = app.getVersion();
    dbg(`Versión actual: v${currentVer}`);

    dbg('Consultando latest.yml...');
    let info;
    try {
      info = await fetchLatestInfo();
      dbg(`latest.yml: version=${info.version} exeName=${info.exeName}`);
    } catch (netErr) {
      dbg(`Error de red: ${netErr.message}`);
      return;
    }

    dbg(`Última versión en GitHub: v${info.version}`);

    if (semverCompare(info.version, currentVer) <= 0) {
      dbg('Ya tienes la última versión.');
      return;
    }

    dbg('Nueva versión detectada.');
    dbg('Notificando al renderizador...');
    if (mainWindow) {
      mainWindow.webContents.send('update-available', {
        version: info.version,
        exeName: info.exeName,
        exeUrl: info.exeUrl
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
    const info = await fetchLatestInfo();

    const dlPath = path.join(app.getPath('temp'), info.exeName);
    _pendingDlPath = dlPath;
    dbg(`Descargando a: ${dlPath}`);

    function downloadFile(url) {
      return new Promise((resolve, reject) => {
        dbg(`Descargando desde URL: ${url}`);
        const file = fs.createWriteStream(dlPath);
        const req = https.get(url, { headers: { 'User-Agent': 'bodega-insumos' } }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            file.close();
            fs.unlinkSync(dlPath);
            dbg(`Redirigiendo a: ${res.headers.location}`);
            resolve(downloadFile(res.headers.location));
            return;
          }
          if (res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          const total = parseInt(res.headers['content-length'] || '0', 10);
          dbg(`Download: status=${res.statusCode}, content-length=${total}`);
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
          file.on('finish', () => {
            file.close();
            const stats = fs.statSync(dlPath);
            dbg(`Descarga completada. Tamaño archivo: ${stats.size}, bytes recibidos: ${downloaded}`);
            if (stats.size < 1000000) {
              dbg(`ERROR: archivo demasiado pequeño (${stats.size} bytes), posible descarga corrupta`);
            }
            resolve();
          });
        });
        req.on('error', reject);
        req.setTimeout(120000, () => { req.destroy(); reject(new Error('Timeout descarga')); });
      });
    }
    await downloadFile(info.exeUrl);

    dbg('Descarga completada.');
    if (mainWindow) {
      mainWindow.webContents.send('update-ready', {
        version: info.version,
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
