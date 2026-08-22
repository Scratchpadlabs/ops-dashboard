/**
 * Behaviour check for src/utils/assessmentPlan.js, against the arithmetic
 * printed on Hillgreen's own report cards.
 *
 *     node tools/check_assessment_templates.mjs
 *
 * The template is a reading of five documents, and a misreading would be
 * invisible until a teacher entered a mark that could not fit its column. The
 * report cards contain worked examples for real students — English 69/80 +
 * 20/20 = 89, Physics 31/70 + 30/30 = 61, IT 17/50 + 48/50 — so every case
 * below is a number the school itself printed, not one I chose.
 *
 * Loads the REAL modules with only the JSON import lines rewritten (Vite
 * resolves bare JSON imports, plain Node does not) — same trick as
 * tools/check_derive_classes.mjs, so what runs here is what ships.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'assess-'))

const inline = (src, importName, jsonPath) => src.replace(
  new RegExp(`^import ${importName} from .*$`, 'm'),
  `import fs from 'node:fs'\nconst ${importName} = JSON.parse(fs.readFileSync(${JSON.stringify(jsonPath)},'utf8'))`)

fs.writeFileSync(path.join(TMP, 'classResolver.js'),
  inline(fs.readFileSync(path.join(ROOT, 'src/utils/classResolver.js'), 'utf8'),
         'SEED', path.join(ROOT, 'functions/shared/education_kb.json')))
fs.writeFileSync(path.join(TMP, 'examScheme.js'),
  inline(fs.readFileSync(path.join(ROOT, 'src/utils/examScheme.js'), 'utf8'),
         'EXAMPLE', path.join(ROOT, 'src/data/assessmentTemplates.json')))
fs.writeFileSync(path.join(TMP, 'assessmentPlan.js'),
  fs.readFileSync(path.join(ROOT, 'src/utils/assessmentPlan.js'), 'utf8'))

const { assessmentsFor, examsForGrade, splitFor, buildAssessmentPlan, compareGradingScale } =
  await import(path.join(TMP, 'assessmentPlan.js'))
const { exampleScheme, exampleGradingScale, proposeSubjectSplits, validateScheme, nameKey } =
  await import(path.join(TMP, 'examScheme.js'))

// The example scheme with its subject splits confirmed — what a school would
// have after seeding and saving. Nothing in the planner has a default; every
// call below passes this explicitly, which is the point.
const SUBJECTS = [
  'English', 'Maths', 'PE', 'Physics', 'Chemistry', 'Science', 'IT', 'HPE',
].map(n => ({ id: `XI Science_${n}`, name: n }))
const scheme = exampleScheme()
scheme.subjectSplits = proposeSubjectSplits([
  ...SUBJECTS,
  ...['English', 'Science', 'IT'].map(n => ({ id: `X_${n}`, name: n })),
  ...['English', 'IT'].map(n => ({ id: `I_${n}`, name: n })),
])
for (const e of Object.values(scheme.subjectSplits)) e.proposed = false

let failures = 0
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) console.log(`  ok   ${label}`)
  else { failures++; console.log(`  FAIL ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`) }
}
const check = (label, cond, extra) => {
  if (cond) console.log(`  ok   ${label}`)
  else { failures++; console.log(`  FAIL ${label}`, extra ?? '') }
}

const EXAMS = Object.fromEntries(
  [1, 10, 11].map(g => [g, Object.fromEntries(examsForGrade(scheme, g).map(e => [e.key, e]))]))

/** The (written max, internal max) a subject would be given for one exam. */
const shape = (examKey, grade, subjectName, subjectId = `X_${subjectName}`) => {
  const exam = EXAMS[grade][examKey]
  const { assessments } = assessmentsFor({
    scheme, exam, subjectId, subjectName, gradeOrdinal: grade, termId: 't' })
  return assessments.map(a => a.maxMarks)
}

console.log('\nClass 11 report card, Term II — the worked example')
// "English 69 /80  20 /20  89" and "Maths 32 /80  20 /20  52"
eq('English PT-IV is 80 + 20', shape('pt4', 11, 'English'), [80, 20])
eq('Maths PT-IV is 80 + 20', shape('pt4', 11, 'Maths'), [80, 20])
// "PE 47 /70  29 /30", "Physics 31 /70  30 /30", "Chemistry 35 /70  30 /30"
eq('PE PT-IV is 70 + 30', shape('pt4', 11, 'PE'), [70, 30])
eq('Physics PT-IV is 70 + 30', shape('pt4', 11, 'Physics'), [70, 30])
eq('Chemistry PT-IV is 70 + 30', shape('pt4', 11, 'Chemistry'), [70, 30])
// "English 36 /40  9 /10  45" — PT-III is 40 + 10 whatever the subject
eq('English PT-III is 40 + 10', shape('pt3', 11, 'English'), [40, 10])
eq('Physics PT-III is 40 + 10 too', shape('pt3', 11, 'Physics'), [40, 10])

