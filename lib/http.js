'use strict';
// Chhote https helpers (Node 16 / Electron 22 me fetch nahi hota)
const https = require('https');
const http = require('http');
const { URL } = require('url');

const agentS = new https.Agent({ keepAlive: true, maxSockets: 16 });
const agentP = new http.Agent({ keepAlive: true, maxSockets: 16 });

function request(urlStr, opts) {
  opts = opts || {};
  const u = new URL(urlStr);
  const lib = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port || undefined,
      path: u.pathname + u.search, method: opts.method || 'GET',
      headers: opts.headers || {}, agent: u.protocol === 'https:' ? agentS : agentP,
    }, resolve);
    req.setTimeout(opts.timeout || 20000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (opts.signal) opts.signal.addEventListener('abort', () => req.destroy(new Error('aborted')));
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function readAll(res) {
  return new Promise((resolve, reject) => {
    const parts = [];
    res.on('data', (d) => parts.push(d));
    res.on('end', () => resolve(Buffer.concat(parts)));
    res.on('error', reject);
  });
}

async function getBuffer(url, headers, timeout) {
  const res = await request(url, { headers, timeout });
  const body = await readAll(res);
  return { status: res.statusCode, headers: res.headers, body };
}
async function getJson(url, headers, timeout) {
  const r = await getBuffer(url, headers, timeout);
  let j = null;
  try { j = JSON.parse(r.body.toString('utf8')); } catch (e) { /* not json */ }
  if (r.status >= 400) {
    const err = new Error('HTTP ' + r.status);
    err.status = r.status; err.json = j;
    throw err;
  }
  return j;
}
async function postForm(url, fields) {
  const body = Object.keys(fields).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(fields[k])).join('&');
  const res = await request(url, {
    method: 'POST', body,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
  });
  const buf = await readAll(res);
  return JSON.parse(buf.toString('utf8'));
}
async function sendJson(url, method, obj) {
  const body = JSON.stringify(obj);
  const res = await request(url, {
    method: 'POST', body, timeout: 10000,
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-HTTP-Method-Override': method },
  });
  await readAll(res);
  return res.statusCode;
}

module.exports = { request, readAll, getBuffer, getJson, postForm, sendJson };
