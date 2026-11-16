import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import SiriOrb, { OrbState } from './SiriOrb'
import { link } from './link'
import { Icon, GroqIcon } from './icons'
import { GROQ_MODELS, DEFAULT_MODEL, getConfig, hasKey, runTurn, saveConfig, testGroq, TOOL_LABEL as LABEL } from './assistant'
import type { ChatMsg } from './assistant'
import { primeAudio, setSound, sfxError, sfxOpen, sfxSend, sfxSuccess, sfxTick, soundOn } from './sfx'

type Line = { id: number; who: 'user' | 'ai' | 'tool'; text: string; ok?: boolean; pending?: boolean }

const CHIPS = ['バッテリーは？', '通知をまとめて消して', '音量を下げて', '未読メッセージを見せて', 'スマホの場所は？', '通知のウィジェットを作って']

const shortModel = (id: string) => (GROQ_MODELS.find(([m]) => m === id) || [id, id])[1].split(' — ')[0]

/**
 * クイックAI — a Gemini-shaped standalone app for the paired phone.
 *
 * The design follows Gemini: a clean surface, a greeting and prompt chips when
 * the conversation is empty, the model named in a pill at the top (tap it to
 * change model — the next message uses it immediately), a user message as a
 * filled pill on the right and the answer on the left under the Groq「g」mark,
 * and one centred pill input bar at the bottom with voice, send and the sound
 * toggle. The thinking is Groq Chat Completions with tool calling (see
 * assistant.ts); every action goes through the same `link` client the UI uses.
 *
 * It is never a modal: inside the Googlebook OS desktop it opens as a window
 * (`QuickAIChat`), so the widgets behind it stay visible.
 */
