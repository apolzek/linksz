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

// Centred, not just brought into view: an element scrolled to the very top
// sits under the sticky header, which then takes the click.
async function click(sel, modifiers = 0) {
  const at = await ev(`(() => { const el = document.querySelector(${q(sel)}); if (!el) return null;
    el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect();
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
// Polls until `f` gives something truthy, or gives up and returns it anyway.
const until = async (f, ms = 4000) => {
  let v;
  for (let t = 0; t < ms; t += 150) { if ((v = await f())) return v; await sleep(150); }
  return v;
};

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

group('search history');
await key('Escape', 'Escape', 27);
await click('#q');
await type('bookmark 3');
await sleep(1800);
await key('Escape', 'Escape', 27);
await click('#btn-history');
is(await hidden('#search-history'), false, 'the history button opens the list');
is(await ev("[...document.querySelectorAll('#history-list .q')].map((e) => e.textContent)"), ['bookmark 3'],
  'with the search once the typing stopped, and not the single letters');
is(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(await text('#history-list time')), true, 'and when it was made, to the second');
await click('#history-list [data-h="0"]');
is([await ev("document.querySelector('#q').value"), await text('#count'), await hidden('#search-history')],
  ['bookmark 3', '1 of 3 links', true], 'picking one runs it again and closes the list');
await key('Escape', 'Escape', 27);
await click('#btn-history');
await key('Escape', 'Escape', 27);
is(await hidden('#search-history'), true, 'Esc closes the list');
await click('#btn-history');
await click('#history-clear');
is(await text('#history-list'), 'No searches yet.', 'and Clear empties it');
await click('#view-links .list-meta');
is(await hidden('#search-history'), true, 'a click elsewhere closes it');

group('the last click');
// Through the store, as a click does: a real click would open a tab.
const opened = (await server('/api/bookmarks')).items.find((b) => b.title === 'Bookmark 3').id;
await ev(`(async () => {
  (await import('/js/store.js')).registerOpen(${q(opened)});
  await new Promise((r) => setTimeout(r, 800));
})()`);
const last = (await server('/api/bookmarks')).items.find((b) => b.id === opened);
is(last.last_open_at > Date.now() - 60_000, true, 'the server keeps the moment of the click');
is(await ev(`document.querySelector('#list .row time.last-open')?.getAttribute('datetime')`), new Date(last.last_open_at).toISOString(),
  'and the row shows it');
is(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(await text('#list .row time.last-open')), true, 'to the second');
await key('Escape', 'Escape', 27);

group('the look');
is(await ev("getComputedStyle(document.body).fontFamily.split(',')[0].replace(/\"/g, '')"), 'Oxygen', 'text is set in Oxygen');
is(await ev("document.fonts.ready.then(() => document.fonts.check('15px Oxygen'))"), true, 'and the face is loaded');
is(await ev("getComputedStyle(document.querySelector('kbd')).fontFamily.includes('JetBrains Mono')"), true, 'keys stay in the mono face');
is(await ev("document.querySelector('#sync')"), null, 'no sync dot in the sidebar');

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

/* ---------------- by folder ---------------- */
group('the list by folder');
const groups = () => ev("[...document.querySelectorAll('#list .group')].map((g) => g.dataset.folder + ':' + g.querySelector('.group-n').textContent)");
const rows = () => ev("document.querySelectorAll('#list .row').length");
await click('#list-mode [data-mode="folders"]');
is(await groups(), ['pasta/1:1', 'pasta/2:1', 'pasta/3:1', 'web/new:1'], 'every link under a heading for its folder, in order');
is(await rows(), 4, 'with all the rows still there');
is(await text('#count'), '4 links', 'the count is the same list');
await click('#list .group[data-folder="pasta/1"] .group-toggle');
is([await rows(), await ev("document.querySelector('#list .group[data-folder=\"pasta/1\"]').classList.contains('collapsed')")],
  [3, true], 'a heading folds its folder away');
await ev("document.activeElement.blur()");
await key('a', 'KeyA', 65, CTRL);
is(await text('#sel-count'), '3 selected', 'and Ctrl+A leaves what is folded alone');
await key('Escape', 'Escape', 27);
await click('#groups-fold');
is([await rows(), await text('#groups-fold')], [0, 'Expand all'], 'collapse all folds them all, headings kept');
await click('#groups-fold');
is([await rows(), await text('#groups-fold')], [4, 'Collapse all'], 'expand all opens every folder');
await click('#q');
await type('bookmark 2');
await sleep(200);
is(await groups(), ['pasta/2:1'], 'a search keeps only the folders it found something in');
await key('Escape', 'Escape', 27);
await click('#list .group[data-folder="web/new"] [data-act="group-scope"]');
is(await text('#scope span'), 'web/new', 'Open narrows the list to that folder');
await click('#scope button');
await ev("document.activeElement.blur()");
await letter('g');
is([await ev("document.querySelectorAll('#list .group').length"), await rows()], [0, 4], 'g goes back to the plain list');
is(await ev("localStorage.getItem('bookmarks_list_mode')"), 'flat', 'and the choice is remembered');

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

// Modifier bits in the DevTools protocol: 2 is Ctrl, 8 is Shift.
await ev("(async () => { const o = await import('/js/organize.js'); o.openFolder('pasta', 'a'); o.openFolder('web', 'b'); })()");
await sleep(300);
await click('#pane-a .orow[data-folder="pasta/1"]', 2);
is(await text('#pane-a .pane-folder span'), 'pasta', 'Ctrl+click on a folder selects it instead of opening it');
// By now pasta holds 1 and 3: the moves above emptied pasta/2 off the tree.
const runOf = "[...document.querySelectorAll('#pane-a .orow.folder.marked')].map((li) => li.dataset.folder)";
await click('#pane-a .orow[data-folder="pasta/3"]', 8);
is(await ev(runOf), ['pasta/1', 'pasta/3'], 'Shift+click marks the run of folders');
await click('#pane-a .orow[data-folder="pasta/3"]', 2);
is(await ev(runOf), ['pasta/1'], 'Ctrl+click on a marked folder unmarks it');
await click('#pane-a .orow[data-folder="pasta/3"]', 2);
is(await ev("document.querySelector('#move-ab span').textContent"), '2', 'and the arrow counts folders');
await click('#move-ab');
await sleep(900);
all = (await server('/api/bookmarks')).items;
is([all.some((b) => b.folder === 'web/1'), all.some((b) => b.folder === 'web/3'), all.some((b) => b.folder.startsWith('pasta/'))],
  [true, true, false], 'the arrow moves every marked folder');
await click('.toast:last-child button');
await sleep(1000);
all = (await server('/api/bookmarks')).items;
is([all.some((b) => b.folder === 'pasta/1'), all.some((b) => b.folder === 'pasta/3'), all.some((b) => b.folder === 'web/1' || b.folder === 'web/3')],
  [true, true, false], 'one undo puts all of them back');
await ev("(async () => { const o = await import('/js/organize.js'); o.openFolder('pasta', 'a'); })()");
await sleep(300);
is(await ev("[...document.querySelectorAll('#pane-a .orow.folder[data-fi]')].every((li) => li.querySelector('.check-box use')?.getAttribute('href') === '#i-check')"),
  true, 'folder rows have a check box, like links');
await click('#pane-a .orow[data-folder="pasta/1"] .check-box');
is([await text('#pane-a .pane-folder span'), await ev(runOf)], ['pasta', ['pasta/1']], 'clicking the box marks the folder instead of opening it');
await click('#pane-a .orow[data-folder="pasta/1"] .check-box');
is(await ev(runOf), [], 'and clicking it again unmarks it');
is(await ev("document.querySelector('#view-organize .titles p')"), null, 'no instructions above the panes');
await ev("(async () => { const o = await import('/js/organize.js'); o.openFolder('pasta/1', 'a'); o.openFolder('pasta/2', 'b'); })()");
await sleep(300);

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

await ev("(async () => { const s = await import('/js/store.js'); await s.createFolder('pasta/1/x'); await s.createFolder('pasta/1/y'); })()");
await sleep(400);
const markedIn = (sel) => ev(`document.querySelectorAll('#pane-a ${sel}.marked').length`);
const listedIn = (sel) => ev(`document.querySelectorAll('#pane-a ${sel}').length`);
await click('#pane-a .pane-list');
await key('a', 'KeyA', 65, CTRL);
is([await markedIn('.orow.folder[data-fi]'), await markedIn('.orow[data-i]')],
  [await listedIn('.orow.folder[data-fi]'), await listedIn('.orow[data-i]')], 'Ctrl+A in a pane selects its folders and its links');
await key('Escape', 'Escape', 27);
is(await markedIn('.orow'), 0, 'Esc clears it');
await click('#pane-a .orow[data-folder="pasta/1/x"]', CTRL);
await click('#pane-a .orow[data-folder="pasta/1/y"]', CTRL);
is(await hidden('#pane-a [data-act="delete-marked"]'), false, 'selecting folders shows the bin');
await key('Delete', 'Delete', 46);
is(await ev("document.querySelector('#dlg-confirm').open"), true, 'Del on selected folders asks first');
await click('#confirm-yes');
await sleep(800);
const left = (await server('/api/folders')).folders.map((f) => f.path);
is([left.includes('pasta/1/x'), left.includes('pasta/1/y'), left.includes('pasta/1')], [false, false, true],
  'and deletes the selected folders, not the one they are in');

// A folder and a link of its own, so the counts the later groups expect stand.
await ev(`(async () => { const s = await import('/js/store.js'); await s.createFolder('pasta/1/z');
  await fetch('/api/bookmarks', { method: 'POST', headers: { 'content-type': 'application/json',
    authorization: 'Bearer ' + localStorage.getItem('bookmarks_token') },
    body: JSON.stringify({ url: 'https://to-the-bin.example', title: 'To the bin', folder: 'pasta/1' }) });
  await s.pull(); })()`);
await sleep(600);
const loose = 'To the bin';
const binRow = await ev("[...document.querySelectorAll('#pane-a .orow[data-i]')].find((li) => li.textContent.includes('To the bin'))?.dataset.i");
await click('#pane-a .orow[data-folder="pasta/1/z"]', CTRL);
await click(`#pane-a .orow[data-i="${binRow}"]`);
await click('#pane-a [data-act="delete-marked"]');
is(await text('#confirm-title'), 'Delete 1 folder and 1 link?', 'the bin asks once for folders and links together');
await click('#confirm-yes');
await sleep(800);
all = (await server('/api/bookmarks')).items;
is([(await server('/api/folders')).folders.some((f) => f.path === 'pasta/1/z'), all.some((b) => b.title === loose)],
  [false, false], 'and removes both');
is(await hidden('#pane-a [data-act="delete-marked"]'), true, 'with nothing selected the bin goes away');

await click('#pane-a [data-act="new-link"]');
is(await ev("document.querySelector('#dlg-edit').open"), true, 'the plus on a pane opens a new link');
is(await text('#e-folder span'), 'pasta/1', 'filed in the folder that pane shows');
await type('example.org/from-organize');
await click('#edit-save');
await sleep(700);
let fromPane = (await server('/api/bookmarks')).items.find((b) => b.url === 'https://example.org/from-organize');
is(fromPane?.folder, 'pasta/1', 'and saved there');
is(await ev("[...document.querySelectorAll('#pane-a .orow[data-i]')].some((li) => li.textContent.includes('example.org'))"), true,
  'the pane shows it at once');
await click('#pane-b .pane-list');
await letter('n');
is(await ev("document.querySelector('#dlg-edit').open"), true, 'n on the organizer opens a new link');
is(await text('#e-folder span'), 'pasta/2', 'in the folder of the pane in focus');
is(await ev("document.querySelector('#e-url').value"), '', 'and the n is not typed into it');
await key('Escape', 'Escape', 27);
// Out of the way, so the counts the later groups expect stand.
await ev(`fetch('/api/bookmarks/${fromPane?.id}', { method: 'DELETE', headers: {
  authorization: 'Bearer ' + localStorage.getItem('bookmarks_token') } })`);
await sleep(300);

// A paste the way the browser delivers one. Ctrl+V itself cannot be driven in
// headless Chrome without clipboard permissions, so the event is made by hand.
const paste = (textOnClipboard, target = 'document.body') => ev(`(() => {
  const dt = new DataTransfer();
  dt.setData('text/plain', ${q(textOnClipboard)});
  (${target}).dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
})()`);
const pasted = async () => (await server('/api/bookmarks')).items.filter((b) => /paste-\d\.example/.test(b.url));
await click('#pane-a .pane-list');
await ev('document.activeElement.blur()');
await paste('https://paste-1.example/a?b=c#d');
await sleep(700);
let p1 = (await pasted()).find((b) => b.url === 'https://paste-1.example/a?b=c#d');
is(p1?.folder, 'pasta/1', 'Ctrl+V files the link on the clipboard in the pane in focus');
is([p1?.title, p1?.description, p1?.tags, p1?.category], ['', '', '', ''], 'with the URL and nothing else');
is(await ev("[...document.querySelectorAll('#pane-a .orow[data-i]')].some((li) => li.textContent.includes('paste-1.example'))"), true,
  'and the pane shows it at once');
await paste('https://paste-1.example/a?b=c#d');
await sleep(500);
is((await pasted()).length, 1, 'the same link pasted again is not filed twice');
is(await lastToast(), 'Already in pasta/1', 'it says so');
await paste('paste-2.example\n  https://paste-3.example/x  \nnot a link at all\n');
await sleep(900);
is((await pasted()).map((b) => b.url).sort(), ['https://paste-1.example/a?b=c#d', 'https://paste-2.example', 'https://paste-3.example/x'],
  'one link per line, a bare domain gets https, prose is passed over');
await click('#pane-b .pane-list');
await ev('document.activeElement.blur()');
await paste('just some words');
await sleep(400);
is((await pasted()).length, 3, 'a clipboard with no link files nothing');
is(await lastToast(), 'Nothing to paste: the clipboard holds no link', 'and says why');
await click('#pane-a .pane-tools input');
await paste('https://paste-4.example', "document.querySelector('#pane-a .pane-tools input')");
await sleep(400);
is((await pasted()).length, 3, 'a paste into the filter box is the filter box\'s');

// Editing from the organizer, on a link of its own.
const editRow = "[...document.querySelectorAll('#pane-a .orow[data-i]')].find((li) => li.textContent.includes('paste-1.example'))";
await ev('document.activeElement.blur()');
await click('#pane-a .pane-list');
const editAt = await ev(`${editRow}?.dataset.i`);
await click(`#pane-a .orow[data-i="${editAt}"] .edit-link`);
is(await ev("document.querySelector('#dlg-edit').open"), true, 'the pencil on a link opens the form');
is(await ev("document.querySelector('#e-url').value"), 'https://paste-1.example/a?b=c#d', 'on that link');
is(await ev(`${editRow}?.classList.contains('marked')`), false, 'and does not select it');
await ev("document.querySelector('#e-title').select()");
await type('Edited in the organizer');
await click('#edit-save');
await sleep(700);
is((await pasted()).find((b) => b.url === 'https://paste-1.example/a?b=c#d')?.title, 'Edited in the organizer', 'the change is saved');
is((await pasted()).find((b) => b.url === 'https://paste-1.example/a?b=c#d')?.folder, 'pasta/1', 'in the same folder');
is(await ev(`${editRow}?.querySelector('.orow-title').textContent`), 'Edited in the organizer', 'and the pane shows it');
await click(`#pane-a .orow[data-i="${await ev(`${editRow}?.dataset.i`)}"]`);
await letter('e');
is(await ev("document.querySelector('#e-title').value"), 'Edited in the organizer', 'e edits the one link selected');
await key('Escape', 'Escape', 27);
await key('F2', 'F2', 113);
is(await ev("document.querySelector('#dlg-edit').open"), true, 'so does F2');
await key('Escape', 'Escape', 27);
await click(`#pane-a .orow[data-i="${(Number(await ev(`${editRow}?.dataset.i`)) + 1) % 2}"]`);
await letter('e');
is(await ev("document.querySelector('#dlg-edit').open"), false, 'with two selected, e does nothing');
await key('Escape', 'Escape', 27);

// A .example address never resolves, so the title can only come from the
// address: the page half is covered by tests/titles.test.js.
await key('Escape', 'Escape', 27);
await ev('document.activeElement.blur()');
await paste('https://paste-5.example/2024/an-article-worth-reading.html');
await sleep(150);
is((await pasted()).some((b) => b.url.includes('paste-5')), true, 'the link is saved before its title is found');
// Up to the title fetcher's own timeout: a resolver that is slow to say a
// name does not exist (some VPN ones take seconds) runs the fetch out.
await until(async () => (await pasted()).find((b) => b.url.includes('paste-5'))?.title, 8000);
is((await pasted()).find((b) => b.url.includes('paste-5'))?.title, 'An Article Worth Reading',
  'and then gets a title, from the address when the page cannot be read');
is(await ev("[...document.querySelectorAll('#pane-a .orow-title')].some((s) => s.textContent === 'An Article Worth Reading')"), true,
  'which the pane shows');

await ev(`(async () => { const s = await import('/js/store.js');
  await s.removeMany(s.all().filter((b) => /paste-\\d\\.example/.test(b.url)).map((b) => b.id)); })()`);
await sleep(400);

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
await pickFile(`${FIXTURES}/vault.yaml`);
await click('#io-modes input[value="update"]');
await sleep(600);
is(await text('#io-apply'), 'Nothing to import', 'the same file again has nothing to import');
is(await hidden('#io-none'), false, 'and the page says why, instead of a silent grey button');
await pickFile(`${FIXTURES}/vault.json`);
is(await hidden('#io-plan'), false, 'a json export with its folders up front gets a plan');
await click('#io-apply');
await sleep(1000);
all = (await server('/api/bookmarks')).items;
is(all.find((b) => b.title === 'From the json')?.folder, 'curated/topic-7/subtopic', 'and lands in its folder');
is((await server('/api/folders')).folders.some((f) => f.path === 'curated/empty'), true, 'empty folders included');
// Out of the way, so the counts the later groups expect stand.
await ev(`fetch('/api/folders/delete', { method: 'POST', headers: { 'content-type': 'application/json',
  authorization: 'Bearer ' + localStorage.getItem('bookmarks_token') }, body: JSON.stringify({ path: 'curated' }) })`);
await sleep(300);

/* ---------------- audit ---------------- */
group('the audit log');
const auditRows = () => ev("[...document.querySelectorAll('#audit-rows tr')].map((r) => [...r.cells].map((c) => c.innerText.trim()))");
await click('.nav a[data-route="audit"]');
await sleep(900);
is(await ev("document.body.dataset.route"), 'audit', 'the sidebar opens the audit log');
let arows = await auditRows();
is(arows.length > 0 && arows.every((r) => /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(r[0])), true, 'every change has its date and time to the second');
await click('#audit-q');
await type('Made in the browser');
await sleep(700);
is((await auditRows()).map((r) => r[1]), ['Moved', 'Moved', 'Restored', 'Deleted', 'Added'],
  'a link\'s whole history, newest first: added, deleted, undone, moved and moved back');
await ev("(() => { const i = document.querySelector('#audit-q'); i.value = ''; i.dispatchEvent(new Event('input')); })()");
await sleep(500);
await click('#audit-action [data-action="move"]');
await sleep(600);
arows = await auditRows();
is(arows.length > 0 && arows.every((r) => r[1] === 'Moved' && r[3].includes('→')), true, 'moves only, each with where from and where to');
await click('#audit-action [data-action="edit"]');
await sleep(600);
arows = await auditRows();
is(arows.length > 0 && arows.every((r) => r[1] === 'Edited'), true, 'edits only');
is(arows.some((r) => /Title/.test(r[3]) && r[3].includes('→')), true, 'with the field and its value before and after');

await click('#audit-tab [data-tab="clicks"]');
await sleep(900);
arows = await auditRows();
is(arows[0]?.slice(1, 3), ['#/audit', 'Clicks'], 'the clicks tab starts with the click that opened it');
is(arows.some((r) => r[2] === 'Audit log' && r[3].includes('a')), true, 'and the click on the sidebar before it');
is(arows.some((r) => r[1] === '#/organize'), true, 'clicks on every page are there');
is(await hidden('#audit-action'), true, 'the action filter is for link changes only');
await click('#audit-q');
await type('organize');
await sleep(700);
arows = await auditRows();
is(arows.length > 0 && arows.every((r) => (r.join(' ')).toLowerCase().includes('organize')), true, 'the filter narrows the clicks');
is(await ev("document.querySelector('#audit-rows').innerHTML.includes('do-vault')"), false, 'nothing typed was recorded, only clicks');

/* ---------------- leaving ---------------- */
group('settings: saving from anywhere');
await go('#/settings');
is(await text('#prefix-example'), `${BASE}https://www.youtube.com/watch?v=…`, 'the prefix shown is this app\'s own address');
is(await ev("document.querySelector('#bookmarklet').getAttribute('href')"), `javascript:void(open(${JSON.stringify(BASE)}+location.href))`,
  'and the bookmarklet opens it in front of the page');
await click('#bookmarklet');
is(await lastToast(), 'Drag it to the bookmarks bar', 'clicking it here explains instead of running it');

// Fixtures for the two groups below: a folder with two links and an empty one.
await go('#/');
await ev('document.activeElement.blur()');
await ev(`(async () => {
  const s = await import('/js/store.js');
  await s.create({ url: 'https://undo-1.example', title: 'Undo one', folder: 'undo/inner' });
  await s.create({ url: 'https://undo-2.example', title: 'Undo two', folder: 'undo' });
  await s.createFolder('undo/empty');
})()`);
await sleep(500);
const undoLive = async () => (await server('/api/bookmarks?limit=5000')).items.filter((b) => b.url.startsWith('https://undo-'))
  .map((b) => `${b.folder}|${b.title}`).sort();
const undoFolders = async () => (await server('/api/folders')).folders.map((f) => f.path).filter((p) => /^(undo|undone)(\/|$)/.test(p)).sort();
const ctrlZ = async () => { await letter('z', CTRL); await sleep(1200); };

group('a folder with links is not deleted by accident');
await go('#/organize');
await ev("(async () => { const o = await import('/js/organize.js'); o.openFolder('undo', 'a'); })()");
await sleep(400);
is(await hidden('#pane-a .pane-head [data-act="delete"]'), false, 'with nothing selected, the folder has its bin');
await click('#pane-a .orow[data-i="0"]');
is([await hidden('#pane-a .pane-head [data-act="delete"]'), await hidden('#pane-a [data-act="delete-marked"]')], [true, false],
  'with a link selected, the only bin is the one for the selection');
await key('Escape', 'Escape', 27);
is(await hidden('#pane-a .pane-head [data-act="delete"]'), false, 'and the folder bin is back when the selection goes');
await click('#pane-a .pane-head [data-act="delete"]');
is([await ev("document.querySelector('#dlg-prompt').open"), await text('#prompt-ok'), await ev("document.querySelector('#prompt-ok').className")],
  [true, 'Delete 2 links', 'btn danger'], 'a folder with links asks for its name, and says how much goes');
await ev("document.querySelector('#prompt-input').value = 'nope'; document.querySelector('#prompt-form').requestSubmit(); 1");
await sleep(400);
is([await ev("document.querySelector('#dlg-prompt').open"), await text('#prompt-error')], [true, 'Type undo to confirm'], 'the wrong name deletes nothing');
await key('Escape', 'Escape', 27);
await sleep(300);
is((await undoLive()).length, 2, 'and cancelling keeps every link');
await go('#/');
await ev('document.activeElement.blur()');

group('undo with Ctrl+Z');
const foldersBefore = await undoFolders();
// Not awaited: it waits on the confirm dialog, clicked below.
await ev("import('/js/ui.js').then((u) => { u.askDeleteFolders(['undo']); }); 1");
await sleep(300);
await ev("document.querySelector('#prompt-input').value = 'undo'; document.querySelector('#prompt-form').requestSubmit(); 1");
await sleep(900);
is(await undoLive(), [], 'deleting a folder takes its links');
await ctrlZ();
is(await undoLive(), ['undo/inner|Undo one', 'undo|Undo two'], 'Ctrl+Z brings the links back where they were');
is([await undoFolders(), foldersBefore.includes('undo/empty')], [foldersBefore, true], 'and the folders as they were, the empty one too');
is(await lastToast(), 'Undone: Deleted undo and 2 links', 'and says what it undid');

await ev("import('/js/ui.js').then((u) => { u.askRenameFolder('undo'); }); 1");
await sleep(300);
await ev("document.querySelector('#prompt-input').value = 'undone'; document.querySelector('#prompt-form').requestSubmit(); 1");
await sleep(900);
is(await undoLive(), ['undone/inner|Undo one', 'undone|Undo two'], 'renaming a folder moves what is in it');
await ctrlZ();
is(await undoLive(), ['undo/inner|Undo one', 'undo|Undo two'], 'Ctrl+Z puts the old name back');

const two = (await server('/api/bookmarks?limit=5000')).items.find((b) => b.url === 'https://undo-2.example');
await ev(`import('/js/ui.js').then((u) => u.moveLinks([${q(two.id)}], 'elsewhere')).then(() => 1)`);
await sleep(700);
is((await undoLive()).includes('elsewhere|Undo two'), true, 'moving a link files it elsewhere');
await ctrlZ();
is((await undoLive()).includes('undo|Undo two'), true, 'Ctrl+Z moves it back');

await ev(`(async () => {
  const s = await import('/js/store.js');
  (await import('/js/editor.js')).openEditor(s.all().find((b) => b.url === 'https://undo-2.example'));
})()`);
await sleep(300);
await ev("document.querySelector('#e-title').value = 'Renamed by mistake'; document.querySelector('#edit-form').requestSubmit(); 1");
await sleep(900);
is((await undoLive()).includes('undo|Renamed by mistake'), true, 'editing a link changes it');
await ctrlZ();
is((await undoLive()).includes('undo|Undo two'), true, 'Ctrl+Z takes the edit back');

await ev("import('/js/ui.js').then((u) => { u.askDeleteFolders(['undo']); }); 1");
await sleep(300);
await ev("document.querySelector('#prompt-input').value = 'undo'; document.querySelector('#prompt-form').requestSubmit(); 1");
await sleep(900);
await ev("import('/js/ui.js').then((u) => u.moveLinks([], 'x')).then(() => 1)");
await ctrlZ();
is(await undoLive(), ['undo/inner|Undo one', 'undo|Undo two'], 'the newest change is the one undone');

await ev(`import('/js/ui.js').then((u) => u.moveLinks([${q(two.id)}], 'elsewhere')).then(() => 1)`);
await sleep(700);
await click('#q');
await type('typed');
await ctrlZ();
is((await undoLive()).includes('elsewhere|Undo two'), true, 'in a text field, Ctrl+Z is the field\'s own and the move stays');
await key('Escape', 'Escape', 27);
await ev('document.activeElement.blur()');
await ctrlZ();
is((await undoLive()).includes('undo|Undo two'), true, 'out of it, Ctrl+Z undoes the move');

group('settings: devices');
is(await until(() => ev("document.querySelectorAll('#devices li').length > 0")), true, 'Settings lists the devices signed in');
is(await ev("[...document.querySelectorAll('#devices li')].filter((li) => li.querySelector('.badge')).length"), 1, 'and marks this one');
const other = await ev(`fetch('/api/auth/key', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ key: ${JSON.stringify(KEY)}, device: 'Old phone' }) }).then((r) => r.json()).then((r) => r.token)`);
await go('#/links');
await go('#/settings');
is(await until(() => ev("[...document.querySelectorAll('#devices strong')].map((s) => s.textContent).includes('Old phone')")), true,
  'a device that signs in shows up');
await ev("[...document.querySelectorAll('#devices li')].find((li) => li.textContent.includes('Old phone')).querySelector('[data-revoke]').click()");
await sleep(300);
is(await text('#confirm-title'), 'Sign out Old phone?', 'signing one out asks first');
await click('#confirm-yes');
await sleep(600);
is(await ev(`fetch('/api/me', { headers: { authorization: ${q('Bearer ' + other)} } }).then((r) => r.status)`), 401,
  'and that device is out');
is(await ev("[...document.querySelectorAll('#devices strong')].map((s) => s.textContent).includes('Old phone')"), false, 'and off the list');
is(await hidden('#shell'), false, 'while this one stays in');

group('settings: the omarchy themes');
is(await ev("document.querySelectorAll('#palettes button').length"), 23, 'every omarchy theme is offered');
await click('#palettes [data-theme="nord"]');
is([await ev('document.documentElement.dataset.theme'), await ev("localStorage.getItem('bookmarks_theme')"),
  await ev('getComputedStyle(document.body).backgroundColor')], ['nord', 'nord', 'rgb(46, 52, 64)'], 'picking one paints the page in it, and is remembered');
is(await ev("[...document.querySelectorAll('#theme button.on, #palettes button.on')].map((b) => b.dataset.theme)"), ['nord'], 'and it alone is shown as chosen');
await click('#palettes [data-theme="catppuccin-latte"]');
is(await ev('getComputedStyle(document.body).backgroundColor'), 'rgb(239, 241, 245)', 'a light one works the same');
await click('#theme [data-theme="auto"]');
is([await ev('document.documentElement.dataset.theme ?? null'), await ev("localStorage.getItem('bookmarks_theme')")], [null, 'auto'], 'System goes back to following the system');

/* ---------------- previews ---------------- */
// What the server says about a link, and the site a frame loads, are both
// answered here, over the DevTools protocol: no test reaches the internet,
// and the backend's side of it is covered by the node suite.
group('previews');
const FRAMED = 'https://framed.example/page';
let previewReply = null;
let previewAsks = 0;
let framedLoads = 0;
cdp.on((m) => {
  if (m.method !== 'Fetch.requestPaused') return;
  const { requestId, request } = m.params;
  const body = (s) => Buffer.from(s).toString('base64');
  if (request.url.includes('/api/preview')) {
    previewAsks += 1;
    cdp.send('Fetch.fulfillRequest', { requestId, responseCode: 200,
      responseHeaders: [{ name: 'content-type', value: 'application/json' }], body: body(JSON.stringify(previewReply)) });
  } else {
    framedLoads += 1;
    cdp.send('Fetch.fulfillRequest', { requestId, responseCode: 200,
      responseHeaders: [{ name: 'content-type', value: 'text/html' }], body: body('<h1>framed page</h1>') });
  }
});
await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/preview*' }, { urlPattern: 'https://framed.example/*' }] });
const reply = (over) => ({ url: FRAMED, final_url: FRAMED, title: 'Framed', description: '', image: '', icon: '', site: 'framed.example', frame: true, ...over });
const previewOpen = () => ev("document.querySelector('#dlg-preview').open");
const pointAt = async (sel, dx = 0) => {
  const at = await ev(`(() => { const r = document.querySelector(${q(sel)})?.getBoundingClientRect();
    return r ? [r.x + r.width / 2 + ${dx}, r.y + r.height / 2] : null; })()`);
  if (at) await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at[0], y: at[1] });
  return at;
};

