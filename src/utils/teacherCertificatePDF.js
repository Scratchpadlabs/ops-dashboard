/**
 * Teacher certificates — "Certificate of Completion, Holistic Progress Card
 * Workshop", one A4 landscape page per teacher.
 *
 * The artwork is public/certificates/teacher.png: the Canva design with no
 * name, school or year (tools/build_teacher_certificate_template.py). On top
 * of it this prints, in the design's own fonts:
 *
 *   - the teacher's name on the rule, Cinzel Decorative, upper case; long
 *     names shrink to fit the rule, very long ones go on two lines
 *   - "as part of <School>, during the academic year <Year>" under the fixed
 *     body text, Raleway with the school in bold, wrapped like the sample
 *
 * The background image is embedded once and drawn on every page.
 *
 * Positions are in pixels of the 2000 x 1414 Canva export (y down), measured
 * from the samples; toPdf() maps them onto the A4 page.
 */
import { PDFDocument, rgb } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'

const PX_W = 2000
const PX_H = 1414
const PAGE_W = 841.89            // A4 landscape, points
const PAGE_H = 595.28
const K = PAGE_W / PX_W          // points per template pixel

export const LAYOUT = {
  name: {
    x: 727, baseline: 692,       // sits on the rule at y 707
    size: 100,                   // as in the sample (SUBHASH KOLI)
    maxWidth: 1028,              // the rule: x 727 – 1755
    oneLineMin: 58,              // below this a name reads better on two lines
    twoLineMax: 54, min: 38,
    lineGap: 1.22,               // two lines: room for Cinzel's swash tails
    color: [26 / 255, 48 / 255, 80 / 255],
  },
  body: {
    x: 728, baseline: 892,       // third body line; first two are in the artwork
    size: 26.8, lineHeight: 35.5,
    maxWidth: 935,               // as wide as the longest fixed line
    color: [0, 0, 0],
  },
}

const toRgb = (c) => rgb(c[0], c[1], c[2])
const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim()

/**
 * The name as it goes on the certificate. School rosters often store staff
 * as "Vinaya Teacher" or "Teacher - Vinaya"; the word "teacher" (and any
 * dash or comma left hanging by removing it) is dropped: "Vinaya".
 */
export function certificateName(name) {
  return clean(String(name ?? '').replace(/\bteachers?\b/gi, ' '))
    .replace(/^[\s\-–—,.:]+|[\s\-–—,:]+$/g, '')
    .trim()
}

/** Demo / test accounts ("Sample Teacher", "sample 1") never get a certificate. */
export function isSampleName(name) {
  return /\bsample\b/i.test(String(name ?? ''))
}

/** Default number of blank certificates: 10% of the teachers, rounded up, at least 1. */
export function defaultBlankCount(teacherCount) {
  return Math.max(1, Math.ceil((Number(teacherCount) || 0) * 0.1))
}

/** Largest size ≤ preferred (step 0.5) at which text fits maxWidth, never below min. */
export function fitSize(widthAt, text, preferred, maxWidth, min) {
  let size = preferred
  while (size > min && widthAt(text, size) > maxWidth) size -= 0.5
  return size
}

/** Split words into two lines of as-equal-as-possible width. */
export function balancedSplit(widthAt, text, size) {
  const words = text.split(' ')
  if (words.length < 2) return [text]
  let best = null
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' ')
    const b = words.slice(i).join(' ')
    const worst = Math.max(widthAt(a, size), widthAt(b, size))
    if (!best || worst < best.worst) best = { worst, lines: [a, b] }
  }
  return best.lines
}

function truncate(widthAt, text, size, maxWidth) {
  if (widthAt(text, size) <= maxWidth) return text
  const chars = Array.from(text)
  while (chars.length && widthAt(chars.join('').trimEnd() + '…', size) > maxWidth) chars.pop()
  return chars.join('').trimEnd() + '…'
}

/**
 * The name as lines to draw: [{ text, size, dy }] in template pixels, dy
 * relative to the rule baseline (negative = higher). Never wider than the rule.
 */
export function layoutName(name, widthAt, L = LAYOUT.name) {
  const text = certificateName(name).toUpperCase()
  if (!text) return []
  const one = fitSize(widthAt, text, L.size, L.maxWidth, L.oneLineMin)
  if (widthAt(text, one) <= L.maxWidth) return [{ text, size: one, dy: 0 }]

  const lines = balancedSplit(widthAt, text, L.twoLineMax)
  if (lines.length === 1) {
    const size = fitSize(widthAt, text, L.twoLineMax, L.maxWidth, L.min)
    return [{ text: truncate(widthAt, text, size, L.maxWidth), size, dy: 0 }]
  }
  const size = Math.min(...lines.map(l => fitSize(widthAt, l, L.twoLineMax, L.maxWidth, L.min)))
  return [
    { text: truncate(widthAt, lines[0], size, L.maxWidth), size, dy: -size * L.lineGap },
    { text: truncate(widthAt, lines[1], size, L.maxWidth), size, dy: 0 },
  ]
}

/** "as part of <b>School,</b> during the academic year 2025-26" as styled runs. */
export function schoolRuns(schoolName, academicYear) {
  const school = clean(schoolName).replace(/,+$/, '')
  const year = clean(academicYear)
  return [
    { text: 'as part of ', bold: false },
    { text: `${school},`, bold: true },
    { text: ` during the academic year${year ? ` ${year}` : ''}`, bold: false },
  ]
}

/**
 * Greedy word wrap over styled runs. Returns lines of [{ text, bold, x }]
 * with x offsets from the line start. widthAt(text, bold) measures one piece.
 */
