// The API, as the extension uses it. The same endpoints the app calls, with the
// session token the extension was given, and a header that has the audit trail
// say the change came from here. `fetch` is passed in so node can test this
// against a real server (extension/test/client.test.mjs).

export class AuthError extends Error {
  constructor() {
    super('signed out');
    this.name = 'AuthError';
  }
}

export function createClient({ server, token = '', fetch = globalThis.fetch.bind(globalThis) }) {
  async function call(method, path, body) {
    const res = await fetch(server + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        'x-bookmarks-via': 'extension',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
    if (res.status === 401 && token) throw new AuthError();
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `error ${res.status}`);
    return data;
  }

  return {
    // The key, typed into the extension, for a session of its own. The key is
    // not kept: only the token that comes back.
    signIn: (key) => call('POST', '/api/auth/key', { key, device: 'Browser extension' }),
    me: () => call('GET', '/api/me'),
    signOut: () => call('POST', '/api/auth/logout'),
    lookup: async (url) => (await call('GET', `/api/bookmarks?url=${encodeURIComponent(url)}`)).items,
    search: async (q, limit = 8) => (await call('GET', `/api/bookmarks?q=${encodeURIComponent(q)}&limit=${limit}`)).items,
    folders: () => call('GET', '/api/folders'),
    save: async ({ url, title, folder }) => (await call('POST', '/api/bookmarks', { url, title, folder })).item,
    remove: (id) => call('DELETE', `/api/bookmarks/${encodeURIComponent(id)}`),
    opened: (id) => call('POST', '/api/bookmarks/open', { id }),
  };
}
