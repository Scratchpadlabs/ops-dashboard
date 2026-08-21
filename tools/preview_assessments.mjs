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
if (!SCHOOL && !LIST) {
  console.error('usage: node tools/preview_assessments.mjs --project <id> --school "<school doc id>" [--term1 <id> --term2 <id>] [--verbose] [--json]\n'
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
fs.writeFileSync(path.join(TMP, 'assessmentPlan.js'),
  inline(fs.readFileSync(path.join(ROOT, 'src/utils/assessmentPlan.js'), 'utf8'),
         'TEMPLATE', path.join(ROOT, 'src/data/assessmentTemplates.json')))

const { buildAssessmentPlan, compareGradingScale } = await import(path.join(TMP, 'assessmentPlan.js'))

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

const plan = buildAssessmentPlan({ subjects, termIds: { 1: term1, 2: term2 }, existing })

if (AS_JSON) {
  console.log(JSON.stringify({ school: SCHOOL, term1, term2, ...plan }, null, 1))
  process.exit(0)
}

const scaleMatch = scales.find(s => compareGradingScale(s).matches)

console.log(`\n=== ${SCHOOL} ${'='.repeat(Math.max(0, 58 - SCHOOL.length))}`)
console.log(`  subjects read      ${plan.totals.subjects}`)
console.log(`  assessments        ${plan.totals.create} to create, ${plan.totals.update} to update`)
console.log(`  subjects covered   ${plan.totals.subjects - plan.totals.uncoveredSubjects}`)
console.log(`  grading scale      ` + (scaleMatch
  ? `"${scaleMatch.name || scaleMatch.id}" matches the report cards' 8-point bands`
  : 'NONE of this school\'s scales matches the report cards\' 8-point bands'))

// Grouped by subject so the shape of one subject's year is readable, which is
// what an operator actually checks — not 2,000 rows.
const bySubject = new Map()
for (const i of plan.items) {
  if (!bySubject.has(i.subjectId)) bySubject.set(i.subjectId, [])
  bySubject.get(i.subjectId).push(i)
}
const shown = VERBOSE ? [...bySubject.keys()] : [...bySubject.keys()].slice(0, 6)
console.log(`\n  -- ${VERBOSE ? 'every' : 'first ' + shown.length} subject(s) of ${bySubject.size}`)
for (const sid of shown) {
  console.log(`\n  ${sid}`)
  for (const a of bySubject.get(sid)) {
    const conv = a.conversionType === 'none' ? '' : `  ${a.conversionType} x${a.conversionFactor}`
    console.log(`     ${a.status.padEnd(6)} order ${String(a.order).padStart(2)}  `
              + `${a.name.padEnd(30)} /${String(a.maxMarks).padEnd(4)}${conv}`)
  }
}
if (!VERBOSE && bySubject.size > shown.length) {
  console.log(`\n  …and ${bySubject.size - shown.length} more subject(s). Use --verbose for all.`)
}

if (plan.uncovered.length) {
  console.log(`\n  NOT COVERED — nothing will be created for these:`)
  for (const u of plan.uncovered) console.log(`     ${u.subjectId.padEnd(24)} ${u.reason}`)
}

if (plan.warnings.length) {
  console.log(`\n  ${plan.warnings.length} thing(s) to verify:`)
  for (const w of plan.warnings) console.log(`     ${w}`)
}

fs.rmSync(TMP, { recursive: true, force: true })
console.log('')
