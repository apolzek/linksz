// Backend do Vaultmarks: API REST + sync + serve a web.
//
// Node puro, zero dependências — `node:sqlite`, `node:http` e `node:crypto` já
// dão conta. Não há framework nem roteador: as rotas são um objeto indexado
// por "MÉTODO /caminho", e o que não começa com /api/ vira arquivo estático.
//
// Autenticação é token opaco no header `Authorization: Bearer`, guardado na
// tabela `sessions`. Não há cookie nem CSRF a considerar porque a barra do
// desktop fala com a mesma API de outra origem.
//
// Vizinhos:
//   db.js           schema e conexão
//   auth.js         hash de senha e token
//   portability.js  import/export
//   ../web/search.js  o mesmo motor de busca que roda no browser
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
  // Sem este content-type o navegador ignora o manifest e nao oferece instalar.
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

// Import de um vault grande passa fácil de 2 MB — o HTML do Chrome é verboso.
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
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('JSON invalido')); }
    });
    req.on('error', reject);
  });
}

function str(v, max = 2000) {
  return String(v == null ? '' : v).slice(0, max).trim();
}

// Aceita "#a, b  #c" ou ["a","b"] -> "a,b,c" (normalizado, sem #)
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

  // Preenchido no boot (ensureSeedUser). Fica fora do `q` porque e estado do
  // processo, nao do banco.
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

  // Grava um bookmark vindo do cliente. `updated_at` do cliente vence se for
  // mais novo (last-write-wins) — e o que mantem web e desktop convergindo.
  function writeBookmark(userId, b, ts = now()) {
    const id = str(b.id, 64) || crypto.randomUUID();
    const existing = q.getOne.get(userId, id);
    const updated = Number(b.updated_at) > 0 ? Number(b.updated_at) : ts;
    const created = existing ? existing.created_at : (Number(b.created_at) > 0 ? Number(b.created_at) : ts);

    q.upsert.run(
      id, userId,
      str(b.title, 500), str(b.url, 2000),
      normFolder(b.folder), normCategory(b.category), normTags(b.tags),
      str(b.description ?? b.notes, 5000),   // `notes`: nome antigo do campo
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

      if (!looksLikeEmail(email)) return json(res, 400, { error: 'email invalido' });
      if (!/^[a-z0-9._-]{2,60}$/.test(username)) return json(res, 400, { error: 'usuario deve ter 2-60 chars (a-z 0-9 . _ -)' });
      if (password.length < 6) return json(res, 400, { error: 'senha precisa de ao menos 6 caracteres' });
      if (q.userByLogin.get(email, username)) return json(res, 409, { error: 'email ou usuario ja existe' });

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
        return json(res, 401, { error: 'credenciais invalidas' });
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
      const limit = Math.min(Number(url.searchParams.get('limit')) || 200, 500);
      const items = query.trim() ? search(all, query, limit) : all.slice(0, limit);
      return json(res, 200, { items, total: all.length });
    },

    'POST /api/bookmarks': async (req, res, user) => {
      const b = await readBody(req);
      if (!str(b.url) && !str(b.title)) return json(res, 400, { error: 'informe ao menos url ou titulo' });
      return json(res, 201, { item: writeBookmark(user.id, b) });
    },

    // Export: yaml (nativo), html (formato do navegador) ou json (script).
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
      if (!renderers[format]) return json(res, 400, { error: 'formato deve ser yaml, html ou json' });

      const [body, type, filename] = renderers[format]();
      res.writeHead(200, {
        'content-type': type,
        'content-length': Buffer.byteLength(body),
        'content-disposition': `attachment; filename="${filename}"`,
        'cache-control': 'no-store',
      });
      return res.end(body);
    },

    // Import em dois tempos: sem `apply`, so devolve o plano — nada e gravado.
    // A UI mostra o plano, o usuario escolhe o modo, e so entao aplica.
    'POST /api/import': async (req, res, user) => {
      const b = await readBody(req, IMPORT_LIMIT);
      const content = typeof b.content === 'string' ? b.content : '';
      if (!content.trim()) return json(res, 400, { error: 'arquivo vazio' });

      const mode = String(b.mode || 'adicionar');
      if (!portability.MODES.includes(mode)) {
        return json(res, 400, { error: `modo deve ser um de: ${portability.MODES.join(', ')}` });
      }

      let parsed;
      try {
        parsed = portability.parseImport(content, String(b.format || 'auto'));
      } catch (err) {
        return json(res, 400, { error: `nao consegui ler o arquivo — ${err.message}` });
      }

      const existing = q.allBookmarks.all(user.id);
      const plan = portability.planImport(existing, parsed.items, mode);
      const preview = {
        formato: parsed.format,
        resumo: plan.resumo,
        // Amostra para a UI mostrar o que vai acontecer, sem despejar tudo.
        exemplos: {
          criar: plan.criar.slice(0, 5).map((p) => p.incoming.title || p.incoming.url),
          atualizar: plan.atualizar.slice(0, 5).map((p) => p.atual.title || p.atual.url),
          remover: plan.remover.slice(0, 5).map((p) => p.atual.title || p.atual.url),
        },
      };

      if (!b.apply) return json(res, 200, { ...preview, aplicado: false });

      const ts = now();
      for (const { incoming } of plan.criar) writeBookmark(user.id, { ...incoming, id: '' }, ts);
      for (const { incoming } of plan.atualizar) writeBookmark(user.id, { ...incoming, updated_at: ts }, ts);
      for (const { atual } of plan.remover) q.softDelete.run(ts, user.id, atual.id);

      return json(res, 200, { ...preview, aplicado: true, total: q.allBookmarks.all(user.id).length });
    },

    // Sync bidirecional: cliente manda o que mudou, recebe o que mudou no servidor.
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
    // Linhas com deleted=1 sao tombstones (existem so pro sync) — para a API
    // REST elas nao existem mais.
    const live = () => {
      const row = q.getOne.get(user.id, id);
      return row && !row.deleted ? row : null;
    };

    if (method === 'PUT') {
      return readBody(req).then((b) => {
        const existing = live();
        if (!existing) return json(res, 404, { error: 'nao encontrado' });
        const merged = { ...existing, ...b, id, updated_at: now() };
        return json(res, 200, { item: writeBookmark(user.id, merged) });
      });
    }
    if (method === 'DELETE') {
      if (!live()) return json(res, 404, { error: 'nao encontrado' });
      q.softDelete.run(now(), user.id, id);
      return json(res, 200, { ok: true });
    }
    if (method === 'GET') {
      const item = live();
      return item ? json(res, 200, { item }) : json(res, 404, { error: 'nao encontrado' });
    }
    return json(res, 405, { error: 'metodo nao permitido' });
  }

  function serveStatic(res, pathname) {
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const file = path.join(WEB_DIR, rel);
    // Compara com o separador junto: sem ele, `../webx/y` passaria por
    // startsWith(WEB_DIR) por ser so um prefixo de string.
    if (file !== WEB_DIR && !file.startsWith(WEB_DIR + path.sep)) {
      return json(res, 403, { error: 'proibido' });
    }

    fs.readFile(file, (err, data) => {
      if (err) return json(res, 404, { error: 'nao encontrado' });

      const name = path.basename(file);
      const headers = { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' };

      if (name === 'sw.js') {
        // O service worker precisa ser sempre revalidado, senao o navegador
        // segura uma versao velha por horas e a atualizacao nunca chega.
        headers['cache-control'] = 'no-cache';
        headers['service-worker-allowed'] = '/';
      } else if (name === 'index.html') {
        headers['cache-control'] = 'no-cache';
      } else {
        // O proprio SW guarda a casca; aqui basta uma janela curta.
        headers['cache-control'] = 'public, max-age=300';
      }

      res.writeHead(200, headers);
      res.end(data);
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const { pathname } = url;

    // CORS liberado: a barra do desktop e outras origens batem na mesma API.
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
      if (!isPublic && !user) return json(res, 401, { error: 'nao autenticado' });

      const idMatch = /^\/api\/bookmarks\/([^/]+)$/.exec(pathname);
      if (idMatch) return await handleBookmarkId(req.method, decodeURIComponent(idMatch[1]), req, res, user);

      const handler = routes[key];
      if (!handler) return json(res, 404, { error: 'rota nao encontrada' });
      return await handler(req, res, user, url);
    } catch (err) {
      return json(res, 400, { error: err.message || 'erro' });
    }
  });

  return { server, db, runtime };
}

