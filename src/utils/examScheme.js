/**
 * A school's own exam scheme — the shape, the validator, and the seeding.
 *
 * Pure. No Firestore, no Vue.
 *
 * WHY PER SCHOOL, NOT ONE FRAMEWORK. Hillgreen's scheme came out of its own
 * marks sheet and report cards, and nothing says the next school examines the
 * same way. A single scheme applied everywhere would be wrong silently: a
 * school with different papers would get columns that look right, take marks
 * all term, and disagree with its own report card at the end of it. So the
 * scheme lives at `schools/{id}/config/exam_scheme`, one per school, and a
 * school without one gets NOTHING — never a default that quietly applies.
 *
 * SUBJECT SPLITS ARE WRITTEN DOWN, NOT INFERRED. The first version guessed
 * which subjects had practicals from their names, and Hillgreen immediately
 * showed why that fails: it spells the same subject "PE Additional" and "HPE",
 * one matched the rule and one did not, and the two were examined differently
 * with nothing to say so. Inference now runs ONCE, when a scheme is seeded, as
 * a proposal an operator edits. What is saved is a decision, not a guess.
 */
import EXAMPLE from '../data/assessmentTemplates.json'
import { parseClassValue } from './classResolver.js'

/** Where a school's scheme lives. */
export const EXAM_SCHEME_DOC = 'exam_scheme'

/** Names a split can have. `standard` is required; the others are optional. */
export const SPLIT_NAMES = ['standard', 'practical', 'halfPractical']

/** A subject's name, as loosely as a school might have spelled it. */
export function nameKey(s) {
  return String(s ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

/**
 * `$`-prefixed keys are the source file's own annotations — where a number was
 * read from, what a section does not cover. They belong in the repo, not in a
 * school's Firestore document, and a validator reading `splits.$comment` as a
 * split is how that gets noticed late.
 */
function stripAnnotations(value) {
  if (Array.isArray(value)) return value.map(stripAnnotations)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([k]) => !k.startsWith('$'))
      .map(([k, v]) => [k, stripAnnotations(v)]))
  }
  return value
}

/**
 * The example scheme, for a school that wants to start from one rather than
 * from a blank page. Offered by name and never applied on its own — see the
 * module comment.
 */
export function exampleScheme() {
  return {
    name: 'CBSE — Hillgreen 2026 (example)',
    source: 'Read from Hillgreen\'s marks_conversion.xlsx and four report card models',
    splits: stripAnnotations(EXAMPLE.splits ?? {}),
    exams: stripAnnotations(EXAMPLE.exams ?? []),
    gradeOverrides: stripAnnotations(EXAMPLE.gradeOverrides ?? {}),
    unverifiedGrades: stripAnnotations(EXAMPLE.unverifiedGrades ?? []),
    // Deliberately empty: the seeding step fills this against the school's own
    // subject list, so a scheme never carries another school's subject names.
    subjectSplits: {},
  }
}

/** The grading scale the example's report cards print — offered, never assumed. */
export function exampleGradingScale() {
  return structuredClone(EXAMPLE.gradingScale)
}

/**
 * A scheme's rules applied to a subject list, as a PROPOSAL.
 *
 * Runs the old name-matching once so an operator starts from something rather
 * than from 162 blank rows, and marks every entry `proposed: true`. Saving is
 * what turns a proposal into the school's decision.
 */
export function proposeSubjectSplits(subjects = [], rules = EXAMPLE.subjectSplitRules) {
  const out = {}
  for (const subject of subjects) {
    const name = subject.name || subject.id || ''
    const key = nameKey(name)
    if (!key || out[key]) continue

    const gradeToken = String(subject.id || '').includes('_')
      ? String(subject.id).split('_')[0] : ''
    const ordinal = parseClassValue(gradeToken).gradeOrdinal

    let splitName = 'standard'
    let reason = 'no rule matched — the ordinary paper for this school'
    for (const ruleName of ['halfPractical', 'practical']) {
      const rule = rules?.[ruleName]
      if (!rule) continue
      if (ordinal === null || ordinal === undefined || ordinal < rule.fromGrade) continue
      const hit = (rule.names || []).find(n => key === nameKey(n) || key.startsWith(nameKey(n) + ' '))
      if (hit) { splitName = ruleName; reason = `name matched "${hit}"`; break }
    }
    out[key] = { name, splitName, reason, proposed: true }
  }
  return out
}

