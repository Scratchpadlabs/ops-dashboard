/**
 * Derive a class list from raw student-file rows — standalone.
 *
 * WHY THIS IS SEPARATE FROM structureInference.js
 * The New School wizard's "From a student file" route exists precisely for a
 * school that has NO classes yet. Anything that diffs against configured
 * classes is therefore circular here: you cannot use existing classes to
 * work out what the classes should be. So this module:
 *
 *   - takes ONLY raw rows, never Firestore state
 *   - runs no commit-time validation (no "class-section not configured",
 *     no class lookup, no section resolver) — those all check against
 *     configuration that by definition does not exist yet
 *   - proposes, never writes
 *
 * It is a distinct-values scan of the grade and section columns, nothing more.
 * Grade normalization goes through the shared education knowledge base so a
 * class proposed here matches the class a later import will resolve to —
 * that is the one thing that must NOT diverge.
 */
import { classify, GRADE } from './educationKB.js'

/** Same rule as structureInference.normGrade — keep them identical. */
export function normGrade(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return ''
  const r = classify(s, { expect: GRADE })
  return r.type === GRADE && r.canonical ? r.canonical : s.toUpperCase()
}

export function normSection(raw) {
  return String(raw ?? '').trim().toUpperCase()
}

// Ordering for display: pre-primary first, then numeric/roman grades.
const PRE_PRIMARY = { 'PRE-NURSERY': -4, PRENURSERY: -4, NURSERY: -3, LKG: -2, UKG: -1 }
const ROMAN = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10, XI: 11, XII: 12 }

export function gradeOrder(grade) {
  const g = String(grade || '').trim().toUpperCase()
  if (g in PRE_PRIMARY) return PRE_PRIMARY[g]
  if (g in ROMAN) return ROMAN[g]
  if (/^\d+$/.test(g)) return parseInt(g, 10)
  return 999
}

/**
 * Section used when the file gives a grade but no section at all.
 *
 * Common for pre-primary — a school with one Nursery class often leaves the
 * column blank. structureInference DROPS these rows outright ("a grade with
 * no section can't become a class doc"), which is why Nursery/LKG/UKG went
 * missing from proposals. Here the grade is kept and the section is defaulted,
 * marked `sectionInferred` so the wizard can show it was assumed rather than
 * read — the operator confirms or edits before anything is written.
 */
export const DEFAULT_SECTION = 'A'

/**
 * @param {Array<Object>} rows  raw staged row data ({grade, section, ...})
 * @param {Object} [opts]
 * @param {string[]} [opts.gradeFields]    column names to try, in order
 * @param {string[]} [opts.sectionFields]
 * @returns {{classes: Array, grades: string[], rowsScanned: number,
 *            rowsWithoutGrade: number, sectionsFound: string[]}}
 */
export function deriveClassStructure(rows = [], opts = {}) {
  const gradeFields = opts.gradeFields || ['grade', 'clazz', 'class', 'standard', 'std', 'class_name']
  const sectionFields = opts.sectionFields || ['section', 'sec', 'division', 'div', 'class_section']

  const agg = new Map()          // `${grade}|${section}` -> {grade, section, studentCount}
  const gradesSeen = new Set()
  const sectionsSeen = new Set()
  let rowsWithoutGrade = 0

  // Column names are matched case- and separator-insensitively: real exports
  // write "Class", "Section", "CLASS", "class_name" for the same thing.
  const keyOf = (k) => String(k).toLowerCase().replace(/[^a-z]/g, '')
  const pick = (row, fields) => {
    if (!row) return ''
    const wanted = fields.map(keyOf)
    for (const w of wanted) {
      for (const [k, v] of Object.entries(row)) {
        if (keyOf(k) !== w) continue
        if (v !== null && v !== undefined && String(v).trim()) return String(v).trim()
      }
    }
    return ''
  }

  // Canonical form GROUPS ("III" and "3" are one grade); the school's own
  // spelling LABELS. The KB canonicalises roman to numeric, so labelling with
  // the canonical form would rename a "III" file's classes to "3_A" — every
  // school in the estate writes III_A. Group by canonical, label by the most
  // common raw token actually seen.
  const tokenCounts = new Map()   // canonical -> Map(rawToken -> count)

  for (const row of rows) {
    const rawGrade = pick(row, gradeFields)
    const grade = normGrade(rawGrade)
    if (!grade) { rowsWithoutGrade++; continue }
    gradesSeen.add(grade)

    // Kept as written — 'Nursery' must not become 'NURSERY'.
    const token = String(rawGrade).trim()
    if (!tokenCounts.has(grade)) tokenCounts.set(grade, new Map())
    const tc = tokenCounts.get(grade)
    tc.set(token, (tc.get(token) || 0) + 1)

    const rawSection = pick(row, sectionFields)
    const section = normSection(rawSection)
    if (section) sectionsSeen.add(section)

    const key = `${grade}|${section}`
    if (!agg.has(key)) {
      agg.set(key, { grade, section, rawSection, studentCount: 0 })
    }
    agg.get(key).studentCount++
  }

  // A grade seen BOTH with and without a section means some rows just left the
  // column blank — those belong to the real sections, not to an invented one,
  // so the sectionless bucket is folded away rather than becoming "Nursery_A"
  // alongside a genuine "Nursery_B".
  const gradesWithSection = new Set(
    Array.from(agg.values()).filter(v => v.section).map(v => v.grade))

  /** The spelling this file uses most often for a grade. */
  const labelFor = (canonical) => {
    const tc = tokenCounts.get(canonical)
    if (!tc || !tc.size) return canonical
    return Array.from(tc.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0]
  }

  const classes = []
  for (const v of agg.values()) {
    if (!v.section && gradesWithSection.has(v.grade)) continue
    const sectionInferred = !v.section
    const section = v.section || DEFAULT_SECTION
    const label = labelFor(v.grade)
    classes.push({
      grade: label,
      gradeCanonical: v.grade,
      section,
      docId: `${label}_${section}`,
      studentCount: v.studentCount,
      sectionInferred,
      accepted: true,
    })
  }

  classes.sort((a, b) =>
    gradeOrder(a.grade) - gradeOrder(b.grade) || a.section.localeCompare(b.section))

  return {
    classes,
    grades: Array.from(gradesSeen).sort((a, b) => gradeOrder(a) - gradeOrder(b)).map(labelFor),
    sectionsFound: Array.from(sectionsSeen).sort(),
    rowsScanned: rows.length,
    rowsWithoutGrade,
  }
}
