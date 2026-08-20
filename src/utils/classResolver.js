/**
 * Canonical class resolution — browser side.
 *
 * Hand-port of functions/shared/class_resolver.py, reading the SAME seed
 * (education_kb.json) so a value resolves identically in the dashboard and in
 * the Cloud Functions. The two files must be changed together; the fixture
 * lists in functions/shared/tests/test_class_resolver.py and the cases below
 * are what catch a drift.
 *
 * Grades resolve to an ORDINAL so promotion is arithmetic:
 *     Pre-Nursery -3, Nursery -2, LKG -1, UKG 0, Grades 1..12 = 1..12
 * UKG(0) + 1 === Grade 1, so the pre-primary ladder needs no special case.
 *
 * Ambiguity is never guessed. An unreadable value comes back with
 * confidence 'none', its raw string and the field it came from, so the UI can
 * render `classId: "1st Std" (unrecognized)` instead of a bare arrow.
 */
import SEED from '../../functions/shared/education_kb.json'

export const CONF_HIGH = 'high'
export const CONF_MEDIUM = 'medium'
export const CONF_LOW = 'low'
export const CONF_NONE = 'none'

export const GRADUATED = '__graduated__'

// Some students are parked on a deliberately meaningless class value so they
// cannot reach the app. A KNOWN state, not broken data: it must not block a
// reset and must not be promoted either. Mirrors class_resolver.py.
export const EXCLUDED = '__excluded__'

// Values that LOOK like a parking sentinel. Used only to PROPOSE exclusion in
// the review UI — never to exclude automatically, or a genuine class called
// "Sample House" would vanish for anyone who never opened that screen.
const SENTINEL_HINTS = ['sample', 'test', 'demo', 'dummy', 'placeholder', 'temp', 'xxx']

export function looksLikeSentinel(raw) {
  const text = norm(raw)
  return !!text && SENTINEL_HINTS.some(h => text.includes(h))
}

const PRE_PRIMARY_ORDINALS = { 'Pre-Nursery': -3, Nursery: -2, LKG: -1, UKG: 0 }

/**
 * Board/affiliation tokens, stripped from every section and class identifier.
 *
 * Hillgreen's teacher file writes sections as "SCI_CBSE_A" while its configured
 * classes use "SCI_A" — the same section with the board baked in. A board is
 * identical for every class in a school, so it carries no information in an
 * identifier while permanently coupling it to an affiliation that can change.
 * Stripping here means both spellings resolve to the same class instead of the
 * teacher row being flagged "not in school config".
 *
 * Twin of BOARD_TOKENS / strip_board_tokens in class_resolver.py.
 */
export const BOARD_TOKENS = [
  'CBSE', 'ICSE', 'ISC', 'SSC', 'HSC', 'IB', 'IGCSE', 'CIE', 'NIOS', 'STATE',
]

const BOARD_SET = new Set(BOARD_TOKENS)

/** Split on separators, drop board tokens, rejoin with underscores. */
export function stripBoardTokens(value) {
  const parts = String(value ?? '').trim().split(/[_\-/\s]+/).filter(Boolean)
  const kept = parts.filter(p => !BOARD_SET.has(p.toUpperCase()))
  // An all-board value ("CBSE") would otherwise vanish — keep it as-is.
  return (kept.length ? kept : parts).join('_')
}

/** THE section normalization: board stripped, upper-cased. */
export function normalizeSectionValue(raw) {
  return stripBoardTokens(raw).toUpperCase()
}

const CLASS_ID_SEPARATORS = /[\s_\-/.]+/g

/**
 * Comparison key for a class DOCUMENT id.
 *
 * "Play_Group_A", "play group a" and "PLAY-GROUP-A" all reduce to
 * "play_group_a", so an id typed into a spreadsheet can be compared with one
 * School Setup wrote. Deliberately knows nothing about grades — it is not a
 * parser, only a fold. Twin: class_id_key in functions/shared/class_resolver.py.
 *
 * Exists because a school's export can carry the class as ONE complete id
 * instead of a Class + Section pair (Hillgreen's 2026-27 export), which the
 * (grade, section) lookup cannot see.
 */
