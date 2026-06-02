// Penny service worker — minimal, network-first
// Required for Chrome's PWA install prompt.

const CACHE = 'penny-v1'
const SHELL = ['/', '/chat']

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(SHELL).catch(() => {}))
  )
  self.skipWaiting()
})

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  )
  self.clients.claim()
})

self.addEventListener('fetch', event => {
  // Always go network-first for API calls — never cache them
  if (event.request.url.includes('/api/')) {
    event.respondWith(fetch(event.request))
    return
  }
  // For everything else: try network, fall back to cache if offline
  event.respondWith(
    fetch(event.request)
      .then(res => {
        const clone = res.clone()
        caches.open(CACHE).then(cache => cache.put(event.request, clone))
        return res
      })
      .catch(() => caches.match(event.request))
  )
})
