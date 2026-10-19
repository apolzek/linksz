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

// Where the file came from, which the caller declares instead of the parser
// guessing. The two are different jobs: one restores a vault, the other brings
// in a tree from a browser that never had categories to begin with.
const SOURCES = ['native', 'browser'];

// Fields a browser file has no way to express. Silence there means "I do not
// know", never "empty", so an import from one must not take these away from a
// bookmark that already has them. Without this, importing Chrome over a vault
// with "Use the file" strips the categories off everything the two have in
// common, quietly, and the file cannot put them back.
const BROWSER_PARTIAL_FIELDS = ['category', 'tags', 'description'];

// Thrown when the file belongs to the other flow. Separate from a parse error
// because the file is not broken, it is only in the wrong queue, and telling
// someone their export is corrupt would send them hunting for nothing.
class WrongSourceError extends Error {}

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

// Sorting is not cosmetic here: with folders and entries in a fixed order, two
// exports of the same vault are the same file, and a diff shows what changed
// instead of what moved.
function byName(a, b) {
  return String(a).localeCompare(String(b), 'en', { sensitivity: 'base' });
}

// Title, then url, then id: a total order. Two bookmarks sharing a title (the
// same page saved from two mirrors, say) would otherwise land in whatever order
// the database happened to return, and the file would differ for no reason.
function byEntry(a, b) {
  return byName(a.title || a.url, b.title || b.url)
      || byName(a.url, b.url)
      || byName(a.id, b.id);
}

