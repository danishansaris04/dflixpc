'use strict';
// PlayerActivity.java ka logic (engine-independent): resume, history, series next/prev, auto-next,
// multi-quality switch, subtitle discovery, block => band. Engine = mpv (sab formats) ya built-in HTML5 fallback.
const tokens = require('./tokens');
const drive = require('./drive');
const history = require('./history');
const server = require('./server');

const SUB_RE = /\.(srt|vtt|ass|ssa)$/i;
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const stripExt = (n) => String(n || '').replace(/\.[A-Za-z0-9]{2,4}$/, '');
const LANG = { en: 'English', hi: 'Hindi', ur: 'Urdu', ar: 'Arabic', es: 'Spanish', fr: 'French', de: 'German', ta: 'Tamil', te: 'Telugu', bn: 'Bengali', pt: 'Portuguese', ru: 'Russian', tr: 'Turkish', id: 'Indonesian', ko: 'Korean', ja: 'Japanese', zh: 'Chinese', ml: 'Malayalam', kn: 'Kannada', pa: 'Punjabi', eng: 'English', hin: 'Hindi', urd: 'Urdu', ara: 'Arabic' };

function subLabel(fileName, base) {
  const dot = fileName.lastIndexOf('.');
  const ext = dot > 0 ? fileName.slice(dot + 1).toUpperCase() : 'SUB';
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const idx = stem.toLowerCase().indexOf(base.toLowerCase());
  let rest = idx >= 0 && base ? stem.slice(idx + base.length) : stem;
  rest = rest.replace(/^[\s._\-[(]+|[\s._\-\])]+$/g, '');
  let lang = /^[A-Za-z]{2,3}$/.test(rest) && LANG[rest.toLowerCase()] ? LANG[rest.toLowerCase()] : rest;
  if (!lang) lang = 'Subtitle';
  return lang + ' (' + ext + ')';
}

class Session {
  /** engine: {load(url,title,startMs), addSub(url,label), osd(msg), setInfo(obj), quit()} ; deps.presence optional */
  constructor(engine, opts) {
    this.engine = engine;
    this.opts = opts || {};
    this.closed = false; this.switching = false;
    this.pos = 0; this.dur = 0; this.lastSave = 0;
    this.gen = 0;
  }

  async start(req) {
    // req: {fileId, fileName, local, metaJson}
    this.local = !!req.local;
    this.fileId = req.fileId; this.title = req.fileName || ''; this.fileName = this.title; this.stateId = req.fileId;
    this.hType = ''; this.hKey = ''; this.hTitle = ''; this.hParent = '';
    this.playlist = null; this.playIndex = -1; this.variants = null; this.curHeight = 0; this.titleIsFolder = false;
    if (req.metaJson) {
      try {
        const m = JSON.parse(req.metaJson);
        this.hType = m.htype || ''; this.hKey = m.hkey || ''; this.hTitle = m.htitle || ''; this.hParent = m.hparent || '';
        this.playlist = m.playlist || null; this.playIndex = typeof m.pindex === 'number' ? m.pindex : -1;
        if (m.mq) {
          if (m.mq.sid) this.stateId = m.mq.sid;
          if (m.mq.fname) this.fileName = m.mq.fname;
          this.curHeight = m.mq.h || 0; this.variants = m.mq.variants || null; this.titleIsFolder = true;
        }
      } catch (e) { /* ignore */ }
    }
    const resume = history.playState(this.stateId).pos || 0;
    this.recordHistory();
    this.publishInfo();
    await this.engine.load(this.urlFor(this.fileId, this.fileName), this.shownTitle(), resume);
    this.discoverSubtitles();
  }

  urlFor(id, name) { return this.local ? server.localUrl(id, name) : server.streamUrl(id, name); }
  shownTitle() {
    let t = this.hType === 'series' && this.playlist ? this.stripEp(this.title) : stripExt(this.title);
    if (this.playlist && this.playIndex >= 0 && this.playlist.length > 1) t += '   [Episode ' + (this.playIndex + 1) + '/' + this.playlist.length + ']';
    return t;
  }
  stripEp(n) { return stripExt(n); }
  currentUrl() { return this.urlFor(this.fileId, this.fileName); }
  /** Abhi jo chal raha hai uska request (engine badalne ke liye, jaise web player -> mpv) */
  exportReq() {
    const meta = { htype: this.hType, hkey: this.hKey, htitle: this.hTitle, hparent: this.hParent };
    if (this.playlist) { meta.playlist = this.playlist; meta.pindex = this.playIndex; }
    if (this.titleIsFolder) meta.mq = { sid: this.stateId, h: this.curHeight, variants: this.variants, fname: this.fileName };
    return { fileId: this.fileId, fileName: this.title, local: this.local, metaJson: JSON.stringify(meta) };
  }
  recordHistory() {
    if (!this.hKey || !this.stateId) return;
    const t = this.hTitle || stripExt(this.title);
    history.record(this.hKey, this.hType, t, this.hParent, this.stateId, this.title, this.titleIsFolder);
  }
  qLabel(h) {
    for (const v of this.variants || []) if (v.h === h) return v.label || drive.qualityLabel(h);
    return drive.qualityLabel(h);
  }
  publishInfo() {
    this.engine.setInfo && this.engine.setInfo({
      hasPrev: !!(this.playlist && this.playIndex > 0),
      hasNext: !!(this.playlist && this.playIndex >= 0 && this.playIndex + 1 < this.playlist.length),
      hasQuality: !!(this.variants && this.variants.length > 1),
      quality: this.curHeight ? this.qLabel(this.curHeight) : '',
      variants: (this.variants || []).map((v) => ({ h: v.h, label: v.label })),
      title: this.shownTitle(),
      episodes: this.playlist && this.playlist.length > 1 ? this.playlist.map((e) => stripExt(e.name)) : [],
      index: this.playIndex,
    });
  }

