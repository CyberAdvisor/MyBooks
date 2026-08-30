/**
 * dropbox.js
 * Cross-device sync via Dropbox (App Folder scope, OAuth 2.0 with PKCE - no
 * client secret is embedded in this file, since a static browser app can't
 * keep one confidential).
 *
 * This module only ever reads/writes a single file, LIBRARY_FILE_PATH, in
 * the app's dedicated Dropbox folder (Apps/<app name>/). It never touches
 * anything else in the user's Dropbox.
 *
 * Sync model (deliberately simple - see CLAUDE_CONTEXT.md if this file gets
 * extended): whole-library, last-write-wins, no per-book merge. app.js is
 * responsible for calling getRemoteModifiedTime()/downloadBackup() on
 * startup and uploadBackup() from a manual "Sync Now" action; this module
 * only exposes the Dropbox operations themselves, no app-level policy.
 */

const DBX_APP_KEY = '9b5g5jkx9g39gaq';
const DBX_REDIRECT_URI = 'https://mybooks.fyi/mybooks/';
const LIBRARY_FILE_PATH = '/library-backup.json';

// Refresh token is long-lived and persisted; the short-lived access token
// is kept in memory only (dbxState.accessToken) and re-derived from the
// refresh token whenever the app restarts.
const REFRESH_TOKEN_KEY = 'dbx_refresh_token';
// The PKCE code verifier only needs to survive the redirect round-trip to
// Dropbox and back, so sessionStorage (not localStorage) is enough for it.
const CODE_VERIFIER_KEY = 'dbx_code_verifier';

const dbxState = {
  accessToken: null,
  accessTokenExpiresAt: 0, // epoch ms
};

// ---------- PKCE helpers ----------

/** Generates a random, URL-safe string for use as a PKCE code verifier. */
function generateCodeVerifier() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/**
 * Derives the PKCE code challenge (SHA-256 of the verifier, base64url).
 *
 * Deliberately synchronous. This used to call the async
 * crypto.subtle.digest(), but Safari can silently drop a
 * window.location.href navigation that happens after an await - even a
 * very short one - with no error and no popup-blocked indicator; it just
 * doesn't navigate. connect() below needs to run start-to-finish with zero
 * awaits before the redirect, so the digest is computed with the
 * self-contained, synchronous sha256() implementation instead.
 */
function generateCodeChallenge(verifier) {
  const data = new TextEncoder().encode(verifier);
  return base64UrlEncode(sha256(data));
}

// ---------- Synchronous SHA-256 (see generateCodeChallenge above) ----------

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x, n) {
  return (x >>> n) | (x << (32 - n));
}

/** Pure-JS, synchronous SHA-256. Takes a Uint8Array, returns a 32-byte Uint8Array digest. */
function sha256(message) {
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

  const bitLen = message.length * 8;
  const paddedLen = (((message.length + 9 + 63) >> 6) << 6);
  const padded = new Uint8Array(paddedLen);
  padded.set(message);
  padded[message.length] = 0x80;
  // 64-bit big-endian bit length in the final 8 bytes (bitLen fits in 32
  // bits for any input this app will ever hash, so the high word is 0).
  const dv = new DataView(padded.buffer);
  dv.setUint32(paddedLen - 4, bitLen >>> 0, false);

  const w = new Uint32Array(64);
  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = dv.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }

    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[i] + w[i]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + temp1) | 0;
      d = c; c = b; b = a; a = (temp1 + temp2) | 0;
    }

    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  [h0, h1, h2, h3, h4, h5, h6, h7].forEach((h, i) => outView.setUint32(i * 4, h >>> 0, false));
  return out;
}

function base64UrlEncode(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ---------- Connection state ----------

function getStoredRefreshToken() {
  return localStorage.getItem(REFRESH_TOKEN_KEY);
}

/** Whether a Dropbox account is currently linked (has a stored refresh token). */
function isConnected() {
  return !!getStoredRefreshToken();
}

/** Forgets the linked Dropbox account. Does not affect files already synced. */
function disconnect() {
  localStorage.removeItem(REFRESH_TOKEN_KEY);
  dbxState.accessToken = null;
  dbxState.accessTokenExpiresAt = 0;
}

// ---------- OAuth flow ----------

/**
 * Starts the Dropbox OAuth PKCE flow by redirecting the browser to
 * Dropbox's consent screen. The user is sent back to DBX_REDIRECT_URI with
 * a ?code=... query param, which handleAuthRedirect() picks up on the next
 * page load.
 *
 * Deliberately synchronous, with zero awaits before window.location.href is
 * set - see the comment on generateCodeChallenge() above.
 */
function connect() {
  const verifier = generateCodeVerifier();
  sessionStorage.setItem(CODE_VERIFIER_KEY, verifier);
  const challenge = generateCodeChallenge(verifier);

  const params = new URLSearchParams({
    client_id: DBX_APP_KEY,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    redirect_uri: DBX_REDIRECT_URI,
    token_access_type: 'offline', // requests a refresh token, not just a short-lived access token
  });
  window.location.href = `https://www.dropbox.com/oauth2/authorize?${params.toString()}`;
}

/**
 * Call once on app startup. If the current URL carries a Dropbox auth code
 * (i.e. the user just came back from connect()), exchanges it for tokens,
 * stores the refresh token, and strips the code from the URL so a page
 * refresh doesn't try to reuse it. Resolves true if a code was handled,
 * false otherwise (nothing to do).
 */
async function handleAuthRedirect() {
  const url = new URL(window.location.href);
  const code = url.searchParams.get('code');
  if (!code) return false;

  const verifier = sessionStorage.getItem(CODE_VERIFIER_KEY);
  sessionStorage.removeItem(CODE_VERIFIER_KEY);

  // Always strip ?code (and ?state, if present) from the visible URL, even
  // on failure below, so a reload never resubmits a spent auth code.
  url.searchParams.delete('code');
  url.searchParams.delete('state');
  window.history.replaceState({}, '', url.toString());

  if (!verifier) {
    throw new Error('Dropbox sign-in could not be completed (missing verifier). Please try connecting again.');
  }

  const resp = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      grant_type: 'authorization_code',
      client_id: DBX_APP_KEY,
      redirect_uri: DBX_REDIRECT_URI,
      code_verifier: verifier,
    }),
  });
  if (!resp.ok) {
    throw new Error('Dropbox sign-in failed. Please try connecting again.');
  }
  const data = await resp.json();
  localStorage.setItem(REFRESH_TOKEN_KEY, data.refresh_token);
  dbxState.accessToken = data.access_token;
  dbxState.accessTokenExpiresAt = Date.now() + data.expires_in * 1000;
  return true;
}

