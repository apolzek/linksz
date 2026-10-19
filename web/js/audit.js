// The audit page: every change to a link (added, edited, moved, deleted,
// restored) and every click, newest first, a page at a time.

import { api } from './http.js';
import { $, $$, esc, hostOf, folderLabel } from './ui.js';
import { flush } from './clicklog.js';

const PAGE = 100;

const state = { tab: 'changes', action: '', q: '', next: null, loading: false };

const ACTION = {
  create: 'Added', edit: 'Edited', move: 'Moved', delete: 'Deleted', restore: 'Restored',
};
const FIELD = {
  title: 'Title', url: 'URL', folder: 'Folder', category: 'Category', tags: 'Tags', description: 'Description',
};

const pad = (n) => String(n).padStart(2, '0');

// Local time, to the second, in an order that sorts and scans.
export function stamp(at) {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const short = (s, max = 80) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

function detailHTML(r) {
  if (r.action === 'move') {
    const [from, to] = r.changes.folder || [];
    return `<span class="aud-from">${esc(folderLabel(from))}</span> → <span class="aud-to">${esc(folderLabel(to))}</span>`;
  }
  if (r.action === 'edit') {
    return Object.entries(r.changes).map(([f, [a, b]]) => `<div class="aud-field"><b>${esc(FIELD[f] || f)}</b>
      <span class="aud-from">${esc(short(a) || '(empty)')}</span> → <span class="aud-to">${esc(short(b) || '(empty)')}</span></div>`).join('');
  }
  return `<span class="muted">in ${esc(folderLabel(r.folder))}</span>`;
}

function changeHTML(r) {
  const name = r.title || hostOf(r.url) || r.url;
  return `<tr>
    <td class="aud-when">${stamp(r.at)}</td>
    <td><span class="aud-badge aud-${esc(r.action)}">${esc(ACTION[r.action] || r.action)}</span></td>
    <td class="aud-link"><a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer" title="${esc(r.url)}">${esc(name)}</a>
      <span class="muted">${esc(hostOf(r.url))}</span></td>
    <td class="aud-detail">${detailHTML(r)}</td>
    <td class="aud-via muted">${esc(r.via)}</td>
  </tr>`;
}

function clickHTML(c) {
  return `<tr>
    <td class="aud-when">${stamp(c.at)}</td>
    <td class="aud-route">${esc(c.route)}</td>
    <td class="aud-label">${esc(c.label) || '<span class="muted">(no text)</span>'}</td>
    <td class="aud-target muted"><code>${esc(c.target)}</code>${c.href && !c.href.startsWith('#') ? ` <a href="${esc(c.href)}" target="_blank" rel="noopener noreferrer">${esc(hostOf(c.href))}</a>` : ''}</td>
  </tr>`;
}

const HEAD = {
  changes: '<tr><th>When</th><th>What</th><th>Link</th><th>Details</th><th>Via</th></tr>',
  clicks: '<tr><th>When</th><th>Page</th><th>Clicked</th><th>Element</th></tr>',
};

async function load({ more = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  const body = $('#audit-rows');
  if (!more) {
    state.next = null;
    $('#audit-head').innerHTML = HEAD[state.tab];
    body.innerHTML = '';
  }
  const params = new URLSearchParams({ limit: String(PAGE) });
  if (more && state.next) params.set('before', String(state.next));
  if (state.q) params.set('q', state.q);
  if (state.tab === 'changes' && state.action) params.set('action', state.action);
  try {
    if (state.tab === 'clicks') await flush();
    const r = await api(`/api/audit/${state.tab}?${params}`);
    body.insertAdjacentHTML('beforeend', r.items.map(state.tab === 'changes' ? changeHTML : clickHTML).join(''));
    state.next = r.next;
    $('#audit-error').textContent = '';
  } catch (err) {
    $('#audit-error').textContent = err.message;
  } finally {
    state.loading = false;
  }
  const empty = !body.children.length;
  $('#audit-empty').hidden = !empty;
  $('#audit-empty').textContent = state.q || state.action ? 'Nothing matches.'
    : state.tab === 'changes' ? 'No link has been added, edited, moved or deleted yet.' : 'No clicks recorded yet.';
  $('#audit-table').hidden = empty;
  $('#audit-more').hidden = !state.next;
}

function paintTabs() {
  for (const b of $$('#audit-tab button')) b.classList.toggle('on', b.dataset.tab === state.tab);
  for (const b of $$('#audit-action button')) b.classList.toggle('on', b.dataset.action === state.action);
  $('#audit-action').hidden = state.tab !== 'changes';
  $('#audit-q').placeholder = state.tab === 'changes' ? 'Filter by title, address or folder' : 'Filter by page, text or element';
}

export function init() {
  for (const b of $$('#audit-tab button')) {
    b.onclick = () => {
      // A filter written for one list means nothing to the other.
      state.tab = b.dataset.tab;
      state.q = '';
      state.action = '';
      $('#audit-q').value = '';
      paintTabs();
      load();
    };
  }
  for (const b of $$('#audit-action button')) {
    b.onclick = () => { state.action = b.dataset.action; paintTabs(); load(); };
  }
  let timer = 0;
  $('#audit-q').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => { state.q = e.target.value.trim(); load(); }, 250);
  });
  $('#audit-more').onclick = () => load({ more: true });
  $('#audit-refresh').onclick = async () => { await flush(); load(); };
  paintTabs();
}

export async function show() {
  // The click that brought the page up is in the queue: send it first, so the
  // list starts with it.
  await flush();
  load();
}
