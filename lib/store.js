'use strict';
// Encrypted JSON key-value store (SharedPreferences ki jagah). Har store = data/store/<name>.dat
const fs = require('fs');
const paths = require('./paths');
const dcrypto = require('./crypto');

const open = {};

function load(name) {
  const file = paths.p('store', name + '.dat');
  let obj = {};
  try {
    if (fs.existsSync(file)) obj = JSON.parse(dcrypto.readSealed(file, 'store:' + name).toString('utf8'));
  } catch (e) {
    try { fs.renameSync(file, file + '.corrupt'); } catch (x) {}
    obj = {};
  }
  return obj;
}

function get(name) {
  if (open[name]) return open[name];
  const s = { name, file: paths.p('store', name + '.dat'), data: load(name), timer: null };
  open[name] = s;
  return s;
}

function flush(s) {
  if (s.timer) { clearTimeout(s.timer); s.timer = null; }
  try { dcrypto.writeSealed(s.file, Buffer.from(JSON.stringify(s.data), 'utf8'), 'store:' + s.name); }
  catch (e) { console.error('store write failed', s.name, e.message); }
}

function schedule(s) {
  if (s.timer) return;
  s.timer = setTimeout(() => flush(s), 400);
}

const store = {
  getItem(name, key, def) {
    const v = get(name).data[key];
    return v === undefined ? def : v;
  },
  setItem(name, key, val) {
    const s = get(name);
    s.data[key] = val;
    schedule(s);
  },
  removeItem(name, key) {
    const s = get(name);
    delete s.data[key];
    schedule(s);
  },
  keys(name) { return Object.keys(get(name).data); },
  all(name) { return get(name).data; },
  clear(name) { const s = get(name); s.data = {}; schedule(s); },
  flushAll() { Object.values(open).forEach(flush); },
};

module.exports = store;
