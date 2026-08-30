/**
 * dropbox.test.js
 * Plain Node unit tests for dropbox.js. Runs outside a browser, so the
 * handful of browser globals dropbox.js relies on (localStorage,
 * sessionStorage, window.location/history, fetch) are stubbed here with
 * small in-memory fakes - the same "stub the network boundary, exercise
 * the real logic around it" approach app.test.js uses for api.js's fetch
 * calls, just without needing jsdom for a module with no DOM interaction
 * of its own.
 *
 * Run with: node dropbox.test.js
 * No dependencies required (Node's built-in crypto/fetch/btoa cover
 * everything dropbox.js itself uses).
 */
const assert = require('assert');

// ---------- Browser global stubs ----------

function makeStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
}

global.localStorage = makeStorage();
global.sessionStorage = makeStorage();
global.window = {
  location: { href: 'https://mybooks.fyi/mybooks/' },
  history: {
    // A real browser's replaceState() updates location.href without a
    // reload - mimic that here so tests can assert on the visible URL
    // after handleAuthRedirect() strips ?code from it.
    replaceState: (state, title, url) => { global.window.location.href = url; },
  },
};

const dropbox = require('./js/dropbox.js');

let pass = 0, fail = 0;
async function test(label, fn) {
  try {
    await fn();
    pass++;
    console.log('PASS -', label);
  } catch (e) {
    fail++;
    console.log('FAIL -', label);
    console.log('      ', e.message);
  }
}

/** Resets all connection state (stored + in-memory) between tests. */
function resetConnection() {
  dropbox.disconnect();
  global.sessionStorage.removeItem('dbx_code_verifier');
  global.window.location.href = 'https://mybooks.fyi/mybooks/';
}

/** Fakes a connected account with a valid cached access token, so tests
 * that only care about upload/download don't also need to exercise the
 * token-refresh exchange. */
function fakeConnected() {
  global.localStorage.setItem('dbx_refresh_token', 'fake-refresh-token');
}

