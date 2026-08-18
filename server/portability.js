'use strict';

// Import e export do vault.
//
// Formatos:
//   yaml   nativo — legível, editável à mão, guarda tudo (tags, pasta, notas)
//   html   Netscape Bookmark File — o que Chrome/Firefox/Edge/Safari
//          exportam e importam. É a ponte com o mundo.
//   json   despejo cru, para script
//
// A parte que exige cuidado é o import. Importar não é "adicionar tudo":
// o mesmo favorito pode já existir, com outro título, ou ter sido editado dos
// dois lados. Por isso o import é sempre **plano primeiro, aplicação depois** —
// planImport() diz exatamente o que vai acontecer e a UI mostra antes de gravar.

const yaml = require('./yaml');

const MODES = ['adicionar', 'atualizar', 'mais-recente', 'substituir'];

/* ======================= identidade ======================= */

// Duas entradas são "a mesma" se têm o mesmo id, ou a mesma URL normalizada.
// A URL é o que permite reimportar um arquivo do browser sem duplicar tudo.
function urlKey(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw.includes('://') ? raw : `https://${raw}`);
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    const path = u.pathname.replace(/\/+$/, '');
    // Fragmento fora: `#secao` é o mesmo documento. Query fica: muda a página.
    return `${host}${path}${u.search}`.toLowerCase();
  } catch {
    return raw.toLowerCase().replace(/\/+$/, '');
  }
}

const FIELDS = ['title', 'url', 'folder', 'category', 'tags', 'description'];

function sameContent(a, b) {
  return FIELDS.every((f) => String(a[f] ?? '') === String(b[f] ?? ''));
}

/* ======================= exportar ======================= */

