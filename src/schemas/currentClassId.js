/**
 * currentClassId validation — the one field where live data is actually broken.
 *
 * AUDIT.md §2.3, from the 2026-08-04 dump:
 *   A K CSchool    currentClassId = "sakc0001"   ← a STUDENT ID
 *   Carmel Convent currentClassId = "sccs0001"   ← a STUDENT ID
 *   Aravali        currentClassId = "III"        ← grade only, 3 sections exist
 *   GK Gurukul     currentClassId = "V_Sample"   ← parking sentinel
 *
 * Parsing is delegated to utils/classResolver.js — the shared resolver that
 * functions/shared/class_resolver.py mirrors. Two earlier independent class
 * parsers in this repo were deleted for exactly the failures above; this module
 * adds rules ON TOP of the resolver and never re-implements it.
 *
 * Mirrored in functions/shared/school_schema.py (validate_current_class_id).
 */
import { parseClassValue, looksLikeSentinel } from '../utils/classResolver.js'
import { PERSON_ID_RE } from './schoolSchema.js'

export const REASON_EMPTY = 'empty'
export const REASON_PERSON_ID = 'person_id'
export const REASON_SELF_ID = 'self_id'
export const REASON_UNRESOLVABLE = 'unresolvable'
export const REASON_GRADE_ONLY = 'grade_only'
export const REASON_UNKNOWN_CLASS = 'unknown_class'
export const REASON_SENTINEL = 'sentinel'

/**
 * @param {string} value            the currentClassId about to be written
 * @param {Object} [ctx]
 * @param {string} [ctx.studentId]  the student's own doc ID — a value equal to
 *                                  it is the exact A K / Carmel corruption
 * @param {string[]} [ctx.classIds] the school's configured class doc IDs
 * @returns {{ok: boolean, reason: string|null, message: string,
 *            severity: 'error'|'warning'|null, parsed: Object|null}}
 */
export function validateCurrentClassId(value, ctx = {}) {
  const raw = String(value ?? '').trim()
  const ok = { ok: true, reason: null, message: '', severity: null, parsed: null }

  if (!raw) {
    return { ok: false, reason: REASON_EMPTY, severity: 'error', parsed: null,
      message: 'currentClassId is empty' }
  }

  // A student ID where a class ID belongs. Checked before parsing: "sakc0001"
  // would otherwise fall out as merely unrecognised, and the specific message
  // is what tells an ops user this is a mapping bug, not a naming quirk.
  if (ctx.studentId && raw === String(ctx.studentId).trim()) {
    return { ok: false, reason: REASON_SELF_ID, severity: 'error', parsed: null,
      message: `currentClassId "${raw}" is the student's own ID, not a class` }
  }
  if (PERSON_ID_RE.test(raw)) {
    return { ok: false, reason: REASON_PERSON_ID, severity: 'error', parsed: null,
      message: `currentClassId "${raw}" looks like a student/staff ID, not a class` }
  }

  const parsed = parseClassValue(raw)

  if (parsed.gradeOrdinal === null) {
    return { ok: false, reason: REASON_UNRESOLVABLE, severity: 'error', parsed,
      message: `currentClassId "${raw}" does not resolve to a grade — confirm it in Class Map first` }
  }

  // Grade-only. Aravali stores "III" while running III_A1/A2/A3 — there is no
  // way to pick a section, so this must be rejected rather than guessed.
  if (!parsed.section) {
    return { ok: false, reason: REASON_GRADE_ONLY, severity: 'error', parsed,
      message: `currentClassId "${raw}" has a grade but no section — a section is required` }
  }

  // Beyond this point the value is structurally valid. The remaining checks
  // are advisory: they describe the school's configuration, not the value.
  if (looksLikeSentinel(raw)) {
    return { ok: true, reason: REASON_SENTINEL, severity: 'warning', parsed,
      message: `currentClassId "${raw}" looks like a placeholder/parking class` }
  }

  if (Array.isArray(ctx.classIds) && ctx.classIds.length && !ctx.classIds.includes(raw)) {
    return { ok: true, reason: REASON_UNKNOWN_CLASS, severity: 'warning', parsed,
      message: `currentClassId "${raw}" is not one of this school's configured classes` }
  }

  return { ...ok, parsed }
}

/** Group a roster's problems by reason — powers the integrity report. */
export function summarizeClassIdIssues(students, ctx = {}) {
  const buckets = new Map()
  for (const s of students || []) {
    const r = validateCurrentClassId(s.currentClassId, { ...ctx, studentId: s.id })
    if (r.ok && !r.reason) continue
    const key = r.reason
    const row = buckets.get(key) || { reason: key, severity: r.severity, count: 0, message: r.message, samples: [] }
    row.count++
    if (row.samples.length < 5) row.samples.push({ studentId: s.id, value: s.currentClassId })
    buckets.set(key, row)
  }
  return Array.from(buckets.values()).sort((a, b) => b.count - a.count)
}
