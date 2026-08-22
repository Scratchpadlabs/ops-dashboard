/**
 * Stage curriculum templates — goals and competencies, applied per stage.
 *
 * The library is src/data/curriculumTemplates.json, extracted verbatim from the
 * NCF stage documents ops supplied. This module turns it into the shape a
 * subject document stores and merges it into what a school already has.
 *
 * MERGE RULE, decided by ops: add what is missing, never overwrite what is
 * there. A goal a school already authored keeps its exact wording and its
 * competencies; the template can only contribute goals and competencies that
 * are absent. Nothing is ever removed. That is what makes this safe to run
 * against a live school whose teachers are already entering against it.
 */
import TEMPLATES from '../data/curriculumTemplates.json'
import QUESTIONS from '../data/feedbackQuestions.json'
import { canonicalize, classify, SUBJECT, COSCHOLASTIC, MEDIUM_CONFIDENCE } from './educationKB.js'

export const STAGE_KEYS = ['foundation', 'prepratory', 'middle', 'secondary']

/** Raw template entry for a stage, or null. */
export function stageTemplate(stage) {
  return TEMPLATES.stages?.[stage] || null
}

/**
 * The template goals that apply to one subject at one stage.
 *
 * Foundational carries no subject split — ops decided every subject at that
 * stage gets all 13 goals — so the subject name is ignored there. Elsewhere the
 * subject is matched by canonicalised name, so a school's "Maths" finds the
 * "Mathematics" slot.
 *
 * Returns [] rather than throwing when there is no match: a school teaching a
 * subject the framework has no goals for is normal, not an error.
 */
export function templateGoalsFor(stage, subjectName) {
  const t = stageTemplate(stage)
  if (!t) return []
  if (t.appliesToAllSubjects) return t.subjects.flatMap(s => s.goals || [])

  const want = resolveSubjectName(subjectName)
  if (!want) return []
  const hit = (t.subjects || []).find(s =>
    resolveSubjectName(s.subject) === want ||
    (s.aliases || []).some(a => resolveSubjectName(a) === want))
  return hit ? (hit.goals || []) : []
}

/**
 * A subject name reduced to something comparable across schools.
 *
 * Runs the name through the knowledge base first, so "Maths", "maths" and
 * "Ganit" all reduce to Mathematics and pick up that slot's goals — this is the
 * whole reason a school does not have to spell subjects our way. Falls back to
 * the plain canonical form when the KB has no confident answer, so an unknown
 * subject still matches itself.
 */
function resolveSubjectName(name) {
  const raw = (name || '').trim()
  if (!raw) return ''
  const hit = classify(raw, { expect: SUBJECT })
  if (hit && hit.canonical && hit.confidence >= MEDIUM_CONFIDENCE &&
      (hit.type === SUBJECT || hit.type === COSCHOLASTIC)) {
    return canonicalize(hit.canonical)
  }
  return canonicalize(raw)
}

/** Every framework subject a stage defines, for mapping a school's own names. */
export function templateSubjectNames(stage) {
  const t = stageTemplate(stage)
  if (!t || t.appliesToAllSubjects) return []
  return (t.subjects || []).map(s => s.subject)
}

/**
 * Subject slots a stage defines that cannot be matched by name alone.
 *
 * "Language 1/2/3" say which language a school teaches first, second and third.
 * That is a per-school fact and must be chosen by a human — inferring it from a
 * name would file Hindi's goals against English.
 */
export function ambiguousSlots(stage) {
  const t = stageTemplate(stage)
  if (!t || t.appliesToAllSubjects) return []
  return (t.subjects || []).map(s => s.subject).filter(n => /^Language\s*\d/i.test(n))
}

/** curricular_goals is stored as [{ "<goal>": ["<competency>", ...] }, ...]. */
function goalText(entry) { return Object.keys(entry || {})[0] || '' }
function goalComps(entry) { return Object.values(entry || {})[0] || [] }

/**
 * Merge template goals into a subject's existing curricular_goals.
 *
 * Returns { goals, addedGoals, addedCompetencies, unchanged } so a caller can
 * show exactly what a run would do before writing anything.
 */
export function mergeCurricularGoals(existing, templateGoals) {
  const out = (existing || []).map(e => ({ [goalText(e)]: [...goalComps(e)] }))
  const index = new Map(out.map((e, i) => [canonicalize(goalText(e)), i]))

  let addedGoals = 0
  let addedCompetencies = 0

  for (const g of templateGoals || []) {
    const text = (g.goal || '').trim()
    if (!text) continue
    const comps = (g.competencies || []).map(c => (c.text || '').trim()).filter(Boolean)
    const key = canonicalize(text)

    if (!index.has(key)) {
      out.push({ [text]: comps })
      index.set(key, out.length - 1)
      addedGoals++
      addedCompetencies += comps.length
      continue
    }

    // Goal already there: keep the school's wording and every competency it
    // holds, and only append ones it is missing.
    const slot = out[index.get(key)]
    const existingText = Object.keys(slot)[0]
    const have = new Set(slot[existingText].map(canonicalize))
    for (const c of comps) {
      if (!have.has(canonicalize(c))) {
        slot[existingText].push(c)
        have.add(canonicalize(c))
        addedCompetencies++
      }
    }
  }

  return {
    goals: out,
    addedGoals,
    addedCompetencies,
    unchanged: addedGoals === 0 && addedCompetencies === 0,
  }
}

// ── Activity feedback questions ─────────────────────────────────────────────
// Student and peer questions are per STAGE, not per subject: every subject at a
// stage carries the same set. Teacher surveys are NOT here — their summaryMap
// text is authored per activity, so they cannot come from a stage template.

/** Terms a subject_feedbacks document is written for. */
export const FEEDBACK_TERMS = ['Term1', 'Term2', 'Optional']

/**
 * Questions for a stage, in the exact shape subject_feedbacks stores.
 *
 * Returns a deep copy so a caller can stamp per-document fields without
 * mutating the shared seed.
 */
export function feedbackQuestionsFor(stage, { peer = false } = {}) {
  const set = QUESTIONS.subjectFeedbacks?.[stage]
  if (!set) return []
  return JSON.parse(JSON.stringify(peer ? (set.peer || []) : (set.student || [])))
}

/**
 * Doc id for a subject's feedback in one term: the SUBJECT's own doc id plus
 * the term — `III_English` + `Term1` -> `III_English_Term1`.
 *
 * Deliberately built from the subject id rather than from grade + canonical
 * name, because live ids carry the school's own spelling: SAMARTH has
 * `III_Maths_Term1` and `III_SST_Term1`, not `III_Mathematics_…` /
 * `III_Social Science_…`.
 */
export function subjectFeedbackDocId(subjectId, term) {
  return `${subjectId}_${term}`
}
