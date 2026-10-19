// Organize: two folders side by side, and links moving between them.
//
// Each pane shows one folder: its subfolders first, then the links filed
// directly in it. Clicking a link selects it (here selecting is the point, so
// it takes no modifier), Shift extends the run, and the arrow buttons between
// the panes send the selection across. Dragging works too, onto the other
// pane, onto a subfolder row, onto a breadcrumb or onto the folder list.
//
// A subfolder row opens on a click, so marking one takes Ctrl (Cmd on a Mac),
// the way a file manager does, and Shift extends the run from there. Marked
// folders travel with the marked links: the arrows, `m` and dragging move them
// all, and Delete removes them all. Ctrl+A marks everything the pane lists,
// folders included. `n`, or the plus on a pane, makes a new link right in the
// folder that pane shows. Ctrl+V with a link on the clipboard files it there
// as it is, and a moment later the server finds it a title: the page's own, or
// the words in its address. The pencil on a link edits it, and so
// do `e` and F2 when one link is selected.

import * as store from './store.js';
import {
  $, esc, icon, favicon, hostOf, plural, folderLabel, pickFolder, dropTarget,
  startLinkDrag, startFolderDrag, moveLinks, moveFoldersTo, deleteLinks, askNewFolder,
  askRenameFolder, askDeleteFolder, askDeleteFolders, fail, toast,
} from './ui.js';
import { openEditor } from './editor.js';
import { api } from './http.js';

const KEY = 'bookmarks_organize';

function pane(id) {
  return {
    id, path: '', filter: '', marked: new Set(), anchor: -1, links: [],
    folders: [], markedFolders: new Set(), folderAnchor: -1, el: null,
  };
}

const panes = { a: pane('a'), b: pane('b') };
let focused = 'a';
let ready = false;

const other = (id) => (id === 'a' ? 'b' : 'a');

function save() {
  try { localStorage.setItem(KEY, JSON.stringify({ a: panes.a.path, b: panes.b.path })); } catch { /* fine */ }
}

// The first visit opens the fullest folder on the left, since that is the pile
// waiting to be sorted, and a different one on the right.
function pickDefaults() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { /* none */ }
  const t = store.tree();
  if (saved && t.has(saved.a) && t.has(saved.b)) {
    panes.a.path = saved.a;
    panes.b.path = saved.b;
    return;
  }
  let fullest = '';
  for (const p of ['', ...t.paths]) if (t.direct(p) > t.direct(fullest)) fullest = p;
  panes.a.path = fullest;
  panes.b.path = t.children('').find((p) => p !== fullest && !fullest.startsWith(p + '/')) ?? '';
}

export function openFolder(path, which = focused) {
  const p = panes[which];
  if (p.path === path) return;
  p.path = path;
  p.filter = '';
  p.marked.clear();
  p.anchor = -1;
  p.markedFolders.clear();
  p.folderAnchor = -1;
  save();
  paintPane(p);
  paintActions();
}

export function focusedPath() {
  return panes[focused].path;
}

/* ---------------- painting ---------------- */

function crumbs(path) {
  const parts = path ? path.split('/') : [];
  let html = `<button type="button" data-folder="">All</button>`;
  let acc = '';
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part;
    html += `${icon('chev')}<button type="button" data-folder="${esc(acc)}">${esc(part)}</button>`;
  }
  return html;
}

function paintPane(p) {
  const el = p.el;
  const root = p.path === '';
  el.innerHTML = `
    <div class="pane-head">
      <button type="button" class="btn pane-folder" data-act="pick" title="Choose the folder for this side">
        ${icon(root ? 'inbox' : 'folder')}<span>${esc(root ? 'Unfiled' : store.nameOf(p.path))}</span>${icon('chev-down', 'chev')}</button>
      <button type="button" class="btn icon" data-act="new-link" title="New link here (n)">${icon('plus')}</button>
      <button type="button" class="btn icon" data-act="new" title="New folder inside">${icon('folder-plus')}</button>
      ${root ? '' : `<button type="button" class="btn icon" data-act="rename" title="Rename this folder">${icon('edit')}</button>
      <button type="button" class="btn icon" data-act="delete" title="Delete this folder">${icon('trash')}</button>`}
    </div>
    <div class="crumbs">${root ? '<span class="muted">Top-level folders, and links in no folder</span>' : crumbs(p.path)}</div>
    <div class="pane-tools">
      <span class="check-box" data-act="all" title="Select all"></span>
      <input type="search" placeholder="Filter" value="${esc(p.filter)}" autocomplete="off" spellcheck="false">
      <span class="pane-count"></span>
      <button type="button" class="btn icon sm" data-act="delete-marked" title="Delete selected (Del)" hidden>${icon('trash')}</button>
    </div>
    <ul class="pane-list" role="listbox" aria-multiselectable="true"></ul>`;
  el.querySelector('input').addEventListener('input', (e) => {
    p.filter = e.target.value;
    paintList(p);
  });
  paintList(p);
}

