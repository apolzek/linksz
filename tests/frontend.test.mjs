// The frontend's pure pieces, run in node: the search history's rules and its
// storage, and the timestamp the links page shows. What needs a document is
// in web.mjs.

import test from 'node:test';
import assert from 'node:assert';
import { record, load, save, add, clear, MAX } from '../web/js/searchlog.js';
import { stamp } from '../web/js/stamp.js';
import { suggestFolders, words } from '../web/js/suggest.js';

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

/* ---------------- where a link probably goes ---------------- */

const vault = [
  { id: '1', title: 'Kubernetes the hard way', url: 'https://github.com/kelseyhightower/kubernetes-the-hard-way', folder: 'dev/k8s' },
  { id: '2', title: 'Helm charts best practices', url: 'https://helm.sh/docs/chart_best_practices/', folder: 'dev/k8s' },
  { id: '3', title: 'Receita de pão de queijo', url: 'https://receitas.example/pao-de-queijo', folder: 'casa/receitas' },
  { id: '4', title: 'Some repo', url: 'https://github.com/a/b', folder: 'dev/repos' },
  { id: '5', title: 'Another repo', url: 'https://github.com/c/d', folder: 'dev/repos' },
  { id: '6', title: 'Not sorted', url: 'https://github.com/e/f', folder: 'Temporary' },
];

test('words leave out accents, short words, numbers and the filler', () => {
  assert.deepEqual(words('Receita de Pão de Queijo 2024, the best!'), ['receita', 'pao', 'queijo', 'best']);
});

test('the same site counts most', () => {
  const link = { id: 'x', title: 'whatever', url: 'https://github.com/x/y' };
  assert.equal(suggestFolders(link, vault, { exclude: ['Temporary'] })[0], 'dev/repos');
});

test('shared words and the folder name count too', () => {
  const link = { id: 'x', title: 'Kubernetes operators explained', url: 'https://blog.example/k8s' };
  assert.deepEqual(suggestFolders(link, vault, { exclude: ['Temporary'] }), ['dev/k8s']);
  const bread = { id: 'y', title: 'Melhor receita de pão', url: 'https://outra.example/' };
  assert.deepEqual(suggestFolders(bread, vault), ['casa/receitas'], 'a word of the folder name is enough');
});

test('the folder being sorted, and anything under it, is never suggested', () => {
  const link = { id: 'x', title: 'x', url: 'https://github.com/x/y' };
  const out = suggestFolders(link, [...vault, { id: '7', title: 'x', url: 'https://github.com/q', folder: 'Temporary/later' }],
    { exclude: ['Temporary'] });
  assert.ok(!out.some((f) => f.startsWith('Temporary')), JSON.stringify(out));
});

test('nothing alike, nothing suggested, and never more than asked for', () => {
  assert.deepEqual(suggestFolders({ id: 'z', title: 'zzzz', url: 'https://nowhere.example/' }, vault), []);
  assert.equal(suggestFolders({ id: 'g', title: 'repo kubernetes receita', url: 'https://github.com/' }, vault, { limit: 2 }).length, 2);
});
