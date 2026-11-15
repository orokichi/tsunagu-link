import Peer, { DataConnection } from 'peerjs'

export type Status = 'starting' | 'waiting' | 'connected' | 'error'
export interface Device { name: string; model: string; android: string }
export interface Info { battery: number; charging: boolean; net: string; carrier?: string; storageFree: number; storageTotal: number; ringer?: string }
export interface Notif { key: string; app: string; pkg: string; title: string; text: string; time: number; icon?: string; reply?: boolean; actions?: string[] }
export interface Media { app: string; title: string; artist: string; playing: boolean; art?: string; position?: number; duration?: number }
export interface Thread { id: string; address: string; name?: string; snippet: string; time: number; unread?: boolean }
export interface Sms { id: string; body: string; time: number; mine: boolean }
export interface Call { number: string; name?: string; type: number; time: number; duration: number }
export interface Photo { id: string; video: boolean; time: number; thumb: string; duration?: number; name: string; size: number }
export interface Transfer { id: string; name: string; size: number; mime: string; done: number; dir: 'in' | 'out'; state: 'active' | 'done' | 'error'; url?: string }
export interface Clip { text: string; time: number; from: 'pc' | 'phone' }
export interface Toast { id: number; text: string; action?: { label: string; run: () => void } }

export interface State {
  status: Status; code: string; secret: string; error?: string
  device?: Device; info?: Info; seed?: string
  notifs: Notif[]; media?: Media | null
  threads: Thread[]; sms: Record<string, Sms[]>
  calls: Call[]; photos: Photo[]; photosMore: boolean
  transfers: Transfer[]; clips: Clip[]; toasts: Toast[]
  pending?: { name: string; accept: () => void; reject: () => void }
  incomingCall?: { number: string; name?: string } | null
}

const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const rand = (n: number, a = ALPHA) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => a[b % a.length]).join('')
const ls = {
  get: (k: string) => localStorage.getItem('ts.' + k),
  set: (k: string, v: string) => localStorage.setItem('ts.' + k, v),
}
const CHUNK = 48 * 1024

function b64(buf: ArrayBuffer) {
  const u = new Uint8Array(buf); let s = ''
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000))
  return btoa(s)
}
function unb64(s: string) { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u }

class Link {
  state: State
  private subs = new Set<() => void>()
  private peer?: Peer
  private conn?: DataConnection
  private incoming = new Map<string, { parts: Uint8Array[]; t: Transfer }>()
  private toastId = 0
  private lastClip = ''

  constructor() {
    let code = ls.get('code'); let secret = ls.get('secret')
    if (!code) { code = rand(6); ls.set('code', code) }
    if (!secret) { secret = rand(20); ls.set('secret', secret) }
    this.state = { status: 'starting', code, secret, notifs: [], threads: [], sms: {}, calls: [], photos: [], photosMore: false, transfers: [], clips: JSON.parse(ls.get('clips') || '[]'), toasts: [], seed: ls.get('seed') || undefined }
    this.start()
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
    peer.on('connection', (c) => this.onConn(c))
    peer.on('disconnected', () => { if (!peer.destroyed) setTimeout(() => peer.reconnect(), 2000) })
    peer.on('error', (e: any) => {
      if (e.type === 'unavailable-id') this.set({ status: 'error', error: 'このコードは別のタブで使用中です。ほかのタブを閉じてください。' })
      else if (e.type === 'network' || e.type === 'server-error' || e.type === 'socket-error') { this.set({ status: 'starting' }); setTimeout(() => this.start(), 4000) }
    })
  }

  regenerate() {
    const code = rand(6), secret = rand(20); ls.set('code', code); ls.set('secret', secret); ls.set('trusted', '[]')
    this.conn?.close(); this.set({ code, secret, status: 'starting', device: undefined }); this.start()
  }

  get qrText() { return `tsunagu:${this.state.code}:${this.state.secret}` }

  private onConn(c: DataConnection) {
    c.on('data', (d: any) => this.onData(c, d))
    c.on('close', () => { if (this.conn === c) { this.conn = undefined; this.set({ status: 'waiting', media: undefined, incomingCall: null }); this.toast('スマートフォンとの接続が切れました') } })
    c.on('error', () => {})
  }

  private accept(c: DataConnection, hello: any) {
    if (this.conn && this.conn !== c) this.conn.close()
    this.conn = c
    let token = hello.token
    const trusted: string[] = JSON.parse(ls.get('trusted') || '[]')
    if (!trusted.includes(token)) { token = rand(24); trusted.push(token); ls.set('trusted', JSON.stringify(trusted.slice(-10))) }
    c.send({ t: 'welcome', token, pc: navigator.userAgent.includes('Windows') ? 'Windows PC' : 'PC' })
    if (hello.seed) ls.set('seed', hello.seed)
    this.set({ status: 'connected', device: { name: hello.name, model: hello.model, android: hello.android }, seed: hello.seed || this.state.seed, pending: undefined })
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
  private notify(title: string, body: string, icon?: string) {
    if (document.hasFocus() || !('Notification' in window) || Notification.permission !== 'granted') return
    try { new Notification(title, { body, icon: icon ? 'data:image/png;base64,' + icon : '/icon.svg', silent: false }) } catch {}
  }

  private onData(c: DataConnection, m: any) {
    if (!m || typeof m !== 'object') return
    if (m.t === 'hello') {
      const trusted: string[] = JSON.parse(ls.get('trusted') || '[]')
      if (m.token === this.state.secret || trusted.includes(m.token)) this.accept(c, m)
      else this.set({ pending: { name: m.name || 'Android', accept: () => this.accept(c, m), reject: () => { c.close(); this.set({ pending: undefined }) } } })
      return
    }
    if (c !== this.conn) return
    const s = this.state
    switch (m.t) {
      case 'info': this.set({ info: m.info }); break
      case 'notifs': this.set({ notifs: m.items }); break
      case 'notif': {
        const n: Notif = m.item
        this.set({ notifs: [n, ...s.notifs.filter((x) => x.key !== n.key)] })
        if (m.fresh) this.notify(`${n.app}: ${n.title}`, n.text, n.icon)
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
        this.notify(m.name || m.address, m.body); this.toast(`SMS: ${m.name || m.address}`)
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
        const u = unb64(m.d); f.parts.push(u); f.t.done += u.length
        this.updT(m.id, { done: f.t.done }); break
      }
      case 'file_end': {
        const f = this.incoming.get(m.id); if (!f) return
        this.incoming.delete(m.id)
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
          const dc = (this.conn as any)?.dataChannel as RTCDataChannel | undefined
          while (dc && dc.bufferedAmount > 4 * 1024 * 1024) await new Promise((r) => setTimeout(r, 30))
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