function paintList(p) {
  const S = globalThis.BookmarksSearch;
  const t = store.tree();
  const q = p.filter.trim();
  const nq = S.norm(q);

  let links = store.inFolder(p.path);
  if (q) links = S.search(links, q, links.length || 1);
  else links.sort((x, y) => (x.title || x.url).localeCompare(y.title || y.url, undefined, { sensitivity: 'base' }));
  p.links = links;

  // Marks on links that left this folder (moved, deleted, synced away) go.
  const here = new Set(links.map((b) => b.id));
  for (const id of p.marked) if (!here.has(id)) p.marked.delete(id);

  let folders = t.children(p.path);
  if (q) folders = folders.filter((f) => S.norm(store.nameOf(f)).includes(nq));
  p.folders = folders;
  const shown = new Set(folders);
  for (const f of p.markedFolders) if (!shown.has(f)) p.markedFolders.delete(f);

  let html = '';
  if (p.path && !q) {
    const up = store.parentOf(p.path);
    html += `<li class="orow folder up" data-folder="${esc(up)}" title="Up to ${esc(folderLabel(up))}">${icon('up')}<div class="orow-main"><span class="orow-title muted">${esc(up ? store.nameOf(up) : 'All folders')}</span></div></li>`;
  }
  folders.forEach((f, i) => {
    html += `<li class="orow folder${p.markedFolders.has(f) ? ' marked' : ''}" data-folder="${esc(f)}" data-fi="${i}" draggable="true">${icon('folder')}<div class="orow-main"><span class="orow-title">${esc(store.nameOf(f))}</span></div><span class="pane-count">${t.total(f)}</span>${icon('chev')}</li>`;
  });
  links.forEach((b, i) => {
    const host = hostOf(b.url);
    html += `<li class="orow${p.marked.has(b.id) ? ' marked' : ''}" data-i="${i}" draggable="true" role="option">
      <span class="check-box">${icon('check')}</span>${favicon(b.url, b.title)}
      <div class="orow-main"><span class="orow-title">${esc(b.title || host || b.url)}</span><span class="orow-host">${esc(host)}</span></div>
      <button type="button" class="btn icon edit-link" title="Edit (e)" draggable="false">${icon('edit')}</button>
      <a class="btn icon open-link" href="${esc(b.url)}" target="_blank" rel="noopener noreferrer" title="Open" draggable="false">${icon('ext')}</a></li>`;
  });
  if (!folders.length && !links.length) {
    html += `<li class="pane-empty">${q ? 'Nothing matches the filter.' : 'Empty. Move links here from the other side.'}</li>`;
  }
  const ul = p.el.querySelector('.pane-list');
  ul.innerHTML = html;
  paintCount(p);
}

function paintCount(p) {
  const n = p.links.length;
  const m = p.marked.size;
  const f = p.markedFolders.size;
  const parts = [];
  if (f) parts.push(plural(f, 'folder'));
  if (m) parts.push(`${m} of ${n}`);
  p.el.querySelector('.pane-count').textContent = parts.length ? parts.join(' · ') : plural(n, 'link');
  const all = m + f === n + p.folders.length;
  const box = p.el.querySelector('[data-act="all"]');
  box.className = 'check-box' + (m + f && all ? ' on' : m + f ? ' some' : '');
  box.innerHTML = m + f && all ? icon('check') : '';
  p.el.querySelector('[data-act="delete-marked"]').hidden = !(m + f);
  paintActions();
}

