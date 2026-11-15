import Peer, { DataConnection } from 'peerjs'

export type Status = 'starting' | 'waiting' | 'connected' | 'error'
export type Via = 'lan' | 'cloud'
export interface Device { name: string; model: string; android: string }
export interface Info { battery: number; charging: boolean; net: string; carrier?: string; storageFree: number; storageTotal: number; ringer?: string; lan?: LanEps }
export interface LanEps { ips: string[]; port: number }
export interface Notif { key: string; app: string; pkg: string; title: string; text: string; time: number; icon?: string; reply?: boolean; actions?: string[] }
export interface Media { app: string; title: string; artist: string; playing: boolean; art?: string; position?: number; duration?: number }
export interface Thread { id: string; address: string; name?: string; snippet: string; time: number; unread?: boolean; kind?: 'sms' | 'rcs' | 'mms' }
export interface Sms { id: string; body: string; time: number; mine: boolean; kind?: 'sms' | 'rcs' | 'mms' }
export interface Call { number: string; name?: string; type: number; time: number; duration: number }
export interface Photo { id: string; video: boolean; time: number; thumb: string; duration?: number; name: string; size: number }
export interface Transfer { id: string; name: string; size: number; mime: string; done: number; dir: 'in' | 'out'; state: 'active' | 'done' | 'error'; url?: string }
export interface Clip { text: string; time: number; from: 'pc' | 'phone' }
export interface Toast { id: number; text: string; action?: { label: string; run: () => void } }

export interface State {
  status: Status; code: string; secret: string; error?: string
  device?: Device; info?: Info; seed?: string; via?: Via
  notifs: Notif[]; media?: Media | null
  threads: Thread[]; sms: Record<string, Sms[]>
  calls: Call[]; photos: Photo[]; photosMore: boolean
  transfers: Transfer[]; clips: Clip[]; toasts: Toast[]
  pending?: { name: string; accept: () => void; reject: () => void }
  incomingCall?: { number: string; name?: string } | null
  focusNotif?: string
}

const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const rand = (n: number, a = ALPHA) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => a[b % a.length]).join('')
const ls = {
  get: (k: string) => localStorage.getItem('ts.' + k),
  set: (k: string, v: string) => localStorage.setItem('ts.' + k, v),
  del: (k: string) => localStorage.removeItem('ts.' + k),
}
const CHUNK = 48 * 1024
export const APP_VERSION = '1.0.4'

function b64(buf: ArrayBuffer) {
  const u = new Uint8Array(buf); let s = ''
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000))
  return btoa(s)
}
function unb64(s: string) { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u }

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

  constructor() {
    let code = ls.get('code'); let secret = ls.get('secret')
    if (!code) { code = rand(6); ls.set('code', code) }
    if (!secret) { secret = rand(20); ls.set('secret', secret) }
    const focusNotif = new URLSearchParams(location.search).get('notif') || undefined
    this.state = { status: 'starting', code, secret, notifs: [], threads: [], sms: {}, calls: [], photos: [], photosMore: false, transfers: [], clips: JSON.parse(ls.get('clips') || '[]'), toasts: [], seed: ls.get('seed') || undefined, focusNotif }
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
      if (d.type === 'notif_reply' && d.key && d.text) { this.send({ t: 'notif_reply', key: d.key, text: d.text }); this.toast('返信を送信しました') }
      else if (d.type === 'notif_action' && d.key) this.send({ t: 'notif_action', key: d.key, index: d.index | 0 })
      else if (d.type === 'focus_notif' && d.key) this.set({ focusNotif: d.key })
    })
    window.addEventListener('focus', () => this.pushClipboard(false))
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.pushClipboard(false) })
  }

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
    const code = rand(6), secret = rand(20); ls.set('code', code); ls.set('secret', secret); ls.set('trusted', '[]'); ls.del('lan')
    this.conn?.close(); this.pendingLan?.close(); this.set({ code, secret, status: 'starting', device: undefined, via: undefined }); this.start()
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
      this.set({ status: 'waiting', via: undefined, media: undefined, incomingCall: null })
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
    c.send({ t: 'welcome', token, pc: navigator.userAgent.includes('Windows') ? 'Windows PC' : 'PC' })
    if (hello.seed) ls.set('seed', hello.seed)
    this.learnLan(hello.lan)
    this.set({ status: 'connected', via: c.kind, device: { name: hello.name, model: hello.model, android: hello.android }, seed: hello.seed || this.state.seed, pending: undefined })
    for (const what of ['info', 'notifs', 'media', 'threads', 'calls']) this.send({ t: 'get', what })
    this.getPhotos(true)
    this.toast(`${hello.name} と接続しました`)
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission()
  }

  send(m: any) { if (this.conn?.open) this.conn.send(m) }
  toast(text: string, action?: Toast['action']) {
    const id = ++this.toastId; this.set({ toasts: [...this.state.toasts, { id, text, action }] })
    setTimeout(() => this.set({ toasts: this.state.toasts.filter((t) => t.id !== id) }), action ? 8000 : 3500)
  }
  clearFocusNotif() { if (this.state.focusNotif) this.set({ focusNotif: undefined }) }

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

  private notify(title: string, body: string, rich?: { key?: string; reply?: boolean; actions?: string[]; icon?: string }) {
    if (document.hasFocus() || !('Notification' in window) || Notification.permission !== 'granted') return
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
        data: { key: rich?.key || '' },
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
      const trusted: string[] = JSON.parse(ls.get('trusted') || '[]')
      if (m.token === this.state.secret || trusted.includes(m.token)) this.accept(c, m)
      else this.set({ pending: { name: m.name || 'Android', accept: () => this.accept(c, m), reject: () => { c.close(); this.set({ pending: undefined }) } } })
      return
    }
    if (c !== this.conn) return
    const s = this.state
    switch (m.t) {
      case 'info': this.set({ info: m.info }); this.learnLan(m.info?.lan); break
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
  openThread(id: string) { this.send({ t: 'get', what: 'sms', threadId: id }) }
  clearTransfers() { this.set({ transfers: this.state.transfers.filter((t) => t.state === 'active') }) }
}

export const link = new Link()
;(window as any).tsunagu = link
