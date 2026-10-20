// Small pieces every view uses: escaping, icons, favicons, highlighting, the
// toast, the confirm and prompt dialogs, the folder picker, and dragging.

import * as store from './store.js';

export { stamp } from './stamp.js';

export const $ = (s, root = document) => root.querySelector(s);
export const $$ = (s, root = document) => [...root.querySelectorAll(s)];

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ESC[c]);
}

export function icon(name, cls = '') {
  return `<svg${cls ? ` class="${cls}"` : ''}><use href="#i-${name}"/></svg>`;
}

export function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

export function folderLabel(path) {
  return path ? path : 'Unfiled';
}

// The letter sits under the icon, so a favicon that never loads leaves a
// readable square behind instead of a broken image.
export function favicon(url, title) {
  const host = hostOf(url);
  const letter = esc((title || host || '?').trim().charAt(0) || '?');
  if (!host) return `<span class="fav">${letter}</span>`;
  return `<span class="fav">${letter}<img src="https://icons.duckduckgo.com/ip3/${esc(host)}.ico" alt="" loading="lazy" decoding="async" onerror="this.remove()"></span>`;
}

// Marks what the search matched, on the original text. The search compares
// accent-free lowercase, so each character is normalized on its own and mapped
// back, which keeps `ação` highlighted when `acao` was typed.
export function highlight(text, needles) {
  const s = String(text || '');
  if (!needles.length || !s) return esc(s);
  const norm = globalThis.BookmarksSearch.norm;
  let flat = '';
  const map = [];
  for (let i = 0; i < s.length; i++) {
    const n = norm(s[i]);
    for (let k = 0; k < n.length; k++) { flat += n[k]; map.push(i); }
  }
  const spans = [];
  for (const v of needles) {
    let from = 0;
    let i;
    while (v && (i = flat.indexOf(v, from)) >= 0) {
      spans.push([map[i], map[i + v.length - 1] + 1]);
      from = i + v.length;
    }
  }
  if (!spans.length) return esc(s);
  spans.sort((a, b) => a[0] - b[0]);
  let out = '';
  let cur = 0;
  for (const [a, b] of spans) {
    if (a < cur) continue;
    out += esc(s.slice(cur, a)) + '<mark>' + esc(s.slice(a, b)) + '</mark>';
    cur = b;
  }
  return out + esc(s.slice(cur));
}

export function plural(n, one, many = one + 's') {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/* ---------------- toast ---------------- */

export function toast(message, { action, onAction, error = false, ms = 5000 } = {}) {
  const el = document.createElement('div');
  el.className = 'toast' + (error ? ' error' : '');
  el.innerHTML = `<span>${esc(message)}</span>`;
  let timer;
  const close = () => { clearTimeout(timer); el.remove(); };
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = action;
    b.onclick = () => { close(); onAction?.(); };
    el.append(b);
  }
  $('#toasts').append(el);
  // Only the newest few: a burst of undos is noise past three.
  const all = $$('#toasts .toast');
  if (all.length > 3) all[0].remove();
  timer = setTimeout(close, ms);
  return close;
}

export function fail(err) {
  toast(err?.message || String(err), { error: true, ms: 7000 });
}

/* ---------------- dialogs ---------------- */

// Every dialog closes on its [data-close] buttons and on a click outside the card.
export function wireDialog(dlg) {
  for (const b of $$('[data-close]', dlg)) b.onclick = () => dlg.close('cancel');
  dlg.addEventListener('mousedown', (e) => {
    if (e.target !== dlg) return;
    const r = dlg.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) dlg.close('cancel');
  });
}

export function anyDialogOpen() {
  return !!document.querySelector('dialog[open]');
}

export function confirmDialog({ title, text = '', ok = 'Delete' }) {
  const dlg = $('#dlg-confirm');
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = text;
  $('#confirm-yes').textContent = ok;
  dlg.returnValue = '';
  dlg.showModal();
  // Cancel holds the focus, so a stray Enter says no.
  $('#confirm-no').focus();
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'yes'), { once: true });
  });
}

