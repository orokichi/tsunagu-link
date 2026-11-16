import Peer, { DataConnection } from 'peerjs'

export type Status = 'starting' | 'waiting' | 'connected' | 'error'
export type Via = 'lan' | 'cloud'
export interface Device { name: string; model: string; android: string }
export interface Info { battery: number; charging: boolean; net: string; carrier?: string; storageFree: number; storageTotal: number; ringer?: string; lan?: LanEps }
export interface LanEps { ips: string[]; port: number }
/** Phone system controls reported by the app (クイック設定). */
export interface Sys {
  rotate: boolean | null; canWrite: boolean
  ringer: 'normal' | 'vibrate' | 'silent'; dnd: boolean; dndAccess: boolean
  vol: number; volMax: number; volMin?: number; muted: boolean
}
/** What this PC reports about itself to the phone (bidirectional link). */
export interface PcInfo {
  name: string; browser: string; os: string; battery: number | null; charging: boolean | null
  online: boolean; visible: boolean; screen: string; lang: string; pwa: boolean
}
export interface Notif { key: string; app: string; pkg: string; title: string; text: string; time: number; icon?: string; reply?: boolean; actions?: string[] }
export interface Media { app: string; title: string; artist: string; playing: boolean; art?: string; position?: number; duration?: number }
export interface Thread { id: string; address: string; name?: string; snippet: string; time: number; unread?: boolean; unreadCount?: number; kind?: 'sms' | 'rcs' | 'mms' }
export interface Sms { id: string; body: string; time: number; mine: boolean; kind?: 'sms' | 'rcs' | 'mms'; read?: boolean }
export interface FsItem { name: string; dir: boolean; size: number; time: number }
export interface LocFix { lat: number; lng: number; acc?: number | null; time: number }
export interface Call { number: string; name?: string; type: number; time: number; duration: number }
export interface Photo { id: string; video: boolean; time: number; thumb: string; duration?: number; name: string; size: number }
export interface Transfer { id: string; name: string; size: number; mime: string; done: number; dir: 'in' | 'out'; state: 'active' | 'done' | 'error'; url?: string }
export interface Clip { text: string; time: number; from: 'pc' | 'phone' }
export interface Toast { id: number; text: string; action?: { label: string; run: () => void } }

export type PushState = 'unsupported' | 'off' | 'on' | 'blocked' | 'busy' | 'error'
export interface State {
  status: Status; code: string; secret: string; error?: string
  pushState: PushState; pushSynced: boolean
  device?: Device; info?: Info; seed?: string; via?: Via
  notifs: Notif[]; media?: Media | null
  threads: Thread[]; sms: Record<string, Sms[]>
  calls: Call[]; photos: Photo[]; photosMore: boolean
  transfers: Transfer[]; clips: Clip[]; toasts: Toast[]
  fsPath: string; fsItems: FsItem[]; fsAccess: boolean; fsReady: boolean
  loc?: LocFix | null; locError?: string; locBusy: boolean
  pending?: { name: string; accept: () => void; reject: () => void }
  incomingCall?: { number: string; name?: string } | null
  focusNotif?: string
  sys?: Sys | null
  /** The phone is ringing this PC (「PC を鳴らす」). */
  ringing: boolean
  /** Text the phone sent to this PC (「PC にテキストを送る」). */
  inbox?: { text: string; time: number } | null
}

const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const rand = (n: number, a = ALPHA) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => a[b % a.length]).join('')
const ls = {
  get: (k: string) => localStorage.getItem('ts.' + k),
  set: (k: string, v: string) => localStorage.setItem('ts.' + k, v),
  del: (k: string) => localStorage.removeItem('ts.' + k),
}
const CHUNK = 48 * 1024
export const APP_VERSION = '1.1.0'

function b64(buf: ArrayBuffer) {
  const u = new Uint8Array(buf); let s = ''
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000))
  return btoa(s)
}
function unb64(s: string) { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u }

// ---------------------------------------------------------------------------
// Web Push (receive phone notifications while this page is closed).
//
// There is no push server: the phone itself is the application server. It
// generates a VAPID key pair and hands the public key over in its hello; this
// page subscribes through PushManager with that key and sends the resulting
// PushSubscription back over the paired connection, so the phone can encrypt
// (RFC 8291) and POST pushes directly to the browser's push service.
// ---------------------------------------------------------------------------
export const pushSupported = () =>
  typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window

