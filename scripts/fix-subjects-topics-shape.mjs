#!/usr/bin/env node
/**
 * One-off correction: scripts/backfill-topics.mjs (see git history) wrote
 * subjects/{id}.topics using the shape the ops-dashboard Subjects tab editor
 * understands — { topic, description, quiz } — for any subject doc that had
 * no topics yet. That shape is WRONG: the real, live shape (verified against
 * an active school, Hillgreen_Highschool) is
 *
 *   { id: "{subjectId}_Term1", name: "Term 1 Activity",
 *     cost: { case_study: 10, materials: 10, quiz: 10 },
 *     survey_initiated_by: { ... } }
 *
 * written by a feature outside ops-dashboard entirely (the topic/description/
 * quiz editor in SubjectsTab.vue doesn't even produce an `id` or `name`
 * field, and doesn't validate against this shape). cost is a fixed constant
 * (same for every class/subject/school, per confirmation) and
 * survey_initiated_by starts as {} for a subject nobody has surveyed yet.
 *
 * This script finds subjects/{id} docs whose topics array is in the WRONG
 * shape — every item has a `topic` string field and no `cost` field, the
 * unambiguous fingerprint of scripts/backfill-topics.mjs's placeholder — and
 * replaces them with the correct shape. It never touches a doc whose topics
 * already look like the real shape (has `cost`/`name`/`id` on every item),
 * so this is safe to run against a school that was never touched by the
 * wrong backfill.
 *
 * classes/{id}.subjects[].topics is NOT touched by this script — that shape
 * ({id, topic, isCompleted, completedAt}) was verified correct against
 * Hillgreen and was never wrong.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *   # 1. Dry run (default). Touches nothing, writes the review CSV.
 *   node scripts/fix-subjects-topics-shape.mjs --school=THE_KEYSTONE_ANKURAM_SCHOOL
 *
 *   # 2. Apply the fix.
 *   node scripts/fix-subjects-topics-shape.mjs --school=THE_KEYSTONE_ANKURAM_SCHOOL --commit
 *
 * Flags:
 *   --commit           actually write (without it nothing is written)
 *   --school=<id>      limit to one school (repeatable) — REQUIRED, no
 *                       accidental all-schools run for a targeted fix like this
 *   --out=<path>       CSV path (default ./subjects-topics-shape-fix-<stamp>.csv)
 *   --project=<id>     Firestore project (default clarified-1501, or GOOGLE_CLOUD_PROJECT)
 *
 * Auth: application default credentials.
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json node scripts/...
 * or `gcloud auth application-default login` with access to the project.
 */
import { writeFileSync } from 'node:fs'
import { initializeApp, applicationDefault } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

const DEFAULT_PROJECT = 'clarified-1501'
const BATCH_LIMIT = 400
const FIXED_COST = { case_study: 10, materials: 10, quiz: 10 }

// ── CLI ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const value = (name) => {
  const hit = argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : null
}
const values = (name) => argv.filter(a => a.startsWith(`--${name}=`)).map(a => a.slice(name.length + 3))

const commit = flag('commit')
const onlySchools = values('school')
const projectId = value('project') || process.env.GOOGLE_CLOUD_PROJECT || DEFAULT_PROJECT
const outPath = value('out') || `subjects-topics-shape-fix-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`

if (!onlySchools.length) {
  console.error('Refusing to run without --school=<id> — this is a targeted one-off fix, not a general backfill.')
  process.exit(1)
}

// Same Training_DEMO exception as backfill-topics.mjs.
const TRAINING_TOPIC_LABELS = ['Topic 1', 'Topic 2', 'Topic 3']
const isTrainingSubject = (subjectId) => subjectId.startsWith('Training_')

function correctTopics(subjectId) {
  const labels = isTrainingSubject(subjectId)
    ? TRAINING_TOPIC_LABELS.map((label, i) => [label, `Topic${i + 1}`, `${label} Activity`])
    : [['Term 1', 'Term1', 'Term 1 Activity'], ['Term 2', 'Term2', 'Term 2 Activity'], ['Optional', 'Optional', 'Optional Activity']]
  return labels.map(([, suffix, name]) => ({
    id: `${subjectId}_${suffix}`, name, cost: { ...FIXED_COST }, survey_initiated_by: {},
  }))
}

