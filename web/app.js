/* Web UI. Strategy: load everything into memory and search locally (instant,
   no round-trip). Writes go to the server and the sync runs in the background
   to converge with the desktop app. */
'use strict';

const $ = (s) => document.querySelector(s);
const API = '';

const state = {
  token: localStorage.getItem('vm_token') || '',
  items: [],          // every live bookmark
  results: [],
  sel: 0,
  editing: null,
  lastSync: 0,
  panelFilter: {},   // filters for the panel lists (they do not filter bookmarks)
  closedFolders: new Set(JSON.parse(localStorage.getItem('vm_closed_folders') || '[]')),
};

/* ---------------- http ---------------- */
async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: {
      'content-type': 'application/json',
      ...(state.token ? { authorization: `Bearer ${state.token}` } : {}),
      ...opts.headers,
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `error ${res.status}`);
  return body;
}

function setSync(text, cls = '') {
  const el = $('#sync-state');
  el.textContent = text;
  el.className = 'sync ' + cls;
}

/* ---------------- auth ---------------- */
let authMode = 'login';

// `fetch` rejects with TypeError("Failed to fetch") for any network failure:
// server down, wrong port, DNS. The raw message says nothing, so the failure is
// classified here before it becomes text.
function isNetworkError(err) {
  return err instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(err.message || '');
}

// It does not ask "is the backend running?", it checks and states. A server
// error (wrong password, duplicate user) goes to the line under the button; a
// network outage turns into the status light and the what-to-do block, without
// repeating the text in three places.
async function reportFailure(err) {
  if (!isNetworkError(err)) {
    $('#auth-error').textContent = err.message;
    return;
  }
  const alive = await checkServer();
  $('#auth-error').textContent = alive ? 'the connection dropped mid-request, try again' : '';
}

function renderAuthMode() {
  const isReg = authMode === 'register';
  $('#w-login').classList.toggle('hidden', isReg);
  $('#f-login').required = !isReg;
  $('#w-email').classList.toggle('hidden', !isReg);
  $('#f-email').required = isReg;
  $('#w-username').classList.toggle('hidden', !isReg);
  $('#f-username').required = isReg;
  $('#pw-hint').classList.toggle('hidden', !isReg);
  $('#auth-submit').textContent = isReg ? 'Create account' : 'Sign in';
  $('#f-password').autocomplete = isReg ? 'new-password' : 'current-password';
  $('#f-password').minLength = isReg ? 6 : 0;
  $('#auth-error').textContent = '';
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.mode === authMode));
  (isReg ? $('#f-email') : $('#f-login')).focus();
}

document.querySelectorAll('.tab').forEach((t) => {
  t.onclick = () => { authMode = t.dataset.mode; renderAuthMode(); };
});

$('#pw-toggle').onclick = () => {
  const field = $('#f-password');
  const showing = field.type === 'text';
  field.type = showing ? 'password' : 'text';
  $('#pw-toggle').classList.toggle('on', !showing);
  $('#pw-toggle').title = showing ? 'Show password' : 'Hide password';
  field.focus();
};

async function signIn(credentials, mode = authMode) {
  const button = $('#auth-submit');
  const caption = button.textContent;
  button.disabled = true;
  button.textContent = mode === 'register' ? 'creating…' : 'signing in…';
  $('#auth-error').textContent = '';
  try {
    const r = await api(`/api/auth/${mode}`, { method: 'POST', body: JSON.stringify(credentials) });
    state.token = r.token;
    localStorage.setItem('vm_token', r.token);
    $('#auth-offline').classList.add('hidden');
    await enterApp();
  } catch (err) {
    await reportFailure(err);
  } finally {
    button.disabled = false;
    button.textContent = caption;
  }
}

$('#auth-form').onsubmit = (e) => {
  e.preventDefault();
  const password = $('#f-password').value;
  return signIn(authMode === 'register'
    ? { email: $('#f-email').value.trim(), username: $('#f-username').value.trim(), password }
    : { login: $('#f-login').value.trim(), password });
};

