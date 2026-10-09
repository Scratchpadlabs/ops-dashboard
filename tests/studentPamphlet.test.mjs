// Run with `npm test` (node's built-in test runner — no extra dependencies).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PDFDocument } from 'pdf-lib'
import {
  layoutSchoolHeader, balancedSplit, scriptRuns, stageForGrade, STAGES,
  designForGrade, displayWebsite, qrTarget, headerText, fitSize, compareStudents, layoutHeader, truncateToWidth,
  guessAppSchool, pamphletFilename, buildStudentPamphletsPDF, blankCopies, pagesFor, defaultBlankPamphlets, classSkipReason,
} from '../src/utils/studentPamphletPDF.js'
import LAYOUT from '../src/utils/pamphletLayout.js'

const read = (p) => new Uint8Array(readFileSync(new URL(`../${p}`, import.meta.url)))

test('SP-01 Nursery … Grade 2 are Foundational, Grade 3+ Middle + Prep, unknown is null', () => {
  // classResolver ordinals: Pre-Nursery -3, Nursery -2, LKG -1, UKG 0.
  assert.deepEqual([-3, -2, -1, 0, 1, 2].map(designForGrade), Array(6).fill('foundational'))
  assert.deepEqual([3, 5, 8, 12].map(designForGrade), Array(4).fill('middle'))
  assert.equal(designForGrade(null), null)
})

test('SP-02 website is printed without protocol; QR always opens https', () => {
  assert.equal(displayWebsite('https://nins.myhpc.app/'), 'nins.myhpc.app')
  assert.equal(displayWebsite('  www.spl.myhpc.app '), 'www.spl.myhpc.app')
  assert.equal(qrTarget('www.spl.myhpc.app'), 'https://www.spl.myhpc.app')
  assert.equal(qrTarget('http://x.app'), 'https://x.app')
  assert.equal(qrTarget(''), '')
})

test('SP-03 header matches the sample; no roll no is skipped, a missing name/class prints as a blank', () => {
  assert.equal(headerText({ name: 'Aditya Singh', rollNo: '02', className: 'IV Diamond' }),
    'Name: Aditya Singh   Roll No.: 02   Class: IV Diamond')
  assert.equal(headerText({ name: 'A', rollNo: '', className: 'I A' }), 'Name: A   Class: I A')
  assert.equal(headerText({ name: 'A', rollNo: '   ', className: 'I A' }), 'Name: A   Class: I A')
  assert.equal(headerText({ name: '  ', rollNo: null, className: undefined }),
    'Name: ______________   Class: ________')
  assert.equal(headerText({ name: 'Riya   Sharma ', rollNo: ' 7 ', className: 'II A' }), 'Name: Riya Sharma   Roll No.: 7   Class: II A')
})

// Width model for layout tests: every character is 0.6em wide.
const mono = (t, s) => Array.from(t).length * s * 0.6

test('SP-03b header stays on one line, as in the sample, while it fits at 14pt', () => {
  const lines = layoutHeader({ name: 'Aditya Singh', rollNo: '02', className: 'IV Diamond' }, mono, 19, 530)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].dy, 0)
  assert.ok(lines[0].size >= 14 && lines[0].size <= 19)
})

test('SP-03c a long name moves to its own line; roll no + class go below, nothing overflows', () => {
  const student = { name: 'Venkata Subramaniam Raghunathan Iyer Krishnamurthy', rollNo: '113', className: 'Senior KG Rose' }
  const lines = layoutHeader(student, mono, 19, 530)
  assert.equal(lines.length, 2)
  assert.equal(lines[0].text, `Name: ${student.name}`)
  assert.equal(lines[1].text, 'Roll No.: 113   Class: Senior KG Rose')
  assert.ok(lines[0].dy > lines[1].dy)                     // name above
  for (const l of lines) assert.ok(mono(l.text, l.size) <= 530)
  assert.equal(lines[0].size, lines[1].size)
})

