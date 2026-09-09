/* Web UI. Strategy: load everything into memory and search locally (instant,
   no round-trip). Writes go to the server and the sync runs in the background,
   so two tabs or two browsers converge on the same vault. */
'use strict';

const $ = (s) => document.querySelector(s);
const API = '';

// The browser storage keys were prefixed vm_ when the project had another name.
// This carries over what is already on the machine (session, theme, history)
// once, so renaming the project does not sign anyone out.
(function renameStorageKeys() {
  const keys = ['token', 'theme', 'closed_folders', 'closed_sections', 'expanded_facets', 'history', 'browse'];
  try {
    for (const k of keys) {
      const old = localStorage.getItem('vm_' + k);
      if (old !== null && localStorage.getItem('bookmarks_' + k) === null) {
        localStorage.setItem('bookmarks_' + k, old);
      }
      if (old !== null) localStorage.removeItem('vm_' + k);
    }
  } catch { /* storage blocked: nothing to carry over */ }
})();

const state = {
  token: localStorage.getItem('bookmarks_token') || '',
  items: [],          // every live bookmark
  // The folders written down on the server. The tree the panel draws is these
  // plus the ones the bookmarks imply, so a folder holding nothing still shows.
  folders: [],
  results: [],
  sel: 0,
  editing: null,
  editingFolder: null,   // the folder the folder modal is renaming, null when creating
  lastSync: 0,
  panelFilter: {},   // filters for the panel lists (they do not filter bookmarks)
  closedFolders: new Set(JSON.parse(localStorage.getItem('bookmarks_closed_folders') || '[]')),
  closedSections: new Set(JSON.parse(localStorage.getItem('bookmarks_closed_sections') || '[]')),
  helpOpen: false,
  // Flat lists (categories, tags) start capped: 1798 tags in one column is a
  // scroll, not a panel. `expand all` lifts the cap.
  expandedFacets: new Set(JSON.parse(localStorage.getItem('bookmarks_expanded_facets') || '[]')),
  // [{ q, n, t }]: the query, how many times it was used, when it was last used.
  history: JSON.parse(localStorage.getItem('bookmarks_history') || '[]'),
  suggestOff: false,   // hidden until the next keystroke (Esc, or one was picked)
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

/* ---------------- search history ---------------- */
// The last searches, ranked by how often they were used. Kept in the browser:
// it is a habit, not vault data, and it never leaves this device.
const HISTORY_KEEP = 50;    // how many are stored
const HISTORY_SHOW = 10;    // how many are offered at once

function rememberQuery(raw) {
  const q = String(raw).trim();
  // Two characters is where a search starts being a search, and `help` is a
  // command, not one.
  if (q.length < 2 || BookmarksSearch.norm(q) === 'help') return;

  const i = state.history.findIndex((h) => h.q === q);
  if (i >= 0) state.history[i] = { q, n: state.history[i].n + 1, t: Date.now() };
  else state.history.push({ q, n: 1, t: Date.now() });

  // Most used first, ties by recency, and the tail falls off.
  state.history.sort((a, b) => (b.n - a.n) || (b.t - a.t));
  state.history = state.history.slice(0, HISTORY_KEEP);
  localStorage.setItem('bookmarks_history', JSON.stringify(state.history));
}

function forgetQuery(q) {
  state.history = state.history.filter((h) => h.q !== q);
  localStorage.setItem('bookmarks_history', JSON.stringify(state.history));
}

function renderSuggest() {
  const box = $('#suggest');
  const typed = $('#q').value.trim();
  const term = BookmarksSearch.norm(typed);
  box.innerHTML = '';

  // Only while typing, and never offering back exactly what is already there.
  const matches = (!state.suggestOff && term)
    ? state.history.filter((h) => BookmarksSearch.norm(h.q).includes(term) && h.q !== typed).slice(0, HISTORY_SHOW)
    : [];
  box.classList.toggle('hidden', !matches.length);
  if (!matches.length) return;

  for (const h of matches) {
    const li = document.createElement('li');
    li.className = 'suggest-row';

    const use = document.createElement('button');
    use.type = 'button';
    use.className = 'suggest-use';
    use.append(highlight(h.q, BookmarksSearch.parseQuery(typed)));
    use.onmousedown = (e) => e.preventDefault();     // keeps the field focused
    use.onclick = () => { state.suggestOff = true; setQuery(h.q); };

    const drop = document.createElement('button');
    drop.type = 'button';
    drop.className = 'suggest-drop';
    drop.textContent = '×';
    drop.title = 'Forget this search';
    drop.onmousedown = (e) => e.preventDefault();
    drop.onclick = () => { forgetQuery(h.q); renderSuggest(); };

    li.append(use, drop);
    box.append(li);
  }
}

/* ---------------- theme ---------------- */
// `auto` follows the system; the rest are the Catppuccin flavours declared in
// style.css. The value is read again in the <head> so the choice survives a
// reload without a flash of the default palette.
const THEMES = ['auto', 'latte', 'frappe', 'macchiato', 'mocha', 'matrix'];

function applyTheme(name) {
  const theme = THEMES.includes(name) ? name : 'auto';
  const root = document.documentElement;
  if (theme === 'auto') delete root.dataset.theme; else root.dataset.theme = theme;
  try { localStorage.setItem('bookmarks_theme', theme); } catch {}
  // The browser chrome (address bar, task switcher) reads this tag, and only
  // the computed value knows which palette actually won.
  const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
  if (bg) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg);
}

function setupTheme() {
  let saved = 'auto';
  try { saved = localStorage.getItem('bookmarks_theme') || 'auto'; } catch {}
  const select = $('#theme');
  select.value = THEMES.includes(saved) ? saved : 'auto';
  select.onchange = () => applyTheme(select.value);
  // On `auto`, the system flipping to light changes --bg under our feet.
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (!document.documentElement.dataset.theme) applyTheme('auto');
  });
  applyTheme(select.value);
}

setupTheme();

