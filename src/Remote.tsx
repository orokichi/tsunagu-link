import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { link } from './link'
import { Icon } from './icons'

const useLink = () => useSyncExternalStore(link.subscribe, link.get)

/**
 * 「スマホ操作」— screen mirroring and real control of the paired Android phone.
 *
 * The picture is the phone's own MediaProjection stream (long side ≈720 px,
 * JPEG), painted into a canvas. Mouse and keyboard on this side become the
 * phone's input: a click is a tap, a drag is a swipe (one continuous stroke), a
 * long press is a long press, the wheel scrolls, right-click goes back, and the
 * keyboard types into the focused field or sends Enter / Backspace / Tab /
 * arrows / Escape / Home. Everything below the surface is the phone's
 * AccessibilityService doing the work — this app never pretends to be a USB HID
 * device, because a normal Android app cannot be one.
 */
export default function Remote() {
  const s = useLink()
  const r = s.remote
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const [hasFrame, setHasFrame] = useState(false)
  const [fps, setFps] = useState(0)
  const [kb, setKb] = useState(true)
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null)
  const count = useRef(0)
  const acc = r.acc
  const live = r.mirror === 'live'

  // Frames arrive outside React state (see link.onFrame) and are painted here.
  useEffect(() => link.onFrame((url) => {
    const img = new Image()
    img.onload = () => {
      const c = canvasRef.current
      if (!c) return
      if (c.width !== img.width || c.height !== img.height) { c.width = img.width; c.height = img.height }
      const g = c.getContext('2d')
      if (!g) return
      g.drawImage(img, 0, 0)
      setHasFrame(true)
      count.current++
    }
    img.src = url
  }), [])

  useEffect(() => {
    const id = window.setInterval(() => { setFps(count.current); count.current = 0 }, 1000)
    return () => window.clearInterval(id)
  }, [])

  // Ask for the current permission state whenever this app is opened.
  useEffect(() => { link.remoteRefresh() }, [])
  useEffect(() => { if (!live) setHasFrame(false) }, [live])

  const norm = (e: { clientX: number; clientY: number }) => {
    const c = canvasRef.current
    if (!c) return null
    const b = c.getBoundingClientRect()
    if (!b.width || !b.height) return null
    return { x: Math.min(1, Math.max(0, (e.clientX - b.left) / b.width)), y: Math.min(1, Math.max(0, (e.clientY - b.top) / b.height)) }
  }

  /* ---------- pointer → gesture ---------- */
  const drag = useRef<{ t: number; x: number; y: number; moved: boolean } | null>(null)
  const hear = useRef<{ dx: number; dy: number; used: boolean }>({ dx: 0, dy: 0, used: false })

  const down = (e: React.PointerEvent) => {
    if (!acc || !live) return
    const p = norm(e)
    if (!p) return
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    drag.current = { t: Date.now(), x: p.x, y: p.y, moved: false }
    setCursor(p)
  }
  const move = (e: React.PointerEvent) => {
    const p = norm(e)
    if (p) setCursor(p)
    const d = drag.current
    if (!d || !p) return
    if (Math.hypot(p.x - d.x, p.y - d.y) > 0.012) d.moved = true
  }
  const up = (e: React.PointerEvent) => {
    const d = drag.current
    drag.current = null
    if (!d || !acc || !live) return
    const p = norm(e)
    if (!p) return
    const dt = Date.now() - d.t
    const dist = Math.hypot(p.x - d.x, p.y - d.y)
    if (dist < 0.012) {
      if (dt > 650) link.send({ t: 'rm_long', x: p.x, y: p.y })
      else link.send({ t: 'rm_tap', x: p.x, y: p.y })
    } else {
      link.send({ t: 'rm_swipe', x1: d.x, y1: d.y, x2: p.x, y2: p.y, ms: Math.min(1200, Math.max(90, dt)) })
    }
  }
  const wheel = (e: React.WheelEvent) => {
    if (!acc || !live) return
    const h = hear.current
    h.dx += e.deltaX; h.dy += e.deltaY
    if (h.used) return
    h.used = true
    window.setTimeout(() => {
      const { dx, dy } = h
      h.dx = 0; h.dy = 0; h.used = false
      if (Math.abs(dy) < 6 && Math.abs(dx) < 6) return
      const dir = Math.abs(dy) > Math.abs(dx) ? (dy > 0 ? 'down' : 'up') : (dx > 0 ? 'right' : 'left')
      const p = norm(e as any) || { x: 0.5, y: 0.5 }
      link.send({ t: 'rm_scroll', dir, x: p.x, y: p.y })
    }, 120)
  }

  /* ---------- keyboard → phone ---------- */
  const buffer = useRef('')
  const flushTimer = useRef<number | undefined>(undefined)
  const flush = () => {
    if (flushTimer.current) { window.clearTimeout(flushTimer.current); flushTimer.current = undefined }
    const t = buffer.current
    buffer.current = ''
    if (t) link.remoteText(t)
  }
  const key = (e: React.KeyboardEvent) => {
    if (!kb || !acc) return
    if (e.metaKey || e.altKey) return
    if (e.ctrlKey && e.key.toLowerCase() === 'v') {
      flush()
      void navigator.clipboard?.readText?.().then((t) => t && link.remoteText(t)).catch(() => {})
      e.preventDefault()
      return
    }
    if (e.ctrlKey && e.key.toLowerCase() === 'a') { flush(); link.remoteKey('select_all'); e.preventDefault(); return }
    const map: Record<string, string> = {
      Enter: 'enter', Backspace: 'backspace', Tab: 'tab', Escape: 'back', Delete: 'delete',
      ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Home: 'home',
    }
    if (map[e.key]) { flush(); link.remoteKey(map[e.key]); e.preventDefault(); return }
    if (e.key.length === 1) {
      buffer.current += e.key
      if (flushTimer.current) window.clearTimeout(flushTimer.current)
      flushTimer.current = window.setTimeout(flush, 260)
      e.preventDefault()
    }
  }
  useEffect(() => () => flush(), [])

  const navButtons: [string, string, string][] = [
    ['back', '戻る', 'arrow_back'], ['home', 'ホーム', 'home'], ['recents', '履歴', 'history'],
    ['notifications', '通知', 'notifications'], ['quick_settings', 'クイック設定', 'tune'],
    ['lock', '画面ロック', 'lock'], ['screen_on', '画面を点ける', 'light_mode'],
  ]

  return (
    <div className="rp pane">
      <header className="rp-head">
        <div className="rp-title">
          <h2 className="display-s">スマホ操作</h2>
          <span className="muted small">{s.device?.name || 'スマートフォン'} · ミラーリングとリモート操作</span>
        </div>
        <div className="rp-chips">
          <span className={'via-chip ' + (acc ? 'lan' : '')}><Icon n={acc ? 'check_circle' : 'lock'} />ユーザー補助 {acc ? 'オン' : 'オフ'}</span>
          <span className={'via-chip ' + (live ? 'lan' : '')}><Icon n={live ? 'screen_share' : 'screen_share'} />{live ? `ミラーリング中 ${fps} fps` : 'ミラーリング停止'}</span>
          <button className="icon-btn sm" title="状態を再取得" onClick={() => link.remoteRefresh()}><Icon n="refresh" /></button>
        </div>
      </header>

      {!acc && (
        <section className="rp-perm card">
          <Icon n="touch_app" />
          <div>
            <b>ユーザー補助（リモート操作）を許可してください</b>
            <p className="small muted">スマホ側の「Quick Link」→「連携する機能」→「ユーザー補助（リモート操作）」をオンにすると、この画面のタップ・スワイプ・文字入力・戻る／ホームが使えるようになります。許可の画面はここから開けます。</p>
          </div>
          <button className="btn tonal" onClick={() => link.send({ t: 'perm_open', which: 'accessibility' })}><Icon n="open_in_new" />スマホで許可画面を開く</button>
        </section>
      )}

      <div className={'rp-body' + (live ? ' live' : '')}>
        <div className="rp-stage" ref={surfaceRef} tabIndex={0} onKeyDown={key}
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={() => { drag.current = null }}
          onWheel={wheel} onContextMenu={(e) => { e.preventDefault(); if (acc && live) link.remoteKey('back') }}
          aria-label="スマートフォンの画面">
          <canvas ref={canvasRef} className={hasFrame ? 'on' : ''} />
          {!hasFrame && (
            <div className="rp-blank">
              {r.mirror === 'requesting' ? (
                <><span className="loader" /><b>スマホで「画面の共有を開始」を選んでください</b><span className="small muted">スマホに出ているダイアログで「今すぐ開始」を押すと、ここに画面が映ります。</span></>
              ) : r.mirror === 'denied' ? (
                <><Icon n="block" /><b>画面共有が許可されませんでした</b><button className="btn filled" onClick={() => link.mirrorStart()}><Icon n="screen_share" />もう一度試す</button></>
              ) : (
                <><Icon n="smartphone" /><b>画面はまだ映っていません</b><span className="small muted">「画面共有を開始」を押すと、スマホに許可のダイアログが出ます。ユーザー補助がオンなら、映った画面をそのまま操作できます。</span>
                  <button className="btn filled" onClick={() => link.mirrorStart()}><Icon n="screen_share" />画面共有を開始</button></>
              )}
            </div>
          )}
          {hasFrame && cursor && acc && (
            <span className="rp-cursor" style={{ left: `${cursor.x * 100}%`, top: `${cursor.y * 100}%` }} aria-hidden="true" />
          )}
          {hasFrame && live && (
            <span className="rp-hint small">{kb ? 'キーボード入力: この画面をクリックしてから打鍵' : 'キーボード入力: オフ'}</span>
          )}
        </div>

        <aside className="rp-side">
          <div className="rp-side-row">
            <span className="muted small">ミラーリング</span>
            {live
              ? <button className="btn tonal" onClick={() => link.mirrorStop()}><Icon n="stop_circle" />停止</button>
              : <button className="btn filled" onClick={() => link.mirrorStart()} disabled={!s.via}><Icon n="screen_share" />画面共有を開始</button>}
          </div>
          {r.w > 0 && <p className="muted small">スマホの解像度 {r.w} × {r.h} · 長辺 720px に縮小して JPEG で送信{live ? ` · 約 ${fps} fps` : ''}</p>}
          <div className="rp-side-row">
            <span className="muted small">キーボード</span>
            <button className={'btn ' + (kb ? 'filled' : 'tonal')} role="switch" aria-checked={kb} onClick={() => setKb((v) => !v)}>
              <Icon n={kb ? 'keyboard' : 'keyboard_hide'} />{kb ? 'オン' : 'オフ'}
            </button>
          </div>
          <div className="rp-nav" role="toolbar" aria-label="スマホのナビゲーション">
            {navButtons.map(([k, label, ic]) => (
              <button key={k} className="rp-nav-btn" disabled={!acc} onClick={() => link.remoteKey(k)} title={label}>
                <Icon n={ic} /><span className="small">{label}</span>
              </button>
            ))}
          </div>
          <p className="muted small">
            できること: タップ・長押し・スワイプ（ドラッグ）・ホイールスクロール・右クリックで戻る・文字入力（フォーカス中の欄へ）・Enter／Backspace／Tab／矢印／Esc／Home。<br />
            できないこと: 電源ボタンの長押しメニューや、ロック画面での操作（Android が一般アプリに許していません）。ロックは「画面ロック」で行えます。
          </p>
          <p className="muted small">
            ユーザー補助は画面の内容を読み取り、操作を代行する強い権限です。Quick Link はこの端末の操作にだけ使い、内容を外部へ送りません。
          </p>
        </aside>
      </div>
    </div>
  )
}