export function wrapRuns(runs, widthAt, maxWidth) {
  const words = []
  for (const run of runs) {
    for (const part of run.text.split(/(\s+)/)) {
      if (!part) continue
      if (/^\s+$/.test(part)) words.push({ space: true, bold: run.bold })
      else words.push({ text: part, bold: run.bold })
    }
  }
  const lines = [[]]
  let x = 0
  let pendingSpace = null
  for (const w of words) {
    if (w.space) { pendingSpace = w; continue }
    const spaceW = pendingSpace && x > 0 ? widthAt(' ', pendingSpace.bold) : 0
    const wordW = widthAt(w.text, w.bold)
    if (x > 0 && x + spaceW + wordW > maxWidth) {
      lines.push([])
      x = 0
    } else {
      x += spaceW
    }
    lines[lines.length - 1].push({ text: w.text, bold: w.bold, x })
    x += wordW
    pendingSpace = null
  }
  return lines.filter(l => l.length)
}

/** Characters a font can't draw would throw inside pdf-lib. */
function drawable(font, text) {
  const supported = new Set(font.getCharacterSet())
  return Array.from(String(text ?? '')).filter(ch => supported.has(ch.codePointAt(0))).join('')
}

/** True when some letters of the name can't be printed in the certificate font. */
export function hasUnprintable(text) {
  return /[^\u0000-ɏ‘-”…]/.test(String(text ?? ''))
}

/** Browser: fetch the artwork and fonts from /public. */
export async function loadCertificateAssets(base = '/') {
  const get = async (path) => {
    const res = await fetch(base + path)
    if (!res.ok) throw new Error(`Could not load ${path} (${res.status})`)
    return new Uint8Array(await res.arrayBuffer())
  }
  const [template, name, regular, bold] = await Promise.all([
    get('certificates/teacher.png'),
    get('fonts/CinzelDecorative-Regular.ttf'), get('fonts/Raleway-Regular.ttf'), get('fonts/Raleway-Bold.ttf'),
  ])
  return { template, fonts: { name, regular, bold } }
}

/**
 * @param {object} opts
 * @param {Array<{name: string}>} opts.teachers  one page each, in order; an
 *        empty name prints a blank certificate (name left for handwriting)
 * @param {string} opts.schoolName    e.g. "Navodaya Central School, Raichur"
 * @param {string} opts.academicYear  e.g. "2025-26"
 * @param {object} opts.assets        from loadCertificateAssets()
 * @param {(done:number,total:number)=>void} [opts.onProgress]
 * @returns {Promise<Uint8Array>}
 */
export async function buildTeacherCertificatesPDF({ teachers, schoolName, academicYear, assets, onProgress }) {
  const doc = await PDFDocument.create()
  doc.registerFontkit(fontkit)
  doc.setTitle(`${clean(schoolName)} — Teacher Certificates`)
  doc.setAuthor('scratchpad Labs')

  const art = await doc.embedPng(assets.template)
  const fonts = {
    name: await doc.embedFont(assets.fonts.name, { subset: true }),
    regular: await doc.embedFont(assets.fonts.regular, { subset: true }),
    bold: await doc.embedFont(assets.fonts.bold, { subset: true }),
  }

  // Template pixels -> PDF points (origin bottom-left).
  const px = (v) => v * K
  const py = (v) => (PX_H - v) * K

  // The school line is the same on every page: lay it out once.
  const B = LAYOUT.body
  const bodyFont = (bold) => (bold ? fonts.bold : fonts.regular)
  const runs = schoolRuns(schoolName, academicYear)
    .map(r => ({ ...r, text: drawable(bodyFont(r.bold), r.text) }))
  const bodyLines = wrapRuns(runs, (t, bold) => bodyFont(bold).widthOfTextAtSize(t, px(B.size)) / K, B.maxWidth)

  const N = LAYOUT.name
  const nameWidth = (t, size) => fonts.name.widthOfTextAtSize(t, px(size)) / K

  let done = 0
  for (const teacher of teachers) {
    const page = doc.addPage([PAGE_W, PAGE_H])
    page.drawImage(art, { x: 0, y: 0, width: PAGE_W, height: PAGE_H })

    for (const line of layoutName(drawable(fonts.name, certificateName(teacher.name).toUpperCase()), nameWidth)) {
      page.drawText(line.text, {
        x: px(N.x), y: py(N.baseline + line.dy), size: px(line.size), font: fonts.name, color: toRgb(N.color),
      })
    }

    bodyLines.forEach((line, i) => {
      for (const piece of line) {
        page.drawText(piece.text, {
          x: px(B.x + piece.x), y: py(B.baseline + i * B.lineHeight),
          size: px(B.size), font: bodyFont(piece.bold), color: toRgb(B.color),
        })
      }
    })

    done++
    if (onProgress && (done % 25 === 0 || done === teachers.length)) {
      onProgress(done, teachers.length)
      await new Promise(r => setTimeout(r, 0))
    }
  }
  return doc.save()
}

export function certificateFilename(schoolName, suffix = '') {
  const name = clean(schoolName || 'School').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim()
  return `${name} - Teacher Certificates${suffix ? ` - ${suffix}` : ''}.pdf`
}

/**
 * How the school is named on the certificate by default: "Name, City" as in
 * the Canva sample ("Navodaya Central School, Raichur"), without repeating a
 * city the name already ends with.
 */
export function defaultPrintedSchool(school) {
  const name = clean(school?.name)
  const city = clean(school?.city)
  if (!city || name.toLowerCase().includes(city.toLowerCase())) return name
  return name ? `${name}, ${city}` : city
}
