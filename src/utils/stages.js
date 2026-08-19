/**
 * Grade → NEP stage.
 *
 * The `stage` field on a class was never derived: every path that created a
 * class hardcoded 'foundation', so Grade XII classes were written to Firestore
 * as foundational. Stage-keyed configuration (subject templates, per-stage
 * survey questions) cannot work until the value means something.
 *
 * Boundaries come from ops:
 *     foundation   Nursery, LKG, UKG, I, II
 *     prepratory   III, IV, V
 *     middle       VI, VII, VIII
 *     secondary    IX, X, XI, XII
 *
 * Keyed off the resolver's grade ORDINAL rather than the grade token, so it
 * works whatever notation a school writes — `III` and `3` both resolve to 3 —
 * and pre-primary falls out of the same scale (Nursery -2, LKG -1, UKG 0).
 *
 * `stage` is written only by the browser. functions/shared/school_schema.py
 * validates the value against the same STAGES list but never produces one, so
 * this module has no Python twin to keep in step.
 */
import { parseClassValue } from './classResolver.js'

// 'prepratory' is misspelled in production data and stays that way — see
// src/schemas/schoolSchema.js and docs/school-setup-page-spec.md §2.
export const STAGE_FOUNDATION = 'foundation'
export const STAGE_PREPRATORY = 'prepratory'
export const STAGE_MIDDLE = 'middle'
export const STAGE_SECONDARY = 'secondary'

export const STAGE_LABELS = {
  [STAGE_FOUNDATION]: 'Foundational',
  [STAGE_PREPRATORY]: 'Preparatory',
  [STAGE_MIDDLE]: 'Middle',
  [STAGE_SECONDARY]: 'Secondary',
}

/**
 * Stage for a grade ordinal, or null when there is no ordinal to read.
 *
 * Null is deliberate: an unreadable grade must not be silently labelled
 * foundational, which is the bug this module exists to end. Callers decide what
 * to do with "unknown" — they must not treat it as a stage.
 */
export function stageForOrdinal(ordinal) {
  if (ordinal === null || ordinal === undefined || Number.isNaN(Number(ordinal))) return null
  const n = Number(ordinal)
  if (n <= 2) return STAGE_FOUNDATION      // pre-primary is negative, so it lands here
  if (n <= 5) return STAGE_PREPRATORY
  if (n <= 8) return STAGE_MIDDLE
  return STAGE_SECONDARY                    // 9+ — a grade above XII is still not foundational
}

/**
 * Stage for a grade token ("III", "3", "Nursery") or a class id ("III_A").
 *
 * Note the field is `gradeOrdinal`: the JS resolver camel-cases what the Python
 * twin calls `grade_ordinal`.
 */
export function stageForGrade(gradeOrClassId) {
  const parsed = parseClassValue(gradeOrClassId)
  return stageForOrdinal(parsed?.gradeOrdinal ?? null)
}
