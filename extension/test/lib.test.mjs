// The extension's pure pieces.

import test from 'node:test';
import assert from 'node:assert';
import {
  normalizeServer, isBuiltinHost, originPattern, isSaveable, folderPaths, cleanFolder, folderLabel,
  escapeXml, omniboxSuggestions, newNonce, connectUrl, checkConnect, CONNECT_TTL,
} from '../src/lib.js';

test('a server is kept as an origin, and only http or https', () => {
  assert.equal(normalizeServer('http://localhost:8080/'), 'http://localhost:8080');
  assert.equal(normalizeServer('localhost:8080'), 'http://localhost:8080');
  assert.equal(normalizeServer(' https://bm.example.com/app#/x '), 'https://bm.example.com');
  for (const bad of ['', 'javascript:alert(1)', 'file:///etc', 'ftp://x.example', 'http://']) {
    assert.equal(normalizeServer(bad), '', bad);
  }
});

test('only this machine needs no permission asked for', () => {
  assert.equal(isBuiltinHost('http://localhost:8080'), true);
  assert.equal(isBuiltinHost('http://127.0.0.1:9000'), true);
  assert.equal(isBuiltinHost('https://bm.example.com'), false);
  assert.equal(isBuiltinHost('http://localhost.evil.example'), false);
  assert.equal(originPattern('https://bm.example.com:8443'), 'https://bm.example.com/*');
});

test('only web pages can be saved', () => {
  for (const ok of ['https://a.example', 'http://localhost:8080/x']) assert.equal(isSaveable(ok), true, ok);
  for (const no of ['chrome://extensions', 'about:blank', 'file:///tmp/x', 'chrome-extension://abc/popup.html', '', undefined]) {
    assert.equal(isSaveable(no), false, String(no));
  }
});

test('the folder list is the whole tree, parents included, sorted', () => {
  const paths = folderPaths({ folders: [{ path: 'dev/web' }, { path: 'Zeta' }], used: ['dev/docker/compose', 'alpha', ''] });
  assert.deepEqual(paths, ['alpha', 'dev', 'dev/docker', 'dev/docker/compose', 'dev/web', 'Zeta']);
  assert.deepEqual(folderPaths({}), []);
});

test('a typed folder is cleaned, and no folder reads as Unfiled', () => {
  assert.equal(cleanFolder(' dev / web// '), 'dev/web');
  assert.equal(cleanFolder('///'), '');
  assert.equal(folderLabel(''), 'Unfiled');
  assert.equal(folderLabel('dev'), 'dev');
});

test('the address bar gets escaped suggestions that open the link', () => {
  assert.equal(escapeXml(`<a href="x">&'`), '&lt;a href=&quot;x&quot;&gt;&amp;&apos;');
  const s = omniboxSuggestions([
    { url: 'https://a.example/?q=1&b=2', title: 'A <b>bold</b> title', folder: 'dev' },
    { url: 'https://b.example', title: '', folder: '' },
  ]);
  assert.equal(s[0].content, 'https://a.example/?q=1&b=2', 'the content is the url itself');
  assert.equal(s[0].description, 'A &lt;b&gt;bold&lt;/b&gt; title <url>https://a.example/?q=1&amp;b=2</url> <dim>dev</dim>');
  assert.equal(s[1].description, 'https://b.example <url>https://b.example</url>');
  assert.equal(omniboxSuggestions(Array.from({ length: 10 }, (_, i) => ({ url: `https://${i}.example` }))).length, 6);
});

test('a nonce is url safe and never the same twice', () => {
  const a = newNonce();
  assert.match(a, /^[A-Za-z0-9_-]{32}$/);
  assert.notEqual(a, newNonce());
  assert.equal(newNonce(new Uint8Array([251, 255, 191])), '-_-_');
});

test('the connect page carries the extension and the nonce, in the shape the app reads', async () => {
  const url = connectUrl('http://localhost:8080', 'a'.repeat(32), 'N'.repeat(32));
  assert.equal(url, `http://localhost:8080/#/connect/${'a'.repeat(32)}/${'N'.repeat(32)}`);
  // The app's side of the same contract, in web/js/settings.js.
  const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('../../web/js/settings.js', import.meta.url), 'utf8'));
  const re = new RegExp(/connect\\\/\(\[a-p\]\{32\}\)\\\/\(\[A-Za-z0-9_-\]\{16,64\}\)/.source);
  assert.match(src, re, 'settings.js reads #/connect/<id>/<nonce> with these patterns');
  assert.match(new URL(url).hash, /^#\/connect\/([a-p]{32})\/([A-Za-z0-9_-]{16,64})$/);
});

test('only the connection this extension started is taken', () => {
  const token = 'f'.repeat(64);
  const pending = { server: 'http://localhost:8080', nonce: 'n'.repeat(32), at: 1000 };
  const msg = { type: 'linksz-connect', nonce: pending.nonce, token };
  assert.equal(checkConnect(msg, 'http://localhost:8080', pending, 2000), '');
  assert.equal(checkConnect({ ...msg, type: 'other' }, 'http://localhost:8080', pending, 2000), 'not a connection');
  assert.equal(checkConnect(msg, 'http://localhost:8080', null, 2000), 'no connection is waiting');
  assert.equal(checkConnect(msg, 'http://localhost:8080', pending, 1000 + CONNECT_TTL + 1), 'the connection waited too long');
  assert.equal(checkConnect(msg, 'http://127.0.0.1:8080', pending, 2000), 'from another server');
  assert.equal(checkConnect({ ...msg, nonce: 'x'.repeat(32) }, 'http://localhost:8080', pending, 2000), 'another nonce');
  assert.equal(checkConnect({ ...msg, token: 'nope' }, 'http://localhost:8080', pending, 2000), 'no token');
});
