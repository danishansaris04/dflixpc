'use strict';
// HistoryStore.java + player prefs ka port (sab encrypted store me)
const store = require('./store');
const MAX = 40;

function record(key, type, title, parentId, lastId, lastName, multi) {
  if (!key || !lastId) return;
  const old = store.getItem('history', 'list', []);
  const e = { key, type: type || 'movie', title: title || '', parentId: parentId || '', lastId, lastName: lastName || '', ts: Date.now() };
  if (multi) e.multi = true;
  const out = [e];
  for (const o of old) { if (out.length >= MAX) break; if (o.key !== key) out.push(o); }
  store.setItem('history', 'list', out);
}
function playState(id) {
  return {
    pos: store.getItem('player', 'pos_' + id, 0),
    dur: store.getItem('player', 'dur_' + id, 0),
    done: store.getItem('player', 'done_' + id, false),
  };
}
function getAll() {
  return store.getItem('history', 'list', []).map((o) => Object.assign({}, o, playState(o.lastId)));
}
function clearPlayState(id) {
  if (!id) return;
  store.removeItem('player', 'pos_' + id);
  store.removeItem('player', 'done_' + id);
}
function remove(key) {
  const old = store.getItem('history', 'list', []);
  store.setItem('history', 'list', old.filter((o) => { if (o.key === key) { clearPlayState(o.lastId); return false; } return true; }));
}
function clearAll() { store.removeItem('history', 'list'); }
function savePos(id, posMs, durMs) {
  if (!id) return;
  if (durMs > 0) store.setItem('player', 'dur_' + id, Math.round(durMs));
  if (durMs > 0 && posMs >= durMs - 15000) { store.removeItem('player', 'pos_' + id); store.setItem('player', 'done_' + id, true); }
  else { store.setItem('player', 'pos_' + id, Math.round(posMs)); store.removeItem('player', 'done_' + id); }
}
function markDone(id, durMs) {
  if (!id) return;
  if (durMs > 0) store.setItem('player', 'dur_' + id, Math.round(durMs));
  store.removeItem('player', 'pos_' + id);
  store.setItem('player', 'done_' + id, true);
}
const getQualityPref = (k) => (k ? store.getItem('player', 'qpref_' + k, 0) : 0);
const setQualityPref = (k, h) => { if (k && h > 0) store.setItem('player', 'qpref_' + k, h); };

module.exports = { record, getAll, playState, clearPlayState, remove, clearAll, savePos, markDone, getQualityPref, setQualityPref };
