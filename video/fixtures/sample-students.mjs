/**
 * Fictional students for previews and tests. Answers are written as option
 * labels (readable) and turned into the real response shape
 * ({answers: {questionId: {answer: optionId, data: label}}}) against the real
 * survey definitions in aam-surveys.json, so they exercise the same code path
 * a Firestore response does.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolveRoles } from '../src/storyline/buildStoryline.mjs'

export const SURVEYS = JSON.parse(readFileSync(fileURLToPath(new URL('./aam-surveys.json', import.meta.url)), 'utf8'))

export const survey = (id) => ({ id, questions: SURVEYS[id] })

/** {role: label | label[]} → a response doc for `surveyId`. */
export function responseFrom(segment, surveyId, byRole) {
  const roles = resolveRoles(segment, SURVEYS[surveyId])
  const answers = {}
  for (const [role, value] of Object.entries(byRole)) {
    const q = roles[role]
    if (!q) throw new Error(`${surveyId} has no question for role ${role}`)
    const labels = [].concat(value)
    const ids = labels.map((l) => {
      const opt = q.answers.find((o) => o.label.includes(l))
      if (!opt) throw new Error(`${surveyId}/${role}: no option matching "${l}"`)
      return opt.id
    })
    answers[q.id] = Array.isArray(value)
      ? { answer: ids, data: labels }
      : { answer: ids[0], data: labels[0] }
  }
  return { status: 'submitted', answers }
}

const SCHOOL = { id: 'demo', name: 'Sunrise Public School' }
const YEAR = '2025–26'

export const SAMPLES = {
  // Prep: the idol example from the brief — Ronaldo at the start, Virat by the end.
  aarav: {
    segment: 'prep', school: SCHOOL, academicYear: YEAR,
    student: { id: 'demo-aarav', name: 'Aarav Sharma', className: 'IV_A' },
    rounds: {
      start: { survey: survey('AAM1-prep'), response: responseFrom('prep', 'AAM1-prep', {
        idol: 'Cristiano Ronaldo', dream: 'Footballer', superpower: 'Flying',
        food: 'Pizza', sport: 'Football', festival: 'Diwali',
        doWell: 'Solving puzzles and riddles', getBetter: 'spelling difficult words',
        learnAtSchool: 'Learning about space and planets', learnForFun: 'Learning magic tricks',
        notEnjoy: 'Eat bitter vegetables',
      }) },
      end: { survey: survey('AAM2-prep'), response: responseFrom('prep', 'AAM2-prep', {
        idol: 'Virat Kohli', dream: 'Cricketer', superpower: 'Time travel',
        food: 'Pani Puri', sport: 'Cricket', festival: 'Diwali',
        doWell: 'Solving puzzles and riddles', getBetter: 'speaking more confidently',
        notEnjoy: 'Eat bitter vegetables',
        schoolSpecial: 'my school is like my second home',
      }) },
    },
  },

  // Middle: a dream that evolves, a superpower that stays.
  ananya: {
    segment: 'mid', school: SCHOOL, academicYear: YEAR,
    student: { id: 'demo-ananya', name: 'ANANYA IYER', className: 'VI_B' },
    rounds: {
      start: { survey: survey('AAM1-mid'), response: responseFrom('mid', 'AAM1-mid', {
        dream: 'Doctor', superpower: 'Invisibility', freeTime: 'Reading storybooks and novels',
        kindness: 'Helping my classmates with homework', proud: 'Finishing a difficult project',
        dreamActions: ['Studying hard and doing well in subjects', 'Reading books and learning more about my dream field'],
        studyHabits: ['Revising lessons every day', 'Making short notes while studying'],
        academicGoal: 'Solve tricky maths problems faster', academicWhy: 'It will boost my confidence',
        academicSteps: ['Study a little every day instead of only before exams', 'Practise subjects and topics I find difficult more often'],
        personalGoal: 'Be more confident in myself', personalWhy: 'It will help me overcome my fears',
        personalSteps: ['Practise speaking in front of a mirr', 'Read books or stories for fun and learning'],
      }) },
      end: { survey: survey('AAM2-mid'), response: responseFrom('mid', 'AAM2-mid', {
        dream: 'Space scientist', superpower: 'Invisibility', freeTime: 'Learning about space and planets',
        kindness: 'Helping a new student feel comfortable', proud: 'Overcoming my fear',
        dreamActions: ['Asking questions and staying curious', 'Attend workshops, camps, and competitions'],
        studyHabits: ['Asking questions when I don’t understand something', 'Making a study schedule for each subject'],
        academicGoal: 'Understand science experiments and concepts better', academicWhy: 'It will help me in my future career',
        academicSteps: ['Read extra books and use educational videos', 'Ask teachers and my friends when I don’t understand'],
        personalGoal: 'Be more confident in myself', personalWhy: 'It will help me overcome my fears',
        personalSteps: ['Practise speaking in front of a mirr', 'Wake up early and follow a routine'],
        schoolSpecial: 'my teachers always listen to me',
      }) },
    },
  },

  // Middle, sparse: no AAM2 at all and several skipped questions — the
  // fallback path, which is most of what went wrong last year.
  kabir: {
    segment: 'mid', school: SCHOOL, academicYear: YEAR,
    student: { id: 'demo-kabir', name: 'Kabir', className: 'VIII_C' },
    rounds: {
      start: { survey: survey('AAM1-mid'), response: responseFrom('mid', 'AAM1-mid', {
        superpower: 'Super speed', freeTime: 'Cycling',
        personalGoal: 'Take care of my health and fitness',
        personalSteps: ['Eat healthy food and drink enough water', 'Practise my favourite sport regularly'],
      }) },
      end: null,
    },
  },
}
