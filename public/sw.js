/* Quick Link service worker.
 *
 * Jobs:
 *  1. PWA installability + instant offline start. The hashed files of the current
 *     build are injected below by vite.config.ts and precached on install.
 *     Same-origin requests are served **cache-first** and revalidated in the
 *     background (stale-while-revalidate): the window paints from the cache
 *     without waiting for the network at all, which is what makes a Chromebook
 *     cold start feel instant. A new deploy still wins, because the new build's
 *     service worker installs, drops the old cache and claims the pages at once.
 *     Google Fonts (which carries the Material Symbols icon font) is cached
 *     cache-first too, so icons draw offline instead of showing ligature names.
 *  2. Web Share Target (Chromebook / Android / desktop Chrome): a share from any
 *     app (files, text, a link) POSTs multipart form data to /share-target.
 *     The files are kept in a Cache, the text/title/url in IndexedDB, and the
 *     browser is redirected to the app with ?shared=<id>; the page then offers
 *     「スマートフォンに送信」.
 *  3. Desktop notifications for mirrored phone notifications, including an
 *     inline text reply action (Chrome). Reply text / action taps are forwarded
 *     to the open Quick Link page, which relays them to the phone over the
 *     paired connection. Nothing is executed from the SW itself.
 *  4. Web Push: while no Quick Link page is open, the phone itself POSTs an
 *     encrypted push (RFC 8291, VAPID-signed) to this browser's push service,
 *     which wakes this SW to show the OS notification. The SW cannot hold the
 *     WebRTC connection to the phone, so a reply typed into a push
 *     notification is stored in IndexedDB ("offline outbox", shared with the
 *     page) and sent by the page the next time it connects.
 */
// Replaced at build time (see offlinePrecache in vite.config.ts).
const BUILD_ID = 'dev'
const BUILD_ASSETS = []
const CACHE = 'quicklink-shell-' + BUILD_ID
const FONT_CACHE = 'quicklink-fonts' // survives builds: fonts never change
const SHARE_CACHE = 'quicklink-shared' // files received through the share sheet
const SHARE_DB = 'tsunagu-share' // share metadata, shared with the page (src/share.ts)
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com']
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png', '/apple-touch-icon.png',
  ...BUILD_ASSETS]
// The two stylesheets index.html asks for (the families are fixed there).
const FONT_CSS = [
  'https://fonts.googleapis.com/css2?family=Google+Sans+Flex:opsz,wght,ROND@6..144,1..1000,100&family=Noto+Sans+JP:wght@400;500;700&display=swap',
  'https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:opsz,wght,FILL,GRAD@20..48,300..700,0..1,-50..200&display=block',
]

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE)
    await Promise.allSettled(SHELL.map((u) => cache.add(new Request(u, { cache: 'reload' }))))
    const fonts = await caches.open(FONT_CACHE)
    await Promise.allSettled(FONT_CSS.map((u) => fonts.add(u)))
    await self.skipWaiting()
  })())
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys()
    await Promise.all(keys.filter((k) => k !== CACHE && k !== FONT_CACHE && k !== SHARE_CACHE).map((k) => caches.delete(k)))
    await self.clients.claim()
  })())
})

// ---- Web Share Target -------------------------------------------------------
async function shareDb() {
  return new Promise((res) => {
    try {
      const r = indexedDB.open(SHARE_DB, 1)
      r.onupgradeneeded = () => { try { r.result.createObjectStore('items', { keyPath: 'id' }) } catch (e) {} }
      r.onsuccess = () => res(r.result)
      r.onerror = () => res(null)
    } catch (e) { res(null) }
  })
}
async function shareStoreAdd(rec) {
  const db = await shareDb()
  if (!db) return
  await new Promise((res) => {
    try {
      const tx = db.transaction('items', 'readwrite')
      tx.objectStore('items').put(rec)
      tx.oncomplete = () => res(); tx.onerror = () => res()
    } catch (e) { res() }
  })
  db.close()
}