await go('#/links');
previewReply = reply();
// The second link for the pointer, the first for the keyboard: each link's
// preview is kept for the session, so the two must be different links.
const HOVERED = '#list .row[data-i="1"]';
await pointAt(HOVERED);
await sleep(1500);
is(await previewOpen(), false, 'passing over a link opens nothing, not even after a second and a half');
await pointAt(HOVERED, 8);
await sleep(2400);
is(await previewOpen(), true, 'resting on it opens the preview');
const frame = await until(() => ev("document.querySelector('#preview-body iframe')?.getAttribute('src') ?? null"));
is(frame, FRAMED, 'a site that allows it is shown in a frame');
is(await ev("document.querySelector('#preview-body iframe').getAttribute('sandbox').split(' ').includes('allow-top-navigation')"), false,
  'which cannot navigate the app away');
// A frame from another site runs in a process of its own and is not in this
// page's frame tree; the request for its page is what shows it loaded.
is(await until(() => framedLoads > 0), true, 'and the browser loads the page in it');
is(await hidden('#preview-mode'), false, 'with a switch to the card');
await click('#preview-mode [data-mode="card"]');
is(await ev("[!!document.querySelector('#preview-body iframe'), !!document.querySelector('.preview-card')]"), [false, true],
  'the switch shows the card instead');

