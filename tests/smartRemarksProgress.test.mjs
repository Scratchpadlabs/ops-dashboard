// Run with `npm test` (node's built-in test runner — no extra dependencies).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  RUN_STATUS, jobProgress, overallProgress, etaMs, formatDuration, preflightVerdict, mapLimit,
} from '../src/utils/smartRemarksProgress.js'

const ts = ms => ({ toMillis: () => ms })

test('SP-01 job progress counts remarks when the function reports them', () => {
  assert.deepEqual(jobProgress({ totalRemarks: 40, processedRemarks: 10, totalStudents: 20, processedStudents: 3 }),
    { done: 10, total: 40, unit: 'remarks', pct: 25 })
})

test('SP-02 an older function (students only) still gives a bar', () => {
  assert.deepEqual(jobProgress({ totalStudents: 20, processedStudents: 5 }), { done: 5, total: 20, unit: 'students', pct: 25 })
  assert.equal(jobProgress(null).pct, null)
})

test('SP-03 a class with nothing to write is complete once done', () => {
  assert.equal(jobProgress({ totalRemarks: 0, processedRemarks: 0, status: 'done' }).pct, 100)
})

test('SP-04 overall progress: finished classes count whole, the running one by fraction, skipped not at all', () => {
  const items = [
    { status: RUN_STATUS.DONE },
    { status: RUN_STATUS.FAILED },
    { status: RUN_STATUS.RUNNING, job: { totalRemarks: 10, processedRemarks: 5 } },
    { status: RUN_STATUS.QUEUED },
    { status: RUN_STATUS.SKIPPED },
  ]
  assert.equal(overallProgress(items), 63) // (1 + 1 + 0.5 + 0) / 4
  assert.equal(overallProgress([]), 0)
})

test('SP-05 ETA extrapolates from the job’s own pace', () => {
  const job = { startedAt: ts(0), totalRemarks: 10, processedRemarks: 2 }
  assert.equal(etaMs(job, 20_000), 80_000)
  assert.equal(etaMs({ ...job, processedRemarks: 0 }, 20_000), null)
  assert.equal(etaMs({ ...job, processedRemarks: 10 }, 20_000), null)
})

test('SP-06 durations read naturally', () => {
  assert.equal(formatDuration(5_000), '5s')
  assert.equal(formatDuration(65_000), '1m 05s')
  assert.equal(formatDuration(3_720_000), '1h 2m')
  assert.equal(formatDuration(null), '')
})

test('SP-07 preflight leaves out classes with nothing to generate, and says why', () => {
  assert.deepEqual(preflightVerdict({ band: 'Middle', sheetFound: true, tickedStudents: 3 }), { include: true, reason: '' })
  assert.equal(preflightVerdict({ band: null, categories: [] }).include, false)
  assert.match(preflightVerdict({ band: 'Middle', sheetFound: false }).reason, /No remarks sheet/)
  assert.match(preflightVerdict({ band: 'Middle', sheetFound: true, tickedStudents: 0, unmatchedTicks: 4 }).reason, /match no/)
})

test('SP-08 mapLimit keeps order and never exceeds the limit', async () => {
  let inFlight = 0
  let peak = 0
  const out = await mapLimit([30, 10, 20, 5, 1], 2, async (ms, i) => {
    inFlight++; peak = Math.max(peak, inFlight)
    await new Promise(r => setTimeout(r, ms))
    inFlight--
    return i
  })
  assert.deepEqual(out, [0, 1, 2, 3, 4])
  assert.equal(peak, 2)
})
