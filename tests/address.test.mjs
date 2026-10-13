// Saving from the address bar: the link read out of the app's own address, and
// the rule that decides which paths get the app at all.
//
// Three places decide about the same address: web/js/address.js in the browser,
// LINK_PATH in api/server.js and the @link location in web/nginx.conf. These
// tests hold them to one answer.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { linkFromAddress, sameLink, bookmarklet, TEMP_FOLDER } from '../web/js/address.js';

const require = createRequire(import.meta.url);
const { LINK_PATH } = require('../api/server.js');

// The address the way `location` has it: path, query and hash apart.
const at = (address) => {
  const u = new URL(address, 'http://localhost:8080');
  return { pathname: u.pathname, search: u.search, hash: u.hash };
};
const link = (address) => linkFromAddress(at(address));

/* ---------------- reading the link ---------------- */

test('a full link after the address is read back whole', () => {
  assert.equal(link('/https://www.youtube.com/watch?v=_Hkdzzx15PI'), 'https://www.youtube.com/watch?v=_Hkdzzx15PI');
  assert.equal(link('/http://example.com/a/b'), 'http://example.com/a/b');
});

test('the query and the hash belong to the link, not the app', () => {
  assert.equal(link('/https://www.youtube.com/watch?v=_Hkdzzx15PI&t=30#comments'),
    'https://www.youtube.com/watch?v=_Hkdzzx15PI&t=30#comments');
});

test('without a scheme the link is https', () => {
  assert.equal(link('/www.youtube.com/watch?v=x'), 'https://www.youtube.com/watch?v=x');
  assert.equal(link('/example.com'), 'https://example.com');
});

test('the slashes after the scheme are read as two, however many arrive', () => {
  assert.equal(link('/https:/example.com/x'), 'https://example.com/x');
  assert.equal(link('/https:///example.com/x'), 'https://example.com/x');
  assert.equal(link('/HTTPS://example.com'), 'HTTPS://example.com');
});

test('the app itself, and paths that are not links, read as no link', () => {
  for (const p of ['/', '/index.html', '/nothing', '/js/nothing', '/https://', '/https:/nohost', '/localhost/x']) {
    assert.equal(link(p), '', `${p} is not a link`);
  }
  assert.equal(linkFromAddress(), '');
});

test('saved links go to Temporary', () => {
  assert.equal(TEMP_FOLDER, 'Temporary');
});

/* ---------------- the same link twice ---------------- */

test('a trailing slash does not make a second bookmark', () => {
  assert.ok(sameLink('https://example.com/', 'https://example.com'));
  assert.ok(sameLink('https://example.com/a', 'https://example.com/a'));
});

test('anything else does', () => {
  assert.ok(!sameLink('https://example.com/a', 'https://example.com/b'));
  assert.ok(!sameLink('https://example.com/?v=1', 'https://example.com/?v=2'));
  assert.ok(!sameLink('http://example.com', 'https://example.com'));
  assert.ok(!sameLink('', ''), 'two empty links are not a match');
});

/* ---------------- the bookmarklet ---------------- */

test('the bookmarklet opens the prefix plus the page in a new tab', () => {
  const href = bookmarklet('http://localhost:8080/');
  assert.match(href, /^javascript:/);
  let opened = null;
  new Function('open', 'location', href.slice('javascript:'.length))(
    (u) => { opened = u; }, { href: 'https://www.youtube.com/watch?v=x' });
  assert.equal(opened, 'http://localhost:8080/https://www.youtube.com/watch?v=x');
});

test('a prefix with a quote in it stays a string', () => {
  let opened = null;
  new Function('open', 'location', bookmarklet(`http://x/'");alert(1);//`).slice('javascript:'.length))(
    (u) => { opened = u; }, { href: 'p' });
  assert.equal(opened, `http://x/'");alert(1);//p`);
});

/* ---------------- app, server and nginx agree ---------------- */

const nginxRule = (() => {
  const conf = fs.readFileSync(new URL('../web/nginx.conf', import.meta.url), 'utf8');
  const m = /location @link \{\s*if \(\$uri !~\* "([^"]+)"\)/.exec(conf);
  assert.ok(m, 'the @link rule is where this test expects it');
  return new RegExp(m[1], 'i');
})();

// nginx tests $uri, which has the slashes merged and no query.
const merged = (address) => at(address).pathname.replace(/\/{2,}/g, '/');

const ADDRESSES = [
  '/https://www.youtube.com/watch?v=_Hkdzzx15PI', '/http://example.com', '/https:/example.com/x',
  '/www.youtube.com/watch?v=x', '/example.com', '/example.com:8443/x', '/sub.example.co.uk/a/b',
  '/', '/nothing', '/js/nothing', '/app.js', '/index.html', '/api/health', '/-/x',
];

test('nginx and the node server send the same paths to the app', () => {
  for (const a of ADDRESSES) {
    assert.equal(nginxRule.test(merged(a)), LINK_PATH.test(at(a).pathname), `${a}: nginx and node disagree`);
  }
});

test('every address the app reads a link from is one the servers send to it', () => {
  for (const a of ADDRESSES) {
    if (!link(a)) continue;
    assert.ok(LINK_PATH.test(at(a).pathname), `${a}: node would not serve the app`);
    assert.ok(nginxRule.test(merged(a)), `${a}: nginx would not serve the app`);
  }
});
