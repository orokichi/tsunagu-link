/* Tsunagu service worker.
 *
 * Jobs:
 *  1. PWA installability + offline shell. Caching is deliberately network-first
 *     for everything same-origin, so a new deploy always wins over the cache
 *     (no "stale old version" problem); the cache is only an offline fallback.
 *  2. Desktop notifications for mirrored phone notifications, including an
 *     inline text reply action (Chrome). Reply text / action taps are forwarded
 *     to the open Tsunagu page, which relays them to the phone over the paired
 *     connection. Nothing is executed from the SW itself.
 *  3. Web Push: while no Tsunagu page is open, the phone itself POSTs an
 *     encrypted push (RFC 8291, VAPID-signed) to this browser's push service,
 *     which wakes this SW to show the OS notification. The SW cannot hold the
 *     WebRTC connection to the phone, so a reply typed into a push
 *     notification is stored in IndexedDB ("offline outbox", shared with the
 *     page) and sent by the page the next time it connects.
 */
const CACHE = 'tsunagu-shell-v4'
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

// ---- Offline outbox (IndexedDB, shared with the page; see src/link.ts) ----
function idbOpen() {
  return new Promise((res) => {
    try {
      const r = indexedDB.open('tsunagu-offline', 1)
      r.onupgradeneeded = () => { try { r.result.createObjectStore('queue', { keyPath: 'id', autoIncrement: true }) } catch (e) {} }
      r.onsuccess = () => res(r.result)
      r.onerror = () => res(null)
    } catch (e) { res(null) }
  })
}
async function queueAdd(rec) {
  const db = await idbOpen()
  if (!db) return
  await new Promise((res) => {
    try {
      const tx = db.transaction('queue', 'readwrite')
      tx.objectStore('queue').add(rec)
      tx.oncomplete = () => res(); tx.onerror = () => res()
    } catch (e) { res() }
  })
  db.close()
}
async function tellPages(msg) {
  const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  for (const w of wins) { try { w.postMessage(msg) } catch (e) {} }
  return wins[0]
}

// ---- Web Push: a phone notification arrived while the page was closed ----
self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let d = {}
    try { d = event.data ? event.data.json() : {} } catch (e) {
      try { d = { text: event.data.text() } } catch (e2) {}
    }
    const title = d.app ? `${d.app}: ${d.title || '通知'}` : (d.title || 'Tsunagu の通知')
    const actions = []
    if (d.reply) actions.push({ action: 'reply', type: 'text', title: '返信', placeholder: '返信を入力…' })
    for (const [i, t] of (d.actions || []).entries()) {
      if (actions.length >= 2) break
      actions.push({ action: 'a' + i, title: t })
    }
    await self.registration.showNotification(title, {
      body: d.text || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: d.key || undefined,
      renotify: !!d.key,
      data: { key: d.key || '', push: true },
      actions: actions.length ? actions : undefined,
    })
  })())
})

// The push service rotated the subscription: re-subscribe with the same
// VAPID key and queue the new subscription for the page to forward to the
// phone on its next connection.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    try {
      const old = event.oldSubscription
      const options = old ? old.options : { userVisibleOnly: true }
      const sub = await self.registration.pushManager.subscribe(options)
      await queueAdd({ kind: 'subscription', subscription: sub.toJSON(), time: Date.now() })
      await tellPages({ type: 'push_queue_changed' })
    } catch (e) { /* the page re-subscribes on its next sync anyway */ }
  })())
})

self.addEventListener('notificationclick', (event) => {
  const n = event.notification
  const key = (n.data && n.data.key) || ''
  const fromPush = !!(n.data && n.data.push)
  const action = event.action || ''
  n.close()
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const win = wins[0]
    const post = (msg) => { if (win) win.postMessage(msg) }

    // Replies/actions on a *push* notification (page closed or not live):
    // the SW cannot reach the phone, so queue them in the offline outbox.
    // The page flushes the queue as soon as it connects, and we say so.
    if (fromPush && action === 'reply' && event.reply && key) {
      await queueAdd({ kind: 'reply', key, text: event.reply, time: Date.now() })
      await tellPages({ type: 'push_queue_changed' })
      await self.registration.showNotification('Tsunagu', {
        body: '返信を保存しました。Tsunagu がスマホに接続した時点で送信します。',
        icon: '/icons/icon-192.png',
        tag: 'tsunagu-pending-' + key,
      })
      if (!win) { try { await self.clients.openWindow('/?notif=' + encodeURIComponent(key)) } catch (e) {} }
      return
    }
    if (fromPush && action.startsWith('a') && key) {
      await queueAdd({ kind: 'action', key, index: parseInt(action.slice(1), 10) || 0, time: Date.now() })
      await tellPages({ type: 'push_queue_changed' })
      await self.registration.showNotification('Tsunagu', {
        body: '操作を保存しました。Tsunagu がスマホに接続した時点で実行します。',
        icon: '/icons/icon-192.png',
        tag: 'tsunagu-pending-' + key,
      })
      if (!win) { try { await self.clients.openWindow('/?notif=' + encodeURIComponent(key)) } catch (e) {} }
      return
    }

    if (action === 'reply') {
      // Inline reply: forward the typed text; without text (unsupported / empty),
      // fall back to focusing the app's reply box for that notification.
      // With no window at all the text would be lost, so queue it instead.
      if (event.reply && key) {
        if (win) post({ type: 'notif_reply', key, text: event.reply })
        else await queueAdd({ kind: 'reply', key, text: event.reply, time: Date.now() })
      } else if (key) post({ type: 'focus_notif', key })
    } else if (action.startsWith('a') && key) {
      if (win) post({ type: 'notif_action', key, index: parseInt(action.slice(1), 10) || 0 })
      else await queueAdd({ kind: 'action', key, index: parseInt(action.slice(1), 10) || 0, time: Date.now() })
    } else if (key) {
      post({ type: 'focus_notif', key })
    }
    if (win) {
      try { await win.focus() } catch (e) {}
    } else if (key) {
      // Page was closed: reopen the app on the notifications view for this key.
      try { await self.clients.openWindow('/?notif=' + encodeURIComponent(key)) } catch (e) {}
    }
  })())
})
