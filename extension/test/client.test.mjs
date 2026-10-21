// The extension's API client against the real backend, the same one the app
// uses: started here on a throwaway vault.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createClient, AuthError } from '../src/client.js';

const require = createRequire(import.meta.url);
const { createApp } = require('../../api/server.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bookmarks-extension-'));
const app = createApp(path.join(dir, 'bookmarks.db'));
let server;
let key;
let appToken;

test.before(async () => {
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  server = `http://127.0.0.1:${app.server.address().port}`;
  const r = await (await fetch(`${server}/api/auth/vault`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"ext"}' })).json();
  key = r.key;
  appToken = r.token;
});

test.after(() => {
  app.server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

let api;

test('the key opens a session named for the extension, and is not needed again', async () => {
  const r = await createClient({ server }).signIn(key);
  assert.match(r.token, /^[0-9a-f]{64}$/);
  api = createClient({ server, token: r.token });
  assert.equal((await api.me()).user.name, 'ext');
  const list = await (await fetch(`${server}/api/auth/sessions`, { headers: { authorization: `Bearer ${appToken}` } })).json();
  assert.ok(list.sessions.some((s) => s.name === 'Browser extension'));
});

test('a wrong key is an error, not a sign-out', async () => {
  await assert.rejects(createClient({ server }).signIn('0000-0000'), (err) => !(err instanceof AuthError) && /does not open/.test(err.message));
});

test('saving, finding by url, searching and counting an open', async () => {
  assert.deepEqual(await api.lookup('https://ext.example/page'), []);
  const b = await api.save({ url: 'https://ext.example/page', title: 'Saved from the extension', folder: 'Temporary' });
  assert.equal(b.folder, 'Temporary');
  assert.deepEqual((await api.lookup('https://ext.example/page/')).map((x) => x.id), [b.id], 'a trailing slash is the same page');
  assert.deepEqual((await api.search('from the extension')).map((x) => x.id), [b.id]);
  await api.opened(b.id);
  assert.equal((await api.lookup('https://ext.example/page'))[0].opens, 1);
  const { folders, used } = await api.folders();
  assert.ok(Array.isArray(folders) && used.includes('Temporary'));
  await api.remove(b.id);
  assert.deepEqual(await api.lookup('https://ext.example/page'), [], 'undo deletes it');
});

test('what the extension changes is marked as such in the audit log', async () => {
  const b = await api.save({ url: 'https://audited.example', title: 'x', folder: '' });
  const log = await (await fetch(`${server}/api/audit/changes`, { headers: { authorization: `Bearer ${appToken}` } })).json();
  assert.equal(log.items.find((r) => r.bookmark_id === b.id).via, 'extension');
});

test('no CORS is needed: the server sends no allow-origin to the extension', async () => {
  const res = await fetch(`${server}/api/me`, { headers: { origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop', authorization: `Bearer ${appToken}` } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('a session signed out from the app is a sign-out here', async () => {
  const list = await (await fetch(`${server}/api/auth/sessions`, { headers: { authorization: `Bearer ${appToken}` } })).json();
  const ext = list.sessions.find((s) => s.name === 'Browser extension');
  await fetch(`${server}/api/auth/sessions/revoke`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${appToken}` }, body: JSON.stringify({ id: ext.id }),
  });
  await assert.rejects(api.lookup('https://ext.example'), AuthError);
});
