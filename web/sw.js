/* Service worker do Vaultmarks.
 *
 * Objetivo: a casca do app (HTML/CSS/JS/icones) abrir instantaneamente e
 * funcionar sem rede. Os dados continuam vindo da API — favorito e informacao
 * que muda e nao pode ser servida velha sem o usuario saber.
 *
 * Estrategias:
 *   navegacao   network-first  -> pega a versao nova; sem rede, cai no cache
 *   assets      stale-while-revalidate -> pinta na hora, atualiza atras
 *   /api/*      network-only   -> nunca cacheia resposta autenticada
 */
'use strict';

// Suba esta versao ao mudar qualquer arquivo da casca.
const VERSION = 'v2';
const SHELL_CACHE = `vaultmarks-shell-${VERSION}`;

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
      // addAll e tudo-ou-nada; individual evita que um 404 derrube a instalacao.
      .then((cache) => Promise.all(SHELL.map((url) => cache.add(url).catch(() => null))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith('vaultmarks-') && k !== SHELL_CACHE)
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

  // Sem cache, espera a rede; com cache, responde ja e atualiza atras.
  return cached || network.then((res) => {
    if (res) return res;
    throw new Error('offline e sem cache');
  });
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;  // favicons de terceiros
  if (isApi(url)) return;                            // dados sempre da rede

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
    return;
  }
  event.respondWith(staleWhileRevalidate(request));
});

// A pagina manda isso depois de atualizar, para nao esperar o proximo boot.
self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});