export function classIdKey(value) {
  return String(value ?? '').trim().toLowerCase()
    .replace(CLASS_ID_SEPARATORS, '_')
    .replace(/^_+|_+$/g, '')
}

export const CLASS_ID_FIELDS = ['classId', 'currentClassId', 'class_id', 'classID',
  'classid', 'className', 'class_name']
export const GRADE_FIELDS = ['grade', 'clazz', 'standard', 'std', 'class', 'Grade', 'Class']
export const SECTION_FIELDS = ['section', 'sec', 'division', 'div', 'Section']

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII']

function norm(value) {
  return String(value ?? '').trim().toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-_/.,:]+|[\s\-_/.,:]+$/g, '')
}

/** {normalized token -> [canonical, ordinal]} for every grade and alias. */
const GRADE_INDEX = (() => {
  const out = new Map()
  for (const entry of SEED.grades || []) {
    const canon = entry.canonical
    let ordinal = PRE_PRIMARY_ORDINALS[canon]
    if (ordinal === undefined) {
      if (!/^\d+$/.test(String(canon))) continue
      ordinal = parseInt(canon, 10)
    }
    for (const token of [canon, ...(entry.aliases || [])]) {
      out.set(norm(token), [canon, ordinal])
    }
  }
  return out
})()

const MAX_GRADE_WORDS = Math.max(1, ...[...GRADE_INDEX.keys()].map(k => k.split(' ').length))

// The (?=\d|\b) lookahead is deliberate: \b alone does not sit between "e"
// and "7", so "Grade7" lost its 7 before this was fixed once already.
const PREFIX_RE = new RegExp(
  `^\\s*(?:${(SEED.grade_prefixes || []).slice().sort((a, b) => b.length - a.length)
    .map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\s*[:.\\-]?\\s*(?=\\d|\\b)`, 'i')

const SEPARATORS = /[_\-/,:.|]+/g
const DIGIT_ALPHA = /^(\d{1,2})\s*([A-Za-z][A-Za-z0-9 ]*)$/
const ORDINAL_SUFFIX = /^(\d{1,2})(?:st|nd|rd|th)$/i

/**
 * ORDER MATTERS, and must match class_resolver.py's _tokens: separators are
 * normalized to spaces BEFORE the prefix is stripped. Underscore is a word
 * character, so the \b in PREFIX_RE does not fire between "e" and "_" —
 * stripping first left "grade_II_A" with its prefix intact and unresolvable.
 * 1,836 live students were affected.
 */
function tokens(raw) {
  const cleaned = String(raw ?? '').trim().replace(SEPARATORS, ' ')
  return cleaned.replace(PREFIX_RE, '').split(/\s+/).filter(Boolean)
}

const BLANK = {
  gradeToken: null, gradeCanonical: null, gradeOrdinal: null,
  section: '', confidence: CONF_NONE, reason: null,
}

