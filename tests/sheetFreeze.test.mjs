// Run with `npm test` (node's built-in test runner — no extra dependencies).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SHEET_TYPES, sheetType, rowKeyFor, buildRows, idsToWrite, chunk, applyFrozen, sortRows,
} from '../src/utils/sheetFreeze.js'

const classes = [
  { id: 'c6a', name: '6 A', subjects: [{ subjectId: 'math' }, { subjectId: 'sci' }] },
  { id: 'c6b', name: '6 B', subjects: [{ subjectId: 'math' }] },
  { id: 'c7a', name: '7 A' }, // no subjects field at all
]
const doc = (id, data) => ({ id, data })
const ts = ms => ({ toMillis: () => ms, toDate: () => new Date(ms) })

test('FZ-01 the four sheet types map to the collections the teacher app writes', () => {
  assert.deepEqual(SHEET_TYPES.map(t => [t.key, t.collection, t.termScoped]), [
    ['academics', 'smart_sheet_entries', true],
    ['co-scholastic', 'smart_sheet_entries', true],
    ['attendance', 'attendance_sheets', false],
    ['remarks', 'remarks_sheets', false],
  ])
  assert.throws(() => sheetType('nope'))
})

test('FZ-02 academics and co-scholastic share a collection but never claim each other’s sheets', () => {
  const ac = { classId: 'c6a', termId: 't1', subjectId: 'math' }
  const cs = { type: 'co-scholastic', classId: 'c6a', termId: 't1' }
  assert.equal(rowKeyFor('academics', ac), 'c6a__math')
  assert.equal(rowKeyFor('academics', cs), null)
  assert.equal(rowKeyFor('co-scholastic', cs), 'c6a')
  assert.equal(rowKeyFor('co-scholastic', ac), null)
  // a co-scholastic doc that somehow carries a subjectId is still co-scholastic
  assert.equal(rowKeyFor('academics', { ...cs, subjectId: 'math' }), null)
})

test('FZ-03 docs without a classId are ignored', () => {
  for (const t of SHEET_TYPES) assert.equal(rowKeyFor(t.key, { isFrozen: true }), null)
  assert.equal(rowKeyFor('academics', null), null)
})

test('FZ-04 academics: one row per class subject, sheets matched, unopened ones marked not started', () => {
  const rows = buildRows('academics', classes, [
    doc('s1', { classId: 'c6a', termId: 't1', subjectId: 'math', isFrozen: true }),
    doc('cs', { type: 'co-scholastic', classId: 'c6a', termId: 't1' }),
  ])
  assert.deepEqual(rows.map(r => r.key), ['c6a__math', 'c6a__sci', 'c6b__math'])
  const [m, s] = rows
  assert.equal(m.exists, true); assert.equal(m.isFrozen, true); assert.deepEqual(m.sheets, [{ id: 's1', isFrozen: true }])
  assert.equal(s.exists, false); assert.equal(s.isFrozen, false); assert.deepEqual(s.sheets, [])
})

test('FZ-05 co-scholastic, attendance and remarks: one row per class, including classes with no subjects', () => {
  for (const k of ['co-scholastic', 'attendance', 'remarks']) {
    assert.deepEqual(buildRows(k, classes, []).map(r => r.key), ['c6a', 'c6b', 'c7a'])
  }
})

test('FZ-06 duplicate sheets for one class are grouped into one row and all frozen together', () => {
  const rows = buildRows('remarks', classes, [
    doc('r1', { classId: 'c6a', isFrozen: true }),
    doc('r2', { classId: 'c6a' }),
    doc('r3', { classId: 'c6a', isFrozen: false }),
  ])
  const r = rows.find(x => x.key === 'c6a')
  assert.equal(r.sheets.length, 3)
  assert.equal(r.isFrozen, false)
  assert.equal(r.partlyFrozen, true)
  assert.deepEqual(idsToWrite([r], true).sort(), ['r2', 'r3'])
  assert.deepEqual(idsToWrite([r], false), ['r1'])
})

