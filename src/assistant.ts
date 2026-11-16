/**
 * AI assistant brain: Groq Console API + tool calling over the paired phone.
 *
 * The browser talks to Groq directly with the user's own API key (stored in
 * this browser only). Every tool runs against the same `link` client the app
 * itself uses, so the assistant can only ever do what the UI can do — read the
 * phone's state, clear notifications, change volume / quick settings, move text
 * through the clipboard, read and send messages, locate and ring the phone.
 *
 * Nothing is faked: each tool returns what the phone actually reported, and a
 * call that cannot reach the phone says so.
 */
import { link } from './link'
import type { State, Sms } from './link'
import { planWidget, widgetStore } from './widgets'

const API = 'https://api.groq.com/openai/v1'
const KEY_STORE = 'ts.groq.key'
const MODEL_STORE = 'ts.groq.model'

export const GROQ_MODELS: [string, string][] = [
  ['llama-3.3-70b-versatile', 'Llama 3.3 70B — おすすめ（賢い・Tool Calling 対応）'],
  ['llama-3.1-8b-instant', 'Llama 3.1 8B — 高速・軽い'],
  ['openai/gpt-oss-120b', 'GPT-OSS 120B — 大型・推論向け'],
  ['openai/gpt-oss-20b', 'GPT-OSS 20B — 軽量'],
  ['meta-llama/llama-4-scout-17b-16e-instruct', 'Llama 4 Scout 17B'],
  ['qwen/qwen3-32b', 'Qwen3 32B'],
]
export const DEFAULT_MODEL = 'llama-3.3-70b-versatile'

export interface AiConfig { key: string; model: string }
export const getConfig = (): AiConfig => ({
  key: localStorage.getItem(KEY_STORE) || '',
  model: localStorage.getItem(MODEL_STORE) || DEFAULT_MODEL,
})
export function saveConfig(c: Partial<AiConfig>) {
  if (c.key !== undefined) { if (c.key) localStorage.setItem(KEY_STORE, c.key); else localStorage.removeItem(KEY_STORE) }
  if (c.model) localStorage.setItem(MODEL_STORE, c.model)
}
export const hasKey = () => !!getConfig().key

/* ---------------- Groq calls ---------------- */
export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export type ChatMsg =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: ToolCall[] }
  | { role: 'tool'; content: string; tool_call_id: string; name?: string }

function friendlyHttp(status: number, body: string): string {
  let detail = ''
  try { detail = JSON.parse(body)?.error?.message || '' } catch { detail = body.slice(0, 200) }
  if (status === 401) return 'Groq API キーが正しくないようです。設定の「AIアシスタント」でキーを確認してください。'
  if (status === 403) return 'この API キーでは利用できないモデルか、権限が足りません。'
  if (status === 404) return 'モデルが見つかりません。設定で別のモデルを選んでください。'
  if (status === 429) return 'Groq のリクエスト上限に達しました。少し待ってからもう一度お試しください。'
  if (status >= 500) return 'Groq 側で問題が起きています。少し待ってからもう一度お試しください。'
  return `Groq API エラー（${status}）${detail ? ': ' + detail : ''}`
}

/** Is the key valid, and what does it see? Used by 設定 → 接続テスト. */
export async function testGroq(key: string): Promise<{ ok: boolean; message: string }> {
  if (!key.trim()) return { ok: false, message: 'API キーを入力してください' }
  try {
    const r = await fetch(`${API}/models`, { headers: { Authorization: `Bearer ${key.trim()}` } })
    if (!r.ok) return { ok: false, message: friendlyHttp(r.status, await r.text()) }
    const j = await r.json().catch(() => ({}))
    const n = Array.isArray(j?.data) ? j.data.length : 0
    return { ok: true, message: `接続できました（利用できるモデル ${n} 件）` }
  } catch (e: any) {
    return { ok: false, message: `Groq に接続できませんでした（${e?.message || 'ネットワークエラー'}）。この PC のネットワークと、ブラウザの拡張機能によるブロックを確認してください。` }
  }
}

