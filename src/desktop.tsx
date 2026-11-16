import { useCallback, useEffect, useRef, useState } from 'react'
import { link, APP_VERSION } from './link'
import type { Media, Notif, Photo, State } from './link'
import { Icon, QuickShareIcon } from './icons'

/**
 * Experimental 「Googlebook OS」 desktop (設定 → 実験的な機能).
 *
 * Modelled on Google's Android-based desktop OS shown in September/October 2026
 * (9to5Google hands-on and review, Notebookcheck, press renders of the Lenovo
 * Googlebook 15): a ChromeOS-shaped desktop that feels like a Pixel —
 *  · top status bar: clock / weekday / date on the left (tap → calendar), the
 *    Android status icons (Wi-Fi, battery, notification bell) and a media pill on
 *    the right, where a tap opens Pixel-style Quick Settings and the shade;
 *  · centred floating dock with the stylised G (action key) and the app icons;
 *  · a home screen of Dynamic-Color Pixel widgets and shortcuts;
 *  · real floating windows (drag, resize, minimise, maximise, phone-width) so
 *    notifications, messages, photos, sharing, files and settings run side by
 *    side like apps on a desktop.
 * Everything is drawn with the app's own Material 3 dynamic color roles, so the
 * phone's wallpaper seed still colours the whole desktop.
 */

type Win = {
  id: string; view: string; x: number; y: number; w: number; h: number
  z: number; min: boolean; max: boolean; phone: boolean
  prev?: { x: number; y: number; w: number; h: number }
}

export const DESKTOP_APPS: [string, string, string][] = [
  ['home', 'ホーム', 'home'],
  ['notifs', '通知', 'notifications'],
  ['messages', 'メッセージ', 'chat'],
  ['calls', '通話', 'call'],
  ['photos', '写真', 'photo_library'],
  ['files', 'Quick Share', 'share'],
  ['explorer', 'ファイル', 'folder_open'],
  ['find', '探す', 'location_on'],
  ['clip', 'クリップボード', 'content_paste'],
  ['settings', '設定', 'settings'],
]

const WEEK = ['日曜日', '月曜日', '火曜日', '水曜日', '木曜日', '金曜日', '土曜日']
const APP_NAME = (v: string) => (DESKTOP_APPS.find((a) => a[0] === v) || [v, v, 'apps'])[1]
const APP_ICON = (v: string) => (DESKTOP_APPS.find((a) => a[0] === v) || [v, v, 'apps'])[2]

function useClock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => { const t = window.setInterval(() => setNow(new Date()), 10000); return () => clearInterval(t) }, [])
  return now
}

const batIcon = (pct: number | null, charging: boolean) => {
  if (pct == null) return 'battery_unknown'
  if (charging) return 'battery_charging_full'
  const p = Math.max(0, Math.min(100, pct))
  return p >= 96 ? 'battery_full' : `battery_${Math.min(6, Math.round((p / 100) * 6))}_bar`
}

/* ---------------- Calendar popover (top-left clock) ---------------- */
function Calendar({ now }: { now: Date }) {
  const [month, setMonth] = useState(() => new Date(now.getFullYear(), now.getMonth(), 1))
  const first = new Date(month.getFullYear(), month.getMonth(), 1)
  const start = (first.getDay() + 6) % 7 // Monday-first, like Pixel
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()
  const cells: (number | null)[] = [...Array(start).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)]
  const isThisMonth = now.getMonth() === month.getMonth() && now.getFullYear() === month.getFullYear()
  return (
    <div className="gb-cal" onClick={(e) => e.stopPropagation()}>
      <div className="gb-cal-h">
        <button className="icon-btn sm" aria-label="前の月" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}><Icon n="chevron_left" /></button>
        <b>{month.getFullYear()}年 {month.getMonth() + 1}月</b>
        <button className="icon-btn sm" aria-label="次の月" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}><Icon n="chevron_right" /></button>
      </div>
      <div className="gb-cal-w">{['月', '火', '水', '木', '金', '土', '日'].map((d) => <span key={d} className="muted small">{d}</span>)}</div>
      <div className="gb-cal-g">
        {cells.map((d, i) => <span key={i} className={'gb-cal-d' + (d && isThisMonth && d === now.getDate() ? ' today' : '')}>{d || ''}</span>)}
      </div>
      <div className="gb-cal-f small muted">{now.toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' })}（{WEEK[now.getDay()]}）</div>
    </div>
  )
}

