'use strict';

// YAML mínimo, sem dependência nenhuma — o backend não tem node_modules.
//
// NÃO é um YAML completo. É o subconjunto necessário para o arquivo de export
// do Vaultmarks, mais o que uma pessoa razoavelmente escreveria à mão:
//
//   chave: valor              mapa
//   chave:                    mapa/lista aninhada por indentação
//     - item                  lista
//   - chave: valor            lista de mapas
//   tags: [a, b]              lista em linha
//   {a: 1, b: [x]}            mapa em linha (não emitimos, mas outros emitem)
//   description: |                  bloco multilinha (| mantém a quebra final, |- corta)
//     linha 1
//   "com: dois pontos"        aspas duplas (com \n \t \" \\ \uXXXX)
//   'literal'                 aspas simples ('' escapa a aspa)
//   # comentário              linha inteira, ou depois de um espaço
//
// Escalares quebrados em várias linhas (com ou sem aspas) são unidos pela
// regra de folding do YAML — é o que emissores fazem com texto longo.
//
// O que NÃO existe aqui — âncoras (&x), aliases (*x), tags (!!str), documentos
// múltiplos (---), chaves complexas. Encontrando qualquer um deles o parser
// **lança erro com o número da linha** em vez de adivinhar: adivinhar aqui
// significaria importar o vault errado calado.
//
// Conferido contra o PyYAML nos dois sentidos, com 500 documentos gerados —
// ver tests/yaml.test.js.

const INDICATORS = '-?:,[]{}#&*!|>%@`"\'';

/* ============================ emitir ============================ */

function needsQuotes(s) {
  if (s === '') return true;
  if (s !== s.trim()) return true;                       // espaço nas pontas
  if (INDICATORS.includes(s[0])) return true;            // começa com indicador
  if (s.includes(': ') || s.endsWith(':')) return true;  // vira chave
  if (s.includes(' #')) return true;                     // vira comentário
  if (/[\n\r\t]/.test(s)) return true;
  // Não pode ser relido como outro tipo.
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

// Texto com quebra de linha vira bloco `|-`: fica legível e editável no arquivo.
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
        // Lista de mapas: a primeira chave fica na mesma linha do traço.
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
    // A chave passa pelas mesmas regras do valor: sem aspas, uma chave `yes:`
    // vira booleano em YAML 1.1 e o arquivo deixa de reler igual em outro parser.
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

/* ============================ ler ============================ */

class YamlError extends Error {
  constructor(message, line) {
    super(line ? `linha ${line}: ${message}` : message);
    this.name = 'YamlError';
    this.line = line;
  }
}

// Remove comentário no fim da linha, respeitando aspas.
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
    if (close < 0) throw new YamlError(`aspas ${q === '"' ? 'duplas' : 'simples'} nao fechadas`, line);
    if (close !== text.length - 1) throw new YamlError('sobrou conteudo depois das aspas', line);
    return foldQuoted(text, q, line);
  }

  if (text[0] === '&' || text[0] === '*') throw new YamlError('ancora/alias nao suportado', line);
  if (text.startsWith('!!') || text.startsWith('!')) throw new YamlError('tag YAML nao suportada', line);

  if (text[0] === '[') {
    if (text[text.length - 1] !== ']') throw new YamlError('lista em linha nao fechada', line);
    const inner = text.slice(1, -1).trim();
    if (!inner) return [];
    return splitFlow(inner, line).map((part) => parseScalar(part, line));
  }

  // Mapa em linha: `{a: 1, tags: [x, y]}`. Nao e o que a gente emite, mas e o
  // que sai de outros emissores em modo flow — e recusar isso seria recusar
  // um export legitimo do usuario.
  if (text[0] === '{') {
    if (text[text.length - 1] !== '}') throw new YamlError('mapa em linha nao fechado', line);
    const inner = text.slice(1, -1).trim();
    if (!inner) return {};
    const out = {};
    for (const part of splitFlow(inner, line)) {
      const colon = flowColon(part);
      if (colon < 0) throw new YamlError(`esperava "chave: valor" em ${JSON.stringify(part)}`, line);
      out[String(parseScalar(part.slice(0, colon), line))] = parseScalar(part.slice(colon + 1), line);
    }
    return out;
  }

  // Escalar simples quebrado em varias linhas (emissores fazem isso quando o
  // valor passa da largura). A quebra vira espaco, pela mesma regra das aspas.
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

// Onde a aspa aberta em text[0] fecha. -1 = não fecha nesta string.
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

// Junta linhas de um escalar quebrado: uma quebra vira espaço, n quebras
// seguidas viram n-1 novas linhas. Em aspas duplas, uma barra invertida no
// fim da linha engole a quebra inteira (continuação explícita).
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

