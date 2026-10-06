// Run with `npm test` (node's built-in test runner — no extra dependencies).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PDFDocument } from 'pdf-lib'
import {
  designForGrade, displayWebsite, qrTarget, headerText, fitSize, compareStudents,
  guessAppSchool, pamphletFilename, buildStudentPamphletsPDF,
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

test('SP-03 header matches the sample and skips missing parts', () => {
  assert.equal(headerText({ name: 'Aditya Singh', rollNo: '02', className: 'IV Diamond' }),
    'Name: Aditya Singh   Roll No.: 02   Class: IV Diamond')
  assert.equal(headerText({ name: 'A', rollNo: '', className: 'I A' }), 'Name: A   Class: I A')
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
    templates: { foundational: read('public/pamphlets/foundational.pdf'), middle: read('public/pamphlets/middle.pdf') },
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
})
