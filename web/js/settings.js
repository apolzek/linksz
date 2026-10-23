// Settings: the theme, the vault's name, saving from anywhere, its key, and
// signing out.

import { api } from './http.js';
import * as store from './store.js';
import { $, $$, esc, plural, stamp, toast, fail, confirmDialog } from './ui.js';
import { bookmarklet } from './address.js';
import { PALETTES } from './themes.js';

const THEME_KEY = 'bookmarks_theme';

// 'auto', 'light', 'dark', or the name of one of the omarchy palettes.
export function applyTheme(name) {
  const root = document.documentElement;
  if (!['light', 'dark', ...PALETTES.map((p) => p.name)].includes(name)) name = 'auto';
  if (name === 'auto') delete root.dataset.theme;
  else root.dataset.theme = name;
  try { localStorage.setItem(THEME_KEY, name); } catch { /* this tab only */ }
  for (const b of $$('#theme button, #palettes button')) b.classList.toggle('on', b.dataset.theme === name);
  // The bar colour of an installed app follows the page.
  requestAnimationFrame(() => {
    const bg = getComputedStyle(document.body).backgroundColor;
    $('meta[name="theme-color"]').setAttribute('content', bg);
  });
}

// The key with a break opportunity after each dash, so it wraps between
// groups and never inside one. Copying still gives the plain key.
export function showKey(el, key) {
  el.innerHTML = `<span>${key.split('-').map((g) => g.replace(/[^0-9A-Z]/g, '')).join('-<wbr>')}</span>`;
}

export function copy(text, done = 'Copied') {
  navigator.clipboard?.writeText(text).then(() => toast(done), () => toast('Select the key and copy it', { error: true }));
}

let user = null;
let signOut = () => {};

export function setUser(u) {
  user = u;
  $('#vault-name').value = u?.name || '';
}

export function init(opts) {
  signOut = opts.signOut;
  let saved = 'auto';
  try { saved = localStorage.getItem(THEME_KEY) || 'auto'; } catch { /* default */ }
  $('#palettes').innerHTML = PALETTES.map((p) => `<button type="button" data-theme="${p.name}" title="${p.label}">
      <span class="swatch">${p.swatch.map((c) => `<i style="background:${c}"></i>`).join('')}</span><span>${p.label}</span></button>`).join('');
  applyTheme(saved);
  for (const b of $$('#theme button, #palettes button')) b.onclick = () => applyTheme(b.dataset.theme);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(localStorage.getItem(THEME_KEY) || 'auto'));

  $('#vault-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await api('/api/me', { method: 'POST', body: { name: $('#vault-name').value } });
      setUser(r.user);
      opts.onUser?.(r.user);
      toast('Saved');
    } catch (err) { fail(err); }
  };

  $('#btn-rotate').onclick = async () => {
    const yes = await confirmDialog({
      title: 'Generate a new access key?',
      text: 'The current key stops working now, and every other device using it is signed out. This one stays signed in.',
      ok: 'Generate',
    });
    if (!yes) return;
    try {
      const r = await api('/api/auth/rotate', { method: 'POST' });
      showKey($('#rotated-key'), r.key);
      $('#rotated').hidden = false;
      toast('New key ready. Save it now: it is not shown again.', { ms: 8000 });
    } catch (err) { fail(err); }
  };
  $('#rotated-copy').onclick = () => copy($('#rotated-key').textContent);
  $('#btn-signout').onclick = () => signOut();

  // The prefix is this app's own address, whatever host it is served from.
  const prefix = `${location.origin}/`;
  $('#prefix-example').textContent = `${prefix}https://www.youtube.com/watch?v=…`;
  $('#bookmarklet').href = bookmarklet(prefix);
  $('#bookmarklet').onclick = (e) => { e.preventDefault(); toast('Drag it to the bookmarks bar'); };
}

