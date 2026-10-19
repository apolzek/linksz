'use strict';

// Minimal YAML with no dependency at all: the backend has no node_modules.
//
// This is NOT full YAML. It is the subset the export file needs, plus what a
// person would reasonably write by hand:
//
//   key: value                mapping
//   key:                      mapping/list nested by indentation
//     - item                  list
//   - key: value              list of mappings
//   tags: [a, b]              flow list
//   {a: 1, b: [x]}            flow mapping (we never emit one, others do)
//   description: |            multiline block (| keeps the final break, |- trims it)
//     line 1
//   "with: a colon"           double quotes (with \n \t \" \\ \uXXXX)
//   'literal'                 single quotes ('' escapes the quote)
//   # comment                 a whole line, or after a space
//
// Scalars broken across several lines (quoted or not) are joined by the YAML
// folding rule, which is what emitters do with long text.
//
// What does NOT exist here: anchors (&x), aliases (*x), tags (!!str), multiple
// documents (---), complex keys. On any of them the parser **throws with the
// line number** instead of guessing, because guessing here would mean silently
// importing the wrong vault.
//
// Checked against PyYAML in both directions with 500 generated documents; see
// tests/yaml.test.js.

const INDICATORS = '-?:,[]{}#&*!|>%@`"\'';

/* ============================ emit ============================ */

function needsQuotes(s) {
  if (s === '') return true;
  if (s !== s.trim()) return true;                       // whitespace at the edges
  if (INDICATORS.includes(s[0])) return true;            // starts with an indicator
  if (s.includes(': ') || s.endsWith(':')) return true;  // would become a key
  if (s.includes(' #')) return true;                     // would become a comment
  if (/[\n\r\t]/.test(s)) return true;
  // Must not read back as another type.
  if (/^(true|false|null|yes|no|on|off|~)$/i.test(s)) return true;
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return true;
  return false;
}

function quote(s) {
  const escaped = s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `"${escaped}"`;
}

function scalar(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  const s = String(value);
  return needsQuotes(s) ? quote(s) : s;
}

// Text with line breaks becomes a `|-` block: readable and editable in the file.
function blockScalar(value, indent) {
  const pad = ' '.repeat(indent + 2);
  const lines = String(value).replace(/\r\n?/g, '\n').split('\n');
  const trailing = lines[lines.length - 1] === '';
  if (trailing) lines.pop();
  const head = trailing ? '|' : '|-';
  return `${head}\n${lines.map((l) => (l ? pad + l : '')).join('\n')}`;
}

function dumpValue(value, indent) {
  const pad = ' '.repeat(indent);

  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    return '\n' + value.map((item) => {
      if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
        // List of mappings: the first key stays on the same line as the dash.
        const body = dumpMapping(item, indent + 2);
        return `${pad}- ${body.slice(indent + 2)}`;
      }
      return `${pad}- ${scalar(item)}`;
    }).join('\n');
  }

  if (value !== null && typeof value === 'object') {
    if (!Object.keys(value).length) return '{}';
    return '\n' + dumpMapping(value, indent + 2);
  }

  if (typeof value === 'string' && value.includes('\n')) return blockScalar(value, indent);
  return scalar(value);
}

function dumpMapping(obj, indent) {
  const pad = ' '.repeat(indent);
  const out = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    // The key follows the same rules as the value: unquoted, a `yes:` key turns
    // into a boolean in YAML 1.1 and the file stops reading back the same elsewhere.
    const k = scalar(String(key));
    const rendered = dumpValue(value, indent);
    out.push(rendered.startsWith('\n') ? `${pad}${k}:${rendered}` : `${pad}${k}: ${rendered}`);
  }
  return out.join('\n');
}

function stringify(value, { header = '' } = {}) {
  const prefix = header
    ? header.split('\n').map((l) => `# ${l}`.trimEnd()).join('\n') + '\n'
    : '';
  const body = (value !== null && typeof value === 'object' && !Array.isArray(value))
    ? dumpMapping(value, 0)
    : dumpValue(value, 0).replace(/^\n/, '');
  return `${prefix}${body}\n`;
}

