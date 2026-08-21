/**
 * Preview the exam template run for one school, from the command line.
 *
 * READ-ONLY. It opens no write path: it reads four collections and prints what
 * the Assessments tab's "Apply Exam Template" preview would show. Nothing is
 * written, ever.
 *
 *     npm install                                  # once, for the Firestore client
 *     gcloud auth application-default login        # if not already
 *     node tools/preview_assessments.mjs --project clarified-1501 \
 *          --school Hillgreen_Highschool
 *
 * Term ids are Firestore ids and nothing in the source documents names them, so
 * the run needs to be told which of the school's terms is Term I and which is
 * Term II. With exactly two terms it offers a guess and asks you to confirm it:
 *
 *     node tools/preview_assessments.mjs --project clarified-1501 \
 *          --school Hillgreen_Highschool --term1 <id> --term2 <id>
 *
 * The scheme is read from schools/{id}/config/exam_scheme. A school without one
 * gets no assessments — deliberately, see src/utils/examScheme.js. To see what
 * the bundled CBSE example WOULD produce for a school, without saving anything:
 *
 *     node tools/preview_assessments.mjs … --use-example
 *
 * Runs the REAL planner (src/utils/assessmentPlan.js) with only the JSON import
 * lines rewritten, because Vite resolves bare JSON imports and plain Node does
 * not — same trick as tools/preview_curriculum.mjs, so what runs here is what
 * ships in the dashboard.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const PROJECT = arg('project', 'clarified-1501')
const SCHOOL = arg('school')
const AS_JSON = process.argv.includes('--json')
const LIST = process.argv.includes('--list')
const VERBOSE = process.argv.includes('--verbose')
const USE_EXAMPLE = process.argv.includes('--use-example')
if (!SCHOOL && !LIST) {
  console.error('usage: node tools/preview_assessments.mjs --project <id> --school "<school doc id>" [--term1 <id> --term2 <id>] [--use-example] [--verbose] [--json]\n'
              + '       node tools/preview_assessments.mjs --project <id> --list')
  process.exit(2)
}

// ── stage the browser modules so plain Node can import them ────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'assess-'))
const inline = (src, name, jsonPath) => src.replace(
  new RegExp(`^import ${name} from .*$`, 'm'),
  `import fsx from 'node:fs'\nconst ${name} = JSON.parse(fsx.readFileSync(${JSON.stringify(jsonPath)},'utf8'))`)

fs.writeFileSync(path.join(TMP, 'classResolver.js'),
  inline(fs.readFileSync(path.join(ROOT, 'src/utils/classResolver.js'), 'utf8'),
         'SEED', path.join(ROOT, 'functions/shared/education_kb.json')))
fs.writeFileSync(path.join(TMP, 'examScheme.js'),
  inline(fs.readFileSync(path.join(ROOT, 'src/utils/examScheme.js'), 'utf8'),
         'EXAMPLE', path.join(ROOT, 'src/data/assessmentTemplates.json')))
fs.writeFileSync(path.join(TMP, 'assessmentPlan.js'),
  fs.readFileSync(path.join(ROOT, 'src/utils/assessmentPlan.js'), 'utf8'))

const { buildAssessmentPlan, compareGradingScale } = await import(path.join(TMP, 'assessmentPlan.js'))
const { exampleScheme, exampleGradingScale, proposeSubjectSplits, validateScheme } =
  await import(path.join(TMP, 'examScheme.js'))

// ── read the school (read-only) ────────────────────────────────────────────
const { Firestore } = await import('@google-cloud/firestore')
const db = new Firestore({ projectId: PROJECT })

if (LIST) {
  const snap = await db.collection('schools').select().get()
  console.log(`\n${snap.size} school(s) in ${PROJECT}:\n`)
  for (const d of snap.docs) console.log(`  ${d.id}`)
  console.log('')
  process.exit(0)
}

const base = db.collection('schools').doc(SCHOOL)

// Without this a typo reads four empty collections and prints a confident plan
// for a school that does not exist.
const root = await base.get()
if (!root.exists) {
  console.error(`\nNo school with id "${SCHOOL}" in ${PROJECT}.`)
  const snap = await db.collection('schools').select().get()
  const first = (SCHOOL.toLowerCase().split(/[\s_]+/)[0] || '')
  const near = snap.docs.map(d => d.id).filter(id => id.toLowerCase().includes(first))
  console.error(near.length ? `\nDid you mean:\n${near.map(id => '  ' + id).join('\n')}`
                            : '\nRun with --list to see every school id.')
  console.error('')
  process.exit(1)
}

async function read(name) {
  const snap = await base.collection(name).get()
  return snap.docs.map(d => ({ id: d.id, ...d.data() }))
}

const [terms, scales, subjects, existing] = await Promise.all(
  ['terms', 'grading_scales', 'subjects', 'assessments'].map(read))

// ── the school's own scheme ────────────────────────────────────────────────
let scheme = null
const schemeSnap = await base.collection('config').doc('exam_scheme').get()
if (schemeSnap.exists) {
  scheme = schemeSnap.data()
} else if (USE_EXAMPLE) {
  scheme = exampleScheme()
  scheme.subjectSplits = proposeSubjectSplits(subjects)
  console.log('\n--use-example: showing what the bundled CBSE example WOULD produce.')
  console.log('  Nothing is saved. Every subject split below is a guess from the subject')
  console.log('  name, not a decision this school has made.')
} else {
  console.error(`\n"${SCHOOL}" has no exam scheme at config/exam_scheme, so no assessments`)
  console.error('can be planned for it. A scheme says how THIS school examines — nothing is')
  console.error('assumed from another school.\n')
  console.error('  Build one:  School Setup -> Assessments -> Exam Scheme')
  console.error('  Or see what the bundled CBSE example would give:  --use-example\n')
  process.exit(1)
}

const schemeCheck = validateScheme(scheme)
if (!schemeCheck.ok) {
  console.error(`\nThe exam scheme for "${SCHOOL}" is not usable:\n`)
  for (const e of schemeCheck.errors) console.error(`  ${e}`)
  console.error('')
  process.exit(1)
}

if (!terms.length) {
  console.error(`\n"${SCHOOL}" has no terms. An assessment references a termId, so none can `
              + 'be created until Terms & Scales has at least two.\n')
  process.exit(1)
}

let term1 = arg('term1')
let term2 = arg('term2')
if (!term1 || !term2) {
  if (terms.length === 2) {
    const ordered = [...terms].sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
    ;[term1, term2] = ordered.map(t => t.id)
    console.log(`\nNo --term1/--term2 given. This school has exactly two terms, so guessing by name:`)
    console.log(`  Term I  -> ${term1}  (${ordered[0].name})`)
    console.log(`  Term II -> ${term2}  (${ordered[1].name})`)
    console.log('  Pass --term1/--term2 to override.')
  } else {
    console.error(`\n"${SCHOOL}" has ${terms.length} terms. Say which is which:\n`)
    for (const t of terms) console.error(`  ${t.id}  ${t.name ?? '(no name)'}`)
    console.error('\n  --term1 <id> --term2 <id>\n')
    process.exit(1)
  }
}

const plan = buildAssessmentPlan({ scheme, subjects, termIds: { 1: term1, 2: term2 }, existing })

if (AS_JSON) {
  console.log(JSON.stringify({ school: SCHOOL, scheme: scheme.name, term1, term2, ...plan }, null, 1))
  process.exit(0)
}

const exampleLevels = exampleGradingScale().levels
const scaleMatch = scales.find(s => compareGradingScale(s, exampleLevels).matches)

console.log(`\n=== ${SCHOOL} ${'='.repeat(Math.max(0, 58 - SCHOOL.length))}`)
console.log(`  exam scheme        ${scheme.name}`)
if (schemeCheck.warnings.length) {
  for (const w of schemeCheck.warnings) console.log(`                     ! ${w}`)
}
console.log(`  subjects read      ${plan.totals.subjects}`)
console.log(`  assessments        ${plan.totals.create} to create, ${plan.totals.update} to update`)
console.log(`  subjects covered   ${plan.totals.subjects - plan.totals.uncoveredSubjects}`)
console.log(`  grading scale      ` + (scaleMatch
  ? `"${scaleMatch.name || scaleMatch.id}" matches the example's 8-point bands`
  : 'no scale here matches the example\'s 8-point bands — not wrong, just unchecked'))

// Grouped by subject and then by TERM. `order` is only meaningful within a
// term — the teacher app queries where termId == X and sorts by order — so
// printing it without the term makes Periodic Test-I and Periodic Test-III
// both showing order 1 look like a collision when they are in different terms.
const termName = id => (terms.find(t => t.id === id)?.name) || id
const bySubject = new Map()
for (const i of plan.items) {
  if (!bySubject.has(i.subjectId)) bySubject.set(i.subjectId, new Map())
  const byTerm = bySubject.get(i.subjectId)
  if (!byTerm.has(i.termId)) byTerm.set(i.termId, [])
  byTerm.get(i.termId).push(i)
}
const shown = VERBOSE ? [...bySubject.keys()] : [...bySubject.keys()].slice(0, 3)
console.log(`\n  -- ${VERBOSE ? 'every' : 'first ' + shown.length} subject(s) of ${bySubject.size}`)
for (const sid of shown) {
  console.log(`\n  ${sid}`)
  for (const [termId, rows] of bySubject.get(sid)) {
    console.log(`    ${termName(termId)}  (${termId})`)
    for (const a of rows) {
      const conv = a.conversionType === 'none' ? '' : `  ${a.conversionType} x${a.conversionFactor.toFixed(4)}`
      console.log(`       ${a.status.padEnd(6)} order ${String(a.order).padStart(2)}  `
                + `${a.name.padEnd(30)} /${String(a.maxMarks).padEnd(4)}${conv}`)
    }
  }
}
if (!VERBOSE && bySubject.size > shown.length) {
  console.log(`\n  …and ${bySubject.size - shown.length} more subject(s). Use --verbose for all.`)
}

// Where the split could have gone either way, what it went to. Standard first:
// a subject that SHOULD be practical and was not matched is silent in the
// warnings, and this is the only place it shows up.
if (plan.splitReview.length) {
  console.log(`\n  -- written + internal split, per subject`)
  for (const r of plan.splitReview) {
    const flag = r.splitName === 'standard' ? '   ' : ' * '
    console.log(`   ${flag}${r.name.padEnd(30)} ${String(r.written).padStart(3)} + `
              + `${String(r.internal).padEnd(3)}  ${r.splitName.padEnd(14)} `
              + `${r.count} subject(s)`)
  }
  console.log('     (* = a non-standard split. Anything above at the standard split that '
            + 'should not be\n      is a subject nobody has said otherwise about.)')
}

if (plan.uncovered.length) {
  console.log(`\n  NOT COVERED — nothing will be created for these:`)
  for (const u of plan.uncovered) console.log(`     ${u.subjectId.padEnd(24)} ${u.reason}`)
}

if (plan.warnings.length) {
  console.log(`\n  ${plan.warnings.length} thing(s) to verify:`)
  for (const w of plan.warnings) {
    console.log(`\n     ${w.message}`)
    const list = w.subjects.slice(0, VERBOSE ? w.subjects.length : 8).join(', ')
    console.log(`       ${w.count} subject(s): ${list}`
              + (w.count > 8 && !VERBOSE ? ` …(+${w.count - 8}, --verbose for all)` : ''))
  }
}

fs.rmSync(TMP, { recursive: true, force: true })
console.log('')