function paintActions() {
  const set = (btn, from, to) => {
    const n = from.marked.size + from.markedFolders.size;
    btn.disabled = !n || from.path === to.path;
    btn.querySelector('span').textContent = n ? String(n) : '';
    btn.title = n
      ? `Move ${what(from)} to ${folderLabel(to.path)}`
      : `Select links or Ctrl+click folders on the ${from.id === 'a' ? 'left' : 'right'} to move them`;
  };
  set($('#move-ab'), panes.a, panes.b);
  set($('#move-ba'), panes.b, panes.a);
}

// "3 links", "2 folders", "2 folders and 3 links".
function what(p) {
  const parts = [];
  if (p.markedFolders.size) parts.push(plural(p.markedFolders.size, 'folder'));
  if (p.marked.size) parts.push(plural(p.marked.size, 'link'));
  return parts.join(' and ');
}

function paintFolderRow(p, i) {
  const li = p.el.querySelector(`[data-fi="${i}"]`);
  if (li) li.classList.toggle('marked', p.markedFolders.has(p.folders[i]));
}

function paintRow(p, i) {
  const li = p.el.querySelector(`[data-i="${i}"]`);
  if (li) li.classList.toggle('marked', p.marked.has(p.links[i].id));
}

/* ---------------- acting ---------------- */

// Links first, then folders: moving a folder rewrites the paths under it, and
// the marked links are filed in the pane's folder, not in those.
async function moveMarked(p, folder) {
  const ids = [...p.marked];
  const paths = [...p.markedFolders];
  p.marked.clear();
  p.markedFolders.clear();
  try {
    if (ids.length) await moveLinks(ids, folder);
    if (paths.length) await moveFoldersTo(paths, folder);
  } catch (err) { fail(err); }
  paintList(p);
}

function send(fromId) {
  const from = panes[fromId];
  const to = panes[other(fromId)];
  if (!from.marked.size && !from.markedFolders.size) return;
  if (from.path === to.path) return;
  return moveMarked(from, to.path);
}

async function moveMarkedElsewhere(p) {
  if (!p.marked.size && !p.markedFolders.size) return;
  const folder = await pickFolder({ title: `Move ${what(p)} to`, current: p.path });
  if (folder == null) return;
  return moveMarked(p, folder);
}

// Marked folders go with everything in them, after one question. A pane that
// was showing one of them steps up to where it was.
async function deleteMarked(p) {
  const ids = [...p.marked];
  const paths = [...p.markedFolders];
  if (!paths.length) {
    try {
      await deleteLinks(ids, { before: () => p.marked.clear() });
    } catch (err) { fail(err); }
    return;
  }
  const gone = await askDeleteFolders(paths, ids).catch(fail);
  if (!gone) return;
  p.marked.clear();
  p.markedFolders.clear();
  for (const q of Object.values(panes)) {
    const hit = paths.find((f) => q.path === f || q.path.startsWith(f + '/'));
    if (hit) q.path = store.parentOf(hit);
  }
  save();
  paintAll();
}

// Everything the pane lists, folders and links; again, when all of it is
// already marked, clears it.
function markAll(p) {
  const all = p.marked.size + p.markedFolders.size === p.links.length + p.folders.length;
  p.marked.clear();
  p.markedFolders.clear();
  if (!all) {
    for (const b of p.links) p.marked.add(b.id);
    for (const f of p.folders) p.markedFolders.add(f);
  }
  paintList(p);
}

// Ctrl toggles one folder; Shift marks the run from the last one toggled.
function markFolder(p, i, range) {
  if (range && p.folderAnchor >= 0) {
    const [a, z] = p.folderAnchor < i ? [p.folderAnchor, i] : [i, p.folderAnchor];
    for (let k = a; k <= z; k++) { p.markedFolders.add(p.folders[k]); paintFolderRow(p, k); }
  } else {
    const f = p.folders[i];
    if (p.markedFolders.has(f)) p.markedFolders.delete(f); else p.markedFolders.add(f);
    p.folderAnchor = i;
    paintFolderRow(p, i);
  }
  paintCount(p);
}

function setFocus(id) {
  focused = id;
  panes.a.el.classList.toggle('focus', id === 'a');
  panes.b.el.classList.toggle('focus', id === 'b');
}

