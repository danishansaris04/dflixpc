'use strict';
// LocalDownloadManager.java ka port. Downloads data/downloads/ me ENCRYPTED (.dflx) save hote hain,
// file ke naam bhi random-jaise (movie ka naam disk par dikhta nahi). Queue: ek waqt me ek file, pause/resume.
const fs = require('fs');
const crypto = require('crypto');
const paths = require('./paths');
const dcrypto = require('./crypto');
const drive = require('./drive');
const tokens = require('./tokens');

const H = dcrypto.FILE_HEADER;
let notify = () => {};
let isBlocked = () => false;
const queue = new Map();      // fileId -> fileName
const pending = new Set();
let active = null;            // {fileId, cancelled, paused, req}

function setNotifier(fn, blockedFn) { notify = fn; if (blockedFn) isBlocked = blockedFn; }
const js = (name, ...args) => notify(name + '(' + args.map((a) => JSON.stringify(a)).join(',') + ');');

function fileFor(fileId) {
  const h = crypto.createHmac('sha256', dcrypto.sub('names')).update(String(fileId)).digest('hex').slice(0, 32);
  return paths.p('downloads', h + '.dflx');
}
const partFor = (id) => fileFor(id) + '.part';
function isDownloaded(id) { return fs.existsSync(fileFor(id)); }
function deleteSavedFile(id) {
  for (const f of [fileFor(id), partFor(id)]) try { fs.unlinkSync(f); } catch (e) {}
}

function start(fileId, fileName) {
  if (pending.has(fileId)) return;
  pending.add(fileId); queue.set(fileId, fileName);
  next();
}
function cancel(fileId) {
  if (active && active.fileId === fileId) { active.cancelled = true; abortActive(); return; }
  if (queue.has(fileId)) { queue.delete(fileId); pending.delete(fileId); js('onDownloadCancelled', fileId); }
}
function pause(fileId) {
  if (active && active.fileId === fileId) { active.paused = true; abortActive(); return; }
  if (queue.has(fileId)) { queue.delete(fileId); pending.delete(fileId); js('onDownloadPaused', fileId); }
}
function abortActive() { try { if (active && active.res) active.res.destroy(); } catch (e) {} }

function next() {
  if (active || !queue.size) return;
  const [fileId, fileName] = queue.entries().next().value;
  queue.delete(fileId);
  active = { fileId, fileName, cancelled: false, paused: false, res: null };
  run(active).catch((e) => console.error('download fatal', e)).finally(() => {
    pending.delete(fileId); active = null; next();
  });
}

async function run(t) {
  const out = fileFor(t.fileId), tmp = partFor(t.fileId);
  try {
    if (isBlocked()) throw new Error('Blocked by admin');
    const token = await tokens.getValidAccessToken();
    if (!token) throw new Error('Not logged in');
    const info = await drive.resolveFileInfo(token, t.fileId);
    let have = 0, iv;
    if (fs.existsSync(tmp) && fs.statSync(tmp).size >= H) {
      const fd = fs.openSync(tmp, 'r'); const hb = Buffer.alloc(H); fs.readSync(fd, hb, 0, H, 0); fs.closeSync(fd);
      iv = dcrypto.parseFileHeader(hb).iv;
      have = fs.statSync(tmp).size - H;
      if (info.size > 0 && have > info.size) { have = 0; fs.unlinkSync(tmp); }
    }
    if (have === 0) {
      const nh = dcrypto.newFileHeader(info.size);
      iv = nh.iv; fs.writeFileSync(tmp, nh.header);
    }
    const res = await drive.openFileStream(token, info.id, have > 0 ? 'bytes=' + have + '-' : null);
    t.res = res;
    if (have > 0 && res.statusCode === 200) {            // Range ignore hui -> shuru se
      res.destroy(); fs.unlinkSync(tmp); have = 0;
      const nh = dcrypto.newFileHeader(info.size); iv = nh.iv; fs.writeFileSync(tmp, nh.header);
      t.res = await drive.openFileStream(token, info.id, null);
    }
    const r2 = t.res;
    if (r2.statusCode !== 200 && r2.statusCode !== 206) { r2.resume(); throw new Error('HTTP ' + r2.statusCode); }
    const clen = parseInt(r2.headers['content-length'] || '0', 10) || 0;
    const total = info.size > 0 ? info.size : (clen ? have + clen : 0);

    const cipher = dcrypto.ctrAt(dcrypto.fileKey(), iv, have);
    const ws = fs.createWriteStream(tmp, { flags: 'a' });
    let received = have, last = Date.now(), since = 0;
    js('onDownloadProgress', t.fileId, received, total, 0);
    await new Promise((resolve, reject) => {
      ws.on('error', reject);
      r2.on('error', (e) => (t.cancelled || t.paused ? resolve() : reject(e)));
      r2.on('data', (d) => {
        if (t.cancelled || t.paused) return;
        received += d.length; since += d.length;
        if (!ws.write(cipher.update(d))) { r2.pause(); ws.once('drain', () => r2.resume()); }
        const now = Date.now();
        if (now - last >= 500) {
          js('onDownloadProgress', t.fileId, received, total, Math.round(since / ((now - last) / 1000)));
          last = now; since = 0;
        }
      });
      r2.on('close', () => ws.end(resolve));
    });

    if (t.cancelled) { try { fs.unlinkSync(tmp); } catch (e) {} return js('onDownloadCancelled', t.fileId); }
    if (t.paused) { js('onDownloadProgress', t.fileId, received, total || received, 0); return js('onDownloadPaused', t.fileId); }
    if (total > 0 && received < total) throw new Error('connection dropped');
    if (!total) { const fd = fs.openSync(tmp, 'r+'); const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(received)); fs.writeSync(fd, b, 0, 8, 24); fs.closeSync(fd); }
    fs.renameSync(tmp, out);
    js('onDownloadProgress', t.fileId, received, total || received, 0);
    js('onDownloadComplete', t.fileId);
  } catch (e) {
    if (t.cancelled) { try { fs.unlinkSync(tmp); } catch (x) {} return js('onDownloadCancelled', t.fileId); }
    if (t.paused) return js('onDownloadPaused', t.fileId);
    console.error('Download failed', t.fileName, e.message);
    js('onDownloadError', t.fileId, e.message || 'unknown_error');
  }
}

module.exports = { setNotifier, start, cancel, pause, fileFor, isDownloaded, deleteSavedFile };
