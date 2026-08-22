/**
 * The shape of a `classes/{classId}.subjects[]` entry.
 *
 * This array is what the teacher app reads to know which subjects a section
 * is taught and how far each has been covered, so its shape has to match what
 * live schools already carry — not an approximation of it. The template below
 * is copied from a real, teacher-populated class doc
 * (SAMARTH DNYANPEETH SAHAYDRI / classes/III_A, subjects[].subjectId
 * "III_English"), which is the reference for the layout:
 *
 *   { subjectId: "III_English", teacherId: "", isCompleted: false,
 *     completedAt: null,
 *     topics: [
 *       { id: "III_English_Term1",    topic: "Term 1 Activity",   isCompleted, completedAt, absentList? },
 *       { id: "III_English_Term2",    topic: "Term 2 Activity",   isCompleted, completedAt },
 *       { id: "III_English_Optional", topic: "Optional Activity", isCompleted, completedAt },
 *     ] }
 *
 * `absentList` is NOT seeded here: in the reference doc it appears only on the
 * topic a teacher has already completed, so it's written by the teacher app at
 * completion time. Seeding an empty one would put a field on fresh docs that
 * real ones don't have until they're used.
 */

// Suffix → the `topic` label that goes with it. Order matters: the array is
// written in this order and the teacher app renders it as-is.
export const TOPIC_TEMPLATE = [
  { suffix: 'Term1', topic: 'Term 1 Activity' },
  { suffix: 'Term2', topic: 'Term 2 Activity' },
  { suffix: 'Optional', topic: 'Optional Activity' },
]

export function defaultTopicsForSubject(subjectId) {
  return TOPIC_TEMPLATE.map(t => ({
    id: `${subjectId}_${t.suffix}`,
    topic: t.topic,
    isCompleted: false,
    completedAt: null,
  }))
}

export function newClassSubjectEntry(subjectId) {
  return {
    subjectId,
    teacherId: '',
    isCompleted: false,
    completedAt: null,
    topics: defaultTopicsForSubject(subjectId),
  }
}

/**
 * Rebuild a class's `subjects[]` for a checked list of subject IDs.
 *
 * CRITICAL: merge, never clobber. An entry that is already attached is kept
 * exactly as stored — its `isCompleted`, `completedAt`, per-topic state and
 * any `absentList` the teacher app has written are real progress data and are
 * not regenerated from the template.
 */
export function mergeClassSubjects(existingSubjects, checkedSubjectIds) {
  const existingById = new Map((existingSubjects || []).filter(Boolean).map(s => [s.subjectId, s]))
  return checkedSubjectIds.map(subjectId => existingById.get(subjectId) || newClassSubjectEntry(subjectId))
}

/** Append subject IDs that aren't attached yet, leaving existing entries alone. */
export function appendClassSubjects(existingSubjects, subjectIds) {
  const existing = (existingSubjects || []).filter(Boolean)
  const have = new Set(existing.map(s => s.subjectId))
  const additions = subjectIds.filter(id => !have.has(id)).map(newClassSubjectEntry)
  return additions.length ? [...existing, ...additions] : null
}

/** Remove one subject from a class's `subjects[]`; null when it wasn't there. */
export function detachClassSubject(existingSubjects, subjectId) {
  const existing = (existingSubjects || []).filter(Boolean)
  const next = existing.filter(s => s.subjectId !== subjectId)
  return next.length === existing.length ? null : next
}
