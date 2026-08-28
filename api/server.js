// Backend: REST API, sync and static hosting for the web UI.
//
// Plain Node, zero dependencies: `node:sqlite`, `node:http` and `node:crypto`
// cover it. There is no framework and no router; routes are an object keyed by
// "METHOD /path", and anything not under /api/ is served as a static file.
//
// Authentication is an opaque token in the `Authorization: Bearer` header,
// stored in the `sessions` table. There is no cookie, so there is no CSRF to
// consider: a cross-site request carries no credentials of its own.
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
const { execFileSync } = require('node:child_process');

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

// A folder path with the empty segments dropped: `//a//b/` -> `a/b`.
function normFolderPath(v) {
  return normFolder(v).split('/').map((p) => p.trim()).filter(Boolean).join('/');
}

// `_` and `%` are wildcards inside LIKE: a folder named `100%` would otherwise
// match far more than itself.
function escapeLike(v) {
  return String(v).replace(/[\\%_]/g, (c) => '\\' + c);
}

// Usage counters arriving from a client. Never negative, never fractional:
// they are merged with MAX and a bogus value would stick forever.
const DAY = 86400000;
// How far back the log is kept. Long enough for "the last week" to always be
// complete, short enough that it stays a recent history.
const OPENS_LOG_DAYS = 30;

