// Pre-builds the Remotion bundle into BUNDLE_DIR (Dockerfile build step), so
// a fresh container renders immediately instead of bundling on first request.
import { bundleTemplates } from './render.mjs'

const dir = process.env.BUNDLE_DIR || 'build'
await bundleTemplates(dir)
console.log(`bundled templates → ${dir}`)
