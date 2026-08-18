'use strict';

// Import/export tests: formats, URL matching and, most importantly, the import
// plan, which decides what to do when the bookmark already exists.

const test = require('node:test');
const assert = require('node:assert');

const p = require('../server/portability');
const yaml = require('../server/yaml');

const VAULT = [
  { id: 'v1', title: 'Kubernetes Docs', url: 'https://kubernetes.io/docs', folder: 'dev/infra',
    category: 'studies', tags: 'k8s,devops', description: '', created_at: 100, updated_at: 500 },
  { id: 'v2', title: 'The Go Blog', url: 'https://go.dev/blog', folder: 'dev',
    category: 'studies', tags: 'go', description: 'ler', created_at: 100, updated_at: 400 },
];

/* ---------------- identity by URL ---------------- */

test('urlKey ignores differences that do not change the page', () => {
  const same = [
    ['https://go.dev/blog', 'https://go.dev/blog/'],
    ['https://go.dev/blog', 'http://go.dev/blog'],
    ['https://go.dev/blog', 'https://www.go.dev/blog'],
    ['https://go.dev/blog', 'HTTPS://GO.DEV/blog'],
    ['https://go.dev/blog', 'https://go.dev/blog#secao'],
  ];
  for (const [a, b] of same) {
    assert.equal(p.urlKey(a), p.urlKey(b), `${a} should match ${b}`);
  }
});

test('urlKey separates what is a different page', () => {
  const different = [
    ['https://go.dev/blog', 'https://go.dev/docs'],
    ['https://go.dev/?p=1', 'https://go.dev/?p=2'],
    ['https://go.dev', 'https://outro.dev'],
  ];
  for (const [a, b] of different) {
    assert.notEqual(p.urlKey(a), p.urlKey(b), `${a} should not match ${b}`);
  }
});

test('urlKey survives garbage without blowing up', () => {
  assert.equal(p.urlKey(''), '');
  assert.equal(p.urlKey(null), '');
  assert.equal(p.urlKey('not an url'), 'not an url');
});

/* ---------------- export ---------------- */

test('the yaml export reads back as the same vault', () => {
  const doc = yaml.parse(p.toYaml(VAULT, { user: 'apolzek' }));
  assert.equal(doc.version, 1);
  assert.equal(doc.count, 2);
  assert.deepEqual(doc.bookmarks.map((b) => b.title), ['Kubernetes Docs', 'The Go Blog']);
  assert.deepEqual(doc.bookmarks[0].tags, ['k8s', 'devops'], 'tags become a list in the file');
});

test('the yaml export comes back through import with no field lost', () => {
  const { items } = p.parseImport(p.toYaml(VAULT));
  assert.equal(items.length, 2);
  const k8s = items[0];
  assert.equal(k8s.id, 'v1');
  assert.equal(k8s.folder, 'dev/infra');
  assert.equal(k8s.category, 'studies');
  assert.equal(k8s.tags, 'k8s,devops', 'the list in the file becomes csv again');
  assert.equal(k8s.created_at, 100);
});

test('the html export is recognized as a browser format', () => {
  const html = p.toNetscapeHtml(VAULT);
  assert.match(html, /^<!DOCTYPE NETSCAPE-Bookmark-file-1>/);
  assert.match(html, /<DT><H3>dev<\/H3>/, 'a folder becomes <H3>');
  assert.match(html, /HREF="https:\/\/kubernetes\.io\/docs"/);
  assert.match(html, /TAGS="k8s,devops"/);
  assert.equal(p.detectFormat(html), 'html');
});

test('the html export escapes what would break the file', () => {
  const html = p.toNetscapeHtml([
    { id: 'x', title: 'A & B <script>', url: 'https://x.com/?a=1&b="2"', tags: '', folder: '' },
  ]);
  assert.ok(!html.includes('<script>'), 'a tag must not go through raw');
  assert.match(html, /A &amp; B &lt;script&gt;/);
  const { items } = p.parseImport(html);
  assert.equal(items[0].title, 'A & B <script>', 'and it reads back as the original');
});

test('export json', () => {
  const doc = JSON.parse(p.toJson(VAULT));
  assert.equal(doc.count, 2);
  assert.equal(doc.bookmarks[0].id, 'v1');
  assert.equal(p.detectFormat(p.toJson(VAULT)), 'json');
});

/* ---------------- reading the browser format ---------------- */

