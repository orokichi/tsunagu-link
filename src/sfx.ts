/**
 * Assistant sound effects, synthesised with the Web Audio API.
 *
 * No audio files: everything is built from oscillators and gain envelopes, so a
 * note always plays (and works offline). The first note needs a user gesture to
 * unlock audio — the assistant's own opening tap provides it.
 */
type Wave = OscillatorType

let ctx: AudioContext | null = null
let master: GainNode | null = null

const KEY = 'ts.ai.sound'
export const soundOn = () => localStorage.getItem(KEY) !== '0'
export function setSound(on: boolean) { localStorage.setItem(KEY, on ? '1' : '0') }

function ac(): AudioContext | null {
  if (typeof window === 'undefined') return null
  const Ctor = window.AudioContext || (window as any).webkitAudioContext
  if (!Ctor) return null
  if (!ctx) {
    try {
      ctx = new Ctor()
      master = ctx.createGain()
      master.gain.value = 0.5
      master.connect(ctx.destination)
    } catch { return null }
  }
  if (ctx.state === 'suspended') void ctx.resume().catch(() => {})
  return ctx
}

/** Unlock audio on the first real gesture (browsers block sound before one). */
export function primeAudio() { ac() }

function tone(freq: number, startAt: number, dur: number, opts: { type?: Wave; gain?: number; to?: number; attack?: number } = {}) {
  const c = ac(); if (!c || !master) return
  const { type = 'sine', gain = 0.16, to, attack = 0.012 } = opts
  const t0 = c.currentTime + startAt
  const osc = c.createOscillator()
  const g = c.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(freq, t0)
  if (to && to !== freq) osc.frequency.exponentialRampToValueAtTime(to, t0 + dur)
  g.gain.setValueAtTime(0.0001, t0)
  g.gain.exponentialRampToValueAtTime(gain, t0 + attack)
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
  osc.connect(g).connect(master)
  osc.start(t0)
  osc.stop(t0 + dur + 0.02)
}

function noise(startAt: number, dur: number, gain = 0.05) {
  const c = ac(); if (!c || !master) return
  const n = Math.floor(c.sampleRate * dur)
  const buf = c.createBuffer(1, n, c.sampleRate)
  const d = buf.getChannelData(0)
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n) ** 3
  const src = c.createBufferSource()
  src.buffer = buf
  const g = c.createGain(); g.gain.value = gain
  const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 2200
  src.connect(hp).connect(g).connect(master)
  src.start(c.currentTime + startAt)
}

/** Siri-like clear two-note chime (assistant opens / starts listening). */
export function sfxOpen() {
  if (!soundOn()) return
  tone(1174.66, 0, 0.34, { gain: 0.13 })        // D6
  tone(1760.0, 0.085, 0.5, { gain: 0.1 })       // A6
  tone(2637.02, 0.085, 0.28, { gain: 0.035, type: 'triangle' })
  noise(0.0, 0.04, 0.012)
}

/** Soft click / chirp when the message is sent. */
export function sfxSend() {
  if (!soundOn()) return
  tone(880, 0, 0.09, { gain: 0.07, type: 'triangle', to: 1320 })
  noise(0, 0.03, 0.02)
}

/** Rising, pleasant chord when an answer or an action completes. */
export function sfxSuccess() {
  if (!soundOn()) return
  const notes = [523.25, 659.25, 783.99, 1046.5] // C5 E5 G5 C6
  notes.forEach((f, i) => tone(f, i * 0.055, 0.42 - i * 0.03, { gain: 0.085 - i * 0.008 }))
}

/** Quiet, low notification for errors (no alarm sound). */
export function sfxError() {
  if (!soundOn()) return
  tone(392, 0, 0.16, { gain: 0.08, type: 'sine', to: 330 })
  tone(261.63, 0.12, 0.24, { gain: 0.07, type: 'sine' })
}

/** Tiny tick used while listening starts / stops. */
export function sfxTick() {
  if (!soundOn()) return
  tone(1568, 0, 0.05, { gain: 0.035, type: 'sine' })
}