function urlB64ToUint8Array(s: string) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4)
  const bin = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'))
  const u = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i)
  return u
}
function bufToB64Url(buf: ArrayBuffer) {
  return b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// Offline outbox shared with the service worker (same origin, same database).
// A reply typed into a push notification while no page is open is stored here
// by the SW and flushed by the page the next time it connects to the phone —
// an SW cannot hold the WebRTC connection itself.
const IDB_NAME = 'tsunagu-offline'
function idbOpen(): Promise<IDBDatabase | null> {
  return new Promise((res) => {
    try {
      const r = indexedDB.open(IDB_NAME, 1)
      r.onupgradeneeded = () => { try { r.result.createObjectStore('queue', { keyPath: 'id', autoIncrement: true }) } catch {} }
      r.onsuccess = () => res(r.result)
      r.onerror = () => res(null)
    } catch { res(null) }
  })
}
async function idbAdd(rec: any) {
  const db = await idbOpen(); if (!db) return
  await new Promise<void>((res) => {
    try {
      const tx = db.transaction('queue', 'readwrite')
      tx.objectStore('queue').add(rec)
      tx.oncomplete = () => res(); tx.onerror = () => res()
    } catch { res() }
  })
  db.close()
}
async function idbAll(): Promise<any[]> {
  const db = await idbOpen(); if (!db) return []
  const out = await new Promise<any[]>((res) => {
    try {
      const rq = db.transaction('queue', 'readonly').objectStore('queue').getAll()
      rq.onsuccess = () => res(rq.result || [])
      rq.onerror = () => res([])
    } catch { res([]) }
  })
  db.close()
  return out
}
async function idbDel(id: number) {
  const db = await idbOpen(); if (!db) return
  await new Promise<void>((res) => {
    try {
      const tx = db.transaction('queue', 'readwrite')
      tx.objectStore('queue').delete(id)
      tx.oncomplete = () => res(); tx.onerror = () => res()
    } catch { res() }
  })
  db.close()
}

// ---------------------------------------------------------------------------
// Transports. The app protocol is identical JSON messages over either:
//  - "cloud": PeerJS (public signaling) WebRTC data channel.
//  - "lan":   a raw RTCPeerConnection offered by this page to the phone's
//             authenticated LAN signaling endpoint (same Wi-Fi). Messages are
//             JSON text framed as [0x00]+utf8, or chunked frames
//             [0x01][id:u32][idx:u16][total:u16]+slice(<=16000B) when large —
//             the identical codec lives in the phone's bridge.html.
// ---------------------------------------------------------------------------
interface Transport {
  kind: Via
  readonly open: boolean
  send(m: any): void
  close(): void
  buffered(): number
}

class PeerTransport implements Transport {
  kind: Via = 'cloud'
  constructor(private c: DataConnection) {}
  get open() { return this.c.open }
  send(m: any) { this.c.send(m) }
  close() { try { this.c.close() } catch {} }
  buffered() { return ((this.c as any).dataChannel as RTCDataChannel | undefined)?.bufferedAmount ?? 0 }
}

const FRAME_CHUNK = 16000
let frameSeq = 1
function encodeFrames(text: string): ArrayBuffer[] {
  const bytes = new TextEncoder().encode(text)
  if (bytes.length <= FRAME_CHUNK) { const f = new Uint8Array(bytes.length + 1); f[0] = 0; f.set(bytes, 1); return [f.buffer] }
  const id = (frameSeq = (frameSeq + 1) >>> 0) || (frameSeq = 1)
  const total = Math.ceil(bytes.length / FRAME_CHUNK); const out: ArrayBuffer[] = []
  for (let i = 0; i < total; i++) {
    const slice = bytes.subarray(i * FRAME_CHUNK, (i + 1) * FRAME_CHUNK)
    const f = new Uint8Array(9 + slice.length); const dv = new DataView(f.buffer)
    f[0] = 1; dv.setUint32(1, id); dv.setUint16(5, i); dv.setUint16(7, total); f.set(slice, 9)
    out.push(f.buffer)
  }
  return out
}
function makeFrameDecoder(onText: (s: string) => void) {
  const pending = new Map<number, { parts: (Uint8Array | undefined)[]; got: number }>()
  const dec = new TextDecoder()
  return (buf: ArrayBuffer) => {
    const u = new Uint8Array(buf); if (!u.length) return
    if (u[0] === 0) { onText(dec.decode(u.subarray(1))); return }
    if (u[0] !== 1 || u.length < 9) return
    const dv = new DataView(u.buffer, u.byteOffset, u.byteLength)
    const id = dv.getUint32(1), idx = dv.getUint16(5), total = dv.getUint16(7)
    let p = pending.get(id); if (!p) { p = { parts: new Array(total), got: 0 }; pending.set(id, p) }
    if (p.parts[idx] === undefined) { p.parts[idx] = u.slice(9); p.got++ }
    if (p.got === total) {
      pending.delete(id)
      let len = 0; for (const x of p.parts) len += x!.length
      const all = new Uint8Array(len); let o = 0
      for (const x of p.parts) { all.set(x!, o); o += x!.length }
      onText(dec.decode(all))
    }
  }
}
function waitIce(pc: RTCPeerConnection, ms: number) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise<void>((res) => {
    const to = setTimeout(done, ms)
    function done() { pc.removeEventListener('icegatheringstatechange', f); clearTimeout(to); res() }
    function f() { if (pc.iceGatheringState === 'complete') done() }
    pc.addEventListener('icegatheringstatechange', f)
  })
}
function firstOk<T>(promises: Promise<T>[]): Promise<T> {
  return new Promise((resolve, reject) => {
    let left = promises.length
    if (!left) return reject(new Error('none'))
    for (const p of promises) p.then(resolve, () => { if (--left === 0) reject(new Error('all failed')) })
  })
}
async function sha256Hex(s: string) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('')
}

class LanTransport implements Transport {
  kind: Via = 'lan'
  onmsg: (m: any) => void = () => {}
  onclose: () => void = () => {}
  private closed = false
  private dec = makeFrameDecoder((s) => { try { this.onmsg(JSON.parse(s)) } catch {} })
  constructor(private pc: RTCPeerConnection, private dc: RTCDataChannel) {
    dc.binaryType = 'arraybuffer'
    dc.onmessage = (e) => { if (e.data instanceof ArrayBuffer) this.dec(e.data) }
    dc.onclose = () => this.fireClose()
    pc.oniceconnectionstatechange = () => { if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'closed') this.fireClose() }
  }
  private fireClose() { if (!this.closed) { this.closed = true; this.onclose() } }
  get open() { return this.dc.readyState === 'open' }
  send(m: any) { for (const f of encodeFrames(JSON.stringify(m))) this.dc.send(f) }
  close() { try { this.dc.close() } catch {} try { this.pc.close() } catch {} this.fireClose() }
  buffered() { return this.dc.bufferedAmount }
}

