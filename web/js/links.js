// All links: the search box, the list, and selecting rows to act on them.
//
// The list is drawn in pages of PAGE rows and grows as it scrolls. A search
// over the whole vault is a few milliseconds; building a DOM row for each of
// two thousand results is what used to make typing stutter, and nobody reads
// past the first screen of them anyway.

import * as store from './store.js';
import {
  $, esc, icon, favicon, highlight, hostOf, plural, folderLabel, stamp,
  startLinkDrag, moveLinks, deleteLinks, pickFolder, fail,
} from './ui.js';
import { openEditor } from './editor.js';
import * as searchlog from './searchlog.js';

const PAGE = 40;
const MODE_KEY = 'bookmarks_list_mode';

const view = {
  query: '',
  scope: null,       // null: everything; '' Unfiled; 'a/b': that folder and below
  results: [],
  shown: 0,
  cursor: -1,
  marked: new Set(),
  anchor: -1,
  lastVersion: -1,
  needles: [],
  // 'flat' is one ranked list; 'folders' is the same results under a heading
  // per folder. What is drawn is `items`: a row is its index in `results`, a
  // heading is { folder, n, collapsed }. `pos` maps a row to its item.
  mode: 'flat',
  collapsed: new Set(),
  groups: [],
  items: [],
  pos: [],
};

try { if (localStorage.getItem(MODE_KEY) === 'folders') view.mode = 'folders'; } catch { /* flat */ }

const list = () => $('#list');

export function getScope() {
  return view.scope;
}

export function setScope(path) {
  view.scope = view.scope === path ? null : path;
  view.cursor = -1;
  refresh({ reset: true });
}

export function setQuery(q) {
  $('#q').value = q;
  view.query = q;
  view.cursor = -1;
  refresh({ reset: true });
}

export function getMode() {
  return view.mode;
}

export function setMode(mode) {
  view.mode = mode === 'folders' ? 'folders' : 'flat';
  try { localStorage.setItem(MODE_KEY, view.mode); } catch { /* this tab only */ }
  view.cursor = -1;
  refresh({ reset: true });
}

export function toggleMode() {
  setMode(view.mode === 'folders' ? 'flat' : 'folders');
}

function toggleGroup(folder) {
  if (view.collapsed.has(folder)) view.collapsed.delete(folder); else view.collapsed.add(folder);
  refresh();
}

function setAllGroups(collapse) {
  view.collapsed = collapse ? new Set(view.groups.map((g) => g.folder)) : new Set();
  refresh({ reset: true });
}

export function focusSearch() {
  $('#q').focus();
  $('#q').select();
}

function inScope(b) {
  const s = view.scope;
  if (s === null) return true;
  const f = b.folder || '';
  return s === '' ? f === '' : f === s || f.startsWith(s + '/');
}

function needlesOf(q) {
  const S = globalThis.BookmarksSearch;
  return S.parseQuery(q)
    .filter((t) => !t.negate && (t.field === 'any' || t.field === 'title' || t.field === 'url') && t.value)
    .map((t) => t.value);
}

// Re-runs the search. `reset` goes back to the top; without it (a sync landed,
// a row was edited) the list keeps how far it was scrolled.
export function refresh({ reset = false } = {}) {
  const S = globalThis.BookmarksSearch;
  const pool = view.scope === null ? store.all() : store.all().filter(inScope);
  view.results = S.search(pool, view.query, pool.length || 1);
  arrange();
  view.needles = needlesOf(view.query);
  view.lastVersion = store.version();

  // A mark only survives while its row is still listed: a group delete must not
  // take something nobody can see is selected.
  if (view.marked.size) {
    const listed = new Set(view.results.map((b) => b.id));
    for (const id of view.marked) if (!listed.has(id)) view.marked.delete(id);
  }
  if (view.cursor >= view.results.length) view.cursor = view.results.length - 1;

  const keep = reset ? PAGE : Math.max(PAGE, view.shown);
  paint(keep);
  if (reset) $('#view-links').scrollTop = 0;
  paintMeta();
}

const byFolder = (a, b) => (a === '') - (b === '') || a.localeCompare(b, undefined, { sensitivity: 'base' });

