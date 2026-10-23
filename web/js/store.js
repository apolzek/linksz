// The vault, in memory, and how it stays in step with the server.
//
// Three things make it fast, and each one is a decision:
//
//   * The whole vault lives here and search runs over it locally, so a
//     keystroke never waits on the network.
//   * It is cached in IndexedDB per vault. A reload paints from the cache at
//     once and asks the server only for what changed since (`/api/sync`), so a
//     vault of thousands opens as fast as an empty one.
//   * Writes are optimistic. The change lands here first and the screen
//     repaints in the same frame; the request goes out behind it, and a failure
//     puts the old value back and says so.
//
// A bookmark object is never mutated: every change replaces it. The search
// keeps its normalized text per object, so a new object is what tells it the
// old text is stale.

import { api } from './http.js';

const state = {
  vault: 0,
  items: new Map(),     // id -> live bookmark
  folders: new Set(),   // folders written down on the server (they may be empty)
  lastSync: 0,          // server clock of the last pull
  version: 0,           // bumped on every change; caches key off it
};

/* ---------------- change notification ---------------- */

const listeners = new Set();
let notifyQueued = false;

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Batched in a microtask: a bulk move touching 900 rows repaints once, and still
// before the browser paints the next frame.
function changed() {
  state.version += 1;
  schedulePersist();
  if (notifyQueued) return;
  notifyQueued = true;
  queueMicrotask(() => {
    notifyQueued = false;
    for (const fn of listeners) fn();
  });
}

/* ---------------- sync status ---------------- */

const statusListeners = new Set();
let status = 'idle';

export function onStatus(fn) {
  statusListeners.add(fn);
  fn(status);
  return () => statusListeners.delete(fn);
}

function setStatus(next) {
  if (next === status) return;
  status = next;
  for (const fn of statusListeners) fn(status);
}

/* ---------------- reading ---------------- */

let liveCache = null;
let liveVersion = -1;

export function all() {
  if (liveVersion !== state.version) {
    liveCache = [...state.items.values()];
    liveVersion = state.version;
  }
  return liveCache;
}

export function get(id) {
  return state.items.get(id) || null;
}

export function count() {
  return state.items.size;
}

export function version() {
  return state.version;
}

function parentOf(path) {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

export function nameOf(path) {
  return path ? path.slice(path.lastIndexOf('/') + 1) : '';
}

export { parentOf };

// The folder tree, which is the union of two things: the folders written down
// on purpose and the ones the bookmarks imply. Computed once per change, not
// once per paint, because the sidebar, the pickers and both panes of the
// organizer all read it.
let treeCache = null;
let treeVersion = -1;

export function tree() {
  if (treeVersion === state.version) return treeCache;

  const direct = new Map();
  const paths = new Set(state.folders);
  for (const b of state.items.values()) {
    const f = b.folder || '';
    direct.set(f, (direct.get(f) || 0) + 1);
    if (f) paths.add(f);
  }
  for (const p of [...paths]) {
    let a = parentOf(p);
    while (a && !paths.has(a)) {
      paths.add(a);
      a = parentOf(a);
    }
  }

  const total = new Map();
  const children = new Map([['', []]]);
  for (const p of paths) {
    total.set(p, total.get(p) || 0);
    children.set(p, children.get(p) || []);
  }
  for (const p of paths) {
    const parent = parentOf(p);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(p);
  }
  for (const [path, n] of direct) {
    let p = path;
    while (p) {
      total.set(p, (total.get(p) || 0) + n);
      p = parentOf(p);
    }
  }
  const byName = (a, b) => nameOf(a).localeCompare(nameOf(b), undefined, { sensitivity: 'base', numeric: true });
  for (const list of children.values()) list.sort(byName);

  treeCache = {
    paths: [...paths].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true })),
    has: (p) => p === '' || paths.has(p),
    direct: (p) => direct.get(p) || 0,
    total: (p) => (p === '' ? state.items.size : total.get(p) || 0),
    children: (p) => children.get(p) || [],
  };
  treeVersion = state.version;
  return treeCache;
}

export function inFolder(path) {
  const out = [];
  for (const b of state.items.values()) if ((b.folder || '') === path) out.push(b);
  return out;
}

/* ---------------- normalizing, as the server does ---------------- */
// The server is the authority and its answer replaces these, but showing
// `#Go, k8s` as typed until the answer arrives would be a visible flicker.

export function normFolder(v) {
  return String(v == null ? '' : v).split('/').map((p) => p.trim()).filter(Boolean).join('/');
}

