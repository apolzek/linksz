// The folder tree in the sidebar. Clicking a folder narrows the link list, or
// opens it in the organizer when that is the page on screen. Everything in it
// is a drop target, and every folder can be dragged onto another.

import * as store from './store.js';
import { $, esc, icon, dropTarget, startFolderDrag } from './ui.js';

const OPEN_KEY = 'bookmarks_open_folders';

let open = new Set();
try { open = new Set(JSON.parse(localStorage.getItem(OPEN_KEY) || '[]')); } catch { /* all closed */ }

let onPick = () => {};
let active = () => null;

function saveOpen() {
  try { localStorage.setItem(OPEN_KEY, JSON.stringify([...open])); } catch { /* fine */ }
}

function nodeHTML(path, depth, t, on) {
  const kids = t.children(path);
  const isOpen = open.has(path);
  let html = `<div class="node${on === path ? ' on' : ''}" data-folder="${esc(path)}" draggable="true" role="treeitem"
      aria-expanded="${kids.length ? isOpen : ''}" style="padding-left:${4 + depth * 14}px" title="${esc(path)}">
    <span class="twisty${kids.length ? (isOpen ? ' open' : '') : ' leaf'}" data-toggle>${icon('chev')}</span>
    ${icon('folder')}<span class="node-name">${esc(store.nameOf(path))}</span><span class="node-count">${t.total(path)}</span></div>`;
  if (isOpen) for (const k of kids) html += nodeHTML(k, depth + 1, t, on);
  return html;
}

export function paint() {
  const t = store.tree();
  const on = active();
  // The folder on screen is always visible: its parents open up.
  if (on) {
    let a = store.parentOf(on);
    while (a) { open.add(a); a = store.parentOf(a); }
  }
  let html = `<div class="node${on === '' ? ' on' : ''}" data-folder="" role="treeitem" style="padding-left:4px">
    <span class="twisty leaf"></span>${icon('inbox')}<span class="node-name">Unfiled</span><span class="node-count">${t.direct('')}</span></div>`;
  for (const p of t.children('')) html += nodeHTML(p, 0, t, on);
  $('#tree').innerHTML = html;
  $('#nav-count').textContent = store.count().toLocaleString();
}

export function init({ pick, current }) {
  onPick = pick;
  active = current;
  const el = $('#tree');

  el.addEventListener('click', (e) => {
    const node = e.target.closest('.node');
    if (!node) return;
    const path = node.dataset.folder;
    if (e.target.closest('[data-toggle]') && path) {
      if (open.has(path)) open.delete(path); else open.add(path);
      saveOpen();
      paint();
      return;
    }
    onPick(path);
  });

  el.addEventListener('dragstart', (e) => {
    const node = e.target.closest('.node');
    if (node && node.dataset.folder) startFolderDrag(e, node.dataset.folder);
  });

  // Hovering a closed folder while dragging opens it, so a drop can reach the
  // folders inside without letting go first.
  let hoverTimer = null;
  let hovered = null;
  el.addEventListener('dragover', (e) => {
    const node = e.target.closest('.node');
    const path = node?.dataset.folder;
    if (path === hovered) return;
    hovered = path;
    clearTimeout(hoverTimer);
    if (path && !open.has(path) && store.tree().children(path).length) {
      hoverTimer = setTimeout(() => { open.add(path); saveOpen(); paint(); }, 700);
    }
  });

  dropTarget(el, (e) => {
    const node = e.target.closest('.node');
    return node ? { path: node.dataset.folder, el: node } : null;
  });

  store.subscribe(paint);
}