export function QuickAIChat({ onOpenSettings, onClose }: { onOpenSettings?: () => void; onClose?: () => void }) {
  const ls_ = useSyncExternalStore(link.subscribe, link.get)
  const [orb, setOrb] = useState<OrbState>('idle')
  const [lines, setLines] = useState<Line[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [listening, setListening] = useState(false)
  const [amp, setAmp] = useState(0)
  const [err, setErr] = useState<string | null>(null)
  const [model, setModel] = useState(() => getConfig().model || DEFAULT_MODEL)
  const [models, setModels] = useState(false)
  const [snd, setSnd] = useState(() => soundOn())
  const history = useRef<ChatMsg[]>([])
  const idRef = useRef(0)
  const recRef = useRef<any>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const push = (l: Omit<Line, 'id'>) => setLines((ls) => [...ls, { ...l, id: ++idRef.current }])

  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight }, [lines])
  useEffect(() => () => { try { recRef.current?.stop() } catch {} }, [])

  // Simulated speech envelope while the microphone is open (keeps the orb
  // alive without a second microphone consumer competing with recognition).
  useEffect(() => {
    if (!listening) { setAmp(0); return }
    let t = 0
    const id = window.setInterval(() => {
      t += 0.35
      setAmp(Math.max(0.18, Math.min(1, 0.5 + 0.28 * Math.sin(t) + 0.18 * Math.sin(t * 2.3))))
    }, 90)
    return () => window.clearInterval(id)
  }, [listening])

  const send = async (forced?: string) => {
    const q = (forced ?? input).trim()
    if (!q || busy) return
    if (!hasKey()) { setErr('Groq の API キーがまだ設定されていません。設定 →「クイックAI」でキーを入力してください。'); return }
    primeAudio(); sfxSend()
    setInput('')
    setErr(null)
    push({ who: 'user', text: q })
    setBusy(true); setOrb('thinking')
    const toolIds: number[] = []
    try {
      const { reply, messages } = await runTurn(history.current, q, {
        onDelta: () => setOrb('streaming'),
        onToolStart: (name) => {
          const id = ++idRef.current
          toolIds.push(id)
          setLines((ls) => [...ls, { id, who: 'tool', text: LABEL[name] || name, pending: true }])
        },
        onToolEnd: (_name, outcome) => {
          const id = toolIds.shift()
          setLines((ls) => ls.map((l) => (l.id === id ? { ...l, pending: false, ok: outcome.ok } : l)))
        },
      })
      // Only plain user/assistant turns are kept for the next message: a tool
      // result without its tool_calls (cut by the history limit) would make the
      // next request invalid.
      history.current = messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ role: m.role, content: (m as { content: string }).content }) as ChatMsg)
        .filter((m) => m.content)
        .slice(-10)
      if (reply) push({ who: 'ai', text: reply })
      setOrb('done'); sfxSuccess()
      window.setTimeout(() => setOrb((s) => (s === 'done' ? 'idle' : s)), 900)
    } catch (e: any) {
      const msg = String(e?.message || '')
      const text = msg === 'NO_KEY'
        ? 'Groq の API キーがまだ設定されていません。設定 →「クイックAI」でキーを入力してください。'
        : msg === 'AbortError' ? 'キャンセルしました。'
          : /Failed to fetch|NetworkError/i.test(msg) ? 'Groq に接続できませんでした（ネットワーク、またはブラウザの拡張機能によるブロックを確認してください）。'
            : msg
      push({ who: 'ai', text })
      setOrb('error'); sfxError()
      window.setTimeout(() => setOrb('idle'), 700)
    } finally {
      setBusy(false)
    }
  }

  const mic = () => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!SR) { setErr('このブラウザは音声入力（Web Speech API）に対応していません。キーボードで入力してください。'); return }
    if (listening) { try { recRef.current?.stop() } catch {} return }
    try {
      const rec = new SR()
      recRef.current = rec
      rec.lang = 'ja-JP'
      rec.interimResults = true
      rec.continuous = false
      rec.onresult = (e: any) => {
        let t = ''
        for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript
        setInput(t)
      }
      rec.onerror = () => { setListening(false); setOrb('idle'); setErr('音声を聞き取れませんでした。マイクの許可を確認してください。'); sfxError() }
      rec.onend = () => { setListening(false); setOrb((s) => (s === 'listening' ? 'idle' : s)) }
      rec.start()
      primeAudio(); sfxTick()
      setErr(null); setListening(true); setOrb('listening')
    } catch { setErr('マイクを開始できませんでした。') }
  }

  const pickModel = (id: string) => {
    saveConfig({ model: id })
    setModel(id)
    setModels(false)
    sfxTick()
    inputRef.current?.focus()
  }
  const toggleSound = () => { const v = !snd; setSnd(v); setSound(v); primeAudio(); if (v) sfxTick() }

  const ready = typeof window !== 'undefined' && hasKey()

  return (
    <div className="qai">
      <header className="qai-head">
        <span className="qai-mark"><GroqIcon size={20} /></span>
        <b className="qai-name">クイックAI</b>
        <div className="qai-model">
          <button className={'qai-pill' + (models ? ' open' : '')} aria-haspopup="listbox" aria-expanded={models}
            title="モデルを選ぶ" onClick={() => setModels((v) => !v)}>
            <span>{shortModel(model)}</span><Icon n="expand_more" />
          </button>
          {models && (
            <>
              <div className="qai-menu-scrim" onClick={() => setModels(false)} />
              <div className="qai-menu" role="listbox" aria-label="モデル">
                {GROQ_MODELS.map(([id, label]) => (
                  <button key={id} role="option" aria-selected={id === model} className={id === model ? 'on' : ''} onClick={() => pickModel(id)}>
                    <span><b>{label.split(' — ')[0]}</b><span className="small muted">{label.split(' — ')[1] || id}</span></span>
                    {id === model && <Icon n="check" />}
                  </button>
                ))}
                <p className="qai-menu-note small muted">選んだモデルは次のメッセージから使われます。設定にも保存されます。</p>
              </div>
            </>
          )}
        </div>
        <span className="qai-spacer" />
        <button className={'icon-btn sm' + (snd ? ' on' : '')} title={snd ? '効果音をオフ' : '効果音をオン'} aria-pressed={snd} onClick={toggleSound}>
          <Icon n={snd ? 'volume_up' : 'volume_off'} fill={snd} />
        </button>
        {onClose && <button className="icon-btn sm" title="閉じる" onClick={onClose}><Icon n="close" /></button>}
      </header>

      <div className="qai-log" ref={logRef}>
        {!lines.length && (
          <div className="qai-hello">
            <span className="qai-orb"><SiriOrb state={orb} size={56} amplitude={amp} /></span>
            <h2>こんにちは、クイックAIです</h2>
            <p className="muted">つないだスマートフォンのことを聞いたり、操作したり、ウィジェットを作ったりできます。</p>
          </div>
        )}
        {!ready && (
          <div className="qai-setup-card">
            <span className="qai-avatar"><GroqIcon size={16} /></span>
            <div>
              <b>Groq Console API キーが必要です</b>
              <p className="small muted">設定 →「クイックAI（Groq Console API）」でキーを保存すると、スマホの操作やウィジェット作成を頼めます。キーはこのブラウザにだけ保存され、Groq 以外には送られません。</p>
            </div>
            {onOpenSettings && <button className="btn tonal" onClick={onOpenSettings}><Icon n="settings" />設定を開く</button>}
          </div>
        )}
        {lines.map((l) =>
          l.who === 'tool' ? (
            <div key={l.id} className={'ai-tool' + (l.pending ? ' pending' : l.ok ? ' ok' : ' fail')}>
              <Icon n={l.pending ? 'progress_activity' : l.ok ? 'check_circle' : 'error'} className={l.pending ? 'spin' : ''} />
              <span className="small">{l.text}</span>
            </div>
          ) : l.who === 'user' ? (
            <div key={l.id} className="qai-turn user"><div className="qai-bubble user">{l.text}</div></div>
          ) : (
            <div key={l.id} className="qai-turn ai">
              <span className="qai-avatar"><GroqIcon size={16} /></span>
              <div className="qai-bubble ai">{l.text}</div>
            </div>
          ),
        )}
        {busy && !lines.some((l) => l.pending) && (
          <div className="qai-turn ai"><span className="qai-avatar"><GroqIcon size={16} /></span>
            <div className="qai-bubble ai thinking"><span className="dots"><i /><i /><i /></span></div></div>
        )}
      </div>

      {err && <div className="ai-err small"><Icon n="error" />{err}</div>}

      {!lines.length && (
        <div className="qai-chips">
          {CHIPS.map((c) => <button key={c} className="qai-chip" disabled={busy || !ready} onClick={() => void send(c)}><Icon n="auto_awesome" />{c}</button>)}
        </div>
      )}

      <form className="qai-input" onSubmit={(e) => { e.preventDefault(); void send() }}>
        <button type="button" className={'icon-btn' + (listening ? ' filled' : '')} title="音声で入力" aria-pressed={listening} onClick={mic}>
          <Icon n={listening ? 'mic' : 'mic_none'} fill={listening} />
        </button>
        <input ref={inputRef} value={input} onChange={(e) => setInput(e.target.value)}
          placeholder={listening ? '聞いています…' : 'クイックAIにメッセージ'} aria-label="クイックAIへの指示" />
        <button className="icon-btn filled qai-send" disabled={busy || !input.trim()} aria-label="送信"><Icon n="arrow_upward" /></button>
      </form>
      <p className="qai-note small muted">
        {ls_.status === 'connected' ? `${ls_.device?.name || 'スマートフォン'} に接続中` : 'スマートフォン未接続（接続するまで操作はできません）'}
        <span> · Groq / {shortModel(model)}</span>
        <span> · 誤りを含む場合があります</span>
      </p>
    </div>
  )
}

