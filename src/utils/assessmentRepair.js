/**
 * Auditing assessment documents that are already in Firestore.
 *
 * The import path that wrote most of them is fixed (see assessmentImport.js),
 * but fixing the writer does nothing for what it already wrote. This module
 * finds those documents and proposes a correction; it never decides on its own
 * what a mark should be.
 *
 * What the old importer left behind:
 *   - maxMarks from `parseFloat(text.replace(/[^\d.]/g,''))`, so the documented
 *     composite "80 (40+40)" was stored as 804040.
 *   - `order: 1` on every row, so a subject's assessments have no usable order.
 *   - no `conversionType` / `conversionFactor` at all, which the schema
 *     requires and the teacher app's mark conversion reads.
 *   - blueprint columns (dateStart, syllabusCovered, maxWrittenRaw, …) written
 *     as extra document fields that nothing reads.
 *   - a `name` taken from whatever matched a subject name, so assessments came
 *     out named after their own subject.
 *
 * Everything here is pure — tools/check_assessment_repair.mjs pins it.
 */

export const ENTRY_TYPES = ['marks', 'grade']
export const CONVERSION_TYPES = ['none', 'marks_to_grade', 'sum_up', 'sum_down']

/**
 * Above this, a maxMarks is treated as implausible for a school assessment and
 * is flagged for a human. It is a review threshold, not a schema rule: a real
 * assessment marked out of 500 is flagged, looked at, and kept.
 */
export const MAX_PLAUSIBLE_MARKS = 200

/** Extra fields the old importer wrote that no reader has. */
export const STRIPPABLE_FIELDS = [
  'dateStart', 'dateEnd', 'instructionalDays', 'syllabusCovered',
  'examSyllabus', 'maxWrittenRaw', 'activityWeight', 'total', 'duration',
]

const isPositiveNumber = v => typeof v === 'number' && Number.isFinite(v) && v > 0

/**
 * Try to recover the real maximum from a mark mangled by the digit-strip.
 *
 * Two shapes are recoverable, and only these two — anything else returns null
 * so the value is flagged for a human rather than replaced by a guess:
 *
 *   "80 (40+40)" -> 804040 : a prefix followed by equal-length parts that sum
 *                            to it. The prefix IS the answer (80).
 *   "20+80"      -> 2080   : exactly TWO equal-length parts and nothing else.
 *                            Their sum is the answer (100).
 *
 * The first rule is tried first: 804040 also splits as [80,40,40], and the
 * prefix reading is the one that matches how the source cell was written.
 *
 * Rule 2 is deliberately limited to two parts. Allowing more made it answer
 * for values it had no business answering for — 803030 splits as [80,30,30]
 * and would have been "recovered" as 140, when the cell was far more likely
 * "80 (30+30)" with a breakdown that does not add up. There is no way to tell
 * from the stored number, so it is flagged for a human instead.
 */
export function suggestRepairedMaxMarks(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return null
  const digits = String(value)
  if (digits.length < 3) return null

  const partsOf = (text, partLen) => {
    if (partLen < 1 || text.length % partLen !== 0) return null
    const count = text.length / partLen
    if (count < 2) return null
    const out = []
    for (let i = 0; i < text.length; i += partLen) out.push(Number(text.slice(i, i + partLen)))
    return out
  }

  // Rule 1 — prefix + a breakdown that adds up to it.
  for (let prefixLen = 1; prefixLen <= digits.length - 2; prefixLen++) {
    const prefix = Number(digits.slice(0, prefixLen))
    const rest = digits.slice(prefixLen)
    if (!prefix) continue
    for (let partLen = 1; partLen <= rest.length / 2; partLen++) {
      const parts = partsOf(rest, partLen)
      if (parts && parts.every(n => n > 0) && parts.reduce((a, b) => a + b, 0) === prefix) return prefix
    }
  }

  // Rule 2 — a bare two-part sum, and only that.
  if (digits.length % 2 === 0) {
    const parts = partsOf(digits, digits.length / 2)
    if (parts && parts.length === 2 && parts.every(n => n > 0)) {
      const sum = parts[0] + parts[1]
      if (sum > 0 && sum <= MAX_PLAUSIBLE_MARKS && sum !== value) return sum
    }
  }

  return null
}

