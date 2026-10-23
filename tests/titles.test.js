'use strict';

// Titles for pasted links: the page's own, cleaned of what each site wraps
// around it, or the words in the address. All offline: the pages are served
// here, on loopback, which only these tests are allowed to fetch.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const zlib = require('node:zlib');

const t = require('../api/titles');

const ML = 'https://www.mercadolivre.com.br/drone-xiaomi-fimi-mini-3-4k-60fps-camera-48mp-gimbal-3-eixos-laranja/p/MLB44999506'
  + '?pdp_filters=item_id%3AMLB4639619744#polycard_client=search-desktop&position=1';

/* ---------------- out of the address ---------------- */

test('mercado livre: the product slug, shop-style capitals', () => {
  assert.equal(t.titleFromUrl(ML), 'Drone Xiaomi Fimi Mini 3 4K 60fps Camera 48MP Gimbal 3 Eixos Laranja');
  assert.equal(t.titleFromUrl('https://produto.mercadolivre.com.br/MLB-1234567-fone-bluetooth-sem-fio-_JM'),
    'Fone Bluetooth Sem Fio');
});

test('amazon, magalu and medium read their slugs', () => {
  assert.equal(t.titleFromUrl('https://www.amazon.com.br/Profeta-Khalil-Gibran/dp/8568871038'), 'Profeta Khalil Gibran');
  assert.equal(t.titleFromUrl('https://www.magazineluiza.com.br/smartphone-samsung-galaxy-a15/p/238052400/te/ga15/'),
    'Smartphone Samsung Galaxy a15');
  assert.equal(t.titleFromUrl('https://medium.com/@someone/how-to-write-a-parser-3f2a9c1b7e4d'), 'How to Write a Parser');
});

test('github is owner/repo, linkedin its handle', () => {
  assert.equal(t.titleFromUrl('https://github.com/autobrr/netronome/issues/3'), 'autobrr/netronome');
  assert.equal(t.titleFromUrl('https://www.linkedin.com/in/oldpiratebr/'), 'oldpiratebr (LinkedIn)');
  assert.equal(t.titleFromUrl('https://www.linkedin.com/company/some-company/'), 'Some Company (LinkedIn)');
});

test('anywhere else, the last part of the path that reads as words', () => {
  assert.equal(t.titleFromUrl('https://blog.example.com/2024/05/the-art-of-unix-programming.html'), 'The Art of Unix Programming');
  assert.equal(t.titleFromUrl('https://example.com/watch?v=abc'), '', 'no words, no title');
  assert.equal(t.titleFromUrl('https://example.com/a/123456'), '');
  assert.equal(t.titleFromUrl('https://example.com/3f2a9c1b-7e4d-4a1b-9c3d-123456789abc'), '', 'an id is not words');
  assert.equal(t.titleFromUrl('not a url'), '');
});

/* ---------------- out of the page ---------------- */

test('og:title first, then <title>, entities decoded', () => {
  assert.equal(t.titleInHtml('<title>Plain</title><meta property="og:title" content="From &quot;OG&quot;">'), 'From "OG"');
  assert.equal(t.titleInHtml("<meta content='Reversed' name='twitter:title'>"), 'Reversed');
  assert.equal(t.titleInHtml('<title>\n  Spaced &amp; out\n</title>'), 'Spaced & out');
  assert.equal(t.titleInHtml('<p>no title</p>'), '');
});

test('on x the <title> carries the post, and wins', () => {
  const html = '<title>Starter Story no X: &quot;Marc Lou builds things…&quot; / X</title>'
    + '<meta property="og:title" content="Starter Story (@starter_story) no X">';
  const url = 'https://x.com/starter_story/status/1';
  assert.equal(t.cleanTitle(t.titleInHtml(html, url), url), 'Starter Story: Marc Lou builds things…');
});