/* ============================ read ============================ */

class YamlError extends Error {
  constructor(message, line) {
    super(line ? `line ${line}: ${message}` : message);
    this.name = 'YamlError';
    this.line = line;
  }
}

// Strips a trailing comment, respecting quotes.
function stripComment(text) {
  let quoteChar = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoteChar) {
      if (c === '\\' && quoteChar === '"') { i++; continue; }
      if (c === quoteChar) quoteChar = '';
    } else if (c === '"' || c === "'") {
      quoteChar = c;
    } else if (c === '#' && (i === 0 || /\s/.test(text[i - 1]))) {
      return text.slice(0, i);
    }
  }
  return text;
}

function parseScalar(raw, line) {
  const text = raw.trim();
  if (text === '' || text === '~' || text === 'null') return null;

  if (text[0] === '"' || text[0] === "'") {
    const q = text[0];
    const close = closingQuote(text, q);
    if (close < 0) throw new YamlError(`unclosed ${q === '"' ? 'double' : 'single'} quote`, line);
    if (close !== text.length - 1) throw new YamlError('trailing content after the closing quote', line);
    return foldQuoted(text, q, line);
  }

  if (text[0] === '&' || text[0] === '*') throw new YamlError('anchor/alias not supported', line);
  if (text.startsWith('!!') || text.startsWith('!')) throw new YamlError('YAML tag not supported', line);

  if (text[0] === '[') {
    if (text[text.length - 1] !== ']') throw new YamlError('unclosed flow list', line);
    const inner = text.slice(1, -1).trim();
    if (!inner) return [];
    return splitFlow(inner, line).map((part) => parseScalar(part, line));
  }

  // Flow mapping: `{a: 1, tags: [x, y]}`. Not what we emit, but what other
  // emitters produce in flow style, and refusing it would mean refusing a
  // legitimate export.
  if (text[0] === '{') {
    if (text[text.length - 1] !== '}') throw new YamlError('unclosed flow mapping', line);
    const inner = text.slice(1, -1).trim();
    if (!inner) return {};
    const out = {};
    for (const part of splitFlow(inner, line)) {
      const colon = flowColon(part);
      if (colon < 0) throw new YamlError(`expected "key: value" in ${JSON.stringify(part)}`, line);
      out[String(parseScalar(part.slice(0, colon), line))] = parseScalar(part.slice(colon + 1), line);
    }
    return out;
  }

  // A plain scalar broken across lines (emitters do that when the value goes
  // past the width). The break becomes a space, by the same rule as quotes.
  if (text.includes('\n')) return foldBreaks(text.split('\n').map((l) => l.trim()));

  if (/^(true|yes|on)$/i.test(text)) return true;
  if (/^(false|no|off)$/i.test(text)) return false;
  if (/^[-+]?\d+$/.test(text)) {
    const n = Number(text);
    return Number.isSafeInteger(n) ? n : text;
  }
  if (/^[-+]?(\d+\.\d*|\.\d+)([eE][-+]?\d+)?$/.test(text)) return Number(text);

  return text;
}

// Where the quote opened at text[0] closes. -1 = it does not close in this string.
function closingQuote(text, q) {
  for (let i = 1; i < text.length; i++) {
    if (q === '"' && text[i] === '\\') { i++; continue; }
    if (text[i] === q) {
      if (q === "'" && text[i + 1] === "'") { i++; continue; }  // '' escapa a aspa
      return i;
    }
  }
  return -1;
}

// Joins the lines of a broken scalar: one break becomes a space, n consecutive
// breaks become n-1 newlines. Inside double quotes, a backslash at the end of a
// line swallows the break entirely (explicit continuation).
function foldBreaks(parts, allowEscapedBreak = false) {
  let out = '';
  let breaks = 0;
  let glued = false;

  for (let i = 0; i < parts.length; i++) {
    let part = parts[i];
    const trailing = (part.match(/\\*$/) || [''])[0].length;
    const suppress = allowEscapedBreak && trailing % 2 === 1;
    if (suppress) part = part.slice(0, -1);

    if (i === 0) { out = part; glued = suppress; continue; }
    if (part === '' && !suppress) { breaks++; continue; }

    out += glued ? '' : (breaks === 0 ? ' ' : '\n'.repeat(breaks));
    out += part;
    breaks = 0;
    glued = suppress;
  }

  if (breaks > 0) out += '\n'.repeat(breaks - 1);
  return out;
}

