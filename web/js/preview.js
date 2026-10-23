// A link's preview: resting the pointer on a link, or `p` on the one under
// the cursor, opens it in a dialog. The page itself, in a frame, when the site
// allows other pages to show it; otherwise, and on request, a card from what
// the page says about itself (its title, description and image).
//
// Most big sites refuse to be framed (X-Frame-Options, CSP frame-ancestors),
// and the browser gives a page no way to tell a refused frame from a slow one.
// So the server asks first, from the headers the site sends, and the dialog
// only tries a frame where one will show.

import { api } from './http.js';
import * as store from './store.js';
import { $, $$, esc, favicon, hostOf, wireDialog, anyDialogOpen } from './ui.js';

const HOVER_KEY = 'linksz_preview_hover';
const HOVER_MS = 1000;
// Leaving the card for this long closes a preview the pointer opened.
const LEAVE_MS = 350;
// The frame runs the site's scripts in its own origin, which can never reach
// this one. No allow-top-navigation: a page that tries to break out of the
// frame by navigating the app away is stopped.
const SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox';

// What the server said about each link, for this session. The server keeps
// its own for hours; this one only spares the round trip on a second look.
const cache = new Map();
const CACHE_MAX = 200;
const state = { link: null, info: null, mode: 'card', seq: 0, byHover: false, entered: false };

export function hoverEnabled() {
  try { return localStorage.getItem(HOVER_KEY) !== 'off'; } catch { return true; }
}

export function setHoverEnabled(on) {
  try { localStorage.setItem(HOVER_KEY, on ? 'on' : 'off'); } catch { /* this tab only */ }
  paintSetting();
}

function paintSetting() {
  const on = hoverEnabled();
  for (const b of $$('#preview-hover button')) b.classList.toggle('on', (b.dataset.hover === 'on') === on);
}

// The app is http on localhost; on https a plain-http page would be blocked
// as mixed content, and there the card is all there is.
function canFrame(info) {
  return !!info?.frame && !(location.protocol === 'https:' && /^http:/i.test(info.final_url || info.url));
}

async function load(url) {
  if (cache.has(url)) return cache.get(url);
  const info = await api(`/api/preview?url=${encodeURIComponent(url)}`);
  cache.set(url, info);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return info;
}

export async function openPreview(link, { byHover = false } = {}) {
  if (!link?.url || !/^https?:/i.test(link.url)) return;
  const dlg = $('#dlg-preview');
  const seq = ++state.seq;
  Object.assign(state, { link, info: null, mode: 'card', byHover, entered: false });
  paintHead();
  $('#preview-body').innerHTML = '<div class="preview-wait muted">Loading the preview…</div>';
  $('#preview-mode').hidden = true;
  if (!dlg.open) dlg.showModal();
  $('#preview-open').focus();

  let info;
  try { info = await load(link.url); } catch { info = null; }
  if (seq !== state.seq || !dlg.open) return;
  state.info = info || { url: link.url, final_url: link.url, title: '', description: '', image: '', site: hostOf(link.url), frame: false, offline: true };
  state.mode = canFrame(state.info) ? 'page' : 'card';
  paintHead();
  paintBody();
}

function paintHead() {
  const { link, info } = state;
  $('#preview-fav').innerHTML = favicon(link.url, link.title);
  $('#preview-title').textContent = link.title || info?.title || hostOf(link.url) || link.url;
  $('#preview-host').textContent = info?.site && info.site !== hostOf(link.url)
    ? `${info.site} · ${hostOf(link.url)}` : hostOf(link.url);
  $('#preview-open').href = link.url;
  const mode = $('#preview-mode');
  mode.hidden = !canFrame(info);
  for (const b of $$('button', mode)) b.classList.toggle('on', b.dataset.mode === state.mode);
}

function paintBody() {
  const { info } = state;
  const body = $('#preview-body');
  if (state.mode === 'page') {
    body.innerHTML = `<iframe class="preview-frame" sandbox="${SANDBOX}" referrerpolicy="no-referrer"
      title="${esc(info.title || hostOf(info.url))}" src="${esc(info.url)}"></iframe>`;
    return;
  }
  const why = info.offline
    ? 'The server could not be reached, so this is what the link itself says.'
    : canFrame(info) ? '' : `${esc(info.site || hostOf(info.url))} does not let other pages show it inside them. Open it to see the page.`;
  body.innerHTML = `<article class="preview-card">
    ${info.image ? `<img class="preview-image" src="${esc(info.image)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}
    <h3>${esc(state.link.title || info.title || hostOf(info.url))}</h3>
    ${info.description ? `<p>${esc(info.description)}</p>` : ''}
    <p class="preview-url muted">${esc(info.final_url || info.url)}</p>
    ${why ? `<p class="hint">${why}</p>` : ''}
  </article>`;
}

function close() {
  const dlg = $('#dlg-preview');
  if (dlg.open) dlg.close();
}

/* ---------------- the pointer ---------------- */

// A row in the list or in an Organize pane that is a link, not a folder.
const ROWS = '#list .row[data-id], .pane .orow[data-id]';
const coarse = () => matchMedia('(pointer: coarse)').matches;

let armed = null;
let timer = 0;
let lastX = -1;
let lastY = -1;

function disarm() {
  clearTimeout(timer);
  armed = null;
}

// Only a pointer that moved arms it. A row that slides under a pointer at
// rest (the list redrawn after a delete, or scrolled, which makes the browser
// send a mousemove of its own at the same spot) is not somebody pointing.
function onMove(e) {
  if (e.clientX === lastX && e.clientY === lastY) return;
  lastX = e.clientX;
  lastY = e.clientY;
  const row = e.target.closest?.(ROWS) || null;
  if (row === armed) return;
  disarm();
  // A button held down is a drag or a selection on its way, not a rest.
  if (!row || e.buttons || !hoverEnabled() || coarse() || anyDialogOpen()) return;
  armed = row;
  timer = setTimeout(() => {
    if (armed !== row || !row.isConnected || anyDialogOpen()) return;
    const link = store.get(row.dataset.id);
    disarm();
    if (link) openPreview(link, { byHover: true });
  }, HOVER_MS);
}

export function init() {
  const dlg = $('#dlg-preview');
  wireDialog(dlg);
  dlg.addEventListener('close', () => {
    state.seq += 1;
    // The frame goes with the dialog, or its page keeps playing behind it.
    $('#preview-body').innerHTML = '';
  });
  $('#preview-open').addEventListener('click', () => {
    if (state.link) store.registerOpen(state.link.id);
    close();
  });
  for (const b of $$('#preview-mode button')) {
    b.onclick = () => { state.mode = b.dataset.mode; paintHead(); paintBody(); };
  }

  // A preview the pointer opened closes when the pointer leaves it, once it
  // has been inside: it opens centred, so it often appears away from where
  // the pointer is. Measured against the card, not with pointerleave: the
  // backdrop of a modal dialog is the dialog as far as events go, so leaving
  // the card for it is never leaving.
  let leaving = 0;
  dlg.addEventListener('pointermove', (e) => {
    const r = dlg.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (inside) {
      state.entered = true;
      clearTimeout(leaving);
      leaving = 0;
    } else if (state.byHover && state.entered && !leaving) {
      leaving = setTimeout(() => { leaving = 0; close(); }, LEAVE_MS);
    }
  });

  document.addEventListener('mousemove', onMove);
  for (const type of ['mousedown', 'dragstart', 'keydown', 'wheel']) document.addEventListener(type, disarm, true);

  for (const b of $$('#preview-hover button')) b.onclick = () => setHoverEnabled(b.dataset.hover === 'on');
  paintSetting();
}
