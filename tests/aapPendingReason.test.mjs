import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rowReason, studentReason } from '../src/utils/aapCompletionExport.js'

const gap = (missing, extra = {}) => ({ studentId: 's', studentName: 'S', missing, ...extra })

test('complete rows have no reason', () => {
  assert.equal(rowReason({ status: 'complete', gaps: [] }), '')
})

test('taught but not started names the date', () => {
  assert.match(rowReason({ status: 'not_started', taught: true, completedAt: '2026-09-29T05:11:48Z' }),
    /marked as taught on 29 Sept, but the teacher has not started the survey/)
})

test('teacher stopped after question 1', () => {
  const r = { status: 'partial', expectedStudents: 3, respondedStudents: 1, notApplicable: 1,
    gaps: [gap(['sensitivity', 'creativity']), gap(['sensitivity', 'creativity'])] }
  assert.match(rowReason(r), /filled only Question 1 \(Awareness\) and stopped/)
})

test('new students are explained separately', () => {
  const r = { status: 'partial', expectedStudents: 30, respondedStudents: 28, notApplicable: 0,
    gaps: [gap(['awareness', 'sensitivity', 'creativity'], { addedAfterSurvey: true, addedAt: '2026-09-24T07:10:10Z' }),
      gap(['awareness', 'sensitivity', 'creativity'], { addedAfterSurvey: true, addedAt: '2026-09-24T07:10:10Z' })] }
  assert.equal(rowReason(r), '2 students joined the class on 24 Sept, after the survey was done. The teacher needs to rate them.')
  assert.match(studentReason(r, r.gaps[0]), /^New student: joined the class on 24 Sept/)
})

test('student missing only some questions', () => {
  assert.equal(studentReason({ status: 'partial' }, gap(['creativity'])),
    'The teacher filled Question 1 (Awareness) and Question 2 (Sensitivity) but has not filled Question 3 (Creativity) yet.')
})