// Says up front whether the backend answers, instead of waiting for someone to
// mistype a password to find out the problem was something else.
function paintStatus(status, text) {
  const el = $('#auth-status');
  el.className = `status ${status}`;
  $('#auth-status-text').textContent = text;
}

async function checkServer() {
  $('#auth-origin').textContent = location.origin;
  paintStatus('checking', 'checking the backend…');
  try {
    const r = await fetch('/api/health', { cache: 'no-store' });
    const body = await r.json();
    $('#auth-offline').classList.add('hidden');
    paintStatus('up', `backend up at ${location.origin}`);

    const demo = $('#auth-demo');
    if (body.demo?.login) {
      demo.textContent = `sign in to the test account (${body.demo.login})`;
      demo.classList.remove('hidden');
    } else {
      demo.classList.add('hidden');
    }
    return true;
  } catch {
    $('#auth-offline').classList.remove('hidden');
    $('#auth-demo').classList.add('hidden');
    paintStatus('down', `backend down at ${location.origin}`);
    return false;
  }
}

$('#auth-retry').onclick = async () => {
  const btn = $('#auth-retry');
  btn.disabled = true;
  btn.textContent = 'checking…';
  $('#auth-error').textContent = '';
  const ok = await checkServer();
  btn.disabled = false;
  btn.textContent = 'check again';
  // Session still valid + server back up: there is nothing to ask.
  if (ok && state.token) {
    try { await api('/api/me'); await enterApp(); } catch {}
  }
};

$('#auth-demo').onclick = () => signIn({ login: 'teste', password: 'teste123' }, 'login');

$('#btn-logout').onclick = async () => {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
  localStorage.removeItem('vm_token');
  state.token = '';
  state.items = [];
  location.reload();
};

/* ---------------- data ---------------- */
async function loadAll() {
  const r = await api('/api/bookmarks?limit=500');
  state.items = r.items;
  state.lastSync = Date.now();
  refreshDatalists();
  render();
}

// Pulls only what changed since the last sync (including desktop changes).
async function pullChanges() {
  try {
    const r = await api('/api/sync', {
      method: 'POST',
      body: JSON.stringify({ since: state.lastSync, changes: [] }),
    });
    state.lastSync = r.now;
    if (!r.changes.length) return;
    for (const c of r.changes) {
      const i = state.items.findIndex((b) => b.id === c.id);
      if (c.deleted) { if (i >= 0) state.items.splice(i, 1); continue; }
      if (i >= 0) state.items[i] = c; else state.items.unshift(c);
    }
    refreshDatalists();
    render();
    setSync('synced');
  } catch {
    setSync('offline', 'err');
  }
}

function refreshDatalists() {
  const fill = (el, values) => {
    el.innerHTML = '';
    for (const v of [...new Set(values)].filter(Boolean).sort()) {
      const o = document.createElement('option');
      o.value = v;
      el.appendChild(o);
    }
  };
  fill($('#dl-folders'), state.items.map((b) => b.folder));
  fill($('#dl-categories'), state.items.map((b) => b.category));
}

/* ---------------- render ---------------- */
function highlight(text, terms) {
  const frag = document.createDocumentFragment();
  const plain = VMSearch.norm(text);
  const spans = [];
  for (const t of terms) {
    if (!t.value) continue;
    let from = 0, i;
    while ((i = plain.indexOf(t.value, from)) >= 0) {
      spans.push([i, i + t.value.length]);
      from = i + t.value.length;
    }
  }
  spans.sort((a, b) => a[0] - b[0]);
  let cursor = 0;
  for (const [s, e] of spans) {
    if (s < cursor) continue;
    frag.append(text.slice(cursor, s));
    const m = document.createElement('mark');
    m.textContent = text.slice(s, e);
    frag.append(m);
    cursor = e;
  }
  frag.append(text.slice(cursor));
  return frag;
}

function faviconFor(url) {
  try { return `https://icons.duckduckgo.com/ip3/${new URL(url).hostname}.ico`; } catch { return ''; }
}

function iconButton(glyph, title, onClick) {
  const el = document.createElement('button');
  el.className = 'icon-btn';
  el.type = 'button';
  el.textContent = glyph;
  el.title = title;
  el.setAttribute('aria-label', title);
  el.onclick = (e) => { e.stopPropagation(); onClick(); };
  return el;
}