const issue = (code, message, { fixable = false, severity = 'warning' } = {}) =>
  ({ code, message, fixable, severity })

/**
 * Audit one assessment document.
 *
 * @param {Object} doc     the stored document, including `id`
 * @param {Object} ctx
 * @param {Set}    ctx.scaleIds      grading scale IDs that exist
 * @param {Set}    ctx.termIds       term IDs that exist
 * @param {Map}    ctx.subjectNames  subjectId -> subject name
 * @param {number} ctx.resequencedOrder  order this doc should have, when its
 *                                       (subjectId, termId) group needs one
 * @returns {{id, issues: Array, patch: Object, strip: string[], marksSuggestion: number|null, changesMarking: boolean}}
 */
export function auditAssessment(doc, ctx = {}) {
  const { scaleIds = new Set(), termIds = new Set(), subjectNames = new Map(), resequencedOrder = null } = ctx
  const issues = []
  const patch = {}
  let marksSuggestion = null

  if (!String(doc.name ?? '').trim()) {
    issues.push(issue('name_missing', 'has no name', { severity: 'error' }))
  } else {
    // The old importer resolved a row's subject by matching the ASSESSMENT
    // NAME against subject names, so the only rows that survived were ones
    // named after a subject. That is the fingerprint — a human has to supply
    // the real name, so this is reported, never auto-fixed.
    const subjectName = subjectNames.get(doc.subjectId)
    if (subjectName && String(doc.name).trim().toLowerCase() === subjectName.trim().toLowerCase()) {
      issues.push(issue('name_is_subject', `is named "${doc.name}" — the same as its subject, which is what the old import bug produced. Rename it to the real assessment name.`))
    }
  }

  if (!termIds.size || !termIds.has(doc.termId)) {
    if (termIds.size) issues.push(issue('term_missing', `references term "${doc.termId}" which does not exist`, { severity: 'error' }))
  }
  if (doc.subjectId && subjectNames.size && !subjectNames.has(doc.subjectId)) {
    issues.push(issue('subject_missing', `references subject "${doc.subjectId}" which does not exist`, { severity: 'error' }))
  }

  if (!ENTRY_TYPES.includes(doc.entryType)) {
    issues.push(issue('entry_type', `entryType is ${JSON.stringify(doc.entryType)} — defaulting to "marks"`, { fixable: true }))
    patch.entryType = 'marks'
  }

  const entryType = patch.entryType || doc.entryType

  if (!isPositiveNumber(doc.maxMarks)) {
    marksSuggestion = suggestRepairedMaxMarks(doc.maxMarks)
    issues.push(issue('max_marks_invalid', `maxMarks is ${JSON.stringify(doc.maxMarks)} — every mark is scored against this`, { severity: 'error' }))
  } else if (doc.maxMarks > MAX_PLAUSIBLE_MARKS) {
    marksSuggestion = suggestRepairedMaxMarks(doc.maxMarks)
    issues.push(issue('max_marks_implausible',
      marksSuggestion
        ? `maxMarks is ${doc.maxMarks} — reads as a composite mark mangled by the old import; ${marksSuggestion} is the likely original`
        : `maxMarks is ${doc.maxMarks}, above the ${MAX_PLAUSIBLE_MARKS} review threshold — check it is really marked out of this`,
      { severity: 'error' }))
  }

  if (!CONVERSION_TYPES.includes(doc.conversionType)) {
    issues.push(issue('conversion_type', `conversionType is ${JSON.stringify(doc.conversionType)} — the schema requires one and the teacher app reads it; defaulting to "none"`, { fixable: true }))
    patch.conversionType = 'none'
  }
  const conversionType = patch.conversionType || doc.conversionType

  if (conversionType === 'none' && doc.conversionFactor !== null && doc.conversionFactor !== undefined) {
    issues.push(issue('conversion_factor_set', 'has a conversionFactor while conversionType is "none" — clearing it', { fixable: true }))
    patch.conversionFactor = null
  } else if (doc.conversionFactor === undefined) {
    // The schema requires the field to be present (nullable, not absent).
    issues.push(issue('conversion_factor_absent', 'has no conversionFactor field at all — the schema requires it; writing null', { fixable: true }))
    patch.conversionFactor = null
  }
  if ((conversionType === 'sum_up' || conversionType === 'sum_down') && !doc.conversionFactor) {
    issues.push(issue('conversion_factor_missing', `conversionType is "${conversionType}" but there is no conversionFactor — set one in the editor`, { severity: 'error' }))
  }

  const needsScale = entryType === 'grade' || conversionType === 'marks_to_grade'
  if (needsScale && !doc.gradingScaleId) {
    issues.push(issue('scale_missing', `needs a grading scale (entryType "${entryType}", conversionType "${conversionType}") but has none`, { severity: 'error' }))
  } else if (doc.gradingScaleId && !scaleIds.has(doc.gradingScaleId)) {
    issues.push(issue('scale_unknown', `references grading scale "${doc.gradingScaleId}" which does not exist`, { severity: 'error' }))
  }
  if (doc.gradingScaleId === undefined) {
    issues.push(issue('scale_absent', 'has no gradingScaleId field at all — the schema requires it; writing null', { fixable: true }))
    patch.gradingScaleId = null
  }

  if (resequencedOrder !== null && resequencedOrder !== doc.order) {
    issues.push(issue('order', `order ${JSON.stringify(doc.order)} → ${resequencedOrder}`, { fixable: true }))
    patch.order = resequencedOrder
  }

  const strip = STRIPPABLE_FIELDS.filter(k => doc[k] !== undefined)
  if (strip.length) {
    issues.push(issue('extra_fields', `carries ${strip.length} field(s) nothing reads, written by the old import: ${strip.join(', ')}`, { fixable: true }))
  }

  // Changing what a mark is scored against can invalidate marks teachers have
  // already entered — the same gate the editor and the CSV import use.
  const changesMarking = patch.entryType !== undefined
    || issues.some(i => i.code === 'max_marks_invalid' || i.code === 'max_marks_implausible')

  // True when the stored maximum itself is the problem — the UI offers an
  // editable box for these, including the ones with no recoverable reading,
  // so an assessment with a null maxMarks is fixable here rather than only
  // being reported.
  const needsMaxMarks = issues.some(i => i.code === 'max_marks_invalid' || i.code === 'max_marks_implausible')

  return { id: doc.id, doc, issues, patch, strip, marksSuggestion, needsMaxMarks, changesMarking }
}

