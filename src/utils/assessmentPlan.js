/**
 * A school's exam scheme, turned into assessment documents.
 *
 * Pure — no Firestore, no Vue. Every function takes the SCHEME as an argument
 * rather than importing one, because a scheme belongs to a school: see
 * utils/examScheme.js for why there is deliberately no default.
 *
 * The point of keeping it pure is that a school's report cards contain worked
 * examples (Hillgreen prints English 69/80 + 20/20 = 89), so the planner can
 * be checked against a school's own numbers rather than against anyone's
 * reading of them: node tools/check_assessment_templates.mjs
 *
 * TWO ASSESSMENTS PER EXAM (ops decision, 2026-08-20). The report card prints
 * Theory and Practical/Internal as separate columns, and a teacher enters both
 * numbers, so "Periodic Test-II" is two documents — "… (Written)" and
 * "… (Internal)" — whose maxMarks add to the exam's total. One document with
 * the combined figure would make the two unseparable, and the report card
 * needs them apart.
 */
import { nameKey } from './examScheme.js'
import { parseClassValue } from './classResolver.js'

export const WRITTEN = 'Written'
export const INTERNAL = 'Internal'

/**
 * Which written/internal split a subject takes.
 *
 * A lookup, not a guess. The scheme carries `subjectSplits` — a decision an
 * operator saved — and anything not in it takes the standard split. Grade is
 * not consulted: if a school examines Physics differently at 11 than at 10,
 * that is two entries, written down, rather than a rule nobody can see.
 *
 * Returns why, not just what, because "standard" is also what an unrecognised
 * spelling falls through to, and those two need telling apart.
 */
export function splitFor(scheme, subjectName) {
  const splits = scheme?.splits || {}
  const entry = (scheme?.subjectSplits || {})[nameKey(subjectName)]
  const chosen = entry && splits[entry.splitName]
  if (chosen) {
    return {
      split: chosen,
      splitName: entry.splitName,
      reason: entry.reason || 'set for this school',
      proposed: !!entry.proposed,
    }
  }
  return {
    split: splits.standard,
    splitName: 'standard',
    reason: entry ? `split "${entry.splitName}" is not defined — fell back to standard`
                  : 'not listed in this school\'s subject splits',
    proposed: false,
  }
}

/** The exams a grade sits, with any grade override applied. */
export function examsForGrade(scheme, gradeOrdinal) {
  const exams = scheme?.exams || []
  const override = (scheme?.gradeOverrides || {})[String(gradeOrdinal)]
  if (!override) return exams
  const kept = exams.filter(e => e.term !== override.replaceTerm)
  return [...kept, ...(override.exams || [])]
}

function writtenMaxFor(exam, gradeOrdinal) {
  const band = (exam.writtenBands || []).find(
    b => gradeOrdinal >= b.minGrade && gradeOrdinal <= b.maxGrade)
  return band ? band : null
}

/**
 * The two assessment specs for one (exam, subject, grade).
 *
 * `max: null` in a written band means "the paper is already the split's own
 * written mark" — grades 6–12 sit an 80- or 70-mark paper depending on the
 * subject, which is only known once the split is.
 *
 * conversionFactor is convertTo / writtenMax. It is 1 (so conversionType
 * "none") wherever the paper is already on the report card's scale, and only
 * grades 3–5 produce a non-integer — 60 marks scaled to 80. That is what the
 * marks sheet says, and the planner flags it rather than rounding it away.
 */
