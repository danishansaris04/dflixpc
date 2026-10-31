'use strict';
// D-FLIX for PC (Windows 7 / 8 / 8.1 / 10 / 11)  - Electron 22 (last version with Windows 7/8 support)
const path = require('path');
const fs = require('fs');
const electron = require('electron');
const { app, BrowserWindow, ipcMain, shell, Notification, safeStorage, screen, dialog, net: enet, Menu } = electron;

const paths = require('./lib/paths');

if (!app.requestSingleInstanceLock()) { app.quit(); return; }
app.setAppUserModelId('com.dflix.danish1.pc');
try { paths.init(app); } catch (e) { app.whenReady().then(() => { dialog.showErrorBox('D-FLIX', String(e.message)); app.quit(); }); return; }
app.setPath('userData', paths.p('electron'));          // Chromium ka kachra bhi data folder ke andar
app.commandLine.appendSwitch('disk-cache-size', '1');
app.commandLine.appendSwitch('disable-http-cache');

const dcrypto = require('./lib/crypto');
const store = require('./lib/store');
const tokens = require('./lib/tokens');
const drive = require('./lib/drive');
const server = require('./lib/server');
const downloads = require('./lib/downloads');
const streamcache = require('./lib/streamcache');
const tmdb = require('./lib/tmdb');
const history = require('./lib/history');
const presence = require('./lib/presence');
const notify = require('./lib/notify');
const device = require('./lib/device');
const { MpvEngine, findMpv } = require('./lib/mpv');
const { WebEngine } = require('./lib/webplayer');
const { Session } = require('./lib/session');
const vlc = require('./lib/vlc');
const updater = require('./lib/updater');

const ICON = path.join(__dirname, 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
let win = null, player = null, htmlWin = null, quitting = false;

const runJs = (code) => { try { if (win && !win.isDestroyed()) win.webContents.executeJavaScript(code, true).catch(() => {}); } catch (e) { /* closed */ } };
const q = (v) => JSON.stringify(v);           // JS literal
const toast = (m) => runJs('try{showToast(' + q(m) + ')}catch(e){}');

// ---------- active state (online/offline for admin) ----------
function updateActive() {
  const visible = win && !win.isDestroyed() && win.isVisible() && !win.isMinimized();
  presence.setActive(!!(visible || (player && player.engine.isAlive())));
}

// ---------- window ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 780, minWidth: 820, minHeight: 560, backgroundColor: '#050508', title: 'D-FLIX', show: false,
    icon: ICON, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: false, nodeIntegration: false, spellcheck: false, backgroundThrottling: false },
  });
  Menu.setApplicationMenu(null);
  win.once('ready-to-show', () => { win.show(); updateActive(); });
  ['minimize', 'restore', 'show', 'hide', 'focus'].forEach((ev) => win.on(ev, updateActive));
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); } });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.on('closed', () => { win = null; });
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
}

// ---------- player ----------
function mpvDirs() {
  const d = [];
  if (process.env.PORTABLE_EXECUTABLE_DIR) d.push(path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'vendor', 'mpv'));
  d.push(path.join(path.dirname(process.execPath), 'vendor', 'mpv'));
  if (process.resourcesPath) d.push(path.join(process.resourcesPath, 'vendor', 'mpv'));
  d.push(path.join(__dirname, 'vendor', 'mpv'));
  d.push(path.join(path.dirname(paths.dataDir), 'vendor', 'mpv'));
  return d;
}
function closePlayer() {
  if (!player) return;
  const p = player; player = null;
  try { p.session.onClosed(); p.engine.kill(); } catch (e) { /* ignore */ }
}

function vlcDirs() { return mpvDirs().map((d) => path.join(path.dirname(d), 'vlc')); }

// mode: 'web' (default - D-FLIX ka apna player UI) ya 'mpv' (sab formats ke liye, "Play with mpv" button se)
async function launchPlayer(req, mode) {
  if (presence.isBlockedCached()) { toast('Admin ne aapko block kiya hai'); return; }
  closePlayer();
  const mpvExe = findMpv(mpvDirs());
  const useMpv = mode === 'mpv' && !!mpvExe;
  let engine;
  if (useMpv) engine = new MpvEngine(mpvExe, path.join(__dirname, 'mpv-config', 'input.conf'));
  else { engine = new WebEngine(electron, __dirname); engine.extra = { hasMpv: !!mpvExe }; }
  const sess = new Session(engine);
  const me = { engine, session: sess };
  player = me;
  const t0 = Date.now();
  engine.on('tick', (p, d) => sess.onTick(p, d));
  engine.on('ended', () => sess.onEnded());
  engine.on('command', (c, a) => {
    if (c === 'mpv') switchToMpv(me);
    else if (c === 'vlc') openInVlc(me);
    else sess.command(c, a);
  });
  engine.on('message', (a) => {
    if (a[0] === 'dflix-next') sess.command('next'); else if (a[0] === 'dflix-prev') sess.command('prev'); else if (a[0] === 'dflix-quality') sess.command('quality');
  });
  engine.on('playerror', (m) => toast('Play nahi hua: ' + m));
  engine.on('error', (e) => { if (player === me) { console.error('mpv error', e.message); fallback(); } });
  engine.on('closed', () => {
    sess.onClosed();
    if (player !== me) return;
    if (engine instanceof MpvEngine && !engine.everReady && Date.now() - t0 < 10000 && !quitting) return fallback();
    player = null; updateActive(); runJs('try{if(window.onAppResumed)onAppResumed()}catch(e){}');
  });
  function fallback() {
    if (player !== me) return;
    player = null; try { engine.kill(); } catch (e) { /* ignore */ }
    toast('mpv chal nahi paya - D-FLIX player khul raha hai');
    launchPlayer(sess.exportReq(), 'web');
  }
  updateActive();
  await sess.start(req);
}

