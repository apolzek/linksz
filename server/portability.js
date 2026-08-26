'use strict';

// Vault import and export.
//
// Formats:
//   yaml   native: readable, hand-editable, keeps everything (tags, folder, description)
//   html   Netscape Bookmark File, what Chrome/Firefox/Edge/Safari export and
//          import. This is the bridge to the rest of the world.
//   json   raw dump, for scripts
//
// The delicate part is the import. Importing is not "add everything": the same
// bookmark may already exist under another title, or have been edited on both
// sides. So the import is always **plan first, apply second**: planImport()
// says exactly what will happen and the UI shows it before anything is written.

const yaml = require('./yaml');

const MODES = ['add', 'update', 'newest', 'replace'];

/* ======================= identity ======================= */

// Two entries are "the same" when they share an id, or a normalized URL.
// The URL is what allows reimporting a browser file without duplicating it all.
function urlKey(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw.includes('://') ? raw : `https://${raw}`);
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    const path = u.pathname.replace(/\/+$/, '');
    // Fragment dropped: `#section` is the same document. Query kept: it changes the page.
    return `${host}${path}${u.search}`.toLowerCase();
  } catch {
    return raw.toLowerCase().replace(/\/+$/, '');
  }
}

// What makes two entries the same bookmark for the import plan. Usage counters
// are deliberately out: opening a link is not an edit to it.
const FIELDS = ['title', 'url', 'folder', 'category', 'tags', 'description'];

function sameContent(a, b) {
  return FIELDS.every((f) => String(a[f] ?? '') === String(b[f] ?? ''));
}

/* ======================= export ======================= */

// One entry as it appears in the file. `folder` is not written: inside the
// export it is the key the entry sits under.
function yamlItem(b) {
  const item = { id: b.id, title: b.title || '', url: b.url || '' };
  if (b.category) item.category = b.category;
  // A list instead of csv: in the file that is far more readable and editable.
  if (b.tags) item.tags = String(b.tags).split(',').filter(Boolean);
  if (b.description) item.description = b.description;
  // Usage survives the round trip. Counters only ever grow, and the server
  // merges them with MAX, so importing an old file cannot lower them.
  if (Number(b.opens) > 0) item.opens = Number(b.opens);
  if (Number(b.last_open_at) > 0) item.last_open_at = Number(b.last_open_at);
  item.created_at = b.created_at;
  item.updated_at = b.updated_at;
  return item;
}

// Sorting is not cosmetic here: with folders and titles in a fixed order, two
// exports of the same vault are the same file, and a diff shows what changed
// instead of what moved.
function byName(a, b) {
  return String(a).localeCompare(String(b), 'en', { sensitivity: 'base' });
}

/* The file is grouped by folder:

     folders:
       technology/infrastructure/observability:
       - title: Grafana Docs
         ...

   which is the tree the app shows, written down. It beats a flat list with a
   `folder:` on every entry for the two things this file is for: reading the
   taxonomy, and editing it by hand (renaming a folder is one key, moving one
   is one line). */
