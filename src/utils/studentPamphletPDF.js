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

export function headerText({ name, rollNo, className }) {
  return [
    `Name: ${name || ''}`,
    rollNo ? `Roll No.: ${rollNo}` : null,
    className ? `Class: ${className}` : null,
  ].filter(Boolean).join('   ')
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
const VALUE_MAX_WIDTH = 150    // on the User ID / Password rule
const FOOTER_MAX_WIDTH = 520

const toRgb = (c) => rgb(c[0], c[1], c[2])

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
  const [foundational, middle, regular, bold, valueFont] = await Promise.all([
    get('pamphlets/foundational.pdf'), get('pamphlets/middle.pdf'),
    get('fonts/Poppins-Regular.ttf'), get('fonts/Poppins-Bold.ttf'), get('fonts/Inter-Bold.ttf'),
  ])
  return { templates: { foundational, middle }, fonts: { regular, bold, value: valueFont } }
}

/**
 * @param {object} opts
 * @param {Array<{id,name,rollNo,className,design}>} opts.students  in print order;
 *        design is 'foundational' | 'middle'
 * @param {string} opts.schoolName   printed in every footer
 * @param {string} opts.website      e.g. "www.nins.myhpc.app"
 * @param {object} opts.assets       from loadPamphletAssets()
 * @param {(done:number,total:number)=>void} [opts.onProgress]
 * @returns {Promise<Uint8Array>}
 */
export async function buildStudentPamphletsPDF({ students, schoolName, website, assets, onProgress }) {
  const doc = await PDFDocument.create()
  doc.registerFontkit(fontkit)
  doc.setTitle(`${schoolName} — Student Login Pamphlets`)
  doc.setAuthor('scratchpad Labs')

  const fonts = {
    regular: await doc.embedFont(assets.fonts.regular, { subset: true }),
    bold:    await doc.embedFont(assets.fonts.bold, { subset: true }),
    value:   await doc.embedFont(assets.fonts.value, { subset: true }),
  }

  const templates = {}
  for (const design of new Set(students.map(s => s.design))) {
    const layout = LAYOUT[design]
    if (!layout) throw new Error(`Unknown pamphlet design "${design}"`)
    const src = await PDFDocument.load(assets.templates[design])
    const pages = await doc.embedPages(src.getPages())
    templates[design] = { layout, pages }
  }

  const shownUrl = displayWebsite(website)
  const qr = QRCode.create(qrTarget(website), { errorCorrectionLevel: 'M' })
  const footer = String(schoolName || '').trim().toUpperCase()

  let done = 0
  for (const student of students) {
    const { layout, pages } = templates[student.design]
    const id = String(student.id || '').trim()
    const header = headerText({
      name: drawable(fonts.regular, student.name),
      rollNo: drawable(fonts.regular, student.rollNo),
      className: drawable(fonts.regular, student.className),
    })

    layout.pages.forEach((slots, i) => {
      const page = doc.addPage([layout.width, layout.height])
      page.drawPage(pages[i], { x: 0, y: 0, width: layout.width, height: layout.height })

      if (slots.header) drawCentered(page, fonts.regular, header, slots.header, HEADER_MAX_WIDTH)
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
        if (!slot) continue
        const text = drawable(fonts.value, id)
        const size = fitSize((t, s) => fonts.value.widthOfTextAtSize(t, s), text, slot.size, VALUE_MAX_WIDTH)
        page.drawText(text, { x: slot.x, y: slot.baseline, size, font: fonts.value, color: toRgb(slot.color) })
      }
      if (slots.footer && footer) drawCentered(page, fonts.regular, drawable(fonts.regular, footer), slots.footer, FOOTER_MAX_WIDTH)
    })

    done++
    if (onProgress && (done % 25 === 0 || done === students.length)) {
      onProgress(done, students.length)
      // Let the progress text paint between batches.
      await new Promise(r => setTimeout(r, 0))
    }
  }

  return doc.save()
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
