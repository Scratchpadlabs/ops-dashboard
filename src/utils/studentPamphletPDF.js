/**
 * Student login pamphlets — one per student, stamped onto the blank Canva
 * designs in public/pamphlets/ (built by tools/build_pamphlet_templates.py and
 * tools/add_pamphlet_school_band.py, which also record where every field goes
 * in pamphletLayout.js).
 *
 *   foundational.pdf — Nursery … Grade 2: English front, Hindi back
 *   middle.pdf       — Grade 3 and above: login details + how-to, English only
 *
 * Each student gets both pages of their design, with: the school logo and
 * name in a band across the top of the front page, name / roll no / class in
 * the strip under it, the school website as a QR code and as text, and their
 * User ID and Password (the same value — the student doc id).
 *
 * The two template pages are embedded ONCE and drawn on every student's page,
 * so a 1,000-student PDF carries the artwork once, not 1,000 times.
 *
 * Pure helpers are exported for tests; buildStudentPamphletsPDF takes the
 * template and font bytes as an argument so it runs in node as well as the
 * browser (loadPamphletAssets fetches them in the browser).
 */
// fontkit's Indic shaper uses generators compiled for regenerator-runtime but
// doesn't load it: any text that starts with Devanagari (a Hindi school or
// student name) would throw "regeneratorRuntime is not defined" mid-run.
import 'regenerator-runtime/runtime.js'
import { PDFDocument, rgb } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import QRCode from 'qrcode'
import LAYOUT from './pamphletLayout.js'

export const DESIGNS = {
  foundational: { label: 'Foundational (Nursery – Grade 2, English + Hindi)' },
  middle:       { label: 'Middle + Prep (Grade 3 and above, English)' },
}

/** Grades up to 2 (Pre-Nursery … UKG are ≤ 0 in classResolver) are Foundational. */
export const LAST_FOUNDATIONAL_GRADE = 2

/** Which design a class gets, from its grade ordinal (null = not recognised). */
export function designForGrade(gradeOrdinal) {
  if (gradeOrdinal === null || gradeOrdinal === undefined) return null
  return gradeOrdinal <= LAST_FOUNDATIONAL_GRADE ? 'foundational' : 'middle'
}

/** "nins.myhpc.app", "https://www.x.app/" → what is printed under the QR. */
export function displayWebsite(url) {
  return String(url || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '')
}

/** What the QR opens: always a full https URL. */
export function qrTarget(url) {
  const shown = displayWebsite(url)
  return shown ? `https://${shown}` : ''
}

/** A missing name or class prints as a blank rule, to be filled in by hand.
 *  A missing roll number is left out of the header altogether. */
const BLANK = { name: '______________', rollNo: '_____', className: '________' }

const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim()

export function headerParts({ name, rollNo, className, blank }) {
  // A blank copy is filled in by hand, so it gets a line for every field.
  if (blank) {
    return { name: `Name: ${BLANK.name}`, rest: `Roll No.: ${BLANK.rollNo}   Class: ${BLANK.className}` }
  }
  return {
    name: `Name: ${clean(name) || BLANK.name}`,
    rest: [
      clean(rollNo) ? `Roll No.: ${clean(rollNo)}` : null,
      `Class: ${clean(className) || BLANK.className}`,
    ].filter(Boolean).join('   '),
  }
}

export function headerText(student) {
  const { name, rest } = headerParts(student)
  return `${name}   ${rest}`
}

// Header band: one line as in the Canva sample while it fits at a readable
// size, else name on its own line above roll no + class. Offsets are from the
// sample's baseline; the two lines stay inside the band above the border.
const HEADER_ONE_LINE_MIN = 14
const HEADER_TWO_LINE_MAX = 15
const HEADER_TWO_LINE_DY = [16.5, -4]
const HEADER_MIN = 9

/** Cut `text` to fit `maxWidth` at `size`, ending in an ellipsis. */
export function truncateToWidth(widthAt, text, size, maxWidth, ellipsis = '…') {
  if (widthAt(text, size) <= maxWidth) return text
  let chars = Array.from(text)
  while (chars.length && widthAt(chars.join('').trimEnd() + ellipsis, size) > maxWidth) chars.pop()
  return chars.join('').trimEnd() + ellipsis
}

