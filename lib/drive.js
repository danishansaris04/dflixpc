'use strict';
// DriveHelper.java ka port: Google Drive REST v3
const net = require('./http');

const BASE = process.env.DFLIX_DRIVE_BASE || 'https://www.googleapis.com/drive/v3';
const LOCKED_ROOT_FOLDER_ID = '17s88x00QQXAnTQtFWasBIOcgRqziTEnQ';
const FOLDER = 'application/vnd.google-apps.folder';
const SHORTCUT = 'application/vnd.google-apps.shortcut';
const FOLDER_ONLY_SEARCH_NAMES = ['web series', 'pakistani drama', 'tv shows', 'animation series'];
const CACHE_TTL = 10 * 60 * 1000;

const auth = (t) => ({ Authorization: 'Bearer ' + t });
const q = encodeURIComponent;

let cache = null; // {names:Map, parents:Map, special:Set, ts}

async function listFiles(token, folderId) {
  const parent = folderId || LOCKED_ROOT_FOLDER_ID;
  const query = q("'" + parent + "' in parents and trashed=false");
  const fields = q('nextPageToken,files(id,name,mimeType,size,modifiedTime)');
  const all = [];
  let pageToken = null;
  do {
    const url = BASE + '/files?q=' + query + '&fields=' + fields + '&pageSize=1000&orderBy=folder,name_natural'
      + (pageToken ? '&pageToken=' + q(pageToken) : '');
    const page = await net.getJson(url, auth(token));
    (page.files || []).forEach((f) => all.push(f));
    pageToken = page.nextPageToken || null;
  } while (pageToken);
  return { files: all };
}

