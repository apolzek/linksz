// The searches typed on this device, newest first, for the history button on
// the links page. Kept in the browser and nowhere else: what someone looked
// for is theirs, and the server has no need of it.

const KEY = 'bookmarks_search_history';
export const MAX = 50;
// Typing "doc", pausing, then "docker" is one search, not two.
const REFINE_MS = 30_000;

// The list with `query` recorded at `at`. Pure, so the rules can be tested
// without a browser: blanks are skipped, a repeat moves to the top, and a
// query that refines the newest one shortly after replaces it.
export function record(list, query, at) {
  const q = String(query || '').trim();
  if (q.length < 2) return list;
  const rest = list.filter((e) => e.q !== q);
  const top = rest[0];
  if (top && at - top.at < REFINE_MS && (q.startsWith(top.q) || top.q.startsWith(q))) rest.shift();
  return [{ q, at }, ...rest].slice(0, MAX);
}

export function load() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(list) ? list.filter((e) => e && typeof e.q === 'string' && Number.isFinite(e.at)) : [];
  } catch { return []; }
}

export function save(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* this tab only */ }
}

export function add(query, at = Date.now()) {
  const list = load();
  const next = record(list, query, at);
  if (next !== list) save(next);
  return next;
}

export function clear() {
  save([]);
}
