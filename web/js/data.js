// Import and export. Importing is two steps: the server first says what the
// file would do, nothing is written, and only then is it applied.

import { api, getToken } from './http.js';
import * as store from './store.js';
import { $, $$, esc, plural, toast, fail } from './ui.js';

const io = { content: '', source: 'native', plan: null };

function fileName(res, fallback) {
  const m = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '');
  return m ? m[1] : fallback;
}

// Through fetch, because the route needs the token: a plain link would go
// without it and get a 401.
async function exportVault(btn) {
  const format = btn.dataset.export;
  btn.disabled = true;
  try {
    const res = await fetch(`/api/export?format=${format}`, { headers: { authorization: `Bearer ${getToken()}` } });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `error ${res.status}`);
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName(res, `bookmarks.${format}`);
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    fail(err);
  } finally {
    btn.disabled = false;
  }
}

const mode = () => document.querySelector('input[name="io-mode"]:checked').value;

function request(apply) {
  return api('/api/import', {
    method: 'POST',
    body: {
      content: io.content,
      mode: mode(),
      apply,
      source: io.source,
      folderPrefix: io.source === 'browser' ? $('#io-prefix').value : '',
    },
  });
}

const LINES = {
  create: 'new', update: 'updated', skip: 'kept as they are', same: 'already identical', remove: 'removed from the vault',
};

function paintPlan(plan) {
  io.plan = plan;
  const f = plan.file || {};
  const parts = [plural(f.count || 0, 'link'), plural(f.folders || 0, 'folder')];
  if (f.unfiled) parts.push(`${f.unfiled} in no folder`);
  parts.push(f.tagged ? `${f.tagged} with tags` : 'no tags');
  if (f.prefix) parts.push(`all under ${f.prefix}`);
  $('#io-stats').textContent = `The file has ${parts.join(' · ')}.`;

  const r = plan.summary;
  $('#io-summary').innerHTML = ['create', 'update', 'skip', 'same', 'remove'].filter((k) => r[k]).map((k) => {
    const ex = (plan.examples[k] || []).slice(0, 3).join(' · ');
    return `<li><b>${r[k].toLocaleString()}</b> ${LINES[k]}${ex ? `<em>${esc(ex)}${r[k] > 3 ? ' …' : ''}</em>` : ''}</li>`;
  }).join('') || '<li>Nothing to do: the vault already matches the file.</li>';

  $('#io-warn').hidden = !r.remove;
  if (r.remove) $('#io-warn').textContent = `${plural(r.remove, 'link')} in the vault ${r.remove === 1 ? 'is' : 'are'} not in the file and will be removed.`;
  // A greyed-out button with no reason reads as broken: say why there is
  // nothing to press, and what would make a difference.
  const changes = r.create || r.update || r.remove;
  $('#io-none').hidden = Boolean(changes);
  if (!changes) {
    $('#io-none').textContent = mode() === 'replace'
      ? 'Every link in the file is already here, and nothing else is in the vault.'
      : 'Every link in the file is already in the vault, exactly as it is. Nothing to import.';
  }
  const btn = $('#io-apply');
  btn.disabled = !changes;
  btn.textContent = !changes ? 'Nothing to import' : r.remove ? 'Replace the vault' : 'Import';
  btn.className = r.remove ? 'btn danger' : 'btn primary';
  $('#io-plan').hidden = false;
}

async function preview() {
  if (!io.content) return;
  $('#io-error').textContent = '';
  try {
    paintPlan(await request(false));
  } catch (err) {
    $('#io-error').textContent = err.message;
    $('#io-plan').hidden = true;
  }
}

function reset() {
  io.content = '';
  io.plan = null;
  $('#io-file').value = '';
  $('#io-filename').textContent = 'or drop it here';
  $('#io-error').textContent = '';
  $('#io-plan').hidden = true;
}

// The two files can do different things, so the form asks different
// questions: only a browser tree can go under a folder of your own, and only a
// vault file may replace the vault.
function setSource(source) {
  io.source = source;
  for (const b of $$('#io-source button')) b.classList.toggle('on', b.dataset.source === source);
  $('#io-prefix-row').hidden = source !== 'browser';
  $('#io-mode-replace').hidden = source === 'browser';
  if (source === 'browser' && mode() === 'replace') document.querySelector('input[name="io-mode"][value="add"]').checked = true;
  // No filter for browsers: Chrome's own profile file has no extension at all.
  $('#io-file').accept = source === 'browser' ? '' : '.yaml,.yml,.json,application/json';
  reset();
}

async function take(file) {
  if (!file) return;
  $('#io-filename').textContent = file.name;
  io.content = await file.text();
  preview();
}

export function init() {
  for (const b of $$('[data-export]')) b.onclick = () => exportVault(b);
  for (const b of $$('#io-source button')) b.onclick = () => setSource(b.dataset.source);
  $('#io-file').onchange = (e) => take(e.target.files[0]);
  for (const r of $$('input[name="io-mode"]')) r.onchange = preview;

  const drop = $('#io-drop');
  drop.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); drop.classList.add('drop'); } });
  drop.addEventListener('dragleave', () => drop.classList.remove('drop'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('drop'); take(e.dataTransfer.files[0]); });

  let timer = null;
  $('#io-prefix').oninput = () => { clearTimeout(timer); timer = setTimeout(preview, 400); };
  $('#io-prefix-dated').onclick = () => {
    $('#io-prefix').value = `Imported-${new Date().toISOString().slice(0, 10)}`;
    preview();
  };

  $('#io-apply').onclick = async () => {
    const btn = $('#io-apply');
    btn.disabled = true;
    btn.textContent = 'Importing…';
    try {
      const r = await request(true);
      await store.reload();
      const n = r.summary.create + r.summary.update + r.summary.remove;
      toast(`Import done: ${plural(n, 'link')} changed`);
      reset();
    } catch (err) {
      $('#io-error').textContent = err.message;
      btn.disabled = false;
      btn.textContent = 'Import';
    }
  };
  setSource('native');
}