export function assessmentsFor({ scheme, exam, subjectId, subjectName, gradeOrdinal, termId }) {
  const band = writtenMaxFor(exam, gradeOrdinal)
  if (!band) {
    return {
      assessments: [],
      notes: [],
      warnings: [{ key: `noband:${exam.key}:${gradeOrdinal}`,
                   message: `grade ${gradeOrdinal} is outside every band of "${exam.name}"` }],
    }
  }

  const { split, splitName, reason, proposed } = splitFor(scheme, subjectName)
  const warnings = []
  const notes = []

  // PT-I/III fix both halves outright; the 100-mark exams take them from the split.
  const convertTo = exam.convertTo ?? split.written
  const internalMax = exam.internal ?? split.internal

  // A non-standard split names the paper's own size, and beats the grade band.
  // The marks sheet gives the bands for an ordinary paper and then says, in a
  // footnote, that "in some papers like IT and AI Written is 50 and
  // internal/prcatical is altogether 50" — a statement about the paper, not
  // about the grade. Letting the band win instead produced a 40 + 50 exam
  // worth 90 for IT in class 1, which is not a mark scheme anyone wrote down.
  const bandOverridden = exam.splitVaries && splitName !== 'standard'
                         && band.max !== null && band.max !== split.written
  const writtenMax = exam.splitVaries && splitName !== 'standard'
    ? split.written
    : (band.max ?? split.written)
  if (bandOverridden) {
    warnings.push({
      key: `band:${splitName}:${band.max}:${split.written}`,
      message: `The ${splitName} split makes this a ${split.written}-mark paper, where grade `
             + `${gradeOrdinal} otherwise sits ${band.max}. The marks sheet states the split `
             + 'as a footnote and gives no band for it — verify this subject is really '
             + 'examined that way here.',
    })
  }

  if (exam.splitVaries) {
    notes.push(`${splitName} split (${convertTo} + ${internalMax}) — ${reason}`)
    if (proposed) {
      warnings.push({
        key: `split:${splitName}:${nameKey(subjectName)}`,
        message: `"${subjectName}" is still the seeded proposal (${splitName}, `
               + `${convertTo} + ${internalMax}) — confirm it in the exam scheme`,
      })
    }
  }

  const factor = convertTo / writtenMax
  const conversionType = factor === 1 ? 'none' : 'sum_up'
  const conversionFactor = factor === 1 ? null : factor
  if (conversionType === 'sum_up' && !Number.isInteger(factor)) {
    warnings.push({
      key: `conversion:${writtenMax}:${convertTo}`,
      message: `A ${writtenMax}-mark paper scaled to ${convertTo} is a factor of `
             + `${factor.toFixed(4)} — verify before teachers enter marks`,
    })
  }

  const base = { termId, subjectId, entryType: 'marks', gradingScaleId: null }
  return {
    notes,
    warnings,
    assessments: [
      {
        ...base,
        docId: `${subjectId}_${termId}_${exam.key}_written`,
        name: `${exam.name} (${WRITTEN})`,
        order: exam.order * 2 - 1,
        maxMarks: writtenMax,
        conversionType,
        conversionFactor,
      },
      {
        ...base,
        docId: `${subjectId}_${termId}_${exam.key}_internal`,
        name: `${exam.name} (${INTERNAL})`,
        order: exam.order * 2,
        maxMarks: internalMax,
        conversionType: 'none',
        conversionFactor: null,
      },
    ],
  }
}

/**
 * Every assessment a school's subjects need, and everything the documents
 * could not answer.
 *
 * @param {object[]} subjects  [{id, name}] from schools/{id}/subjects
 * @param {object}   termIds   {1: <termId>, 2: <termId>} — ops maps the
 *                             school's own term documents onto Term I / II,
 *                             because a term id is a Firestore id and nothing
 *                             in these documents names it.
 * @param {object[]} existing  assessments already in the school, to mark
 *                             which rows would create and which would update
 */