// Which folders have to be written down as a key with no entries under it.
//
// A folder holding bookmarks writes itself, and so does every folder above it:
// reading `dev/go/web` back recreates `dev` and `dev/go` on the way. So only
// the tips of what is left need a key of their own, and `dev: []` next to a
// `dev/go` full of links would be noise that says nothing new.
//
// The key is a plain entry in the `folders:` map that has been there since
// version 2 of the format, holding an empty list. That is what lets an older
// importer, which knows nothing about this, walk past it in silence instead of
// failing on a key it does not recognise.
function emptyFolderKeys(known, used) {
  const covered = new Set();
  const cover = (path) => {
    const parts = String(path).split('/').filter(Boolean);
    for (let i = 1; i <= parts.length; i++) covered.add(parts.slice(0, i).join('/'));
  };
  for (const path of used) cover(path);

  const out = [];
  // Deepest first, so a folder that covers its own parents gets there before
  // the parents are considered on their own.
  const byDepth = [...new Set(known)].filter(Boolean)
    .sort((a, b) => b.split('/').length - a.split('/').length || byName(a, b));
  for (const path of byDepth) {
    if (covered.has(path)) continue;
    out.push(path);
    cover(path);
  }
  return out;
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
function toYaml(bookmarks, { user = '', folders: known = [] } = {}) {
  const grouped = new Map();
  const unfiled = [];
  for (const b of bookmarks) {
    const folder = String(b.folder || '').trim();
    if (!folder) { unfiled.push(b); continue; }
    if (!grouped.has(folder)) grouped.set(folder, []);
    grouped.get(folder).push(b);
  }

  for (const path of emptyFolderKeys(known, grouped.keys())) grouped.set(path, []);

  const folders = {};
  for (const path of [...grouped.keys()].sort(byName)) {
    folders[path] = grouped.get(path).sort(byEntry).map(yamlItem);
  }

  const doc = {
    version: 2,
    exported_at: new Date().toISOString(),
    count: bookmarks.length,
    folders,
  };
  if (unfiled.length) {
    doc.unfiled = unfiled.sort(byEntry).map(yamlItem);
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
    '  * empty folder      -> a key with [] keeps a folder that holds nothing',
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
// does not reshape anything, which is the point of having it. `folders` is
// every folder written down, empty ones included, so the tree survives the
// trip; an importer that predates the key walks past it.
function toJson(bookmarks, { folders = [] } = {}) {
  return JSON.stringify({ version: 2, count: bookmarks.length, bookmarks, folders: [...folders].sort() }, null, 2);
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
  return readYamlDoc(text).items;
}

// The same read, keeping the folder keys as well as the entries. A key with an
// empty list is a folder that owns nothing, and it is the only thing in the
// file that says so: dropping it here would lose the folder on every import.
function readYamlDoc(text) {
  const doc = yaml.parse(text);
  if (doc === null) return { items: [], folders: [] };

  const out = [];
  const seen = [];
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
      const folder = path === '/' ? '' : normFolder(path);
      if (folder) seen.push(folder);
      takeList(list, folder);
    }
  };

  if (Array.isArray(doc)) {
    takeList(doc, '');
  } else {
    // `folders` written as a list is a hand-editing mistake with an obvious
    // fix; reading it as zero bookmarks and saying nothing is the worst answer.
    if (Array.isArray(doc.folders)) {
      throw new Error('"folders" must be a map of path -> entries, not a list');
    }
    takeMap(doc.folders);
    takeList(doc.unfiled, '');
    // `bookmarks:` was the flat list, but a hand-written file may well use the
    // same key for the grouped shape.
    if (Array.isArray(doc.bookmarks)) takeList(doc.bookmarks, '');
    else takeMap(doc.bookmarks);
  }

  // A file that carries nothing but empty folders is still a file that says
  // something, so the folders count as content here.
  if (!out.length && !seen.length && !hasAnyList(doc)) {
    throw new Error('YAML without a "folders" map or a "bookmarks" list, check the file');
  }
  return { items: out, folders: [...new Set(seen)] };
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
    const h3 = /<DT>\s*<H3([^>]*)>(.*?)<\/H3>/i.exec(line);
    if (h3) {
      // The bookmarks bar is a place in the browser's window, not a folder
      // anyone filed anything into, so it contributes no level here and its
      // children land where the user put them. Every browser marks it.
      const isToolbar = /PERSONAL_TOOLBAR_FOLDER\s*=\s*"true"/i.test(h3[1]);
      stack.push(isToolbar ? '' : decodeHtml(h3[2]).trim());
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
        folder: stack.filter(Boolean).join('/'),
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

// Chrome, Chromium, Edge and Brave keep their bookmarks as JSON in the profile
// directory (~/.config/google-chrome/Default/Bookmarks on Linux). It is not the
// HTML those browsers export, and it is the file people actually find first, so
// it is read here too.
//
// Timestamps are WebKit epoch: microseconds since 1601-01-01, which is
// 11644473600 seconds before the Unix one.
const WEBKIT_EPOCH_OFFSET_MS = 11644473600000;

function webkitTime(v) {
  const micro = Number(v);
  if (!Number.isFinite(micro) || micro <= 0) return null;
  const ms = Math.round(micro / 1000) - WEBKIT_EPOCH_OFFSET_MS;
  return ms > 0 ? ms : null;
}

/**
 * Reads the browser's own profile file.
 *
 * The folder tree follows what the same browser writes when it exports HTML, so
 * the two ways in land in the same shape: the bookmarks bar becomes a folder of
 * its own name, and "Other bookmarks" is flattened to the root, because that is
 * where the browser itself puts it.
 */
function parseChromeJson(text) {
  const doc = JSON.parse(text);
  const roots = doc && doc.roots;
  if (!roots || typeof roots !== 'object') throw new Error('JSON without a "roots" map');

  const out = [];
  const walk = (node, path) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'url') {
      if (!node.url || /^(javascript|place|chrome):/i.test(node.url)) return;
      out.push(normalizeIncoming({
        title: node.name,
        url: node.url,
        folder: path.join('/'),
        created_at: webkitTime(node.date_added),
        updated_at: webkitTime(node.date_modified) || webkitTime(node.date_added),
      }));
      return;
    }
    for (const child of node.children || []) walk(child, path);
  };

  for (const root of Object.values(roots)) {
    if (!root || typeof root !== 'object' || !Array.isArray(root.children)) continue;
    // The roots are where the browser keeps things, not folders anyone made:
    // "Bookmarks bar" and "Other bookmarks" are the window, not the filing. So
    // what sits inside them comes in at the top, which is where their owner put
    // it. To gather an import under one folder, use the prefix instead.
    const base = [];
    for (const child of root.children) {
      if (child && child.type === 'folder') {
        walkFolder(child, base, out);
      } else {
        walk(child, base);
      }
    }
  }
  return out;

  function walkFolder(node, path, sink) {
    const here = [...path, String(node.name || '').trim()].filter(Boolean);
    for (const child of node.children || []) {
      if (child && child.type === 'folder') walkFolder(child, here, sink);
      else walk(child, here);
    }
  }
}

function parseJsonExport(text) {
  return readJsonDoc(text).items;
}

function readJsonDoc(text) {
  const doc = JSON.parse(text);
  const list = Array.isArray(doc) ? doc : doc.bookmarks;
  if (!Array.isArray(list)) throw new Error('JSON without a "bookmarks" list');
  const folders = Array.isArray(doc.folders)
    ? [...new Set(doc.folders.filter((f) => typeof f === 'string').map(normFolder).filter(Boolean))]
    : [];
  // Not .map(normalizeIncoming): map's second argument is the index, and it
  // would land in the folder parameter, filing every entry under "0", "1"...
  return { items: list.filter((i) => i && typeof i === 'object').map((i) => normalizeIncoming(i)), folders };
}

function detectFormat(text) {
  const head = String(text).slice(0, 2000).trim();
  if (/^<!DOCTYPE NETSCAPE-Bookmark/i.test(head) || /<DT>\s*<A\s/i.test(head)) return 'html';
  // The browser's own profile file, before the generic JSON check: it is JSON
  // too, but with a shape of its own and no "bookmarks" list to match on.
  //
  // Whatever opens with a brace is read as JSON and told apart by its keys, not
  // by where they fall in the first lines: a JSON that slipped through to the
  // YAML reader would be read as one enormous broken document.
  if (head.startsWith('[')) return 'json';
  if (head.startsWith('{')) {
    let doc = null;
    try { doc = JSON.parse(text); } catch { return 'json'; }
    return doc && typeof doc === 'object' && 'roots' in doc ? 'chrome' : 'json';
  }
  return 'yaml';
}

function parseImport(text, format = 'auto') {
  const chosen = format === 'auto' ? detectFormat(text) : format;
  const parsers = {
    yaml: parseYamlExport,
    html: parseNetscapeHtml,
    json: parseJsonExport,
    chrome: parseChromeJson,
  };
  const parser = parsers[chosen];
  if (!parser) throw new Error(`unknown format: ${chosen}`);

  // Only the YAML and this app's JSON have a way to name a folder that holds
  // nothing. For the browser formats the list comes back empty, which is not
  // the same as "no folders": their entries still carry folders, they just
  // cannot mention an empty one.
  const { items, folders } = chosen === 'yaml' ? readYamlDoc(text)
    : chosen === 'json' ? readJsonDoc(text)
    : { items: parser(text), folders: [] };
  // With neither url nor title there is nothing to do with the entry.
  return { format: chosen, items: items.filter((b) => b.url || b.title), folders };
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
/* ======================= import: sources ======================= */

// A folder path as the vault stores it: no leading or trailing slash, no empty
// segments, bounded like the column is.
function normFolder(path) {
  return String(path ?? '')
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)
    .join('/')
    .slice(0, 300);
}

// A browser file knows a folder tree and nothing else. Category does not exist
// in the format, so it is emptied rather than left to whatever happened to be
// on the object, and the whole tree can be dropped under a folder of the
// vault's own so an import does not scatter itself across the root.
function browserEntry(item, prefix) {
  return {
    ...item,
    folder: normFolder(prefix ? `${prefix}/${item.folder || ''}` : item.folder),
    category: '',
  };
}

// What the file turned out to carry, counted before anything is decided.
// "348 bookmarks in 12 folders, no categories" is the honest answer to "what am
// I about to import", and it is the answer people need before, not after.
function fileStats(items, declared = []) {
  const folders = new Set(declared);
  let unfiled = 0;
  let tagged = 0;
  let described = 0;
  for (const b of items) {
    if (b.folder) folders.add(b.folder); else unfiled += 1;
    if (b.tags) tagged += 1;
    if (b.description) described += 1;
  }
  return { count: items.length, folders: folders.size, unfiled, tagged, described };
}

/**
 * Reads a file for one declared source, refusing the other one's format.
 *
 * Being wrong here is expensive. A browser file read as a vault file looks like
 * a vault that lost every category, and importing that with "use the file"
 * would erase them for real. So a mismatch is an error pointing at the other
 * flow, never a best-effort guess.
 */
function readImport(text, { source = 'native', folderPrefix = '' } = {}) {
  if (!SOURCES.includes(source)) throw new Error(`invalid source: ${source}`);

  const detected = detectFormat(text);
  // Two files count as coming from a browser: the HTML it exports, and the
  // profile file it keeps for itself.
  const fromBrowser = detected === 'html' || detected === 'chrome';
  if (source === 'browser' && !fromBrowser) {
    throw new WrongSourceError('this is not a browser file: the vault\'s own YAML and JSON come in through "From this app"');
  }
  if (source === 'native' && fromBrowser) {
    throw new WrongSourceError('this file belongs to a browser: bring it in through "From a browser"');
  }

  const { format, items, folders } = parseImport(text, detected);
  const prefix = source === 'browser' ? normFolder(folderPrefix) : '';
  const out = source === 'browser' ? items.map((b) => browserEntry(b, prefix)) : items;
  // The prefix is not applied to `folders`, and does not need to be: only the
  // YAML names a folder that holds nothing, and a YAML never arrives through
  // the browser flow, which is the only flow that has a prefix.
  return { source, format, prefix, items: out, folders, stats: fileStats(out, folders) };
}

/* ======================= import: plan ======================= */

function planImport(existing, incoming, mode = 'add', { partialFields = [], buried = [] } = {}) {
  if (!MODES.includes(mode)) throw new Error(`invalid mode: ${mode}`);

  const byId = new Map();
  const byUrl = new Map();
  for (const b of existing) {
    byId.set(b.id, b);
    const key = urlKey(b.url);
    // The first one wins the index: a local duplicate does not steal the other's match.
    if (key && !byUrl.has(key)) byUrl.set(key, b);
  }
  // Ids the vault has as tombstones. They are not in `existing`, so without
  // this they would fall through to the URL, and the same URL in two folders is
  // two records on purpose: restoring a deleted bookmark would land on top of
  // the surviving one and take it over instead of coming back as itself.
  const buriedIds = new Set(buried);

  const plan = { create: [], update: [], same: [], skip: [], remove: [] };
  const matched = new Set();

  for (const item of incoming) {
    // An id the vault recognises is the answer, buried or not. The URL is only
    // the fallback for an entry carrying no id, or an id from another install.
    const current = (item.id && byId.get(item.id))
      || (buriedIds.has(item.id) ? null : byUrl.get(urlKey(item.url)))
      || null;

    if (!current) {
      plan.create.push({ incoming: item });
      continue;
    }
    matched.add(current.id);

    // What the file is silent about, the vault keeps. `partialFields` names the
    // fields this kind of file cannot carry, so an empty one is not an answer.
    const filled = { ...item };
    for (const field of partialFields) {
      if (!filled[field]) filled[field] = current[field];
    }
    // Keeps the vault's id: the one in the file may come from another install.
    const merged = { ...filled, id: current.id, created_at: current.created_at };

    // Compared after the merge, so a file that only went quiet about a field
    // counts as identical instead of as an update that changes nothing.
    if (sameContent(current, merged)) {
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
  SOURCES,
  BROWSER_PARTIAL_FIELDS,
  WrongSourceError,
  normFolder,
  browserEntry,
  fileStats,
  readImport,
  urlKey,
  toYaml,
  toNetscapeHtml,
  toJson,
  parseImport,
  parseYamlExport,
  readYamlDoc,
  parseNetscapeHtml,
  parseChromeJson,
  detectFormat,
  planImport,
  normalizeIncoming,
};
