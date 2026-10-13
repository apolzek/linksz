// Drives the real page in a real browser, over the DevTools protocol.
//
// No dependency: node has WebSocket built in and the browser is the one already
// on the machine. What it covers is the half the node suite cannot see, the
// part that only exists once a browser is running the page: the key screen,
// the keyboard, the dialogs, the organizer and the two import flows.
//
// Started by tests/web.sh, which brings up a server on a throwaway vault and
// passes its URL and the vault's key. Two hard-won rules about headless Chrome
// live here:
//   * --headless (old) delivers Input events; --headless=new silently does not
//   * navigating with Page.navigate kills input for the rest of the session, so
//     the browser is launched on the URL and never told to go anywhere else
//     (a hash change is fine; it is not a navigation)
'use strict';

const BASE = process.argv[2];
const PORT = Number(process.argv[3] || 9222);
const KEY = process.env.DEV_KEY;
const FIXTURES = process.env.WEB_FIXTURES;

let failures = 0;
const ok = (m) => console.log(`  \x1b[32m✔\x1b[0m ${m}`);
const bad = (m) => { failures += 1; console.log(`  \x1b[31m✖\x1b[0m ${m}`); };
const group = (m) => console.log(`\x1b[1;34m›\x1b[0m ${m}`);
const is = (actual, expected, what) =>
  (JSON.stringify(actual) === JSON.stringify(expected)
    ? ok(what)
    : bad(`${what}\n      expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rpc(ws) {
  let id = 0;
  const waiting = new Map();
  const listeners = [];
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
    else if (m.method) listeners.forEach((f) => f(m));
  });
  return {
    send: (method, params = {}) => new Promise((res) => { waiting.set(++id, res); ws.send(JSON.stringify({ id, method, params })); }),
    on: (f) => listeners.push(f),
  };
}

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = targets.find((t) => t.type === 'page' && t.url.startsWith(BASE));
if (!page) { console.error('the browser did not open the app'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
const cdp = rpc(ws);
const jsErrors = [];
const nativeDialogs = [];
cdp.on((m) => {
  if (m.method === 'Runtime.exceptionThrown') {
    jsErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  }
  if (m.method === 'Page.javascriptDialogOpening') {
    nativeDialogs.push(m.params.message);
    cdp.send('Page.handleJavaScriptDialog', { accept: false });
  }
});
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
await cdp.send('DOM.enable');

const ev = async (expr) => (await cdp.send('Runtime.evaluate',
  { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
const q = (sel) => JSON.stringify(sel);

// A key the way a keyboard sends it: one keyDown carrying the text, so a
// handler that calls preventDefault stops the character, as it would for real.
async function key(k, code, keyCode, modifiers = 0) {
  const base = { modifiers, key: k, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
  const text = k === 'Enter' ? '\r' : (k.length === 1 && !(modifiers & 6) ? k : undefined);
  await cdp.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, text });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  await sleep(150);
}
const letter = (c, modifiers = 0) => key(c, `Key${c.toUpperCase()}`, c.toUpperCase().charCodeAt(0), modifiers);
const CTRL = 2;
const SHIFT = 8;
const ALT = 1;

async function type(text) {
  await cdp.send('Input.insertText', { text });
  await sleep(200);
}

async function click(sel, modifiers = 0) {
  const at = await ev(`(() => { const el = document.querySelector(${q(sel)}); if (!el) return null;
    el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect();
    return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
  if (!at) { bad(`nothing to click at ${sel}`); return; }
  const [x, y] = at;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, modifiers });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, modifiers });
  await sleep(300);
}

// Native drag and drop cannot be driven over Input in headless Chrome, so the
// events are dispatched by hand, with one DataTransfer carried across the three
// of them the way the browser would.
const drag = (src, dst) => ev(`(async () => {
  const s = document.querySelector(${q(src)}), d = document.querySelector(${q(dst)});
  if (!s || !d) return false;
  const dt = new DataTransfer();
  s.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
  d.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
  d.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  s.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
  await new Promise((r) => setTimeout(r, 500));
  return true;
})()`);

