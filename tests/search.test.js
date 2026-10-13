'use strict';

// Search engine tests. The same engine runs in the browser and in the backend,
// so these cases cover both.

const test = require('node:test');
const assert = require('node:assert');

const { search, parseQuery, tokenize, norm } = require('../web/search');

const FIXTURES = [
  { id: '1', title: 'Kubernetes Docs', url: 'https://kubernetes.io/docs', folder: 'dev/infra',
    category: 'studies', tags: 'k8s,devops', description: '', updated_at: 5 },
  { id: '2', title: 'The Go Blog', url: 'https://go.dev/blog', folder: 'dev',
    category: 'studies', tags: 'go,backend', description: '', updated_at: 4 },
  { id: '3', title: 'Hacker News', url: 'https://news.ycombinator.com', folder: 'diario',
    category: 'news', tags: 'noticias', description: 'leitura diaria', updated_at: 3 },
  { id: '4', title: 'Grafana', url: 'https://grafana.com', folder: 'dev/infra',
    category: 'work', tags: 'observabilidade,devops', description: '', updated_at: 2 },
  { id: '5', title: 'Página com Acentuação', url: 'https://exemplo.com/pagina', folder: '',
    category: 'work', tags: 'golanguage', description: '', updated_at: 1 },
  { id: '6', title: 'Excluido', url: 'https://excluido.com', folder: '', category: '',
    tags: '', description: '', updated_at: 9, deleted: 1 },
];

const t = (q) => search(FIXTURES, q).map((b) => b.title);
const sorted = (q) => t(q).sort();

/* ---------------- normalization ---------------- */

test('norm strips accents and case', () => {
  assert.equal(norm('Página COM Acentuação'), 'pagina com acentuacao');
  assert.equal(norm('ÀÉÎÕÜç'), 'aeiouc');
  assert.equal(norm(null), '');
  assert.equal(norm(undefined), '');
  assert.equal(norm(42), '42');
});

/* ---------------- tokenizer ---------------- */

test('tokenize splits on whitespace', () => {
  assert.deepEqual(tokenize('a b  c'), ['a', 'b', 'c']);
  assert.deepEqual(tokenize('   '), []);
  assert.deepEqual(tokenize(''), []);
  assert.deepEqual(tokenize(null), []);
});

test('tokenize keeps quoted runs together', () => {
  assert.deepEqual(tokenize('"duas palavras" solta'), ['"duas palavras"', 'solta']);
  assert.deepEqual(tokenize("'single quotes' x"), ["'single quotes'", 'x']);
  assert.deepEqual(tokenize('a "b c" d'), ['a', '"b c"', 'd']);
});

test('tokenize survives an unclosed quote', () => {
  assert.deepEqual(tokenize('"sem fechar'), ['"sem fechar']);
  assert.equal(parseQuery('"sem fechar')[0].value, 'sem fechar');
});

/* ---------------- parser ---------------- */

test('parseQuery understands the sigils', () => {
  assert.deepEqual(parseQuery('#tag'), [{ field: 'tags', value: 'tag', negate: false }]);
  assert.deepEqual(parseQuery('@cat'), [{ field: 'category', value: 'cat', negate: false }]);
  assert.deepEqual(parseQuery('/folder'), [{ field: 'folder', value: 'folder', negate: false }]);
  assert.deepEqual(parseQuery('livre'), [{ field: 'any', value: 'livre', negate: false }]);
});

test('parseQuery understands field:value and aliases', () => {
  const field = (q) => parseQuery(q)[0].field;
  assert.equal(field('title:x'), 'title');
  assert.equal(field('url:x'), 'url');
  assert.equal(field('link:x'), 'url');
  assert.equal(field('description:x'), 'description');
  assert.equal(field('note:x'), 'description');
  assert.equal(field('tag:x'), 'tags');
  assert.equal(field('tags:x'), 'tags');
  assert.equal(field('cat:x'), 'category');
  assert.equal(field('category:x'), 'category');
  assert.equal(field('folder:x'), 'folder');
  assert.equal(field('dir:x'), 'folder');
  assert.equal(field('TITLE:x'), 'title', 'nome do campo e case-insensitive');
});

test('parseQuery does not mistake a url for field:value', () => {
  const term = parseQuery('https://go.dev')[0];
  assert.equal(term.field, 'any');
  assert.equal(term.value, 'https://go.dev');
  assert.equal(parseQuery('foo:bar')[0].value, 'foo:bar', 'campo desconhecido fica literal');
});

test('parseQuery understands negation in every form', () => {
  assert.deepEqual(parseQuery('-x'), [{ field: 'any', value: 'x', negate: true }]);
  assert.deepEqual(parseQuery('-#t'), [{ field: 'tags', value: 't', negate: true }]);
  assert.deepEqual(parseQuery('-@c'), [{ field: 'category', value: 'c', negate: true }]);
  assert.deepEqual(parseQuery('-title:x'), [{ field: 'title', value: 'x', negate: true }]);
});

