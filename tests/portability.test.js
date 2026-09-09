'use strict';

// Import/export tests: formats, URL matching and, most importantly, the import
// plan, which decides what to do when the bookmark already exists.

const test = require('node:test');
const assert = require('node:assert');

const p = require('../api/portability');
const yaml = require('../api/yaml');

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

test('the yaml export groups by folder, and the key is the path', () => {
  const doc = yaml.parse(p.toYaml(VAULT, { user: 'apolzek' }));
  assert.equal(doc.version, 2);
  assert.equal(doc.count, 2);
  assert.deepEqual(Object.keys(doc.folders), ['dev', 'dev/infra'], 'folders sorted by path');
  assert.deepEqual(doc.folders['dev/infra'].map((b) => b.title), ['Kubernetes Docs']);
  assert.deepEqual(doc.folders['dev/infra'][0].tags, ['k8s', 'devops'], 'tags become a list in the file');
  assert.equal('folder' in doc.folders['dev/infra'][0], false, 'the folder is the key, not a field');
});

test('the yaml export comes back through import with no field lost', () => {
  const { items } = p.parseImport(p.toYaml(VAULT));
  assert.equal(items.length, 2);
  const k8s = items.find((b) => b.id === 'v1');
  assert.equal(k8s.folder, 'dev/infra', 'the key becomes the folder again');
  assert.equal(k8s.category, 'studies');
  assert.equal(k8s.tags, 'k8s,devops', 'the list in the file becomes csv again');
  assert.equal(k8s.created_at, 100);
});

test('two exports of the same vault are the same file', () => {
  // Including two entries with the same title: without a total order they land
  // in whatever order the database returned and the file changes for nothing.
  const twins = [
    ...VAULT,
    { id: 'z1', title: 'Mesmo Titulo', url: 'https://b.example', folder: 'dev',
      category: '', tags: '', description: '', created_at: 1, updated_at: 1 },
    { id: 'z2', title: 'Mesmo Titulo', url: 'https://a.example', folder: 'dev',
      category: '', tags: '', description: '', created_at: 1, updated_at: 1 },
  ];
  const strip = (text) => text.replace(/^exported_at:.*$/m, '');
  assert.equal(strip(p.toYaml(twins)), strip(p.toYaml([...twins].reverse())),
               'order in the database must not change the file');
  const doc = yaml.parse(p.toYaml(twins));
  assert.deepEqual(doc.folders.dev.map((b) => b.url),
                   ['https://a.example', 'https://b.example', 'https://go.dev/blog'],
                   'sorted by title, and ties break by url');
});

test('bookmarks with no folder go under unfiled', () => {
  const doc = yaml.parse(p.toYaml([...VAULT, {
    id: 'v3', title: 'Solto', url: 'https://solto.example', folder: '',
    category: '', tags: '', description: '', created_at: 1, updated_at: 1,
  }]));
  assert.deepEqual(doc.unfiled.map((b) => b.title), ['Solto']);
  const { items } = p.parseImport(yaml.stringify(doc));
  assert.equal(items.find((b) => b.id === 'v3').folder, '');
});

test('usage survives the round trip', () => {
  const used = [{ ...VAULT[0], opens: 12, last_open_at: 1787000000000 }];
  const doc = yaml.parse(p.toYaml(used));
  assert.equal(doc.folders['dev/infra'][0].opens, 12);
  const { items } = p.parseImport(p.toYaml(used));
  assert.equal(items[0].opens, 12);
  assert.equal(items[0].last_open_at, 1787000000000);
});

test('a bookmark with no opens carries no counter in the file', () => {
  const doc = yaml.parse(p.toYaml(VAULT));
  assert.equal('opens' in doc.folders['dev/infra'][0], false);
});

/* ---------------- reading files edited by hand ---------------- */

test('a flat bookmarks list, from older exports, still imports', () => {
  const legacy = [
    'version: 1',
    'bookmarks:',
    '- id: old1',
    '  title: Antigo',
    '  url: https://antigo.example',
    '  folder: dev/infra',
    '  tags:',
    '  - k8s',
  ].join('\n');
  const { items, format } = p.parseImport(legacy);
  assert.equal(format, 'yaml');
  assert.equal(items.length, 1);
  assert.equal(items[0].folder, 'dev/infra');
  assert.equal(items[0].tags, 'k8s');
});

