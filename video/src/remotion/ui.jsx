import React from 'react'
import { AbsoluteFill, interpolate, interpolateColors, spring, useCurrentFrame, useVideoConfig, random } from 'remotion'

export const ThemeContext = React.createContext(null)
export const useTheme = () => React.useContext(ThemeContext)

/** 0→1 entrance, bouncier for the prep theme. */
export function usePop(delay = 0) {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const t = useTheme()
  return spring({ frame: frame - delay, fps, config: t.bouncy ? { damping: 9, stiffness: 120 } : { damping: 18, stiffness: 90 } })
}

/** Fades the whole scene out over its last frames so cuts never feel abrupt. */
export function SceneFrame({ children, duration, padding = 90 }) {
  const frame = useCurrentFrame()
  const out = interpolate(frame, [duration - 10, duration], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
  const inn = interpolate(frame, [0, 8], [0, 1], { extrapolateRight: 'clamp' })
  return (
    <AbsoluteFill style={{ opacity: Math.min(out, inn), padding, justifyContent: 'center', alignItems: 'center', gap: 46 }}>
      {children}
    </AbsoluteFill>
  )
}

export function Kicker({ children, delay = 0 }) {
  const t = useTheme()
  const p = usePop(delay)
  return (
    <div style={{
      background: t.kickerBg, color: t.kickerInk, fontFamily: t.font, fontWeight: 700,
      fontSize: 38, letterSpacing: 4, padding: '14px 34px', borderRadius: 999,
      transform: `translateY(${(1 - p) * -40}px)`, opacity: p, textAlign: 'center',
    }}>{children}</div>
  )
}

/** Line of text revealed word by word. */
export function Words({ text, delay = 0, size = 64, color, weight = 600, perWord = 3, align = 'center', italic = false }) {
  const frame = useCurrentFrame()
  const t = useTheme()
  const words = String(text || '').split(/\s+/).filter(Boolean)
  return (
    <div style={{ fontFamily: t.font, fontSize: size, fontWeight: weight, color: color || t.ink, textAlign: align, lineHeight: 1.25, fontStyle: italic ? 'italic' : 'normal', maxWidth: 900 }}>
      {words.map((w, i) => {
        const o = interpolate(frame - delay - i * perWord, [0, 8], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
        return <span key={i} style={{ opacity: o, display: 'inline-block', transform: `translateY(${(1 - o) * 18}px)`, marginRight: '0.28em' }}>{w}</span>
      })}
    </div>
  )
}

/** The answer itself: emoji (if any) over the text, on a card. */
export function AnswerCard({ answer, delay = 0, scale = 1, dim = 0, highlight = false, compact = false }) {
  const t = useTheme()
  const p = usePop(delay)
  if (!answer) return null
  const long = (answer.text || '').length > 34
  return (
    <div style={{
      background: highlight ? t.accent : t.card,
      border: t.cardBorder ? `3px solid ${highlight ? t.accent : t.cardBorder}` : 'none',
      boxShadow: t.bouncy ? '0 18px 0 rgba(31,27,77,0.12)' : '0 30px 80px rgba(0,0,0,0.35)',
      borderRadius: compact ? 36 : 56, padding: compact ? '30px 44px' : '54px 64px',
      minWidth: compact ? 0 : 620, maxWidth: 900,
      transform: `scale(${(0.6 + 0.4 * p) * scale}) rotate(${t.bouncy ? (1 - p) * -8 : 0}deg)`,
      opacity: p * (1 - dim * 0.55), display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 18,
    }}>
      {answer.emoji ? <div style={{ fontSize: compact ? 90 : 170, lineHeight: 1 }}>{answer.emoji}</div> : null}
      <div style={{
        fontFamily: t.font, fontWeight: 800, textAlign: 'center', lineHeight: 1.15,
        fontSize: compact ? (long ? 42 : 52) : long ? 60 : 84,
        color: highlight ? (t.bouncy ? '#FFFFFF' : '#1E1A5C') : t.ink,
      }}>{answer.text}</div>
    </div>
  )
}

/** `phase` is a float scene index; colours glide between scenes instead of cutting. */
export function Background({ phase = 0 }) {
  const t = useTheme()
  const frame = useCurrentFrame()
  const { width, height } = useVideoConfig()
  const n = t.bg.length
  const stops = Array.from({ length: n + 1 }, (_, i) => i)
  const ring = [...t.bg, t.bg[0]]
  const p = phase % n
  const c1 = interpolateColors(p, stops, ring)
  const c2 = interpolateColors((p + 1) % n, stops, ring)
  const shapes = Array.from({ length: t.bouncy ? 14 : 60 }, (_, i) => i)
  return (
    <AbsoluteFill style={{ background: `linear-gradient(160deg, ${c1} 0%, ${c2} 100%)`, overflow: 'hidden' }}>
      {shapes.map((i) => {
        const x = random(`x${i}`) * width
        const y0 = random(`y${i}`) * height
        const speed = 0.3 + random(`s${i}`) * 0.9
        const y = ((y0 - frame * speed) % (height + 200) + height + 200) % (height + 200) - 100
        if (t.bouncy) {
          const size = 50 + random(`r${i}`) * 140
          const color = t.blobs[i % t.blobs.length]
          const round = i % 3 === 0 ? '30%' : '50%'
          return <div key={i} style={{ position: 'absolute', left: x, top: y, width: size, height: size, borderRadius: round, background: color, opacity: 0.35, transform: `rotate(${frame * speed}deg)` }} />
        }
        const size = 2 + random(`r${i}`) * 5
        const tw = 0.3 + 0.7 * Math.abs(Math.sin(frame / 20 + i))
        return <div key={i} style={{ position: 'absolute', left: x, top: (y0 + frame * 0.1) % height, width: size, height: size, borderRadius: '50%', background: '#fff', opacity: tw * 0.8 }} />
      })}
      {!t.bouncy && (
        <div style={{ position: 'absolute', width: 1100, height: 1100, borderRadius: '50%', left: -300 + Math.sin(frame / 90) * 120, top: 900, background: 'radial-gradient(circle, rgba(109,93,252,0.45), transparent 65%)' }} />
      )}
    </AbsoluteFill>
  )
}

export function Confetti({ start = 0, count = 70 }) {
  const frame = useCurrentFrame() - start
  const t = useTheme()
  const { width, height } = useVideoConfig()
  if (frame < 0) return null
  const colors = [...t.blobs, t.accent, t.accent2]
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      {Array.from({ length: count }, (_, i) => {
        const vx = (random(`cx${i}`) - 0.5) * 34
        const vy = -25 - random(`cy${i}`) * 30
        const x = width / 2 + vx * frame
        const y = height * 0.8 + vy * frame + 0.9 * frame * frame
        if (y > height + 50) return null
        return <div key={i} style={{ position: 'absolute', left: x, top: y, width: 22, height: 12, background: colors[i % colors.length], transform: `rotate(${frame * (8 + i)}deg)`, borderRadius: 3 }} />
      })}
    </AbsoluteFill>
  )
}
