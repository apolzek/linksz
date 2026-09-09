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
const VERSION = 'v55';
const SHELL_CACHE = `bookmarks-shell-${VERSION}`;

const SHELL = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/search.js',
  '/manifest.webmanifest',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
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
        keys.filter((k) => k.startsWith('bookmarks-') && k !== SHELL_CACHE)
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
  try {
    const fresh = await fetch(request);
    if (fresh.ok) cache.put(request, fresh.clone());
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