const CHROME = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><A HREF="https://root.com" ADD_DATE="1700000000">At the root</A>
    <DT><H3>dev</H3>
    <DL><p>
        <DT><A HREF="https://go.dev" ADD_DATE="1700000001" LAST_MODIFIED="1700000002">Go</A>
        <DD>a note
        <DT><H3>infra</H3>
        <DL><p>
            <DT><A HREF="https://k8s.io" TAGS="k8s,devops">Kubernetes</A>
        </DL><p>
    </DL><p>
    <DT><A HREF="javascript:void(0)">Bookmarklet</A>
    <DT><A HREF="https://acento.com">Página com Acentuação &amp; cia</A>
</DL><p>`;

test('reads the browser folder tree', () => {
  const { format, items } = p.parseImport(CHROME);
  assert.equal(format, 'html');
  const byTitle = Object.fromEntries(items.map((b) => [b.title, b]));

  assert.equal(items.length, 4, 'a bookmarklet does not count as a bookmark');
  assert.equal(byTitle['At the root'].folder, '');
  assert.equal(byTitle.Go.folder, 'dev');
  assert.equal(byTitle.Kubernetes.folder, 'dev/infra', 'a nested folder becomes a path');
});

test('reads dates, tags, descriptions and HTML entities', () => {
  const { items } = p.parseImport(CHROME);
  const byTitle = Object.fromEntries(items.map((b) => [b.title, b]));

  assert.equal(byTitle.Go.created_at, 1700000001000, 'ADD_DATE is in seconds');
  assert.equal(byTitle.Go.updated_at, 1700000002000);
  assert.equal(byTitle.Go.description, 'a note', '<DD> becomes the description');
  assert.equal(byTitle.Kubernetes.tags, 'k8s,devops');
  assert.equal(byTitle['Página com Acentuação & cia'].url, 'https://acento.com');
});

test('detects the format on its own', () => {
  assert.equal(p.detectFormat(CHROME), 'html');
  assert.equal(p.detectFormat('version: 1\nbookmarks: []\n'), 'yaml');
  assert.equal(p.detectFormat('{"bookmarks": []}'), 'json');
  assert.equal(p.detectFormat('[{"url": "x"}]'), 'json');
});

test('an unreadable file errors instead of importing nothing', () => {
  assert.throws(() => p.parseImport('a: 1\nb: 2\n'), /bookmarks/,
    'valid YAML without the list must not slip through');
  assert.throws(() => p.parseImport('{"nothing": 1}', 'json'), /bookmarks/);
});

test('normalizes what comes from outside', () => {
  const { items } = p.parseImport(yaml.stringify({
    bookmarks: [{ title: '  Spaces  ', url: ' https://x.com ', tags: ['#Go', 'GO', 'cli'],
      category: '@Work', folder: '/dev/infra/' }],
  }));
  const b = items[0];
  assert.equal(b.title, 'Spaces');
  assert.equal(b.url, 'https://x.com');
  assert.equal(b.tags, 'go,cli', 'a repeated tag enters once, lowercase and without #');
  assert.equal(b.category, 'work');
  assert.equal(b.folder, 'dev/infra');
});

/* ---------------- o plan de import ---------------- */

const fresh = (extra = {}) => p.normalizeIncoming({ title: 'New', url: 'https://new.com', ...extra });
const sameAsVault = () => p.normalizeIncoming({ ...VAULT[0] });
const edited = (extra = {}) => p.normalizeIncoming({ ...VAULT[0], title: 'Kubernetes EDITADO', ...extra });

test('a new entry comes in under any mode', () => {
  for (const mode of p.MODES) {
    const plan = p.planImport(VAULT, [fresh()], mode);
    assert.equal(plan.summary.create, 1, `mode ${mode}`);
  }
});

test('an identical entry touches nothing', () => {
  for (const mode of p.MODES) {
    const plan = p.planImport(VAULT, [sameAsVault()], mode);
    assert.equal(plan.summary.same, 1, `mode ${mode}`);
    assert.equal(plan.summary.update, 0, `mode ${mode} must not rewrite what did not change`);
  }
});

test('the add mode preserves what was already there', () => {
  const plan = p.planImport(VAULT, [edited()], 'add');
  assert.equal(plan.summary.update, 0);
  assert.equal(plan.summary.skip, 1);
  assert.match(plan.skip[0].reason, /already exists/);
});

test('the update mode overwrites with the file', () => {
  const plan = p.planImport(VAULT, [edited()], 'update');
  assert.equal(plan.summary.update, 1);
  assert.equal(plan.update[0].incoming.title, 'Kubernetes EDITADO');
  assert.equal(plan.update[0].incoming.id, 'v1', 'keeps the vault id');
  assert.equal(plan.update[0].incoming.created_at, 100, 'the vault created_at is preserved');
});

test('the newest mode compares updated_at', () => {
  const newer = p.planImport(VAULT, [edited({ updated_at: 999 })], 'newest');
  assert.equal(newer.summary.update, 1, 'the newer file wins');

  const older = p.planImport(VAULT, [edited({ updated_at: 1 })], 'newest');
  assert.equal(older.summary.update, 0, 'the older file loses');
  assert.match(older.skip[0].reason, /newer/);
});

test('the replace mode removes what is not in the file', () => {
  const plan = p.planImport(VAULT, [sameAsVault()], 'replace');
  assert.equal(plan.summary.remove, 1);
  assert.equal(plan.remove[0].current.id, 'v2', 'only what is missing from the file goes');
});

test('replace with an empty file empties the vault, and the plan says so first', () => {
  const plan = p.planImport(VAULT, [], 'replace');
  assert.equal(plan.summary.remove, 2);
  assert.equal(plan.summary.create, 0);
});

test('matching by URL, even with no id and a different title', () => {
  const fromWeb = p.normalizeIncoming({ title: 'Outro nome', url: 'https://go.dev/blog/' });
  const plan = p.planImport(VAULT, [fromWeb], 'update');
  assert.equal(plan.summary.create, 0, 'a trailing slash must not create a duplicate');
  assert.equal(plan.summary.update, 1);
  assert.equal(plan.update[0].current.id, 'v2');
});

test('the id wins over the URL when both exist', () => {
  const movedUrl = p.normalizeIncoming({ id: 'v1', title: 'Kubernetes Docs', url: 'https://novo-endereco.io',
    folder: 'dev/infra', category: 'studies', tags: 'k8s,devops' });
  const plan = p.planImport(VAULT, [movedUrl], 'update');
  assert.equal(plan.summary.create, 0, 'changing the url of a known id does not create another');
  assert.equal(plan.update[0].current.id, 'v1');
});

test('reimporting our own export changes nothing', () => {
  const { items } = p.parseImport(p.toYaml(VAULT));
  for (const mode of p.MODES) {
    const plan = p.planImport(VAULT, items, mode);
    assert.equal(plan.summary.same, 2, `mode ${mode}`);
    assert.equal(plan.summary.create, 0, `mode ${mode}`);
    assert.equal(plan.summary.update, 0, `mode ${mode}`);
    assert.equal(plan.summary.remove, 0, `mode ${mode}`);
  }
});

test('reimporting the html export does not duplicate either', () => {
  const { items } = p.parseImport(p.toNetscapeHtml(VAULT));
  const plan = p.planImport(VAULT, items, 'add');
  assert.equal(plan.summary.create, 0, 'the html loses tags/category, but the URL still matches');
});

test('a duplicate inside the vault does not steal the match', () => {
  const withDup = [...VAULT, { id: 'v3', title: 'Copy', url: 'https://go.dev/blog', tags: '', folder: '', category: '', description: '', updated_at: 1 }];
  const plan = p.planImport(withDup, [p.normalizeIncoming({ title: 'X', url: 'https://go.dev/blog' })], 'update');
  assert.equal(plan.update[0].current.id, 'v2', 'matches the first one, not the copy');
});

test('an invalid mode is refused', () => {
  assert.throws(() => p.planImport(VAULT, [], 'wipe-everything'), /invalid mode/);
});

test('the summary matches the lists', () => {
  const plan = p.planImport(VAULT, [fresh(), edited(), sameAsVault()], 'update');
  assert.equal(plan.summary.create, plan.create.length);
  assert.equal(plan.summary.update, plan.update.length);
  assert.equal(plan.summary.same, plan.same.length);
  assert.equal(plan.summary.read, 3);
});

test('a file using the old field name (notes) still imports', () => {
  const yaml = ['bookmarks:', '  - title: Old', '    url: https://old.com', '    notes: came from the old format'].join('\n');
  const { items } = p.parseImport(yaml, 'yaml');
  assert.equal(items[0].description, 'came from the old format');
});
