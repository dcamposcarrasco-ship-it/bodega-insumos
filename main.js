const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');

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

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'bodega-insumos' } }, (res) => {
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

    dbg('Nueva versión detectada. Buscando Setup .exe en assets...');
    const exeAsset = release.assets.find(a => a.name.includes('Setup') && a.name.endsWith('.exe')) || release.assets.find(a => a.name.endsWith('.exe') && !a.name.includes('Setup'));
    if (!exeAsset) { dbg('No se encontró .exe en los assets'); return; }
    dbg(`Asset encontrado: ${exeAsset.name}`);

    dbg('Notificando al renderizador...');
    if (mainWindow) {
      mainWindow.webContents.send('update-available', {
        version: latestTag,
        exeName: exeAsset.name,
        exeUrl: exeAsset.browser_download_url
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
    const exeAsset = release.assets.find(a => a.name.includes('Setup') && a.name.endsWith('.exe')) || release.assets.find(a => a.name.endsWith('.exe') && !a.name.includes('Setup'));
    if (!exeAsset) { dbg('No exe asset'); return; }

    const dlPath = path.join(app.getPath('temp'), exeAsset.name);
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
    await downloadFile(exeAsset.browser_download_url);

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
