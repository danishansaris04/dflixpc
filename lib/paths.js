'use strict';
// Sab app-data ek hi "data" folder me jaata hai (exe ke bagal me).
const fs = require('fs');
const path = require('path');

let DATA = null;

function resolveBase(electronApp) {
  if (process.env.DFLIX_DATA_DIR) return process.env.DFLIX_DATA_DIR;
  let base;
  if (electronApp && electronApp.isPackaged) {
    base = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
  } else {
    base = path.join(__dirname, '..');
  }
  return path.join(base, 'data');
}

function writable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const t = path.join(dir, '.w' + process.pid);
    fs.writeFileSync(t, '1');
    fs.unlinkSync(t);
    return true;
  } catch (e) { return false; }
}

function init(electronApp) {
  let dir = resolveBase(electronApp);
  if (!writable(dir)) {
    // exe aisi jagah hai jahan likh nahi sakte (jaise Program Files) -> AppData me
    const alt = path.join(electronApp ? electronApp.getPath('appData') : process.env.APPDATA || '.', 'DFlix', 'data');
    if (!writable(alt)) throw new Error('data folder nahi ban pa raha: ' + dir);
    dir = alt;
  }
  DATA = dir;
  for (const s of ['store', 'downloads', 'posters', 'cache', 'cache/stream', 'cache/img', 'electron']) {
    fs.mkdirSync(path.join(DATA, s), { recursive: true });
  }
  return DATA;
}

function p(...parts) {
  if (!DATA) throw new Error('paths.init() pehle call karein');
  return path.join(DATA, ...parts);
}

module.exports = { init, p, get dataDir() { return DATA; } };