/** The corner orb: a shortcut that opens the Quick AI app (never a modal). */
export function QuickAIOrb({ onClick, open }: { onClick: () => void; open?: boolean }) {
  return (
    <button className={'ai-fab gb-ai-fab' + (open ? ' open' : '')} onClick={onClick}
      aria-label="クイックAIを開く" title="クイックAI">
      <SiriOrb state="idle" size={50} />
    </button>
  )
}

/**
 * Classic (rail) UI: the corner orb opens クイックAI as the main pane — one
 * instance, one conversation, and a real app rather than a popup that covers
 * the page.
 */
export default function QuickAI({ onOpen }: { onOpen: () => void }) {
  return (
    <button className="ai-fab" onClick={() => { primeAudio(); sfxOpen(); onOpen() }}
      aria-label="クイックAIを開く" title="クイックAI">
      <SiriOrb state="idle" size={52} />
    </button>
  )
}

/* ---------------- 設定: Groq setup ---------------- */
export function GroqSettings() {
  const cfg = getConfig()
  const [key, setKey] = useState(cfg.key)
  const [model, setModel] = useState(cfg.model || DEFAULT_MODEL)
  const [show, setShow] = useState(false)
  const [state, setState] = useState<'idle' | 'busy' | 'ok' | 'ng'>('idle')
  const [msg, setMsg] = useState('')
  const [snd, setSnd] = useState(() => soundOn())

  const save = () => {
    saveConfig({ key: key.trim(), model })
    setState('idle'); setMsg('保存しました')
    link.toast('クイックAIの設定を保存しました')
  }
  const test = async () => {
    setState('busy'); setMsg('接続しています…')
    const r = await testGroq(key)
    setState(r.ok ? 'ok' : 'ng'); setMsg(r.message)
  }
  const toggleSound = () => { const v = !snd; setSnd(v); setSound(v); primeAudio() }

  return (
    <section className="card set-card a-ai">
      <div className="set-head">
        <div><h3>クイックAI（Groq Console API）</h3><p className="muted small">アプリ「クイックAI」と、AI によるウィジェット作成で使います</p></div>
        <span className={'via-chip ' + (cfg.key ? 'lan' : '')}><Icon n={cfg.key ? 'check_circle' : 'key'} />{cfg.key ? '設定済み' : '未設定'}</span>
      </div>
      <div className="ai-set-row">
        <label className="ai-set-label">API キー
          <div className="ai-set-key">
            <input type={show ? 'text' : 'password'} value={key} onChange={(e) => setKey(e.target.value)} placeholder="gsk_…" autoComplete="off" spellCheck={false} />
            <button className="icon-btn sm" title={show ? '隠す' : '表示'} onClick={() => setShow((v) => !v)}><Icon n={show ? 'visibility_off' : 'visibility'} /></button>
          </div>
        </label>
        <label className="ai-set-label">モデル
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            {GROQ_MODELS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
        </label>
      </div>
      <div className="ai-set-actions">
        <button className="btn filled" onClick={save}><Icon n="save" />保存</button>
        <button className="btn tonal" disabled={state === 'busy' || !key.trim()} onClick={() => void test()}>
          <Icon n={state === 'busy' ? 'progress_activity' : 'bolt'} className={state === 'busy' ? 'spin' : ''} />{state === 'busy' ? '確認中…' : '接続テスト'}
        </button>
        <button className={'btn text'} onClick={toggleSound}><Icon n={snd ? 'volume_up' : 'volume_off'} />効果音 {snd ? 'オン' : 'オフ'}</button>
        <a className="btn text" href="https://console.groq.com/keys" target="_blank" rel="noreferrer"><Icon n="open_in_new" />キーを取得</a>
      </div>
      {msg && <p className={'small ' + (state === 'ng' ? 'ai-ng' : state === 'ok' ? 'ai-ok' : 'muted')}>{msg}</p>}
      <p className="muted small">
        Groq Console（console.groq.com）で発行した API キーを使います。キーはこの PC のブラウザ（ローカルストレージ）にだけ保存され、通信はブラウザから Groq へ直接行われます。会話の内容はスマホの状態を答えるために Groq へ送られます。無料枠には回数制限があります。
      </p>
    </section>
  )
}