await pointAt('#dlg-preview');
await sleep(100);
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 3, y: 3 });
await sleep(150);
is(await previewOpen(), true, 'a moment outside is not leaving yet');
await sleep(600);
is(await previewOpen(), false, 'a preview the pointer opened closes when the pointer leaves it');

previewReply = reply({ url: 'https://closed.example/', final_url: 'https://closed.example/', title: 'Closed',
  description: 'What the page says about itself', site: 'Closed Site', frame: false });
await ev('document.activeElement.blur()');
for (let k = 0; k < 4; k++) await key('ArrowUp', 'ArrowUp', 38);
is(await ev("document.querySelector('.row.cursor')?.dataset.i ?? null"), '0', 'the cursor on the first link');
await letter('p');
is(await until(() => ev("document.querySelector('.preview-card')?.innerText.includes('What the page says about itself') ?? false")), true,
  'p previews the link under the cursor, and a site that refuses frames gets the card');
is([await hidden('#preview-mode'), !!(await ev("document.querySelector('#preview-body iframe')"))], [true, false], 'with no frame to switch to');
is((await text('#preview-body .hint')).includes('does not let other pages show it'), true, 'and says why');
await key('Escape', 'Escape', 27);
is(await previewOpen(), false, 'Esc closes it');
is(await ev("document.querySelector('#preview-body').innerHTML"), '', 'and the frame goes with it');