// Fingerprint of the wrong placeholder shape: every item has `topic`, none have `cost`.
function isWrongShape(topics) {
  return topics.length > 0 && topics.every(t => t && typeof t === 'object' && typeof t.topic === 'string' && !('cost' in t))
}

const CSV_COLUMNS = ['school', 'docId', 'action', 'before_topics', 'after_topics', 'note']

function toCsv(rows) {
  const escape = (v) => {
    const s = v === null || v === undefined ? '' : String(v)
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return [CSV_COLUMNS.join(','), ...rows.map(r => CSV_COLUMNS.map(c => escape(r[c])).join(','))].join('\n') + '\n'
}

function writeReport(rows) {
  writeFileSync(outPath, toCsv(rows))
}

function planForSubject(schoolId, docSnap) {
  const data = docSnap.data()
  const topics = Array.isArray(data.topics) ? data.topics : []
  if (!isWrongShape(topics)) {
    return { school: schoolId, docId: docSnap.id, action: 'SKIP', before_topics: '', after_topics: '', note: topics.length ? 'topics already in correct shape' : 'no topics to fix' }
  }
  const fixed = correctTopics(docSnap.id)
  return {
    school: schoolId, docId: docSnap.id, action: 'UPDATE',
    before_topics: topics.map(t => t.topic).join(';'),
    after_topics: fixed.map(t => t.name).join(';'),
    note: 'replaced wrong {topic,description,quiz} placeholder with {id,name,cost,survey_initiated_by}',
    _write: { topics: fixed },
  }
}

async function buildPlan(db) {
  const plan = []
  for (const schoolId of onlySchools) {
    const subjectsSnap = await db.collection('schools').doc(schoolId).collection('subjects').get()
    for (const docSnap of subjectsSnap.docs) plan.push(planForSubject(schoolId, docSnap))
  }
  return plan
}

async function applyPlan(db, plan) {
  const updates = plan.filter(r => r.action === 'UPDATE')
  for (let i = 0; i < updates.length; i += BATCH_LIMIT) {
    const chunk = updates.slice(i, i + BATCH_LIMIT)
    const batch = db.batch()
    for (const row of chunk) {
      const ref = db.collection('schools').doc(row.school).collection('subjects').doc(row.docId)
      batch.update(ref, { ...row._write, updated_at: new Date(), updated_by: 'scripts/fix-subjects-topics-shape.mjs' })
    }
    try {
      await batch.commit()
      chunk.forEach(r => { r.action = 'UPDATED' })
    } catch (e) {
      chunk.forEach(r => { r.action = 'FAILED'; r.note = [r.note, `write failed: ${e.message}`].filter(Boolean).join('; ') })
    }
    console.log(`  wrote ${Math.min(i + chunk.length, updates.length)}/${updates.length}`)
  }
}

async function main() {
  initializeApp({ credential: applicationDefault(), projectId })
  const db = getFirestore()

  const mode = commit ? 'COMMIT' : 'DRY RUN (no writes)'
  console.log(`Project: ${projectId}`)
  console.log(`Mode:    ${mode}`)
  console.log(`Schools: ${onlySchools.join(', ')}`)
  console.log('')

  const plan = await buildPlan(db)
  const updates = plan.filter(r => r.action === 'UPDATE').length
  const skips = plan.filter(r => r.action === 'SKIP').length

  writeReport(plan)
  console.log(`${plan.length} subject doc(s): ${updates} to fix, ${skips} already correct or empty.`)
  console.log(`Report: ${outPath}`)

  if (!plan.length) return
  if (!commit) {
    console.log('\nDry run — nothing written. Review the CSV, then re-run with --commit.')
    return
  }
  if (!updates) {
    console.log('\nNothing to fix.')
    return
  }

  console.log('')
  await applyPlan(db, plan)
  writeReport(plan)

  const tally = plan.reduce((acc, r) => ({ ...acc, [r.action]: (acc[r.action] || 0) + 1 }), {})
  console.log('\nDone: ' + Object.entries(tally).map(([k, v]) => `${k}=${v}`).join(' '))
  console.log(`Report: ${outPath}`)
}

function fail(err) {
  if (/default credentials/i.test(err?.message || '')) {
    console.error('\nCould not authenticate to Firestore.')
    console.error('Set GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json,')
    console.error('or run `gcloud auth application-default login` with access to the project.')
  } else {
    console.error(err)
  }
  process.exit(1)
}

process.on('unhandledRejection', fail)
main().catch(fail)