// Toggles a filter (#tag, @category, /folder) while keeping the others, which
// is what allows crossing "@work #k8s" with two clicks.
function toggleToken(token) {
  const current = $('#q').value.trim();
  const parts = current.split(/\s+/).filter(Boolean);
  const i = parts.findIndex((p) => p.toLowerCase() === token.toLowerCase());
  if (i >= 0) parts.splice(i, 1); else parts.push(token);
  setQuery(parts.join(' '));
}

function activeToken(token) {
  return $('#q').value.trim().split(/\s+/).some((p) => p.toLowerCase() === token.toLowerCase());
}

function badge(cls, text, onClick) {
  const el = document.createElement('span');
  el.className = `badge ${cls}`;
  el.textContent = text;
  el.onclick = (e) => { e.stopPropagation(); onClick(); };
  return el;
}

function render() {
  const q = $('#q').value;
  const terms = VMSearch.parseQuery(q);
  // No cap: the panel exists to sweep the whole vault, and cutting at 50 would
  // hide exactly the tail someone is looking for.
  state.results = VMSearch.search(state.items, q, state.items.length || 1);
  if (state.sel >= state.results.length) state.sel = Math.max(0, state.results.length - 1);

  $('#q-clear').classList.toggle('hidden', !q);

  const ul = $('#results');
  ul.innerHTML = '';
  for (const [i, b] of state.results.entries()) {
    const li = document.createElement('li');
    li.className = 'item' + (i === state.sel ? ' sel' : '');
    li.onclick = (e) => { state.sel = i; openSelected(e.ctrlKey || e.metaKey); };
    li.oncontextmenu = (e) => { e.preventDefault(); openModal(b); };

    if (b.url) {
      const img = document.createElement('img');
      img.className = 'favicon';
      img.src = faviconFor(b.url);
      img.onerror = () => { img.style.visibility = 'hidden'; };
      li.append(img);
    }

    const main = document.createElement('div');
    main.className = 'item-main';
    const title = document.createElement('div');
    title.className = 'item-title';
    title.append(highlight(b.title || b.url, terms));
    const url = document.createElement('div');
    url.className = 'item-url';
    url.append(highlight(b.url, terms));
    main.append(title, url);
    li.append(main);

    const meta = document.createElement('div');
    meta.className = 'item-meta';
    if (b.folder) meta.append(badge('folder', '/' + b.folder, () => toggleToken('/' + b.folder)));
    if (b.category) meta.append(badge('cat', '@' + b.category, () => toggleToken('@' + b.category)));
    for (const t of b.tags.split(',').filter(Boolean).slice(0, 3)) {
      meta.append(badge('tag', '#' + t, () => toggleToken('#' + t)));
    }
    li.append(meta);

    // Editing only via right-click and the `e` key is undiscoverable, and on a
    // phone it does not exist at all: that is why the buttons sit on the row.
    const actions = document.createElement('div');
    actions.className = 'item-actions';
    actions.append(
      iconButton('✎', 'Edit', () => openModal(b)),
      iconButton('🗑', 'Delete', () => removeBookmark(b)),
    );
    li.append(actions);
    ul.append(li);
  }

  const total = state.items.length;
  const count = $('#count');
  if (!total) {
    count.textContent = '';
  } else if (state.results.length === total) {
    count.textContent = `${total} bookmark${total > 1 ? 's' : ''}`;
  } else {
    count.textContent = `${state.results.length} of ${total} bookmarks`;
  }

  const empty = $('#empty');
  if (!state.results.length) {
    empty.classList.remove('hidden');
    empty.textContent = state.items.length
      ? `no bookmark matches "${q}"`
      : 'no bookmarks yet: click "+ new" or press n';
  } else {
    empty.classList.add('hidden');
  }

  renderChips();
  renderBrowse();
  document.querySelector('.item.sel')?.scrollIntoView({ block: 'nearest' });
}

