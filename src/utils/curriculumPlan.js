/**
 * Plan a curriculum template run for one school — pure, no Firestore.
 *
 * The plan IS the preview and IS the write input, the same arrangement the
 * promotion engine uses: what a run reports is exactly what it does, because
 * there is no second implementation to drift.
 *
 * SCOPE, decided by ops: add what is missing, never overwrite what is there.
 * A subject a school already authored keeps its goals and wording; the template
 * only contributes goals and competencies that are absent. Nothing is removed,
 * and re-running produces an empty plan.
 */
import { stageForGrade, STAGE_LABELS } from './stages.js'
import {
  templateGoalsFor, mergeCurricularGoals, ambiguousSlots,
  feedbackQuestionsFor, subjectFeedbackDocId, FEEDBACK_TERMS,
} from './curriculumTemplates.js'

/** Grade token from a subject id — `III_English` -> `III`. Mirrors the tabs. */
export function gradeOf(subjectId) {
  return String(subjectId || '').split('_')[0] || ''
}

/**
 * @param {object[]} classes   existing class docs ({ id, clazz, stage })
 * @param {object[]} subjects  existing subject docs ({ id, name, curricular_goals })
 * @param {Set<string>} existingFeedbackIds  subject_feedbacks doc ids already present
 * @param {object} languageMap  { [subjectId]: 'Language 1' } — which of THIS
 *   school's subjects fills each language slot. Without it a school's English
 *   and Hindi match no template at all, because the framework names the slots
 *   (Language 1/2/3) and not the languages.
 */
export function buildCurriculumPlan({
  classes = [], subjects = [], existingFeedbackIds = new Set(), languageMap = {},
} = {}) {
  const subjectRows = []
  const feedbackRows = []
  const warnings = []

  // Grades the school actually teaches, so a subject filed under a grade no
  // class uses is reported rather than silently enriched.
  const gradesInUse = new Set(classes.map(c => (c.clazz || '').trim()).filter(Boolean))

  for (const subj of subjects) {
    const subjectId = subj.id
    const grade = gradeOf(subjectId)
    const stage = stageForGrade(grade)

    if (!stage) {
      warnings.push({
        kind: 'unreadable-grade',
        subjectId,
        message: `${subjectId}: grade "${grade}" does not resolve to a stage — skipped.`,
      })
      continue
    }
    if (gradesInUse.size && !gradesInUse.has(grade)) {
      warnings.push({
        kind: 'grade-not-taught',
        subjectId,
        message: `${subjectId}: no class in this school uses grade "${grade}".`,
      })
    }

    // ── curricular goals ────────────────────────────────────────────────
    // A mapped language slot wins over the subject's own name: "English" finds
    // no framework subject, but the slot it was assigned to does.
    const slot = languageMap[subjectId]
    const tpl = templateGoalsFor(stage, slot || subj.name || subjectId)
    if (!tpl.length) {
      const isLang = ambiguousSlots(stage).length > 0 && !slot
      warnings.push({
        kind: isLang ? 'needs-language-slot' : 'no-template',
        subjectId,
        message: isLang
          ? `${subjectId} ("${subj.name || ''}"): no ${STAGE_LABELS[stage]} template matches. If this is a language subject, map it to a Language slot.`
          : `${subjectId} ("${subj.name || ''}"): no ${STAGE_LABELS[stage]} template matches this subject — goals unchanged.`,
      })
    } else {
      const merged = mergeCurricularGoals(subj.curricular_goals || [], tpl)
      if (!merged.unchanged) {
        subjectRows.push({
          subjectId,
          name: subj.name || subjectId,
          grade,
          stage,
          addedGoals: merged.addedGoals,
          addedCompetencies: merged.addedCompetencies,
          goals: merged.goals,
        })
      }
    }

    // ── subject feedback documents ──────────────────────────────────────
    // Student questions only. The one shape verified against live data
    // (III_English_Term1) carries student questions; where peer questions live
    // is unconfirmed, so none are written.
    const questions = feedbackQuestionsFor(stage)
    if (!questions.length) {
      warnings.push({
        kind: 'no-questions',
        subjectId,
        message: `${STAGE_LABELS[stage]} has no feedback questions — none written for ${subjectId}.`,
      })
      continue
    }
    for (const term of FEEDBACK_TERMS) {
      const docId = subjectFeedbackDocId(subjectId, term)
      if (existingFeedbackIds.has(docId)) continue
      feedbackRows.push({ docId, subjectId, stage, term, questions, questionCount: questions.length })
    }
  }

  // Language slots cannot be matched by name — say so once per stage in use.
  const stagesInUse = [...new Set(subjectRows.concat(feedbackRows).map(r => r.stage))]
  for (const stage of stagesInUse) {
    const slots = ambiguousSlots(stage)
    if (slots.length) {
      warnings.push({
        kind: 'language-slots',
        message: `${STAGE_LABELS[stage]}: ${slots.join(', ')} are slots, not names — a school's own language subjects will not match them automatically.`,
      })
    }
  }

  return {
    subjectRows,
    feedbackRows,
    warnings,
    totals: {
      subjectsTouched: subjectRows.length,
      goalsAdded: subjectRows.reduce((n, r) => n + r.addedGoals, 0),
      competenciesAdded: subjectRows.reduce((n, r) => n + r.addedCompetencies, 0),
      feedbackDocs: feedbackRows.length,
      writes: subjectRows.length + feedbackRows.length,
    },
    isEmpty: subjectRows.length === 0 && feedbackRows.length === 0,
  }
}