test('SP-03d an absurdly long name is cut with an ellipsis rather than shrunk unreadably', () => {
  const lines = layoutHeader({ name: 'X'.repeat(200), rollNo: '1', className: 'I A' }, mono, 19, 530)
  assert.equal(lines.length, 2)
  assert.ok(lines[0].text.endsWith('…'))
  assert.ok(lines[0].size >= 9)
  assert.ok(mono(lines[0].text, lines[0].size) <= 530)
})

test('SP-03e truncateToWidth leaves fitting text alone and trims trailing spaces before the ellipsis', () => {
  assert.equal(truncateToWidth(mono, 'abc', 10, 100), 'abc')
  assert.equal(truncateToWidth(mono, 'ab cdefgh', 10, 24), 'ab…')
})

test('SP-04 fitSize shrinks until it fits, never below the minimum', () => {
  const width = (t, s) => t.length * s
  assert.equal(fitSize(width, 'abcd', 20, 100), 20)
  assert.equal(fitSize(width, 'abcdefghij', 20, 100), 10)
  assert.equal(fitSize(width, 'x'.repeat(100), 20, 100), 8)
})

test('SP-05 students sort by class, then numeric roll no, then name; blank rolls last', () => {
  const list = [
    { classId: 'B', rollNo: '1', name: 'z' },
    { classId: 'A', rollNo: '10', name: 'a' },
    { classId: 'A', rollNo: '', name: 'b' },
    { classId: 'A', rollNo: '2', name: 'c' },
    { classId: 'A', rollNo: '2', name: 'b' },
  ]
  assert.deepEqual(list.sort((a, b) => compareStudents(a, b)).map(s => `${s.classId}${s.rollNo}${s.name}`),
    ['A2b', 'A2c', 'A10a', 'Ab', 'B1z'])
})

test('SP-06 ops school name is matched to the teacher-app school only when unambiguous', () => {
  const schools = [
    { id: 'spl', name: 'SPL International School' },
    { id: 'nins', name: 'New India National School' },
    { id: 'nis2', name: 'New India School' },
  ]
  assert.equal(guessAppSchool('S.P.L. International School', schools)?.id, 'spl')
  assert.equal(guessAppSchool('nins', schools)?.id, 'nins')
  assert.equal(guessAppSchool('New India', schools), null)      // two candidates
  assert.equal(guessAppSchool('', schools), null)
})

test('SP-07 filename drops characters Windows refuses', () => {
  assert.equal(pamphletFilename('St. Mary/Joseph: School', 'IV A'), 'St. Mary Joseph School - Student Pamphlets - IV A.pdf')
})

test('SP-08 layout has every slot the pamphlet needs on page 1', () => {
  for (const design of ['foundational', 'middle']) {
    const p1 = LAYOUT[design].pages[0]
    for (const key of ['school', 'header', 'qr', 'url', 'userId', 'password']) assert.ok(p1[key], `${design} ${key}`)
    assert.equal(LAYOUT[design].pages.length, 2)
    // The school name moved from the footer to the band.
    for (const page of LAYOUT[design].pages) assert.equal(page.footer, undefined, `${design} footer`)
    // The band sits above the student strip, inside the page border.
    assert.ok(p1.school.bottom > p1.header.baseline + 19, `${design} band above strip`)
    assert.ok(p1.school.x0 > 22 && p1.school.x1 < 573, `${design} band inside border`)
  }
})

