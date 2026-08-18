'use strict';

// Testes do motor de busca. O espelho em Python vive em tests/test_desktop.py,
// que alem de repetir estes casos compara as duas implementacoes.

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

/* ---------------- normalizacao ---------------- */

test('norm remove acentos e caixa', () => {
  assert.equal(norm('Página COM Acentuação'), 'pagina com acentuacao');
  assert.equal(norm('ÀÉÎÕÜç'), 'aeiouc');
  assert.equal(norm(null), '');
  assert.equal(norm(undefined), '');
  assert.equal(norm(42), '42');
});

/* ---------------- tokenizer ---------------- */

test('tokenize quebra por espaco', () => {
  assert.deepEqual(tokenize('a b  c'), ['a', 'b', 'c']);
  assert.deepEqual(tokenize('   '), []);
  assert.deepEqual(tokenize(''), []);
  assert.deepEqual(tokenize(null), []);
});

test('tokenize mantem aspas juntas', () => {
  assert.deepEqual(tokenize('"duas palavras" solta'), ['"duas palavras"', 'solta']);
  assert.deepEqual(tokenize("'aspas simples' x"), ["'aspas simples'", 'x']);
  assert.deepEqual(tokenize('a "b c" d'), ['a', '"b c"', 'd']);
});

test('tokenize aguenta aspas nao fechadas', () => {
  assert.deepEqual(tokenize('"sem fechar'), ['"sem fechar']);
  assert.equal(parseQuery('"sem fechar')[0].value, 'sem fechar');
});

/* ---------------- parser ---------------- */

test('parseQuery entende os sigilos', () => {
  assert.deepEqual(parseQuery('#tag'), [{ field: 'tags', value: 'tag', negate: false }]);
  assert.deepEqual(parseQuery('@cat'), [{ field: 'category', value: 'cat', negate: false }]);
  assert.deepEqual(parseQuery('/pasta'), [{ field: 'folder', value: 'pasta', negate: false }]);
  assert.deepEqual(parseQuery('livre'), [{ field: 'any', value: 'livre', negate: false }]);
});

