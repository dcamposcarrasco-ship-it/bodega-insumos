const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

exports.default = async function(context) {
  const rcedit = path.join(__dirname, 'node_modules', 'electron-winstaller', 'vendor', 'rcedit.exe');
  const icon = path.join(__dirname, 'icon.ico');
  const appOutDir = context.appOutDir;

  for (const f of fs.readdirSync(appOutDir)) {
    const fp = path.join(appOutDir, f);
    if (f.endsWith('.exe') && fs.statSync(fp).isFile()) {
      console.log('[afterPack] Setting icon for ' + f);
      execSync('"' + rcedit + '" "' + fp + '" --set-icon "' + icon + '"', { stdio: 'pipe' });
    }
  }
};
