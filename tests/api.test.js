'use strict';

// Backend tests: access keys, isolation between vaults, CRUD, search over the
// API, two-way sync and the files that make the PWA installable.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createApp, issueMissingKeys, ensureDevVault } = require('../api/server');
const { newAccessKey, normalizeKey, hashKey } = require('../api/auth');

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

let token;
let accessKey;

/* ---------------- access keys ---------------- */

test('health answers without auth', async () => {
  const r = await call('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
});

test('creating a vault returns its key, once, and a session', async () => {
  const r = await call('POST', '/api/auth/vault', { body: { name: 'apolzek' } });
  assert.equal(r.status, 201);
  assert.match(r.body.key, /^([0-9A-HJKMNP-TV-Z]{4}-){7}[0-9A-HJKMNP-TV-Z]{4}$/, 'eight groups of Crockford base32');
  assert.ok(r.body.token);
  assert.equal(r.body.user.name, 'apolzek');
  assert.equal(r.body.user.key_hash, undefined, 'the key hash must not leak');
  token = r.body.token;
  accessKey = r.body.key;
});

test('every vault gets its own key', async () => {
  const a = await call('POST', '/api/auth/vault', { body: {} });
  const b = await call('POST', '/api/auth/vault', { body: {} });
  assert.notEqual(a.body.key, b.body.key);
  assert.notEqual(a.body.user.id, b.body.user.id);
  assert.equal(a.body.user.name, '', 'a name is optional');
});

test('the key opens its vault, however it is typed', async () => {
  const forms = [
    accessKey,
    accessKey.toLowerCase(),
    accessKey.replace(/-/g, ' '),
    `  ${accessKey.replace(/-/g, '')}  `,
    // Crockford reads O as 0 and I or L as 1.
    accessKey.replace(/0/g, 'O').replace(/1/g, 'l'),
  ];
  for (const key of forms) {
    const r = await call('POST', '/api/auth/key', { body: { key } });
    assert.equal(r.status, 200, `should open with ${JSON.stringify(key)}`);
    assert.equal(r.body.user.name, 'apolzek');
  }
});

test('a wrong or malformed key opens nothing', async () => {
  const wrong = newAccessKey();
  for (const key of [wrong, '', 'short', accessKey.slice(0, -1), null, 42]) {
    const r = await call('POST', '/api/auth/key', { body: { key } });
    assert.equal(r.status, 401, `should refuse ${JSON.stringify(key)}`);
  }
});

test('only the hash of a key is stored', () => {
  const k = newAccessKey();
  assert.equal(hashKey(k).length, 64);
  assert.equal(hashKey(k), hashKey(k.toLowerCase()));
  assert.equal(hashKey('nope'), null, 'a key of the wrong length hashes to nothing');
  assert.equal(normalizeKey('ab-cd o l i'), 'ABCD011');
});

test('a vault can be renamed', async () => {
  const r = await call('POST', '/api/me', { token, body: { name: '  my links  ' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.name, 'my links');
  assert.equal((await call('GET', '/api/me', { token })).body.user.name, 'my links');
});

test('rotating the key kills the old key and every other session', async () => {
  const v = await call('POST', '/api/auth/vault', { body: {} });
  const other = (await call('POST', '/api/auth/key', { body: { key: v.body.key } })).body.token;
  const r = await call('POST', '/api/auth/rotate', { token: v.body.token });
  assert.equal(r.status, 200);
  assert.notEqual(r.body.key, v.body.key);
  assert.equal((await call('POST', '/api/auth/key', { body: { key: v.body.key } })).status, 401, 'old key is dead');
  assert.equal((await call('POST', '/api/auth/key', { body: { key: r.body.key } })).status, 200, 'new key works');
  assert.equal((await call('GET', '/api/me', { token: other })).status, 401, 'the other device is signed out');
  assert.equal((await call('GET', '/api/me', { token: v.body.token })).status, 200, 'this device stays in');
});

test('the password routes are gone', async () => {
  assert.equal((await call('POST', '/api/auth/login', { body: { login: 'x', password: 'y' } })).status, 401);
  assert.equal((await call('POST', '/api/auth/register', { body: { email: 'a@b', username: 'ab', password: 'secret' } })).status, 401);
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
  const other = await call('POST', '/api/auth/vault', { body: { name: 'outro' } });
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
  // The cursor is inclusive (>=, see server.js): a row stamped in the very
  // millisecond of the cursor is sent again on purpose. Step past it, so what
  // is measured below is the incremental sync and not that edge.
  await new Promise((r) => setTimeout(r, 5));

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
  const s = await call('POST', '/api/auth/key', { body: { key: accessKey } });
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
  const outro = await call('POST', '/api/auth/vault', { body: { name: 'importador' } });
  const r = await call('POST', '/api/import', {
    token: outro.body.token,
    body: { content: 'bookmarks:\n  - title: So dele\n    url: https://dele.com\n', apply: true },
  });
  assert.equal(r.body.summary.create, 1);

  const mine = await call('GET', '/api/bookmarks?q=dele.com', { token });
  assert.equal(mine.body.items.length, 0, 'one user import does not show up for another');
});

test('replace removes what is missing from the file, and warns first', async () => {
  const solo = await call('POST', '/api/auth/vault', { body: { name: 'replacer' } });
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

test('a link after the address gets the app, and nothing else does', async () => {
  const index = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
  for (const p of [
    '/https://www.youtube.com/watch?v=_Hkdzzx15PI', '/https:/www.youtube.com/watch',
    '/http://example.com', '/www.youtube.com/watch?v=x', '/example.com', '/localhost.dev:3000/x',
  ]) {
    const res = await fetch(base + p);
    assert.equal(res.status, 200, `${p} answered ${res.status}`);
    assert.equal(await res.text(), index, `${p} should be the app`);
  }
  // A real file is still the file, and a path that is no link stays a 404.
  assert.match(await (await fetch(base + '/app.js')).text(), /linkInPath/);
  for (const p of ['/nothing', '/js/nothing']) {
    assert.equal((await fetch(base + p)).status, 404, `${p} should be a 404`);
  }
});

test('the PWA assets exist and are served', async () => {
  const esperados = [
    '/manifest.webmanifest', '/sw.js', '/icon.svg',
    '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png', '/apple-touch-icon.png',
    '/style.css', '/app.js', '/search.js',
  ];
  // Every module the shell imports has to be precached, or the app opens
  // offline to a blank page missing one of them.
  const sw = await (await fetch(base + '/sw.js')).text();
  for (const m of fs.readdirSync(path.join(__dirname, '..', 'web', 'js'))) {
    esperados.push(`/js/${m}`);
    assert.ok(sw.includes(`'/js/${m}'`), `sw.js does not precache /js/${m}`);
  }
  for (const p of esperados) {
    assert.equal((await fetch(base + p)).status, 200, `${p} should exist`);
  }
});

test('the font is served as a font', async () => {
  const res = await fetch(base + '/fonts/jetbrains-mono.woff2');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'font/woff2');
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

/* ---------------- vaults from before the keys ---------------- */

// A database in the shape the password era left behind: users with an email,
// a username and a password hash, and bookmarks pointing at them.
function legacyDb(dbPath) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE,
      username TEXT NOT NULL UNIQUE, pass_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL);
    CREATE TABLE bookmarks (id TEXT NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '', folder TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, id));
    INSERT INTO users VALUES (1, 'a@x', 'alice', 'scrypt$00$00', 1), (2, 'b@x', 'bob', 'scrypt$00$00', 1);
    INSERT INTO sessions VALUES ('old-token', 1, 1);
    INSERT INTO bookmarks (id, user_id, title, url, folder, created_at, updated_at)
      VALUES ('b1', 1, 'Alice one', 'https://a.example', 'dev', 1, 1),
             ('b2', 1, 'Alice two', 'https://b.example', '', 1, 1),
             ('b3', 2, 'Bob one', 'https://c.example', 'x', 1, 1);
  `);
  db.close();
}

test('an old vault keeps every bookmark and gets a key on boot', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bookmarks-legacy-'));
  const dbPath = path.join(dir, 'bookmarks.db');
  try {
    legacyDb(dbPath);
    const app = createApp(dbPath);
    const users = app.db.prepare('SELECT * FROM users ORDER BY id').all();
    assert.deepEqual(users.map((u) => [u.id, u.name, u.key_hash]), [[1, 'alice', null], [2, 'bob', null]],
      'ids and names survive; the passwords do not');
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0, 'password sessions are gone');
    assert.equal(app.db.prepare('PRAGMA foreign_key_check').all().length, 0);

    const issued = issueMissingKeys(app.db);
    assert.equal(issued.length, 2);
    assert.deepEqual(issueMissingKeys(app.db), [], 'a vault with a key is never issued another');

    await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${app.server.address().port}`;
    const open = await (await fetch(url + '/api/auth/key', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: issued[0].key }),
    })).json();
    assert.equal(open.user.name, 'alice');
    const list = await (await fetch(url + '/api/bookmarks', { headers: { authorization: `Bearer ${open.token}` } })).json();
    assert.deepEqual(list.items.map((b) => b.id).sort(), ['b1', 'b2'], 'alice sees her bookmarks and only hers');
    app.server.close();
    app.db.close();

    // A second boot on the migrated database changes nothing.
    const again = createApp(dbPath);
    assert.equal(again.db.prepare('SELECT COUNT(*) AS n FROM bookmarks').get().n, 3);
    again.db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('BOOKMARKS_DEV_KEY makes one known vault, idempotently', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bookmarks-dev-'));
  try {
    const app = createApp(path.join(dir, 'bookmarks.db'));
    const key = newAccessKey();
    assert.equal(ensureDevVault(app.db, ''), null, 'off unless set');
    assert.equal(ensureDevVault(app.db, key).created, true);
    assert.equal(ensureDevVault(app.db, key.toLowerCase()).created, false);
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
    assert.throws(() => ensureDevVault(app.db, 'too-short'));
    app.db.close();
  } finally {
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

/* ---------------- doing one thing to many bookmarks ---------------- */

// Selecting rows in the list and filing or deleting them at once. One request,
// because a selection can be the whole vault.

test('a batch move files every id it is given', async () => {
  const a = await makeIn('lote/origem', 'lote a');
  const b = await makeIn('lote/origem', 'lote b');
  const c = await makeIn('lote/fica', 'lote c');

  const r = await call('POST', '/api/bookmarks/move', { token, body: { ids: [a, b], folder: '/lote/destino/' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.moved, 2);
  assert.equal(r.body.folder, 'lote/destino', 'the path is normalised the way a folder is');

  const folderOf = async (id) => (await call('GET', `/api/bookmarks/${id}`, { token })).body.item.folder;
  assert.equal(await folderOf(a), 'lote/destino');
  assert.equal(await folderOf(b), 'lote/destino');
  assert.equal(await folderOf(c), 'lote/fica', 'and nothing else is touched');
});

test('an empty folder in a batch move means the root', async () => {
  const id = await makeIn('lote/tirar', 'sai da pasta');
  const r = await call('POST', '/api/bookmarks/move', { token, body: { ids: [id], folder: '' } });
  assert.equal(r.body.moved, 1);
  assert.equal((await call('GET', `/api/bookmarks/${id}`, { token })).body.item.folder, '');
});

test('a batch move counts only what actually moved', async () => {
  const id = await makeIn('lote/mesmo', 'ja esta la');
  const r = await call('POST', '/api/bookmarks/move', { token, body: { ids: [id], folder: 'lote/mesmo' } });
  assert.equal(r.body.moved, 0, 'moving something to where it already is changes nothing');
});

test('an id that is not yours is skipped, not refused', async () => {
  const mine = await makeIn('lote/meu', 'meu');
  const other = (await call('POST', '/api/auth/vault', { body: { name: 'loteuser' } })).body.token;
  const theirs = (await call('POST', '/api/bookmarks', {
    token: other, body: { url: 'https://alheio.example', title: 'alheio', folder: 'deles' },
  })).body.item.id;

  const r = await call('POST', '/api/bookmarks/move', { token, body: { ids: [mine, theirs], folder: 'lote/novo' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.moved, 1, 'the whole batch is not thrown away over one stale id');
  assert.equal((await call('GET', `/api/bookmarks/${theirs}`, { token: other })).body.item.folder, 'deles',
               'and the other account is untouched');
});

test('a batch needs ids', async () => {
  assert.equal((await call('POST', '/api/bookmarks/move', { token, body: { ids: [], folder: 'x' } })).status, 400);
  assert.equal((await call('POST', '/api/bookmarks/delete', { token, body: {} })).status, 400);
});

test('a batch delete buries every id and says how many', async () => {
  const a = await makeIn('lote/apagar', 'apaga a');
  const b = await makeIn('lote/apagar', 'apaga b');
  const c = await makeIn('lote/apagar', 'apaga c');

  const r = await call('POST', '/api/bookmarks/delete', { token, body: { ids: [a, b] } });
  assert.equal(r.body.deleted, 2);
  assert.equal((await call('GET', `/api/bookmarks/${a}`, { token })).status, 404);
  assert.equal((await call('GET', `/api/bookmarks/${b}`, { token })).status, 404);
  assert.equal((await call('GET', `/api/bookmarks/${c}`, { token })).status, 200);

  // Deleting the same ones again is not an error and not a second deletion.
  const again = await call('POST', '/api/bookmarks/delete', { token, body: { ids: [a, b] } });
  assert.equal(again.body.deleted, 0);
});

test('a batch delete is a tombstone, so the sync carries it', async () => {
  const id = await makeIn('lote/tumulo', 'vira tombstone');
  const before = Date.now();
  await call('POST', '/api/bookmarks/delete', { token, body: { ids: [id] } });
  const sync = await call('POST', '/api/sync', { token, body: { since: before, changes: [] } });
  const row = sync.body.changes.find((c) => c.id === id);
  assert.ok(row, 'the deletion reaches the other client');
  assert.equal(row.deleted, 1);
});

/* ---------------- folders of their own ---------------- */

// A folder that holds nothing cannot be a string on a bookmark, which is the
// whole reason the `folders` table exists. Everything below is about that one
// difference: creating one, keeping it, and taking it with the branch.

const paths = async (t = token) =>
  (await call('GET', '/api/folders', { token: t })).body.folders.map((f) => f.path);

test('creating a folder writes the way down to it', async () => {
  const r = await call('POST', '/api/folders', { token, body: { path: '/empty/deep/leaf/' } });
  assert.equal(r.status, 201);
  assert.equal(r.body.folder.path, 'empty/deep/leaf');

  const all = await paths();
  for (const step of ['empty', 'empty/deep', 'empty/deep/leaf']) {
    assert.ok(all.includes(step), `${step} is on the tree`);
  }
});

test('a folder with no bookmarks in it still comes back', async () => {
  await call('POST', '/api/folders', { token, body: { path: 'solitaria' } });
  assert.ok((await paths()).includes('solitaria'));
  // And nothing about it reaches the bookmarks.
  const items = (await call('GET', '/api/bookmarks', { token })).body.items;
  assert.equal(items.filter((b) => b.folder === 'solitaria').length, 0);
});

test('creating a folder that is already on the tree is refused', async () => {
  await call('POST', '/api/folders', { token, body: { path: 'duplicada' } });
  const again = await call('POST', '/api/folders', { token, body: { path: 'duplicada' } });
  assert.equal(again.status, 409);

  // Including one the tree only has because bookmarks are inside it: to
  // whoever is looking at the panel the two kinds are the same folder.
  await makeIn('derivada/dentro', 'algo');
  const derived = await call('POST', '/api/folders', { token, body: { path: 'derivada' } });
  assert.equal(derived.status, 409);
});

test('a path is required', async () => {
  const r = await call('POST', '/api/folders', { token, body: { path: ' // ' } });
  assert.equal(r.status, 400);
});

test('renaming rewrites the branch and keeps the parent', async () => {
  const id = await makeIn('velho/dentro', 'um link');
  await call('POST', '/api/folders', { token, body: { path: 'velho/dentro/vazia' } });

  const r = await call('POST', '/api/folders/rename', { token, body: { path: 'velho/dentro', name: 'novo' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.to, 'velho/novo');

  const item = (await call('GET', `/api/bookmarks/${id}`, { token })).body.item;
  assert.equal(item.folder, 'velho/novo', 'the bookmark went with it');

  const all = await paths();
  assert.ok(all.includes('velho/novo/vazia'), 'and so did the empty folder below it');
  assert.ok(!all.includes('velho/dentro/vazia'), 'the old path is gone');
});

test('a rename cannot smuggle a move in the name', async () => {
  await call('POST', '/api/folders', { token, body: { path: 'imovel' } });
  const r = await call('POST', '/api/folders/rename', { token, body: { path: 'imovel', name: 'outro/lugar' } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /cannot contain/);
});

test('renaming onto a folder that exists is refused', async () => {
  await call('POST', '/api/folders', { token, body: { path: 'ocupada' } });
  await call('POST', '/api/folders', { token, body: { path: 'livre' } });
  const r = await call('POST', '/api/folders/rename', { token, body: { path: 'livre', name: 'ocupada' } });
  assert.equal(r.status, 409);
});

test('moving a folder carries the empty ones inside it', async () => {
  await call('POST', '/api/folders', { token, body: { path: 'mudanca/nada' } });
  const r = await call('POST', '/api/folders/move', { token, body: { from: 'mudanca', to: 'destino' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.to, 'destino/mudanca');

  const all = await paths();
  assert.ok(all.includes('destino/mudanca/nada'));
  assert.ok(!all.includes('mudanca/nada'), 'nothing is left behind at the old path');
});

test('deleting a folder takes the bookmarks under it', async () => {
  const inside = await makeIn('condenada/sub', 'vai junto');
  const outside = await makeIn('condenada-vizinha', 'fica');
  await call('POST', '/api/folders', { token, body: { path: 'condenada/vazia' } });

  const r = await call('POST', '/api/folders/delete', { token, body: { path: 'condenada' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.bookmarks, 1);

  assert.equal((await call('GET', `/api/bookmarks/${inside}`, { token })).status, 404);
  assert.equal((await call('GET', `/api/bookmarks/${outside}`, { token })).status, 200,
               'a folder whose name merely starts the same is untouched');

  const all = await paths();
  assert.ok(!all.some((x) => x === 'condenada' || x.startsWith('condenada/')));
});

test('deleting a folder that is not there says so', async () => {
  const r = await call('POST', '/api/folders/delete', { token, body: { path: 'nunca-existiu' } });
  assert.equal(r.status, 404);
});

test('folders are private to the user, like the bookmarks', async () => {
  const other = (await call('POST', '/api/auth/vault', { body: { name: 'folderuser' } })).body.token;

  await call('POST', '/api/folders', { token: other, body: { path: 'so-minha' } });
  assert.ok(!(await paths()).includes('so-minha'));
  assert.ok((await paths(other)).includes('so-minha'));
});

test('the sync carries folders, tombstones included', async () => {
  const t = (await call('POST', '/api/auth/vault', { body: { name: 'foldersync' } })).body.token;

  await call('POST', '/api/folders', { token: t, body: { path: 'sincronizada' } });
  const first = await call('POST', '/api/sync', { token: t, body: { since: 0, changes: [] } });
  assert.ok(first.body.folders.some((f) => f.path === 'sincronizada' && !f.deleted));

  await call('POST', '/api/folders/delete', { token: t, body: { path: 'sincronizada' } });
  const second = await call('POST', '/api/sync', { token: t, body: { since: first.body.now, changes: [] } });
  assert.ok(second.body.folders.some((f) => f.path === 'sincronizada' && f.deleted === 1),
            'the other client has to learn the folder is gone');
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
  const other = await call('POST', '/api/auth/vault', { body: { name: 'insights' } });
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
  const mine = await call('POST', '/api/auth/vault', { body: { name: 'restore' } });
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
  const t = (await call('POST', '/api/auth/vault', { body: { name: 'quoting' } })).body.token;

  // Every one of these means something else in YAML unless the key is quoted.
  const names = ['dev: infra', '#tag', 'c++', '100%', 'true', 'null', '123', '[a]', '@at', '- dash'];
  for (const [i, folder] of names.entries()) {
    await call('POST', '/api/bookmarks', { token: t, body: { url: `https://q${i}.example`, title: `q${i}`, folder } });
  }
  const file = await fetch(`${base}/api/export?format=yaml`, {
    headers: { authorization: `Bearer ${t}` },
  }).then((r) => r.text());

  const other = (await call('POST', '/api/auth/vault', { body: { name: 'quoting2' } })).body.token;
  await call('POST', '/api/import', { token: other, body: { content: file, mode: 'add', apply: true } });

  const copied = (await call('GET', '/api/bookmarks?limit=500', { token: other })).body.items;
  assert.deepEqual([...new Set(copied.map((b) => b.folder))].sort(), [...names].sort());
});

/* ---------------- sync: the cursor is a millisecond ---------------- */

test('a change made in the same millisecond as the last sync still arrives', async () => {
  const t = (await call('POST', '/api/auth/vault', { body: { name: 'cursor' } })).body.token;

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
  const t = (await call('POST', '/api/auth/vault', { body: { name: 'cursor2' } })).body.token;
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
  const t = (await call('POST', '/api/auth/vault', { body: { name: 'revive' } })).body.token;
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
