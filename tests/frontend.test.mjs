// The frontend's pure pieces, run in node: the search history's rules and its
// storage, and the timestamp the links page shows. What needs a document is
// in web.mjs.

import test from 'node:test';
import assert from 'node:assert';
import { record, load, save, add, clear, MAX } from '../web/js/searchlog.js';
import { stamp } from '../web/js/stamp.js';

// A localStorage for node, reset before each test.
const memory = new Map();
globalThis.localStorage = {
  getItem: (k) => (memory.has(k) ? memory.get(k) : null),
  setItem: (k, v) => memory.set(k, String(v)),
  removeItem: (k) => memory.delete(k),
};
test.beforeEach(() => memory.clear());

/* ---------------- recording a search ---------------- */

test('a search goes on top with the moment it was made', () => {
  assert.deepEqual(record([], 'docker', 1000), [{ q: 'docker', at: 1000 }]);
  const list = record([{ q: 'nginx', at: 1 }], 'docker', 100_000);
  assert.deepEqual(list.map((e) => e.q), ['docker', 'nginx']);
});

test('blanks and single letters are not searches', () => {
  const list = [{ q: 'nginx', at: 1 }];
  for (const q of ['', '   ', 'a', null, undefined]) assert.equal(record(list, q, 2), list);
});

test('the query is kept trimmed', () => {
  assert.equal(record([], '  docker  ', 1)[0].q, 'docker');
});

test('a repeat moves to the top instead of showing twice', () => {
  const list = [{ q: 'a b', at: 3 }, { q: 'docker', at: 2 }, { q: 'nginx', at: 1 }];
  const next = record(list, 'nginx', 100_000);
  assert.deepEqual(next.map((e) => e.q), ['nginx', 'a b', 'docker']);
  assert.equal(next[0].at, 100_000);
});

test('refining the newest search soon after replaces it', () => {
  let list = record([], 'doc', 1000);
  list = record(list, 'docker', 3000);
  assert.deepEqual(list.map((e) => e.q), ['docker']);
  list = record(list, 'dock', 4000);
  assert.deepEqual(list.map((e) => e.q), ['dock'], 'backspacing is the same search too');
});

test('the same words much later are a search of their own', () => {
  let list = record([], 'doc', 0);
  list = record(list, 'docker', 60_000);
  assert.deepEqual(list.map((e) => e.q), ['docker', 'doc']);
});

test('the history keeps the newest searches and drops the oldest', () => {
  let list = [];
  for (let i = 0; i < MAX + 10; i++) list = record(list, `query ${i}`, i * 60_000);
  assert.equal(list.length, MAX);
  assert.equal(list[0].q, `query ${MAX + 9}`);
  assert.ok(!list.some((e) => e.q === 'query 0'));
});

/* ---------------- storage ---------------- */

test('the history survives a reload, and clearing empties it', () => {
  add('docker', 1);
  add('nginx', 100_000);
  assert.deepEqual(load().map((e) => e.q), ['nginx', 'docker']);
  clear();
  assert.deepEqual(load(), []);
});

test('a damaged history reads as empty, not as an error', () => {
  memory.set('bookmarks_search_history', '{not json');
  assert.deepEqual(load(), []);
  memory.set('bookmarks_search_history', JSON.stringify([{ q: 'ok', at: 1 }, { q: 5 }, null, 'x']));
  assert.deepEqual(load(), [{ q: 'ok', at: 1 }]);
});

test('a browser that blocks storage still searches', () => {
  const saved = globalThis.localStorage;
  globalThis.localStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  try {
    assert.deepEqual(load(), []);
    assert.doesNotThrow(() => save([{ q: 'x', at: 1 }]));
    assert.doesNotThrow(() => add('docker'));
  } finally { globalThis.localStorage = saved; }
});

/* ---------------- the timestamp ---------------- */

test('a moment reads to the second, in local time', () => {
  const d = new Date(2026, 9, 20, 9, 5, 7);
  assert.equal(stamp(d.getTime()), '2026-10-20 09:05:07');
  assert.equal(stamp(new Date(2026, 0, 1, 23, 59, 59).getTime()), '2026-01-01 23:59:59');
});