test("SP-09 builds two pages per student, even with a name the fonts can't draw", async () => {
  const assets = {
    templates: { foundational: read('public/pamphlets/foundational.pdf'), middle: read('public/pamphlets/middle.pdf'), foundationalMarathi: read('public/pamphlets/foundational-marathi.pdf') },
    fonts: { regular: read('public/fonts/Poppins-Regular.ttf'), bold: read('public/fonts/Poppins-Bold.ttf'), value: read('public/fonts/Inter-Bold.ttf') },
  }
  const bytes = await buildStudentPamphletsPDF({
    schoolName: 'Spl International School',
    website: 'www.spl.myhpc.app',
    assets,
    students: [
      { id: 'sss0001', name: 'Aditya Singh', rollNo: '02', className: 'UKG A', design: 'foundational' },
      // A character the fonts can't draw must not abort the whole run.
      { id: 'sss0002', name: 'आर्यन Kumar', rollNo: '3', className: 'IV Diamond', design: 'middle' },
    ],
  })
  const doc = await PDFDocument.load(bytes)
  assert.equal(doc.getPageCount(), 4)

  // Canva's page box starts at y = 7.83, not 0. Output pages must keep the
  // template's box, or the artwork shifts against the stamped text.
  const template = await PDFDocument.load(assets.templates.foundational)
  const want = template.getPage(0).getMediaBox()
  assert.ok(want.y > 0, 'fixture should exercise a non-zero page box origin')
  for (const page of doc.getPages()) assert.deepEqual(page.getMediaBox(), want)
})

test('SP-10 blank copies: a line for every header field, no ID or password', async () => {
  assert.equal(headerText({ blank: true, name: 'ignored', rollNo: '9' }),
    'Name: ______________   Roll No.: _____   Class: ________')
  assert.deepEqual(blankCopies('middle', 2), [{ blank: true, design: 'middle' }, { blank: true, design: 'middle' }])
  assert.deepEqual(blankCopies('middle', 0), [])
  assert.deepEqual(blankCopies('middle', 'x'), [])

  const assets = {
    templates: { foundational: read('public/pamphlets/foundational.pdf'), middle: read('public/pamphlets/middle.pdf'), foundationalMarathi: read('public/pamphlets/foundational-marathi.pdf') },
    fonts: { regular: read('public/fonts/Poppins-Regular.ttf'), bold: read('public/fonts/Poppins-Bold.ttf'), value: read('public/fonts/Inter-Bold.ttf') },
  }
  const bytes = await buildStudentPamphletsPDF({
    schoolName: 'X School', website: 'x.myhpc.app', assets,
    students: [...blankCopies('foundational', 2), ...blankCopies('middle', 1)],
  })
  assert.equal((await PDFDocument.load(bytes)).getPageCount(), 6)
})

// ── School band ──────────────────────────────────────────────────────────────
const BAND = { x0: 30, x1: 565, top: 837, bottom: 785 }
const inside = (r, box) => r.x0 >= box.x0 - 0.01 && r.x1 <= box.x1 + 0.01 && r.y0 >= box.bottom - 0.01 && r.y1 <= box.top + 0.01
// Text extent at size s, using the same cap / descent the layout assumes.
const textBox = (l) => ({ x0: l.x, x1: l.x + mono(l.text, l.size), y0: l.baseline - 0.32 * l.size, y1: l.baseline + 0.63 * l.size })

function checkBand(name, aspect) {
  const b = layoutSchoolHeader(name, aspect, mono, BAND)
  for (const l of b.lines) assert.ok(inside(textBox(l), BAND), `text inside band: ${name} @ ${aspect}`)
  assert.ok(b.rule.y >= BAND.bottom && b.rule.y < Math.min(...b.lines.map(l => l.baseline)), 'rule under the name, inside band')
  if (b.logo) {
    const logo = { x0: b.logo.x, x1: b.logo.x + b.logo.width, y0: b.logo.y, y1: b.logo.y + b.logo.height }
    assert.ok(inside(logo, BAND), `logo inside band @ ${aspect}`)
    assert.ok(Math.abs(b.logo.width / b.logo.height - aspect) < 1e-9, 'logo keeps its aspect ratio')
    for (const l of b.lines) assert.ok(l.x >= logo.x1 + 10, 'name never overlaps the logo')
  }
  return b
}

