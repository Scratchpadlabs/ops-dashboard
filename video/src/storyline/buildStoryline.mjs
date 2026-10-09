/**
 * AAM answers → the scene list of one student's year-wrap video.
 *
 * Pure: no Firestore, no React. The output ("storyline") is plain JSON and
 * is the single thing the renderer consumes, so ops can review and edit it
 * (fix a name, swap a line) before rendering, and a re-render of one child
 * never needs the surveys again.
 *
 * Missing data is the normal case, not the exception — a child may have
 * skipped AAM2, skipped a question, or (one school) answered a copy of the
 * survey with different ids. Every scene therefore degrades in steps:
 *   both rounds, different answers → "it evolved" scene
 *   both rounds, same answer       → "it stayed" scene
 *   one round only                 → single-statement scene
 *   neither                        → generic fallback (key scenes) or dropped
 * and every degradation is recorded in `warnings` for the review screen.
 */
import { ROLES, SEGMENTS } from './questions.mjs'
import { present, sameAnswer, splitEmoji } from './labels.mjs'
import { COPY, FALLBACKS, pick } from './copy.mjs'

export const FPS = 30
const sec = (s) => Math.round(s * FPS)

export const DURATIONS = {
  intro: sec(5), evolution: sec(7), single: sec(5), list: sec(6.5), goal: sec(7.5),
  pair: sec(6.5), favourites: sec(8), quote: sec(5.5), funFact: sec(5), outro: sec(6),
}

/** role → question, for one survey's question list. */
export function resolveRoles(segment, questions = []) {
  const roles = ROLES[segment]
  if (!roles) throw new Error(`Unknown segment: ${segment}`)
  const byId = new Map(questions.map((q, i) => [String(q.id), i]))
  const text = (q) => (typeof q.questionText === 'object' ? q.questionText?.en : q.questionText) || ''
  const out = {}
  for (const [role, spec] of Object.entries(roles)) {
    let idx = spec.ids.map((id) => byId.get(id)).find((i) => i !== undefined)
    if (idx === undefined && spec.match) idx = questions.findIndex((q) => spec.match.test(text(q)))
    // "Why is this goal important to you?" appears twice with identical text,
    // so those roles are located by position relative to their goal.
    if ((idx === undefined || idx < 0) && spec.after && out[spec.after]) {
      const prev = questions.indexOf(out[spec.after])
      if (prev >= 0 && questions[prev + 1]) idx = prev + 1
    }
    if (idx !== undefined && idx >= 0) out[role] = questions[idx]
  }
  return out
}

const optionLabel = (o) => (typeof o?.label === 'object' ? o.label?.en : o?.label) ?? ''

/**
 * One question's chosen option labels in one response, or [] if unanswered.
 * Responses store {answer: optionId | optionId[], data: label | label[]};
 * the id is authoritative, `data` is the fallback when an id doesn't resolve.
 */
export function readAnswer(question, response) {
  if (!question || !response?.answers) return []
  const entry = response.answers[String(question.id)]
  if (!entry) return []
  const ids = [].concat(entry.answer ?? [])
  const data = [].concat(entry.data ?? [])
  return ids.map((id, i) => {
    const opt = (question.answers || []).find((o) => String(o.id) === String(id))
    return opt ? optionLabel(opt) : (typeof data[i] === 'string' ? data[i] : '')
  }).filter((s) => String(s).trim())
}

function roundAnswers(segment, round) {
  if (!round?.survey || !round?.response) return null
  const roles = resolveRoles(segment, round.survey.questions || [])
  const out = {}
  for (const [role, q] of Object.entries(roles)) out[role] = readAnswer(q, round.response)
  return out
}

/** Roman / numeric grade of "VI_A", "6-B", "Grade 6" → 6 */
export function gradeNumber(className) {
  const g = String(className || '').trim().toUpperCase().split(/[_\-\s]/).filter(Boolean)
  const ROMAN = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10, XI: 11, XII: 12 }
  for (const part of g) {
    if (ROMAN[part]) return ROMAN[part]
    if (/^\d{1,2}$/.test(part)) return parseInt(part, 10)
  }
  return null
}

