const CACHE_NAME = 'adamdh7v4';
const IMAGE_CACHE = 'adamdh7.png';
const JSON_CACHE = 'adamdh7v2';
const VIDEO_CACHE = 'adamdh7v1';
const OFFLINE_URL = '/offline.html';
const PLACEHOLDER = '/placeholder.jpg';

const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.json',
  OFFLINE_URL,
  '/styles.css',
  '/main.js',
  PLACEHOLDER
];

const AVOID_CACHE_DOMAINS = [
  'adsterra.com',
  'ads.adsterra.com',
  'pantherinvincible.com',
  'adserver.',
  'doubleclick.net',
  'googleads.g.doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'adservice.google.com',
  'adsystem.com',
  'adroll.com',
  'adsafeprotected.com',
  'openx.net',
  'rubiconproject.com',
  'adnxs.com',
  'amazon-adsystem.com',
  'yieldlab.net',
  'adaplex.net',
  '/ad-',
  '/ads/',
  '/ads?',
  'ad_content'
];

function normalizeUrl(u){
  return new URL(u, self.location.origin).toString();
}

function shouldBypass(url){
  if(!url) return false;
  const s = url.toString().toLowerCase();
  return AVOID_CACHE_DOMAINS.some(d => d && s.includes(d));
}

async function pool(limit, tasks) {
  const executing = [];
  for (const task of tasks) {
    const p = task().finally(() => executing.splice(executing.indexOf(p), 1));
    executing.push(p);
    if (executing.length >= limit) await Promise.race(executing);
  }
  await Promise.allSettled(executing);
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);

    await Promise.allSettled(
      PRECACHE_URLS
        .filter(u => !shouldBypass(u))
        .map(async u => {
          const r = await fetch(u, { cache: 'no-cache' });
          if (r && (r.ok || r.type === 'opaque')) {
            await cache.put(new Request(u), r.clone());
          }
        })
    );

    try {
      const resp = await fetch('/index.json', { cache: 'no-cache' });
      if (!resp || (!resp.ok && resp.type !== 'opaque')) return;

      const index = await resp.json();
      const imageCache = await caches.open(IMAGE_CACHE);
      const jsonCache = await caches.open(JSON_CACHE);
      const urls = new Set();

      if (Array.isArray(index)) {
        index.forEach(it => {
          if (it['Url Thumb']) urls.add(normalizeUrl(it['Url Thumb']));
          if (it['Url']) urls.add(normalizeUrl(it['Url']));
          if (it.image) urls.add(normalizeUrl(it.image));
        });
      } else {
        Object.values(index).forEach(v => {
          if (typeof v === 'string') urls.add(normalizeUrl(v));
        });
      }

      await pool(4, Array.from(urls).map(u => async () => {
        if (shouldBypass(u)) return;
        const r = await fetch(u).catch(() => null);
        if (!r || (!r.ok && r.type !== 'opaque')) return;
        const req = new Request(u);
        if (u.endsWith('.json')) await jsonCache.put(req, r.clone());
        else if (/\.(jpg|jpeg|png|webp)$/i.test(u)) await imageCache.put(req, r.clone());
      }));

    } catch(e) {}

    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.map(k => {
        if (![CACHE_NAME, IMAGE_CACHE, JSON_CACHE, VIDEO_CACHE].includes(k)) {
          return caches.delete(k);
        }
      })
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  if (req.destination === 'video' || /\.(mp4|webm|ogg|mov)$/i.test(req.url)) {
    event.respondWith(fetch(req));
    return;
  }

  if (shouldBypass(req.url)) {
    event.respondWith(
      fetch(req).catch(() =>
        req.mode === 'navigate'
          ? caches.match(OFFLINE_URL)
          : new Response(null, { status: 504 })
      )
    );
    return;
  }

  if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
    event.respondWith(networkFirst(req));
    return;
  }

  if (req.destination === 'image' || /\.(png|jpg|jpeg|webp|gif)$/i.test(req.url)) {
    event.respondWith(cacheFirstWithFallback(req, IMAGE_CACHE, PLACEHOLDER));
    return;
  }

  if (req.url.endsWith('.json')) {
    event.respondWith(networkFirst(req, JSON_CACHE));
    return;
  }

  event.respondWith(cacheFirst(req));
});

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  const resp = await fetch(request).catch(() => null);
  if (resp && (resp.ok || resp.type === 'opaque') && !shouldBypass(request.url)) {
    await cache.put(request, resp.clone());
  }
  return resp || caches.match(OFFLINE_URL);
}

async function networkFirst(request, cacheName = CACHE_NAME) {
  const cache = await caches.open(cacheName);
  try {
    const resp = await fetch(request);
    if (resp && (resp.ok || resp.type === 'opaque') && !shouldBypass(request.url)) {
      await cache.put(request, resp.clone());
    }
    return resp;
  } catch {
    return (await cache.match(request)) || caches.match(OFFLINE_URL);
  }
}

async function cacheFirstWithFallback(request, cacheName, fallbackUrl) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const resp = await fetch(request).catch(() => null);
  if (resp && (resp.ok || resp.type === 'opaque') && !shouldBypass(request.url)) {
    await cache.put(request, resp.clone());
    return resp;
  }
  return resp || caches.match(fallbackUrl);
}
