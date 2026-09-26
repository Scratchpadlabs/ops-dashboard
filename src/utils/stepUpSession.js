/**
 * Step-up (password re-entry) window, persisted per browser tab.
 *
 * Stored in sessionStorage, so it survives a reload of the same tab but not
 * a new tab or a closed browser, and is tied to the signed-in uid so a
 * different account never inherits it. Pure helpers, so the rules can be
 * tested without a browser.
 */

export const STEP_UP_KEY = 'ops.stepUp'
export const IDLE_LIMIT_MS = 30 * 60 * 1000

/** Last activity time (ms) worth restoring, or null. */
export function restoreStepUp(raw, uid, nowMs, idleLimitMs = IDLE_LIMIT_MS) {
  if (!raw || !uid) return null
  let parsed
  try { parsed = JSON.parse(raw) } catch { return null }
  const at = Number(parsed?.lastActivityAt)
  if (parsed?.uid !== uid || !Number.isFinite(at)) return null
  if (at > nowMs || nowMs - at >= idleLimitMs) return null
  return at
}

export function serializeStepUp(uid, lastActivityAt) {
  return JSON.stringify({ uid, lastActivityAt })
}
