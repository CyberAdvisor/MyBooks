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
// is kept in memory only (state.accessToken) and re-derived from the
// refresh token whenever the app restarts.
const REFRESH_TOKEN_KEY = 'dbx_refresh_token';
// The PKCE code verifier only needs to survive the redirect round-trip to
// Dropbox and back, so sessionStorage (not localStorage) is enough for it.
const CODE_VERIFIER_KEY = 'dbx_code_verifier';

const state = {
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

/** Derives the PKCE code challenge (SHA-256 of the verifier, base64url). */
async function generateCodeChallenge(verifier) {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(new Uint8Array(digest));
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
  state.accessToken = null;
  state.accessTokenExpiresAt = 0;
}

// ---------- OAuth flow ----------

/**
 * Starts the Dropbox OAuth PKCE flow by redirecting the browser to
 * Dropbox's consent screen. The user is sent back to DBX_REDIRECT_URI with
 * a ?code=... query param, which handleAuthRedirect() picks up on the next
 * page load.
 */
async function connect() {
  const verifier = generateCodeVerifier();
  sessionStorage.setItem(CODE_VERIFIER_KEY, verifier);
  const challenge = await generateCodeChallenge(verifier);

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
  state.accessToken = data.access_token;
  state.accessTokenExpiresAt = Date.now() + data.expires_in * 1000;
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
  if (state.accessToken && Date.now() < state.accessTokenExpiresAt - 60000) {
    return state.accessToken;
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
  state.accessToken = data.access_token;
  state.accessTokenExpiresAt = Date.now() + data.expires_in * 1000;
  return state.accessToken;
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
