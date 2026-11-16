import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import QRCode from 'qrcode'
import { link, Photo, Transfer, APP_VERSION } from './link'
import { applyTheme } from './theme'

const APK_URL = 'https://github.com/orokichi/tsunagu-link/releases/latest'
const useLink = () => useSyncExternalStore(link.subscribe, link.get)
export const Icon = ({ n, fill, className = '' }: { n: string; fill?: boolean; className?: string }) =>
  <span className={'ms ' + className} style={fill ? { fontVariationSettings: "'FILL' 1" } : undefined}>{n}</span>

/* ---------- Expressive shapes ---------- */
function cookiePath(lobes: number, depth = 0.08, r = 50) {
  const pts: string[] = []
  for (let i = 0; i <= 360; i += 2) {
    const a = (i * Math.PI) / 180
    const rr = r * (1 - depth + depth * Math.cos(lobes * a))
    pts.push(`${(50 + rr * Math.cos(a)).toFixed(2)},${(50 + rr * Math.sin(a)).toFixed(2)}`)
  }
  return 'M' + pts.join('L') + 'Z'
}
export function Cookie({ lobes = 9, className = '', children }: { lobes?: number; className?: string; children?: React.ReactNode }) {
  return (
    <div className={'cookie ' + className}>
      <svg viewBox="0 0 100 100"><path d={cookiePath(lobes)} /></svg>
      <div className="cookie-in">{children}</div>
    </div>
  )
}
export function Wavy({ value, active = true }: { value: number; active?: boolean }) {
  const w = 400, amp = active ? 3 : 0
  let d = 'M0,6'
  for (let x = 0; x <= w * 2; x += 4) d += `L${x},${(6 + amp * Math.sin(x / 6)).toFixed(2)}`
  const pct = Math.max(0, Math.min(1, value)) * 100
  return (
    <div className="wavy" role="progressbar" aria-valuenow={Math.round(pct)}>
      <div className="wavy-fill" style={{ width: pct + '%' }}>
        <svg viewBox={`0 0 ${w} 12`} preserveAspectRatio="none" className={active ? 'moving' : ''}><path d={d} /></svg>
      </div>
      <div className="wavy-track" style={{ left: `calc(${pct}% + 6px)` }} />
    </div>
  )
}

const fmtSize = (b: number) => (b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(0) + ' KB' : b < 1073741824 ? (b / 1048576).toFixed(1) + ' MB' : (b / 1073741824).toFixed(1) + ' GB')
const fmtTime = (t: number) => {
  const d = new Date(t), now = new Date()
  return d.toDateString() === now.toDateString() ? d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString('ja-JP', { month: 'short', day: 'numeric' })
}
const fmtDur = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

/* ---------- Pairing ---------- */
function Pairing() {
  const s = useLink()
  const [qr, setQr] = useState('')
  useEffect(() => { QRCode.toDataURL(link.qrText, { margin: 1, width: 560, color: { dark: '#1b1b21', light: '#ffffff' } }).then(setQr) }, [s.code, s.secret])
  return (
    <div className="pair">
      <section className="pair-hero">
        <Cookie lobes={s.status === 'waiting' ? 9 : 6} className={'big spin ' + s.status}><Icon n="devices" fill /></Cookie>
        <h1>PC とスマホを、<br />ひとつに。</h1>
        <p className="lead">通知・メッセージ・通話・写真・ファイル共有・クリップボードを、このブラウザからそのまま扱えます。スマホからもこの PC にファイルやリンクを送れます。</p>
        <ol className="steps">
          <li><span>1</span><div><b>Android アプリを入れる</b><a className="btn tonal" href={APK_URL} target="_blank" rel="noreferrer"><Icon n="android" />APK をダウンロード</a></div></li>
          <li><span>2</span><div><b>アプリで「PC とつなぐ」</b>右の QR をスキャン、またはコードを入力（コードの入力は初回だけです）</div></li>
          <li><span>3</span><div><b>以後は自動で接続</b>同じ Wi-Fi につながっていれば、このページを開くだけで直接つながります。外出先などではクラウド経由でつながります</div></li>
        </ol>
      </section>
      <section className="pair-card">
        {s.status === 'error' ? <div className="err"><Icon n="error" />{s.error}</div> : <>
          <div className="qr">{qr ? <img src={qr} alt="ペアリング用 QR コード" /> : <div className="loader" />}</div>
          <div className="code-label">ペアリングコード</div>
          <div className="code">{s.code.split('').map((c, i) => <span key={i}>{c}</span>)}</div>
          <div className={'chip ' + s.status}><i />{s.status === 'waiting' ? 'スマホからの接続を待っています' : 'サーバーに接続中…'}</div>
          <button className="btn text" onClick={() => link.regenerate()}><Icon n="refresh" />コードを作り直す</button>
        </>}
      </section>
    </div>
  )
}

/* 「スマホを鳴らす」: 通常クリック = 音、右クリック / 長押し（600ms）= 振動。
   Long-press and context menu both suppress the click that follows them, so
   the ringer never fires by accident after a vibrate. */
function RingButton({ className = 'btn filled' }: { className?: string }) {
  const timer = useRef<number | undefined>(undefined)
  const suppressUntil = useRef(0)
  const vibrate = () => { suppressUntil.current = Date.now() + 800; link.send({ t: 'vibrate', on: true }) }
  const clear = () => { if (timer.current) { clearTimeout(timer.current); timer.current = undefined } }
  return (
    <button className={className}
      title="クリックで音を鳴らす／右クリック・長押しで振動させる"
      onClick={() => { if (Date.now() < suppressUntil.current) return; link.send({ t: 'ring', on: true }) }}
      onContextMenu={(e) => { e.preventDefault(); clear(); vibrate() }}
      onPointerDown={() => { clear(); timer.current = window.setTimeout(vibrate, 600) }}
      onPointerUp={clear} onPointerLeave={clear} onPointerCancel={clear}>
      <Icon n="ring_volume" />スマホを鳴らす
    </button>
  )
}

/* ---------- Home (dashboard) ---------- */
function useMedia(q: string) {
  const [m, setM] = useState(() => matchMedia(q).matches)
  useEffect(() => { const mq = matchMedia(q); const f = () => setM(mq.matches); mq.addEventListener('change', f); f(); return () => mq.removeEventListener('change', f) }, [q])
  return m
}