await go('#/settings');
await click('#preview-hover [data-hover="off"]');
await go('#/links');
const asked = previewAsks;
await pointAt('#list .row[data-i="2"]', 4);
await sleep(2400);
is([await previewOpen(), previewAsks], [false, asked], 'with hover turned off in Settings, resting opens nothing');
await go('#/settings');
await click('#preview-hover [data-hover="on"]');
await cdp.send('Fetch.disable');

/* ---------------- favourites, many at once, Temporary ---------------- */
group('favourites, opening many at once, sorting Temporary');
const post = (b) => ev(`fetch('/api/bookmarks', { method: 'POST', headers: { 'content-type': 'application/json',
  authorization: 'Bearer ' + localStorage.getItem('bookmarks_token') }, body: ${q(JSON.stringify(b))} }).then((r) => r.status)`);
for (let i = 0; i < 12; i++) await post({ title: `Bulk ${i}`, url: `https://bulk${i}.example/`, folder: 'bulk' });
await post({ title: 'A repo', url: 'https://github.com/a/b', folder: 'dev/repos' });
await post({ title: 'New thing on github', url: 'https://github.com/x/new-thing', folder: 'Temporary' });
await post({ title: 'Throwaway', url: 'https://throwaway.example/', folder: 'Temporary' });
await go('#/links');
await until(() => ev("document.querySelector('#count').textContent.includes('of') === false && !!document.querySelector('#btn-triage:not([hidden])')"), 9000);
// What the app opens is written down instead of opened. `blockAfter` plays a
// browser that lets one window through and blocks the rest.
await ev(`window.__opened = []; window.__blockAfter = Infinity;
  window.open = (u) => (window.__opened.length >= window.__blockAfter ? null : (window.__opened.push(u), {})); 1`);
