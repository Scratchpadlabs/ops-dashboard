import test from 'node:test'
import assert from 'node:assert/strict'
import { mapImportRowToStudent } from '../src/schemas/studentMapping.js'

test('parent names and government IDs are persisted, not dropped', () => {
  const { payload, dropped } = mapImportRowToStudent({
    student_name: 'Seri Tharuna', father_name: 'Seri Venkat Ram Reddy', mother_name: 'S Indira',
    apaar_id: '255358387329', pen_no: '23127137227',
  }, { classId: 'II_DRDO' })
  assert.equal(payload.fatherName, 'Seri Venkat Ram Reddy')
  assert.equal(payload.motherName, 'S Indira')
  assert.equal(payload.apaarId, '255358387329')
  assert.equal(payload.penNo, '23127137227')
  assert.ok(!dropped.includes('father_name') && !dropped.includes('mother_name'))
})

test('missing parent names and IDs are written as empty strings', () => {
  const { payload } = mapImportRowToStudent({ student_name: 'Ziva Patel' }, { classId: 'II_DRDO' })
  assert.deepEqual([payload.fatherName, payload.motherName, payload.apaarId, payload.penNo], ['', '', '', ''])
})

test('"Not Available" and similar placeholders are not stored as IDs', () => {
  const { payload } = mapImportRowToStudent({ student_name: 'P Aadya Reddy', apaar_id: 'Not Available', pen_no: '-' }, { classId: 'I_DRDO' })
  assert.equal(payload.apaarId, '')
  assert.equal(payload.penNo, '')
})