/**
 * Audit a whole school's assessments.
 *
 * `order` is judged per (subjectId, termId) group: a group whose orders are
 * missing, non-positive or duplicated is resequenced 1..n, keeping the order
 * the documents are already in so a deliberate ordering survives. A group
 * that is already a clean sequence is left completely alone.
 */
export function auditAssessments(docs, { scaleIds, termIds, subjectNames } = {}) {
  const groups = new Map()
  for (const d of docs) {
    const key = `${d.subjectId}|${d.termId}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(d)
  }

  const resequenced = new Map()
  for (const list of groups.values()) {
    const orders = list.map(d => d.order)
    const clean = orders.every(o => typeof o === 'number' && Number.isInteger(o) && o >= 1)
      && new Set(orders).size === orders.length
    if (clean) continue
    // Stable: existing order first (a real one is a decision worth keeping),
    // then doc ID so a group of all-1s resequences the same way every run.
    const sorted = [...list].sort((a, b) =>
      (typeof a.order === 'number' ? a.order : 1e9) - (typeof b.order === 'number' ? b.order : 1e9)
      || String(a.id).localeCompare(String(b.id)))
    sorted.forEach((d, i) => resequenced.set(d.id, i + 1))
  }

  return docs
    .map(d => auditAssessment(d, {
      scaleIds, termIds, subjectNames,
      resequencedOrder: resequenced.has(d.id) ? resequenced.get(d.id) : null,
    }))
    .filter(r => r.issues.length)
}