export function firstNameOf(student) {
  const raw = student?.firstName || String(student?.name || '').trim().split(/\s+/)[0] || ''
  const clean = raw.replace(/[^\p{L}\p{M}'.-]/gu, '')
  return clean ? clean.charAt(0).toUpperCase() + clean.slice(1).toLowerCase() : ''
}

export function buildStoryline({ segment, student = {}, school = {}, academicYear = '', rounds = {} }) {
  if (!SEGMENTS[segment]) throw new Error(`Unknown segment: ${segment}`)
  const warnings = []
  const seed = String(student.id || student.name || '')
  const start = roundAnswers(segment, rounds.start)
  const end = roundAnswers(segment, rounds.end)
  if (!start) warnings.push('No start-of-year (AAM1) response — using end-of-year answers only')
  if (!end) warnings.push('No end-of-year (AAM2) response — using start-of-year answers only')
  if (!start && !end) {
    return { renderable: false, reason: 'No AAM1 or AAM2 response', segment, student, warnings, scenes: [] }
  }

  const first = (round, role) => round?.[role]?.[0]
  const all = (round, role) => round?.[role] || []
  const latest = (role) => all(end, role).length ? all(end, role) : all(start, role)

  const firstName = firstNameOf(student)
  if (!firstName) warnings.push('Student name missing — the video says "Superstar"')
  const name = firstName || 'Superstar'
  const grade = gradeNumber(student.className)

  const scenes = []
  const add = (type, data) => scenes.push({ type, durationInFrames: DURATIONS[type], ...data })

  /** start vs end of one single-choice role → evolution / single / fallback / nothing */
  function compare(role, { required = false } = {}) {
    const a = first(start, role)
    const b = first(end, role)
    const copy = COPY[segment][role]
    const kicker = copy.kicker
    if (a && b) {
      const same = sameAnswer(a, b)
      return ['evolution', {
        role, kicker, mode: same ? 'same' : 'changed',
        startLine: pick(copy.startLine, seed + role),
        endLine: pick(same ? copy.sameLine : copy.changedLine, seed + role),
        start: present(a), end: present(b),
      }]
    }
    if (a || b) {
      warnings.push(`${role}: answered in ${a ? 'AAM1' : 'AAM2'} only`)
      return ['single', {
        role, kicker,
        line: pick(a ? copy.startLine : copy.onlyLine, seed + role),
        answer: present(a || b),
      }]
    }
    if (required) {
      warnings.push(`${role}: unanswered in both rounds — generic fallback used`)
      return ['single', { role, kicker, line: FALLBACKS[role].line, answer: FALLBACKS[role].answer, fallback: true }]
    }
    warnings.push(`${role}: unanswered in both rounds — scene skipped`)
    return null
  }
  const addCompare = (role, opts) => { const r = compare(role, opts); if (r) add(...r) }

  add('intro', {
    schoolName: school.name || '', name, academicYear,
    classLabel: student.className ? `Class ${String(student.className).replace(/_/g, ' ')}` : '',
    title: COPY[segment].title,
  })

  if (segment === 'mid') {
    addCompare('dream', { required: true })
    const dream = first(end, 'dream') || first(start, 'dream')
    const actions = latest('dreamActions').slice(0, 2)
    const habits = latest('studyHabits').slice(0, 2)
    if (actions.length || habits.length) {
      add('list', {
        kicker: 'THE GAME PLAN',
        title: dream ? `To become ${article(present(dream).text)} you said you'd…` : 'Your plan to get there…',
        items: [...actions, ...habits].map(present),
      })
    } else warnings.push('dreamActions/studyHabits: unanswered — plan scene skipped')
    addCompare('superpower')
    addCompare('freeTime')
    addGoal('academic', 'MY ACADEMIC GOAL')
    addGoal('personal', 'MY PERSONAL GOAL')
    const kind = first(end, 'kindness') || first(start, 'kindness')
    const proud = first(end, 'proud') || first(start, 'proud')
    if (kind || proud) {
      add('pair', {
        kicker: 'YOUR BIG HEART',
        items: [
          kind && { label: 'You show kindness by', answer: present(kind) },
          proud && { label: 'Your proudest moments come from', answer: present(proud) },
        ].filter(Boolean),
      })
    }
  } else {
    addCompare('idol')
    addCompare('dream', { required: true })
    addCompare('superpower')
    const favs = ['food', 'sport', 'festival'].map((role) => {
      const a = first(start, role); const b = first(end, role)
      if (!a && !b) return null
      return {
        role, label: COPY.prep[role].label,
        answer: present(b || a),
        was: a && b && !sameAnswer(a, b) ? present(a) : null,
      }
    }).filter(Boolean)
    if (favs.length) add('favourites', { kicker: 'A FEW OF YOUR FAVOURITE THINGS', items: favs })
    const well = first(end, 'doWell') || first(start, 'doWell')
    const better = first(end, 'getBetter') || first(start, 'getBetter')
    if (well || better) {
      add('pair', {
        kicker: 'YOUR SUPERSKILLS',
        items: [
          well && { label: 'You are awesome at', answer: present(well) },
          better && { label: 'And you are getting better at', answer: present(better) },
        ].filter(Boolean),
      })
    }
    const learn = [first(start, 'learnAtSchool'), first(start, 'learnForFun')].filter(Boolean)
    if (learn.length) add('list', { kicker: 'THIS YEAR YOU SET OUT TO LEARN', title: 'Your learning wishlist', items: learn.map(present) })
    const notEnjoy = first(end, 'notEnjoy') || first(start, 'notEnjoy')
    if (notEnjoy) add('funFact', { kicker: 'FUN FACT', line: 'Something you would happily skip…', answer: present(notEnjoy) })
  }

  const special = first(end, 'schoolSpecial')
  if (special) {
    // The child's own words, kept in first person — it's shown as a quote.
    add('quote', { kicker: 'IN YOUR OWN WORDS', line: 'What makes your school special?', quote: splitEmoji(special).text, schoolName: school.name || '' })
  }

  add('outro', {
    name,
    line: pick(COPY[segment].outro, seed),
    next: grade ? `Next stop: Class ${grade + 1}!` : 'On to the next chapter!',
    schoolName: school.name || '',
  })

  return {
    renderable: true, segment, fps: FPS,
    durationInFrames: scenes.reduce((n, s) => n + s.durationInFrames, 0),
    student: { id: student.id || '', name: student.name || '', className: student.className || '' },
    school: { id: school.id || '', name: school.name || '' },
    academicYear, scenes, warnings,
  }

  function addGoal(kind, kicker) {
    const goal = first(end, `${kind}Goal`) || first(start, `${kind}Goal`)
    if (!goal) { warnings.push(`${kind}Goal: unanswered — scene skipped`); return }
    // why/steps are read from the same round as the goal, so they belong to it.
    const round = first(end, `${kind}Goal`) ? end : start
    const startGoal = first(start, `${kind}Goal`)
    add('goal', {
      kicker,
      goal: present(goal),
      was: startGoal && round === end && !sameAnswer(startGoal, goal) ? present(startGoal) : null,
      why: first(round, `${kind}Why`) ? present(first(round, `${kind}Why`)) : null,
      steps: all(round, `${kind}Steps`).slice(0, 2).map(present),
    })
  }
}

function article(role) {
  const r = String(role || '').trim()
  if (!r) return r
  // "a Doctor", "an Engineer", "an IAS officer" — sound, not spelling, for acronyms.
  const vowelSound = /^[aeiou]/i.test(r) || /^(IAS|IPS|ISRO|MBA|MLA|NCC)\b/.test(r)
  return `${vowelSound ? 'an' : 'a'} ${r}`
}
