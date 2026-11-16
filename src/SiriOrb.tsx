import type { CSSProperties } from 'react'

/**
 * Siri-style orb, after SmoothUI's `SiriOrb`
 * (https://smoothui.dev/docs/components/siri-orb): layered conic gradients
 * rotating around a registered CSS `@property --angle`, with a dot pattern in
 * `mix-blend-mode: overlay`. Rebuilt here without Tailwind or Motion, so it
 * costs no dependency and animates on the compositor.
 *
 * States follow the same six-state contract:
 *  idle      — slow spin, a little desaturated
 *  listening — grows with the microphone amplitude (--amp)
 *  thinking  — spins 2.2× faster, same size (the layout stays calm)
 *  streaming — softer breathing pulse while the answer arrives
 *  done      — one settle overshoot when a task completes
 *  error     — desaturates and shakes once, under 200ms
 * `prefers-reduced-motion` stops the rotation and drops the amplitude reaction.
 */
export type OrbState = 'idle' | 'listening' | 'thinking' | 'streaming' | 'done' | 'error'

export default function SiriOrb({ state = 'idle', size = 56, amplitude = 0, className = '' }: {
  state?: OrbState
  size?: number
  /** 0–1 microphone level; ignored for every state but `listening`. */
  amplitude?: number
  className?: string
}) {
  const amp = state === 'listening' ? Math.max(0, Math.min(1, amplitude)) : 0
  const style = {
    width: size, height: size,
    '--u': size / 56,
    '--blur': `${Math.max(2, Math.round(size / 10))}px`,
    '--amp': amp.toFixed(3),
  } as CSSProperties
  return (
    <span className={'orb st-' + state + (className ? ' ' + className : '')} style={style} role="img" aria-label="AI アシスタント">
      <span className="orb-glow" aria-hidden="true" />
      <span className="orb-core" aria-hidden="true">
        <i className="l1" /><i className="l2" /><i className="l3" /><i className="l4" /><i className="l5" /><i className="l6" />
        <span className="orb-dots" />
        <span className="orb-shine" />
      </span>
    </span>
  )
}