const pickFile = async (path) => {
  const doc = await cdp.send('DOM.getDocument', { depth: -1 });
  const found = await cdp.send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#io-file' });
  await cdp.send('DOM.setFileInputFiles', { files: [path], nodeId: found.result.nodeId });
  await sleep(1200);
};

const server = (path) => ev(`fetch(${q(path)}, { headers: { authorization: 'Bearer ' + localStorage.getItem('bookmarks_token') } }).then((r) => r.json())`);
const text = (sel) => ev(`document.querySelector(${q(sel)})?.textContent ?? null`);
const hidden = (sel) => ev(`(() => { const el = document.querySelector(${q(sel)}); return !el || el.hidden || el.closest('[hidden]') !== null; })()`);
const lastToast = () => ev("[...document.querySelectorAll('.toast')].pop()?.innerText ?? ''");
const go = async (hash) => { await ev(`location.hash = ${q(hash)}`); await sleep(400); };

await sleep(2500);
await cdp.send('Page.bringToFront');

// Before anything else: if this browser does not deliver key events, every
// check below would pass or fail for the wrong reason.
await ev("window.__k = []; document.addEventListener('keydown', (e) => window.__k.push(e.key), true); 1");
await key('Shift', 'ShiftLeft', 16);
if (await ev('window.__k.length') === 0) {
  console.error('this browser is not delivering input events; the rest would be meaningless');
  process.exit(2);
}

/* ---------------- the key screen ---------------- */
group('the key screen');
is(await hidden('#auth'), false, 'a browser with no session sees the key screen');
is(await ev("!!document.querySelector('input[type=password]')"), false, 'there is no password field');

await click('#auth-key');
await type('not a real key');
await key('Enter', 'Enter', 13);
await sleep(500);
is(await hidden('#shell'), true, 'a wrong key opens nothing');
is(await text('#auth-error'), 'that key does not open any vault', 'and says so');

await ev("document.querySelector('#auth-key').value = ''");
await click('#auth-key');
await type(KEY.toLowerCase().replace(/-/g, ' '));
is(await ev("document.querySelector('#auth-key').value"), KEY, 'the key is formatted in groups as it is typed');
await key('Enter', 'Enter', 13);
await sleep(1500);
is(await hidden('#shell'), false, 'the right key opens the vault');
is(await text('#count'), '3 links', 'with what is in it');

/* ---------------- searching ---------------- */
group('searching');
is(await ev("document.activeElement.id"), 'q', 'the search box has the caret');
await type('bookmark 2');
await sleep(200);
is(await text('#count'), '1 of 3 links', 'typing narrows the list');
is(await ev("[...document.querySelectorAll('#list .row-title mark')].map((m) => m.textContent)"), ['Bookmark', '2'],
  'and marks each term it matched');
await key('Escape', 'Escape', 27);
is(await ev("document.querySelector('#q').value"), '', 'Esc clears the search');
is(await text('#count'), '3 links', 'and everything is back');

await ev("document.activeElement.blur()");
await letter('b');
is(await ev("[document.activeElement.id, document.querySelector('#q').value]"), ['q', 'b'],
  'a letter typed anywhere goes into the search');
await key('Escape', 'Escape', 27);

await key('ArrowDown', 'ArrowDown', 40);
await key('ArrowDown', 'ArrowDown', 40);
is(await ev("document.querySelector('.row.cursor')?.dataset.i"), '1', 'the arrows move a cursor through the list');

/* ---------------- the folder list ---------------- */
group('the folder list');
await click('#tree .node[data-folder="pasta"] .node-name');
is(await ev("[document.querySelector('#count').textContent, document.querySelector('#scope span')?.textContent]"),
  ['3 links', 'pasta'], 'a folder narrows the list to itself and below');
await click('#scope button');
is(await hidden('#scope'), true, 'and the chip in the search box undoes it');

/* ---------------- the editor ---------------- */
group('the link form');
await ev("document.activeElement.blur()");
await letter('n');
is(await ev("document.querySelector('#dlg-edit').open"), true, 'n opens a new link');
is(await ev("document.querySelector('#e-url').value"), '', 'and the n itself is not typed into it');
await type('example.org/web-test');
await click('#e-title');
await type('Made in the browser');
await click('#e-folder');
is(await ev("document.querySelector('#dlg-picker').open"), true, 'the folder opens the picker');
await type('web/new');
is(await ev("document.querySelector('#picker-list .cur')?.innerText"), 'Create “web/new”',
  'a folder that does not exist is offered to be created');