const openedNow = () => ev('window.__opened');

await click('#q');
await type('Bulk 3');
await ev('document.activeElement.blur()');
await key('ArrowDown', 'ArrowDown', 40);
await letter('f');
await until(() => ev("document.querySelectorAll('#pins .pin').length === 1"));
is(await ev("[...document.querySelectorAll('#pins .pin')].map((p) => [p.querySelector('kbd')?.textContent, p.querySelector('span:not(.fav)').textContent])"), [['1', 'Bulk 3']],
  'f pins the link under the cursor, numbered');
await click('#q');
await ev("document.querySelector('#q').select()");
await type('Bulk 7');
await click('#list .row [data-act="pin"]');
await until(() => ev("document.querySelectorAll('#pins .pin').length === 2"));
const pinsOf = () => ev("[...document.querySelectorAll('#pins .pin span:not(.fav)')].map((s) => s.textContent)");
is(await pinsOf(), ['Bulk 3', 'Bulk 7'], 'the star on a row pins it after the others');
const onServer = async () => (await server('/api/bookmarks?limit=5000')).items.filter((b) => b.pinned > 0)
  .sort((a, b) => a.pinned - b.pinned).map((b) => b.title);
is(await until(async () => (await onServer()).length === 2 && onServer()), ['Bulk 3', 'Bulk 7'], 'and the server keeps both, in order');
await ev('document.activeElement.blur()');
await key('2', 'Digit2', 50, ALT);
is((await openedNow()).at(-1), 'https://bulk7.example/', 'Alt+2 opens the second pin');
await drag('#pins .pin:nth-child(2)', '#pins .pin:nth-child(1)');
is(await until(async () => (await pinsOf())[0] === 'Bulk 7' && pinsOf()), ['Bulk 7', 'Bulk 3'], 'dragging a pin onto another puts it first');
await key('1', 'Digit1', 49, ALT);
is((await openedNow()).at(-1), 'https://bulk7.example/', 'and Alt+1 follows the new order');
await ev("document.querySelector('#pins .pin:nth-child(2) [data-unpin]').click()");
is(await until(async () => (await pinsOf()).length === 1 && pinsOf()), ['Bulk 7'], 'the x on a pin unpins it');

