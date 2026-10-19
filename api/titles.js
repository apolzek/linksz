'use strict';

// A title for a link nobody typed one for: the one the page gives itself, and
// when the page will not say, the one written into its address.
//
// The page is asked as what this is, not as a browser and not as somebody
// else's crawler. Sites that answer that (GitHub, YouTube, X, Amazon) give the
// real title; sites that answer it with a shell or a challenge (Mercado Livre,
// Magalu, anything behind Cloudflare's "Just a moment...") are recognised as
// such, and their slug is used instead: the words are right, the accents and
// the capitals are the slug's.
//
// Fetching a URL somebody pasted is how a server gets talked into reading its
// own network. Every address a name resolves to is checked when the socket
// connects, not before, so a redirect or a second DNS answer cannot slip a
// private one past it.

const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');
const net = require('node:net');
const zlib = require('node:zlib');

const USER_AGENT = 'Mozilla/5.0 (compatible; Bookmarks link preview; self-hosted)';
const TIMEOUT_MS = 6000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;

/* ---------------- which addresses may be fetched ---------------- */

function ipv4Parts(ip) {
  const parts = ip.split('.').map(Number);
  return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? parts : null;
}

// Loopback, the private ranges, link-local, CGNAT, multicast and the reserved
// blocks: nothing a link on the public web points at.
function isPublicAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ipv4Parts(ip);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    return true;
  }
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(low);
    if (mapped) return isPublicAddress(mapped[1]);
    if (low === '::' || low === '::1') return false;
    if (/^f[cd]/.test(low)) return false;          // unique local
    if (/^fe[89ab]/.test(low)) return false;       // link-local
    if (/^ff/.test(low)) return false;             // multicast
    if (low.startsWith('64:ff9b:') || low.startsWith('2001:db8')) return false;
    return true;
  }
  return false;
}

// dns.lookup with every answer checked. Passed to http.request as `lookup`, so
// it runs for the connection itself.
function guardedLookup(allow) {
  return (hostname, options, callback) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err);
      const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: options.family || 4 }];
      const blocked = list.find((a) => !allow(a.address));
      if (blocked || !list.length) {
        const e = new Error(`refusing to fetch ${hostname}: ${blocked ? blocked.address : 'no address'} is not public`);
        e.code = 'EBLOCKED';
        return callback(e);
      }
      if (options.all) return callback(null, list);
      return callback(null, list[0].address, list[0].family);
    });
  };
}

/* ---------------- fetching ---------------- */

function decoder(res) {
  const enc = String(res.headers['content-encoding'] || '').toLowerCase();
  if (enc === 'gzip' || enc === 'x-gzip') return res.pipe(zlib.createGunzip());
  if (enc === 'deflate') return res.pipe(zlib.createInflate());
  if (enc === 'br') return res.pipe(zlib.createBrotliDecompress());
  return res;
}

// The head of the page, as text: enough to hold the title, never the whole of
// a page that does not end.
function fetchHead(url, { allow, timeout, maxBytes }, hops = 0) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(new Error('not a url')); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return reject(new Error('only http and https'));
    // A literal address skips the lookup, so it is checked here.
    const literal = u.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(literal) && !allow(literal)) {
      const e = new Error(`refusing to fetch ${literal}: not public`);
      e.code = 'EBLOCKED';
      return reject(e);
    }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, {
      method: 'GET',
      lookup: guardedLookup(allow),
      timeout,
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
        'accept-language': 'pt-BR,pt;q=0.9,en;q=0.8',
        'accept-encoding': 'gzip, deflate, br',
      },
    }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (hops >= MAX_REDIRECTS) return reject(new Error('too many redirects'));
        const next = new URL(res.headers.location, u).toString();
        return fetchHead(next, { allow, timeout, maxBytes }, hops + 1).then(resolve, reject);
      }
      const type = String(res.headers['content-type'] || '');
      if (type && !/html|xml/i.test(type)) { res.resume(); return resolve({ status, html: '' }); }
      const body = decoder(res);
      const chunks = [];
      let size = 0;
      const done = () => resolve({ status, html: Buffer.concat(chunks).toString('utf8') });
      body.on('data', (chunk) => {
        chunks.push(chunk);
        size += chunk.length;
        // The title lives in the head; past it, or past the cap, stop reading.
        if (size > maxBytes || /<\/head>/i.test(chunk.toString('latin1'))) { req.destroy(); done(); }
      });
      body.on('end', done);
      body.on('error', () => done());
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end();
  });
}