/* ---------------- Quick Settings + notification shade ---------------- */
function QuickPanel({ s, onClose }: { s: State; onClose: () => void }) {
  const sys = s.sys
  const [bright, setBright] = useState(() => Number(localStorage.getItem('ts.gb.bright') || '100'))
  const setBrightness = (v: number) => { setBright(v); localStorage.setItem('ts.gb.bright', String(v)) }
  const ringer = sys?.ringer || 'normal'
  const vol = sys?.vol ?? 0
  const max = sys?.volMax || 15
  return (
    <div className="gb-panel" onClick={(e) => e.stopPropagation()}>
      <div className="gb-panel-head">
        <div className="gb-panel-clock"><b>{new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}</b><span className="muted small">{new Date().toLocaleDateString('ja-JP', { month: 'long', day: 'numeric' }) }（{WEEK[new Date().getDay()]}）</span></div>
        <div className="gb-panel-actions">
          <button className="icon-btn" title="設定" onClick={() => { link.setBookUi(false) }}><Icon n="open_in_full" /></button>
          <button className="icon-btn" title="閉じる" onClick={onClose}><Icon n="close" /></button>
        </div>
      </div>

      <div className="gb-slider-row">
        <Icon n="brightness_6" />
        <input type="range" className="slider" min={30} max={100} value={bright} aria-label="明るさ"
          style={{ '--p': ((bright - 30) / 70) * 100 + '%' } as React.CSSProperties}
          onChange={(e) => setBrightness(Number(e.target.value))} />
      </div>
      <div className="gb-slider-row">
        <button className="icon-btn sm" title={sys?.muted ? 'ミュート解除' : 'ミュート'} onClick={() => link.setSys({ key: 'mute', on: !sys?.muted })}><Icon n={sys?.muted || vol === 0 ? 'volume_off' : 'volume_up'} fill /></button>
        <input type="range" className="slider" min={sys?.volMin ?? 0} max={max} value={sys?.muted ? 0 : vol} aria-label="音量"
          style={{ '--p': ((sys?.muted ? 0 : vol) / max) * 100 + '%' } as React.CSSProperties}
          onChange={(e) => link.setSys({ key: 'vol', value: Number(e.target.value) })} />
      </div>

      <div className="gb-tiles">
        <button className={'gb-tile' + (s.via ? ' on' : '')} onClick={() => {}}><span className="gb-tile-icon"><Icon n={s.via === 'lan' ? 'wifi' : s.via === 'usb' ? 'usb' : 'cloud'} /></span><span><b>{s.via === 'lan' ? '同じ Wi-Fi で接続' : s.via === 'usb' ? 'USB ケーブル' : s.via ? 'クラウド経由' : '未接続'}</b><span className="small">{s.device?.name || 'スマートフォン'}</span></span></button>
        <button className={'gb-tile' + (sys?.rotate ? ' on' : '')} disabled={!sys?.canWrite} onClick={() => link.setSys({ key: 'rotate', on: !sys?.rotate })}><span className="gb-tile-icon"><Icon n="screen_rotation" /></span><span><b>自動回転</b><span className="small">{sys?.rotate ? 'オン' : sys ? 'オフ' : '—'}</span></span></button>
        <button className={'gb-tile' + (sys?.dnd ? ' on' : '')} disabled={!sys?.dndAccess} onClick={() => link.setSys({ key: 'dnd', on: !sys?.dnd })}><span className="gb-tile-icon"><Icon n="do_not_disturb_on" /></span><span><b>サイレント</b><span className="small">{sys?.dnd ? 'オン' : 'オフ'}</span></span></button>
        <button className={'gb-tile' + (ringer === 'vibrate' ? ' on' : '')} disabled={!sys?.dndAccess} onClick={() => link.setSys({ key: 'ringer', mode: ringer === 'vibrate' ? 'normal' : 'vibrate' })}><span className="gb-tile-icon"><Icon n="vibration" /></span><span><b>バイブ</b><span className="small">{ringer === 'vibrate' ? 'オン' : 'オフ'}</span></span></button>
        <button className="gb-tile" onClick={() => link.pushClipboard(true)}><span className="gb-tile-icon"><Icon n="content_paste_go" /></span><span><b>クリップボード</b><span className="small">スマホへ送る</span></span></button>
        <button className="gb-tile" onClick={() => link.send({ t: 'ring', on: true })}><span className="gb-tile-icon"><Icon n="ring_volume" /></span><span><b>スマホを鳴らす</b><span className="small">音で知らせる</span></span></button>
        <button className="gb-tile" onClick={() => link.getLocation()}><span className="gb-tile-icon"><Icon n="location_on" /></span><span><b>探す</b><span className="small">現在地を取得</span></span></button>
        <button className="gb-tile" onClick={() => link.setBookUi(false)}><span className="gb-tile-icon"><Icon n="desktop_windows" /></span><span><b>標準の画面</b><span className="small">実験的UIをオフ</span></span></button>
      </div>

      <div className="gb-shade-h">
        <b>通知</b>
        <div>
          <button className="btn text" onClick={() => link.dismissNotif('*')}><Icon n="clear_all" />すべて消去</button>
        </div>
      </div>
      <div className="gb-shade">
        {s.notifs.slice(0, 8).map((n: Notif) => (
          <div key={n.key} className="gb-notif">
            <div className="avatar">{n.icon ? <img src={'data:image/png;base64,' + n.icon} alt="" /> : <Icon n="notifications" />}</div>
            <div className="body"><div className="row"><span className="muted small">{n.app}</span><span className="muted small">{new Date(n.time).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}</span></div><b>{n.title}</b><p className="muted">{n.text}</p></div>
            <button className="icon-btn" aria-label="消去" onClick={() => link.dismissNotif(n.key)}><Icon n="close" /></button>
          </div>
        ))}
        {!s.notifs.length && <div className="empty"><Icon n="notifications_off" /><span>通知はありません</span></div>}
      </div>
      <div className="gb-panel-foot small muted">Quick Link Web v{APP_VERSION} · Googlebook OS 風デスクトップ（実験的）</div>
    </div>
  )
}