export function show() {
  const t = store.tree();
  $('#vault-stats').textContent = `${plural(store.count(), 'link')} in ${plural(t.paths.length, 'folder')}.`;
  paintDevices();
}

/* ---------------- devices ---------------- */

async function paintDevices() {
  const ul = $('#devices');
  let sessions;
  try {
    ({ sessions } = await api('/api/auth/sessions'));
  } catch {
    ul.innerHTML = '<li class="muted">The list needs the server.</li>';
    return;
  }
  ul.innerHTML = sessions.map((s) => `<li data-id="${s.id}">
      <div class="device-main"><span><strong>${esc(s.name || 'Signed in before devices had names')}</strong>${s.current ? '<span class="badge">This device</span>' : ''}</span>
        <span class="muted">Signed in ${stamp(s.created_at)} · last used ${stamp(s.last_used_at || s.created_at)}</span></div>
      <button type="button" class="btn sm danger-text" data-revoke="${s.id}">Sign out</button></li>`).join('');
  for (const b of $$('[data-revoke]', ul)) {
    b.onclick = () => revoke(sessions.find((s) => String(s.id) === b.dataset.revoke));
  }
}

async function revoke(s) {
  if (!s) return;
  const yes = await confirmDialog({
    title: `Sign out ${s.name || 'this session'}?`,
    text: s.current ? 'This is the device you are using: it goes back to the key screen.' : 'It will need the key, or to connect again, to open the vault.',
    ok: 'Sign out',
  });
  if (!yes) return;
  if (s.current) { signOut(); return; }
  try {
    await api('/api/auth/sessions/revoke', { method: 'POST', body: { id: s.id } });
    toast(`${s.name || 'The session'} is signed out`);
  } catch (err) { fail(err); }
  paintDevices();
}

/* ---------------- connecting the browser extension ---------------- */

// The extension opens #/connect/<its id>/<a nonce it made>. This app, signed in
// already, asks first, then makes a session for it alone and hands the token
// to that extension, which keeps it only if the nonce is the one it is waiting
// for. The access key never reaches the extension.
export function connectRequest(hash = location.hash) {
  const m = /^#\/connect\/([a-p]{32})\/([A-Za-z0-9_-]{16,64})$/.exec(hash);
  return m ? { extensionId: m[1], nonce: m[2] } : null;
}

export async function connectExtension({ extensionId, nonce }) {
  const runtime = globalThis.chrome?.runtime;
  if (!runtime?.sendMessage) {
    toast('No extension answers here. Open this from the Linksz extension, in Chrome or Chromium.', { error: true, ms: 8000 });
    return false;
  }
  const yes = await confirmDialog({
    title: 'Connect the browser extension?',
    text: 'It gets a session of its own, listed under Devices, where it can be signed out at any time. The access key is not shared.',
    ok: 'Connect',
    danger: false,
  });
  if (!yes) return false;
  let token;
  try {
    ({ token } = await api('/api/auth/session', { method: 'POST', body: { device: 'Browser extension' } }));
  } catch (err) { fail(err); return false; }
  const answer = await new Promise((resolve) => {
    try {
      runtime.sendMessage(extensionId, { type: 'linksz-connect', nonce, token, user }, (r) => {
        resolve(runtime.lastError ? null : r);
      });
    } catch { resolve(null); }
  });
  if (!answer?.ok) {
    // A session nobody holds is closed again.
    await fetch('/api/auth/logout', { method: 'POST', headers: { authorization: `Bearer ${token}` } }).catch(() => {});
    toast('The extension did not take the connection. Start again from its popup.', { error: true, ms: 8000 });
    return false;
  }
  toast('The extension is connected');
  return true;
}

export function showBuild(build) {
  if (!build || !build.commit) return;
  const when = build.deployed_at ? new Date(build.deployed_at) : null;
  $('#build').textContent = `Build ${build.commit}${when && !Number.isNaN(when.getTime()) ? ` · ${when.toLocaleDateString()}` : ''}`;
}
