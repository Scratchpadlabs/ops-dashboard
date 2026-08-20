/**
 * Matching an import row onto a class that School Setup actually holds.
 *
 * Pure — no Firestore, no Vue. The caller reads the `classes` collection and
 * hands the documents in; everything here is key arithmetic, so the behaviour
 * is checkable in isolation (`node tools/check_class_lookup.mjs`) rather than
 * only against a live school.
 *
 * Split out of src/composables/useImport.js, which now reads the collection
 * and delegates. ImportReview.vue imports normalizeGrade from useImport still,
 * which re-exports it from here.
 */
import { classify, GRADE } from './educationKB.js'
import { normalizeSectionValue } from './classResolver.js'

// ── Grade normalization — delegates to the shared education knowledge base
// (src/utils/educationKB.js), which is seeded from the very same
// functions/shared/education_kb.json that generate_import/education_kb.py reads.
// The review UI needs the same "does this row's class-section exist" answer
// the Cloud Function used when it raised the flag, and the only way to
// guarantee that is one shared vocabulary rather than two hand-synced
// roman-numeral tables (which is what this used to be). ─────────────────────
export function normalizeGrade(g) {
  const s = (g || '').trim()
  if (!s) return ''
  // expect: GRADE is correct here — every caller already knows this value
  // came from a grade column, the context that lets a bare 'V' read as 5.
  const r = classify(s, { expect: GRADE })
  return r.type === GRADE && r.canonical ? r.canonical : s.toUpperCase()
}

// Board tokens stripped, so a teacher row's "SCI_CBSE_A" resolves to the same
// class as the configured "SCI_A". One rule, shared with the Cloud Function's
// normalize_section and the wizard's class derivation.
export function normalizeSection(s) {
  return normalizeSectionValue(s)
}

/**
 * Comparison key for a class DOCUMENT id, so "Play_Group_A", "play group a"
 * and "PLAY-GROUP-A" all read as the same class.
 *
 * Deliberately separate from normalizeGrade: this one understands nothing
 * about grades, it only makes an id typed into a spreadsheet comparable with
 * one School Setup wrote.
 */
export function classIdKey(v) {
  return String(v ?? '').trim().toLowerCase()
    .replace(/[\s_\-/.]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

/**
 * @param {Array<{id: string, clazz?: string, section?: string, subjects?: Array}>} classDocs
 * @returns {{classLookup: Map, classByDocId: Map, subjectsByClass: Map}}
 */
export function buildClassLookup(classDocs = []) {
  const classLookup = new Map()   // `${normGrade}|${normSection}` -> class id
  const classByDocId = new Map()  // classIdKey(doc id)            -> class id
  const subjectsByClass = new Map()
  for (const c of classDocs) {
    classLookup.set(`${normalizeGrade(c.clazz)}|${normalizeSection(c.section)}`, c.id)
    classByDocId.set(classIdKey(c.id), c.id)
    subjectsByClass.set(c.id, (c.subjects || []).map(s => s.subjectId).filter(Boolean))
  }
  return { classLookup, classByDocId, subjectsByClass }
}

/**
 * A row's class, from whichever shape the file used.
 *
 * The (grade, section) pair is tried FIRST and is untouched — a file that
 * resolved before resolves identically now, by the same key.
 *
 * The fallback exists because a school's export can carry the class as ONE
 * complete id instead of two columns. Hillgreen's 2026-27 export dropped its
 * Section column and put "Play_Group_A" / "8_KALAM" straight into Class; since
 * STUDENT_HEADER_ALIASES maps "class" onto grade, all 1621 rows were rejected
 * as grade "8_KALAM", section (none). Matching that value against the class
 * doc ids School Setup actually holds cannot invent anything — an id that is
 * not configured still misses, and still says so.
 */
export function resolveClassId({ classLookup, classByDocId } = {}, rawGrade, rawSection) {
  if (!classLookup) return null
  const direct = classLookup.get(`${normalizeGrade(rawGrade)}|${normalizeSection(rawSection)}`)
  if (direct) return direct
  if (!classByDocId) return null
  const gradeKey = classIdKey(rawGrade)
  if (gradeKey && classByDocId.has(gradeKey)) return classByDocId.get(gradeKey)
  // "Class" holding a grade token with "Section" in its own column still
  // spells a doc id when the class was authored with a clazz value the KB
  // cannot read back (a school's own notation the seed vocabulary misses).
  const sectionKey = classIdKey(rawSection)
  if (gradeKey && sectionKey && classByDocId.has(`${gradeKey}_${sectionKey}`)) {
    return classByDocId.get(`${gradeKey}_${sectionKey}`)
  }
  return null
}

/**
 * Why a (grade, section) missed, in words an operator can act on.
 *
 * "Class-section not configured for this school." was the entire message, on
 * every one of the rows, with no indication of what was looked for or what
 * exists — so a school whose Classes collection is simply empty looked exactly
 * like one section being misspelled. Both are common and the fixes are
 * completely different, so the message has to tell them apart.
 */
export function describeClassMiss({ classLookup, classByDocId } = {}, rawGrade, rawSection) {
  if (!classLookup || classLookup.size === 0) {
    return 'School Setup has no classes configured at all — set up the class structure before importing.'
  }
  const grade = normalizeGrade(rawGrade)
  const section = normalizeSection(rawSection)
  const sameGrade = [...classLookup.keys()]
    .filter(k => k.split('|')[0] === grade)
    .map(k => k.split('|')[1] || '(no section)')
  const looked = `looked for grade "${grade}" section "${section || '(none)'}"`
  // Say that the whole-id fallback was tried too, so a file carrying complete
  // class ids in one column does not read as a grade-spelling problem.
  const asId = classIdKey(rawGrade)
  const alsoTried = asId && classByDocId && !classByDocId.has(asId)
    ? ` No class document is named "${String(rawGrade).trim()}" either.`
    : ''
  return sameGrade.length
    ? `Class-section not configured — ${looked}. Grade "${grade}" has: ${sameGrade.sort().join(', ')}.${alsoTried}`
    : `Class-section not configured — ${looked}, and grade "${grade}" has no classes at all in School Setup.${alsoTried}`
}
