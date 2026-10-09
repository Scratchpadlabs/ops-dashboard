// Run with `npm test` (node's built-in test runner — no extra dependencies).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PDFDocument } from 'pdf-lib'
import {
  LAYOUT, layoutName, balancedSplit, schoolRuns, wrapRuns, hasUnprintable,
  defaultPrintedSchool, certificateFilename, buildTeacherCertificatesPDF,
  certificateName, isSampleName, defaultBlankCount, spaceAfterTitle,
} from '../src/utils/teacherCertificatePDF.js'

const read = (p) => new Uint8Array(readFileSync(new URL(`../${p}`, import.meta.url)))
// Width model: every character 0.6 em.
const mono = (t, s) => Array.from(t).length * s * 0.6
const N = LAYOUT.name

test('TC-01 a normal name is one line at the sample size, upper case', () => {
  assert.deepEqual(layoutName('Subhash Koli', mono), [{ text: 'SUBHASH KOLI', size: N.size, dy: 0 }])
  assert.deepEqual(layoutName('  ', mono), [])
})

test('TC-02 a longer name shrinks to fit the rule before it wraps', () => {
  const [line, ...rest] = layoutName('Birat Ranjan Meher Kumar', mono)
  assert.equal(rest.length, 0)
  assert.ok(line.size < N.size && line.size >= N.oneLineMin)
  assert.ok(mono(line.text, line.size) <= N.maxWidth)
})

test('TC-03 a very long name goes on two balanced lines, both inside the rule, first above', () => {
  const lines = layoutName('Dr. Shrimati Annapurna Devi Raghavendra Rao Kulkarni Deshpande', mono)
  assert.equal(lines.length, 2)
  assert.equal(lines[0].size, lines[1].size)
  assert.ok(lines[0].dy < 0 && lines[1].dy === 0)
  for (const l of lines) assert.ok(mono(l.text, l.size) <= N.maxWidth)
  assert.equal(lines.map(l => l.text).join(' '), 'DR. SHRIMATI ANNAPURNA DEVI RAGHAVENDRA RAO KULKARNI DESHPANDE')
})

test('TC-04 one endless word is cut with an ellipsis, never overflowing', () => {
  const [line] = layoutName('X'.repeat(200), mono)
  assert.ok(line.text.endsWith('…'))
  assert.ok(mono(line.text, line.size) <= N.maxWidth)
  assert.deepEqual(balancedSplit(mono, 'ONE TWO THREE FOUR', 10), ['ONE TWO', 'THREE FOUR'])
})

test('TC-05 school line: bold school with its comma, then the year; long schools wrap', () => {
  assert.deepEqual(schoolRuns('Navodaya Central School, Raichur', '2025-26'), [
    { text: 'as part of ', bold: false },
    { text: 'Navodaya Central School, Raichur,', bold: true },
    { text: ' during the academic year 2025-26', bold: false },
  ])
  // A trailing comma typed into the field is not doubled.
  assert.equal(schoolRuns('ABC School,', '2025-26')[1].text, 'ABC School,')
  const w = (t) => t.length * 10
  const lines = wrapRuns(schoolRuns('Navodaya Central School, Raichur', '2025-26'), w, 600)
  assert.ok(lines.length >= 2)
  for (const line of lines) assert.ok(line.at(-1).x + w(line.at(-1).text) <= 600)
  assert.equal(lines.flat().map(p => p.text).join(' '),
    'as part of Navodaya Central School, Raichur, during the academic year 2025-26')
  assert.ok(lines.flat().find(p => p.text === 'Navodaya').bold)
})

test('TC-06 default school is "Name, City" without repeating the city', () => {
  assert.equal(defaultPrintedSchool({ name: 'Navodaya Central School', city: 'Raichur' }), 'Navodaya Central School, Raichur')
  assert.equal(defaultPrintedSchool({ name: 'Sharda English School, Dharur', city: 'Dharur' }), 'Sharda English School, Dharur')
  assert.equal(defaultPrintedSchool({ name: 'ABC School' }), 'ABC School')
})