// A quoted scalar may span lines, which is what PyYAML and other emitters do
// with long text. A single break becomes a space; n consecutive breaks become
// n-1 newlines (the YAML folding rule).
function foldQuoted(full, q, line) {
  const close = closingQuote(full, q);
  if (close < 0) throw new YamlError('unclosed quote', line);

  const parts = full.slice(1, close).split('\n');

  // Whitespace disappears when it touches a line break, but the whitespace on
  // the last line touches no break, it touches the quote: it is content.
  const norm = parts.length === 1 ? parts : parts.map((p, i) => (
    i === 0 ? p.replace(/\s+$/, '')
      : i === parts.length - 1 ? p.replace(/^\s+/, '')
        : p.trim()
  ));

  const out = foldBreaks(norm, q === '"');

  return q === "'"
    ? out.replace(/''/g, "'")
    : out.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (m, esc) => {
      if (esc[0] === 'u') return String.fromCharCode(parseInt(esc.slice(1), 16));
      return { n: '\n', r: '\r', t: '\t', '"': '"', "'": "'", '\\': '\\', '0': '\0' }[esc] ?? esc;
    });
}

// Splits "a, b, 'c, d', [e, f]" on the top-level commas, respecting quotes and
// nested brackets/braces.
function splitFlow(text, line) {
  const parts = [];
  let cur = '';
  let quoteChar = '';
  let depth = 0;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoteChar) {
      cur += c;
      if (c === '\\' && quoteChar === '"') { cur += text[++i] ?? ''; continue; }
      if (c === quoteChar) quoteChar = '';
    } else if ((c === '"' || c === "'") && opensQuote(text, i)) {
      quoteChar = c;
      cur += c;
    } else if (c === '[' || c === '{') {
      depth++;
      cur += c;
    } else if (c === ']' || c === '}') {
      depth--;
      cur += c;
    } else if (c === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }

  if (quoteChar) throw new YamlError('unclosed quote in the list', line);
  parts.push(cur);
  return parts.map((p) => p.trim()).filter((p, i, arr) => !(p === '' && i === arr.length - 1));
}

// A quote only opens a scalar at the start of a token. In the middle of a plain
// scalar it is literal: `description: a stray " quote` is valid YAML.
function opensQuote(text, i) {
  for (let j = i - 1; j >= 0; j--) {
    const c = text[j];
    if (/\s/.test(c)) continue;
    return c === ',' || c === '[' || c === '{' || c === ':';
  }
  return true;
}

// Did a flow structure ([...] or {...}) close yet? It is fed one line at a
// time and carries its state from one to the next, so a long structure is read
// once. Rescanning everything gathered so far on every line made a long one (a
// JSON file offered as YAML, say) quadratic, and froze the server for minutes.
// `prev` is the last character that was not whitespace, which is what decides
// whether a quote opens a scalar (see opensQuote).
function flowScan(chunk, state = { depth: 0, quoteChar: '', prev: '', skip: false }) {
  let { depth, quoteChar, prev, skip } = state;
  for (let i = 0; i < chunk.length; i++) {
    const c = chunk[i];
    if (skip) { skip = false; continue; }
    if (quoteChar) {
      if (c === '\\' && quoteChar === '"') { skip = true; continue; }
      if (c === quoteChar) {
        if (quoteChar === "'" && chunk[i + 1] === "'") { skip = true; continue; }
        quoteChar = '';
      }
    } else if ((c === '"' || c === "'") && (prev === '' || prev === ',' || prev === '[' || prev === '{' || prev === ':')) {
      quoteChar = c;
    } else if (c === '[' || c === '{') {
      depth++;
    } else if (c === ']' || c === '}') {
      depth--;
      if (depth === 0) return { done: true, depth, quoteChar, prev: c, skip };
    }
    if (!/\s/.test(c)) prev = c;
  }
  return { done: false, depth, quoteChar, prev, skip };
}