function toYaml(bookmarks, { user = '' } = {}) {
  const doc = {
    version: 1,
    exported_at: new Date().toISOString(),
    count: bookmarks.length,
    bookmarks: bookmarks.map((b) => {
      const item = {
        id: b.id,
        title: b.title || '',
        url: b.url || '',
      };
      if (b.folder) item.folder = b.folder;
      if (b.category) item.category = b.category;
      // Lista em vez de csv: no arquivo isso é bem mais legível e editável.
      if (b.tags) item.tags = String(b.tags).split(',').filter(Boolean);
      if (b.description) item.description = b.description;
      item.created_at = b.created_at;
      item.updated_at = b.updated_at;
      return item;
    }),
  };

  const header = [
    'Vaultmarks — export do vault',
    user ? `usuario: ${user}` : '',
    '',
    'Pode editar este arquivo a mao e importar de volta.',
    'O campo id e o que liga cada linha ao favorito ja existente:',
    'apagando o id, o favorito entra como novo.',
  ].filter((l) => l !== null).join('\n');

  return yaml.stringify(doc, { header });
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Netscape Bookmark File: formato de 1990 que todo navegador ainda fala.
// A hierarquia de pastas vira <DL> aninhado; tags cabem no atributo TAGS
// (convenção do Firefox) e a categoria vira uma pasta de primeiro nível.
function toNetscapeHtml(bookmarks) {
  const tree = new Map();
  for (const b of bookmarks) {
    const path = b.folder || '';
    if (!tree.has(path)) tree.set(path, []);
    tree.get(path).push(b);
  }

  const lines = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<!-- This is an automatically generated file.',
    '     It will be read and overwritten.',
    '     DO NOT EDIT! -->',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    '<DL><p>',
  ];

  const entry = (b, depth) => {
    const pad = '    '.repeat(depth);
    const attrs = [
      `HREF="${escapeHtml(b.url)}"`,
      b.created_at ? `ADD_DATE="${Math.floor(Number(b.created_at) / 1000)}"` : '',
      b.updated_at ? `LAST_MODIFIED="${Math.floor(Number(b.updated_at) / 1000)}"` : '',
      b.tags ? `TAGS="${escapeHtml(b.tags)}"` : '',
    ].filter(Boolean).join(' ');
    const out = [`${pad}<DT><A ${attrs}>${escapeHtml(b.title || b.url)}</A>`];
    if (b.description) out.push(`${pad}<DD>${escapeHtml(b.description)}`);
    return out;
  };

  // Ordena pela chave, nao pelo par: o sort padrao converte o elemento inteiro
  // em string, e as linhas vindas do node:sqlite tem prototipo nulo — nao
  // sobrevivem a String().
  const pastas = [...tree.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  for (const [folder, items] of pastas) {
    if (!folder) {
      for (const b of items) lines.push(...entry(b, 1));
      continue;
    }
    // Cada nível da pasta vira um <DL> — é assim que o browser mostra a árvore.
    const parts = folder.split('/').filter(Boolean);
    parts.forEach((part, i) => {
      const pad = '    '.repeat(i + 1);
      lines.push(`${pad}<DT><H3>${escapeHtml(part)}</H3>`, `${pad}<DL><p>`);
    });
    for (const b of items) lines.push(...entry(b, parts.length + 1));
    for (let i = parts.length - 1; i >= 0; i--) lines.push(`${'    '.repeat(i + 1)}</DL><p>`);
  }

  lines.push('</DL><p>', '');
  return lines.join('\n');
}

function toJson(bookmarks) {
  return JSON.stringify({ version: 1, count: bookmarks.length, bookmarks }, null, 2);
}

/* ======================= importar: ler ======================= */

function decodeHtml(s) {
  return String(s ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');   // por último, senão &amp;lt; vira <
}

function normTagList(value) {
  const parts = Array.isArray(value) ? value : String(value ?? '').split(/[,\s]+/);
  const out = [];
  for (let t of parts) {
    t = String(t).replace(/^#/, '').trim().toLowerCase();
    if (t && !out.includes(t)) out.push(t);
  }
  return out.join(',');
}

function normalizeIncoming(raw) {
  return {
    id: String(raw.id ?? '').trim().slice(0, 64),
    title: String(raw.title ?? '').trim().slice(0, 500),
    url: String(raw.url ?? '').trim().slice(0, 2000),
    folder: String(raw.folder ?? '').trim().replace(/^\/+|\/+$/g, '').slice(0, 300),
    category: String(raw.category ?? '').replace(/^@/, '').trim().toLowerCase().slice(0, 200),
    tags: normTagList(raw.tags),
    // `notes` e o nome antigo do campo: arquivo velho continua importando.
    description: String(raw.description ?? raw.notes ?? '').trim().slice(0, 5000),
    created_at: Number(raw.created_at) > 0 ? Number(raw.created_at) : null,
    updated_at: Number(raw.updated_at) > 0 ? Number(raw.updated_at) : null,
  };
}

function parseYamlExport(text) {
  const doc = yaml.parse(text);
  if (doc === null) return [];

  const list = Array.isArray(doc) ? doc : doc.bookmarks;
  if (!Array.isArray(list)) {
    throw new Error('YAML sem a lista "bookmarks" — confira o arquivo');
  }
  return list
    .filter((item) => item && typeof item === 'object')
    .map(normalizeIncoming);
}

// Lê o HTML do navegador sem parser de HTML: o formato é rígido o suficiente
// (uma linha por <DT>) e regex aqui é mais previsível que meio parser.
function parseNetscapeHtml(text) {
  const out = [];
  const stack = [];
  let last = null;

  const lines = String(text).split(/\r?\n/);
  for (const line of lines) {
    const h3 = /<DT>\s*<H3[^>]*>(.*?)<\/H3>/i.exec(line);
    if (h3) {
      stack.push(decodeHtml(h3[1]).trim());
      continue;
    }
    if (/<\/DL>/i.test(line)) {
      stack.pop();
      continue;
    }

    const a = /<DT>\s*<A\s+([^>]*)>(.*?)<\/A>/i.exec(line);
    if (a) {
      const attrs = a[1];
      const attr = (name) => {
        const m = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i').exec(attrs);
        return m ? decodeHtml(m[1]) : '';
      };
      const href = attr('HREF');
      // Bookmarklets e separadores não são favoritos.
      if (!href || /^(javascript|place):/i.test(href)) { last = null; continue; }

      const seconds = (v) => (Number(v) > 0 ? Number(v) * 1000 : null);
      last = normalizeIncoming({
        title: decodeHtml(a[2]),
        url: href,
        folder: stack.join('/'),
        tags: attr('TAGS'),
        created_at: seconds(attr('ADD_DATE')),
        updated_at: seconds(attr('LAST_MODIFIED')),
      });
      out.push(last);
      continue;
    }

    // <DD> traz a descrição do favorito anterior.
    const dd = /<DD>(.*)$/i.exec(line);
    if (dd && last) last.description = decodeHtml(dd[1]).trim().slice(0, 5000);
  }

  return out;
}

function parseJsonExport(text) {
  const doc = JSON.parse(text);
  const list = Array.isArray(doc) ? doc : doc.bookmarks;
  if (!Array.isArray(list)) throw new Error('JSON sem a lista "bookmarks"');
  return list.filter((i) => i && typeof i === 'object').map(normalizeIncoming);
}

function detectFormat(text) {
  const head = String(text).slice(0, 2000).trim();
  if (/^<!DOCTYPE NETSCAPE-Bookmark/i.test(head) || /<DT>\s*<A\s/i.test(head)) return 'html';
  if (head.startsWith('{') && /"bookmarks"\s*:/.test(head)) return 'json';
  if (head.startsWith('[')) return 'json';
  return 'yaml';
}

function parseImport(text, format = 'auto') {
  const chosen = format === 'auto' ? detectFormat(text) : format;
  const parsers = { yaml: parseYamlExport, html: parseNetscapeHtml, json: parseJsonExport };
  const parser = parsers[chosen];
  if (!parser) throw new Error(`formato desconhecido: ${chosen}`);

  const items = parser(text);
  // Sem url e sem título não dá pra fazer nada com a linha.
  return { format: chosen, items: items.filter((b) => b.url || b.title) };
}

/* ======================= importar: planejar ======================= */

/**
 * Decide o destino de cada entrada do arquivo, sem gravar nada.
 *
 * Modos:
 *   adicionar     só cria o que não existe. Nunca toca no que já está.
 *   atualizar     cria os novos e sobrescreve os existentes com o arquivo.
 *   mais-recente  vence quem tem updated_at maior (merge de dois vaults).
 *   substituir    o arquivo passa a ser a verdade: o que não está nele é removido.
 */
function planImport(existing, incoming, mode = 'adicionar') {
  if (!MODES.includes(mode)) throw new Error(`modo invalido: ${mode}`);

  const byId = new Map();
  const byUrl = new Map();
  for (const b of existing) {
    byId.set(b.id, b);
    const key = urlKey(b.url);
    // O primeiro ganha o índice: duplicata local não rouba o par do outro.
    if (key && !byUrl.has(key)) byUrl.set(key, b);
  }

  const plan = { criar: [], atualizar: [], iguais: [], ignorar: [], remover: [] };
  const casados = new Set();

  for (const item of incoming) {
    const atual = (item.id && byId.get(item.id)) || byUrl.get(urlKey(item.url)) || null;

    if (!atual) {
      plan.criar.push({ incoming: item });
      continue;
    }
    casados.add(atual.id);

    // Mantém o id do vault: o do arquivo pode vir de outra instalação.
    const merged = { ...item, id: atual.id, created_at: atual.created_at };

    if (sameContent(atual, item)) {
      plan.iguais.push({ atual, incoming: item });
      continue;
    }

    if (mode === 'adicionar') {
      plan.ignorar.push({ atual, incoming: item, motivo: 'ja existe' });
    } else if (mode === 'mais-recente' && Number(item.updated_at) <= Number(atual.updated_at)) {
      plan.ignorar.push({ atual, incoming: item, motivo: 'a versao do vault e mais nova' });
    } else {
      plan.atualizar.push({ atual, incoming: merged });
    }
  }

  if (mode === 'substituir') {
    for (const b of existing) {
      if (!casados.has(b.id)) plan.remover.push({ atual: b });
    }
  }

  plan.resumo = {
    modo: mode,
    lidos: incoming.length,
    criar: plan.criar.length,
    atualizar: plan.atualizar.length,
    iguais: plan.iguais.length,
    ignorar: plan.ignorar.length,
    remover: plan.remover.length,
  };
  return plan;
}

module.exports = {
  MODES,
  urlKey,
  toYaml,
  toNetscapeHtml,
  toJson,
  parseImport,
  parseYamlExport,
  parseNetscapeHtml,
  detectFormat,
  planImport,
  normalizeIncoming,
};