function Home({ go }: { go: (v: string) => void }) {
  const s = useLink()
  const i = s.info
  const [url, setUrl] = useState('')
  return (
    <div className="dash">
      <section className="card hero-device a-hero">
        <Cookie lobes={12} className="spin slow"><Icon n="smartphone" fill /></Cookie>
        <div className="hero-text">
          <div className="overline">接続中</div>
          <h2 className="display">{s.device?.name}</h2>
          <div className="muted">{s.device?.model} · Android {s.device?.android}</div>
          <div className="hero-chips">
            <span className={'via-chip ' + (s.via || '')}><Icon n={s.via === 'lan' ? 'wifi' : 'cloud'} />{s.via === 'lan' ? '同じネットワークで直接接続' : 'クラウド経由で接続'}</span>
            {i?.ringer && <span className="via-chip"><Icon n={s.sys?.ringer === 'silent' ? 'notifications_off' : s.sys?.ringer === 'vibrate' ? 'vibration' : 'notifications_active'} />{i.ringer}</span>}
          </div>
        </div>
        <div className="hero-actions"><RingButton className="btn filled big" /></div>
      </section>

      <section className="card battery-card a-battery">
        <Gauge value={i ? i.battery / 100 : 0} label={i ? i.battery + '%' : '—'} charging={!!i?.charging} powerSave={!!i?.powerSave} />
        <div className="battery-meta">
          <div className="batt-head">
            <b>{i?.charging ? '充電中' : 'バッテリー'}</b>
            {i && <SaverFlag on={i.powerSave} />}
          </div>
          <Stat icon="signal_cellular_alt" label={i?.carrier || 'ネットワーク'} value={i?.net || '—'} />
          <Stat icon="hard_drive" label="空き容量" value={i ? fmtSize(i.storageFree) : '—'} meter={i ? 1 - i.storageFree / i.storageTotal : 0} />
        </div>
      </section>

      <QuickSettings />

      <MediaCard />

      <section className="card actions a-actions">
        <h3>クイック操作</h3>
        <div className="action-grid">
          <label className="action-tile"><span className="at-icon"><Icon n="share" fill /></span><b>ファイル共有</b><span className="muted small">スマホに送る</span><input type="file" multiple hidden onChange={(e) => { if (e.target.files) link.sendFiles(e.target.files); e.target.value = '' }} /></label>
          <button className="action-tile" onClick={() => link.pushClipboard(true)}><span className="at-icon"><Icon n="content_paste_go" /></span><b>クリップボード</b><span className="muted small">スマホに送る</span></button>
          <button className="action-tile" onClick={() => go('find')}><span className="at-icon"><Icon n="location_on" /></span><b>探す</b><span className="muted small">地図で表示</span></button>
          <button className="action-tile" onClick={() => go('explorer')}><span className="at-icon"><Icon n="folder_open" /></span><b>ファイル</b><span className="muted small">ストレージを開く</span></button>
        </div>
        <form className="url" onSubmit={(e) => { e.preventDefault(); if (url) { link.send({ t: 'open_url', url: /^https?:/.test(url) ? url : 'https://' + url }); setUrl(''); link.toast('スマホにリンクを送りました') } }}>
          <Icon n="link" /><input placeholder="スマホで開くリンク" value={url} onChange={(e) => setUrl(e.target.value)} /><button className="icon-btn filled" aria-label="送信"><Icon n="send" /></button>
        </form>
      </section>

      <section className="card list-card a-notifs">
        <header><h3>最近の通知</h3><button className="btn text" onClick={() => go('notifs')}>すべて</button></header>
        {s.notifs.slice(0, 5).map((n) => <NotifRow key={n.key} n={n} compact />)}
        {!s.notifs.length && <Empty icon="notifications_off" text="通知はありません" />}
      </section>

      <section className="card list-card a-photos">
        <header><h3>最近の写真</h3><button className="btn text" onClick={() => go('photos')}>すべて</button></header>
        <div className="strip">{s.photos.slice(0, 14).map((p) => <Thumb key={p.id} p={p} />)}</div>
        {!s.photos.length && <Empty icon="photo_library" text="写真へのアクセスを許可すると表示されます" />}
      </section>
    </div>
  )
}
const Stat = ({ icon, label, value, meter }: { icon: string; label: string; value: string; meter?: number }) => (
  <div className="stat"><Icon n={icon} /><div><div className="muted small">{label}</div><b>{value}</b>{meter !== undefined && <div className="meter"><i style={{ width: meter * 100 + '%' }} /></div>}</div></div>
)
const Empty = ({ icon, text }: { icon: string; text: string }) => <div className="empty"><Icon n={icon} /><span>{text}</span></div>

/** Battery saver (省電力モード) state shown beside the battery level. App builds
 *  that do not report it yet show a neutral dash instead of guessing "off". */
const SaverFlag = ({ on }: { on?: boolean | null }) => (
  <span className={'batt-flag' + (on === true ? ' on' : '') + (on == null ? ' unknown' : '')}
    title={on == null ? 'スマホのアプリがバッテリーセーバーの状態をまだ送っていません' : 'スマホのバッテリーセーバー（省電力モード）'}>
    <Icon n="battery_saver" fill={on === true} />バッテリーセーバー{on == null ? ' —' : on ? ' オン' : ' オフ'}
  </span>
)

/** Expressive circular gauge (wavy when charging). */
function Gauge({ value, label, charging, powerSave }: { value: number; label: string; charging: boolean; powerSave?: boolean }) {
  const r = 52, c = 2 * Math.PI * r, v = Math.max(0, Math.min(1, value))
  return (
    <div className={'gauge' + (charging ? ' charging' : '') + (powerSave ? ' saver' : '') + (v <= 0.15 ? ' low' : '')}>
      <svg viewBox="0 0 128 128"><circle className="g-track" cx="64" cy="64" r={r} /><circle className="g-fill" cx="64" cy="64" r={r} strokeDasharray={`${c * v} ${c}`} /></svg>
      <div className="g-in"><Icon n={charging ? 'bolt' : 'battery_horiz_075'} fill /><b>{label}</b></div>
    </div>
  )
}

/** Phone quick settings: auto-rotate, ringer mode and Do Not Disturb. */
function QuickSettings() {
  const sys = useLink().sys
  const ringer = sys?.ringer || 'normal'
  return (
    <section className="card qs a-toggles">
      <header className="qs-h"><h3>スマホのクイック設定</h3>{!sys && <span className="muted small">アプリを v1.1.0 に更新すると使えます</span>}</header>
      <div className="qs-tiles">
        <Tile icon="screen_rotation" label="自動回転" on={!!sys?.rotate} state={sys?.rotate == null ? '—' : sys.rotate ? 'オン' : 'オフ'}
          disabled={!sys || !sys.canWrite} onClick={() => link.setSys({ key: 'rotate', on: !sys?.rotate })} />
        <Tile icon={sys?.dnd ? 'do_not_disturb_on' : 'do_not_disturb_off'} label="サイレント" on={!!sys?.dnd} state={sys?.dnd ? 'オン（優先のみ）' : 'オフ'}
          disabled={!sys || !sys.dndAccess} onClick={() => link.setSys({ key: 'dnd', on: !sys?.dnd })} />
      </div>
      <div className="ringer-seg" role="radiogroup" aria-label="着信モード">
        {([['normal', '着信音', 'notifications_active'], ['vibrate', 'バイブ', 'vibration'], ['silent', 'ミュート', 'notifications_off']] as const).map(([k, l, ic]) => (
          <button key={k} role="radio" aria-checked={ringer === k} className={ringer === k ? 'on' : ''} disabled={!sys || ((k === 'silent' || ringer === 'silent') && !sys.dndAccess)}
            onClick={() => link.setSys({ key: 'ringer', mode: k })}><Icon n={ic} fill={ringer === k} />{l}</button>
        ))}
      </div>
      {sys && !sys.canWrite && <PermHint text="自動回転の切り替えには、スマホで「システム設定の変更」の許可が必要です" onClick={() => link.sysPerm('write_settings')} />}
      {sys && !sys.dndAccess && <PermHint text="サイレント・ミュートの切り替えには、スマホで「サイレントモードへのアクセス」の許可が必要です" onClick={() => link.sysPerm('dnd')} />}
    </section>
  )
}
const Tile = ({ icon, label, state, on, disabled, onClick }: { icon: string; label: string; state: string; on: boolean; disabled?: boolean; onClick: () => void }) => (
  <button className={'tile' + (on ? ' on' : '')} disabled={disabled} onClick={onClick} aria-pressed={on}>
    <span className="tile-icon"><Icon n={icon} fill={on} /></span><span className="tile-text"><b>{label}</b><span className="small">{disabled ? '未許可' : state}</span></span>
  </button>
)
const PermHint = ({ text, onClick }: { text: string; onClick: () => void }) => (
  <div className="perm-hint"><Icon n="lock" /><span className="small">{text}</span><button className="btn text" onClick={onClick}>スマホで許可</button></div>
)

