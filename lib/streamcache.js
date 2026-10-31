'use strict';
// StreamCache.java ka port: 4 MB chunks, 3 parallel Drive connections, read-ahead.
// Naya: har chunk disk par ENCRYPTED (random session key, sirf memory me) - leftover files bekar hain.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const drive = require('./drive');
const tokens = require('./tokens');
const dcrypto = require('./crypto');
const paths = require('./paths');

const CHUNK = 4 * 1024 * 1024;
const WORKERS = 3;
const AHEAD = 30;
const SESSION_MAX = 400 * 1024 * 1024;
const TOTAL_MAX = 1024 * 1024 * 1024;
const IDLE_MS = 90 * 1000;
const NONE = 0, LOADING = 1, DONE = 2, FAILED = 3;

const sessions = new Map();
let root = null;

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) {} }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function open(fileId, size) {
  if (!root) {
    root = paths.p('cache', 'stream');
    rmrf(root); fs.mkdirSync(root, { recursive: true });
  }
  const key = fileId + '_' + size;
  let s = sessions.get(key);
  if (s && !s.closed) s.lastUse = Date.now();
  else { s = new Session(key, fileId, size, path.join(root, key.replace(/[^A-Za-z0-9_\-]/g, '_'))); sessions.set(key, s); }
  for (const o of sessions.values()) if (o !== s) o.parked = true;
  trim(s);
  s.begin();
  return s;
}
function trim(keep) {
  for (;;) {
    let total = 0, oldest = null;
    for (const o of sessions.values()) {
      total += o.cachedBytes;
      if (o !== keep && (!oldest || o.lastUse < oldest.lastUse)) oldest = o;
    }
    if (total <= TOTAL_MAX || !oldest) return;
    oldest.close(); sessions.delete(oldest.key);
  }
}
function closeAll() { for (const s of sessions.values()) s.close(); sessions.clear(); if (root) rmrf(root); }

class Session {
  constructor(key, fileId, size, dir) {
    this.key = key; this.fileId = fileId; this.size = size; this.dir = dir;
    this.count = Math.ceil(size / CHUNK);
    this.enc = crypto.randomBytes(32);          // sirf RAM me
    this.nonce = crypto.randomBytes(8);
    this.chunks = [];
    for (let i = 0; i < this.count; i++) {
      const iv = Buffer.alloc(16); this.nonce.copy(iv, 0); iv.writeUInt32BE(i, 8);
      this.chunks.push({ state: NONE, bytes: 0, length: Math.min(CHUNK, size - i * CHUNK), file: path.join(dir, i + '.chk'), iv });
    }
    this.urgent = []; this.cachedBytes = 0;
    this.closed = false; this.parked = false; this.lastUse = Date.now();
    this.head = 0; this.gen = 0; this.live = 0; this.started = false;
    this.waiters = [];
  }
  notify() { const w = this.waiters; this.waiters = []; w.forEach((f) => f()); }
  wait(ms) { return new Promise((res) => { const t = setTimeout(res, ms); this.waiters.push(() => { clearTimeout(t); res(); }); }); }

  begin() {
    fs.mkdirSync(this.dir, { recursive: true });
    this.parked = false; this.lastUse = Date.now();
    if (!this.started) {
      this.started = true;
      this.urgent.push(0);
      if (this.count > 1) this.urgent.push(this.count - 1);
      if (this.count > 2) this.urgent.push(1);
    }
    this.ensureWorkers(); this.notify();
  }
  ensureWorkers() {
    while (this.live < WORKERS && !this.closed) { this.live++; this.worker().finally(() => { this.live--; }); }
  }
  close() { this.closed = true; this.notify(); rmrf(this.dir); this.cachedBytes = 0; }

  pick() {
    while (this.urgent.length) {
      const i = this.urgent.shift();
      if (i >= 0 && i < this.count && this.chunks[i].state === NONE) { this.chunks[i].state = LOADING; return i; }
    }
    const last = Math.min(this.count - 1, this.head + AHEAD);
    for (let i = Math.max(0, this.head); i <= last; i++) {
      if (this.chunks[i].state === NONE) { this.chunks[i].state = LOADING; return i; }
    }
    return -1;
  }
  async worker() {
    for (;;) {
      let ci = -1;
      for (;;) {
        if (this.closed || this.parked || Date.now() - this.lastUse > IDLE_MS) return;
        ci = this.pick();
        if (ci >= 0) break;
        await this.wait(1000);
      }
      try { await this.downloadChunk(ci); } catch (e) { console.error('chunk worker', e.message); }
    }
  }