/**
 * Lines to draw in the header band: [{ text, size, dy }], dy relative to the
 * slot baseline. Never wider than maxWidth, however long the name.
 */
export function layoutHeader(student, widthAt, preferred, maxWidth, ellipsis = '…') {
  const one = headerText(student)
  const oneSize = fitSize(widthAt, one, preferred, maxWidth, HEADER_ONE_LINE_MIN)
  if (widthAt(one, oneSize) <= maxWidth) return [{ text: one, size: oneSize, dy: 0 }]

  let { name, rest } = headerParts(student)
  const top = Math.min(preferred, HEADER_TWO_LINE_MAX)
  const size = Math.min(
    fitSize(widthAt, name, top, maxWidth, HEADER_MIN),
    fitSize(widthAt, rest, top, maxWidth, HEADER_MIN),
  )
  name = truncateToWidth(widthAt, name, size, maxWidth, ellipsis)
  rest = truncateToWidth(widthAt, rest, size, maxWidth, ellipsis)
  return [
    { text: name, size, dy: HEADER_TWO_LINE_DY[0] },
    { text: rest, size, dy: HEADER_TWO_LINE_DY[1] },
  ]
}

/** Largest size ≤ preferred at which `text` fits `maxWidth` (never below min). */
export function fitSize(widthAt, text, preferred, maxWidth, min = 8) {
  let size = preferred
  while (size > min && widthAt(text, size) > maxWidth) size -= 0.5
  return size
}

// School band at the top of the front page: logo on the left, name beside it
// in Cormorant Garamond with a short gold rule under it. The name is sized
// from the logo's height so the two always read as one unit; with no logo
// the name is centred on its own.
const SCHOOL_LOGO_FILL = 0.84        // logo height as a share of the band
const SCHOOL_LOGO_MAX_WIDTH = 140    // a very wide logo is shrunk to this
const SCHOOL_GAP = 14                // between logo and name
const SCHOOL_CAP = 0.63              // Cormorant cap height, in em
const SCHOOL_DESCENT = 0.32          // room for g/y/p under the last line, in em
const SCHOOL_LEADING = 1.18
const SCHOOL_RULE = { width: 44, gap: 4, thickness: 0.8 }
const SCHOOL_MIN_SIZE = 8
export const SCHOOL_COLOR = [0.17, 0.17, 0.17]
export const SCHOOL_GOLD = [0xb0 / 255, 0x8d / 255, 0x57 / 255]

/** Split at the word break that makes the two lines most even. */
export function balancedSplit(widthAt, text, size) {
  const words = text.split(' ')
  if (words.length < 2) return [text]
  let best = null
  for (let i = 1; i < words.length; i++) {
    const lines = [words.slice(0, i).join(' '), words.slice(i).join(' ')]
    const w = Math.max(...lines.map(l => widthAt(l, size)))
    if (!best || w < best.w) best = { w, lines }
  }
  return best.lines
}

/**
 * Where to draw the logo, the school name and its rule inside `box`
 * ({x0, x1, top, bottom}, PDF points, y up). logoAspect is width / height,
 * or null for no logo. Returns
 *   { logo: {x, y, width, height} | null,
 *     lines: [{text, size, x, baseline}],
 *     rule: {x0, x1, y} }
 */
