/**
 * The page a parent opens from a year-wrap share link: /w/<linkId>.
 *
 * Deliberately separate from the dashboard (its own entry, wrap.html): no
 * Vue, no Firebase, no login — just React, the Remotion Player and the same
 * template the dashboard previews. It fetches the child's storyline from the
 * render service's public /w/<linkId> route and plays it in the browser, so
 * no video file is ever rendered or stored.
 */
import React from 'react'
import { createRoot } from 'react-dom/client'
import { Player } from '@remotion/player'
import { YearWrap } from '../../video/src/remotion/YearWrap.jsx'
import prepMusic from '../../video/public/music/sunny-steps.mp3?url'
import midMusic from '../../video/public/music/big-sky.mp3?url'

const SERVICE = String(import.meta.env.VITE_YEAR_WRAP_URL || '').replace(/\/+$/, '')
const linkId = (location.pathname.match(/\/w\/([A-Za-z0-9_-]+)/) || [])[1] || ''
const h = React.createElement

function App() {
  const [state, setState] = React.useState({ loading: true })
  const [started, setStarted] = React.useState(false)
  const player = React.useRef(null)

  React.useEffect(() => {
    if (!linkId || !SERVICE) { setState({ error: 'This link is incomplete.' }); return }
    fetch(`${SERVICE}/w/${linkId}`)
      .then(async (r) => {
        const body = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(body.error || 'This video could not be loaded.')
        const first = body.storyline.scenes?.[0]?.name || ''
        if (first) document.title = `${first}'s Year in Review`
        setState({ storyline: body.storyline })
      })
      .catch((e) => setState({ error: e.message || 'This video could not be loaded.' }))
  }, [])

  if (state.loading) return h(Centered, null, h('div', { className: 'spinner', style: spinner }), h('p', { style: muted }, 'Loading your video…'))
  if (state.error) return h(Centered, null, h('div', { style: { fontSize: 56 } }, '🎬'), h('p', { style: { fontSize: 18, maxWidth: 320, textAlign: 'center' } }, state.error))

  const s = state.storyline
  // The poster is the intro's title card (the child's name); playing starts from the top.
  const play = () => { setStarted(true); player.current?.seekTo(0); player.current?.play() }
  const share = async () => {
    const url = location.href
    if (navigator.share) { try { await navigator.share({ title: document.title, url }) } catch {} return }
    window.open(`https://wa.me/?text=${encodeURIComponent(`${document.title} 🎉 ${url}`)}`, '_blank')
  }

  return h('div', { style: page },
    h('div', { style: frame },
      h(Player, {
        ref: player,
        component: YearWrap,
        inputProps: { storyline: s, musicSrc: { prep: prepMusic, mid: midMusic } },
        durationInFrames: Math.max(1, s.durationInFrames),
        compositionWidth: 1080, compositionHeight: 1920, fps: s.fps || 30,
        initialFrame: Math.min(75, s.durationInFrames - 1),
        controls: started, clickToPlay: true, spaceKeyToPlayOrPause: true,
        style: { width: '100%', height: '100%' },
      }),
      // Phones won't autoplay with sound, so the first tap starts it.
      !started && h('button', { onClick: play, style: playOverlay, 'aria-label': 'Play' },
        h('span', { style: playCircle }, '▶'),
        h('span', { style: { fontSize: 18, fontWeight: 600 } }, 'Tap to play'),
      ),
    ),
    h('div', { style: bar },
      h('span', { style: { ...muted, flex: 1 } }, s.school?.name || ''),
      h('button', { onClick: share, style: shareBtn }, 'Share'),
    ),
  )
}

const Centered = ({ children }) => h('div', { style: { minHeight: '100dvh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 } }, children)

// The video fills the screen height on a phone and stays 9:16 on a laptop.
const page = { minHeight: '100dvh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, padding: '8px 0' }
const frame = { position: 'relative', width: 'min(100vw, calc((100dvh - 64px) * 9 / 16))', aspectRatio: '9 / 16', borderRadius: 16, overflow: 'hidden', background: '#000' }
const playOverlay = { position: 'absolute', inset: 0, border: 0, background: 'linear-gradient(to top, rgba(10,8,30,0.55), rgba(10,8,30,0) 55%)', justifyContent: 'flex-end', paddingBottom: '18%', color: '#fff', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, cursor: 'pointer', font: 'inherit' }
const playCircle = { width: 88, height: 88, borderRadius: '50%', background: '#FBBF24', color: '#1E1A5C', fontSize: 36, display: 'flex', alignItems: 'center', justifyContent: 'center', paddingLeft: 6, boxShadow: '0 10px 30px rgba(0,0,0,0.35)' }
const bar = { width: 'min(100vw, calc((100dvh - 64px) * 9 / 16))', display: 'flex', alignItems: 'center', gap: 12, padding: '0 12px', boxSizing: 'border-box' }
const shareBtn = { background: '#25D366', color: '#fff', border: 0, borderRadius: 999, padding: '10px 22px', fontSize: 16, fontWeight: 700, cursor: 'pointer' }
const muted = { color: '#C7C2F5', fontSize: 14 }
const spinner = { width: 36, height: 36, border: '4px solid rgba(255,255,255,0.2)', borderTopColor: '#FBBF24', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }

const style = document.createElement('style')
style.textContent = '@keyframes spin { to { transform: rotate(360deg) } }'
document.head.appendChild(style)

createRoot(document.getElementById('root')).render(h(App))