/** Subtitle dhundhne ke liye: poora folder (1000+ files) list karne ke bajay sirf video ke naam ke pehle word se milti files. */
async function listSimilarNames(token, folderId, base) {
  const word = (String(base || '').match(/[A-Za-z0-9\u00C0-\uFFFF]{3,}/) || [''])[0];
  if (!word) return listFiles(token, folderId);
  const query = q("'" + folderId + "' in parents and trashed=false and name contains '" + word.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'");
  const fields = q('nextPageToken,files(id,name)');
  const all = []; let pageToken = null;
  try {
    do {
      const url = BASE + '/files?q=' + query + '&fields=' + fields + '&pageSize=1000' + (pageToken ? '&pageToken=' + q(pageToken) : '');
      const page = await net.getJson(url, auth(token));
      (page.files || []).forEach((f) => all.push(f));
      pageToken = page.nextPageToken || null;
    } while (pageToken);
  } catch (e) { return listFiles(token, folderId); }   // query fail ho to purana tareeka
  return { files: all };
}

async function collectFolders(token, root) {
  const names = new Map(), parents = new Map(), special = new Set();
  try {
    const m = await net.getJson(BASE + '/files/' + root + '?fields=' + q('id,name'), auth(token));
    names.set(root, m.name || '');
  } catch (e) { names.set(root, ''); }
  const queue = [root];
  for (let i = 0; i < queue.length; i++) {
    const parent = queue[i];
    const query = q("'" + parent + "' in parents and trashed=false and mimeType='" + FOLDER + "'");
    let pageToken = null;
    do {
      const url = BASE + '/files?q=' + query + '&fields=' + q('nextPageToken,files(id,name)') + '&pageSize=1000'
        + (pageToken ? '&pageToken=' + q(pageToken) : '');
      const page = await net.getJson(url, auth(token));
      for (const it of page.files || []) {
        if (names.has(it.id)) continue;
        names.set(it.id, it.name || '');
        parents.set(it.id, parent);
        if (FOLDER_ONLY_SEARCH_NAMES.includes((it.name || '').toLowerCase())) special.add(it.id);
        queue.push(it.id);
      }
      pageToken = page.nextPageToken || null;
    } while (pageToken);
  }
  return { names, parents, special, ts: Date.now() };
}

async function folderTree(token) {
  if (!cache || Date.now() - cache.ts > CACHE_TTL) cache = await collectFolders(token, LOCKED_ROOT_FOLDER_ID);
  return cache;
}
function warmFolderCache(token) { if (token) folderTree(token).catch(() => {}); }
function invalidateFolderCache() { cache = null; }

function resolveShowFolderId(c, startId) {
  if (!c.special.size || !startId) return null;
  let cur = startId, prev = null;
  for (let hops = 0; cur && hops < 50; hops++) {
    if (c.special.has(cur)) return prev || cur;
    prev = cur;
    cur = c.parents.get(cur);
  }
  return null;
}

async function searchFiles(token, keyword) {
  const c = await folderTree(token);
  const query = q("name contains '" + keyword.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "' and trashed=false");
  const fields = q('nextPageToken,files(id,name,mimeType,size,modifiedTime,parents)');
  const files = [];
  let pageToken = null;
  do {
    const url = BASE + '/files?q=' + query + '&fields=' + fields + '&pageSize=1000' + (pageToken ? '&pageToken=' + q(pageToken) : '');
    const page = await net.getJson(url, auth(token));
    (page.files || []).forEach((f) => files.push(f));
    pageToken = page.nextPageToken || null;
  } while (pageToken);

  const results = new Map();
  for (const f of files) {
    const pid = (f.parents || []).find((p) => c.names.has(p));
    if (!pid) continue;
    const isFolder = f.mimeType === FOLDER;
    const show = resolveShowFolderId(c, isFolder ? f.id : pid);
    if (show) {
      if (!results.has(show)) results.set(show, { id: show, name: c.names.get(show), mimeType: FOLDER });
    } else results.set(f.id, f);
  }
  return { files: Array.from(results.values()) };
}

// ---- file info (shortcut follow + size), 10 min cache ----
const infoCache = new Map();
async function resolveFileInfo(token, fileId) {
  const hit = infoCache.get(fileId);
  if (hit && Date.now() - hit.time < CACHE_TTL) return hit;
  let cur = fileId, result = null;
  for (let hop = 0; hop < 5; hop++) {
    const meta = await net.getJson(BASE + '/files/' + cur + '?fields=' + q('id,mimeType,size,shortcutDetails'), auth(token), 15000);
    if (meta.mimeType !== SHORTCUT) { result = { id: cur, size: parseInt(meta.size || '0', 10) || 0 }; break; }
    const t = meta.shortcutDetails && meta.shortcutDetails.targetId;
    if (!t) { result = { id: cur, size: 0 }; break; }
    cur = t;
  }
  if (!result) result = { id: cur, size: 0 };
  result.time = Date.now();
  infoCache.set(fileId, result);
  return result;
}
async function resolveActualFileId(token, id) { return (await resolveFileInfo(token, id)).id; }

async function findFileIdInFolder(token, folderId, fileName) {
  const parent = !folderId || folderId === 'root' ? LOCKED_ROOT_FOLDER_ID : folderId;
  const esc = fileName.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const query = q("'" + parent + "' in parents and trashed=false and name = '" + esc + "'");
  const j = await net.getJson(BASE + '/files?q=' + query + '&fields=' + q('files(id,name)') + '&pageSize=1', auth(token));
  return j.files && j.files.length ? j.files[0].id : null;
}
async function getParentId(token, fileId) {
  const m = await net.getJson(BASE + '/files/' + fileId + '?fields=parents', auth(token));
  return m.parents && m.parents.length ? m.parents[0] : null;
}
async function getMeta(token, id) {
  return net.getJson(BASE + '/files/' + id + '?fields=' + q('id,name,mimeType,parents'), auth(token));
}
/** raw response (stream) - Range support. */
function openFileStream(token, fileId, range, signal) {
  const h = auth(token);
  if (range) h.Range = range;
  return net.request(BASE + '/files/' + fileId + '?alt=media', { headers: h, timeout: 25000, signal });
}

// ---------------- multi quality ----------------
const QUALITY_RE = /(2160|1440|1080|720|576|540|480|360|240)\s*p|\b4k\b|\buhd\b/i;
function qualityHeight(name) {
  const m = QUALITY_RE.exec(name || '');
  if (!m) return 0;
  return m[1] ? parseInt(m[1], 10) : 2160;
}
function qualityLabel(h) { return h >= 5000 ? 'Auto' : h >= 2160 ? '4K' : h + 'p'; }
function formatSize(n) {
  if (!(n > 0)) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let d = n, i = 0;
  while (d >= 1024 && i < u.length - 1) { d /= 1024; i++; }
  return d >= 10 || i === 0 ? d.toFixed(0) + ' ' + u[i] : d.toFixed(1) + ' ' + u[i];
}
const sizeOf = (f) => parseInt(f.size || '0', 10) || 0;
const VIDEO_EXT = /\.(mkv|mp4|avi|mov|webm|ts|m4v|wmv|flv|mpg|mpeg|3gp)$/i;
function isVideoItem(f) { return (f.mimeType || '').startsWith('video/') || VIDEO_EXT.test(f.name || ''); }
const isFolderItem = (f) => f.mimeType === FOLDER;

async function firstVideoInFolder(token, folderId) {
  const arr = (await listFiles(token, folderId)).files || [];
  return arr.find((f) => !isFolderItem(f) && isVideoItem(f)) || null;
}

async function resolveMulti(token, folderId, preferHeight) {
  const kids = (await listFiles(token, folderId)).files || [];
  let q2 = [];
  let directVideo = null;
  const kidsVideos = [];
  for (const f of kids) {
    if (isFolderItem(f)) {
      const h = qualityHeight(f.name);
      if (h > 0) q2.push({ h, label: qualityLabel(h), fid: f.id });
    } else if (isVideoItem(f)) { kidsVideos.push(f); if (!directVideo) directVideo = f; }
  }
  if (!q2.length && kidsVideos.length >= 2) {
    const n = kidsVideos.length;
    const hs = kidsVideos.map((f) => qualityHeight(f.name));
    let real = hs.every((h) => h > 0) && new Set(hs).size === n;
    if (real) {
      q2 = kidsVideos.map((f, i) => ({ h: hs[i], label: qualityLabel(hs[i]), fid: f.id, file: f.id, fname: f.name }));
    } else {
      const idx = kidsVideos.map((_, i) => i).sort((x, y) => {
        const sx = sizeOf(kidsVideos[x]), sy = sizeOf(kidsVideos[y]);
        return sx !== sy ? sy - sx : kidsVideos[x].name.localeCompare(kidsVideos[y].name);
      });
      q2 = idx.map((i, r) => {
        const f = kidsVideos[i], sz = formatSize(sizeOf(f));
        const lab = (hs[i] > 0 ? qualityLabel(hs[i]) + (sz ? ' \u00B7 ' : '') : '') + (sz || (hs[i] > 0 ? '' : 'Original'));
        return { h: 5000 + (n - 1 - r), label: lab, fid: f.id, file: f.id, fname: f.name };
      });
    }
  }
  const res = { sid: folderId };
  if (!q2.length) {
    if (!directVideo) throw new Error('No video found in this folder');
    return Object.assign(res, { fileId: directVideo.id, fileName: directVideo.name || '', height: 0, label: '', variants: [] });
  }
  q2.sort((a, b) => b.h - a.h);
  let order = q2.slice();
  if (preferHeight > 0) {
    const want = preferHeight;
    const key = (v) => (v.h <= want ? 0 : 100000) + Math.abs(v.h - want);
    order.sort((a, b) => key(a) - key(b));
  }
  for (const v of order) {
    if (!v.file) {
      const file = await firstVideoInFolder(token, v.fid);
      if (!file) continue;
      v.file = file.id; v.fname = file.name || '';
    }
    res.fileId = v.file; res.fileName = v.fname; res.height = v.h; res.label = v.label;
    res.variants = q2.map((s) => { const o = { label: s.label, h: s.h, fid: s.fid }; if (s.file) { o.file = s.file; o.fname = s.fname; } return o; });
    return res;
  }
  throw new Error('No video found inside the quality folders');
}

module.exports = {
  LOCKED_ROOT_FOLDER_ID, listFiles, listSimilarNames, searchFiles, warmFolderCache, invalidateFolderCache,
  resolveFileInfo, resolveActualFileId, findFileIdInFolder, getParentId, getMeta, openFileStream,
  qualityHeight, qualityLabel, firstVideoInFolder, resolveMulti, isVideoItem,
};