// Escalar entre aspas pode atravessar linhas — é o que PyYAML e outros
// emissores fazem com texto longo. A quebra simples vira espaço; n quebras
// seguidas viram n-1 novas linhas (regra de folding do YAML).
function foldQuoted(full, q, line) {
  const close = closingQuote(full, q);
  if (close < 0) throw new YamlError('aspas nao fechadas', line);

  const parts = full.slice(1, close).split('\n');

  // O espaco em branco some quando encosta numa quebra de linha — mas o da
  // ultima linha nao encosta em quebra nenhuma, encosta na aspa: e conteudo.
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

// Quebra "a, b, 'c, d', [e, f]" nas virgulas do nivel de cima, respeitando
// aspas e colchetes/chaves aninhados.
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

  if (quoteChar) throw new YamlError('aspas nao fechadas na lista', line);
  parts.push(cur);
  return parts.map((p) => p.trim()).filter((p, i, arr) => !(p === '' && i === arr.length - 1));
}

// Uma aspa so abre um escalar quando esta no inicio de um token. No meio de
// um escalar simples ela e literal: `description: aspa " solta` e YAML valido.
function opensQuote(text, i) {
  for (let j = i - 1; j >= 0; j--) {
    const c = text[j];
    if (/\s/.test(c)) continue;
    return c === ',' || c === '[' || c === '{' || c === ':';
  }
  return true;
}

// Uma estrutura em linha ([...] ou {...}) fechou dentro deste texto?
function flowComplete(text) {
  let quoteChar = '';
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoteChar) {
      if (c === '\\' && quoteChar === '"') { i++; continue; }
      if (c === quoteChar) {
        if (quoteChar === "'" && text[i + 1] === "'") { i++; continue; }
        quoteChar = '';
      }
    } else if ((c === '"' || c === "'") && opensQuote(text, i)) {
      quoteChar = c;
    } else if (c === '[' || c === '{') {
      depth++;
    } else if (c === ']' || c === '}') {
      depth--;
      if (depth === 0) return true;
    }
  }
  return false;
}

// Posicao do ":" que separa chave de valor num item de mapa em linha.
// Exige espaco depois, senao "https://x" viraria chave.
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
    if (typeof text !== 'string') throw new YamlError('conteudo precisa ser texto');
    this.lines = text.replace(/\r\n?/g, '\n').split('\n').map((raw, i) => {
      const withoutTabs = raw.match(/^\t/) ? null : raw;
      if (withoutTabs === null) throw new YamlError('indentacao com TAB — YAML exige espacos', i + 1);
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
    if (first.content.startsWith('---')) throw new YamlError('documento multiplo (---) nao suportado', first.n);
    return this.parseNode(first.indent);
  }

  parseNode(indent) {
    const line = this.peek();
    if (!line || line.indent < indent) return null;

    // Documento inteiro em estilo flow: `{a: 1, b: [x]}`.
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
      // Coluna real onde o conteúdo começa — respeita "-   chave: v".
      const contentCol = indent + dash.length;

      if (rest === '') {
        this.i++;
        const next = this.peek();
        out.push(next && next.indent > indent ? this.parseNode(next.indent) : null);
      } else if (this.looksLikeKey(rest)) {
        // A primeira chave do mapa mora na linha do traço.
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
      if (line.indent > indent) throw new YamlError('indentacao inesperada', line.n);
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

  // Escalar comum, exceto quando a aspa nao fecha na propria linha: ai o valor
  // continua nas seguintes (emissores quebram texto longo assim).
  readScalar(rest, lineNo, parentIndent = null) {
    const head = rest[0];

    // Estrutura em linha que nao fechou: emissores quebram `{a: 1, b: 2}`
    // em varias linhas quando fica longo.
    if (head === '[' || head === '{') {
      let acc = rest;
      while (!flowComplete(acc)) {
        if (this.i >= this.lines.length) throw new YamlError('estrutura em linha nao fechada', lineNo);
        acc += '\n' + this.lines[this.i].raw;
        this.i++;
      }
      return parseScalar(acc, lineNo);
    }

    if (head !== '"' && head !== "'") {
      // Escalar simples tambem pode continuar nas linhas seguintes: qualquer
      // linha mais indentada que nao seja outra chave nem item de lista.
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

    // Aspas que atravessam linhas.
    const segs = [rest];
    while (closingQuote(segs.join('\n'), head) < 0) {
      if (this.i >= this.lines.length) throw new YamlError('aspas nao fechadas', lineNo);
      // Cru: quem decide o que e espaco de indentacao e o que e conteudo
      // e o foldQuoted, que conhece a regra de quebra do YAML.
      segs.push(this.lines[this.i].raw);
      this.i++;
    }
    return foldQuoted(segs.join('\n'), head, lineNo);
  }

  splitKey(line) {
    const text = line.content;
    if (text[0] === '"' || text[0] === "'") {
      const close = text.indexOf(text[0], 1);
      if (close < 0) throw new YamlError('chave com aspas nao fechadas', line.n);
      const after = text.slice(close + 1).replace(/^\s*:\s?/, '');
      return { key: parseScalar(text.slice(0, close + 1), line.n), rest: after.trim() };
    }
    const idx = text.indexOf(':');
    if (idx < 0) throw new YamlError(`esperava "chave: valor", veio ${JSON.stringify(text)}`, line.n);
    return { key: text.slice(0, idx).trim(), rest: text.slice(idx + 1).trim() };
  }

  // Bloco literal: usa as linhas cruas, sem tirar comentário nem espaço.
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