function MediaCard() {
  const s = useLink()
  const m = s.media, sys = s.sys
  const [drag, setDrag] = useState<number | null>(null)
  const vol = drag ?? sys?.vol ?? 0
  const max = sys?.volMax || 15
  const volume = sys && (
    <div className="volume">
      <button className="icon-btn" title={sys.muted ? 'ミュート解除' : 'ミュート'} onClick={() => link.setSys({ key: 'mute', on: !sys.muted })}><Icon n={sys.muted || vol === 0 ? 'volume_off' : vol < max / 2 ? 'volume_down' : 'volume_up'} fill /></button>
      <button className="icon-btn sm" title="音量を下げる" onClick={() => link.setSys({ key: 'vol_step', dir: -1 })}><Icon n="remove" /></button>
      <input type="range" className="slider" min={sys.volMin ?? 0} max={max} step={1} value={sys.muted ? 0 : vol} aria-label="メディアの音量"
        style={{ '--p': ((sys.muted ? 0 : vol) / max) * 100 + '%' } as React.CSSProperties}
        onChange={(e) => { const v = +e.target.value; setDrag(v); link.setSys({ key: 'vol', value: v }) }}
        onPointerUp={() => setDrag(null)} onKeyUp={() => setDrag(null)} onBlur={() => setDrag(null)} />
      <button className="icon-btn sm" title="音量を上げる" onClick={() => link.setSys({ key: 'vol_step', dir: 1 })}><Icon n="add" /></button>
      <span className="vol-num">{sys.muted ? 0 : vol}<span className="muted">/{max}</span></span>
    </div>
  )
  if (!m) return <section className="card media empty-media a-media"><Icon n="music_off" /><span className="muted">再生中のメディアはありません</span>{volume}</section>
  return (
    <section className={'card media a-media' + (m.playing ? ' playing' : '')}>
      <div className="media-main">
        <div className="art">{m.art ? <img src={'data:image/jpeg;base64,' + m.art} alt="" /> : <Icon n="music_note" />}</div>
        <div className="meta"><div className="overline">再生中 · {m.app}</div><b>{m.title}</b><span className="muted">{m.artist}</span>
          <Wavy value={m.duration ? (m.position || 0) / m.duration : 0} active={m.playing} />
          <div className="controls">
            <button className="icon-btn" onClick={() => link.send({ t: 'media_cmd', cmd: 'prev' })}><Icon n="skip_previous" fill /></button>
            <button className={'play ' + (m.playing ? 'on' : '')} onClick={() => link.send({ t: 'media_cmd', cmd: m.playing ? 'pause' : 'play' })}><Icon n={m.playing ? 'pause' : 'play_arrow'} fill /></button>
            <button className="icon-btn" onClick={() => link.send({ t: 'media_cmd', cmd: 'next' })}><Icon n="skip_next" fill /></button>
          </div>
        </div>
      </div>
      {volume}
    </section>
  )
}

