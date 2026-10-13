// The one way the app talks to the API. Same origin behind nginx, so paths are
// relative and there is no CORS to think about.

const TOKEN_KEY = 'bookmarks_token';

let token = '';
try { token = localStorage.getItem(TOKEN_KEY) || ''; } catch { /* storage blocked */ }

export function getToken() { return token; }

export function setToken(value) {
  token = value || '';
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* the session lasts as long as the tab, then */ }
}

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// A fetch that never reached the server is not the server saying no. Telling
// the two apart is what keeps a restart from signing everybody out.
export function isOffline(err) {
  return !(err instanceof ApiError);
}

export async function api(path, { method = 'GET', body, raw = false } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  if (raw && res.ok) return res;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || `error ${res.status}`, res.status);
  return data;
}