test('SP-11 school band: every logo shape and name length stays inside the band, never overlapping', () => {
  const names = ['ABC School', 'Aditya International School', "St. Xavier's High School & Junior College",
    'Dr. D. Y. Patil International School and Junior College of Science, Pimpri',
    'Shri Swami Vivekanand Shikshan Sanstha Sanchalit Adarsh Vidya Mandir English Medium School Pimpri Chinchwad Pune',
    'Supercalifragilisticexpialidociousinternationalschoolofexcellence']
  for (const name of names) for (const aspect of [null, 1, 0.5, 0.25, 2, 3.3, 6, 12]) checkBand(name, aspect)
})

test('SP-12 school band: the name is sized from the logo, so a bigger logo means a bigger name', () => {
  const square = layoutSchoolHeader('Aditya International School', 1, mono, BAND)
  const flat = layoutSchoolHeader('Aditya International School', 12, mono, BAND)
  assert.ok(flat.logo.height < square.logo.height)
  assert.ok(flat.lines[0].size < square.lines[0].size)
  // ...but a very flat logo never shrinks the name below a readable size.
  assert.ok(flat.lines[0].size >= 10)
})

test('SP-13 school band: long names wrap to two balanced lines; one long word is cut with an ellipsis', () => {
  const two = layoutSchoolHeader('Dr. D. Y. Patil International School and Junior College of Science, Pimpri', 1, mono, BAND)
  assert.equal(two.lines.length, 2)
  assert.equal(two.lines.map(l => l.text.replace('…', '')).join(' ').length > 40, true)
  const word = layoutSchoolHeader('Supercalifragilisticexpialidocious'.repeat(4), 1, mono, BAND)
  assert.equal(word.lines.length, 1)
  assert.ok(word.lines[0].text.endsWith('…'))
  assert.deepEqual(balancedSplit(mono, 'One Two Three Four', 10), ['One Two', 'Three Four'])
})

test('SP-14 school band: the logo + name group is centred; with no logo the name is centred alone', () => {
  for (const aspect of [null, 1, 3]) {
    const b = layoutSchoolHeader('Navodaya Public School', aspect, mono, BAND)
    const left = b.logo ? b.logo.x : b.lines[0].x
    const right = Math.max(...b.lines.map(l => l.x + mono(l.text, l.size)))
    assert.ok(Math.abs((left + right) / 2 - (BAND.x0 + BAND.x1) / 2) < 0.01)
  }
})

test('SP-15 Hindi and Latin are shaped as separate runs (र्म must print as a reph, not र् + म)', () => {
  assert.deepEqual(scriptRuns('Name: आरव शर्मा   Roll No.: 31   Class: UKG B'),
    ['Name: ', 'आरव शर्मा   ', 'Roll No.: 31   Class: UKG B'])
  assert.deepEqual(scriptRuns('आर्यन Kumar'), ['आर्यन ', 'Kumar'])
  assert.deepEqual(scriptRuns('St. Xavier\'s'), ["St. Xavier's"])
  assert.deepEqual(scriptRuns(''), [])
  assert.equal(scriptRuns('Name: आरव शर्मा   Roll No.: 31').join(''), 'Name: आरव शर्मा   Roll No.: 31')
})

test('SP-16 stages: Nursery – Grade 2 Foundational, 3 – 5 Preparatory, 6 and above Middle & Secondary', () => {
  // classResolver ordinals: Pre-Nursery -3, Nursery -2, LKG -1, UKG 0.
  assert.deepEqual([-3, -2, -1, 0, 1, 2].map(stageForGrade), Array(6).fill('foundational'))
  assert.deepEqual([3, 4, 5].map(stageForGrade), Array(3).fill('preparatory'))
  assert.deepEqual([6, 8, 10, 12].map(stageForGrade), Array(4).fill('middleSecondary'))
  assert.equal(stageForGrade(null), null)
  assert.equal(stageForGrade(undefined), null)
  assert.deepEqual(Object.keys(STAGES), ['foundational', 'preparatory', 'middleSecondary'])
})

