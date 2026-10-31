'use strict';
// LocalServer.java ka port: 127.0.0.1:8765
//  /oauth2callback  /stream/{id}  /local/{id} (downloaded, decrypt-on-the-fly)  /play/{id}  /poster/{key}  /page/{folder}/{file}  /sub/{id}
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const { URL } = require('url');
const tokens = require('./tokens');
const drive = require('./drive');
const streamcache = require('./streamcache');
const downloads = require('./downloads');
const dcrypto = require('./crypto');
const tmdb = require('./tmdb');
const presence = require('./presence');

const PORT = tokens.PORT;
const SESSION_KEY = crypto.randomBytes(16).toString('hex'); // sirf is run ke liye
let authListener = { ok() {}, fail() {} };
let server = null;

function mediaType(n) {
  const l = (n || '').toLowerCase();
  const m = { mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', '3gp': 'video/3gpp', mov: 'video/quicktime', ts: 'video/mp2t',
    mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/x-wav', amr: 'audio/amr', avi: 'video/x-msvideo' };
  const ext = l.slice(l.lastIndexOf('.') + 1);
  return m[ext] || 'video/x-matroska';
}
function pageType(n) {
  const l = n.toLowerCase();
  const m = { html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'application/javascript; charset=utf-8',
    mjs: 'application/javascript; charset=utf-8', json: 'application/json; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg',
    jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon', woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf',
    mp4: 'video/mp4', mp3: 'audio/mpeg', xml: 'application/xml; charset=utf-8', txt: 'text/plain; charset=utf-8' };
  return m[l.slice(l.lastIndexOf('.') + 1)] || 'application/octet-stream';
}
function simple(res, code, type, body) {
  const b = Buffer.from(body, 'utf8');
  res.writeHead(code, { 'Content-Type': type + '; charset=utf-8', 'Content-Length': b.length, Connection: 'close' });
  res.end(b);
}
function parseRange(h, size) {
  let start = 0, end = size - 1, partial = false;
  if (h && /^bytes=/i.test(h)) {
    let spec = h.slice(6).trim(); const c = spec.indexOf(','); if (c >= 0) spec = spec.slice(0, c);
    const d = spec.indexOf('-');
    try {
      if (d === 0) start = Math.max(0, size - parseInt(spec.slice(1), 10));
      else if (d > 0) { start = parseInt(spec.slice(0, d), 10); const e = spec.slice(d + 1).trim(); if (e) end = Math.min(size - 1, parseInt(e, 10)); }
      if (Number.isNaN(start) || Number.isNaN(end)) throw new Error('bad');
      partial = true;
    } catch (e) { start = 0; end = size - 1; partial = false; }
  }
  return { start, end, partial };
}
function sendRangeHead(res, size, r, type) {
  const h = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': r.end - r.start + 1, Connection: 'close', 'Cache-Control': 'no-store' };
  if (r.partial) h['Content-Range'] = 'bytes ' + r.start + '-' + r.end + '/' + size;
  res.writeHead(r.partial ? 206 : 200, h);
}
function guardSession(u) { return u.searchParams.get('k') === SESSION_KEY; }

async function handleOAuth(u, res) {
  const code = u.searchParams.get('code');
  if (!code) { simple(res, 400, 'text/html', '<h2>Login failed. No code received.</h2>'); return authListener.fail('no_code'); }
  const ok = await tokens.exchangeCode(code);
  if (ok) {
    simple(res, 200, 'text/html', "<html><body style='font-family:sans-serif;text-align:center;margin-top:60px;background:#0b0b10;color:#fff'><h2>Login successful \u2705</h2><p>Ab D-FLIX app me wapas jaiye. Ye tab band kar sakte hain.</p></body></html>");
    authListener.ok();
  } else { simple(res, 500, 'text/html', '<h2>Login failed while exchanging token.</h2>'); authListener.fail('exchange_failed'); }
}

async function handleStream(u, req, res) {
  if (!guardSession(u)) return simple(res, 403, 'text/plain', 'Forbidden');
  if (presence.isBlockedCached()) return simple(res, 403, 'text/plain', 'Blocked by admin');
  const fileId = decodeURIComponent(u.pathname.slice('/stream/'.length));
  const name = u.searchParams.get('n') || '';
  const token = await tokens.getValidAccessToken();
  if (!token) return simple(res, 401, 'text/plain', 'Not logged in');
  const info = await drive.resolveFileInfo(token, fileId);
  const type = mediaType(name);
  let alive = true; res.on('close', () => { alive = false; });
  if (info.size > 0) {
    const r = parseRange(req.headers.range, info.size);
    if (r.start >= info.size || r.start > r.end) {
      res.writeHead(416, { 'Content-Range': 'bytes */' + info.size, 'Content-Length': 0, Connection: 'close' }); return res.end();
    }
    const session = streamcache.open(info.id, info.size);
    sendRangeHead(res, info.size, r, type);
    try { await session.serve(res, r.start, r.end, () => alive); } catch (e) { if (alive) res.destroy(); return; }
    return res.end();
  }
  const up = await drive.openFileStream(token, info.id, req.headers.range || null);
  if (up.statusCode !== 200 && up.statusCode !== 206) { up.resume(); return simple(res, up.statusCode, 'text/plain', 'Drive error: ' + up.statusCode); }
  const h = { 'Content-Type': type, 'Accept-Ranges': 'bytes', Connection: 'close' };
  if (up.headers['content-range']) h['Content-Range'] = up.headers['content-range'];
  if (up.headers['content-length']) h['Content-Length'] = up.headers['content-length'];
  res.writeHead(up.statusCode, h);
  res.on('close', () => up.destroy());
  up.pipe(res);
}

async function handleLocal(u, req, res) {
  if (!guardSession(u)) return simple(res, 403, 'text/plain', 'Forbidden');
  if (presence.isBlockedCached()) return simple(res, 403, 'text/plain', 'Blocked by admin');
  const id = decodeURIComponent(u.pathname.slice('/local/'.length));
  const file = downloads.fileFor(id);
  if (!fs.existsSync(file)) return simple(res, 404, 'text/plain', 'Not downloaded');
  const hb = Buffer.alloc(dcrypto.FILE_HEADER); const fd = fs.openSync(file, 'r'); fs.readSync(fd, hb, 0, hb.length, 0); fs.closeSync(fd);
  const size = dcrypto.parseFileHeader(hb).size || Math.max(0, fs.statSync(file).size - dcrypto.FILE_HEADER);
  const r = parseRange(req.headers.range, size);
  if (r.start >= size || r.start > r.end) { res.writeHead(416, { 'Content-Range': 'bytes */' + size, 'Content-Length': 0 }); return res.end(); }
  sendRangeHead(res, size, r, mediaType(u.searchParams.get('n') || ''));
  let alive = true; res.on('close', () => { alive = false; });
  try { await dcrypto.readEncryptedRange(file, r.start, r.end, res, () => alive); } catch (e) { res.destroy(); return; }
  res.end();
}

// multi-quality folder -> real file: 302 redirect (player ko seedha file milti hai)
async function handlePlay(u, res) {
  if (!guardSession(u)) return simple(res, 403, 'text/plain', 'Forbidden');
  const id = decodeURIComponent(u.pathname.slice('/play/'.length));
  const token = await tokens.getValidAccessToken();
  if (!token) return simple(res, 401, 'text/plain', 'Not logged in');
  const h = parseInt(u.searchParams.get('h') || '0', 10) || 0;
  const r = await drive.resolveMulti(token, id, h);
  res.writeHead(302, { Location: '/stream/' + encodeURIComponent(r.fileId) + '?n=' + encodeURIComponent(r.fileName || '') + '&k=' + SESSION_KEY, 'Content-Length': 0 });
  res.end();
}

async function handlePage(u, req, res) {
  const cookie = /(?:^|;\s*)dk=([a-f0-9]+)/.exec(req.headers.cookie || '');
  if (!guardSession(u) && !(cookie && cookie[1] === SESSION_KEY)) return simple(res, 403, 'text/plain', 'Forbidden');
  if (presence.isBlockedCached()) return simple(res, 403, 'text/plain', 'Blocked by admin');
  const rest = u.pathname.slice('/page/'.length);
  const slash = rest.indexOf('/');
  if (slash < 0) return simple(res, 400, 'text/plain', 'Bad request');
  const folderId = decodeURIComponent(rest.slice(0, slash)), fileName = decodeURIComponent(rest.slice(slash + 1));
  const token = await tokens.getValidAccessToken();
  if (!token) return simple(res, 401, 'text/plain', 'Not logged in');
  let fid = await drive.findFileIdInFolder(token, folderId, fileName);
  if (!fid) return simple(res, 404, 'text/plain', 'Not found: ' + fileName);
  fid = await drive.resolveActualFileId(token, fid);
  const up = await drive.openFileStream(token, fid, null);
  if (up.statusCode !== 200) { up.resume(); return simple(res, up.statusCode, 'text/plain', 'Drive error: ' + up.statusCode); }
  const h = { 'Content-Type': pageType(fileName), 'Cache-Control': 'no-cache', Connection: 'close', 'Set-Cookie': 'dk=' + SESSION_KEY + '; Path=/page; HttpOnly' };
  if (up.headers['content-length']) h['Content-Length'] = up.headers['content-length'];
  res.writeHead(200, h); up.pipe(res);
}

function decodeText(buf) {
  if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return buf.toString('utf8', 3);
  if (buf[0] === 0xFF && buf[1] === 0xFE) return buf.toString('utf16le', 2);
  if (buf[0] === 0xFE && buf[1] === 0xFF) { const s = Buffer.from(buf.subarray(2)); s.swap16(); return s.toString('utf16le'); }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (e) { return new TextDecoder('windows-1252').decode(buf); }
}
async function handleSub(u, res) {
  if (!guardSession(u)) return simple(res, 403, 'text/plain', 'Forbidden');
  const id = decodeURIComponent(u.pathname.slice('/sub/'.length));
  const token = await tokens.getValidAccessToken();
  if (!token) return simple(res, 401, 'text/plain', 'Not logged in');
  const real = await drive.resolveActualFileId(token, id);
  const up = await drive.openFileStream(token, real, null);
  const chunks = []; for await (const c of up) chunks.push(c);
  if (up.statusCode !== 200) return simple(res, up.statusCode, 'text/plain', 'error');
  const text = decodeText(Buffer.concat(chunks));
  const b = Buffer.from(text, 'utf8');
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': b.length, 'Access-Control-Allow-Origin': '*' }); res.end(b);
}

function handlePoster(u, res) {
  const buf = tmdb.readPoster(decodeURIComponent(u.pathname.slice('/poster/'.length)));
  if (!buf) return simple(res, 404, 'text/plain', 'Not found');
  res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': buf.length, 'Cache-Control': 'max-age=31536000', Connection: 'close' });
  res.end(buf);
}

function start(listener) {
  if (listener) authListener = listener;
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      let u;
      try { u = new URL(req.url, 'http://127.0.0.1:' + PORT); } catch (e) { return simple(res, 400, 'text/plain', 'bad'); }
      const p = u.pathname;
      const run = (fn) => Promise.resolve().then(fn).catch((e) => {
        console.error('server error', p, e.message);
        if (!res.headersSent) simple(res, 500, 'text/plain', 'Error: ' + e.message); else res.destroy();
      });
      if (p.startsWith('/oauth2callback')) return run(() => handleOAuth(u, res));
      if (p.startsWith('/stream/')) return run(() => handleStream(u, req, res));
      if (p.startsWith('/local/')) return run(() => handleLocal(u, req, res));
      if (p.startsWith('/play/')) return run(() => handlePlay(u, res));
      if (p.startsWith('/page/')) return run(() => handlePage(u, req, res));
      if (p.startsWith('/sub/')) return run(() => handleSub(u, res));
      if (p.startsWith('/poster/')) return run(() => handlePoster(u, res));
      simple(res, 404, 'text/plain', 'Not found');
    });
    server.on('error', reject);
    server.listen(PORT, '127.0.0.1', () => resolve());
  });
}
function stop() { try { server.close(); } catch (e) {} }
const base = 'http://127.0.0.1:' + PORT;
const streamUrl = (id, name) => base + '/stream/' + encodeURIComponent(id) + '?n=' + encodeURIComponent(name || '') + '&k=' + SESSION_KEY;
const localUrl = (id, name) => base + '/local/' + encodeURIComponent(id) + '?n=' + encodeURIComponent(name || '') + '&k=' + SESSION_KEY;
const playUrl = (id, h) => base + '/play/' + encodeURIComponent(id) + '?h=' + (h || 0) + '&k=' + SESSION_KEY;
const subUrl = (id) => base + '/sub/' + encodeURIComponent(id) + '?k=' + SESSION_KEY;
const pageUrl = (folder, name) => base + '/page/' + encodeURIComponent(folder || 'root') + '/' + encodeURIComponent(name) + '?k=' + SESSION_KEY;

module.exports = { PORT, start, stop, streamUrl, localUrl, playUrl, subUrl, pageUrl };
