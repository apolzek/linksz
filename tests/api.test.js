'use strict';

// Backend tests: auth, isolation between users, CRUD, search over the API,
// two-way sync and the files that make the PWA installable.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createApp, ensureSeedUser } = require('../server/server');
const { verifyPassword } = require('../server/auth');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bookmarks-test-')), 'bookmarks.db');
const { server } = createApp(tmpDb);
let base;

test.before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server.close();
  fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true });
});

async function call(method, p, { token, body } = {}) {
  const res = await fetch(base + p, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const USER = { email: 'apolzek@example.com', username: 'apolzek', password: 'secret123' };
let token;

/* ---------------- auth ---------------- */

test('health answers without auth', async () => {
  const r = await call('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
});

test('register creates a user and returns a token (the email is not validated)', async () => {
  const r = await call('POST', '/api/auth/register', { body: USER });
  assert.equal(r.status, 201);
  assert.ok(r.body.token);
  assert.equal(r.body.user.username, 'apolzek');
  assert.equal(r.body.user.pass_hash, undefined, 'the password hash must not leak');
  token = r.body.token;
});

test('a duplicate registration is refused', async () => {
  assert.equal((await call('POST', '/api/auth/register', { body: USER })).status, 409);
  const mesmoEmail = await call('POST', '/api/auth/register', {
    body: { ...USER, username: 'outro_nome' },
  });
  assert.equal(mesmoEmail.status, 409, 'a repeated email is blocked too');
});

test('register validates its input', async () => {
  const casos = [
    [{ email: 'x@y.com', username: 'short', password: '123' }, 'short password'],
    [{ email: 'noatsign', username: 'valid', password: 'secret123' }, 'email without @'],
    [{ email: 'x@y.com', username: 'a', password: 'secret123' }, '1-char username'],
    [{ email: 'x@y.com', username: 'with space', password: 'secret123' }, 'username with a space'],
    [{ email: 'x@y.com', username: 'Ação', password: 'secret123' }, 'username with an accent'],
  ];
  for (const [body, reason] of casos) {
    const r = await call('POST', '/api/auth/register', { body });
    assert.equal(r.status, 400, `should refuse: ${reason}`);
  }
});

test('login by username and by email', async () => {
  assert.equal((await call('POST', '/api/auth/login', { body: { login: 'apolzek', password: 'secret123' } })).status, 200);
  assert.equal((await call('POST', '/api/auth/login', { body: { login: USER.email, password: 'secret123' } })).status, 200);
  assert.equal((await call('POST', '/api/auth/login', { body: { login: 'APOLZEK', password: 'secret123' } })).status, 200,
    'login is case-insensitive');
});

test('login with a wrong credential fails', async () => {
  assert.equal((await call('POST', '/api/auth/login', { body: { login: 'apolzek', password: 'errada' } })).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { body: { login: 'ninguem', password: 'secret123' } })).status, 401);
});

test('protected routes require a valid token', async () => {
  assert.equal((await call('GET', '/api/bookmarks')).status, 401);
  assert.equal((await call('GET', '/api/bookmarks', { token: 'lixo' })).status, 401);
  assert.equal((await call('GET', '/api/me')).status, 401);
  assert.equal((await call('POST', '/api/sync')).status, 401);
});

/* ---------------- crud ---------------- */

const FIXTURES = [
  { url: 'https://kubernetes.io/docs', title: 'Kubernetes Docs', folder: 'dev/infra', category: '@studies', tags: '#k8s, #devops' },
  { url: 'https://go.dev/blog', title: 'The Go Blog', folder: 'dev', category: 'studies', tags: 'go,backend' },
  { url: 'https://news.ycombinator.com', title: 'Hacker News', folder: 'diario', category: '@news', tags: 'noticias', description: 'leitura diaria' },
  { url: 'https://grafana.com', title: 'Grafana', folder: 'dev/infra', category: 'work', tags: 'observabilidade,devops' },
  { url: 'https://example.com/page', title: 'Página com Acentuação', folder: '', category: 'work', tags: 'accents' },
];

test('creates bookmarks and normalizes tags/category/folder', async () => {
  for (const f of FIXTURES) {
    const r = await call('POST', '/api/bookmarks', { token, body: f });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  const list = await call('GET', '/api/bookmarks', { token });
  assert.equal(list.body.total, FIXTURES.length);

  const k8s = list.body.items.find((b) => b.title === 'Kubernetes Docs');
  assert.equal(k8s.tags, 'k8s,devops', 'tags perdem o # e viram csv');
  assert.equal(k8s.category, 'studies', 'the category loses the @');
  assert.equal(k8s.folder, 'dev/infra');
});

test('normalization drops duplicates and a trailing slash', async () => {
  const r = await call('POST', '/api/bookmarks', {
    token,
    body: { url: 'https://dup.com', title: 'Dup', tags: '#go, go, GO, #Go', folder: '/dev/infra/', category: '@WORK' },
  });
  assert.equal(r.body.item.tags, 'go', 'a repeated tag enters only once');
  assert.equal(r.body.item.folder, 'dev/infra', 'barras das pontas somem');
  assert.equal(r.body.item.category, 'work', 'the category is lowercased');
  await call('DELETE', `/api/bookmarks/${r.body.item.id}`, { token });
});

test('creating a bookmark with no url and no title is refused', async () => {
  assert.equal((await call('POST', '/api/bookmarks', { token, body: { tags: 'nada' } })).status, 400);
});

// Creates its own bookmark and removes it at the end, so the search tests below
// keep seeing FIXTURES intact regardless of execution order.
test('editing updates and keeps created_at', async () => {
  const criado = await call('POST', '/api/bookmarks', {
    token, body: { url: 'https://edit-me.com', title: 'To Edit', category: 'old', tags: 'before' },
  });
  const bm = criado.body.item;

  const r = await call('PUT', `/api/bookmarks/${bm.id}`, { token, body: { category: '@monitoring', tags: '#metrics' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.item.category, 'monitoring');
  assert.equal(r.body.item.tags, 'metrics');
  assert.equal(r.body.item.created_at, bm.created_at);
  assert.ok(r.body.item.updated_at >= bm.updated_at);
  assert.equal(r.body.item.url, bm.url, 'a field not sent is preserved');
  assert.equal(r.body.item.title, bm.title, 'a title not sent is preserved');

  await call('DELETE', `/api/bookmarks/${bm.id}`, { token });
});

test('editing a missing id gives 404', async () => {
  assert.equal((await call('PUT', '/api/bookmarks/does-not-exist', { token, body: { title: 'x' } })).status, 404);
  assert.equal((await call('GET', '/api/bookmarks/does-not-exist', { token })).status, 404);
  assert.equal((await call('DELETE', '/api/bookmarks/does-not-exist', { token })).status, 404);
});

/* ---------------- busca via API ---------------- */

async function q(query) {
  const r = await call('GET', `/api/bookmarks?q=${encodeURIComponent(query)}`, { token });
  assert.equal(r.status, 200);
  return r.body.items.map((b) => b.title);
}

test('search: substring in title and url', async () => {
  assert.deepEqual(await q('kuber'), ['Kubernetes Docs']);
  assert.deepEqual(await q('BERNET'), ['Kubernetes Docs'], 'case-insensitive');
  assert.deepEqual(await q('ycombinator'), ['Hacker News']);
  assert.equal((await q('https://')).length, FIXTURES.length, 'matches in every url');
});

test('search: field sigils', async () => {
  assert.deepEqual((await q('#devops')).sort(), ['Grafana', 'Kubernetes Docs']);
  assert.deepEqual((await q('@studies')).sort(), ['Kubernetes Docs', 'The Go Blog']);
  assert.deepEqual((await q('/dev/infra')).sort(), ['Grafana', 'Kubernetes Docs']);
  assert.equal((await q('/dev')).length, 3, 'a parent folder matches its children');
});

test('search: field:value', async () => {
  assert.deepEqual(await q('title:grafana'), ['Grafana']);
  assert.deepEqual(await q('url:ycombinator'), ['Hacker News']);
  assert.deepEqual(await q('description:diaria'), ['Hacker News']);
  assert.deepEqual(await q('title:grafana.com'), [], 'a url does not match under title:');
});

test('search: quoted phrase', async () => {
  assert.deepEqual(await q('"hacker news"'), ['Hacker News']);
  assert.deepEqual(await q('"news hacker"'), []);
});

test('search: negation', async () => {
  assert.deepEqual(await q('#devops -#k8s'), ['Grafana']);
  assert.deepEqual(await q('/dev -@studies'), ['Grafana']);
  assert.equal((await q('-#devops')).length, FIXTURES.length - 2);
});

test('search: AND between terms', async () => {
  assert.deepEqual(await q('#devops @work'), ['Grafana']);
  assert.deepEqual(await q('#devops @news'), []);
});

test('search: ignores accents', async () => {
  assert.deepEqual(await q('acentuacao'), ['Página com Acentuação']);
  assert.deepEqual(await q('pagina'), ['Página com Acentuação']);
});

test('search: no query lists everything', async () => {
  assert.equal((await q('')).length, FIXTURES.length);
  assert.equal((await q('   ')).length, FIXTURES.length);
});

test('search: an exact tag ranks above a substring', async () => {
  await call('POST', '/api/bookmarks', { token, body: { url: 'https://golang.org', title: 'Golang', tags: 'golanguage' } });
  assert.equal((await q('#go'))[0], 'The Go Blog', 'tag exata "go" vence a substring "golanguage"');
  const created = await call('GET', '/api/bookmarks?q=golang.org', { token });
  await call('DELETE', `/api/bookmarks/${created.body.items[0].id}`, { token });
});

test('search: limit is honoured and capped', async () => {
  const r = await call('GET', '/api/bookmarks?limit=2', { token });
  assert.equal(r.body.items.length, 2);
  assert.equal(r.body.total, FIXTURES.length, 'total ignora o limit');

  const gigante = await call('GET', '/api/bookmarks?limit=99999', { token });
  assert.ok(gigante.body.items.length <= 500, 'limit tem teto');
});

/* ---------------- exclusao e sync ---------------- */

test('delete disappears from the listing but stays in sync as a tombstone', async () => {
  const list = await call('GET', '/api/bookmarks?q=Hacker', { token });
  const id = list.body.items[0].id;
  assert.equal((await call('DELETE', `/api/bookmarks/${id}`, { token })).status, 200);
  assert.deepEqual(await q('Hacker'), []);

  const sync = await call('POST', '/api/sync', { token, body: { since: 0 } });
  const tomb = sync.body.changes.find((c) => c.id === id);
  assert.equal(tomb.deleted, 1, 'tombstone propaga a exclusao pros outros clientes');
  assert.equal((await call('DELETE', `/api/bookmarks/${id}`, { token })).status, 404);
});

test('isolation between users', async () => {
  const other = await call('POST', '/api/auth/register', {
    body: { email: 'outro@example.com', username: 'outro', password: 'secret123' },
  });
  const list = await call('GET', '/api/bookmarks', { token: other.body.token });
  assert.equal(list.body.total, 0, 'a new user does not see other people bookmarks');

  const mine = await call('GET', '/api/bookmarks?q=Grafana', { token });
  const id = mine.body.items[0].id;
  assert.equal((await call('GET', `/api/bookmarks/${id}`, { token: other.body.token })).status, 404,
    'you cannot read another user bookmark by id');
  assert.equal((await call('PUT', `/api/bookmarks/${id}`, { token: other.body.token, body: { title: 'hack' } })).status, 404,
    'nem editar');
  assert.equal((await call('DELETE', `/api/bookmarks/${id}`, { token: other.body.token })).status, 404,
    'nem apagar');

  const still = await call('GET', `/api/bookmarks/${id}`, { token });
  assert.equal(still.body.item.title, 'Grafana', 'the owner still has the bookmark intact');
});

test('two-way sync between two clients (web <-> desktop)', async () => {
  const a = await call('POST', '/api/sync', {
    token,
    body: { since: 0, changes: [{ id: 'uuid-desktop-1', url: 'https://zed.dev', title: 'Zed', tags: 'editor', category: 'dev', updated_at: Date.now() }] },
  });
  assert.equal(a.body.pushed, 1);

  const b = await call('POST', '/api/sync', { token, body: { since: 0, changes: [] } });
  assert.ok(b.body.changes.some((c) => c.id === 'uuid-desktop-1'));

  const c = await call('POST', '/api/sync', { token, body: { since: b.body.now, changes: [] } });
  assert.equal(c.body.changes.length, 0, 'an incremental sync does not resend what was already seen');
});

test('sync resolves conflicts by last-write-wins', async () => {
  const t0 = Date.now();
  const push = (title, ts) => call('POST', '/api/sync', {
    token, body: { changes: [{ id: 'conflict', url: 'https://a.com', title, updated_at: ts }] },
  });

  await push('old', t0);
  await push('new', t0 + 1000);
  await push('late', t0 - 1000);

  const r = await call('GET', '/api/bookmarks/conflict', { token });
  assert.equal(r.body.item.title, 'new', 'the newest write wins');
});

test('sync ignores a malformed payload without falling over', async () => {
  const r = await call('POST', '/api/sync', { token, body: { since: 'abc', changes: 'not-an-array' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.pushed, 0);
});

test('logout invalidates only the session used', async () => {
  const s = await call('POST', '/api/auth/login', { body: { login: 'apolzek', password: 'secret123' } });
  assert.equal((await call('POST', '/api/auth/logout', { token: s.body.token })).status, 200);
  assert.equal((await call('GET', '/api/bookmarks', { token: s.body.token })).status, 401);
  assert.equal((await call('GET', '/api/bookmarks', { token })).status, 200, 'outras sessoes continuam validas');
});

/* ---------------- export e import ---------------- */

async function download(format) {
  const res = await fetch(`${base}/api/export?format=${format}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

test('export requires authentication', async () => {
  assert.equal((await fetch(`${base}/api/export`)).status, 401);
});

test('the yaml export comes as a download with a filename', async () => {
  const r = await download('yaml');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /yaml/);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="bookmarks-\d{4}-\d{2}-\d{2}\.yaml"/);
  assert.match(r.text, /^# Bookmarks vault export/);
  assert.match(r.text, /^bookmarks:$/m);
});

test('the html export is the format browsers import', async () => {
  const r = await download('html');
  assert.match(r.text, /^<!DOCTYPE NETSCAPE-Bookmark-file-1>/);
  assert.match(r.headers.get('content-disposition'), /\.html"/);
});

test('export json', async () => {
  const r = await download('json');
  const doc = JSON.parse(r.text);
  assert.ok(Array.isArray(doc.bookmarks));
});

test('an export with an invalid format is refused', async () => {
  const r = await call('GET', '/api/export?format=xml', { token });
  assert.equal(r.status, 400);
});

test('import without apply writes nothing', async () => {
  const before = (await call('GET', '/api/bookmarks', { token })).body.total;
  const content = 'bookmarks:\n  - title: Fantasma\n    url: https://fantasma.com\n';

  const r = await call('POST', '/api/import', { token, body: { content: content, mode: 'add' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.applied, false);
  assert.equal(r.body.summary.create, 1);
  assert.equal(r.body.format, 'yaml');

  const after = (await call('GET', '/api/bookmarks', { token })).body.total;
  assert.equal(after, before, 'a preview must not change the vault');
  assert.deepEqual(await q('Fantasma'), [], 'nada foi criado');
});

test('import applies and is idempotent afterwards', async () => {
  const content = 'bookmarks:\n  - title: Importado\n    url: https://importado.com\n    tags: [novo]\n';

  const one = await call('POST', '/api/import', { token, body: { content: content, mode: 'add', apply: true } });
  assert.equal(one.body.applied, true);
  assert.equal(one.body.summary.create, 1);
  assert.deepEqual(await q('Importado'), ['Importado']);

  const two = await call('POST', '/api/import', { token, body: { content: content, mode: 'add', apply: true } });
  assert.equal(two.body.summary.create, 0, 'reimporting does not duplicate');
  assert.equal(two.body.summary.same, 1);
  assert.deepEqual(await q('Importado'), ['Importado']);
});

test('import honours the chosen mode', async () => {
  const edited = 'bookmarks:\n  - title: Importado EDITADO\n    url: https://importado.com\n    tags: [novo]\n';

  const keeping = await call('POST', '/api/import', { token, body: { content: edited, mode: 'add', apply: true } });
  assert.equal(keeping.body.summary.skip, 1);
  assert.deepEqual(await q('Importado'), ['Importado'], 'the add mode keeps the old title');

  const usingFile = await call('POST', '/api/import', { token, body: { content: edited, mode: 'update', apply: true } });
  assert.equal(usingFile.body.summary.update, 1);
  assert.deepEqual(await q('Importado'), ['Importado EDITADO']);
});

test('importing our own export changes nothing', async () => {
  const { text } = await download('yaml');
  const r = await call('POST', '/api/import', { token, body: { content: text, mode: 'update', apply: true } });
  assert.equal(r.body.summary.create, 0);
  assert.equal(r.body.summary.update, 0);
  assert.ok(r.body.summary.same > 0, 'everything matches itself');
});

test('import reads the browser format', async () => {
  const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
    <DT><H3>navegador</H3>
    <DL><p>
        <DT><A HREF="https://veio-do-chrome.com" ADD_DATE="1700000000">Do Chrome</A>
    </DL><p>
</DL><p>`;
  const r = await call('POST', '/api/import', { token, body: { content: html, apply: true } });
  assert.equal(r.body.format, 'html');
  assert.equal(r.body.summary.create, 1);
  assert.deepEqual(await q('/navegador'), ['Do Chrome'], 'the browser folder became the vault folder');
});

test('import gives a useful error on a broken file', async () => {
  const broken = await call('POST', '/api/import', { token, body: { content: 'bookmarks:\n\t- x\n' } });
  assert.equal(broken.status, 400);
  assert.match(broken.body.error, /could not read/);
  assert.match(broken.body.error, /line 2/, 'the error has to say where');

  const empty = await call('POST', '/api/import', { token, body: { content: '   ' } });
  assert.equal(empty.status, 400);

  const wrongMode = await call('POST', '/api/import', { token, body: { content: 'bookmarks: []', mode: 'wipe' } });
  assert.equal(wrongMode.status, 400);
  assert.match(wrongMode.body.error, /mode must be/);
});

test('import does not leak between users', async () => {
  const outro = await call('POST', '/api/auth/register', {
    body: { email: 'imp@example.com', username: 'importador', password: 'secret123' },
  });
  const r = await call('POST', '/api/import', {
    token: outro.body.token,
    body: { content: 'bookmarks:\n  - title: So dele\n    url: https://dele.com\n', apply: true },
  });
  assert.equal(r.body.summary.create, 1);

  const mine = await call('GET', '/api/bookmarks?q=dele.com', { token });
  assert.equal(mine.body.items.length, 0, 'one user import does not show up for another');
});

test('replace removes what is missing from the file, and warns first', async () => {
  const solo = await call('POST', '/api/auth/register', {
    body: { email: 'sub@example.com', username: 'replacer', password: 'secret123' },
  });
  const t = solo.body.token;
  for (const url of ['https://a.com', 'https://b.com']) {
    await call('POST', '/api/bookmarks', { token: t, body: { url, title: url } });
  }

  const content = 'bookmarks:\n  - title: Only this\n    url: https://a.com\n';
  const preview = await call('POST', '/api/import', { token: t, body: { content: content, mode: 'replace' } });
  assert.equal(preview.body.summary.remove, 1);
  assert.deepEqual(preview.body.examples.remove, ['https://b.com']);
  assert.equal((await call('GET', '/api/bookmarks', { token: t })).body.total, 2, 'nothing removed yet');

  await call('POST', '/api/import', { token: t, body: { content: content, mode: 'replace', apply: true } });
  const left = await call('GET', '/api/bookmarks', { token: t });
  assert.equal(left.body.total, 1);
  assert.equal(left.body.items[0].url, 'https://a.com');
});

/* ---------------- web and PWA ---------------- */

test('the web UI is served at the root', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /bookmarks/i);
});

test('does not serve files outside web/', async () => {
  for (const p of ['/../server/db.js', '/../../etc/passwd', '/%2e%2e/server/db.js']) {
    const res = await fetch(base + p);
    assert.ok(res.status === 403 || res.status === 404, `${p} devolveu ${res.status}`);
  }
});

test('the PWA assets exist and are served', async () => {
  const esperados = [
    '/manifest.webmanifest', '/sw.js', '/icon.svg',
    '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png', '/apple-touch-icon.png',
    '/style.css', '/app.js', '/search.js',
  ];
  for (const p of esperados) {
    assert.equal((await fetch(base + p)).status, 200, `${p} should exist`);
  }
});

test('the manifest has the content-type the browser requires', async () => {
  const res = await fetch(base + '/manifest.webmanifest');
  assert.match(res.headers.get('content-type'), /application\/manifest\+json/,
    'without this type the browser ignores the manifest and never offers to install');
});

test('the manifest declares the minimum to be installable', async () => {
  const m = await (await fetch(base + '/manifest.webmanifest')).json();
  assert.ok(m.name && m.short_name, 'it needs a name');
  assert.equal(m.start_url, '/');
  assert.equal(m.display, 'standalone', 'senao abre como aba comum');
  assert.ok(m.theme_color && m.background_color);

  const sizes = m.icons.map((i) => i.sizes);
  assert.ok(sizes.includes('192x192'), 'Android exige one icone 192');
  assert.ok(sizes.includes('512x512'), 'Android exige one icone 512');
  assert.ok(m.icons.some((i) => i.purpose === 'maskable'), 'sem maskable o Android recorta torto');
});

test('the service worker comes with headers that allow updating', async () => {
  const res = await fetch(base + '/sw.js');
  assert.match(res.headers.get('content-type'), /javascript/);
  assert.equal(res.headers.get('cache-control'), 'no-cache',
    'sw cacheado prende o app numa versao velha');
  assert.equal(res.headers.get('service-worker-allowed'), '/');
});

test('the service worker does not intercept the API', async () => {
  const sw = await (await fetch(base + '/sw.js')).text();
  assert.match(sw, /\/api\//, 'it has to handle /api/ explicitly');
  assert.match(sw, /request\.method !== 'GET'/, 'escrita nunca pode sair do cache');
});

test('the icons are real PNGs', async () => {
  for (const p of ['/icon-192.png', '/icon-512.png']) {
    const res = await fetch(base + p);
    assert.equal(res.headers.get('content-type'), 'image/png');
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], `${p} is not a PNG`);
  }
});

test('index points at the manifest, the icon and a mobile viewport', async () => {
  const html = await (await fetch(base + '/')).text();
  assert.match(html, /rel="manifest"/, 'without the manifest link it does not install');
  assert.match(html, /apple-touch-icon/, 'iOS uses this icon on the home screen');
  assert.match(html, /viewport-fit=cover/, 'sem isso o content some atras do notch');
  assert.match(html, /theme-color/);
});

/* ---------------- test account ---------------- */

// The same path as the real boot (server.js calls this before listen), only
// with a throwaway database and the environment restored at the end.
function bootSeed(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bookmarks-seed-'));
  const dbPath = path.join(dir, 'bookmarks.db');
  const before = {};
  for (const [k, v] of Object.entries(env)) { before[k] = process.env[k]; process.env[k] = v; }

  const users = (app) => app.db.prepare('SELECT * FROM users').all();
  try {
    const first = createApp(dbPath);
    ensureSeedUser(first.db);
    const afterFirstBoot = users(first);
    first.db.close();

    // A second boot on the same database: that is where idempotency shows up.
    const second = createApp(dbPath);
    ensureSeedUser(second.db);
    const afterSecondBoot = users(second);
    second.db.close();

    return { afterFirstBoot, afterSecondBoot };
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('boot creates the test account with the default password', () => {
  const { afterFirstBoot } = bootSeed();
  assert.equal(afterFirstBoot.length, 1);
  assert.equal(afterFirstBoot[0].username, 'teste');
  assert.equal(afterFirstBoot[0].email, 'teste@bookmarks.local');
  assert.ok(verifyPassword('teste123', afterFirstBoot[0].pass_hash));
});

test('a second boot neither duplicates the account nor breaks the password', () => {
  const { afterSecondBoot } = bootSeed();
  assert.equal(afterSecondBoot.length, 1);
  assert.ok(verifyPassword('teste123', afterSecondBoot[0].pass_hash));
});

test('BOOKMARKS_SEED=0 creates no account at all', () => {
  const { afterSecondBoot } = bootSeed({ BOOKMARKS_SEED: '0' });
  assert.equal(afterSecondBoot.length, 0);
});

test('the test account username and password come from the environment', () => {
  const { afterFirstBoot } = bootSeed({
    BOOKMARKS_SEED_USER: 'qa',
    BOOKMARKS_SEED_PASSWORD: 'segredo123',
  });
  assert.equal(afterFirstBoot[0].username, 'qa');
  assert.equal(afterFirstBoot[0].email, 'qa@bookmarks.local');
  assert.ok(verifyPassword('segredo123', afterFirstBoot[0].pass_hash));
  assert.ok(!verifyPassword('teste123', afterFirstBoot[0].pass_hash));
});

test('a password changed in the environment is reset on the next boot', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bookmarks-seed-'));
  const dbPath = path.join(dir, 'bookmarks.db');
  try {
    const a = createApp(dbPath);
    ensureSeedUser(a.db);
    a.db.close();

    process.env.BOOKMARKS_SEED_PASSWORD = 'new-password';
    const b = createApp(dbPath);
    ensureSeedUser(b.db);
    const [u] = b.db.prepare('SELECT * FROM users').all();
    b.db.close();

    assert.ok(verifyPassword('new-password', u.pass_hash));
  } finally {
    delete process.env.BOOKMARKS_SEED_PASSWORD;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------- usage ranking ---------------- */

test('opening a bookmark counts, and the count survives a sync', async () => {
  const created = await call('POST', '/api/bookmarks', {
    token, body: { url: 'https://usado.example', title: 'usado' },
  });
  const id = created.body.item.id;
  assert.equal(created.body.item.opens, 0);

  const first = await call('POST', '/api/bookmarks/open', { token, body: { id } });
  assert.equal(first.status, 200);
  assert.equal(first.body.item.opens, 1);
  assert.ok(first.body.item.last_open_at > 0);

  await call('POST', '/api/bookmarks/open', { token, body: { id } });
  const after = await call('GET', `/api/bookmarks/${id}`, { token });
  assert.equal(after.body.item.opens, 2);

  // A client pushing an older count must not erase what the server has: the
  // counters merge with MAX, they are not last-write-wins.
  await call('POST', '/api/sync', {
    token, body: { since: 0, changes: [{ ...after.body.item, opens: 0, title: 'usado editado' }] },
  });
  const merged = await call('GET', `/api/bookmarks/${id}`, { token });
  assert.equal(merged.body.item.opens, 2, 'the count stays');
  assert.equal(merged.body.item.title, 'usado editado', 'the rest is last-write-wins');
});

test('opening something that does not exist is a 404', async () => {
  const r = await call('POST', '/api/bookmarks/open', { token, body: { id: 'nao-existe' } });
  assert.equal(r.status, 404);
});

/* ---------------- moving folders ---------------- */

async function makeIn(folder, title) {
  const r = await call('POST', '/api/bookmarks', { token, body: { url: `https://${title}.example`, title, folder } });
  return r.body.item.id;
}

test('moving a folder takes everything under it', async () => {
  const rust = await makeIn('rust', 'rust raiz');
  const nested = await makeIn('rust/async', 'rust async');
  const other = await makeIn('rustico', 'nao e a mesma pasta');

  const r = await call('POST', '/api/folders/move', { token, body: { from: 'rust', to: 'programming' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.moved, 2);
  assert.equal(r.body.to, 'programming/rust');

  const folderOf = async (id) => (await call('GET', `/api/bookmarks/${id}`, { token })).body.item.folder;
  assert.equal(await folderOf(rust), 'programming/rust');
  assert.equal(await folderOf(nested), 'programming/rust/async');
  assert.equal(await folderOf(other), 'rustico', 'a folder with the same prefix is not dragged along');
});

test('a folder cannot move inside itself', async () => {
  await makeIn('dev/infra', 'infra');
  const r = await call('POST', '/api/folders/move', { token, body: { from: 'dev', to: 'dev/infra' } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /inside itself/);
});

test('moving to the root pulls the folder out', async () => {
  const id = await makeIn('a/b/c', 'fundo do poco');
  const r = await call('POST', '/api/folders/move', { token, body: { from: 'a/b', to: '' } });
  assert.equal(r.body.to, 'b');
  const item = (await call('GET', `/api/bookmarks/${id}`, { token })).body.item;
  assert.equal(item.folder, 'b/c');
});

test('moving an empty folder changes nothing and does not fail', async () => {
  const r = await call('POST', '/api/folders/move', { token, body: { from: 'pasta-vazia', to: 'destino' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.moved, 0);
});

test('from is required', async () => {
  const r = await call('POST', '/api/folders/move', { token, body: { from: '  /  ', to: 'x' } });
  assert.equal(r.status, 400);
});

/* ---------------- insights ---------------- */

test('insights reports the window, the top links and the log', async () => {
  const a = await call('POST', '/api/bookmarks', { token, body: { url: 'https://insight-a.example', title: 'Insight A' } });
  const b = await call('POST', '/api/bookmarks', { token, body: { url: 'https://insight-b.example', title: 'Insight B' } });

  for (let i = 0; i < 3; i++) await call('POST', '/api/bookmarks/open', { token, body: { id: a.body.item.id } });
  await call('POST', '/api/bookmarks/open', { token, body: { id: b.body.item.id } });

  const r = await call('GET', '/api/insights?days=7', { token });
  assert.equal(r.status, 200);
  assert.equal(r.body.days, 7);
  assert.equal(r.body.daily.length, 7, 'one bucket per day, empty days included');
  assert.equal(r.body.daily.at(-1).count >= 4, true, 'today holds the opens');

  const top = r.body.top.find((x) => x.id === a.body.item.id);
  assert.equal(top.hits, 3);
  assert.equal(top.total, 3);
  assert.ok(r.body.top.findIndex((x) => x.id === a.body.item.id)
          < r.body.top.findIndex((x) => x.id === b.body.item.id), 'the most opened comes first');

  assert.equal(r.body.log[0].id, b.body.item.id, 'the log is newest first');
  assert.ok(r.body.log.every((row) => row.at >= r.body.since));
});

test('the window is clamped and days is a number', async () => {
  assert.equal((await call('GET', '/api/insights?days=0', { token })).body.days, 7, 'falls back to a week');
  assert.equal((await call('GET', '/api/insights?days=999', { token })).body.days, 30, 'never past what is kept');
  assert.equal((await call('GET', '/api/insights?days=abc', { token })).body.days, 7);
});

test('insights only ever sees your own opens', async () => {
  const other = await call('POST', '/api/auth/register', {
    body: { email: 'insights@example.com', username: 'insights', password: 'secret123' },
  });
  const r = await call('GET', '/api/insights?days=7', { token: other.body.token });
  assert.equal(r.body.total, 0);
  assert.deepEqual(r.body.log, []);
  assert.deepEqual(r.body.top, []);
});