function wirePane(p) {
  const el = p.el;
  el.addEventListener('pointerdown', () => setFocus(p.id));
  el.addEventListener('focusin', () => setFocus(p.id));

  el.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'pick') {
      const path = await pickFolder({ title: `Open on the ${p.id === 'a' ? 'left' : 'right'}`, current: p.path });
      if (path != null) openFolder(path, p.id);
      return;
    }
    if (act === 'new-link') { openEditor(null, { folder: p.path }); return; }
    if (act === 'new') {
      const made = await askNewFolder(p.path);
      if (made) paintPane(p);
      return;
    }
    if (act === 'rename') {
      const to = await askRenameFolder(p.path).catch(fail);
      if (to) {
        for (const q of Object.values(panes)) {
          if (q.path === p.path || q.path.startsWith(p.path + '/')) q.path = to + q.path.slice(p.path.length);
        }
        save();
        paintAll();
      }
      return;
    }
    if (act === 'delete') {
      const path = p.path;
      const gone = await askDeleteFolder(path).catch(fail);
      if (gone) {
        for (const q of Object.values(panes)) {
          if (q.path === path || q.path.startsWith(path + '/')) q.path = store.parentOf(path);
        }
        save();
        paintAll();
      }
      return;
    }
    if (act === 'all') { markAll(p); return; }
    if (act === 'delete-marked') { deleteMarked(p); return; }

    const crumb = e.target.closest('.crumbs [data-folder]');
    if (crumb) { openFolder(crumb.dataset.folder, p.id); return; }

    const row = e.target.closest('.orow');
    if (!row) return;
    if (row.dataset.fi != null && (e.ctrlKey || e.metaKey || (e.shiftKey && p.folderAnchor >= 0))) {
      markFolder(p, Number(row.dataset.fi), e.shiftKey);
      return;
    }
    if (row.dataset.folder != null) { openFolder(row.dataset.folder, p.id); return; }

    const i = Number(row.dataset.i);
    const b = p.links[i];
    if (e.target.closest('.open-link')) { store.registerOpen(b.id); return; }
    if (e.target.closest('.edit-link')) { openEditor(b); return; }
    if (e.shiftKey && p.anchor >= 0) {
      const [a, z] = p.anchor < i ? [p.anchor, i] : [i, p.anchor];
      for (let k = a; k <= z; k++) { p.marked.add(p.links[k].id); paintRow(p, k); }
    } else {
      if (p.marked.has(b.id)) p.marked.delete(b.id); else p.marked.add(b.id);
      p.anchor = i;
      paintRow(p, i);
    }
    paintCount(p);
  });

  el.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.orow[data-i]');
    if (!row) return;
    const b = p.links[Number(row.dataset.i)];
    store.registerOpen(b.id);
    window.open(b.url, '_blank', 'noopener');
  });

  el.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.orow');
    if (!row) return;
    if (row.dataset.folder != null) {
      // A marked folder carries every marked folder with it; an unmarked one
      // goes alone, as it always did.
      const f = row.dataset.folder;
      startFolderDrag(e, p.markedFolders.has(f) ? [...p.markedFolders] : f);
      return;
    }
    const b = p.links[Number(row.dataset.i)];
    if (!p.marked.has(b.id)) {
      p.marked.add(b.id);
      paintRow(p, Number(row.dataset.i));
      paintCount(p);
    }
    startLinkDrag(e, [...p.marked]);
  });

  // Over a folder row or a breadcrumb: that folder. Anywhere else in the pane:
  // the folder the pane shows.
  dropTarget(el, (e) => {
    const f = e.target.closest('[data-folder]');
    if (f) return { path: f.dataset.folder, el: f };
    return { path: p.path, el };
  });
}

// `settle` steps a pane up from a folder that is no longer there (deleted on
// another device, say) to the closest one still standing. Only on arrival:
// while the page is open, a pane stays put even when its folder empties and
// drops off the tree, because emptying a folder is what this page is for and
// the pane should not wander off the moment it happens.
function paintAll({ settle = false } = {}) {
  const t = store.tree();
  for (const p of Object.values(panes)) {
    if (settle) while (p.path && !t.has(p.path)) p.path = store.parentOf(p.path);
    paintPane(p);
  }
  setFocus(focused);
}