function toYaml(bookmarks, { user = '' } = {}) {
  const grouped = new Map();
  const unfiled = [];
  for (const b of bookmarks) {
    const folder = String(b.folder || '').trim();
    if (!folder) { unfiled.push(b); continue; }
    if (!grouped.has(folder)) grouped.set(folder, []);
    grouped.get(folder).push(b);
  }

  const folders = {};
  for (const path of [...grouped.keys()].sort(byName)) {
    folders[path] = grouped.get(path)
      .sort((a, b) => byName(a.title || a.url, b.title || b.url))
      .map(yamlItem);
  }

  const doc = {
    version: 2,
    exported_at: new Date().toISOString(),
    count: bookmarks.length,
    folders,
  };
  if (unfiled.length) {
    doc.unfiled = unfiled
      .sort((a, b) => byName(a.title || a.url, b.title || b.url))
      .map(yamlItem);
  }

  const header = [
    'Bookmarks export',
    user ? `user: ${user}` : '',
    '',
    'Entries are grouped by folder, and the key is the whole path.',
    '',
    'Editing by hand:',
    '  * rename a key      -> renames that folder for everything under it',
    '  * move an entry     -> cut it under another key, or give it a folder: line',
    '  * new folder        -> a key that does not exist yet is created on import',
    '  * delete the id     -> the entry comes in as a new bookmark',
    '',
    'Importing an edited file: choose "Use the file". The other modes keep what',
    'is already here when the dates match, and your edits would be skipped.',
    '',
    'Files exported by older versions (a flat bookmarks: list) still import.',
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

// Netscape Bookmark File: a format from 1990 that every browser still speaks.
// The folder hierarchy becomes nested <DL>; tags fit in the TAGS attribute
// (a Firefox convention) and the category becomes a top-level folder.
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

  // Sort by the key, not by the pair: the default sort stringifies the whole
  // element, and rows coming from node:sqlite have a null prototype, so they do
  // not survive String().
  const folders = [...tree.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  for (const [folder, items] of folders) {
    if (!folder) {
      for (const b of items) lines.push(...entry(b, 1));
      continue;
    }
    // Every folder level becomes a <DL>: that is how the browser shows the tree.
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

// The raw dump: every column as it is stored, for scripts. Unlike the YAML it
// does not reshape anything, which is the point of having it.
function toJson(bookmarks) {
  return JSON.stringify({ version: 2, count: bookmarks.length, bookmarks }, null, 2);
}

/* ======================= import: read ======================= */

function decodeHtml(s) {
  return String(s ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');   // last, otherwise &amp;lt; would turn into <
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

// `folder` comes from the key the entry was found under. An explicit folder:
// on the entry still wins, so moving one bookmark can be a single added line
// instead of cutting and pasting the block.
function normalizeIncoming(raw, folderFromKey = '') {
  return {
    id: String(raw.id ?? '').trim().slice(0, 64),
    title: String(raw.title ?? '').trim().slice(0, 500),
    url: String(raw.url ?? '').trim().slice(0, 2000),
    folder: String(raw.folder ?? folderFromKey ?? '').trim().replace(/^\/+|\/+$/g, '').slice(0, 300),
    category: String(raw.category ?? '').replace(/^@/, '').trim().toLowerCase().slice(0, 200),
    tags: normTagList(raw.tags),
    // `notes` is the field's old name: older files still import.
    description: String(raw.description ?? raw.notes ?? '').trim().slice(0, 5000),
    created_at: Number(raw.created_at) > 0 ? Number(raw.created_at) : null,
    updated_at: Number(raw.updated_at) > 0 ? Number(raw.updated_at) : null,
    // Usage comes back with the file. The server merges counters with MAX, so
    // an old export can restore a count but never shrink one.
    opens: Number(raw.opens) > 0 ? Math.floor(Number(raw.opens)) : 0,
    last_open_at: Number(raw.last_open_at) > 0 ? Math.floor(Number(raw.last_open_at)) : 0,
  };
}

// Reads both shapes: the current one, grouped by folder, and the flat
// `bookmarks:` list that earlier versions wrote. A file edited by hand tends to
// be a mix of the two, so neither is treated as the only right answer.
function parseYamlExport(text) {
  const doc = yaml.parse(text);
  if (doc === null) return [];

  const out = [];
  const takeList = (list, folder) => {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (item && typeof item === 'object' && !Array.isArray(item)) out.push(normalizeIncoming(item, folder));
    }
  };
  // A map of path -> entries. `unfiled` (or the empty key, or `/`) is the root.
  const takeMap = (map) => {
    if (!map || typeof map !== 'object' || Array.isArray(map)) return;
    for (const [path, list] of Object.entries(map)) {
      takeList(list, path === '/' ? '' : path);
    }
  };

  if (Array.isArray(doc)) {
    takeList(doc, '');
  } else {
    takeMap(doc.folders);
    takeList(doc.unfiled, '');
    // `bookmarks:` was the flat list, but a hand-written file may well use the
    // same key for the grouped shape.
    if (Array.isArray(doc.bookmarks)) takeList(doc.bookmarks, '');
    else takeMap(doc.bookmarks);
  }

  if (!out.length && !hasAnyList(doc)) {
    throw new Error('YAML without a "folders" map or a "bookmarks" list, check the file');
  }
  return out;
}

// An empty vault is a valid file; a file with none of the expected keys is not.
function hasAnyList(doc) {
  if (Array.isArray(doc)) return true;
  if (!doc || typeof doc !== 'object') return false;
  return ['folders', 'unfiled', 'bookmarks'].some((k) => k in doc);
}

// Reads the browser HTML without an HTML parser: the format is rigid enough
// (one line per <DT>) and a regex here is more predictable than half a parser.
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
      // Bookmarklets and separators are not bookmarks.
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

    // <DD> carries the description of the previous bookmark.
    const dd = /<DD>(.*)$/i.exec(line);
    if (dd && last) last.description = decodeHtml(dd[1]).trim().slice(0, 5000);
  }

  return out;
}

function parseJsonExport(text) {
  const doc = JSON.parse(text);
  const list = Array.isArray(doc) ? doc : doc.bookmarks;
  if (!Array.isArray(list)) throw new Error('JSON without a "bookmarks" list');
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
  if (!parser) throw new Error(`unknown format: ${chosen}`);

  const items = parser(text);
  // With neither url nor title there is nothing to do with the entry.
  return { format: chosen, items: items.filter((b) => b.url || b.title) };
}

/* ======================= import: plan ======================= */

/**
 * Decides what happens to each entry of the file, without writing anything.
 *
 * Modes:
 *   add      only creates what is missing. Never touches what is already there.
 *   update   creates the new ones and overwrites the existing ones with the file.
 *   newest   the larger updated_at wins (merging two vaults).
 *   replace  the file becomes the truth: whatever is not in it is removed.
 */
function planImport(existing, incoming, mode = 'add') {
  if (!MODES.includes(mode)) throw new Error(`invalid mode: ${mode}`);

  const byId = new Map();
  const byUrl = new Map();
  for (const b of existing) {
    byId.set(b.id, b);
    const key = urlKey(b.url);
    // The first one wins the index: a local duplicate does not steal the other's match.
    if (key && !byUrl.has(key)) byUrl.set(key, b);
  }

  const plan = { create: [], update: [], same: [], skip: [], remove: [] };
  const matched = new Set();

  for (const item of incoming) {
    const current = (item.id && byId.get(item.id)) || byUrl.get(urlKey(item.url)) || null;

    if (!current) {
      plan.create.push({ incoming: item });
      continue;
    }
    matched.add(current.id);

    // Keeps the vault's id: the one in the file may come from another install.
    const merged = { ...item, id: current.id, created_at: current.created_at };

    if (sameContent(current, item)) {
      plan.same.push({ current, incoming: item });
      continue;
    }

    if (mode === 'add') {
      plan.skip.push({ current, incoming: item, reason: 'already exists' });
    } else if (mode === 'newest' && Number(item.updated_at) <= Number(current.updated_at)) {
      plan.skip.push({ current, incoming: item, reason: 'the vault version is newer' });
    } else {
      plan.update.push({ current, incoming: merged });
    }
  }

  if (mode === 'replace') {
    for (const b of existing) {
      if (!matched.has(b.id)) plan.remove.push({ current: b });
    }
  }

  plan.summary = {
    mode,
    read: incoming.length,
    create: plan.create.length,
    update: plan.update.length,
    same: plan.same.length,
    skip: plan.skip.length,
    remove: plan.remove.length,
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