/* ---------- Notifications ---------- */
function NotifRow({ n, compact, autoReply }: { n: import('./link').Notif; compact?: boolean; autoReply?: boolean }) {
  const [reply, setReply] = useState<string | null>(null)
  // Opened from a desktop notification click: jump straight into the reply box.
  useEffect(() => { if (autoReply) { if (n.reply) setReply(''); link.clearFocusNotif() } }, [autoReply])
  return (
    <div className="notif">
      <div className="avatar">{n.icon ? <img src={'data:image/png;base64,' + n.icon} alt="" /> : <Icon n="notifications" />}</div>
      <div className="body">
        <div className="row"><span className="muted small">{n.app} · {fmtTime(n.time)}</span></div>
        <b>{n.title}</b><p>{n.text}</p>
        {!compact && <div className="chips">
          {n.reply && <button className="chip-btn" onClick={() => setReply('')}><Icon n="reply" />返信</button>}
          {n.actions?.map((a, i) => <button key={i} className="chip-btn" onClick={() => link.send({ t: 'notif_action', key: n.key, index: i })}>{a}</button>)}
        </div>}
        {reply !== null && <form className="reply" onSubmit={(e) => { e.preventDefault(); link.send({ t: 'notif_reply', key: n.key, text: reply }); setReply(null) }}>
          <input autoFocus value={reply} onChange={(e) => setReply(e.target.value)} placeholder="返信を入力" /><button className="icon-btn filled"><Icon n="send" /></button></form>}
      </div>
      <button className="icon-btn" aria-label="消去" onClick={() => link.send({ t: 'notif_dismiss', key: n.key })}><Icon n="close" /></button>
    </div>
  )
}
function NotifDetail({ n }: { n: import('./link').Notif }) {
  const [reply, setReply] = useState('')
  return (
    <div className="detail notif-detail" key={n.key}>
      <div className="detail-head">
        <div className="avatar xl">{n.icon ? <img src={'data:image/png;base64,' + n.icon} alt="" /> : <Icon n="notifications" />}</div>
        <div><div className="overline">{n.app}</div><div className="muted small">{new Date(n.time).toLocaleString('ja-JP')}</div></div>
        <button className="icon-btn" title="消去" onClick={() => link.send({ t: 'notif_dismiss', key: n.key })}><Icon n="delete" /></button>
      </div>
      <h2 className="display-s">{n.title}</h2>
      <p className="detail-body">{n.text}</p>
      {!!n.actions?.length && <div className="chips">{n.actions.map((a, i) => <button key={i} className="chip-btn" onClick={() => link.send({ t: 'notif_action', key: n.key, index: i })}>{a}</button>)}</div>}
      {n.reply && <form className="composer" onSubmit={(e) => { e.preventDefault(); if (reply) { link.send({ t: 'notif_reply', key: n.key, text: reply }); setReply('') } }}>
        <input autoFocus value={reply} onChange={(e) => setReply(e.target.value)} placeholder={`${n.app} に返信`} /><button className="icon-btn filled big"><Icon n="send" fill /></button></form>}
    </div>
  )
}
function Notifs() {
  const s = useLink()
  const wide = useMedia('(min-width: 1000px)')
  const [sel, setSel] = useState<string | null>(null)
  useEffect(() => { if (s.focusNotif && wide) { setSel(s.focusNotif); link.clearFocusNotif() } }, [s.focusNotif, wide])
  const cur = s.notifs.find((n) => n.key === sel) || (wide ? s.notifs[0] : undefined)
  const perm = typeof Notification !== 'undefined' ? Notification.permission : 'unsupported'
  return (
    <div className="pane">
      <header className="pane-h"><h2 className="display-s">通知</h2>
        {perm === 'default' && <button className="btn tonal" onClick={() => Notification.requestPermission()}><Icon n="notifications_active" />ブラウザ通知を有効化</button>}
        {perm === 'denied' && <span className="muted small">ブラウザ通知がブロックされています（ブラウザの設定から許可してください）</span>}
        {s.pushState === 'unsupported' && <span className="muted small">このブラウザは「閉じていても通知」（Web Push）に対応していません</span>}
        {s.pushState === 'off' && perm !== 'denied' && <button className="btn tonal" onClick={() => link.enablePush()}><Icon n="notifications_paused" />アプリを閉じても通知を受け取る</button>}
        {s.pushState === 'busy' && <button className="btn tonal" disabled>設定中…</button>}
        {s.pushState === 'error' && <button className="btn tonal" onClick={() => link.enablePush()}><Icon n="refresh" />Push設定を再試行</button>}
        {s.pushState === 'on' && <span className="muted small">閉じていても通知: 有効{s.pushSynced ? '（スマホに登録済み）' : '（スマホ接続時に登録します）'}</span>}
        {s.pushState === 'on' && <button className="btn tonal" onClick={() => link.disablePush()}>Pushを無効化</button>}
        <button className="btn tonal" onClick={() => link.send({ t: 'notif_dismiss', key: '*' })}><Icon n="clear_all" />すべて消去</button></header>
      {wide ? (
        <div className="two-pane">
          <div className="card list-card pane-list">
            {s.notifs.map((n) => <button key={n.key} className={'thread notif-item' + (cur?.key === n.key ? ' sel' : '')} onClick={() => setSel(n.key)}>
              <div className="avatar">{n.icon ? <img src={'data:image/png;base64,' + n.icon} alt="" /> : <Icon n="notifications" />}</div>
              <div className="body"><div className="row"><span className="muted small">{n.app}</span><span className="muted small">{fmtTime(n.time)}</span></div><b>{n.title}</b><p className="muted">{n.text}</p></div>
            </button>)}
            {!s.notifs.length && <Empty icon="notifications_off" text="通知はありません（アプリで通知へのアクセスを許可してください）" />}
          </div>
          <div className="card pane-detail">{cur ? <NotifDetail n={cur} /> : <Empty icon="notifications" text="通知を選択してください" />}</div>
        </div>
      ) : (
        <div className="card list-card">{s.notifs.map((n) => <NotifRow key={n.key} n={n} autoReply={s.focusNotif === n.key} />)}{!s.notifs.length && <Empty icon="notifications_off" text="通知はありません（アプリで通知へのアクセスを許可してください）" />}</div>
      )}
    </div>
  )
}

/* ---------- Messages ---------- */
function Messages() {
  const s = useLink()
  const [sel, setSel] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [to, setTo] = useState('')
  const th = s.threads.find((t) => t.id === sel)
  const msgs = sel ? s.sms[sel] || [] : []
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }) }, [msgs.length, sel])
  // Leaving the messages screen stops the phone from treating the open
  // conversation as being read on the PC.
  useEffect(() => () => link.clearWatch(), [])
  const send = (e: React.FormEvent) => {
    e.preventDefault(); const addr = th ? th.address : to
    if (!text || !addr) return
    link.sendSms(addr, text, sel); setText('')
  }
  return (
    <div className={'pane split' + (sel ? ' has-sel' : '')}>
      <div className="card threads">
        <header className="pane-h"><h2 className="display-s">メッセージ</h2><button className="icon-btn filled" title="新規" onClick={() => setSel('new')}><Icon n="edit_square" /></button></header>
        {s.threads.map((t) => (
          <button key={t.id} className={'thread ' + (sel === t.id ? 'sel' : '') + ((t.unreadCount || 0) > 0 ? ' unread' : '')} onClick={() => { setSel(t.id); link.openThread(t.id) }}>
            <div className="avatar letter">{(t.name || t.address).slice(0, 1)}</div>
            <div className="body"><div className="row"><b>{t.name || t.address}</b>{t.kind === 'rcs' && <span className="kind-chip">RCS</span>}{t.kind === 'mms' && <span className="kind-chip">MMS</span>}<span className="muted small">{fmtTime(t.time)}</span>{(t.unreadCount || 0) > 0 && <span className="unread-badge">{t.unreadCount}</span>}</div><p className="muted">{t.snippet}</p></div>
          </button>
        ))}
        {!s.threads.length && <Empty icon="sms" text="メッセージへのアクセスを許可すると表示されます" />}
      </div>
      <div className="card convo">
        {sel ? <>
          <header className="convo-h"><button className="icon-btn back" title="戻る" onClick={() => { setSel(null); link.clearWatch() }}><Icon n="arrow_back" /></button>{sel === 'new' ? <input className="to" placeholder="宛先の電話番号" value={to} onChange={(e) => setTo(e.target.value)} /> : <><b>{th?.name || th?.address}</b><span className="muted small">{th?.address}</span>{th?.kind && <span className="kind-label">{th.kind === 'rcs' ? 'RCSメッセージ' : th.kind === 'mms' ? 'MMSメッセージ' : 'メッセージ'}</span>}</>}
            {th && <button className="icon-btn" title="発信" onClick={() => link.send({ t: 'dial', number: th.address })}><Icon n="call" /></button>}</header>
          <div className="bubbles">{msgs.map((m) => <div key={m.id} className={'bubble ' + (m.mine ? 'mine' : '')}>{m.body}<span>{fmtTime(m.time)}</span></div>)}<div ref={end} /></div>
          <form className="composer" onSubmit={send}><input placeholder={th?.kind === 'rcs' || th?.kind === 'mms' ? 'メッセージを入力（SMS として送信されます）' : 'メッセージを入力'} value={text} onChange={(e) => setText(e.target.value)} /><button className="icon-btn filled big"><Icon n="send" fill /></button></form>
        </> : <Empty icon="forum" text="会話を選択してください" />}
      </div>
    </div>
  )
}