/* ---------------- reading the title out of a page ---------------- */

function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

const squash = (s) => decodeEntities(s).replace(/\s+/g, ' ').trim();

function metaContent(html, name) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const key = /\b(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag);
    if (!key || key[1].toLowerCase() !== name) continue;
    const content = /\bcontent\s*=\s*"([^"]*)"|\bcontent\s*=\s*'([^']*)'/i.exec(tag);
    if (content) return squash(content[1] ?? content[2]);
  }
  return '';
}

// og:title is what a site wants a shared link called, so it comes first; the
// <title> is the fallback, because it usually carries the site's name too. X
// is the other way round: its og:title is the account, its <title> the post.
function titleInHtml(html, url = '') {
  const t = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const tag = t ? squash(t[1]) : '';
  const host = hostOf(url);
  if (tag && (isHost(host, 'x.com') || isHost(host, 'twitter.com'))) return tag;
  return metaContent(html, 'og:title') || metaContent(html, 'twitter:title') || tag;
}

/* ---------------- the house rules of the big sites ---------------- */

const hostOf = (url) => {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
};
const isHost = (host, domain) => host === domain || host.endsWith(`.${domain}`);

// Pages that are a site's answer to a robot, not to the link: a challenge, a
// shell, an error. Their title is no title.
const GENERIC = [
  /^just a moment/i, /^attention required/i, /^access denied/i, /^forbidden/i, /captcha/i,
  /^robot check/i, /^are you a robot/i, /^security check/i, /^verifica/i, /^one more step/i,
  /not found/i, /^n[ãa]o foi poss[íi]vel/i, /^p[áa]gina n[ãa]o encontrada/i, /^error\b/i, /^erro\b/i,
  /^\d{3}\b/, /^(mercado (libre|livre))$/i, /^amazon(\.com)?(\.[a-z.]+)?$/i, /^magazine luiza/i,
  /^youtube$/i, /^x$/i, /^twitter$/i, /^instagram$/i, /^log ?in\b/i, /^sign in\b/i, /^entrar\b/i,
];

function isGeneric(title, url) {
  if (!title) return true;
  if (GENERIC.some((re) => re.test(title))) return true;
  // The site's own name and nothing else.
  const brand = hostOf(url).split('.')[0];
  return brand.length > 2 && title.toLowerCase().replace(/[^a-z0-9]/g, '') === brand.replace(/[^a-z0-9]/g, '');
}

// What a site wraps around a title: "GitHub - ", " - YouTube", " : authors :
// Amazon.com.br: Livros", " | Medium". Taken off when it names the site.
function cleanTitle(raw, url) {
  let t = squash(raw);
  const host = hostOf(url);
  if (isHost(host, 'github.com')) t = t.replace(/^GitHub - /, '');
  if (isHost(host, 'youtube.com') || host === 'youtu.be') t = t.replace(/ - YouTube$/, '');
  if (/^amazon\./.test(host) || /\.amazon\./.test(host)) {
    // "Title : Authors : Amazon.com.br: Livros", or "Amazon.com.br: Title".
    t = t.replace(/^Amazon\.[a-z.]+\s*:\s*/i, '');
    if (/ : /.test(t)) t = t.split(' : ')[0];
    t = t.replace(/\s*[:|-]\s*Amazon\.[a-z.]+.*$/i, '');
  }
  if (isHost(host, 'x.com') || isHost(host, 'twitter.com')) {
    // "Name on X: "the post"": the post is the thing.
    t = t.replace(/\s+\/\s+X$/, '');
    const post = /^(.+?) (?:on|no|en) X: ["“](.+?)["”]?$/s.exec(t);
    if (post) t = `${post[1]}: ${post[2]}`;
  }
  // A trailing " | Site" or " - Site" that names the host.
  const brand = host.split('.').slice(-3, -1).join('').replace(/[^a-z0-9]/g, '');
  const tail = /\s+[|\-–—·]\s+([^|\-–—·]+)$/.exec(t);
  if (tail && brand.length > 2) {
    const name = tail[1].toLowerCase().replace(/[^a-z0-9]/g, '');
    if (name && (brand.includes(name) || name.includes(brand))) t = t.slice(0, tail.index);
  }
  return t.trim();
}

/* ---------------- a title out of the address ---------------- */