test('what the big sites wrap around a title comes off', () => {
  assert.equal(t.cleanTitle('O Profeta - Khalil Gibran: Edição Integral : Gibran, Khalil, Barros, Lígia: Amazon.com.br: Livros',
    'https://www.amazon.com.br/Profeta-Khalil-Gibran/dp/8568871038'), 'O Profeta - Khalil Gibran: Edição Integral');
  assert.equal(t.cleanTitle('Amazon.com: Some Book', 'https://www.amazon.com/dp/1'), 'Some Book');
  assert.equal(t.cleanTitle('GitHub - autobrr/netronome: a speed tool', 'https://github.com/autobrr/netronome'),
    'autobrr/netronome: a speed tool');
  assert.equal(t.cleanTitle('A video - YouTube', 'https://www.youtube.com/watch?v=1'), 'A video');
  assert.equal(t.cleanTitle('Writing a parser | Medium', 'https://medium.com/@a/b'), 'Writing a parser');
  assert.equal(t.cleanTitle('Docs - Kubernetes', 'https://kubernetes.io/docs/'), 'Docs');
  assert.equal(t.cleanTitle('Rust - the language', 'https://example.com/rust'), 'Rust - the language',
    'a dash that does not name the site stays');
});

test('a challenge, a shell or an error is no title', () => {
  for (const s of ['Just a moment...', 'Attention Required! | Cloudflare', 'Access Denied', 'Mercado Libre',
    'Não foi possível encontrar esta página', '404 Not Found', 'Robot Check', '', 'Sign in']) {
    assert.ok(t.isGeneric(s, 'https://www.mercadolivre.com.br/x'), s);
  }
  assert.ok(t.isGeneric('Medium', 'https://medium.com/x'), 'the site name alone');
  assert.ok(!t.isGeneric('O Profeta - Khalil Gibran', 'https://www.amazon.com.br/x'));
});

/* ---------------- which addresses may be fetched ---------------- */

test('only public addresses are fetched', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', 'nonsense']) {
    assert.equal(t.isPublicAddress(ip), false, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(t.isPublicAddress(ip), true, ip);
  }
});

/* ---------------- fetching, against pages served here ---------------- */

let server;
let base;
let hits = 0;
const pages = {
  '/amazon': { body: '<html><head><title>O Profeta - Khalil Gibran: Edição Integral : Gibran: Amazon.com.br: Livros</title></head></html>' },
  '/gzip': { body: '<head><meta property="og:title" content="Compressed &amp; fine"></head>', gzip: true },
  '/challenge/the-real-article-name': { body: '<title>Just a moment...</title>' },
  '/missing/some-gone-page': { status: 404, body: '<title>Some gone page</title>' },
  '/json': { body: '{"title":"no"}', type: 'application/json' },
  '/hop': { status: 302, location: '/amazon' },
  '/loop': { status: 302, location: '/loop' },
  '/to-private': { status: 302, location: 'http://10.255.255.1/secret' },
  '/slow/a-slow-page-title': { slow: true },
};

