// Where a link probably belongs, from where the links like it already are.
// No model and no network: the same site counts most, then words the title
// shares with the titles in a folder, then words of the folder's own name.
// Pure, so it runs in node too (tests/frontend.test.mjs).

const STOP = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'what', 'how', 'your', 'you', 'are', 'was', 'not',
  'all', 'can', 'new', 'one', 'out', 'use', 'via', 'about', 'into', 'more', 'www', 'com', 'org', 'net', 'html',
  'http', 'https', 'index', 'page', 'home', 'para', 'uma', 'como', 'que', 'dos', 'das', 'por', 'sem',
]);

export function words(text) {
  return String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w));
}

export function siteOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

// The words a link brings: its title, and the readable parts of its address.
function linkWords(link) {
  let path = '';
  try { path = new URL(link.url).pathname.replace(/[-_/.]+/g, ' '); } catch { /* not a url */ }
  return new Set(words(`${link.title || ''} ${path}`));
}

const SITE = 3;
const NAME = 4;

/**
 * Up to `limit` folders for `link`, best first. `links` is the vault; a
 * folder in `exclude`, or under one, is never suggested (the one being
 * sorted, typically).
 */
export function suggestFolders(link, links, { exclude = [], limit = 3 } = {}) {
  const banned = (f) => !f || exclude.some((x) => f === x || f.startsWith(`${x}/`));
  const site = siteOf(link.url);
  const mine = linkWords(link);
  const score = new Map();
  const bump = (f, n) => score.set(f, (score.get(f) || 0) + n);

  const folders = new Set();
  for (const b of links) {
    const f = b.folder || '';
    if (b.id === link.id || banned(f)) continue;
    folders.add(f);
    let s = 0;
    if (site && siteOf(b.url) === site) s += SITE;
    for (const w of new Set(words(b.title))) if (mine.has(w)) s += 1;
    if (s) bump(f, s);
  }
  for (const f of folders) {
    for (const w of new Set(words(f.replace(/\//g, ' ')))) if (mine.has(w)) bump(f, NAME);
  }

  return [...score.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([folder]) => folder);
}
