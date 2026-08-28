// Drives the real page in a real browser, over the DevTools protocol.
//
// No dependency: node has WebSocket built in and the browser is the one already
// on the machine. What it covers is the half the node suite cannot see, the
// part that only exists once a browser is running the page: keyboard handling,
// modals, the service worker's shell and the two import flows.
//
// Started by tests/web.sh, which brings up a server on a throwaway vault and
// passes its URL. Two hard-won rules about headless Chrome live here:
//   * --headless (old) delivers Input events; --headless=new silently does not
//   * navigating with Page.navigate kills input for the rest of the session, so
//     the browser is launched on the URL and never told to go anywhere else
'use strict';

const BASE = process.argv[2];
const PORT = Number(process.argv[3] || 9222);

let failures = 0;
const ok = (m) => console.log(`  \x1b[32m✔\x1b[0m ${m}`);
const bad = (m) => { failures += 1; console.log(`  \x1b[31m✖\x1b[0m ${m}`); };
const group = (m) => console.log(`\x1b[1;34m›\x1b[0m ${m}`);
const is = (actual, expected, what) =>
  (JSON.stringify(actual) === JSON.stringify(expected)
    ? ok(what)
    : bad(`${what}\n      esperado ${JSON.stringify(expected)}, veio ${JSON.stringify(actual)}`));
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

async function key(k, code, keyCode, modifiers = 0) {
  const base = { modifiers, key: k, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
  const printable = k.length === 1 && !modifiers;
  await cdp.send('Input.dispatchKeyEvent', { type: printable ? 'keyDown' : 'rawKeyDown', ...base, text: printable ? k : undefined });
  if (printable) await cdp.send('Input.dispatchKeyEvent', { type: 'char', ...base, text: k });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  await sleep(350);
}

// Typing into a React-less input still needs the native setter, or the value
// lands without the event the page listens for.
const setInput = (sel, value) => ev(
  `(() => { const el = document.querySelector(${JSON.stringify(sel)});
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`,
);

const pickFile = async (path) => {
  const doc = await cdp.send('DOM.getDocument', { depth: -1 });
  const found = await cdp.send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#io-file' });
  await cdp.send('DOM.setFileInputFiles', { files: [path], nodeId: found.result.nodeId });
  await sleep(1400);
};

await sleep(2500);
await cdp.send('Page.bringToFront');

// Before anything else: if this browser does not deliver key events, every
// check below would pass or fail for the wrong reason.
await ev("window.__k = []; document.addEventListener('keydown', (e) => window.__k.push(e.key), true); 1");
await key('a', 'KeyA', 65);
if (await ev('window.__k.length') === 0) {
  console.error('this browser is not delivering input events; the rest would be meaningless');
  process.exit(2);
}

/* ---------------- the sign-in screen ---------------- */
group('sign-in screen');
is(await ev("document.body.innerText.includes('backend up at')"), false,
  'a backend that answers says nothing');
is(await ev("document.querySelector('#auth-status').classList.contains('hidden')"), true,
  'the status block hides itself when there is no news');
is(await ev("!!document.querySelector('.sub')"), false, 'no tagline under the wordmark');

await setInput('#f-login', 'teste');
await setInput('#f-password', 'teste123');
await ev("document.querySelector('#auth-form').requestSubmit()");
await sleep(2500);
is(await ev("!document.querySelector('#app').classList.contains('hidden')"), true, 'signs in');

/* ---------------- keyboard ---------------- */
group('keyboard');
// Signing in swaps the whole screen; the tab has to be told it is the one in
// front again or the keys go nowhere.
await cdp.send('Page.bringToFront');
await ev("window.__k = []; document.addEventListener('keydown', (e) => window.__k.push(e.key), true); 1");
await key('a', 'KeyA', 65);
is(await ev('window.__k.length') > 0, true, 'the browser is delivering real key events');
await setInput('#q', '');
await ev("document.querySelector('#q').focus()");
await sleep(600);

is(await ev("document.activeElement.id"), 'q', 'the caret lives in the search box');
await key('F2', 'F2', 113);
is(await ev("!document.querySelector('#modal').classList.contains('hidden')"), true,
  'F2 opens the editor from the search box, where a letter could not');
is(await ev("document.querySelector('#modal-title').textContent"), 'Edit bookmark', 'and it is an edit, not a new one');
await key('Escape', 'Escape', 27);

await ev("document.querySelector('#q').focus()");
await key('e', 'KeyE', 69);
is((await ev("document.querySelector('#q').value")).includes('e'), true, '"e" is still a letter while typing');
await setInput('#q', '');
await sleep(500);

/* ---------------- deleting ---------------- */
group('deleting');
nativeDialogs.length = 0;
await ev("document.querySelector('#q').focus()");
await key('Delete', 'Delete', 46);
is(nativeDialogs.length, 0, 'Delete alone in the search box asks nothing');
is(await ev("document.querySelector('#confirm-modal').classList.contains('hidden')"), true, 'and opens no modal');

await key('Delete', 'Delete', 46, 2);
is(await ev("!document.querySelector('#confirm-modal').classList.contains('hidden')"), true, 'Ctrl+Delete asks');
is(nativeDialogs.length, 0, 'in the app, not in a browser dialog');
is(await ev("document.activeElement.id"), 'confirm-cancel', 'with the focus on cancel');
const before = await ev("document.querySelectorAll('#results li').length");
await key('Enter', 'Enter', 13);
is(await ev("document.querySelector('#confirm-modal').classList.contains('hidden')"), true, 'Enter on cancel closes it');
is(await ev("document.querySelectorAll('#results li').length"), before, 'and deletes nothing');

await ev("document.querySelector('#q').focus()");
await key('Delete', 'Delete', 46, 2);
await key('Escape', 'Escape', 27);
is(await ev("document.querySelector('#confirm-modal').classList.contains('hidden')"), true, 'Esc closes it too');
is(await ev("document.querySelectorAll('#results li').length"), before, 'still deletes nothing');

/* ---------------- opening ---------------- */
group('opening a result');
await ev("window.__opened = []; window.open = (u, t, f) => { window.__opened.push(u); return null; }; 1");
const target = JSON.parse(await ev(`(() => { const li = document.querySelector('#results li');
  const r = li.getBoundingClientRect();
  return JSON.stringify({ x: Math.round(r.left + 40), y: Math.round(r.top + r.height / 2) }); })()`));
await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'middle', clickCount: 1, buttons: 4 });
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'middle', clickCount: 1, buttons: 0 });
await sleep(900);
is((await ev('window.__opened.length')) === 1, true, 'the wheel button opens the row in a new tab');
is(await ev("location.pathname === '/'"), true, 'and leaves the app where it was');

