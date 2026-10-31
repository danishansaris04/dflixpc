'use strict';
// Stream cache v2 (RAM based): Drive se 2 MB ke chunks, parallel connections, smart read-ahead.
//  - disk par kuch nahi likhta (HDD wale purane PC par bhi lag nahi) - RAM me hi rehta hai, band hote hi gayab
//  - har active request (playback / seek / index-probe) ka apna position; read-ahead hamesha asli playback ke aage chalta hai
//  - keep-alive connections (chunk ke baad connection destroy nahi hota -> TLS handshake dobara nahi)
//  - shuru me kam connections (pehla chunk jaldi aaye), buffer bharte hi poore connections
const os = require('os');
const fs = require('fs');
const drive = require('./drive');
const tokens = require('./tokens');
const paths = require('./paths');

const CHUNK = 2 * 1024 * 1024;
const LOW_RAM = os.totalmem() < 3.2 * 1024 * 1024 * 1024;
const WORKERS = LOW_RAM ? 4 : 6;
const AHEAD = LOW_RAM ? 24 : 48;             // chunks (48 x 2MB = ~96 MB aage tak)
const BEHIND = 4;                            // chhote peeche-seek ke liye
const SESSION_MAX = (AHEAD + BEHIND + 6) * CHUNK;
const IDLE_MS = 90 * 1000;
const NONE = 0, LOADING = 1, DONE = 2, FAILED = 3;

const sessions = new Map();
let cleaned = false;

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function open(fileId, size) {
  if (!cleaned) { cleaned = true; try { rmrf(paths.p('cache', 'stream')); } catch (e) { /* purana disk cache saaf */ } }
  const key = fileId + '_' + size;
  let s = sessions.get(key);
  if (s && !s.closed) s.lastUse = Date.now();
  else { s = new Session(key, fileId, size); sessions.set(key, s); }
  // ek waqt me ek hi video: baaki ki RAM turant free
  for (const [k, o] of sessions) if (o !== s) { o.close(); sessions.delete(k); }
  s.begin();
  return s;
}
function closeAll() { for (const s of sessions.values()) s.close(); sessions.clear(); if (cleaned) rmrf(paths.p('cache', 'stream')); }

class Session {
  constructor(key, fileId, size) {
    this.key = key; this.fileId = fileId; this.size = size;
    this.count = Math.ceil(size / CHUNK);
    this.chunks = [];
    for (let i = 0; i < this.count; i++) this.chunks.push({ state: NONE, bytes: 0, length: Math.min(CHUNK, size - i * CHUNK), buf: null });
    this.urgent = []; this.cachedBytes = 0; this.inFlight = 0;
    this.active = new Set(); this.lastHead = 0;
    this.closed = false; this.lastUse = Date.now(); this.live = 0; this.started = false;
    this.waiters = [];
  }
  notify() { const w = this.waiters; this.waiters = []; w.forEach((f) => f()); }
  wait(ms) { return new Promise((res) => { const t = setTimeout(res, ms); this.waiters.push(() => { clearTimeout(t); res(); }); }); }

  begin() {
    this.lastUse = Date.now();
    if (!this.started) {
      this.started = true;
      this.urgent.push(0);
      if (this.count > 1) this.urgent.push(this.count - 1);     // mp4 moov / mkv cues aksar file ke end me hote hain
    }
    this.ensureWorkers(); this.notify();
  }
  ensureWorkers() {
    while (this.live < WORKERS && !this.closed) { this.live++; this.worker().finally(() => { this.live--; }); }
  }
  close() {
    this.closed = true; this.notify();
    this.chunks.forEach((c) => { c.buf = null; c.state = NONE; c.bytes = 0; });
    this.cachedBytes = 0;
  }

  primary() { let p = null; for (const s of this.active) if (!p || s.served > p.served) p = s; return p; }
  headChunk() { const p = this.primary(); return p ? Math.floor(p.pos / CHUNK) : this.lastHead; }
  // asli playback ke aage kitne chunk tayyar hain
  aheadReady() {
    const h = this.headChunk(); let n = 0;
    for (let i = h; i < this.count && i <= h + AHEAD; i++) { const c = this.chunks[i]; if (c.state === DONE || (c.state === LOADING && c.bytes === c.length)) n++; else break; }
    return n;
  }
  allowed() { return this.aheadReady() < 3 ? 2 : WORKERS; }   // shuru me 2 connection: pehla data jaldi aaye

  take(i) { this.chunks[i].state = LOADING; return i; }
  needs(i) { return i >= 0 && i < this.count && this.chunks[i].state === NONE; }
  pick() {
    if (this.inFlight >= this.allowed()) return -1;
    while (this.urgent.length) { const i = this.urgent.shift(); if (this.needs(i)) return this.take(i); }
    // 1) har chalte request ke agle 3 chunk (taaki seek / probe bhi atke nahi)
    const act = [...this.active].sort((a, b) => b.t - a.t);
    for (const s of act) { const b = Math.floor(s.pos / CHUNK); for (let k = 0; k < 3; k++) if (this.needs(b + k)) return this.take(b + k); }
    // 2) asli playback ke aage poora read-ahead window
    const h = this.headChunk(), last = Math.min(this.count - 1, h + AHEAD);
    for (let i = h; i <= last; i++) if (this.needs(i)) return this.take(i);
    return -1;
  }
  async worker() {
    for (;;) {
      let ci = -1;
      for (;;) {
        if (this.closed || Date.now() - this.lastUse > IDLE_MS) return;
        ci = this.pick();
        if (ci >= 0) break;
        await this.wait(800);
      }
      this.inFlight++;
      try { await this.downloadChunk(ci); } catch (e) { console.error('chunk worker', e.message); }
      this.inFlight--; this.notify();
    }
  }

