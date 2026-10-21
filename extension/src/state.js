// Where the extension keeps what it needs between runs.
//
//   chrome.storage.local    { server, token, vault }: the session token, never
//                           the access key. On disk in the browser profile,
//                           readable by this extension only, not by the pages
//                           it runs next to. It is what the app keeps in
//                           localStorage, and it can be signed out on its own
//                           from Settings > Devices.
//   chrome.storage.session  { pending }: a connection started from the popup,
//                           in memory only, gone when the browser closes.

import { createClient, AuthError } from './client.js';
import { DEFAULT_SERVER } from './lib.js';

export async function connection() {
  const { server = DEFAULT_SERVER, token = '', vault = '' } = await chrome.storage.local.get(['server', 'token', 'vault']);
  return { server, token, vault };
}

export async function saveConnection({ server, token, vault }) {
  await chrome.storage.local.set({ server, token, vault: vault || '' });
}

// The server is kept: connecting again goes back to the same place.
export async function forget() {
  await chrome.storage.local.remove(['token', 'vault']);
}

export async function setPending(pending) {
  if (pending) await chrome.storage.session.set({ pending });
  else await chrome.storage.session.remove('pending');
}

export async function pending() {
  return (await chrome.storage.session.get('pending')).pending || null;
}

// A client for the current connection. A 401 means the session was signed out
// somewhere else (Settings > Devices, a new key): the token is dropped, and
// the popup asks to connect again.
export async function client() {
  const c = await connection();
  const api = createClient({ server: c.server, token: c.token });
  const guarded = {};
  for (const [name, fn] of Object.entries(api)) {
    guarded[name] = async (...args) => {
      try {
        return await fn(...args);
      } catch (err) {
        if (err instanceof AuthError) await forget();
        throw err;
      }
    };
  }
  return { ...c, api: guarded };
}

export { AuthError };
