// Schema e conexão do vault, em SQLite via `node:sqlite` (embutido no Node 24).
//
// Sem ORM e sem migrations: o `CREATE TABLE IF NOT EXISTS` abaixo é o schema
// inteiro, e roda a cada abertura. Se um dia uma coluna mudar, aqui é onde a
// migração vai morar.
//
// Duas decisões que o resto do sistema depende:
//   - a chave primária de bookmarks é (user_id, id), com `id` sendo um UUID
//     gerado no cliente — é isso que permite criar favorito offline;
//   - exclusão é `deleted = 1` (tombstone), nunca DELETE, senão o outro
//     cliente nunca fica sabendo que o registro sumiu.
'use strict';

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

function defaultDbPath() {
  if (process.env.VAULTMARKS_DB) return process.env.VAULTMARKS_DB;
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'vaultmarks', 'vault.db');
}

// O campo se chamava `notes`. Bancos criados antes disso ganham a coluna
// renomeada na abertura — o CREATE TABLE acima nao roda em tabela que ja
// existe, entao sem isto o vault antigo perderia o texto.
function migrarNotesParaDescription(db) {
  const colunas = db.prepare('SELECT name FROM pragma_table_info(?)').all('bookmarks').map((c) => c.name);
  if (colunas.includes('description') || !colunas.includes('notes')) return;
  db.exec('ALTER TABLE bookmarks RENAME COLUMN notes TO description');
}

function open(dbPath = defaultDbPath()) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      email      TEXT NOT NULL UNIQUE,
      username   TEXT NOT NULL UNIQUE,
      pass_hash  TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL
    );

    -- id e um UUID gerado pelo cliente para permitir criacao offline no desktop.
    CREATE TABLE IF NOT EXISTS bookmarks (
      id         TEXT NOT NULL,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title      TEXT NOT NULL DEFAULT '',
      url        TEXT NOT NULL DEFAULT '',
      folder     TEXT NOT NULL DEFAULT '',
      category   TEXT NOT NULL DEFAULT '',
      tags       TEXT NOT NULL DEFAULT '',
      description      TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted    INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, id)
    );

    CREATE INDEX IF NOT EXISTS idx_bm_sync ON bookmarks(user_id, updated_at);
  `);

  migrarNotesParaDescription(db);
  return db;
}

module.exports = { open, defaultDbPath };
