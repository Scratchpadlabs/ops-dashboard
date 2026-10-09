/**
 * Storyline → MP4 + JPEG thumbnail on local disk, via Remotion.
 *
 * The Remotion bundle is built once: at image build time in the Dockerfile
 * (BUNDLE_DIR), or lazily on first render when running from a checkout.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderMedia, renderStill, selectComposition } from '@remotion/renderer'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let serveUrlPromise = null

export async function bundleTemplates(outDir) {
  const { bundle } = await import('@remotion/bundler')
  return bundle({ entryPoint: path.join(ROOT, 'src/remotion/index.jsx'), publicDir: path.join(ROOT, 'public'), outDir })
}

function serveUrl() {
  const prebuilt = process.env.BUNDLE_DIR
  if (prebuilt && existsSync(path.join(prebuilt, 'index.html'))) return Promise.resolve(prebuilt)
  serveUrlPromise ||= bundleTemplates()
  return serveUrlPromise
}

export async function renderStoryline(storyline, onProgress = () => {}) {
  const url = await serveUrl()
  const browserExecutable = process.env.REMOTION_BROWSER || null
  const inputProps = { storyline }
  const composition = await selectComposition({ serveUrl: url, id: 'YearWrap', inputProps, browserExecutable })
  const dir = mkdtempSync(path.join(os.tmpdir(), 'yearwrap-'))
  const video = path.join(dir, 'video.mp4')
  const thumb = path.join(dir, 'thumb.jpg')
  try {
    await renderMedia({
      composition, serveUrl: url, inputProps, browserExecutable,
      codec: 'h264', crf: 20, audioBitrate: '160k', outputLocation: video,
      onProgress: ({ progress }) => onProgress(progress),
    })
    // Frame 75 is the intro's title card: the child's name, fully on screen.
    await renderStill({ composition, serveUrl: url, inputProps, browserExecutable, frame: 75, output: thumb, imageFormat: 'jpeg', jpegQuality: 85 })
    return { video, thumb, dir }
  } catch (e) {
    rmSync(dir, { recursive: true, force: true })
    throw e
  }
}
