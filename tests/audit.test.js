'use strict';

// The audit trail: every change to a link, whichever route made it, and every
// click the app reports. On a throwaway vault of its own.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createApp } = require('../api/server');
const audit = require('../api/audit');

/* ---------------- what a write did ---------------- */

const row = (over = {}) => ({
  id: 'a', title: 'Go', url: 'https://go.dev', folder: 'dev', category: '', tags: '', description: '', deleted: 0, ...over,
});

test('a new row is a create, a buried one coming back a restore', () => {
  assert.deepEqual(audit.describeChange(undefined, row()), { action: 'create', changes: {} });
  assert.deepEqual(audit.describeChange(row({ deleted: 1 }), row()), { action: 'restore', changes: {} });
});

test('a row going to the tombstone is a delete; one already there is nothing', () => {
  assert.deepEqual(audit.describeChange(row(), row({ deleted: 1 })), { action: 'delete', changes: {} });
  assert.equal(audit.describeChange(row({ deleted: 1 }), row({ deleted: 1 })), null);
  assert.equal(audit.describeChange(undefined, row({ deleted: 1 })), null, 'a tombstone synced in was never seen alive');
});

test('only the folder changing is a move, with where from and where to', () => {
  assert.deepEqual(audit.describeChange(row(), row({ folder: 'lang/go' })),
    { action: 'move', changes: { folder: ['dev', 'lang/go'] } });
});

test('any other field is an edit, each one with before and after', () => {
  assert.deepEqual(audit.describeChange(row(), row({ title: 'The Go language', tags: 'go' })),
    { action: 'edit', changes: { title: ['Go', 'The Go language'], tags: ['', 'go'] } });
  assert.deepEqual(audit.describeChange(row(), row({ url: 'https://go.dev/doc', folder: 'x' })).changes,
    { url: ['https://go.dev', 'https://go.dev/doc'], folder: ['dev', 'x'] }, 'an edit that also moved says so');
});

test('a write that changed nothing is not logged: an open counted, a stale sync', () => {
  assert.equal(audit.describeChange(row(), row({ opens: 9, last_open_at: 5, updated_at: 7 })), null);
});

test('a click is trimmed, and its time kept unless the clock is absurd', () => {
  const ts = 1_800_000_000_000;
  assert.deepEqual(audit.normClick({ at: ts - 5000, route: '#/organize', label: '  New\n link ', target: 'button#btn-new' }, ts),
    { at: ts - 5000, route: '#/organize', label: 'New link', target: 'button#btn-new', href: '' });
  assert.equal(audit.normClick({ at: 1, label: 'x' }, ts).at, ts, 'a time from 1970 is replaced');
  assert.equal(audit.normClick({ at: ts + 3600000, label: 'x' }, ts).at, ts, 'and one from the future');
  assert.equal(audit.normClick({ route: '#/' }, ts), null, 'nothing clicked, nothing logged');
  assert.equal(audit.normClick('junk', ts), null);
  assert.equal(audit.normClick({ label: 'x'.repeat(999) }, ts).label.length, 160);
});

/* ---------------- through the API ---------------- */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bookmarks-audit-'));
const app = createApp(path.join(dir, 'b.db'));
let base;
let token;

test.before(async () => {
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  token = (await call('POST', '/api/auth/vault', { body: { name: 'audit' } })).body.token;
});