// The panel lists EVERYTHING in the vault (folders, categories and tags) with
// how many bookmarks each one has. Sorted by usage, ties broken by name so the
// list does not dance around on every sync.
function facets(values) {
  const counts = new Map();
  for (const v of values) {
    if (!v) continue;
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));
}

function browseSection(heading, prefix, entries, emptyText, filter) {
  const sec = document.createElement('section');
  sec.className = 'facet';

  const h = document.createElement('h3');
  h.textContent = `${heading} (${entries.length})`;
  sec.append(h);
  if (filter) sec.append(filter);

  if (!entries.length) {
    const p = document.createElement('p');
    p.className = 'facet-empty';
    p.textContent = emptyText;
    sec.append(p);
    return sec;
  }

  for (const [name, n] of entries) {
    const token = prefix + name;
    const b = document.createElement('button');
    b.className = 'facet-row' + (activeToken(token) ? ' on' : '');
    b.type = 'button';

    const label = document.createElement('span');
    label.className = 'facet-name';
    label.textContent = name;

    const qty = document.createElement('span');
    qty.className = 'facet-count';
    qty.textContent = n;

    b.append(label, qty);
    b.onclick = () => toggleToken(token);
    sec.append(b);
  }
  return sec;
}

// `dev/k8s` is a single string in the database; the tree exists only on screen.
// A node's total includes its descendants: clicking `dev` filters `dev/*`
// because the search does a substring match on the folder field.
function folderTree(items) {
  const root = new Map();
  for (const b of items) {
    if (!b.folder) continue;
    let level = root;
    let path = '';
    for (const part of b.folder.split('/').filter(Boolean)) {
      path = path ? `${path}/${part}` : part;
      if (!level.has(part)) level.set(part, { name: part, path, total: 0, children: new Map() });
      const node = level.get(part);
      node.total += 1;
      level = node.children;
    }
  }
  return root;
}

function countNodes(level) {
  let n = 0;
  for (const node of level.values()) n += 1 + countNodes(node.children);
  return n;
}

function treeRows(level, depth, destino, filter) {
  for (const node of [...level.values()].sort((a, b) => (b.total - a.total) || a.name.localeCompare(b.name))) {
    // A node stays visible when it matches the filter, or when a descendant does.
    const selfMatch = !filter || VMSearch.norm(node.name).includes(filter);
    const branch = document.createElement('div');
    const children = document.createElement('div');
    if (node.children.size) treeRows(node.children, depth + 1, children, filter);
    if (!selfMatch && !children.childElementCount) continue;

    const token = '/' + node.path;
    const isOpen = !state.closedFolders.has(node.path);

    const linha = document.createElement('div');
    linha.className = 'tree-row';
    linha.style.setProperty('--level', depth);

    if (node.children.size) {
      const arrow = document.createElement('button');
      arrow.type = 'button';
      arrow.className = 'tree-toggle';
      arrow.textContent = isOpen ? '▾' : '▸';
      arrow.title = isOpen ? 'Collapse' : 'Expand';
      arrow.onclick = () => {
        if (isOpen) state.closedFolders.add(node.path); else state.closedFolders.delete(node.path);
        localStorage.setItem('vm_closed_folders', JSON.stringify([...state.closedFolders]));
        renderBrowse();
      };
      linha.append(arrow);
    } else {
      const emptyText = document.createElement('span');
      emptyText.className = 'tree-toggle emptyText';
      linha.append(emptyText);
    }

    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'facet-row tree-item' + (activeToken(token) ? ' on' : '');
    const name = document.createElement('span');
    name.className = 'facet-name';
    name.textContent = node.name;
    const qty = document.createElement('span');
    qty.className = 'facet-count';
    qty.textContent = node.total;
    b.append(name, qty);
    b.onclick = () => toggleToken(token);
    b.title = '/' + node.path;
    linha.append(b);

    branch.append(linha);
    // With a filter on, collapsing the branch would hide exactly what matched.
    if (isOpen || filter) branch.append(children);
    destino.append(branch);
  }
}

