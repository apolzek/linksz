// The one form a link has: new or edit.

import * as store from './store.js';
import { $, icon, folderLabel, pickFolder, deleteLinks, undoable, fail, wireDialog, hostOf } from './ui.js';

let editing = null;   // the bookmark being edited, null for a new one
let folder = '';

function paintFolder() {
  $('#e-folder').innerHTML = `${icon(folder ? 'folder' : 'inbox')}<span>${folderLabel(folder)}</span>${icon('chev-down', 'chev')}`;
}

function fillCategories() {
  const seen = new Set();
  for (const b of store.all()) if (b.category) seen.add(b.category);
  $('#dl-categories').innerHTML = [...seen].sort().map((c) => `<option value="${c.replace(/"/g, '&quot;')}">`).join('');
}

// A bare domain is a link to it. Saving `example.com` as a relative URL would
// open /example.com on this app.
function withScheme(url) {
  const u = url.trim();
  if (!u || /^[a-z][a-z0-9+.-]*:/i.test(u)) return u;
  return `https://${u}`;
}

export function openEditor(b = null, defaults = {}) {
  editing = b;
  const dlg = $('#dlg-edit');
  $('#edit-title').textContent = b ? 'Edit link' : 'New link';
  $('#e-url').value = b ? b.url : defaults.url || '';
  $('#e-title').value = b ? b.title : defaults.title || '';
  $('#e-tags').value = b ? (b.tags || '').split(',').filter(Boolean).join(', ') : '';
  $('#e-category').value = b ? b.category || '' : '';
  $('#e-description').value = b ? b.description || '' : '';
  $('#edit-error').textContent = '';
  $('#edit-delete').hidden = !b;
  folder = b ? b.folder || '' : defaults.folder || '';
  paintFolder();
  fillCategories();
  dlg.showModal();
  (b ? $('#e-title') : $('#e-url')).focus();
}

async function save() {
  const fields = {
    url: withScheme($('#e-url').value),
    title: $('#e-title').value.trim(),
    folder,
    tags: $('#e-tags').value,
    category: $('#e-category').value,
    description: $('#e-description').value,
  };
  if (!fields.url && !fields.title) {
    $('#edit-error').textContent = 'A link needs at least a URL or a title.';
    return;
  }
  if (!fields.title) fields.title = hostOf(fields.url);
  const was = editing;
  $('#dlg-edit').close('saved');
  try {
    if (was) {
      const prev = Object.fromEntries(Object.keys(fields).map((k) => [k, was[k] ?? '']));
      await store.update(was.id, fields);
      undoable(`Edited “${fields.title}”`, () => store.update(was.id, prev));
    } else {
      const b = await store.create(fields);
      undoable(`Saved to ${folderLabel(folder)}`, () => store.removeMany([b.id]));
    }
  } catch (err) {
    fail(err);
  }
}

export function initEditor() {
  const dlg = $('#dlg-edit');
  wireDialog(dlg);
  $('#edit-form').addEventListener('submit', (e) => {
    e.preventDefault();
    save();
  });
  $('#e-folder').onclick = async () => {
    const picked = await pickFolder({ title: 'Folder', current: folder });
    // The picker is its own modal: coming back puts this one on top again.
    if (picked != null) { folder = picked; paintFolder(); }
  };
  $('#edit-delete').onclick = async () => {
    const b = editing;
    dlg.close('deleted');
    if (b) deleteLinks([b.id], { ask: false }).catch(fail);
  };
}