/* ---------- Calls ---------- */
function Calls() {
  const s = useLink()
  const [num, setNum] = useState('')
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#']
  const typeIcon = (t: number) => (t === 1 ? ['call_received', 'in'] : t === 2 ? ['call_made', 'out'] : t === 3 || t === 5 ? ['call_missed', 'miss'] : ['call', ''])
  return (
    <div className="pane split">
      <div className="card threads">
        <header className="pane-h"><h2 className="display-s">通話履歴</h2></header>
        {s.calls.map((c, i) => { const [ic, cl] = typeIcon(c.type); return (
          <div key={i} className="thread">
            <div className={'avatar call ' + cl}><Icon n={ic} /></div>
            <div className="body"><div className="row"><b>{c.name || c.number}</b><span className="muted small">{fmtTime(c.time)}</span></div><p className="muted">{c.name ? c.number + ' · ' : ''}{c.duration ? fmtDur(c.duration) : '—'}</p></div>
            <button className="icon-btn" onClick={() => link.send({ t: 'dial', number: c.number })}><Icon n="call" /></button>
          </div>) })}
        {!s.calls.length && <Empty icon="call_log" text="通話履歴へのアクセスを許可すると表示されます" />}
      </div>
      <div className="card dialer">
        <div className="dial-num">{num || <span className="muted">番号を入力</span>}</div>
        <div className="keys">{keys.map((k) => <button key={k} className="key" onClick={() => setNum(num + k)}>{k}</button>)}</div>
        <div className="dial-row">
          <span />
          <button className="call-btn" onClick={() => num && link.send({ t: 'dial', number: num })}><Icon n="call" fill /></button>
          <button className="icon-btn" onClick={() => setNum(num.slice(0, -1))}><Icon n="backspace" /></button>
        </div>
        <p className="muted small center">スマホから発信し、音声はスマホで通話します</p>
      </div>
    </div>
  )
}

/* ---------- Photos ---------- */
function Thumb({ p, onOpen, sel }: { p: Photo; onOpen?: (p: Photo) => void; sel?: boolean }) {
  return (
    <button className={'thumb' + (sel ? ' sel' : '')} onClick={() => (onOpen ? onOpen(p) : link.send({ t: 'photo_get', id: p.id }))} title={p.name}>
      <img src={'data:image/jpeg;base64,' + p.thumb} alt={p.name} loading="lazy" />
      {p.video && <span className="badge"><Icon n="play_arrow" fill />{p.duration ? fmtDur(p.duration / 1000) : ''}</span>}
    </button>
  )
}
function PhotoDetail({ p, onClose }: { p: Photo; onClose?: () => void }) {
  return (
    <div className="viewer" onClick={(e) => e.stopPropagation()}>
      <img src={'data:image/jpeg;base64,' + p.thumb} alt="" />
      <div className="viewer-bar"><div><b>{p.name}</b><div className="muted small">{new Date(p.time).toLocaleString('ja-JP')} · {fmtSize(p.size)}{p.video ? ' · 動画' : ''}</div></div>
        <button className="btn filled" onClick={() => { link.send({ t: 'photo_get', id: p.id }); onClose?.(); link.toast('PC に転送しています…') }}><Icon n="download" />PC に保存</button></div>
    </div>
  )
}
function Photos() {
  const s = useLink()
  const wide = useMedia('(min-width: 1200px)')
  const [filter, setFilter] = useState<'all' | 'img' | 'vid'>('all')
  const [open, setOpen] = useState<Photo | null>(null)
  const list = s.photos.filter((p) => filter === 'all' || (filter === 'vid' ? p.video : !p.video))
  const cur = open || (wide ? list[0] : null)
  return (
    <div className="pane">
      <header className="pane-h"><h2 className="display-s">写真と動画</h2>
        <div className="seg">{([['all', 'すべて'], ['img', '写真'], ['vid', '動画']] as const).map(([k, l]) => <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>{filter === k && <Icon n="check" />}{l}</button>)}</div>
        <button className="icon-btn" title="更新" onClick={() => link.getPhotos(true)}><Icon n="refresh" /></button>
      </header>
      <div className={wide ? 'two-pane photos-pane' : ''}>
        <div>
          <div className="gallery">{list.map((p) => <Thumb key={p.id} p={p} onOpen={setOpen} sel={wide && cur?.id === p.id} />)}</div>
          {!s.photos.length && <Empty icon="photo_library" text="写真と動画へのアクセスを許可すると表示されます" />}
          {s.photosMore && <div className="center"><button className="btn tonal" onClick={() => link.getPhotos(false)}>さらに読み込む</button></div>}
        </div>
        {wide && cur && <div className="pane-detail sticky"><PhotoDetail p={cur} /></div>}
      </div>
      {!wide && open && <div className="scrim" onClick={() => setOpen(null)}><PhotoDetail p={open} onClose={() => setOpen(null)} /></div>}
    </div>
  )
}

/* ---------- Files ---------- */
function TransferRow({ t }: { t: Transfer }) {
  return (
    <div className="transfer">
      <div className={'avatar ' + t.dir}><Icon n={t.dir === 'in' ? 'download' : 'upload'} /></div>
      <div className="body"><div className="row"><b>{t.name}</b><span className="muted small">{t.state === 'error' ? '失敗' : t.state === 'done' ? fmtSize(t.size) : `${Math.round((t.done / Math.max(t.size, 1)) * 100)}%`}</span></div>
        {t.state === 'active' ? <Wavy value={t.done / Math.max(t.size, 1)} /> : <span className="muted small">{t.dir === 'in' ? 'スマホ → PC' : 'PC → スマホ（ダウンロード/Tsunagu）'}</span>}</div>
      {t.url && <a className="icon-btn" href={t.url} download={t.name}><Icon n="save" /></a>}
    </div>
  )
}
function Files() {
  const s = useLink()
  const sending = s.transfers.filter((t) => t.state === 'active' && t.dir === 'out')
  const pct = sending.length ? Math.round((sending.reduce((a, t) => a + t.done / Math.max(t.size, 1), 0) / sending.length) * 100) : 0
  return (
    <div className="pane">
      <header className="pane-h"><h2 className="display-s">ファイル共有</h2>{s.transfers.length > 0 && <button className="btn text" onClick={() => link.clearTransfers()}>履歴を消去</button>}</header>
      <div className="two-pane share-pane"><div className="col">
      <label className={'qs-hero card' + (sending.length ? ' sending' : '')}>
        <div className="qs-stage" aria-hidden="true">
          <span className="qs-ring" /><span className="qs-ring r2" /><span className="qs-ring r3" />
          <div className="qs-core"><Icon n="share" fill /></div>
        </div>
        <div className="overline">送信先</div>
        <div className="qs-device">
          <div className="qs-avatar"><Icon n="smartphone" fill /></div>
          <div className="qs-name">{s.device?.name || 'スマホ'}</div>
          <div className="muted small">{s.device?.model}{s.info ? ` · バッテリー ${s.info.battery}%${s.info.charging ? '（充電中）' : ''}${s.info.powerSave ? ' · バッテリーセーバー オン' : ''}` : ''}</div>
        </div>
        <p className="qs-status muted">{sending.length ? `送信中… ${pct}%` : 'タップしてファイルを選択 — この画面へのドラッグ＆ドロップでも送れます'}</p>
        <input type="file" multiple hidden onChange={(e) => { if (e.target.files?.length) link.sendFiles(e.target.files); e.target.value = '' }} />
      </label>
      <p className="muted small">受け取ったファイルはスマホの「ダウンロード/Tsunagu」に保存されます。スマホから送るには、Tsunagu アプリの「PC にファイルを送る」か、ギャラリーやファイルアプリの「共有」→「PC に送る」を選びます。</p>
      </div>
      <div className="card list-card"><header><h3>転送履歴</h3></header>{s.transfers.map((t) => <TransferRow key={t.id} t={t} />)}{!s.transfers.length && <Empty icon="swap_vert" text="転送履歴はありません" />}</div>
      </div>
    </div>
  )
}