test('parseQuery drops empty terms', () => {
  for (const q of ['#', '@', '/', '-', '""', "''", '   ', '']) {
    assert.deepEqual(parseQuery(q), [], `${JSON.stringify(q)} must not become a term`);
  }
});

test('quotes protect a literal hyphen', () => {
  const term = parseQuery('"-not-a-negation"')[0];
  assert.equal(term.negate, false);
  assert.equal(term.value, '-not-a-negation');
});

/* ---------------- substring search ---------------- */

test('substring matches in the middle of any field', () => {
  assert.deepEqual(t('kuber'), ['Kubernetes Docs'], 'start of the title');
  assert.deepEqual(t('bernet'), ['Kubernetes Docs'], 'middle of the title');
  assert.deepEqual(t('ycombinator'), ['Hacker News'], 'middle of the url');
  assert.deepEqual(t('diaria'), ['Hacker News'], 'notas');
  // A tie on folder (same weight, same position): the most recent comes first.
  assert.deepEqual(t('infra'), ['Kubernetes Docs', 'Grafana'], 'folder');
});

test('search is case-insensitive', () => {
  assert.deepEqual(t('BERNET'), ['Kubernetes Docs']);
  assert.deepEqual(t('KuBeRnEtEs'), ['Kubernetes Docs']);
});

test('search ignores accents in both directions', () => {
  assert.deepEqual(t('acentuacao'), ['Página com Acentuação']);
  assert.deepEqual(t('Acentuação'), ['Página com Acentuação']);
  assert.deepEqual(t('pagina'), ['Página com Acentuação']);
});

test('special characters are literal, not regex', () => {
  assert.deepEqual(t('go.dev'), ['The Go Blog']);
  assert.deepEqual(t('.*'), [], 'it is not interpreted as a regex');
  assert.deepEqual(t('kubernetes.io/docs'), ['Kubernetes Docs']);
  assert.deepEqual(t('['), []);
});

/* ---------------- search by field ---------------- */

test('#tag searches tags only', () => {
  assert.deepEqual(sorted('#devops'), ['Grafana', 'Kubernetes Docs']);
  assert.deepEqual(t('#k8s'), ['Kubernetes Docs']);
  assert.deepEqual(t('#inexistente'), []);
  assert.deepEqual(t('#Hacker'), [], 'a title does not enter a tag search');
});

test('@category searches the category only', () => {
  assert.deepEqual(sorted('@studies'), ['Kubernetes Docs', 'The Go Blog']);
  assert.deepEqual(sorted('@stud'), ['Kubernetes Docs', 'The Go Blog'], 'substring vale');
  assert.deepEqual(t('@grafana'), [], 'a title does not enter a category search');
});

test('/folder searches folders only and catches children', () => {
  assert.deepEqual(sorted('/dev/infra'), ['Grafana', 'Kubernetes Docs']);
  assert.equal(t('/dev').length, 3, 'a parent folder matches its children');
});

test('field:value filters the right field', () => {
  assert.deepEqual(t('title:go'), ['The Go Blog']);
  assert.deepEqual(t('url:ycombinator'), ['Hacker News']);
  assert.deepEqual(t('description:diaria'), ['Hacker News']);
  assert.deepEqual(sorted('cat:work'), ['Grafana', 'Página com Acentuação']);
  assert.deepEqual(t('title:grafana.com'), [], 'a url does not match when the field is title');
});

test('a quoted phrase matches with the space', () => {
  assert.deepEqual(t('"hacker news"'), ['Hacker News']);
  assert.deepEqual(t('"news hacker"'), [], 'ordem importa numa frase');
  assert.deepEqual(t('hacker news'), ['Hacker News'], 'without quotes they are two AND terms');
  assert.deepEqual(t('title:"go blog"'), ['The Go Blog']);
});

/* ---------------- combinacoes ---------------- */

test('terms combine with AND', () => {
  assert.deepEqual(t('#devops @work'), ['Grafana']);
  assert.deepEqual(t('#devops @studies'), ['Kubernetes Docs']);
  assert.deepEqual(t('#devops @news'), []);
  assert.deepEqual(t('#k8s @studies /dev/infra'), ['Kubernetes Docs']);
});

test('negation excludes', () => {
  assert.deepEqual(t('#devops -#k8s'), ['Grafana']);
  assert.deepEqual(t('/dev -@studies'), ['Grafana']);
  assert.deepEqual(t('#devops -grafana'), ['Kubernetes Docs']);
  assert.deepEqual(t('#devops -#devops'), [], 'negating the same term empties it');
});

test('negation alone lists everything else', () => {
  const all = t('');
  const semDevops = t('-#devops');
  assert.equal(semDevops.length, all.length - 2);
  assert.ok(!semDevops.includes('Grafana'));
  assert.ok(!semDevops.includes('Kubernetes Docs'));
});

test('negating a phrase', () => {
  assert.deepEqual(t('-"hacker news"').includes('Hacker News'), false);
});