  // ---- engine events ----
  onTick(posMs, durMs) {
    this.pos = posMs; if (durMs > 0) this.dur = durMs;
    const now = Date.now();
    if (now - this.lastSave > 5000 && posMs > 0) { this.lastSave = now; this.savePos(); }
  }
  savePos() { if (this.stateId && this.pos > 0) history.savePos(this.stateId, this.pos, this.dur); }
  onEnded() {
    history.markDone(this.stateId, this.dur);
    if (this.playlist && this.playIndex >= 0 && this.playIndex + 1 < this.playlist.length) this.switchToEpisode(this.playIndex + 1, false);
    else this.engine.quit();
  }
  onClosed() { if (this.closed) return; this.closed = true; this.savePos(); }
  command(name, arg) {
    if (name === 'next') this.switchToEpisode(this.playIndex + 1, true);
    else if (name === 'prev') this.switchToEpisode(this.playIndex - 1, true);
    else if (name === 'quality') this.cycleQuality(arg);
    else if (name === 'episode' && typeof arg === 'number' && arg !== this.playIndex) this.switchToEpisode(arg, true);
  }

  // ---- series ----
  async switchToEpisode(target, manual) {
    if (!this.playlist || this.playIndex < 0 || this.switching) return;
    if (target < 0 || target >= this.playlist.length) { if (manual) this.engine.osd(target < 0 ? 'Ye pehla episode hai' : 'Ye aakhri episode hai'); return; }
    const n = this.playlist[target];
    if (!n || !n.id) return;
    if (manual) this.savePos();
    if (!n.multi) return this.applyEpisode(target, n.id, n.name, n.id, n.name, null, 0, false, manual);
    this.switching = true; this.engine.osd('Episode load ho raha hai...');
    try {
      const token = await tokens.getValidAccessToken();
      const r = await drive.resolveMulti(token, n.id, this.curHeight);
      this.applyEpisode(target, n.id, n.name, r.fileId, r.fileName || n.name, r.variants, r.height, true, manual);
    } catch (e) { this.engine.osd("Episode load nahi hua - internet check karein"); }
    finally { this.switching = false; }
  }
  applyEpisode(target, sid, shownTitle, fileId, fileName, variants, height, multi, manual) {
    this.playIndex = target; this.fileId = fileId; this.stateId = sid; this.fileName = fileName; this.title = shownTitle;
    this.titleIsFolder = multi; this.variants = variants; this.curHeight = height;
    history.clearPlayState(sid);
    this.pos = 0; this.dur = 0;
    this.recordHistory(); this.publishInfo();
    this.engine.osd((manual ? 'Episode: ' : 'Agla episode: ') + stripExt(shownTitle) + (multi && height ? '  (' + this.qLabel(height) + ')' : ''));
    this.engine.load(this.urlFor(fileId, fileName), this.shownTitle(), 0);
    this.discoverSubtitles();
  }

  // ---- quality ----
  async cycleQuality(wantH) {
    if (this.switching) return;
    if (!this.variants || this.variants.length < 2) return this.engine.osd('Is video ki sirf ek quality hai');
    let v;
    if (wantH) v = this.variants.find((x) => x.h === wantH);
    else { const i = this.variants.findIndex((x) => x.h === this.curHeight); v = this.variants[(i + 1) % this.variants.length]; }
    if (!v || v.h === this.curHeight) return;
    this.switching = true; this.engine.osd('Quality: ' + (v.label || drive.qualityLabel(v.h)) + ' ...');
    const pos = this.pos; this.savePos();
    try {
      let fid = v.file, fname = v.fname;
      if (!fid) {
        const token = await tokens.getValidAccessToken();
        const f = await drive.firstVideoInFolder(token, v.fid);
        if (!f) throw new Error('none');
        fid = f.id; fname = f.name; v.file = fid; v.fname = fname;
      }
      this.curHeight = v.h; this.fileId = fid; this.fileName = fname;
      if (this.hKey) history.setQualityPref(this.hKey, v.h);
      this.publishInfo();
      await this.engine.load(this.urlFor(fid, fname), this.shownTitle(), pos);
      this.engine.osd('Quality: ' + (v.label || drive.qualityLabel(v.h)));
      this.discoverSubtitles();
    } catch (e) { this.engine.osd('Ye quality abhi available nahi hai'); }
    finally { this.switching = false; }
  }

  // ---- subtitles (same Drive folder: .srt/.vtt/.ass named like the video) ----
  async discoverSubtitles() {
    const myGen = ++this.gen;
    const base = stripExt(this.fileName || this.title);
    if (!base || !this.fileId) return;
    try {
      const token = await tokens.getValidAccessToken();
      if (!token) return;
      const real = await drive.resolveActualFileId(token, this.fileId);
      const parent = await drive.getParentId(token, real);
      if (!parent) return;
      const nb = norm(base);
      const files = (await drive.listFiles(token, parent)).files || [];
      for (const f of files) {
        const n = f.name || '';
        if (!SUB_RE.test(n)) continue;
        if (!norm(n.replace(/\.[^.]+$/, '')).startsWith(nb)) continue;
        if (myGen !== this.gen || this.closed) return;
        this.engine.addSub(server.subUrl(f.id), subLabel(n, base));
      }
    } catch (e) { /* offline / koi subtitle nahi */ }
  }
}

module.exports = { Session };