await key('Enter', 'Enter', 13);
await sleep(400);
is(await text('#e-folder span'), 'web/new', 'and lands in the form');
await click('#edit-save');
await sleep(700);
let all = (await server('/api/bookmarks')).items;
const made = all.find((b) => b.title === 'Made in the browser');
is(made && [made.url, made.folder], ['https://example.org/web-test', 'web/new'],
  'saving writes it, with a scheme on the bare domain');
is((await server('/api/folders')).folders.some((f) => f.path === 'web/new'), true, 'the new folder is on the server');

await ev("document.activeElement.blur()");
await key('Escape', 'Escape', 27);
await key('ArrowDown', 'ArrowDown', 40);
await key('F2', 'F2', 113);
is(await ev("document.querySelector('#dlg-edit').open"), true, 'F2 edits the row under the cursor');
await key('Escape', 'Escape', 27);
is(await ev("document.querySelector('#dlg-edit').open"), false, 'Esc closes the form');

/* ---------------- deleting ---------------- */
group('deleting');
await click('#q');
await type('made in the browser');
await key('ArrowDown', 'ArrowDown', 40);
await key('Delete', 'Delete', 46, CTRL);
await sleep(600);
is(await text('#count'), '0 of 3 links', 'Ctrl+Del deletes at once, no question for one link');
is(await lastToast(), 'Deleted “Made in the browser”\nUndo', 'and offers to undo');
await click('.toast:last-child button');
await sleep(800);
is(await text('#count'), '1 of 4 links', 'undo brings it back');
all = (await server('/api/bookmarks')).items;
is(all.some((b) => b.id === made.id), true, 'with the same id, on the server too');
await key('Escape', 'Escape', 27);

/* ---------------- selecting ---------------- */
group('selecting rows');
await ev("document.activeElement.blur()");
await key('a', 'KeyA', 65, CTRL);
is(await text('#sel-count'), '4 selected', 'Ctrl+A selects everything listed');
is(await hidden('#selbar'), false, 'and the selection bar says so');
await key('Escape', 'Escape', 27);
is(await hidden('#selbar'), true, 'Esc drops the selection');

await click('#list .row[data-i="0"]', CTRL);
await click('#list .row[data-i="2"]', SHIFT);
is(await text('#sel-count'), '3 selected', 'Ctrl+click and Shift+click build a run');
await click('#sel-move');
await type('moved/here');
await key('Enter', 'Enter', 13);
await sleep(800);
all = (await server('/api/bookmarks')).items;
is(all.filter((b) => b.folder === 'moved/here').length, 3, 'move to… files them all, into a folder made on the way');
is(await hidden('#selbar'), true, 'and the selection is done');
is((await cdp.send('Target.getTargets')).result.targetInfos.filter((t) => t.type === 'page').length, 1,
  'the Enter that picked the folder did not go on to open a link');
await click('.toast:last-child button');
await sleep(800);
all = (await server('/api/bookmarks')).items;
is(all.filter((b) => b.folder === 'moved/here').length, 0, 'undo puts each one back where it was');

/* ---------------- organize ---------------- */
group('organize');
await go('#/organize');
await ev("(async () => { const o = await import('/js/organize.js'); o.openFolder('pasta/1', 'a'); o.openFolder('pasta/2', 'b'); })()");
await sleep(300);
is(await ev("[...document.querySelectorAll('.pane-folder span')].map((s) => s.textContent)"), ['1', '2'],
  'two folders side by side');
is(await ev("document.querySelector('#move-ab').disabled"), true, 'nothing selected, nothing to move');
await click('#pane-a .orow[data-i="0"]');
is(await ev("[document.querySelector('#move-ab').disabled, document.querySelector('#move-ab span').textContent]"),
  [false, '1'], 'a click selects, and the arrow counts it');