/* ---------------- ranking ---------------- */

test('an exact tag ranks above a substring', () => {
  // "go" is a whole tag in The Go Blog and a substring in "golanguage".
  assert.equal(t('#go')[0], 'The Go Blog');
  assert.ok(t('#go').includes('Página com Acentuação'), 'the substring still matches');
});

test('the title weighs more than the description', () => {
  const items = [
    { id: 'a', title: 'nada', url: '', tags: '', category: '', folder: '', description: 'zebra', updated_at: 2 },
    { id: 'b', title: 'zebra', url: '', tags: '', category: '', folder: '', description: '', updated_at: 1 },
  ];
  assert.deepEqual(search(items, 'zebra').map((b) => b.id), ['b', 'a']);
});

test('ties break by recency', () => {
  const items = [
    { id: 'velho', title: 'igual', url: '', tags: '', category: '', folder: '', description: '', updated_at: 1 },
    { id: 'novo', title: 'igual', url: '', tags: '', category: '', folder: '', description: '', updated_at: 9 },
  ];
  assert.deepEqual(search(items, 'igual').map((b) => b.id), ['novo', 'velho']);
});

test('a missing updated_at does not break the ordering', () => {
  const items = [
    { id: 'a', title: 'igual', url: '', tags: '', category: '', folder: '', description: '' },
    { id: 'b', title: 'igual', url: '', tags: '', category: '', folder: '', description: '', updated_at: null },
  ];
  assert.equal(search(items, 'igual').length, 2);
});

/* ---------------- bordas ---------------- */

test('an empty query lists everything but deleted rows', () => {
  assert.equal(t('').length, 5);
  assert.ok(!t('').includes('Excluido'));
});

test('deleted rows never show up', () => {
  assert.deepEqual(t('excluido.com'), []);
  assert.deepEqual(t('#'), t(''), 'an empty term filters nothing');
});

test('limit truncates the result', () => {
  assert.equal(search(FIXTURES, '', 2).length, 2);
  assert.equal(search(FIXTURES, '', 0).length, 0);
  assert.equal(search([], 'x').length, 0);
});

test('missing fields do not break anything', () => {
  const items = [{ id: 'x' }];
  assert.equal(search(items, '').length, 1);
  assert.equal(search(items, 'qualquer').length, 0);
});

/* ---------------- usage ranking ---------------- */

// The bookmark you keep opening is the one the launcher should offer first.
const RANKED = [
  { id: 'novo', title: 'go novo', url: '', tags: '', category: '', folder: '', description: '', updated_at: 100 },
  { id: 'usado', title: 'go usado', url: '', tags: '', category: '', folder: '', description: '', updated_at: 1, opens: 5 },
];
const ids = (items, q) => search(items, q).map((b) => b.id);

test('the most used one comes before the most recent one', () => {
  assert.deepEqual(ids(RANKED, ''), ['usado', 'novo'], 'with no query too');
  assert.deepEqual(ids(RANKED, 'go'), ['usado', 'novo']);
});

test('with no opens the order is still by recency', () => {
  const none = RANKED.map((b) => ({ ...b, opens: 0 }));
  assert.deepEqual(ids(none, ''), ['novo', 'usado']);
});

test('the boost saturates, so a favourite cannot bury a better match', () => {
  // 999 opens on a description match still loses to a title match: the boost
  // stops at 36 and the gap between the fields is larger than that.
  const items = [
    { id: 'titulo', title: 'grafana', url: '', tags: '', category: '', folder: '', description: '', updated_at: 1 },
    { id: 'desc', title: 'outro', url: '', tags: '', category: '', folder: '', description: 'grafana', updated_at: 1, opens: 999 },
  ];
  assert.deepEqual(ids(items, 'grafana'), ['titulo', 'desc']);
});

test('a broken counter counts as zero', () => {
  for (const opens of [null, undefined, -5, 'abc', NaN, {}]) {
    const items = [
      { id: 'a', title: 'x', url: '', tags: '', category: '', folder: '', description: '', updated_at: 2, opens },
      { id: 'b', title: 'x', url: '', tags: '', category: '', folder: '', description: '', updated_at: 1 },
    ];
    assert.deepEqual(ids(items, 'x'), ['a', 'b'], `opens = ${String(opens)}`);
  }
});

test('a bookmark replaced by an edited copy is searched by its new text', () => {
  // The normalized text is kept per object. The app replaces a bookmark on
  // every change instead of mutating it, and that is what keeps this honest.
  const before = { id: 'a', title: 'grafana', url: '', tags: '', category: '', folder: '', description: '', updated_at: 1 };
  assert.deepEqual(ids([before], 'grafana'), ['a']);
  const after = { ...before, title: 'prometheus' };
  assert.deepEqual(ids([after], 'grafana'), []);
  assert.deepEqual(ids([after], 'prometheus'), ['a']);
  assert.deepEqual(ids([before], 'grafana'), ['a'], 'the old object still answers for its own text');
});