/* ---------------- keyboard ---------------- */

export function onKey(e, typing) {
  const p = panes[focused];
  if (e.key === 'Escape') {
    let had = 0;
    for (const q of Object.values(panes)) {
      had += q.marked.size + q.markedFolders.size;
      q.marked.clear();
      q.markedFolders.clear();
      paintList(q);
    }
    return had > 0;
  }
  if (typing) return false;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
    const all = p.marked.size + p.markedFolders.size === p.links.length + p.folders.length;
    if (!all) markAll(p);
    return true;
  }
  if (e.key === 'ArrowRight' && !e.ctrlKey && !e.metaKey && !e.altKey) { send('a'); return true; }
  if (e.key === 'ArrowLeft' && !e.ctrlKey && !e.metaKey && !e.altKey) { send('b'); return true; }
  if (e.key === 'Delete' || e.key === 'Backspace') { deleteMarked(p); return true; }
  if (e.key === 'm') { moveMarkedElsewhere(p); return true; }
  if (e.key === 'n' && !e.ctrlKey && !e.metaKey && !e.altKey) { openEditor(null, { folder: p.path }); return true; }
  if ((e.key === 'e' && !e.ctrlKey && !e.metaKey && !e.altKey) || e.key === 'F2') {
    if (p.marked.size !== 1) return false;
    const b = store.get([...p.marked][0]);
    if (b) openEditor(b);
    return Boolean(b);
  }
  return false;
}

/* ---------------- pasting ---------------- */

// What on the clipboard reads as links: one per line, with or without the
// scheme. A line with a space in it is prose, not a link, and is passed over.
export function linksIn(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const s = raw.trim();
    if (!s || /\s/.test(s)) continue;
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
    let u;
    try { u = new URL(url); } catch { continue; }
    if (!/^https?:$/.test(u.protocol)) continue;
    if (!u.hostname.includes('.') && u.hostname !== 'localhost') continue;
    if (!out.includes(url)) out.push(url);
  }
  return out;
}

// The links go into the folder of the pane in focus, saved at once with the URL
// alone. One already filed there is not filed twice.

// The title follows: reading the page takes a moment and may fail, and neither
// should hold the save. A title typed in the meantime wins.
async function fillTitle(b) {
  try {
    const r = await api(`/api/title?url=${encodeURIComponent(b.url)}`);
    const now = store.get(b.id);
    if (r.title && now && !now.title) await store.update(b.id, { title: r.title });
  } catch { /* the link is saved; the title was a nicety */ }
}

export async function onPaste(e) {
  const p = panes[focused];
  const urls = linksIn(e.clipboardData?.getData('text/plain'));
  if (!urls.length) { toast('Nothing to paste: the clipboard holds no link'); return; }
  e.preventDefault();
  const here = new Set(store.inFolder(p.path).map((b) => b.url));
  const fresh = urls.filter((u) => !here.has(u));
  if (!fresh.length) {
    toast(urls.length === 1 ? `Already in ${folderLabel(p.path)}` : `All of them are already in ${folderLabel(p.path)}`);
    return;
  }
  try {
    const made = [];
    for (const url of fresh) made.push(await store.create({ url, folder: p.path }));
    for (const b of made) fillTitle(b);
    toast(`Added ${made.length === 1 ? hostOf(fresh[0]) : plural(made.length, 'link')} to ${folderLabel(p.path)}`, {
      action: 'Undo',
      onAction: () => store.removeMany(made.map((b) => b.id)).catch(fail),
    });
  } catch (err) { fail(err); }
}

/* ---------------- lifecycle ---------------- */

export function init() {
  panes.a.el = $('#pane-a');
  panes.b.el = $('#pane-b');
  wirePane(panes.a);
  wirePane(panes.b);
  $('#move-ab').onclick = () => send('a');
  $('#move-ba').onclick = () => send('b');
  store.subscribe(() => {
    if (document.body.dataset.route !== 'organize') return;
    // A sync or a move repaints the lists, not the filter boxes, so typing in
    // one is never interrupted.
    paintList(panes.a);
    paintList(panes.b);
  });
}

export function show() {
  if (!ready) { pickDefaults(); ready = true; }
  paintAll({ settle: true });
}
