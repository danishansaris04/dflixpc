'use strict';
// PresenceManager.java ka port: naam, device details, online/lastSeen heartbeat, remote BLOCK.
const store = require('./store');
const net = require('./http');
const device = require('./device');

const DB_URL = process.env.DFLIX_ADMIN_DB || 'https://dflixadmin-default-rtdb.firebaseio.com';
const CYCLE_MS = 30000;

let activeCount = 0, started = false, blocked = false, lastSentActive = false;
let onBlockedChange = () => {}, getInfo = () => ({}), timer = null, streamReq = null;

const S = 'user';
const getName = () => store.getItem(S, 'name', '');
const isBlocked = () => store.getItem(S, 'blocked', false);
const isBlockedCached = () => blocked;

function saveName(name) {
  name = String(name || '').trim().slice(0, 30);
  store.setItem(S, 'name', name);
  if (!store.getItem(S, 'firstSeen', 0)) store.setItem(S, 'firstSeen', Date.now());
  syncNow();
}
function setActive(b) { const n = b ? 1 : 0; if (n === activeCount) return; activeCount = n; syncNow(); }
function syncNow() { cycle().catch(() => {}); }

function setBlocked(b) {
  const changed = b !== blocked;
  blocked = b;
  store.setItem(S, 'blocked', b);
  if (changed) onBlockedChange(b);
}

async function cycle() {
  const name = getName();
  if (!name) return;
  const active = activeCount > 0;
  if (!active && !lastSentActive) return;
  const id = device.getDeviceId();
  const body = Object.assign({
    name, deviceId: id, firstSeen: store.getItem(S, 'firstSeen', Date.now()),
    online: active, lastSeen: { '.sv': 'timestamp' },
  }, getInfo());
  try {
    await net.sendJson(DB_URL + '/users/' + id + '.json', 'PATCH', body);
    lastSentActive = active;
    if (active) {
      const r = await net.getBuffer(DB_URL + '/users/' + id + '/blocked.json?t=' + Date.now(), null, 10000);
      if (r.status === 200) setBlocked(r.body.toString().trim() === 'true');
    }
  } catch (e) { /* offline: block cached rehta hai */ }
}

async function streamBlocked() {
  const id = device.getDeviceId();
  const res = await net.request(DB_URL + '/users/' + id + '/blocked.json', { headers: { Accept: 'text/event-stream' }, timeout: 70000 });
  streamReq = res;
  await new Promise((resolve) => {
    let buf = '', ev = null;
    res.setEncoding('utf8');
    res.setTimeout(70000, () => res.destroy());
    res.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1);
        if (line.startsWith('event:')) ev = line.slice(6).trim();
        else if (line.startsWith('data:') && (ev === 'put' || ev === 'patch')) {
          try { const o = JSON.parse(line.slice(5)); if ((o.path || '/') === '/') setBlocked(o.data === true); } catch (e) {}
        }
      }
    });
    res.on('end', resolve); res.on('close', resolve); res.on('error', resolve);
  });
}

function ensureStarted(opts) {
  if (started) return;
  started = true;
  getInfo = opts.getInfo; onBlockedChange = opts.onBlockedChange;
  blocked = isBlocked();
  timer = setInterval(() => cycle().catch(() => {}), CYCLE_MS);
  (async () => {
    let backoff = 1000;
    for (;;) {
      const t0 = Date.now();
      try { await streamBlocked(); } catch (e) { /* retry */ }
      backoff = Date.now() - t0 > 20000 ? 1000 : Math.min(backoff * 2, 30000);
      await new Promise((r) => setTimeout(r, backoff));
    }
  })();
}
async function goOffline() {
  activeCount = 0;
  const name = getName();
  if (!name || !lastSentActive) return;
  try { await net.sendJson(DB_URL + '/users/' + device.getDeviceId() + '.json', 'PATCH', { online: false, lastSeen: { '.sv': 'timestamp' } }); } catch (e) {}
}

module.exports = { getName, saveName, isBlocked, isBlockedCached, setActive, syncNow, ensureStarted, goOffline };
