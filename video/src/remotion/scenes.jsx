import React from 'react'
import { interpolate, useCurrentFrame } from 'remotion'
import { AnswerCard, Confetti, Kicker, SceneFrame, Words, usePop, useTheme } from './ui.jsx'

const Label = ({ children, delay = 0, color }) => {
  const t = useTheme()
  const p = usePop(delay)
  return <div style={{ fontFamily: t.font, fontWeight: 700, fontSize: 34, letterSpacing: 5, color: color || t.soft, opacity: p }}>{children}</div>
}

export function Intro({ scene }) {
  const t = useTheme()
  const frame = useCurrentFrame()
  const name = usePop(18)
  const title = usePop(34)
  return (
    <SceneFrame duration={scene.durationInFrames}>
      {scene.schoolName ? <Words text={`${scene.schoolName} presents`} size={42} color={t.soft} weight={600} /> : null}
      <div style={{ fontFamily: t.font, fontWeight: 800, fontSize: 150, color: t.accent, transform: `scale(${name})`, lineHeight: 1, textAlign: 'center' }}>
        {scene.name}’s
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', columnGap: 30, maxWidth: 940 }}>
        {/* letters animate individually, but wrap only between words */}
        {scene.title.split(' ').map((word, wi, words) => {
          const offset = words.slice(0, wi).join(' ').length + (wi ? 1 : 0)
          return (
            <span key={wi} style={{ display: 'inline-flex', whiteSpace: 'nowrap' }}>
              {word.split('').map((ch, ci) => {
                const i = offset + ci
                const y = t.bouncy ? Math.sin((frame - i * 3) / 6) * 10 * title : 0
                return <span key={ci} style={{ fontFamily: t.font, fontWeight: 800, fontSize: t.bouncy ? 110 : 96, color: t.ink, opacity: title, transform: `translateY(${y + (1 - title) * 60}px)`, display: 'inline-block' }}>{ch}</span>
              })}
            </span>
          )
        })}
      </div>
      <Words text={[scene.classLabel, scene.academicYear].filter(Boolean).join('  ·  ')} delay={50} size={44} color={t.soft} />
      <Confetti start={30} />
    </SceneFrame>
  )
}

/** The core of the brief: what you said at the start vs what you said at the end. */
export function Evolution({ scene }) {
  const t = useTheme()
  const frame = useCurrentFrame()
  const d = scene.durationInFrames
  const turn = Math.round(d * 0.45)
  const changed = scene.mode === 'changed'
  const shrink = interpolate(frame, [turn, turn + 15], [1, changed ? 0.88 : 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
  const arrow = interpolate(frame, [turn + 6, turn + 22], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
  const stamp = usePop(turn + 10)
  return (
    <SceneFrame duration={d} padding={70}>
      <Kicker>{scene.kicker}</Kicker>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 26 }}>
        <Label delay={6}>START OF THE YEAR</Label>
        <Words text={scene.startLine} delay={8} size={56} />
        <AnswerCard answer={scene.start} delay={24} scale={shrink} compact={changed && frame > turn} dim={changed ? (1 - shrink) * 3 : 0} />
      </div>
      {changed ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 26 }}>
          <div style={{ fontSize: 90, color: t.accent, opacity: arrow, transform: `translateY(${(1 - arrow) * -30}px)` }}>↓</div>
          <Label delay={turn + 8} color={t.accent}>END OF THE YEAR</Label>
          <Words text={scene.endLine} delay={turn + 10} size={56} />
          <AnswerCard answer={scene.end} delay={turn + 28} highlight />
        </div>
      ) : frame > turn ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 26 }}>
          <div style={{ fontFamily: t.font, fontWeight: 800, fontSize: 48, color: t.bouncy ? '#fff' : '#1E1A5C', background: t.accent2, padding: '12px 36px', borderRadius: 20, transform: `rotate(-6deg) scale(${stamp})` }}>
            STILL YOUR №1 ♥
          </div>
          <Words text={scene.endLine} delay={turn + 12} size={54} />
        </div>
      ) : null}
      {changed ? <Confetti start={turn + 30} count={40} /> : null}
    </SceneFrame>
  )
}