console.log('\nClass 10 report card')
// "Science 23 /80  12 /20" — Science is NOT practical-split below grade 11
eq('Science at grade 10 is 80 + 20', shape('pb1', 10, 'Science'), [80, 20])
// "IT 17 /50  48 /50"
eq('IT is 50 + 50', shape('pb1', 10, 'IT'), [50, 50])
eq('IT is 50 + 50 at grade 1 too — the split beats the grade band', shape('pt2', 1, 'IT'), [50, 50])
check('and says so, because the marks sheet gives no band for that paper',
  assessmentsFor({ scheme, exam: EXAMS[1].pt2, subjectId: 'I_IT', subjectName: 'IT',
                   gradeOrdinal: 1, termId: 't' })
    .warnings.some(w => w.message.includes('50-mark paper') && w.message.includes('verify')))
// Term II is Pre-Boards, not periodic tests
eq('grade 10 Term II is the Pre-Boards',
   examsForGrade(scheme, 10).filter(e => e.term === 2).map(e => e.name),
   ['Pre-Board - I', 'Pre-Board - II'])
eq('grade 10 keeps the Term I periodic tests',
   examsForGrade(scheme, 10).filter(e => e.term === 1).map(e => e.name),
   ['Periodic Test-I', 'Periodic Test-II'])
eq('no other grade gets Pre-Boards',
   examsForGrade(scheme, 9).map(e => e.name),
   ['Periodic Test-I', 'Periodic Test-II', 'Periodic Test-III', 'Periodic Test-IV'])

console.log('\nMarks sheet — the written bands')
eq('grades 1-2 sit a 20-mark PT-I', shape('pt1', 1, 'English'), [20, 10])
eq('grades 3-12 sit a 40-mark PT-I', shape('pt1', 11, 'English'), [40, 10])
eq('grades 1-2 sit a 40-mark PT-II', shape('pt2', 1, 'English'), [40, 20])

console.log('\nConversion — written scaled to the report card')
const conv = (examKey, grade, name) => {
  const { assessments } = assessmentsFor({
    scheme, exam: EXAMS[grade][examKey], subjectId: `X_${name}`, subjectName: name,
    gradeOrdinal: grade, termId: 't' })
  return [assessments[0].conversionType, assessments[0].conversionFactor]
}
eq('20 -> 40 is sum_up x2', conv('pt1', 1, 'English'), ['sum_up', 2])
eq('40 -> 40 needs no conversion', conv('pt1', 11, 'English'), ['none', null])
eq('40 -> 80 is sum_up x2', conv('pt2', 1, 'English'), ['sum_up', 2])
eq('80 -> 80 needs no conversion', conv('pt4', 11, 'English'), ['none', null])
eq('the internal half is never converted',
   assessmentsFor({ scheme, exam: EXAMS[1].pt1, subjectId: 'I_English', subjectName: 'English',
                    gradeOrdinal: 1, termId: 't' }).assessments[1].conversionType, 'none')

console.log('\nWhat the documents do not answer is reported, not guessed')
// A scheme seeded against this school's own subject list, splits confirmed.
const subjects = [
  { id: 'I_English', name: 'English' },
  { id: 'XI_Physics', name: 'Physics' },
  { id: 'UKG_English', name: 'English' },
  { id: 'Play_Group_Rhymes', name: 'Rhymes' },
  { id: 'XII_Physics', name: 'Physics' },
  { id: 'AAM', name: 'Assembly' },
]
const planScheme = exampleScheme()
planScheme.subjectSplits = proposeSubjectSplits(subjects)
for (const e of Object.values(planScheme.subjectSplits)) e.proposed = false
const plan = buildAssessmentPlan({ scheme: planScheme, subjects, termIds: { 1: 'term1', 2: 'term2' } })
const uncoveredIds = plan.uncovered.map(u => u.subjectId).sort()
check('pre-primary subjects are reported, not scheduled',
      uncoveredIds.includes('UKG_English') && uncoveredIds.includes('Play_Group_Rhymes'),
      JSON.stringify(uncoveredIds))
check('a subject with no readable grade is reported', uncoveredIds.includes('AAM'), JSON.stringify(uncoveredIds))
check('a grade the scheme marks unverified says so',
      plan.warnings.some(w => w.message.includes('unverified') && w.subjects.includes('XII_Physics')),
      JSON.stringify(plan.warnings))
check('a confirmed split does NOT warn — it is a decision, not a guess',
      !plan.warnings.some(w => w.message.includes('seeded proposal')),
      JSON.stringify(plan.warnings))
