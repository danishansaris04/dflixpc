'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const on = (ch) => (cb) => ipcRenderer.on(ch, (e, d) => cb(d));
contextBridge.exposeInMainWorld('dp', {
  onLoad: on('dp-load'), onSub: on('dp-sub'), onOsd: on('dp-osd'), onInfo: on('dp-info'),
  send: (...a) => ipcRenderer.send('dplayer', ...a),
});
