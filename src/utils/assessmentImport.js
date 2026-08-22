/**
 * Turning an exam-blueprint row into assessment documents.
 *
 * A blueprint file (the "assessments" import entity) describes an exam for a
 * whole grade band — "Term 1 Exam, grades III-V, 80 written + 20 activity,
 * 3 hours". It does NOT describe one subject. Two bugs followed from ignoring
 * that, and both are what this module exists to prevent:
 *
 *   1. The subject was resolved by matching the ASSESSMENT NAME against the
 *      school's subject names. So a row named "Term 1 Exam" resolved to
 *      nothing and was rejected, while a row that happened to be named
 *      "English" produced one assessment called "English" — which is why the
 *      committed assessments came out named after subjects. A blueprint row
 *      fans out across the subjects of its grade band instead (or names one
 *      explicitly in a `subject` column).
 *
 *   2. maxMarks was `parseFloat(text.replace(/[^\d.]/g, ''))`, which turns the
 *      documented composite form "80 (40+40)" into 804040 — every mark in the
 *      teacher app scaled against a nonsense denominator. parseMaxMarks below
 *      reads composites the way a human does.
 */

/** Numbers in a string, in order. "80 (40+40)" -> [80, 40, 40] */
function numbersIn(text) {
  return (String(text ?? '').match(/\d+(?:\.\d+)?/g) || []).map(Number).filter(n => Number.isFinite(n))
}

/**
 * One marks cell -> a number.
 *
 * Handles the forms these files actually use:
 *   "80"            -> 80
 *   "80 marks"      -> 80
 *   "80 (40+40)"    -> 80   (the bracket is a breakdown OF the 80)
 *   "40+40"         -> 80   (a bare sum IS the total)
 *   ""/"NA"/"-"     -> null
 *
 * Returns { value, note } — `note` is set when the cell said something the
 * caller should show the operator (a breakdown that doesn't add up).
 */
export function parseMarksCell(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return { value: null, note: '' }

  // A trailing parenthetical is a breakdown, not part of the number.
  const bracket = /\(([^)]*)\)/.exec(text)
  const outside = text.replace(/\([^)]*\)/g, ' ')
  const outsideNums = numbersIn(outside)

  let value = null
  if (outsideNums.length === 0) {
    // Only a bracket: "(40+40)" — the breakdown is all we have.
    const inner = numbersIn(bracket ? bracket[1] : '')
    if (!inner.length) return { value: null, note: '' }
    value = /\+/.test(bracket[1]) ? inner.reduce((a, b) => a + b, 0) : inner[0]
  } else if (/\+/.test(outside)) {
    // A bare sum outside brackets is the total: "40+40" -> 80.
    value = outsideNums.reduce((a, b) => a + b, 0)
  } else {
    value = outsideNums[0]
  }

  let note = ''
  if (bracket && outsideNums.length && /\+/.test(bracket[1])) {
    const inner = numbersIn(bracket[1])
    const sum = inner.reduce((a, b) => a + b, 0)
    if (inner.length > 1 && sum !== value) {
      note = `"${text}" — the breakdown adds to ${sum}, not ${value}; used ${value}`
    }
  }
  return { value: Number.isFinite(value) && value > 0 ? value : null, note }
}

/**
 * A blueprint row -> the assessment's maxMarks.
 *
 * `total` wins when the file states one, because that is the row's own answer.
 * Otherwise written + activity is the total, and written alone is the
 * fallback. Every branch reports which columns it used, so an operator can see
 * in the preview where a number came from rather than trusting it blind.
 *
 * @returns {{maxMarks: number|null, source: string, notes: string[]}}
 */
