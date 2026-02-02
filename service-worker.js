const VERSION = 'v2.0.0'
const STATIC_CACHE = `adam-static-${VERSION}`
const DYNAMIC_CACHE = `adam-dynamic-${VERSION}`

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/adamdh7.png',
  '/asset/512.png'
]

self.addEventListener('install', event => {
  self.skipWaiting()
  event.waitUntil(
    caches.open(STATIC_CACHE).then(cache => cache.addAll(STATIC_ASSETS))
  )
})

self.addEventListener('activate', event => {
  event.waitUntil(
    Promise.all([
      caches.keys().then(keys =>
        Promise.all(
          keys
            .filter(k => ![STATIC_CACHE, DYNAMIC_CACHE].includes(k))
            .map(k => caches.delete(k))
        )
      ),
      self.clients.claim()
    ])
  )
})

self.addEventListener('fetch', event => {
  const req = event.request
  const url = new URL(req.url)

  if (!url.protocol.startsWith('http')) return

  if (req.destination === '' && url.pathname.endsWith('.json')) {
    event.respondWith(networkFirst(req))
    return
  }

  if (req.destination === 'video') {
    event.respondWith(fetch(req))
    return
  }

  if (
    req.destination === 'image' ||
    req.destination === 'style' ||
    req.destination === 'font'
  ) {
    event.respondWith(cacheFirst(req))
    return
  }

  if (
    url.hostname.includes('cdnjs') ||
    url.hostname.includes('googleapis') ||
    url.hostname.includes('gstatic')
  ) {
    event.respondWith(staleWhileRevalidate(req))
    return
  }

  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(req))
    return
  }

  event.respondWith(fetch(req).catch(() => caches.match(req)))
})

async function cacheFirst(request) {
  const cache = await caches.open(DYNAMIC_CACHE)
  const cached = await cache.match(request)
  if (cached) return cached
  const fresh = await fetch(request)
  cache.put(request, fresh.clone())
  return fresh
}

async function networkFirst(request) {
  const cache = await caches.open(DYNAMIC_CACHE)
  try {
    const fresh = await fetch(request)
    cache.put(request, fresh.clone())
    return fresh
  } catch {
    return await cache.match(request)
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(DYNAMIC_CACHE)
  const cached = await cache.match(request)
  const networkFetch = fetch(request).then(res => {
    cache.put(request, res.clone())
    return res
  })
  return cached || networkFetch
}

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting()
  }
})
