/**
 * Renders the fictional sample students to out/<name>.mp4, plus each
 * storyline as JSON (the exact input the renderer used — what the review
 * screen will show and edit).
 *
 *   npm run render:samples              # all samples
 *   npm run render:samples -- aarav     # one
 *
 * REMOTION_BROWSER overrides the Chromium used (defaults to Remotion's own
 * download; this repo's cloud sandbox points it at /opt/pw-browsers).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { bundle } from '@remotion/bundler'
import { renderMedia, renderStill, selectComposition } from '@remotion/renderer'
import { buildStoryline } from '../src/storyline/buildStoryline.mjs'
import { OUTPUT } from '../server/render.mjs'
import { SAMPLES } from '../fixtures/sample-students.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(root, 'out')
mkdirSync(outDir, { recursive: true })

const only = process.argv.slice(2)
const names = only.length ? only : Object.keys(SAMPLES)
const browserExecutable = process.env.REMOTION_BROWSER || null

// The studio's default props: the middle-school sample.
writeFileSync(path.join(root, 'src/remotion/default-storyline.json'),
  JSON.stringify(buildStoryline(SAMPLES.ananya), null, 2) + '\n')

console.log('bundling…')
const serveUrl = await bundle({ entryPoint: path.join(root, 'src/remotion/index.jsx'), publicDir: path.join(root, 'public') })

for (const name of names) {
  const storyline = buildStoryline(SAMPLES[name])
  writeFileSync(path.join(outDir, `${name}.storyline.json`), JSON.stringify(storyline, null, 2))
  if (!storyline.renderable) { console.log(`${name}: not renderable — ${storyline.reason}`); continue }
  if (storyline.warnings.length) console.log(`${name} warnings:\n  - ${storyline.warnings.join('\n  - ')}`)
  const inputProps = { storyline }
  const composition = await selectComposition({ serveUrl, id: 'YearWrap', inputProps, browserExecutable })
  const t0 = Date.now()
  await renderMedia({
    composition, serveUrl, inputProps, browserExecutable,
    ...OUTPUT,
    outputLocation: path.join(outDir, `${name}.mp4`),
    onProgress: ({ progress }) => process.stdout.write(`\r${name}: ${Math.round(progress * 100)}%   `),
  })
  console.log(`\r${name}: done in ${Math.round((Date.now() - t0) / 1000)}s → out/${name}.mp4 (${(storyline.durationInFrames / 30).toFixed(1)}s)`)

  // Thumbnail = intro title card, for the dashboard list / WhatsApp preview.
  await renderStill({ composition, serveUrl, inputProps, browserExecutable, frame: 75, output: path.join(outDir, `${name}.jpg`), imageFormat: 'jpeg', scale: OUTPUT.scale })
}
