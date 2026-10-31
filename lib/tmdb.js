'use strict';
// TmdbHelper.java + PosterCache.java ka port. JSON cache + poster images (data/cache/img, ENCRYPTED)
const fs = require('fs');
const crypto = require('crypto');
const net = require('./http');
const store = require('./store');
const paths = require('./paths');
const dcrypto = require('./crypto');

const DEFAULT_BASE = 'https://api.themoviedb.org/3', DEFAULT_IMG = 'https://image.tmdb.org/t/p';
const BASE = process.env.DFLIX_TMDB_BASE || DEFAULT_BASE;
const IMG = process.env.DFLIX_TMDB_IMG || DEFAULT_IMG;
// Mirror domains: agar ISP ek domain block kare to dusra try hota hai
const BASES = [BASE].concat(process.env.DFLIX_TMDB_ALT_BASE ? [process.env.DFLIX_TMDB_ALT_BASE] : (BASE === DEFAULT_BASE ? ['https://api.tmdb.org/3'] : []));
const IMGS = [IMG].concat(process.env.DFLIX_TMDB_ALT_IMG ? [process.env.DFLIX_TMDB_ALT_IMG] : (IMG === DEFAULT_IMG ? ['https://www.themoviedb.org/t/p'] : []));
const UA = 'Mozilla/5.0 (Windows NT 6.3; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36';
const DAY = 24 * 3600 * 1000;
let API_KEY = '16b0f944d64a43298cf3ce5fc5852ffb';
try { // apni TMDB key lagani ho to data\tmdb-key.txt me paste karein
  const kf = paths.p('tmdb-key.txt');
  if (fs.existsSync(kf)) { const k = fs.readFileSync(kf, 'utf8').trim(); if (/^[a-f0-9]{32}$/i.test(k)) API_KEY = k; }
} catch (e) { /* paths init nahi hua (tests) */ }

// ---- debug log (data\poster-log.txt) ----
function logLine(msg) {
  try {
    const f = paths.p('poster-log.txt');
    let old = ''; try { old = fs.readFileSync(f, 'utf8'); } catch (e) {}
    if (old.length > 60000) old = old.slice(-30000);
    fs.writeFileSync(f, old + new Date().toISOString() + ' ' + msg + '\n');
  } catch (e) { /* ignore */ }
}

// ---- network layers: Node https  ->  Chromium (electron.net: system proxy/certs)  ->  mirror domain ----
let chromiumGet = null;
function setChromiumGet(fn) { chromiumGet = fn; }
let pref = 0; // pichhli baar jo tareeka chala wahi pehle try hoga

async function fetchAny(urls, timeout) {
  const attempts = [];
  urls.forEach((u, i) => { attempts.push({ via: 'node', url: u, mirror: i }); if (chromiumGet) attempts.push({ via: 'chromium', url: u, mirror: i }); });
  let lastErr = null;
  for (let k = 0; k < attempts.length; k++) {
    const a = attempts[(pref + k) % attempts.length];
    try {
      const r = a.via === 'node' ? await net.getBuffer(a.url, { 'User-Agent': UA, Accept: '*/*' }, timeout) : await chromiumGet(a.url, timeout);
      if (r.status === 200 || r.status === 404) { pref = (pref + k) % attempts.length; return r; }
      lastErr = new Error('HTTP ' + r.status);
      if (r.status === 401) logLine('HTTP 401 - TMDB API key galat/blocked? (' + a.via + ' ' + a.url.replace(/api_key=[a-f0-9]+/i, 'api_key=***') + ')');
    } catch (e) { lastErr = e; }
    logLine('fail via=' + a.via + ' mirror=' + a.mirror + ' ' + a.url.replace(/api_key=[a-f0-9]+/i, 'api_key=***').slice(0, 120) + ' -> ' + (lastErr && lastErr.message));
  }
  throw lastErr || new Error('network');
}
const T_NONE = 0, T_MOVIE = 1, T_TV = 2;

