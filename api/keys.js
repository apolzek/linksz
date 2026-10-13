// Access keys, from the host's side.
//
// A key is shown once and only its hash is kept, so a lost key cannot be read
// back. Whoever runs the host can always issue a new one, which is what this is
// for. It works on the same database the server uses (BOOKMARKS_DB), and the
// server does not need to stop: SQLite in WAL takes the write.
//
//   node api/keys.js                 lists the vaults
//   node api/keys.js issue <id>      a new key for that vault; the old one dies
//
// In the stack: docker compose exec api node api/keys.js
'use strict';

const { open } = require('./db');
const { newAccessKey, hashKey } = require('./auth');

function list(db) {
  const rows = db.prepare(`
    SELECT u.id, u.name, u.created_at, u.key_hash IS NOT NULL AS has_key,
           (SELECT COUNT(*) FROM bookmarks b WHERE b.user_id = u.id AND b.deleted = 0) AS bookmarks
    FROM users u ORDER BY u.id`).all();
  if (!rows.length) return console.log('no vaults yet');
  for (const r of rows) {
    const made = new Date(r.created_at).toISOString().slice(0, 10);
    console.log(`#${r.id}  ${r.name || '(unnamed)'}  ${r.bookmarks} bookmarks  created ${made}${r.has_key ? '' : '  NO KEY'}`);
  }
}

function issue(db, id) {
  const row = db.prepare('SELECT id, name FROM users WHERE id = ?').get(id);
  if (!row) {
    console.error(`no vault #${id}`);
    process.exit(1);
  }
  let key;
  let hash;
  do {
    key = newAccessKey();
    hash = hashKey(key);
  } while (db.prepare('SELECT 1 FROM users WHERE key_hash = ?').get(hash));
  db.exec('BEGIN');
  db.prepare('UPDATE users SET key_hash = ? WHERE id = ?').run(hash, row.id);
  // The old key may be why this is being run, so what it opened goes with it.
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.id);
  db.exec('COMMIT');
  console.log(`vault #${row.id}${row.name ? ` (${row.name})` : ''}: ${key}`);
}

const [cmd, arg] = process.argv.slice(2);
const db = open();
if (!cmd || cmd === 'list') list(db);
else if (cmd === 'issue' && Number(arg) > 0) issue(db, Number(arg));
else {
  console.error('usage: node api/keys.js [list | issue <id>]');
  process.exit(1);
}
