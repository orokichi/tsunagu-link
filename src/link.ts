// Type-only imports: the heavy libraries (PeerJS, the ADB stack, QRCode) are
// pulled in with a dynamic import at the moment they are needed, so the first
// paint never waits for them — the Chromebook start stays under a second.
import type { DataConnection } from 'peerjs'
import type { Adb, AdbSocket } from '@yume-chan/adb'
import type { AdbDaemonWebUsbDevice } from '@yume-chan/adb-daemon-webusb'
import type PeerType from 'peerjs'
import { deleteShared, getShared, pruneShared, readSharedFiles, SharedEntry } from './share'

export type Status = 'starting' | 'waiting' | 'connected' | 'error'
export type Via = 'lan' | 'cloud' | 'usb'
export interface Device { name: string; model: string; android: string }
export interface Info {
  battery: number; charging: boolean; net: string; carrier?: string; storageFree: number; storageTotal: number; ringer?: string; lan?: LanEps
  /** Phone's battery saver / power-saving mode. Older app builds do not send
   *  it (undefined); the card then shows the state as unknown. */
  powerSave?: boolean | null
}
export interface LanEps { ips: string[]; port: number }
/** How this PC chooses its transport: 'auto' prefers the LAN direct route and
 *  falls back to the cloud; 'cloud' never uses the local route. */
export type LinkMode = 'auto' | 'cloud'
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
  /** Older pages still exist on the phone (the conversation is paged in
   *  newest-first slices so a long history never has to cross in one message). */
  smsMore: Record<string, boolean>
  smsBusy: Record<string, boolean>
  smsError: Record<string, string | undefined>
  threadsError?: string
  notifsError?: string
  calls: Call[]; photos: Photo[]; photosMore: boolean
  transfers: Transfer[]; clips: Clip[]; toasts: Toast[]
  fsPath: string; fsItems: FsItem[]; fsAccess: boolean; fsReady: boolean
  loc?: LocFix | null; locError?: string; locBusy: boolean
  /** How the phone's location permission is set: 「常に許可」 or 「使用中のみ」, and
   *  whether the link service currently holds a location foreground service. */
  locMode?: 'always' | 'while_in_use'
  locFg?: boolean
  pending?: { name: string; accept: () => void; reject: () => void }
  incomingCall?: { number: string; name?: string } | null
  focusNotif?: string
  sys?: Sys | null
  /** The phone is ringing this PC (「PC を鳴らす」). */
  ringing: boolean
  /** Text the phone sent to this PC (「PC にテキストを送る」). */
  inbox?: { text: string; time: number } | null
  /** Transport preference and the manual LAN endpoint (設定). */
  mode: LinkMode
  lanManual?: LanEps | null
  lanBusy: boolean
  lanMessage?: string
  /** USB cable (ADB over WebUSB): works with no network at all. */
  usbSupported: boolean
  usbBusy: boolean
  usbMessage?: string
  /** Content handed over by the system share sheet (Web Share Target). */
  share?: SharedEntry | null
  /** Kept until it can be sent (the phone was not connected yet). */
  shareQueued?: boolean
  /** Experimental 「Googlebook OS」 desktop UI (設定 → 実験的な機能). */
  bookUi?: boolean
  /** Round-trip of the last heartbeat, for the connection badge. */
  latency?: number | null
}

const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const rand = (n: number, a = ALPHA) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => a[b % a.length]).join('')
const ls = {
  get: (k: string) => localStorage.getItem('ts.' + k),
  set: (k: string, v: string) => localStorage.setItem('ts.' + k, v),
  del: (k: string) => localStorage.removeItem('ts.' + k),
}
const CHUNK = 48 * 1024
export const APP_VERSION = '1.4.0'
/** How often the two ends ping each other, and how long silence is tolerated
 *  before the link is treated as dead (a data channel can stay "open" long
 *  after the other side is gone: Wi-Fi roamed, laptop slept, phone lost data). */
const HEARTBEAT_MS = 4000
const HEARTBEAT_DEAD_MS = 14000

/** Stored LAN endpoint (自動検出 or 手動設定). */
function parseLan(s: string | null): LanEps | null {
  try {
    const v = JSON.parse(s || 'null')
    if (v && Array.isArray(v.ips) && v.ips.length && v.port > 0) return { ips: v.ips.slice(0, 4), port: v.port }
  } catch {}
  return null
}

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

/** The phone answered as an ADB device but has no Quick Link USB socket yet. */
class UsbNoAppError extends Error {}

/** Rejects (with a spoken-to-the-user reason) if `p` takes longer than `ms`. */
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(message)), ms)
    p.then((v) => { clearTimeout(to); resolve(v) }, (e) => { clearTimeout(to); reject(e) })
  })
}