function treeSection(root, total, filter) {
  const sec = document.createElement('section');
  sec.className = 'facet';

  const h = document.createElement('h3');
  h.textContent = `Folders (${total})`;
  sec.append(h, filterField('filter-folders', 'filter folders…', renderBrowse));

  if (!total) {
    const p = document.createElement('p');
    p.className = 'facet-empty';
    p.textContent = 'no folders yet';
    sec.append(p);
    return sec;
  }

  const tree = document.createElement('div');
  tree.className = 'tree';
  treeRows(root, 0, tree, filter);
  if (!tree.childElementCount) {
    const p = document.createElement('p');
    p.className = 'facet-empty';
    p.textContent = 'no folder matches the filter';
    sec.append(p);
    return sec;
  }
  sec.append(tree);
  return sec;
}

// A filter over the list itself: it does not touch the bookmark search, it only
// shortens the panel when there are too many categories/tags to scan by eye.
function filterField(id, placeholder, aoMudar) {
  const wrap = document.createElement('div');
  wrap.className = 'facet-search';
  const input = document.createElement('input');
  input.type = 'search';
  input.id = id;
  input.placeholder = placeholder;
  input.autocomplete = 'off';
  input.value = state.panelFilter[id] || '';
  input.oninput = () => { state.panelFilter[id] = input.value; aoMudar(); };
  wrap.append(input);
  return wrap;
}

function renderBrowse() {
  const body = $('#browse-body');
  // Rebuilding the panel on every render would steal focus from whoever is
  // typing in the filter; the caret position is saved and restored at the end.
  const focused = document.activeElement;
  const focusId = focused && focused.closest?.('.facet-search') ? focused.id : null;
  const caret = focusId ? focused.selectionStart : 0;

  body.innerHTML = '';

  const root = folderTree(state.items);
  const tags = state.items.flatMap((b) => b.tags.split(',').filter(Boolean));
  const filterEntries = (list, key) => {
    const term = VMSearch.norm(state.panelFilter[key] || '');
    return term ? list.filter(([name]) => VMSearch.norm(name).includes(term)) : list;
  };

  body.append(
    treeSection(root, countNodes(root), VMSearch.norm(state.panelFilter['filter-folders'] || '')),
    browseSection('Categories', '@', filterEntries(facets(state.items.map((b) => b.category)), 'filter-categories'),
                'no categories yet', filterField('filter-categories', 'filter categories…', renderBrowse)),
    browseSection('Tags', '#', filterEntries(facets(tags), 'filter-tags'),
                'no tags yet', filterField('filter-tags', 'filter tags…', renderBrowse)),
  );

  if (focusId) {
    const target = document.getElementById(focusId);
    if (target) { target.focus(); target.setSelectionRange(caret, caret); }
  }

  $('#browse-clear').classList.toggle('hidden',
    !$('#q').value.trim() && !Object.values(state.panelFilter).some(Boolean));
}

function setBrowseOpen(isOpen) {
  $('#browse').classList.toggle('off', !isOpen);
  $('#btn-browse').setAttribute('aria-expanded', String(isOpen));
  localStorage.setItem('vm_browse', isOpen ? '1' : '0');
}

$('#btn-browse').onclick = () => setBrowseOpen($('#browse').classList.contains('off'));
$('#browse-clear').onclick = () => {
  state.panelFilter = {};
  setQuery('');
};

