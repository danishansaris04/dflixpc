'use strict';
// UI window ka bridge: Android WebView ke "Android.*" calls ko Electron IPC se jodta hai.
// Aur localStorage ko ENCRYPTED store se replace karta hai (disk par plain data nahi).
const { ipcRenderer } = require('electron');

// ---- localStorage -> encrypted store ----
const lsData = ipcRenderer.sendSync('ls:all') || {};
const ls = {
  getItem(k) { k = String(k); return Object.prototype.hasOwnProperty.call(lsData, k) ? lsData[k] : null; },
  setItem(k, v) { k = String(k); v = String(v); lsData[k] = v; ipcRenderer.send('ls:set', k, v); },
  removeItem(k) { k = String(k); delete lsData[k]; ipcRenderer.send('ls:del', k); },
  clear() { Object.keys(lsData).forEach((k) => delete lsData[k]); ipcRenderer.send('ls:clear'); },
  key(i) { return Object.keys(lsData)[i] || null; },
  get length() { return Object.keys(lsData).length; },
};
Object.defineProperty(window, 'localStorage', { value: ls, configurable: true });

// ---- Android bridge ----
const SYNC = ['isLoggedIn', 'getUserName', 'isBlocked', 'isNetworkAvailable', 'getHistory', 'getPlayState', 'getQualityPref', 'getNotifications'];
const ASYNC = ['saveUserName', 'login', 'logout', 'listFiles', 'searchFiles', 'resolvePoster', 'resolveBackdrop', 'savePosterFile',
  'saveCustomPosterFile', 'deletePosterFile', 'openFile', 'openFileEx', 'removeHistory', 'clearHistory', 'clearPlayState', 'getFolderChain',
  'resolveMulti', 'setQualityPref', 'openHtmlFile', 'downloadFile', 'cancelDownload', 'pauseDownload', 'deleteDownloadedFile',
  'downloadFolder', 'downloadSelection', 'playLocalFile', 'markNotificationsRead', 'clearNotifications'];
const Android = {};
SYNC.forEach((n) => { Android[n] = (...a) => ipcRenderer.sendSync('a:sync', n, a); });
ASYNC.forEach((n) => { Android[n] = (...a) => { ipcRenderer.send('a:async', n, a); }; });
window.Android = Android;

// main process se JS run karne ke liye
ipcRenderer.on('run-js', (e, code) => { try { (0, eval)(code); } catch (err) { console.error('run-js', err); } });

// Esc / Alt+Left = Android ka back button
window.addEventListener('keydown', (e) => {
  const t = e.target, typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
  if ((e.key === 'Escape' || (e.altKey && e.key === 'ArrowLeft') || (e.key === 'Backspace' && !typing)) && typeof window.handleBackPress === 'function') {
    try { if (window.handleBackPress() === true) e.preventDefault(); } catch (x) { /* ignore */ }
  }
}, true);