export function Single({ scene }) {
  return (
    <SceneFrame duration={scene.durationInFrames}>
      <Kicker>{scene.kicker}</Kicker>
      <Words text={scene.line} delay={8} size={62} />
      <AnswerCard answer={scene.answer} delay={26} highlight />
    </SceneFrame>
  )
}

export function List({ scene }) {
  const t = useTheme()
  return (
    <SceneFrame duration={scene.durationInFrames} padding={80}>
      <Kicker>{scene.kicker}</Kicker>
      <Words text={scene.title} delay={6} size={58} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 26, width: '100%' }}>
        {scene.items.map((it, i) => <ListRow key={i} item={it} delay={26 + i * 14} n={i} />)}
      </div>
    </SceneFrame>
  )
}

function ListRow({ item, delay, n }) {
  const t = useTheme()
  const p = usePop(delay)
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 28, background: t.card, border: t.cardBorder ? `2px solid ${t.cardBorder}` : 'none', borderRadius: 30, padding: '26px 34px', opacity: p, transform: `translateX(${(1 - p) * (n % 2 ? 300 : -300)}px)`, boxShadow: t.bouncy ? '0 10px 0 rgba(31,27,77,0.10)' : 'none' }}>
      <div style={{ flex: '0 0 66px', height: 66, borderRadius: '50%', background: n % 2 ? t.accent2 : t.accent, color: '#fff', fontSize: 40, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: t.font, fontWeight: 800 }}>✓</div>
      <div style={{ fontFamily: t.font, fontWeight: 600, fontSize: 44, color: t.ink, lineHeight: 1.2 }}>{item.text} {item.emoji}</div>
    </div>
  )
}

export function Goal({ scene }) {
  const t = useTheme()
  return (
    <SceneFrame duration={scene.durationInFrames} padding={80}>
      <Kicker>{scene.kicker}</Kicker>
      {scene.was ? <Words text={`You started the year aiming to ${lowerFirst(scene.was.text)}… and set an even newer goal:`} delay={6} size={40} color={t.soft} /> : null}
      <AnswerCard answer={scene.goal} delay={scene.was ? 30 : 12} highlight />
      {scene.why ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
          <Label delay={60} color={t.accent}>WHY IT MATTERS</Label>
          <Words text={scene.why.text} delay={64} size={46} italic />
        </div>
      ) : null}
      {scene.steps.length ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18, width: '100%' }}>
          <div style={{ alignSelf: 'center' }}><Label delay={110} color={t.accent}>YOUR STEPS</Label></div>
          {scene.steps.map((s, i) => <ListRow key={i} item={s} delay={116 + i * 14} n={i} />)}
        </div>
      ) : null}
    </SceneFrame>
  )
}

export function Pair({ scene }) {
  return (
    <SceneFrame duration={scene.durationInFrames}>
      <Kicker>{scene.kicker}</Kicker>
      {scene.items.map((it, i) => (
        <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 24 }}>
          <Words text={it.label} delay={10 + i * 70} size={54} />
          <AnswerCard answer={it.answer} delay={26 + i * 70} highlight={i === 0} compact />
        </div>
      ))}
    </SceneFrame>
  )
}

export function Favourites({ scene }) {
  const t = useTheme()
  const frame = useCurrentFrame()
  return (
    <SceneFrame duration={scene.durationInFrames} padding={70}>
      <Kicker>{scene.kicker}</Kicker>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 34, width: '100%' }}>
        {scene.items.map((f, i) => {
          const delay = 14 + i * 40
          const flip = f.was ? interpolate(frame, [delay + 26, delay + 36], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }) : 1
          const shown = flip < 0.5 && f.was ? f.was : f.answer
          return (
            <FavTile key={i} delay={delay} label={f.label} fallbackEmoji={FAV_EMOJI[f.role]} answer={shown} flip={flip} wasText={f.was && flip >= 0.5 ? `${f.was.emoji} ${f.was.text}` : null} />
          )
        })}
      </div>
    </SceneFrame>
  )
}