/**
 * @returns {{ok: boolean, errors: string[], warnings: string[]}}
 *
 * Checked here rather than only in the editor because a scheme read back from
 * Firestore may have been written by an older version of the editor, or by
 * hand. A malformed scheme produces assessments a teacher cannot fill, which
 * is a much later and much more expensive place to find out.
 */
export function validateScheme(scheme) {
  const errors = []
  const warnings = []
  const s = scheme || {}

  if (!String(s.name || '').trim()) errors.push('the scheme needs a name')

  const splits = s.splits || {}
  if (!splits.standard) errors.push('a "standard" split is required — it is what a subject with no rule takes')
  for (const [key, split] of Object.entries(splits)) {
    if (key.startsWith('$')) continue   // an annotation, not a split
    for (const half of ['written', 'internal']) {
      const v = split?.[half]
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
        errors.push(`split "${key}": ${half} must be a number, got ${JSON.stringify(v)}`)
      }
    }
  }

  const exams = Array.isArray(s.exams) ? s.exams : []
  if (!exams.length) errors.push('a scheme with no exams would create nothing')

  const seenKeys = new Set()
  for (const [i, e] of exams.entries()) {
    const where = `exam ${i + 1}${e?.name ? ` ("${e.name}")` : ''}`
    if (!String(e?.key || '').trim()) errors.push(`${where}: needs a key — it is part of the document id`)
    else if (seenKeys.has(e.key)) errors.push(`${where}: key "${e.key}" is used twice, so one would overwrite the other`)
    else seenKeys.add(e.key)

    if (!String(e?.name || '').trim()) errors.push(`${where}: needs a name`)
    if (![1, 2].includes(e?.term)) errors.push(`${where}: term must be 1 or 2, got ${JSON.stringify(e?.term)}`)
    if (typeof e?.order !== 'number' || e.order < 1) errors.push(`${where}: order must be 1 or more`)

    const bands = Array.isArray(e?.writtenBands) ? e.writtenBands : []
    if (!bands.length) errors.push(`${where}: needs at least one grade band`)
    for (const b of bands) {
      if (typeof b?.minGrade !== 'number' || typeof b?.maxGrade !== 'number') {
        errors.push(`${where}: a band needs numeric minGrade and maxGrade`)
        continue
      }
      if (b.minGrade > b.maxGrade) errors.push(`${where}: band ${b.minGrade}–${b.maxGrade} runs backwards`)
      if (b.max !== null && (typeof b.max !== 'number' || b.max <= 0)) {
        errors.push(`${where}: band ${b.minGrade}–${b.maxGrade} needs a positive written max, or null to take it from the split`)
      }
    }
    // Overlapping bands are not an error — the first match wins, which is
    // deterministic — but it is almost always a mistake worth seeing.
    const sorted = bands.filter(b => typeof b?.minGrade === 'number')
      .slice().sort((a, b) => a.minGrade - b.minGrade)
    for (let j = 1; j < sorted.length; j++) {
      if (sorted[j].minGrade <= sorted[j - 1].maxGrade) {
        warnings.push(`${where}: grades ${sorted[j].minGrade}–${sorted[j - 1].maxGrade} are in two bands; the first one wins`)
      }
    }

    if (!e?.splitVaries) {
      if (typeof e?.convertTo !== 'number' || e.convertTo <= 0) {
        errors.push(`${where}: a fixed exam needs convertTo (what the written mark becomes)`)
      }
      if (typeof e?.internal !== 'number' || e.internal < 0) {
        errors.push(`${where}: a fixed exam needs an internal mark`)
      }
    }
  }

  for (const [grade, ov] of Object.entries(s.gradeOverrides || {})) {
    if (grade.startsWith('$')) continue
    if (!Number.isFinite(Number(grade))) errors.push(`override "${grade}": not a grade`)
    if (![1, 2].includes(ov?.replaceTerm)) errors.push(`override "${grade}": replaceTerm must be 1 or 2`)
    if (!Array.isArray(ov?.exams) || !ov.exams.length) {
      errors.push(`override "${grade}": replaces a term with no exams, which would leave that term empty`)
    }
  }

  for (const [key, entry] of Object.entries(s.subjectSplits || {})) {
    if (!splits[entry?.splitName]) {
      errors.push(`subject "${entry?.name || key}": split "${entry?.splitName}" is not defined`)
    }
  }
  const stillProposed = Object.values(s.subjectSplits || {}).filter(e => e?.proposed).length
  if (stillProposed) {
    warnings.push(`${stillProposed} subject split(s) are still the seeded proposal — confirm them`)
  }

  return { ok: !errors.length, errors, warnings }
}
