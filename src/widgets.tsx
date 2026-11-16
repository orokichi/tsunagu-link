import { useSyncExternalStore } from 'react'
import type { State } from './link'
import { Icon } from './icons'

/**
 * 「ウィジェットを作成」 — Material 3 Expressive widgets the AI composes out of
 * parts that already exist.
 *
 * Nothing here is generated HTML: a widget is a JSON choice among a fixed set of
 * React templates (`compact-stat`, `dual-metric`, `status-card`, `feed-list`,
 * `control-panel`), sizes, M3 colour roles, an icon and up to four live data
 * sources. Groq (the same key as Quick AI) only picks the combination for what
 * the user asked for; the drawing, the layout and the colours all come from this
 * file, so a model can never produce a broken or unstyled card. Every value is
 * read from the phone's live state, so the widget updates as the phone changes.
 *
 * Without a Groq key the same list of templates is offered as one-tap presets.
 */

export type WidgetSource =
  | 'battery' | 'batterySaver' | 'connection' | 'notifications' | 'latestNotification'
  | 'messages' | 'location' | 'volume' | 'clipboard' | 'deviceInfo'
export type WidgetTemplate = 'compact-stat' | 'dual-metric' | 'status-card' | 'feed-list' | 'control-panel'
export type WidgetSize = 'small' | 'medium' | 'large'
export type WidgetTheme = 'primary' | 'tertiary' | 'secondary' | 'surface'

export interface Widget {
  id: string
  template: WidgetTemplate
  size: WidgetSize
  theme: WidgetTheme
  icon: string
  title: string
  sources: WidgetSource[]
  prompt?: string
  ai?: boolean
  created: number
}

export const TEMPLATES: { id: WidgetTemplate; label: string; hint: string; grid: string }[] = [
  { id: 'compact-stat', label: 'compact-stat', hint: '数字ひとつ（1×1）', grid: '1×1' },
  { id: 'dual-metric', label: 'dual-metric', hint: '数字ふたつ（2×1）', grid: '2×1' },
  { id: 'status-card', label: 'status-card', hint: 'アイコン＋状態（2×1）', grid: '2×1' },
  { id: 'feed-list', label: 'feed-list', hint: '一覧（2×2）', grid: '2×2' },
  { id: 'control-panel', label: 'control-panel', hint: '操作つき（2×1）', grid: '2×1' },
]

export const SOURCES: { id: WidgetSource; label: string }[] = [
  { id: 'battery', label: 'バッテリー残量' },
  { id: 'batterySaver', label: 'バッテリーセーバー' },
  { id: 'connection', label: '接続（Wi-Fi / USB / クラウド）' },
  { id: 'notifications', label: '通知の件数' },
  { id: 'latestNotification', label: '最新の通知' },
  { id: 'messages', label: '未読メッセージ' },
  { id: 'location', label: '現在地' },
  { id: 'volume', label: '音量' },
  { id: 'clipboard', label: 'クリップボード' },
  { id: 'deviceInfo', label: '端末情報' },
]

export const THEMES: WidgetTheme[] = ['primary', 'tertiary', 'secondary', 'surface']
export const SIZES: WidgetSize[] = ['small', 'medium', 'large']

/** Material Symbols that make sense on a phone-state widget. The model may only
 *  choose from these: the icon font draws a ligature, so an invented name would
 *  print as literal text on the card. */
export const WIDGET_ICONS = [
  'battery_full', 'battery_5_bar', 'battery_charging_full', 'battery_saver', 'bolt', 'speed',
  'wifi', 'usb', 'cloud', 'cell_tower', 'signal_cellular_alt', 'notifications', 'notifications_active',
  'mark_email_unread', 'sms', 'chat', 'location_on', 'my_location', 'map', 'volume_up', 'volume_off',
  'content_paste', 'smartphone', 'devices', 'phone_android', 'schedule', 'insights', 'monitor_heart',
  'thermostat', 'music_note', 'calendar_month', 'check_circle', 'error', 'offline_bolt', 'trending_up',
  'storage', 'public', 'sync', 'air', 'water_drop', 'wb_sunny',
]

const KEY = 'ts.widgets'
const ID = () => 'w' + Math.random().toString(36).slice(2, 9)

