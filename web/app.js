/* Web UI: boot, the access-key screen, the routes and the keyboard.
 *
 * The app is a handful of ES modules under js/, no build step:
 *   js/http.js       the API client and the session token
 *   js/store.js      the vault in memory, its IndexedDB cache and the sync
 *   js/ui.js         shared pieces: dialogs, the folder picker, toasts, dragging
 *   js/links.js      all links: search, list, selection
 *   js/organize.js   two folders side by side, for moving links between them
 *   js/tree.js       the folder tree in the sidebar
 *   js/editor.js     the link form
 *   js/activity.js, js/data.js, js/settings.js   the other three pages
 *   js/audit.js      the audit page: link changes and clicks
 *   js/clicklog.js   records every click and sends them in batches
 * search.js is a classic script shared with the server, loaded before this.
 */

import { api, getToken, setToken, isOffline } from './js/http.js';
import * as store from './js/store.js';
import { $, $$, anyDialogOpen, wireDialog, askNewFolder, fail, toast, undoable, undoLast, hostOf, folderLabel, favicon } from './js/ui.js';
import * as links from './js/links.js';
import * as organize from './js/organize.js';
import * as tree from './js/tree.js';
import * as activity from './js/activity.js';
import * as data from './js/data.js';
import * as settings from './js/settings.js';
import * as audit from './js/audit.js';
import * as clicklog from './js/clicklog.js';
import * as preview from './js/preview.js';
import { openEditor, initEditor } from './js/editor.js';
import { linkFromAddress, sameLink, TEMP_FOLDER } from './js/address.js';

const USER_KEY = 'bookmarks_user';

/* ---------------- routes ---------------- */

const ROUTES = {
  links: { view: '#view-links', show: () => links.show() },
  organize: { view: '#view-organize', show: () => organize.show() },
  activity: { view: '#view-activity', show: () => activity.show() },
  audit: { view: '#view-audit', show: () => audit.show() },
  data: { view: '#view-data', show: () => {} },
  settings: { view: '#view-settings', show: () => settings.show() },
};

function routeFromHash() {
  const m = /^#\/?([a-z]*)/.exec(location.hash);
  return m && ROUTES[m[1]] ? m[1] : 'links';
}

function go() {
  const route = routeFromHash();
  document.body.dataset.route = route;
  for (const [name, r] of Object.entries(ROUTES)) $(r.view).hidden = name !== route;
  for (const a of $$('[data-route]')) a.classList.toggle('on', a.dataset.route === route);
  closeMenu();
  ROUTES[route].show();
  links.selectionChanged();
  tree.paint();
  if (route === 'links' && matchMedia('(min-width: 861px)').matches) $('#q').focus();
}

function openMenu() { $('#shell').classList.add('menu-open'); $('#scrim').hidden = false; }
function closeMenu() { $('#shell').classList.remove('menu-open'); $('#scrim').hidden = true; }

/* ---------------- keyboard ---------------- */