async function main() {

// ---------- Connection state ----------

await test('isConnected/disconnect: reflects whether a refresh token is stored', () => {
  resetConnection();
  assert.strictEqual(dropbox.isConnected(), false);
  fakeConnected();
  assert.strictEqual(dropbox.isConnected(), true);
  dropbox.disconnect();
  assert.strictEqual(dropbox.isConnected(), false);
});

// ---------- OAuth flow ----------

await test('connect: redirects to Dropbox authorize URL with PKCE challenge, and stashes the verifier', async () => {
  resetConnection();
  await dropbox.connect();
  const redirectUrl = new URL(global.window.location.href);
  assert.strictEqual(redirectUrl.origin + redirectUrl.pathname, 'https://www.dropbox.com/oauth2/authorize');
  assert.strictEqual(redirectUrl.searchParams.get('client_id'), '9b5g5jkx9g39gaq');
  assert.strictEqual(redirectUrl.searchParams.get('response_type'), 'code');
  assert.strictEqual(redirectUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.strictEqual(redirectUrl.searchParams.get('redirect_uri'), 'https://mybooks.fyi/mybooks/');
  assert.ok(redirectUrl.searchParams.get('code_challenge')); // present, non-empty
  assert.ok(global.sessionStorage.getItem('dbx_code_verifier')); // saved for the return trip
});

await test('connect: has no pending microtask before the redirect (Safari drops navigations that happen after an await)', () => {
  resetConnection();
  // If connect() were async, this call would return a Promise before
  // location.href is ever set, and the assertion below would fail.
  const result = dropbox.connect();
  assert.strictEqual(result, undefined, 'connect() must run synchronously, not return a Promise');
  assert.ok(global.window.location.href.startsWith('https://www.dropbox.com/oauth2/authorize'));
});

await test('connect: two back-to-back calls (no await between them) each complete their own redirect synchronously', () => {
  resetConnection();
  // If connect() yielded to a microtask before redirecting (the old async
  // bug), the href check right after the first call below would still see
  // the pre-redirect URL.
  dropbox.connect();
  const firstHref = global.window.location.href;
  const firstVerifier = global.sessionStorage.getItem('dbx_code_verifier');
  assert.ok(firstHref.startsWith('https://www.dropbox.com/oauth2/authorize'));

  dropbox.connect();
  const secondHref = global.window.location.href;
  const secondVerifier = global.sessionStorage.getItem('dbx_code_verifier');
  assert.ok(secondHref.startsWith('https://www.dropbox.com/oauth2/authorize'));
  assert.notStrictEqual(firstVerifier, secondVerifier, 'each connect() call generates a fresh PKCE verifier');
});

await test('handleAuthRedirect: no ?code in the URL is a no-op, resolves false', async () => {
  resetConnection();
  global.window.location.href = 'https://mybooks.fyi/mybooks/';
  const handled = await dropbox.handleAuthRedirect();
  assert.strictEqual(handled, false);
  assert.strictEqual(dropbox.isConnected(), false);
});

await test('handleAuthRedirect: exchanges the code for tokens, stores refresh token, strips ?code from the URL', async () => {
  resetConnection();
  global.sessionStorage.setItem('dbx_code_verifier', 'test-verifier');
  global.window.location.href = 'https://mybooks.fyi/mybooks/?code=abc123&state=xyz';

  let tokenRequestBody = null;
  global.fetch = async (url, opts) => {
    assert.strictEqual(url, 'https://api.dropboxapi.com/oauth2/token');
    tokenRequestBody = opts.body.toString();
    return {
      ok: true,
      json: async () => ({ access_token: 'at1', refresh_token: 'rt1', expires_in: 14400 }),
    };
  };

  const handled = await dropbox.handleAuthRedirect();
  assert.strictEqual(handled, true);
  assert.strictEqual(dropbox.isConnected(), true);
  assert.ok(tokenRequestBody.includes('grant_type=authorization_code'));
  assert.ok(tokenRequestBody.includes('code=abc123'));
  assert.ok(tokenRequestBody.includes('code_verifier=test-verifier'));
  // The code (and state) must not linger in the visible URL after handling.
  assert.strictEqual(global.window.location.href.includes('code='), false);
});

await test('handleAuthRedirect: missing verifier (e.g. lost sessionStorage) throws rather than exchanging blindly', async () => {
  resetConnection();
  global.window.location.href = 'https://mybooks.fyi/mybooks/?code=abc123';
  await assert.rejects(() => dropbox.handleAuthRedirect(), /verifier/i);
});

await test('handleAuthRedirect: a failed token exchange throws a user-presentable error', async () => {
  resetConnection();
  global.sessionStorage.setItem('dbx_code_verifier', 'test-verifier');
  global.window.location.href = 'https://mybooks.fyi/mybooks/?code=abc123';
  global.fetch = async () => ({ ok: false });
  await assert.rejects(() => dropbox.handleAuthRedirect(), /sign-in failed/i);
});

// ---------- File operations ----------

await test('uploadBackup: refreshes an access token, then PUTs the JSON to the app-folder file', async () => {
  resetConnection();
  fakeConnected();
  const books = [{ title: 'Dune', author: 'Frank Herbert' }];
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push(url);
    if (url === 'https://api.dropboxapi.com/oauth2/token') {
      return { ok: true, json: async () => ({ access_token: 'at1', expires_in: 14400 }) };
    }
    if (url === 'https://content.dropboxapi.com/2/files/upload') {
      assert.strictEqual(opts.headers.Authorization, 'Bearer at1');
      const arg = JSON.parse(opts.headers['Dropbox-API-Arg']);
      assert.strictEqual(arg.path, '/library-backup.json');
      assert.strictEqual(arg.mode, 'overwrite');
      assert.deepStrictEqual(JSON.parse(opts.body), books);
      return { ok: true, json: async () => ({ client_modified: '2026-08-30T12:00:00Z' }) };
    }
    throw new Error('unexpected fetch: ' + url);
  };
  const meta = await dropbox.uploadBackup(books);
  assert.strictEqual(meta.client_modified, '2026-08-30T12:00:00Z');
  assert.deepStrictEqual(calls, ['https://api.dropboxapi.com/oauth2/token', 'https://content.dropboxapi.com/2/files/upload']);
});

await test('uploadBackup: throws if Dropbox\'s 200 response is missing client_modified (e.g. a blocker faking success)', async () => {
  resetConnection();
  fakeConnected();
  global.fetch = async (url) => {
    if (url === 'https://api.dropboxapi.com/oauth2/token') {
      return { ok: true, json: async () => ({ access_token: 'at1', expires_in: 14400 }) };
    }
    return { ok: true, json: async () => ({}) }; // no client_modified at all
  };
  await assert.rejects(() => dropbox.uploadBackup([]), /did not confirm the upload/i);
});

await test('uploadBackup: a cached, still-valid access token skips the refresh call', async () => {
  resetConnection();
  fakeConnected();
  let refreshCalls = 0;
  global.fetch = async (url) => {
    if (url === 'https://api.dropboxapi.com/oauth2/token') {
      refreshCalls++;
      return { ok: true, json: async () => ({ access_token: 'at1', expires_in: 14400 }) };
    }
    return { ok: true, json: async () => ({ client_modified: '2026-08-30T12:00:00Z' }) };
  };
  await dropbox.uploadBackup([]);
  await dropbox.uploadBackup([]); // second call, token still fresh
  assert.strictEqual(refreshCalls, 1);
});

await test('uploadBackup: throws a user-presentable error including Dropbox\'s own error_summary', async () => {
  resetConnection();
  fakeConnected();
  global.fetch = async (url) => {
    if (url === 'https://api.dropboxapi.com/oauth2/token') {
      return { ok: true, json: async () => ({ access_token: 'at1', expires_in: 14400 }) };
    }
    return {
      ok: false,
      status: 403,
      text: async () => JSON.stringify({ error_summary: 'missing_scope/...' }),
    };
  };
  await assert.rejects(() => dropbox.uploadBackup([]), /could not sync.*missing_scope/is);
});

await test('uploadBackup: falls back to the raw response body when it is not JSON', async () => {
  resetConnection();
  fakeConnected();
  global.fetch = async (url) => {
    if (url === 'https://api.dropboxapi.com/oauth2/token') {
      return { ok: true, json: async () => ({ access_token: 'at1', expires_in: 14400 }) };
    }
    return { ok: false, status: 500, text: async () => 'Internal Server Error' };
  };
  await assert.rejects(() => dropbox.uploadBackup([]), /could not sync.*Internal Server Error/is);
});

const TEMP_LINK_URL = 'https://api.dropboxapi.com/2/files/get_temporary_link';
const FAKE_CONTENT_URL = 'https://dl.dropboxusercontent.com/fake-link';

await test('downloadBackup: goes through get_temporary_link, then a plain GET, and returns the parsed books array', async () => {
  resetConnection();
  fakeConnected();
  const books = [{ title: 'Emma', author: 'Jane Austen' }];
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push(url);
    if (url === 'https://api.dropboxapi.com/oauth2/token') {
      return { ok: true, json: async () => ({ access_token: 'at1', expires_in: 14400 }) };
    }
    if (url === TEMP_LINK_URL) {
      assert.strictEqual(opts.headers.Authorization, 'Bearer at1');
      assert.deepStrictEqual(JSON.parse(opts.body), { path: '/library-backup.json' });
      return { ok: true, json: async () => ({ link: FAKE_CONTENT_URL }) };
    }
    if (url === FAKE_CONTENT_URL) {
      // The content fetch itself is a plain, header-less GET - no opts at all.
      assert.strictEqual(opts, undefined);
      return { ok: true, text: async () => JSON.stringify(books) };
    }
    throw new Error('unexpected fetch: ' + url);
  };
  assert.deepStrictEqual(await dropbox.downloadBackup(), books);
  assert.deepStrictEqual(calls, [
    'https://api.dropboxapi.com/oauth2/token',
    TEMP_LINK_URL,
    FAKE_CONTENT_URL,
  ]);
});

