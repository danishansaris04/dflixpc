'use strict';
// mpv engine: har video/audio format (MKV, AVI, HEVC, AC3, DTS, TrueHD, FLAC, ALAC, WMV, FLV, MP2, ...) - mpv ka built-in ffmpeg decode karta hai.
const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const EventEmitter = require('events');

function findMpv(extraDirs) {
  const names = ['mpv.exe', 'mpv.com'];
  const dirs = (extraDirs || []).concat([]);
  for (const d of dirs) for (const n of names) { const f = path.join(d, n); if (fs.existsSync(f)) return f; }
  return null;
}

class MpvEngine extends EventEmitter {
  constructor(exe, inputConf) { super(); this.exe = exe; this.inputConf = inputConf; this.proc = null; this.sock = null; this.buf = ''; this.reqId = 100; this.ready = false; this.queue = []; this.info = {}; }

  isAlive() { return !!this.proc && this.proc.exitCode === null; }

  _spawn(url, title, startSec) {
    const pipeName = 'dflix-mpv-' + crypto.randomBytes(6).toString('hex');
    this.pipe = process.platform === 'win32' ? '\\\\.\\pipe\\' + pipeName : require('os').tmpdir() + '/' + pipeName + '.sock';
    const args = [
      '--no-config', '--input-conf=' + this.inputConf, '--input-ipc-server=' + this.pipe,
      '--idle=yes', '--force-window=yes', '--keep-open=no', '--osc=yes', '--osd-level=1',
      '--title=${media-title} - D-FLIX', '--force-media-title=' + title,
      '--hwdec=auto-safe', '--cache=yes', '--demuxer-max-bytes=200MiB', '--demuxer-max-back-bytes=50MiB',
      '--network-timeout=30', '--sub-auto=fuzzy', '--screenshot-format=jpg', '--audio-display=embedded-first',
      '--volume-max=150', '--save-position-on-quit=no', '--msg-level=all=warn',
    ];
    if (startSec > 3) args.push('--start=' + Math.floor(startSec));
    args.push(url);
    this.proc = spawn(this.exe, args, { windowsHide: false, stdio: 'ignore' });
    this.proc.on('error', (e) => this.emit('error', e));
    this.proc.on('exit', () => { this.ready = false; try { this.sock && this.sock.destroy(); } catch (e) {} this.emit('closed'); });
    this._connect(0);
  }

  _connect(n) {
    if (!this.isAlive()) return;
    const s = net.connect(this.pipe);
    s.on('connect', () => {
      this.sock = s; this.ready = true; this.everReady = true;
      ['time-pos', 'duration', 'pause', 'media-title'].forEach((p, i) => this._send(['observe_property', i + 1, p]));
      this.queue.splice(0).forEach((c) => this._send(c));
      this.emit('ready');
    });
    s.on('data', (d) => this._data(d));
    s.on('error', () => { if (!this.ready && n < 60) setTimeout(() => this._connect(n + 1), 150); });
  }
  _data(d) {
    this.buf += d.toString('utf8');
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
      let m; try { m = JSON.parse(line); } catch (e) { continue; }
      this._event(m);
    }
  }
  _event(m) {
    if (m.event === 'property-change') {
      if (m.name === 'time-pos' && typeof m.data === 'number') { this.pos = m.data * 1000; this.emit('tick', this.pos, (this.dur || 0)); }
      else if (m.name === 'duration' && typeof m.data === 'number') this.dur = m.data * 1000;
    } else if (m.event === 'file-loaded') {
      this.dur = 0;
      if (this.pendingSeek > 3000) this._send(['seek', this.pendingSeek / 1000, 'absolute']);
      this.pendingSeek = 0;
      this.emit('loaded');
    } else if (m.event === 'end-file') {
      if (m.reason === 'eof') this.emit('ended');
      else if (m.reason === 'error') this.emit('playerror', m.file_error || 'play nahi ho paya');
    } else if (m.event === 'client-message' && Array.isArray(m.args)) {
      this.emit('message', m.args);
    }
  }
  _send(cmd) {
    if (!this.ready) { this.queue.push(cmd); return; }
    try { this.sock.write(JSON.stringify({ command: cmd }) + '\n'); } catch (e) { /* closed */ }
  }

  // ---- engine interface ----
  async load(url, title, startMs) {
    if (!this.isAlive()) { this.pos = 0; this._spawn(url, title, (startMs || 0) / 1000); return; }
    this.pendingSeek = startMs || 0; this.pos = 0;
    this._send(['set_property', 'force-media-title', title]);
    this._send(['loadfile', url, 'replace']);
  }
  addSub(url, label) { this._send(['sub-add', url, 'auto', label]); }
  osd(msg) { this._send(['show-text', String(msg), 3000]); }
  setInfo(info) { this.info = info; }
  quit() { this._send(['quit']); setTimeout(() => { try { this.proc && this.proc.kill(); } catch (e) {} }, 1500); }
  kill() { try { this.proc && this.proc.kill(); } catch (e) {} }
}

module.exports = { MpvEngine, findMpv };