await click('#move-ab');
await sleep(700);
all = (await server('/api/bookmarks')).items;
is(all.find((b) => b.title === 'Bookmark 1')?.folder, 'pasta/2', 'the arrow moves it to the other side');
is(await ev("document.querySelectorAll('#pane-b .orow[data-i]').length"), 2, 'and it shows up there');
is(await text('#pane-a .pane-folder span'), '1', 'the emptied side stays on its folder');

await click('#pane-b .orow[data-i="0"]');
await click('#pane-b .orow[data-i="1"]');
await key('ArrowLeft', 'ArrowLeft', 37);
await sleep(700);
all = (await server('/api/bookmarks')).items;
is(all.filter((b) => b.folder === 'pasta/1').length, 2, '← sends the right-hand selection left');

await drag('#pane-a .orow[data-i="0"]', '#tree .node[data-folder="pasta/3"]');
all = (await server('/api/bookmarks')).items;
is(all.filter((b) => b.folder === 'pasta/3').length, 2, 'a link dragged onto the folder list is filed there');

await drag('#tree .node[data-folder="pasta/3"]', '#tree .node[data-folder="web"]');
await sleep(300);
all = (await server('/api/bookmarks')).items;
is(all.filter((b) => b.folder === 'web/3').length, 2, 'a folder dragged onto another moves inside it, links and all');
await click('.toast:last-child button');
await sleep(800);
all = (await server('/api/bookmarks')).items;
is(all.filter((b) => b.folder === 'pasta/3').length, 2, 'and undo moves it back');

/* ---------------- folders ---------------- */
group('folders');
await click('#pane-a [data-act="new"]');
await type('fresh');
await key('Enter', 'Enter', 13);
await sleep(600);
is((await server('/api/folders')).folders.some((f) => f.path === 'pasta/1/fresh'), true,
  'a new folder is made inside the one on screen');
await ev("(async () => (await import('/js/organize.js')).openFolder('pasta/1/fresh', 'a'))()");
await sleep(200);
await click('#pane-a [data-act="rename"]');
await ev("document.querySelector('#prompt-input').select()");
await type('renamed');
await key('Enter', 'Enter', 13);
await sleep(600);
is(await text('#pane-a .pane-folder span'), 'renamed', 'renaming follows the folder in its pane');
is((await server('/api/folders')).folders.some((f) => f.path === 'pasta/1/renamed'), true, 'and on the server');
await click('#pane-a [data-act="delete"]');
is(await ev("document.querySelector('#dlg-confirm').open"), true, 'deleting a folder asks first');
is(nativeDialogs.length, 0, 'in the app, not with a browser dialog');
await key('Enter', 'Enter', 13);
await sleep(300);
is((await server('/api/folders')).folders.some((f) => f.path === 'pasta/1/renamed'), true, 'Enter answers no');
await click('#pane-a [data-act="delete"]');
await click('#confirm-yes');
await sleep(600);
is((await server('/api/folders')).folders.some((f) => f.path === 'pasta/1/renamed'), false, 'and yes deletes');
is(await text('#pane-a .pane-folder span'), '1', 'the pane steps up to the parent');

/* ---------------- sync between tabs ---------------- */
group('sync');
await go('#/');
await ev(`fetch('/api/bookmarks', { method: 'POST', headers: { 'content-type': 'application/json',
  authorization: 'Bearer ' + localStorage.getItem('bookmarks_token') },
  body: JSON.stringify({ url: 'https://elsewhere.example', title: 'From another device' }) })`);
await sleep(5800);
is(await text('#count'), '5 links', 'a change made elsewhere shows up without a reload');

/* ---------------- import ---------------- */
group('import: two flows');
await go('#/data');
await click('#io-source [data-source="browser"]');
is(await hidden('#io-prefix-row'), false, 'the browser flow can put everything under a folder');
await pickFile(`${FIXTURES}/browser-export.html`);
is(await hidden('#io-plan'), false, 'a browser export gets a plan before anything is written');
is(await ev("document.querySelector('#io-mode-replace').hidden"), true, 'a browser file is never offered the replace');
await click('#io-prefix-dated');
await sleep(800);
await click('#io-apply');
await sleep(1200);
all = (await server('/api/bookmarks')).items;
const stamp = new Date().toISOString().slice(0, 10);
const dated = `Imported-${stamp}`;
is(all.filter((b) => b.folder === dated || b.folder.startsWith(`${dated}/`)).length, 2, 'it lands under the dated folder');
is(await ev("document.querySelector('#nav-count').textContent"), '7', 'and the app sees it at once');

