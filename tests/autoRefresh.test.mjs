// Run with `npm test` (node's built-in test runner — no extra dependencies).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldRefresh } from '../src/composables/useAutoRefresh.js'
import { restoreStepUp, serializeStepUp, IDLE_LIMIT_MS } from '../src/utils/stepUpSession.js'

const base = { nowMs: 10 * 60_000, lastMs: 0, gapMs: 5 * 60_000, visible: true, busy: false, blocked: false }

test('AR-01 refreshes once the gap has passed, only when visible and not busy', () => {
  assert.equal(shouldRefresh(base), true)
  assert.equal(shouldRefresh({ ...base, lastMs: 6 * 60_000 }), false)
  assert.equal(shouldRefresh({ ...base, visible: false }), false)
  assert.equal(shouldRefresh({ ...base, busy: true }), false)
  assert.equal(shouldRefresh({ ...base, blocked: true }), false)
})

test('SU-01 a reload inside 30 minutes restores the step-up window for the same user', () => {
  const raw = serializeStepUp('u1', 1_000)
  assert.equal(restoreStepUp(raw, 'u1', 1_000 + IDLE_LIMIT_MS - 1), 1_000)
})

test('SU-02 expired, other-user, future or garbled windows are not restored', () => {
  const raw = serializeStepUp('u1', 1_000)
  assert.equal(restoreStepUp(raw, 'u1', 1_000 + IDLE_LIMIT_MS), null)
  assert.equal(restoreStepUp(raw, 'u2', 2_000), null)
  assert.equal(restoreStepUp(raw, null, 2_000), null)
  assert.equal(restoreStepUp(raw, 'u1', 500), null)
  assert.equal(restoreStepUp('{nope', 'u1', 2_000), null)
  assert.equal(restoreStepUp(null, 'u1', 2_000), null)
})
