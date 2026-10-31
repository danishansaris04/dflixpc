'use strict';
// OAuth token store (encrypted) + auto refresh. Lifetime login: refresh token encrypted file me.
const store = require('./store');
const net = require('./http');

const CLIENT_ID = process.env.DFLIX_CLIENT_ID || '89188069759-chhqnlnbggmt0n6el64he8cm940dcg24.apps.googleusercontent.com';
const CLIENT_SECRET = process.env.DFLIX_CLIENT_SECRET || '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';
const PORT = 8765;
const REDIRECT_URI = 'http://127.0.0.1:' + PORT + '/oauth2callback';
const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const TOKEN_URL = process.env.DFLIX_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const S = 'auth';

let refreshing = null;

function isLoggedIn() { return !!getRefreshToken(); }
function getRefreshToken() { return store.getItem(S, 'refresh_token', null); }

function saveTokens(access, refresh, expiresIn) {
  store.setItem(S, 'access_token', access);
  store.setItem(S, 'expires_at', Date.now() + expiresIn * 1000 - 60000);
  if (refresh) store.setItem(S, 'refresh_token', refresh);
}
function logout() { store.clear(S); }

function authUrl() {
  return 'https://accounts.google.com/o/oauth2/v2/auth?client_id=' + encodeURIComponent(CLIENT_ID)
    + '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) + '&response_type=code&access_type=offline&prompt=consent'
    + '&scope=' + encodeURIComponent(SCOPE);
}

async function getValidAccessToken() {
  const at = store.getItem(S, 'access_token', null);
  if (at && Date.now() < store.getItem(S, 'expires_at', 0)) return at;
  const rt = getRefreshToken();
  if (!rt) return null;
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const j = await net.postForm(TOKEN_URL, {
        client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: rt, grant_type: 'refresh_token',
      });
      if (!j.access_token) throw new Error(j.error || 'no access_token');
      saveTokens(j.access_token, null, j.expires_in || 3600);
      return j.access_token;
    } catch (e) {
      console.error('Token refresh failed:', e.message);
      return null;
    } finally { refreshing = null; }
  })();
  return refreshing;
}

async function exchangeCode(code) {
  try {
    const j = await net.postForm(TOKEN_URL, {
      code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: REDIRECT_URI, grant_type: 'authorization_code',
    });
    if (!j.access_token) throw new Error(j.error_description || j.error || 'no token');
    saveTokens(j.access_token, j.refresh_token || null, j.expires_in || 3600);
    return true;
  } catch (e) { console.error('Code exchange failed:', e.message); return false; }
}

module.exports = { PORT, REDIRECT_URI, isLoggedIn, getRefreshToken, getValidAccessToken, exchangeCode, logout, authUrl };