const SYSTEM = `あなたは「クイックAI」です。Quick Link は、この PC のブラウザと持ち主の Android スマートフォンを WebRTC でつないで、通知・メッセージ・通話・写真・ファイル・クリップボード・位置情報を PC から扱えるようにするアプリです。
あなたは会話しながら、用意されたツールでそのスマートフォンを実際に操作・確認できます。

守ること:
- スマートフォンの状態（バッテリー、通知、音量、位置など）を答えるときは、必ずツールで最新の状態を取得してから答える。推測で数字を作らない。
- 操作を頼まれたら、確認を求められていなくても実行してよい（例: 「音量を下げて」「通知を消して」）。ただし SMS の送信は、宛先と本文が指示に含まれている場合だけ実行し、あいまいなら短く聞き返す。
- ツールが失敗したとき・スマートフォンに接続していないときは、その事実を短く伝え、必要な操作（ペアリングや接続の確認）を1つだけ案内する。
- ウィジェットを作って頼まれたら create_widget を呼び、どんな見た目で追加したかを1文で伝える。ウィジェットは HTML ではなく、決まった Material 3 の型から選ばれる。
- 返事は日本語で、声に出して自然な短い文（1〜3文）にする。箇条書きは必要なときだけ。絵文字は使わない。
- 個人情報（電話番号や本文）は、本人が求めた範囲でだけ扱う。`

/** A snapshot of what the PC currently knows, so the model does not have to
 *  spend a tool round on context it already has. */
function contextNote(s: State): string {
  const i = s.info
  const parts = [
    s.status === 'connected'
      ? `接続中: ${s.device?.name || 'スマートフォン'}（${s.via === 'lan' ? '同じ Wi-Fi で直接' : s.via === 'usb' ? 'USB ケーブル' : 'クラウド経由'}）`
      : '未接続: スマートフォンとはつながっていません（操作はできません）',
  ]
  if (i) parts.push(`バッテリー ${i.battery}%${i.charging ? '（充電中）' : ''}、回線 ${i.net}`)
  parts.push(`未読メッセージ ${s.threads.reduce((a, t) => a + (t.unreadCount || 0), 0)} 件、通知 ${s.notifs.length} 件`)
  parts.push(s.remote.acc ? '画面操作（ユーザー補助）: 利用できます' : '画面操作（ユーザー補助）: オフ')
  return parts.join(' / ')
}