function load(): Widget[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]')
    return Array.isArray(v) ? v.filter((w) => w && typeof w.id === 'string').map(normalize) : []
  } catch { return [] }
}
let items: Widget[] = load()
const subs = new Set<() => void>()
function emit() {
  try { localStorage.setItem(KEY, JSON.stringify(items)) } catch {}
  subs.forEach((f) => f())
}

/** The board a first launch gets: the phone's state at a glance. They are real
 *  widgets in the store, so they can be deleted, regenerated or replaced. */
const HOME_DEFAULT: Widget[] = [
  { id: 'home-batt', template: 'compact-stat', size: 'small', theme: 'primary', icon: 'battery_5_bar', title: 'バッテリー', sources: ['battery'] },
  { id: 'home-notif', template: 'dual-metric', size: 'medium', theme: 'secondary', icon: 'notifications', title: '通知と未読', sources: ['notifications', 'messages'] },
  { id: 'home-feed', template: 'feed-list', size: 'large', theme: 'surface', icon: 'notifications_active', title: '最新の通知', sources: ['latestNotification', 'notifications'] },
  { id: 'home-loc', template: 'dual-metric', size: 'medium', theme: 'tertiary', icon: 'location_on', title: '現在地と接続', sources: ['location', 'connection'] },
  { id: 'home-vol', template: 'control-panel', size: 'medium', theme: 'primary', icon: 'volume_up', title: '音量と節電', sources: ['volume', 'batterySaver'] },
].map((w) => normalize({ ...w, created: 0 }))
if (!localStorage.getItem(KEY)) { items = HOME_DEFAULT; try { localStorage.setItem(KEY, JSON.stringify(items)) } catch {} }

export const widgetStore = {
  subscribe(f: () => void) { subs.add(f); return () => { subs.delete(f) } },
  get(): Widget[] { return items },
  add(w: Widget) { items = [...items, w]; emit(); return w },
  remove(id: string) { items = items.filter((w) => w.id !== id); emit() },
  replace(id: string, w: Widget) { items = items.map((x) => (x.id === id ? w : x)); emit() },
  /** Puts the default board back (after deleting everything). */
  reset() { items = HOME_DEFAULT.map((w) => ({ ...w })); emit() },
}
export const useWidgets = () => useSyncExternalStore(widgetStore.subscribe, widgetStore.get)

/* ---------------- Validation ---------------- */
function normalize(w: any): Widget {
  const template: WidgetTemplate = TEMPLATES.some((t) => t.id === w?.template) ? w.template : 'status-card'
  const size: WidgetSize = SIZES.includes(w?.size) ? w.size : defaultSize(template)
  const theme: WidgetTheme = THEMES.includes(w?.theme) ? w.theme : 'primary'
  const sources: WidgetSource[] = (Array.isArray(w?.sources) ? w.sources : [])
    .filter((x: any) => SOURCES.some((s) => s.id === x)).slice(0, 4)
  const icon = WIDGET_ICONS.includes(w?.icon) ? w.icon : defaultIcon(sources[0])
  return {
    id: typeof w?.id === 'string' && w.id ? w.id : ID(),
    template, size, theme, icon, sources: sources.length ? sources : defaultsFor(template),
    title: String(w?.title || '').slice(0, 24) || defaultTitle(template, sources),
    prompt: typeof w?.prompt === 'string' ? w.prompt.slice(0, 300) : undefined,
    ai: !!w?.ai,
    created: Number(w?.created) || Date.now(),
  }
}
const defaultSize = (t: WidgetTemplate): WidgetSize =>
  t === 'compact-stat' ? 'small' : t === 'feed-list' ? 'large' : 'medium'
function defaultIcon(src?: WidgetSource) {
  switch (src) {
    case 'battery': case 'batterySaver': return 'battery_5_bar'
    case 'connection': return 'wifi'
    case 'notifications': case 'latestNotification': return 'notifications'
    case 'messages': return 'sms'
    case 'location': return 'location_on'
    case 'volume': return 'volume_up'
    case 'clipboard': return 'content_paste'
    case 'deviceInfo': return 'smartphone'
    default: return 'insights'
  }
}
function defaultsFor(t: WidgetTemplate): WidgetSource[] {
  return t === 'feed-list' ? ['notifications', 'latestNotification']
    : t === 'control-panel' ? ['volume', 'batterySaver']
      : t === 'dual-metric' ? ['battery', 'notifications']
        : t === 'compact-stat' ? ['battery'] : ['battery', 'connection']
}
function defaultTitle(t: WidgetTemplate, src: WidgetSource[]) {
  if (t === 'feed-list') return '通知'
  const l = SOURCES.find((s) => s.id === src[0])?.label || 'スマートフォン'
  return t === 'dual-metric' ? `${SOURCES.find((s) => s.id === src[0])?.label || ''}・${SOURCES.find((s) => s.id === src[1])?.label || ''}`.replace(/^・|・$/g, '') || l
    : l
}