// Position of the ":" separating key from value in a flow mapping item.
// It requires a space after it, otherwise "https://x" would become a key.
function flowColon(text) {
  let quoteChar = '';
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoteChar) {
      if (c === '\\' && quoteChar === '"') { i++; continue; }
      if (c === quoteChar) quoteChar = '';
    } else if ((c === '"' || c === "'") && opensQuote(text, i)) {
      quoteChar = c;
    } else if (c === '[' || c === '{') {
      depth++;
    } else if (c === ']' || c === '}') {
      depth--;
    } else if (c === ':' && depth === 0 && (i + 1 >= text.length || /\s/.test(text[i + 1]))) {
      return i;
    }
  }
  return -1;
}

class Reader {
  constructor(text) {
    if (typeof text !== 'string') throw new YamlError('content must be text');
    this.lines = text.replace(/\r\n?/g, '\n').split('\n').map((raw, i) => {
      const withoutTabs = raw.match(/^\t/) ? null : raw;
      if (withoutTabs === null) throw new YamlError('indentation with TAB, YAML requires spaces', i + 1);
      const indent = raw.length - raw.trimStart().length;
      const trimmed = raw.trim();
      const content = stripComment(raw.slice(indent)).trimEnd();
      return {
        n: i + 1,
        raw,
        indent,
        content,
        skip: trimmed === '' || trimmed.startsWith('#'),
      };
    });
    this.i = 0;
  }

  peek() {
    while (this.i < this.lines.length && this.lines[this.i].skip) this.i++;
    return this.i < this.lines.length ? this.lines[this.i] : null;
  }

  parse() {
    const first = this.peek();
    if (!first) return null;
    if (first.content.startsWith('---')) throw new YamlError('multiple documents (---) not supported', first.n);
    return this.parseNode(first.indent);
  }

  parseNode(indent) {
    const line = this.peek();
    if (!line || line.indent < indent) return null;

    // A whole document in flow style: `{a: 1, b: [x]}`.
    if (line.content[0] === '{' || line.content[0] === '[') {
      this.i++;
      return this.readScalar(line.content, line.n);
    }

    return /^-(\s|$)/.test(line.content) ? this.parseSequence(indent) : this.parseMapping(indent);
  }

  parseSequence(indent) {
    const out = [];
    for (;;) {
      const line = this.peek();
      if (!line || line.indent !== indent || !/^-(\s|$)/.test(line.content)) break;

      const dash = line.content.match(/^-\s*/)[0];
      const rest = line.content.slice(dash.length);
      // The real column where content starts, respecting "-   key: v".
      const contentCol = indent + dash.length;

      if (rest === '') {
        this.i++;
        const next = this.peek();
        out.push(next && next.indent > indent ? this.parseNode(next.indent) : null);
      } else if (this.looksLikeKey(rest)) {
        // The mapping's first key lives on the dash line.
        this.lines[this.i] = { ...line, indent: contentCol, content: rest };
        out.push(this.parseMapping(contentCol));
      } else {
        this.i++;
        out.push(this.readScalar(rest, line.n, indent));
      }
    }
    return out;
  }

  looksLikeKey(text) {
    if (text[0] === '"' || text[0] === "'") {
      const close = text.indexOf(text[0], 1);
      return close > 0 && /^\s*:(\s|$)/.test(text.slice(close + 1));
    }
    const m = text.match(/^([^:]+):(\s|$)/);
    return Boolean(m);
  }