test('SP-17 Foundational back page: Hindi by default, Marathi on request; Middle unaffected', async () => {
  assert.deepEqual(pagesFor('foundational'), [['foundational', 0], ['foundational', 1]])
  assert.deepEqual(pagesFor('foundational', 'marathi'), [['foundational', 0], ['foundationalMarathi', 0]])
  assert.deepEqual(pagesFor('middle', 'marathi'), [['middle', 0], ['middle', 1]])
  assert.throws(() => pagesFor('foundational', 'tamil'), /back-page language/)

  // The Marathi page has every slot the Hindi back page has.
  assert.deepEqual(Object.keys(LAYOUT.foundationalMarathi.pages[0]).sort(), Object.keys(LAYOUT.foundational.pages[1]).sort())

  const assets = {
    templates: {
      foundational: read('public/pamphlets/foundational.pdf'), middle: read('public/pamphlets/middle.pdf'),
      foundationalMarathi: read('public/pamphlets/foundational-marathi.pdf'),
    },
    fonts: { regular: read('public/fonts/Poppins-Regular.ttf'), bold: read('public/fonts/Poppins-Bold.ttf'), value: read('public/fonts/Inter-Bold.ttf') },
  }
  const bytes = await buildStudentPamphletsPDF({
    schoolName: 'X School', website: 'x.myhpc.app', assets, foundationalBack: 'marathi',
    students: [
      { id: 'x0001', name: 'A', rollNo: '1', className: 'UKG A', design: 'foundational' },
      { id: 'x0002', name: 'B', rollNo: '2', className: 'V A', design: 'middle' },
    ],
  })
  assert.equal((await PDFDocument.load(bytes)).getPageCount(), 4)
})

test("SP-18 blank pamphlets default to 10% of a design's students, rounded up", () => {
  assert.equal(defaultBlankPamphlets(0), 0)       // no students of that design: none
  assert.equal(defaultBlankPamphlets(1), 1)
  assert.equal(defaultBlankPamphlets(10), 1)
  assert.equal(defaultBlankPamphlets(11), 2)
  assert.equal(defaultBlankPamphlets(95), 10)
  assert.equal(defaultBlankPamphlets(221), 23)
})

test('SP-19 inactive, sample/demo/training/test classes and "no class" are not ticked by default', () => {
  assert.equal(classSkipReason({ clazz: 'III', section: 'A', isActive: true }, 'III_A'), null)
  assert.equal(classSkipReason({ clazz: 'III', section: 'B' }, 'III_B'), null)
  assert.equal(classSkipReason({ clazz: 'III', section: 'C', isActive: false }, 'III_C'), 'inactive')
  assert.equal(classSkipReason({ clazz: 'Training', section: 'DEMO', name: 'Training Demo' }, 'Training_DEMO'), 'sample')
  assert.equal(classSkipReason({ name: 'Sample Class' }, 'sample_class'), 'sample')
  assert.equal(classSkipReason(undefined, 'TEST_A'), 'sample')
  assert.equal(classSkipReason(undefined, '__none__'), 'no class')
  // Holding classes named for students who are no longer current.
  for (const name of ['Inactive', 'Left Students', 'Alumni', 'Passed Out', 'Old', 'Archive', 'Transferred', 'Dropouts'])
    assert.equal(classSkipReason({ name }, name.replace(/\s+/g, '_')), 'inactive', name)
  assert.equal(classSkipReason({ name: 'Golden Batch' }, 'Golden'), null)    // "old" inside a word
  // Words that merely contain those letters are real classes.
  assert.equal(classSkipReason({ name: 'Contest Section' }, 'IV_Contest'), null)
  assert.equal(classSkipReason({ name: 'Demonstration School V A' }, 'V_A'), null)
})
