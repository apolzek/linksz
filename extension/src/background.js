// The service worker: the connection the app hands over, the right-click
// menu, the address bar ("bm" then a space), and the mark on the toolbar
// button for a page that is saved already.

import { checkConnect, connectUrl, newNonce, omniboxSuggestions, isSaveable, TEMP_FOLDER } from './lib.js';
import { connection, saveConnection, setPending, pending, client } from './state.js';

/* ---------------- connecting ---------------- */

// From the popup: open the app on its connect page, with a nonce to match.
async function beginConnect(server) {
  const nonce = newNonce();
  await setPending({ server, nonce, at: Date.now() });
  await chrome.storage.local.set({ server });
  await chrome.tabs.create({ url: connectUrl(server, chrome.runtime.id, nonce) });
}

// From the app: the token, if this is the connection the popup started.
chrome.runtime.onMessageExternal.addListener((msg, sender, reply) => {
  (async () => {
    const waiting = await pending();
    const why = checkConnect(msg, sender.origin, waiting);
    if (why) { reply({ ok: false, error: why }); return; }
    await saveConnection({ server: waiting.server, token: msg.token, vault: msg.user?.name || '' });
    await setPending(null);
    reply({ ok: true });
    refreshBadge();
  })();
  return true;
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type === 'begin-connect') {
    beginConnect(msg.server).then(() => reply({ ok: true }), (err) => reply({ ok: false, error: err.message }));
    return true;
  }
  // The popup names the tab it saved: the active tab is the popup itself when
  // it is opened as a page.
  if (msg?.type === 'refresh-badge') {
    (msg.tabId ? chrome.tabs.get(msg.tabId) : Promise.resolve(undefined))
      .then(refreshBadge, () => {}).then(() => reply({ ok: true }));
    return true;
  }
  return false;
});

/* ---------------- the toolbar mark ---------------- */

async function refreshBadge(tab) {
  if (!tab) [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) return;
  const set = (text, color = '#40a02b') => {
    chrome.action.setBadgeText({ tabId: tab.id, text });
    if (text) chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color });
  };
  const c = await connection();
  if (!c.token) { set('!', '#d20f39'); return; }
  if (!isSaveable(tab.url)) { set(''); return; }
  try {
    const { api } = await client();
    set((await api.lookup(tab.url)).length ? '✓' : '');
  } catch {
    set('');
  }
}

chrome.tabs.onActivated.addListener(({ tabId }) => chrome.tabs.get(tabId).then(refreshBadge, () => {}));
chrome.tabs.onUpdated.addListener((tabId, info, tab) => { if (info.status === 'complete' && tab.active) refreshBadge(tab); });
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.token) refreshBadge(); });

/* ---------------- right click ---------------- */

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'save-page', title: 'Save page to Bookmarks', contexts: ['page'] });
  chrome.contextMenus.create({ id: 'save-link', title: 'Save link to Bookmarks', contexts: ['link'] });
  refreshBadge();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const url = info.menuItemId === 'save-link' ? info.linkUrl : tab?.url;
  const title = info.menuItemId === 'save-link' ? (info.selectionText || '') : (tab?.title || '');
  if (!isSaveable(url)) return;
  const flash = (text, color) => tab?.id && chrome.action.setBadgeText({ tabId: tab.id, text })
    .then(() => chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color }));
  try {
    const { api } = await client();
    if ((await api.lookup(url)).length === 0) await api.save({ url, title, folder: TEMP_FOLDER });
    flash('✓', '#40a02b');
  } catch {
    flash('!', '#d20f39');
  }
});

/* ---------------- the address bar ---------------- */

const lastSuggested = new Map();   // url -> bookmark id, to count the open

chrome.omnibox.setDefaultSuggestion({ description: 'Search your bookmarks' });

chrome.omnibox.onInputChanged.addListener(async (text, suggest) => {
  if (!text.trim()) return;
  try {
    const { api } = await client();
    const items = await api.search(text, 6);
    lastSuggested.clear();
    for (const b of items) lastSuggested.set(b.url, b.id);
    suggest(omniboxSuggestions(items));
  } catch {
    suggest([]);
  }
});

chrome.omnibox.onInputEntered.addListener(async (text, disposition) => {
  let url = text;
  let id = lastSuggested.get(text);
  const { api } = await client();
  // Enter on what was typed, not on a suggestion: the best match.
  if (!id) {
    const [best] = await api.search(text, 1).catch(() => []);
    if (!best) return;
    url = best.url;
    id = best.id;
  }
  api.opened(id).catch(() => {});
  if (disposition === 'currentTab') chrome.tabs.update({ url });
  else chrome.tabs.create({ url, active: disposition === 'newForegroundTab' });
});