test('a folder: line on an entry wins over the key it sits under', () => {
  const edited = [
    'folders:',
    '  dev/infra:',
    '  - title: Movido a mao',
    '    url: https://movido.example',
    '    folder: technology/software/dev',
  ].join('\n');
  const { items } = p.parseImport(edited);
  assert.equal(items[0].folder, 'technology/software/dev');
});

test('a key that does not exist yet simply becomes a folder', () => {
  const { items } = p.parseImport('folders:\n  brand/new/deep/path:\n  - title: New\n    url: https://new.example\n');
  assert.equal(items[0].folder, 'brand/new/deep/path');
});

test('the root can be written as / or as unfiled', () => {
  const { items } = p.parseImport('folders:\n  /:\n  - title: Raiz\n    url: https://raiz.example\n');
  assert.equal(items[0].folder, '');
});

test('a yaml with none of the expected keys is refused', () => {
  assert.throws(() => p.parseImport('titulo: nada a ver\noutro: campo\n'), /folders/);
});

test('an empty vault is a valid file', () => {
  const { items } = p.parseImport(p.toYaml([]));
  assert.deepEqual(items, []);
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

/* ---------------- a browser file may add, never take away ---------------- */

const CURATED = [{
  id: 'keep-me',
  title: 'Titulo que eu escolhi',
  url: 'https://k8s.io',
  folder: 'minha/pasta',
  category: 'infra',
  tags: 'meu,tag',
  description: 'minha nota',
  updated_at: 1000,
}];

const BROWSER_SAYS = [{
  title: 'Kubernetes',
  url: 'https://k8s.io',
  folder: 'Bookmarks bar',
  category: '',
  tags: '',
  description: '',
  updated_at: 9000,
}];

test('the default mode adds and never touches what is already there', () => {
  const plan = p.planImport(CURATED, BROWSER_SAYS, 'add', { partialFields: p.BROWSER_PARTIAL_FIELDS });
  assert.equal(plan.summary.create, 0);
  assert.equal(plan.summary.update, 0);
  assert.equal(plan.summary.remove, 0, 'nothing is ever removed outside replace');
  assert.equal(plan.summary.skip, 1);
});

test('overwriting from a browser file cannot blank a category, a tag or a note', () => {
  const plan = p.planImport(CURATED, BROWSER_SAYS, 'update', { partialFields: p.BROWSER_PARTIAL_FIELDS });
  assert.equal(plan.summary.update, 1);
  const after = plan.update[0].incoming;
  assert.equal(after.category, 'infra', 'the file has no categories, so it keeps its hands off');
  assert.equal(after.tags, 'meu,tag');
  assert.equal(after.description, 'minha nota');
  assert.equal(after.title, 'Kubernetes', 'what the file does carry still wins');
  assert.equal(after.folder, 'Bookmarks bar');
});

test('what the browser file does carry overwrites', () => {
  const withTags = [{ ...BROWSER_SAYS[0], tags: 'k8s,devops' }];
  const plan = p.planImport(CURATED, withTags, 'update', { partialFields: p.BROWSER_PARTIAL_FIELDS });
  assert.equal(plan.update[0].incoming.tags, 'k8s,devops');
  assert.equal(plan.update[0].incoming.category, 'infra', 'still nothing to say about this one');
});

test('a file that only went quiet counts as identical, not as an update', () => {
  const same = [{ ...CURATED[0], category: '', tags: '', description: '', id: '' }];
  const plan = p.planImport(CURATED, same, 'update', { partialFields: p.BROWSER_PARTIAL_FIELDS });
  assert.equal(plan.summary.same, 1, 'nothing would change, so nothing is written');
  assert.equal(plan.summary.update, 0);
});

test('a vault file has no such protection: it speaks for every field', () => {
  const plan = p.planImport(CURATED, BROWSER_SAYS, 'update');
  assert.equal(plan.update[0].incoming.category, '', 'clearing a category here is a real instruction');
});

/* ---------------- the browser's own profile file ---------------- */

// Shaped like what Chrome, Chromium, Edge and Brave keep in the profile
// directory. Synthetic on purpose: a real one is somebody's browsing history.
// date_added is WebKit epoch, microseconds since 1601-01-01.
const CHROME_PROFILE = JSON.stringify({
  checksum: 'ignored',
  version: 1,
  roots: {
    bookmark_bar: {
      type: 'folder',
      name: 'Bookmarks bar',
      children: [
        { type: 'url', name: 'Direto na barra', url: 'https://na-barra.com', date_added: '13428098755418102' },
        {
          type: 'folder',
          name: 'Trabalho',
          children: [
            { type: 'url', name: 'Kubernetes', url: 'https://k8s.io', date_added: '13428098755418102' },
            {
              type: 'folder',
              name: 'Cloud',
              children: [{ type: 'url', name: 'AWS', url: 'https://aws.amazon.com' }],
            },
          ],
        },
      ],
    },
    other: {
      type: 'folder',
      name: 'Other bookmarks',
      children: [
        { type: 'url', name: 'Solto', url: 'https://solto.com' },
        { type: 'folder', name: 'Leituras', children: [{ type: 'url', name: 'HN', url: 'https://news.ycombinator.com' }] },
        { type: 'url', name: 'Bookmarklet', url: 'javascript:void(0)' },
      ],
    },
    synced: { type: 'folder', name: 'Mobile bookmarks', children: [] },
  },
});

test('the profile file is told apart from the vault\'s own JSON', () => {
  assert.equal(p.detectFormat(CHROME_PROFILE), 'chrome');
  assert.equal(p.detectFormat('{"bookmarks": []}'), 'json');
});

test('the browser\'s own roots are not folders, so what is inside them comes to the top', () => {
  const { items } = p.readImport(CHROME_PROFILE, { source: 'browser' });
  const folder = (url) => items.find((b) => b.url.includes(url)).folder;
  // "Bookmarks bar" and "Other bookmarks" are where the browser puts its
  // window, not folders anyone filed into: a bookmark sitting in the bar is
  // loose, and Trabalho is a top-level folder, which is how its owner sees it.
  assert.equal(folder('na-barra'), '', 'straight on the bar means no folder');
  assert.equal(folder('k8s.io'), 'Trabalho', 'a folder on the bar is a folder at the root');
  assert.equal(folder('aws.amazon'), 'Trabalho/Cloud', 'nesting below it survives');
  assert.equal(folder('solto.com'), '');
  assert.equal(folder('ycombinator'), 'Leituras');
});

test('the profile file drops what is not a bookmark', () => {
  const { items } = p.readImport(CHROME_PROFILE, { source: 'browser' });
  assert.equal(items.length, 5, 'the bookmarklet and the empty mobile root are not bookmarks');
  assert.ok(!items.some((b) => /^javascript:/i.test(b.url)));
});

test('WebKit timestamps become Unix ones', () => {
  const { items } = p.readImport(CHROME_PROFILE, { source: 'browser' });
  const b = items.find((x) => x.url.includes('na-barra'));
  assert.equal(new Date(b.created_at).toISOString().slice(0, 10), '2026-07-09');
  const noDate = items.find((x) => x.url.includes('aws.amazon'));
  assert.equal(noDate.created_at, null, 'a missing date stays missing, not 1601');
});

test('the profile file brings no category either', () => {
  const { items, stats } = p.readImport(CHROME_PROFILE, { source: 'browser' });
  assert.ok(items.every((b) => b.category === ''));
  // Trabalho, Trabalho/Cloud and Leituras; the two on the bar and in other are loose.
  assert.deepEqual(
    { count: stats.count, folders: stats.folders, unfiled: stats.unfiled },
    { count: 5, folders: 3, unfiled: 2 },
  );
});

test('a prefix is how an import is kept together, since the roots no longer do it', () => {
  const { items } = p.readImport(CHROME_PROFILE, { source: 'browser', folderPrefix: 'Imported-2026-08-28' });
  assert.equal(items.find((b) => b.url.includes('k8s.io')).folder, 'Imported-2026-08-28/Trabalho');
  assert.equal(items.find((b) => b.url.includes('solto.com')).folder, 'Imported-2026-08-28', 'the loose ones land on the prefix itself');
});

test('the toolbar folder is dropped from an exported HTML too, by its marker', () => {
  const exported = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
    <DT><H3 PERSONAL_TOOLBAR_FOLDER="true">Barra de favoritos</H3>
    <DL><p>
        <DT><A HREF="https://na-barra.com">Direto na barra</A>
        <DT><H3>Trabalho</H3>
        <DL><p>
            <DT><A HREF="https://k8s.io">Kubernetes</A>
        </DL><p>
    </DL><p>
</DL><p>`;
  const { items } = p.readImport(exported, { source: 'browser' });
  assert.equal(items.find((b) => b.url.includes('na-barra')).folder, '');
  assert.equal(items.find((b) => b.url.includes('k8s.io')).folder, 'Trabalho', 'the same shape the profile file gives');
});

test('a folder that is not the toolbar keeps its level', () => {
  const exported = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
    <DT><H3>Guardados</H3>
    <DL><p>
        <DT><A HREF="https://um.com">Um</A>
    </DL><p>
</DL><p>`;
  const { items } = p.readImport(exported, { source: 'browser' });
  assert.equal(items[0].folder, 'Guardados');
});

test('the vault flow refuses the profile file and points at the other one', () => {
  assert.throws(
    () => p.readImport(CHROME_PROFILE, { source: 'native' }),
    (err) => err instanceof p.WrongSourceError && /From a browser/.test(err.message),
  );
});

test('a profile file without roots is a broken file, not a misfiled one', () => {
  assert.throws(() => p.parseChromeJson('{"version":1}'), /roots/);
});

/* ---------------- import sources ---------------- */

test('the browser source empties the category, whatever the entry carried', () => {
  const { items, source, format } = p.readImport(CHROME, { source: 'browser' });
  assert.equal(source, 'browser');
  assert.equal(format, 'html');
  assert.ok(items.every((b) => b.category === ''), 'the format has no categories');
});

test('a prefix sits above the browser tree, and is normalised like a folder', () => {
  const { items, prefix } = p.readImport(CHROME, { source: 'browser', folderPrefix: '  //chrome/ backup// ' });
  assert.equal(prefix, 'chrome/backup');
  const root = items.find((b) => b.url.includes('root.com'));
  assert.equal(root.folder, 'chrome/backup', 'an entry with no folder lands on the prefix itself');
  const k8s = items.find((b) => b.url.includes('k8s.io'));
  assert.equal(k8s.folder, 'chrome/backup/dev/infra');
});

test('without a prefix the browser tree comes in as it is', () => {
  const { items, prefix } = p.readImport(CHROME, { source: 'browser' });
  assert.equal(prefix, '');
  assert.equal(items.find((b) => b.url.includes('k8s.io')).folder, 'dev/infra');
  assert.equal(items.find((b) => b.url.includes('root.com')).folder, '');
});

test('each source refuses the other one\'s file, and says where it goes', () => {
  assert.throws(
    () => p.readImport(CHROME, { source: 'native' }),
    (err) => err instanceof p.WrongSourceError && /From a browser/.test(err.message),
  );
  assert.throws(
    () => p.readImport('bookmarks: []', { source: 'browser' }),
    (err) => err instanceof p.WrongSourceError && /From this app/.test(err.message),
  );
});

test('an unknown source is refused outright', () => {
  assert.throws(() => p.readImport(CHROME, { source: 'firefox' }), /invalid source/);
});

test('the stats count what the file carries, not what the vault has', () => {
  const { stats } = p.readImport(CHROME, { source: 'browser' });
  assert.equal(stats.count, 4, 'the bookmarklet is not a bookmark');
  assert.equal(stats.folders, 2, 'dev and dev/infra');
  assert.equal(stats.unfiled, 2, 'the two at the root');
  assert.equal(stats.tagged, 1);
  assert.equal(stats.described, 1);
});

test('the native source still reads a vault export unchanged', () => {
  const { source, format, items, prefix } = p.readImport(p.toYaml(VAULT), { source: 'native' });
  assert.equal(source, 'native');
  assert.equal(format, 'yaml');
  assert.equal(prefix, '', 'a prefix belongs to the browser flow only');
  assert.equal(items.length, VAULT.length);
  assert.ok(items.some((b) => b.category), 'categories survive here');
});

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

/* ---------------- folders that hold nothing ---------------- */

// The file is the vault's backup, so a folder created and left empty has to
// survive it. It is written as a key with an empty list inside the `folders:`
// map that has been there since version 2, which is the part that matters for
// compatibility: an importer that knows nothing about this walks past the key
// instead of failing on it.

test('an empty folder is written as a key with no entries', () => {
  const doc = yaml.parse(p.toYaml(VAULT, { folders: ['dev', 'dev/infra', 'vazia/funda'] }));
  assert.equal(doc.version, 2, 'the version does not move: the shape did not change');
  assert.deepEqual(doc.folders['vazia/funda'], []);
  assert.deepEqual(
    Object.keys(doc.folders).sort(),
    ['dev', 'dev/infra', 'vazia/funda'],
    'a folder the bookmarks already write is not repeated as an empty key',
  );
});

test('only the tips are written, since the way down is recreated on import', () => {
  const doc = yaml.parse(p.toYaml([], { folders: ['a', 'a/b', 'a/b/c'] }));
  assert.deepEqual(Object.keys(doc.folders), ['a/b/c']);
  // And reading it back names the whole branch, so nothing was lost by not
  // writing the parents down.
  const { folders } = p.readImport(p.toYaml([], { folders: ['a', 'a/b', 'a/b/c'] }));
  assert.deepEqual(folders, ['a/b/c']);
});

test('an empty folder survives the round trip', () => {
  const file = p.toYaml(VAULT, { folders: ['vazia'] });
  const { items, folders } = p.readImport(file);
  assert.equal(items.length, 2, 'the bookmarks came through untouched');
  assert.ok(folders.includes('vazia'));
  assert.ok(folders.includes('dev/infra'), 'the folders holding bookmarks are named too');
});

test('a file that is nothing but empty folders is still a valid file', () => {
  const file = p.toYaml([], { folders: ['so-pastas'] });
  const read = p.readImport(file);
  assert.deepEqual(read.items, []);
  assert.deepEqual(read.folders, ['so-pastas']);
});

test('the file counts an empty folder among its folders', () => {
  const { stats } = p.readImport(p.toYaml(VAULT, { folders: ['vazia'] }));
  assert.equal(stats.count, 2);
  assert.equal(stats.folders, 3, 'dev, dev/infra and the empty one');
});

test('the formats that cannot express an empty folder say nothing, not zero', () => {
  const html = p.readImport(p.toNetscapeHtml(VAULT), { source: 'browser' });
  assert.deepEqual(html.folders, [], 'the HTML has no way to write one down');
  const json = p.parseImport(p.toJson(VAULT));
  assert.deepEqual(json.folders, []);
});

/* ---------------- compatibility with older files ---------------- */

test('a file from before empty folders reads the same as it always did', () => {
  const before = ['version: 2', 'folders:', '  dev:', '  - id: v2', '    title: The Go Blog',
                  '    url: https://go.dev/blog'].join('\n');
  const { items, folders } = p.readImport(before);
  assert.equal(items.length, 1);
  assert.equal(items[0].folder, 'dev');
  assert.deepEqual(folders, ['dev'], 'the key is a folder whether or not it holds anything');
});

test('a restored bookmark does not land on another one that shares its URL', () => {
  // The same URL in two folders is two records on purpose. With one of them
  // deleted, its id is buried and not in the live list, so without being told
  // about the tombstone the import would match the entry by URL and take over
  // the survivor instead of bringing the deleted one back.
  const live = [{ id: 'sobrevivente', title: 'Go copy', url: 'https://go.dev', folder: 'outra',
                  category: '', tags: '', description: '', created_at: 1, updated_at: 1 }];
  const incoming = [{ id: 'enterrado', title: 'Go', url: 'https://go.dev', folder: 'dev' }];

  const blind = p.planImport(live, incoming, 'update');
  assert.equal(blind.update.length, 1, 'without the tombstone it lands on the survivor');

  const told = p.planImport(live, incoming, 'update', { buried: ['enterrado'] });
  assert.equal(told.create.length, 1, 'told about it, the deleted one comes back as itself');
  assert.equal(told.update.length, 0, 'and the survivor is left alone');
});

test('an entry with no id still matches by URL, the way it always has', () => {
  const incoming = [{ title: 'Kubernetes Docs, edited', url: 'https://kubernetes.io/docs' }];
  const plan = p.planImport(VAULT, incoming, 'update', { buried: ['v1'] });
  assert.equal(plan.update.length, 1);
  assert.equal(plan.update[0].current.id, 'v1');
});

test('a file using the old field name (notes) still imports', () => {
  const yaml = ['bookmarks:', '  - title: Old', '    url: https://old.com', '    notes: came from the old format'].join('\n');
  const { items } = p.parseImport(yaml, 'yaml');
  assert.equal(items[0].description, 'came from the old format');
});