  async downloadChunk(ci) {
    const c = this.chunks[ci];
    for (let attempt = 1; !this.closed; attempt++) {
      try {
        const token = await tokens.getValidAccessToken();
        if (!token) throw new Error('not logged in');
        const chunkStart = ci * CHUNK;
        const from = chunkStart + c.bytes, to = chunkStart + c.length - 1;
        const res = await drive.openFileStream(token, this.fileId, 'bytes=' + from + '-' + to);
        const whole = res.statusCode === 200 && from === 0 && c.length === this.size;
        if (res.statusCode !== 206 && !whole) { res.resume(); throw new Error('HTTP ' + res.statusCode); }
        if (!c.buf) c.buf = Buffer.allocUnsafe(c.length);
        await new Promise((resolve, reject) => {
          let got = 0, done = false; const need = c.length - c.bytes;
          const fin = (fn, v) => { if (!done) { done = true; fn(v); } };
          res.on('error', (e) => fin(reject, e));
          res.on('aborted', () => fin(reject, new Error('aborted')));
          res.on('end', () => fin(resolve));
          res.on('close', () => fin(resolve));
          res.on('data', (d) => {
            if (this.closed || !c.buf) { res.destroy(); return fin(resolve); }
            if (got + d.length > need) d = d.subarray(0, need - got);
            d.copy(c.buf, c.bytes); got += d.length;
            this._progress(c, d.length);
            if (got >= need && whole) res.destroy();    // 206 me connection khud khatam hone do (keep-alive reuse)
          });
        });
        if (this.closed) return;
        if (c.bytes < c.length) throw new Error('short chunk');
        c.state = DONE; this.cachedBytes += c.length; this.evict(); this.notify();
        return;
      } catch (e) {
        if (attempt >= 4 || this.closed) { c.state = FAILED; this.notify(); return; }
        await sleep(600 << (attempt - 1));        // resume wahin se jahan tak aaya (c.bytes)
      }
    }
  }
  _progress(c, n) { c.bytes += n; this.notify(); }

  // RAM bound: window ke bahar ke chunk farthest-first hata do
  evict() {
    if (this.cachedBytes <= SESSION_MAX) return;
    const keep = new Set([0, this.count - 1, this.count - 2]);
    const h = this.headChunk();
    for (let i = h - BEHIND; i <= h + AHEAD; i++) keep.add(i);
    for (const s of this.active) { const b = Math.floor(s.pos / CHUNK); for (let i = b - 1; i <= b + 3; i++) keep.add(i); }
    const cand = [];
    for (let i = 0; i < this.count; i++) { const c = this.chunks[i]; if (c.state === DONE && !keep.has(i)) cand.push(i); }
    cand.sort((a, b) => Math.abs(b - h) - Math.abs(a - h));
    for (const i of cand) {
      if (this.cachedBytes <= SESSION_MAX) break;
      const c = this.chunks[i]; c.buf = null; c.state = NONE; c.bytes = 0; this.cachedBytes -= c.length;
    }
  }

  /** bytes [start..end] ko res (writable) me bhejta hai. isAlive() false => client chala gaya. */
  async serve(res, start, end, isAlive) {
    const st = { pos: start, served: 0, t: Date.now() };
    this.active.add(st);
    this.lastUse = Date.now(); this.ensureWorkers(); this.notify();
    let lastCi = -1;
    try {
      while (st.pos <= end) {
        if (this.closed) throw new Error('closed');
        if (isAlive && !isAlive()) return;
        const ci = Math.floor(st.pos / CHUNK), c = this.chunks[ci];
        if (ci !== lastCi) { lastCi = ci; this.ensureWorkers(); this.notify(); }
        const inChunk = st.pos - ci * CHUNK;
        const t0 = Date.now(); let retries = 0;
        while (!(c.state === DONE || c.bytes > inChunk)) {
          if (this.closed) throw new Error('closed');
          if (isAlive && !isAlive()) return;
          if (c.state === FAILED) {
            if (++retries > 2) throw new Error('chunk ' + ci + ' failed');
            c.bytes = 0; c.buf = null; c.state = NONE;
          }
          // sirf tab jagao jab kuch naya ho (har loop me notify() karne se do requests ek dusre ko jagate rehte the)
          if (c.state === NONE && !this.urgent.includes(ci)) { this.urgent.push(ci); this.ensureWorkers(); this.notify(); }
          await this.wait(400);
          if (Date.now() - t0 > 60000) throw new Error('timeout');
        }
        const avail = c.state === DONE ? c.length : c.bytes;
        const upto = Math.min(end, ci * CHUNK + avail - 1);
        const n = upto - st.pos + 1;
        const part = c.buf.subarray(inChunk, inChunk + n);
        st.pos += n; st.served += n; st.t = Date.now(); this.lastUse = st.t;
        if (!res.write(part)) {
          await new Promise((r) => { const done = () => { res.removeListener('drain', done); res.removeListener('close', done); r(); }; res.on('drain', done); res.on('close', done); });
        }
      }
    } finally {
      this.active.delete(st);
      if (this.active.size === 0) this.lastHead = Math.min(this.count - 1, Math.floor(st.pos / CHUNK));
      this.lastUse = Date.now(); this.notify();
    }
  }
}

module.exports = { open, closeAll, CHUNK };