export function layoutSchoolHeader(name, logoAspect, widthAt, box) {
  const bandH = box.top - box.bottom
  const cy = (box.top + box.bottom) / 2
  const boxW = box.x1 - box.x0

  let logo = null
  if (logoAspect > 0 && Number.isFinite(logoAspect)) {
    let height = bandH * SCHOOL_LOGO_FILL
    let width = height * logoAspect
    if (width > SCHOOL_LOGO_MAX_WIDTH) { width = SCHOOL_LOGO_MAX_WIDTH; height = width / logoAspect }
    logo = { width, height }
  }
  // Text is proportioned to the logo (a very flat logo still gets a readable
  // name); without one, to the band.
  const ref = logo ? Math.max(logo.height, bandH * 0.6) : bandH * 0.9
  const oneLine = ref * 0.56
  const twoLine = ref * 0.4
  const textMaxW = boxW - (logo ? logo.width + SCHOOL_GAP : 0)
  // Two lines must still fit the band with the rule under them.
  const twoLineMax = (bandH - SCHOOL_RULE.gap - 2) / (SCHOOL_CAP + SCHOOL_LEADING + SCHOOL_DESCENT)

  let lines
  let size
  if (widthAt(name, oneLine * 0.85) <= textMaxW || !name.includes(' ')) {
    size = fitSize(widthAt, name, oneLine, textMaxW, SCHOOL_MIN_SIZE)
    lines = [truncateToWidth(widthAt, name, size, textMaxW)]
  } else {
    size = Math.min(twoLine, twoLineMax)
    lines = balancedSplit(widthAt, name, size)
    size = Math.min(...lines.map(l => fitSize(widthAt, l, size, textMaxW, SCHOOL_MIN_SIZE)))
    lines = lines.map(l => truncateToWidth(widthAt, l, size, textMaxW))
  }
  const textW = Math.max(...lines.map(l => widthAt(l, size)))
  const groupW = (logo ? logo.width + SCHOOL_GAP : 0) + textW
  const left = (box.x0 + box.x1) / 2 - groupW / 2
  if (logo) Object.assign(logo, { x: left, y: cy - logo.height / 2 })
  const textCx = left + (logo ? logo.width + SCHOOL_GAP : 0) + textW / 2

  // Centre caps + lines + rule on the logo's middle.
  const ruleDrop = SCHOOL_DESCENT * size + SCHOOL_RULE.gap
  const blockH = SCHOOL_CAP * size + (lines.length - 1) * SCHOOL_LEADING * size + ruleDrop
  const firstBaseline = cy + blockH / 2 - SCHOOL_CAP * size
  const lastBaseline = firstBaseline - (lines.length - 1) * SCHOOL_LEADING * size
  return {
    logo,
    lines: lines.map((text, i) => ({
      text, size,
      x: textCx - widthAt(text, size) / 2,
      baseline: firstBaseline - i * SCHOOL_LEADING * size,
    })),
    rule: { x0: textCx - SCHOOL_RULE.width / 2, x1: textCx + SCHOOL_RULE.width / 2, y: lastBaseline - ruleDrop },
  }
}

/** Class, then roll number (numerically when both are numbers), then name. */
export function compareStudents(a, b, compareClasses = (x, y) => x.localeCompare(y)) {
  const byClass = compareClasses(a.classId || '', b.classId || '')
  if (byClass) return byClass
  const ra = String(a.rollNo ?? '').trim()
  const rb = String(b.rollNo ?? '').trim()
  if (ra !== rb) {
    if (!ra) return 1
    if (!rb) return -1
    const na = Number(ra)
    const nb = Number(rb)
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb
    const byRoll = ra.localeCompare(rb, undefined, { numeric: true })
    if (byRoll) return byRoll
  }
  return String(a.name || '').localeCompare(String(b.name || ''))
}

/** Characters the embedded fonts can't draw would throw inside pdf-lib. */
function drawable(font, text) {
  const supported = new Set(font.getCharacterSet())
  return Array.from(String(text ?? '')).filter(ch => supported.has(ch.codePointAt(0))).join('')
}

const HEADER_MAX_WIDTH = 530   // inside the page border
const URL_MAX_WIDTH = 280      // inside the yellow box
// Room on the User ID / Password rules, from where the value starts.
// Older layouts without a measured maxWidth on the value slots.
const VALUE_MAX_WIDTH = { userId: 152, password: 142 }
const FOOTER_MAX_WIDTH = 520

const toRgb = (c) => rgb(c[0], c[1], c[2])

/**
 * Layout slots are measured from the page box's corner, but Canva's page box
 * doesn't start at (0, 0) — it is [0 7.83 595.5 850.08]. Move every slot by
 * the box origin so stamped text lands where it sat in the sample.
 */