/* ---------------- the sync light ---------------- */
group('sync light');
is(await ev("document.querySelector('#sync-state').classList.contains('hidden')"), true, 'quiet while everything is synced');
await ev("setSync('saving…', 'saving')");
is(await ev("!document.querySelector('#sync-state').classList.contains('hidden')"), true, 'shows up for work in progress');
await ev("setSync('save failed', 'err')");
is(await ev("document.querySelector('#sync-state').className.includes('err')"), true, 'and for a failure');
await ev("setSync('synced')");
is(await ev("document.querySelector('#sync-state').classList.contains('hidden')"), true, 'then gets out of the way');

/* ---------------- insights ---------------- */
group('insights');
await ev("document.querySelector('#btn-insights').click()");
await sleep(1200);
is(await ev("!document.querySelector('#insights-modal').classList.contains('hidden')"), true, 'opens');
is(await ev("getComputedStyle(document.querySelector('.modal-head')).position"), 'sticky', 'the header travels with the scroll');
is(await ev("!!document.querySelector('#ins-close')"), true, 'with a close in the top bar');
is(await ev("document.querySelector('.insights-card').getBoundingClientRect().width > 700"), true,
  'and room for a chart and two lists');
await key('Escape', 'Escape', 27);
is(await ev("document.querySelector('#insights-modal').classList.contains('hidden')"), true, 'Esc closes it');

/* ---------------- import ---------------- */
group('import: two flows');
await ev("document.querySelector('#btn-io').click()");
await sleep(700);
is(await ev("document.querySelector('[data-io-source].on').dataset.ioSource"), 'native', 'opens on the vault flow');
is(await ev("document.querySelector('#io-prefix-row').classList.contains('hidden')"), true,
  'a vault file is not dropped under a folder');
is(await ev("!document.querySelector('#io-mode-replace').classList.contains('hidden')"), true,
  'and it may replace the vault');

await ev("document.querySelector('#io-src-browser').click()");
await sleep(400);
is(await ev("document.querySelector('[data-io-source].on').dataset.ioSource"), 'browser', 'switches to the browser flow');
is(await ev("!document.querySelector('#io-prefix-row').classList.contains('hidden')"), true, 'which offers a folder to land in');
is(await ev("document.querySelector('#io-mode-replace').classList.contains('hidden')"), true,
  'and may never replace the vault');
is(await ev("document.querySelector('#io-file').accept"), '',
  'no file filter: the browser\'s own Bookmarks has no extension');

const fixtures = process.env.WEB_FIXTURES;
await pickFile(`${fixtures}/browser-export.html`);
is(await ev("document.querySelector('#io-error').textContent"), '', 'reads an exported HTML');
is((await ev("document.querySelector('#io-file-stats').textContent")).includes('no categories'), true,
  'and says up front that it carries none');

await pickFile(`${fixtures}/browser-profile.json`);
is(await ev("document.querySelector('#io-error').textContent"), '', "reads the browser's own profile file");

await ev("document.querySelector('#io-prefix-dated').click()");
await sleep(1200);
const dated = await ev("document.querySelector('#io-prefix').value");
is(/^Imported-\d{4}-\d{2}-\d{2}$/.test(dated), true, 'one click dates the folder everything lands in');
is((await ev("document.querySelector('#io-file-stats').textContent")).includes(dated), true,
  'and the plan says so before anything is written');

await setInput('#io-prefix', '');
await sleep(1000);
await pickFile(`${fixtures}/vault.yaml`);
is((await ev("document.querySelector('#io-error').textContent")).includes('From this app'), true,
  'a vault file here is refused, pointing at the other flow');
is(await ev("document.querySelector('#io-apply').disabled"), true, 'and nothing can be imported meanwhile');

await ev("document.querySelector('#io-src-native').click()");
await sleep(400);
await pickFile(`${fixtures}/browser-export.html`);
is((await ev("document.querySelector('#io-error').textContent")).includes('From a browser'), true,
  'and the other way round as well');

group('nothing threw');
is(jsErrors, [], 'no uncaught error in the console');
is(nativeDialogs, [], 'no native dialog anywhere in the run');

ws.close();
console.log('');
if (failures) {
  console.log(`\x1b[31m✖ ${failures} check(s) failed\x1b[0m`);
  process.exit(1);
}
console.log('\x1b[32m✔ web ok\x1b[0m');
