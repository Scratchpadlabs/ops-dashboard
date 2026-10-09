import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildStoryline, resolveRoles, readAnswer, gradeNumber, firstNameOf } from '../src/storyline/buildStoryline.mjs'
import { splitEmoji, toSecondPerson, sameAnswer } from '../src/storyline/labels.mjs'
import { SAMPLES, SURVEYS, survey, responseFrom } from '../fixtures/sample-students.mjs'

const sceneOf = (s, role) => s.scenes.find((x) => x.role === role)

test('labels: option prefixes and emoji are split off', () => {
  assert.deepEqual(splitEmoji('a) 🚀 Flying'), { text: 'Flying', emoji: '🚀' })
  assert.deepEqual(splitEmoji('Astronaut 👨‍🚀'), { text: 'Astronaut', emoji: '👨‍🚀' })
  assert.deepEqual(splitEmoji('Prime Minister 🇮🇳'), { text: 'Prime Minister', emoji: '🇮🇳' })
  assert.deepEqual(splitEmoji('Engineer'), { text: 'Engineer', emoji: '' })
})

test('labels: first person becomes second person', () => {
  assert.equal(toSecondPerson('My mother'), 'Your mother')
  assert.equal(toSecondPerson('Playing my favourite sport'), 'Playing your favourite sport')
  assert.equal(toSecondPerson('I want to make my parents proud'), 'You want to make your parents proud')
  assert.equal(toSecondPerson('staying calm when I’m angry'), 'Staying calm when you’re angry')
  assert.equal(toSecondPerson('Overcoming my fear'), 'Overcoming your fear')
})

test('labels: answers compare by text, not emoji or case', () => {
  assert.ok(sameAnswer('Cricketer 🏏', 'cricketer'))
  assert.ok(!sameAnswer('Cristiano Ronaldo ⚽', 'Virat Kohli 🏏'))
})

test('every role resolves in every current survey', () => {
  for (const [seg, ids] of [['mid', ['AAM1-mid', 'AAM2-mid']], ['prep', ['AAM1-prep', 'AAM2-prep']]]) {
    for (const id of ids) {
      const roles = resolveRoles(seg, SURVEYS[id])
      const expected = id.startsWith('AAM1') ? Object.keys(roles).filter((r) => r !== 'schoolSpecial') : Object.keys(roles)
      for (const r of expected) assert.ok(roles[r], `${id} missing ${r}`)
    }
  }
})

test('the copy with different question ids still resolves by text', () => {
  const roles = resolveRoles('prep', SURVEYS['AAM1-prep@legacyIds'])
  for (const r of ['idol', 'dream', 'superpower', 'food', 'sport']) assert.ok(roles[r], `legacy copy missing ${r}`)
  assert.match(roles.idol.questionText, /idol/i)
})

test('mid "why" questions with identical text resolve by position', () => {
  const roles = resolveRoles('mid', SURVEYS['AAM1-mid'].map((q) => ({ ...q, id: `x_${q.id}` })))
  const qs = SURVEYS['AAM1-mid']
  assert.equal(roles.academicWhy.id, `x_${qs[10].id}`)
  assert.equal(roles.personalWhy.id, `x_${qs[13].id}`)
  assert.equal(roles.personalSteps.id, `x_${qs[14].id}`)
})

test('readAnswer resolves ids, falls back to stored label, handles multi-select', () => {
  const q = { id: 'q1', answers: [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }] }
  assert.deepEqual(readAnswer(q, { answers: { q1: { answer: 'b', data: 'Beta' } } }), ['Beta'])
  assert.deepEqual(readAnswer(q, { answers: { q1: { answer: ['a', 'b'], data: ['Alpha', 'Beta'] } } }), ['Alpha', 'Beta'])
  assert.deepEqual(readAnswer(q, { answers: { q1: { answer: 'zz', data: 'Old label' } } }), ['Old label'])
  assert.deepEqual(readAnswer(q, { answers: {} }), [])
  assert.deepEqual(readAnswer(q, null), [])
})

test('prep: the idol evolves from Ronaldo to Virat Kohli', () => {
  const s = buildStoryline(SAMPLES.aarav)
  const idol = sceneOf(s, 'idol')
  assert.equal(idol.type, 'evolution')
  assert.equal(idol.mode, 'changed')
  assert.equal(idol.start.text, 'Cristiano Ronaldo')
  assert.equal(idol.end.text, 'Virat Kohli')
  assert.equal(idol.end.emoji, '🏏')
  const favs = s.scenes.find((x) => x.type === 'favourites').items
  assert.equal(favs.find((f) => f.role === 'food').was.text, 'Pizza')
  assert.equal(favs.find((f) => f.role === 'festival').was, null, 'same answer both rounds → no "was"')
  assert.equal(s.scenes.at(-1).next, 'Next stop: Class 5!')
  assert.equal(s.scenes[0].name, 'Aarav')
})

