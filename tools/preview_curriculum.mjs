/**
 * Preview the curriculum template run for one school, from the command line.
 *
 * READ-ONLY. It opens no write path: it reads three collections and prints what
 * the Curriculum tab's Preview would show. Nothing is written, ever.
 *
 *     npm install                                  # once, for the Firestore client
 *     gcloud auth application-default login        # if not already
 *     node tools/preview_curriculum.mjs --project clarified-1501 \
 *          --school "SAMARTH DNYANPEETH SAHAYDRI"
 *
 * Map a school's subjects onto framework subjects to see what they would gain
 * (Language 1/2/3 are slots, and Preparatory groups Science + Social Science as
 * "The World Around Us"):
 *
 *     node tools/preview_curriculum.mjs --project clarified-1501 \
 *          --school "SAMARTH DNYANPEETH SAHAYDRI" \
 *          --map "III_English=Language 1 (R1),III_Science=The World Around Us"
 *
 * Runs the REAL planner (src/utils/curriculumPlan.js) with only the JSON import
 * lines rewritten, because Vite resolves bare JSON imports and plain Node does
 * not — same trick as tools/check_resolver_parity.mjs, so what runs here is what
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
if (!SCHOOL) {
  console.error('usage: node tools/preview_curriculum.mjs --project <id> --school "<school doc id>" [--map "ID=FrameworkSubject,..."] [--json]')
  process.exit(2)
}

const subjectMap = {}
for (const pair of (arg('map', '') || '').split(',').filter(Boolean)) {
  const [k, ...v] = pair.split('=')
  if (k && v.length) subjectMap[k.trim()] = v.join('=').trim()
}

// ── stage the browser modules so plain Node can import them ────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'curric-'))
const KB = path.join(ROOT, 'functions/shared/education_kb.json')
const seedLine = `import fs from 'node:fs'\nconst SEED = JSON.parse(fs.readFileSync(${JSON.stringify(KB)},'utf8'))`

for (const f of ['classResolver.js', 'educationKB.js']) {
  fs.writeFileSync(path.join(TMP, f),
    fs.readFileSync(path.join(ROOT, 'src/utils', f), 'utf8')
      .replace(/import SEED from ['"][^'"]+['"]/, seedLine))
}
for (const f of ['stages.js', 'curriculumPlan.js']) {
  fs.copyFileSync(path.join(ROOT, 'src/utils', f), path.join(TMP, f))
}
fs.writeFileSync(path.join(TMP, 'curriculumTemplates.js'),
  fs.readFileSync(path.join(ROOT, 'src/utils/curriculumTemplates.js'), 'utf8')
    .replace(/import TEMPLATES from ['"][^'"]+['"]/,
      `import fs2 from 'node:fs'\nconst TEMPLATES = JSON.parse(fs2.readFileSync(${JSON.stringify(path.join(ROOT, 'src/data/curriculumTemplates.json'))},'utf8'))`)
    .replace(/import QUESTIONS from ['"][^'"]+['"]/,
      `const QUESTIONS = JSON.parse(fs2.readFileSync(${JSON.stringify(path.join(ROOT, 'src/data/feedbackQuestions.json'))},'utf8'))`))

const { buildCurriculumPlan } = await import(path.join(TMP, 'curriculumPlan.js'))

// ── read the school (read-only) ────────────────────────────────────────────
const { Firestore } = await import('@google-cloud/firestore')
const db = new Firestore({ projectId: PROJECT })
const base = db.collection('schools').doc(SCHOOL)

async function read(name) {
  const snap = await base.collection(name).get()
  return snap.docs.map(d => ({ id: d.id, ...d.data() }))
}

const [classes, subjects, feedbacks, savedMap] = await Promise.all([
  read('classes'), read('subjects'), read('subject_feedbacks'),
  base.collection('config').doc('curriculum_map').get()
      .then(d => (d.exists ? (d.data().map || {}) : {})).catch(() => ({})),
])

// The mapping the tab saved is the default; --map overrides entry by entry, so
// the CLI and the UI cannot disagree about what a run would do.
const effectiveMap = { ...savedMap, ...subjectMap }
if (Object.keys(savedMap).length) {
  console.log(`(using ${Object.keys(savedMap).length} saved mapping(s) from config/curriculum_map)`)
}

const plan = buildCurriculumPlan({
  classes, subjects,
  existingFeedbackIds: new Set(feedbacks.map(f => f.id)),
  subjectMap: effectiveMap,
})

fs.rmSync(TMP, { recursive: true, force: true })

if (AS_JSON) {
  console.log(JSON.stringify({ school: SCHOOL, counts: { classes: classes.length, subjects: subjects.length, feedbacks: feedbacks.length }, plan }, null, 2))
  process.exit(0)
}

const line = '─'.repeat(72)
console.log(`\n${line}\n  ${SCHOOL}\n${line}`)
console.log(`read: ${classes.length} classes, ${subjects.length} subjects, ${feedbacks.length} subject_feedbacks`)

const byStage = {}
for (const c of classes) {
  const s = c.stage || '(unset)'
  byStage[s] = (byStage[s] || 0) + 1
}
console.log('classes by stored stage:', Object.entries(byStage).map(([k, v]) => `${k}=${v}`).join('  '))

console.log(`\nWOULD WRITE ${plan.totals.writes} document(s)`)
console.log(`  ${plan.totals.subjectsTouched} subject(s) gain ${plan.totals.goalsAdded} goal(s) / ${plan.totals.competenciesAdded} competenc(ies)`)
console.log(`  ${plan.totals.feedbackDocs} subject_feedbacks document(s) created`)

if (plan.subjectRows.length) {
  console.log('\nSubjects gaining goals:')
  for (const r of plan.subjectRows) {
    console.log(`  ${r.subjectId.padEnd(26)} ${String(r.stage).padEnd(11)} +${r.addedGoals} goals, +${r.addedCompetencies} competencies`)
  }
}
if (plan.feedbackRows.length) {
  const show = plan.feedbackRows.slice(0, 8).map(r => r.docId)
  console.log(`\nFeedback documents to create (${plan.feedbackRows.length}):`)
  console.log('  ' + show.join('\n  ') + (plan.feedbackRows.length > 8 ? `\n  … ${plan.feedbackRows.length - 8} more` : ''))
}
if (plan.warnings.length) {
  const groups = {}
  for (const w of plan.warnings) (groups[w.kind] ||= []).push(w)
  console.log(`\nWarnings (${plan.warnings.length}):`)
  for (const [kind, list] of Object.entries(groups)) {
    console.log(`  [${kind}] ${list.length}`)
    for (const w of list.slice(0, 6)) console.log(`      ${w.message}`)
    if (list.length > 6) console.log(`      … ${list.length - 6} more`)
  }
}
if (plan.isEmpty) console.log('\nNothing to add — this school already matches the templates.')
console.log('')
