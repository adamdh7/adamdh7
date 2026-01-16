const CACHE_NAME = 'adamdh7v2';
const IMAGE_CACHE = 'adamdh7v2';
const JSON_CACHE = 'adamdh7v2';
const VIDEO_CACHE = 'adamdh7v2';
const OFFLINE_URL = '/offline.html';
const PLACEHOLDER = '/images/placeholder-thumb.png';

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
  for(const d of AVOID_CACHE_DOMAINS){
    if(d && s.includes(d)) return true;
  }
  return false;
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
          }).catch(err => {
          })
        )
    );

    try {
      const resp = await fetch('/index.json', {cache: 'no-cache'});
      if (resp && (resp.ok || resp.type === 'opaque')) {
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
            if (typeof v === 'string' && (v.endsWith('.json') || /\.(jpg|jpeg|png|webp)$/.test(v))) urls.add(normalizeUrl(v));
          });
        }

        await Promise.allSettled(Array.from(urls).map(u => {
          if (shouldBypass(u)) return Promise.resolve();
          if (u.endsWith('.json')) {
            return fetch(u).then(r => { if(r && (r.ok||r.type==='opaque')) return jsonCache.put(u, r.clone()); }).catch(()=>{});
          }
          if (/\.(jpg|jpeg|png|webp)$/.test(u)) {
            return fetch(u).then(r => { if(r && (r.ok||r.type==='opaque')) return imageCache.put(u, r.clone()); }).catch(()=>{});
          }
          return Promise.resolve();
        }));
      }
    } catch (e) {
    }

    await self.skipWaiting();
  })());
});

self.addEventListener('activate', evt => {
  evt.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => {
      if (![CACHE_NAME, IMAGE_CACHE, JSON_CACHE, VIDEO_CACHE].includes(k)) {
        return caches.delete(k);
      }
      return Promise.resolve();
    }));
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

  try {
    if (shouldBypass(req.url)) {
      event.respondWith(
        fetch(req).catch(err => {
          if (req.mode === 'navigate' || (req.headers.get('accept')||'').includes('text/html')) {
            return caches.match(OFFLINE_URL);
          }
          return new Response(null, { status: 504, statusText: 'Gateway Timeout' });
        })
      );
      return;
    }
  } catch (e) {
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
    const url = (request.url || '').toLowerCase();
    if (resp && (resp.ok || resp.type === 'opaque') && !shouldBypass(url)) {
      try { cache.put(request, resp.clone()).catch(()=>{}); } catch(e){}
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
      try { cache.put(request, response.clone()).catch(()=>{}); } catch(e){}
    }
    return response;
  } catch (err) {
    const cached = await cache.match(request) || await caches.match(OFFLINE_URL);
    return cached;
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
    if (resp) return resp;
  } catch (e) {
  }
  return caches.match(fallbackUrl);
}