// One text field, validated by `submit`, which throws to keep the dialog open.
export function promptDialog({ title, label, value = '', ok = 'Save', submit }) {
  const dlg = $('#dlg-prompt');
  const input = $('#prompt-input');
  $('#prompt-title').textContent = title;
  $('#prompt-label').textContent = label;
  $('#prompt-ok').textContent = ok;
  $('#prompt-error').textContent = '';
  input.value = value;
  dlg.showModal();
  input.focus();
  input.select();
  return new Promise((resolve) => {
    const form = $('#prompt-form');
    form.onsubmit = async (e) => {
      e.preventDefault();
      try {
        const out = await submit(input.value);
        form.onsubmit = null;
        dlg.close('ok');
        resolve(out);
      } catch (err) {
        $('#prompt-error').textContent = err.message;
      }
    };
    dlg.addEventListener('close', () => { form.onsubmit = null; resolve(null); }, { once: true });
  });
}

/* ---------------- folder picker ---------------- */

// Asks which folder. Resolves to a path ('' is Unfiled) or null if dismissed.
// Typing narrows the list; typing a path that does not exist offers to create
// it, so "move these to a new folder" is one step and not two.
export function pickFolder({ title = 'Move to', current = null, exclude = () => false, allowRoot = true } = {}) {
  const dlg = $('#dlg-picker');
  const input = $('#picker-q');
  const list = $('#picker-list');
  $('#picker-title').textContent = title;
  input.value = '';
  let options = [];
  let cur = 0;

  const norm = globalThis.BookmarksSearch.norm;

  function build() {
    const t = store.tree();
    const q = norm(input.value.trim()).replace(/^\/+|\/+$/g, '');
    options = [];
    if (allowRoot && !q) options.push({ path: '', label: 'Unfiled', root: true });
    const scored = [];
    for (const p of t.paths) {
      if (exclude(p)) continue;
      if (!q) { scored.push([0, p]); continue; }
      const np = norm(p);
      const i = np.indexOf(q);
      if (i < 0) continue;
      const name = norm(store.nameOf(p));
      const score = name === q ? 0 : name.startsWith(q) ? 1 : np.startsWith(q) ? 2 : 3;
      scored.push([score, p]);
    }
    scored.sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]));
    for (const [, p] of scored.slice(0, 300)) options.push({ path: p });
    const typed = store.normFolder(input.value);
    if (typed && !t.has(typed) && !exclude(typed)) options.push({ path: typed, create: true });
    cur = 0;
    paint();
  }

  function paint() {
    const t = store.tree();
    list.innerHTML = options.map((o, i) => {
      const cls = ['pick', i === cur ? 'cur' : '', o.create ? 'create' : '', o.path === current ? 'current' : ''].join(' ');
      if (o.create) {
        return `<li class="${cls}" data-i="${i}" role="option">${icon('folder-plus')}<span class="pick-path">Create “${esc(o.path)}”</span></li>`;
      }
      if (o.root) {
        return `<li class="${cls}" data-i="${i}" role="option">${icon('inbox')}<span class="pick-path">Unfiled</span><span class="pick-count">${t.direct('')}</span></li>`;
      }
      const parent = store.parentOf(o.path);
      return `<li class="${cls}" data-i="${i}" role="option">${icon('folder')}<span class="pick-path">${parent ? `<span class="pick-parent">${esc(parent)}/</span>` : ''}${esc(store.nameOf(o.path))}</span><span class="pick-count">${t.total(o.path)}</span></li>`;
    }).join('') || '<li class="pane-empty">No folder matches</li>';
    list.querySelector('.cur')?.scrollIntoView({ block: 'nearest' });
  }

  return new Promise((resolve) => {
    let answer = null;
    const choose = (i) => {
      const o = options[i];
      if (!o) return;
      answer = o;
      dlg.close('ok');
    };
    input.oninput = build;
    input.onkeydown = (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); cur = Math.min(cur + 1, options.length - 1); paint(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); cur = Math.max(cur - 1, 0); paint(); }
      else if (e.key === 'Enter') { e.preventDefault(); choose(cur); }
    };
    list.onclick = (e) => {
      const li = e.target.closest('[data-i]');
      if (li) choose(Number(li.dataset.i));
    };
    dlg.addEventListener('close', async () => {
      input.oninput = input.onkeydown = list.onclick = null;
      if (!answer) return resolve(null);
      if (answer.create) {
        try { await store.createFolder(answer.path); } catch (err) { fail(err); return resolve(null); }
      }
      resolve(answer.path);
    }, { once: true });
    build();
    dlg.showModal();
    input.focus();
  });
}