test('parseQuery entende campo:valor e apelidos', () => {
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

test('parseQuery nao confunde url com campo:valor', () => {
  const term = parseQuery('https://go.dev')[0];
  assert.equal(term.field, 'any');
  assert.equal(term.value, 'https://go.dev');
  assert.equal(parseQuery('foo:bar')[0].value, 'foo:bar', 'campo desconhecido fica literal');
});

test('parseQuery entende negacao em todas as formas', () => {
  assert.deepEqual(parseQuery('-x'), [{ field: 'any', value: 'x', negate: true }]);
  assert.deepEqual(parseQuery('-#t'), [{ field: 'tags', value: 't', negate: true }]);
  assert.deepEqual(parseQuery('-@c'), [{ field: 'category', value: 'c', negate: true }]);
  assert.deepEqual(parseQuery('-title:x'), [{ field: 'title', value: 'x', negate: true }]);
});

test('parseQuery descarta termos vazios', () => {
  for (const q of ['#', '@', '/', '-', '""', "''", '   ', '']) {
    assert.deepEqual(parseQuery(q), [], `${JSON.stringify(q)} nao deve virar termo`);
  }
});

test('aspas protegem o hifen literal', () => {
  const term = parseQuery('"-nao-e-negacao"')[0];
  assert.equal(term.negate, false);
  assert.equal(term.value, '-nao-e-negacao');
});

/* ---------------- busca por substring ---------------- */

test('substring casa no meio de qualquer campo', () => {
  assert.deepEqual(t('kuber'), ['Kubernetes Docs'], 'inicio do titulo');
  assert.deepEqual(t('bernet'), ['Kubernetes Docs'], 'meio do titulo');
  assert.deepEqual(t('ycombinator'), ['Hacker News'], 'meio da url');
  assert.deepEqual(t('diaria'), ['Hacker News'], 'notas');
  // Empate na pasta (mesmo peso, mesma posicao): o mais recente vem antes.
  assert.deepEqual(t('infra'), ['Kubernetes Docs', 'Grafana'], 'pasta');
});

test('busca e case-insensitive', () => {
  assert.deepEqual(t('BERNET'), ['Kubernetes Docs']);
  assert.deepEqual(t('KuBeRnEtEs'), ['Kubernetes Docs']);
});

test('busca ignora acentos nos dois sentidos', () => {
  assert.deepEqual(t('acentuacao'), ['Página com Acentuação']);
  assert.deepEqual(t('Acentuação'), ['Página com Acentuação']);
  assert.deepEqual(t('pagina'), ['Página com Acentuação']);
});

test('caracteres especiais sao literais, nao regex', () => {
  assert.deepEqual(t('go.dev'), ['The Go Blog']);
  assert.deepEqual(t('.*'), [], 'nao e interpretado como regex');
  assert.deepEqual(t('kubernetes.io/docs'), ['Kubernetes Docs']);
  assert.deepEqual(t('['), []);
});

/* ---------------- busca por campo ---------------- */

test('#tag busca so em tags', () => {
  assert.deepEqual(sorted('#devops'), ['Grafana', 'Kubernetes Docs']);
  assert.deepEqual(t('#k8s'), ['Kubernetes Docs']);
  assert.deepEqual(t('#inexistente'), []);
  assert.deepEqual(t('#Hacker'), [], 'titulo nao entra na busca por tag');
});

test('@categoria busca so em categoria', () => {
  assert.deepEqual(sorted('@studies'), ['Kubernetes Docs', 'The Go Blog']);
  assert.deepEqual(sorted('@stud'), ['Kubernetes Docs', 'The Go Blog'], 'substring vale');
  assert.deepEqual(t('@grafana'), [], 'titulo nao entra na busca por categoria');
});

test('/pasta busca so em pasta e pega as filhas', () => {
  assert.deepEqual(sorted('/dev/infra'), ['Grafana', 'Kubernetes Docs']);
  assert.equal(t('/dev').length, 3, 'pasta pai casa as filhas');
});

test('campo:valor filtra o campo certo', () => {
  assert.deepEqual(t('title:go'), ['The Go Blog']);
  assert.deepEqual(t('url:ycombinator'), ['Hacker News']);
  assert.deepEqual(t('description:diaria'), ['Hacker News']);
  assert.deepEqual(sorted('cat:work'), ['Grafana', 'Página com Acentuação']);
  assert.deepEqual(t('title:grafana.com'), [], 'url nao casa quando o campo e title');
});

test('frase entre aspas casa com espaco', () => {
  assert.deepEqual(t('"hacker news"'), ['Hacker News']);
  assert.deepEqual(t('"news hacker"'), [], 'ordem importa numa frase');
  assert.deepEqual(t('hacker news'), ['Hacker News'], 'sem aspas sao dois termos com AND');
  assert.deepEqual(t('title:"go blog"'), ['The Go Blog']);
});

/* ---------------- combinacoes ---------------- */

test('termos combinam com AND', () => {
  assert.deepEqual(t('#devops @work'), ['Grafana']);
  assert.deepEqual(t('#devops @studies'), ['Kubernetes Docs']);
  assert.deepEqual(t('#devops @news'), []);
  assert.deepEqual(t('#k8s @studies /dev/infra'), ['Kubernetes Docs']);
});

test('negacao exclui', () => {
  assert.deepEqual(t('#devops -#k8s'), ['Grafana']);
  assert.deepEqual(t('/dev -@studies'), ['Grafana']);
  assert.deepEqual(t('#devops -grafana'), ['Kubernetes Docs']);
  assert.deepEqual(t('#devops -#devops'), [], 'negar o mesmo termo zera');
});

test('so negacao lista todo o resto', () => {
  const all = t('');
  const semDevops = t('-#devops');
  assert.equal(semDevops.length, all.length - 2);
  assert.ok(!semDevops.includes('Grafana'));
  assert.ok(!semDevops.includes('Kubernetes Docs'));
});

test('negacao de frase', () => {
  assert.deepEqual(t('-"hacker news"').includes('Hacker News'), false);
});

/* ---------------- ranking ---------------- */

test('tag exata ranqueia acima de substring', () => {
  // "go" e tag inteira em The Go Blog e substring em "golanguage".
  assert.equal(t('#go')[0], 'The Go Blog');
  assert.ok(t('#go').includes('Página com Acentuação'), 'a substring ainda casa');
});

test('titulo pesa mais que notas', () => {
  const items = [
    { id: 'a', title: 'nada', url: '', tags: '', category: '', folder: '', description: 'zebra', updated_at: 2 },
    { id: 'b', title: 'zebra', url: '', tags: '', category: '', folder: '', description: '', updated_at: 1 },
  ];
  assert.deepEqual(search(items, 'zebra').map((b) => b.id), ['b', 'a']);
});

test('empate desempata pelo mais recente', () => {
  const items = [
    { id: 'velho', title: 'igual', url: '', tags: '', category: '', folder: '', description: '', updated_at: 1 },
    { id: 'novo', title: 'igual', url: '', tags: '', category: '', folder: '', description: '', updated_at: 9 },
  ];
  assert.deepEqual(search(items, 'igual').map((b) => b.id), ['novo', 'velho']);
});

test('updated_at ausente nao quebra a ordenacao', () => {
  const items = [
    { id: 'a', title: 'igual', url: '', tags: '', category: '', folder: '', description: '' },
    { id: 'b', title: 'igual', url: '', tags: '', category: '', folder: '', description: '', updated_at: null },
  ];
  assert.equal(search(items, 'igual').length, 2);
});

/* ---------------- bordas ---------------- */

test('query vazia lista tudo menos excluidos', () => {
  assert.equal(t('').length, 5);
  assert.ok(!t('').includes('Excluido'));
});

test('excluidos nunca aparecem', () => {
  assert.deepEqual(t('excluido.com'), []);
  assert.deepEqual(t('#'), t(''), 'termo vazio nao filtra nada');
});

test('limit corta o resultado', () => {
  assert.equal(search(FIXTURES, '', 2).length, 2);
  assert.equal(search(FIXTURES, '', 0).length, 0);
  assert.equal(search([], 'x').length, 0);
});

test('campos ausentes nao quebram', () => {
  const items = [{ id: 'x' }];
  assert.equal(search(items, '').length, 1);
  assert.equal(search(items, 'qualquer').length, 0);
});
