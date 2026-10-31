'use strict';
// Fallback engine (mpv.exe na ho to): Electron/Chromium HTML5 player. Common formats (mp4/h264, webm, mp3, aac, flac, ogg, wav, kuch mkv).
const path = require('path');
const EventEmitter = require('events');

class WebEngine extends EventEmitter {
  constructor(electron, rootDir) {
    super();
    const { BrowserWindow, ipcMain } = electron;
    this.win = new BrowserWindow({
      width: 1100, height: 650, backgroundColor: '#000', autoHideMenuBar: true, title: 'D-FLIX Player',
      icon: path.join(rootDir, 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
      webPreferences: { preload: path.join(rootDir, 'player-preload.js'), contextIsolation: true, nodeIntegration: false, webSecurity: false, enableBlinkFeatures: 'AudioVideoTracks' },
    });
    this.win.setMenuBarVisibility(false);
    this.ready = false; this.q = []; this.extra = {};
    this.id = this.win.webContents.id;
    this._h = (e, ...a) => { if (e.sender.id !== this.id) return; const [type, x, y] = a;
      if (type === 'tick') this.emit('tick', x, y); else if (type === 'ended') this.emit('ended'); else if (type === 'cmd') this.emit('command', x, y); else if (type === 'close') this.quit(); };
    ipcMain.on('dplayer', this._h); this.ipcMain = ipcMain;
    this.win.webContents.once('did-finish-load', () => { this.ready = true; this.q.splice(0).forEach((f) => f()); });
    this.win.on('closed', () => { ipcMain.removeListener('dplayer', this._h); this.emit('closed'); });
    this.win.loadFile(path.join(rootDir, 'ui', 'player.html'));
  }
  _s(ch, data) { const f = () => { if (!this.win.isDestroyed()) this.win.webContents.send(ch, data); }; this.ready ? f() : this.q.push(f); }
  async load(url, title, startMs) { this._s('dp-load', { url, title, start: startMs || 0 }); }
  addSub(url, label) { this._s('dp-sub', { url, label }); }
  osd(m) { this._s('dp-osd', m); }
  setInfo(i) { this._s('dp-info', Object.assign({}, i, this.extra)); }
  quit() { try { if (!this.win.isDestroyed()) this.win.close(); } catch (e) {} }
  kill() { this.quit(); }
  isAlive() { return !this.win.isDestroyed(); }
}
module.exports = { WebEngine };