function switchToMpv(me) {
  if (player !== me) return;
  if (!findMpv(mpvDirs())) return me.engine.osd('mpv.exe nahi mila - vendor\\mpv folder me rakhein');
  const req = me.session.exportReq();
  closePlayer();                      // position save ho jati hai, resume wahin se
  launchPlayer(req, 'mpv');
}

async function openInVlc(me) {
  if (player !== me) return;
  const parent = me.engine.win && !me.engine.win.isDestroyed() ? me.engine.win : win;
  let exe = vlc.findVlc(vlcDirs(), store.getItem('settings', 'vlcPath', null));
  if (!exe) {
    const r = await dialog.showMessageBox(parent, { type: 'question', title: 'D-FLIX', buttons: ['VLC download karein', 'vlc.exe chunein', 'Cancel'], defaultId: 0, cancelId: 2,
      message: 'VLC install nahi mila.', detail: 'VLC install kar lein, ya agar pehle se hai to vlc.exe ki jagah chun dein.' });
    if (r.response === 0) shell.openExternal('https://www.videolan.org/vlc/');
    if (r.response !== 1) return;
    const o = await dialog.showOpenDialog(parent, { title: 'vlc.exe chunein', properties: ['openFile'], filters: [{ name: 'vlc.exe', extensions: ['exe'] }] });
    if (o.canceled || !o.filePaths[0] || !fs.existsSync(o.filePaths[0])) return;
    exe = o.filePaths[0];
    store.setItem('settings', 'vlcPath', exe);
  }
  if (player !== me) return;
  const s = me.session;
  try {
    me.engine.osd('VLC me khul raha hai...');
    s.savePos();
    await vlc.openStream(exe, s.currentUrl(), s.shownTitle(), s.pos);
  } catch (e) {
    store.removeItem('settings', 'vlcPath');
    return me.engine.osd('VLC khul nahi paya: ' + (e && e.message ? e.message : e));
  }
  setTimeout(() => { if (player === me) { closePlayer(); updateActive(); runJs('try{if(window.onAppResumed)onAppResumed()}catch(e){}'); } }, 900);
}

// ---------- IPC: localStorage shim ----------
ipcMain.on('ls:all', (e) => { e.returnValue = store.all('webls'); });
ipcMain.on('ls:set', (e, k, v) => store.setItem('webls', k, v));
ipcMain.on('ls:del', (e, k) => store.removeItem('webls', k));
ipcMain.on('ls:clear', () => store.clear('webls'));