function placeSlots(slots, ox, oy) {
  const out = {}
  for (const [key, slot] of Object.entries(slots)) {
    out[key] = { ...slot }
    if ('cx' in slot) out[key].cx = slot.cx + ox
    if ('x' in slot) out[key].x = slot.x + ox
    if ('y' in slot) out[key].y = slot.y + oy
    if ('baseline' in slot) out[key].baseline = slot.baseline + oy
    if ('x0' in slot) { out[key].x0 = slot.x0 + ox; out[key].x1 = slot.x1 + ox }
    if ('top' in slot) { out[key].top = slot.top + oy; out[key].bottom = slot.bottom + oy }
  }
  return out
}

// fontkit picks ONE shaper per string, from its first letter: in "Name: आरव
// शर्मा" the Latin shaper runs over the Hindi too, and र्म prints as र् + म
// instead of the reph. Measure and draw each script's run on its own.
const DEVANAGARI = /[\u0900-\u097F\uA8E0-\uA8FF\u1CD0-\u1CFF]/
const LETTER = /\p{L}|\p{M}/u

/** Split into runs of one script; spaces, digits and punctuation stay with the run they follow. */
export function scriptRuns(text) {
  const runs = []
  let cur = ''
  let curDeva = null
  for (const ch of String(text)) {
    const deva = DEVANAGARI.test(ch) || (ch === '\u200C' || ch === '\u200D') ? true : LETTER.test(ch) ? false : null
    if (deva !== null && curDeva !== null && deva !== curDeva) {
      runs.push(cur)
      cur = ''
    }
    if (deva !== null) curDeva = deva
    cur += ch
  }
  if (cur) runs.push(cur)
  return runs
}

function runsWidth(font, text, size) {
  return scriptRuns(text).reduce((w, run) => w + font.widthOfTextAtSize(run, size), 0)
}

function drawRuns(page, text, { x, y, size, font, color }) {
  for (const run of scriptRuns(text)) {
    page.drawText(run, { x, y, size, font, color })
    x += font.widthOfTextAtSize(run, size)
  }
}

function drawCentered(page, font, text, slot, maxWidth) {
  const size = fitSize((t, s) => font.widthOfTextAtSize(t, s), text, slot.size, maxWidth)
  const width = font.widthOfTextAtSize(text, size)
  page.drawText(text, { x: slot.cx - width / 2, y: slot.baseline, size, font, color: toRgb(slot.color) })
  return { x: slot.cx - width / 2, width, size }
}

/** QR as vector squares: crisp at any print size, a few hundred bytes. */
function drawQr(page, qr, slot) {
  const n = qr.modules.size
  const quiet = 2
  const cell = slot.size / (n + quiet * 2)
  const black = rgb(0, 0, 0)
  page.drawRectangle({ x: slot.x, y: slot.y, width: slot.size, height: slot.size, color: rgb(1, 1, 1) })
  for (let r = 0; r < n; r++) {
    let c = 0
    while (c < n) {
      if (!qr.modules.get(r, c)) { c++; continue }
      const start = c
      while (c < n && qr.modules.get(r, c)) c++
      page.drawRectangle({
        x: slot.x + (quiet + start) * cell,
        y: slot.y + slot.size - (quiet + r + 1) * cell,
        // A hair wider/taller so adjacent runs don't show seams in viewers.
        width: (c - start) * cell + 0.05,
        height: cell + 0.05,
        color: black,
      })
    }
  }
}

/** Browser: fetch the templates and fonts from /public. */
export async function loadPamphletAssets(base = '/') {
  const get = async (path) => {
    const res = await fetch(base + path)
    if (!res.ok) throw new Error(`Could not load ${path} (${res.status})`)
    return new Uint8Array(await res.arrayBuffer())
  }
  const [foundational, middle, regular, bold, valueFont, school] = await Promise.all([
    get('pamphlets/foundational.pdf'), get('pamphlets/middle.pdf'),
    get('fonts/Poppins-Regular.ttf'), get('fonts/Poppins-Bold.ttf'), get('fonts/Inter-Bold.ttf'),
    get('fonts/CormorantGaramond-SemiBold.ttf'),
  ])
  return { templates: { foundational, middle }, fonts: { regular, bold, value: valueFont, school } }
}

