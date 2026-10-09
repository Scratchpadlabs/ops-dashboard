/**
 * School logo for the pamphlet band.
 *
 * A logo comes from the teacher-app school record (logoUrl) or is uploaded on
 * the Pamphlets tab. Either way it is normalised in the browser before use:
 * any format the browser can show (PNG, JPG, SVG, WebP…) is redrawn to PNG,
 * the blank margin around the artwork is trimmed so the band sizes the logo
 * itself and not its padding, and very large images are scaled down.
 *
 * Saving uploaded logos lives in pamphletLogoStore.js, so these helpers stay
 * free of Firebase and testable in node.
 */

export const LOGO_MAX_SIDE = 800       // px; plenty for a ~1.5 cm print
export const LOGO_MIN_SIDE = 300       // px; below this, warn it may print soft
const MAX_STORED_BYTES = 700 * 1024    // Firestore docs cap at 1 MiB

/**
 * Bounding box of the artwork in RGBA pixel data: pixels that are neither
 * transparent nor near-white. null if the image is blank.
 */
export function contentBounds(data, width, height, { alphaMin = 8, white = 245 } = {}) {
  let x0 = width, y0 = height, x1 = -1, y1 = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      if (data[i + 3] <= alphaMin) continue
      if (data[i] >= white && data[i + 1] >= white && data[i + 2] >= white) continue
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 }
}

/** Scale (never up) so the longer side is at most max. */
export function fitWithin(width, height, max = LOGO_MAX_SIDE) {
  const k = Math.min(1, max / Math.max(width, height))
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) }
}

export function bytesToBase64(bytes) {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

export function base64ToBytes(b64) {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

async function decode(blob) {
  const url = URL.createObjectURL(blob)
  try {
    const img = new Image()
    img.decoding = 'async'
    img.src = url
    await img.decode()
    // An SVG without width/height reports 0 × 0 (or 300 × 150): draw it big.
    let w = img.naturalWidth, h = img.naturalHeight
    if (!w || !h) { w = LOGO_MAX_SIDE; h = LOGO_MAX_SIDE }
    if (/svg/i.test(blob.type) && Math.max(w, h) < LOGO_MAX_SIDE) {
      const k = LOGO_MAX_SIDE / Math.max(w, h)
      w = Math.round(w * k); h = Math.round(h * k)
    }
    return { img, w, h }
  } catch {
    throw new Error('That file is not an image the browser can read. Use PNG, JPG or SVG.')
  } finally {
    URL.revokeObjectURL(url)
  }
}

const canvasBlob = (canvas, type, quality) =>
  new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Could not encode the logo'))), type, quality))

/**
 * Any image Blob → { bytes, type: 'png'|'jpg', width, height, sourceWidth, sourceHeight }.
 * width/height are of the trimmed artwork as stored.
 */
export async function normalizeLogo(blob) {
  const { img, w, h } = await decode(blob)
  const full = document.createElement('canvas')
  full.width = w
  full.height = h
  const ctx = full.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(img, 0, 0, w, h)
  const box = contentBounds(ctx.getImageData(0, 0, w, h).data, w, h)
  if (!box) throw new Error('The logo looks blank (all white or transparent).')

  const pad = Math.round(Math.max(box.width, box.height) * 0.01)
  const cx = Math.max(0, box.x - pad), cy = Math.max(0, box.y - pad)
  const cw = Math.min(w - cx, box.width + 2 * pad), ch = Math.min(h - cy, box.height + 2 * pad)
  const size = fitWithin(cw, ch)
  const out = document.createElement('canvas')
  out.width = size.width
  out.height = size.height
  const octx = out.getContext('2d')
  octx.imageSmoothingQuality = 'high'
  octx.drawImage(full, cx, cy, cw, ch, 0, 0, size.width, size.height)

  let type = 'png'
  let encoded = await canvasBlob(out, 'image/png')
  if (encoded.size > MAX_STORED_BYTES) {
    // A photo-like logo: flatten on white (the band is white) and use JPEG.
    const flat = document.createElement('canvas')
    flat.width = size.width
    flat.height = size.height
    const fctx = flat.getContext('2d')
    fctx.fillStyle = '#fff'
    fctx.fillRect(0, 0, size.width, size.height)
    fctx.drawImage(out, 0, 0)
    type = 'jpg'
    encoded = await canvasBlob(flat, 'image/jpeg', 0.9)
  }
  return {
    bytes: new Uint8Array(await encoded.arrayBuffer()),
    type,
    width: size.width,
    height: size.height,
    // Resolution of the artwork in the original file, for the "may print soft" check.
    sourceWidth: Math.round(box.width),
    sourceHeight: Math.round(box.height),
  }
}

/** Fetch a logo by URL (the teacher-app logoUrl) and normalise it. */
export async function logoFromUrl(url) {
  let res
  try {
    res = await fetch(url, { mode: 'cors' })
  } catch {
    throw new Error('The logo host does not allow the dashboard to read it — upload the logo instead.')
  }
  if (!res.ok) throw new Error(`Could not load the logo (${res.status}).`)
  return normalizeLogo(await res.blob())
}

export function logoDataUrl(logo) {
  return logo ? `data:image/${logo.type === 'jpg' ? 'jpeg' : 'png'};base64,${bytesToBase64(logo.bytes)}` : ''
}
