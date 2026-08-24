/**
 * Which NEP stage a class belongs to, from its grade ordinal.
 *
 * The four stage literals are fixed by the schema (STAGES in
 * src/schemas/schoolSchema.js) and include the "prepratory" misspelling that
 * is live in production data — correcting it breaks the teacher app, so it is
 * kept deliberately.
 *
 * Ordinals follow classResolver: Pre-Nursery -3, Nursery -2, LKG -1, UKG 0,
 * grades 1..12 = 1..12. The foundational stage covers pre-primary through
 * grade 2, which is why the lower bound is open-ended rather than 1.
 *
 * No imports on purpose — scripts/migrate-class-stage.mjs loads this file
 * directly under plain Node, so it must stay dependency-free.
 */
export const FOUNDATION = 'foundation'
export const PREPARATORY = 'prepratory'
export const MIDDLE = 'middle'
export const SECONDARY = 'secondary'

/**
 * @param {number|null} gradeOrdinal as returned by classResolver
 * @returns {string|null} a STAGES literal, or null when the grade is unknown —
 *   callers must not invent a stage for a class they could not read.
 */
export function stageForGrade(gradeOrdinal) {
  if (typeof gradeOrdinal !== 'number' || Number.isNaN(gradeOrdinal)) return null
  if (gradeOrdinal <= 2) return FOUNDATION
  if (gradeOrdinal <= 5) return PREPARATORY
  if (gradeOrdinal <= 8) return MIDDLE
  if (gradeOrdinal <= 12) return SECONDARY
  return null
}
