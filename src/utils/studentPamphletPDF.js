/**
 * Student login pamphlets — one per student, stamped onto the blank Canva
 * designs in public/pamphlets/ (built by tools/build_pamphlet_templates.py,
 * which also records where every field goes in pamphletLayout.js).
 *
 *   foundational.pdf — Nursery … Grade 2: English front, Hindi back
 *   middle.pdf       — Grade 3 and above: login details + how-to, English only
 *
 * Each student gets both pages of their design, with: name / roll no / class
 * across the top, the school website as a QR code and as text, their User ID
 * and Password (the same value — the student doc id), and the school name in
 * the footer.
 *
 * The two template pages are embedded ONCE and drawn on every student's page,
 * so a 1,000-student PDF carries the artwork once, not 1,000 times.
 *
 * Pure helpers are exported for tests; buildStudentPamphletsPDF takes the
 * template and font bytes as an argument so it runs in node as well as the
 * browser (loadPamphletAssets fetches them in the browser).
 */
import { PDFDocument, rgb } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import QRCode from 'qrcode'
import LAYOUT from './pamphletLayout.js'

export const DESIGNS = {
  foundational: { label: 'Foundational (Nursery – Grade 2, English + second language)' },
  middle:       { label: 'Middle + Prep (Grade 3 and above, English)' },
}

/** The Foundational back page's language; the front is always English. */
export const FOUNDATIONAL_BACK_LANGUAGES = [
  { value: 'hindi', label: 'Hindi' },
  { value: 'marathi', label: 'Marathi' },
]

/**
 * Which template pages make up one student's pamphlet: [templateKey, pageIndex]
 * pairs, templateKey being a key of pamphletLayout.js / assets.templates.
 */
export function pagesFor(design, foundationalBack = 'hindi') {
  if (design === 'middle') return [['middle', 0], ['middle', 1]]
  if (design !== 'foundational') throw new Error(`Unknown pamphlet design "${design}"`)
  if (foundationalBack === 'hindi') return [['foundational', 0], ['foundational', 1]]
  if (foundationalBack === 'marathi') return [['foundational', 0], ['foundationalMarathi', 0]]
  throw new Error(`Unknown Foundational back-page language "${foundationalBack}"`)
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
  }
  return out
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
  const [foundational, middle, foundationalMarathi, regular, bold, valueFont] = await Promise.all([
    get('pamphlets/foundational.pdf'), get('pamphlets/middle.pdf'), get('pamphlets/foundational-marathi.pdf'),
    get('fonts/Poppins-Regular.ttf'), get('fonts/Poppins-Bold.ttf'), get('fonts/Inter-Bold.ttf'),
  ])
  return {
    templates: { foundational, middle, foundationalMarathi },
    fonts: { regular, bold, value: valueFont },
  }
}

/**
 * @param {object} opts
 * @param {Array<{id,name,rollNo,className,design,blank?}>} opts.students  in print order;
 *        design is 'foundational' | 'middle'; blank: true for a copy to fill
 *        in by hand (see blankCopies)
 * @param {string} opts.schoolName   printed in every footer
 * @param {string} opts.website      e.g. "www.nins.myhpc.app"
 * @param {object} opts.assets       from loadPamphletAssets()
 * @param {'hindi'|'marathi'} [opts.foundationalBack]  language of the
 *        Foundational back page (front is English); default Hindi
 * @param {(done:number,total:number)=>void} [opts.onProgress]
 * @returns {Promise<Uint8Array>}
 */
export async function buildStudentPamphletsPDF({
  students, schoolName, website, assets, onProgress, foundationalBack = 'hindi',
}) {
  const doc = await PDFDocument.create()
  doc.registerFontkit(fontkit)
  doc.setTitle(`${schoolName} — Student Login Pamphlets`)
  doc.setAuthor('scratchpad Labs')

  const fonts = {
    regular: await doc.embedFont(assets.fonts.regular, { subset: true }),
    bold:    await doc.embedFont(assets.fonts.bold, { subset: true }),
    value:   await doc.embedFont(assets.fonts.value, { subset: true }),
  }

  // Each template file is embedded once, however many designs use its pages.
  const embeddedFiles = {}
  async function embedTemplate(key) {
    const layout = LAYOUT[key]
    if (!layout || !assets.templates[key]) throw new Error(`Missing pamphlet template "${key}"`)
    const src = await PDFDocument.load(assets.templates[key])
    const srcPages = src.getPages()
    // Embed the whole page box explicitly: pdf-lib's default box starts at
    // (0, 0), which shifts Canva's artwork and clips its top 7.83pt.
    const embedded = await doc.embedPages(srcPages, srcPages.map(p => {
      const b = p.getMediaBox()
      return { left: b.x, bottom: b.y, right: b.x + b.width, top: b.y + b.height }
    }))
    return srcPages.map((p, i) => {
      const box = p.getMediaBox()
      return { box, embedded: embedded[i], slots: placeSlots(layout.pages[i] || {}, box.x, box.y) }
    })
  }
  const templates = {}
  for (const design of new Set(students.map(s => s.design))) {
    templates[design] = []
    for (const [key, index] of pagesFor(design, foundationalBack)) {
      embeddedFiles[key] ||= await embedTemplate(key)
      templates[design].push(embeddedFiles[key][index])
    }
  }

  const shownUrl = displayWebsite(website)
  const qr = QRCode.create(qrTarget(website), { errorCorrectionLevel: 'M' })
  const footer = String(schoolName || '').trim().toUpperCase()

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
        const widthAt = (t, s) => fonts.regular.widthOfTextAtSize(t, s)
        for (const line of layoutHeader(headerStudent, widthAt, slots.header.size, HEADER_MAX_WIDTH)) {
          const width = widthAt(line.text, line.size)
          page.drawText(line.text, {
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
        const size = fitSize((t, s) => fonts.value.widthOfTextAtSize(t, s), text, slot.size, VALUE_MAX_WIDTH[key])
        page.drawText(text, { x: slot.x, y: slot.baseline, size, font: fonts.value, color: toRgb(slot.color) })
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