/**
 * @param {object} opts
 * @param {Array<{id,name,rollNo,className,design,blank?}>} opts.students  in print order;
 *        design is 'foundational' | 'middle'; blank: true for a copy to fill
 *        in by hand (see blankCopies)
 * @param {string} opts.schoolName   printed in the school band (or footer, on older templates)
 * @param {{bytes: Uint8Array, type: 'png'|'jpg'}} [opts.logo]  school logo for the school band
 * @param {string} opts.website      e.g. "www.nins.myhpc.app"
 * @param {object} opts.assets       from loadPamphletAssets()
 * @param {(done:number,total:number)=>void} [opts.onProgress]
 * @returns {Promise<Uint8Array>}
 */
export async function buildStudentPamphletsPDF({ students, schoolName, website, logo, assets, onProgress }) {
  const doc = await PDFDocument.create()
  doc.registerFontkit(fontkit)
  doc.setTitle(`${schoolName} — Student Login Pamphlets`)
  doc.setAuthor('scratchpad Labs')

  const fonts = {
    regular: await doc.embedFont(assets.fonts.regular, { subset: true }),
    bold:    await doc.embedFont(assets.fonts.bold, { subset: true }),
    value:   await doc.embedFont(assets.fonts.value, { subset: true }),
    school:  assets.fonts.school ? await doc.embedFont(assets.fonts.school, { subset: true }) : null,
  }

  const templates = {}
  for (const design of new Set(students.map(s => s.design))) {
    const layout = LAYOUT[design]
    if (!layout) throw new Error(`Unknown pamphlet design "${design}"`)
    const src = await PDFDocument.load(assets.templates[design])
    const srcPages = src.getPages()
    // Embed the whole page box explicitly: pdf-lib's default box starts at
    // (0, 0), which shifts Canva's artwork and clips its top 7.83pt.
    const embedded = await doc.embedPages(srcPages, srcPages.map(p => {
      const b = p.getMediaBox()
      return { left: b.x, bottom: b.y, right: b.x + b.width, top: b.y + b.height }
    }))
    templates[design] = srcPages.map((p, i) => {
      const box = p.getMediaBox()
      return { box, embedded: embedded[i], slots: placeSlots(layout.pages[i] || {}, box.x, box.y) }
    })
  }

  const shownUrl = displayWebsite(website)
  const qr = QRCode.create(qrTarget(website), { errorCorrectionLevel: 'M' })
  const footer = String(schoolName || '').trim().toUpperCase()
  // The band prints the name as typed. Cormorant covers Latin only; a name it
  // can't draw in full (e.g. in Devanagari) falls back to Poppins.
  const bandName = String(schoolName || '').replace(/\s+/g, ' ').trim()
  const bandFont = fonts.school && drawable(fonts.school, bandName) === bandName ? fonts.school : fonts.regular
  const logoImage = logo?.bytes
    ? await (logo.type === 'jpg' ? doc.embedJpg(logo.bytes) : doc.embedPng(logo.bytes))
    : null

  let done = 0
  for (const student of students) {
    const id = student.blank ? '' : String(student.id || '').trim()
    const headerStudent = {
      blank: !!student.blank,
      name: drawable(fonts.regular, student.name),
      rollNo: drawable(fonts.regular, student.rollNo),
      className: drawable(fonts.regular, student.className),
    }

    for (const { box, embedded, slots } of templates[student.design]) {
      // Same page box as the template, artwork drawn at its own coordinates.
      const page = doc.addPage([box.width, box.height])
      page.setMediaBox(box.x, box.y, box.width, box.height)
      page.drawPage(embedded, { x: box.x, y: box.y, width: box.width, height: box.height })

      if (slots.header) {
        const widthAt = (t, s) => runsWidth(fonts.regular, t, s)
        for (const line of layoutHeader(headerStudent, widthAt, slots.header.size, HEADER_MAX_WIDTH)) {
          const width = widthAt(line.text, line.size)
          drawRuns(page, line.text, {
            x: slots.header.cx - width / 2, y: slots.header.baseline + line.dy,
            size: line.size, font: fonts.regular, color: toRgb(slots.header.color),
          })
        }
      }
      if (slots.qr && shownUrl) drawQr(page, qr, slots.qr)
      if (slots.url && shownUrl) {
        const t = drawCentered(page, fonts.bold, drawable(fonts.bold, shownUrl), slots.url, URL_MAX_WIDTH)
        // The samples underline the address with a bar just below the baseline.
        page.drawRectangle({
          x: t.x, y: slots.url.baseline - t.size * 0.145, width: t.width, height: t.size * 0.072,
          color: toRgb(slots.url.color),
        })
      }
      for (const key of ['userId', 'password']) {
        const slot = slots[key]
        if (!slot || !id) continue
        const text = drawable(fonts.value, id)
        // Never truncated: a cut-off ID is a wrong ID. Shrink instead.
        const size = fitSize((t, s) => fonts.value.widthOfTextAtSize(t, s), text, slot.size, slot.maxWidth ?? VALUE_MAX_WIDTH[key], 6)
        page.drawText(text, { x: slot.x, y: slot.baseline, size, font: fonts.value, color: toRgb(slot.color) })
      }
      if (slots.school && bandName) {
        const widthAt = (t, s) => runsWidth(bandFont, t, s)
        const aspect = logoImage ? logoImage.width / logoImage.height : null
        const band = layoutSchoolHeader(drawable(bandFont, bandName), aspect, widthAt, slots.school)
        if (band.logo) page.drawImage(logoImage, band.logo)
        for (const line of band.lines) {
          drawRuns(page, line.text, { x: line.x, y: line.baseline, size: line.size, font: bandFont, color: toRgb(SCHOOL_COLOR) })
        }
        page.drawLine({
          start: { x: band.rule.x0, y: band.rule.y }, end: { x: band.rule.x1, y: band.rule.y },
          thickness: SCHOOL_RULE.thickness, color: toRgb(SCHOOL_GOLD),
        })
      } else if (slots.school && logoImage) {
        const band = layoutSchoolHeader('', logoImage.width / logoImage.height, () => 0, slots.school)
        page.drawImage(logoImage, { ...band.logo, x: (slots.school.x0 + slots.school.x1 - band.logo.width) / 2 })
      }
      if (slots.footer && footer) drawCentered(page, fonts.regular, drawable(fonts.regular, footer), slots.footer, FOOTER_MAX_WIDTH)
    }

    done++
    if (onProgress && (done % 25 === 0 || done === students.length)) {
      onProgress(done, students.length)
      // Let the progress text paint between batches.
      await new Promise(r => setTimeout(r, 0))
    }
  }

  return doc.save()
}

