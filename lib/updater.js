'use strict';
// Auto-update: admin (Firebase appconfig/pc) me version badle -> app GitHub repo se zip utarta hai -> resources\app me laga deta hai.
// Safety: repo app me fixed (update-config.json), syntax check, backup + rollback, crash-loop par khud purana version wapas.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');
const net = require('./http');
const { readEntries, extract } = require('./unzip');

const DB_URL = process.env.DFLIX_ADMIN_DB || 'https://dflixadmin-default-rtdb.firebaseio.com';
const ALLOWED_FILES = ['main.js', 'preload.js', 'player-preload.js'];          // boot.js / package.json jaan-boojh kar nahi badalte
const ALLOWED_DIRS = ['lib/', 'ui/', 'mpv-config/', 'build/'];
const CHECK_MS = 10 * 60 * 1000;

const updDir = (root) => path.join(root, '..', '_update');
const rj = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };
const wj = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); };

/** Abhi chal rahe code ka version. Update ke baad package.json nahi badalta, isliye installed.json dekhte hain. */
function currentVersion(root, appVersion) {
  const rec = rj(path.join(updDir(root), 'installed.json'), null);
  return rec && rec.base === appVersion && rec.version ? rec.version : appVersion;
}

function loadLocalConfig(root) {
  const c = rj(path.join(root, 'update-config.json'), {}) || {};
  return { repo: String(c.repo || ''), ref: String(c.ref || 'main'), folder: String(c.folder || '').replace(/^\/+|\/+$/g, '') };
}
const repoOk = (r) => /^[\w.-]+\/[\w.-]+$/.test(r) && !/^YOUR_/i.test(r);
const refOk = (r) => /^[\w./-]{1,100}$/.test(r) && r.indexOf('..') < 0;

async function fetchRemoteConfig() {
  const r = await net.getBuffer(DB_URL + '/appconfig/pc.json?t=' + Date.now(), null, 12000);
  if (r.status !== 200) return null;
  const j = JSON.parse(r.body.toString('utf8') || 'null');
  return j && typeof j === 'object' ? j : null;
}

// redirects follow karke download (GitHub archive -> codeload)
async function download(url, chromiumGet, depth) {
  depth = depth || 0;
  if (depth > 6) throw new Error('bahut redirects');
  let res;
  try { res = await net.getBuffer(url, { 'User-Agent': 'DFlix-Updater' }, 60000); }
  catch (e) { if (chromiumGet) return chromiumGet(url, 60000).then((r) => { if (r.status !== 200) throw new Error('HTTP ' + r.status); return r.body; }); throw e; }
  if (res.status >= 300 && res.status < 400 && res.headers.location) return download(new URL(res.headers.location, url).toString(), chromiumGet, depth + 1);
  if (res.status !== 200) throw new Error('download HTTP ' + res.status);
  return res.body;
}

function zipUrl(local, ref) { return 'https://github.com/' + local.repo + '/archive/' + encodeURIComponent(ref).replace(/%2F/g, '/') + '.zip'; }