await pickFile(`${FIXTURES}/vault.yaml`);
is(await ev("document.querySelector('#io-error').textContent.length > 0"), true,
  'a vault file in the browser flow is refused');
await click('#io-source [data-source="native"]');
is(await ev("document.querySelector('#io-mode-replace').hidden"), false, 'the vault flow keeps the replace');
await pickFile(`${FIXTURES}/vault.yaml`);
await click('#io-apply');
await sleep(1000);
all = (await server('/api/bookmarks')).items;
is(all.find((b) => b.title === 'From the vault')?.category, 'infra', 'the vault file brings everything it carries');

/* ---------------- leaving ---------------- */
group('settings: saving from anywhere');
await go('#/settings');
is(await text('#prefix-example'), `${BASE}https://www.youtube.com/watch?v=…`, 'the prefix shown is this app\'s own address');
is(await ev("document.querySelector('#bookmarklet').getAttribute('href')"), `javascript:void(open(${JSON.stringify(BASE)}+location.href))`,
  'and the bookmarklet opens it in front of the page');
await click('#bookmarklet');
is(await lastToast(), 'Drag it to the bookmarks bar', 'clicking it here explains instead of running it');

group('signing out');
await click('#btn-signout');
await sleep(800);
is(await hidden('#auth'), false, 'signing out goes back to the key screen');
is(await ev('localStorage.getItem("bookmarks_token")'), null, 'the session is gone');
is(await ev(`new Promise((r) => { const o = indexedDB.open('bookmarks', 1);
  o.onsuccess = () => { const t = o.result.transaction('vaults').objectStore('vaults').getAllKeys(); t.onsuccess = () => r(t.result.length); }; })`),
  0, 'and so is the copy of the vault on this device');

/* ---------------- saving from the address bar ---------------- */
// Last, because it navigates: after a navigation this browser delivers no more
// input, so the key goes in through the DOM, not the keyboard.
group('the address in front of a link saves it');
const target = 'https://www.youtube.com/watch?v=_Hkdzzx15PI#t=30';
const arrive = async (p) => { await ev(`location.href = ${q(BASE + p)}`); await sleep(2500); };
await arrive(target);
is(await hidden('#auth'), false, 'with no session it asks for the key first');
is(await ev("[document.querySelector('#auth-title').textContent, document.querySelector('#auth-saving-host').textContent, document.querySelector('#auth-submit').textContent]"),
  ['Save this link', 'youtube.com', 'Save link'], 'and the screen is about the link it will save');
is(await hidden('#auth-saving'), false, 'which it shows');
await ev(`(() => { const i = document.querySelector('#auth-key'); i.value = ${q(KEY)};
  document.querySelector('#auth-open').requestSubmit(); return 1; })()`);
await sleep(2000);
is(await hidden('#shell'), false, 'the key opens the vault');
all = (await server('/api/bookmarks')).items;
is(all.filter((b) => b.url === target).map((b) => [b.title, b.folder]), [['youtube.com', 'Temporary']],
  'and the link is saved to Temporary, query and hash included');
is(await ev("document.querySelector('#q').placeholder"), 'Search this folder', 'the list opens on that folder');
is(await ev('location.pathname + location.search + location.hash'), '/', 'the address bar is the app again, so a reload saves nothing');
is((await lastToast()).startsWith('Saved youtube.com to Temporary'), true, 'a toast says so');

await arrive('www.youtube.com/watch?v=_Hkdzzx15PI#t=30');
all = (await server('/api/bookmarks')).items;
is(all.filter((b) => b.url === target).length, 1, 'the same link without https:// is not saved twice');
is((await lastToast()).startsWith('Already saved'), true, 'it says it is already there');

group('nothing threw');
is(jsErrors, [], 'no uncaught error in the page');
is(nativeDialogs, [], 'no native dialog anywhere');

ws.close();
console.log(failures ? `\n\x1b[31m${failures} failure(s)\x1b[0m` : '\n\x1b[32mweb: all green\x1b[0m');
process.exit(failures ? 1 : 0);
