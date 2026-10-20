// Settings: the theme, the vault's name, saving from anywhere, its key, and
// signing out.

import { api } from './http.js';
import * as store from './store.js';
import { $, $$, plural, toast, fail, confirmDialog } from './ui.js';
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
}

export function showBuild(build) {
  if (!build || !build.commit) return;
  const when = build.deployed_at ? new Date(build.deployed_at) : null;
  $('#build').textContent = `Build ${build.commit}${when && !Number.isNaN(when.getTime()) ? ` · ${when.toLocaleDateString()}` : ''}`;
}
