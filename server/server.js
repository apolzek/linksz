// Backend: REST API, sync and static hosting for the web UI.
//
// Plain Node, zero dependencies: `node:sqlite`, `node:http` and `node:crypto`
// cover it. There is no framework and no router; routes are an object keyed by
// "METHOD /path", and anything not under /api/ is served as a static file.
//
// Authentication is an opaque token in the `Authorization: Bearer` header,
// stored in the `sessions` table. There is no cookie and no CSRF to consider,
// because the desktop bar talks to this same API from another origin.
//
// Neighbours:
//   db.js             schema and connection
//   auth.js           password hashing and tokens
//   portability.js    import/export
//   ../web/search.js  the same search engine that runs in the browser
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { open } = require('./db');
const { search } = require('../web/search');
const { hashPassword, verifyPassword, newToken, looksLikeEmail } = require('./auth');
const portability = require('./portability');

const WEB_DIR = path.join(__dirname, '..', 'web');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  // Without this content-type the browser ignores the manifest and never offers to install.
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

function now() { return Date.now(); }

function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
  });
  res.end(data);
}

// Importing a large vault easily goes past 2 MB; Chrome's HTML export is verbose.
const IMPORT_LIMIT = 32 * 1024 * 1024;

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('payload muito grande')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function str(v, max = 2000) {
  return String(v == null ? '' : v).slice(0, max).trim();
}