await test('downloadBackup: resolves null (not an error) when no backup exists yet', async () => {
  resetConnection();
  fakeConnected();
  global.fetch = async (url) => {
    if (url === 'https://api.dropboxapi.com/oauth2/token') {
      return { ok: true, json: async () => ({ access_token: 'at1', expires_in: 14400 }) };
    }
    return { ok: false, status: 409 };
  };
  assert.strictEqual(await dropbox.downloadBackup(), null);
});

await test('downloadBackup: throws if the remote file is not a books array', async () => {
  resetConnection();
  fakeConnected();
  global.fetch = async (url) => {
    if (url === 'https://api.dropboxapi.com/oauth2/token') {
      return { ok: true, json: async () => ({ access_token: 'at1', expires_in: 14400 }) };
    }
    if (url === TEMP_LINK_URL) {
      return { ok: true, json: async () => ({ link: FAKE_CONTENT_URL }) };
    }
    return { ok: true, text: async () => JSON.stringify({ not: 'an array' }) };
  };
  await assert.rejects(() => dropbox.downloadBackup(), /not in the expected format/i);
});

await test('downloadBackup: throws if the content fetch returns non-JSON (e.g. a blocker returning a stub body)', async () => {
  resetConnection();
  fakeConnected();
  global.fetch = async (url) => {
    if (url === 'https://api.dropboxapi.com/oauth2/token') {
      return { ok: true, json: async () => ({ access_token: 'at1', expires_in: 14400 }) };
    }
    if (url === TEMP_LINK_URL) {
      return { ok: true, json: async () => ({ link: FAKE_CONTENT_URL }) };
    }
    return { ok: true, text: async () => '' };
  };
  await assert.rejects(() => dropbox.downloadBackup(), /not in the expected format/i);
});