test.before(async () => {
  server = http.createServer((req, res) => {
    hits += 1;
    const page = pages[req.url];
    if (!page) { res.writeHead(404); return res.end(); }
    if (page.slow) return; // never answers
    if (page.location) { res.writeHead(page.status, { location: page.location }); return res.end(); }
    const headers = { 'content-type': page.type || 'text/html; charset=utf-8' };
    let body = Buffer.from(page.body);
    if (page.gzip) { body = zlib.gzipSync(body); headers['content-encoding'] = 'gzip'; }
    res.writeHead(page.status || 200, headers);
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server.close());

const loopbackOnly = { allow: (ip) => ip === '127.0.0.1', timeout: 800 };

test('the page title, compressed or not', async () => {
  assert.deepEqual(await t.titleFor(`${base}/gzip`, loopbackOnly), { title: 'Compressed & fine', source: 'page' });
});

test('redirects are followed', async () => {
  const r = await t.titleFor(`${base}/hop`, loopbackOnly);
  assert.equal(r.source, 'page');
  assert.match(r.title, /^O Profeta - Khalil Gibran/);
});

test('a challenge, an error or a non-html answer falls back to the address', async () => {
  assert.deepEqual(await t.titleFor(`${base}/challenge/the-real-article-name`, loopbackOnly),
    { title: 'The Real Article Name', source: 'url' });
  assert.deepEqual(await t.titleFor(`${base}/missing/some-gone-page`, loopbackOnly),
    { title: 'Some Gone Page', source: 'url' }, 'a 404 is not the page');
  assert.deepEqual(await t.titleFor(`${base}/json`, loopbackOnly), { title: '', source: 'none' });
});

test('a redirect loop and a page that never answers end, with the address', async () => {
  assert.equal((await t.titleFor(`${base}/loop`, loopbackOnly)).source, 'none');
  const started = Date.now();
  assert.deepEqual(await t.titleFor(`${base}/slow/a-slow-page-title`, loopbackOnly),
    { title: 'A Slow Page Title', source: 'url' });
  assert.ok(Date.now() - started < 3000, 'the timeout holds');
});

test('a private address is never contacted, directly or through a redirect', async () => {
  const before = hits;
  assert.equal((await t.titleFor(`${base}/gzip`)).source, 'none', 'loopback is refused by default');
  assert.equal(hits, before, 'and the server never saw the request');
  assert.equal((await t.titleFor('http://localhost:1/x')).source, 'none', 'a name that resolves to loopback too');
  const viaHop = await t.titleFor(`${base}/to-private`, loopbackOnly);
  assert.deepEqual(viaHop, { title: 'To Private', source: 'url' }, 'a redirect to a private address is not followed');
});

test('only http and https', async () => {
  assert.equal((await t.titleFor('file:///etc/passwd')).source, 'none');
  assert.equal((await t.titleFor('ftp://example.com/some-file-name')).title, 'Some File Name', 'the address still reads');
});

/* ---------------- previews ---------------- */

test('a frame only where the site says every origin may show it', () => {
  assert.equal(t.frameable({}), true, 'nothing said, nothing refused');
  assert.equal(t.frameable({ 'x-frame-options': 'DENY' }), false);
  assert.equal(t.frameable({ 'x-frame-options': 'sameorigin' }), false);
  assert.equal(t.frameable({ 'x-frame-options': 'ALLOW-FROM https://a.example' }), false);
  assert.equal(t.frameable({ 'content-security-policy': "default-src 'self'; frame-ancestors 'none'" }), false);
  assert.equal(t.frameable({ 'content-security-policy': "frame-ancestors 'self' https://*.example.com" }), false,
    'naming origins is not naming this one');
  assert.equal(t.frameable({ 'content-security-policy': 'frame-ancestors *' }), true);
  assert.equal(t.frameable({ 'content-security-policy': "script-src 'self'" }), true, 'other directives do not count');
  assert.equal(t.frameable({ 'content-security-policy': ["frame-ancestors *", "frame-ancestors 'none'"] }), false,
    'two policies: both must allow it');
});

test('a preview reads the card off the page, and the frame off its headers', async () => {
  const pages = http.createServer((req, res) => {
    if (req.url === '/open') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(`<head><title>Open page | Example</title>
        <meta property="og:description" content="What it is &amp; why.">
        <meta property="og:image" content="/cover.png"><meta property="og:site_name" content="Example">
        <link rel="icon" href="/fav.svg"></head>`);
    }
    if (req.url === '/closed') {
      res.writeHead(200, { 'content-type': 'text/html', 'x-frame-options': 'DENY' });
      return res.end('<head><meta name="description" content="Plain description"><title>Closed page</title></head>');
    }
    if (req.url === '/moved') { res.writeHead(301, { location: '/open' }); return res.end(); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => pages.listen(0, '127.0.0.1', r));
  const at = `http://127.0.0.1:${pages.address().port}`;
  try {
    const open = await t.previewFor(`${at}/open`, loopbackOnly);
    assert.deepEqual(open, {
      url: `${at}/open`, final_url: `${at}/open`, title: 'Open page | Example', description: 'What it is & why.',
      image: `${at}/cover.png`, icon: `${at}/fav.svg`, site: 'Example', frame: true,
    });

    const closed = await t.previewFor(`${at}/closed`, loopbackOnly);
    assert.equal(closed.frame, false);
    assert.equal(closed.description, 'Plain description');
    assert.equal(closed.icon, `${at}/favicon.ico`, 'no icon named, the usual place');

    const moved = await t.previewFor(`${at}/moved`, loopbackOnly);
    assert.equal(moved.final_url, `${at}/open`, 'the frame loads where the link ends up');
    assert.equal(moved.url, `${at}/moved`);

    const gone = await t.previewFor(`${at}/missing/an-old-article`, loopbackOnly);
    assert.equal(gone.frame, false, 'an error page is not framed');
    assert.equal(gone.title, 'An Old Article');
  } finally { pages.close(); }
});

test('a preview never reaches a private address, and never throws', async () => {
  const before = hits;
  const r = await t.previewFor(`${base}/gzip`);
  assert.equal(r.frame, false);
  assert.equal(r.description, '');
  assert.equal(hits, before, 'the server never saw the request');
  assert.equal((await t.previewFor('not a url')).frame, false);
});
