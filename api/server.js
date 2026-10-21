// Backend: REST API, sync and static hosting for the web UI.
//
// Plain Node, zero dependencies: `node:sqlite`, `node:http` and `node:crypto`
// cover it. There is no framework and no router; routes are an object keyed by
// "METHOD /path", and anything not under /api/ is served as a static file.
//
// A vault is opened with its access key, which is exchanged for an opaque
// session token. The token travels in the `Authorization: Bearer` header and is
// stored in the `sessions` table. There is no cookie, so there is no CSRF to
// consider: a cross-site request carries no credentials of its own.
//
// Neighbours:
//   db.js             schema and connection
//   auth.js           access keys and tokens
//   portability.js    import/export
//   ../web/search.js  the same search engine that runs in the browser
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { execFileSync } = require('node:child_process');

const { open, hashToken } = require('./db');
const { search } = require('../web/search');
const { newAccessKey, hashKey, newToken } = require('./auth');
const portability = require('./portability');
const { titleFor } = require('./titles');
const audit = require('./audit');

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
  '.woff2': 'font/woff2',
  // Without this content-type the browser ignores the manifest and never offers to install.
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

// This address in front of a link saves it: /https://example.com/x, or
// /example.com/x. Not a file, so it gets the app, which reads the link from the
// address bar (web/js/address.js). The same rule as the @link location in
// web/nginx.conf; tests/address.test.mjs holds the two together.
const LINK_PATH = /^\/(https?:\/|[a-z0-9-]+(\.[a-z0-9-]+)+(:[0-9]+)?(\/|$))/i;

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

// Ids arriving for a batch. Bounded because the whole vault is a legitimate
// selection but a megabyte of made-up ids is not, deduplicated because the same
// id twice is one bookmark either way.
const BULK_LIMIT = 10000;

function idList(v) {
  if (!Array.isArray(v)) return [];
  const out = new Set();
  for (const raw of v.slice(0, BULK_LIMIT)) {
    const id = str(raw, 64);
    if (id) out.add(id);
  }
  return [...out];
}

// A path and every folder above it: `a/b/c` -> ['a', 'a/b', 'a/b/c']. Creating
// a folder deep in the tree has to write the way down to it, or the new folder
// hangs off parents that do not exist.
function ancestry(path) {
  const parts = normFolderPath(path).split('/').filter(Boolean);
  return parts.map((_, i) => parts.slice(0, i + 1).join('/'));
}

// Usage counters arriving from a client. Never negative, never fractional:
// they are merged with MAX and a bogus value would stick forever.
const DAY = 86400000;

// The part of the app a write came through, as the audit trail names it.
// Anything not listed is the app itself: the form, a move, a delete, a sync.
// A client other than the app says so in a header, and only these names are
// taken: the value ends up in the audit log.
const CLIENTS = new Set(['extension']);
function viaHeader(req) {
  const v = String(req.headers['x-bookmarks-via'] || '').toLowerCase();
  return CLIENTS.has(v) ? v : '';
}