/** zip se allowed files nikalta hai (path-traversal safe) aur syntax check karta hai. -> Map(rel -> Buffer) */
function stageFromZip(buf, folder) {
  const entries = readEntries(buf).filter((e) => !e.dir);
  const files = new Map();
  for (const e of entries) {
    let parts = e.name.split('/'); parts.shift();                       // "repo-main/" hatao
    let rel = parts.join('/');
    if (folder) { if (rel.indexOf(folder + '/') !== 0) continue; rel = rel.slice(folder.length + 1); }
    if (!rel || rel.indexOf('..') >= 0 || rel.indexOf('\\') >= 0 || path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) continue;
    if (!(ALLOWED_FILES.indexOf(rel) >= 0 || ALLOWED_DIRS.some((d) => rel.indexOf(d) === 0))) continue;
    files.set(rel, extract(buf, e));
  }
  if (!files.has('main.js') || !files.has('ui/index.html') || !files.has('ui/app.js')) throw new Error('repo me main.js / ui folder nahi mila (folder setting check karein)');
  for (const [rel, data] of files) {
    if (/\.js$/.test(rel)) {
      // Node module jaisa wrap karke compile (top-level `return` CommonJS me legal hai, jaise main.js me)
      try { new vm.Script(Module.wrap(data.toString('utf8').replace(/^#!.*/, '')), { filename: rel }); } catch (e) { throw new Error('syntax error ' + rel + ': ' + e.message); }
    }
  }
  return files;
}

/** Backup lekar files likhta hai. Beech me fail ho to wapas restore. */
function applyFiles(root, files, version) {
  const bdir = path.join(updDir(root), 'backup');
  fs.rmSync(bdir, { recursive: true, force: true });
  fs.mkdirSync(bdir, { recursive: true });
  const manifest = { from: null, replaced: [], added: [] };
  try {
    for (const [rel, data] of files) {
      const dest = path.join(root, rel);
      if (fs.existsSync(dest)) {
        const b = path.join(bdir, 'files', rel); fs.mkdirSync(path.dirname(b), { recursive: true }); fs.copyFileSync(dest, b);
        manifest.replaced.push(rel);
      } else manifest.added.push(rel);
    }
    wj(path.join(bdir, 'manifest.json'), manifest);
    for (const [rel, data] of files) {
      const dest = path.join(root, rel); fs.mkdirSync(path.dirname(dest), { recursive: true });
      const tmp = dest + '.upd'; fs.writeFileSync(tmp, data); fs.renameSync(tmp, dest);
    }
  } catch (e) { try { rollback(root); } catch (x) { /* ignore */ } throw e; }
}

function rollback(root) {
  const bdir = path.join(updDir(root), 'backup');
  const m = rj(path.join(bdir, 'manifest.json'), null);
  if (!m) return false;
  m.replaced.forEach((rel) => { try { fs.copyFileSync(path.join(bdir, 'files', rel), path.join(root, rel)); } catch (e) { /* skip */ } });
  m.added.forEach((rel) => { try { fs.unlinkSync(path.join(root, rel)); } catch (e) { /* skip */ } });
  return true;
}

function recordInstalled(root, appVersion, version) {
  wj(path.join(updDir(root), 'installed.json'), { base: appVersion, version });
  wj(path.join(updDir(root), 'pending.json'), { version, tries: 0, ts: Date.now() });
}
function markHealthy(root) { try { fs.unlinkSync(path.join(updDir(root), 'pending.json')); } catch (e) { /* none */ } }

/** Poora flow (test ke liye bhi use hota hai). */
async function installVersion(opts) {
  const { root, appVersion, version, ref, local, chromiumGet } = opts;
  const buf = opts.zipBuf || await download(zipUrl(local, ref), chromiumGet);
  const files = stageFromZip(buf, local.folder);
  applyFiles(root, files, version);
  recordInstalled(root, appVersion, version);
  return files.size;
}

// ---------------- background checker ----------------
let busy = false, declined = '', timer = null;
function start(h) {
  // h: { root, appVersion, chromiumGet, isPlaying(), ask(cfg) -> Promise<bool>, toast(msg), restart(), log(msg) }
  const log = h.log || (() => {});
  const local = loadLocalConfig(h.root);
  setTimeout(() => markHealthy(h.root), 20000);
  if (!repoOk(local.repo)) { log('updater band: update-config.json me "repo" (user/repo) set nahi hai'); return; }
  async function check() {
    if (busy) return;
    busy = true;
    try {
      const cfg = await fetchRemoteConfig();
      const want = cfg && String(cfg.version || '').trim();
      if (!cfg || !want || cfg.enabled === false) return;
      const cur = currentVersion(h.root, h.appVersion);
      if (want === cur) return;
      if ((rj(path.join(updDir(h.root), 'failed.json'), []) || []).indexOf(want) >= 0) return;     // pehle fail/rollback hua tha
      const force = cfg.force === true;
      if (!force && declined === want) return;
      const ref = cfg.ref && refOk(String(cfg.ref)) ? String(cfg.ref) : local.ref;
      if (!force) {
        const yes = await h.ask({ version: want, current: cur, notes: String(cfg.notes || '') });
        if (!yes) { declined = want; return; }
      } else {
        while (h.isPlaying()) await new Promise((r) => setTimeout(r, 15000));      // video chal raha ho to rukte hain
      }
      h.toast('Update v' + want + ' download ho raha hai...');
      await installVersion({ root: h.root, appVersion: h.appVersion, version: want, ref, local, chromiumGet: h.chromiumGet });
      h.toast('Update v' + want + ' lag gaya - app restart ho raha hai');
      setTimeout(h.restart, 1500);
    } catch (e) { log('update check/install fail: ' + e.message); h.toast && !/ENOTFOUND|ECONN|timeout|HTTP/i.test(e.message) && h.toast('Update fail: ' + e.message); }
    finally { busy = false; }
  }
  setTimeout(check, 8000);
  timer = setInterval(check, CHECK_MS);
  return { check };
}

module.exports = { start, currentVersion, installVersion, stageFromZip, applyFiles, rollback, markHealthy, loadLocalConfig, updDir };