// ---------- IPC: Android bridge ----------
const cb = (name, obj) => runJs(name + '(' + JSON.stringify(obj) + ');');
const err = (name, e) => cb(name, { error: String((e && e.message) || e || 'unknown_error').replace(/"/g, "'") });

async function collectFilesRecursive(token, folderId, out, depth, pathSoFar) {
  if (depth > 8) return;
  const files = (await drive.listFiles(token, folderId)).files || [];
  for (const f of files) {
    if (f.mimeType === 'application/vnd.google-apps.folder') await collectFilesRecursive(token, f.id, out, depth + 1, pathSoFar.concat([f.name]));
    else { f.subPath = pathSoFar; out.push(f); }
  }
}
function queueDownloads(queued, folderName) {
  if (!queued.length) return toast('No Content found..');
  runJs('onFolderDownloadQueued(' + q(JSON.stringify(queued)) + ',' + q(folderName) + ');');
  queued.forEach((f) => downloads.start(f.id, f.name));
}

const syncApi = {
  isLoggedIn: () => tokens.isLoggedIn(),
  getUserName: () => presence.getName(),
  isBlocked: () => presence.isBlocked(),
  isNetworkAvailable: () => { try { return enet.isOnline(); } catch (e) { return true; } },
  getHistory: () => JSON.stringify(history.getAll()),
  getPlayState: (id) => JSON.stringify(history.playState(id)),
  getQualityPref: (k) => history.getQualityPref(k),
  getNotifications: () => JSON.stringify(notify.getAll()),
};
const asyncApi = {
  saveUserName: (n) => presence.saveName(n),
  login: () => shell.openExternal(tokens.authUrl()),
  logout: () => { tokens.logout(); drive.invalidateFolderCache(); },
  async listFiles(folderId, cbName) {
    try { const t = await tokens.getValidAccessToken(); cb(cbName, t ? await drive.listFiles(t, folderId) : { error: 'not_logged_in' }); } catch (e) { err(cbName, e); }
  },
  async searchFiles(kw, cbName) {
    try { const t = await tokens.getValidAccessToken(); cb(cbName, t ? await drive.searchFiles(t, kw) : { error: 'not_logged_in' }); } catch (e) { err(cbName, e); }
  },
  async resolvePoster(raw, reqId) { const r = await tmdb.resolvePoster(raw); runJs('onPosterResolved(' + q(reqId) + ',' + q(r.dataUrl || r.url) + ');'); },
  async resolveBackdrop(raw, reqId) { const r = await tmdb.resolveBackdrop(raw); runJs('onPosterResolved(' + q(reqId) + ',' + q(r.dataUrl || r.url) + ');'); },
  savePosterFile: (k, d) => { try { tmdb.savePoster(k, d); } catch (e) { console.error(e.message); } },
  async saveCustomPosterFile(k, url, reqId) { const ok = await tmdb.saveCustomPoster(k, url); runJs('onCustomPosterSaved(' + q(reqId) + ',' + ok + ');'); },
  deletePosterFile: (k) => tmdb.deletePoster(k),
  openFile: (id, name) => launchPlayer({ fileId: id, fileName: name }),
  openFileEx: (id, name, meta) => launchPlayer({ fileId: id, fileName: name, metaJson: meta }),
  removeHistory: (k) => history.remove(k),
  clearHistory: () => history.clearAll(),
  clearPlayState: (id) => history.clearPlayState(id),
  async getFolderChain(startId, cbName) {
    try {
      const t = await tokens.getValidAccessToken();
      if (!t) return cb(cbName, { error: 'not_logged_in' });
      const chain = []; let cur = startId;
      for (let i = 0; i < 8 && cur; i++) {
        const m = await drive.getMeta(t, cur);
        if (m.mimeType === 'application/vnd.google-apps.folder') chain.push({ id: cur, name: m.name || '' });
        if (cur === drive.LOCKED_ROOT_FOLDER_ID) break;
        cur = m.parents && m.parents.length ? m.parents[0] : null;
      }
      cb(cbName, { chain });
    } catch (e) { err(cbName, e); }
  },
  async resolveMulti(folderId, h, cbName) {
    try { const t = await tokens.getValidAccessToken(); cb(cbName, t ? await drive.resolveMulti(t, folderId, h) : { error: 'not_logged_in' }); } catch (e) { err(cbName, e); }
  },
  setQualityPref: (k, h) => history.setQualityPref(k, h),
  openHtmlFile(fileId, fileName, folderId) {
    if (htmlWin && !htmlWin.isDestroyed()) htmlWin.close();
    htmlWin = new BrowserWindow({ width: 1100, height: 760, icon: ICON, title: fileName || 'D-FLIX', autoHideMenuBar: true, backgroundColor: '#fff',
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
    htmlWin.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('http://127.0.0.1:' + server.PORT + '/page/')) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); } });
    htmlWin.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
    htmlWin.loadURL(server.pageUrl(folderId, fileName));
  },
  downloadFile: (id, name) => downloads.start(id, name),
  cancelDownload: (id) => downloads.cancel(id),
  pauseDownload: (id) => downloads.pause(id),
  deleteDownloadedFile: (id) => { downloads.cancel(id); downloads.deleteSavedFile(id); },
  async downloadFolder(folderId, folderName) {
    try {
      const t = await tokens.getValidAccessToken();
      if (!t) return toast('Please log in first');
      const out = []; await collectFilesRecursive(t, folderId, out, 0, []);
      queueDownloads(out, folderName);
    } catch (e) { toast('Folder download could not start'); }
  },
  downloadSelection(folderName, filesJson) { try { queueDownloads(JSON.parse(filesJson), folderName); } catch (e) { toast('Folder download could not start'); } },
  playLocalFile(id, name) {
    if (!downloads.isDownloaded(id)) return toast("This file hasn't been downloaded yet");
    launchPlayer({ fileId: id, fileName: name, local: true });
  },
  markNotificationsRead: () => notify.markAllRead(),
  clearNotifications: () => notify.clearAll(),
};
ipcMain.on('a:sync', (e, name, args) => {
  try { e.returnValue = syncApi[name] ? syncApi[name](...args) : null; } catch (x) { console.error(name, x.message); e.returnValue = null; }
});
ipcMain.on('a:async', (e, name, args) => {
  const fn = asyncApi[name];
  if (!fn) return;
  Promise.resolve().then(() => fn(...args)).catch((x) => console.error(name, x && x.message));
});

