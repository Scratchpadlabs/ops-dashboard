/**
 * Who gets which year-wrap video, shared by the render service and the
 * dashboard so both agree on segments and survey ids.
 */
import { SEGMENTS } from './questions.mjs'

export const AAM_SURVEY_IDS = Object.values(SEGMENTS).flatMap((s) => [s.surveys.start, s.surveys.end])

// NEP stages: Preparatory = grades 3–5, Middle = 6–8. Only used when a
// student answered neither AAM survey — otherwise the survey they were given
// decides, since that's what the school actually assigned.
export function segmentForGrade(gradeOrdinal) {
  if (gradeOrdinal >= 3 && gradeOrdinal <= 5) return 'prep'
  if (gradeOrdinal >= 6 && gradeOrdinal <= 8) return 'mid'
  return null
}

/** respondedIn: AAM survey ids this student has a response doc in. */
export function segmentFor({ respondedIn = [], gradeOrdinal = null } = {}) {
  const set = new Set(respondedIn)
  for (const [segment, { surveys }] of Object.entries(SEGMENTS)) {
    if (set.has(surveys.start) || set.has(surveys.end)) return segment
  }
  return segmentForGrade(gradeOrdinal)
}

/**
 * buildStoryline() input for one student.
 * surveys: {surveyId: {questions}}, responses: {surveyId: responseDoc}
 */
export function storyInput({ segment, student, school, academicYear, surveys = {}, responses = {} }) {
  const { start, end } = SEGMENTS[segment].surveys
  const round = (id) => (surveys[id] && responses[id] ? { survey: surveys[id], response: responses[id] } : null)
  return { segment, student, school, academicYear, rounds: { start: round(start), end: round(end) } }
}