/* ---------- Explorer ---------- */
const fsJoin = (a: string, b: string) => (a ? a + '/' + b : b)
function Explorer() {
  const s = useLink()
  const path = s.fsPath
  useEffect(() => { link.fsList(link.get().fsPath) }, [])
  const segs = path ? path.split('/') : []
  const parent = segs.slice(0, -1).join('/')
  return (
    <div className="pane">
      <header className="pane-h"><h2 className="display-s">エクスプローラー</h2>
        <button className="icon-btn" title="更新" onClick={() => link.fsList(path)}><Icon n="refresh" /></button>
        <button className="btn tonal" onClick={() => { const name = prompt('新しいフォルダ名'); if (name) link.fsMkdir(path, name) }}><Icon n="create_new_folder" />新規フォルダ</button>
        <label className="btn tonal"><Icon n="upload_file" />アップロード<input type="file" multiple hidden onChange={(e) => { if (e.target.files) link.fsUpload(e.target.files, path); e.target.value = '' }} /></label>
      </header>
      {s.fsReady && !s.fsAccess && <div className="warn-card">
        <Icon n="lock" />
        <div><b>すべてのファイルへのアクセスが許可されていません</b>
          <p className="small">許可がないフォルダは中身が表示されません。スマホの Tsunagu アプリの「連携する機能」→「エクスプローラー（全ファイル）」からも許可できます。</p></div>
        <button className="btn filled" onClick={() => link.fsPerm()}>スマホで許可画面を開く</button>
      </div>}
      <div className="crumbs">
        <button className="crumb" onClick={() => link.fsList('')}><Icon n="smartphone" />内部ストレージ</button>
        {segs.map((seg, i) => (
          <span key={i} className="crumb-wrap"><Icon n="chevron_right" className="crumb-sep" /><button className="crumb" onClick={() => link.fsList(segs.slice(0, i + 1).join('/'))}>{seg}</button></span>
        ))}
      </div>
      <div className="card list-card">
        {path && <button className="thread" onClick={() => link.fsList(parent)}>
          <div className="avatar"><Icon n="drive_folder_upload" /></div>
          <div className="body"><b>..</b><p className="muted">上のフォルダへ</p></div>
        </button>}
        {s.fsItems.map((it) => {
          const full = fsJoin(path, it.name)
          return (
            <div key={it.name} className="thread fs-row" onClick={() => { if (it.dir) link.fsList(full) }}>
              <div className={'avatar ' + (it.dir ? 'folder' : '')}><Icon n={it.dir ? 'folder' : 'description'} /></div>
              <div className="body">
                <div className="row"><b>{it.name}</b><span className="muted small">{it.time ? new Date(it.time).toLocaleString('ja-JP', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''}</span></div>
                <p className="muted">{it.dir ? 'フォルダ' : fmtSize(it.size)}</p>
              </div>
              {!it.dir && <button className="icon-btn" title="PC にダウンロード" onClick={(e) => { e.stopPropagation(); link.fsDownload(full) }}><Icon n="download" /></button>}
              <button className="icon-btn" title="名前を変更" onClick={(e) => { e.stopPropagation(); const name = prompt('新しい名前', it.name); if (name && name !== it.name) link.fsRename(full, name) }}><Icon n="edit" /></button>
              <button className="icon-btn" title="削除" onClick={(e) => { e.stopPropagation(); if (confirm(`「${it.name}」を削除しますか？${it.dir ? '\nフォルダの中身もすべて削除されます。' : ''}\nこの操作は取り消せません。`)) link.fsDelete(full) }}><Icon n="delete" /></button>
            </div>
          )
        })}
        {s.fsReady && !s.fsItems.length && <Empty icon="folder_open" text={path ? 'このフォルダは空です' : 'ファイルが表示されません（許可が必要な場合があります）'} />}
        {!s.fsReady && <Empty icon="folder_open" text="読み込み中…" />}
      </div>
    </div>
  )
}

/* ---------- Find （探す） ---------- */
function Find() {
  const s = useLink()
  useEffect(() => { link.getLocation() }, [])
  const loc = s.loc
  const embed = loc ? `https://www.openstreetmap.org/export/embed.html?bbox=${loc.lng - 0.006}%2C${loc.lat - 0.004}%2C${loc.lng + 0.006}%2C${loc.lat + 0.004}&layer=mapnik&marker=${loc.lat}%2C${loc.lng}` : ''
  const osmLink = loc ? `https://www.openstreetmap.org/?mlat=${loc.lat}&mlon=${loc.lng}#map=17/${loc.lat}/${loc.lng}` : ''
  return (
    <div className="pane">
      <header className="pane-h"><h2 className="display-s">探す</h2>
        <button className="btn tonal" disabled={s.locBusy} onClick={() => link.getLocation()}><Icon n="my_location" />{s.locBusy ? '取得中…' : '位置を再取得'}</button>
        <RingButton className="btn tonal" />
      </header>
      {s.locError === 'permission' && <div className="warn-card"><Icon n="location_off" /><div><b>位置情報が許可されていません</b><p className="small">スマホの Tsunagu アプリで「位置情報」を許可してください（アプリのホーム画面の「連携する機能」から許可できます）。</p></div></div>}
      {s.locError === 'unavailable' && <div className="warn-card"><Icon n="location_off" /><div><b>位置を取得できませんでした</b><p className="small">スマホの位置情報がオフになっているか、電波の届かない場所にいる可能性があります。スマホの設定で位置情報をオンにして、もう一度お試しください。</p></div></div>}
      {loc ? <div className="find-layout">
        <iframe title="OpenStreetMap" className="map-frame" src={embed} loading="lazy" />
        <div className="card find-meta">
          <Stat icon="my_location" label="精度" value={loc.acc != null ? `±${Math.round(loc.acc)} m` : '—'} />
          <Stat icon="schedule" label="最終取得" value={new Date(loc.time).toLocaleString('ja-JP')} />
          <a className="btn text" href={osmLink} target="_blank" rel="noreferrer"><Icon n="open_in_new" />OpenStreetMap で開く</a>
          <p className="muted small">地図データ © OpenStreetMap contributors</p>
        </div>
      </div> : !s.locError && <Empty icon="location_searching" text={s.locBusy ? 'スマホの位置を取得しています…' : '位置情報がまだありません'} />}
    </div>
  )
}

/* ---------- Clipboard ---------- */
function Clipboard() {
  const s = useLink()
  const [text, setText] = useState('')
  return (
    <div className="pane">
      <header className="pane-h"><h2 className="display-s">クリップボード</h2><button className="btn filled" onClick={() => link.pushClipboard(true)}><Icon n="content_paste_go" />今のクリップボードを送る</button></header>
      <p className="muted small">PC はこのタブに戻ったとき、スマホはアプリを開いたときやクイック設定タイルから自動で同期します。</p>
      <div className="two-pane clip-pane">
      <form className="card clip-compose" onSubmit={(e) => { e.preventDefault(); if (text) { link.sendClip(text); setText('') } }}>
        <textarea placeholder="スマホに送るテキスト" value={text} onChange={(e) => setText(e.target.value)} rows={5} />
        <button className="btn tonal"><Icon n="send" />送信</button>
      </form>
      <div className="card list-card">
        {s.clips.map((c, i) => (
          <div key={i} className="clip"><div className={'avatar ' + c.from}><Icon n={c.from === 'pc' ? 'computer' : 'smartphone'} /></div>
            <div className="body"><p>{c.text}</p><span className="muted small">{fmtTime(c.time)}</span></div>
            <button className="icon-btn" title="コピー" onClick={() => navigator.clipboard.writeText(c.text).then(() => link.toast('コピーしました'))}><Icon n="content_copy" /></button>
            <button className="icon-btn" title="スマホへ送る" onClick={() => link.sendClip(c.text)}><Icon n="send_to_mobile" /></button></div>
        ))}
        {!s.clips.length && <Empty icon="content_paste" text="履歴はありません" />}
        {s.clips.length > 0 && <div className="center"><button className="btn text" onClick={() => link.clearClips()}>履歴を消去</button></div>}
      </div>
      </div>
    </div>
  )
}

/* ---------- Settings ---------- */
function Settings() {
  const s = useLink()
  const target = link.lanTarget()
  const [ip, setIp] = useState(target?.manual ? target.eps.ips[0] : '')
  const [port, setPort] = useState(String(target?.manual ? target.eps.port : 47822))
  const pc = link.pcInfo()
  return (
    <div className="pane settings">
      <header className="pane-h"><h2 className="display-s">設定</h2></header>

      <section className="card set-card a-conn">
        <div className="set-head">
          <div><h3>接続方法</h3><p className="muted small">スマホとのつながり方を選びます</p></div>
          <span className={'via-chip ' + (s.via || '')}><Icon n={s.via === 'lan' ? 'wifi' : 'cloud'} />{s.via === 'lan' ? '同じネットワークで直接接続中' : s.via === 'cloud' ? 'クラウド経由で接続中' : '未接続'}</span>
        </div>
        <div className="set-seg" role="radiogroup" aria-label="接続方法">
          {([['auto', '自動', 'bolt', '同じ Wi-Fi では直接接続し、使えないときはクラウド経由'],
             ['cloud', 'クラウドのみ', 'cloud', '常にインターネット経由（LAN は使いません）']] as const).map(([k, l, ic, d]) => (
            <button key={k} role="radio" aria-checked={s.mode === k} className={s.mode === k ? 'on' : ''} onClick={() => link.setMode(k)}>
              <Icon n={ic} fill={s.mode === k} />
              <span><b>{l}</b><span className="small">{d}</span></span>
            </button>
          ))}
        </div>
      </section>

      <section className="card set-card a-lan">
        <div className="set-head">
          <div><h3>ローカル接続</h3><p className="muted small">同じ Wi-Fi の中だけで、インターネットを経由せずに直接つなぎます</p></div>
        </div>
        <div className="set-row lan-row">
          <Stat icon={target?.manual ? 'push_pin' : 'wifi_find'} label={target?.manual ? '手動で指定した接続先' : '自動で見つけた接続先'}
            value={target ? `${target.eps.ips[0]}:${target.eps.port}` : '未検出'} />
          <button className="btn tonal" disabled={s.lanBusy} onClick={() => link.connectLocal()}>
            <Icon n="bolt" />{s.lanBusy ? '接続中…' : '今すぐ接続を試す'}
          </button>
          {target?.manual && <button className="btn text" onClick={() => { link.clearManualLan(); setIp('') }}><Icon n="restart_alt" />自動検出に戻す</button>}
        </div>
        <form className="lan-form" onSubmit={(e) => { e.preventDefault(); link.setManualLan(ip, Number(port)) }}>
          <label>スマホの IP アドレス<input inputMode="decimal" placeholder="192.168.1.23" value={ip} onChange={(e) => setIp(e.target.value)} /></label>
          <label>ポート<input inputMode="numeric" placeholder="47822" value={port} onChange={(e) => setPort(e.target.value)} /></label>
          <button className="btn filled" disabled={!ip.trim()}><Icon n="save" />この接続先を使う</button>
        </form>
        <p className="muted small">{s.lanMessage || (target?.manual
          ? '手動で指定した接続先を優先して試します。うまくつながらないときは、スマホが同じ Wi-Fi にいるか、IP アドレスが変わっていないかを確認してください。'
          : 'ふだんはスマホが知らせてくる接続先に自動でつなぎます。見つからないときは、スマホの「設定」→「Wi-Fi」で確認できる IP アドレスを入れてください。ポートは通常 47822 です。')}</p>
      </section>

      <section className="card set-card">
        <div className="set-head"><div><h3>この PC</h3><p className="muted small">スマホのアプリに表示される情報</p></div></div>
        <div className="set-row">
          <Stat icon="computer" label="端末" value={pc.name} />
          <Stat icon="public" label="ブラウザ" value={`${pc.browser} · ${pc.os}`} />
          <Stat icon="desktop_windows" label="画面" value={pc.screen} />
          <Stat icon="notifications" label="閉じていても通知" value={s.pushState === 'on' ? '有効' : s.pushState === 'unsupported' ? '非対応' : s.pushState === 'blocked' ? 'ブロック中' : 'オフ'} />
        </div>
        <p className="muted small">Tsunagu Web v{APP_VERSION} · スマホのアプリを v1.2.0 以降に更新すると、バッテリーセーバーの状態も表示できます（v1.1.0 以降でクイック設定）。</p>
      </section>
    </div>
  )
}

/* ---------- Shell ---------- */
const NAV = [
  ['home', 'ホーム', 'home'], ['notifs', '通知', 'notifications'], ['messages', 'メッセージ', 'chat'],
  ['calls', '通話', 'call'], ['photos', '写真', 'photo_library'], ['files', '共有', 'share'],
  ['explorer', 'エクスプローラー', 'folder_open'], ['find', '探す', 'location_on'], ['clip', 'クリップボード', 'content_paste'],
  ['settings', '設定', 'settings'],
] as const

export default function App() {
  const s = useLink()
  const [view, setView] = useState<string>('home')
  const [drag, setDrag] = useState(false)
  useEffect(() => { applyTheme(s.seed); const mq = matchMedia('(prefers-color-scheme: dark)'); const f = () => applyTheme(s.seed); mq.addEventListener('change', f); return () => mq.removeEventListener('change', f) }, [s.seed])
  const connected = s.status === 'connected'
  const connectedRef = useRef(false)
  connectedRef.current = connected
  useEffect(() => { if (s.focusNotif) setView('notifs') }, [s.focusNotif])
  // Drop overlay: driven by window-level drag events with an enter/leave
  // counter. The old element-level dragleave check got stuck whenever the
  // drag ended without a drop (leaving the window, Esc, drop elsewhere),
  // because no event ever cleared the state. Every exit path now resets:
  // counter reaching 0, leaving the window (relatedTarget === null), drop,
  // dragend and window blur.
  useEffect(() => {
    let count = 0
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')
    const reset = () => { count = 0; setDrag(false) }
    const enter = (e: DragEvent) => { if (!connectedRef.current || !hasFiles(e)) return; count++; setDrag(true) }
    const over = (e: DragEvent) => { if (hasFiles(e)) e.preventDefault() }
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return
      if (!e.relatedTarget) { reset(); return }
      count = Math.max(0, count - 1); if (count === 0) setDrag(false)
    }
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      const files = e.dataTransfer?.files
      reset()
      if (connectedRef.current && files && files.length) { link.sendFiles(files); setView('files') }
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragover', over)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    window.addEventListener('dragend', reset)
    window.addEventListener('blur', reset)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
      window.removeEventListener('dragend', reset)
      window.removeEventListener('blur', reset)
    }
  }, [])
  const badges = useMemo(() => ({
    notifs: s.notifs.length,
    messages: s.threads.reduce((a, t) => a + (t.unreadCount || 0), 0),
  } as Record<string, number>), [s.notifs.length, s.threads])
  return (
    <div className={'app ' + (drag ? 'dragging' : '') + (connected ? ' on' : '')}>
      <nav className="rail" aria-label="メイン">
        <div className="brand"><img src="/icon.svg" alt="" /><span>Tsunagu</span></div>
        {connected && <label className="fab" title="ファイルを共有"><Icon n="share" fill /><span>共有</span><input type="file" multiple hidden onChange={(e) => { if (e.target.files?.length) { link.sendFiles(e.target.files); setView('files') } e.target.value = '' }} /></label>}
        {NAV.map(([k, l, ic]) => (
          <button key={k} disabled={!connected && k !== 'settings'} className={'nav ' + (view === k ? 'on' : '')} onClick={() => setView(k)}>
            <span className="pill"><Icon n={ic} fill={view === k} /><span className="pl">{l}</span>{badges[k] ? <em>{badges[k] > 99 ? '99+' : badges[k]}</em> : null}</span><span className="lbl">{l}</span>
          </button>
        ))}
        <div className="rail-foot">{connected ? <button className="nav" title="接続を解除" onClick={() => { if (confirm('ペアリングを解除して新しいコードを作りますか？')) link.regenerate() }}><span className="pill"><Icon n="link_off" /><span className="pl">ペアリング解除</span></span><span className="lbl">解除</span></button> : null}<div className="muted small center">v{APP_VERSION}</div></div>
      </nav>
      <main>
        {s.incomingCall && <div className="call-banner"><Cookie lobes={8} className="spin"><Icon n="ring_volume" fill /></Cookie><div><div className="overline">着信</div><b>{s.incomingCall.name || s.incomingCall.number || '不明な番号'}</b></div>
          <button className="btn filled danger" onClick={() => link.send({ t: 'call_end' })}><Icon n="call_end" />拒否</button></div>}
        {!connected && view !== 'settings' ? <Pairing /> :
          view === 'home' ? <Home go={setView} /> : view === 'notifs' ? <Notifs /> : view === 'messages' ? <Messages /> :
          view === 'calls' ? <Calls /> : view === 'photos' ? <Photos /> : view === 'files' ? <Files /> :
          view === 'explorer' ? <Explorer /> : view === 'find' ? <Find /> : view === 'clip' ? <Clipboard /> : <Settings />}
      </main>
      {s.pending && <div className="scrim"><div className="dialog"><Cookie lobes={6}><Icon n="phonelink_lock" /></Cookie><h3>{s.pending.name} が接続しようとしています</h3><p className="muted">コード入力で接続したデバイスです。許可すると、次回からは自動で接続されます。</p>
        <div className="dialog-actions"><button className="btn text" onClick={s.pending.reject}>拒否</button><button className="btn filled" onClick={s.pending.accept}>許可</button></div></div></div>}
      {s.ringing && <div className="scrim ring-scrim" onClick={() => link.stopRing()}><div className="dialog ring-dialog"><Cookie lobes={8} className="spin big"><Icon n="ring_volume" fill /></Cookie><h3 className="display-s">{s.device?.name || 'スマホ'} から呼び出し中</h3><p className="muted">この PC はここにあります</p><button className="btn filled big" onClick={() => link.stopRing()}><Icon n="stop" fill />停止</button></div></div>}
      {s.inbox && <div className="scrim" onClick={() => link.clearInbox()}><div className="dialog inbox" onClick={(e) => e.stopPropagation()}><Cookie lobes={6}><Icon n="sms" /></Cookie><h3>{s.device?.name || 'スマホ'} からテキスト</h3>
        <textarea readOnly value={s.inbox.text} rows={Math.min(8, Math.max(3, s.inbox.text.split('\n').length))} onFocus={(e) => e.currentTarget.select()} />
        <div className="dialog-actions"><button className="btn text" onClick={() => link.clearInbox()}>閉じる</button>
          {/^https?:\/\/\S+$/.test(s.inbox.text.trim()) && <a className="btn tonal" href={s.inbox.text.trim()} target="_blank" rel="noreferrer" onClick={() => link.clearInbox()}><Icon n="open_in_new" />開く</a>}
          <button className="btn filled" onClick={() => { const t = s.inbox!.text; navigator.clipboard.writeText(t).then(() => link.toast('コピーしました')).catch(() => {}); link.clearInbox() }}><Icon n="content_copy" />コピー</button></div></div></div>}
      {drag && <div className="drop-overlay"><div className="qs-core lg"><Icon n="share" fill /></div><b>ドロップして{s.device ? `${s.device.name} に送信` : 'スマホに送信'}</b></div>}
      <div className="toasts">{s.toasts.map((t) => <div key={t.id} className="toast">{t.text}{t.action && <button onClick={t.action.run}>{t.action.label}</button>}</div>)}</div>
    </div>
  )
}
