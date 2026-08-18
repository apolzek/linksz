'use strict';

// Testes do YAML mínimo. A validação de que isso é YAML *de verdade* — e não um
// dialeto particular — está em tests/test_yaml_interop.py, que confere contra o
// PyYAML nos dois sentidos.

const test = require('node:test');
const assert = require('node:assert');

const { stringify, parse, YamlError } = require('../server/yaml');

const volta = (v) => parse(stringify(v));

/* ---------------- emitir ---------------- */

test('escalares simples saem sem aspas', () => {
  assert.match(stringify({ a: 'texto' }), /^a: texto$/m);
  assert.match(stringify({ a: 42 }), /^a: 42$/m);
  assert.match(stringify({ a: true }), /^a: true$/m);
});

test('cita o que seria relido como outra coisa', () => {
  for (const valor of ['007', 'true', 'yes', 'null', '3.14', '-1']) {
    const texto = stringify({ a: valor });
    assert.match(texto, /^a: "/m, `${valor} precisa de aspas`);
    assert.equal(parse(texto).a, valor, `${valor} tem que voltar string`);
  }
});

test('cita o que quebraria a sintaxe', () => {
  for (const valor of ['com: dois pontos', ' espaco', 'espaco ', '- traco', '# hash', 'a # b', '']) {
    assert.equal(volta({ a: valor }).a, valor, `nao sobreviveu: ${JSON.stringify(valor)}`);
  }
});

test('chave que parece booleano tambem e citada', () => {
  // `yes:` sem aspas vira chave booleana em YAML 1.1 e o arquivo deixa de
  // significar a mesma coisa em outro parser.
  assert.match(stringify({ yes: 1 }), /^"yes": 1$/m);
  assert.deepEqual(volta({ yes: 1, no: 2, on: 3 }), { yes: 1, no: 2, on: 3 });
});

test('texto multilinha vira bloco legivel', () => {
  const texto = stringify({ description: 'linha 1\nlinha 2' });
  assert.match(texto, /description: \|-/);
  assert.match(texto, /^ {2}linha 1$/m);
  assert.equal(parse(texto).description, 'linha 1\nlinha 2');
});

test('bloco preserva linha em branco no meio e no fim', () => {
  assert.equal(volta({ n: 'a\n\nb' }).n, 'a\n\nb');
  assert.equal(volta({ n: 'a\n' }).n, 'a\n');
});

test('lista de escalares e lista de mapas', () => {
  assert.deepEqual(volta({ tags: ['a', 'b'] }).tags, ['a', 'b']);
  assert.deepEqual(volta({ tags: [] }).tags, []);
  const doc = volta({ bookmarks: [{ id: '1', t: 'A' }, { id: '2', t: 'B: dois' }] });
  assert.deepEqual(doc.bookmarks, [{ id: '1', t: 'A' }, { id: '2', t: 'B: dois' }]);
});

test('cabecalho vira comentario', () => {
  const texto = stringify({ a: 1 }, { header: 'primeira\nsegunda' });
  assert.match(texto, /^# primeira\n# segunda\n/);
  assert.deepEqual(parse(texto), { a: 1 });
});

/* ---------------- ler ---------------- */

test('le mapa e lista basicos', () => {
  assert.deepEqual(parse('a: 1\nb: texto\n'), { a: 1, b: 'texto' });
  assert.deepEqual(parse('- 1\n- 2\n'), [1, 2]);
  assert.deepEqual(parse(''), null);
  assert.deepEqual(parse('\n\n'), null);
});

test('le aninhamento por indentacao', () => {
  assert.deepEqual(parse('a:\n  b:\n    c: 1\n'), { a: { b: { c: 1 } } });
  assert.deepEqual(parse('bookmarks:\n  - id: 1\n    t: A\n  - id: 2\n'),
    { bookmarks: [{ id: 1, t: 'A' }, { id: 2 }] });
});

test('lista pode vir no mesmo nivel da chave', () => {
  assert.deepEqual(parse('tags:\n- a\n- b\n'), { tags: ['a', 'b'] });
});

test('tipos escalares', () => {
  const doc = parse('i: 7\nf: 1.5\nt: true\nn: no\nz: null\nv:\nti: ~\ns: "7"\n');
  assert.deepEqual(doc, { i: 7, f: 1.5, t: true, n: false, z: null, v: null, ti: null, s: '7' });
});

test('inteiro grande demais fica string em vez de perder precisao', () => {
  assert.equal(parse('a: 123456789012345678901234567890\n').a, '123456789012345678901234567890');
});

test('comentarios sao ignorados, menos dentro de aspas', () => {
  assert.deepEqual(parse('# topo\na: 1  # depois\nb: "x # y"\n'), { a: 1, b: 'x # y' });
  assert.equal(parse('u: https://x.com/#anchor\n').u, 'https://x.com/#anchor',
    'o # colado na url nao e comentario');
});

test('aspas simples e duplas com escapes', () => {
  assert.equal(parse(`a: 'com ''aspa'''\n`).a, "com 'aspa'");
  assert.equal(parse('a: "linha\\nquebra"\n').a, 'linha\nquebra');
  assert.equal(parse('a: "tab\\tfim"\n').a, 'tab\tfim');
  assert.equal(parse('a: "\\u00e9"\n').a, 'é');
});

test('le listas e mapas em linha', () => {
  assert.deepEqual(parse('a: [1, 2, x]\n').a, [1, 2, 'x']);
  assert.deepEqual(parse('a: []\n').a, []);
  assert.deepEqual(parse('a: {b: 1, c: [x, y]}\n').a, { b: 1, c: ['x', 'y'] });
  assert.deepEqual(parse('{a: 1, b: 2}\n'), { a: 1, b: 2 });
});

test('virgula dentro de aspas nao quebra a lista', () => {
  assert.deepEqual(parse(`a: ['x, y', z]\n`).a, ['x, y', 'z']);
});

test('aspa no meio de escalar simples e literal', () => {
  // `aspa " solta` e YAML valido: a aspa so abre no inicio do token.
  assert.equal(parse('a: aspa " solta\n').a, 'aspa " solta');
  assert.deepEqual(parse('{a: aspa " solta, b: 1}\n'), { a: 'aspa " solta', b: 1 });
});

test('escalar quebrado em varias linhas e reunido', () => {
  // Regra do YAML: uma quebra vira espaco, duas viram uma nova linha.
  assert.equal(parse("a: 'uma\n  duas'\n").a, 'uma duas');
  assert.equal(parse("a: 'uma\n\n  duas'\n").a, 'uma\nduas');
  assert.equal(parse('a: uma\n  duas\n').a, 'uma duas');
});

test('espaco antes da aspa de fechamento e conteudo', () => {
  assert.equal(parse("a: 'termina com espaco\n  aqui '\n").a, 'termina com espaco aqui ');
});

test('mapa em linha quebrado em varias linhas', () => {
  assert.deepEqual(parse('a: {b: 1,\n  c: 2}\n').a, { b: 1, c: 2 });
});

/* ---------------- erros ---------------- */

test('recusa o que nao entende, com numero de linha', () => {
  const casos = [
    ['a: 1\nb: &ancora\n', /linha 2/, 'ancora'],
    ['a: 1\nb: *alias\n', /linha 2/, 'alias'],
    ['a: !!str x\n', /linha 1/, 'tag'],
    ['a: 1\n\tb: 2\n', /TAB/, 'tab'],
    ['---\na: 1\n', /documento/, 'documento multiplo'],
    ['a: [1, 2\n', /nao fechada/, 'lista aberta'],
  ];
  for (const [texto, padrao, nome] of casos) {
    assert.throws(() => parse(texto), (err) => {
      assert.ok(err instanceof YamlError, `${nome}: erro deveria ser YamlError`);
      assert.match(err.message, padrao, nome);
      return true;
    }, `deveria recusar: ${nome}`);
  }
});

test('erro de indentacao aponta a linha', () => {
  assert.throws(() => parse('a: 1\n  b: 2\n'), /linha 2/);
});

test('conteudo que nao e texto e recusado', () => {
  assert.throws(() => parse(null), YamlError);
  assert.throws(() => parse(42), YamlError);
});

/* ---------------- round-trip ---------------- */

test('round-trip aguenta o que aparece num vault', () => {
  const doc = {
    version: 1,
    bookmarks: [
      { id: 'a1', title: 'Página com Acentuação', url: 'https://x.com/#a', tags: ['go', 'cli'] },
      { id: 'a2', title: 'Caddy: servidor', url: 'http://y.org?q=1&b=2', description: 'linha 1\nlinha 2' },
      { id: 'a3', title: '🔖 emoji', url: '', tags: [], description: '' },
      { id: 'a4', title: '-traco', url: 'c:\\temp\\x', tags: ['a,b'] },
      { id: 'a5', title: '007', url: 'yes', description: '  espaco  ' },
    ],
  };
  assert.deepEqual(volta(doc), doc);
});

test('round-trip com 200 combinacoes geradas', () => {
  const pedacos = ['', 'a', 'com: dois', "'aspa'", '"dupla"', 'l1\nl2', ' esp ', '🔖', '007',
    'yes', '#h', 'a,b', '-t', 'x'.repeat(300), 'tab\tmeio', 'barra\\fim', 'fim '];
  let seed = 42;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };

  for (let i = 0; i < 200; i++) {
    const doc = {
      id: String(rnd(1000)),
      title: pedacos[rnd(pedacos.length)],
      description: pedacos[rnd(pedacos.length)],
      tags: Array.from({ length: rnd(4) }, () => pedacos[rnd(pedacos.length)]),
      n: rnd(10 ** 9),
      b: rnd(2) === 0,
    };
    assert.deepEqual(volta(doc), doc, `falhou em ${JSON.stringify(doc)}`);
  }
});
