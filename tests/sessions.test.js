'use strict';

// Signed-in devices, and what the browser extension asks of the API: a session
// handed out by a device already in, the list of devices and signing one out,
// "is this page saved already?", and the audit trail saying where a change
// came from. The extension's own code is tested in extension/test.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createApp } = require('../api/server');
const { hashToken } = require('../api/db');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bookmarks-sessions-'));
const app = createApp(path.join(dir, 'bookmarks.db'));
let base;

test.before(async () => {
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

test.after(() => {
  app.server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function call(method, p, { token, body, headers = {} } = {}) {
  const res = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const CHROME_LINUX = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

let key;
let web;

test('signing in names the session after the browser, or what the client says', async () => {
  const v = await call('POST', '/api/auth/vault', { body: { name: 'mine' }, headers: { 'user-agent': CHROME_LINUX } });
  key = v.body.key;
  web = v.body.token;
  const named = await call('POST', '/api/auth/key', { body: { key, device: '  my   laptop ' } });
  const list = (await call('GET', '/api/auth/sessions', { token: web })).body.sessions;
  assert.deepEqual(list.map((s) => s.name).sort(), ['Chrome on Linux', 'my laptop']);
  await call('POST', '/api/auth/logout', { token: named.body.token });
});

test('only the hash of a token is stored', async () => {
  const rows = app.db.prepare('SELECT * FROM sessions').all();
  assert.ok(rows.length > 0);
  for (const r of rows) {
    assert.equal(r.token, undefined, 'no token column');
    assert.notEqual(r.token_hash, web);
  }
  assert.ok(rows.some((r) => r.token_hash === hashToken(web)));
});

test('the list says which session is asking, and never shows a hash', async () => {
  const { sessions } = (await call('GET', '/api/auth/sessions', { token: web })).body;
  assert.equal(sessions.filter((s) => s.current).length, 1);
  assert.equal(sessions.find((s) => s.current).name, 'Chrome on Linux');
  for (const s of sessions) {
    assert.deepEqual(Object.keys(s).sort(), ['created_at', 'current', 'id', 'last_used_at', 'name']);
    assert.ok(s.last_used_at >= s.created_at);
  }
});

let ext;

test('a signed-in device hands out a session of its own to another client', async () => {
  assert.equal((await call('POST', '/api/auth/session', { body: { device: 'x' } })).status, 401, 'not without a session');
  const r = await call('POST', '/api/auth/session', { token: web, body: { device: 'Browser extension' } });
  assert.equal(r.status, 201);
  assert.notEqual(r.body.token, web);
  assert.equal(r.body.user.name, 'mine');
  ext = r.body.token;
  assert.equal((await call('GET', '/api/me', { token: ext })).status, 200, 'the new token opens the vault');
  const names = (await call('GET', '/api/auth/sessions', { token: ext })).body.sessions.map((s) => [s.name, s.current]);
  assert.deepEqual(names.sort(), [['Browser extension', true], ['Chrome on Linux', false]]);
});

test('signing the app out leaves the extension signed in', async () => {
  const other = (await call('POST', '/api/auth/key', { body: { key } })).body.token;
  await call('POST', '/api/auth/logout', { token: other });
  assert.equal((await call('GET', '/api/me', { token: other })).status, 401);
  assert.equal((await call('GET', '/api/me', { token: ext })).status, 200);
});

test('one device can be signed out from another, and only in the same vault', async () => {
  const stranger = (await call('POST', '/api/auth/vault', { body: { name: 'theirs' } })).body.token;
  const target = (await call('GET', '/api/auth/sessions', { token: web })).body.sessions.find((s) => s.name === 'Browser extension');
  assert.equal((await call('POST', '/api/auth/sessions/revoke', { token: stranger, body: { id: target.id } })).status, 404,
    'a session of another vault is not found');
  assert.equal((await call('GET', '/api/me', { token: ext })).status, 200);

  assert.equal((await call('POST', '/api/auth/sessions/revoke', { token: web, body: { id: target.id } })).status, 200);
  assert.equal((await call('GET', '/api/me', { token: ext })).status, 401, 'the revoked token is dead');
  assert.equal((await call('GET', '/api/me', { token: web })).status, 200, 'the one that revoked it is not');
});

test('a session can sign itself out through the list', async () => {
  const t = (await call('POST', '/api/auth/session', { token: web, body: { device: 'short-lived' } })).body.token;
  const me = (await call('GET', '/api/auth/sessions', { token: t })).body.sessions.find((s) => s.current);
  assert.equal((await call('POST', '/api/auth/sessions/revoke', { token: t, body: { id: me.id } })).status, 200);
  assert.equal((await call('GET', '/api/me', { token: t })).status, 401);
});

test('a new key signs every other session out, the extension included', async () => {
  const e = (await call('POST', '/api/auth/session', { token: web, body: { device: 'Browser extension' } })).body.token;
  await call('POST', '/api/auth/rotate', { token: web });
  assert.equal((await call('GET', '/api/me', { token: e })).status, 401);
  assert.equal((await call('GET', '/api/me', { token: web })).status, 200);
});

/* ---------------- is this page saved already? ---------------- */

test('?url= finds a link the way sameLink does: only a trailing slash is ignored', async () => {
  const add = (url, folder) => call('POST', '/api/bookmarks', { token: web, body: { url, title: url, folder } });
  await add('https://lookup.example/page/', 'a');
  await add('https://lookup.example/page', 'b');
  await add('https://lookup.example/page?x=1', 'c');
  const find = async (u) => (await call('GET', `/api/bookmarks?url=${encodeURIComponent(u)}`, { token: web })).body.items.map((b) => b.folder).sort();
  assert.deepEqual(await find('https://lookup.example/page'), ['a', 'b'], 'saved in two folders, two answers');
  assert.deepEqual(await find('https://lookup.example/page///'), ['a', 'b']);
  assert.deepEqual(await find('https://lookup.example/page?x=1'), ['c'], 'a query is a different page');
  assert.deepEqual(await find('https://lookup.example/other'), []);
  assert.deepEqual(await find(''), [], 'an empty url matches nothing');
});

test('?url= leaves deleted links out', async () => {
  const b = (await call('POST', '/api/bookmarks', { token: web, body: { url: 'https://gone.example/' } })).body.item;
  await call('DELETE', `/api/bookmarks/${b.id}`, { token: web });
  assert.deepEqual((await call('GET', '/api/bookmarks?url=https://gone.example', { token: web })).body.items, []);
});

test('the folder list also names the folders bookmarks are in', async () => {
  await call('POST', '/api/folders', { token: web, body: { path: 'made/on-purpose' } });
  const r = (await call('GET', '/api/folders', { token: web })).body;
  assert.ok(r.folders.some((f) => f.path === 'made/on-purpose'));
  assert.deepEqual(['a', 'b', 'c'].filter((f) => r.used.includes(f)), ['a', 'b', 'c']);
  assert.ok(!r.used.includes(''), 'no folder is not a folder');
});

/* ---------------- where a change came from ---------------- */

test('a client names itself in the audit trail, and only a known name is taken', async () => {
  const via = async (header) => {
    const headers = header ? { 'x-bookmarks-via': header } : {};
    const b = (await call('POST', '/api/bookmarks', { token: web, body: { url: `https://via-${header || 'none'}.example` }, headers })).body.item;
    const rows = (await call('GET', '/api/audit/changes', { token: web })).body.items;
    return rows.find((r) => r.bookmark_id === b.id).via;
  };
  assert.equal(await via('extension'), 'extension');
  assert.equal(await via('Extension'), 'extension');
  assert.equal(await via(''), 'app');
  assert.equal(await via('<script>'), 'app', 'anything else is the app');
});
