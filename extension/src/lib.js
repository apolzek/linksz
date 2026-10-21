// The extension's pure pieces: no chrome.*, no fetch, so node can test them
// (extension/test/lib.test.mjs).

export const DEFAULT_SERVER = 'http://localhost:8080';
// Where a link saved with no folder chosen goes; the app's own TEMP_FOLDER.
export const TEMP_FOLDER = 'Temporary';
// How long a connection started from the popup waits for the app's answer.
export const CONNECT_TTL = 10 * 60 * 1000;

// The server as an origin: scheme, host and port, nothing after. Anything that
// is not http(s) is refused rather than guessed at.
export function normalizeServer(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `http://${s}`;
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.origin;
  } catch {
    return '';
  }
}

// Whether the extension may ask for permission on its own: the two loopback
// names are in the manifest already, anything else is asked for at connect.
export function isBuiltinHost(server) {
  try {
    const { hostname } = new URL(server);
    return hostname === 'localhost' || hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

// The permission pattern for a server: every path, any port.
export function originPattern(server) {
  const u = new URL(server);
  return `${u.protocol}//${u.hostname}/*`;
}

// Only web pages are saved: chrome://, file:, about: and the extension's own
// pages are not links anyone can open from the vault.
export function isSaveable(url) {
  return /^https?:\/\/[^/]/i.test(String(url || ''));
}

// The whole tree from what /api/folders answers: the folders made on purpose,
// the folders bookmarks are in, and every parent of either, sorted.
export function folderPaths({ folders = [], used = [] } = {}) {
  const out = new Set();
  for (const p of [...folders.map((f) => f.path), ...used]) {
    const parts = String(p || '').split('/').filter(Boolean);
    for (let i = 1; i <= parts.length; i++) out.add(parts.slice(0, i).join('/'));
  }
  return [...out].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

// A folder as typed: no empty segments, no stray spaces around them.
export function cleanFolder(raw) {
  return String(raw || '').split('/').map((p) => p.trim()).filter(Boolean).join('/');
}

export function folderLabel(path) {
  return path ? path : 'Unfiled';
}

// The omnibox speaks a small XML: the description has to be escaped, and
// <match> and <url> are the only markup in it.
export function escapeXml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

export function omniboxSuggestions(items, limit = 6) {
  return items.slice(0, limit).map((b) => ({
    content: b.url,
    description: `${escapeXml(b.title || b.url)} <url>${escapeXml(b.url)}</url>${b.folder ? ` <dim>${escapeXml(b.folder)}</dim>` : ''}`,
  }));
}

// A nonce for one connection: 24 random bytes, base64url.
export function newNonce(bytes = crypto.getRandomValues(new Uint8Array(24))) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// The page the app connects from: its own settings, told which extension is
// asking and with which nonce.
export function connectUrl(server, extensionId, nonce) {
  return `${server}/#/connect/${extensionId}/${nonce}`;
}

// Whether a message from a page is the answer to the connection this
// extension started: the right type, from the server it opened, with the
// nonce it made, in time. Returns the reason when it is not.
export function checkConnect(msg, senderOrigin, pending, now = Date.now()) {
  if (!msg || msg.type !== 'bookmarks-connect') return 'not a connection';
  if (!pending || !pending.nonce) return 'no connection is waiting';
  if (now - pending.at > CONNECT_TTL) return 'the connection waited too long';
  if (senderOrigin !== pending.server) return 'from another server';
  if (msg.nonce !== pending.nonce) return 'another nonce';
  if (typeof msg.token !== 'string' || !/^[0-9a-f]{64}$/.test(msg.token)) return 'no token';
  return '';
}
