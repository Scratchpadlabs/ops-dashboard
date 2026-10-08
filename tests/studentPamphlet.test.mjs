// Run with `npm test` (node's built-in test runner — no extra dependencies).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PDFDocument } from 'pdf-lib'
import {
  designForGrade, displayWebsite, qrTarget, headerText, fitSize, compareStudents, layoutHeader, truncateToWidth,
  guessAppSchool, pamphletFilename, buildStudentPamphletsPDF, blankCopies, pagesFor,
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
    for (const key of ['header', 'qr', 'url', 'userId', 'password', 'footer']) assert.ok(p1[key], `${design} ${key}`)
    assert.equal(LAYOUT[design].pages.length, 2)
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

test('SP-11 Foundational back page: Hindi by default, Marathi on request; Middle unaffected', async () => {
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