/* ---------------- dragging ---------------- */
// Native drag and drop, with two payloads: a set of link ids, or a folder path.
// Anything that accepts a drop says which folder it stands for.

const LINKS = 'application/x-bookmark-ids';
const FOLDER = 'application/x-bookmark-folder';
let dragging = null;   // { ids } or { folder }, readable during dragover

export function startLinkDrag(e, ids) {
  dragging = { ids };
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData(LINKS, JSON.stringify(ids));
  e.dataTransfer.setData('text/plain', ids.map((id) => store.get(id)?.url).filter(Boolean).join('\n'));
  if (ids.length > 1) {
    const ghost = document.createElement('div');
    ghost.className = 'drag-ghost';
    ghost.textContent = `${ids.length} links`;
    document.body.append(ghost);
    e.dataTransfer.setDragImage(ghost, 12, 12);
    setTimeout(() => ghost.remove(), 0);
  }
}

// One folder, or several: the Organize page drags every folder marked in a pane.
export function startFolderDrag(e, paths) {
  const folders = [].concat(paths);
  dragging = { folders };
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData(FOLDER, JSON.stringify(folders));
  e.dataTransfer.setData('text/plain', folders.join('\n'));
  if (folders.length > 1) {
    const ghost = document.createElement('div');
    ghost.className = 'drag-ghost';
    ghost.textContent = `${folders.length} folders`;
    document.body.append(ghost);
    e.dataTransfer.setDragImage(ghost, 12, 12);
    setTimeout(() => ghost.remove(), 0);
  }
}

document.addEventListener('dragend', () => {
  dragging = null;
  for (const el of $$('.drop')) el.classList.remove('drop');
});

function canDrop(target) {
  if (!dragging) return false;
  if (dragging.folders) return dragging.folders.every((from) => canDropFolder(from, target));
  return true;
}

// Makes `el` accept drops. `resolve(e)` says what is under the pointer: the
// folder it stands for and the element to light up, or null for nothing. One
// listener per container, however many rows it holds.
export function dropTarget(el, resolve) {
  let lit = null;
  const light = (node) => {
    if (lit === node) return;
    lit?.classList.remove('drop');
    lit = node;
    lit?.classList.add('drop');
  };
  el.addEventListener('dragover', (e) => {
    const hit = resolve(e);
    if (!hit || !canDrop(hit.path)) { light(null); return; }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    light(hit.el);
  });
  el.addEventListener('dragleave', (e) => {
    if (!el.contains(e.relatedTarget)) light(null);
  });
  el.addEventListener('drop', async (e) => {
    const hit = resolve(e);
    light(null);
    if (!hit) return;
    e.preventDefault();
    const ids = e.dataTransfer.getData(LINKS);
    const folders = e.dataTransfer.getData(FOLDER);
    dragging = null;
    try {
      if (ids) await moveLinks(JSON.parse(ids), hit.path);
      else if (folders) {
        const paths = JSON.parse(folders);
        if (paths.every((from) => canDropFolder(from, hit.path))) await moveFoldersTo(paths, hit.path);
      }
    } catch (err) { fail(err); }
  });
}

function canDropFolder(from, to) {
  return to !== from && to !== store.parentOf(from) && !to.startsWith(from + '/');
}

/* ---------------- actions shared by every view ---------------- */

