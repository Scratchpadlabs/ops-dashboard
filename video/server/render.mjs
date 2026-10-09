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

// Output settings, measured on 4 vCPU with a 65 s video:
//   1080p, crf 20, default preset/concurrency   96 s   12.5 MB
//   720p,  crf 23, veryfast, all cores           40 s    5.5 MB
// The template is still laid out at 1080×1920 and scaled on output, so it
// looks the same; on a phone screen 720p is indistinguishable, and the
// smaller file is quicker to share on WhatsApp.
export const OUTPUT = {
  codec: 'h264', scale: 2 / 3, crf: 23, x264Preset: 'veryfast', audioBitrate: '128k',
  concurrency: Math.max(1, os.cpus().length),
}

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
      ...OUTPUT, outputLocation: video,
      onProgress: ({ progress }) => onProgress(progress),
    })
    // Frame 75 is the intro's title card: the child's name, fully on screen.
    await renderStill({ composition, serveUrl: url, inputProps, browserExecutable, frame: 75, output: thumb, imageFormat: 'jpeg', jpegQuality: 85, scale: OUTPUT.scale })
    return { video, thumb, dir }
  } catch (e) {
    rmSync(dir, { recursive: true, force: true })
    throw e
  }
}