test('TC-07 helpers: unprintable letters flagged, safe file names', () => {
  assert.equal(hasUnprintable('Asha Rao'), false)
  assert.equal(hasUnprintable('आशा राव'), true)
  assert.equal(certificateFilename('St. Mary/Joseph: School', 'Blank'), 'St. Mary Joseph School - Teacher Certificates - Blank.pdf')
})

test('TC-08 builds one A4 landscape page per teacher, blank names included', async () => {
  const assets = {
    template: read('public/certificates/teacher.png'),
    fonts: { name: read('public/fonts/CinzelDecorative-Regular.ttf'), regular: read('public/fonts/Raleway-Regular.ttf'), bold: read('public/fonts/Raleway-Bold.ttf') },
  }
  const bytes = await buildTeacherCertificatesPDF({
    teachers: [{ name: 'Subhash Koli' }, { name: 'आशा Rao' }, { name: '' }],
    schoolName: 'Navodaya Central School, Raichur', academicYear: '2025-26', assets,
  })
  const doc = await PDFDocument.load(bytes)
  assert.equal(doc.getPageCount(), 3)
  const { width, height } = doc.getPage(0).getSize()
  assert.ok(Math.abs(width - 841.89) < 0.01 && Math.abs(height - 595.28) < 0.01)
})

test('TC-09 "teacher" is dropped from names, with any dash or comma it leaves behind', () => {
  assert.equal(certificateName('Vinaya Teacher'), 'Vinaya')
  assert.equal(certificateName('vinaya teacher'), 'Vinaya'.toLowerCase())
  assert.equal(certificateName('Teacher - Vinaya'), 'Vinaya')
  assert.equal(certificateName('Vinaya Patil, Teacher'), 'Vinaya Patil')
  assert.equal(certificateName('Science Teachers Rekha'), 'Science Rekha')
  assert.equal(certificateName('Teacher'), '')
  // Only the whole word: names that merely contain it are untouched.
  assert.equal(certificateName('Teacherina Rao'), 'Teacherina Rao')
  assert.deepEqual(layoutName('Vinaya Teacher', mono).map(l => l.text), ['VINAYA'])
})

test('TC-10 sample / demo accounts are recognised', () => {
  assert.equal(isSampleName('Sample Teacher'), true)
  assert.equal(isSampleName('sample 2'), true)
  assert.equal(isSampleName('SAMPLE'), true)
  assert.equal(isSampleName('Asha Rao'), false)
  assert.equal(isSampleName('Samplewala Rao'), false)
})

test('TC-11 blank certificate policy brackets, edges included', () => {
  const expect = {
    0: 3, 9: 3,
    10: 5, 19: 5,
    20: 7, 29: 7,
    30: 10, 40: 10,
    41: 12, 48: 12,
    49: 15, 60: 15,
    61: 20, 80: 20,
    81: 25, 100: 25,
    101: 25, 250: 25,   // past the policy: the last count
  }
  for (const [n, blanks] of Object.entries(expect)) assert.equal(defaultBlankCount(Number(n)), blanks, `${n} teachers`)
})

test('TC-12 titles typed without a gap get one: Mr.Siddhesh -> Mr. Siddhesh', () => {
  const cases = {
    'Mr.Siddhesh': 'Mr. Siddhesh',
    'Dr.Siddhesh': 'Dr. Siddhesh',
    'Mrs.Smita': 'Mrs. Smita',
    'Ms.Smita': 'Ms. Smita',
    'MRS.SMITA PATIL': 'MRS. SMITA PATIL',
    'Dr .Smita': 'Dr. Smita',
    'Prof.A.K. Rao': 'Prof. A.K. Rao',
    'Smt.Kavita Teacher': 'Smt. Kavita',
    'Mr. Siddhesh': 'Mr. Siddhesh',      // already right: unchanged
    'Mr Siddhesh': 'Mr Siddhesh',        // no dot: left as typed
    'Amr.Khan': 'Amr.Khan',              // not a title
  }
  for (const [raw, want] of Object.entries(cases)) assert.equal(certificateName(raw), want, raw)
  assert.equal(spaceAfterTitle('Mrs.Smita'), 'Mrs. Smita')
  assert.deepEqual(layoutName('Mr.Siddhesh', mono).map(l => l.text), ['MR. SIDDHESH'])
})