// Accepts "#a, b  #c" or ["a","b"] -> "a,b,c" (normalized, no #)
function normTags(v) {
  const parts = Array.isArray(v) ? v : String(v == null ? '' : v).split(/[,\s]+/);
  const seen = [];
  for (let t of parts) {
    t = String(t).replace(/^#/, '').trim().toLowerCase();
    if (t && !seen.includes(t)) seen.push(t);
  }
  return seen.join(',');
}

function normCategory(v) {
  return String(v == null ? '' : v).replace(/^@/, '').trim().toLowerCase().slice(0, 200);
}

function normFolder(v) {
  return String(v == null ? '' : v).trim().replace(/^\/+|\/+$/g, '').slice(0, 300);
}

function createApp(dbPath) {
  const db = open(dbPath);

  // Filled in at boot (ensureSeedUser). Kept out of `q` because it is process
  // state, not database state.
  const runtime = { demo: null };

  const q = {
    userByLogin: db.prepare('SELECT * FROM users WHERE email = ? OR username = ?'),
    userById: db.prepare('SELECT id, email, username, created_at FROM users WHERE id = ?'),
    insertUser: db.prepare('INSERT INTO users (email, username, pass_hash, created_at) VALUES (?, ?, ?, ?)'),
    insertSession: db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)'),
    sessionByToken: db.prepare('SELECT * FROM sessions WHERE token = ?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
    allBookmarks: db.prepare('SELECT * FROM bookmarks WHERE user_id = ? AND deleted = 0 ORDER BY updated_at DESC'),
    since: db.prepare('SELECT * FROM bookmarks WHERE user_id = ? AND updated_at > ? ORDER BY updated_at ASC'),
    getOne: db.prepare('SELECT * FROM bookmarks WHERE user_id = ? AND id = ?'),
    upsert: db.prepare(`
      INSERT INTO bookmarks (id, user_id, title, url, folder, category, tags, description, created_at, updated_at, deleted)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, id) DO UPDATE SET
        title=excluded.title, url=excluded.url, folder=excluded.folder,
        category=excluded.category, tags=excluded.tags, description=excluded.description,
        updated_at=excluded.updated_at, deleted=excluded.deleted
      WHERE excluded.updated_at >= bookmarks.updated_at`),
    softDelete: db.prepare('UPDATE bookmarks SET deleted = 1, updated_at = ? WHERE user_id = ? AND id = ?'),
  };

  function auth(req) {
    const h = req.headers.authorization || '';
    const m = /^Bearer\s+(.+)$/i.exec(h);
    if (!m) return null;
    const s = q.sessionByToken.get(m[1]);
    if (!s) return null;
    return q.userById.get(s.user_id) || null;
  }

  // Writes a bookmark coming from a client. The client's `updated_at` wins when
  // it is newer (last-write-wins), which is what keeps web and desktop converging.
  function writeBookmark(userId, b, ts = now()) {
    const id = str(b.id, 64) || crypto.randomUUID();
    const existing = q.getOne.get(userId, id);
    const updated = Number(b.updated_at) > 0 ? Number(b.updated_at) : ts;
    const created = existing ? existing.created_at : (Number(b.created_at) > 0 ? Number(b.created_at) : ts);

    q.upsert.run(
      id, userId,
      str(b.title, 500), str(b.url, 2000),
      normFolder(b.folder), normCategory(b.category), normTags(b.tags),
      str(b.description ?? b.notes, 5000),   // `notes`: the field's old name
      created, updated, b.deleted ? 1 : 0,
    );
    return q.getOne.get(userId, id);
  }

  const routes = {
    'POST /api/auth/register': async (req, res) => {
      const b = await readBody(req);
      const email = str(b.email, 200).toLowerCase();
      const username = str(b.username, 60).toLowerCase();
      const password = String(b.password || '');

      if (!looksLikeEmail(email)) return json(res, 400, { error: 'invalid email' });
      if (!/^[a-z0-9._-]{2,60}$/.test(username)) return json(res, 400, { error: 'username must be 2-60 chars (a-z 0-9 . _ -)' });
      if (password.length < 6) return json(res, 400, { error: 'password needs at least 6 characters' });
      if (q.userByLogin.get(email, username)) return json(res, 409, { error: 'email or username already exists' });

      const info = q.insertUser.run(email, username, hashPassword(password), now());
      const token = newToken();
      q.insertSession.run(token, Number(info.lastInsertRowid), now());
      return json(res, 201, { token, user: q.userById.get(Number(info.lastInsertRowid)) });
    },

    'POST /api/auth/login': async (req, res) => {
      const b = await readBody(req);
      const login = str(b.login || b.email || b.username, 200).toLowerCase();
      const user = q.userByLogin.get(login, login);
      if (!user || !verifyPassword(String(b.password || ''), user.pass_hash)) {
        return json(res, 401, { error: 'invalid credentials' });
      }
      const token = newToken();
      q.insertSession.run(token, user.id, now());
      return json(res, 200, { token, user: q.userById.get(user.id) });
    },

    'POST /api/auth/logout': async (req, res, user, url) => {
      const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
      if (m) q.deleteSession.run(m[1]);
      return json(res, 200, { ok: true });
    },

    'GET /api/me': async (req, res, user) => json(res, 200, { user }),

    'GET /api/bookmarks': async (req, res, user, url) => {
      const all = q.allBookmarks.all(user.id);
      const query = url.searchParams.get('q') || '';
      const limit = Math.min(Number(url.searchParams.get('limit')) || 200, 5000);
      const items = query.trim() ? search(all, query, limit) : all.slice(0, limit);
      return json(res, 200, { items, total: all.length });
    },

    'POST /api/bookmarks': async (req, res, user) => {
      const b = await readBody(req);
      if (!str(b.url) && !str(b.title)) return json(res, 400, { error: 'provide at least a url or a title' });
      return json(res, 201, { item: writeBookmark(user.id, b) });
    },

    // Export: yaml (native), html (browser format) or json (for scripts).
    'GET /api/export': async (req, res, user, url) => {
      const format = (url.searchParams.get('format') || 'yaml').toLowerCase();
      const items = q.allBookmarks.all(user.id);
      const stamp = new Date().toISOString().slice(0, 10);

      const renderers = {
        yaml: () => [portability.toYaml(items, { user: user.username }),
          'application/yaml; charset=utf-8', `vaultmarks-${stamp}.yaml`],
        html: () => [portability.toNetscapeHtml(items),
          'text/html; charset=utf-8', `vaultmarks-${stamp}.html`],
        json: () => [portability.toJson(items),
          'application/json; charset=utf-8', `vaultmarks-${stamp}.json`],
      };
      if (!renderers[format]) return json(res, 400, { error: 'format must be yaml, html or json' });

      const [body, type, filename] = renderers[format]();
      res.writeHead(200, {
        'content-type': type,
        'content-length': Buffer.byteLength(body),
        'content-disposition': `attachment; filename="${filename}"`,
        'cache-control': 'no-store',
      });
      return res.end(body);
    },

    // Import happens in two steps: without `apply` it only returns the plan and
    // nothing is written. The UI shows the plan, the user picks a mode, then applies.
    'POST /api/import': async (req, res, user) => {
      const b = await readBody(req, IMPORT_LIMIT);
      const content = typeof b.content === 'string' ? b.content : '';
      if (!content.trim()) return json(res, 400, { error: 'empty file' });

      const mode = String(b.mode || 'add');
      if (!portability.MODES.includes(mode)) {
        return json(res, 400, { error: `mode must be one of: ${portability.MODES.join(', ')}` });
      }

      let parsed;
      try {
        parsed = portability.parseImport(content, String(b.format || 'auto'));
      } catch (err) {
        return json(res, 400, { error: `could not read the file: ${err.message}` });
      }

      const existing = q.allBookmarks.all(user.id);
      const plan = portability.planImport(existing, parsed.items, mode);
      const preview = {
        format: parsed.format,
        summary: plan.summary,
        // A sample so the UI can show what will happen without dumping everything.
        examples: {
          create: plan.create.slice(0, 5).map((p) => p.incoming.title || p.incoming.url),
          update: plan.update.slice(0, 5).map((p) => p.current.title || p.current.url),
          remove: plan.remove.slice(0, 5).map((p) => p.current.title || p.current.url),
        },
      };

      if (!b.apply) return json(res, 200, { ...preview, applied: false });

      const ts = now();
      for (const { incoming } of plan.create) writeBookmark(user.id, { ...incoming, id: '' }, ts);
      for (const { incoming } of plan.update) writeBookmark(user.id, { ...incoming, updated_at: ts }, ts);
      for (const { current } of plan.remove) q.softDelete.run(ts, user.id, current.id);

      return json(res, 200, { ...preview, applied: true, total: q.allBookmarks.all(user.id).length });
    },

    // Two-way sync: the client sends what changed locally and gets back what changed here.
    'POST /api/sync': async (req, res, user) => {
      const b = await readBody(req);
      const since = Number(b.since) || 0;
      const pushed = Array.isArray(b.changes) ? b.changes : [];
      const ts = now();
      for (const item of pushed) writeBookmark(user.id, item, ts);
      const changes = q.since.all(user.id, since);
      return json(res, 200, { changes, now: ts, pushed: pushed.length });
    },
  };

  function handleBookmarkId(method, id, req, res, user) {
    // Rows with deleted=1 are tombstones (they exist only for sync); to the REST
    // API they no longer exist.
    const live = () => {
      const row = q.getOne.get(user.id, id);
      return row && !row.deleted ? row : null;
    };

    if (method === 'PUT') {
      return readBody(req).then((b) => {
        const existing = live();
        if (!existing) return json(res, 404, { error: 'not found' });
        const merged = { ...existing, ...b, id, updated_at: now() };
        return json(res, 200, { item: writeBookmark(user.id, merged) });
      });
    }
    if (method === 'DELETE') {
      if (!live()) return json(res, 404, { error: 'not found' });
      q.softDelete.run(now(), user.id, id);
      return json(res, 200, { ok: true });
    }
    if (method === 'GET') {
      const item = live();
      return item ? json(res, 200, { item }) : json(res, 404, { error: 'not found' });
    }
    return json(res, 405, { error: 'method not allowed' });
  }

  function serveStatic(res, pathname) {
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const file = path.join(WEB_DIR, rel);
    // Compare with the separator attached: without it `../webx/y` would pass
    // startsWith(WEB_DIR) just by being a string prefix.
    if (file !== WEB_DIR && !file.startsWith(WEB_DIR + path.sep)) {
      return json(res, 403, { error: 'forbidden' });
    }

    fs.readFile(file, (err, data) => {
      if (err) return json(res, 404, { error: 'not found' });

      const name = path.basename(file);
      const headers = { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' };

      if (name === 'sw.js') {
        // The service worker must always be revalidated, otherwise the browser
        // holds an old version for hours and the update never lands.
        headers['cache-control'] = 'no-cache';
        headers['service-worker-allowed'] = '/';
      } else if (name === 'index.html') {
        headers['cache-control'] = 'no-cache';
      } else {
        // The SW itself caches the shell, so a short window is enough here.
        headers['cache-control'] = 'public, max-age=300';
      }

      res.writeHead(200, headers);
      res.end(data);
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const { pathname } = url;

    // CORS is open: the desktop bar and other origins hit this same API.
    res.setHeader('access-control-allow-origin', req.headers.origin || '*');
    res.setHeader('access-control-allow-headers', 'content-type, authorization');
    res.setHeader('access-control-allow-methods', 'GET, POST, PUT, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    try {
      if (!pathname.startsWith('/api/')) return serveStatic(res, pathname);
      if (pathname === '/api/health') return json(res, 200, { ok: true, service: 'vaultmarks', demo: runtime.demo });

      const key = `${req.method} ${pathname}`;
      const isPublic = key === 'POST /api/auth/register' || key === 'POST /api/auth/login';
      const user = auth(req);
      if (!isPublic && !user) return json(res, 401, { error: 'not authenticated' });

      const idMatch = /^\/api\/bookmarks\/([^/]+)$/.exec(pathname);
      if (idMatch) return await handleBookmarkId(req.method, decodeURIComponent(idMatch[1]), req, res, user);

      const handler = routes[key];
      if (!handler) return json(res, 404, { error: 'route not found' });
      return await handler(req, res, user, url);
    } catch (err) {
      return json(res, 400, { error: err.message || 'error' });
    }
  });

  return { server, db, runtime };
}

// Test account, guaranteed on every boot of the stack.
//
// Without it a fresh database opens the login screen with nobody to log in as,
// and the first thing everyone does is register an account by hand just to see
// the app running. Idempotent: if the account exists it only resets the
// password, and it never touches that account's bookmarks.
//
// The password is known by design, so this is for local development and
// testing. Before publishing the instance on a network (compose + Caddy), turn
// it off with VAULTMARKS_SEED=0, or anyone who reads this file can log in.
function ensureSeedUser(db) {
  if (process.env.VAULTMARKS_SEED === '0') return null;

  const username = String(process.env.VAULTMARKS_SEED_USER || 'teste').toLowerCase();
  const email = String(process.env.VAULTMARKS_SEED_EMAIL || `${username}@vaultmarks.local`).toLowerCase();
  const password = String(process.env.VAULTMARKS_SEED_PASSWORD || 'teste123');
  const isDefaultPassword = !process.env.VAULTMARKS_SEED_PASSWORD;

  const existing = db.prepare('SELECT * FROM users WHERE email = ? OR username = ?').get(email, username);
  if (existing) {
    // Only rewrites when the current password does not match: avoids a fresh hash on every boot.
    if (!verifyPassword(password, existing.pass_hash)) {
      db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(password), existing.id);
    }
    return { username: existing.username, password, isDefaultPassword, created: false };
  }

  db.prepare('INSERT INTO users (email, username, pass_hash, created_at) VALUES (?, ?, ?, ?)')
    .run(email, username, hashPassword(password), now());
  return { username, password, isDefaultPassword, created: true };
}

if (require.main === module) {
  const port = Number(process.env.VAULTMARKS_PORT) || 8787;
  const host = process.env.VAULTMARKS_HOST || '127.0.0.1';
  const { server, db, runtime } = createApp();

  const seed = ensureSeedUser(db);
  // Only announced when the password is the default one: with a custom password
  // the shortcut on the login screen could not work anyway.
  runtime.demo = seed && seed.isDefaultPassword ? { login: seed.username } : null;
  server.listen(port, host, () => {
    console.log(`vaultmarks running on http://${host}:${port}`);
    if (seed) {
      // The password only reaches the log when it is the default one, which is
      // already in this file. A VAULTMARKS_SEED_PASSWORD stays out of the journal.
      const shown = seed.isDefaultPassword ? ` / ${seed.password}` : ' (password from VAULTMARKS_SEED_PASSWORD)';
      console.log(`test user: ${seed.username}${shown}`);
    }
  });
}

module.exports = { createApp, ensureSeedUser };
