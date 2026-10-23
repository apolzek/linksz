/* Service worker.
 *
 * Goal: the app shell (HTML/CSS/JS/icons) opens instantly and works with no
 * network. Data still comes from the API, because a bookmark is information
 * that changes and must not be served stale without the user knowing.
 *
 * Strategies:
 *   navigation  network-first          -> takes the new version; offline, falls back to cache
 *   assets      stale-while-revalidate -> paints at once, refreshes behind
 *   /api/*      network-only           -> never caches an authenticated response
 */
'use strict';

// Bump this version whenever a shell file changes.
const VERSION = 'v80';
const SHELL_CACHE = `linksz-shell-${VERSION}`;

const SHELL = [
  '/',
  '/index.html',
  '/style.css',
  '/themes.css',
  '/app.js',
  '/search.js',
  '/js/http.js',
  '/js/store.js',
  '/js/ui.js',
  '/js/links.js',
  '/js/organize.js',
  '/js/tree.js',
  '/js/editor.js',
  '/js/activity.js',
  '/js/audit.js',
  '/js/clicklog.js',
  '/js/data.js',
  '/js/settings.js',
  '/js/searchlog.js',
  '/js/stamp.js',
  '/js/themes.js',
  '/js/address.js',
  '/js/preview.js',
  '/manifest.webmanifest',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/fonts/oxygen-400.woff2',
  '/fonts/oxygen-700.woff2',
  '/fonts/jetbrains-mono.woff2',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      // addAll is all-or-nothing; going one by one keeps a 404 from failing the install.
      .then((cache) => Promise.all(SHELL.map((url) => cache.add(url).catch(() => null))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => /^(linksz|bookmarks)-/.test(k) && k !== SHELL_CACHE)
          .map((k) => caches.delete(k)),
      ))
      .then(() => self.clients.claim()),
  );
});

function isApi(url) {
  return url.pathname.startsWith('/api/');
}

async function networkFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  // Only the shell's own pages are kept. Every link saved by putting this
  // address in front of it is a navigation too, and each would be one more
  // copy of index.html in the cache.
  const keep = SHELL.includes(new URL(request.url).pathname);
  try {
    const fresh = await fetch(request);
    if (fresh.ok && keep) cache.put(request, fresh.clone());
    return fresh;
  } catch (err) {
    const cached = await cache.match(request) || await cache.match('/index.html');
    if (cached) return cached;
    throw err;
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);

  const network = fetch(request)
    .then((res) => {
      if (res.ok) cache.put(request, res.clone());
      return res;
    })
    .catch(() => null);

  // With no cache, wait for the network; with cache, answer now and refresh behind.
  return cached || network.then((res) => {
    if (res) return res;
    throw new Error('offline and not cached');
  });
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;  // third-party favicons
  if (isApi(url)) return;                            // data always from the network

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
    return;
  }
  event.respondWith(staleWhileRevalidate(request));
});
