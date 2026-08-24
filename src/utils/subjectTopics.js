/**
 * `subjects/{id}.topics` — survey/topic machinery consumed by the teacher
 * app's survey module. Every subject is expected to carry exactly these
 * three entries (docs/school-setup-page-spec.md §2 calls it read-only
 * "survey/topic machinery"; this is what "in place" means for that field).
 */
const TOPIC_TEMPLATE = [
  { suffix: 'Term1', name: 'Term 1 Activity' },
  { suffix: 'Term2', name: 'Term 2 Activity' },
  { suffix: 'Optional', name: 'Optional Activity' },
]

function defaultCost() {
  return { case_study: 10, materials: 10, quiz: 10 }
}

function defaultTopicEntry(subjectId, suffix, name) {
  return { id: `${subjectId}_${suffix}`, name, cost: defaultCost(), survey_initiated_by: {} }
}

/** Full default `topics` array for a brand-new subject. */
export function defaultTopicsForSubject(subjectId) {
  return TOPIC_TEMPLATE.map(t => defaultTopicEntry(subjectId, t.suffix, t.name))
}

/** True if `subject.topics` is missing any of the expected Term1/Term2/Optional entries. */
export function subjectNeedsTopicRepair(subject) {
  const topics = Array.isArray(subject?.topics) ? subject.topics : []
  const ids = new Set(topics.map(t => t && t.id))
  return TOPIC_TEMPLATE.some(t => !ids.has(`${subject.id}_${t.suffix}`))
}

/**
 * Adds whatever Term1/Term2/Optional entries are missing, preserving every
 * existing entry (including ones already matching, and any extras) as-is.
 */
export function repairedTopicsFor(subject) {
  const existing = Array.isArray(subject?.topics) ? subject.topics : []
  const ids = new Set(existing.map(t => t && t.id))
  const missing = TOPIC_TEMPLATE
    .filter(t => !ids.has(`${subject.id}_${t.suffix}`))
    .map(t => defaultTopicEntry(subject.id, t.suffix, t.name))
  return [...existing, ...missing]
}
