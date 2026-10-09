// Run with `npm test` (node's built-in test runner — no extra dependencies).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normName, normId, parseRosterRows, matchRoster, duplicateScholarNos } from '../src/utils/rosterMatch.js'

// Simple class key for tests: "III - A" / "III_A" / "iii a" → "IIIA".
const key = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '')

test('RM-01 names compare without titles, case, spacing or punctuation', () => {
  assert.equal(normName('MISS  Anushka  Ninama'), 'ANUSHKA NINAMA')
  assert.equal(normName('MAS. AARYAN GANDHI'), 'AARYAN GANDHI')
  assert.equal(normName('Master Rohan'), 'ROHAN')
  assert.equal(normName('Masood Khan'), 'MASOOD KHAN')   // not a title
  assert.equal(normId('r-4490'), 'R4490')
})

test('RM-02 reads the sectioned school layout: CLASS line, header, students', () => {
  const rows = [
    [], ['CLASS NURSERY  A'],
    ['SN', 'NAME OF STUDENT', 'GENDER', 'DOB', 'SC.NO.'],
    ['1', 'MISS ANUSHKA NINAMA', 'FEMALE', '27/01/2023', 'R-4490'],
    ['2', 'MAS. RIYAN JAIN', 'MALE', '', 'R-4491'],
    [], ['CLASS III - A'],
    ['SN', 'NAME OF STUDENT', 'GENDER', 'DOB', 'SC.NO.'],
    ['1', 'MISS ASHA RAO', 'FEMALE', '', 'L-1'],
  ]
  const out = parseRosterRows(rows)
  assert.deepEqual(out.map(s => [s.name, s.className, s.scholarNo]), [
    ['MISS ANUSHKA NINAMA', 'NURSERY A', 'R-4490'],
    ['MAS. RIYAN JAIN', 'NURSERY A', 'R-4491'],
    ['MISS ASHA RAO', 'III - A', 'L-1'],
  ])
})

test('RM-03 reads a flat sheet with Class and Section columns', () => {
  const out = parseRosterRows([
    ['Roll No', 'Student Name', 'Class', 'Section', 'Adm No'],
    ['1', 'Asha Rao', 'III', 'A', '501'],
  ])
  assert.deepEqual(out.map(s => [s.name, s.className, s.scholarNo, s.rollNo]), [['Asha Rao', 'III A', '501', '1']])
})

test('RM-04 matches by scholar no, then name + class, then unique name; the rest is reported', () => {
  const file = [
    { name: 'MISS ANUSHKA NINAMA', className: 'NURSERY A', scholarNo: 'R-4490' },
    { name: 'MAS. RIYAN JAIN', className: 'NURSERY A', scholarNo: '' },
    { name: 'MISS ASHA RAO', className: 'IV - A', scholarNo: '' },       // moved class
    { name: 'NEW CHILD', className: 'I A', scholarNo: 'X-1' },            // not in system
  ]
  const system = [
    { id: 's1', name: 'Anushka Ninama', currentClassId: 'Nursery_A', admNo: 'R4490' },
    { id: 's2', name: 'Riyan Jain', currentClassId: 'NURSERY A' },
    { id: 's3', name: 'Asha Rao', currentClassId: 'III_A' },
    { id: 's4', name: 'Old Student', currentClassId: 'V_B' },             // stale
  ]
  const r = matchRoster(file, system, key)
  assert.deepEqual(r.matched.map(m => [m.system.id, m.by]), [['s1', 'scholar no'], ['s2', 'name + class']])
  assert.deepEqual(r.classChanged.map(m => [m.system.id, m.by]), [['s3', 'name']])
  assert.deepEqual(r.notInFile.map(s => s.id), ['s4'])
  assert.deepEqual(r.notInSystem.map(f => f.name), ['NEW CHILD'])
})

test('RM-05 a name shared by two students is never matched on name alone', () => {
  const file = [{ name: 'Ravi Kumar', className: 'V A' }]
  const system = [
    { id: 'a', name: 'Ravi Kumar', currentClassId: 'VI_A' },
    { id: 'b', name: 'Ravi Kumar', currentClassId: 'VII_A' },
  ]
  const r = matchRoster(file, system, key)
  assert.equal(r.matched.length + r.classChanged.length, 0)
  assert.equal(r.notInFile.length, 2)
})

test('RM-06 duplicate students in the system: only one matches, the duplicate is left over', () => {
  const file = [{ name: 'Asha Rao', className: 'III A' }]
  const system = [
    { id: 'a', name: 'Asha Rao', currentClassId: 'III_A' },
    { id: 'b', name: 'ASHA  RAO', currentClassId: 'III A' },
  ]
  const r = matchRoster(file, system, key)
  assert.equal(r.matched.length, 1)
  assert.equal(r.notInFile.length, 1)
})

test('RM-07 duplicate scholar numbers in the school file are reported', () => {
  const dups = duplicateScholarNos([
    { name: 'A', scholarNo: 'L-3054' }, { name: 'B', scholarNo: 'L 3054' }, { name: 'C', scholarNo: 'L-1' },
  ])
  assert.equal(dups.length, 1)
  assert.deepEqual(dups[0].map(f => f.name), ['A', 'B'])
})

test('RM-08 a scholar number the school file gives two children is not trusted; names decide', () => {
  const file = [
    { name: 'MAS. HARSH GAWLI', className: 'IV - A', scholarNo: 'L-3055' },
    { name: 'MAS. RIDHAAN RAJORA', className: 'IV - A', scholarNo: 'L-3055' },
  ]
  const system = [
    { id: 'h', name: 'Harsh Gawli', currentClassId: 'IV_A' },
    { id: 'r', name: 'Ridhaan Rajora', currentClassId: 'IV_A', admNo: 'L3055' },
  ]
  const r = matchRoster(file, system, key)
  assert.deepEqual(r.matched.map(m => [normName(m.file.name), m.system.id]).sort(), [['HARSH GAWLI', 'h'], ['RIDHAAN RAJORA', 'r']])
  assert.equal(r.notInFile.length, 0)
})

test('RM-09 same scholar number but no name in common is a typo, not a match', () => {
  const r = matchRoster([{ name: 'Asha Rao', className: 'I A', scholarNo: '77' }],
    [{ id: 'x', name: 'Vikram Singh', currentClassId: 'I_A', admNo: '77' }], key)
  assert.equal(r.matched.length, 0)
  assert.deepEqual(r.notInFile.map(s => s.id), ['x'])
})