test.after(() => {
  app.server.close();
  app.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function call(method, p, { body, auth = true } = {}) {
  const res = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json', ...(auth && token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const changes = async (qs = '') => (await call('GET', `/api/audit/changes${qs}`)).body;
const latest = async () => (await changes('?limit=1')).items[0];

test('the audit needs a session', async () => {
  assert.equal((await call('GET', '/api/audit/changes', { auth: false })).status, 401);
  assert.equal((await call('GET', '/api/audit/clicks', { auth: false })).status, 401);
  assert.equal((await call('POST', '/api/audit/clicks', { auth: false, body: { clicks: [] } })).status, 401);
});

test('add, edit, move, delete and restore each leave a row, newest first', async () => {
  const made = (await call('POST', '/api/bookmarks', { body: { url: 'https://go.dev', title: 'Go', folder: 'dev' } })).body.item;
  let last = await latest();
  assert.equal(last.action, 'create');
  assert.deepEqual([last.bookmark_id, last.title, last.url, last.folder, last.via], [made.id, 'Go', 'https://go.dev', 'dev', 'app']);
  assert.ok(Math.abs(last.at - Date.now()) < 5000, 'with when it happened');

  await call('PUT', `/api/bookmarks/${made.id}`, { body: { title: 'The Go language' } });
  last = await latest();
  assert.deepEqual([last.action, last.changes], ['edit', { title: ['Go', 'The Go language'] }]);

  await call('POST', '/api/bookmarks/move', { body: { ids: [made.id], folder: 'lang/go' } });
  last = await latest();
  assert.deepEqual([last.action, last.changes], ['move', { folder: ['dev', 'lang/go'] }]);

  await call('POST', '/api/bookmarks/open', { body: { id: made.id } });
  assert.equal((await latest()).action, 'move', 'opening a link is not a change');

  await call('DELETE', `/api/bookmarks/${made.id}`);
  last = await latest();
  assert.deepEqual([last.action, last.title, last.folder], ['delete', 'The Go language', 'lang/go'], 'it still reads after the link is gone');

  // Undo is the same link written again.
  await call('POST', '/api/bookmarks', { body: { ...made, title: 'The Go language', folder: 'lang/go', updated_at: undefined } });
  assert.equal((await latest()).action, 'restore');

  const all = (await changes()).items.map((r) => r.action);
  assert.deepEqual(all.slice(0, 5), ['restore', 'delete', 'move', 'edit', 'create']);
});

test('a batch delete, a folder renamed and an import are logged too, with where they came from', async () => {
  const a = (await call('POST', '/api/bookmarks', { body: { url: 'https://a.example', folder: 'box' } })).body.item;
  const b = (await call('POST', '/api/bookmarks', { body: { url: 'https://b.example', folder: 'box/inner' } })).body.item;

  await call('POST', '/api/folders/rename', { body: { path: 'box', name: 'crate' } });
  let rows = (await changes('?limit=2')).items;
  assert.deepEqual(rows.map((r) => [r.action, r.via, r.changes.folder?.[1]]).sort(),
    [['move', 'folder', 'crate'], ['move', 'folder', 'crate/inner']], 'a folder renamed moves each link in it');

  await call('POST', '/api/bookmarks/delete', { body: { ids: [a.id, b.id] } });
  rows = (await changes('?limit=2')).items;
  assert.deepEqual(rows.map((r) => r.action), ['delete', 'delete']);

  const content = 'folders:\n  imported:\n  - title: From a file\n    url: https://file.example\n';
  await call('POST', '/api/import', { body: { content, mode: 'add', apply: true, source: 'native' } });
  const last = await latest();
  assert.deepEqual([last.action, last.via, last.title, last.folder], ['create', 'import', 'From a file', 'imported']);

  await call('POST', '/api/import', { body: { content, mode: 'add', apply: false, source: 'native' } });
  assert.equal((await latest()).id, last.id, 'a preview writes nothing, so it logs nothing');
});

test('a sync that pushes an edit logs it; one that only carries counters does not', async () => {
  const made = (await call('POST', '/api/bookmarks', { body: { url: 'https://sync.example', title: 'Before' } })).body.item;
  await call('POST', '/api/sync', { body: { since: 0, changes: [{ ...made, opens: 4, updated_at: made.updated_at + 1 }] } });
  assert.equal((await latest()).action, 'create', 'counters only');
  await call('POST', '/api/sync', { body: { since: 0, changes: [{ ...made, title: 'After', updated_at: made.updated_at + 2 }] } });
  const last = await latest();
  assert.deepEqual([last.action, last.via, last.changes.title], ['edit', 'app', ['Before', 'After']]);
});

test('the changes filter by action and by text, and page with before', async () => {
  const moves = (await changes('?action=move')).items;
  assert.ok(moves.length >= 3 && moves.every((r) => r.action === 'move'));
  assert.equal((await call('GET', '/api/audit/changes?action=nonsense')).status, 400);
  const found = (await changes('?q=file.example')).items;
  assert.deepEqual(found.map((r) => r.url), ['https://file.example']);
  assert.deepEqual((await changes('?q=100%25')).items, [], 'a % in the filter is a character, not a wildcard');

  const first = await changes('?limit=2');
  assert.equal(first.items.length, 2);
  assert.ok(first.next);
  const second = await changes(`?limit=2&before=${first.next}`);
  assert.ok(second.items.every((r) => r.id < first.next), 'the next page starts where this one ended');
});

test('clicks are saved in batches and come back newest first', async () => {
  const at = Date.now();
  const r = await call('POST', '/api/audit/clicks', { body: { clicks: [
    { at: at - 2000, route: '#/', label: 'All links', target: 'a.on', href: '#/' },
    { at: at - 1000, route: '#/organize', label: 'New link', target: 'button[data-act=new-link]' },
    { route: '#/' },
  ] } });
  assert.deepEqual(r.body, { saved: 2 }, 'an entry that names nothing is dropped');
  const list = (await call('GET', '/api/audit/clicks')).body;
  assert.deepEqual(list.items.map((c) => [c.label, c.route, c.at]), [['New link', '#/organize', at - 1000], ['All links', '#/', at - 2000]]);
  assert.deepEqual((await call('GET', '/api/audit/clicks?q=organize')).body.items.map((c) => c.label), ['New link']);
});

test('a click batch is bounded and must be a list', async () => {
  assert.equal((await call('POST', '/api/audit/clicks', { body: { clicks: 'x' } })).status, 400);
  const many = Array.from({ length: audit.CLICK_BATCH + 1 }, () => ({ label: 'x' }));
  assert.equal((await call('POST', '/api/audit/clicks', { body: { clicks: many } })).status, 400);
});

test('old clicks are pruned; the change log is kept', async () => {
  app.db.prepare('INSERT INTO click_log (user_id, at, label) VALUES (1, ?, ?)').run(Date.now() - (audit.CLICK_DAYS + 1) * 86400000, 'ancient');
  await call('POST', '/api/audit/clicks', { body: { clicks: [{ label: 'fresh' }] } });
  const labels = (await call('GET', '/api/audit/clicks?limit=500')).body.items.map((c) => c.label);
  assert.ok(labels.includes('fresh') && !labels.includes('ancient'));
});

test('one vault never sees another vault\'s trail', async () => {
  const other = (await call('POST', '/api/auth/vault', { body: {} })).body.token;
  const get = (p) => fetch(base + p, { headers: { authorization: `Bearer ${other}` } }).then((x) => x.json());
  assert.deepEqual((await get('/api/audit/changes')).items, []);
  assert.deepEqual((await get('/api/audit/clicks')).items, []);
});
