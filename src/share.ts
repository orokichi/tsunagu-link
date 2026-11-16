/**
 * Web Share Target inbox (page side).
 *
 * The service worker receives a share from another app on this computer
 * (Chromebook / Android / desktop Chrome), keeps the files in a Cache and this
 * metadata in IndexedDB, then redirects here with `?shared=<id>`.
 * `link.ts` picks the entry up and offers 「スマートフォンに送信」, whether the
 * share was files, text, a link, or a title with nothing else.
 *
 * The names (DB/store/cache) match public/sw.js; they are internal, so they keep
 * the original app id so an existing install keeps working.
 */
const SHARE_DB = 'tsunagu-share'
const SHARE_CACHE = 'quicklink-shared'

export interface SharedFileMeta { key: string; name: string; type: string; size: number }
export interface SharedEntry {
  id: string
  title: string
  text: string
  url: string
  time: number
  files: SharedFileMeta[]
  /** Filled in when the page has read the bytes out of the Cache. */
  blobs?: File[]
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((res) => {
    try {
      const r = indexedDB.open(SHARE_DB, 1)
      r.onupgradeneeded = () => { try { r.result.createObjectStore('items', { keyPath: 'id' }) } catch {} }
      r.onsuccess = () => res(r.result)
      r.onerror = () => res(null)
    } catch { res(null) }
  })
}

export async function getShared(id: string): Promise<SharedEntry | null> {
  const db = await openDb(); if (!db) return null
  const rec = await new Promise<SharedEntry | null>((res) => {
    try {
      const rq = db.transaction('items', 'readonly').objectStore('items').get(id)
      rq.onsuccess = () => res((rq.result as SharedEntry) || null)
      rq.onerror = () => res(null)
    } catch { res(null) }
  })
  db.close()
  if (!rec) return null
  return { ...rec, files: rec.files || [] }
}

export async function listShared(): Promise<SharedEntry[]> {
  const db = await openDb(); if (!db) return []
  const recs = await new Promise<SharedEntry[]>((res) => {
    try {
      const rq = db.transaction('items', 'readonly').objectStore('items').getAll()
      rq.onsuccess = () => res((rq.result as SharedEntry[]) || [])
      rq.onerror = () => res([])
    } catch { res([]) }
  })
  db.close()
  return recs.sort((a, b) => (b.time || 0) - (a.time || 0))
}

export async function readSharedFiles(entry: SharedEntry): Promise<File[]> {
  if (entry.blobs) return entry.blobs
  const out: File[] = []
  let cache: Cache | null = null
  try { cache = await caches.open(SHARE_CACHE) } catch { cache = null }
  for (const f of entry.files) {
    const res = cache ? await cache.match(f.key) : undefined
    if (!res) continue
    try {
      const blob = await res.blob()
      out.push(new File([blob], f.name, { type: f.type || blob.type || 'application/octet-stream' }))
    } catch { /* unreadable entry: skip */ }
  }
  return out
}

export async function deleteShared(id: string) {
  const entry = await getShared(id)
  if (entry) {
    try {
      const cache = await caches.open(SHARE_CACHE)
      for (const f of entry.files) await cache.delete(f.key)
    } catch {}
  }
  const db = await openDb(); if (!db) return
  await new Promise<void>((res) => {
    try {
      const tx = db.transaction('items', 'readwrite')
      tx.objectStore('items').delete(id)
      tx.oncomplete = () => res(); tx.onerror = () => res()
    } catch { res() }
  })
  db.close()
}

/** Older entries were never sent: keep the inbox from growing without bound. */
export async function pruneShared(maxAgeMs = 1000 * 60 * 60 * 24 * 3) {
  const all = await listShared()
  const now = Date.now()
  for (const e of all) if (now - (e.time || 0) > maxAgeMs) await deleteShared(e.id)
}
