/**
 * Suggest which framework subject one of a school's subjects corresponds to.
 *
 * WHY THIS EXISTS
 *     The framework names slots, not subjects: Language 1/2/3 rather than
 *     English/Hindi/Marathi, and Preparatory groups Science and Social Science
 *     as "The World Around Us". SAMARTH needed 24 mappings picked by hand, and
 *     a school spanning I–XII needs far more — but they are the same handful of
 *     subject names repeated once per grade.
 *
 * Nothing here writes. Every suggestion is offered for a human to accept or
 * change, because a wrong mapping files one subject's goals against another.
 */
import { canonicalize, classify, SUBJECT, MEDIUM_CONFIDENCE } from './educationKB.js'
import { templateSubjectNames } from './curriculumTemplates.js'

// Language canonicals the knowledge base knows. Used to tell a language subject
// from a subject one — which is the difference between a confident suggestion
// and one that needs a human, because slot ORDER cannot be inferred from a name.
export const LANGUAGE_CANONICALS = [
  'English', 'English Grammar', 'English Literature',
  'Hindi', 'Hindi Grammar', 'Marathi', 'Sanskrit', 'Urdu', 'Telugu', 'Kannada',
  'Tamil', 'Bengali', 'Gujarati', 'Punjabi', 'French', 'German',
  'Second Language', 'Third Language',
]
const LANG_SET = new Set(LANGUAGE_CANONICALS.map(canonicalize))

/** Canonical name for a school's subject, via the knowledge base. */
export function canonicalSubject(name) {
  const raw = (name || '').trim()
  if (!raw) return ''
  const hit = classify(raw, { expect: SUBJECT })
  return (hit && hit.canonical && hit.confidence >= MEDIUM_CONFIDENCE) ? hit.canonical : raw
}

export function isLanguageSubject(name) {
  return LANG_SET.has(canonicalize(canonicalSubject(name)))
}

// Canonical subject -> the framework subject it belongs to, per stage. Only
// where the mapping is a fact about the framework rather than about a school:
// Preparatory has no Science or Social Science, it has "The World Around Us".
const BY_STAGE = {
  prepratory: {
    Science: 'The World Around Us',
    'Social Science': 'The World Around Us',
    EVS: 'The World Around Us',
    'General Awareness': 'The World Around Us',
    Geography: 'The World Around Us',
    History: 'The World Around Us',
    Civics: 'The World Around Us',
    Mathematics: 'Mathematics',
  },
  middle: {
    Science: 'Science', Physics: 'Science', Chemistry: 'Science', Biology: 'Science', EVS: 'Science',
    'Social Science': 'Social Science', History: 'Social Science', Geography: 'Social Science',
    Civics: 'Social Science', 'Political Science': 'Social Science', Economics: 'Social Science',
    Mathematics: 'Mathematics',
  },
}
BY_STAGE.secondary = { ...BY_STAGE.middle }

/**
 * Suggest a framework subject.
 *
 * @returns {{ suggestion: string|null, confidence: 'high'|'low'|'none', reason: string }}
 *   'high' — a fact about the framework; safe to accept in bulk.
 *   'low'  — a language, where only the SLOT ORDER is guessed. Check it.
 *   'none' — no suggestion; the human decides.
 */
export function suggestFrameworkSubject(stage, name, { languageOrder = [] } = {}) {
  const available = new Set(templateSubjectNames(stage))
  if (!available.size) return { suggestion: null, confidence: 'none', reason: 'stage has no subject list' }

  const canon = canonicalSubject(name)

  // Already a framework subject by name — nothing to map.
  if (available.has(canon)) {
    return { suggestion: canon, confidence: 'high', reason: 'matches the framework subject by name' }
  }

  const mapped = (BY_STAGE[stage] || {})[canon]
  if (mapped && available.has(mapped)) {
    return { suggestion: mapped, confidence: 'high', reason: `${canon} is ${mapped} at this stage` }
  }

  if (isLanguageSubject(canon)) {
    // Slots in framework order; which language is first is a school's own fact,
    // so position in languageOrder decides and the result stays 'low'.
    const slots = templateSubjectNames(stage).filter(n => /^Language\s*\d/i.test(n))
    if (!slots.length) return { suggestion: null, confidence: 'none', reason: 'stage has no language slots' }
    const idx = languageOrder.findIndex(l => canonicalize(l) === canonicalize(canon))
    const slot = slots[Math.min(idx === -1 ? 0 : idx, slots.length - 1)]
    return {
      suggestion: slot,
      confidence: 'low',
      reason: `${canon} is a language — check it is ${slot} at this school`,
    }
  }

  return { suggestion: null, confidence: 'none', reason: 'no framework subject corresponds to this' }
}

/**
 * Collapse unmapped subject ids into one row per (stage, canonical name), each
 * carrying the ids it covers — so a decision is made once and applied to every
 * grade that shares the name.
 */
export function groupForMapping(subjectRefs, { languageOrder = [] } = {}) {
  const groups = new Map()
  for (const { subjectId, stage, name } of subjectRefs) {
    const canon = canonicalSubject(name)
    const key = `${stage}::${canonicalize(canon)}`
    if (!groups.has(key)) {
      const s = suggestFrameworkSubject(stage, name, { languageOrder })
      groups.set(key, { key, stage, name: canon, rawNames: new Set(), subjectIds: [], ...s })
    }
    const g = groups.get(key)
    g.subjectIds.push(subjectId)
    g.rawNames.add(name)
  }
  return [...groups.values()]
    .map(g => ({ ...g, rawNames: [...g.rawNames], count: g.subjectIds.length }))
    .sort((a, b) => a.stage.localeCompare(b.stage) || a.name.localeCompare(b.name))
}

/** Expand group choices back to the { [subjectId]: framework } map the plan takes. */
export function expandGroups(groups, choices) {
  const out = {}
  for (const g of groups) {
    const pick = choices[g.key]
    if (!pick) continue
    for (const id of g.subjectIds) out[id] = pick
  }
  return out
}