/**
 * Returns a valid access token, refreshing it via the stored refresh token
 * if the cached one is missing or about to expire. Throws if not connected.
 */
async function getAccessToken() {
  const refreshToken = getStoredRefreshToken();
  if (!refreshToken) {
    throw new Error('Dropbox is not connected.');
  }
  // 60s safety margin before expiry.
  if (dbxState.accessToken && Date.now() < dbxState.accessTokenExpiresAt - 60000) {
    return dbxState.accessToken;
  }

  const resp = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: DBX_APP_KEY,
    }),
  });
  if (!resp.ok) {
    // Refresh token itself is invalid/revoked - the user needs to reconnect.
    disconnect();
    throw new Error('Dropbox connection expired. Please reconnect.');
  }
  const data = await resp.json();
  dbxState.accessToken = data.access_token;
  dbxState.accessTokenExpiresAt = Date.now() + data.expires_in * 1000;
  return dbxState.accessToken;
}

// ---------- File operations ----------

/**
 * Uploads the given books array to the app-folder backup file, overwriting
 * whatever was there. Mirrors the same JSON shape app.js's Backup Now
 * writes to a local file (see handleBackupNow in app.js).
 */
async function uploadBackup(books) {
  const token = await getAccessToken();
  const json = JSON.stringify(books, null, 2);

  const resp = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': JSON.stringify({
        path: LIBRARY_FILE_PATH,
        mode: 'overwrite',
        mute: true, // don't generate a Dropbox notification for this app-internal write
      }),
    },
    body: json,
  });
  if (!resp.ok) {
    throw new Error('Could not sync to Dropbox. Please try again.');
  }
  return resp.json(); // file metadata, including the new client_modified
}

/**
 * Downloads and parses the app-folder backup file. Resolves null if no
 * backup has ever been uploaded yet (not an error - e.g. first connect on
 * a fresh account), rather than throwing.
 */
async function downloadBackup() {
  const token = await getAccessToken();
  const resp = await fetch('https://content.dropboxapi.com/2/files/download', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Dropbox-API-Arg': JSON.stringify({ path: LIBRARY_FILE_PATH }),
    },
  });
  if (resp.status === 409) {
    // path/not_found - nothing has been uploaded yet.
    return null;
  }
  if (!resp.ok) {
    throw new Error('Could not fetch your library from Dropbox. Please try again.');
  }
  const books = await resp.json();
  if (!Array.isArray(books)) {
    throw new Error('The library file in Dropbox is not in the expected format.');
  }
  return books;
}

/**
 * Returns the backup file's last-modified time as a Date, or null if no
 * backup exists yet in the app folder. Used on startup to decide whether
 * the remote copy is newer than what's stored locally, without downloading
 * the (potentially large, cover-image-laden) full file just to check.
 */
async function getRemoteModifiedTime() {
  const token = await getAccessToken();
  const resp = await fetch('https://api.dropboxapi.com/2/files/get_metadata', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ path: LIBRARY_FILE_PATH }),
  });
  if (resp.status === 409) {
    return null; // path/not_found
  }
  if (!resp.ok) {
    throw new Error('Could not check Dropbox for updates.');
  }
  const data = await resp.json();
  return new Date(data.client_modified);
}

// Exported as a single namespaced object, matching every other module in
// this app: `dropbox.connect()`, `dropbox.uploadBackup()`, etc. In the
// browser this becomes `window.dropbox`; under Node (tests) it's
// module.exports.
const dropboxExports = {
  isConnected,
  disconnect,
  connect,
  handleAuthRedirect,
  uploadBackup,
  downloadBackup,
  getRemoteModifiedTime,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = dropboxExports;
} else if (typeof window !== 'undefined') {
  window.dropbox = dropboxExports;
}
