/**
 * Which AAM question plays which role in the year-wrap video.
 *
 * Survey docs live at schools/{schoolId}/surveys/{AAM1-mid|AAM2-mid|AAM1-prep|AAM2-prep}.
 * AAM1 and AAM2 ask the same questions with the same question and option ids
 * (AAM2 adds "What makes your school special?"), which is what makes the
 * start-of-year vs end-of-year comparison possible.
 *
 * Roles are resolved by question id first and by question text second: one
 * school (Motilal Talera, AAM1-prep) carries a copy of the survey with
 * different ids, and matching by text keeps that school working without a
 * special case. Answers are compared by their label for the same reason —
 * option ids are not guaranteed to match across copies.
 */

export const SEGMENTS = {
  mid: { surveys: { start: 'AAM1-mid', end: 'AAM2-mid' } },
  prep: { surveys: { start: 'AAM1-prep', end: 'AAM2-prep' } },
}

/** role → { ids: [question ids], match: regex on the English question text } */
export const ROLES = {
  mid: {
    superpower: { ids: ['q_000'], match: /superpower/i },
    freeTime: { ids: ['q_001'], match: /enjoy doing the most in your free time/i },
    skillToImprove: { ids: ['q_002'], match: /skill you would like to improve/i },
    kindness: { ids: ['q_003'], match: /show kindness/i },
    proud: { ids: ['q_004'], match: /feel proud of yourself/i },
    dream: { ids: ['q_005'], match: /want to become in the future/i },
    dreamActions: { ids: ['q_006'], match: /two things you will do to achieve your future goal/i },
    studyHabits: { ids: ['q_007'], match: /two study habits/i },
    dreamSkills: { ids: ['q_008'], match: /most important skills you need/i },
    academicGoal: { ids: ['q_009'], match: /academic goal for this year/i },
    academicWhy: { ids: ['q_010'], match: null, after: 'academicGoal' },
    academicSteps: { ids: ['q_011'], match: null, after: 'academicWhy' },
    personalGoal: { ids: ['q_012'], match: /personal goal for this year/i },
    personalWhy: { ids: ['q_013'], match: null, after: 'personalGoal' },
    personalSteps: { ids: ['q_014'], match: null, after: 'personalWhy' },
    schoolSpecial: { ids: ['q_school_special_001'], match: /makes your school special/i },
  },
  prep: {
    superpower: { ids: ['q_87158bf9'], match: /superpower/i },
    dream: { ids: ['q_b0a299c2'], match: /like to be when you grow up/i },
    learnAtSchool: { ids: ['q_e5806a6f'], match: /new thing you want to learn in school/i },
    learnForFun: { ids: ['q_1f846fac'], match: /fun thing you want to learn/i },
    food: { ids: ['q_121e61b7'], match: /favourite food/i },
    doWell: { ids: ['q_054bf981'], match: /can do really well/i },
    sport: { ids: ['q_e8109525'], match: /favourite sport/i },
    difficult: { ids: ['q_b4288b03'], match: /find difficult/i },
    festival: { ids: ['q_37037000'], match: /favourite festival/i },
    getBetter: { ids: ['q_bc7fe01e'], match: /want to get better at/i },
    notEnjoy: { ids: ['q_74f2839e'], match: /do not enjoy/i },
    idol: { ids: ['q_3d537cbf'], match: /who is your idol/i },
    notStudying: { ids: ['q_f2d925c4'], match: /when you are not studying/i },
    schoolSpecial: { ids: ['q_school_special_001'], match: /makes your school special/i },
  },
}