  parseMapping(indent) {
    const out = {};
    for (;;) {
      const line = this.peek();
      if (!line || line.indent < indent) break;
      if (line.indent > indent) throw new YamlError('unexpected indentation', line.n);
      if (/^-(\s|$)/.test(line.content)) break;

      const { key, rest } = this.splitKey(line);
      this.i++;

      if (rest === '') {
        const next = this.peek();
        out[key] = (next && next.indent > indent) ? this.parseNode(next.indent)
          : (next && next.indent === indent && /^-(\s|$)/.test(next.content)) ? this.parseSequence(indent)
            : null;
      } else if (rest === '|' || rest === '|-' || rest === '|+' || rest === '>' || rest === '>-') {
        out[key] = this.readBlock(indent, rest);
      } else {
        out[key] = this.readScalar(rest, line.n, indent);
      }
    }
    return out;
  }

  // An ordinary scalar, except when the quote does not close on its own line:
  // then the value continues on the next ones (that is how emitters break long text).
  readScalar(rest, lineNo, parentIndent = null) {
    const head = rest[0];

    // A flow structure that did not close: emitters break `{a: 1, b: 2}` across
    // several lines when it gets long.
    if (head === '[' || head === '{') {
      const acc = [rest];
      let scan = flowScan(rest);
      while (!scan.done) {
        if (this.i >= this.lines.length) throw new YamlError('unclosed flow structure', lineNo);
        const raw = this.lines[this.i].raw;
        acc.push(raw);
        this.i++;
        scan = flowScan('\n' + raw, scan);
      }
      return parseScalar(acc.join('\n'), lineNo);
    }

    if (head !== '"' && head !== "'") {
      // A plain scalar can continue on the next lines too: any line indented
      // further that is neither another key nor a list item.
      if (parentIndent !== null) {
        const segs = [rest];
        while (this.i < this.lines.length) {
          const next = this.lines[this.i];
          if (next.skip || next.indent <= parentIndent) break;
          if (this.looksLikeKey(next.content) || /^-(\s|$)/.test(next.content)) break;
          segs.push(next.content.trim());
          this.i++;
        }
        if (segs.length > 1) return foldBreaks(segs);
      }
      return parseScalar(rest, lineNo);
    }

    if (closingQuote(rest, head) >= 0) return parseScalar(rest, lineNo);

    // Quotes spanning several lines.
    const segs = [rest];
    while (closingQuote(segs.join('\n'), head) < 0) {
      if (this.i >= this.lines.length) throw new YamlError('unclosed quote', lineNo);
      // Raw: foldQuoted is what decides which whitespace is indentation and
      // which is content, because it knows the YAML folding rule.
      segs.push(this.lines[this.i].raw);
      this.i++;
    }
    return foldQuoted(segs.join('\n'), head, lineNo);
  }

  splitKey(line) {
    const text = line.content;
    if (text[0] === '"' || text[0] === "'") {
      const close = text.indexOf(text[0], 1);
      if (close < 0) throw new YamlError('key with an unclosed quote', line.n);
      const after = text.slice(close + 1).replace(/^\s*:\s?/, '');
      return { key: parseScalar(text.slice(0, close + 1), line.n), rest: after.trim() };
    }
    const idx = text.indexOf(':');
    if (idx < 0) throw new YamlError(`expected "key: value", got ${JSON.stringify(text)}`, line.n);
    return { key: text.slice(0, idx).trim(), rest: text.slice(idx + 1).trim() };
  }

  // Literal block: uses the raw lines, stripping neither comment nor whitespace.
  readBlock(parentIndent, marker) {
    const collected = [];
    let blockIndent = null;

    while (this.i < this.lines.length) {
      const line = this.lines[this.i];
      const isBlank = line.raw.trim() === '';

      if (!isBlank && line.indent <= parentIndent) break;
      if (blockIndent === null && !isBlank) blockIndent = line.indent;

      collected.push(isBlank ? '' : line.raw.slice(blockIndent ?? line.indent));
      this.i++;
    }

    while (collected.length && collected[collected.length - 1] === '') collected.pop();
    const text = marker.startsWith('>') ? collected.join(' ') : collected.join('\n');
    return marker === '|' || marker === '>' ? text + '\n' : text;
  }
}

function parse(text) {
  return new Reader(text).parse();
}

module.exports = { stringify, parse, YamlError };
