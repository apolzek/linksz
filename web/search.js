// Shared search engine: runs on Node (server) and in the browser (web).
// One file, two runtimes: the api image copies it out of web/, which is why the
// api is built from the repository root.
'use strict';

// ---------------------------------------------------------------------------
// Syntax
//
//   text             substring in title, url, tags, category, folder, description
//   "two words"      substring with a space (literal phrase)
//   #tag             tags only
//   @category        category only
//   /folder          folder only
//   field:value      that field only (title, url, description, tag/tags, cat/category, folder)
//   -term            excludes (works with any of the forms above)
//
// Terms combine with AND. Everything is substring, case- and accent-insensitive.
// ---------------------------------------------------------------------------

const FIELDS = ['title', 'url', 'tags', 'category', 'folder', 'description'];

// Weight of each field in free search: where it matched matters more than how often.
const ANY_WEIGHTS = [
  ['title', 60],
  ['url', 50],
  ['tags', 45],
  ['category', 40],
  ['folder', 35],
  ['description', 20],
];

// Usage ranking. A bookmark you keep opening is the one you probably want, so
// its score gets a bonus. It saturates on purpose: after USAGE_CAP opens an old
// favourite stops climbing, otherwise it would bury better matches forever.
// Integers only, so the order is exactly reproducible.
const USAGE_STEP = 3;
const USAGE_CAP = 12;

const SIGILS = { '#': 'tags', '@': 'category', '/': 'folder' };

const FIELD_ALIASES = {
  title: 'title',
  url: 'url',
  link: 'url',
  desc: 'description',
  description: 'description',
  // The field used to be called `notes`; typing `notes:something` still works.
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

// Whitespace spelled out by hand instead of /\s/: the regex class has moved
// between engine versions on corners like U+0085 and U+FEFF, and tokenizing has
// to be stable for any input.
const WHITESPACE =
  ' \t\n\v\f\r\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006'
  + '\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';

function norm(s) {
  return String(s == null ? '' : s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

// Splits on whitespace but keeps quoted runs together. The quotes stay in the
// token; stripQuotes removes them later, after the prefixes are read.
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

// Splits a field into components (tags are csv, titles have spaces).
// Hand-written for the same reason as WHITESPACE: split(/[,\s]+/) and
// str.split() do not agree on every character.
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

// An unclosed quote still counts: `"foo bar` becomes `foo bar`.
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

  // A sigil with no value (`#`, `-`, `@`) becomes an empty term and is dropped
  // by parseQuery: while `#devops` is being typed, a lone `#` must not empty
  // the list.
  const negate = text[0] === '-';
  if (negate) text = text.slice(1);

  let field = 'any';
  if (SIGILS[text[0]]) {
    field = SIGILS[text[0]];
    text = text.slice(1);
  } else {
    // `field:value`, but only for known fields, otherwise `https://x` would
    // become a filter on a "https" field.
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
    // Nothing left after the prefixes (e.g. `#`, `""`, `-`): ignore it.
    if (term.value) terms.push(term);
  }
  return terms;
}

// Normalizing is most of the cost of a search: NFD and a regex over six fields
// of every bookmark, on every keystroke. The result depends only on the
// bookmark, so it is kept per object. An edit replaces the object rather than
// mutating it, which is what retires the stale entry, and a WeakMap lets it go
// with the bookmark. Where nothing is reused (the server reads fresh rows on
// each request) it costs one lookup and changes nothing.
const fieldCache = new WeakMap();

function fieldsOf(b) {
  let f = fieldCache.get(b);
  if (f) return f;
  f = {};
  for (const name of FIELDS) f[name] = norm(b[name]);
  fieldCache.set(b, f);
  return f;
}

// null = no match. A number = score (higher is better).
function scoreTerm(f, term) {
  const v = term.value;

  if (term.field !== 'any') {
    const hay = f[term.field];
    const i = hay.indexOf(v);
    if (i < 0) return null;
    // A whole component (tag `go` in `go,golang`) is worth more than a substring.
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

function usageBoost(b) {
  const opens = Math.floor(Number(b.opens));
  if (!Number.isFinite(opens) || opens <= 0) return 0;
  return Math.min(opens, USAGE_CAP) * USAGE_STEP;
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

    // With no query every match scores 0, so the plain list is ranked by usage
    // too, which is what the bar shows the moment it opens.
    if (ok) out.push({ bookmark: b, score: total + usageBoost(b) });
  }

  // Ties break by recency. Beyond that the sort is stable in both languages, so
  // input order decides the rest and the sort stays stable.
  out.sort((a, b) =>
    (b.score - a.score) ||
    ((Number(b.bookmark.updated_at) || 0) - (Number(a.bookmark.updated_at) || 0)));

  return out.slice(0, limit).map((r) => r.bookmark);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { search, parseQuery, tokenize, norm };
} else {
  globalThis.LinkszSearch = { search, parseQuery, tokenize, norm };
}