// What a session is called in Settings: what the client said, or the browser
// and system read off its User-Agent.
function deviceName(req, given) {
  const named = String(given || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (named) return named;
  const ua = String(req.headers['user-agent'] || '');
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrom(e|ium)\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari' : /^curl\//.test(ua) ? 'curl' : '';
  const system = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return [browser, system].filter(Boolean).join(' on ') || 'Unknown device';
}

const VIA = {
  'POST /api/import': 'import',
  'POST /api/folders/move': 'folder',
  'POST /api/folders/rename': 'folder',
  'POST /api/folders/delete': 'folder',
};
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

// `titles` reaches titleFor: the tests use it to let the title fetcher read a
// page served on loopback, which it refuses everywhere else.
function createApp(dbPath, { titles = {} } = {}) {
  const db = open(dbPath);

  // Several writes as one: a batch of 900 moves is one commit instead of 900,
  // which in SQLite is the difference between instant and a visible pause, and
  // it can no longer end half applied.
  function tx(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

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
    userByKey: db.prepare('SELECT id FROM users WHERE key_hash = ?'),
    userById: db.prepare('SELECT id, name, created_at FROM users WHERE id = ?'),
    insertUser: db.prepare('INSERT INTO users (name, key_hash, created_at) VALUES (?, ?, ?)'),
    setKey: db.prepare('UPDATE users SET key_hash = ? WHERE id = ?'),
    rename: db.prepare('UPDATE users SET name = ? WHERE id = ?'),
    insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, name, created_at, last_used_at) VALUES (?, ?, ?, ?, ?)'),
    sessionByHash: db.prepare('SELECT * FROM sessions WHERE token_hash = ?'),
    touchSession: db.prepare('UPDATE sessions SET last_used_at = ? WHERE id = ? AND last_used_at < ?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    deleteSessionById: db.prepare('DELETE FROM sessions WHERE user_id = ? AND id = ?'),
    deleteOtherSessions: db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?'),
    listSessions: db.prepare('SELECT id, name, created_at, last_used_at, token_hash FROM sessions WHERE user_id = ? ORDER BY last_used_at DESC, id DESC'),
    bookmarksByUrl: db.prepare(`SELECT * FROM bookmarks WHERE user_id = ? AND deleted = 0
      AND rtrim(url, '/') = rtrim(?, '/') AND url <> '' ORDER BY updated_at DESC`),
    allBookmarks: db.prepare('SELECT * FROM bookmarks WHERE user_id = ? AND deleted = 0 ORDER BY updated_at DESC'),
    // >= and not >: the cursor is a millisecond, and a change written in the
    // same millisecond as the previous answer would fall in the gap and never
    // be sent again. Resending a row the client already has costs nothing,
    // losing one costs a deletion that never arrives.
    since: db.prepare('SELECT * FROM bookmarks WHERE user_id = ? AND updated_at >= ? ORDER BY updated_at ASC'),
    getOne: db.prepare('SELECT * FROM bookmarks WHERE user_id = ? AND id = ?'),
    // The ids the vault buried. An import needs them to tell "this entry is a
    // bookmark I deleted" from "this entry is new", which the live list cannot.
    buriedIds: db.prepare('SELECT id FROM bookmarks WHERE user_id = ? AND deleted = 1'),
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
    // Every folder a bookmark puts on the tree, whether or not it was created
    // on purpose. This is the other half of the union the tree is made of.
    bookmarkFolders: db.prepare(`
      SELECT DISTINCT folder FROM bookmarks
      WHERE user_id = ? AND deleted = 0 AND folder <> ''`),
    allFolders: db.prepare(`
      SELECT path, created_at, updated_at FROM folders
      WHERE user_id = ? AND deleted = 0 ORDER BY path`),
    // Tombstones included: a folder deleted elsewhere has to reach this client
    // as news, not as silence. Same >= cursor as the bookmarks, for the same
    // reason written above them.
    foldersSince: db.prepare(`
      SELECT path, created_at, updated_at, deleted FROM folders
      WHERE user_id = ? AND updated_at >= ? ORDER BY updated_at ASC`),
    getFolder: db.prepare('SELECT * FROM folders WHERE user_id = ? AND path = ?'),
    upsertFolder: db.prepare(`
      INSERT INTO folders (user_id, path, created_at, updated_at, deleted)
      VALUES (?, ?, ?, ?, 0)
      ON CONFLICT(user_id, path) DO UPDATE SET
        updated_at = excluded.updated_at, deleted = 0`),
    // A branch: the folder and everything under it, the same prefix match the
    // bookmarks get, with the separator attached for the same reason.
    folderBranch: db.prepare(`
      SELECT * FROM folders
      WHERE user_id = ? AND deleted = 0 AND (path = ? OR path LIKE ? ESCAPE '\\')`),
    burnFolder: db.prepare('UPDATE folders SET deleted = 1, updated_at = ? WHERE user_id = ? AND path = ?'),
    logChange: db.prepare(`
      INSERT INTO audit_log (user_id, at, action, bookmark_id, title, url, folder, changes, via)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    logClick: db.prepare('INSERT INTO click_log (user_id, at, route, label, target, href) VALUES (?, ?, ?, ?, ?, ?)'),
    pruneClicks: db.prepare('DELETE FROM click_log WHERE user_id = ? AND at < ?'),
  };

  // Which part of the app a write came through, for the audit trail. Set once
  // per request by the dispatcher and read wherever the write lands, however
  // many awaits away.
  const requestVia = new AsyncLocalStorage();

  function recordChange(userId, before, after, ts) {
    const what = audit.describeChange(before, after);
    if (!what) return;
    q.logChange.run(userId, ts, what.action, after.id, after.title, after.url, after.folder,
      JSON.stringify(what.changes), requestVia.getStore() || '');
  }

  // Deleting, logged. Every deletion in the API goes through here.
  function buryBookmark(userId, id, ts = now()) {
    const before = q.getOne.get(userId, id);
    q.softDelete.run(ts, userId, id);
    recordChange(userId, before, q.getOne.get(userId, id), ts);
  }

  function bearer(req) {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
    return m ? m[1] : '';
  }

  function sessionOf(req) {
    const token = bearer(req);
    return (token && q.sessionByHash.get(hashToken(token))) || null;
  }

  // The last use is written at most once a minute: it is for a person reading
  // Settings, not a log, and every request would otherwise be a write.
  function auth(req) {
    const s = sessionOf(req);
    if (!s) return null;
    const ts = now();
    q.touchSession.run(ts, s.id, ts - 60_000);
    return q.userById.get(s.user_id) || null;
  }

  // Only the hash is stored; the token itself is in this answer and nowhere else.
  function startSession(userId, name) {
    const token = newToken();
    const ts = now();
    q.insertSession.run(hashToken(token), userId, name, ts, ts);
    return token;
  }

  // A key that hashes to nothing already in the table. 160 random bits will
  // not collide, but the UNIQUE index would turn the one-in-never into a 500.
  function freshKey() {
    for (;;) {
      const key = newAccessKey();
      const hash = hashKey(key);
      if (!q.userByKey.get(hash)) return { key, hash };
    }
  }

  function vaultName(v) {
    return str(v, 80);
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

    const before = existing;
    q.upsert.run(
      id, userId,
      str(b.title, 500), str(b.url, 2000),
      normFolder(b.folder), normCategory(b.category), normTags(b.tags),
      str(b.description ?? b.notes, 5000),   // `notes`: the field's old name
      created, updated, (buried || b.deleted) ? 1 : 0,
      counter(b.opens), counter(b.last_open_at),
    );
    const after = q.getOne.get(userId, id);
    recordChange(userId, before, after, ts);
    return after;
  }

  // Records a folder and the way down to it. Idempotent: a path that is
  // already there only has its timestamp bumped, so the sync carries it, and a
  // tombstoned one comes back.
  function recordFolder(userId, path, ts = now()) {
    const steps = ancestry(path);
    for (const step of steps) {
      const existing = q.getFolder.get(userId, step);
      q.upsertFolder.run(userId, step, existing ? existing.created_at : ts, ts);
    }
    return steps.length;
  }

  // Every path the tree already shows: the folders written down, plus the ones
  // the bookmarks put there on their own. This is what "already exists" means
  // when a new folder is asked for, because to the person looking at the panel
  // the two kinds are the same folder.
  function folderPaths(userId) {
    const out = new Set();
    for (const row of q.allFolders.all(userId)) out.add(row.path);
    for (const row of q.bookmarkFolders.all(userId)) {
      for (const step of ancestry(row.folder)) out.add(step);
    }
    return out;
  }

  // Moves a branch: every bookmark under `from` and every folder row under it
  // land under `target`. In both places the path is a plain string, so this is
  // one prefix rewrite and the whole branch travels together.
  //
  // Folder rows are not created here for a branch that had none. A folder that
  // exists only because bookmarks are inside it stays that way after moving:
  // recording it would quietly promote it to a folder that survives emptying,
  // which is a decision for whoever creates a folder, not for whoever drags one.
  function moveBranch(userId, from, target, ts = now()) {
    const like = escapeLike(from) + '/%';

    const rows = q.inFolder.all(userId, from, like);
    for (const row of rows) {
      const rest = row.folder.slice(from.length);      // '' or '/child/…'
      writeBookmark(userId, { ...row, folder: target + rest, updated_at: ts }, ts);
    }

    const branch = q.folderBranch.all(userId, from, like);
    for (const row of branch) {
      const rest = row.path.slice(from.length);
      q.upsertFolder.run(userId, target + rest, row.created_at, ts);
      q.burnFolder.run(ts, userId, row.path);
    }
    return { moved: rows.length, folders: branch.length };
  }

  const routes = {
    // A new vault, and its key. The key is in this answer and nowhere else:
    // only its hash is stored, so losing it means asking the host for another
    // (see keys.js), never reading it back.
    'POST /api/auth/vault': async (req, res) => {
      const b = await readBody(req);
      const { key, hash } = freshKey();
      const info = q.insertUser.run(vaultName(b.name), hash, now());
      const id = Number(info.lastInsertRowid);
      return json(res, 201, { key, token: startSession(id, deviceName(req, b.device)), user: q.userById.get(id) });
    },

    'POST /api/auth/key': async (req, res) => {
      const b = await readBody(req);
      const hash = hashKey(b.key);
      const row = hash && q.userByKey.get(hash);
      if (!row) return json(res, 401, { error: 'that key does not open any vault' });
      return json(res, 200, { token: startSession(row.id, deviceName(req, b.device)), user: q.userById.get(row.id) });
    },

    // A new session for another client of the same vault, handed out by one
    // that is already signed in. This is how the browser extension connects
    // without the key ever passing through it.
    'POST /api/auth/session': async (req, res, user) => {
      const b = await readBody(req);
      return json(res, 201, { token: startSession(user.id, deviceName(req, b.device)), user });
    },

    // The devices signed in to this vault. The hash never leaves the server;
    // `current` marks the one asking.
    'GET /api/auth/sessions': async (req, res, user) => {
      const mine = hashToken(bearer(req));
      const sessions = q.listSessions.all(user.id).map(({ token_hash, ...s }) => ({ ...s, current: token_hash === mine }));
      return json(res, 200, { sessions });
    },

    // Signs one device out, this one included.
    'POST /api/auth/sessions/revoke': async (req, res, user) => {
      const b = await readBody(req);
      const info = q.deleteSessionById.run(user.id, Number(b.id));
      if (!info.changes) return json(res, 404, { error: 'not found' });
      return json(res, 200, { ok: true });
    },

    // A new key for this vault. The old one stops working at once, and every
    // other device is signed out with it: a key is rotated because it may have
    // leaked, and a session opened with a leaked key is the leak.
    'POST /api/auth/rotate': async (req, res, user) => {
      const { key, hash } = freshKey();
      tx(() => {
        q.setKey.run(hash, user.id);
        q.deleteOtherSessions.run(user.id, hashToken(bearer(req)));
      });
      return json(res, 200, { key });
    },

    'POST /api/auth/logout': async (req, res) => {
      const token = bearer(req);
      if (token) q.deleteSession.run(hashToken(token));
      return json(res, 200, { ok: true });
    },

    'POST /api/me': async (req, res, user) => {
      const b = await readBody(req);
      q.rename.run(vaultName(b.name), user.id);
      return json(res, 200, { user: q.userById.get(user.id) });
    },

    'GET /api/me': async (req, res, user) => json(res, 200, { user }),

    'GET /api/bookmarks': async (req, res, user, url) => {
      // ?url= is "is this page saved already?": the same rule as sameLink in
      // web/js/address.js, where only a trailing slash is ignored. A link saved
      // in two folders is two answers, since that is allowed.
      if (url.searchParams.has('url')) {
        const items = q.bookmarksByUrl.all(user.id, url.searchParams.get('url') || '');
        return json(res, 200, { items, total: items.length });
      }
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
        // The YAML and the JSON carry the empty folders. The HTML is a
        // browser's format, and browsers drop an empty <DL> on import.
        yaml: () => [portability.toYaml(items, {
          user: user.name,
          folders: q.allFolders.all(user.id).map((f) => f.path),
        }), 'application/yaml; charset=utf-8', `bookmarks-${stamp}.yaml`],
        html: () => [portability.toNetscapeHtml(items),
          'text/html; charset=utf-8', `bookmarks-${stamp}.html`],
        json: () => [portability.toJson(items, { folders: q.allFolders.all(user.id).map((f) => f.path) }),
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
        buried: q.buriedIds.all(user.id).map((r) => r.id),
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
      tx(() => {
        for (const { incoming } of plan.create) {
          // The id in the file is kept: an export is a backup, and restoring one
          // has to give back the same bookmarks, not copies of them. Its
          // timestamp is not: the sync hands out what changed since a client's
          // cursor, and a bookmark written now under the file's older date sits
          // behind every cursor already past it, so the clients already signed
          // in would never receive it. A tombstone with that id (deleted here,
          // still in the file) is the same problem twice over: the
          // last-write-wins gate would also drop the write.
          const buried = incoming.id ? q.getOne.get(user.id, incoming.id) : null;
          // Strictly newer than the tombstone, not merely now: a client with a
          // clock running ahead can leave a timestamp in the future, and a
          // restore losing to it would fail quietly.
          const stamp = buried ? Math.max(ts, buried.updated_at + 1) : ts;
          writeBookmark(user.id, { ...incoming, updated_at: stamp }, ts);
        }
        for (const { incoming } of plan.update) writeBookmark(user.id, { ...incoming, updated_at: ts }, ts);
        for (const { current } of plan.remove) buryBookmark(user.id, current.id, ts);

        // Folders travel outside the plan. There is nothing to decide about one:
        // a folder in the file either is already on the tree or is written down,
        // and neither answer can lose a bookmark.
        const keep = new Set();
        for (const path of parsed.folders) {
          for (const step of ancestry(path)) keep.add(step);
        }
        for (const path of keep) recordFolder(user.id, path, ts);
        // `replace` means the file is the truth, for folders as much as for
        // bookmarks: one that the file does not mention goes with the rest.
        // Only for the YAML, though. The other formats have no way to write an
        // empty folder down, so their silence is not an answer and pruning on it
        // would delete folders the file never had an opinion about.
        if (mode === 'replace' && parsed.format === 'yaml') {
          for (const row of q.allFolders.all(user.id)) {
            if (!keep.has(row.path)) q.burnFolder.run(ts, user.id, row.path);
          }
        }
      });

      return json(res, 200, { ...preview, applied: true, total: q.allBookmarks.all(user.id).length });
    },

    // Files a set of bookmarks at once, which is what selecting rows in the list
    // needs: marking 900 of them and moving one PUT at a time would be 900
    // requests, and 900 chances to end up half moved.
    //
    // An id that is not yours, or already deleted, is skipped rather than
    // refused: a selection made against a list that has moved on is a stale
    // list, not a bad request, and failing the whole batch over one would throw
    // away the other 899.
    'POST /api/bookmarks/move': async (req, res, user) => {
      const b = await readBody(req);
      const folder = normFolderPath(b.folder);
      const ids = idList(b.ids);
      if (!ids.length) return json(res, 400, { error: 'ids is required' });

      const ts = now();
      let moved = 0;
      tx(() => {
        for (const id of ids) {
          const row = q.getOne.get(user.id, id);
          if (!row || row.deleted || row.folder === folder) continue;
          writeBookmark(user.id, { ...row, folder, updated_at: ts }, ts);
          moved += 1;
        }
      });
      return json(res, 200, { moved, folder, now: ts });
    },

    // The same batch, for deleting. Tombstones, like every other deletion here,
    // so an export taken before this still brings them back.
    'POST /api/bookmarks/delete': async (req, res, user) => {
      const b = await readBody(req);
      const ids = idList(b.ids);
      if (!ids.length) return json(res, 400, { error: 'ids is required' });

      const ts = now();
      let deleted = 0;
      tx(() => {
        for (const id of ids) {
          const row = q.getOne.get(user.id, id);
          if (!row || row.deleted) continue;
          buryBookmark(user.id, id, ts);
          deleted += 1;
        }
      });
      return json(res, 200, { deleted });
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
      const { moved, folders } = tx(() => moveBranch(user.id, from, target));
      return json(res, 200, { moved, folders, from, to: target });
    },

    // A title for a link that came without one: the page's own, or failing
    // that the one in its address. Slow by nature, so the app asks after the
    // link is already saved, and nothing here writes.
    'GET /api/title': async (req, res, user, url) => {
      const target = String(url.searchParams.get('url') || '').trim();
      if (!/^https?:\/\//i.test(target)) return json(res, 400, { error: 'url must be http or https' });
      return json(res, 200, await titleFor(target, titles));
    },

    // The folders written down, which is not the whole tree: the app unions
    // these with the ones it derives from the `folder` of each bookmark.
    'GET /api/folders': async (req, res, user) => {
      // `used` is the other half of the tree: the folders bookmarks are in,
      // for a client that does not hold every bookmark (the extension).
      return json(res, 200, {
        folders: q.allFolders.all(user.id),
        used: q.bookmarkFolders.all(user.id).map((r) => r.folder),
      });
    },

    // Creates a folder that owns nothing yet, which the `folder` string on a
    // bookmark cannot express: that is the whole reason the table exists.
    'POST /api/folders': async (req, res, user) => {
      const b = await readBody(req);
      const path = normFolderPath(b.path);
      if (!path) return json(res, 400, { error: 'path is required' });
      // Against the union, not against the table: a folder full of bookmarks
      // is on screen, and answering "created" for it would be a lie.
      if (folderPaths(user.id).has(path)) {
        return json(res, 409, { error: `folder /${path} already exists` });
      }

      recordFolder(user.id, path);
      const row = q.getFolder.get(user.id, path);
      return json(res, 201, { folder: { path: row.path, created_at: row.created_at, updated_at: row.updated_at } });
    },

    // Renaming is moving that keeps the parent, so it is the same prefix
    // rewrite. A name with a `/` in it would be a move wearing a disguise, and
    // it is refused rather than silently reparenting the branch.
    'POST /api/folders/rename': async (req, res, user) => {
      const b = await readBody(req);
      const from = normFolderPath(b.path);
      const name = normFolder(b.name);
      if (!from) return json(res, 400, { error: 'path is required' });
      if (!name) return json(res, 400, { error: 'name is required' });
      if (name.includes('/')) {
        return json(res, 400, { error: 'a name cannot contain "/": drag the folder to change where it lives' });
      }

      const parent = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '';
      const target = parent ? `${parent}/${name}` : name;
      if (target === from) return json(res, 200, { moved: 0, folders: 0, from, to: target });
      if (folderPaths(user.id).has(target)) {
        return json(res, 409, { error: `folder /${target} already exists` });
      }

      const { moved, folders } = tx(() => moveBranch(user.id, from, target));
      return json(res, 200, { moved, folders, from, to: target });
    },

    // Deletes the folder and everything under it, bookmarks included. Both
    // sides are tombstones, never DELETE, so an export taken before this still
    // brings the bookmarks back: the import bumps a tombstone's timestamp past
    // the deletion on purpose, right above.
    'POST /api/folders/delete': async (req, res, user) => {
      const b = await readBody(req);
      const path = normFolderPath(b.path);
      if (!path) return json(res, 400, { error: 'path is required' });
      if (!folderPaths(user.id).has(path)) return json(res, 404, { error: 'not found' });

      const like = escapeLike(path) + '/%';
      const ts = now();
      const { rows, branch } = tx(() => {
        const rows = q.inFolder.all(user.id, path, like);
        for (const row of rows) buryBookmark(user.id, row.id, ts);
        const branch = q.folderBranch.all(user.id, path, like);
        for (const row of branch) q.burnFolder.run(ts, user.id, row.path);
        return { rows, branch };
      });

      return json(res, 200, { path, bookmarks: rows.length, folders: branch.length });
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
    // The audit trail. Newest first, a page at a time: `before` is the id of
    // the last row already shown.
    'GET /api/audit/changes': async (req, res, user, url) => {
      const { before, limit, like } = auditPage(url);
      const action = url.searchParams.get('action') || '';
      if (action && !audit.ACTIONS.includes(action)) return json(res, 400, { error: `invalid action: ${action}` });
      const rows = db.prepare(`
        SELECT id, at, action, bookmark_id, title, url, folder, changes, via FROM audit_log
        WHERE user_id = ? AND id < ? ${action ? 'AND action = ?' : ''}
          ${like ? "AND (title LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\' OR folder LIKE ? ESCAPE '\\' OR changes LIKE ? ESCAPE '\\')" : ''}
        ORDER BY id DESC LIMIT ?`)
        .all(user.id, before, ...(action ? [action] : []), ...(like ? [like, like, like, like] : []), limit + 1);
      const items = rows.slice(0, limit).map((r) => ({ ...r, changes: JSON.parse(r.changes || '{}') }));
      return json(res, 200, { items, next: rows.length > limit ? items[items.length - 1].id : null });
    },

    'GET /api/audit/clicks': async (req, res, user, url) => {
      const { before, limit, like } = auditPage(url);
      const rows = db.prepare(`
        SELECT id, at, route, label, target, href FROM click_log
        WHERE user_id = ? AND id < ?
          ${like ? "AND (label LIKE ? ESCAPE '\\' OR route LIKE ? ESCAPE '\\' OR target LIKE ? ESCAPE '\\' OR href LIKE ? ESCAPE '\\')" : ''}
        ORDER BY id DESC LIMIT ?`)
        .all(user.id, before, ...(like ? [like, like, like, like] : []), limit + 1);
      const items = rows.slice(0, limit);
      return json(res, 200, { items, next: rows.length > limit ? items[items.length - 1].id : null });
    },

    'POST /api/audit/clicks': async (req, res, user) => {
      const b = await readBody(req);
      if (!Array.isArray(b.clicks)) return json(res, 400, { error: 'clicks must be a list' });
      if (b.clicks.length > audit.CLICK_BATCH) return json(res, 400, { error: `at most ${audit.CLICK_BATCH} clicks at a time` });
      const ts = now();
      const clicks = b.clicks.map((c) => audit.normClick(c, ts)).filter(Boolean);
      tx(() => {
        for (const c of clicks) q.logClick.run(user.id, c.at, c.route, c.label, c.target, c.href);
        q.pruneClicks.run(user.id, ts - audit.CLICK_DAYS * DAY);
      });
      return json(res, 200, { saved: clicks.length });
    },

    'POST /api/sync': async (req, res, user) => {
      const b = await readBody(req);
      const since = Number(b.since) || 0;
      const pushed = Array.isArray(b.changes) ? b.changes : [];
      const ts = now();
      // A push never revives: see writeBookmark.
      tx(() => { for (const item of pushed) writeBookmark(user.id, item, ts, { revive: false }); });
      const changes = q.since.all(user.id, since);
      // `folders` is additive, and a client that predates it ignores the key.
      // It only comes down: no client creates a folder while offline, so there
      // is nothing to push and no conflict to resolve.
      const folders = q.foldersSince.all(user.id, since);
      return json(res, 200, { changes, folders, now: ts, pushed: pushed.length });
    },
  };

  function auditPage(url) {
    const before = Number(url.searchParams.get('before')) || Number.MAX_SAFE_INTEGER;
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 100, 1), 500);
    const text = String(url.searchParams.get('q') || '').trim().slice(0, 200);
    return { before, limit, like: text ? `%${escapeLike(text)}%` : '' };
  }

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
      buryBookmark(user.id, id);
      return json(res, 200, { ok: true });
    }
    if (method === 'GET') {
      const item = live();
      return item ? json(res, 200, { item }) : json(res, 404, { error: 'not found' });
    }
    return json(res, 405, { error: 'method not allowed' });
  }

  function serveStatic(res, pathname) {
    const rel = pathname === '/' || (LINK_PATH.test(pathname) && !fs.existsSync(path.join(WEB_DIR, pathname)))
      ? 'index.html'
      : pathname.replace(/^\/+/, '');
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
      res.setHeader('access-control-allow-headers', 'content-type, authorization, x-bookmarks-via');
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
        return json(res, 200, { ok: true, service: 'bookmarks', build: buildInfo() });
      }

      const key = `${req.method} ${pathname}`;
      const isPublic = key === 'POST /api/auth/vault' || key === 'POST /api/auth/key';
      const user = auth(req);
      if (!isPublic && !user) return json(res, 401, { error: 'not authenticated' });

      // Named routes first: otherwise `POST /api/bookmarks/open` would be read
      // as a bookmark whose id is "open".
      const handler = routes[key];
      const via = VIA[key] || viaHeader(req) || 'app';
      if (handler) return await requestVia.run(via, () => handler(req, res, user, url));

      const idMatch = /^\/api\/bookmarks\/([^/]+)$/.exec(pathname);
      if (idMatch) {
        return await requestVia.run(via, () => handleBookmarkId(req.method, decodeURIComponent(idMatch[1]), req, res, user));
      }

      return json(res, 404, { error: 'route not found' });
    } catch (err) {
      return json(res, 400, { error: err.message || 'error' });
    }
  });

  return { server, db };
}

// Every vault leaves the boot with a key.
//
// Vaults from before the access keys come out of the migration with none, and
// nobody could open them. Each gets one here, written to the log once: the log
// is the one place the person who owns the host can read and nobody else can,
// and after this boot the vault has a key and is never listed again. Lost it
// anyway? `node api/keys.js` issues another.
function issueMissingKeys(db) {
  const rows = db.prepare('SELECT id, name FROM users WHERE key_hash IS NULL').all();
  const out = [];
  for (const row of rows) {
    let key;
    let hash;
    do {
      key = newAccessKey();
      hash = hashKey(key);
    } while (db.prepare('SELECT 1 FROM users WHERE key_hash = ?').get(hash));
    db.prepare('UPDATE users SET key_hash = ? WHERE id = ?').run(hash, row.id);
    out.push({ id: row.id, name: row.name, key });
  }
  return out;
}

// A known vault for development and tests, opened by the key in
// BOOKMARKS_DEV_KEY. Off unless that variable is set: a key in an environment
// file is a key anyone who reads the file has.
function ensureDevVault(db, raw = process.env.BOOKMARKS_DEV_KEY) {
  if (!raw) return null;
  const hash = hashKey(raw);
  if (!hash) throw new Error('BOOKMARKS_DEV_KEY is not a valid access key (32 base32 characters)');
  const existing = db.prepare('SELECT id FROM users WHERE key_hash = ?').get(hash);
  if (existing) return { id: existing.id, created: false };
  const info = db.prepare('INSERT INTO users (name, key_hash, created_at) VALUES (?, ?, ?)').run('dev', hash, now());
  return { id: Number(info.lastInsertRowid), created: true };
}

if (require.main === module) {
  const port = Number(process.env.BOOKMARKS_PORT) || 8787;
  const host = process.env.BOOKMARKS_HOST || '127.0.0.1';
  const { server, db } = createApp();

  ensureDevVault(db);
  const issued = issueMissingKeys(db);
  server.listen(port, host, () => {
    console.log(`bookmarks running on http://${host}:${port}`);
    for (const v of issued) {
      console.log(`vault #${v.id}${v.name ? ` (${v.name})` : ''} had no access key; it is now: ${v.key}`);
    }
  });
}

module.exports = { createApp, issueMissingKeys, ensureDevVault, LINK_PATH };
