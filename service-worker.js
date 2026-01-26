const CACHE_NAME = 'adam-core-v7';
const IMAGE_CACHE = 'adam-images-v7';
const JSON_CACHE = 'adam-data-v7';
const VIDEO_CACHE = 'adam-videos-v7';
const OFFLINE_URL = '/offline.html';
const PLACEHOLDER = '/asset/192.png';

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
  'adsterra.com', 'ads.adsterra.com', 'pantherinvincible.com', 'adserver.',
  'doubleclick.net', 'googleads.g.doubleclick.net', 'googlesyndication.com',
  'googleadservices.com', 'adservice.google.com', 'adsystem.com', 'adroll.com',
  'adsafeprotected.com', 'openx.net', 'rubiconproject.com', 'adnxs.com',
  'amazon-adsystem.com', 'yieldlab.net', 'adaplex.net', '/ad-', '/ads/', '/ads?', 'ad_content'
];

function normalizeUrl(u){
  try {
    const url = new URL(u, self.location.origin);
    return url.href;
  } catch(e) {
    return u;
  }
}

function shouldBypass(url){
  if(!url) return false;
  const s = url.toString().toLowerCase();
  return AVOID_CACHE_DOMAINS.some(d => s.includes(d));
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.allSettled(
      PRECACHE_URLS
        .filter(u => !shouldBypass(u))
        .map(u =>
          fetch(u, {cache: 'no-cache'}).then(res => {
            if (!res.ok && res.type !== 'opaque') throw new Error(`${u} -> ${res.status}`);
            return cache.put(u, res.clone());
          }).catch(() => {})
        )
    );

    try {
      const resp = await fetch('/index.json', {cache: 'no-cache'});
      if (resp && resp.ok) {
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
        }
        await Promise.allSettled(Array.from(urls).map(u => {
          if (shouldBypass(u)) return Promise.resolve();
          const targetCache = u.endsWith('.json') ? jsonCache : imageCache;
          return fetch(u).then(r => { 
            if(r && (r.ok || r.type === 'opaque')) return targetCache.put(u, r.clone()); 
          }).catch(()=>{});
        }));
      }
    } catch (e) {}
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', evt => {
  evt.waitUntil((async () => {
    const keys = await caches.keys();
    const activeCaches = [CACHE_NAME, IMAGE_CACHE, JSON_CACHE, VIDEO_CACHE];
    await Promise.all(keys.map(k => {
      if (!activeCaches.includes(k)) return caches.delete(k);
    }));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (req.destination === 'video' || /\.(mp4|webm|ogg|mov)$/i.test(req.url)) return;
  if (shouldBypass(req.url)) {
    event.respondWith(
      fetch(req).catch(() => {
        if (req.mode === 'navigate') return caches.match(OFFLINE_URL);
        return new Response(null, { status: 504 });
      })
    );
    return;
  }
  if (req.mode === 'navigate' || (req.headers.get('accept')||'').includes('text/html')) {
    event.respondWith(networkFirst(req));
    return;
  }
  if (req.destination === 'image' || /\.(png|jpg|jpeg|webp|gif)$/.test(req.url)) {
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
  try {
    const resp = await fetch(request);
    if (resp && (resp.ok || resp.type === 'opaque') && !shouldBypass(request.url)) {
      cache.put(request, resp.clone()).catch(()=>{});
    }
    return resp;
  } catch (e) {
    return caches.match(OFFLINE_URL);
  }
}

async function networkFirst(request, cacheName = CACHE_NAME) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response && (response.ok || response.type === 'opaque') && !shouldBypass(request.url)) {
      cache.put(request, response.clone()).catch(()=>{});
    }
    return response;
  } catch (err) {
    return await cache.match(request) || await caches.match(OFFLINE_URL);
  }
}

async function cacheFirstWithFallback(request, cacheName, fallbackUrl) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const resp = await fetch(request);
    if (resp && (resp.ok || resp.type === 'opaque') && !shouldBypass(request.url)) {
      await cache.put(request, resp.clone());
      return resp;
    }
    return resp;
  } catch (e) {}
  return caches.match(fallbackUrl);
}
