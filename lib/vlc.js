'use strict';
// VLC dhoondhna (registry + Program Files + vendor\vlc + user ka chuna hua path) aur stream kholna
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

function regInstallDir(key) {
  try {
    const out = execFileSync('reg', ['query', key, '/v', 'InstallDir'], { windowsHide: true, timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    const m = /InstallDir\s+REG_SZ\s+(.+)/i.exec(out);
    return m ? m[1].trim() : null;
  } catch (e) { return null; }
}

function findVlc(extraDirs, savedPath) {
  const cands = [];
  if (savedPath) cands.push(savedPath);
  (extraDirs || []).forEach((d) => cands.push(path.join(d, 'vlc.exe')));
  if (process.platform === 'win32') {
    ['HKLM\\SOFTWARE\\VideoLAN\\VLC', 'HKLM\\SOFTWARE\\WOW6432Node\\VideoLAN\\VLC', 'HKCU\\SOFTWARE\\VideoLAN\\VLC'].forEach((k) => {
      const d = regInstallDir(k); if (d) cands.push(path.join(d, 'vlc.exe'));
    });
    ['ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432'].forEach((e) => { if (process.env[e]) cands.push(path.join(process.env[e], 'VideoLAN', 'VLC', 'vlc.exe')); });
  } else {
    cands.push('/usr/bin/vlc', '/usr/local/bin/vlc', '/Applications/VLC.app/Contents/MacOS/VLC');
  }
  for (const c of cands) { try { if (c && fs.existsSync(c)) return c; } catch (e) { /* skip */ } }
  return null;
}

/** VLC me stream kholta hai. Resolve(true) = process start ho gaya, reject = start nahi hua. */
function openStream(exe, url, title, startMs) {
  return new Promise((resolve, reject) => {
    const args = [];
    if (startMs > 3000) args.push('--start-time=' + Math.floor(startMs / 1000));
    args.push(url);
    if (title) args.push(':meta-title=' + String(title).replace(/[\r\n]/g, ' '));
    let child;
    try { child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false }); } catch (e) { return reject(e); }
    let settled = false;
    child.on('error', (e) => { if (!settled) { settled = true; reject(e); } });
    child.on('spawn', () => { if (!settled) { settled = true; try { child.unref(); } catch (e) { /* ignore */ } resolve(true); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.unref(); } catch (e) { /* ignore */ } resolve(true); } }, 2500);
  });
}

module.exports = { findVlc, openStream };