/**
 * Blank copies to fill in by hand (new admissions, lost pamphlets): school
 * name, website and QR printed; name / roll no / class as blank lines; User
 * ID and Password left empty on their rules.
 */
export function blankCopies(design, count) {
  const n = Math.max(0, Math.floor(Number(count) || 0))
  return Array.from({ length: n }, () => ({ blank: true, design }))
}

export function pamphletFilename(schoolName, suffix = '') {
  const clean = String(schoolName || 'School').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim()
  return `${clean} - Student Pamphlets${suffix ? ` - ${suffix}` : ''}.pdf`
}

/**
 * The ops-dashboard school record and the teacher-app school are separate
 * trees with unrelated ids. Best guess at which teacher-app school an ops
 * school is, by name: an exact match ignoring case/punctuation, else a
 * single school whose name contains the other's. null when unsure.
 */
export function guessAppSchool(opsName, appSchools) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '')
  const want = norm(opsName)
  if (!want) return null
  const exact = appSchools.filter(s => norm(s.name) === want || norm(s.id) === want)
  if (exact.length === 1) return exact[0]
  const partial = appSchools.filter(s => {
    const n = norm(s.name)
    return n && (n.includes(want) || want.includes(n))
  })
  return partial.length === 1 ? partial[0] : null
}
