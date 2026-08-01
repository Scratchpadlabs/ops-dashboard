/**
 * Education knowledge base — browser side.
 *
 * Byte-for-byte the same seeded knowledge as the import parser: both this
 * module and functions/generate_import/education_kb.py read the SAME
 * education_kb.json. That file lives in the Cloud Function's source folder
 * because `gcloud functions deploy --source .` only uploads that folder —
 * keeping the seed there means the deployed parser and this bundle can never
 * drift, and there is no copy step to forget. Vite inlines the JSON at build.
 *
 * This is a direct port of education_kb.py: same bands, same precedence, same
 * similarity metric (normalized Levenshtein, chosen precisely because it
 * ports exactly — see that file's _similarity comment). Change one, change
 * both; tests/test_education_kb.py pins a parity fixture list.
 *
 * Deterministic first, LLM last resort, human confirm always, cache forever —
 * nothing here calls a model or writes to the overlay.
 */
import SEED from '../../functions/generate_import/education_kb.json'

export const SUBJECT = 'subject'
export const COSCHOLASTIC = 'coscholastic'
export const GRADE = 'grade'
export const SECTION = 'section'
export const UNKNOWN = 'unknown'
export const OTHER = 'other'

export const ENTITY_TYPES = [SUBJECT, COSCHOLASTIC, GRADE, SECTION]

// Bands the UI keys off: >= HIGH auto-applies silently, >= MEDIUM offers a
// one-click suggestion chip, below that is unknown (LLM fallback territory).
export const HIGH_CONFIDENCE = 0.95
export const MEDIUM_CONFIDENCE = 0.80

const EXACT = 1.0
const ALIAS = 0.97
const LEARNED = 0.96
const PATTERN = 0.95

export const TYPE_LABELS = {
  [SUBJECT]: 'Scholastic subject',
  [COSCHOLASTIC]: 'Co-scholastic area',
  [GRADE]: 'Grade',
  [SECTION]: 'Section',
  [OTHER]: 'Something else',
  [UNKNOWN]: 'Unrecognized',
}

export function canonicalize(s) {
  return (s || '').trim().toLowerCase().replace(/[\s\-._&/()]+/g, '')
}

// Normalized Levenshtein similarity in [0,1] — identical algorithm to the
// Python side so both agree on every band boundary.
function similarity(a, b) {
  if (a === b) return 1
  if (!a || !b) return 0
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] !== b[j - 1] ? 1 : 0)))
    }
    prev = cur
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length)
}

// ── Indexes ─────────────────────────────────────────────────────────────────
const INDEX = new Map()
const KIND_KEYS = [[SUBJECT, 'subjects'], [COSCHOLASTIC, 'coscholastic'], [GRADE, 'grades']]
for (const [kind, key] of KIND_KEYS) {
  for (const entry of SEED[key]) {
    for (const alias of entry.aliases || []) {
      const c = canonicalize(alias)
      if (!INDEX.has(c)) INDEX.set(c, [kind, entry.canonical])
    }
  }
}
// Canonicals last so a canonical always beats another entry's alias.
for (const [kind, key] of KIND_KEYS) {
  for (const entry of SEED[key]) INDEX.set(canonicalize(entry.canonical), [kind, entry.canonical])
}

const SECTION_INDEX = new Map()
for (const [family, names] of Object.entries(SEED.section_patterns)) {
  for (const n of names) {
    const c = canonicalize(n)
    if (!SECTION_INDEX.has(c)) SECTION_INDEX.set(c, [n, family])
  }
}

const GRADE_PREFIX_RE = new RegExp(
  `^(?:${[...SEED.grade_prefixes].sort((a, b) => b.length - a.length).map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?=\\d|\\b)\\.?\\s*`, 'i')
const SINGLE_LETTER_RE = /^[A-Za-z]$/
const NUMERIC_RE = /^\d{1,2}$/
const COMPOUND_SECTION_RE = /^[A-Za-z]\s*-?\s*\d{1,2}$/

