// Sorting Temporary: one link at a time, with the folders it probably belongs
// in. Everything saved in a hurry (the address prefix, the extension, a paste,
// the desktop shortcut) lands in Temporary, and this is how it leaves.
//
//   Enter        the first suggestion       1 2 3   that suggestion
//   m            another folder             p       preview the link
//   s or →       skip it for now            Del     delete it
//   Esc          stop
//
// Each move and delete is the usual one, with its own undo in the toast.

import * as store from './store.js';
import { $, esc, favicon, hostOf, folderLabel, moveLinks, deleteLinks, pickFolder, fail, stamp, wireDialog } from './ui.js';
import { TEMP_FOLDER } from './address.js';
import { suggestFolders } from './suggest.js';
import { openPreview } from './preview.js';

const state = { queue: [], index: 0, suggestions: [], busy: false };

const current = () => state.queue[state.index] || null;

export function pending() {
  return store.inFolder(TEMP_FOLDER).length;
}

export function openTriage() {
  // Oldest first: what has waited longest is what is most forgotten.
  state.queue = store.inFolder(TEMP_FOLDER).sort((a, b) => a.created_at - b.created_at).map((b) => b.id);
  state.index = 0;
  const dlg = $('#dlg-triage');
  paint();
  if (!dlg.open) dlg.showModal();
}

function paint() {
  // A link that left Temporary some other way (another device, the list
  // behind the dialog) is passed over.
  while (state.index < state.queue.length) {
    const b = store.get(state.queue[state.index]);
    if (b && (b.folder || '') === TEMP_FOLDER) break;
    state.index += 1;
  }
  const b = current() && store.get(current());
  const body = $('#triage-body');
  $('#triage-progress').textContent = b ? `${state.index + 1} of ${state.queue.length}` : '';
  if (!b) {
    state.suggestions = [];
    body.innerHTML = `<div class="triage-done"><b>Temporary is sorted</b>
      <p class="muted">Nothing left waiting. New links saved in a hurry land there again.</p>
      <button type="button" class="btn primary" data-close>Done</button></div>`;
    body.querySelector('[data-close]').onclick = () => $('#dlg-triage').close();
    return;
  }
  state.suggestions = suggestFolders(b, store.all(), { exclude: [TEMP_FOLDER] });
  body.innerHTML = `<div class="triage-link">
      ${favicon(b.url, b.title)}
      <div class="triage-main">
        <a class="triage-title" href="${esc(b.url)}" target="_blank" rel="noopener noreferrer">${esc(b.title || hostOf(b.url) || b.url)}</a>
        <span class="muted">${esc(hostOf(b.url))} · saved ${stamp(b.created_at)}</span>
      </div>
    </div>
    <p class="label">${state.suggestions.length ? 'Probably goes in' : 'No folder looks like it yet'}</p>
    <div class="triage-suggestions">
      ${state.suggestions.map((f, i) => `<button type="button" class="btn${i === 0 ? ' primary' : ''}" data-folder="${esc(f)}">
        <kbd>${i === 0 ? 'Enter' : i + 1}</kbd><span>${esc(folderLabel(f))}</span></button>`).join('')}
      <button type="button" class="btn" data-act="pick"><kbd>m</kbd><span>Another folder…</span></button>
    </div>
    <div class="triage-actions">
      <button type="button" class="btn" data-act="preview"><kbd>p</kbd>Preview</button>
      <button type="button" class="btn" data-act="skip"><kbd>s</kbd>Skip</button>
      <span class="spacer"></span>
      <button type="button" class="btn danger-text" data-act="delete"><kbd>Del</kbd>Delete</button>
    </div>`;
}

async function act(run) {
  if (state.busy) return;
  state.busy = true;
  try { await run(); } catch (err) { fail(err); } finally { state.busy = false; }
  state.index += 1;
  paint();
}

const fileIn = (folder) => act(() => moveLinks([current()], folder));

async function pickAnother() {
  const id = current();
  if (!id) return;
  const folder = await pickFolder({ title: 'Move link to', current: TEMP_FOLDER });
  // The picker is a dialog of its own; the triage is still open under it.
  if (folder == null || folder === TEMP_FOLDER) return;
  fileIn(folder);
}

function onKey(e) {
  // A dialog stacked on top (the folder picker, a preview) owns the keys.
  if (e.target.closest('dialog') !== $('#dlg-triage') || !current()) return;
  const k = e.key;
  if (k === 'Enter' && state.suggestions[0]) { e.preventDefault(); fileIn(state.suggestions[0]); return; }
  if (/^[1-3]$/.test(k) && state.suggestions[Number(k) - 1]) { e.preventDefault(); fileIn(state.suggestions[Number(k) - 1]); return; }
  if (k === 'm') { e.preventDefault(); pickAnother(); return; }
  if (k === 'p') { e.preventDefault(); openPreview(store.get(current())); return; }
  if (k === 's' || k === 'ArrowRight') { e.preventDefault(); act(async () => {}); return; }
  if (k === 'Delete') { e.preventDefault(); act(() => deleteLinks([current()])); }
}

export function init() {
  const dlg = $('#dlg-triage');
  wireDialog(dlg);
  dlg.addEventListener('keydown', onKey);
  // Buttons are not wired one by one: the body is redrawn for every link.
  $('#triage-body').addEventListener('click', (e) => {
    const folder = e.target.closest('[data-folder]')?.dataset.folder;
    if (folder != null) { fileIn(folder); return; }
    const what = e.target.closest('[data-act]')?.dataset.act;
    if (what === 'pick') pickAnother();
    else if (what === 'preview') openPreview(store.get(current()));
    else if (what === 'skip') act(async () => {});
    else if (what === 'delete') act(() => deleteLinks([current()]));
  });
}