test('mid: dream changes, superpower stays, goals carry why + steps', () => {
  const s = buildStoryline(SAMPLES.ananya)
  assert.equal(sceneOf(s, 'dream').mode, 'changed')
  assert.equal(sceneOf(s, 'superpower').mode, 'same')
  const plan = s.scenes.find((x) => x.type === 'list')
  assert.match(plan.title, /^To become a Space scientist/)
  assert.equal(plan.items.length, 4)
  const [academic, personal] = s.scenes.filter((x) => x.type === 'goal')
  assert.equal(academic.was.text, 'Solve tricky maths problems faster', 'goal changed → start goal shown')
  assert.equal(personal.was, null)
  assert.equal(academic.steps.length, 2)
  assert.ok(academic.why)
  assert.equal(s.scenes[0].name, 'Ananya', 'ALL CAPS names are title-cased')
  assert.ok(s.scenes.some((x) => x.type === 'quote' && x.quote.startsWith('I like that my teachers')))
  assert.deepEqual(s.warnings, [])
})

test('sparse: no AAM2, skipped questions → fallbacks and warnings, still renderable', () => {
  const s = buildStoryline(SAMPLES.kabir)
  assert.equal(s.renderable, true)
  const dream = sceneOf(s, 'dream')
  assert.equal(dream.type, 'single')
  assert.equal(dream.fallback, true)
  assert.equal(sceneOf(s, 'superpower').type, 'single')
  assert.ok(!s.scenes.some((x) => x.type === 'quote'), 'no AAM2 → no school quote')
  assert.ok(!s.scenes.some((x) => x.type === 'goal' && x.kicker.includes('ACADEMIC')))
  assert.ok(s.warnings.some((w) => w.includes('No end-of-year')))
  assert.ok(s.warnings.some((w) => w.startsWith('dream:')))
  assert.equal(s.durationInFrames, s.scenes.reduce((n, x) => n + x.durationInFrames, 0))
})

test('no responses at all → not renderable, with a reason', () => {
  const s = buildStoryline({ segment: 'mid', student: { id: 'x', name: 'X' }, rounds: {} })
  assert.equal(s.renderable, false)
  assert.match(s.reason, /No AAM1 or AAM2/)
})

test('only AAM2 answered → end answers used as single statements', () => {
  const s = buildStoryline({
    segment: 'prep', student: { id: 'z', name: 'Zoya' },
    rounds: { end: { survey: survey('AAM2-prep'), response: responseFrom('prep', 'AAM2-prep', { idol: 'Mary Kom' }) } },
  })
  const idol = sceneOf(s, 'idol')
  assert.equal(idol.type, 'single')
  assert.equal(idol.line, 'This year, your hero was')
  assert.equal(idol.answer.text, 'Mary Kom')
})

test('copy variants are stable per student', () => {
  const a = buildStoryline(SAMPLES.ananya)
  const b = buildStoryline(SAMPLES.ananya)
  assert.deepEqual(a.scenes, b.scenes)
})

test('grade and name helpers', () => {
  assert.equal(gradeNumber('VI_B'), 6)
  assert.equal(gradeNumber('10-A'), 10)
  assert.equal(gradeNumber('Grade 3'), 3)
  assert.equal(gradeNumber('UKG'), null)
  assert.equal(firstNameOf({ name: '  riya   patel ' }), 'Riya')
  assert.equal(firstNameOf({ name: '' }), '')
})

import { segmentFor, storyInput, AAM_SURVEY_IDS } from '../src/storyline/roster.mjs'

test('roster: segment comes from the survey answered, then from grade', () => {
  assert.deepEqual(AAM_SURVEY_IDS, ['AAM1-mid', 'AAM2-mid', 'AAM1-prep', 'AAM2-prep'])
  assert.equal(segmentFor({ respondedIn: ['AAM2-prep'], gradeOrdinal: 7 }), 'prep', 'assigned survey wins over grade')
  assert.equal(segmentFor({ respondedIn: [], gradeOrdinal: 4 }), 'prep')
  assert.equal(segmentFor({ gradeOrdinal: 8 }), 'mid')
  assert.equal(segmentFor({ gradeOrdinal: 2 }), null)
  assert.equal(segmentFor({ gradeOrdinal: 9 }), null)
})

test('roster: storyInput pairs each round with its survey, null when missing', () => {
  const surveys = { 'AAM1-mid': survey('AAM1-mid'), 'AAM2-mid': survey('AAM2-mid') }
  const r1 = responseFrom('mid', 'AAM1-mid', { dream: 'Doctor' })
  const input = storyInput({ segment: 'mid', student: { id: 's', name: 'Riya' }, surveys, responses: { 'AAM1-mid': r1 } })
  assert.equal(input.rounds.start.response, r1)
  assert.equal(input.rounds.end, null)
  assert.equal(buildStoryline(input).scenes.find((x) => x.role === 'dream').answer.text, 'Doctor')
})