// In folder mode the results are regrouped, each folder keeping the search's
// own order inside it, and a collapsed folder keeps its heading and count but
// gives up its rows: what is not drawn cannot be marked, moved or deleted.
function arrange() {
  if (view.mode !== 'folders') {
    view.groups = [];
    view.items = view.results.map((_, i) => i);
    view.pos = view.items.slice();
    return;
  }
  const buckets = new Map();
  for (const b of view.results) {
    const f = b.folder || '';
    if (!buckets.has(f)) buckets.set(f, []);
    buckets.get(f).push(b);
  }
  view.groups = [...buckets.keys()].sort(byFolder).map((folder) => ({
    folder, n: buckets.get(folder).length, collapsed: view.collapsed.has(folder),
  }));
  view.results = [];
  view.items = [];
  view.pos = [];
  for (const g of view.groups) {
    view.items.push(g);
    if (g.collapsed) continue;
    for (const b of buckets.get(g.folder)) {
      view.pos.push(view.items.length);
      view.items.push(view.results.length);
      view.results.push(b);
    }
  }
}

function groupHTML(g) {
  const cut = g.folder.lastIndexOf('/');
  const name = g.folder
    ? `${cut > 0 ? `<span class="group-parent">${esc(g.folder.slice(0, cut + 1))}</span>` : ''}${esc(g.folder.slice(cut + 1))}`
    : 'Unfiled';
  return `<li class="group${g.collapsed ? ' collapsed' : ''}" data-folder="${esc(g.folder)}" role="presentation">
    <button type="button" class="group-toggle" data-act="group" aria-expanded="${!g.collapsed}" title="${g.collapsed ? 'Show' : 'Hide'} these links">
      ${icon('chev-down', 'group-chev')}${icon(g.folder ? 'folder' : 'inbox')}<span class="group-name">${name}</span><span class="group-n">${g.n.toLocaleString()}</span>
    </button>
    <button type="button" class="btn link sm" data-act="group-scope" title="Show only this folder">Open</button>
  </li>`;
}

function itemHTML(k) {
  const it = view.items[k];
  return typeof it === 'number' ? rowHTML(view.results[it], it) : groupHTML(it);
}