const SMALL = new Set(['a', 'o', 'as', 'os', 'e', 'de', 'da', 'do', 'das', 'dos', 'em', 'na', 'no', 'com', 'para',
  'por', 'the', 'of', 'and', 'in', 'on', 'for', 'to', 'with', 'y', 'la', 'el', 'en', 'del']);

// "drone-xiaomi-fimi-mini-3-4k-60fps-camera-48mp" -> "Drone Xiaomi Fimi Mini 3
// 4K 60fps Camera 48MP": words capitalised, short connectives left small,
// resolutions and megapixels in capitals the way shops write them.
function humanize(slug) {
  const words = decodeURIComponent(slug).replace(/[-_+]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  return words.map((w, i) => {
    const lower = w.toLowerCase();
    if (/^\d+(k|mp|gb|tb|mb|mah|hz|w|v)$/i.test(w)) return w.replace(/[a-z]+$/i, (u) => u.toUpperCase());
    if (i > 0 && SMALL.has(lower)) return lower;
    if (/\d/.test(w)) return lower;
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  }).join(' ');
}

// A slug worth reading: two words at least, letters in it, not an id.
const readable = (s) => s && /[a-z]/i.test(s) && /[-_]/.test(s) && s.split(/[-_]+/).filter(Boolean).length >= 2
  && !/^[0-9a-f-]{20,}$/i.test(s);

function titleFromUrl(url) {
  let u;
  try { u = new URL(url); } catch { return ''; }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const segs = u.pathname.split('/').filter(Boolean);

  if (/mercadoli[bv]re\./.test(host)) {
    // /slug/p/MLB123, or produto.mercadolivre.com.br/MLB-123-slug-_JM
    const p = segs.indexOf('p');
    if (p > 0 && readable(segs[p - 1])) return humanize(segs[p - 1]);
    const item = segs.map((s) => /^ML[A-Z]-?\d+-(.+?)(?:-_JM)?$/.exec(s)).find(Boolean);
    if (item) return humanize(item[1]);
  }
  if (/(^|\.)amazon\./.test(host)) {
    const dp = segs.findIndex((s) => s === 'dp' || s === 'gp');
    if (dp > 0 && readable(segs[dp - 1])) return humanize(segs[dp - 1]);
  }
  if (/magazineluiza\.com\.br$/.test(host)) {
    const p = segs.indexOf('p');
    if (p > 0 && readable(segs[p - 1])) return humanize(segs[p - 1]);
  }
  if (host === 'github.com' && segs.length >= 2) return `${segs[0]}/${segs[1]}`;
  // LinkedIn answers anything not signed in with a 999, so the profile's name
  // is out of reach; its handle is what the address has.
  if (host.endsWith('linkedin.com') && (segs[0] === 'in' || segs[0] === 'company') && segs[1]) {
    return segs[0] === 'in' ? `${decodeURIComponent(segs[1])} (LinkedIn)` : `${humanize(segs[1])} (LinkedIn)`;
  }
  if (host === 'medium.com' || host.endsWith('.medium.com')) {
    const last = segs[segs.length - 1] || '';
    const slug = last.replace(/-[0-9a-f]{8,}$/, '');
    if (readable(slug)) return humanize(slug);
  }
  // Anywhere else: the last part of the path that reads as words.
  for (let i = segs.length - 1; i >= 0; i--) {
    const s = segs[i].replace(/\.(html?|php|aspx?)$/i, '');
    if (readable(s)) return humanize(s);
  }
  return '';
}

/* ---------------- together ---------------- */

// Never throws: a page that cannot be read is a title from the address, and an
// address with no words in it is no title at all.
async function titleFor(url, { allow = isPublicAddress, timeout = TIMEOUT_MS, maxBytes = MAX_BYTES } = {}) {
  try {
    const { status, html } = await fetchHead(url, { allow, timeout, maxBytes });
    if (status >= 200 && status < 300 && html) {
      const title = cleanTitle(titleInHtml(html, url), url);
      if (!isGeneric(title, url)) return { title, source: 'page' };
    }
  } catch { /* unreachable, blocked or broken: the address is what is left */ }
  const fromUrl = titleFromUrl(url);
  return { title: fromUrl, source: fromUrl ? 'url' : 'none' };
}

module.exports = { titleFor, titleFromUrl, titleInHtml, cleanTitle, isGeneric, isPublicAddress, humanize };