/** Parse one raw class string into its parts. */
export function parseClassValue(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return { ...BLANK, reason: 'empty' }

  const toks = tokens(text)
  if (!toks.length) return { ...BLANK, reason: 'no readable tokens' }

  // Longest leading run first, so "Jr KG" and "Pre Nursery" beat their own
  // fragments.
  for (let span = Math.min(MAX_GRADE_WORDS, toks.length); span >= 1; span--) {
    const hit = GRADE_INDEX.get(norm(toks.slice(0, span).join(' ')))
    if (hit) {
      const [canon, ordinal] = hit
      const section = toks.slice(span).join(' ').trim()
      return {
        gradeToken: toks.slice(0, span).join(' '),
        gradeCanonical: canon,
        gradeOrdinal: ordinal,
        section,
        confidence: section ? CONF_MEDIUM : CONF_HIGH,
        reason: null,
      }
    }
  }

  // "1B" / "10A": a digit run followed by letters is unambiguous.
  const m = toks.length === 1 ? DIGIT_ALPHA.exec(toks[0]) : null
  if (m) {
    const hit = GRADE_INDEX.get(norm(m[1]))
    if (hit) {
      return { gradeToken: m[1], gradeCanonical: hit[0], gradeOrdinal: hit[1],
        section: m[2].trim(), confidence: CONF_MEDIUM, reason: null }
    }
  }

  const o = ORDINAL_SUFFIX.exec(toks[0])
  if (o) {
    const hit = GRADE_INDEX.get(norm(o[1]))
    if (hit) {
      return { gradeToken: toks[0], gradeCanonical: hit[0], gradeOrdinal: hit[1],
        section: toks.slice(1).join(' ').trim(), confidence: CONF_MEDIUM, reason: null }
    }
  }

  // Deliberately NOT guessed: a glued alphabetic run like "IB" could be roman
  // I + section B, or a programme name. Splitting on a hunch is how a roster
  // lands silently in the wrong grade.
  return { ...BLANK, reason: `unrecognized grade in "${text}"` }
}

function firstNonEmpty(doc, fields) {
  for (const f of fields) {
    let v = doc?.[f]
    if (v === null || v === undefined) continue
    if (typeof v === 'string') {
      v = v.trim()
      if (!v) continue
      return [v, f]
    }
    if (v !== '' && !(Array.isArray(v) && !v.length)) return [v, f]
  }
  return [null, null]
}

/** The raw class string for a student, and which field it came from. */
export function rawClassValue(student) {
  if (!student || typeof student !== 'object') return [null, null]
  const [value, field] = firstNonEmpty(student, CLASS_ID_FIELDS)
  if (value) return [String(value), field]

  const [grade, gfield] = firstNonEmpty(student, GRADE_FIELDS)
  if (grade) {
    const [section, sfield] = firstNonEmpty(student, SECTION_FIELDS)
    if (section) return [`${grade}_${section}`, `${gfield}+${sfield}`]
    return [String(grade), gfield]
  }
  return [null, null]
}

/** Never blank — the reset preview rendered bare arrows for these. */
export function describeUnresolved(raw, field) {
  if (!field) return 'no class field on the student record'
  if (raw === null || raw === undefined || raw === '') return `${field}: "" (empty)`
  return `${field}: "${raw}" (unrecognized)`
}

export function notationOf(classIds) {
  let numeric = 0, roman = 0
  for (const cid of classIds || []) {
    const token = (parseClassValue(cid).gradeToken || '').trim()
    if (!token) continue
    if (/^\d+$/.test(token)) numeric++
    else if (/^[IVXivx]+$/.test(token)) roman++
  }
  return numeric > roman ? 'numeric' : 'roman'
}

export function ordinalToToken(ordinal, notation = 'roman') {
  if (ordinal === null || ordinal === undefined) return null
  for (const [canon, o] of Object.entries(PRE_PRIMARY_ORDINALS)) {
    if (o === ordinal) return canon
  }
  if (ordinal >= 1 && ordinal <= 12) {
    return notation === 'numeric' ? String(ordinal) : ROMAN[ordinal - 1]
  }
  return null
}

export function composeClassId(gradeToken, section, separator = '_') {
  if (!gradeToken) return null
  return section ? `${gradeToken}${separator}${section}` : gradeToken
}