/** A share arrived from another app: keep it, then reopen the app on it. */
async function handleShareTarget(req) {
  try {
    const form = await req.formData()
    const title = String(form.get('title') || '')
    const text = String(form.get('text') || '')
    const url = String(form.get('url') || '')
    const list = []
    for (const value of form.getAll('files')) {
      if (value && typeof value === 'object' && typeof value.name === 'string') list.push(value)
    }
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
    const cache = await caches.open(SHARE_CACHE)
    const files = []
    for (let i = 0; i < list.length; i++) {
      const f = list[i]
      const key = '/__shared/' + id + '/' + i
      try {
        await cache.put(key, new Response(f, {
          headers: {
            'content-type': f.type || 'application/octet-stream',
            'x-name': encodeURIComponent(f.name || ('file-' + i)),
            'x-size': String(f.size || 0),
          },
        }))
        files.push({ key, name: f.name || ('file-' + i), type: f.type || 'application/octet-stream', size: f.size || 0 })
      } catch (e) { /* skip a file the Cache cannot hold */ }
    }
    await shareStoreAdd({ id, title, text, url, time: Date.now(), files })
    return Response.redirect(new URL('/?shared=' + id, self.location.origin).toString(), 303)
  } catch (e) {
    return Response.redirect(new URL('/?share_error=1', self.location.origin).toString(), 303)
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request
  const url = new URL(req.url)
  if (req.method === 'POST' && url.origin === self.location.origin && url.pathname === '/share-target') {
    event.respondWith(handleShareTarget(req))
    return
  }
  if (req.method !== 'GET') return
  // Fonts (the icon font in particular): cache-first, network only on a miss.
  if (FONT_HOSTS.includes(url.host)) {
    event.respondWith((async () => {
      const cache = await caches.open(FONT_CACHE)
      const hit = await cache.match(req)
      if (hit) return hit
      const res = await fetch(req)
      if (res.ok || res.type === 'opaque') cache.put(req, res.clone())
      return res
    })())
    return
  }
  if (url.origin !== self.location.origin) return // PeerJS cloud / push: leave alone
  // Stale-while-revalidate. Both promises start synchronously so the event's
  // lifetime covers the background refresh; the page gets the cached copy at
  // once and the network answer replaces it in the cache for the next start.
  const cacheP = caches.open(CACHE)
  const cachedP = cacheP.then((c) => c.match(req, { ignoreSearch: true })).catch(() => null)
  const networkP = fetch(req).then(async (res) => {
    if (res && res.ok) { try { const c = await cacheP; await c.put(req, res.clone()) } catch (e) {} }
    return res
  }).catch(() => null)
  event.waitUntil(networkP.then(() => {}).catch(() => {}))
  event.respondWith((async () => {
    const hit = await cachedP
    if (hit) return hit
    const res = await networkP
    if (res) return res
    if (req.mode === 'navigate') {
      const c = await cacheP
      const shell = (await c.match('/index.html', { ignoreSearch: true })) || (await c.match('/'))
      if (shell) return shell
    }
    return new Response('オフラインです。ネットワークにつながると起動できます。', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } })
  })())
})

// ---- Offline outbox (IndexedDB, shared with the page; see src/link.ts) ----
function outboxOpen() {
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
  const db = await outboxOpen()
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
    const title = d.app ? `${d.app}: ${d.title || '通知'}` : (d.title || 'Quick Link の通知')
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
  // A link sent from the phone (\"PC で開く\") whose tab could not be opened
  // directly (popup blocked): the notification click carries the user
  // activation needed to open it.
  if (n.data && n.data.url) { event.waitUntil(self.clients.openWindow(n.data.url).catch(() => {})); return }
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
      await self.registration.showNotification('Quick Link', {
        body: '返信を保存しました。Quick Link がスマホに接続した時点で送信します。',
        icon: '/icons/icon-192.png',
        tag: 'quicklink-pending-' + key,
      })
      if (!win) { try { await self.clients.openWindow('/?notif=' + encodeURIComponent(key)) } catch (e) {} }
      return
    }
    if (fromPush && action.startsWith('a') && key) {
      await queueAdd({ kind: 'action', key, index: parseInt(action.slice(1), 10) || 0, time: Date.now() })
      await tellPages({ type: 'push_queue_changed' })
      await self.registration.showNotification('Quick Link', {
        body: '操作を保存しました。Quick Link がスマホに接続した時点で実行します。',
        icon: '/icons/icon-192.png',
        tag: 'quicklink-pending-' + key,
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