await click('#q');
await ev("document.querySelector('#q').select()");
await type('/bulk');
await ev('document.activeElement.blur()');
await ev('window.__opened = []');
await letter('o');
is(await ev("document.querySelector('#dlg-confirm').open && document.querySelector('#confirm-yes').textContent"), 'Open 12',
  'o on twelve links asks first');
await click('#confirm-yes');
is((await openedNow()).length, 12, 'and opens every one listed');
is(await lastToast(), 'Opened 12 links', 'saying so');
await ev('window.__opened = []; window.__blockAfter = 1');
await letter('o');
await click('#confirm-yes');
is((await lastToast()).startsWith('The browser blocked 11 of 12. Allow pop-ups for this site'), true,
  'a browser that blocks the rest is told about, with what to do');
await ev('window.__blockAfter = Infinity');

await click('#list-mode [data-mode="folders"]');
await ev('window.__opened = []');
await click('#list .group [data-act="group-open"]');
await click('#confirm-yes');
is((await openedNow()).length, 12, 'the folder heading opens its folder');
await click('#list-mode [data-mode="flat"]');
await key('Escape', 'Escape', 27);
await key('Escape', 'Escape', 27);

const waiting = Number((await text('#btn-triage span')).match(/\d+/)[0]);
is(waiting >= 2, true, 'the list offers to sort what waits in Temporary');
await ev('document.activeElement.blur()');
await letter('t');
is(await ev("document.querySelector('#dlg-triage').open"), true, 't opens the sorting');
const seen = [];
for (let n = 0; n < waiting; n++) {
  const title = await text('#triage-body .triage-title');
  if (!title) break;
  seen.push(title);
  if (title === 'New thing on github') {
    is(await text('#triage-body .triage-suggestions .btn.primary span'), 'dev/repos', 'a link is offered the folder its site is in');
    await key('Enter', 'Enter', 13);
  } else if (title === 'Throwaway') {
    await key('Delete', 'Delete', 46);
  } else {
    await letter('s');
  }
  await sleep(300);
}
is(seen.includes('New thing on github') && seen.includes('Throwaway'), true, 'one link at a time, every one waiting');
is(await hidden('#triage-body .triage-done'), false, 'until Temporary is done');
const after = (await server('/api/bookmarks?limit=5000')).items;
is(after.find((b) => b.title === 'New thing on github')?.folder, 'dev/repos', 'Enter filed it where suggested');
is(after.some((b) => b.title === 'Throwaway'), false, 'Del deleted the other');
await key('Escape', 'Escape', 27);
is(await ev("document.querySelector('#dlg-triage').open"), false, 'Esc closes it');
await go('#/settings');

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