// Shortcuts: the most used categories and tags become clickable chips.
function renderChips() {
  const counts = new Map();
  for (const b of state.items) {
    if (b.category) counts.set('@' + b.category, (counts.get('@' + b.category) || 0) + 1);
    for (const t of b.tags.split(',').filter(Boolean)) counts.set('#' + t, (counts.get('#' + t) || 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const wrap = $('#chips');
  wrap.innerHTML = '';
  for (const [label, n] of top) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = `${label} ${n}`;
    b.classList.toggle('on', activeToken(label));
    b.onclick = () => toggleToken(label);
    wrap.append(b);
  }
}

function setQuery(v) {
  $('#q').value = v;
  state.sel = 0;
  render();
  $('#q').focus();
}

/* ---------------- actions ---------------- */
function openSelected(newTab = true) {
  const b = state.results[state.sel];
  if (!b?.url) return;
  const url = /^https?:\/\//i.test(b.url) ? b.url : 'https://' + b.url;
  if (newTab) window.open(url, '_blank', 'noopener');
  else location.href = url;
}

function openModal(b = null) {
  state.editing = b;
  $('#modal-title').textContent = b ? 'Edit bookmark' : 'New bookmark';
  $('#b-url').value = b?.url || '';
  $('#b-title').value = b?.title || '';
  $('#b-folder').value = b?.folder || '';
  $('#b-category').value = b?.category || '';
  $('#b-tags').value = b?.tags || '';
  $('#b-description').value = b?.description || '';
  $('#bm-error').textContent = '';
  $('#bm-delete').classList.toggle('hidden', !b);
  $('#modal').classList.remove('hidden');
  ($('#b-url').value ? $('#b-title') : $('#b-url')).focus();
}

function closeModal() {
  $('#modal').classList.add('hidden');
  state.editing = null;
  $('#q').focus();
}

$('#bm-form').onsubmit = async (e) => {
  e.preventDefault();
  const payload = {
    url: $('#b-url').value.trim(),
    title: $('#b-title').value.trim(),
    folder: $('#b-folder').value.trim(),
    category: $('#b-category').value.trim(),
    tags: $('#b-tags').value.trim(),
    description: $('#b-description').value.trim(),
  };
  if (!payload.url && !payload.title) {
    $('#bm-error').textContent = 'enter at least a url or a title';
    return;
  }
  if (!payload.title) payload.title = payload.url.replace(/^https?:\/\//, '').replace(/\/$/, '');

  setSync('saving…', 'saving');
  try {
    const r = state.editing
      ? await api(`/api/bookmarks/${state.editing.id}`, { method: 'PUT', body: JSON.stringify(payload) })
      : await api('/api/bookmarks', { method: 'POST', body: JSON.stringify(payload) });

    const i = state.items.findIndex((b) => b.id === r.item.id);
    if (i >= 0) state.items[i] = r.item; else state.items.unshift(r.item);
    state.lastSync = r.item.updated_at;
    refreshDatalists();
    closeModal();
    render();
    setSync('synced');
  } catch (err) {
    $('#bm-error').textContent = err.message;
    setSync('save failed', 'err');
  }
};

async function removeBookmark(b) {
  if (!b || !confirm(`Delete "${b.title || b.url}"?`)) return;
  setSync('saving…', 'saving');
  try {
    await api(`/api/bookmarks/${b.id}`, { method: 'DELETE' });
    state.items = state.items.filter((x) => x.id !== b.id);
    render();
    setSync('synced');
  } catch (err) {
    setSync('delete failed', 'err');
  }
}

$('#bm-delete').onclick = async () => {
  const b = state.editing;
  closeModal();
  await removeBookmark(b);
};
$('#bm-cancel').onclick = closeModal;
$('#btn-new').onclick = () => openModal();
$('#fab').onclick = () => openModal();
$('#q-clear').onclick = () => setQuery('');
$('#q').oninput = () => { state.sel = 0; render(); };

/* ---------------- keyboard ---------------- */
document.addEventListener('keydown', (e) => {
  if (!$('#io-modal').classList.contains('hidden')) {
    if (e.key === 'Escape') closeIo();
    return;
  }
  if (!$('#modal').classList.contains('hidden')) {
    if (e.key === 'Escape') closeModal();
    return;
  }
  if ($('#app').classList.contains('hidden')) return;

  const inSearch = document.activeElement === $('#q');

  if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
    e.preventDefault();
    state.sel = Math.min(state.sel + 1, state.results.length - 1);
    render();
  } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
    e.preventDefault();
    state.sel = Math.max(state.sel - 1, 0);
    render();
  } else if (e.key === 'Enter' && state.results.length) {
    e.preventDefault();
    openSelected(e.ctrlKey || e.metaKey || true);
  } else if (e.key === 'Escape') {
    if ($('#q').value) setQuery(''); else $('#q').blur();
  } else if (!inSearch && (e.key === 'n' || e.key === '/')) {
    e.preventDefault();
    if (e.key === 'n') openModal(); else $('#q').focus();
  } else if (!inSearch && e.key === 'b') {
    e.preventDefault();
    setBrowseOpen($('#browse').classList.contains('off'));
  } else if (!inSearch && e.key === 'e') {
    e.preventDefault();
    if (state.results[state.sel]) openModal(state.results[state.sel]);
  } else if (e.key === 'Delete') {
    e.preventDefault();
    removeBookmark(state.results[state.sel]);
  } else if (!inSearch && e.key.length === 1) {
    $('#q').focus();
  }
});

/* ---------------- import / export ---------------- */
const io = { content: '', name: '', plan: null };

function fileName(res, fallback) {
  const m = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '');
  return m ? m[1] : fallback;
}