/* ---------------- App drawer (G / action key) ---------------- */
function Drawer({ onPick, onClose }: { onPick: (v: string) => void; onClose: () => void }) {
  const [q, setQ] = useState('')
  const apps = DESKTOP_APPS.filter(([, label]) => !q || label.toLowerCase().includes(q.toLowerCase()))
  return (
    <div className="gb-drawer-scrim" onClick={onClose}>
      <div className="gb-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="gb-drawer-search">
          <Icon n="search" />
          <input autoFocus placeholder="アプリを検索" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="gb-drawer-grid">
          {apps.map(([k, label]) => (
            <button key={k} className="gb-app" onClick={() => onPick(k)}>
              <span className="gb-app-icon">{k === 'files' ? <QuickShareIcon size={26} /> : <Icon n={APP_ICON(k)} />}</span>
              <span className="small">{label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

export default function Desktop({ s, view, setView, renderView, badges }: {
  s: State; view: string; setView: (v: string) => void
  renderView: (v: string) => React.ReactNode; badges: Record<string, number>
}) {
  const now = useClock()
  const [wins, setWins] = useState<Win[]>([])
  const zRef = useRef(10)
  const [panel, setPanel] = useState(false)
  const [cal, setCal] = useState(false)
  const [drawer, setDrawer] = useState(false)
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1400
  const vh = typeof window !== 'undefined' ? window.innerHeight : 900

  const focusWin = useCallback((id: string) => {
    const nz = ++zRef.current
    setWins((ws) => ws.map((w) => (w.id === id ? { ...w, min: false, z: nz } : w)))
  }, [])

  /** Open a view in a window (or bring its window forward). 「ホーム」 sends every
   *  window to the dock and shows the desktop again. */
  const open = useCallback((v: string) => {
    setDrawer(false)
    if (v === 'home') { setWins((ws) => ws.map((w) => ({ ...w, min: true }))); return }
    const nz = ++zRef.current
    setWins((ws) => {
      const hit = ws.find((w) => w.view === v)
      if (hit) return ws.map((w) => (w.view === v ? { ...w, min: false, z: nz } : w))
      const count = ws.filter((w) => !w.min).length
      const w = Math.min(980, Math.max(520, vw * 0.52))
      const h = Math.min(vh - 140, Math.max(420, vh * 0.66))
      const x = Math.max(12, Math.min(vw - w - 12, 120 + (count % 5) * 48))
      const y = Math.max(60, Math.min(vh - h - 90, 90 + (count % 5) * 36))
      return [...ws, { id: 'w' + nz, view: v, x, y, w, h, z: nz, min: false, max: false, phone: false }]
    })
  }, [vw, vh])
  /** Dock / drawer / shortcut: keep the app's view in step and open the window. */
  const pick = useCallback((v: string) => { setView(v); open(v) }, [open, setView])

  // A view chosen anywhere else in the app (a dropped file, a notification link)
  // opens its window here too.
  useEffect(() => { open(view) }, [view])

  const close = (id: string) => setWins((ws) => ws.filter((w) => w.id !== id))
  const minimize = (id: string) => setWins((ws) => ws.map((w) => (w.id === id ? { ...w, min: true } : w)))
  const togglePhone = (id: string) => setWins((ws) => ws.map((w) => (w.id === id ? { ...w, phone: !w.phone, w: !w.phone ? 400 : Math.min(980, vw * 0.52), h: !w.phone ? Math.min(vh - 140, 820) : Math.min(vh - 140, Math.max(420, vh * 0.66)) } : w)))
  const toggleMax = (id: string) => setWins((ws) => ws.map((w) => {
    if (w.id !== id) return w
    if (w.max) return { ...w, max: false, ...(w.prev || {}) }
    return { ...w, max: true, prev: { x: w.x, y: w.y, w: w.w, h: w.h }, x: 0, y: 44, w: vw, h: vh - 44 }
  }))

  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null)
  const resize = useRef<{ id: string; sx: number; sy: number; w: number; h: number } | null>(null)

  const visible = wins.filter((w) => !w.min)

  return (
    <div className={'gb' + (panel || cal ? ' gb-dim' : '')} onClick={() => { setPanel(false); setCal(false) }}>
      {/* ---- wallpaper ---- */}
      <div className="gb-wall" aria-hidden="true"><i className="b1" /><i className="b2" /><i className="b3" /><i className="b4" /></div>

      {/* ---- top status bar ---- */}
      <div className="gb-top">
        <button className="gb-clock" onClick={(e) => { e.stopPropagation(); setCal((v) => !v); setPanel(false) }}>
          <b>{now.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}</b>
          <span>{WEEK[now.getDay()]} {now.getMonth() + 1}/{now.getDate()}</span>
        </button>
        <div className="gb-status">
          {s.media && (
            <button className="gb-media-pill" title="再生中のメディア" onClick={(e) => { e.stopPropagation(); setPanel(true) }}>
              <span className="gb-eq"><i /><i /><i /></span>
              <span className="gb-media-text"><b>{s.media.title}</b><span>{s.media.app}</span></span>
              <span className="gb-media-btn" role="button" aria-label={s.media.playing ? '一時停止' : '再生'}
                onClick={(e) => { e.stopPropagation(); link.send({ t: 'media_cmd', cmd: s.media!.playing ? 'pause' : 'play' }) }}>
                <Icon n={s.media.playing ? 'pause' : 'play_arrow'} fill />
              </span>
            </button>
          )}
          <button className="gb-status-btn" title={s.info?.net || 'ネットワーク'}><Icon n="wifi" /></button>
          <button className="gb-status-btn" title={`バッテリー ${s.info?.battery ?? '—'}%`}><Icon n={batIcon(s.info?.battery ?? null, !!s.info?.charging)} /><span className="gb-batt small">{s.info?.battery ?? '—'}%</span></button>
          <button className="gb-status-btn" title="通知" onClick={(e) => { e.stopPropagation(); setPanel((v) => !v); setCal(false) }}>
            <Icon n="notifications" /><em className="gb-badge">{s.notifs.length > 99 ? '99+' : s.notifs.length}</em>
          </button>
        </div>
      </div>

      {cal && <Calendar now={now} />}
      {panel && <QuickPanel s={s} onClose={() => setPanel(false)} />}
      {drawer && <Drawer onPick={pick} onClose={() => setDrawer(false)} />}

      {/* ---- windows ---- */}
      {visible.map((w) => (
        <div key={w.id} className={'gb-win' + (w.max ? ' max' : '') + (w.phone ? ' phone' : '')}
          style={{ left: w.x, top: w.y, width: w.w, height: w.h, zIndex: w.z }}
          onPointerDown={() => focusWin(w.id)}>
          <div className="gb-win-bar"
            onPointerDown={(e) => {
              if ((e.target as HTMLElement).closest('button')) return
              focusWin(w.id)
              if (w.max) return
              drag.current = { id: w.id, dx: e.clientX - w.x, dy: e.clientY - w.y }
              ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
            }}
            onPointerMove={(e) => {
              const d = drag.current
              if (!d || d.id !== w.id) return
              setWins((ws) => ws.map((x) => (x.id === w.id ? { ...x, x: Math.max(-40, Math.min(vw - 80, e.clientX - d.dx)), y: Math.max(44, Math.min(vh - 60, e.clientY - d.dy)) } : x)))
            }}
            onPointerUp={() => { drag.current = null }}>
            <span className="gb-win-icon">{w.view === 'files' ? <QuickShareIcon size={18} /> : <Icon n={APP_ICON(w.view)} />}</span>
            <b>{APP_NAME(w.view)}</b>
            <div className="gb-win-btns">
              <button className="icon-btn sm" title="最小化" onClick={() => minimize(w.id)}><Icon n="remove" /></button>
              <button className="icon-btn sm" title="スマホサイズ" onClick={() => togglePhone(w.id)}><Icon n="smartphone" /></button>
              <button className="icon-btn sm" title={w.max ? '元のサイズ' : '最大化'} onClick={() => toggleMax(w.id)}><Icon n={w.max ? 'close_fullscreen' : 'open_in_full'} /></button>
              <button className="icon-btn sm" title="閉じる" onClick={() => close(w.id)}><Icon n="close" /></button>
            </div>
          </div>
          <div className="gb-win-body" key={w.view}>{renderView(w.view)}</div>
          {!w.max && !w.phone && (
            <div className="gb-resize" title="サイズ変更"
              onPointerDown={(e) => { e.stopPropagation(); focusWin(w.id); resize.current = { id: w.id, sx: e.clientX, sy: e.clientY, w: w.w, h: w.h }; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) }}
              onPointerMove={(e) => {
                const r = resize.current
                if (!r || r.id !== w.id) return
                setWins((ws) => ws.map((x) => (x.id === w.id ? { ...x, w: Math.max(360, r.w + e.clientX - r.sx), h: Math.max(260, r.h + e.clientY - r.sy) } : x)))
              }}
              onPointerUp={() => { resize.current = null }} />
          )}
        </div>
      ))}

      {/* ---- home screen: widgets + shortcuts ---- */}
      {!visible.length && <HomeSurface s={s} onOpen={pick} />}

      {/* ---- dock ---- */}
      <div className="gb-dock" onClick={(e) => e.stopPropagation()}>
        <button className="gb-g" title="アプリ（G）" onClick={() => setDrawer((v) => !v)}>G</button>
        <span className="gb-dock-sep" />
        {DESKTOP_APPS.filter(([k]) => k !== 'home').map(([k, label]) => {
          const running = wins.some((w) => w.view === k)
          return (
            <button key={k} className={'gb-dock-app' + (running ? ' run' : '')} title={label} onClick={() => pick(k)}>
              <span className="gb-app-icon">{k === 'files' ? <QuickShareIcon size={24} /> : <Icon n={APP_ICON(k)} />}</span>
              {badges[k] ? <em className="gb-badge">{badges[k] > 99 ? '99+' : badges[k]}</em> : null}
              <i className="gb-dot" />
            </button>
          )
        })}
        <span className="gb-dock-sep" />
        <button className="gb-dock-app" title="ホーム" onClick={() => pick('home')}>
          <span className="gb-app-icon"><Icon n="home" /></span><i className="gb-dot" />
        </button>
        <button className="gb-dock-app" title="標準の画面に戻す" onClick={() => link.setBookUi(false)}>
          <span className="gb-app-icon"><Icon n="switch_left" /></span><i className="gb-dot" />
        </button>
      </div>
    </div>
  )
}

/* ---------------- Home screen widgets ---------------- */
function HomeSurface({ s, onOpen }: { s: State; onOpen: (v: string) => void }) {
  const i = s.info
  const m: Media | null | undefined = s.media
  const pics: Photo[] = s.photos.slice(0, 6)
  return (
    <div className="gb-home" onClick={(e) => e.stopPropagation()}>
      <div className="gb-widgets">
        <section className="gb-w gb-w-phone">
          <header><Icon n="smartphone" /><span className="muted small">スマートフォン</span></header>
          <b className="gb-w-title">{s.device?.name || '未接続'}</b>
          <div className="small muted">{s.device?.model}{s.device?.android ? ` · Android ${s.device.android}` : ''}</div>
          <div className="gb-w-batt">
            <Icon n={batIcon(i?.battery ?? null, !!i?.charging)} fill />
            <b>{i ? `${i.battery}%` : '—'}</b>
            <span className="small muted">{i?.charging ? '充電中' : i?.net || ''}{i?.powerSave ? ' · セーバー' : ''}</span>
          </div>
          <div className="gb-w-chips">
            <span className="via-chip"><Icon n={s.via === 'lan' ? 'wifi' : s.via === 'usb' ? 'usb' : 'cloud'} />{s.via === 'lan' ? '同じ Wi-Fi' : s.via === 'usb' ? 'USB ケーブル' : s.via ? 'クラウド' : '未接続'}</span>
            {s.latency != null && <span className="via-chip"><Icon n="bolt" />{s.latency} ms</span>}
          </div>
          <div className="gb-w-actions">
            <button className="gb-btn" onClick={() => link.send({ t: 'ring', on: true })}><Icon n="ring_volume" />鳴らす</button>
            <button className="gb-btn" onClick={() => onOpen('settings')}><Icon n="settings" />接続</button>
          </div>
        </section>

        <section className="gb-w gb-w-share">
          <header><QuickShareIcon size={18} /><span className="muted small">Quick Share</span></header>
          <b className="gb-w-title">ファイルもテキストも送る</b>
          <p className="small muted">この PC のファイルを選ぶか、下の欄に入力して「スマートフォンに送信」を押します。</p>
          <label className="gb-share-btn"><QuickShareIcon size={20} />ファイルを選ぶ
            <input type="file" multiple hidden onChange={(e) => { if (e.target.files?.length) link.sendFiles(e.target.files); e.target.value = '' }} />
          </label>
          <button className="gb-btn" onClick={() => onOpen('files')}><Icon n="open_in_new" />共有画面を開く</button>
        </section>

        <section className="gb-w gb-w-notif">
          <header><Icon n="notifications" /><span className="muted small">通知</span><button className="btn text small" onClick={() => onOpen('notifs')}>すべて</button></header>
          {s.notifs.slice(0, 3).map((n) => (
            <div key={n.key} className="gb-w-notif-row">
              <div className="avatar sm">{n.icon ? <img src={'data:image/png;base64,' + n.icon} alt="" /> : <Icon n="notifications" />}</div>
              <div><b>{n.title}</b><p className="muted small">{n.text}</p></div>
            </div>
          ))}
          {!s.notifs.length && <div className="empty small"><Icon n="notifications_off" /><span>通知はありません</span></div>}
        </section>

        {m && (
          <section className={'gb-w gb-w-media' + (m.playing ? ' playing' : '')}>
            <header><Icon n="music_note" /><span className="muted small">再生中 · {m.app}</span></header>
            <div className="gb-w-media-main">
              <div className="art">{m.art ? <img src={'data:image/jpeg;base64,' + m.art} alt="" /> : <Icon n="music_note" />}</div>
              <div><b>{m.title}</b><span className="small muted">{m.artist}</span></div>
            </div>
            <div className="gb-w-media-ctl">
              <button className="icon-btn sm" onClick={() => link.send({ t: 'media_cmd', cmd: 'prev' })}><Icon n="skip_previous" /></button>
              <button className="icon-btn filled" onClick={() => link.send({ t: 'media_cmd', cmd: m.playing ? 'pause' : 'play' })}><Icon n={m.playing ? 'pause' : 'play_arrow'} fill /></button>
              <button className="icon-btn sm" onClick={() => link.send({ t: 'media_cmd', cmd: 'next' })}><Icon n="skip_next" /></button>
            </div>
          </section>
        )}

        <section className="gb-w gb-w-loc">
          <header><Icon n="location_on" /><span className="muted small">現在地</span></header>
          {s.loc ? <>
            <b className="gb-w-title">{s.loc.lat.toFixed(4)}, {s.loc.lng.toFixed(4)}</b>
            <span className="small muted">±{Math.round(s.loc.acc ?? 0)} m · {new Date(s.loc.time).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}</span>
            <div className="gb-w-actions">
              <a className="gb-btn" href={`https://www.openstreetmap.org/?mlat=${s.loc.lat}&mlon=${s.loc.lng}#map=17/${s.loc.lat}/${s.loc.lng}`} target="_blank" rel="noreferrer"><Icon n="map" />地図</a>
              <button className="gb-btn" onClick={() => link.getLocation()}><Icon n="refresh" />更新</button>
            </div>
          </> : <><b className="gb-w-title">位置はまだありません</b><button className="gb-btn" onClick={() => link.getLocation()}><Icon n="my_location" />取得する</button></>}
        </section>

        {!!pics.length && (
          <section className="gb-w gb-w-photos">
            <header><Icon n="photo_library" /><span className="muted small">最近の写真</span><button className="btn text small" onClick={() => onOpen('photos')}>すべて</button></header>
            <div className="gb-w-strip">{pics.map((p) => <button key={p.id} onClick={() => onOpen('photos')}><img src={'data:image/jpeg;base64,' + p.thumb} alt={p.name} /></button>)}</div>
          </section>
        )}
      </div>

      <div className="gb-shortcuts">
        {DESKTOP_APPS.filter(([k]) => k !== 'home').map(([k, label]) => (
          <button key={k} className="gb-shortcut" onClick={() => onOpen(k)}>
            <span className="gb-app-icon lg">{k === 'files' ? <QuickShareIcon size={30} /> : <Icon n={APP_ICON(k)} />}</span>
            <span className="small">{label}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