await test('getRemoteModifiedTime: returns a Date for an existing file', async () => {
  resetConnection();
  fakeConnected();
  global.fetch = async (url) => {
    if (url === 'https://api.dropboxapi.com/oauth2/token') {
      return { ok: true, json: async () => ({ access_token: 'at1', expires_in: 14400 }) };
    }
    return { ok: true, json: async () => ({ client_modified: '2026-08-30T12:00:00Z' }) };
  };
  const result = await dropbox.getRemoteModifiedTime();
  assert.ok(result instanceof Date);
  assert.strictEqual(result.toISOString(), '2026-08-30T12:00:00.000Z');
});

await test('getRemoteModifiedTime: resolves null (not an error) when no backup exists yet', async () => {
  resetConnection();
  fakeConnected();
  global.fetch = async (url) => {
    if (url === 'https://api.dropboxapi.com/oauth2/token') {
      return { ok: true, json: async () => ({ access_token: 'at1', expires_in: 14400 }) };
    }
    return { ok: false, status: 409 };
  };
  assert.strictEqual(await dropbox.getRemoteModifiedTime(), null);
});

await test('getAccessToken (via uploadBackup): an expired/invalid refresh token disconnects and throws', async () => {
  resetConnection();
  fakeConnected();
  global.fetch = async () => ({ ok: false });
  await assert.rejects(() => dropbox.uploadBackup([]), /reconnect/i);
  assert.strictEqual(dropbox.isConnected(), false); // disconnect() should have run
});

await test('any file operation without a connected account throws immediately (no fetch attempted)', async () => {
  resetConnection();
  global.fetch = async () => { throw new Error('should not be called'); };
  await assert.rejects(() => dropbox.uploadBackup([]), /not connected/i);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

}

main();
