'use strict';

// Tests for the minimal YAML. The proof that this is *real* YAML, and not a
// private dialect, lives in tests/test_yaml_interop.py, which checks against
// PyYAML in both directions.

const test = require('node:test');
const assert = require('node:assert');

const { stringify, parse, YamlError } = require('../api/yaml');

const roundTrip = (v) => parse(stringify(v));

/* ---------------- emit ---------------- */

test('plain scalars come out unquoted', () => {
  assert.match(stringify({ a: 'text' }), /^a: text$/m);
  assert.match(stringify({ a: 42 }), /^a: 42$/m);
  assert.match(stringify({ a: true }), /^a: true$/m);
});

test('quotes whatever would read back as another type', () => {
  for (const value of ['007', 'true', 'yes', 'null', '3.14', '-1']) {
    const text = stringify({ a: value });
    assert.match(text, /^a: "/m, `${value} needs quotes`);
    assert.equal(parse(text).a, value, `${value} has to come back as a string`);
  }
});

test('quotes whatever would break the syntax', () => {
  for (const value of ['with: a colon', ' space', 'space ', '- dash', '# hash', 'a # b', '']) {
    assert.equal(roundTrip({ a: value }).a, value, `did not survive: ${JSON.stringify(value)}`);
  }
});

test('a key that looks boolean is quoted too', () => {
  // An unquoted `yes:` becomes a boolean key in YAML 1.1 and the file stops
  // meaning the same thing in another parser.
  assert.match(stringify({ yes: 1 }), /^"yes": 1$/m);
  assert.deepEqual(roundTrip({ yes: 1, no: 2, on: 3 }), { yes: 1, no: 2, on: 3 });
});

test('multiline text becomes a readable block', () => {
  const text = stringify({ description: 'line 1\nline 2' });
  assert.match(text, /description: \|-/);
  assert.match(text, /^ {2}line 1$/m);
  assert.equal(parse(text).description, 'line 1\nline 2');
});

test('a block keeps blank lines in the middle and at the end', () => {
  assert.equal(roundTrip({ n: 'a\n\nb' }).n, 'a\n\nb');
  assert.equal(roundTrip({ n: 'a\n' }).n, 'a\n');
});

test('list of scalars and list of mappings', () => {
  assert.deepEqual(roundTrip({ tags: ['a', 'b'] }).tags, ['a', 'b']);
  assert.deepEqual(roundTrip({ tags: [] }).tags, []);
  const doc = roundTrip({ bookmarks: [{ id: '1', t: 'A' }, { id: '2', t: 'B: dois' }] });
  assert.deepEqual(doc.bookmarks, [{ id: '1', t: 'A' }, { id: '2', t: 'B: dois' }]);
});

test('the header becomes a comment', () => {
  const text = stringify({ a: 1 }, { header: 'primeira\nsegunda' });
  assert.match(text, /^# primeira\n# segunda\n/);
  assert.deepEqual(parse(text), { a: 1 });
});

/* ---------------- ler ---------------- */

test('reads a basic mapping and list', () => {
  assert.deepEqual(parse('a: 1\nb: text\n'), { a: 1, b: 'text' });
  assert.deepEqual(parse('- 1\n- 2\n'), [1, 2]);
  assert.deepEqual(parse(''), null);
  assert.deepEqual(parse('\n\n'), null);
});

test('reads nesting by indentation', () => {
  assert.deepEqual(parse('a:\n  b:\n    c: 1\n'), { a: { b: { c: 1 } } });
  assert.deepEqual(parse('bookmarks:\n  - id: 1\n    t: A\n  - id: 2\n'),
    { bookmarks: [{ id: 1, t: 'A' }, { id: 2 }] });
});

test('a list may sit at the same level as the key', () => {
  assert.deepEqual(parse('tags:\n- a\n- b\n'), { tags: ['a', 'b'] });
});

test('scalar types', () => {
  const doc = parse('i: 7\nf: 1.5\nt: true\nn: no\nz: null\nv:\nti: ~\ns: "7"\n');
  assert.deepEqual(doc, { i: 7, f: 1.5, t: true, n: false, z: null, v: null, ti: null, s: '7' });
});

test('an integer too large stays a string instead of losing precision', () => {
  assert.equal(parse('a: 123456789012345678901234567890\n').a, '123456789012345678901234567890');
});

test('comments are ignored, except inside quotes', () => {
  assert.deepEqual(parse('# topo\na: 1  # depois\nb: "x # y"\n'), { a: 1, b: 'x # y' });
  assert.equal(parse('u: https://x.com/#anchor\n').u, 'https://x.com/#anchor',
    'a # glued to the url is not a comment');
});

test('single and double quotes with escapes', () => {
  assert.equal(parse(`a: 'com ''aspa'''\n`).a, "com 'aspa'");
  assert.equal(parse('a: "line\\nbreak"\n').a, 'line\nbreak');
  assert.equal(parse('a: "tab\\tfim"\n').a, 'tab\tfim');
  assert.equal(parse('a: "\\u00e9"\n').a, 'é');
});

test('reads flow lists and mappings', () => {
  assert.deepEqual(parse('a: [1, 2, x]\n').a, [1, 2, 'x']);
  assert.deepEqual(parse('a: []\n').a, []);
  assert.deepEqual(parse('a: {b: 1, c: [x, y]}\n').a, { b: 1, c: ['x', 'y'] });
  assert.deepEqual(parse('{a: 1, b: 2}\n'), { a: 1, b: 2 });
});

test('a comma inside quotes does not break the list', () => {
  assert.deepEqual(parse(`a: ['x, y', z]\n`).a, ['x, y', 'z']);
});

test('a quote in the middle of a plain scalar is literal', () => {
  // `a " stray quote` is valid YAML: a quote only opens at the start of a token.
  assert.equal(parse('a: aspa " solta\n').a, 'aspa " solta');
  assert.deepEqual(parse('{a: aspa " solta, b: 1}\n'), { a: 'aspa " solta', b: 1 });
});

test('a scalar broken across lines is joined back', () => {
  // The YAML rule: one break becomes a space, two become a newline.
  assert.equal(parse("a: 'uma\n  duas'\n").a, 'uma duas');
  assert.equal(parse("a: 'uma\n\n  duas'\n").a, 'uma\nduas');
  assert.equal(parse('a: uma\n  duas\n').a, 'uma duas');
});

test('whitespace before the closing quote is content', () => {
  assert.equal(parse("a: 'ends with a space\n  here '\n").a, 'ends with a space here ');
});

test('a flow mapping broken across lines', () => {
  assert.deepEqual(parse('a: {b: 1,\n  c: 2}\n').a, { b: 1, c: 2 });
});

/* ---------------- erros ---------------- */

test('refuses what it does not understand, with a line number', () => {
  const cases = [
    ['a: 1\nb: &anchor\n', /line 2/, 'anchor'],
    ['a: 1\nb: *alias\n', /line 2/, 'alias'],
    ['a: !!str x\n', /line 1/, 'tag'],
    ['a: 1\n\tb: 2\n', /TAB/, 'tab'],
    ['---\na: 1\n', /documents/, 'multiple documents'],
    ['a: [1, 2\n', /unclosed/, 'open list'],
  ];
  for (const [text, pattern, name] of cases) {
    assert.throws(() => parse(text), (err) => {
      assert.ok(err instanceof YamlError, `${name}: the error should be a YamlError`);
      assert.match(err.message, pattern, name);
      return true;
    }, `should refuse: ${name}`);
  }
});

test('an indentation error points at the line', () => {
  assert.throws(() => parse('a: 1\n  b: 2\n'), /line 2/);
});

test('content that is not text is refused', () => {
  assert.throws(() => parse(null), YamlError);
  assert.throws(() => parse(42), YamlError);
});

/* ---------------- round-trip ---------------- */

test('round-trip survives what shows up in a vault', () => {
  const doc = {
    version: 1,
    bookmarks: [
      { id: 'a1', title: 'Página com Acentuação', url: 'https://x.com/#a', tags: ['go', 'cli'] },
      { id: 'a2', title: 'Caddy: server', url: 'http://y.org?q=1&b=2', description: 'line 1\nline 2' },
      { id: 'a3', title: '🔖 emoji', url: '', tags: [], description: '' },
      { id: 'a4', title: '-dash', url: 'c:\\temp\\x', tags: ['a,b'] },
      { id: 'a5', title: '007', url: 'yes', description: '  space  ' },
    ],
  };
  assert.deepEqual(roundTrip(doc), doc);
});

test('round-trip over 200 generated combinations', () => {
  const chunks = ['', 'a', 'com: dois', "'aspa'", '"dupla"', 'l1\nl2', ' esp ', '🔖', '007',
    'yes', '#h', 'a,b', '-t', 'x'.repeat(300), 'tab\tmiddle', 'slash\\end', 'end '];
  let seed = 42;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };

  for (let i = 0; i < 200; i++) {
    const doc = {
      id: String(rnd(1000)),
      title: chunks[rnd(chunks.length)],
      description: chunks[rnd(chunks.length)],
      tags: Array.from({ length: rnd(4) }, () => chunks[rnd(chunks.length)]),
      n: rnd(10 ** 9),
      b: rnd(2) === 0,
    };
    assert.deepEqual(roundTrip(doc), doc, `failed on ${JSON.stringify(doc)}`);
  }
});