/* ---------------- Presets (no API key needed) ---------------- */
export const PRESETS: Widget[] = [
  { id: 'p-batt-notif', template: 'dual-metric', size: 'large', theme: 'primary', icon: 'battery_charging_full', title: 'バッテリーと通知', sources: ['battery', 'notifications'] },
  { id: 'p-loc-conn', template: 'dual-metric', size: 'medium', theme: 'tertiary', icon: 'location_on', title: '現在地と接続', sources: ['location', 'connection'] },
  { id: 'p-feed', template: 'feed-list', size: 'large', theme: 'secondary', icon: 'notifications', title: '通知フィード', sources: ['notifications', 'latestNotification'] },
  { id: 'p-vol', template: 'control-panel', size: 'medium', theme: 'primary', icon: 'volume_up', title: '音量と節電', sources: ['volume', 'batterySaver'] },
  { id: 'p-dev', template: 'status-card', size: 'medium', theme: 'surface', icon: 'smartphone', title: '端末の状態', sources: ['deviceInfo', 'battery'] },
  { id: 'p-msg', template: 'compact-stat', size: 'small', theme: 'tertiary', icon: 'sms', title: '未読メッセージ', sources: ['messages'] },
  { id: 'p-clip', template: 'status-card', size: 'medium', theme: 'secondary', icon: 'content_paste', title: 'クリップボード', sources: ['clipboard'] },
  { id: 'p-batt', template: 'compact-stat', size: 'small', theme: 'primary', icon: 'battery_5_bar', title: 'バッテリー', sources: ['battery'] },
].map((w) => normalize({ ...w, id: ID(), created: 0 }))

/* ---------------- Groq: pick the parts ---------------- */
const API = 'https://api.groq.com/openai/v1/chat/completions'

const PROMPT = `あなたは「クイックAI」のウィジェット設計者です。ユーザーの日本語の要望から、Android スマートフォンの状態を表示する Material 3 Expressive ウィジェットの構成をひとつ選び、JSON だけを返します。

使える template（これ以外は不可）:
- compact-stat: 数字ひとつを大きく見せる（1×1）
- dual-metric: 数字をふたつ並べる（2×1）
- status-card: アイコンと状態文を見せる（2×1）
- feed-list: 通知やメッセージを数件並べる（2×2）
- control-panel: 音量スライダーや節電トグルなど操作つき（2×1）

size: small | medium | large
theme（Material 3 のカラーロール）: primary | tertiary | secondary | surface
sources（1〜4個、順番が表示順）: battery, batterySaver, connection, notifications, latestNotification, messages, location, volume, clipboard, deviceInfo
icon: ${WIDGET_ICONS.join(', ')}
title: 16文字以内の日本語（例: バッテリーと通知）

出力は次の形の JSON オブジェクトだけ:
{"template":"dual-metric","size":"large","theme":"primary","icon":"battery_charging_full","title":"バッテリーと通知","sources":["battery","notifications"]}`

function cfg() {
  let key = '', model = 'llama-3.3-70b-versatile'
  try { key = localStorage.getItem('ts.groq.key') || '' } catch {}
  try { model = localStorage.getItem('ts.groq.model') || model } catch {}
  return { key, model }
}

function extractJson(text: string): any {
  const a = text.indexOf('{'), b = text.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  try { return JSON.parse(text.slice(a, b + 1)) } catch { return null }
}