function stripGradePrefix(value) {
  return (value || '').trim().replace(GRADE_PREFIX_RE, '').trim()
}

function result(type, canonical, confidence, source, alternatives = []) {
  return { type, canonical, confidence: Math.round(confidence * 10000) / 10000, source, alternatives }
}

// ── Overlay (learned kb_entries) ────────────────────────────────────────────
/**
 * Turn raw kb_entries docs into the map classify() takes. A cached `other`
 * answer is as valuable as a positive one — it stops the LLM being asked
 * about that value ever again.
 */
export function buildOverlay(entries) {
  const overlay = new Map()
  for (const e of entries || []) {
    const value = canonicalize(e.value || '')
    const kind = (e.type || '').trim().toLowerCase()
    if (!value || (!ENTITY_TYPES.includes(kind) && kind !== OTHER)) continue
    overlay.set(value, [kind, (e.canonical || '').trim() || null])
  }
  return overlay
}

// ── classify ────────────────────────────────────────────────────────────────
/**
 * Classify one raw value into {type, canonical, confidence, source, alternatives}.
 *
 * `expect` is a context hint ('section' when adding a section, 'subject' when
 * typing a subject) that breaks genuine ties — 'Art' the house name vs Art &
 * Craft the activity, 'V' the section letter vs roman five. It never
 * overrides a confident answer from another family.
 */
export function classify(value, { expect = null, overlay = null } = {}) {
  const raw = (value || '').trim()
  if (!raw) return result(UNKNOWN, null, 0, 'none')

  const canon = canonicalize(raw)

  if (expect === SECTION) {
    const hit = sectionLookup(raw, canon)
    if (hit) return hit
  }
  if ((expect === SUBJECT || expect === COSCHOLASTIC) && INDEX.has(canon)) {
    const [kind, canonical] = INDEX.get(canon)
    if (kind === SUBJECT || kind === COSCHOLASTIC) {
      const src = canonicalize(canonical) === canon ? 'exact' : 'alias'
      return result(kind, canonical, src === 'exact' ? EXACT : ALIAS, src)
    }
  }

  const gradeHit = gradeLookup(raw, canon, expect)
  if (gradeHit) return gradeHit

  // Grades are deliberately excluded here: gradeLookup owns grade resolution
  // end-to-end, and when it declines (a bare 'V' with no grade context) this
  // lookup must not silently re-admit the reading it just rejected.
  if (INDEX.has(canon) && INDEX.get(canon)[0] !== GRADE) {
    const [kind, canonical] = INDEX.get(canon)
    const src = canonicalize(canonical) === canon ? 'exact' : 'alias'
    return result(kind, canonical, src === 'exact' ? EXACT : ALIAS, src)
  }

  const sectionHit = sectionLookup(raw, canon)
  if (sectionHit) return sectionHit

  if (overlay && overlay.has(canon)) {
    const [kind, canonical] = overlay.get(canon)
    return result(kind, canonical || raw, LEARNED, 'learned')
  }

  let bestKind = null, bestCanonical = null, bestRatio = 0
  const alternatives = []
  for (const [candCanon, [kind, canonical]] of INDEX) {
    if (kind === GRADE) continue // grades are exact-or-nothing; a fuzzy grade is a bad guess
    const ratio = similarity(canon, candCanon)
    if (ratio >= MEDIUM_CONFIDENCE) {
      alternatives.push({ type: kind, canonical, confidence: Math.round(ratio * 10000) / 10000 })
    }
    if (ratio > bestRatio) { bestKind = kind; bestCanonical = canonical; bestRatio = ratio }
  }
  if (expect === SECTION) {
    for (const [candCanon, [name]] of SECTION_INDEX) {
      const ratio = similarity(canon, candCanon)
      if (ratio > bestRatio) { bestKind = SECTION; bestCanonical = name; bestRatio = ratio }
    }
  }

  if (bestRatio >= MEDIUM_CONFIDENCE) {
    const alts = alternatives
      .sort((a, b) => b.confidence - a.confidence)
      .filter(a => a.canonical !== bestCanonical)
      .slice(0, 3)
    return result(bestKind, bestCanonical, bestRatio, 'fuzzy', alts)
  }

  return result(UNKNOWN, null, Math.round(bestRatio * 10000) / 10000, 'none')
}

