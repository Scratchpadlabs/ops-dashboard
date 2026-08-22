/**
 * Behaviour check for src/utils/assessmentRepair.js — auditing assessment
 * documents that are already in Firestore.
 *
 *     node tools/check_assessment_repair.mjs
 *
 * The recovery rule for a mangled maxMarks is pinned hardest: it proposes a
 * number that will be written back over live marking data, so it must decline
 * to guess far more readily than it guesses.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { suggestRepairedMaxMarks, auditAssessment, auditAssessments, MAX_PLAUSIBLE_MARKS } =
  await import(path.join(ROOT, 'src/utils/assessmentRepair.js'))
// The point of the repair is a document the schema accepts, so the last check
// runs the real validator rather than trusting this module's own rules.
const { validateDoc, formatErrors } = await import(path.join(ROOT, 'src/schemas/schoolSchema.js'))

let failures = 0
const check = (label, cond, extra) => {
  if (cond) console.log(`  ok   ${label}`)
  else { failures++; console.log(`  FAIL ${label}`, extra !== undefined ? JSON.stringify(extra) : '') }
}
const codes = r => r.issues.map(i => i.code)

// ── suggestRepairedMaxMarks ─────────────────────────────────────────────────
// The exact value the old importer produced from the documented "80 (40+40)".
check('804040 recovers to 80', suggestRepairedMaxMarks(804040) === 80, suggestRepairedMaxMarks(804040))
check('1005050 recovers to 100', suggestRepairedMaxMarks(1005050) === 100, suggestRepairedMaxMarks(1005050))
check('a bare sum 2080 recovers to 100', suggestRepairedMaxMarks(2080) === 100, suggestRepairedMaxMarks(2080))
check('803030 has no consistent reading', suggestRepairedMaxMarks(803030) === null, suggestRepairedMaxMarks(803030))

// Declining to guess is the important half.
check('a plain 80 is not "recovered"', suggestRepairedMaxMarks(80) === null)
check('a plain 100 is not "recovered"', suggestRepairedMaxMarks(100) === null)
check('null is handled', suggestRepairedMaxMarks(null) === null)
check('a non-number is handled', suggestRepairedMaxMarks('80 (40+40)') === null)
check('a decimal is not split', suggestRepairedMaxMarks(7.5) === null)
check('a negative is handled', suggestRepairedMaxMarks(-80) === null)
// A part reading as 0 is not a real breakdown ("100" is not 10 and 0).
check('a zero part is rejected', suggestRepairedMaxMarks(100) === null)

// ── auditAssessment ─────────────────────────────────────────────────────────
const ctx = {
  scaleIds: new Set(['standard_scale']),
  termIds: new Set(['term1']),
  subjectNames: new Map([['III_English', 'English'], ['III_Maths', 'Maths']]),
}

// Exactly what the old importer wrote: no conversion fields, order 1,
// composite marks, blueprint extras, and a name taken from the subject.
const legacy = {
  id: 'III_English_term1_English', name: 'English', termId: 'term1', subjectId: 'III_English',
  order: 1, entryType: 'marks', maxMarks: 804040, gradingScaleId: null,
  dateStart: '2026-04-01', syllabusCovered: 'Ch 1-4', maxWrittenRaw: '80 (40+40)',
}
const r = auditAssessment(legacy, ctx)
check('the composite mark is flagged', codes(r).includes('max_marks_implausible'), codes(r))
check('...with the recovered value offered', r.marksSuggestion === 80)
check('the missing conversionType is flagged', codes(r).includes('conversion_type'))
check('...and auto-fixed to "none"', r.patch.conversionType === 'none')
check('conversionFactor is defaulted to null', r.patch.conversionFactor === null)
check('the subject-named assessment is flagged', codes(r).includes('name_is_subject'))
check('...but never auto-renamed', r.patch.name === undefined)
check('the blueprint extras are listed', r.strip.join(',') === 'dateStart,syllabusCovered,maxWrittenRaw', r.strip)
check('it counts as changing the marking', r.changesMarking === true)

// A clean document produces nothing at all.
const clean = {
  id: 'III_Maths_term1_unit_1', name: 'Unit 1', termId: 'term1', subjectId: 'III_Maths',
  order: 1, entryType: 'marks', maxMarks: 20, gradingScaleId: null,
  conversionType: 'none', conversionFactor: null,
}
check('a clean document raises nothing', auditAssessment(clean, ctx).issues.length === 0,
  codes(auditAssessment(clean, ctx)))
check('...and needs no marks box', auditAssessment(clean, ctx).needsMaxMarks === false)
check('...and is not treated as changing the marking', auditAssessment(clean, ctx).changesMarking === false)

// The schema requires these fields to be PRESENT (nullable, not absent), and
// the old importer wrote neither.
const { conversionFactor, gradingScaleId, ...noConvFields } = clean
const bare = auditAssessment(noConvFields, ctx)
check('an absent conversionFactor is flagged', codes(bare).includes('conversion_factor_absent'), codes(bare))
check('...and written as null', bare.patch.conversionFactor === null)
check('an absent gradingScaleId is flagged', codes(bare).includes('scale_absent'))
check('...and written as null', bare.patch.gradingScaleId === null)

// A null maxMarks has no recoverable reading, but must still be fixable here
// rather than only reported.
const nullMarks = auditAssessment({ ...clean, maxMarks: null }, ctx)
check('a null maxMarks still offers the editable box', nullMarks.needsMaxMarks === true)
check('...with no invented suggestion', nullMarks.marksSuggestion === null)
check('...and counts as changing the marking', nullMarks.changesMarking === true)

// An implausible mark with no reading is likewise editable, not just reported.
const unreadable = auditAssessment({ ...clean, maxMarks: 803030 }, ctx)
check('an unrecoverable implausible mark is editable', unreadable.needsMaxMarks === true)
check('...with no invented suggestion', unreadable.marksSuggestion === null)
check('...and is filtered out of the audit', auditAssessments([clean], ctx).length === 0)

// Individual rules.
check('a missing name is an error',
  auditAssessment({ ...clean, name: '' }, ctx).issues.some(i => i.code === 'name_missing' && i.severity === 'error'))
check('a bad entryType is fixed to marks',
  auditAssessment({ ...clean, entryType: undefined }, ctx).patch.entryType === 'marks')
check('maxMarks null is an error',
  auditAssessment({ ...clean, maxMarks: null }, ctx).issues.some(i => i.code === 'max_marks_invalid' && i.severity === 'error'))
check(`maxMarks above ${MAX_PLAUSIBLE_MARKS} is flagged even without a reading`,
  codes(auditAssessment({ ...clean, maxMarks: 803030 }, ctx)).includes('max_marks_implausible'))
check('a stray conversionFactor is cleared',
  auditAssessment({ ...clean, conversionFactor: 2 }, ctx).patch.conversionFactor === null)
check('sum_up without a factor is an error',
  auditAssessment({ ...clean, conversionType: 'sum_up', conversionFactor: null }, ctx)
    .issues.some(i => i.code === 'conversion_factor_missing' && i.severity === 'error'))
check('entryType grade without a scale is an error',
  codes(auditAssessment({ ...clean, entryType: 'grade' }, ctx)).includes('scale_missing'))
check('an unknown grading scale is flagged',
  codes(auditAssessment({ ...clean, gradingScaleId: 'gone' }, ctx)).includes('scale_unknown'))
check('an unknown term is flagged',
  codes(auditAssessment({ ...clean, termId: 'nope' }, ctx)).includes('term_missing'))
check('an unknown subject is flagged',
  codes(auditAssessment({ ...clean, subjectId: 'IV_Latin' }, ctx)).includes('subject_missing'))
check('a subject-named assessment in a school with no subjects loaded is not flagged',
  !codes(auditAssessment({ ...clean, name: 'Maths' }, { ...ctx, subjectNames: new Map() })).includes('name_is_subject'))

// ── order, judged per (subjectId, termId) group ─────────────────────────────
// Every row order: 1 is exactly what the old importer produced.
const allOnes = [
  { ...clean, id: 'a_2', name: 'Unit 2', order: 1 },
  { ...clean, id: 'a_1', name: 'Unit 1', order: 1 },
]
const seq = auditAssessments(allOnes, ctx)
// Only a_2 actually changes: the tie-break is doc ID, so a_1 keeps order 1 and
// raises nothing — a document that needs no change is never in the list.
check('the duplicated order raises exactly one change', seq.length === 1, seq.map(x => [x.id, codes(x)]))
check('...on the document that moves', seq[0].id === 'a_2')
check('...to the next slot', seq[0].patch.order === 2)
check('...and the one that keeps its order is untouched', !seq.some(x => x.id === 'a_1'))

// A real ordering is a decision — it survives.
const ordered = [
  { ...clean, id: 'b_1', order: 1 },
  { ...clean, id: 'b_2', order: 2 },
]
check('a clean sequence is left alone', auditAssessments(ordered, ctx).length === 0)

// Different subjects each get their own 1..n.
const twoSubjects = [
  { ...clean, id: 'c_1', subjectId: 'III_English', order: 0 },
  { ...clean, id: 'c_2', subjectId: 'III_Maths', order: 0 },
]
const perSubject = auditAssessments(twoSubjects, ctx)
check('order is scoped per subject+term', perSubject.every(x => x.patch.order === 1), perSubject.map(x => x.patch.order))

// ── End to end: a repaired legacy document must satisfy the real schema ────
function applyRepair(doc, r, maxMarksOverride) {
  const out = { ...doc, ...r.patch }
  const marks = maxMarksOverride !== undefined ? maxMarksOverride
    : (r.marksSuggestion !== null ? r.marksSuggestion : doc.maxMarks)
  if (r.needsMaxMarks) out.maxMarks = marks
  for (const f of r.strip) delete out[f]
  delete out.id
  return out
}

const repairedLegacy = applyRepair(legacy, auditAssessment(legacy, ctx))
const legacyCheck = validateDoc('assessments', repairedLegacy)
check('a repaired legacy document passes the assessments schema',
  legacyCheck.ok, legacyCheck.ok ? '' : formatErrors(legacyCheck.errors))
check('...with the recovered maximum', repairedLegacy.maxMarks === 80)
check('...and none of the blueprint extras left behind',
  !('maxWrittenRaw' in repairedLegacy) && !('syllabusCovered' in repairedLegacy))

// The unrepaired original is exactly what the schema rejects today.
check('the unrepaired original does NOT pass',
  !validateDoc('assessments', (({ id, ...rest }) => rest)(legacy)).ok)

// A document whose only problem is the absent conversion fields.
const repairedBare = applyRepair(noConvFields, auditAssessment(noConvFields, ctx))
const bareCheck = validateDoc('assessments', repairedBare)
check('a repaired bare document passes the schema', bareCheck.ok,
  bareCheck.ok ? '' : formatErrors(bareCheck.errors))

// A null maxMarks needs the operator's number; with it, the doc is valid.
const repairedNull = applyRepair({ ...clean, maxMarks: null }, auditAssessment({ ...clean, maxMarks: null }, ctx), 50)
check('a null maxMarks passes once the operator supplies one',
  validateDoc('assessments', (({ id, ...rest }) => rest)(repairedNull)).ok)

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed')
process.exit(failures ? 1 : 0)