// Midnight local time, which is the day boundary a person means.
function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function counter(v) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// What is running right now: which commit the frontend came from and when it
// was put there. A pipeline sets the two environment variables at deploy time;
// with none set (running from a clone) it falls back to asking git, and if even
// that is unavailable the UI simply shows nothing.
let buildInfoCache = null;
function buildInfo() {
  if (buildInfoCache) return buildInfoCache;

  const fromEnv = {
    commit: str(process.env.BOOKMARKS_COMMIT, 40),
    deployed_at: str(process.env.BOOKMARKS_DEPLOYED_AT, 40),
  };
  if (fromEnv.commit) {
    buildInfoCache = { ...fromEnv, source: 'env' };
    return buildInfoCache;
  }

  try {
    const git = (...args) => execFileSync('git', args, {
      cwd: path.join(__dirname, '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    buildInfoCache = {
      commit: git('rev-parse', '--short', 'HEAD'),
      // The commit's own date: with no pipeline, that is the closest thing to
      // a deploy date there is.
      deployed_at: git('log', '-1', '--format=%cI'),
      source: 'git',
    };
  } catch {
    buildInfoCache = { commit: '', deployed_at: '', source: 'unknown' };
  }
  return buildInfoCache;
}

function createApp(dbPath) {
  const db = open(dbPath);

  // Filled in at boot (ensureSeedUser). Kept out of `q` because it is process
  // state, not database state.
  const runtime = { demo: null };

  // Which origins may drive this API from a browser, read from
  // BOOKMARKS_ALLOWED_ORIGINS (comma separated). Empty is the default and the
  // right answer for the shipped stack: nginx serves the PWA and proxies /api
  // on one origin, so the browser never makes a cross-origin request and no
  // CORS header is needed for the app to work.
  //
  // `*` puts it back to answering everyone, which is a decision someone has to
  // write down rather than something inherited.
  const allowedOrigins = new Set(
    String(process.env.BOOKMARKS_ALLOWED_ORIGINS || '')
      .split(',')
      .map((o) => o.trim().replace(/\/+$/, ''))
      .filter(Boolean),
  );
  const anyOriginAllowed = allowedOrigins.has('*');

  const q = {
    userByLogin: db.prepare('SELECT * FROM users WHERE email = ? OR username = ?'),
    userById: db.prepare('SELECT id, email, username, created_at FROM users WHERE id = ?'),
    insertUser: db.prepare('INSERT INTO users (email, username, pass_hash, created_at) VALUES (?, ?, ?, ?)'),
    insertSession: db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)'),
    sessionByToken: db.prepare('SELECT * FROM sessions WHERE token = ?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
    allBookmarks: db.prepare('SELECT * FROM bookmarks WHERE user_id = ? AND deleted = 0 ORDER BY updated_at DESC'),
    // >= and not >: the cursor is a millisecond, and a change written in the
    // same millisecond as the previous answer would fall in the gap and never
    // be sent again. Resending a row the client already has costs nothing,
    // losing one costs a deletion that never arrives.
    since: db.prepare('SELECT * FROM bookmarks WHERE user_id = ? AND updated_at >= ? ORDER BY updated_at ASC'),
    getOne: db.prepare('SELECT * FROM bookmarks WHERE user_id = ? AND id = ?'),
    upsert: db.prepare(`
      INSERT INTO bookmarks (id, user_id, title, url, folder, category, tags, description, created_at, updated_at, deleted, opens, last_open_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, id) DO UPDATE SET
        title=excluded.title, url=excluded.url, folder=excluded.folder,
        category=excluded.category, tags=excluded.tags, description=excluded.description,
        updated_at=excluded.updated_at, deleted=excluded.deleted,
        -- The counters never go backwards: two devices that opened the same
        -- link while offline both keep what they counted.
        opens=MAX(excluded.opens, bookmarks.opens),
        last_open_at=MAX(excluded.last_open_at, bookmarks.last_open_at)
      WHERE excluded.updated_at >= bookmarks.updated_at`),
    softDelete: db.prepare('UPDATE bookmarks SET deleted = 1, updated_at = ? WHERE user_id = ? AND id = ?'),
    logOpen: db.prepare('INSERT INTO opens_log (user_id, bookmark_id, at) VALUES (?, ?, ?)'),
    pruneLog: db.prepare('DELETE FROM opens_log WHERE user_id = ? AND at < ?'),
    // Most opened inside the window, with the bookmark's own fields alongside.
    topOpened: db.prepare(`
      SELECT b.id, b.title, b.url, b.folder, b.category, b.opens AS total, COUNT(l.id) AS hits
      FROM opens_log l JOIN bookmarks b ON b.user_id = l.user_id AND b.id = l.bookmark_id
      WHERE l.user_id = ? AND l.at >= ? AND b.deleted = 0
      GROUP BY b.id ORDER BY hits DESC, b.opens DESC LIMIT ?`),
    recentOpens: db.prepare(`
      SELECT l.at, b.id, b.title, b.url, b.folder
      FROM opens_log l JOIN bookmarks b ON b.user_id = l.user_id AND b.id = l.bookmark_id
      WHERE l.user_id = ? AND l.at >= ?
      ORDER BY l.at DESC LIMIT ?`),
    countOpens: db.prepare('SELECT COUNT(*) AS n FROM opens_log WHERE user_id = ? AND at >= ?'),
    // All time, for the bookmarks that were opened before the log existed.
    topEver: db.prepare(`
      SELECT id, title, url, folder, category, opens AS total, last_open_at
      FROM bookmarks WHERE user_id = ? AND deleted = 0 AND opens > 0
      ORDER BY opens DESC, last_open_at DESC LIMIT ?`),
    registerOpen: db.prepare(`
      UPDATE bookmarks SET opens = opens + 1, last_open_at = ?, updated_at = ?
      WHERE user_id = ? AND id = ? AND deleted = 0`),
    // Moving a folder is a prefix rewrite over every bookmark inside it.
    inFolder: db.prepare(`
      SELECT * FROM bookmarks
      WHERE user_id = ? AND deleted = 0 AND (folder = ? OR folder LIKE ? ESCAPE '\\')`),
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
  // it is newer (last-write-wins), which is what keeps two clients converging.
  //
  // `revive` is what a sync push does not get. A push carries the whole record,
  // including rows the other side only touched to count an open, and a counter
  // bump must not undo a deletion: delete a bookmark on the web, open it on the
  // bar a moment later, and it would come back from the dead. Deleting stays
  // deliberate, so only a deliberate write (create, edit, import) revives.
  function writeBookmark(userId, b, ts = now(), { revive = true } = {}) {
    const id = str(b.id, 64) || crypto.randomUUID();
    const existing = q.getOne.get(userId, id);
    const updated = Number(b.updated_at) > 0 ? Number(b.updated_at) : ts;
    const created = existing ? existing.created_at : (Number(b.created_at) > 0 ? Number(b.created_at) : ts);
    const buried = !revive && existing?.deleted === 1;

    q.upsert.run(
      id, userId,
      str(b.title, 500), str(b.url, 2000),
      normFolder(b.folder), normCategory(b.category), normTags(b.tags),
      str(b.description ?? b.notes, 5000),   // `notes`: the field's old name
      created, updated, (buried || b.deleted) ? 1 : 0,
      counter(b.opens), counter(b.last_open_at),
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
          'application/yaml; charset=utf-8', `bookmarks-${stamp}.yaml`],
        html: () => [portability.toNetscapeHtml(items),
          'text/html; charset=utf-8', `bookmarks-${stamp}.html`],
        json: () => [portability.toJson(items),
          'application/json; charset=utf-8', `bookmarks-${stamp}.json`],
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

      const source = String(b.source || 'native');
      if (!portability.SOURCES.includes(source)) {
        return json(res, 400, { error: `source must be one of: ${portability.SOURCES.join(', ')}` });
      }
      // A browser file is a partial view of a vault: no ids, no categories, and
      // tags only where the browser wrote them. Letting it replace the vault
      // would delete every bookmark the browser never knew about, which nobody
      // importing from Chrome is asking for.
      if (source === 'browser' && mode === 'replace') {
        return json(res, 400, {
          error: 'a browser file cannot replace the vault: it does not carry everything a bookmark has',
        });
      }

      let parsed;
      try {
        parsed = portability.readImport(content, { source, folderPrefix: b.folderPrefix });
      } catch (err) {
        // The wrong flow is not a broken file, and saying "could not read" would
        // send someone looking for corruption in an export that is perfectly fine.
        const prefix = err instanceof portability.WrongSourceError ? '' : 'could not read the file: ';
        return json(res, 400, { error: `${prefix}${err.message}` });
      }

      const existing = q.allBookmarks.all(user.id);
      const plan = portability.planImport(existing, parsed.items, mode, {
        // A browser file cannot speak about categories, and only sometimes
        // about tags and descriptions. It may add, never take away.
        partialFields: source === 'browser' ? portability.BROWSER_PARTIAL_FIELDS : [],
      });
      const preview = {
        source: parsed.source,
        format: parsed.format,
        // What the file itself carried, before deciding what to do with it.
        file: { ...parsed.stats, prefix: parsed.prefix },
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
      for (const { incoming } of plan.create) {
        // The id in the file is kept: an export is a backup, and restoring one
        // has to give back the same bookmarks, not copies of them. The one
        // catch is a tombstone with that id (deleted here, still in the file):
        // the last-write-wins gate would drop the write and the bookmark would
        // never come back, so that write is stamped now.
        const buried = incoming.id ? q.getOne.get(user.id, incoming.id) : null;
        // Strictly newer than the tombstone, not merely now: a client with a
        // clock running ahead can leave a timestamp in the future, and a
        // restore losing to it would fail quietly.
        const stamp = buried ? Math.max(ts, buried.updated_at + 1) : ts;
        writeBookmark(user.id, buried ? { ...incoming, updated_at: stamp } : incoming, ts);
      }
      for (const { incoming } of plan.update) writeBookmark(user.id, { ...incoming, updated_at: ts }, ts);
      for (const { current } of plan.remove) q.softDelete.run(ts, user.id, current.id);

      return json(res, 200, { ...preview, applied: true, total: q.allBookmarks.all(user.id).length });
    },

    // Ranking input: the client says "I just opened this one". Kept apart from
    // PUT so that opening a bookmark cannot rewrite its fields by accident.
    'POST /api/bookmarks/open': async (req, res, user) => {
      const b = await readBody(req);
      const id = str(b.id, 64);
      const ts = now();
      const info = q.registerOpen.run(ts, ts, user.id, id);
      if (!info.changes) return json(res, 404, { error: 'not found' });
      // The counter says how often, the log says when: insights needs both.
      q.logOpen.run(user.id, id, ts);
      q.pruneLog.run(user.id, ts - OPENS_LOG_DAYS * DAY);
      return json(res, 200, { item: q.getOne.get(user.id, id) });
    },

    // Moves a folder (with everything under it) into another one. `to` empty
    // means the root. The path is a string on each bookmark, so this is a
    // prefix rewrite, and every touched row is bumped so the sync carries it.
    'POST /api/folders/move': async (req, res, user) => {
      const b = await readBody(req);
      const from = normFolderPath(b.from);
      const to = normFolderPath(b.to);
      if (!from) return json(res, 400, { error: 'from is required' });

      const name = from.split('/').pop();
      const target = to ? `${to}/${name}` : name;
      if (target === from) return json(res, 200, { moved: 0, from, to: target });
      // Dropping a folder inside itself would detach the branch from the tree.
      if (to === from || to.startsWith(from + '/')) {
        return json(res, 400, { error: 'a folder cannot move inside itself' });
      }

      // LIKE with the separator attached, so `dev` does not also match `devops`.
      const rows = q.inFolder.all(user.id, from, escapeLike(from) + '/%');
      const ts = now();
      for (const row of rows) {
        const rest = row.folder.slice(from.length);      // '' or '/child/…'
        writeBookmark(user.id, { ...row, folder: target + rest, updated_at: ts }, ts);
      }
      return json(res, 200, { moved: rows.length, from, to: target });
    },

    // Browsing habits: what gets opened, and when. Everything is derived from
    // opens_log, except the all-time top, which the counter answers on its own.
    'GET /api/insights': async (req, res, user, url) => {
      const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 7, 1), OPENS_LOG_DAYS);
      const now = Date.now();
      const since = now - days * DAY;

      const rows = q.recentOpens.all(user.id, since, 500);
      // One bucket per day, oldest first, including the days with nothing in
      // them: a gap in the chart is information too.
      const buckets = [];
      for (let i = days - 1; i >= 0; i--) {
        const start = startOfDay(now - i * DAY);
        buckets.push({ day: new Date(start).toISOString().slice(0, 10), start, count: 0 });
      }
      for (const row of rows) {
        const bucket = buckets.find((b) => row.at >= b.start && row.at < b.start + DAY);
        if (bucket) bucket.count += 1;
      }

      return json(res, 200, {
        days,
        since,
        total: q.countOpens.get(user.id, since).n,
        daily: buckets.map(({ day, count }) => ({ day, count })),
        top: q.topOpened.all(user.id, since, 10),
        top_ever: q.topEver.all(user.id, 10),
        log: rows.slice(0, 200),
      });
    },

    // Two-way sync: the client sends what changed locally and gets back what changed here.
    'POST /api/sync': async (req, res, user) => {
      const b = await readBody(req);
      const since = Number(b.since) || 0;
      const pushed = Array.isArray(b.changes) ? b.changes : [];
      const ts = now();
      // A push never revives: see writeBookmark.
      for (const item of pushed) writeBookmark(user.id, item, ts, { revive: false });
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

    // No CORS unless someone asked for it. What the old open policy allowed was
    // any page in the browser reading this API with a token the person had
    // already pasted into it; the app itself never needed it, being same-origin
    // behind nginx. A refused origin gets no header, which is what makes the
    // browser block the response.
    const origin = req.headers.origin;
    if (origin && (anyOriginAllowed || allowedOrigins.has(origin.replace(/\/+$/, '')))) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('access-control-allow-headers', 'content-type, authorization');
      res.setHeader('access-control-allow-methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('access-control-max-age', '600');
    }
    // Set even when the origin is refused: the answer depends on Origin either
    // way, and a shared cache that does not know that hands one site the
    // response meant for another.
    res.setHeader('vary', 'Origin');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    try {
      if (!pathname.startsWith('/api/')) return serveStatic(res, pathname);
      if (pathname === '/api/health') {
        return json(res, 200, { ok: true, service: 'bookmarks', demo: runtime.demo, build: buildInfo() });
      }

      const key = `${req.method} ${pathname}`;
      const isPublic = key === 'POST /api/auth/register' || key === 'POST /api/auth/login';
      const user = auth(req);
      if (!isPublic && !user) return json(res, 401, { error: 'not authenticated' });

      // Named routes first: otherwise `POST /api/bookmarks/open` would be read
      // as a bookmark whose id is "open".
      const handler = routes[key];
      if (handler) return await handler(req, res, user, url);

      const idMatch = /^\/api\/bookmarks\/([^/]+)$/.exec(pathname);
      if (idMatch) return await handleBookmarkId(req.method, decodeURIComponent(idMatch[1]), req, res, user);

      return json(res, 404, { error: 'route not found' });
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
// testing. Before putting the instance anywhere else can reach it, turn it off
// with BOOKMARKS_SEED=0, or anyone who reads this file can log in.
function ensureSeedUser(db) {
  if (process.env.BOOKMARKS_SEED === '0') return null;

  const username = String(process.env.BOOKMARKS_SEED_USER || 'teste').toLowerCase();
  const email = String(process.env.BOOKMARKS_SEED_EMAIL || `${username}@bookmarks.local`).toLowerCase();
  const password = String(process.env.BOOKMARKS_SEED_PASSWORD || 'teste123');
  const isDefaultPassword = !process.env.BOOKMARKS_SEED_PASSWORD;

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
  const port = Number(process.env.BOOKMARKS_PORT) || 8787;
  const host = process.env.BOOKMARKS_HOST || '127.0.0.1';
  const { server, db, runtime } = createApp();

  const seed = ensureSeedUser(db);
  // Only announced when the password is the default one: with a custom password
  // the shortcut on the login screen could not work anyway.
  runtime.demo = seed && seed.isDefaultPassword ? { login: seed.username } : null;
  server.listen(port, host, () => {
    console.log(`bookmarks running on http://${host}:${port}`);
    if (seed) {
      // The password only reaches the log when it is the default one, which is
      // already in this file. A BOOKMARKS_SEED_PASSWORD stays out of the journal.
      const shown = seed.isDefaultPassword ? ` / ${seed.password}` : ' (password from BOOKMARKS_SEED_PASSWORD)';
      console.log(`test user: ${seed.username}${shown}`);
    }
  });
}

module.exports = { createApp, ensureSeedUser };
