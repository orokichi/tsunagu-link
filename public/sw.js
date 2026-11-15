/* Tsunagu service worker.
 *
 * Two jobs:
 *  1. PWA installability + offline shell. Caching is deliberately network-first
 *     for everything same-origin, so a new deploy always wins over the cache
 *     (no "stale old version" problem); the cache is only an offline fallback.
 *  2. Desktop notifications for mirrored phone notifications, including an
 *     inline text reply action (Chrome). Reply text / action taps are forwarded
 *     to the open Tsunagu page, which relays them to the phone over the paired
 *     PeerJS connection. Nothing is executed from the SW itself.
 */
const CACHE = 'tsunagu-shell-v3'
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png', '/apple-touch-icon.png']

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE)
    await Promise.allSettled(SHELL.map((u) => cache.add(u)))
    await self.skipWaiting()
  })())
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys()
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return // fonts / PeerJS cloud: leave alone
  event.respondWith((async () => {
    const cache = await caches.open(CACHE)
    try {
      const res = await fetch(req)
      if (res.ok) cache.put(req, res.clone())
      return res
    } catch (e) {
      const hit = await cache.match(req, { ignoreSearch: true })
      if (hit) return hit
      if (req.mode === 'navigate') {
        const shell = await cache.match('/index.html')
        if (shell) return shell
      }
      throw e
    }
  })())
})

self.addEventListener('notificationclick', (event) => {
  const n = event.notification
  const key = (n.data && n.data.key) || ''
  const action = event.action || ''
  n.close()
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const win = wins[0]
    const post = (msg) => { if (win) win.postMessage(msg) }
    if (action === 'reply') {
      // Inline reply: forward the typed text; without text (unsupported / empty),
      // fall back to focusing the app's reply box for that notification.
      if (event.reply && key) post({ type: 'notif_reply', key, text: event.reply })
      else if (key) post({ type: 'focus_notif', key })
    } else if (action.startsWith('a') && key) {
      post({ type: 'notif_action', key, index: parseInt(action.slice(1), 10) || 0 })
    } else if (key) {
      post({ type: 'focus_notif', key })
    }
    if (win) {
      try { await win.focus() } catch (e) {}
    } else {
      // Page was closed: reopen the app on the notifications view for this key.
      try { await self.clients.openWindow('/?notif=' + encodeURIComponent(key)) } catch (e) {}
    }
  })())
})