check('nothing is planned for an uncovered subject',
      !plan.items.some(i => uncoveredIds.includes(i.subjectId)))

console.log('\nEvery senior subject\'s split is shown, matched or not')
// The bug this catches: Hillgreen spells the same subject "PE Additional" and
// "HPE". One matches the practical rule and one does not, and the warnings
// only mention the one that did — so the mismatch is invisible exactly where
// it matters.
const seniorSubjects = [
  { id: 'XII Science_Physics', name: 'Physics' },
  { id: 'XII Commerce_HPE', name: 'HPE' },
  { id: 'XII Commerce_PE_Additional', name: 'PE Additional' },
  { id: 'XII Commerce_Accounts', name: 'Accounts' },
  { id: 'III_English', name: 'English' },
]
const seniorScheme = exampleScheme()
seniorScheme.subjectSplits = proposeSubjectSplits(seniorSubjects)
for (const e of Object.values(seniorScheme.subjectSplits)) e.proposed = false
const senior = buildAssessmentPlan({
  scheme: seniorScheme, subjects: seniorSubjects, termIds: { 1: 'term1', 2: 'term2' },
})
const byName = Object.fromEntries(senior.splitReview.map(r => [r.name, r]))
check('a matched practical subject is listed', byName.Physics?.splitName === 'practical')
check('an UNmatched senior subject is listed too', byName.HPE?.splitName === 'standard',
      JSON.stringify(senior.splitReview.map(r => r.name)))
eq('and shows the split it actually got', [byName.HPE?.written, byName.HPE?.internal], [80, 20])
eq('beside the spelling that did match',
   [byName['PE Additional']?.written, byName['PE Additional']?.internal], [70, 30])
check('an ordinary senior subject is listed as standard', byName.Accounts?.splitName === 'standard')
check('a junior subject is listed too — every split is now written down', !!byName.English)
check('standard rows sort first, so a missed spelling is what the eye lands on',
      senior.splitReview[0].splitName === 'standard')

console.log('\nOne fact reported once, however many subjects share it')
// Hillgreen printed the grades 3-5 conversion 59 times, once per subject —
// enough to bury the seven warnings that were actually different.
const many = buildAssessmentPlan({
  scheme: planScheme,
  subjects: ['CLB', 'Computer', 'EVS', 'English', 'Hindi', 'Maths']
    .map(n => ({ id: `III_${n}`, name: n })),
  termIds: { 1: 'term1', 2: 'term2' },
})
const shared = many.warnings.filter(w => w.message.includes('factor of'))
eq('six subjects sharing one conversion produce one warning', shared.length, 1)
eq('and it names every subject it applies to', shared[0].count, 6)
check('the message itself carries no subject id — it is a fact about the paper',
      !/III_/.test(shared[0].message), shared[0].message)
check('a subject appears once in the list even across two exams',
      new Set(shared[0].subjects).size === shared[0].subjects.length)

console.log('\nThe plan itself')
eq('8 assessments per covered subject (4 exams x written+internal)',
   plan.items.filter(i => i.subjectId === 'I_English').length, 8)
eq('doc ids are deterministic, so re-running updates rather than duplicates',
   plan.items.filter(i => i.subjectId === 'I_English').map(i => i.docId).sort(),
   ['I_English_term1_pt1_internal', 'I_English_term1_pt1_written',
    'I_English_term1_pt2_internal', 'I_English_term1_pt2_written',
    'I_English_term2_pt3_internal', 'I_English_term2_pt3_written',
    'I_English_term2_pt4_internal', 'I_English_term2_pt4_written'])
const again = buildAssessmentPlan({
  scheme: planScheme,
  subjects: [{ id: 'I_English', name: 'English' }],
  termIds: { 1: 'term1', 2: 'term2' },
  existing: plan.items.filter(i => i.subjectId === 'I_English').map(i => ({ id: i.docId })),
})
eq('a second run is all updates, no creates', [again.totals.create, again.totals.update], [0, 8])
check('orders are distinct within a subject+term',
  (() => {
    const t1 = plan.items.filter(i => i.subjectId === 'I_English' && i.termId === 'term1')
    return new Set(t1.map(i => i.order)).size === t1.length
  })())
check('every assessment names its exam and half',
      plan.items.every(i => /\((Written|Internal)\)$/.test(i.name)))

console.log('\nGrading scale')
const scale = exampleGradingScale()
check('covers 0 to 100 with no gaps at the ends',
      Math.min(...scale.levels.map(l => l.minPercent)) === 0
      && Math.max(...scale.levels.map(l => l.maxPercent)) === 100)
check('no two bands overlap',
      scale.levels.slice().sort((a, b) => a.minPercent - b.minPercent)
        .every((lv, i, arr) => i === 0 || lv.minPercent > arr[i - 1].maxPercent))