function onKey(e) {
  // A key a dialog already acted on is spent. The Enter that picks a folder
  // closes the picker before it bubbles here, and without this it would go on
  // to open the link under the cursor.
  if (e.defaultPrevented || e.target.closest?.('dialog')) return;
  if (anyDialogOpen() || $('#shell').hidden) return;
  const route = document.body.dataset.route;
  const el = document.activeElement;
  const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
  const inSearch = el === $('#q');
  // A letter is a command when the caret is not in a text field; in the search
  // box, the same letter with Alt.
  const cmd = (k) => (e.key.toLowerCase() === k && !e.ctrlKey && !e.metaKey)
    && ((!typing && !e.altKey) || (e.altKey && inSearch));

  // Ctrl+Z takes back the last change, on every page. In a text field it is
  // the field's own undo.
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z' && !typing) {
    e.preventDefault();
    undoLast();
    return;
  }

  if (route === 'organize') {
    if (organize.onKey(e, typing)) e.preventDefault();
    return;
  }
  if (route !== 'links') return;

  if (e.key === '/' && !typing) { e.preventDefault(); links.focusSearch(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); links.focusSearch(); return; }
  if (e.key === 'ArrowDown' && (!typing || inSearch)) { e.preventDefault(); links.moveCursor(1); return; }
  if (e.key === 'ArrowUp' && (!typing || inSearch)) { e.preventDefault(); links.moveCursor(-1); return; }
  if (e.key === 'Enter' && (!typing || inSearch)) { e.preventDefault(); links.openCursor(); return; }
  if (e.key === 'Escape') {
    if (links.onEscape()) e.preventDefault();
    else if (typing) el.blur();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && !typing) { e.preventDefault(); links.markAll(); return; }
  if (e.key === 'F2' || cmd('e')) { e.preventDefault(); links.editCursor(); return; }
  if (cmd('m')) { e.preventDefault(); links.moveSelected(); return; }
  if (cmd('p')) { e.preventDefault(); const b = links.cursorLink(); if (b) preview.openPreview(b); return; }
  if (cmd('x')) { e.preventDefault(); links.toggleCursorMark(); return; }
  if (cmd('g')) { e.preventDefault(); links.toggleMode(); return; }
  if (cmd('n')) { e.preventDefault(); openEditor(null, { folder: links.getScope() || '' }); return; }
  // Delete on its own is the forward-delete of a text field.
  if (e.key === 'Delete' && (!typing || e.ctrlKey || e.metaKey)) { e.preventDefault(); links.deleteSelected(); return; }
  // Any other letter starts a search, wherever the caret was.
  if (!typing && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && e.key !== ' ') links.focusSearch();
}

/* ---------------- the key screen ---------------- */

function showAuth() {
  $('#shell').hidden = true;
  $('#auth').hidden = false;
  $('#auth-open').hidden = false;
  $('#auth-created').hidden = true;
  // Arriving with a link to save, the screen is about the link: the key is
  // the one thing it asks for, and the button says what it will do.
  const saving = linkInPath();
  $('#auth-saving').hidden = !saving;
  $('#auth-title').textContent = saving ? 'Save this link' : 'Open your vault';
  $('#auth-lead').textContent = saving
    ? 'Enter your access key and it goes straight to your vault.'
    : 'Paste the access key you got when the vault was created.';
  $('#auth-submit').textContent = saving ? 'Save link' : 'Open vault';
  if (saving) {
    $('#auth-saving-fav').innerHTML = favicon(saving);
    $('#auth-saving-host').textContent = hostOf(saving);
    $('#auth-saving-url').textContent = saving.replace(/^https?:\/\/(www\.)?/, '');
    $('#auth-saving').title = saving;
  }
  $('#auth-key').focus();
  checkServer();
}

async function checkServer() {
  const line = $('#auth-server');
  try {
    const r = await fetch('/api/health', { cache: 'no-store' });
    if (!r.ok) throw new Error();
    line.hidden = true;
  } catch {
    line.hidden = false;
    line.textContent = 'The server is not answering. Is the stack up? (docker compose up -d)';
  }
}

// Keys are read in groups of four. Formatting as it is typed makes a paste
// with spaces or a missing dash look the same as a clean one.
function formatKey(raw) {
  const k = raw.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 32);
  return k.match(/.{1,4}/g)?.join('-') || '';
}