const JUNK = ['1080p', '720p', '480p', '2160p', '4k', '8k', 'hdcam', 'hdrip', 'dvdrip', 'webrip', 'web dl', 'webdl', 'bluray', 'blu ray',
  'brrip', 'bdrip', 'hdtv', 'x264', 'x265', 'hevc', 'h264', 'h265', 'aac', 'ac3', 'dts', 'esubs', 'esub', 'subbed', 'dual audio',
  'multi audio', 'dubbed', 'hindi', 'english', 'tamil', 'telugu', 'kannada', 'malayalam', 'korean', 'proper', 'extended', 'uncut',
  'remastered', 'nf', 'amzn', 'hmax', 'yify', 'yts', 'rarbg', 'galaxytv', 'psa', 'org'];
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function parseFilename(raw) {
  let name = raw.replace(/\.(mkv|mp4|avi|mov|wmv|flv|webm|m4v|ts|3gp)$/i, '');
  const info = { title: '', year: null, guessedType: T_MOVIE };
  const ym = /\b(19\d{2}|20\d{2})\b/.exec(name);
  if (ym) info.year = ym[1];
  const se = /\bS\d{1,2}\s?E\d{1,3}\b/i.exec(name), sw = /\bSeason\s?\d{1,2}\b/i.exec(name);
  let src;
  if (se) { info.guessedType = T_TV; src = name.slice(0, se.index); }
  else if (sw) { info.guessedType = T_TV; src = name.slice(0, sw.index); }
  else src = name;
  src = src.replace(/[\[\(\{][^\[\]\(\)\{\}]*[\]\)\}]/g, ' ').replace(/[._-]/g, ' ');
  for (const j of JUNK) src = src.replace(new RegExp('\\b' + esc(j) + '\\b', 'gi'), ' ');
  src = src.replace(/\b(19\d{2}|20\d{2})\b/g, ' ').replace(/\b\d+(\.\d+)?\s?(MB|GB|KB)\b/gi, ' ');
  src = src.replace(/\s+/g, ' ').trim().replace(/^[\s\-:,.]+|[\s\-:,.]+$/g, '').trim();
  info.title = src;
  return info;
}

async function search(kind, title, year) {
  const qs = '/search/' + kind + '?api_key=' + API_KEY + '&query=' + encodeURIComponent(title) + (kind === 'movie' && year ? '&year=' + year : '');
  const resp = await fetchAny(BASES.map((b) => b + qs), 8000);
  let j = null; try { j = JSON.parse(resp.body.toString('utf8')); } catch (e) { /* not json */ }
  const list = (j && j.results) || [];
  const r = list.find((x) => x.poster_path) || list[0];
  if (!r) {
    if (kind === 'movie' && year) return search(kind, title, null);
    return { type: T_NONE };
  }
  return { type: kind === 'movie' ? T_MOVIE : T_TV, title: r.title || r.name || title, poster: r.poster_path || null, backdrop: r.backdrop_path || null };
}

const mem = new Map();
async function resolveInfo(rawName) {
  const cache = store.all('tmdb');
  const c = cache[rawName];
  // "mila nahi" wala result sirf 1 din yaad rakhte hain (purane galat/adhure result dobara try honge)
  if (c && (c.type !== T_NONE || (c.ts && Date.now() - c.ts < DAY))) return c;
  if (mem.has(rawName)) return mem.get(rawName);
  const p = (async () => {
    const parsed = parseFilename(rawName);
    let res;
    if (!parsed.title) res = { type: T_NONE };
    else {
      const tvFirst = parsed.guessedType === T_TV;
      res = await search(tvFirst ? 'tv' : 'movie', parsed.title, tvFirst ? null : parsed.year);
      if (res.type === T_NONE) res = await search(tvFirst ? 'movie' : 'tv', parsed.title, tvFirst ? parsed.year : null);
    }
    res.ts = Date.now();
    store.setItem('tmdb', rawName, res);
    return res;
  })().finally(() => mem.delete(rawName));
  mem.set(rawName, p);
  return p;
}