function gradeLookup(raw, canon, expect) {
  const stripped = stripGradePrefix(raw)
  const scanon = canonicalize(stripped)
  const hadPrefix = scanon !== canon
  if (!scanon) return null

  if (INDEX.has(scanon) && INDEX.get(scanon)[0] === GRADE) {
    const canonical = INDEX.get(scanon)[1]
    // A bare single letter is never read as a roman-numeral grade unless the
    // caller explicitly expects one — in a school file 'V' beside a class is
    // far more often section V than grade 5.
    if (SINGLE_LETTER_RE.test(stripped) && !hadPrefix && expect !== GRADE) return null
    const src = canonicalize(canonical) === scanon ? 'exact' : 'alias'
    return result(GRADE, canonical, (src === 'exact' || hadPrefix) ? EXACT : ALIAS, src)
  }

  if (NUMERIC_RE.test(stripped)) {
    const n = parseInt(stripped, 10)
    if (n >= 1 && n <= 12) {
      return result(GRADE, String(n), hadPrefix ? EXACT : PATTERN, hadPrefix ? 'exact' : 'pattern')
    }
  }
  return null
}

function sectionLookup(raw, canon) {
  if (SECTION_INDEX.has(canon)) {
    const [name] = SECTION_INDEX.get(canon)
    const isExact = raw.trim() === name
    return result(SECTION, name, isExact ? EXACT : ALIAS, isExact ? 'exact' : 'alias')
  }
  const stripped = raw.trim()
  if (SINGLE_LETTER_RE.test(stripped)) return result(SECTION, stripped.toUpperCase(), PATTERN, 'pattern')
  if (COMPOUND_SECTION_RE.test(stripped)) {
    return result(SECTION, stripped.replace(/[\s-]+/g, '').toUpperCase(), PATTERN, 'pattern')
  }
  return null
}

// ── normalize ───────────────────────────────────────────────────────────────
/**
 * Canonical display form of `value` read as `kind`, else the trimmed input.
 * Never guesses across families: normalize('Eng', COSCHOLASTIC) is 'Eng',
 * not 'English' — call classify() if you want the family decided for you.
 */
export function normalize(value, kind, { overlay = null } = {}) {
  const r = classify(value, { expect: kind, overlay })
  return r.type === kind && r.canonical ? r.canonical : (value || '').trim()
}

export const isScholastic = (v, overlay = null) => classify(v, { overlay }).type === SUBJECT
export const isCoScholastic = (v, overlay = null) => classify(v, { overlay }).type === COSCHOLASTIC

// ── List accessors (pickers) ────────────────────────────────────────────────
export const listSubjects = () => SEED.subjects.map(e => e.canonical)
export const listCoScholastic = () => SEED.coscholastic.map(e => e.canonical)
export const listGrades = () => SEED.grades.map(e => e.canonical)
export const sectionFamilies = () => Object.keys(SEED.section_patterns)
export function listSectionNames(family = null) {
  if (family) return [...(SEED.section_patterns[family] || [])]
  return Object.values(SEED.section_patterns).flat()
}
export function aliasesFor(canonical, kind) {
  const key = { [SUBJECT]: 'subjects', [COSCHOLASTIC]: 'coscholastic', [GRADE]: 'grades' }[kind]
  if (!key) return []
  return [...(SEED[key].find(e => e.canonical === canonical)?.aliases || [])]
}

// Confidence band a result falls in — the single place the UI decides
// between "apply silently", "offer a chip", and "ask".
export function band(result) {
  if (result.type === UNKNOWN) return 'unknown'
  if (result.confidence >= HIGH_CONFIDENCE) return 'high'
  if (result.confidence >= MEDIUM_CONFIDENCE) return 'medium'
  return 'unknown'
}