class Link {
  state: State
  private subs = new Set<() => void>()
  private peer?: Peer
  private conn?: Transport
  private pendingLan?: LanTransport
  private lanTrying = false
  private incoming = new Map<string, { parts: Uint8Array[]; t: Transfer }>()
  private toastId = 0
  private lastClip = ''
  private vapid?: string
  private pcToken = ''
  private pushEndpoint = ''

  constructor() {
    let code = ls.get('code'); let secret = ls.get('secret')
    if (!code) { code = rand(6); ls.set('code', code) }
    if (!secret) { secret = rand(20); ls.set('secret', secret) }
    const focusNotif = new URLSearchParams(location.search).get('notif') || undefined
    this.state = { status: 'starting', code, secret, pushState: pushSupported() ? (ls.get('push') === '1' ? 'on' : 'off') : 'unsupported', pushSynced: false, notifs: [], threads: [], sms: {}, calls: [], photos: [], photosMore: false, transfers: [], clips: JSON.parse(ls.get('clips') || '[]'), toasts: [], seed: ls.get('seed') || undefined, focusNotif, fsPath: '', fsItems: [], fsAccess: false, fsReady: false, locBusy: false, ringing: false }
    this.start()
    // If we already know the phone's LAN endpoints (learned during a previous
    // pairing), try the direct route right away; keep retrying while offline
    // and upgrade a cloud connection to LAN when the network allows it.
    this.tryLan()
    setInterval(() => this.tryLan(), 20000)
    // Replies / action taps typed into desktop notifications come back from the
    // service worker; relay them to the phone over the paired connection only.
    navigator.serviceWorker?.addEventListener('message', (e) => {
      const d = e.data || {}
      if (d.type === 'notif_reply' && d.key && d.text) this.relayReply(d.key, d.text)
      else if (d.type === 'notif_action' && d.key) {
        if (this.conn?.open) this.send({ t: 'notif_action', key: d.key, index: d.index | 0 })
        else { void idbAdd({ kind: 'action', key: d.key, index: d.index | 0, time: Date.now() }); this.toast('操作を保存しました（接続時に実行します）') }
      }
      else if (d.type === 'push_queue_changed') void this.drainOfflineQueue()
      else if (d.type === 'focus_notif' && d.key) this.set({ focusNotif: d.key })
    })
    void this.refreshPushState()
    void this.drainOfflineQueue()
    window.addEventListener('focus', () => this.pushClipboard(false))
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.pushClipboard(false); this.queuePcInfo() })
    window.addEventListener('online', () => this.queuePcInfo())
    window.addEventListener('offline', () => this.queuePcInfo())
    // Browsers only allow audio after a user gesture: unlock the ring sound on
    // the first interaction so the phone can ring this PC later.
    const unlock = () => { this.audio(); window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock) }
    window.addEventListener('pointerdown', unlock)
    window.addEventListener('keydown', unlock)
    ;(navigator as any).getBattery?.().then((b: any) => {
      this.battery = b
      b.addEventListener('levelchange', () => this.queuePcInfo())
      b.addEventListener('chargingchange', () => this.queuePcInfo())
    }).catch(() => {})
  }

  // ---------------- This PC, as seen from the phone ----------------
  private battery?: { level: number; charging: boolean }
  private pcInfoTimer?: number
  pcInfo(): PcInfo {
    const ua = navigator.userAgent
    const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'ブラウザ'
    const os = /CrOS/.test(ua) ? 'ChromeOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /Linux/.test(ua) ? 'Linux' : 'PC'
    const name = os === 'ChromeOS' ? 'Chromebook' : os === 'Windows' ? 'Windows PC' : os === 'macOS' ? 'Mac' : os === 'Linux' ? 'Linux PC' : 'PC'
    const b = this.battery
    return {
      name, browser, os,
      battery: b ? Math.round(b.level * 100) : null, charging: b ? b.charging : null,
      online: navigator.onLine, visible: !document.hidden,
      screen: `${screen.width}×${screen.height}`, lang: navigator.language,
      pwa: matchMedia('(display-mode: standalone)').matches,
    }
  }
  private queuePcInfo() {
    if (!this.conn?.open) return
    clearTimeout(this.pcInfoTimer)
    this.pcInfoTimer = window.setTimeout(() => this.send({ t: 'pc_info', info: this.pcInfo() }), 400)
  }

  // ---------------- Ring this PC (phone → PC) ----------------
  private ctx?: AudioContext
  private ringTimer?: number
  private ringStop?: number
  private audio() {
    try {
      if (!this.ctx) this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)()
      if (this.ctx.state === 'suspended') void this.ctx.resume()
    } catch {}
    return this.ctx
  }
  private beep() {
    const ctx = this.audio(); if (!ctx) return
    const t0 = ctx.currentTime
    for (const [i, f] of [880, 1320, 880, 1320].entries()) {
      const o = ctx.createOscillator(), g = ctx.createGain()
      o.type = 'sine'; o.frequency.value = f
      const t = t0 + i * 0.18
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.35, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16)
      o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + 0.17)
    }
  }
  startRing() {
    this.stopRing(false)
    this.set({ ringing: true })
    this.beep()
    this.ringTimer = window.setInterval(() => this.beep(), 1200)
    this.ringStop = window.setTimeout(() => this.stopRing(), 30000)
    this.notify('スマホから呼び出し中', 'Tsunagu のタブで「停止」を押すと止まります', { key: 'tsunagu-ring' }, true)
    this.send({ t: 'pc_ring_state', on: true })
  }
  stopRing(report = true) {
    clearInterval(this.ringTimer); clearTimeout(this.ringStop)
    this.ringTimer = undefined; this.ringStop = undefined
    if (this.state.ringing) this.set({ ringing: false })
    if (report) this.send({ t: 'pc_ring_state', on: false })
  }

  /** Open a link the phone sent. Popup blockers may refuse a tab opened
   *  without a click, so fall back to a toast button and a notification
   *  whose click opens it. */
  private openFromPhone(url: string) {
    if (!/^https?:\/\//i.test(url)) return
    let w: Window | null = null
    try { w = window.open(url, '_blank') } catch {}
    if (w) { try { w.opener = null } catch {} this.toast('スマホから送られたリンクを開きました'); return }
    this.toast('スマホからリンクが届きました', { label: '開く', run: () => window.open(url, '_blank', 'noopener') })
    this.notify('スマホからのリンク', url, { url }, true)
  }
  clearInbox() { this.set({ inbox: null }) }

  // ---------------- Phone quick settings (PC → phone) ----------------
  setSys(p: Record<string, unknown>) {
    this.send({ t: 'sys_set', ...p })
    // Optimistic UI; the phone answers with the authoritative state.
    const s = this.state.sys; if (!s) return
    const next = { ...s }
    if (p.key === 'rotate') next.rotate = !!p.on
    else if (p.key === 'dnd') next.dnd = !!p.on
    else if (p.key === 'ringer') next.ringer = p.mode as Sys['ringer']
    else if (p.key === 'vol') { next.vol = Number(p.value); next.muted = false }
    else if (p.key === 'mute') next.muted = !!p.on
    this.set({ sys: next })
  }
  sysPerm(which: 'write_settings' | 'dnd') { this.send({ t: 'sys_perm', which }); this.toast('スマホで許可画面を開きました') }

  subscribe = (f: () => void) => { this.subs.add(f); return () => { this.subs.delete(f) } }
  get = () => this.state
  private set(p: Partial<State>) { this.state = { ...this.state, ...p }; this.subs.forEach((f) => f()) }

  private start() {
    this.peer?.destroy()
    const peer = new Peer('tsunagu-link-' + this.state.code.toLowerCase(), { debug: 0 })
    this.peer = peer
    peer.on('open', () => this.set({ status: this.conn?.open ? 'connected' : 'waiting', error: undefined }))
    peer.on('connection', (c) => this.onConn(new PeerTransport(c), c))
    peer.on('disconnected', () => { if (!peer.destroyed) setTimeout(() => peer.reconnect(), 2000) })
    peer.on('error', (e: any) => {
      if (e.type === 'unavailable-id') this.set({ status: 'error', error: 'このコードは別のタブで使用中です。ほかのタブを閉じてください。' })
      else if (e.type === 'network' || e.type === 'server-error' || e.type === 'socket-error') { this.set({ status: 'starting' }); setTimeout(() => this.start(), 4000) }
    })
  }

  regenerate() {
    // A new pairing code invalidates the old pairing: drop the Web Push
    // subscription too (the phone discards it with the old token as well).
    // It can be re-enabled after the new pairing connects.
    void this.disablePush()
    this.vapid = undefined; this.pcToken = ''
    const code = rand(6), secret = rand(20); ls.set('code', code); ls.set('secret', secret); ls.set('trusted', '[]'); ls.del('lan')
    this.conn?.close(); this.pendingLan?.close(); this.set({ code, secret, status: 'starting', device: undefined, via: undefined, pushSynced: false }); this.start()
  }

  get qrText() { return `tsunagu:${this.state.code}:${this.state.secret}` }

  private onConn(t: Transport, raw?: DataConnection) {
    if (raw) {
      raw.on('data', (d: any) => this.onData(t, d))
      raw.on('close', () => this.onTransportClose(t))
      raw.on('error', () => {})
    }
  }

  private onTransportClose(t: Transport) {
    if (this.pendingLan === t) { this.pendingLan = undefined; return }
    if (this.conn === t) {
      this.conn = undefined
      this.set({ status: 'waiting', via: undefined, media: undefined, incomingCall: null, pushSynced: false, sys: null })
      this.stopRing(false)
      this.toast('スマートフォンとの接続が切れました')
      setTimeout(() => this.tryLan(), 3000)
    }
  }

  private accept(c: Transport, hello: any) {
    if (this.conn && this.conn !== c) this.conn.close()
    if (this.pendingLan === c) this.pendingLan = undefined
    this.conn = c
    let token = hello.token
    const trusted: string[] = JSON.parse(ls.get('trusted') || '[]')
    if (!trusted.includes(token)) { token = rand(24); trusted.push(token); ls.set('trusted', JSON.stringify(trusted.slice(-10))) }
    const me = this.pcInfo()
    c.send({ t: 'welcome', token, pc: me.name, pcInfo: me })
    this.pcToken = token
    if (hello.vapid) this.vapid = hello.vapid
    if (hello.seed) ls.set('seed', hello.seed)
    this.learnLan(hello.lan)
    this.set({ status: 'connected', via: c.kind, device: { name: hello.name, model: hello.model, android: hello.android }, seed: hello.seed || this.state.seed, pending: undefined })
    for (const what of ['info', 'notifs', 'media', 'threads', 'calls', 'sys']) this.send({ t: 'get', what })
    this.getPhotos(true)
    // (Re)register the Web Push subscription with this pairing and flush any
    // replies that were queued while the page was closed.
    void this.syncPushSubscription()
    void this.drainOfflineQueue()
    this.toast(`${hello.name} と接続しました`)
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission()
  }

  send(m: any) { if (this.conn?.open) this.conn.send(m) }
  toast(text: string, action?: Toast['action']) {
    const id = ++this.toastId; this.set({ toasts: [...this.state.toasts, { id, text, action }] })
    setTimeout(() => this.set({ toasts: this.state.toasts.filter((t) => t.id !== id) }), action ? 8000 : 3500)
  }
  clearFocusNotif() { if (this.state.focusNotif) this.set({ focusNotif: undefined }) }

  // ---------------- Web Push （閉じていても通知） ----------------
  /** Reflect the browser-side subscription state (permission + saved intent). */
  private async refreshPushState() {
    if (!pushSupported()) { this.set({ pushState: 'unsupported' }); return }
    if (Notification.permission === 'denied') { this.set({ pushState: 'blocked' }); return }
    if (ls.get('push') !== '1') { this.set({ pushState: 'off' }); return }
    this.set({ pushState: 'on' })
    try {
      const reg = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise<null>((r) => setTimeout(() => r(null), 3000)),
      ])
      const sub = await (reg as ServiceWorkerRegistration | null)?.pushManager.getSubscription().catch(() => null)
      if (sub) this.pushEndpoint = sub.endpoint
    } catch {}
    if (this.conn?.open) void this.syncPushSubscription()
  }

  /** User action: turn closed-app notifications on (asks permission if needed). */
  async enablePush() {
    if (!pushSupported()) { this.set({ pushState: 'unsupported' }); this.toast('このブラウザは Web Push に対応していません'); return }
    this.set({ pushState: 'busy' })
    try {
      let perm = Notification.permission
      if (perm === 'default') perm = await Notification.requestPermission()
      if (perm !== 'granted') { this.set({ pushState: 'blocked' }); this.toast('ブラウザ通知が許可されていません'); return }
      ls.set('push', '1')
      const ok = await this.syncPushSubscription()
      if (ok) { this.set({ pushState: 'on' }); this.toast(this.conn?.open ? '閉じていても通知を受け取ります' : '有効にしました（スマホ接続時に登録されます）') }
      else if (!this.vapid) { this.set({ pushState: 'on' }); this.toast('有効にしました（スマホ接続時に登録されます）') }
      else { this.set({ pushState: 'error' }); this.toast('Push購読の作成に失敗しました') }
    } catch { this.set({ pushState: 'error' }); this.toast('Push購読の作成に失敗しました') }
  }

  /** User action: turn closed-app notifications off and drop the subscription. */
  async disablePush() {
    ls.del('push')
    const ep = this.pushEndpoint
    if (this.conn?.open && ep) this.send({ t: 'push_unsubscribe', pcToken: this.pcToken, endpoint: ep })
    try {
      const reg = await navigator.serviceWorker?.getRegistration()
      const sub = await reg?.pushManager.getSubscription()
      if (sub) {
        if (this.conn?.open && !ep) this.send({ t: 'push_unsubscribe', pcToken: this.pcToken, endpoint: sub.endpoint })
        await sub.unsubscribe()
      }
    } catch {}
    this.pushEndpoint = ''
    this.set({ pushState: pushSupported() ? 'off' : 'unsupported', pushSynced: false })
  }

  /** Create (or reuse) the browser subscription for the phone's VAPID key and
   *  hand it to the phone over the paired connection. Returns false when no
   *  subscription could be produced (e.g. VAPID key not known yet). */
  private async syncPushSubscription(): Promise<boolean> {
    if (!pushSupported()) { this.set({ pushState: 'unsupported' }); return false }
    if (ls.get('push') !== '1') {
      this.set({ pushState: Notification.permission === 'denied' ? 'blocked' : 'off' })
      return false
    }
    if (Notification.permission === 'denied') { this.set({ pushState: 'blocked' }); return false }
    if (Notification.permission !== 'granted') { this.set({ pushState: 'off' }); return false }
    this.set({ pushState: 'on' })
    await this.drainOfflineQueue() // adopt a subscription rotated by the SW, if any
    if (!this.vapid) return false
    let sub: PushSubscription | null = null
    try {
      const reg = await navigator.serviceWorker.ready
      sub = await reg.pushManager.getSubscription()
      if (sub) {
        const current = sub.options.applicationServerKey ? bufToB64Url(sub.options.applicationServerKey) : ''
        if (current !== this.vapid) { await sub.unsubscribe(); sub = null }
      }
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(this.vapid) as BufferSource })
    } catch { sub = null }
    if (!sub) { if (this.conn?.open) this.set({ pushState: 'error' }); return false }
    this.pushEndpoint = sub.endpoint
    if (this.conn?.open) this.send({ t: 'push_subscribe', pcToken: this.pcToken, subscription: sub.toJSON() })
    return true
  }

  /** Send replies/actions the SW queued while no live connection existed. */
  private async drainOfflineQueue() {
    const recs = await idbAll()
    if (!recs.length) return
    let sent = 0
    for (const r of recs.sort((a, b) => (a.time || 0) - (b.time || 0))) {
      if (r.kind === 'subscription') {
        // The SW re-subscribed after pushsubscriptionchange: forward the new
        // subscription exactly like a fresh one, once connected.
        if (this.conn?.open && r.subscription) {
          this.pushEndpoint = r.subscription.endpoint || this.pushEndpoint
          this.send({ t: 'push_subscribe', pcToken: this.pcToken, subscription: r.subscription })
          await idbDel(r.id)
        }
        continue
      }
      if (!this.conn?.open) continue
      if (r.kind === 'reply' && r.key && r.text) this.send({ t: 'notif_reply', key: r.key, text: r.text })
      else if (r.kind === 'action' && r.key) this.send({ t: 'notif_action', key: r.key, index: r.index | 0 })
      else continue
      await idbDel(r.id)
      sent++
    }
    if (sent) this.toast(`送信待ちだった返信・操作 ${sent} 件を送信しました`)
  }

  /** A notification reply from the SW: send now, or queue it if offline. */
  private relayReply(key: string, text: string) {
    if (this.conn?.open) { this.send({ t: 'notif_reply', key, text }); this.toast('返信を送信しました') }
    else { void idbAdd({ kind: 'reply', key, text, time: Date.now() }); this.toast('返信を保存しました（スマホに接続した時点で送信します）') }
  }

  /** Send an SMS from the PC, showing it in the open conversation right away.
   *  The phone's follow-up history push replaces the optimistic entry. */
  sendSms(to: string, body: string, threadId: string | null) {
    this.send({ t: 'sms_send', to, body, threadId })
    if (threadId && threadId !== 'new') {
      const m: Sms = { id: 'tmp' + Date.now(), body, time: Date.now(), mine: true, kind: 'sms' }
      this.set({ sms: { ...this.state.sms, [threadId]: [...(this.state.sms[threadId] || []), m] } })
    }
  }

  // ---------------- LAN direct connection ----------------
  private lanEps(): LanEps | null {
    try { const v = JSON.parse(ls.get('lan') || 'null'); return v && Array.isArray(v.ips) && v.ips.length && v.port > 0 ? v : null } catch { return null }
  }
  private learnLan(lan: any) {
    if (!lan || !Array.isArray(lan.ips) || !lan.ips.length || !(lan.port > 0)) return
    const v = JSON.stringify({ ips: lan.ips.slice(0, 4), port: lan.port })
    if (ls.get('lan') !== v) { ls.set('lan', v); this.tryLan() }
  }
  private async lanAuth(): Promise<string[]> {
    const trusted: string[] = JSON.parse(ls.get('trusted') || '[]')
    return Promise.all([this.state.secret, ...trusted].map(sha256Hex))
  }
  private async lanFetch(ip: string, port: number, path: string, body: any, timeoutMs: number): Promise<any> {
    const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), timeoutMs)
    try {
      const r = await fetch(`http://${ip}:${port}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal })
      if (!r.ok) throw new Error('http ' + r.status)
      return await r.json()
    } finally { clearTimeout(to) }
  }
  private async tryLan() {
    if (this.lanTrying || (this.conn?.kind === 'lan' && this.conn.open) || this.pendingLan) return
    if (this.state.transfers.some((t) => t.state === 'active')) return // never switch transports mid-transfer
    const eps = this.lanEps(); if (!eps) return
    this.lanTrying = true
    try { await this.lanConnect(eps) } catch { /* unreachable / blocked: cloud fallback keeps working */ }
    finally { this.lanTrying = false }
  }
  private async lanConnect(eps: LanEps) {
    const auth = await this.lanAuth()
    const ip = await firstOk(eps.ips.map(async (ip) => { await this.lanFetch(ip, eps.port, '/ping', { auth }, 1500); return ip }))
    if (this.conn?.kind === 'lan' && this.conn.open) return
    const pc = new RTCPeerConnection({ iceServers: [] })
    const dc = pc.createDataChannel('tsunagu')
    const t = new LanTransport(pc, dc)
    this.pendingLan = t
    t.onmsg = (m) => this.onData(t, m)
    t.onclose = () => this.onTransportClose(t)
    try {
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      await waitIce(pc, 2000)
      const sdp = pc.localDescription?.sdp
      if (!sdp) throw new Error('no local sdp')
      const ans = await this.lanFetch(ip, eps.port, '/signal', { auth, sdp }, 12000)
      if (this.pendingLan !== t) return // superseded / closed meanwhile
      await pc.setRemoteDescription({ type: 'answer', sdp: ans.sdp })
    } catch { t.close(); return }
    // If the channel opens but no hello is accepted within 8s, give up on it.
    setTimeout(() => { if (this.pendingLan === t) { this.pendingLan = undefined; t.close() } }, 8000)
  }

  private notify(title: string, body: string, rich?: { key?: string; reply?: boolean; actions?: string[]; icon?: string; url?: string }, always = false) {
    if ((!always && document.hasFocus()) || !('Notification' in window) || Notification.permission !== 'granted') return
    const icon = rich?.icon ? 'data:image/png;base64,' + rich.icon : '/icons/icon-192.png'
    // Prefer the service worker: only SW notifications can carry action buttons
    // and the inline text reply (used e.g. to answer LINE without opening the app).
    const viaSw = async () => {
      const reg = await navigator.serviceWorker?.getRegistration()
      if (!reg) throw new Error('no sw')
      const actions: any[] = []
      if (rich?.reply) actions.push({ action: 'reply', type: 'text', title: '返信', placeholder: '返信を入力…' })
      for (const [i, t] of (rich?.actions || []).entries()) {
        if (actions.length >= 2) break
        actions.push({ action: 'a' + i, title: t })
      }
      await reg.showNotification(title, {
        body, icon, tag: rich?.key, renotify: !!rich?.key,
        data: { key: rich?.url ? '' : rich?.key || '', url: rich?.url },
        actions: actions.length ? actions : undefined,
      } as NotificationOptions)
    }
    viaSw().catch(() => { try { new Notification(title, { body, icon }) } catch {} })
  }

  private onData(c: Transport, m: any) {
    if (!m || typeof m !== 'object') return
    if (m.t === 'hello') {
      // LAN is strictly preferred: once it is live, ignore cloud hellos so the
      // connection never flaps back to the slower route.
      if (this.conn?.kind === 'lan' && c.kind === 'cloud') return
      if (m.vapid) this.vapid = m.vapid
      const trusted: string[] = JSON.parse(ls.get('trusted') || '[]')
      if (m.token === this.state.secret || trusted.includes(m.token)) this.accept(c, m)
      else this.set({ pending: { name: m.name || 'Android', accept: () => this.accept(c, m), reject: () => { c.close(); this.set({ pending: undefined }) } } })
      return
    }
    if (c !== this.conn) return
    const s = this.state
    switch (m.t) {
      case 'info': this.set({ info: m.info, ...(m.info?.sys ? { sys: m.info.sys } : {}) }); this.learnLan(m.info?.lan); break
      case 'sys': this.set({ sys: m.sys }); break
      case 'sys_err': this.toast(m.text || '操作できませんでした'); if (m.sys) this.set({ sys: m.sys }); break
      // ---- phone → PC ----
      case 'pc_get': this.send({ t: 'pc_info', info: this.pcInfo() }); break
      case 'pc_open': this.openFromPhone(String(m.url || '')); break
      case 'pc_ping': {
        const text = String(m.text || 'スマホから呼び出しがあります')
        this.toast(`${s.device?.name || 'スマホ'}: ${text}`)
        this.notify(s.device?.name || 'スマホ', text, { key: 'tsunagu-ping-' + Date.now() }, true)
        break
      }
      case 'pc_ring': if (m.on === false) this.stopRing(); else this.startRing(); break
      case 'pc_text': {
        const text = String(m.text || ''); if (!text) break
        this.lastClip = text
        this.set({ inbox: { text, time: Date.now() }, clips: this.addClip({ text, time: Date.now(), from: 'phone' }) })
        this.notify('スマホからテキスト', text, { key: 'tsunagu-text' })
        break
      }
      case 'push_state': {
        if (m.subscribed) { if (m.endpoint) this.pushEndpoint = m.endpoint; this.set({ pushState: 'on', pushSynced: true }) }
        else this.set({ pushSynced: false })
        break
      }
      case 'notifs': this.set({ notifs: m.items }); break
      case 'notif': {
        const n: Notif = m.item
        this.set({ notifs: [n, ...s.notifs.filter((x) => x.key !== n.key)] })
        if (m.fresh) this.notify(`${n.app}: ${n.title}`, n.text, { key: n.key, reply: n.reply, actions: n.actions, icon: n.icon })
        break
      }
      case 'notif_rm': this.set({ notifs: s.notifs.filter((x) => x.key !== m.key) }); break
      case 'media': this.set({ media: m.state }); break
      case 'clip': {
        this.lastClip = m.text
        this.set({ clips: this.addClip({ text: m.text, time: Date.now(), from: 'phone' }) })
        navigator.clipboard?.writeText(m.text).then(() => this.toast('スマホのクリップボードをコピーしました')).catch(() =>
          this.toast('スマホからテキストが届きました', { label: 'コピー', run: () => navigator.clipboard.writeText(m.text) }))
        break
      }
      case 'threads': this.set({ threads: m.items }); break
      case 'sms': this.set({ sms: { ...s.sms, [m.threadId]: m.items } }); break
      case 'sms_in': {
        this.notify(m.name || m.address, m.body); this.toast(`メッセージ: ${m.name || m.address}`)
        this.send({ t: 'get', what: 'threads' }); if (m.threadId) this.send({ t: 'get', what: 'sms', threadId: m.threadId })
        break
      }
      case 'calls': this.set({ calls: m.items }); break
      case 'call_state': {
        if (m.state === 'ringing') { this.set({ incomingCall: { number: m.number, name: m.name } }); this.notify('着信', m.name || m.number || '不明な番号') }
        else { this.set({ incomingCall: null }); if (m.state === 'idle') this.send({ t: 'get', what: 'calls' }) }
        break
      }
      case 'photos': this.set({ photos: m.offset ? [...s.photos, ...m.items] : m.items, photosMore: m.hasMore }); break
      case 'fs_list': this.set({ fsPath: m.path || '', fsItems: m.items || [], fsAccess: !!m.access, fsReady: true }); break
      case 'location': {
        if (m.error) this.set({ locError: m.error, locBusy: false })
        else this.set({ loc: { lat: m.lat, lng: m.lng, acc: m.acc ?? null, time: m.time }, locError: undefined, locBusy: false })
        break
      }
      case 'toast': this.toast(m.text); break
      case 'file_start': {
        const t: Transfer = { id: m.id, name: m.name, size: m.size, mime: m.mime || 'application/octet-stream', done: 0, dir: 'in', state: 'active' }
        this.incoming.set(m.id, { parts: [], t }); this.set({ transfers: [t, ...s.transfers] }); break
      }
      case 'file_chunk': {
        const f = this.incoming.get(m.id); if (!f) return
        let u: Uint8Array
        try { u = unb64(m.d) } catch { this.incoming.delete(m.id); this.updT(m.id, { state: 'error' }); return }
        f.parts.push(u); f.t.done += u.length
        this.updT(m.id, { done: f.t.done }); break
      }
      case 'file_end': {
        const f = this.incoming.get(m.id); if (!f) return
        this.incoming.delete(m.id)
        // Never hand the user a truncated/corrupt file as if it were complete:
        // if the received byte count differs from the declared size, fail visibly.
        if (f.t.size > 0 && f.t.done !== f.t.size) {
          this.updT(m.id, { state: 'error' })
          this.toast(`ファイルが不完全なため保存しませんでした: ${f.t.name}（${f.t.done} / ${f.t.size} バイト）`)
          break
        }
        const url = URL.createObjectURL(new Blob(f.parts as BlobPart[], { type: f.t.mime }))
        this.updT(m.id, { state: 'done', url, done: f.t.size })
        const a = document.createElement('a'); a.href = url; a.download = f.t.name; a.click()
        this.notify('ファイルを受信しました', f.t.name); break
      }
    }
  }

  private updT(id: string, p: Partial<Transfer>) { this.set({ transfers: this.state.transfers.map((t) => (t.id === id ? { ...t, ...p } : t)) }) }
  private addClip(c: Clip) {
    const clips = [c, ...this.state.clips.filter((x) => x.text !== c.text)].slice(0, 30)
    ls.set('clips', JSON.stringify(clips)); return clips
  }

  async pushClipboard(manual: boolean) {
    if (this.state.status !== 'connected') return
    try {
      const text = await navigator.clipboard.readText()
      if (!text || (!manual && text === this.lastClip)) return
      this.lastClip = text; this.sendClip(text, manual)
    } catch { if (manual) this.toast('クリップボードの読み取りを許可してください') }
  }
  sendClip(text: string, notify = true) {
    this.lastClip = text
    this.send({ t: 'clip', text }); this.set({ clips: this.addClip({ text, time: Date.now(), from: 'pc' }) })
    if (notify) this.toast('スマホにクリップボードを送りました')
  }
  clearClips() { ls.set('clips', '[]'); this.set({ clips: [] }) }

  async sendFiles(files: FileList | File[]) {
    if (!this.conn?.open) { this.toast('スマホが接続されていません'); return }
    for (const file of Array.from(files)) {
      const id = rand(10)
      const t: Transfer = { id, name: file.name, size: file.size, mime: file.type, done: 0, dir: 'out', state: 'active' }
      this.set({ transfers: [t, ...this.state.transfers] })
      this.send({ t: 'file_start', id, name: file.name, size: file.size, mime: file.type || 'application/octet-stream' })
      try {
        for (let off = 0; off < file.size; off += CHUNK) {
          const buf = await file.slice(off, off + CHUNK).arrayBuffer()
          while (this.conn && this.conn.buffered() > 4 * 1024 * 1024) await new Promise((r) => setTimeout(r, 30))
          if (!this.conn?.open) throw new Error('closed')
          this.send({ t: 'file_chunk', id, d: b64(buf) })
          if ((off / CHUNK) % 8 === 0) this.updT(id, { done: off + buf.byteLength })
        }
        this.send({ t: 'file_end', id }); this.updT(id, { state: 'done', done: file.size })
      } catch { this.updT(id, { state: 'error' }) }
    }
  }

  getPhotos(reset: boolean) { this.send({ t: 'get', what: 'photos', offset: reset ? 0 : this.state.photos.length }) }
  openThread(id: string) {
    this.send({ t: 'get', what: 'sms', threadId: id })
    // Opening a conversation marks it read on the phone too (the phone updates
    // the providers' READ flags where Android allows it and pushes the result).
    this.send({ t: 'mark_read', threadId: id })
    // Optimistically clear the badge; the phone's next threads push is authoritative.
    this.set({ threads: this.state.threads.map((t) => (t.id === id ? { ...t, unread: false, unreadCount: 0 } : t)) })
  }
  clearWatch() { this.send({ t: 'watch', threadId: '' }) }

  // ---------------- Explorer ----------------
  fsList(path: string) { this.send({ t: 'get', what: 'fs', path }) }
  fsDownload(path: string) { this.send({ t: 'fs_get', path }); this.toast('PC に転送しています…') }
  fsDelete(path: string) { this.send({ t: 'fs_delete', path }) }
  fsRename(path: string, name: string) { this.send({ t: 'fs_rename', path, name }) }
  fsMkdir(path: string, name: string) { this.send({ t: 'fs_mkdir', path, name }) }
  fsPerm() { this.send({ t: 'fs_perm' }) }
  async fsUpload(files: FileList | File[], dir: string) {
    if (!this.conn?.open) { this.toast('スマホが接続されていません'); return }
    for (const file of Array.from(files)) {
      const id = rand(10)
      const t: Transfer = { id, name: file.name, size: file.size, mime: file.type, done: 0, dir: 'out', state: 'active' }
      this.set({ transfers: [t, ...this.state.transfers] })
      this.send({ t: 'fs_put_start', id, dir, name: file.name, size: file.size, mime: file.type || 'application/octet-stream' })
      try {
        for (let off = 0; off < file.size; off += CHUNK) {
          const buf = await file.slice(off, off + CHUNK).arrayBuffer()
          while (this.conn && this.conn.buffered() > 4 * 1024 * 1024) await new Promise((r) => setTimeout(r, 30))
          if (!this.conn?.open) throw new Error('closed')
          this.send({ t: 'fs_put_chunk', id, d: b64(buf) })
          if ((off / CHUNK) % 8 === 0) this.updT(id, { done: off + buf.byteLength })
        }
        this.send({ t: 'fs_put_end', id }); this.updT(id, { state: 'done', done: file.size })
      } catch { this.updT(id, { state: 'error' }) }
    }
  }

  // ---------------- Find （探す） ----------------
  getLocation() { this.set({ locBusy: true, locError: undefined }); this.send({ t: 'get', what: 'location' }) }

  clearTransfers() { this.set({ transfers: this.state.transfers.filter((t) => t.state === 'active') }) }
}

export const link = new Link()
;(window as any).tsunagu = link
