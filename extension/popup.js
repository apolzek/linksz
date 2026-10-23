// The popup: connect, save the page on screen, search.
//
// popup.html?tab=<id> works on that tab instead of the active one, which is
// what lets the browser tests open the popup as a page of its own.

import { normalizeServer, isBuiltinHost, originPattern, isSaveable, folderPaths, cleanFolder, folderLabel, TEMP_FOLDER, DEFAULT_SERVER } from './src/lib.js';
import { connection, saveConnection, forget, client, AuthError } from './src/state.js';

const $ = (s) => document.querySelector(s);
const LAST_FOLDER = 'lastFolder';

async function targetTab() {
  const id = Number(new URLSearchParams(location.search).get('tab'));
  if (id) return chrome.tabs.get(id);
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

/* ---------------- not connected ---------------- */

async function showConnect(why = '') {
  $('#connected').hidden = true;
  $('#footer').hidden = true;
  $('#connect').hidden = false;
  $('#connect-why').textContent = why;
  const c = await connection();
  $('#server').value = c.server || DEFAULT_SERVER;
}

// Permission for a server that is not this machine is asked for here, in the
// click, which is the only place the browser lets it be asked.
async function serverWithPermission() {
  const server = normalizeServer($('#server').value || DEFAULT_SERVER);
  if (!server) throw new Error('That is not an http or https address.');
  if (!isBuiltinHost(server)) {
    const granted = await chrome.permissions.request({ origins: [originPattern(server)] });
    if (!granted) throw new Error(`The extension needs permission to reach ${server}.`);
  }
  return server;
}

$('#btn-connect').onclick = async () => {
  $('#connect-error').textContent = '';
  try {
    const server = await serverWithPermission();
    if (!isBuiltinHost(server)) {
      throw new Error('Connecting through the app works on localhost. For another server, use the access key.');
    }
    const r = await chrome.runtime.sendMessage({ type: 'begin-connect', server });
    if (!r?.ok) throw new Error(r?.error || 'Could not open the app.');
    window.close();
  } catch (err) {
    $('#connect-error').textContent = err.message;
  }
};

$('#btn-key').onclick = async () => {
  $('#connect-error').textContent = '';
  try {
    const server = await serverWithPermission();
    const { createClient } = await import('./src/client.js');
    const r = await createClient({ server }).signIn($('#key').value);
    $('#key').value = '';
    await saveConnection({ server, token: r.token, vault: r.user?.name });
    await showConnected();
  } catch (err) {
    $('#connect-error').textContent = /key does not open/.test(err.message) ? 'That key does not open any vault.' : err.message;
  }
};

/* ---------------- connected ---------------- */

let tab = null;
let saved = null;

function fail(err) {
  if (err instanceof AuthError) { showConnect('This extension was signed out. Connect it again.'); return; }
  $('#error').textContent = err.message === 'Failed to fetch' ? 'The server does not answer.' : err.message;
}

async function showConnected() {
  const c = await connection();
  if (!c.token) return showConnect();
  $('#connect').hidden = true;
  $('#connected').hidden = false;
  $('#footer').hidden = false;
  $('#vault').textContent = c.vault;
  $('#error').textContent = '';
  $('#q').focus();

  tab = await targetTab();
  const { api } = await client();
  const canSave = isSaveable(tab?.url);
  $('#title').value = tab?.title || '';
  $('#url').textContent = tab?.url || '';
  $('#save-form').querySelectorAll('input, button').forEach((el) => { el.disabled = !canSave; });
  if (!canSave) {
    $('#saved-note').className = 'note muted';
    $('#saved-note').textContent = 'Only web pages can be saved.';
  }
  const { [LAST_FOLDER]: last = TEMP_FOLDER } = await chrome.storage.local.get(LAST_FOLDER);
  $('#folder').value = last;

  try {
    const [here, folders] = await Promise.all([canSave ? api.lookup(tab.url) : [], api.folders()]);
    $('#folders').innerHTML = '';
    for (const p of folderPaths(folders)) $('#folders').append(new Option(p, p));
    if (here.length) {
      $('#saved-note').className = 'note ok';
      $('#saved-note').textContent = `Already saved in ${here.map((b) => folderLabel(b.folder)).join(', ')}.`;
      $('#btn-save').textContent = 'Save again';
    }
  } catch (err) { fail(err); }
}

$('#save-form').onsubmit = async (e) => {
  e.preventDefault();
  $('#error').textContent = '';
  const folder = cleanFolder($('#folder').value) || TEMP_FOLDER;
  try {
    const { api } = await client();
    saved = await api.save({ url: tab.url, title: $('#title').value.trim() || tab.title || '', folder });
    await chrome.storage.local.set({ [LAST_FOLDER]: folder });
    $('#saved-note').className = 'note ok';
    $('#saved-note').textContent = `Saved to ${folderLabel(folder)}.`;
    $('#btn-save').disabled = true;
    $('#btn-undo').hidden = false;
    chrome.runtime.sendMessage({ type: 'refresh-badge', tabId: tab?.id }).catch(() => {});
  } catch (err) { fail(err); }
};

$('#btn-undo').onclick = async () => {
  if (!saved) return;
  try {
    const { api } = await client();
    await api.remove(saved.id);
    saved = null;
    $('#saved-note').className = 'note muted';
    $('#saved-note').textContent = 'Not saved.';
    $('#btn-save').disabled = false;
    $('#btn-undo').hidden = true;
    chrome.runtime.sendMessage({ type: 'refresh-badge', tabId: tab?.id }).catch(() => {});
  } catch (err) { fail(err); }
};

// The search comes first: the popup opens on it. While there is a query the
// save card steps aside, and the keyboard moves through the results: the
// arrows pick one, Enter opens it (the first, when none is picked).
let searching = 0;
let picked = 0;

function openBookmark(api, b) {
  api.opened(b.id).catch(() => {});
  chrome.tabs.create({ url: b.url }).then(() => window.close());
}

function pick(i) {
  const rows = [...document.querySelectorAll('#results button')];
  if (!rows.length) return;
  picked = (i + rows.length) % rows.length;
  rows.forEach((r, n) => r.classList.toggle('picked', n === picked));
  rows[picked].scrollIntoView({ block: 'nearest' });
}

$('#q').addEventListener('input', async () => {
  const q = $('#q').value.trim();
  const mine = ++searching;
  $('#save-form').hidden = Boolean(q);
  if (!q) { $('#results').innerHTML = ''; return; }
  try {
    const { api } = await client();
    const items = await api.search(q, 8);
    if (mine !== searching) return;
    $('#results').innerHTML = '';
    for (const b of items) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.tabIndex = -1;
      btn.dataset.id = b.id;
      btn.innerHTML = '<span class="t"></span><span class="u"></span>';
      btn.querySelector('.t').textContent = b.title || b.url;
      btn.querySelector('.u').textContent = `${folderLabel(b.folder)} · ${b.url}`;
      btn.onclick = () => openBookmark(api, b);
      li.append(btn);
      $('#results').append(li);
    }
    if (!items.length) $('#results').innerHTML = '<li class="muted small">Nothing matches.</li>';
    pick(0);
  } catch (err) { fail(err); }
});

$('#q').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); pick(picked + 1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); pick(picked - 1); }
  else if (e.key === 'Enter') {
    e.preventDefault();
    document.querySelectorAll('#results button')[picked]?.click();
  }
});

$('#btn-app').onclick = async () => {
  const c = await connection();
  await chrome.tabs.create({ url: `${c.server}/` });
  window.close();
};

$('#btn-disconnect').onclick = async () => {
  try { const { api } = await client(); await api.signOut(); } catch { /* the token is dropped either way */ }
  await forget();
  chrome.runtime.sendMessage({ type: 'refresh-badge', tabId: tab?.id }).catch(() => {});
  showConnect('Disconnected.');
};

showConnected();