function normTags(v) {
  const parts = Array.isArray(v) ? v : String(v == null ? '' : v).split(/[,\s]+/);
  const seen = [];
  for (let t of parts) {
    t = String(t).replace(/^#/, '').trim().toLowerCase();
    if (t && !seen.includes(t)) seen.push(t);
  }
  return seen.join(',');
}

function normCategory(v) {
  return String(v == null ? '' : v).replace(/^@/, '').trim().toLowerCase();
}

function clean(fields) {
  const out = {};
  if ('title' in fields) out.title = String(fields.title || '').trim();
  if ('url' in fields) out.url = String(fields.url || '').trim();
  if ('folder' in fields) out.folder = normFolder(fields.folder);
  if ('category' in fields) out.category = normCategory(fields.category);
  if ('tags' in fields) out.tags = normTags(fields.tags);
  if ('description' in fields) out.description = String(fields.description || '').trim();
  if ('pinned' in fields) out.pinned = Math.max(0, Math.floor(Number(fields.pinned) || 0));
  return out;
}

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/* ---------------- writing ---------------- */

// While a write is in flight, a pull could carry the row as it was before the
// write and paint the old value over the new one for a moment. So pulls wait
// for writes, and a pull that was already out when a write started is thrown
// away (the epoch moved); the pull after the write brings the real answer.
let inflight = 0;
let epoch = 0;

function put(item) {
  if (!item || !item.id) return;
  if (item.deleted) state.items.delete(item.id);
  else state.items.set(item.id, item);
}

async function write(run, rollback) {
  inflight += 1;
  epoch += 1;
  setStatus('saving');
  try {
    const out = await run();
    broadcast();
    return out;
  } catch (err) {
    if (rollback) {
      rollback();
      changed();
    }
    throw err;
  } finally {
    inflight -= 1;
    if (!inflight) {
      setStatus('synced');
      pullSoon();
    }
  }
}

export async function create(fields) {
  const ts = Date.now();
  const b = {
    id: uuid(), title: '', url: '', folder: '', category: '', tags: '', description: '',
    ...clean(fields), created_at: ts, updated_at: ts, deleted: 0, opens: 0, last_open_at: 0,
  };
  state.items.set(b.id, b);
  changed();
  return write(async () => {
    const r = await api('/api/bookmarks', { method: 'POST', body: { ...b, updated_at: undefined } });
    put(r.item);
    changed();
    return r.item;
  }, () => state.items.delete(b.id));
}

export async function update(id, fields) {
  const prev = state.items.get(id);
  if (!prev) return null;
  const patch = clean(fields);
  state.items.set(id, { ...prev, ...patch, updated_at: Date.now() });
  changed();
  return write(async () => {
    const r = await api(`/api/bookmarks/${encodeURIComponent(id)}`, { method: 'PUT', body: patch });
    put(r.item);
    changed();
    return r.item;
  }, () => state.items.set(id, prev));
}

// Gives back what was removed, which is what an undo needs.
export async function removeMany(ids) {
  const gone = ids.map((id) => state.items.get(id)).filter(Boolean);
  if (!gone.length) return [];
  for (const b of gone) state.items.delete(b.id);
  changed();
  await write(
    () => (gone.length === 1
      ? api(`/api/bookmarks/${encodeURIComponent(gone[0].id)}`, { method: 'DELETE' })
      : api('/api/bookmarks/delete', { method: 'POST', body: { ids: gone.map((b) => b.id) } })),
    () => { for (const b of gone) state.items.set(b.id, b); },
  );
  return gone;
}

// Brings deleted bookmarks back, with their ids. A plain POST revives a
// tombstone on the server, and the server stamps it newer than the deletion.
export async function restore(items) {
  for (const b of items) state.items.set(b.id, b);
  changed();
  await write(async () => {
    for (let i = 0; i < items.length; i += 8) {
      const chunk = items.slice(i, i + 8);
      const answers = await Promise.all(chunk.map((b) =>
        api('/api/bookmarks', { method: 'POST', body: { ...b, updated_at: undefined } })));
      for (const r of answers) put(r.item);
    }
    changed();
  }, () => { for (const b of items) state.items.delete(b.id); });
}

// Files bookmarks under a folder. Returns where each one was, so the move can
// be undone folder by folder.
export async function moveMany(ids, folder) {
  const to = normFolder(folder);
  const before = new Map();
  for (const id of ids) {
    const b = state.items.get(id);
    if (!b || (b.folder || '') === to) continue;
    before.set(id, b);
    state.items.set(id, { ...b, folder: to, updated_at: Date.now() });
  }
  if (!before.size) return before;
  changed();
  await write(
    () => api('/api/bookmarks/move', { method: 'POST', body: { ids: [...before.keys()], folder: to } }),
    () => { for (const [id, b] of before) state.items.set(id, b); },
  );
  return before;
}

// Puts each bookmark back in the folder it came from.
export async function unmove(before) {
  const groups = new Map();
  for (const [id, b] of before) {
    const f = b.folder || '';
    if (!groups.has(f)) groups.set(f, []);
    groups.get(f).push(id);
  }
  for (const [folder, ids] of groups) await moveMany(ids, folder);
}

/* ---------------- favourites ---------------- */

// The pinned links, in their order. `pinned` is a position, 1 first; gaps
// left by an unpin are fine, only the order counts.
export function pins() {
  return [...state.items.values()].filter((b) => b.pinned > 0)
    .sort((a, b) => a.pinned - b.pinned || a.created_at - b.created_at);
}

export function togglePin(id) {
  const b = state.items.get(id);
  if (!b) return null;
  if (b.pinned > 0) return update(id, { pinned: 0 });
  const last = pins().reduce((m, p) => Math.max(m, p.pinned), 0);
  return update(id, { pinned: last + 1 });
}

// Pins in the order given, numbered from 1. Only the ones whose place moved
// are written.
export async function orderPins(ids) {
  const writes = [];
  ids.forEach((id, i) => {
    const b = state.items.get(id);
    if (b && b.pinned !== i + 1) writes.push(update(id, { pinned: i + 1 }));
  });
  await Promise.all(writes);
}

const OPEN_DEBOUNCE = 3000;
const lastOpen = new Map();

// The count goes up here first so the ranking reacts at once; the server call
// is fire and forget, because a link that opened must not wait on a statistic.
export function registerOpen(id) {
  const b = state.items.get(id);
  if (!b) return;
  const now = Date.now();
  if (now - (lastOpen.get(id) || 0) < OPEN_DEBOUNCE) return;
  lastOpen.set(id, now);
  state.items.set(id, { ...b, opens: (Number(b.opens) || 0) + 1, last_open_at: now });
  changed();
  api('/api/bookmarks/open', { method: 'POST', body: { id } })
    .then((r) => { if (r.item && state.items.has(id)) { put(r.item); changed(); } })
    .catch(() => {});
}

/* ---------------- folders ---------------- */

function snapshotBranch(from) {
  const items = [];
  for (const b of state.items.values()) {
    const f = b.folder || '';
    if (f === from || f.startsWith(from + '/')) items.push(b);
  }
  return { items, folders: new Set(state.folders) };
}

function restoreBranch(snap) {
  for (const b of snap.items) state.items.set(b.id, b);
  state.folders = snap.folders;
}

// A folder is a path on every bookmark inside it, so moving or renaming one is
// a prefix rewrite, here exactly as on the server.
function rewrite(from, to) {
  const ts = Date.now();
  for (const b of state.items.values()) {
    const f = b.folder || '';
    if (f === from || f.startsWith(from + '/')) {
      state.items.set(b.id, { ...b, folder: to + f.slice(from.length), updated_at: ts });
    }
  }
  for (const p of [...state.folders]) {
    if (p === from || p.startsWith(from + '/')) {
      state.folders.delete(p);
      state.folders.add(to + p.slice(from.length));
    }
  }
}

export async function createFolder(path) {
  const p = normFolder(path);
  if (!p) throw new Error('a folder needs a name');
  if (tree().has(p)) throw new Error(`/${p} already exists`);
  const before = new Set(state.folders);
  let a = p;
  while (a) { state.folders.add(a); a = parentOf(a); }
  changed();
  await write(() => api('/api/folders', { method: 'POST', body: { path: p } }), () => { state.folders = before; });
  return p;
}

export async function renameFolder(path, name) {
  const clean = String(name || '').trim();
  if (!clean) throw new Error('a folder needs a name');
  if (clean.includes('/')) throw new Error('a name cannot contain "/"');
  const parent = parentOf(path);
  const target = parent ? `${parent}/${clean}` : clean;
  if (target === path) return path;
  if (tree().has(target)) throw new Error(`/${target} already exists`);
  const snap = snapshotBranch(path);
  rewrite(path, target);
  changed();
  // The rewritten bookmarks keep their ids, so putting the snapshot back
  // overwrites them; nothing else needs undoing.
  await write(() => api('/api/folders/rename', { method: 'POST', body: { path, name: clean } }),
    () => restoreBranch(snap));
  return target;
}

// Moves a folder, with everything in it, under another one ('' is the top).
export async function moveFolder(from, toParent) {
  const to = normFolder(toParent);
  if (to === from || to.startsWith(from + '/')) throw new Error('a folder cannot go inside itself');
  const target = to ? `${to}/${nameOf(from)}` : nameOf(from);
  if (target === from) return from;
  if (tree().has(target)) throw new Error(`/${target} already exists`);
  const snap = snapshotBranch(from);
  rewrite(from, target);
  changed();
  await write(() => api('/api/folders/move', { method: 'POST', body: { from, to } }),
    () => restoreBranch(snap));
  return target;
}

// Returns what went, the links and the folders written down, so the delete
// can be undone: restore() the links, reviveFolders() the folders.
export async function deleteFolder(path) {
  const snap = snapshotBranch(path);
  const paths = [...state.folders].filter((p) => p === path || p.startsWith(path + '/'));
  for (const b of snap.items) state.items.delete(b.id);
  for (const p of paths) state.folders.delete(p);
  changed();
  await write(() => api('/api/folders/delete', { method: 'POST', body: { path } }), () => restoreBranch(snap));
  return { items: snap.items, paths };
}

// Writes folders down again, parents first. One the links already put back on
// the tree answers 409, which here means it is there: what was wanted.
export async function reviveFolders(paths) {
  const todo = [...new Set(paths)].sort((a, b) => a.split('/').length - b.split('/').length);
  for (const p of todo) state.folders.add(p);
  changed();
  await write(async () => {
    for (const p of todo) {
      try {
        await api('/api/folders', { method: 'POST', body: { path: p } });
      } catch (err) {
        if (err.status !== 409) throw err;
      }
    }
  });
}

/* ---------------- sync ---------------- */

let pulling = false;
let pullTimer = null;

function pullSoon() {
  clearTimeout(pullTimer);
  pullTimer = setTimeout(pull, 50);
}

export async function pull() {
  if (!state.vault || pulling || inflight) return;
  pulling = true;
  const started = epoch;
  const fresh = state.lastSync === 0;
  if (fresh) setStatus('syncing');
  try {
    const r = await api('/api/sync', { method: 'POST', body: { since: state.lastSync, changes: [] } });
    // A write began while this was out: what it carries may predate the write.
    if (epoch !== started || inflight) return;
    let touched = fresh;
    for (const c of r.changes || []) {
      const had = state.items.get(c.id);
      if (c.deleted ? had : (!had || had.updated_at !== c.updated_at || had.opens !== c.opens)) touched = true;
      put(c);
    }
    for (const f of r.folders || []) {
      if (f.deleted) { if (state.folders.delete(f.path)) touched = true; }
      else if (!state.folders.has(f.path)) { state.folders.add(f.path); touched = true; }
    }
    state.lastSync = r.now;
    if (touched) changed();
    setStatus('synced');
  } catch (err) {
    setStatus(err.status === 401 ? 'signed-out' : 'offline');
  } finally {
    pulling = false;
  }
}

// Another tab of the same app wrote something: pull now instead of in five
// seconds. Two windows side by side then agree as fast as one does with itself.
const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('bookmarks') : null;
function broadcast() {
  channel?.postMessage({ vault: state.vault });
}
if (channel) channel.onmessage = (e) => { if (e.data?.vault === state.vault) pullSoon(); };

let started = false;

export function startSync() {
  if (started) return;
  started = true;
  setInterval(() => { if (document.visibilityState === 'visible') pull(); }, 5000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') pull(); });
  window.addEventListener('online', pull);
  window.addEventListener('focus', pull);
}

/* ---------------- the cache ---------------- */

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('bookmarks', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('vaults');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbDo(mode, fn) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('vaults', mode);
    const req = fn(tx.objectStore('vaults'));
    tx.oncomplete = () => { db.close(); resolve(req?.result); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

let persistTimer = null;

function schedulePersist() {
  if (!state.vault) return;
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persist, 400);
}

function persist() {
  if (!state.vault) return;
  const snapshot = {
    items: all(),
    folders: [...state.folders],
    lastSync: state.lastSync,
  };
  idbDo('readwrite', (s) => s.put(snapshot, `v${state.vault}`)).catch(() => {});
}

// Opens a vault: the cache first, so the first paint does not wait on the
// network, then a pull for what changed since the cache was written.
export async function open(vaultId) {
  state.vault = vaultId;
  state.items = new Map();
  state.folders = new Set();
  state.lastSync = 0;
  let cached = null;
  try { cached = await idbDo('readonly', (s) => s.get(`v${vaultId}`)); } catch { /* no cache, then */ }
  if (cached && Array.isArray(cached.items)) {
    for (const b of cached.items) state.items.set(b.id, b);
    state.folders = new Set(cached.folders || []);
    state.lastSync = Number(cached.lastSync) || 0;
  }
  changed();
  const pulled = pull();
  // Without a cache there is nothing to show until the pull lands.
  if (!cached) await pulled;
  return !!cached;
}

// Everything again from the server, after an import rewrote the vault.
export async function reload() {
  state.items = new Map();
  state.folders = new Set();
  state.lastSync = 0;
  await pull();
}

export async function close() {
  const id = state.vault;
  state.vault = 0;
  state.items = new Map();
  state.folders = new Set();
  state.lastSync = 0;
  clearTimeout(persistTimer);
  // A signed-out device should not keep a copy of the vault around.
  if (id) await idbDo('readwrite', (s) => s.delete(`v${id}`)).catch(() => {});
}