// The light only lights up when there is something to say. `synced` is where it
// sits almost all the time, and a badge that is always on says nothing; what
// this element is actually for is work in progress, a failure, and the one-off
// notes like "moved to /x". Those still show.
function setSync(text, cls = '') {
  const el = $('#sync-state');
  el.textContent = text;
  el.className = 'sync ' + cls;
  el.classList.toggle('hidden', text === 'synced');
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
    localStorage.setItem('bookmarks_token', r.token);
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
// mistype a password to find out the problem was something else. A backend that
// is up is the expected case and says nothing: the block appears only while the
// answer is unknown, or when it is bad news.
function paintStatus(status, text) {
  const el = $('#auth-status');
  el.className = `status ${status}`;
  el.classList.toggle('hidden', status === 'up');
  $('#auth-status-text').textContent = text || '';
}

// The build stamp next to the sync light: short commit and the day it went out.
// Both come from the server, so the page never claims a version of its own.
function showBuild(build) {
  const el = $('#build');
  if (!build?.commit) { el.classList.add('hidden'); return; }

  const when = build.deployed_at ? new Date(build.deployed_at) : null;
  const day = when && !isNaN(when)
    ? when.toLocaleDateString(undefined, { day: '2-digit', month: 'short' })
    : '';
  el.textContent = day ? `${build.commit} · ${day}` : build.commit;
  el.title = when && !isNaN(when)
    ? `frontend ${build.commit}, deployed ${when.toLocaleString()} (${build.source})`
    : `frontend ${build.commit} (${build.source})`;
  el.classList.remove('hidden');
}

async function checkServer() {
  $('#auth-origin').textContent = location.origin;
  paintStatus('checking', 'checking the backend…');
  try {
    const r = await fetch('/api/health', { cache: 'no-store' });
    const body = await r.json();
    $('#auth-offline').classList.add('hidden');
    paintStatus('up');

    showBuild(body.build);

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
    paintStatus('down', 'the backend is not answering');
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

// The panel is open when the button says so or when the query is the `help`
// command, so closing it has to undo whichever one opened it.
function setHelp(open) {
  const byCommand = BookmarksSearch.norm($('#q').value).trim() === 'help';
  state.helpOpen = open;
  if (!open && byCommand) setQuery('');   // setQuery renders on its own
  else render();
}

$('#btn-help').onclick = () => setHelp($('#help').classList.contains('hidden'));
$('#help-close').onclick = () => setHelp(false);

$('#btn-logout').onclick = async () => {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
  localStorage.removeItem('bookmarks_token');
  state.token = '';
  state.items = [];
  location.reload();
};

/* ---------------- data ---------------- */
async function loadAll() {
  const [r, f] = await Promise.all([
    api('/api/bookmarks?limit=5000'),
    // An older server has no such route. The tree still draws from the
    // bookmarks, so this is a degraded panel, never a broken one.
    api('/api/folders').catch(() => ({ folders: [] })),
  ]);
  state.items = r.items;
  state.folders = f.folders.map((x) => x.path);
  state.lastSync = Date.now();
  refreshDatalists();
  render();
}

// Pulls only what changed since the last sync, including another client's writes.
async function pullChanges() {
  try {
    const r = await api('/api/sync', {
      method: 'POST',
      body: JSON.stringify({ since: state.lastSync, changes: [] }),
    });
    state.lastSync = r.now;
    // `folders` is only sent by a server that knows about them, and an empty
    // list is a real answer (nothing changed), so the key's absence is what
    // says "this server has nothing to say", not its length.
    const folders = Array.isArray(r.folders) ? r.folders : [];
    if (!r.changes.length && !folders.length) return;
    for (const c of r.changes) {
      const i = state.items.findIndex((b) => b.id === c.id);
      if (c.deleted) { if (i >= 0) state.items.splice(i, 1); continue; }
      if (i >= 0) state.items[i] = c; else state.items.unshift(c);
    }
    for (const f of folders) {
      const known = state.folders.includes(f.path);
      if (f.deleted) { if (known) state.folders.splice(state.folders.indexOf(f.path), 1); }
      else if (!known) state.folders.push(f.path);
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
  fill($('#dl-folders'), [...state.items.map((b) => b.folder), ...state.folders]);
  fill($('#dl-categories'), state.items.map((b) => b.category));
}

/* ---------------- render ---------------- */
function highlight(text, terms) {
  const frag = document.createDocumentFragment();
  const plain = BookmarksSearch.norm(text);
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

// Moving the selection repaints two rows, not the screen. Going through
// render() meant re-searching the vault, rebuilding every result row and the
// whole folder panel on each arrow key, which is what made holding the key crawl.
function moveSel(delta) {
  if (!state.results.length) return;
  const next = Math.min(Math.max(state.sel + delta, 0), state.results.length - 1);
  if (next === state.sel) return;

  const rows = $('#results').children;
  rows[state.sel]?.classList.remove('sel');
  state.sel = next;
  const row = rows[state.sel];
  if (!row) return render();     // list out of step with the results: rebuild
  row.classList.add('sel');
  row.scrollIntoView({ block: 'nearest' });
}

function render() {
  const q = $('#q').value;
  const terms = BookmarksSearch.parseQuery(q);
  // No cap: the panel exists to sweep the whole vault, and cutting at 50 would
  // hide exactly the tail someone is looking for.
  state.results = BookmarksSearch.search(state.items, q, state.items.length || 1);
  if (state.sel >= state.results.length) state.sel = Math.max(0, state.results.length - 1);

  $('#q-clear').classList.toggle('hidden', !q);
  // `help` typed in the search box is a command, not a search: the panel opens
  // and the results below still answer the query, so nothing is taken away.
  $('#help').classList.toggle('hidden', !state.helpOpen && BookmarksSearch.norm(q).trim() !== 'help');

  const ul = $('#results');
  ul.innerHTML = '';
  for (const [i, b] of state.results.entries()) {
    const li = document.createElement('li');
    li.className = 'item' + (i === state.sel ? ' sel' : '');
    // The row is a drag source: dropping it on a folder in the panel files it
    // there. This is also what records the pointer position the click below
    // reads.
    wireBookmarkDrag(li, b);
    // Selecting the title to copy it ends in a click on the row, which used to
    // open the link and wipe the selection. A pointer that travelled, or any
    // text left selected, means the gesture was a selection.
    li.onclick = (e) => {
      const moved = Math.hypot(e.clientX - Number(li.dataset.px || e.clientX),
                               e.clientY - Number(li.dataset.py || e.clientY));
      if (moved > 4 || String(getSelection())) return;
      state.sel = i;
      openSelected(e.ctrlKey || e.metaKey);
    };
    // The wheel button opens in a new tab everywhere else on the web, so it does
    // here too, the same as Ctrl+Enter. Two things it needs: the event is
    // `auxclick`, not `click`, and the mousedown has to be swallowed or the
    // browser starts its autoscroll on top of the result.
    li.onmousedown = (e) => { if (e.button === 1) e.preventDefault(); };
    li.onauxclick = (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      state.sel = i;
      openSelected(true);
    };
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
    // The URL line carries the counter: how many times this link was opened
    // from here, with Enter, Ctrl+Enter or a click.
    const url = document.createElement('div');
    url.className = 'item-url';
    const urlText = document.createElement('span');
    urlText.className = 'item-url-text';
    urlText.append(highlight(b.url, terms));
    url.append(urlText, opensLabel(b));
    main.append(title, url);

    // On its own line under the title: sharing the line meant a long URL left
    // the title with a couple of readable characters.
    const meta = document.createElement('div');
    meta.className = 'item-meta';
    if (b.folder) meta.append(badge('folder', '/' + b.folder, () => toggleToken('/' + b.folder)));
    if (b.category) meta.append(badge('cat', '@' + b.category, () => toggleToken('@' + b.category)));
    for (const t of b.tags.split(',').filter(Boolean).slice(0, 6)) {
      meta.append(badge('tag', '#' + t, () => toggleToken('#' + t)));
    }
    if (meta.childElementCount) main.append(meta);
    li.append(main);

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
      : 'no bookmarks yet: click "new" or press n';
  } else {
    empty.classList.add('hidden');
  }

  renderChips();
  renderSuggest();
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

// The heading of a panel section, which is also the button that folds it away.
// With 361 folders open, Categories and Tags are a long scroll below.
function sectionHead(key, heading, count) {
  const head = document.createElement('div');
  head.className = 'facet-head';
  const isOpen = !state.closedSections.has(key);

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'facet-toggle';
  toggle.setAttribute('aria-expanded', String(isOpen));
  toggle.title = isOpen ? `Collapse ${heading}` : `Expand ${heading}`;

  const arrow = document.createElement('span');
  arrow.className = 'tree-toggle';
  arrow.textContent = isOpen ? '▾' : '▸';
  const label = document.createElement('span');
  label.textContent = `${heading} (${count})`;
  toggle.append(arrow, label);
  toggle.onclick = () => {
    if (isOpen) state.closedSections.add(key); else state.closedSections.delete(key);
    localStorage.setItem('bookmarks_closed_sections', JSON.stringify([...state.closedSections]));
    renderBrowse();
  };

  const h = document.createElement('h3');
  h.append(toggle);
  head.append(h);
  return { head, isOpen };
}

// How many rows a flat list shows before `expand all`.
const FACET_CAP = 40;

function browseSection(heading, prefix, entries, emptyText, filter) {
  const sec = document.createElement('section');
  sec.className = 'facet';

  const key = heading.toLowerCase();
  const { head, isOpen } = sectionHead(key, heading, entries.length);
  sec.append(head);
  if (!isOpen) return sec;
  if (filter) sec.append(filter);

  if (!entries.length) {
    const p = document.createElement('p');
    p.className = 'facet-empty';
    p.textContent = emptyText;
    sec.append(p);
    return sec;
  }

  // No expand/collapse pair here: a flat list has nothing to unfold. What it
  // has is a cap, and one line at the end that lifts it.
  const expanded = state.expandedFacets.has(key);

  for (const [name, n] of (expanded ? entries : entries.slice(0, FACET_CAP))) {
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

  if (entries.length > FACET_CAP) {
    const flip = document.createElement('button');
    flip.type = 'button';
    flip.className = 'linkish facet-more';
    flip.textContent = expanded ? 'show fewer' : `show all ${entries.length}`;
    flip.onclick = () => {
      if (expanded) state.expandedFacets.delete(key); else state.expandedFacets.add(key);
      localStorage.setItem('bookmarks_expanded_facets', JSON.stringify([...state.expandedFacets]));
      renderBrowse();
    };
    sec.append(flip);
  }
  return sec;
}

// `dev/k8s` is a single string in the database; the tree exists only on screen.
// A node's total includes its descendants: clicking `dev` filters `dev/*`
// because the search does a substring match on the folder field.
//
// Two sources feed it. The bookmarks put a folder on the tree by being inside
// it, and `folders` are the ones created on their own, which is the only way a
// folder with nothing in it can be here at all.
function folderTree(items, folders = []) {
  const root = new Map();
  // Walks a path into the tree and hands back the node at the end of it,
  // creating what is missing on the way.
  const reach = (folder) => {
    let level = root;
    let path = '';
    let node = null;
    for (const part of folder.split('/').filter(Boolean)) {
      path = path ? `${path}/${part}` : part;
      if (!level.has(part)) level.set(part, { name: part, path, total: 0, children: new Map() });
      node = level.get(part);
      level = node.children;
    }
    return node;
  };

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
  // After the bookmarks, so an empty folder shows up with the 0 it really has.
  for (const folder of folders) reach(folder);
  return root;
}

function countNodes(level) {
  let n = 0;
  for (const node of level.values()) n += 1 + countNodes(node.children);
  return n;
}

// Every node that has children, i.e. every row that shows an arrow. These are
// the paths the "expand all" / "collapse all" buttons flip at once.
function branchPaths(level, out = []) {
  for (const node of level.values()) {
    if (!node.children.size) continue;
    out.push(node.path);
    branchPaths(node.children, out);
  }
  return out;
}

function saveClosedFolders() {
  localStorage.setItem('bookmarks_closed_folders', JSON.stringify([...state.closedFolders]));
}

// Dragging onto a folder, on pointer events rather than HTML5 drag and drop.
// The native API refuses to start a drag on a <button>, behaves differently
// across browsers and cannot be driven by a test; this is a mousedown, a
// threshold and an elementFromPoint, and it is the same code path for every
// pointer.
//
// Two things are dragged and one thing is aimed at. A folder row nests the
// folder, a result row files the bookmark, and either dropped on the section's
// empty space goes to the root. Only what is being dragged differs, so `kind`
// is the one branch and the gesture below is shared.
const drag = {
  kind: null,        // 'folder' or 'bookmark'
  path: null,        // folder being dragged
  item: null,        // bookmark being dragged
  row: null,         // its row
  from: null,        // where the gesture started, to measure the threshold
  active: false,     // past the threshold: it is a drag, not a click
  target: null,      // row currently under the pointer, or the folders section
  ghost: null,       // the label following the pointer
  at: null,          // last pointer position, for the autoscroll to re-aim
  scroll: 0,         // px per frame while the pointer sits near an edge
  scrolling: false,
};

const DRAG_THRESHOLD = 5;   // px before a click becomes a drag

function parentOf(path) {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
}

// `to` is '' for the root. A folder cannot land inside itself, and moving it
// where it already is would only cost a reload.
function canDropFolder(from, to) {
  if (!from || from === to) return false;
  if (to === from || to.startsWith(from + '/')) return false;
  return parentOf(from) !== to;
}

// Filing a bookmark where it already is would be a write that changes nothing.
function canDropBookmark(b, to) {
  return !!b && String(b.folder || '') !== to;
}

// What the gesture in flight is allowed to land on.
function canDrop(to) {
  return drag.kind === 'bookmark'
    ? canDropBookmark(drag.item, to)
    : canDropFolder(drag.path, to);
}

// A filter pinned to the folder that just moved has to move with it. Otherwise
// the search bar keeps pointing at where the folder was, the list empties out,
// and clicking the folder in its new place only adds a second filter on top of
// the stale one.
function retargetFolderTokens(from, to) {
  const before = $('#q').value;
  const lower = from.toLowerCase();

  const after = before.split(/\s+/).filter(Boolean).map((token) => {
    const negated = token.startsWith('-');
    const body = negated ? token.slice(1) : token;
    if (body[0] !== '/') return token;

    const path = body.slice(1).toLowerCase();
    // The folder itself, or anything that lived under it.
    if (path !== lower && !path.startsWith(lower + '/')) return token;
    return `${negated ? '-' : ''}/${to}${body.slice(1 + from.length)}`;
  }).join(' ');

  if (after !== before) setQuery(after);
}

// The path is a plain string on every bookmark below the folder, so the server
// rewrites the prefix and the whole branch travels with it.
async function moveFolder(from, to) {
  if (!canDropFolder(from, to)) return;
  setSync('moving…', 'saving');
  try {
    const r = await api('/api/folders/move', { method: 'POST', body: JSON.stringify({ from, to }) });
    // The destination and its ancestors open, otherwise the folder appears to
    // have vanished instead of having moved.
    for (let p = r.to; p; p = parentOf(p)) state.closedFolders.delete(p);
    saveClosedFolders();
    await loadAll();
    retargetFolderTokens(from, r.to);
    setSync(`moved to /${r.to}`);
    setTimeout(() => setSync('synced'), 3000);
  } catch (err) {
    setSync(err.message || 'move failed', 'err');
  }
}

// Filing a bookmark is an edit to one field, so it goes through the same PUT
// the modal uses: nothing about having dragged it makes it a different write.
// Only `folder` is sent, and the server merges it over the record, so a drag
// cannot overwrite a title someone changed on another device meanwhile.
async function fileBookmark(b, to) {
  if (!canDropBookmark(b, to)) return;
  setSync('moving…', 'saving');
  try {
    const r = await api(`/api/bookmarks/${b.id}`, {
      method: 'PUT',
      body: JSON.stringify({ folder: to }),
    });
    const i = state.items.findIndex((x) => x.id === r.item.id);
    if (i >= 0) state.items[i] = r.item; else state.items.unshift(r.item);
    state.lastSync = r.item.updated_at;
    // The destination opens, otherwise the bookmark looks like it was lost
    // rather than filed.
    for (let path = to; path; path = parentOf(path)) state.closedFolders.delete(path);
    saveClosedFolders();
    refreshDatalists();
    render();
    setSync(to ? `filed under /${to}` : 'moved to the root');
    setTimeout(() => setSync('synced'), 3000);
  } catch (err) {
    setSync(err.message || 'move failed', 'err');
  }
}

// What is under the pointer: a folder row, the root strip, or nothing.
function dropTargetAt(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;

  // A folder row is the obvious target: dropping on it puts what is being
  // dragged inside.
  const row = el.closest('.tree-row');
  if (row?.dataset.path) {
    return canDrop(row.dataset.path) ? { el: row, to: row.dataset.path } : null;
  }

  // Everything else in the folders section means the root, the same way a file
  // manager reads a drop on empty space as "into the folder you are looking
  // at". The heading is that folder's name, so it answers too.
  const section = el.closest('.facet-folders');
  if (section) return canDrop('') ? { el: section, to: '' } : null;
  return null;
}

function highlightTarget(next) {
  if (drag.target?.el === next?.el) { drag.target = next; return; }
  drag.target?.el.classList.remove('drop-into');
  next?.el.classList.add('drop-into');
  drag.target = next;
}

// Dragging to a folder that is not on screen has to be possible, so the panel
// scrolls when the pointer sits near its edges, the way a file manager does.
// Speed grows towards the edge instead of being a single step.
const SCROLL_EDGE = 48;      // px from the edge where it starts
const SCROLL_MAX = 14;       // px per frame at the very edge

function autoScroll(y) {
  const panel = $('#browse');
  const box = panel.getBoundingClientRect();
  let step = 0;
  if (y < box.top + SCROLL_EDGE) step = -(SCROLL_EDGE - (y - box.top));
  else if (y > box.bottom - SCROLL_EDGE) step = SCROLL_EDGE - (box.bottom - y);
  if (!step) { drag.scroll = 0; return; }

  drag.scroll = Math.max(-SCROLL_MAX, Math.min(SCROLL_MAX, step / 3));
  if (drag.scrolling) return;
  drag.scrolling = true;

  const tick = () => {
    if (!drag.active || !drag.scroll) { drag.scrolling = false; return; }
    panel.scrollTop += drag.scroll;
    // The rows moved under a pointer that did not: the target is whatever is
    // under it now, not what was there when the frame started.
    if (drag.at) highlightTarget(dropTargetAt(drag.at.x, drag.at.y));
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// The gesture starts on a row and is followed on the window.
//
// It used to be followed by capturing the pointer on the row itself, which does
// not survive contact with the browser: as soon as the drag begins the row gets
// `pointer-events: none`, so that it stops answering elementFromPoint and the
// row under the pointer is not always the one being dragged. Chrome stops
// routing to a capturing element in that state, so every move and the release
// went to whatever was underneath, the row never heard them, and the drop
// landed nowhere. The window hears them all, whatever the row is doing.
function watchPointer(on) {
  const how = on ? 'addEventListener' : 'removeEventListener';
  window[how]('pointermove', onDragMove, true);
  window[how]('pointerup', onDragUp, true);
  window[how]('pointercancel', onDragCancel, true);
}

// Left button, never touch (a finger drag would fight the panel's scroll), and
// never from a control on the row that has a job of its own.
function startDrag(what, row, e, exclude) {
  if (e.button !== 0 || e.pointerType === 'touch') return;
  if (exclude && e.target.closest(exclude)) return;
  Object.assign(drag, { kind: null, path: null, item: null, ...what, row,
                        from: { x: e.clientX, y: e.clientY }, active: false });
  watchPointer(true);
}

function onDragMove(e) {
  if (!drag.row) return;
  if (!drag.active) {
    if (Math.hypot(e.clientX - drag.from.x, e.clientY - drag.from.y) < DRAG_THRESHOLD) return;
    // Text selected before the gesture turned into a drag would stay
    // highlighted under the ghost, and the click guard afterwards reads a
    // selection as "this was not a click".
    getSelection()?.removeAllRanges();
    beginDrag();
  }
  drag.ghost.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 10}px)`;
  drag.at = { x: e.clientX, y: e.clientY };
  highlightTarget(dropTargetAt(e.clientX, e.clientY));
  autoScroll(e.clientY);
}

function onDragUp(e) {
  if (!drag.row) return;
  if (endDrag(true)) { e.preventDefault(); e.stopPropagation(); }
}

function onDragCancel() {
  if (drag.row) endDrag(false);
}

// A release is followed by a click on whatever the pointer ended on, which
// would toggle the filter of the folder just dropped into, or open the link
// just filed. A drag is not a click, so the one that follows is swallowed. The
// timer is for the drop that lands nowhere and produces no click at all: the
// listener must not sit there waiting to eat an honest one.
function swallowNextClick() {
  const done = () => { window.removeEventListener('click', eat, true); clearTimeout(timer); };
  const eat = (e) => { e.preventDefault(); e.stopPropagation(); done(); };
  window.addEventListener('click', eat, true);
  const timer = setTimeout(done, 300);
}

function beginDrag() {
  drag.active = true;
  drag.row.classList.add('dragging');
  $('#browse-body').classList.add('dragging');
  // A result row is dragged from outside the panel, so the guard against
  // selecting text mid-gesture has to cover the page, not only the panel.
  document.body.classList.add('dragging');

  drag.ghost = document.createElement('div');
  drag.ghost.className = 'drag-ghost';
  drag.ghost.textContent = drag.kind === 'bookmark'
    ? (drag.item.title || drag.item.url)
    : '/' + drag.path;
  document.body.append(drag.ghost);
}

function endDrag(drop) {
  const { kind, path, item, target, active } = drag;
  watchPointer(false);
  drag.ghost?.remove();
  drag.row?.classList.remove('dragging');
  drag.target?.el.classList.remove('drop-into');
  $('#browse-body').classList.remove('dragging');
  document.body.classList.remove('dragging');
  Object.assign(drag, { kind: null, path: null, item: null, row: null, from: null,
                        active: false, target: null, ghost: null, at: null, scroll: 0 });
  if (active) swallowNextClick();
  if (drop && active && target) {
    if (kind === 'bookmark') fileBookmark(item, target.to);
    else moveFolder(path, target.to);
  }
  return active;
}

// Turns a row into a drag source. The drop side is resolved by coordinates, so
// only the source needs wiring.
function wireFolderDrag(row, path) {
  row.dataset.path = path;
  // Not from the expand arrow, and not from the rename and delete buttons:
  // those have a job of their own.
  row.onpointerdown = (e) => startDrag({ kind: 'folder', path }, row, e, '.tree-toggle, .icon-btn');
}

// The same gesture from the other side of the screen: a result row is a drag
// source too, and the panel is what it aims at. The pointer position is also
// what the click handler reads to tell a click from a text selection, so it is
// recorded here rather than in two places.
function wireBookmarkDrag(row, b) {
  row.onpointerdown = (e) => {
    row.dataset.px = e.clientX;
    row.dataset.py = e.clientY;
    startDrag({ kind: 'bookmark', item: b }, row, e, 'button, a');
  };
}

function treeRows(level, depth, into, filter) {
  for (const node of [...level.values()].sort((a, b) => (b.total - a.total) || a.name.localeCompare(b.name))) {
    // A node stays visible when it matches the filter, or when a descendant does.
    const selfMatch = !filter || BookmarksSearch.norm(node.name).includes(filter);
    const branch = document.createElement('div');
    const children = document.createElement('div');
    if (node.children.size) treeRows(node.children, depth + 1, children, filter);
    if (!selfMatch && !children.childElementCount) continue;

    const token = '/' + node.path;
    const isOpen = !state.closedFolders.has(node.path);

    const row = document.createElement('div');
    row.className = 'tree-row';
    row.style.setProperty('--level', depth);

    if (node.children.size) {
      const arrow = document.createElement('button');
      arrow.type = 'button';
      arrow.className = 'tree-toggle';
      arrow.textContent = isOpen ? '▾' : '▸';
      arrow.title = isOpen ? 'Collapse' : 'Expand';
      arrow.onclick = () => {
        if (isOpen) state.closedFolders.add(node.path); else state.closedFolders.delete(node.path);
        saveClosedFolders();
        renderBrowse();
      };
      row.append(arrow);
    } else {
      const emptyText = document.createElement('span');
      emptyText.className = 'tree-toggle emptyText';
      row.append(emptyText);
    }

    // A <div role="button">, not a <button>: Chrome refuses to start a drag on a
    // form control, and this row has to be draggable to nest folders.
    const b = document.createElement('div');
    b.className = 'facet-row tree-item' + (activeToken(token) ? ' on' : '');
    b.setAttribute('role', 'button');
    b.tabIndex = 0;
    const name = document.createElement('span');
    name.className = 'facet-name';
    name.textContent = node.name;
    const qty = document.createElement('span');
    qty.className = 'facet-count';
    qty.textContent = node.total;
    b.append(name, qty);
    b.onclick = () => toggleToken(token);
    // What the <button> gave for free and the div has to spell out.
    b.onkeydown = (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      toggleToken(token);
    };
    b.title = '/' + node.path;
    row.append(b);

    // Renaming and deleting sit on the row the way they sit on a result: out of
    // the way until the pointer is there. Dragging is what moves a folder, so
    // these two are the whole of what is left to do to one.
    const actions = document.createElement('div');
    actions.className = 'item-actions tree-actions';
    actions.append(
      iconButton('✎', `Rename /${node.path}`, () => openFolderModal(node.path)),
      iconButton('🗑', `Delete /${node.path}`, () => removeFolder(node.path)),
    );
    row.append(actions);

    wireFolderDrag(row, node.path);

    branch.append(row);
    // With a filter on, collapsing the branch would hide exactly what matched.
    if (isOpen || filter) branch.append(children);
    into.append(branch);
  }
}

// One button of the "expand all" / "collapse all" pair, used by the folder tree
// and by the flat lists. It comes disabled when it would not change anything,
// so the pair also reads as the current state.
function allButton(label, title, noop, apply) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'linkish';
  b.textContent = label;
  b.title = title;
  b.disabled = noop;
  b.onclick = () => { apply(); renderBrowse(); };
  return b;
}

function treeSection(root, total, filter) {
  const sec = document.createElement('section');
  sec.className = 'facet facet-folders';

  const { head, isOpen } = sectionHead('folders', 'Folders', total);
  sec.append(head);
  if (!isOpen) return sec;
  sec.append(filterField('filter-folders', 'filter folders…', renderBrowse));

  // Under the filter field and lined up with it: only worth showing when some
  // folder has children, because a flat list has nothing to expand.
  const branches = branchPaths(root);
  if (branches.length) {
    const closed = branches.filter((path) => state.closedFolders.has(path)).length;
    const actions = document.createElement('div');
    actions.className = 'facet-actions';
    actions.append(
      // Clearing the set also drops paths of folders that no longer exist.
      allButton('expand all', 'Open every folder', closed === 0,
                () => { state.closedFolders.clear(); saveClosedFolders(); }),
      allButton('collapse all', 'Close every folder', closed === branches.length,
                () => { for (const path of branches) state.closedFolders.add(path); saveClosedFolders(); }),
    );
    sec.append(actions);
  }

  sec.append(newFolderButton());

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

// The one action the panel offers that is not a filter. It sits under the
// expand pair, because that is where the folder section's controls already are.
function newFolderButton() {
  const wrap = document.createElement('div');
  wrap.className = 'facet-actions facet-new';
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'linkish';
  b.textContent = 'new folder';
  b.title = 'Create a folder, empty';
  b.onclick = () => openFolderModal();
  wrap.append(b);
  return wrap;
}

// The folder currently filtered on, which is the folder someone looking at the
// panel means by "here". A new folder starts inside it.
function currentFolder() {
  const token = $('#q').value.trim().split(/\s+/).find((p) => p.startsWith('/') && p.length > 1);
  return token ? token.slice(1) : '';
}

// One card for the two edits a folder has. Creating asks for a whole path,
// renaming asks for a name, because a rename that could reparent the branch
// would be a move wearing a disguise and the drag already does moves.
function openFolderModal(path = null) {
  state.editingFolder = path;
  const renaming = path !== null;
  $('#folder-title').textContent = renaming ? 'Rename folder' : 'New folder';
  $('#folder-path-label').firstChild.textContent = renaming ? 'Name' : 'Path';
  $('#folder-save').textContent = renaming ? 'rename' : 'create';
  $('#folder-hint').innerHTML = renaming
    ? 'Renames <code>/' + escapeText(path) + '</code> for everything inside it.'
    : 'Slashes nest it: <code>dev/linux</code> is <code>linux</code> inside <code>dev</code>.';

  const input = $('#f-path');
  // A rename starts on the name alone; a new folder starts inside whatever is
  // being browsed, which is what "new folder" means while looking at one.
  if (renaming) {
    input.value = path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path;
  } else {
    const here = currentFolder();
    input.value = here ? here + '/' : '';
  }
  input.setAttribute('list', renaming ? '' : 'dl-folders');

  $('#folder-error').textContent = '';
  $('#folder-modal').classList.remove('hidden');
  input.focus();
  // The caret lands at the end, so typing continues the path instead of
  // splitting the parent it was prefilled with.
  input.setSelectionRange(input.value.length, input.value.length);
}

function closeFolderModal() {
  $('#folder-modal').classList.add('hidden');
  state.editingFolder = null;
  $('#q').focus();
}

// Text into the one place here that takes HTML, since the hint carries a <code>.
function escapeText(v) {
  const el = document.createElement('span');
  el.textContent = v;
  return el.innerHTML;
}

$('#folder-form').onsubmit = async (e) => {
  e.preventDefault();
  const value = $('#f-path').value.trim().replace(/^\/+|\/+$/g, '');
  if (!value) {
    $('#folder-error').textContent = 'enter a name';
    return;
  }

  const renaming = state.editingFolder !== null;
  if (renaming && value.includes('/')) {
    $('#folder-error').textContent = 'a name cannot contain "/": drag the folder to move it';
    return;
  }

  setSync('saving…', 'saving');
  try {
    if (renaming) {
      const from = state.editingFolder;
      const r = await api('/api/folders/rename', {
        method: 'POST',
        body: JSON.stringify({ path: from, name: value }),
      });
      for (let path = r.to; path; path = parentOf(path)) state.closedFolders.delete(path);
      saveClosedFolders();
      await loadAll();
      // The search bar may be pointing at the old name, the same way it does
      // after a move.
      retargetFolderTokens(from, r.to);
      setSync(`renamed to /${r.to}`);
    } else {
      await api('/api/folders', { method: 'POST', body: JSON.stringify({ path: value }) });
      for (let path = value; path; path = parentOf(path)) state.closedFolders.delete(path);
      saveClosedFolders();
      await loadAll();
      setSync(`created /${value}`);
    }
    closeFolderModal();
    setTimeout(() => setSync('synced'), 3000);
  } catch (err) {
    $('#folder-error').textContent = err.message;
    setSync('save failed', 'err');
  }
};

$('#folder-cancel').onclick = closeFolderModal;
$('#folder-modal').onclick = (e) => { if (e.target.id === 'folder-modal') closeFolderModal(); };

// Deleting takes everything inside with it, so the question says how much that
// is. The counts come from what is already in memory: the panel knows the whole
// vault, and asking the server first would only add a wait to a question.
async function removeFolder(path) {
  const inside = state.items.filter((b) => b.folder === path || b.folder.startsWith(path + '/'));
  const under = state.folders.filter((p) => p === path || p.startsWith(path + '/'));
  const subfolders = new Set(under.filter((p) => p !== path));
  for (const b of inside) {
    const rest = b.folder.slice(path.length);
    if (rest) subfolders.add(path + rest);
  }

  const parts = [];
  if (inside.length) parts.push(`${inside.length} bookmark${inside.length > 1 ? 's' : ''}`);
  if (subfolders.size) parts.push(`${subfolders.size} subfolder${subfolders.size > 1 ? 's' : ''}`);
  const what = parts.length ? `/${path} and everything in it: ${parts.join(' and ')}` : `/${path}`;
  if (!await askDelete(what)) return;

  setSync('saving…', 'saving');
  try {
    await api('/api/folders/delete', { method: 'POST', body: JSON.stringify({ path }) });
    await loadAll();
    setSync('synced');
  } catch (err) {
    setSync(err.message || 'delete failed', 'err');
  }
}

// A filter over the list itself: it does not touch the bookmark search, it only
// shortens the panel when there are too many categories/tags to scan by eye.
function filterField(id, placeholder, onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'facet-search';
  const input = document.createElement('input');
  input.type = 'search';
  input.id = id;
  input.placeholder = placeholder;
  input.autocomplete = 'off';
  input.value = state.panelFilter[id] || '';
  input.oninput = () => { state.panelFilter[id] = input.value; onChange(); };
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

  const root = folderTree(state.items, state.folders);
  const tags = state.items.flatMap((b) => b.tags.split(',').filter(Boolean));
  const filterEntries = (list, key) => {
    const term = BookmarksSearch.norm(state.panelFilter[key] || '');
    return term ? list.filter(([name]) => BookmarksSearch.norm(name).includes(term)) : list;
  };

  body.append(
    treeSection(root, countNodes(root), BookmarksSearch.norm(state.panelFilter['filter-folders'] || '')),
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
  localStorage.setItem('bookmarks_browse', isOpen ? '1' : '0');
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
  state.suggestOff = false;
  $('#q').focus();
}

/* ---------------- actions ---------------- */
function openSelected(newTab = true) {
  const b = state.results[state.sel];
  if (!b?.url) return;
  const url = /^https?:\/\//i.test(b.url) ? b.url : 'https://' + b.url;
  rememberQuery($('#q').value);      // the search that found it is worth keeping
  registerOpen(b);
  if (newTab) window.open(url, '_blank', 'noopener');
  else location.href = url;
}

// Clicking again because the page is taking its time is one visit, not two:
// the same bookmark only counts once per window.
const OPEN_DEBOUNCE = 3000;
const lastOpen = new Map();

// Usage ranking: the count is bumped locally first so the order reacts right
// away, and the server call is fire and forget because a bookmark that opened
// must not wait on, or fail because of, a statistic.
function registerOpen(b) {
  const now = Date.now();
  if (now - (lastOpen.get(b.id) || 0) < OPEN_DEBOUNCE) return;
  lastOpen.set(b.id, now);

  b.opens = (Number(b.opens) || 0) + 1;
  b.last_open_at = Date.now();
  const label = $('#results').children[state.results.indexOf(b)]?.querySelector('.item-opens');
  if (label) { label.textContent = `${b.opens}×`; label.title = `opened ${b.opens} times from here`; }
  api('/api/bookmarks/open', { method: 'POST', body: JSON.stringify({ id: b.id }) })
    .then((r) => {
      // The server is the authority on the count: another device may have
      // opened the same link since the last sync.
      if (r.item) { b.opens = r.item.opens; b.updated_at = r.item.updated_at; }
    })
    .catch(() => {});
}

// Empty until the link has been opened at least once: a `0×` on every row is
// noise, and the whole point is spotting the ones you keep going back to.
function opensLabel(b) {
  const n = Number(b.opens) || 0;
  const el = document.createElement('span');
  el.className = 'item-opens';
  el.textContent = n ? `${n}×` : '';
  el.title = n ? `opened ${n} time${n > 1 ? 's' : ''} from here` : '';
  return el;
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

// Asks in the app's own modal and answers with a promise, so the callers read
// like the confirm() they replaced. Only one question can be open at a time,
// which is all this app ever needs.
let pendingConfirm = null;

function askDelete(what) {
  $('#confirm-what').textContent = what;
  $('#confirm-modal').classList.remove('hidden');
  // Cancel takes the focus on purpose: Ctrl+Del is one keystroke away from
  // here, and Enter landing on `delete` would make the question decorative.
  $('#confirm-cancel').focus();
  return new Promise((resolve) => { pendingConfirm = resolve; });
}

function closeConfirm(answer) {
  if (!pendingConfirm) return;
  const resolve = pendingConfirm;
  pendingConfirm = null;
  $('#confirm-modal').classList.add('hidden');
  $('#q').focus();
  resolve(answer);
}

$('#confirm-ok').onclick = () => closeConfirm(true);
$('#confirm-cancel').onclick = () => closeConfirm(false);
// The backdrop is everything outside the card, and clicking it is a cancel.
$('#confirm-modal').onclick = (e) => { if (e.target === $('#confirm-modal')) closeConfirm(false); };

async function removeBookmark(b) {
  if (!b) return;
  if (!await askDelete(b.title || b.url)) return;
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
let historyTimer = null;
$('#q').oninput = () => {
  state.sel = 0;
  state.suggestOff = false;
  render();
  // Recorded after a pause: `k`, `ku`, `kub` are not three searches, the one
  // you stopped at is. And only if it found something, so typos are not kept.
  clearTimeout(historyTimer);
  historyTimer = setTimeout(() => {
    if (state.results.length) rememberQuery($('#q').value);
  }, 1200);
};

$('#q').onfocus = () => { state.suggestOff = false; renderSuggest(); };
// A click on a suggestion runs before this, because both buttons cancel the
// mousedown that would blur the field.
$('#q').onblur = () => { state.suggestOff = true; renderSuggest(); };

/* ---------------- keyboard ---------------- */
document.addEventListener('keydown', (e) => {
  // The question comes first: while it is open nothing else may act, or Esc
  // would close something underneath and leave it hanging.
  if (!$('#confirm-modal').classList.contains('hidden')) {
    if (e.key === 'Escape') closeConfirm(false);
    // Enter means "the button under the focus", spelled out instead of left to
    // the browser's native activation, which does not fire for every way a key
    // can arrive. Focus starts on cancel, so Enter answers no until you Tab.
    if (e.key === 'Enter') {
      e.preventDefault();
      closeConfirm(document.activeElement === $('#confirm-ok'));
    }
    return;
  }
  if (!$('#insights-modal').classList.contains('hidden')) {
    if (e.key === 'Escape') closeInsights();
    return;
  }
  if (!$('#io-modal').classList.contains('hidden')) {
    if (e.key === 'Escape') closeIo();
    return;
  }
  if (!$('#modal').classList.contains('hidden')) {
    if (e.key === 'Escape') closeModal();
    return;
  }
  if (!$('#folder-modal').classList.contains('hidden')) {
    if (e.key === 'Escape') closeFolderModal();
    return;
  }
  if ($('#app').classList.contains('hidden')) return;

  const inSearch = document.activeElement === $('#q');

  // Ctrl+C with the caret in the search box wipes the search. With a selection
  // it still copies, which is what Ctrl+C is for.
  if (inSearch && (e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C') && !String(getSelection())) {
    e.preventDefault();
    setQuery('');
    return;
  }

  // Edit and delete need to work while typing, which is where the caret spends
  // its whole life here: the search box takes focus on boot and after most
  // actions. A letter cannot do that job, so each one has a key that is not a
  // letter, and keeps its letter for when the caret is somewhere else.
  //
  // F2 is the rename key everywhere else, and no browser claims it. Delete gets
  // Ctrl, because deleting by accident costs more than one keystroke saved.
  if (e.key === 'F2' || (!inSearch && e.key === 'e')) {
    e.preventDefault();
    if (state.results[state.sel]) openModal(state.results[state.sel]);
    return;
  }
  // Delete on its own is the forward-delete of a text field. Firing it there
  // asked, mid-word, whether to throw away a bookmark nobody was looking at.
  if (e.key === 'Delete' && (e.ctrlKey || e.metaKey || !inSearch)) {
    e.preventDefault();
    removeBookmark(state.results[state.sel]);
    return;
  }

  if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
    e.preventDefault();
    moveSel(1);
  } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
    e.preventDefault();
    moveSel(-1);
  } else if (e.key === 'Enter' && state.results.length) {
    e.preventDefault();
    openSelected(e.ctrlKey || e.metaKey || true);
  } else if (e.key === 'Escape') {
    if (!$('#help').classList.contains('hidden')) { $('#help-close').onclick(); return; }
    // The suggestions go first: Esc closing them is not the same as Esc
    // throwing away what was typed.
    if (!$('#suggest').classList.contains('hidden')) { state.suggestOff = true; renderSuggest(); return; }
    if ($('#q').value) setQuery(''); else $('#q').blur();
  } else if (!inSearch && (e.key === 'n' || e.key === '/')) {
    e.preventDefault();
    if (e.key === 'n') openModal(); else $('#q').focus();
  } else if (!inSearch && e.key === 'b') {
    e.preventDefault();
    setBrowseOpen($('#browse').classList.contains('off'));
  } else if (!inSearch && e.key.length === 1) {
    $('#q').focus();
  }
});

/* ---------------- insights ---------------- */
// What actually gets opened, from the server's log: a bar per day, the most
// opened links, and the raw list. No library: the bars are divs.
const insights = { days: 7 };

function openInsights(days = insights.days) {
  insights.days = days;
  $('#insights-modal').classList.remove('hidden');
  $('#ins-days').textContent = days;
  for (const b of document.querySelectorAll('.ins-range button')) {
    b.classList.toggle('on', Number(b.dataset.days) === days);
  }
  loadInsights();
}

async function loadInsights() {
  const chart = $('#ins-chart');
  chart.textContent = 'loading…';
  try {
    const r = await api(`/api/insights?days=${insights.days}`);
    renderInsights(r);
  } catch (err) {
    chart.textContent = err.message || 'could not load';
  }
}

function renderInsights(r) {
  $('#ins-total').textContent = r.total;

  // The tallest day sets the scale; with nothing opened every bar is empty.
  const chart = $('#ins-chart');
  const peak = Math.max(1, ...r.daily.map((d) => d.count));
  // Thirty labels in a narrow modal overlap into a smudge: past a week only
  // every nth day is written, and the last one always is.
  const every = Math.ceil(r.daily.length / 8);
  chart.innerHTML = '';
  for (const [i, d] of r.daily.entries()) {
    const col = document.createElement('div');
    col.className = 'ins-col';
    col.title = `${d.day}: ${d.count} open${d.count === 1 ? '' : 's'}`;

    const value = document.createElement('span');
    value.className = 'ins-value';
    value.textContent = d.count || '';

    const bar = document.createElement('div');
    bar.className = 'ins-bar';
    bar.style.height = `${Math.round((d.count / peak) * 100)}%`;
    if (!d.count) bar.classList.add('empty');

    const label = document.createElement('span');
    label.className = 'ins-day';
    // Day and month only: the year is the same for every bar on screen.
    const [, m, day] = d.day.split('-');
    const shown = (r.daily.length - 1 - i) % every === 0;
    label.textContent = shown ? `${day}/${m}` : '';

    // The number on top of every bar would crowd a month as well.
    if (!shown && r.daily.length > 14) value.textContent = '';
    col.append(value, bar, label);
    chart.append(col);
  }

  const top = $('#ins-top');
  top.innerHTML = '';
  const ever = new Map(r.top_ever.map((b) => [b.id, b.total]));
  const list = r.top.length ? r.top : r.top_ever.map((b) => ({ ...b, hits: 0 }));
  if (!list.length) {
    top.innerHTML = '<li class="facet-empty">nothing opened yet</li>';
  }
  for (const b of list) {
    const li = document.createElement('li');
    li.className = 'ins-row';

    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'ins-link';
    link.textContent = b.title || b.url;
    link.title = b.url;
    // Jumps to the bookmark in the list instead of opening it: from here you
    // are looking at your habits, not following a link.
    link.onclick = () => { closeInsights(); setQuery(b.title || b.url); };

    const count = document.createElement('span');
    count.className = 'ins-count';
    const total = ever.get(b.id) ?? b.total ?? 0;
    count.textContent = b.hits ? `${b.hits}× · ${total} total` : `${total} total`;

    li.append(link, count);
    top.append(li);
  }

  const log = $('#ins-log');
  log.innerHTML = '';
  if (!r.log.length) log.innerHTML = '<li class="facet-empty">no opens in this window</li>';
  for (const row of r.log) {
    const li = document.createElement('li');
    li.className = 'ins-row';
    const when = document.createElement('span');
    when.className = 'ins-when';
    const d = new Date(row.at);
    when.textContent = d.toLocaleString(undefined,
      { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    const what = document.createElement('span');
    what.className = 'ins-what';
    what.textContent = row.title || row.url;
    what.title = row.url;
    li.append(when, what);
    log.append(li);
  }
}

function closeInsights() {
  $('#insights-modal').classList.add('hidden');
  // Like the other two: the caret goes back where the app expects it.
  $('#q').focus();
}

$('#btn-insights').onclick = () => openInsights();
$('#ins-close').onclick = closeInsights;
for (const b of document.querySelectorAll('.ins-range button')) {
  b.onclick = () => openInsights(Number(b.dataset.days));
}

/* ---------------- import / export ---------------- */
const io = { content: '', name: '', plan: null, source: 'native' };

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
    a.download = fileName(res, `bookmarks.${format}`);
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
    body: JSON.stringify({
      content: io.content,
      mode: chosenMode(),
      apply,
      // Which of the two questions is being asked. The server refuses the file
      // that belongs to the other one instead of guessing, because a browser
      // file read as a vault file looks like a vault that lost its categories.
      source: io.source,
      folderPrefix: io.source === 'browser' ? $('#io-prefix').value : '',
    }),
  });
}

const LABELS = {
  create: ['new bookmark', 'new bookmarks'],
  update: ['updated bookmark', 'updated bookmarks'],
  same: ['already identical, no change', 'already identical, no change'],
  skip: ['kept as is', 'kept as is'],
  remove: ['removed from the vault', 'removed from the vault'],
};

// What the file turned out to carry, said before what will be done with it.
// For a browser export this is where "no categories" stops being something
// discovered later, in the vault.
function renderFileStats(plan) {
  const f = plan.file || {};
  const parts = [`${f.count} bookmark(s)`, `${f.folders} folder(s)`];
  if (f.unfiled) parts.push(`${f.unfiled} outside any folder`);
  parts.push(f.tagged ? `${f.tagged} with tags` : 'no tags');
  if (plan.source === 'browser') parts.push('no categories, the format has none');
  else if (f.described) parts.push(`${f.described} with a description`);
  if (f.prefix) parts.push(`all of it under /${f.prefix}`);
  $('#io-file-stats').textContent = parts.join(' · ');
}

function renderPlan(plan) {
  io.plan = plan;
  renderFileStats(plan);
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

function resetIoFile() {
  io.content = '';
  io.name = '';
  io.plan = null;
  $('#io-file').value = '';
  $('#io-filename').textContent = 'no file chosen';
  $('#io-error').textContent = '';
  $('#io-plan').classList.add('hidden');
  $('#io-apply').disabled = true;
  $('#io-apply').textContent = 'import';
}

// Picks which of the two imports is being done and reshapes the form around it.
// The two files have different powers, so the questions asked about them differ:
// only a browser tree can be dropped under a folder of your own, and only a
// vault file is allowed to replace the vault.
function setIoSource(source) {
  io.source = source;
  for (const tab of document.querySelectorAll('[data-io-source]')) {
    const on = tab.dataset.ioSource === source;
    tab.classList.toggle('on', on);
    tab.setAttribute('aria-selected', String(on));
  }
  $('#io-src-native-hint').classList.toggle('hidden', source !== 'native');
  $('#io-prefix-row').classList.toggle('hidden', source !== 'browser');

  // "Replace everything" is off the menu for a browser file: it knows nothing
  // about the bookmarks it would be deleting. The server refuses it too, and
  // this keeps that refusal from being how anyone finds out.
  $('#io-mode-replace').classList.toggle('hidden', source === 'browser');
  $('#io-browser-note').classList.toggle('hidden', source !== 'browser');
  if (source === 'browser' && chosenMode() === 'replace') {
    document.querySelector('input[name="io-mode"][value="add"]').checked = true;
  }

  // No filter on the browser flow: one of the two files it reads is the
  // browser's own `Bookmarks`, which has no extension at all, and an accept
  // list would hide exactly the file people go looking for first.
  $('#io-file').accept = source === 'browser' ? '' : '.yaml,.yml,.json,application/json';

  // Whatever was loaded was an answer to the other question.
  resetIoFile();
}

function openIo() {
  setIoSource('native');
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

document.querySelectorAll('[data-io-source]').forEach((tab) => {
  tab.onclick = () => setIoSource(tab.dataset.ioSource);
});

// A prefix moves every folder in the file, so the plan is recomputed as it is
// typed. Debounced, because otherwise each keystroke re-parses a file that can
// be megabytes.
// One click for the common wish: keep this import together, and dated, so it
// can be found and undone later without guessing which folders came from where.
$('#io-prefix-dated').onclick = () => {
  const today = new Date().toISOString().slice(0, 10);
  $('#io-prefix').value = `Imported-${today}`;
  if (io.content) previewFile();
};

let prefixTimer = null;
$('#io-prefix').oninput = () => {
  clearTimeout(prefixTimer);
  prefixTimer = setTimeout(() => { if (io.content) previewFile(); }, 400);
};

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
  // http://<lan-ip> the browser ignores it, so there is nothing to register and
  // nothing to cache.
  if (!window.isSecureContext) return;

  // Whether a worker is already driving this page decides what happens below.
  // Read it now: by the time the new one claims, it is too late to tell a first
  // install apart from a version change.
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;

  // A new worker takes over as soon as it installs (sw.js calls skipWaiting),
  // but the page is already painted with whatever the old one served, which is
  // the previous version of the shell. Without this reload a deploy needs two
  // of them by hand: one to install the new worker, one to finally see it. On a
  // first install there is no stale page to replace, so it stays put.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });

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
  // The login screen is where checkServer runs; someone with a live session
  // goes straight in, so the stamp is fetched here too.
  fetch('/api/health', { cache: 'no-store' })
    .then((r) => r.json()).then((b) => showBuild(b.build)).catch(() => {});
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
  const choice = localStorage.getItem('bookmarks_browse');
  setBrowseOpen(choice === null ? window.innerWidth >= 900 : choice === '1');
  if (!state.token) return showLogin();

  // Only an invalid token ends the session. A server that is down does not:
  // clearing the token there would force retyping the password over a restart.
  try {
    await api('/api/me');
  } catch (err) {
    const network = err instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(err.message || '');
    if (!network) {
      localStorage.removeItem('bookmarks_token');
      state.token = '';
    }
    return showLogin();
  }
  await enterApp();
})();
