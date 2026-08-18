// Motor de busca compartilhado: roda no Node (server) e no browser (web).
// A versao Python equivalente vive em desktop/vmsearch.py e PRECISA devolver
// exatamente os mesmos resultados — tests/test_desktop.py compara as duas.
'use strict';

// ---------------------------------------------------------------------------
// Sintaxe
//
//   texto            substring em titulo, url, tags, categoria, pasta, notas
//   "duas palavras"  substring com espaco (frase literal)
//   #tag             so em tags
//   @categoria       so em categoria
//   /pasta           so em pasta
//   campo:valor      so no campo (title, url, description, tag/tags, cat/category, folder)
//   -termo           exclui (funciona com qualquer forma acima)
//
// Termos combinam com AND. Tudo e substring, case-insensitive e sem acentos.
// ---------------------------------------------------------------------------

const FIELDS = ['title', 'url', 'tags', 'category', 'folder', 'description'];

// Peso de cada campo na busca livre: onde casou importa mais que quantas vezes.
const ANY_WEIGHTS = [
  ['title', 60],
  ['url', 50],
  ['tags', 45],
  ['category', 40],
  ['folder', 35],
  ['description', 20],
];

const SIGILS = { '#': 'tags', '@': 'category', '/': 'folder' };

const FIELD_ALIASES = {
  title: 'title',
  url: 'url',
  link: 'url',
  desc: 'description',
  description: 'description',
  // O campo se chamava `notes`; quem digita `notes:algo` continua achando.
  note: 'description',
  notes: 'description',
  tag: 'tags',
  tags: 'tags',
  cat: 'category',
  category: 'category',
  folder: 'folder',
  dir: 'folder',
};

const QUOTES = '"\'';

// Espaco definido na unha (em vez de /\s/ e isspace()) porque as duas
// linguagens discordam em cantos como U+0085 e U+FEFF — e a paridade
// JS <-> Python precisa valer para qualquer entrada.
const WHITESPACE =
  ' \t\n\v\f\r\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006'
  + '\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';

function norm(s) {
  return String(s == null ? '' : s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

// Quebra por espaco, mas mantem junto o que estiver entre aspas. As aspas
// seguem no token — quem remove e stripQuotes, depois de ler os prefixos.
function tokenize(q) {
  const tokens = [];
  let cur = '';
  let quote = '';

  for (const ch of String(q == null ? '' : q)) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = '';
    } else if (QUOTES.includes(ch)) {
      cur += ch;
      quote = ch;
    } else if (WHITESPACE.includes(ch)) {
      if (cur) { tokens.push(cur); cur = ''; }
    } else {
      cur += ch;
    }
  }
  if (cur) tokens.push(cur);
  return tokens;
}

// Quebra um campo em componentes (tags sao csv, titulos tem espaco).
// Escrito na mao pelo mesmo motivo de WHITESPACE: split(/[,\s]+/) e
// str.split() nao concordam em todos os caracteres.
function components(hay) {
  const out = [];
  let cur = '';
  for (const ch of hay) {
    if (ch === ',' || WHITESPACE.includes(ch)) {
      if (cur) { out.push(cur); cur = ''; }
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// Aspas nao fechadas ainda contam: `"foo bar` vira `foo bar`.
function stripQuotes(s) {
  if (s.length && QUOTES.includes(s[0])) {
    const q = s[0];
    s = s.slice(1);
    if (s.endsWith(q)) s = s.slice(0, -1);
  }
  return s;
}

function parseToken(raw) {
  let text = raw;

  // Sigilo sem valor (`#`, `-`, `@`) vira termo vazio e e descartado por
  // parseQuery — enquanto se digita `#devops`, o `#` sozinho nao pode zerar
  // a lista.
  const negate = text[0] === '-';
  if (negate) text = text.slice(1);

  let field = 'any';
  if (SIGILS[text[0]]) {
    field = SIGILS[text[0]];
    text = text.slice(1);
  } else {
    // `campo:valor` — mas so para campos conhecidos, senao `https://x` viraria
    // um filtro pelo campo "https".
    const m = /^([a-zA-Z]+):([\s\S]*)$/.exec(text);
    if (m && FIELD_ALIASES[m[1].toLowerCase()]) {
      field = FIELD_ALIASES[m[1].toLowerCase()];
      text = m[2];
    }
  }

  return { field, value: norm(stripQuotes(text)), negate };
}

function parseQuery(q) {
  const terms = [];
  for (const raw of tokenize(q)) {
    const term = parseToken(raw);
    // Sobrou nada depois dos prefixos (ex.: `#`, `""`, `-`): ignora.
    if (term.value) terms.push(term);
  }
  return terms;
}

function fieldsOf(b) {
  const f = {};
  for (const name of FIELDS) f[name] = norm(b[name]);
  return f;
}

// null = nao casou. Numero = pontuacao (maior e melhor).
function scoreTerm(f, term) {
  const v = term.value;

  if (term.field !== 'any') {
    const hay = f[term.field];
    const i = hay.indexOf(v);
    if (i < 0) return null;
    // Componente inteiro (tag `go` em `go,golang`) vale mais que substring.
    const exact = components(hay).includes(v);
    return exact ? 100 : i === 0 ? 70 : 50;
  }

  let best = null;
  for (const [name, weight] of ANY_WEIGHTS) {
    const i = f[name].indexOf(v);
    if (i < 0) continue;
    const score = weight + (i === 0 ? 25 : 0) + (f[name] === v ? 40 : 0);
    if (best === null || score > best) best = score;
  }
  return best;
}

function search(bookmarks, q, limit = 50) {
  const terms = parseQuery(q);
  const out = [];

  for (const b of bookmarks) {
    if (b.deleted) continue;

    const f = fieldsOf(b);
    let total = 0;
    let ok = true;

    for (const term of terms) {
      const s = scoreTerm(f, term);
      if (term.negate) {
        if (s !== null) { ok = false; break; }
      } else if (s === null) {
        ok = false;
        break;
      } else {
        total += s;
      }
    }

    if (ok) out.push({ bookmark: b, score: total });
  }

  // Empate desempata pelo mais recente. Alem disso o sort e estavel nas duas
  // linguagens, entao a ordem de entrada decide o resto — e a paridade se mantem.
  out.sort((a, b) =>
    (b.score - a.score) ||
    ((Number(b.bookmark.updated_at) || 0) - (Number(a.bookmark.updated_at) || 0)));

  return out.slice(0, limit).map((r) => r.bookmark);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { search, parseQuery, tokenize, norm };
} else {
  globalThis.VMSearch = { search, parseQuery, tokenize, norm };
}