// The download has to go through fetch because the route requires the auth
// header: a plain <a href> would go without a token and get a 401.
async function exportVault(format) {
  const btn = document.querySelector(`[data-export="${format}"]`);
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'baixando…';
  try {
    const res = await fetch(`/api/export?format=${format}`, {
      headers: { authorization: `Bearer ${state.token}` },
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `error ${res.status}`);

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName(res, `vaultmarks.${format}`);
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    $('#io-error').textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

function chosenMode() {
  return document.querySelector('input[name="io-mode"]:checked').value;
}

async function requestPlan({ apply = false } = {}) {
  return api('/api/import', {
    method: 'POST',
    body: JSON.stringify({ content: io.content, mode: chosenMode(), apply }),
  });
}

const LABELS = {
  create: ['new bookmark', 'new bookmarks'],
  update: ['updated bookmark', 'updated bookmarks'],
  same: ['already identical, no change', 'already identical, no change'],
  skip: ['kept as is', 'kept as is'],
  remove: ['removed from the vault', 'removed from the vault'],
};

function renderPlan(plan) {
  io.plan = plan;
  const r = plan.summary;
  const ul = $('#io-summary');
  ul.innerHTML = '';

  for (const key of ['create', 'update', 'skip', 'same', 'remove']) {
    const n = r[key];
    if (!n) continue;
    const li = document.createElement('li');
    li.className = `io-line io-${key}`;
    const count = document.createElement('b');
    count.textContent = n;
    li.append(count, ` ${LABELS[key][n === 1 ? 0 : 1]}`);

    // Titles coming from the imported file: textContent, never innerHTML.
    const examples = (plan.examples[key] || []).slice(0, 3).join(' · ');
    if (examples) {
      const sample = document.createElement('em');
      sample.textContent = examples + (n > 3 ? ' …' : '');
      li.append(sample);
    }
    ul.append(li);
  }

  if (!ul.children.length) {
    ul.innerHTML = '<li class="io-line">nothing to do, the file already matches the vault</li>';
  }

  const warning = $('#io-warn');
  if (r.remove) {
    warning.textContent = `Heads up: ${r.remove} bookmark(s) in the vault are not in the file and will be removed.`;
    warning.classList.remove('hidden');
  } else {
    warning.classList.add('hidden');
  }

  $('#io-apply').disabled = !(r.create || r.update || r.remove);
  $('#io-apply').textContent = r.remove ? 'replace vault' : 'import';
  $('#io-plan').classList.remove('hidden');
}

async function previewFile() {
  if (!io.content) return;
  $('#io-error').textContent = '';
  try {
    renderPlan(await requestPlan({ apply: false }));
  } catch (err) {
    $('#io-error').textContent = err.message;
    $('#io-plan').classList.add('hidden');
    $('#io-apply').disabled = true;
  }
}

function openIo() {
  io.content = '';
  io.name = '';
  io.plan = null;
  $('#io-file').value = '';
  $('#io-filename').textContent = 'no file chosen';
  $('#io-error').textContent = '';
  $('#io-plan').classList.add('hidden');
  $('#io-apply').disabled = true;
  $('#io-modal').classList.remove('hidden');
}

function closeIo() {
  $('#io-modal').classList.add('hidden');
  $('#q').focus();
}

document.querySelectorAll('[data-export]').forEach((b) => {
  b.onclick = () => exportVault(b.dataset.export);
});

$('#io-file').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  io.name = file.name;
  $('#io-filename').textContent = file.name;
  io.content = await file.text();
  await previewFile();
};

document.querySelectorAll('input[name="io-mode"]').forEach((r) => {
  // Switching the mode recomputes the plan: the numbers change in front of the user.
  r.onchange = previewFile;
});

$('#io-apply').onclick = async () => {
  const btn = $('#io-apply');
  btn.disabled = true;
  btn.textContent = 'importing…';
  setSync('importing…', 'saving');
  try {
    const r = await requestPlan({ apply: true });
    await loadAll();
    setSync('synced');
    closeIo();
    const n = r.summary.create + r.summary.update + r.summary.remove;
    setSync(`${n} bookmark(s) changed`);
    setTimeout(() => setSync('synced'), 4000);
  } catch (err) {
    $('#io-error').textContent = err.message;
    setSync('import failed', 'err');
    btn.disabled = false;
    btn.textContent = 'import';
  }
};

$('#btn-io').onclick = openIo;
$('#io-close').onclick = closeIo;

/* ---------------- pwa ---------------- */
// A phone screen cuts the long placeholder in the middle of a word.
function fitPlaceholder() {
  $('#q').placeholder = window.matchMedia('(max-width: 640px)').matches
    ? 'search…  #tag  @cat  /folder'
    : 'search…  #tag  @category  /folder  -exclude';
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // A service worker only exists in a secure context: https or localhost. On
  // http://<lan-ip> the browser ignores it, which is why the compose adds TLS.
  if (!window.isSecureContext) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

// Sharing a page from the phone browser lands here (the manifest's
// share_target): /?url=...&title=... opens the modal already filled in.
function pendingShare() {
  const p = new URLSearchParams(location.search);
  const url = p.get('url') || '';
  const text = p.get('text') || '';
  const title = p.get('title') || '';
  if (!url && !text && !title) return null;

  // Android usually sends the URL inside `text` instead of `url`.
  const fromText = /https?:\/\/\S+/.exec(text);
  return {
    url: url || (fromText ? fromText[0] : ''),
    title: title || (fromText ? text.replace(fromText[0], '').trim() : text),
  };
}

/* ---------------- boot ---------------- */
// Allows opening straight into a search: /#q=%23devops
function queryFromHash() {
  const m = /^#q=(.*)$/.exec(location.hash);
  return m ? decodeURIComponent(m[1]) : '';
}

async function enterApp() {
  $('#auth').classList.add('hidden');
  $('#app').classList.remove('hidden');
  await loadAll();

  const shared = pendingShare();
  if (shared) {
    openModal();
    $('#b-url').value = shared.url;
    $('#b-title').value = shared.title;
    // Clears the query string so an F5 does not reopen the modal.
    history.replaceState(null, '', location.pathname);
  } else if (location.hash === '#new') {
    openModal();
    history.replaceState(null, '', location.pathname);
  }

  const initial = queryFromHash();
  if (initial) setQuery(initial);
  window.addEventListener('hashchange', () => setQuery(queryFromHash()));
  if (!shared) $('#q').focus();
  setInterval(pullChanges, 5000);
  window.addEventListener('focus', pullChanges);
}

function showLogin() {
  $('#app').classList.add('hidden');
  $('#auth').classList.remove('hidden');
  $('#f-login').focus();
  checkServer();
}

(async function boot() {
  registerServiceWorker();
  fitPlaceholder();
  window.addEventListener('resize', fitPlaceholder);
  renderAuthMode();
  // On a phone the panel starts closed: there it pushes the results down.
  const choice = localStorage.getItem('vm_browse');
  setBrowseOpen(choice === null ? window.innerWidth >= 900 : choice === '1');
  if (!state.token) return showLogin();

  // Only an invalid token ends the session. A server that is down does not:
  // clearing the token there would force retyping the password over a restart.
  try {
    await api('/api/me');
  } catch (err) {
    const network = err instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(err.message || '');
    if (!network) {
      localStorage.removeItem('vm_token');
      state.token = '';
    }
    return showLogin();
  }
  await enterApp();
})();