export async function moveLinks(ids, folder) {
  const before = await store.moveMany(ids, folder);
  if (!before.size) return before;
  toast(`Moved ${plural(before.size, 'link')} to ${folderLabel(folder)}`, {
    action: 'Undo',
    onAction: () => store.unmove(before).catch(fail),
  });
  return before;
}

export async function moveFolderTo(from, toParent) {
  const target = await store.moveFolder(from, toParent);
  toast(`Moved ${store.nameOf(from)} to ${folderLabel(toParent)}`, {
    action: 'Undo',
    onAction: () => store.moveFolder(target, store.parentOf(from)).catch(fail),
  });
  return target;
}

// Several folders at once, one after the other, with one toast and one undo
// for all of them. A folder that cannot go (a name already taken there) stops
// the run: the ones before it stay moved and can still be undone.
export async function moveFoldersTo(paths, toParent) {
  if (paths.length === 1) return [await moveFolderTo(paths[0], toParent)];
  const done = [];
  let error = null;
  for (const from of paths) {
    try { done.push([from, await store.moveFolder(from, toParent)]); } catch (err) { error = err; break; }
  }
  if (done.length) {
    toast(`Moved ${plural(done.length, 'folder')} to ${folderLabel(toParent)}`, {
      action: 'Undo',
      onAction: async () => {
        try {
          for (const [from, target] of [...done].reverse()) await store.moveFolder(target, store.parentOf(from));
        } catch (err) { fail(err); }
      },
    });
  }
  if (error) throw error;
  return done.map(([, target]) => target);
}

// `before` runs once the answer is yes and before anything changes on screen.
export async function deleteLinks(ids, { ask = ids.length > 1, before } = {}) {
  if (!ids.length) return [];
  if (ask) {
    const yes = await confirmDialog({
      title: `Delete ${plural(ids.length, 'link')}?`,
      text: 'You can undo this right after.',
    });
    if (!yes) return [];
  }
  before?.();
  const gone = await store.removeMany(ids);
  if (gone.length) {
    toast(`Deleted ${gone.length === 1 ? `“${gone[0].title || hostOf(gone[0].url)}”` : plural(gone.length, 'link')}`, {
      action: 'Undo',
      onAction: () => store.restore(gone).catch(fail),
    });
  }
  return gone;
}

export async function askNewFolder(parent = '') {
  return promptDialog({
    title: 'New folder',
    label: parent ? `Inside ${parent}. Slashes nest it.` : 'Name. Slashes nest it: dev/linux',
    ok: 'Create',
    submit: (v) => store.createFolder(parent ? `${parent}/${v}` : v),
  });
}

export async function askRenameFolder(path) {
  return promptDialog({
    title: 'Rename folder',
    label: 'Name',
    value: store.nameOf(path),
    submit: (v) => store.renameFolder(path, v),
  });
}

export async function askDeleteFolder(path) {
  return askDeleteFolders([path]);
}

// Several folders, and the links marked beside them, under one question. The
// links filed loose are counted apart from the ones the folders carry.
export async function askDeleteFolders(paths, links = []) {
  if (!paths.length) return deleteLinks(links).then((gone) => gone.length > 0);
  const t = store.tree();
  const n = paths.reduce((sum, p) => sum + t.total(p), 0);
  const one = paths.length === 1 && !links.length;
  const parts = [plural(paths.length, 'folder')];
  if (links.length) parts.push(plural(links.length, 'link'));
  const yes = await confirmDialog({
    title: one ? `Delete ${store.nameOf(paths[0])}?` : `Delete ${parts.join(' and ')}?`,
    text: one
      ? (n ? `It holds ${plural(n, 'link')}, and they go with it, along with every folder inside.` : 'The folder is empty.')
      : (n ? `The folders hold ${plural(n, 'link')}, and they go with them, along with every folder inside.` : 'The folders are empty.'),
  });
  if (!yes) return false;
  if (links.length) await deleteLinks(links, { ask: false });
  for (const p of paths) await store.deleteFolder(p);
  toast(`Deleted ${one ? store.nameOf(paths[0]) : plural(paths.length, 'folder')}`);
  return true;
}