function imgFile(key) { return paths.p('cache', 'img', crypto.createHash('sha1').update(key).digest('hex') + '.dat'); }
async function loadImage(size, prefix, imgPath) {
  const f = imgFile(prefix + imgPath);
  try { if (fs.existsSync(f)) return dcrypto.readSealed(f, 'img'); } catch (e) {}
  const r = await fetchAny(IMGS.map((b) => b + '/' + size + imgPath), 10000);
  if (r.status !== 200 || !r.body.length) return null;
  try { dcrypto.writeSealed(f, r.body, 'img'); } catch (e) {}
  return r.body;
}
const toDataUrl = (b) => (b ? 'data:image/jpeg;base64,' + b.toString('base64') : null);

// Result: {dataUrl, url, title}. dataUrl na bane to url (seedha TMDB link) bhi diya jata hai - <img> usse Chromium se load kar leta hai.
async function resolvePoster(rawName) {
  let info;
  try { info = await resolveInfo(rawName); } catch (e) { logLine('poster lookup fail: ' + rawName + ' -> ' + e.message); return { dataUrl: null, url: null, title: null, error: true }; }
  const title = info.type === T_MOVIE ? info.title : null;
  if (!info.poster) return { dataUrl: null, url: null, title };
  let buf = null;
  try { buf = await loadImage('w342', 'p_', info.poster); } catch (e) { logLine('poster image fail: ' + info.poster + ' -> ' + e.message); }
  return { dataUrl: toDataUrl(buf), url: buf ? null : IMG + '/w342' + info.poster, title };
}
async function resolveBackdrop(rawName) {
  let info;
  try { info = await resolveInfo(rawName); } catch (e) { logLine('backdrop lookup fail: ' + rawName + ' -> ' + e.message); return { dataUrl: null, url: null, title: null, error: true }; }
  const title = info.type === T_MOVIE ? info.title : null;
  const sz = info.backdrop ? ['w780', 'b_', info.backdrop] : info.poster ? ['w342', 'p_', info.poster] : null;
  if (!sz) return { dataUrl: null, url: null, title };
  let buf = null;
  try { buf = await loadImage(sz[0], sz[1], sz[2]); } catch (e) { logLine('backdrop image fail: ' + sz[2] + ' -> ' + e.message); }
  return { dataUrl: toDataUrl(buf), url: buf ? null : IMG + '/' + sz[0] + sz[2], title };
}

// ---- Downloads tab posters (data/posters, encrypted) ----
const safeKey = (k) => { if (!k) return null; const s = String(k).replace(/[^A-Za-z0-9_\-]/g, '_'); return s && s.length <= 150 ? s : null; };
const posterFile = (k) => paths.p('posters', crypto.createHash('sha1').update(k).digest('hex') + '.dat');
function savePoster(key, dataUrl) {
  const k = safeKey(key); if (!k || !dataUrl) return;
  const i = dataUrl.indexOf(','); if (i < 0) return;
  dcrypto.writeSealed(posterFile(k), Buffer.from(dataUrl.slice(i + 1), 'base64'), 'poster');
}
async function saveCustomPoster(key, url) {
  const k = safeKey(key); if (!k || !/^https?:\/\//i.test(url || '')) return false;
  try {
    const r = await net.getBuffer(url, null, 10000);
    if (r.status !== 200) return false;
    dcrypto.writeSealed(posterFile(k), r.body, 'poster');
    return true;
  } catch (e) { return false; }
}
function deletePoster(key) { const k = safeKey(key); if (k) try { fs.unlinkSync(posterFile(k)); } catch (e) {} }
function readPoster(key) {
  const k = safeKey(String(key).replace(/\.jpg$/, '')); if (!k) return null;
  try { return dcrypto.readSealed(posterFile(k), 'poster'); } catch (e) { return null; }
}

module.exports = { setChromiumGet, parseFilename, resolvePoster, resolveBackdrop, savePoster, saveCustomPoster, deletePoster, readPoster };