function wireAuth() {
  const input = $('#auth-key');
  input.addEventListener('input', () => {
    const at = input.selectionStart === input.value.length;
    input.value = formatKey(input.value);
    if (at) input.setSelectionRange(input.value.length, input.value.length);
    $('#auth-error').textContent = '';
  });

  // Reading the clipboard needs a secure context, and Firefox asks first.
  const paste = $('#auth-paste');
  paste.hidden = !navigator.clipboard?.readText;
  paste.onclick = async () => {
    try {
      input.value = formatKey(await navigator.clipboard.readText());
      $('#auth-error').textContent = '';
      input.focus();
      // A whole key pasted is a key ready to try.
      if (input.value.length === 39) $('#auth-open').requestSubmit();
    } catch {
      input.focus();
    }
  };

  $('#auth-open').onsubmit = async (e) => {
    e.preventDefault();
    const btn = $('#auth-submit');
    if (btn.disabled) return;
    const label = btn.textContent;
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    btn.textContent = linkInPath() ? 'Saving…' : 'Opening…';
    try {
      const r = await api('/api/auth/key', { method: 'POST', body: { key: input.value } });
      await enter(r.token, r.user);
    } catch (err) {
      $('#auth-error').textContent = isOffline(err) ? 'Could not reach the server.' : err.message;
      input.select();
    } finally {
      btn.disabled = false;
      btn.removeAttribute('aria-busy');
      btn.textContent = label;
    }
  };

  let created = null;
  $('#auth-new').onclick = async () => {
    try {
      created = await api('/api/auth/vault', { method: 'POST', body: {} });
    } catch (err) {
      $('#auth-error').textContent = isOffline(err) ? 'Could not reach the server.' : err.message;
      return;
    }
    $('#auth-open').hidden = true;
    $('#auth-created').hidden = false;
    settings.showKey($('#auth-new-key'), created.key);
    $('#auth-saved').checked = false;
    $('#auth-continue').disabled = true;
  };
  $('#auth-copy').onclick = () => settings.copy($('#auth-new-key').textContent, 'Key copied');
  $('#auth-saved').onchange = (e) => { $('#auth-continue').disabled = !e.target.checked; };
  $('#auth-continue').onclick = () => {
    if (created) enter(created.token, created.user);
    created = null;
  };
}

/* ---------------- entering and leaving ---------------- */

function rememberUser(user) {
  try { localStorage.setItem(USER_KEY, JSON.stringify(user)); } catch { /* fine */ }
  settings.setUser(user);
}

async function enter(token, user) {
  setToken(token);
  rememberUser(user);
  $('#auth-key').value = '';
  await openShell(user);
}

let shellWired = false;

async function openShell(user) {
  $('#auth').hidden = true;
  $('#shell').hidden = false;
  settings.setUser(user);
  if (!shellWired) {
    shellWired = true;
    window.addEventListener('hashchange', go);
  }
  // Paints from the cache when there is one; waits for the server only when
  // there is not.
  await store.open(user.id);
  store.startSync();
  const connecting = settings.connectRequest();
  if (connecting) {
    history.replaceState(null, '', '/#/settings');
    go();
    await settings.connectExtension(connecting);
    settings.show();
    return;
  }
  go();
  takeShare();
}

async function signOut() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* the token dies here either way */ }
  await store.close();
  setToken('');
  try { localStorage.removeItem(USER_KEY); } catch { /* fine */ }
  location.hash = '';
  showAuth();
}

/* ---------------- arriving from elsewhere ---------------- */

// The link in this page's own address, if it came in front of one.
function linkInPath() {
  return linkFromAddress(location);
}

// Saved at once, with no form, to Temporary: typing the prefix is the whole
// gesture, and the toast's undo is the way back. The list opens on the folder
// the link is in, so it is on screen. A link already in the vault is not saved
// twice.
async function saveFromPath(url) {
  const have = store.all().find((b) => sameLink(b.url, url));
  const show = (folder) => { if (links.getScope() !== folder) links.setScope(folder); tree.paint(); };
  if (have) {
    show(have.folder || '');
    toast(`Already saved in ${folderLabel(have.folder || '')}`);
    return;
  }
  try {
    const b = await store.create({ url, title: hostOf(url), folder: TEMP_FOLDER });
    show(TEMP_FOLDER);
    undoable(`Saved ${hostOf(url)} to ${TEMP_FOLDER}`, () => store.removeMany([b.id]));
  } catch (err) {
    fail(err);
  }
}

