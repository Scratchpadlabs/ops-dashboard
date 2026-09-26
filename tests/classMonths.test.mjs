// Run with `npm test` (node's built-in test runner — no extra dependencies).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildAcademicYear, buildColumns, indexMonths, editsToRows, rowsForMonths, cellId, compareClasses, toCsvRows,
} from '../src/utils/classMonths.js'

const apr = { key: '2026-04', label: 'April 2026', month: 4, year: 2026, order: 1, workingDays: 22 }
const may = { key: '2026-05', label: 'May 2026', month: 5, year: 2026, order: 2, workingDays: 20 }
const classes = [
  { id: 'c10', name: 'Class 10', months: [apr] },
  { id: 'c9', name: 'Class 9', months: [apr, may] },
  { id: 'c1', name: 'Class 1', months: [] },
]

test('CM-01 academic year wraps into the next calendar year', () => {
  const months = buildAcademicYear({ startMonth: 11, startYear: 2026, span: 3 })
  assert.deepEqual(months.map(m => [m.key, m.label, m.order]), [
    ['2026-11', 'November 2026', 1], ['2026-12', 'December 2026', 2], ['2027-01', 'January 2027', 3],
  ])
})

test('CM-02 columns are the union of every class’s months, in key order', () => {
  assert.deepEqual(buildColumns(classes).map(c => c.key), ['2026-04', '2026-05'])
})

test('CM-03 an edit on an existing month keeps its doc; on a missing month borrows the column', () => {
  const existing = indexMonths(classes)
  const rows = editsToRows({ [cellId('c10', '2026-04')]: 18, [cellId('c10', '2026-05')]: 21, [cellId('c1', '2026-04')]: null },
    existing, buildColumns(classes))
  assert.deepEqual(rows, [
    { classId: 'c10', ...apr, workingDays: 18 },
    { classId: 'c10', ...may, workingDays: 21 },
  ])
})

test('CM-04 regenerating months keeps typed working days unless told to overwrite', () => {
  const existing = indexMonths(classes)
  const year = buildAcademicYear({ startMonth: 4, startYear: 2026, span: 2 })
  const kept = rowsForMonths(year, ['c9', 'c1'], existing)
  assert.deepEqual(kept.map(r => [r.classId, r.key, r.workingDays]), [
    ['c9', '2026-04', 22], ['c9', '2026-05', 20], ['c1', '2026-04', 22], ['c1', '2026-05', 22],
  ])
  const over = rowsForMonths(year, ['c9'], existing, { overwriteWorkingDays: true, defaultWorkingDays: 25 })
  assert.deepEqual(over.map(r => r.workingDays), [25, 25])
})

test('CM-05 copying a class’s months carries its working days', () => {
  const rows = rowsForMonths([may], ['c1'], indexMonths(classes))
  assert.deepEqual(rows, [{ classId: 'c1', ...may }])
})

test('CM-06 classes sort numerically, and CSV rows follow that order', () => {
  assert.deepEqual([...classes].sort(compareClasses).map(c => c.id), ['c1', 'c9', 'c10'])
  assert.deepEqual(toCsvRows(classes).map(r => `${r.classId}:${r.key}`), ['c9:2026-04', 'c9:2026-05', 'c10:2026-04'])
})