/** Everything resolution needs about ONE school, computed once. */
export function buildSchoolContext(classIds = [], classMap = {}, separator = null) {
  const ids = [...(classIds || [])]
  let sep = separator
  if (!sep) {
    sep = '_'
    for (const cid of ids) {
      if (cid.includes('_')) { sep = '_'; break }
      if (cid.includes('-')) { sep = '-'; break }
    }
  }
  const ordinals = {}
  for (const cid of ids) {
    const p = parseClassValue(cid)
    if (p.gradeOrdinal !== null) (ordinals[p.gradeOrdinal] ||= []).push(cid)
  }
  const present = Object.keys(ordinals).map(Number)
  return {
    classIds: ids,
    classIdSet: new Set(ids),
    notation: notationOf(ids),
    separator: sep,
    classMap: { ...(classMap || {}) },
    ordinalsPresent: ordinals,
    maxOrdinal: present.length ? Math.max(...present) : null,
  }
}

/** THE entry point. One student document (or bare class string) -> structure. */
export function resolveClass(student, context = null) {
  const ctx = context || buildSchoolContext()
  let raw, field
  if (typeof student === 'string') { raw = student; field = 'value' }
  else { [raw, field] = rawClassValue(student) }

  if (raw === null || raw === undefined || raw === '') {
    return { raw, rawField: field, ...BLANK, canonicalClassId: null,
      reason: 'no class value', label: describeUnresolved(raw, field) }
  }

  // A confirmed class_map entry is the school's own answer and outranks
  // anything this module can infer.
  const entry = ctx.classMap[raw] || ctx.classMap[norm(raw)]

  // Confirmed parking value: resolved with high confidence to EXCLUDED so the
  // promotion engine leaves the student alone rather than blocking the run.
  if (entry?.excluded) {
    return {
      raw, rawField: field, gradeToken: null, gradeCanonical: null,
      gradeOrdinal: null, section: '', canonicalClassId: EXCLUDED,
      excluded: true, confidence: CONF_HIGH,
      reason: 'excluded from the app by class value',
      label: `${raw} (excluded)`, fromMap: entry.source || 'confirmed',
    }
  }

  if (entry?.canonical_class_id) {
    return {
      raw, rawField: field,
      gradeToken: entry.grade_token ?? null,
      gradeCanonical: entry.grade_canonical ?? null,
      gradeOrdinal: entry.grade_ordinal ?? null,
      section: entry.section || '',
      canonicalClassId: entry.canonical_class_id,
      confidence: entry.source === 'confirmed' ? CONF_HIGH : CONF_MEDIUM,
      reason: null,
      label: entry.canonical_class_id,
      fromMap: entry.source || 'auto',
    }
  }

  const parsed = parseClassValue(raw)
  if (parsed.gradeOrdinal === null) {
    return { raw, rawField: field, ...parsed, canonicalClassId: null,
      label: describeUnresolved(raw, field) }
  }

  const canonical = composeClassId(parsed.gradeToken, parsed.section, ctx.separator)
  let confidence = parsed.confidence
  if (ctx.classIdSet.has(raw) || ctx.classIdSet.has(canonical)) confidence = CONF_HIGH
  return { raw, rawField: field, ...parsed, confidence,
    canonicalClassId: canonical, label: canonical }
}

/**
 * Sort key for a class value: grade order first, then section.
 * Plain string ordering puts "10_A" before "2_A" and "II_Ruby" before
 * "I_Diamond" — both wrong, both previously shipped.
 */
export function classSortKey(classId) {
  const p = parseClassValue(classId)
  return [p.gradeOrdinal === null ? 99 : p.gradeOrdinal,
    (p.section || '').toLowerCase(), String(classId || '').toLowerCase()]
}

export function compareClasses(a, b) {
  const ka = classSortKey(a), kb = classSortKey(b)
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] < kb[i]) return -1
    if (ka[i] > kb[i]) return 1
  }
  return 0
}

/** {rawValue: {raw, field, count, sampleIds}} across a roster. Read-only. */
export function distinctClassValues(students) {
  const out = {}
  for (const s of students || []) {
    const [raw, field] = rawClassValue(s)
    const key = raw ?? ''
    const row = (out[key] ||= { raw, field, count: 0, sampleIds: [] })
    row.count++
    if (row.sampleIds.length < 5 && s.id) row.sampleIds.push(s.id)
  }
  return out
}