/* ---------------- Tool definitions ---------------- */
export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_phone_status',
      description: 'スマートフォンの最新の状態（バッテリー残量・充電・回線・空き容量・着信モード・自動回転・サイレント）を取得する。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_notifications',
      description: 'スマートフォンに出ている通知の一覧（アプリ名・タイトル・本文・キー）を取得する。',
      parameters: { type: 'object', properties: { limit: { type: 'integer', description: '最大件数（既定 10）' } }, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'dismiss_notifications',
      description: '通知を消す。key を指定するとその1件、all: true ですべて消す。',
      parameters: {
        type: 'object',
        properties: { key: { type: 'string', description: 'list_notifications が返した通知のキー' }, all: { type: 'boolean', description: 'すべての通知を消す' } },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_volume',
      description: 'スマートフォンのメディア音量を変える（0〜最大）。mute: true でミュート、mute: false でミュート解除。',
      parameters: { type: 'object', properties: { level: { type: 'integer' }, mute: { type: 'boolean' } }, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_quick_setting',
      description: 'スマートフォンのクイック設定を切り替える。setting は rotate（自動回転 on/off）、silent（サイレント on/off）、ringer（normal / vibrate / silent）。',
      parameters: {
        type: 'object',
        properties: {
          setting: { type: 'string', enum: ['rotate', 'silent', 'ringer'] },
          on: { type: 'boolean' },
          mode: { type: 'string', enum: ['normal', 'vibrate', 'silent'] },
        },
        required: ['setting'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'copy_text_to_phone',
      description: 'テキストをスマートフォンのクリップボードに入れる（スマホで貼り付けできる）。',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_phone_clipboard',
      description: 'スマートフォンから最近送られてきたクリップボードの内容（この PC が保持している最新のもの）を読む。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_message_threads',
      description: 'SMS の会話一覧（相手・最後のメッセージ・未読件数・threadId）を取得する。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_messages',
      description: '指定した会話のメッセージを読む（新しい順に最大30件）。',
      parameters: { type: 'object', properties: { threadId: { type: 'string' } }, required: ['threadId'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_message',
      description: 'SMS を送る。宛先（電話番号）と本文が必要。threadId が分かっていれば渡す。実行前に宛先と本文を指示から確認すること。',
      parameters: { type: 'object', properties: { to: { type: 'string' }, body: { type: 'string' }, threadId: { type: 'string' } }, required: ['to', 'body'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_phone_location',
      description: 'スマートフォンの現在地（緯度・経度・精度）を取得する。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ring_phone',
      description: 'スマートフォンを鳴らす（音）／振動させる／止める。action は ring・vibrate・stop。',
      parameters: { type: 'object', properties: { action: { type: 'string', enum: ['ring', 'vibrate', 'stop'] } }, required: ['action'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_on_phone',
      description: 'スマートフォンのブラウザで URL を開く。',
      parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'phone_global_action',
      description: 'スマートフォンの画面操作（ユーザー補助経由）。戻る・ホーム・履歴・通知パネル・クイック設定・画面ロック。相手のアプリを開くだけの操作で、文字入力やアプリ内のタップはしない。',
      parameters: { type: 'object', properties: { action: { type: 'string', enum: ['back', 'home', 'recents', 'notifications', 'quick_settings', 'lock', 'screen_on'] } }, required: ['action'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_widget',
      description: 'デスクトップに置くウィジェットを、ユーザーの自然な言葉（例:「バッテリーと通知が見やすい大きめウィジェット」）から作って追加する。',
      parameters: { type: 'object', properties: { request: { type: 'string', description: 'ユーザーが望んだ内容をそのまま' } }, required: ['request'] },
    },
  },
] as const

/* ---------------- Tool execution ---------------- */
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until<T>(get: () => T, ok: (v: T) => boolean, ms = 7000): Promise<T | null> {
  const t0 = Date.now()
  let v = get()
  while (!ok(v)) {
    if (Date.now() - t0 > ms) return null
    await wait(120)
    v = get()
  }
  return v
}
const noPhone = 'スマートフォンに接続していないため実行できません（ペアリングと接続を確認してください）。'

export interface ToolOutcome { text: string; ok: boolean }

export async function runTool(name: string, rawArgs: string): Promise<ToolOutcome> {
  let args: any = {}
  try { args = rawArgs ? JSON.parse(rawArgs) : {} } catch { args = {} }
  const s = link.get()
  // Making a widget only edits this browser's desktop: it works with the phone
  // disconnected too (the values then show as 「—」 until it comes back).
  if (s.status !== 'connected' && name !== 'create_widget') return { ok: false, text: noPhone }
  try {
    switch (name) {
      case 'get_phone_status': {
        await link.requestState('info')
        await link.requestState('sys')
        const st = link.get()
        const i = st.info, y = st.sys
        return {
          ok: true,
          text: JSON.stringify({
            device: st.device?.name, model: st.device?.model, android: st.device?.android,
            connection: st.via === 'lan' ? '同じ Wi-Fi で直接接続' : st.via === 'usb' ? 'USB ケーブル' : 'クラウド経由',
            battery: i?.battery ?? null, charging: i?.charging ?? null, network: i?.net ?? null,
            storageFreeBytes: i?.storageFree ?? null, powerSave: i?.powerSave ?? null,
            ringer: y?.ringer ?? i?.ringer ?? null, autoRotate: y?.rotate ?? null, silentMode: y?.dnd ?? null,
            mediaVolume: y ? { value: y.vol, max: y.volMax, muted: y.muted } : null,
          }),
        }
      }
      case 'list_notifications': {
        await link.requestState('notifs', 3500)
        const list = link.get().notifs.slice(0, Math.max(1, Math.min(30, args.limit || 10)))
        if (link.get().notifsError === 'off') return { ok: false, text: 'スマホの「通知へのアクセス」がオフのため、通知を読めません。' }
        return { ok: true, text: list.length ? JSON.stringify(list.map((n) => ({ key: n.key, app: n.app, title: n.title, text: n.text, time: new Date(n.time).toISOString(), replyable: !!n.reply }))) : '通知はありません。' }
      }
      case 'dismiss_notifications': {
        if (args.all) {
          link.dismissNotif('*')
          await wait(1200)
          await link.requestState('notifs', 2500)
          return { ok: true, text: `通知をすべて消去しました（残り ${link.get().notifs.length} 件）。` }
        }
        if (!args.key) return { ok: false, text: 'key か all: true のどちらかが必要です。' }
        link.dismissNotif(String(args.key))
        const gone = await until(() => link.get().notifs.some((n) => n.key === args.key), (still) => !still, 4000)
        return gone !== null
          ? { ok: true, text: '通知を1件消去しました。' }
          : { ok: false, text: '消去できませんでした（スマホ側で消せない通知か、通知へのアクセスがオフの可能性があります）。' }
      }
      case 'set_volume': {
        if (typeof args.mute === 'boolean') {
          link.setSys({ key: 'mute', on: args.mute })
          await link.requestState('sys', 3000)
          return { ok: true, text: args.mute ? 'ミュートにしました。' : 'ミュートを解除しました。' }
        }
        if (typeof args.level !== 'number') return { ok: false, text: 'level（0〜最大）か mute が必要です。' }
        const max = link.get().sys?.volMax || 15
        const lv = Math.max(0, Math.min(max, Math.round(args.level)))
        link.setSys({ key: 'vol', value: lv })
        await link.requestState('sys', 3000)
        return { ok: true, text: `メディア音量を ${lv}（最大 ${max}）にしました。` }
      }
      case 'set_quick_setting': {
        const mode = String(args.mode || '')
        if (args.setting === 'ringer') {
          if (!['normal', 'vibrate', 'silent'].includes(mode)) return { ok: false, text: 'mode は normal / vibrate / silent のどれかです。' }
          link.setSys({ key: 'ringer', mode })
          await link.requestState('sys', 3000)
          return { ok: true, text: `着信モードを ${mode} にしました。` }
        }
        if (args.setting === 'rotate') { link.setSys({ key: 'rotate', on: !!args.on }); await link.requestState('sys', 3000); return { ok: true, text: `自動回転を${args.on ? 'オン' : 'オフ'}にしました。` } }
        if (args.setting === 'silent') { link.setSys({ key: 'dnd', on: !!args.on }); await link.requestState('sys', 3000); return { ok: true, text: `サイレントを${args.on ? 'オン' : 'オフ'}にしました。` } }
        return { ok: false, text: 'setting は rotate / silent / ringer のどれかです。' }
      }
      case 'copy_text_to_phone': {
        const text = String(args.text || '')
        if (!text.trim()) return { ok: false, text: 'テキストが空です。' }
        link.sendClip(text, false)
        await wait(250)
        return { ok: true, text: `スマートフォンのクリップボードに ${text.length} 文字をコピーしました。` }
      }
      case 'read_phone_clipboard': {
        const c = link.get().clips.find((x) => x.from === 'phone')
        if (!c) return { ok: false, text: 'スマートフォンから送られたクリップボードはまだありません。' }
        return { ok: true, text: JSON.stringify({ text: c.text, time: new Date(c.time).toISOString() }) }
      }
      case 'list_message_threads': {
        await link.requestState('threads', 6000)
        const th = link.get().threads
        if (link.get().threadsError) return { ok: false, text: 'メッセージを読めません（スマホでメッセージの権限が必要です）。' }
        return { ok: true, text: th.length ? JSON.stringify(th.slice(0, 20).map((t) => ({ threadId: t.id, name: t.name || null, address: t.address, snippet: t.snippet, unread: t.unreadCount || 0, kind: t.kind || 'sms', time: new Date(t.time).toISOString() }))) : '会話はありません。' }
      }
      case 'read_messages': {
        const id = String(args.threadId || '')
        if (!id) return { ok: false, text: 'threadId が必要です。' }
        link.openThread(id)
        await until(() => (link.get().sms[id] || []).length, (n) => n > 0, 7000)
        const list: Sms[] = link.get().sms[id] || []
        const err = link.get().smsError[id]
        if (!list.length && err) return { ok: false, text: String(err) }
        return { ok: true, text: list.length ? JSON.stringify(list.slice(-30).map((m) => ({ id: m.id, body: m.body, mine: m.mine, time: new Date(m.time).toISOString() }))) : 'メッセージはありません。' }
      }
      case 'send_message': {
        const to = String(args.to || '')
        const body = String(args.body || '')
        if (!to.trim() || !body.trim()) return { ok: false, text: '宛先と本文の両方が必要です。' }
        link.sendSms(to.trim(), body, args.threadId ? String(args.threadId) : null)
        await wait(1600)
        return { ok: true, text: `${to} にメッセージを送信しました。` }
      }
      case 'get_phone_location': {
        const before = link.get().loc?.time || 0
        link.getLocation()
        const ok = await until(() => link.get().loc?.time || 0, (t) => t > before, 20000)
        const st = link.get()
        if (!ok || !st.loc) return { ok: false, text: st.locError === 'permission' ? 'スマホの位置情報が許可されていません。' : '位置を取得できませんでした（電波状況や位置情報の設定を確認してください）。' }
        return { ok: true, text: JSON.stringify({ lat: st.loc.lat, lng: st.loc.lng, accuracyMeters: st.loc.acc ? Math.round(st.loc.acc) : null, time: new Date(st.loc.time).toISOString(), map: `https://www.openstreetmap.org/?mlat=${st.loc.lat}&mlon=${st.loc.lng}#map=17/${st.loc.lat}/${st.loc.lng}` }) }
      }
      case 'ring_phone': {
        const a = String(args.action || 'ring')
        if (a === 'vibrate') { link.send({ t: 'vibrate', on: true }); return { ok: true, text: 'スマートフォンを振動させています。' } }
        if (a === 'stop') { link.send({ t: 'ring', on: false }); link.send({ t: 'vibrate', on: false }); return { ok: true, text: '鳴らすのを止めました。' } }
        link.send({ t: 'ring', on: true })
        return { ok: true, text: 'スマートフォンを鳴らしています。' }
      }
      case 'open_on_phone': {
        const url = String(args.url || '')
        if (!/^https?:\/\//i.test(url)) return { ok: false, text: 'http(s) の URL を指定してください。' }
        link.send({ t: 'open_url', url })
        return { ok: true, text: `スマートフォンで ${url} を開きました。` }
      }
      case 'phone_global_action': {
        const a = String(args.action || '')
        const map: Record<string, string> = { back: 'back', home: 'home', recents: 'recents', notifications: 'notifications', quick_settings: 'quick_settings', lock: 'lock', screen_on: 'screen_on' }
        if (!map[a]) return { ok: false, text: 'action は back / home / recents / notifications / quick_settings / lock / screen_on のどれかです。' }
        if (!link.get().remote.acc) return { ok: false, text: 'スマホの「ユーザー補助（リモート操作）」がオンになっていないため、画面操作はできません。スマホのアプリで許可してください。' }
        link.remoteKey(map[a])
        return { ok: true, text: `スマートフォンで ${a} を実行しました。` }
      }
      case 'create_widget': {
        const req = String(args.request || '').trim()
        if (!req) return { ok: false, text: '作りたいウィジェットの内容が必要です。' }
        const r = await planWidget(req)
        if (r.widget) widgetStore.add(r.widget)
        if (r.ok && r.widget) return { ok: true, text: `「${r.widget.title}」(${r.widget.template} / ${r.widget.size} / ${r.widget.theme} / ${r.widget.sources.join('・')}) をデスクトップに追加しました。` }
        const why = r.ok ? 'ウィジェットを作れませんでした' : r.error
        return r.widget
          ? { ok: false, text: `${why}。代わりに「${r.widget.title}」を追加しました。` }
          : { ok: false, text: why }
      }
      default:
        return { ok: false, text: `未知のツールです: ${name}` }
    }
  } catch (e: any) {
    return { ok: false, text: `実行に失敗しました（${e?.message || 'エラー'}）` }
  }
}

/* ---------------- Streaming chat with tool rounds ---------------- */
export interface RunHooks {
  onDelta?: (text: string) => void
  onToolStart?: (name: string) => void
  onToolEnd?: (name: string, outcome: ToolOutcome) => void
  signal?: AbortSignal
}

interface StreamResult { content: string; toolCalls: ToolCall[] }

async function streamOnce(messages: ChatMsg[], hooks: RunHooks): Promise<StreamResult> {
  const { key, model } = getConfig()
  if (!key) throw new Error('NO_KEY')
  const res = await fetch(`${API}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages, tools: TOOLS, tool_choice: 'auto', temperature: 0.3, max_tokens: 900, stream: true }),
    signal: hooks.signal,
  })
  if (!res.ok) throw new Error(friendlyHttp(res.status, await res.text()))
  if (!res.body) throw new Error('Groq から応答の本文が返りませんでした。')

  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let content = ''
  const calls: Record<number, { id: string; name: string; args: string }> = {}
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') continue
      let j: any
      try { j = JSON.parse(data) } catch { continue }
      const d = j.choices?.[0]?.delta
      if (!d) continue
      if (typeof d.content === 'string' && d.content) { content += d.content; hooks.onDelta?.(d.content) }
      if (Array.isArray(d.tool_calls)) {
        for (const tc of d.tool_calls) {
          const i = typeof tc.index === 'number' ? tc.index : 0
          if (!calls[i]) calls[i] = { id: '', name: '', args: '' }
          if (tc.id) calls[i].id = tc.id
          if (tc.function?.name) calls[i].name += tc.function.name
          if (tc.function?.arguments) calls[i].args += tc.function.arguments
        }
      }
    }
  }
  const toolCalls: ToolCall[] = Object.entries(calls)
    .filter(([, v]) => v.name)
    .map(([i, v]) => ({ id: v.id || `call_${i}`, type: 'function' as const, function: { name: v.name, arguments: v.args || '{}' } }))
  return { content, toolCalls }
}

/**
 * One user turn: stream the answer, run any tool calls, and stream again until
 * the model answers without asking for a tool (at most `maxRounds`, so a
 * confused model can never loop forever).
 */
export async function runTurn(history: ChatMsg[], user: string, hooks: RunHooks = {}): Promise<{ reply: string; messages: ChatMsg[] }> {
  const messages: ChatMsg[] = [
    { role: 'system', content: SYSTEM },
    { role: 'system', content: `いまの状況: ${contextNote(link.get())}` },
    ...history.slice(-12),
    { role: 'user', content: user },
  ]
  let reply = ''
  for (let round = 0; round < 4; round++) {
    const { content, toolCalls } = await streamOnce(messages, hooks)
    if (content) reply += content
    if (!toolCalls.length) {
      messages.push({ role: 'assistant', content })
      return { reply, messages }
    }
    messages.push({ role: 'assistant', content, tool_calls: toolCalls })
    for (const tc of toolCalls) {
      hooks.onToolStart?.(tc.function.name)
      const outcome = await runTool(tc.function.name, tc.function.arguments)
      hooks.onToolEnd?.(tc.function.name, outcome)
      messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: outcome.text })
    }
  }
  if (!reply) reply = 'ごめんなさい、うまくまとめられませんでした。もう一度お願いします。'
  return { reply, messages }
}

/** Human-readable label for a tool, shown in the log. */
export const TOOL_LABEL: Record<string, string> = {
  get_phone_status: 'スマホの状態を確認',
  list_notifications: '通知を確認',
  dismiss_notifications: '通知を消去',
  set_volume: '音量を変更',
  set_quick_setting: 'クイック設定を変更',
  copy_text_to_phone: 'スマホのクリップボードへ',
  read_phone_clipboard: 'クリップボードを読み取り',
  list_message_threads: 'メッセージ一覧を確認',
  read_messages: 'メッセージを読む',
  send_message: 'メッセージを送信',
  get_phone_location: '現在地を取得',
  ring_phone: 'スマホを鳴らす',
  open_on_phone: 'スマホで開く',
  phone_global_action: 'スマホの画面操作',
  create_widget: 'ウィジェットを作成',
}