/** Keyword fallback so a request still lands somewhere sensible with no key. */
export function presetFor(prompt: string): Widget {
  const p = prompt.toLowerCase()
  const pick = (...words: string[]) => words.some((w) => p.includes(w))
  let base = PRESETS[1]
  if (pick('通知', 'メール', 'notif')) base = pick('一覧', 'フィード', 'まとめ') ? PRESETS[2] : PRESETS[0]
  else if (pick('位置', '地図', '現在地', 'gps')) base = PRESETS[1]
  else if (pick('音量', 'ミュート', '音')) base = PRESETS[3]
  else if (pick('メッセージ', 'sms', '未読', 'line')) base = PRESETS[5]
  else if (pick('クリップ', 'コピー')) base = PRESETS[6]
  else if (pick('端末', '機種', 'デバイス', '情報')) base = PRESETS[4]
  else if (pick('バッテリー', '電池', '充電')) base = PRESETS[7]
  const big = pick('大き', '大きく', '大', 'large', '見や')
  const compact = pick('コンパクト', '小さ', '小', 'ミニ')
  return normalize({ ...base, id: ID(), size: big ? 'large' : compact && base.template !== 'feed-list' ? 'small' : base.size, prompt, ai: false, created: Date.now() })
}

export type PlanResult = { ok: true; widget: Widget } | { ok: false; error: string; widget?: Widget }

export async function planWidget(prompt: string): Promise<PlanResult> {
  const q = prompt.trim()
  if (!q) return { ok: false, error: 'どんなウィジェットがほしいか入力してください' }
  const { key, model } = cfg()
  if (!key) return { ok: false, error: 'Groq の API キーが未設定のため、プリセットから選びました', widget: presetFor(q) }
  try {
    const r = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: PROMPT }, { role: 'user', content: q }],
        temperature: 0.2,
        max_tokens: 220,
      }),
    })
    if (!r.ok) {
      const why = r.status === 401 ? 'API キーが正しくありません'
        : r.status === 429 ? 'Groq の回数制限に達しました'
          : `Groq API エラー（${r.status}）`
      return { ok: false, error: why + '。プリセットから選べます', widget: presetFor(q) }
    }
    const j = await r.json().catch(() => ({}))
    const raw = extractJson(String(j?.choices?.[0]?.message?.content || ''))
    if (!raw) return { ok: false, error: 'AI の返答を読み取れませんでした。プリセットから選べます', widget: presetFor(q) }
    const w = normalize({ ...raw, id: ID(), prompt: q, ai: true, created: Date.now() })
    return { ok: true, widget: w }
  } catch (e: any) {
    return { ok: false, error: `Groq に接続できませんでした（${e?.message || 'ネットワーク'}）`, widget: presetFor(q) }
  }
}

/* ---------------- Live values ---------------- */
type Read = { icon: string; label: string; value: string; sub?: string; pct?: number; tone?: string }

export function readSource(src: WidgetSource, s: State): Read {
  const i = s.info, y = s.sys
  switch (src) {
    case 'battery':
      return {
        icon: i?.powerSave ? 'battery_saver' : i?.charging ? 'battery_charging_full' : 'battery_5_bar',
        label: 'バッテリー', value: i ? `${i.battery}%` : '—',
        sub: i ? (i.charging ? '充電中' : i.powerSave ? '節電中' : '使用中') : '未接続',
        pct: i ? i.battery / 100 : undefined,
      }
    case 'batterySaver':
      return {
        icon: 'battery_saver', label: 'バッテリーセーバー',
        value: i?.powerSave == null ? '—' : i.powerSave ? 'オン' : 'オフ',
        sub: i?.powerSave == null ? '未取得' : i.powerSave ? '消費を抑えています' : '通常どおり',
      }
    case 'connection':
      return {
        icon: s.via === 'usb' ? 'usb' : s.via === 'lan' ? 'wifi' : s.via ? 'cloud' : 'cloud_off',
        label: '接続',
        value: s.via === 'usb' ? 'USB' : s.via === 'lan' ? '同じ Wi-Fi' : s.via === 'cloud' ? 'クラウド' : '未接続',
        sub: s.latency != null ? `${s.latency} ms` : s.device?.name,
      }
    case 'notifications':
      return { icon: 'notifications', label: '通知', value: String(s.notifs.length), sub: s.notifs.length ? '件あります' : 'ありません' }
    case 'latestNotification': {
      const n = s.notifs[0]
      return { icon: 'notifications_active', label: '最新の通知', value: n?.title || '—', sub: n ? `${n.app} · ${n.text}` : '通知はありません' }
    }
    case 'messages': {
      const unread = s.threads.reduce((a, t) => a + (t.unreadCount || 0), 0)
      const latest = s.threads[0]
      return { icon: 'sms', label: '未読メッセージ', value: String(unread), sub: latest ? (latest.name || latest.address) : '会話はありません' }
    }
    case 'location':
      return s.loc
        ? {
          icon: 'location_on', label: '現在地',
          value: `${s.loc.lat.toFixed(3)}, ${s.loc.lng.toFixed(3)}`,
          sub: `±${Math.round(s.loc.acc ?? 0)} m · ${new Date(s.loc.time).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}`,
        }
        : { icon: 'location_off', label: '現在地', value: '—', sub: 'まだ取得していません' }
    case 'volume': {
      const v = y?.muted ? 0 : y?.vol ?? 0, max = y?.volMax || 15
      return {
        icon: y?.muted || v === 0 ? 'volume_off' : 'volume_up', label: '音量',
        value: y ? `${v}` : '—', sub: y ? `/ ${max}` : '未接続', pct: y ? v / max : undefined,
      }
    }
    case 'clipboard': {
      const c = s.clips[0]
      return { icon: 'content_paste', label: 'クリップボード', value: c ? c.text.slice(0, 40) : '—', sub: c ? (c.from === 'phone' ? 'スマホから' : 'PC から') : 'まだありません' }
    }
    case 'deviceInfo':
      return {
        icon: 'smartphone', label: '端末', value: s.device?.name || '未接続',
        sub: [s.device?.model, s.device?.android ? `Android ${s.device.android}` : ''].filter(Boolean).join(' · ') || 'ペアリングを待っています',
      }
  }
}