test('FZ-07 attendance: month-wise and every day-wise month of a class are one row', () => {
  const rows = buildRows('attendance', classes, [
    doc('c6a__month-wise', { classId: 'c6a', type: 'month-wise' }),
    doc('c6a__day-wise__2026-06', { classId: 'c6a', type: 'day-wise', month: '2026-06' }),
    doc('c6a__day-wise__2026-07', { classId: 'c6a', type: 'day-wise', month: '2026-07', isFrozen: true }),
    doc('legacy', { classId: 'c6a' }), // real data: older sheets with no type/month
  ])
  const r = rows.find(x => x.key === 'c6a')
  assert.equal(r.sheets.length, 4)
  assert.deepEqual(idsToWrite([r], true).sort(), ['c6a__day-wise__2026-06', 'c6a__month-wise', 'legacy'])
})

test('FZ-08 isFrozen must be exactly true — truthy junk is treated as not frozen (matches the teacher app)', () => {
  const rows = buildRows('remarks', classes, [doc('r1', { classId: 'c6a', isFrozen: 'yes' }), doc('r2', { classId: 'c6b', isFrozen: 1 })])
  assert.equal(rows.find(r => r.key === 'c6a').isFrozen, false)
  assert.equal(rows.find(r => r.key === 'c6b').isFrozen, false)
  // and freezing rewrites them to a real boolean
  assert.deepEqual(idsToWrite(rows, true).sort(), ['r1', 'r2'])
})

test('FZ-09 sheets for a class/subject no longer set up still get a row, so they can be unfrozen', () => {
  const rows = buildRows('academics', classes, [
    doc('old1', { classId: 'c6b', termId: 't1', subjectId: 'art', isFrozen: true }),
    doc('old2', { classId: 'gone', termId: 't1', subjectId: 'math', isFrozen: true }),
  ])
  const orphan = rows.filter(r => !r.configured)
  assert.deepEqual(orphan.map(r => [r.key, r.classId, r.subjectId]), [['c6b__art', 'c6b', 'art'], ['gone__math', 'gone', 'math']])
  assert.ok(rows.filter(r => r.configured).every(r => r.configured === true))
  assert.deepEqual(idsToWrite(orphan, false).sort(), ['old1', 'old2'])

  const rm = buildRows('remarks', classes, [doc('x', { classId: 'deleted' })])
  assert.equal(rm.find(r => r.key === 'deleted').configured, false)
  assert.equal(rm.find(r => r.key === 'deleted').subjectId, null)
})

test('FZ-10 last edited = the most recent edit across a row’s duplicate sheets', () => {
  const rows = buildRows('co-scholastic', classes, [
    doc('a', { type: 'co-scholastic', classId: 'c6a', lastEditedAt: ts(100), lastEditedBy: 'T1' }),
    doc('b', { type: 'co-scholastic', classId: 'c6a', lastEditedAt: ts(300), lastEditedBy: 'T2' }),
    doc('c', { type: 'co-scholastic', classId: 'c6a', lastEditedAt: null, lastEditedBy: '' }),
  ])
  const r = rows.find(x => x.key === 'c6a')
  assert.equal(r.lastEditedBy, 'T2')
  assert.equal(r.lastEditedAt.toMillis(), 300)
  const none = rows.find(x => x.key === 'c6b')
  assert.equal(none.lastEditedAt, null); assert.equal(none.lastEditedBy, null)
})

test('FZ-11 last edited handles Timestamps, Dates, ISO strings and garbage', () => {
  const rows = buildRows('remarks', [{ id: 'c' }], [
    doc('a', { classId: 'c', lastEditedAt: new Date(500), lastEditedBy: 'date' }),
    doc('b', { classId: 'c', lastEditedAt: '1970-01-01T00:00:01Z', lastEditedBy: 'iso' }),
    doc('d', { classId: 'c', lastEditedAt: 'not a date', lastEditedBy: 'junk' }),
  ])
  assert.equal(rows[0].lastEditedBy, 'iso')
})

