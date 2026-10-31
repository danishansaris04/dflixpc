'use strict';
// PC ki details (admin panel me dikhti hain) + stable device id
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const store = require('./store');

function winName(rel) {
  const [maj, min, build] = rel.split('.').map((x) => parseInt(x, 10) || 0);
  if (maj === 6 && min === 0) return 'Windows Vista';
  if (maj === 6 && min === 1) return 'Windows 7';
  if (maj === 6 && min === 2) return 'Windows 8';
  if (maj === 6 && min === 3) return 'Windows 8.1';
  if (maj === 10) return build >= 22000 ? 'Windows 11' : 'Windows 10';
  return 'Windows ' + rel;
}
function reg(args) {
  try { return execFileSync('reg', args, { windowsHide: true, timeout: 4000 }).toString(); } catch (e) { return ''; }
}
function machineGuid() {
  const m = /MachineGuid\s+REG_SZ\s+(\S+)/i.exec(reg(['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid']));
  return m ? m[1] : '';
}
function getDeviceId() {
  let id = store.getItem('user', 'uid', null);
  if (id) return id;
  // MachineGuid se bana id: uninstall/reinstall ke baad bhi same -> block bach nahi sakta
  let seed = machineGuid();
  if (!seed) {
    const nics = Object.values(os.networkInterfaces()).flat().filter((n) => n && !n.internal && n.mac && n.mac !== '00:00:00:00:00:00');
    seed = (nics[0] ? nics[0].mac : '') + '|' + os.hostname();
  }
  if (!seed || seed === '|') seed = crypto.randomBytes(16).toString('hex');
  id = 'pc_' + crypto.createHash('sha256').update('dflix|' + seed).digest('hex').slice(0, 24);
  store.setItem('user', 'uid', id);
  return id;
}
function info(appVersion, screenInfo) {
  const cpus = os.cpus() || [];
  let username = ''; try { username = os.userInfo().username; } catch (e) {}
  return {
    model: os.hostname(),
    username,
    os: winName(os.release()) + ' (' + os.release() + ', ' + os.arch() + ')',
    cpu: cpus[0] ? cpus[0].model.replace(/\s+/g, ' ').trim() + ' x' + cpus.length : '',
    ramGB: Math.round((os.totalmem() / 1073741824) * 10) / 10,
    screen: screenInfo || '',
    platform: 'windows',
    appVersionName: appVersion,
  };
}
module.exports = { getDeviceId, info, winName };