/* ---------------- Renderer ---------------- */
const ICON_ALIAS: Record<string, string> = { battery: 'battery_5_bar' }

/** One widget, drawn with the app's own Material 3 dynamic-colour roles. */
export function M3Widget({ w, s, onMenu }: { w: Widget; s: State; onMenu?: () => void }) {
  const reads = w.sources.map((src) => readSource(src, s))
  const first = reads[0]
  const cls = `gbw t-${w.template} z-${w.theme} sz-${w.size}`
  return (
    <section className={cls} aria-label={w.title}>
      <header>
        <span className="gbw-ic"><Icon n={w.icon || ICON_ALIAS[first?.icon || ''] || first?.icon || 'insights'} /></span>
        <span className="gbw-title">{w.title}</span>
        {onMenu && <button className="gbw-menu" aria-label="ウィジェットの設定" onClick={(e) => { e.stopPropagation(); onMenu() }}><Icon n="more_vert" /></button>}
      </header>
      {w.template === 'compact-stat' && first && (
        <div className="gbw-stat">
          <b>{first.value}</b>
          <span className="small">{first.label}{first.sub ? ` · ${first.sub}` : ''}</span>
        </div>
      )}

      {w.template === 'dual-metric' && (
        <div className="gbw-dual">
          {reads.slice(0, 2).map((r, k) => (
            <div key={k} className="gbw-meter">
              <span className="gbw-k"><Icon n={r.icon} /><span className="small">{r.label}</span></span>
              <b>{r.value}</b>
              {r.pct !== undefined && <span className="gbw-bar"><i style={{ width: Math.max(3, Math.min(100, r.pct * 100)) + '%' }} /></span>}
              {r.sub && <span className="gbw-sub small">{r.sub}</span>}
            </div>
          ))}
        </div>
      )}

      {w.template === 'status-card' && first && (
        <div className="gbw-status">
          <b>{first.value}</b>
          <span className="small">{first.sub || first.label}</span>
          {reads[1] && <span className="gbw-pill"><Icon n={reads[1].icon} />{reads[1].label} {reads[1].value}</span>}
        </div>
      )}

      {w.template === 'feed-list' && (
        <div className="gbw-feed">
          {(s.notifs.length ? s.notifs.slice(0, 4) : []).map((n) => (
            <div key={n.key} className="gbw-row">
              <span className="gbw-dot"><Icon n="notifications" /></span>
              <span className="gbw-rowtext"><b>{n.title}</b><span className="small">{n.text}</span></span>
            </div>
          ))}
          {!s.notifs.length && <div className="gbw-empty small"><Icon n="notifications_off" />通知はありません</div>}
        </div>
      )}

      {w.template === 'control-panel' && (
        <div className="gbw-ctl">
          {reads.map((r, k) => (
            <div key={k} className="gbw-ctlrow">
              <Icon n={r.icon} />
              <span className="gbw-k small">{r.label}</span>
              {r.pct !== undefined
                ? <span className="gbw-bar grow"><i style={{ width: Math.max(3, Math.min(100, r.pct * 100)) + '%' }} /></span>
                : <b className="small">{r.value}</b>}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