check('a matching school scale is recognised', compareGradingScale(scale, scale.levels).matches)
check('a different scale is reported',
      !compareGradingScale({ levels: [{ label: 'A', minPercent: 0, maxPercent: 100 }] }, scale.levels).matches)

console.log('\nSplit classification is always explainable')
check('a subject the scheme lists takes its split',
      splitFor(scheme, 'Physics').splitName === 'practical')
check('a subject the scheme does not list falls back to standard',
      splitFor(scheme, 'Astrophysics').splitName === 'standard')
check('and says it was not listed, so that is distinguishable from a real decision',
      splitFor(scheme, 'Astrophysics').reason.includes('not listed'))
check('a listed standard subject says something different',
      !splitFor(scheme, 'English').reason.includes('not listed'))
check('an undefined split name falls back and says so',
      splitFor({ splits: scheme.splits, subjectSplits: { x: { splitName: 'nope' } } }, 'x')
        .reason.includes('not defined'))

console.log('\nA school without a scheme gets nothing — there is no default')
const nothing = buildAssessmentPlan({
  subjects: [{ id: 'I_English', name: 'English' }], termIds: { 1: 't1', 2: 't2' } })
eq('no scheme, no assessments', nothing.items.length, 0)
eq('an empty scheme is the same', buildAssessmentPlan({
  scheme: {}, subjects: [{ id: 'I_English', name: 'English' }],
  termIds: { 1: 't1', 2: 't2' } }).items.length, 0)
check('and neither throws — a school mid-setup is a normal state',
      Array.isArray(nothing.warnings) && Array.isArray(nothing.uncovered))

console.log('\nSeeding proposes; saving decides')
const proposal = proposeSubjectSplits([
  { id: 'XI Science_Physics', name: 'Physics' },
  { id: 'XI Commerce_HPE', name: 'HPE' },
  { id: 'III_English', name: 'English' },
])
check('every seeded entry is marked as a proposal',
      Object.values(proposal).every(e => e.proposed === true))
check('and carries the reason it was proposed',
      Object.values(proposal).every(e => typeof e.reason === 'string' && e.reason.length))
eq('a name the rules match is proposed non-standard',
   proposal[nameKey('Physics')].splitName, 'practical')
eq('a name they do not match is proposed standard — visibly, not silently',
   proposal[nameKey('HPE')].splitName, 'standard')
check('an unconfirmed proposal warns at plan time', (() => {
  const sch = exampleScheme()
  sch.subjectSplits = proposeSubjectSplits([{ id: 'XI Science_Physics', name: 'Physics' }])
  const p = buildAssessmentPlan({
    scheme: sch, subjects: [{ id: 'XI Science_Physics', name: 'Physics' }],
    termIds: { 1: 't1', 2: 't2' } })
  return p.warnings.some(w => w.message.includes('seeded proposal'))
})())

console.log('\nThe validator catches a scheme that would reach a teacher broken')
const bad = (mutate) => { const c = exampleScheme(); mutate(c); return validateScheme(c) }
check('the example scheme is valid once named', validateScheme(exampleScheme()).ok)
check('no name is an error', !bad(c => { c.name = '' }).ok)
check('no exams is an error', !bad(c => { c.exams = [] }).ok)
check('no standard split is an error', !bad(c => { delete c.splits.standard }).ok)
check('a duplicate exam key is an error — one would overwrite the other',
      !bad(c => { c.exams[1].key = c.exams[0].key }).ok)
check('a term outside 1-2 is an error', !bad(c => { c.exams[0].term = 3 }).ok)
check('a band running backwards is an error',
      !bad(c => { c.exams[0].writtenBands[0] = { minGrade: 9, maxGrade: 2, max: 20 } }).ok)
check('an override that empties a term is an error',
      !bad(c => { c.gradeOverrides['10'].exams = [] }).ok)
check('a subject pointing at an undefined split is an error',
      !bad(c => { c.subjectSplits = { x: { name: 'X', splitName: 'ghost' } } }).ok)
check('overlapping bands warn but do not block — first match wins, deterministically', (() => {
  const r = bad(c => { c.exams[0].writtenBands = [
    { minGrade: 1, maxGrade: 5, max: 20 }, { minGrade: 3, maxGrade: 12, max: 40 }] })
  return r.ok && r.warnings.some(w => w.includes('two bands'))
})())
check('unconfirmed proposals warn but do not block', (() => {
  const c = exampleScheme()
  c.subjectSplits = proposeSubjectSplits([{ id: 'XI Science_Physics', name: 'Physics' }])
  const r = validateScheme(c)
  return r.ok && r.warnings.some(w => w.includes('seeded proposal'))
})())

fs.rmSync(TMP, { recursive: true, force: true })
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed')
process.exit(failures ? 1 : 0)