test('FZ-12 idsToWrite skips no-op docs, rows that don’t exist, and de-duplicates', () => {
  const rows = buildRows('academics', classes, [
    doc('s1', { classId: 'c6a', termId: 't1', subjectId: 'math', isFrozen: true }),
    doc('s2', { classId: 'c6a', termId: 't1', subjectId: 'sci' }),
  ])
  assert.deepEqual(idsToWrite(rows, true), ['s2'])
  assert.deepEqual(idsToWrite(rows, false), ['s1'])
  assert.deepEqual(idsToWrite([rows[0], rows[0]], false), ['s1'])
  assert.deepEqual(idsToWrite([], true), [])
})

test('FZ-13 chunk keeps batches under Firestore’s 500-write limit', () => {
  const ids = Array.from({ length: 1001 }, (_, i) => `s${i}`)
  const parts = chunk(ids)
  assert.deepEqual(parts.map(p => p.length), [450, 450, 101])
  assert.deepEqual(parts.flat(), ids)
  assert.deepEqual(chunk([]), [])
  assert.throws(() => chunk([1], 0))
})

test('FZ-14 applyFrozen updates row state after a write (full, partial, untouched rows)', () => {
  const rows = buildRows('remarks', classes, [
    doc('r1', { classId: 'c6a' }), doc('r2', { classId: 'c6a' }), doc('r3', { classId: 'c6b', isFrozen: true }),
  ])
  applyFrozen(rows, ['r1'], true)
  const a = rows.find(r => r.key === 'c6a')
  assert.equal(a.partlyFrozen, true); assert.equal(a.isFrozen, false)
  applyFrozen(rows, ['r2'], true)
  assert.equal(a.partlyFrozen, false); assert.equal(a.isFrozen, true)
  assert.equal(rows.find(r => r.key === 'c6b').isFrozen, true)
  applyFrozen(rows, ['r1', 'r2', 'r3'], false)
  assert.ok(rows.every(r => !r.isFrozen && !r.partlyFrozen))
  // rows with no sheets stay not-frozen
  assert.equal(rows.find(r => r.key === 'c7a').isFrozen, false)
})

test('FZ-15 rows sort by class name naturally (6 A before 10 A), then subject', () => {
  const cls = [{ id: 'x10', name: '10 A', subjects: [{ subjectId: 'b' }, { subjectId: 'a' }] }, { id: 'x6', name: '6 A', subjects: [{ subjectId: 'a' }] }]
  const names = { x10: '10 A', x6: '6 A' }
  const sorted = sortRows(buildRows('academics', cls, []), id => names[id] ?? id, id => id)
  assert.deepEqual(sorted.map(r => r.key), ['x6__a', 'x10__a', 'x10__b'])
})

test('FZ-16 bad subject entries on a class don’t produce broken rows', () => {
  const rows = buildRows('academics', [{ id: 'c', subjects: [null, {}, { subjectId: '' }, { subjectId: 'ok' }] }], [])
  assert.deepEqual(rows.map(r => r.key), ['c__ok'])
})

test('FZ-17 sheets with an editor but no lastEditedAt still show who edited (as before)', () => {
  const rows = buildRows('academics', classes, [
    doc('a', { classId: 'c6a', termId: 't1', subjectId: 'math', lastEditedBy: '' }),
    doc('b', { classId: 'c6a', termId: 't1', subjectId: 'math', lastEditedBy: 'T1' }),
  ])
  assert.equal(rows[0].lastEditedBy, 'T1')
  assert.equal(rows[0].lastEditedAt, null)
  // a timestamped edit still beats an untimestamped one
  const r2 = buildRows('remarks', classes, [
    doc('x', { classId: 'c6a', lastEditedBy: 'OLD' }),
    doc('y', { classId: 'c6a', lastEditedBy: 'NEW', lastEditedAt: ts(5) }),
  ])
  assert.equal(r2.find(r => r.key === 'c6a').lastEditedBy, 'NEW')
})