// ---------- app lifecycle ----------
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

// TMDB ke liye Chromium network stack (system proxy / certificates / DNS ke saath) - Node https fail ho to ye chalta hai
function chromiumGet(url, timeout) { return new Promise((resolve, reject) => {
  let done = false;
  const fin = (fn, v) => { if (!done) { done = true; clearTimeout(tm); fn(v); } };
  let req;
  try { req = enet.request({ url, method: 'GET' }); } catch (e) { return reject(e); }
  const tm = setTimeout(() => { try { req.abort(); } catch (e) { /* ignore */ } fin(reject, new Error('timeout')); }, timeout || 10000);
  req.on('response', (res) => {
    const parts = [];
    res.on('data', (d) => parts.push(d));
    res.on('end', () => fin(resolve, { status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
    res.on('error', (e) => fin(reject, e));
  });
  req.on('error', (e) => fin(reject, e));
  req.end();
}); }
tmdb.setChromiumGet(chromiumGet);

app.whenReady().then(async () => {
  try { dcrypto.init(safeStorage); }
  catch (e) { dialog.showErrorBox('D-FLIX', 'Data folder khul nahi raha (kisi dusre PC/user ka data hai).\n\n' + e.message + '\n\n"data" folder hata kar dobara chalaiye.'); return app.quit(); }

  downloads.setNotifier(runJs, () => presence.isBlockedCached());
  try {
    await server.start({
      ok() { runJs('onLoginComplete(true);'); if (win) { win.show(); win.focus(); } drive.warmFolderCache(null); tokens.getValidAccessToken().then(drive.warmFolderCache); presence.syncNow(); },
      fail() { runJs('onLoginComplete(false);'); },
    });
  } catch (e) {
    dialog.showErrorBox('D-FLIX', 'Port ' + server.PORT + ' pehle se kisi aur app ne le rakha hai (D-FLIX ka dusra copy?).\nUse band karke dobara chalaiye.');
    return app.quit();
  }
  createWindow();
  const scr = screen.getPrimaryDisplay().size;
  presence.ensureStarted({
    getInfo: () => device.info(updater.currentVersion(__dirname, app.getVersion()), scr.width + 'x' + scr.height),
    onBlockedChange: (b) => { runJs('try{onBlockedChanged(' + b + ')}catch(e){}'); if (b) closePlayer(); },
  });
  updater.start({
    root: __dirname, appVersion: app.getVersion(), chromiumGet,
    log: (m) => console.log('[D-FLIX] ' + m),
    isPlaying: () => !!player,
    toast: (m) => toast(m),
    restart: () => { app.relaunch(); app.quit(); },
    ask: async (u) => {
      const r = await dialog.showMessageBox(win && !win.isDestroyed() ? win : null, { type: 'info', title: 'D-FLIX Update', buttons: ['Abhi update karein', 'Baad me'], defaultId: 0, cancelId: 1,
        message: 'Naya version ' + u.version + ' available hai (aapka: ' + u.current + ')', detail: (u.notes ? u.notes + '\n\n' : '') + 'Update ke baad app khud restart hoga (chalta video band ho jayega).' });
      return r.response === 0;
    },
  });
  notify.ensureStarted({
    show: (n) => { try { if (Notification.isSupported()) new Notification({ title: n.title, body: n.body, icon: ICON }).show(); } catch (e) { /* ignore */ } },
    push: (n) => runJs('try{onPushNotification(' + q(JSON.stringify(n)) + ')}catch(e){}'),
    remove: (id) => runJs('try{onNotificationRemoved(' + q(id) + ')}catch(e){}'),
  });
  tokens.getValidAccessToken().then((t) => { if (t) drive.warmFolderCache(t); });
  const mpv = findMpv(mpvDirs());
  console.log('[D-FLIX] data folder:', paths.dataDir);
  console.log('[D-FLIX] player:', mpv ? 'mpv (' + mpv + ')' : 'built-in HTML5 (mpv.exe nahi mila)');
});

app.on('window-all-closed', () => app.quit());
let cleaned = false;
app.on('before-quit', (e) => {
  quitting = true;
  if (cleaned) return;
  e.preventDefault(); cleaned = true;
  closePlayer();
  store.flushAll();
  streamcache.closeAll();
  const done = () => { store.flushAll(); app.exit(0); };
  Promise.race([presence.goOffline(), new Promise((r) => setTimeout(r, 1500))]).then(() => {
    try { electron.session.defaultSession.clearCache().then(done, done); } catch (x) { done(); }
  });
});
