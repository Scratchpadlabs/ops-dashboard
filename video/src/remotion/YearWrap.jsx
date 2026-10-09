import React from 'react'
import { AbsoluteFill, Audio, Series, continueRender, delayRender, interpolate, staticFile, useCurrentFrame } from 'remotion'
import '@fontsource/baloo-2/600.css'
import '@fontsource/baloo-2/700.css'
import '@fontsource/baloo-2/800.css'
import '@fontsource/poppins/600.css'
import '@fontsource/poppins/700.css'
import '@fontsource/poppins/800.css'
import { THEMES } from './theme.js'
import { Background, ThemeContext } from './ui.jsx'
import { SCENES } from './scenes.jsx'

// Fonts load lazily; hold the first frame until they're in, or the opening
// seconds render in a fallback font.
function useFontsReady(family) {
  const [handle] = React.useState(() => delayRender(`fonts: ${family}`))
  React.useEffect(() => {
    Promise.all([600, 700, 800].map((w) => document.fonts.load(`${w} 40px "${family}"`)))
      .catch(() => {})
      .finally(() => continueRender(handle))
  }, [family, handle])
}

export function YearWrap({ storyline }) {
  const theme = THEMES[storyline.segment] || THEMES.mid
  useFontsReady(theme.font.match(/"([^"]+)"/)[1])
  const frame = useCurrentFrame()
  const total = storyline.durationInFrames

  // Float scene index for the background: glides into the next scene's
  // colours across each cut.
  let acc = 0
  let phase = 0
  storyline.scenes.forEach((s, i) => {
    if (frame >= acc) phase = i + interpolate(frame, [acc + s.durationInFrames - 12, acc + s.durationInFrames + 12], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
    acc += s.durationInFrames
  })

  const firstName = storyline.scenes[0]?.name || ''
  return (
    <ThemeContext.Provider value={theme}>
      <AbsoluteFill>
        <Background phase={phase} />
        <Series>
          {storyline.scenes.map((scene, i) => {
            const Scene = SCENES[scene.type]
            if (!Scene) return null
            return (
              <Series.Sequence key={i} durationInFrames={scene.durationInFrames}>
                <Scene scene={scene} name={firstName} />
              </Series.Sequence>
            )
          })}
        </Series>
        <Audio
          src={staticFile(theme.music)}
          volume={(f) => interpolate(f, [0, 15, total - 60, total], [0, 0.85, 0.85, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })}
        />
      </AbsoluteFill>
    </ThemeContext.Provider>
  )
}