// Sharing a page from a phone lands here (the manifest's share_target):
// /?url=...&title=... opens the form already filled in. The manifest's
// shortcut opens /#new.
function takeShare() {
  const saving = linkInPath();
  if (saving) {
    history.replaceState(null, '', '/');
    saveFromPath(saving);
    return;
  }
  const p = new URLSearchParams(location.search);
  const text = p.get('text') || '';
  const inText = /https?:\/\/\S+/.exec(text);
  const url = p.get('url') || (inText ? inText[0] : '');
  const title = p.get('title') || (inText ? text.replace(inText[0], '').trim() : text);
  if (url || title) {
    history.replaceState(null, '', location.pathname);
    openEditor(null, { url, title });
  } else if (location.hash === '#new') {
    history.replaceState(null, '', location.pathname);
    openEditor();
  }
}

/* ---------------- pwa ---------------- */

function registerServiceWorker() {
  // Only in a secure context: https or localhost.
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  // A new worker takes over at once (skipWaiting); reloading then shows the
  // new shell instead of the one the old worker served. Not on a first
  // install, where there is no old shell to replace.
  const had = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!had || reloading) return;
    reloading = true;
    location.reload();
  });
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

/* ---------------- boot ---------------- */

(async function boot() {
  registerServiceWorker();
  for (const d of $$('dialog')) wireDialog(d);
  initEditor();
  settings.init({ signOut, onUser: rememberUser });
  links.init();
  preview.init();
  organize.init();
  activity.init();
  data.init();
  audit.init();
  clicklog.init();
  tree.init({
    current: () => {
      const route = document.body.dataset.route;
      if (route === 'organize') return organize.focusedPath();
      return route === 'links' ? links.getScope() : null;
    },
    pick: (path) => {
      if (document.body.dataset.route === 'organize') organize.openFolder(path);
      else {
        if (document.body.dataset.route !== 'links') location.hash = '#/';
        links.setScope(path);
      }
      closeMenu();
      tree.paint();
    },
  });
  wireAuth();

  $('#sel-move').onclick = () => links.moveSelected();
  $('#sel-delete').onclick = () => links.deleteSelected();
  // On the organizer, the new link goes where the pane in focus is looking.
  $('#tab-new').onclick = () => openEditor(null, {
    folder: (document.body.dataset.route === 'organize' ? organize.focusedPath() : links.getScope()) || '',
  });
  $('#side-new-folder').onclick = () => askNewFolder().catch(fail);
  for (const b of $$('[data-open-menu]')) b.onclick = openMenu;
  $('#scrim').onclick = closeMenu;
  document.addEventListener('keydown', onKey);
  // On the organizer a pasted link is filed in the folder in focus. A paste
  // into a text field is that field's.
  document.addEventListener('paste', (e) => {
    if (document.body.dataset.route !== 'organize' || anyDialogOpen() || $('#shell').hidden) return;
    const el = document.activeElement;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
    organize.onPaste(e);
  });

  fetch('/api/health', { cache: 'no-store' }).then((r) => r.json()).then((b) => settings.showBuild(b.build)).catch(() => {});

  store.onStatus((s) => {
    // The session ended elsewhere (the key was rotated, or signed out).
    if (s === 'signed-out') signOut();
  });

  if (!getToken()) return showAuth();

  // With a token and a remembered vault, the app opens straight from the
  // cache, and the token is checked behind it. Only the server saying no ends
  // the session: a server that is down does not.
  let user = null;
  try { user = JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch { /* none */ }
  const check = api('/api/me').then((r) => { rememberUser(r.user); return r.user; });
  if (user) {
    check.catch((err) => { if (!isOffline(err)) signOut(); });
    return openShell(user);
  }
  try {
    await openShell(await check);
  } catch (err) {
    if (!isOffline(err)) setToken('');
    showAuth();
  }
})();