export function parseMaxMarks(row) {
  const d = row || {}
  const notes = []
  const take = (key) => {
    const { value, note } = parseMarksCell(d[key])
    if (note) notes.push(note)
    return value
  }
  const total = take('total')
  const written = take('max_written')
  const activity = take('activity_weight')

  if (total !== null) {
    const parts = (written || 0) + (activity || 0)
    if ((written !== null || activity !== null) && parts !== total) {
      notes.push(`total ${total} but written+activity is ${parts} — used total`)
    }
    return { maxMarks: total, source: 'total', notes }
  }
  if (written !== null && activity !== null) {
    return { maxMarks: written + activity, source: 'max_written + activity_weight', notes }
  }
  if (written !== null) return { maxMarks: written, source: 'max_written', notes }
  if (activity !== null) return { maxMarks: activity, source: 'activity_weight', notes }
  return { maxMarks: null, source: '', notes }
}

/**
 * Which subjects a blueprint row applies to.
 *
 * `subject` names one explicitly. Without it the row covers its whole grade
 * band, so it fans out over every subject of that grade — the semantics a
 * blueprint file actually has.
 *
 * Grade bands come written as "III", "III-V", "III to V", "1,2,3". Each token
 * is normalized by the caller's `normalizeGrade` so this module stays free of
 * the grade vocabulary.
 *
 * @param {Object} row
 * @param {Object} opts
 * @param {Function} opts.normalizeGrade      raw grade token -> canonical form
 * @param {Map}      opts.subjectsByGrade     canonical grade -> [subjectId]
 * @param {Map}      opts.subjectLookup       `${grade}|${name.toLowerCase()}` -> subjectId
 * @returns {{subjectIds: string[], reason: string, grades: string[]}}
 */
export function resolveBlueprintSubjects(row, { normalizeGrade, subjectsByGrade, subjectLookup }) {
  const d = row || {}
  const bandText = String(d.grade_band ?? '').trim() || String(d.stream ?? '').trim()
  const grades = expandGradeBand(bandText, { normalizeGrade, knownGrades: [...subjectsByGrade.keys()] })
  if (!grades.length) {
    return { subjectIds: [], grades: [], reason: bandText
      ? `no subjects for grade band "${bandText}" — add its subjects first`
      : 'row names no grade band, so there is nothing to attach it to' }
  }

  const named = String(d.subject ?? '').trim()
  if (named) {
    const ids = grades
      .map(g => subjectLookup.get(`${g}|${named.toLowerCase()}`))
      .filter(Boolean)
    return ids.length
      ? { subjectIds: Array.from(new Set(ids)), grades, reason: `subject column "${named}"` }
      : { subjectIds: [], grades, reason: `no subject "${named}" in grade(s) ${grades.join(', ')}` }
  }

  const ids = grades.flatMap(g => subjectsByGrade.get(g) || [])
  return ids.length
    ? { subjectIds: Array.from(new Set(ids)), grades, reason: `all subjects of grade(s) ${grades.join(', ')}` }
    : { subjectIds: [], grades, reason: `grade(s) ${grades.join(', ')} have no subjects yet` }
}

/**
 * "III-V" / "III to V" / "1,2,3" / "III" -> the canonical grades it covers.
 *
 * A range is resolved against the grades the school actually HAS (in the order
 * they appear in `knownGrades`) rather than against a numeric guess, so
 * "Nursery-II" works the same as "III-V".
 */
export function expandGradeBand(bandText, { normalizeGrade, knownGrades = [] } = {}) {
  const text = String(bandText ?? '').trim()
  if (!text) return []
  const norm = g => (normalizeGrade ? normalizeGrade(g) : String(g).trim())
  const known = knownGrades.map(String)

  const range = /^\s*(.+?)\s*(?:-|–|—|\bto\b)\s*(.+?)\s*$/i.exec(text)
  if (range) {
    const from = norm(range[1])
    const to = norm(range[2])
    const i = known.indexOf(from)
    const j = known.indexOf(to)
    if (i !== -1 && j !== -1) {
      const [lo, hi] = i <= j ? [i, j] : [j, i]
      return known.slice(lo, hi + 1)
    }
    // One end isn't a grade this school has — fall through to token splitting
    // rather than silently covering the wrong span.
  }

  return Array.from(new Set(
    text.split(/[,;/&]|\band\b/i).map(t => norm(t)).filter(g => g && known.includes(g))
  ))
}