export function buildAssessmentPlan({ scheme, subjects = [], termIds = {}, existing = [] } = {}) {
  const existingById = new Map(existing.map(a => [a.id, a]))
  const items = []
  const uncovered = []

  // Every subject whose split could have gone either way, listed with the one
  // it got — not only the ones that matched a rule.
  //
  // The warnings alone are half the picture: they fire when a subject IS
  // classified practical, and say nothing when one is not. Hillgreen has
  // "PE Additional" at 70 + 30 and "HPE" at 80 + 20 — the same subject under
  // two spellings, treated differently, and only one of them visible. A split
  // is a decision about every senior subject, so every senior subject is shown.
  const splitsByName = new Map()
  const recordSplit = (subject) => {
    const { splitName, split, reason, proposed } = splitFor(scheme, subject.name || subject.id)
    const key = `${nameKey(subject.name || subject.id)}|${splitName}`
    if (!splitsByName.has(key)) {
      splitsByName.set(key, {
        name: subject.name || subject.id,
        splitName,
        written: split?.written,
        internal: split?.internal,
        reason,
        proposed,
        subjects: [],
      })
    }
    splitsByName.get(key).subjects.push(subject.id)
  }

  // Grouped by key, not one per subject. The 1.3333 conversion for grades 3-5
  // is one fact about the marks sheet, and Hillgreen produced 59 identical
  // copies of it — enough to bury the seven that were actually different.
  const byKey = new Map()
  const warn = (w, subjectId) => {
    if (!byKey.has(w.key)) byKey.set(w.key, { message: w.message, subjects: [] })
    const entry = byKey.get(w.key)
    if (!entry.subjects.includes(subjectId)) entry.subjects.push(subjectId)
  }

  for (const subject of subjects) {
    const gradeToken = String(subject.id || '').includes('_')
      ? String(subject.id).split('_')[0] : ''
    const parsed = parseClassValue(gradeToken)
    const ordinal = parsed.gradeOrdinal

    if (ordinal === null || ordinal === undefined) {
      uncovered.push({ subjectId: subject.id, reason: `could not read a grade from "${subject.id}"` })
      continue
    }
    if (ordinal < 1) {
      uncovered.push({
        subjectId: subject.id,
        reason: 'pre-primary — the marks sheet starts at class 1 and no pre-primary '
              + 'report card was supplied, so there is no scheme to apply',
      })
      continue
    }
    // A scheme can say which grades it was actually written from. Anything
    // outside that is being given exams by extension rather than by evidence,
    // which is worth saying out loud — Hillgreen's documents cover 1 to 12 but
    // its class 12 report card was never supplied.
    const unverified = (scheme?.unverifiedGrades || []).map(Number)
    if (unverified.includes(ordinal)) {
      warn({
        key: `unverified:${ordinal}`,
        message: `Grade ${ordinal} is marked unverified in this scheme — it is being given `
               + 'exams by extension from a neighbouring grade, not from a document. Confirm '
               + 'before teachers enter marks.',
      }, subject.id)
    }

    recordSplit(subject)

    for (const exam of examsForGrade(scheme, ordinal)) {
      const termId = termIds[exam.term]
      if (!termId) {
        uncovered.push({ subjectId: subject.id, reason: `no term chosen for Term ${exam.term}` })
        continue
      }
      const out = assessmentsFor({
        scheme, exam, subjectId: subject.id, subjectName: subject.name || subject.id,
        gradeOrdinal: ordinal, termId,
      })
      for (const w of out.warnings) warn(w, subject.id)
      for (const a of out.assessments) {
        items.push({
          ...a,
          subjectName: subject.name || subject.id,
          examName: exam.name,
          gradeOrdinal: ordinal,
          notes: out.notes,
          status: existingById.has(a.docId) ? 'UPDATE' : 'CREATE',
        })
      }
    }
  }

  return {
    items,
    warnings: [...byKey.values()].map(w => ({ ...w, count: w.subjects.length })),
    // Standard first, so the eye lands on what did NOT get a practical split —
    // which is where a missed spelling hides.
    splitReview: [...splitsByName.values()]
      .map(s => ({ ...s, count: s.subjects.length }))
      .sort((a, b) => {
        // Not alphabetical: "standard" is what an unmatched spelling falls
        // through to, so it goes first, where a wrong one is noticed.
        const rank = r => (r.splitName === 'standard' ? 0 : 1)
        return rank(a) - rank(b) || a.name.localeCompare(b.name)
      }),
    uncovered,
    totals: {
      subjects: subjects.length,
      assessments: items.length,
      create: items.filter(i => i.status === 'CREATE').length,
      update: items.filter(i => i.status === 'UPDATE').length,
      uncoveredSubjects: new Set(uncovered.map(u => u.subjectId)).size,
    },
  }
}

/**
 * Whether a school's existing scale says the same thing as the report card's.
 * A mismatch means printed grades will not match entered marks, which is the
 * kind of thing nobody notices until a parent does.
 */
export function compareGradingScale(scale, want = []) {
  const got = Array.isArray(scale?.levels) ? scale.levels : []
  want = Array.isArray(want) ? want : (want?.levels || [])
  const key = lv => `${String(lv.label).trim().toUpperCase()}:${lv.minPercent}-${lv.maxPercent}`
  const wantKeys = want.map(key).sort()
  const gotKeys = got.map(key).sort()
  return {
    matches: wantKeys.length === gotKeys.length && wantKeys.every((k, i) => k === gotKeys[i]),
    missing: wantKeys.filter(k => !gotKeys.includes(k)),
    extra: gotKeys.filter(k => !wantKeys.includes(k)),
  }
}
