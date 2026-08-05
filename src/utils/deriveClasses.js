/**
 * Derive a class list from raw student-file rows — standalone.
 *
 * WHY THIS EXISTS
 * The New School wizard's "From a student file" route is for a school that has
 * NO classes yet. Anything that diffs against configured classes is therefore
 * circular: you cannot use existing classes to work out what the classes
 * should be. The Import commit path does exactly that — useImport.js's
 * buildStudentsPlan rejects every row with "Class-section not configured for
 * this school" when the class lookup is empty — which is why this route
 * cannot go through it.
 *
 * So this module takes ONLY raw rows, never Firestore state, runs no
 * commit-time validation, and proposes rather than writes.
 *
 * PARSING IS NOT REIMPLEMENTED HERE. Grade/section parsing is delegated to
 * utils/classResolver.js — the shared resolver mirrored by
 * functions/shared/class_resolver.py. This repo has already deleted two
 * independent class parsers for getting it wrong; this module must not become
 * a third. It adds only the aggregation and ID rules on top.
 */
import {
  parseClassValue, stripBoardTokens, normalizeSectionValue as normSection,
} from './classResolver.js'

export { stripBoardTokens, normSection }

/**
 * Section used when the file gives a grade but no section at all.
 *
 * Common for pre-primary — a school with one Nursery class often leaves the
 * column blank. structureInference DROPS those rows ("a grade with no section
 * can't become a class doc"), which is why Nursery/LKG/UKG went missing from
 * proposals. Here the grade is kept and the section defaulted, flagged
 * `sectionInferred` so the wizard shows it was assumed rather than read.
 */
export const DEFAULT_SECTION = 'A'

/** Ordering key, via the shared resolver so pre-primary sorts correctly. */
export function gradeOrder(gradeToken) {
  const p = parseClassValue(gradeToken)
  return p.gradeOrdinal === null ? 999 : p.gradeOrdinal
}

export function deriveClassStructure(rows = [], opts = {}) {
  const gradeFields = opts.gradeFields || ['grade', 'clazz', 'class', 'standard', 'std', 'class_name']
  const sectionFields = opts.sectionFields || ['section', 'sec', 'division', 'div', 'class_section']

  // Column names matched case- and separator-insensitively: real exports write
  // "Class", "Section", "CLASS", "class_name" for the same thing.
  const keyOf = (k) => String(k).toLowerCase().replace(/[^a-z]/g, '')
  const pick = (row, fields) => {
    if (!row) return ''
    for (const want of fields.map(keyOf)) {
      for (const [k, v] of Object.entries(row)) {
        if (keyOf(k) !== want) continue
        if (v !== null && v !== undefined && String(v).trim()) return String(v).trim()
      }
    }
    return ''
  }

  const agg = new Map()
  const sectionsSeen = new Set()
  let rowsWithoutGrade = 0

  for (const row of rows) {
    const rawGrade = pick(row, gradeFields)
    if (!rawGrade) { rowsWithoutGrade++; continue }

    // The resolver strips the "Grade " prefix and keeps the school's own
    // notation: "Grade VI" -> gradeToken "VI", canonical "6". Labelling with
    // the canonical form would rename a roman school's classes to "6_A".
    const parsed = parseClassValue(rawGrade)
    if (parsed.gradeOrdinal === null) { rowsWithoutGrade++; continue }

    const gradeToken = parsed.gradeToken

    // A stream in the grade cell ("Grade XI Science") comes back as the
    // resolver's `section`. Kept in the ID by decision — XI Science and XI
    // Commerce are genuinely different classes — and placed before the
    // section so IDs read grade → stream → section.
    const stream = stripBoardTokens(parsed.section)
    const section = normSection(pick(row, sectionFields))
    if (section) sectionsSeen.add(section)

    const key = `${parsed.gradeCanonical}|${stream.toUpperCase()}|${section}`
    if (!agg.has(key)) {
      agg.set(key, {
        gradeToken, gradeCanonical: parsed.gradeCanonical, stream, section,
        studentCount: 0, tokenCounts: new Map(),
      })
    }
    const bucket = agg.get(key)
    bucket.studentCount++
    bucket.tokenCounts.set(gradeToken, (bucket.tokenCounts.get(gradeToken) || 0) + 1)
  }

  // A grade+stream seen BOTH with and without a section means some rows just
  // left the column blank — those belong to the real sections, not to an
  // invented one, so the sectionless bucket is folded away rather than
  // becoming "Nursery_A" beside a genuine "Nursery_B".
  const withSection = new Set(
    Array.from(agg.values()).filter(v => v.section)
      .map(v => `${v.gradeCanonical}|${v.stream.toUpperCase()}`))

  const classes = []
  for (const v of agg.values()) {
    if (!v.section && withSection.has(`${v.gradeCanonical}|${v.stream.toUpperCase()}`)) continue
    const sectionInferred = !v.section
    const section = v.section || DEFAULT_SECTION
    // Most common spelling this file uses for the grade.
    const label = Array.from(v.tokenCounts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0]
    // "Play Group" is a legitimate grade token but must not put a space in an
    // ID next to underscore separators — "Play Group_A" reads as a typo.
    // The human-readable form stays on `grade`; only the ID is normalised.
    const idToken = (t) => String(t).trim().replace(/\s+/g, '_')
    const docId = [idToken(label), v.stream && idToken(v.stream), section]
      .filter(Boolean).join('_')
    classes.push({
      grade: label,
      gradeCanonical: v.gradeCanonical,
      stream: v.stream || '',
      section,
      docId,
      studentCount: v.studentCount,
      sectionInferred,
      accepted: true,
    })
  }

  classes.sort((a, b) =>
    gradeOrder(a.grade) - gradeOrder(b.grade)
    || a.stream.localeCompare(b.stream)
    || a.section.localeCompare(b.section))

  const gradeSeq = []
  for (const c of classes) if (!gradeSeq.includes(c.grade)) gradeSeq.push(c.grade)

  return {
    classes,
    grades: gradeSeq,
    sectionsFound: Array.from(sectionsSeen).sort(),
    rowsScanned: rows.length,
    rowsWithoutGrade,
  }
}