  async downloadChunk(ci) {
    const c = this.chunks[ci];
    for (let attempt = 1; !this.closed; attempt++) {
      let ws = null;
      try {
        const token = await tokens.getValidAccessToken();
        if (!token) throw new Error('not logged in');
        const chunkStart = ci * CHUNK;
        const from = chunkStart + c.bytes, to = chunkStart + c.length - 1;
        const res = await drive.openFileStream(token, this.fileId, 'bytes=' + from + '-' + to);
        const whole = res.statusCode === 200 && from === 0 && c.length === this.size;
        if (res.statusCode !== 206 && !whole) { res.resume(); throw new Error('HTTP ' + res.statusCode); }
        fs.mkdirSync(this.dir, { recursive: true });
        const cipher = dcrypto.ctrAt(this.enc, c.iv, c.bytes);
        ws = fs.createWriteStream(c.file, { flags: c.bytes > 0 ? 'a' : 'w' });
        await new Promise((resolve, reject) => {
          let got = 0; const need = c.length - c.bytes;
          ws.on('error', reject);
          res.on('error', reject);
          res.on('data', (d) => {
            if (this.closed) { res.destroy(); return resolve(); }
            if (got + d.length > need) d = d.subarray(0, need - got);
            got += d.length;
            const e = cipher.update(d);
            ws.write(e, () => { c.bytes += e.length; this.notify(); });
            if (got >= need) res.destroy();
          });
          res.on('close', () => ws.end(() => resolve()));
        });
        if (this.closed) return;
        if (c.bytes < c.length) throw new Error('short chunk');
        c.state = DONE; this.cachedBytes += c.length; this.evict(); this.notify();
        return;
      } catch (e) {
        if (ws) try { ws.destroy(); } catch (x) {}
        // writes pending ho sakte hain: bytes ko file size se sync karo
        try { c.bytes = fs.existsSync(c.file) ? fs.statSync(c.file).size : 0; } catch (x) { c.bytes = 0; }
        if (attempt >= 4 || this.closed) { c.state = FAILED; this.notify(); return; }
        await sleep(1000 << (attempt - 1));
      }
    }
  }

  evict() {
    while (this.cachedBytes > SESSION_MAX) {
      let worst = -1, wd = -1;
      for (let i = 0; i < this.count; i++) {
        const c = this.chunks[i];
        if (c.state !== DONE || i === 0 || i >= this.count - 2) continue;
        if (i >= this.head - 2 && i <= this.head + AHEAD) continue;
        const d = i < this.head ? (this.head - i) * 2 : i - this.head;
        if (d > wd) { wd = d; worst = i; }
      }
      if (worst < 0) return;
      const w = this.chunks[worst];
      try { fs.unlinkSync(w.file); } catch (e) {}
      w.state = NONE; w.bytes = 0; this.cachedBytes -= w.length;
    }
  }

  /** bytes [start..end] ko res (writable) me bhejta hai. isAlive() false => client chala gaya. */
  async serve(res, start, end, isAlive) {
    this.parked = false; this.lastUse = Date.now();
    const myGen = ++this.gen;
    this.head = Math.floor(start / CHUNK);
    this.ensureWorkers(); this.notify();
    let pos = start, lastCi = -1;
    while (pos <= end) {
      if (this.closed) throw new Error('closed');
      if (isAlive && !isAlive()) return;
      const ci = Math.floor(pos / CHUNK), c = this.chunks[ci];
      if (ci !== lastCi) {
        lastCi = ci; this.lastUse = Date.now(); this.parked = false;
        if (myGen === this.gen) this.head = ci;
        this.ensureWorkers(); this.notify();
      }
      const inChunk = pos - ci * CHUNK;
      const t0 = Date.now(); let retries = 0;
      while (!(c.state === DONE || c.bytes > inChunk)) {
        if (this.closed) throw new Error('closed');
        if (isAlive && !isAlive()) return;
        if (c.state === FAILED) {
          if (++retries > 2) throw new Error('chunk ' + ci + ' failed');
          try { fs.unlinkSync(c.file); } catch (e) {}
          c.bytes = 0; c.state = NONE;
        }
        if (c.state === NONE && !this.urgent.includes(ci)) this.urgent.push(ci);
        this.notify();
        await this.wait(500);
        if (Date.now() - t0 > 60000) throw new Error('timeout');
      }
      const avail = c.state === DONE ? c.length : c.bytes;
      const upto = Math.min(end, ci * CHUNK + avail - 1);
      const fd = fs.openSync(c.file, 'r');
      try {
        const dec = dcrypto.ctrAt(this.enc, c.iv, inChunk);
        const buf = Buffer.alloc(64 * 1024);
        let left = upto - pos + 1, filePos = inChunk;
        while (left > 0) {
          if (isAlive && !isAlive()) return;
          const n = fs.readSync(fd, buf, 0, Math.min(buf.length, left), filePos);
          if (n <= 0) break;
          const out = dec.update(buf.subarray(0, n));
          filePos += n; pos += n; left -= n;
          if (!res.write(out)) await new Promise((r) => { const done = () => { res.removeListener('drain', done); res.removeListener('close', done); r(); }; res.on('drain', done); res.on('close', done); });
        }
      } finally { fs.closeSync(fd); }
    }
  }
}

module.exports = { open, closeAll, CHUNK };