// Conta de teste, garantida a cada boot da stack.
//
// Sem ela um banco novo abre na tela de login sem ninguém para logar, e a
// primeira coisa que todo mundo faz é registrar uma conta na mão só para ver
// o app de pé. Idempotente: se a conta já existe, apenas reacerta a senha —
// nunca toca nos favoritos dela.
//
// É uma senha conhecida por design, então serve para desenvolvimento e teste
// local. Antes de publicar a instância na rede (compose + Caddy), desligue com
// VAULTMARKS_SEED=0, senão qualquer um que leia este arquivo entra.
function ensureSeedUser(db) {
  if (process.env.VAULTMARKS_SEED === '0') return null;

  const username = String(process.env.VAULTMARKS_SEED_USER || 'teste').toLowerCase();
  const email = String(process.env.VAULTMARKS_SEED_EMAIL || `${username}@vaultmarks.local`).toLowerCase();
  const password = String(process.env.VAULTMARKS_SEED_PASSWORD || 'teste123');
  const isDefaultPassword = !process.env.VAULTMARKS_SEED_PASSWORD;

  const existing = db.prepare('SELECT * FROM users WHERE email = ? OR username = ?').get(email, username);
  if (existing) {
    // Só regrava se a senha atual não confere: evita hash novo a cada boot.
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
  // So anuncia quando a senha e a padrao: com senha propria, o atalho da tela
  // de login nao teria como funcionar mesmo.
  runtime.demo = seed && seed.isDefaultPassword ? { login: seed.username } : null;
  server.listen(port, host, () => {
    console.log(`vaultmarks rodando em http://${host}:${port}`);
    if (seed) {
      // A senha só vai para o log quando é a padrão, que já está neste
      // arquivo. Se veio de VAULTMARKS_SEED_PASSWORD, fica fora do journal.
      const senha = seed.isDefaultPassword ? ` / ${seed.password}` : ' (senha de VAULTMARKS_SEED_PASSWORD)';
      console.log(`usuario de teste: ${seed.username}${senha}`);
    }
  });
}

module.exports = { createApp, ensureSeedUser };