/** Turn WebUSB / ADB failures into something the user can act on. */
function usbErrorText(e: any): string {
  const name = String(e?.name || '')
  const msg = String(e?.message || '')
  if (/busy/i.test(name) || /busy/i.test(msg)) return 'スマホが他の adb（Android Studio・adb コマンド等）に使われています。それを閉じてから、もう一度お試しください。'
  if (name === 'NotFoundError') return 'USB デバイスが選ばれませんでした。'
  if (name === 'SecurityError' || name === 'NetworkError' || name === 'NotAllowedError') return 'USB へのアクセスが許可されませんでした。スマホの画面の確認で「許可」を押してください。'
  if (name === 'InvalidStateError') return 'USB デバイスが既に使われています。ケーブルを差し直してからお試しください。'
  if (/underlying connection|closed|broken pipe|rejected/i.test(msg) && /socket/i.test(msg)) return 'スマホの Quick Link アプリ（v1.3.0 以降）を開いたままにしてから、もう一度お試しください。'
  return 'USB 接続に失敗しました' + (msg ? `（${msg}）` : '')
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

/* USB cable (ADB over WebUSB).

   The phone exposes a local abstract socket ("tsunagu-usb") in which it speaks
   the same JSON protocol as the other transports. The browser becomes the ADB
   host itself over WebUSB, so nothing on the PC has to be installed, and no
   network (Wi-Fi, mobile data or the internet) is involved at all.

   The ADB socket is a byte stream, so messages are framed here as
   [length:u32 big-endian][utf8 JSON]; the phone's UsbServer.kt reads the same.
   Auth is the first frame: the phone checks sha256 of the pairing token / code. */
const USB_SOCKET = 'localabstract:tsunagu-usb'
const USB_MAX_FRAME = 16 * 1024 * 1024
/** WebUSB is the only thing the USB route needs from the browser; the ADB
 *  libraries themselves are loaded when 「USB で接続」 is pressed. */
export const usbSupported = () => typeof navigator !== 'undefined' && !!(navigator as any).usb

class UsbTransport implements Transport {
  kind: Via = 'usb'
  onmsg: (m: any) => void = () => {}
  onclose: () => void = () => {}
  private closed = false
  private acc = new Uint8Array(0)
  private queue: Uint8Array[] = []
  private queued = 0
  private writing = false
  private reader: any
  private writer: any
  private dec = new TextDecoder()
  constructor(private sock: AdbSocket) {
    this.reader = (sock.readable as any).getReader()
    this.writer = (sock.writable as any).getWriter()
    void this.pump()
  }
  private async pump() {
    try {
      for (;;) {
        const { value, done } = await this.reader.read()
        if (done) break
        if (value) this.feed(value as Uint8Array)
      }
    } catch { /* unplugged / closed */ }
    this.fireClose()
  }
  private feed(chunk: Uint8Array) {
    if (this.closed) return
    const all = new Uint8Array(this.acc.length + chunk.length)
    all.set(this.acc); all.set(chunk, this.acc.length)
    let off = 0
    while (all.length - off >= 4) {
      const len = ((all[off] << 24) | (all[off + 1] << 16) | (all[off + 2] << 8) | all[off + 3]) >>> 0
      if (len === 0 || len > USB_MAX_FRAME) { this.close(); return }
      if (all.length - off - 4 < len) break
      const body = all.subarray(off + 4, off + 4 + len)
      off += 4 + len
      try { this.onmsg(JSON.parse(this.dec.decode(body))) } catch {}
    }
    this.acc = all.slice(off)
  }
  private async drain() {
    if (this.writing) return
    this.writing = true
    try {
      while (this.queue.length && !this.closed) {
        const f = this.queue.shift()!
        await this.writer.write(f)
        this.queued -= f.length
      }
    } catch { this.fireClose() }
    this.writing = false
  }
  private fireClose() { if (!this.closed) { this.closed = true; this.onclose() } }
  get open() { return !this.closed }
  send(m: any) {
    if (this.closed) return
    const body = new TextEncoder().encode(JSON.stringify(m))
    const f = new Uint8Array(4 + body.length)
    new DataView(f.buffer).setUint32(0, body.length)
    f.set(body, 4)
    this.queue.push(f); this.queued += f.length
    void this.drain()
  }
  close() {
    if (this.closed) return
    this.closed = true
    try { void this.writer?.close() } catch {}
    try { void this.reader?.cancel() } catch {}
    try { void (this.sock as any).close?.() } catch {}
    this.onclose()
  }
  buffered() { return this.queued }
}

class Link {
  state: State
  private subs = new Set<() => void>()
  private peer?: PeerType
  private conn?: Transport
  private pendingLan?: LanTransport
  private lanTrying = false
  private lanAttemptAt = 0
  private incoming = new Map<string, { parts: Uint8Array[]; t: Transfer }>()
  private toastId = 0
  private lastClip = ''
  private vapid?: string
  private pcToken = ''
  private pushEndpoint = ''
  private pendingUsb?: UsbTransport
  private usbT?: UsbTransport
  private usbDevice?: AdbDaemonWebUsbDevice
  private adb?: Adb
  private cred?: any
  // ---- liveness / reconnection ----
  private lastRx = 0
  private pongs = 0
  private hbTimer?: number
  private hbSentAt = 0
  private healthTimer?: number
  private reconnectTimer?: number
  private reconnectAttempts = 0
  private peerEpoch = 0
  private connLostAt = 0
  /** A share (or hand-typed content) waiting for the phone to come back. */
  private queuedShare?: { files: File[]; text: string; id?: string }

  constructor() {
    let code = ls.get('code'); let secret = ls.get('secret')
    if (!code) { code = rand(6); ls.set('code', code) }
    if (!secret) { secret = rand(20); ls.set('secret', secret) }
    const params = new URLSearchParams(location.search)
    const focusNotif = params.get('notif') || undefined
    const sharedId = params.get('shared') || undefined
    this.state = { status: 'starting', code, secret, pushState: pushSupported() ? (ls.get('push') === '1' ? 'on' : 'off') : 'unsupported', pushSynced: false, notifs: [], threads: [], sms: {}, smsMore: {}, smsBusy: {}, smsError: {}, calls: [], photos: [], photosMore: false, transfers: [], clips: JSON.parse(ls.get('clips') || '[]'), toasts: [], seed: ls.get('seed') || undefined, focusNotif, fsPath: '', fsItems: [], fsAccess: false, fsReady: false, locBusy: false, ringing: false, mode: ls.get('mode') === 'cloud' ? 'cloud' : 'auto', lanManual: parseLan(ls.get('lanManual')), lanBusy: false, usbSupported: usbSupported(), usbBusy: false, usbMessage: undefined, share: null, shareQueued: false, bookUi: ls.get('bookui') === '1', latency: null }
    void this.start()
    // If we already know the phone's LAN endpoints (learned during a previous
    // pairing), try the direct route right away; keep retrying while offline
    // and upgrade a cloud connection to LAN when the network allows it.
    void this.tryLan()
    this.startHeartbeat()
    this.healthTimer = window.setInterval(() => this.health(), 15000)
    if (sharedId) void this.openShare(sharedId)
    else if (params.get('share') === '1') void pruneShared()
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
    window.addEventListener('focus', () => { this.pushClipboard(false); if (!this.conn?.open) this.reconnectNow() })
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return
      this.pushClipboard(false); this.queuePcInfo()
      // Waking the device (or switching back to this tab) is the moment the old
      // socket is most likely dead: check it at once instead of waiting.
      if (!this.conn?.open) this.reconnectNow()
      else {
        // Coming back to the tab: give the link a moment to answer the ping
        // below before any silence is judged.
        this.lastRx = Date.now()
        this.heartbeat()
      }
    })
    // Network came back (Wi-Fi roamed, VPN up, hotspot on): stop waiting out the
    // backoff and try everything again immediately.
    window.addEventListener('online', () => { this.reconnectAttempts = 0; this.queuePcInfo(); this.reconnectNow() })
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
    this.notify('スマホから呼び出し中', 'Quick Link のタブで「停止」を押すと止まります', { key: 'tsunagu-ring' }, true)
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

  /** Starts (or restarts) the PeerJS listener. The library is imported here
   *  rather than at the top of the module so it never sits on the first paint. */
  private async start() {
    const epoch = ++this.peerEpoch
    try { this.peer?.destroy() } catch {}
    let Peer: typeof PeerType
    try {
      Peer = (await import('peerjs')).default
    } catch {
      this.set({ status: 'starting' })
      this.scheduleReconnect()
      return
    }
    if (epoch !== this.peerEpoch) return // a newer start() already took over
    let peer: PeerType
    try {
      peer = new Peer('tsunagu-link-' + this.state.code.toLowerCase(), { debug: 0 })
    } catch {
      this.set({ status: 'starting' })
      this.scheduleReconnect()
      return
    }
    this.peer = peer
    peer.on('open', () => { this.reconnectAttempts = 0; this.set({ status: this.conn?.open ? 'connected' : 'waiting', error: undefined }) })
    peer.on('connection', (c) => this.onConn(new PeerTransport(c), c))
    peer.on('disconnected', () => {
      if (peer.destroyed) return
      try { peer.reconnect() } catch { setTimeout(() => this.scheduleReconnect(), 1500) }
    })
    peer.on('error', (e: any) => {
      if (e.type === 'unavailable-id') this.set({ status: 'error', error: 'このコードは別のタブで使用中です。ほかのタブを閉じてください。' })
      else if (e.type === 'network' || e.type === 'server-error' || e.type === 'socket-error') {
        // Offline (no internet at all) is expected when working over a USB cable:
        // never knock a live USB connection back to "starting".
        if (!(this.conn?.kind === 'usb' && this.conn.open)) this.set({ status: 'starting' })
        this.scheduleReconnect()
      }
    })
  }

  // ---------------- Liveness: heartbeat, dead-link detection, reconnect ----------------
  /** Ping the phone every few seconds and watch for its answer. A WebRTC data
   *  channel (cloud or LAN) can stay "open" long after the other end is gone —
   *  that is what left the connection badge claiming 「接続中」 while nothing
   *  moved. Silence for HEARTBEAT_DEAD_MS now tears the transport down and
   *  reconnects, so the badge always reflects a link that answers. */
  private startHeartbeat() {
    if (this.hbTimer) return
    this.hbTimer = window.setInterval(() => this.heartbeat(), HEARTBEAT_MS)
  }
  private heartbeat() {
    const c = this.conn
    const now = Date.now()
    if (!c) {
      if (this.state.status === 'connected') this.set({ status: 'waiting', via: undefined })
      return
    }
    if (!c.open) { this.dropStale('closed'); return }
    // A hidden tab has its timers throttled (Chrome: about once a minute), so
    // silence there says nothing about the link — judging it would tear down a
    // perfectly good connection every time the user switched tabs.
    // Silence only means "dead" once this phone has proved it answers pings: an
    // older app build does not know `ping` and would look silent while healthy.
    const hidden = typeof document !== 'undefined' && document.hidden
    if (!hidden && this.pongs > 0 && this.lastRx && now - this.lastRx > HEARTBEAT_DEAD_MS) { this.dropStale('silent'); return }
    this.hbSentAt = now
    try { c.send({ t: 'ping', ts: now }) } catch { this.dropStale('closed') }
  }
  /** A watchdog for everything the heartbeat cannot see: PeerJS fell over while
   *  no window event fired, or the LAN route became reachable again. */
  private health() {
    if (!this.conn?.open) {
      const p: any = this.peer
      if (!p || p.destroyed) { void this.start(); return }
      if (p.disconnected) { try { p.reconnect() } catch { void this.start() } }
    }
    if (this.state.mode !== 'cloud') void this.tryLan()
  }
  /** Tear down a transport that stopped answering, and start looking again. */
  private dropStale(reason: 'closed' | 'silent') {
    const c = this.conn
    this.conn = undefined
    this.connLostAt = Date.now()
    this.set({ status: 'waiting', via: undefined, media: undefined, incomingCall: null, pushSynced: false, sys: null, latency: null })
    try { c?.close() } catch {}
    this.stopRing(false)
    this.toast(reason === 'silent' ? '接続が応答しないため、つなぎ直しています…' : '接続が切れたため、つなぎ直しています…')
    this.scheduleReconnect(300)
  }
  private scheduleReconnect(delay?: number) {
    const attempt = this.reconnectAttempts++
    const wait = delay ?? Math.min(15000, 500 * Math.pow(1.7, attempt)) + Math.random() * 500
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = window.setTimeout(() => this.reconnectNow(), wait)
  }
  /** Try every route now: the peer (if it died), then the LAN direct link. */
  private reconnectNow() {
    if (this.conn?.open) return
    const p: any = this.peer
    if (!p || p.destroyed) void this.start()
    else if (p.disconnected) { try { p.reconnect() } catch { void this.start() } }
    if (this.state.mode !== 'cloud' && navigator.onLine) void this.tryLan()
  }

  regenerate() {
    // A new pairing code invalidates the old pairing: drop the Web Push
    // subscription too (the phone discards it with the old token as well).
    // It can be re-enabled after the new pairing connects.
    void this.disablePush()
    this.vapid = undefined; this.pcToken = ''
    const code = rand(6), secret = rand(20); ls.set('code', code); ls.set('secret', secret); ls.set('trusted', '[]'); ls.del('lan')
    this.conn?.close(); this.pendingLan?.close(); this.set({ code, secret, status: 'starting', device: undefined, via: undefined, pushSynced: false }); void this.start()
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
    if (this.pendingUsb === t) { this.pendingUsb = undefined; return }
    if (t.kind === 'usb') {
      if (this.usbT === t) this.usbT = undefined
      try { void this.adb?.close() } catch {}
      this.adb = undefined
    }
    if (this.conn === t) {
      this.conn = undefined
      this.connLostAt = Date.now()
      this.set({ status: 'waiting', via: undefined, media: undefined, incomingCall: null, pushSynced: false, sys: null, latency: null })
      this.stopRing(false)
      this.toast(t.kind === 'usb' ? 'USB ケーブルの接続が切れました' : 'スマートフォンとの接続が切れました')
      this.scheduleReconnect(1000)
    }
  }

  private accept(c: Transport, hello: any) {
    const previous = this.conn
    this.conn = c
    this.lastRx = Date.now()
    this.pongs = 0
    this.reconnectAttempts = 0
    if (this.pendingLan === c) this.pendingLan = undefined
    if (c.kind === 'usb') { this.pendingUsb = undefined; this.usbT = c as UsbTransport }
    // Close the transport we just replaced *after* the new one is in place, so a
    // late close event can never clear the live connection.
    if (previous && previous !== c) { try { previous.close() } catch {} }
    let token = hello.token
    const trusted: string[] = JSON.parse(ls.get('trusted') || '[]')
    if (!trusted.includes(token)) { token = rand(24); trusted.push(token); ls.set('trusted', JSON.stringify(trusted.slice(-10))) }
    const me = this.pcInfo()
    c.send({ t: 'welcome', token, pc: me.name, pcInfo: me })
    this.pcToken = token
    if (hello.vapid) this.vapid = hello.vapid
    if (hello.seed) ls.set('seed', hello.seed)
    this.learnLan(hello.lan)
    this.set({ status: 'connected', via: c.kind, device: { name: hello.name, model: hello.model, android: hello.android }, seed: hello.seed || this.state.seed, pending: undefined, usbMessage: undefined })
    for (const what of ['info', 'notifs', 'media', 'threads', 'calls', 'sys']) this.send({ t: 'get', what })
    this.getPhotos(true)
    // (Re)register the Web Push subscription with this pairing and flush any
    // replies that were queued while the page was closed.
    void this.syncPushSubscription()
    void this.drainOfflineQueue()
    this.toast(`${hello.name} と接続しました`)
    // Content that was waiting for the phone (a share received while it was
    // offline, or one sent before the connection came back) goes out now.
    if (this.queuedShare) setTimeout(() => void this.flushQueuedShare(), 900)
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
  /** Endpoints to try, in order: the one typed in 設定 first, then the ones the
   *  phone reported while pairing. */
  private lanTargets(): LanEps[] {
    const out: LanEps[] = []
    const manual = parseLan(ls.get('lanManual'))
    if (manual) out.push(manual)
    const learned = parseLan(ls.get('lan'))
    if (learned) out.push(learned)
    return out
  }
  /** The endpoint 設定 shows and 「今すぐ接続を試す」 uses. */
  lanTarget(): { eps: LanEps; manual: boolean } | null {
    const manual = parseLan(ls.get('lanManual'))
    if (manual) return { eps: manual, manual: true }
    const learned = parseLan(ls.get('lan'))
    return learned ? { eps: learned, manual: false } : null
  }
  private lanEps(): LanEps | null { return this.lanTargets()[0] || null }

  /** 設定: choose the transport preference. */
  setMode(mode: LinkMode) {
    if (mode === this.state.mode) return
    ls.set('mode', mode); this.set({ mode, lanMessage: undefined })
    if (mode === 'cloud') {
      const c = this.conn
      if (c && c.kind === 'lan') {
        this.conn = undefined; this.pendingLan?.close(); this.pendingLan = undefined
        c.close(); this.set({ status: 'waiting', via: undefined })
      }
      this.toast('クラウド経由で接続します（同じネットワークでも直接接続しません）')
    } else {
      this.toast('同じネットワークでは直接接続を試みます')
      void this.tryLan()
    }
  }

  /** 設定: remember a manually typed LAN endpoint (e.g. a fixed IP the phone
   *  never announces) and try it right away. */
  setManualLan(ip: string, port: number): boolean {
    const host = ip.trim()
    const octets = host.split('.')
    if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(host) || octets.some((n) => Number(n) > 255)) {
      this.toast('IP アドレスを正しく入力してください（例: 192.168.1.23）'); return false
    }
    if (!(port >= 1 && port <= 65535)) { this.toast('ポート番号を確認してください（通常は 47822）'); return false }
    const eps: LanEps = { ips: [host], port }
    ls.set('lanManual', JSON.stringify(eps))
    if (this.state.mode === 'cloud') this.setMode('auto')
    this.set({ lanManual: eps })
    this.toast('ローカル接続先を保存しました')
    void this.connectLocal()
    return true
  }
  clearManualLan() {
    ls.del('lanManual')
    this.set({ lanManual: undefined, lanMessage: undefined })
    this.toast('自動検出に戻しました')
    void this.tryLan()
  }

  /** 設定: try the local route now and report the result here and as a toast. */
  async connectLocal(): Promise<boolean> {
    if (this.state.mode === 'cloud') { this.toast('接続方法が「クラウドのみ」になっています'); return false }
    const target = this.lanTarget()
    if (!target) { this.toast('ローカル接続先がまだ分かりません。スマホと一度つないでください'); return false }
    const { eps } = target
    const where = `${eps.ips[0]}:${eps.port}`
    if (this.conn?.kind === 'lan' && this.conn.open) { this.toast('すでに同じネットワークで直接接続しています'); return true }
    if (this.state.transfers.some((t) => t.state === 'active')) { this.toast('ファイル転送中は接続方法を切り替えられません'); return false }
    this.pendingLan?.close(); this.pendingLan = undefined
    this.set({ lanBusy: true, lanMessage: undefined })
    let ok = false
    try { ok = await this.lanConnect(eps) } finally {
      this.set({ lanBusy: false, lanMessage: ok ? `${where} に接続を試みました（応答待ち）` : `${where} に接続できませんでした` })
    }
    this.toast(ok ? '同じネットワークでの直接接続を試しています…' : `ローカル接続できません: ${where}（同じ Wi-Fi・IP・ポートを確認）`)
    return ok
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
    if (this.state.mode === 'cloud') return
    if (this.conn?.kind === 'usb' && this.conn.open) return // the cable wins
    if (this.lanTrying || (this.conn?.kind === 'lan' && this.conn.open) || this.pendingLan) return
    if (this.state.transfers.some((t) => t.state === 'active')) return // never switch transports mid-transfer
    const targets = this.lanTargets(); if (!targets.length) return
    // A failing network should not be hammered on every health tick: back off
    // from 5s up to a minute, and reset the moment a probe succeeds.
    const wait = Math.min(60000, 5000 * Math.pow(1.5, this.lanFailures))
    if (Date.now() - this.lanAttemptAt < wait) return
    this.lanAttemptAt = Date.now()
    this.lanTrying = true
    let ok = false
    try {
      for (const eps of targets) { if (await this.lanConnect(eps)) { ok = true; break } }
    } catch { /* unreachable / blocked: cloud fallback keeps working */ }
    finally {
      this.lanTrying = false
      if (ok) this.lanFailures = 0
      else this.lanFailures = Math.min(8, this.lanFailures + 1)
    }
  }
  private lanFailures = 0
  private async lanConnect(eps: LanEps): Promise<boolean> {
    // Never run two handshakes at once: a stale offer answering late used to
    // overwrite the live socket's state.
    this.pendingLan?.close(); this.pendingLan = undefined
    const auth = await this.lanAuth()
    const ip = await firstOk(eps.ips.map(async (ip) => { await this.lanFetch(ip, eps.port, '/ping', { auth }, 1500); return ip }))
    if (this.conn?.kind === 'lan' && this.conn.open) return true
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
      if (this.pendingLan !== t) return false // superseded / closed meanwhile
      await pc.setRemoteDescription({ type: 'answer', sdp: ans.sdp })
    } catch { t.close(); if (this.pendingLan === t) this.pendingLan = undefined; return false }
    // If the channel opens but no hello is accepted within 8s, give up on it.
    setTimeout(() => { if (this.pendingLan === t) { this.pendingLan = undefined; t.close() } }, 8000)
    return true
  }

  // ---------------- USB cable (ADB over WebUSB) ----------------
  /** 設定/接続画面: connect over the USB cable — no Wi-Fi, no mobile data and no
   *  internet needed. A device this page was already allowed to use is reused
   *  silently; otherwise the browser's device chooser opens. */
  async connectUsb(): Promise<boolean> {
    if (!usbSupported()) {
      this.set({ usbMessage: 'このブラウザは USB 接続に対応していません。PC の Chrome か Edge でお試しください。' })
      this.toast('このブラウザは USB 接続に対応していません')
      return false
    }
    if (this.state.usbBusy) return false
    if (this.conn?.kind === 'usb' && this.conn.open) { this.toast('すでに USB ケーブルで接続しています'); return true }
    if (this.state.transfers.some((t) => t.state === 'active')) { this.toast('ファイル転送中は接続方法を切り替えられません'); return false }
    this.set({ usbBusy: true, usbMessage: undefined })
    try {
      // The ADB stack is large and only the cable route needs it: load it here,
      // not on the startup path.
      const adbUsb = await import('@yume-chan/adb-daemon-webusb')
      const manager = adbUsb.AdbDaemonWebUsbDeviceManager.BROWSER
      if (!manager) {
        this.set({ usbMessage: 'このブラウザは USB 接続に対応していません。PC の Chrome か Edge でお試しください。' })
        return false
      }
      let device = this.usbDevice
      if (!device) {
        const known = await Promise.resolve(manager.getDevices()).catch(() => [] as AdbDaemonWebUsbDevice[])
        device = known[0]
      }
      if (!device) {
        this.set({ usbMessage: 'スマホの「USB デバッグ」を ON にして USB ケーブルでつなぎ、一覧からスマホを選んでください。' })
        device = await Promise.resolve(manager.requestDevice()).catch(() => undefined)
      }
      if (!device) { this.set({ usbMessage: 'USB デバイスが選ばれませんでした。' }); return false }
      return await this.usbOpen(device)
    } catch (e: any) {
      const msg = usbErrorText(e)
      this.set({ usbMessage: msg }); this.toast(msg)
      return false
    } finally {
      this.set({ usbBusy: false })
    }
  }

  private async usbOpen(device: AdbDaemonWebUsbDevice): Promise<boolean> {
    this.usbT?.close(); this.usbT = undefined
    this.set({ usbMessage: 'USB で接続しています…（スマホに「USB デバッグを許可しますか？」が出たら「許可」を押してください）' })
    try {
      const [{ Adb, AdbDaemonTransport }, { default: AdbWebCredentialStore }] = await Promise.all([
        import('@yume-chan/adb'),
        import('@yume-chan/adb-credential-web'),
      ])
      if (!this.cred) this.cred = new AdbWebCredentialStore('Quick Link')
      const connection = await withTimeout(device.connect(), 20000, 'USB デバイスを開けませんでした。ケーブルを差し直してお試しください。')
      // The phone asks for permission the first time: wait for its answer, but
      // never leave the button spinning forever if nobody taps it.
      const transport = await withTimeout(
        AdbDaemonTransport.authenticate({ serial: device.serial, connection, credentialStore: this.cred }),
        90000,
        'スマホの画面に出る「USB デバッグを許可しますか？」で「許可」を押してください（スマホの画面を見たまま、もう一度お試しください）。',
      )
      this.adb = new Adb(transport)
      let sock: any
      try {
        sock = await withTimeout(this.adb.createSocket(USB_SOCKET), 15000, 'no-app')
      } catch (e: any) {
        // The ADB link itself is fine — the app just is not serving the USB
        // socket yet (older build, or 連携サービス stopped).
        throw new UsbNoAppError(String(e?.message || e))
      }
      const t = new UsbTransport(sock)
      this.pendingUsb = t
      t.onmsg = (m) => this.onData(t, m)
      t.onclose = () => this.onTransportClose(t)
      this.usbDevice = device
      t.send({ t: 'usb_auth', auth: await this.usbAuthHashes() })
      // The phone answers with its hello over this socket; silence usually means
      // an older app build (no USB socket yet) or the app not running.
      setTimeout(() => {
        if (this.pendingUsb !== t) return
        this.pendingUsb = undefined; t.close()
        this.set({ usbMessage: 'スマホから応答がありません。スマホで Quick Link アプリ（v1.3.0 以降）を開いたままにしてください。' })
      }, 15000)
      return true
    } catch (e: any) {
      const msg = e instanceof UsbNoAppError
        ? 'スマホの Quick Link アプリ（v1.3.0 以降）を開いたままにしてから、もう一度お試しください。'
        : usbErrorText(e)
      this.set({ usbMessage: msg }); this.toast(msg)
      try { void this.adb?.close() } catch {}
      this.adb = undefined
      // A half-opened USB device would make the next attempt fail with "busy".
      try { void (device.raw as any)?.close?.() } catch {}
      return false
    }
  }

  /** User action: drop the USB link (the other transports take over again). */
  disconnectUsb() {
    const t = this.conn?.kind === 'usb' ? this.conn : this.usbT || this.pendingUsb
    // Detach first so onTransportClose does not report it as an unexpected drop.
    if (this.conn === t) this.conn = undefined
    this.pendingUsb = undefined; this.usbT = undefined
    t?.close()
    try { void this.adb?.close() } catch {}
    this.adb = undefined
    this.set({ usbMessage: undefined })
    if (!this.conn) this.set({ status: this.peer ? 'waiting' : 'starting', via: undefined, media: undefined, incomingCall: null, sys: null })
    this.toast('USB 接続を解除しました')
    this.reconnectAttempts = 0
    setTimeout(() => this.reconnectNow(), 500)
  }

  /** Hashes the phone accepts over USB: the pairing token it stored, or the
   *  pairing code (for a first pairing with no prior connection). */
  private async usbAuthHashes(): Promise<string[]> {
    const base = await this.lanAuth()
    return [...base, await sha256Hex(this.state.code)]
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
    // Any answer (including the heartbeat reply) proves this transport is alive.
    if (c === this.conn) {
      this.lastRx = Date.now()
      if (m.t === 'pong') { this.pongs++; if (m.ts) this.set({ latency: Math.max(0, Date.now() - Number(m.ts)) }) }
    }
    if (m.t === 'hello') {
      // A better transport wins and the live one is never replaced by a slower
      // route (USB cable > same network > cloud).
      const rank: Record<Via, number> = { usb: 3, lan: 2, cloud: 1 }
      if (this.conn?.open && rank[this.conn.kind] > rank[c.kind]) { c.close(); return }
      if (m.vapid) this.vapid = m.vapid
      const trusted: string[] = JSON.parse(ls.get('trusted') || '[]')
      if (m.token === this.state.secret || trusted.includes(m.token)) this.accept(c, m)
      else this.set({ pending: { name: m.name || 'Android', accept: () => this.accept(c, m), reject: () => { c.close(); this.set({ pending: undefined }) } } })
      return
    }
    if (c !== this.conn) return
    const s = this.state
    switch (m.t) {
      case 'pong': break
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
      case 'notifs': this.set({ notifs: m.items || [], notifsError: m.error || undefined }); break
      case 'notif': {
        const n: Notif = m.item
        this.set({ notifs: [n, ...s.notifs.filter((x) => x.key !== n.key)] })
        if (m.fresh) this.notify(`${n.app}: ${n.title}`, n.text, { key: n.key, reply: n.reply, actions: n.actions, icon: n.icon })
        break
      }
      case 'notif_rm': this.set({ notifs: s.notifs.filter((x) => x.key !== m.key) }); break
      // Result of a dismiss: say why when the phone could not clear it, instead
      // of leaving the row on screen with no explanation.
      case 'notif_dismiss_result': {
        const key = String(m.key || '')
        if (m.ok) {
          if (key === '*') setTimeout(() => this.send({ t: 'get', what: 'notifs' }), 900)
          else this.set({ notifs: s.notifs.filter((x) => x.key !== key) })
          break
        }
        const reason = String(m.reason || '')
        if (reason === 'off') this.toast('スマホの「通知へのアクセス」がオフになっています。スマホの設定 →「通知へのアクセス」で Quick Link を許可してください')
        else if (reason === 'locked') this.toast('この通知はスマホ側で消せません（進行中・消去不可の通知です）')
        else if (reason === 'missing') this.set({ notifs: s.notifs.filter((x) => x.key !== key) })
        else this.toast('通知を消せませんでした')
        break
      }
      case 'media': this.set({ media: m.state }); break
      case 'clip': {
        this.lastClip = m.text
        this.set({ clips: this.addClip({ text: m.text, time: Date.now(), from: 'phone' }) })
        navigator.clipboard?.writeText(m.text).then(() => this.toast('スマホのクリップボードをコピーしました')).catch(() =>
          this.toast('スマホからテキストが届きました', { label: 'コピー', run: () => navigator.clipboard.writeText(m.text) }))
        break
      }
      case 'threads': this.set({ threads: m.items || [], threadsError: m.error || undefined }); break
      case 'sms': {
        const tid = String(m.threadId || '')
        if (!tid) break
        const older = !!m.older
        const items: Sms[] = Array.isArray(m.items) ? m.items : []
        const cur = s.sms[tid] || []
        const had = new Set(cur.map((x) => String(x.id)))
        const added = items.filter((x) => !had.has(String(x.id))).length
        // Optimistic entries from sendSms() are replaced by the phone's copy.
        const base = cur.filter((x) => !(String(x.id).startsWith('tmp') && items.some((y) => y.mine && y.body === x.body)))
        const map = new Map<string, Sms>()
        for (const x of [...base, ...items]) if (x && x.id != null) map.set(String(x.id), x)
        const list = [...map.values()].sort((a, b) => (a.time || 0) - (b.time || 0))
        this.clearSmsTimer(tid)
        this.set({
          sms: { ...s.sms, [tid]: list },
          // An older page that added nothing means the history ends here.
          smsMore: { ...s.smsMore, [tid]: !!m.hasMore && !(older && added === 0) },
          smsBusy: { ...s.smsBusy, [tid]: false },
          smsError: { ...s.smsError, [tid]: m.error ? this.smsErrorText(String(m.error)) : undefined },
        })
        break
      }
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
        const mode = m.mode === 'always' ? 'always' : m.mode === 'while_in_use' ? 'while_in_use' : undefined
        const fg = m.fg === true
        clearTimeout(this.locTimer)
        if (m.error) this.set({ locError: String(m.error), locBusy: false, locMode: mode, locFg: fg })
        else this.set({ loc: { lat: m.lat, lng: m.lng, acc: m.acc ?? null, time: m.time }, locError: undefined, locBusy: false, locMode: mode, locFg: fg })
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

  /** Wait while the data channel is full. Bounded, so a dead link can never
   *  leave a send loop spinning forever (the old loop had no way out). */
  private async drain(c: Transport, limit = 4 * 1024 * 1024, maxMs = 45000): Promise<boolean> {
    const t0 = Date.now()
    while (c.buffered() > limit) {
      if (this.conn !== c || !c.open) return false
      if (Date.now() - t0 > maxMs) return false
      await new Promise((r) => setTimeout(r, 30))
    }
    return true
  }

  async sendFiles(files: FileList | File[]) {
    const c = this.conn
    if (!c?.open) { this.toast('スマホが接続されていません'); return }
    for (const file of Array.from(files)) {
      const id = rand(10)
      const t: Transfer = { id, name: file.name, size: file.size, mime: file.type, done: 0, dir: 'out', state: 'active' }
      this.set({ transfers: [t, ...this.state.transfers] })
      this.send({ t: 'file_start', id, name: file.name, size: file.size, mime: file.type || 'application/octet-stream' })
      try {
        for (let off = 0; off < file.size; off += CHUNK) {
          const buf = await file.slice(off, off + CHUNK).arrayBuffer()
          if (!(await this.drain(c))) throw new Error('closed')
          this.send({ t: 'file_chunk', id, d: b64(buf) })
          if ((off / CHUNK) % 8 === 0) this.updT(id, { done: off + buf.byteLength })
        }
        this.send({ t: 'file_end', id }); this.updT(id, { state: 'done', done: file.size })
      } catch { this.updT(id, { state: 'error' }) }
    }
  }

  getPhotos(reset: boolean) { this.send({ t: 'get', what: 'photos', offset: reset ? 0 : this.state.photos.length }) }

  private smsTimers = new Map<string, number>()
  private clearSmsTimer(tid: string) {
    const t = this.smsTimers.get(tid)
    if (t) { clearTimeout(t); this.smsTimers.delete(tid) }
  }
  private smsErrorText(e: string) {
    if (e === 'permission') return 'スマホでメッセージ（SMS）の権限が許可されていません。スマホの Quick Link アプリの「連携する機能」から許可してください。'
    return `メッセージを読み込めませんでした（${e}）`
  }

  /** Asks for one page of a conversation (newest page, or older than `before`).
   *  Always ends in either the messages or a visible reason: a page that never
   *  arrives used to leave the conversation silently blank. */
  private requestSms(threadId: string, before: number) {
    if (!threadId || threadId === 'new') return
    if (!this.conn?.open) {
      this.set({ smsError: { ...this.state.smsError, [threadId]: 'スマホが接続されていません' }, smsBusy: { ...this.state.smsBusy, [threadId]: false } })
      return
    }
    this.set({ smsBusy: { ...this.state.smsBusy, [threadId]: true } })
    this.send({ t: 'get', what: 'sms', threadId, before })
    this.clearSmsTimer(threadId)
    this.smsTimers.set(threadId, window.setTimeout(() => {
      this.smsTimers.delete(threadId)
      if (!this.state.smsBusy[threadId]) return
      this.set({
        smsBusy: { ...this.state.smsBusy, [threadId]: false },
        smsError: { ...this.state.smsError, [threadId]: 'スマホから応答がありません。Quick Link アプリが動いているか確認して、もう一度お試しください。' },
      })
    }, 15000))
  }

  openThread(id: string) {
    if (id && id !== 'new') {
      this.set({ smsError: { ...this.state.smsError, [id]: undefined } })
      this.requestSms(id, 0)
      this.send({ t: 'mark_read', threadId: id })
    }
    // Optimistically clear the badge; the phone's next threads push is authoritative.
    this.set({ threads: this.state.threads.map((t) => (t.id === id ? { ...t, unread: false, unreadCount: 0 } : t)) })
  }
  /** 「以前のメッセージを読み込む」: the page before the oldest message we hold. */
  loadOlder(id: string) {
    const list = this.state.sms[id] || []
    const oldest = list.length ? list[0].time : 0
    if (!oldest) return
    this.requestSms(id, oldest)
  }
  retryThread(id: string) { this.set({ smsError: { ...this.state.smsError, [id]: undefined } }); this.requestSms(id, 0) }
  clearWatch() { this.send({ t: 'watch', threadId: '' }) }

  // ---------------- Explorer ----------------
  fsList(path: string) { this.send({ t: 'get', what: 'fs', path }) }
  fsDownload(path: string) { this.send({ t: 'fs_get', path }); this.toast('PC に転送しています…') }
  fsDelete(path: string) { this.send({ t: 'fs_delete', path }) }
  fsRename(path: string, name: string) { this.send({ t: 'fs_rename', path, name }) }
  fsMkdir(path: string, name: string) { this.send({ t: 'fs_mkdir', path, name }) }
  fsPerm() { this.send({ t: 'fs_perm' }) }
  async fsUpload(files: FileList | File[], dir: string) {
    const c = this.conn
    if (!c?.open) { this.toast('スマホが接続されていません'); return }
    for (const file of Array.from(files)) {
      const id = rand(10)
      const t: Transfer = { id, name: file.name, size: file.size, mime: file.type, done: 0, dir: 'out', state: 'active' }
      this.set({ transfers: [t, ...this.state.transfers] })
      this.send({ t: 'fs_put_start', id, dir, name: file.name, size: file.size, mime: file.type || 'application/octet-stream' })
      try {
        for (let off = 0; off < file.size; off += CHUNK) {
          const buf = await file.slice(off, off + CHUNK).arrayBuffer()
          if (!(await this.drain(c))) throw new Error('closed')
          this.send({ t: 'fs_put_chunk', id, d: b64(buf) })
          if ((off / CHUNK) % 8 === 0) this.updT(id, { done: off + buf.byteLength })
        }
        this.send({ t: 'fs_put_end', id }); this.updT(id, { state: 'done', done: file.size })
      } catch { this.updT(id, { state: 'error' }) }
    }
  }

  // ---------------- Notifications ----------------
  /** 消去: the phone reports back whether it worked (and why not). */
  dismissNotif(key: string) {
    if (!this.conn?.open) { this.toast('スマホが接続されていません'); return }
    this.send({ t: 'notif_dismiss', key })
  }

  /** Opens a system permission screen on the phone ("listener" = 通知へのアクセス). */
  permOpen(which: 'listener') { this.send({ t: 'perm_open', which }); this.toast('スマホで許可の画面を開きました') }

  // ---------------- Find （探す） ----------------
  private locTimer?: number
  /** Never leaves the screen stuck on 「取得中…」 when no answer comes back. */
  private armLocTimer(ms: number) {
    clearTimeout(this.locTimer)
    this.locTimer = window.setTimeout(() => this.set({ locBusy: false, locError: this.state.locError || 'unavailable' }), ms)
  }
  getLocation() {
    this.set({ locBusy: true, locError: undefined })
    this.send({ t: 'get', what: 'location' })
    this.armLocTimer(20000)
  }
  /** Opens the phone's permission screen: "always" = 常に許可, "fix" = 使用中のみ. */
  locPerm(which: 'always' | 'fix') {
    this.send({ t: 'loc_perm', which })
    this.toast('スマホで位置情報の許可画面を開きました。許可すると現在地を取得します')
    this.set({ locBusy: true })
    this.armLocTimer(60000)
  }
  /** Asks the phone to open its app and take a fix right now (works with 使用中のみ). */
  locNow() {
    this.send({ t: 'loc_now' })
    this.toast('スマホのアプリで位置情報を取得します（スマホの画面を確認してください）')
    this.set({ locBusy: true, locError: undefined })
    this.armLocTimer(60000)
  }

  clearTransfers() { this.set({ transfers: this.state.transfers.filter((t) => t.state === 'active') }) }

  /** Ask the phone for fresh data and resolve once the matching state changed
   *  (or after `ms`). The AI assistant reads through this so its answers
   *  describe the phone as it is right now, not as it was at connect time. */
  async requestState(what: 'info' | 'notifs' | 'threads' | 'sys' | 'calls' | 'photos' | 'location', ms = 5000): Promise<boolean> {
    if (!this.conn?.open) return false
    const key = what as keyof State
    const before = JSON.stringify(this.state[key] ?? null)
    this.send({ t: 'get', what })
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      await new Promise((r) => setTimeout(r, 120))
      if (JSON.stringify(this.state[key] ?? null) !== before) return true
    }
    return false
  }

  // ---------------- Experimental 「Googlebook OS」 desktop UI ----------------
  setBookUi(on: boolean) {
    ls.set('bookui', on ? '1' : '0')
    this.set({ bookUi: on })
    this.toast(on ? 'Googlebook OS デスクトップUIに切り替えました' : '標準の画面に戻しました')
  }

  // ---------------- Web Share Target (shared from this computer) ----------------
  /** The system share sheet handed content to the PWA: show the send sheet. */
  async openShare(id: string) {
    const entry = await getShared(id)
    if (!entry) { this.toast('共有された内容を読み出せませんでした'); return }
    const text = (entry.text || '').trim()
    // Some apps put the link in `text` and leave `url` empty, and vice versa.
    if (!text && entry.url && !(entry.title || '').includes(entry.url)) entry.text = entry.url
    this.set({ share: entry, shareQueued: false })
    // Drop ?shared=… from the address bar so a reload does not reopen it.
    try { history.replaceState(null, '', location.pathname + (new URLSearchParams(location.search).get('notif') ? location.search : '')) } catch {}
  }
  closeShare() { this.set({ share: null, shareQueued: false }) }

  /** 「スマートフォンに送信」 for whatever the share sheet delivered (files,
   *  text, a link, or a title alone). Nothing is dropped: if the phone is not
   *  connected, the content is held and sent as soon as it is. */
  async sendShare() {
    const e = this.state.share
    if (!e) return
    const files = e.files.length ? await readSharedFiles(e) : []
    const text = (e.text || e.url || '').trim()
    if (!files.length && !text) { this.toast('送る内容がありません'); return }
    if (!this.conn?.open) {
      this.queuedShare = { files, text, id: e.id }
      this.set({ shareQueued: true })
      this.toast('スマートフォンに接続した時点で送信します')
      return
    }
    this.deliver(files, text, e.title)
    this.set({ share: null, shareQueued: false })
    if (e.id) void deleteShared(e.id)
    this.queuedShare = undefined
  }

  /** The 共有 screen's own 「スマートフォンに送信」: hand-typed text and picked
   *  files, sent as one action and queued if the phone is away. */
  sendToPhone(files: File[], text: string) {
    const list = Array.from(files || [])
    const body = (text || '').trim()
    if (!list.length && !body) { this.toast('送るファイルかテキストを選んでください'); return }
    if (!this.conn?.open) {
      this.queuedShare = { files: list, text: body }
      this.toast('スマートフォンに接続した時点で送信します')
      return
    }
    this.deliver(list, body)
  }

  private async flushQueuedShare() {
    const q = this.queuedShare
    if (!q || !this.conn?.open) return
    this.queuedShare = undefined
    this.deliver(q.files, q.text)
    if (this.state.share?.id === q.id) this.set({ share: null, shareQueued: false })
    if (q.id) void deleteShared(q.id)
  }

  /** Files go through the transfer path; text goes to the phone's clipboard and
   *  the clip history, so a link or a sentence arrives wherever it is needed. */
  private deliver(files: File[], text: string, title?: string) {
    const parts: string[] = []
    if (files.length) { void this.sendFiles(files); parts.push(files.length > 1 ? `ファイル ${files.length} 件` : files[0].name) }
    const body = text || (files.length ? '' : (title || '').trim())
    if (body) {
      this.lastClip = body
      this.send({ t: 'clip', text: body })
      this.set({ clips: this.addClip({ text: body, time: Date.now(), from: 'pc' }) })
      parts.push('テキスト')
    }
    this.toast(`スマートフォンに送信しました（${parts.join('・')}）`)
  }
}

export const link = new Link()
;(window as any).tsunagu = link
;(window as any).quicklink = link
