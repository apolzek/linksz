// Drives the extension over the DevTools protocol. Started by e2e.sh, which
// passes the backend's address, the debugging port and the vault's key.

const [BASE, PORT] = process.argv.slice(2);
const KEY = process.env.DEV_KEY;

let failures = 0;
const ok = (m) => console.log(`  \x1b[32m✔\x1b[0m ${m}`);
const bad = (m) => { failures += 1; console.log(`  \x1b[31m✖\x1b[0m ${m}`); };
const group = (m) => console.log(`\x1b[1;34m›\x1b[0m ${m}`);
const is = (actual, expected, what) => (JSON.stringify(actual) === JSON.stringify(expected)
  ? ok(what) : bad(`${what}\n      expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DEBUG = `http://127.0.0.1:${PORT}`;

function connect(wsUrl) {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const waiting = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
    });
    ws.addEventListener('open', () => resolve({
      send: (method, params = {}) => new Promise((res) => { waiting.set(++id, res); ws.send(JSON.stringify({ id, method, params })); }),
      close: () => ws.close(),
    }));
  });
}

const targets = async () => (await fetch(`${DEBUG}/json/list`)).json();

// A tab, by the start of its address; waits for it to show up.
async function tab(prefix, ms = 8000) {
  for (let t = 0; t < ms; t += 200) {
    const found = (await targets()).find((x) => x.type === 'page' && x.url.startsWith(prefix));
    if (found) {
      const s = await connect(found.webSocketDebuggerUrl);
      const ev = async (expression) => {
        // A page that closed itself never answers: time out rather than hang.
        const r = await Promise.race([
          s.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
          sleep(8000).then(() => ({ result: { exceptionDetails: { exception: { description: `timed out: ${expression.slice(0, 60)}` } } } })),
        ]);
        if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'evaluate failed');
        return r.result?.result?.value;
      };
      return { ev, close: () => s.close(), id: found.id };
    }
    await sleep(200);
  }
  throw new Error(`no tab at ${prefix}`);
}