const FAV_EMOJI = { food: '🍽️', sport: '🏅', festival: '🎉' }

function FavTile({ delay, label, answer, flip, wasText, fallbackEmoji }) {
  const t = useTheme()
  const p = usePop(delay)
  const squash = Math.abs(Math.cos(flip * Math.PI))
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 34, background: t.card, borderRadius: 40, padding: '30px 40px', opacity: p, transform: `scale(${0.7 + 0.3 * p})`, boxShadow: '0 12px 0 rgba(31,27,77,0.10)' }}>
      <div style={{ fontSize: 120, transform: `scaleY(${Math.max(squash, 0.05)})`, width: 150, textAlign: 'center' }}>{answer.emoji || fallbackEmoji || '⭐'}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ fontFamily: t.font, fontSize: 34, fontWeight: 700, letterSpacing: 3, color: t.soft }}>{label.toUpperCase()}</div>
        <div style={{ fontFamily: t.font, fontSize: 66, fontWeight: 800, color: t.ink, lineHeight: 1.05, transform: `scaleY(${Math.max(squash, 0.05)})` }}>{answer.text}</div>
        {wasText ? <div style={{ fontFamily: t.font, fontSize: 32, fontWeight: 600, color: t.accent }}>used to be {wasText.trim()}</div> : null}
      </div>
    </div>
  )
}

export function Quote({ scene, name }) {
  const t = useTheme()
  return (
    <SceneFrame duration={scene.durationInFrames}>
      <Kicker>{scene.kicker}</Kicker>
      <Words text={scene.line} delay={6} size={50} color={t.soft} />
      <div style={{ fontFamily: 'Georgia, serif', fontSize: 220, lineHeight: 0.6, color: t.accent, opacity: usePop(16), height: 90 }}>“</div>
      <Words text={scene.quote} delay={22} size={66} weight={700} perWord={4} />
      <Words text={`— ${name}`} delay={22 + scene.quote.split(' ').length * 4 + 6} size={44} color={t.accent} />
    </SceneFrame>
  )
}

export function FunFact({ scene }) {
  const frame = useCurrentFrame()
  const wobble = Math.sin(frame / 4) * 4
  return (
    <SceneFrame duration={scene.durationInFrames}>
      <Kicker>{scene.kicker}</Kicker>
      <Words text={scene.line} delay={6} size={60} />
      <div style={{ transform: `rotate(${wobble}deg)` }}>
        <AnswerCard answer={{ ...scene.answer, emoji: scene.answer.emoji || '😜' }} delay={24} highlight />
      </div>
    </SceneFrame>
  )
}

export function Outro({ scene }) {
  const t = useTheme()
  const frame = useCurrentFrame()
  const big = usePop(6)
  const rocketY = Math.sin(frame / 8) * 14 // bobs in place; travelling up it ran over the text above
  return (
    <SceneFrame duration={scene.durationInFrames}>
      <div style={{ fontFamily: t.font, fontWeight: 800, fontSize: 120, color: t.accent, transform: `scale(${big})`, textAlign: 'center', lineHeight: 1.05 }}>
        Way to go,<br />{scene.name}!
      </div>
      <Words text={scene.line} delay={22} size={54} />
      <div style={{ fontSize: 150, transform: `translateY(${rocketY}px) rotate(-20deg)`, opacity: usePop(44) }}>🚀</div>
      <Words text={scene.next} delay={50} size={70} weight={800} color={t.accent2} />
      {scene.schoolName ? <Words text={scene.schoolName} delay={70} size={38} color={t.soft} /> : null}
      <Confetti start={8} count={90} />
    </SceneFrame>
  )
}

const lowerFirst = (s) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s)

export const SCENES = {
  intro: Intro, evolution: Evolution, single: Single, list: List, goal: Goal,
  pair: Pair, favourites: Favourites, quote: Quote, funFact: FunFact, outro: Outro,
}
