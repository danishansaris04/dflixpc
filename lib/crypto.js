'use strict';
// Encryption layer.
//  - Master key: random 32 byte, Windows DPAPI (Electron safeStorage) se locked.
//    Data folder dusre PC / dusre Windows user par copy karne se khulta nahi.
//  - Chhoti files (token, history...): AES-256-GCM (authenticated).
//  - Badi files (video downloads, stream cache): AES-256-CTR (seekable, Range support).
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const paths = require('./paths');

const MAGIC_STORE = Buffer.from('DFS1');
const MAGIC_FILE = Buffer.from('DFLX1\0\0\0'); // 8 bytes
const FILE_HEADER = 8 + 16 + 8;                 // magic + iv + plainSize(uint64)

let master = null;
const subkeys = {};

function machineSeed() {
  let guid = '';
  try {
    const out = require('child_process').execFileSync('reg',
      ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { windowsHide: true, timeout: 5000 }).toString();
    const m = /MachineGuid\s+REG_SZ\s+(\S+)/i.exec(out);
    if (m) guid = m[1];
  } catch (e) { /* non-windows / blocked */ }
  return [guid, os.hostname(), os.userInfo().username].join('|');
}

/** safeStorage = {isEncryptionAvailable, encryptString, decryptString} ya null (tests). */
function init(safeStorage) {
  const keyFile = paths.p('store', 'master.key');
  if (fs.existsSync(keyFile)) {
    const raw = fs.readFileSync(keyFile);
    const mode = raw[0];
    const body = raw.subarray(1);
    if (mode === 1 && safeStorage) {
      master = Buffer.from(safeStorage.decryptString(body), 'base64');
    } else if (mode === 2) {
      master = crypto.scryptSync(machineSeed(), body.subarray(0, 16), 32);
      // mode 2: master seed se bana key, body = salt
    } else {
      throw new Error('master key padh nahi paye (data dusre PC se aaya hai?)');
    }
  } else {
    if (safeStorage && safeStorage.isEncryptionAvailable()) {
      master = crypto.randomBytes(32);
      const enc = safeStorage.encryptString(master.toString('base64'));
      fs.writeFileSync(keyFile, Buffer.concat([Buffer.from([1]), enc]));
    } else {
      // DPAPI na mile to PC-bound key (kamzor, par phir bhi PC se bandha)
      const salt = crypto.randomBytes(16);
      master = crypto.scryptSync(machineSeed(), salt, 32);
      fs.writeFileSync(keyFile, Buffer.concat([Buffer.from([2]), salt]));
    }
  }
}

function sub(name) {
  if (!master) throw new Error('crypto.init() pehle call karein');
  if (!subkeys[name]) {
    // HKDF-SHA256 (salt khali, 1 block = 32 byte) - purane Node par bhi chalta hai
    const prk = crypto.createHmac('sha256', Buffer.alloc(32)).update(master).digest();
    subkeys[name] = crypto.createHmac('sha256', prk).update(Buffer.concat([Buffer.from('dflix:' + name), Buffer.from([1])])).digest();
  }
  return subkeys[name];
}

// ---------- chhote blobs (GCM) ----------
function sealBlob(buf, purpose) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', sub(purpose || 'store'), iv);
  const ct = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([MAGIC_STORE, iv, c.getAuthTag(), ct]);
}
function openBlob(buf, purpose) {
  if (buf.length < 4 + 12 + 16 || !buf.subarray(0, 4).equals(MAGIC_STORE)) throw new Error('bad blob');
  const iv = buf.subarray(4, 16), tag = buf.subarray(16, 32), ct = buf.subarray(32);
  const d = crypto.createDecipheriv('aes-256-gcm', sub(purpose || 'store'), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}
function writeAtomic(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}
function writeSealed(file, buf, purpose) { writeAtomic(file, sealBlob(buf, purpose)); }
function readSealed(file, purpose) { return openBlob(fs.readFileSync(file), purpose); }

// ---------- badi files (CTR, seekable) ----------
function ctrIv(baseIv, blockIndex) {
  let n = BigInt('0x' + baseIv.toString('hex')) + BigInt(blockIndex);
  n &= (1n << 128n) - 1n;
  return Buffer.from(n.toString(16).padStart(32, '0'), 'hex');
}
/** Cipher/decipher jo plaintext offset `offset` par khada hai. (CTR me encrypt==decrypt) */
function ctrAt(key, baseIv, offset) {
  const c = crypto.createCipheriv('aes-256-ctr', key, ctrIv(baseIv, Math.floor(offset / 16)));
  const skip = offset % 16;
  if (skip) c.update(Buffer.alloc(skip));
  return c;
}
function fileKey() { return sub('files'); }

function newFileHeader(plainSize) {
  const iv = crypto.randomBytes(16);
  const h = Buffer.alloc(FILE_HEADER);
  MAGIC_FILE.copy(h, 0); iv.copy(h, 8);
  h.writeBigUInt64BE(BigInt(plainSize || 0), 24);
  return { header: h, iv };
}
function parseFileHeader(buf) {
  if (buf.length < FILE_HEADER || !buf.subarray(0, 8).equals(MAGIC_FILE)) throw new Error('not a dflix file');
  return { iv: Buffer.from(buf.subarray(8, 24)), size: Number(buf.readBigUInt64BE(24)) };
}

/** Encrypted .dflx file ko plaintext byte range [start..end] me decrypt karke out me likhta hai. */
function readEncryptedRange(file, start, end, out, onChunk) {
  return new Promise((resolve, reject) => {
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      const hb = Buffer.alloc(FILE_HEADER);
      fs.readSync(fd, hb, 0, FILE_HEADER, 0);
      const { iv } = parseFileHeader(hb);
      const dec = ctrAt(fileKey(), iv, start);
      let pos = start;
      const buf = Buffer.alloc(256 * 1024);
      const step = () => {
        try {
          if (pos > end) { fs.closeSync(fd); return resolve(); }
          const want = Math.min(buf.length, end - pos + 1);
          const n = fs.readSync(fd, buf, 0, want, FILE_HEADER + pos);
          if (n <= 0) { fs.closeSync(fd); return resolve(); }
          const plain = dec.update(buf.subarray(0, n));
          pos += n;
          const ok = out.write(plain);
          if (onChunk && onChunk() === false) { fs.closeSync(fd); return resolve(); }
          if (ok) setImmediate(step); else out.once('drain', step);
        } catch (e) { try { fs.closeSync(fd); } catch (x) {} reject(e); }
      };
      out.once('close', () => { pos = end + 1; });
      step();
    } catch (e) { try { if (fd !== undefined) fs.closeSync(fd); } catch (x) {} reject(e); }
  });
}

module.exports = {
  init, sub, sealBlob, openBlob, writeSealed, readSealed, writeAtomic,
  ctrIv, ctrAt, fileKey, newFileHeader, parseFileHeader, readEncryptedRange, FILE_HEADER,
};
