'use strict';
// Chhota ZIP reader (koi npm module nahi) - GitHub ke archive zip ke liye. Method 0 (stored) + 8 (deflate).
const zlib = require('zlib');

function readEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) { if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; } }
  if (eocd < 0) throw new Error('zip kharab hai (EOCD nahi mila)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip kharab hai (central dir)');
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.toString((flags & 0x800) ? 'utf8' : 'utf8', p + 46, p + 46 + nl);
    out.push({ name, method, csize, usize, off, dir: name.endsWith('/') });
    p += 46 + nl + el + cl;
  }
  return out;
}

function extract(buf, e) {
  if (buf.readUInt32LE(e.off) !== 0x04034b50) throw new Error('zip kharab hai (local header): ' + e.name);
  const start = e.off + 30 + buf.readUInt16LE(e.off + 26) + buf.readUInt16LE(e.off + 28);
  const raw = buf.subarray(start, start + e.csize);
  if (e.method === 0) return Buffer.from(raw);
  if (e.method === 8) return zlib.inflateRawSync(raw);
  throw new Error('zip method support nahi: ' + e.method);
}

module.exports = { readEntries, extract };
