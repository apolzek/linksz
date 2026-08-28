'use strict';

// Backend tests: auth, isolation between users, CRUD, search over the API,
// two-way sync and the files that make the PWA installable.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createApp, ensureSeedUser } = require('../api/server');
const { verifyPassword } = require('../api/auth');

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

/* ---------------- search over the API ---------------- */

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

test('two-way sync between two clients', async () => {
  const a = await call('POST', '/api/sync', {
    token,
    body: { since: 0, changes: [{ id: 'uuid-client-1', url: 'https://zed.dev', title: 'Zed', tags: 'editor', category: 'dev', updated_at: Date.now() }] },
  });
  assert.equal(a.body.pushed, 1);

  const b = await call('POST', '/api/sync', { token, body: { since: 0, changes: [] } });
  assert.ok(b.body.changes.some((c) => c.id === 'uuid-client-1'));

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
  assert.match(r.text, /^# Bookmarks export/);
  assert.match(r.text, /^folders:$/m, 'grouped by folder, one key per path');
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

const CHROME_FILE = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
    <DT><H3>navegador</H3>
    <DL><p>
        <DT><A HREF="https://veio-do-chrome.com" ADD_DATE="1700000000">Do Chrome</A>
    </DL><p>
</DL><p>`;

test('the browser flow reads the browser format', async () => {
  const r = await call('POST', '/api/import', {
    token,
    body: { content: CHROME_FILE, source: 'browser', apply: true },
  });
  assert.equal(r.body.source, 'browser');
  assert.equal(r.body.format, 'html');
  assert.equal(r.body.summary.create, 1);
  assert.deepEqual(await q('/navegador'), ['Do Chrome'], 'the browser folder became the vault folder');
});

test('the browser flow can drop the whole tree under a folder', async () => {
  const r = await call('POST', '/api/import', {
    token,
    body: { content: CHROME_FILE, source: 'browser', folderPrefix: '/chrome//', apply: false },
  });
  assert.equal(r.body.file.prefix, 'chrome', 'the prefix is normalised the way a folder is');
  assert.equal(r.body.file.count, 1);
  assert.equal(r.body.file.folders, 1);
});

test('the browser flow also reads the browser\'s own profile file', async () => {
  const profile = JSON.stringify({
    checksum: 'x',
    roots: {
      bookmark_bar: {
        type: 'folder',
        name: 'Bookmarks bar',
        children: [{
          type: 'folder',
          name: 'Perfil',
          children: [{ type: 'url', name: 'Do perfil', url: 'https://veio-do-perfil.com', date_added: '13428098755418102' }],
        }],
      },
      other: { type: 'folder', name: 'Other bookmarks', children: [] },
    },
  });
  const r = await call('POST', '/api/import', {
    token,
    body: { content: profile, source: 'browser', apply: true },
  });
  assert.equal(r.body.format, 'chrome', 'told apart from the vault\'s own JSON');
  assert.equal(r.body.summary.create, 1);
  // No "Bookmarks bar" above it: the browser's roots are not folders.
  assert.deepEqual(await q('/Perfil'), ['Do perfil']);
});

test('a file in the wrong flow is refused, and told where it belongs', async () => {
  const asVault = await call('POST', '/api/import', { token, body: { content: CHROME_FILE } });
  assert.equal(asVault.status, 400);
  assert.match(asVault.body.error, /From a browser/, 'it points at the other flow');
  assert.doesNotMatch(asVault.body.error, /could not read/, 'the file is not broken, only misfiled');

  const asBrowser = await call('POST', '/api/import', {
    token,
    body: { content: 'bookmarks: []', source: 'browser' },
  });
  assert.equal(asBrowser.status, 400);
  assert.match(asBrowser.body.error, /From this app/);
});

test('a browser file may never replace the vault', async () => {
  const r = await call('POST', '/api/import', {
    token,
    body: { content: CHROME_FILE, source: 'browser', mode: 'replace' },
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /cannot replace the vault/);
});

test('a browser import brings no category, whatever the file says', async () => {
  const withTags = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
    <DT><H3>infra</H3>
    <DL><p>
        <DT><A HREF="https://k8s.io" TAGS="k8s,devops">Kubernetes</A>
    </DL><p>
</DL><p>`;
  const r = await call('POST', '/api/import', {
    token,
    body: { content: withTags, source: 'browser', folderPrefix: 'chrome', apply: true },
  });
  assert.equal(r.body.summary.create, 1);
  assert.equal(r.body.file.tagged, 1, 'tags survive when the browser wrote them');

  const found = await call('GET', '/api/bookmarks?q=kubernetes', { token });
  const b = found.body.items.find((x) => x.url.includes('k8s.io'));
  assert.equal(b.category, '', 'the format has no categories, so neither does the import');
  assert.equal(b.folder, 'chrome/infra', 'the prefix sits above the browser tree');
});

test('the preview says what the file carries before anything is written', async () => {
  const r = await call('POST', '/api/import', {
    token,
    body: { content: CHROME_FILE, source: 'browser' },
  });
  assert.deepEqual(
    { count: r.body.file.count, folders: r.body.file.folders, unfiled: r.body.file.unfiled },
    { count: 1, folders: 1, unfiled: 0 },
  );
  assert.equal(r.body.applied, false);
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
  // The encoded ones are the interesting half: fetch normalizes `/../x` away
  // before it leaves the client, while `%2e%2e` reaches the server intact.
  const attempts = [
    '/%2e%2e/api/db.js', '/%2e%2e/%2e%2e/etc/passwd', '/..%2fapi%2fserver.js',
    '/../../etc/passwd', '/./../api/auth.js',
  ];
  for (const p of attempts) {
    const res = await fetch(base + p);
    const body = await res.text();
    // 401 is a pass too: `%2e%2e` normalizes to `..` in the URL parser, so the
    // path lands on the API router and is turned away before any file is read.
    assert.ok([401, 403, 404].includes(res.status), `${p} answered ${res.status}`);
    assert.ok(!body.includes('DatabaseSync') && !body.includes('root:'), `${p} leaked a file`);
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

/* ---------------- cors ---------------- */

// Boots an app on a throwaway database with the environment of the moment, so
// each case sees the allowlist it is about.
async function withApp(env, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bookmarks-cors-'));
  const before = {};
  for (const [k, v] of Object.entries(env)) { before[k] = process.env[k]; process.env[k] = v; }
  const app = createApp(path.join(dir, 'bookmarks.db'));
  try {
    await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
    await fn(`http://127.0.0.1:${app.server.address().port}`);
  } finally {
    app.server.close();
    app.db.close();
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('by default no origin is allowed to read the API from a browser', async () => {
  await withApp({}, async (url) => {
    const r = await fetch(url + '/api/health', { headers: { origin: 'https://evil.example' } });
    assert.equal(r.status, 200, 'the request still answers, curl and scripts are not the threat');
    assert.equal(r.headers.get('access-control-allow-origin'), null,
      'without this header the browser refuses to hand the body to the page');
    assert.equal(r.headers.get('vary'), 'Origin');
  });
});

test('a listed origin is allowed, one letter off is not', async () => {
  await withApp({ BOOKMARKS_ALLOWED_ORIGINS: 'https://app.example, https://other.example/' }, async (url) => {
    const yes = await fetch(url + '/api/health', { headers: { origin: 'https://app.example' } });
    assert.equal(yes.headers.get('access-control-allow-origin'), 'https://app.example');

    // The trailing slash in the variable is tolerated; the origin still matches.
    const slash = await fetch(url + '/api/health', { headers: { origin: 'https://other.example' } });
    assert.equal(slash.headers.get('access-control-allow-origin'), 'https://other.example');

    const no = await fetch(url + '/api/health', { headers: { origin: 'https://app.example.evil' } });
    assert.equal(no.headers.get('access-control-allow-origin'), null);
  });
});

test('the preflight answers only for an allowed origin', async () => {
  await withApp({ BOOKMARKS_ALLOWED_ORIGINS: 'https://app.example' }, async (url) => {
    const yes = await fetch(url + '/api/bookmarks', {
      method: 'OPTIONS',
      headers: { origin: 'https://app.example', 'access-control-request-method': 'POST' },
    });
    assert.equal(yes.status, 204);
    assert.equal(yes.headers.get('access-control-allow-origin'), 'https://app.example');
    assert.match(yes.headers.get('access-control-allow-methods'), /POST/);

    const no = await fetch(url + '/api/bookmarks', {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    assert.equal(no.headers.get('access-control-allow-origin'), null);
  });
});

test('* opens it back up, for whoever decides they want that', async () => {
  await withApp({ BOOKMARKS_ALLOWED_ORIGINS: '*' }, async (url) => {
    const r = await fetch(url + '/api/health', { headers: { origin: 'https://anywhere.example' } });
    assert.equal(r.headers.get('access-control-allow-origin'), 'https://anywhere.example');
  });
});

test('the static files carry no CORS header either', async () => {
  await withApp({}, async (url) => {
    const r = await fetch(url + '/manifest.webmanifest', { headers: { origin: 'https://evil.example' } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('access-control-allow-origin'), null);
  });
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
  const other = await makeIn('rustico', 'a different folder');

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
  const r = await call('POST', '/api/folders/move', { token, body: { from: 'empty-folder', to: 'somewhere' } });
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

/* ---------------- editing the yaml by hand ---------------- */

test('renaming a folder key in the file moves everything under it', async () => {
  const mk = (folder, title) => call('POST', '/api/bookmarks', {
    token, body: { url: `https://${title}.example`, title, folder },
  });
  await mk('velho/caminho', 'yaml-a');
  await mk('velho/caminho/fundo', 'yaml-b');

  const exported = await fetch(`${base}/api/export?format=yaml`, {
    headers: { authorization: `Bearer ${token}` },
  }).then((r) => r.text());
  assert.match(exported, /^ {2}velho\/caminho:$/m, 'the path is the key');

  // The whole branch travels by editing one key, and one entry travels by
  // being given a folder line: the two ways the header documents.
  const edited = exported
    .replace(/^ {2}velho\/caminho:$/m, '  novo/caminho:')
    .replace(/^ {2}velho\/caminho\/fundo:$/m, '  novo/caminho/fundo:')
    .replace('    title: yaml-a', '    title: yaml-a\n    folder: solto');

  // `update` is the mode for a hand-edited file: with equal dates the others
  // keep what the vault already has.
  const plan = await call('POST', '/api/import', { token, body: { content: edited, mode: 'update', apply: true } });
  assert.equal(plan.status, 200);

  const all = (await call('GET', '/api/bookmarks?limit=500', { token })).body.items;
  assert.equal(all.find((b) => b.title === 'yaml-a').folder, 'solto');
  assert.equal(all.find((b) => b.title === 'yaml-b').folder, 'novo/caminho/fundo');
});

test('reimporting an untouched export changes nothing', async () => {
  const exported = await fetch(`${base}/api/export?format=yaml`, {
    headers: { authorization: `Bearer ${token}` },
  }).then((r) => r.text());
  const before = (await call('GET', '/api/bookmarks?limit=500', { token })).body.total;

  const plan = await call('POST', '/api/import', { token, body: { content: exported, mode: 'add' } });
  assert.equal(plan.body.summary.create, 0, 'nothing is created twice');

  const after = (await call('GET', '/api/bookmarks?limit=500', { token })).body.total;
  assert.equal(after, before);
});

/* ---------------- import: the file is a backup ---------------- */

test('an exported id comes back as the same bookmark, not a copy', async () => {
  const mine = await call('POST', '/api/auth/register', {
    body: { email: 'restore@example.com', username: 'restore', password: 'secret123' },
  });
  const t = mine.body.token;
  const made = await call('POST', '/api/bookmarks', {
    token: t, body: { url: 'https://restore.example', title: 'Restaurar', folder: 'a/b' },
  });
  const backup = await fetch(`${base}/api/export?format=yaml`, {
    headers: { authorization: `Bearer ${t}` },
  }).then((r) => r.text());

  // Deleted here, still in the file: importing has to bring the same row back,
  // tombstone and last-write-wins gate notwithstanding.
  await call('DELETE', `/api/bookmarks/${made.body.item.id}`, { token: t });
  assert.equal((await call('GET', `/api/bookmarks/${made.body.item.id}`, { token: t })).status, 404);

  await call('POST', '/api/import', { token: t, body: { content: backup, mode: 'add', apply: true } });
  const back = await call('GET', `/api/bookmarks/${made.body.item.id}`, { token: t });
  assert.equal(back.status, 200, 'the bookmark is back');
  assert.equal(back.body.item.id, made.body.item.id, 'with the id it had');
  assert.equal(back.body.item.folder, 'a/b');
});

test('a file that cannot be read is refused and writes nothing', async () => {
  const before = (await call('GET', '/api/bookmarks?limit=5000', { token })).body.total;
  const broken = {
    'empty': '',
    'plain text': 'this is not an export of anything',
    'unclosed quote': 'folders:\n  dev:\n  - title: "cut in half\n',
    'tab indentation': 'folders:\n\tdev:\n\t- title: x\n',
    'no known key': 'title: nothing\nother: field\n',
    'folders as a list': 'folders:\n- title: loose\n  url: https://loose\n',
  };
  for (const [what, content] of Object.entries(broken)) {
    const r = await call('POST', '/api/import', { token, body: { content, mode: 'add', apply: true } });
    assert.equal(r.status, 400, `${what} should be refused`);
    assert.ok(r.body.error, `${what} says why`);
    const after = (await call('GET', '/api/bookmarks?limit=5000', { token })).body.total;
    assert.equal(after, before, `${what} wrote nothing`);
  }
});

test('the preview writes nothing and matches what apply does', async () => {
  const file = ['folders:', '  preview/only:',
                '  - title: Previsto', '    url: https://previsto.example', ''].join('\n');
  const before = (await call('GET', '/api/bookmarks?limit=5000', { token })).body.total;

  const plan = await call('POST', '/api/import', { token, body: { content: file, mode: 'add' } });
  assert.equal(plan.body.applied, false);
  assert.equal((await call('GET', '/api/bookmarks?limit=5000', { token })).body.total, before,
               'a preview is a preview');

  await call('POST', '/api/import', { token, body: { content: file, mode: 'add', apply: true } });
  const after = (await call('GET', '/api/bookmarks?limit=5000', { token })).body.total;
  assert.equal(after - before, plan.body.summary.create, 'created exactly what the plan said');
});

test('folder names that need quoting in yaml survive the round trip', async () => {
  const t = (await call('POST', '/api/auth/register', {
    body: { email: 'quoting@example.com', username: 'quoting', password: 'secret123' },
  })).body.token;

  // Every one of these means something else in YAML unless the key is quoted.
  const names = ['dev: infra', '#tag', 'c++', '100%', 'true', 'null', '123', '[a]', '@at', '- dash'];
  for (const [i, folder] of names.entries()) {
    await call('POST', '/api/bookmarks', { token: t, body: { url: `https://q${i}.example`, title: `q${i}`, folder } });
  }
  const file = await fetch(`${base}/api/export?format=yaml`, {
    headers: { authorization: `Bearer ${t}` },
  }).then((r) => r.text());

  const other = (await call('POST', '/api/auth/register', {
    body: { email: 'quoting2@example.com', username: 'quoting2', password: 'secret123' },
  })).body.token;
  await call('POST', '/api/import', { token: other, body: { content: file, mode: 'add', apply: true } });

  const copied = (await call('GET', '/api/bookmarks?limit=500', { token: other })).body.items;
  assert.deepEqual([...new Set(copied.map((b) => b.folder))].sort(), [...names].sort());
});

/* ---------------- sync: the cursor is a millisecond ---------------- */

test('a change made in the same millisecond as the last sync still arrives', async () => {
  const t = (await call('POST', '/api/auth/register', {
    body: { email: 'cursor@example.com', username: 'cursor', password: 'secret123' },
  })).body.token;

  const made = await call('POST', '/api/bookmarks', {
    token: t, body: { url: 'https://cursor.example', title: 'Cursor' },
  });
  const first = await call('POST', '/api/sync', { token: t, body: { since: 0, changes: [] } });
  const cursor = first.body.now;

  // The worst case, forced: a write stamped exactly at the cursor the client
  // was told to come back with. An exclusive `>` would drop it forever.
  await call('POST', '/api/sync', {
    token: t,
    body: { since: cursor, changes: [{ ...made.body.item, title: 'Cursor edited', updated_at: cursor }] },
  });

  const other = await call('POST', '/api/sync', { token: t, body: { since: cursor, changes: [] } });
  const seen = other.body.changes.find((c) => c.id === made.body.item.id);
  assert.ok(seen, 'the change is in the answer');
  assert.equal(seen.title, 'Cursor edited');
});

test('a deletion in that same window is not lost either', async () => {
  const t = (await call('POST', '/api/auth/register', {
    body: { email: 'cursor2@example.com', username: 'cursor2', password: 'secret123' },
  })).body.token;
  const made = await call('POST', '/api/bookmarks', {
    token: t, body: { url: 'https://gone.example', title: 'Gone' },
  });

  const first = await call('POST', '/api/sync', { token: t, body: { since: 0, changes: [] } });
  await call('DELETE', `/api/bookmarks/${made.body.item.id}`, { token: t });

  const after = await call('POST', '/api/sync', { token: t, body: { since: first.body.now, changes: [] } });
  const tomb = after.body.changes.find((c) => c.id === made.body.item.id);
  assert.ok(tomb, 'the tombstone travels');
  assert.equal(tomb.deleted, 1);
});

test('a sync push does not bring a deleted bookmark back', async () => {
  const t = (await call('POST', '/api/auth/register', {
    body: { email: 'revive@example.com', username: 'revive', password: 'secret123' },
  })).body.token;
  const made = (await call('POST', '/api/bookmarks', {
    token: t, body: { url: 'https://revive.example', title: 'Revive' },
  })).body.item;

  await call('DELETE', `/api/bookmarks/${made.id}`, { token: t });

  // What a bar that opened the link just before the deletion pushes: the whole
  // record, not deleted, stamped later. It must not undo the deletion.
  const pushed = await call('POST', '/api/sync', {
    token: t,
    body: { since: 0, changes: [{ ...made, opens: 3, updated_at: Date.now() + 5000 }] },
  });
  assert.equal(pushed.status, 200);

  const after = await call('GET', `/api/bookmarks/${made.id}`, { token: t });
  assert.equal(after.status, 404, 'it stays deleted');

  // The counter still merged, so nothing is lost if it is ever restored.
  const restored = await call('POST', '/api/import', {
    token: t, mode: 'add',
    body: {
      mode: 'add', apply: true,
      content: `folders:\n  /:\n  - id: ${made.id}\n    title: Revive\n    url: https://revive.example\n`,
    },
  });
  assert.equal(restored.status, 200);
  const back = await call('GET', `/api/bookmarks/${made.id}`, { token: t });
  assert.equal(back.status, 200, 'an import still restores it, because that one is deliberate');
  assert.equal(back.body.item.opens, 3, 'and the opens counted while it was gone survived');
});