async function open(url) {
  await fetch(`${DEBUG}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  await sleep(800);
  return tab(url.split('#')[0]);
}

// Polls an expression until it is truthy.
async function until(t, expression, ms = 6000) {
  for (let w = 0; w < ms; w += 150) {
    const v = await t.ev(expression).catch(() => null);
    if (v) return v;
    await sleep(150);
  }
  return null;
}

async function api(method, path, token, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json().catch(() => ({}));
}

/* ---------------- the extension is there ---------------- */

group('loading');
let ID = null;
for (let t = 0; t < 10000 && !ID; t += 250) {
  const sw = (await targets()).find((x) => x.type === 'service_worker' && x.url.endsWith('/src/background.js'));
  if (sw) ID = new URL(sw.url).host;
  else await sleep(250);
}
if (!ID) { bad('the extension did not load'); process.exit(1); }
ok(`the service worker runs (${ID})`);
const EXT = `chrome-extension://${ID}`;

// The app, signed in on this browser.
const appToken = (await api('POST', '/api/auth/key', null, { key: KEY })).token;
const app = await open(`${BASE}/`);
await app.ev(`localStorage.setItem('bookmarks_token', ${JSON.stringify(appToken)}); location.reload(); 1`);
await sleep(1500);
is(await until(app, "!document.querySelector('#shell').hidden"), true, 'the app is signed in in the same browser');

// A page to save, and its tab id as the extension sees it.
const PAGE = `${BASE}/api/health`;
await open(PAGE);

/* ---------------- connecting through the app ---------------- */

group('connecting through the app');
let popup = await open(`${EXT}/popup.html`);
is(await until(popup, "!document.querySelector('#connect').hidden"), true, 'not connected, the popup offers to connect');
const PAGE_TAB = await popup.ev(`chrome.tabs.query({}).then((ts) => ts.find((t) => t.url === ${JSON.stringify(PAGE)}).id)`);
await popup.ev(`document.querySelector('#server').value = ${JSON.stringify(BASE)}; document.querySelector('#btn-connect').click(); 1`);

const connectTab = await tab(`${BASE}/`, 8000).then(async (first) => {
  // The app tab opened above is also at BASE; the new one asks the question.
  for (let t = 0; t < 8000; t += 200) {
    for (const x of (await targets()).filter((y) => y.type === 'page' && y.url.startsWith(BASE) && y.id !== app.id && !y.url.includes('/api/'))) {
      first.close();
      return tab(x.url);
    }
    await sleep(200);
  }
  return first;
});
is(await until(connectTab, "document.querySelector('#dlg-confirm').open && document.querySelector('#confirm-title').textContent"),
  'Connect the browser extension?', 'the app asks before connecting it');
is(await connectTab.ev('location.hash'), '#/settings', 'and the nonce is out of the address bar');
await connectTab.ev("document.querySelector('#confirm-yes').click(); 1");
is(await until(connectTab, "[...document.querySelectorAll('.toast')].map((t) => t.innerText).find((t) => t.includes('connected'))"),
  'The extension is connected', 'yes connects it');

// The popup closed itself on Connect; an extension page that stays open reads
// the storage from here on.
popup.close();
const ext = await open(`${EXT}/options.html`);
const stored = await ext.ev("chrome.storage.local.get(null)");
is([stored.server, /^[0-9a-f]{64}$/.test(stored.token), stored.vault, 'key' in stored], [BASE, true, 'dev', false],
  'the extension keeps the server and a token, never the key');
is(await ext.ev("chrome.storage.session.get('pending').then((r) => r.pending ?? null)"), null, 'the nonce is spent');
is(await until(ext, "document.querySelector('#o-vault').textContent"), 'dev', 'the options page shows the vault');
let sessions = (await api('GET', '/api/auth/sessions', appToken)).sessions;
is(sessions.map((s) => s.name).filter((n) => n === 'Browser extension').length, 1, 'with a session of its own, named for it');
is(await until(connectTab, "[...document.querySelectorAll('#devices strong')].map((s) => s.textContent).includes('Browser extension')"),
  true, 'which Settings lists under Devices');

group('a connection nobody started is refused');
const forged = await app.ev(`new Promise((r) => chrome.runtime.sendMessage(${JSON.stringify(ID)},
  { type: 'bookmarks-connect', nonce: 'x'.repeat(32), token: 'a'.repeat(64) }, r))`);
is(forged, { ok: false, error: 'no connection is waiting' }, 'a page cannot hand the extension a token of its choosing');
is((await ext.ev("chrome.storage.local.get('token')")).token, stored.token, 'and the token it has stays');

/* ---------------- saving ---------------- */

group('saving the page on screen');
await api('POST', '/api/bookmarks', appToken, { url: 'https://seed.example', title: 'Seed', folder: 'seeded/one' });
popup = await open(`${EXT}/popup.html?tab=${PAGE_TAB}`);
is(await until(popup, "!document.querySelector('#connected').hidden && document.querySelector('#url').textContent"), PAGE,
  'the popup shows the page');
is(await until(popup, "[...document.querySelectorAll('#folders option')].map((o) => o.value).join() || null"), 'seeded,seeded/one',
  'and the whole folder tree to pick from');
await popup.ev(`document.querySelector('#title').value = 'Health, from the extension';
  document.querySelector('#folder').value = ' ext / saved ';
  document.querySelector('#save-form').requestSubmit(); 1`);
is(await until(popup, "document.querySelector('#saved-note').textContent.startsWith('Saved') && document.querySelector('#saved-note').textContent"),
  'Saved to ext/saved.', 'Save files it in the folder typed');
let found = (await api('GET', `/api/bookmarks?url=${encodeURIComponent(PAGE)}`, appToken)).items;
is(found.map((b) => [b.title, b.folder]), [['Health, from the extension', 'ext/saved']], 'the server has it');
const log = (await api('GET', '/api/audit/changes', appToken)).items;
is(log.find((r) => r.bookmark_id === found[0].id)?.via, 'extension', 'and the audit log says where it came from');
is(await until(popup, `chrome.action.getBadgeText({ tabId: ${PAGE_TAB} }).then((t) => t === '✓' && t)`), '✓',
  'the toolbar button marks the page as saved');

await popup.ev("document.querySelector('#btn-undo').click(); 1");
is(await until(popup, "document.querySelector('#saved-note').textContent === 'Not saved.'"), true, 'Undo takes it back');
is((await api('GET', `/api/bookmarks?url=${encodeURIComponent(PAGE)}`, appToken)).items, [], 'on the server too');

await popup.ev("document.querySelector('#save-form').requestSubmit(); 1");
await until(popup, "document.querySelector('#saved-note').textContent.startsWith('Saved')");
popup.close();
popup = await open(`${EXT}/popup.html?tab=${PAGE_TAB}`);
is(await until(popup, "document.querySelector('#saved-note').textContent.startsWith('Already') && [document.querySelector('#saved-note').textContent, document.querySelector('#btn-save').textContent]"),
  ['Already saved in ext/saved.', 'Save again'], 'a page saved already says where, and the folder is remembered');
is(await popup.ev("document.querySelector('#folder').value"), 'ext/saved', 'the last folder is the default');

group('searching');
await api('POST', '/api/bookmarks', appToken, { url: 'https://zebra.example', title: 'Unique Zebra page', folder: 'animals' });
await popup.ev("const q = document.querySelector('#q'); q.value = 'zebra'; q.dispatchEvent(new Event('input')); 1");
is(await until(popup, "[...document.querySelectorAll('#results .t')].map((e) => e.textContent).join() || null"),
  'Unique Zebra page', 'typing searches the vault, with the app\'s engine');

/* ---------------- signed out elsewhere ---------------- */

group('signed out from the app');
sessions = (await api('GET', '/api/auth/sessions', appToken)).sessions;
await api('POST', '/api/auth/sessions/revoke', appToken, { id: sessions.find((s) => s.name === 'Browser extension').id });
popup.close();
popup = await open(`${EXT}/popup.html?tab=${PAGE_TAB}`);
is(await until(popup, "!document.querySelector('#connect').hidden && document.querySelector('#connect-why').textContent"),
  'This extension was signed out. Connect it again.', 'the popup notices and asks to connect again');
is((await popup.ev("chrome.storage.local.get('token')")).token, undefined, 'the dead token is dropped');
is((await popup.ev("chrome.storage.local.get('server')")).server, BASE, 'the server is remembered');

group('the access key instead');
await popup.ev(`document.querySelector('#key').value = 'nope'; document.querySelector('#btn-key').click(); 1`);
is(await until(popup, "document.querySelector('#connect-error').textContent"), 'That key does not open any vault.', 'a wrong key says so');
await popup.ev(`document.querySelector('#key').value = ${JSON.stringify(KEY)}; document.querySelector('#btn-key').click(); 1`);
is(await until(popup, "!document.querySelector('#connected').hidden"), true, 'the right key connects');
is([await popup.ev("document.querySelector('#key').value"), 'key' in await popup.ev('chrome.storage.local.get(null)')], ['', false],
  'and is not kept, in the field or in storage');

group('disconnecting');
const before = (await api('GET', '/api/auth/sessions', appToken)).sessions.length;
await popup.ev("document.querySelector('#btn-disconnect').click(); 1");
is(await until(popup, "!document.querySelector('#connect').hidden && document.querySelector('#connect-why').textContent"), 'Disconnected.',
  'Disconnect goes back to the connect screen');
is((await api('GET', '/api/auth/sessions', appToken)).sessions.length, before - 1, 'and ends its session on the server');

console.log(failures ? `\x1b[31m${failures} failed\x1b[0m` : '\x1b[32mextension: all green\x1b[0m');
process.exit(failures ? 1 : 0);
