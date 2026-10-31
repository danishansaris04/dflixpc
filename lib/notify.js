'use strict';
// FirebaseNotifyListener.java + NotificationStore.java ka port
const store = require('./store');
const net = require('./http');

const DB_URL = process.env.DFLIX_NOTIFY_DB || 'https://dflix-7b2d2-default-rtdb.firebaseio.com';
const S = 'notif';
const MAX = 50;
let handlers = { show() {}, push() {}, remove() {} };
let running = false;

const list = () => store.getItem(S, 'list', []);
const getAll = list;
function add(id, title, body, poster, ts) {
  const e = { id, title, body, ts, read: false };
  if (poster) e.poster = poster;
  store.setItem(S, 'list', [e].concat(list().filter((x) => x.id !== id)).slice(0, MAX));
}
function markAllRead() { store.setItem(S, 'list', list().map((x) => Object.assign({}, x, { read: true }))); }
function clearAll() { store.removeItem(S, 'list'); }
function remove(id) { store.setItem(S, 'list', list().filter((x) => x.id !== id)); }
const lastSeen = () => store.getItem(S, 'lastSeen', 0);

function processOne(pushId, item) {
  const title = String(item.title || '').trim(), body = String(item.body || '').trim(), poster = String(item.poster || '').trim();
  const ts = Number(item.ts) || Date.now();
  if (!title && !body) return;
  const isNew = ts > lastSeen();
  add(pushId, title, body, poster, ts);
  if (isNew) {
    store.setItem(S, 'lastSeen', ts);
    handlers.show({ id: pushId, title: title || 'D-FLIX', body, poster });
    handlers.push({ id: pushId, title, body, poster, ts });
  }
}
function handleEvent(ev, dataJson) {
  if (ev !== 'put' && ev !== 'patch') return;
  let p; try { p = JSON.parse(dataJson); } catch (e) { return; }
  const path = p.path || '/', data = p.data;
  if (path === '/') {
    if (data && typeof data === 'object') for (const k of Object.keys(data)) if (data[k] && typeof data[k] === 'object') processOne(k, data[k]);
  } else {
    const id = path.replace(/^\//, '');
    if (data === null) { remove(id); handlers.remove(id); }
    else if (typeof data === 'object') processOne(id, data);
  }
}
async function listenOnce() {
  const res = await net.request(DB_URL + '/notifications.json', { headers: { Accept: 'text/event-stream' }, timeout: 0 });
  await new Promise((resolve) => {
    let buf = '', ev = null;
    res.setEncoding('utf8');
    res.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1);
        if (line.startsWith('event:')) ev = line.slice(6).trim();
        else if (line.startsWith('data:')) handleEvent(ev, line.slice(5).trim());
      }
    });
    res.on('end', resolve); res.on('close', resolve); res.on('error', resolve);
  });
}
function ensureStarted(h) {
  if (running) return;
  running = true; handlers = h;
  if (!store.getItem(S, 'lastSeen', 0)) store.setItem(S, 'lastSeen', Date.now());
  (async () => {
    let backoff = 2000;
    for (;;) {
      const t0 = Date.now();
      try { await listenOnce(); } catch (e) { /* retry */ }
      backoff = Date.now() - t0 > 30000 ? 2000 : Math.min(backoff * 2, 60000);
      await new Promise((r) => setTimeout(r, backoff));
    }
  })();
}
module.exports = { ensureStarted, getAll, markAllRead, clearAll };