function rowHTML(b, i) {
  const host = hostOf(b.url);
  const tags = (b.tags || '').split(',').filter(Boolean).slice(0, 4);
  const cls = ['row', view.marked.has(b.id) ? 'marked' : '', i === view.cursor ? 'cursor' : ''].join(' ');
  return `<li class="${cls}" data-i="${i}" draggable="true" role="option" aria-selected="${view.marked.has(b.id)}">
    <span class="check-box" data-act="mark">${icon('check')}</span>
    ${favicon(b.url, b.title)}
    <div class="row-main">
      <a class="row-title" href="${esc(b.url)}" target="_blank" rel="noopener noreferrer" draggable="false">${highlight(b.title || host || b.url, view.needles)}</a>
      <div class="row-meta">
        <span class="host">${highlight(host, view.needles)}</span>
        <button type="button" class="chip" data-act="scope" title="Show only this folder">${icon(b.folder ? 'folder' : 'inbox')}<span>${esc(folderLabel(b.folder))}</span></button>
        ${tags.map((t) => `<span class="tag" data-tag="${esc(t)}">#${esc(t)}</span>`).join('')}
        ${b.opens > 0 ? `<span class="opens" title="Opened ${b.opens} times">${b.opens}×</span>` : ''}
        ${b.last_open_at > 0 ? `<time class="opens last-open" datetime="${new Date(b.last_open_at).toISOString()}" title="Last opened">${stamp(b.last_open_at)}</time>` : ''}
      </div>
    </div>
    <div class="row-actions">
      <button type="button" class="btn icon" data-act="move" title="Move (m)">${icon('move')}</button>
      <button type="button" class="btn icon" data-act="edit" title="Edit (e)">${icon('edit')}</button>
      <button type="button" class="btn icon" data-act="delete" title="Delete (Del)">${icon('trash')}</button>
    </div>
  </li>`;
}

function paint(upTo) {
  const ul = list();
  view.shown = Math.min(upTo, view.items.length);
  let html = '';
  for (let k = 0; k < view.shown; k++) html += itemHTML(k);
  ul.innerHTML = html;
  ul.classList.toggle('grouped', view.mode === 'folders');
  ul.classList.toggle('selecting', view.marked.size > 0);
  appendMore();
  paintEmpty();
}

function appendMore() {
  const ul = list();
  ul.querySelector('.more')?.remove();
  if (view.shown >= view.items.length) return;
  const li = document.createElement('li');
  li.className = 'more';
  const left = view.items.slice(view.shown).filter((it) => typeof it === 'number').length;
  li.textContent = left ? `Show more (${left.toLocaleString()} left)` : 'Show more folders';
  li.onclick = showMore;
  ul.append(li);
  observer.observe(li);
}

function showMore() {
  const ul = list();
  const from = view.shown;
  view.shown = Math.min(view.shown + PAGE, view.items.length);
  let html = '';
  for (let k = from; k < view.shown; k++) html += itemHTML(k);
  ul.querySelector('.more')?.remove();
  ul.insertAdjacentHTML('beforeend', html);
  appendMore();
}

const observer = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (e.isIntersecting) { observer.unobserve(e.target); showMore(); }
  }
}, { rootMargin: '600px' });

function paintEmpty() {
  const empty = $('#empty');
  if (view.items.length) { empty.hidden = true; return; }
  empty.hidden = false;
  if (!store.count()) {
    empty.innerHTML = '<b>No links yet</b>Save your first one, or bring them in from a browser.'
      + `<div><button type="button" class="btn primary" id="empty-new">${icon('plus')}New link</button> `
      + '<a class="btn" href="#/data">Import</a></div>';
    $('#empty-new').onclick = () => openEditor();
  } else if (view.query) {
    empty.innerHTML = `<b>Nothing matches</b>No link has “${esc(view.query)}”${view.scope !== null ? ` in ${esc(folderLabel(view.scope))}` : ''}.`;
  } else {
    empty.innerHTML = `<b>${esc(folderLabel(view.scope))} is empty</b>Drag links onto it in the folder list, or use Organize.`;
  }
}

function paintMeta() {
  const n = view.results.length;
  const total = store.count();
  $('#count').textContent = n === total ? plural(total, 'link') : `${n.toLocaleString()} of ${plural(total, 'link')}`;
  const scope = $('#scope');
  if (view.scope === null) {
    scope.hidden = true;
  } else {
    scope.hidden = false;
    scope.innerHTML = `${icon(view.scope ? 'folder' : 'inbox')}<span>${esc(folderLabel(view.scope))}</span><button type="button" title="Search everything">${icon('x')}</button>`;
    scope.querySelector('button').onclick = () => setScope(null);
  }
  $('#q').placeholder = view.scope === null ? `Search ${plural(total, 'link')}` : 'Search this folder';
  for (const b of document.querySelectorAll('#list-mode button')) b.classList.toggle('on', b.dataset.mode === view.mode);
  const fold = $('#groups-fold');
  fold.hidden = view.mode !== 'folders' || view.groups.length < 2;
  const allShut = view.groups.length && view.groups.every((g) => g.collapsed);
  fold.textContent = allShut ? 'Expand all' : 'Collapse all';
  fold.dataset.collapse = String(!allShut);
  paintSelbar();
}

/* ---------------- selection ---------------- */

function paintRow(i) {
  const li = list().querySelector(`[data-i="${i}"]`);
  if (!li) return;
  const b = view.results[i];
  li.classList.toggle('marked', view.marked.has(b.id));
  li.classList.toggle('cursor', i === view.cursor);
  li.setAttribute('aria-selected', String(view.marked.has(b.id)));
}

function toggleMark(i) {
  const b = view.results[i];
  if (!b) return;
  if (view.marked.has(b.id)) view.marked.delete(b.id); else view.marked.add(b.id);
  view.anchor = i;
  paintRow(i);
  paintSelbar();
}

function markRange(i) {
  const from = view.anchor < 0 ? i : view.anchor;
  const [a, z] = from < i ? [from, i] : [i, from];
  for (let k = a; k <= z; k++) {
    view.marked.add(view.results[k].id);
    paintRow(k);
  }
  paintSelbar();
}

export function markAll() {
  for (const b of view.results) view.marked.add(b.id);
  for (const li of list().querySelectorAll('.row')) li.classList.add('marked');
  paintSelbar();
}

export function clearMarks() {
  if (!view.marked.size) return false;
  view.marked.clear();
  for (const li of list().querySelectorAll('.row.marked')) li.classList.remove('marked');
  paintSelbar();
  return true;
}

function paintSelbar() {
  const n = view.marked.size;
  list().classList.toggle('selecting', n > 0);
  const bar = $('#selbar');
  const active = document.body.dataset.route === 'links';
  bar.hidden = !(n && active);
  if (n && active) $('#sel-count').textContent = `${n.toLocaleString()} selected`;
  $('#sel-edit').hidden = n !== 1;
}

export function selectionChanged() {
  paintSelbar();
}

function targets() {
  if (view.marked.size) return [...view.marked];
  const b = view.results[view.cursor];
  return b ? [b.id] : [];
}

export async function moveSelected() {
  const ids = targets();
  if (!ids.length) return;
  const one = ids.length === 1 ? store.get(ids[0]) : null;
  const folder = await pickFolder({
    title: ids.length === 1 ? 'Move link to' : `Move ${ids.length} links to`,
    current: one ? one.folder || '' : null,
  });
  if (folder == null) return;
  // The selection goes first, so the bar is gone before the toast shows up
  // where it stood, instead of the toast jumping down a moment later.
  view.marked.clear();
  paintSelbar();
  moveLinks(ids, folder).catch(fail);
}

export async function deleteSelected() {
  const ids = targets();
  try {
    await deleteLinks(ids, { before: () => { view.marked.clear(); paintSelbar(); } });
  } catch (err) { fail(err); }
}

export function editCursor() {
  const b = view.results[view.cursor] || (view.marked.size === 1 ? store.get([...view.marked][0]) : null);
  if (b) openEditor(b);
}

/* ---------------- the cursor ---------------- */

export function moveCursor(delta) {
  if (!view.results.length) return;
  const prev = view.cursor;
  const next = Math.min(Math.max((prev < 0 && delta > 0 ? -1 : prev) + delta, 0), view.results.length - 1);
  view.cursor = next;
  while (view.pos[next] >= view.shown) showMore();
  paintRow(prev);
  paintRow(next);
  list().querySelector(`[data-i="${next}"]`)?.scrollIntoView({ block: 'nearest' });
}

export function openCursor() {
  const b = view.results[view.cursor < 0 ? 0 : view.cursor];
  if (!b || !b.url) return;
  store.registerOpen(b.id);
  window.open(b.url, '_blank', 'noopener');
}

export function toggleCursorMark() {
  if (view.cursor < 0) moveCursor(1);
  toggleMark(view.cursor);
}

/* ---------------- search history ---------------- */

const historyOpen = () => !$('#search-history').hidden;

function showHistory(open) {
  $('#search-history').hidden = !open;
  $('#btn-history').setAttribute('aria-expanded', String(open));
  if (!open) return;
  const list = searchlog.load();
  $('#history-list').innerHTML = list.length
    ? list.map((e, i) => `<li><button type="button" data-h="${i}"><span class="q">${esc(e.q)}</span><time datetime="${new Date(e.at).toISOString()}">${stamp(e.at)}</time></button></li>`).join('')
    : '<li class="empty-history">No searches yet.</li>';
  $('#history-clear').hidden = !list.length;
}

function initHistory() {
  const q = $('#q');
  // A search is kept once the typing stops, or when it is acted on.
  let timer = 0;
  q.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => searchlog.add(q.value), 1500);
  });
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') searchlog.add(q.value); });
  list().addEventListener('click', () => searchlog.add(q.value), true);

  $('#btn-history').addEventListener('click', () => showHistory(!historyOpen()));
  $('#history-clear').addEventListener('click', () => { searchlog.clear(); showHistory(true); });
  $('#history-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-h]');
    if (!b) return;
    const entry = searchlog.load()[Number(b.dataset.h)];
    showHistory(false);
    if (!entry) return;
    searchlog.add(entry.q);
    setQuery(entry.q);
    q.focus();
  });
  document.addEventListener('click', (e) => {
    if (historyOpen() && !e.target.closest('.history-wrap')) showHistory(false);
  });
}

export function onEscape() {
  if (historyOpen()) { showHistory(false); return true; }
  if (clearMarks()) return true;
  if ($('#q').value) { setQuery(''); return true; }
  if (view.scope !== null) { setScope(null); return true; }
  return false;
}

/* ---------------- wiring ---------------- */

export function init() {
  initHistory();
  const q = $('#q');
  let frame = 0;
  q.addEventListener('input', () => {
    view.query = q.value;
    view.cursor = view.query ? 0 : -1;
    // One search per frame however fast the keys arrive.
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => refresh({ reset: true }));
  });

  const ul = list();

  ul.addEventListener('click', (e) => {
    const group = e.target.closest('.group');
    if (group) {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'group') toggleGroup(group.dataset.folder);
      else if (act === 'group-scope') setScope(group.dataset.folder);
      return;
    }
    const li = e.target.closest('.row');
    if (!li) return;
    const i = Number(li.dataset.i);
    const b = view.results[i];
    const act = e.target.closest('[data-act]')?.dataset.act;
    const tag = e.target.closest('[data-tag]')?.dataset.tag;

    if (tag) { e.preventDefault(); setQuery(`#${tag}`); return; }
    if (act === 'scope') { e.preventDefault(); setScope(b.folder || ''); return; }
    if (act === 'edit') { e.preventDefault(); openEditor(b); return; }
    // On a marked row the button speaks for the whole selection.
    if (act === 'move') { e.preventDefault(); if (view.marked.has(b.id)) moveSelected(); else moveOne(b); return; }
    if (act === 'delete') { e.preventDefault(); if (view.marked.has(b.id)) deleteSelected(); else deleteLinks([b.id]).catch(fail); return; }
    if (e.shiftKey) { e.preventDefault(); markRange(i); return; }
    if (act === 'mark' || e.ctrlKey || e.metaKey || view.marked.size) {
      e.preventDefault();
      toggleMark(i);
      return;
    }
    // A plain click opens the link. The title is a real anchor, so the browser
    // does it; anywhere else on the row, it is done here.
    store.registerOpen(b.id);
    if (!e.target.closest('a')) window.open(b.url, '_blank', 'noopener');
  });

  // The wheel button opens in a new tab, which the anchor already does on the
  // title; this is for the rest of the row.
  ul.addEventListener('auxclick', (e) => {
    if (e.button !== 1) return;
    const li = e.target.closest('.row');
    if (!li || e.target.closest('a')) { if (li) store.registerOpen(view.results[Number(li.dataset.i)].id); return; }
    const b = view.results[Number(li.dataset.i)];
    store.registerOpen(b.id);
    window.open(b.url, '_blank', 'noopener');
  });

  // Right click edits. On a touch screen the same event is a long press, and
  // there it selects, since a phone has no Ctrl to click with.
  ul.addEventListener('contextmenu', (e) => {
    const li = e.target.closest('.row');
    if (!li) return;
    const touch = matchMedia('(pointer: coarse)').matches;
    if (!touch && e.target.closest('a')) return;
    e.preventDefault();
    if (touch) toggleMark(Number(li.dataset.i));
    else openEditor(view.results[Number(li.dataset.i)]);
  });

  ul.addEventListener('dragstart', (e) => {
    const li = e.target.closest('.row');
    if (!li) return;
    const b = view.results[Number(li.dataset.i)];
    // Dragging a marked row takes every marked row with it.
    const ids = view.marked.has(b.id) ? [...view.marked] : [b.id];
    startLinkDrag(e, ids);
    li.classList.add('dragging');
  });
  ul.addEventListener('dragend', (e) => e.target.closest?.('.row')?.classList.remove('dragging'));

  $('#btn-new').onclick = () => openEditor(null, { folder: view.scope || '' });
  for (const b of document.querySelectorAll('#list-mode button')) b.onclick = () => setMode(b.dataset.mode);
  $('#groups-fold').onclick = (e) => setAllGroups(e.currentTarget.dataset.collapse === 'true');
  $('#btn-syntax').onclick = () => { $('#syntax').hidden = !$('#syntax').hidden; };
  $('#sel-clear').onclick = clearMarks;
  $('#sel-edit').onclick = () => { const b = store.get([...view.marked][0]); if (b) openEditor(b); };

  store.subscribe(() => {
    if (document.body.dataset.route === 'links') refresh();
  });
}

async function moveOne(b) {
  const folder = await pickFolder({ title: 'Move link to', current: b.folder || '' });
  if (folder == null) return;
  moveLinks([b.id], folder).catch(fail);
}

// Called when the view comes back on screen: the store may have moved on while
// another view was showing.
export function show() {
  if (view.lastVersion !== store.version()) refresh();
  else paintSelbar();
}
