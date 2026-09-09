#!/usr/bin/env node
/**
 * One-time backfill: seed the fixed Term 1 / Term 2 / Optional topics
 * template (or, for the Training_DEMO demo class/subjects, "Topic 1/2/3" —
 * see createTrainingClass() in ClassesTeachersTab.vue) into any doc that's
 * missing topics entirely, in BOTH places "topics" lives (same three names
 * per doc, two different shapes):
 *
 *   classes/{id}.subjects[].topics — progress tracking, written by
 *     defaultTopicsForSubject() in ClassesTeachersTab.vue/StructureTab.vue:
 *     { id, topic, isCompleted, completedAt }
 *
 *   subjects/{id}.topics — curriculum topic + quiz, written by
 *     defaultTopics() in SubjectsTab.vue:
 *     { topic, description, quiz }
 *
 * Both of those call sites already seed new docs going forward (see
 * SubjectsTab.vue's openAddSubject and ClassesTeachersTab.vue's
 * regenerateSubjectsArray) — this script only backfills docs that predate
 * that, or that were created through a path that skips it (e.g. direct
 * Firestore writes, imports).
 *
 * A `subjects[]` entry or a subjects doc that already has a non-empty
 * `topics` array is left untouched — this never overwrites real topic data,
 * only fills in docs where topics is missing or [].
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *   # 1. Dry run (default). Touches nothing, writes the review CSV.
 *   node scripts/backfill-topics.mjs
 *
 *   # 2. Apply the writes.
 *   node scripts/backfill-topics.mjs --commit
 *
 * Flags:
 *   --commit           actually write (without it nothing is written)
 *   --school=<id>      limit to one school (repeatable)
 *   --out=<path>       CSV path (default ./topics-backfill-<stamp>.csv)
 *   --project=<id>     Firestore project (default clarified-1501, or GOOGLE_CLOUD_PROJECT)
 *
 * The review CSV is flushed to disk BEFORE any write happens, so there is
 * always a record of what was about to change. It is rewritten with the real
 * per-doc outcome once the run finishes.
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
const outPath = value('out') || `topics-backfill-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`

// ── Default topic templates (same three names, two shapes) ─────────────────
// The "Training_DEMO" class and its "Training_"-prefixed demo subjects are a
// special case (see createTrainingClass() in ClassesTeachersTab.vue): they
// intentionally use "Topic 1/2/3" instead of "Term 1/Term 2/Optional", so
// they need their own template rather than the general default below.
const TRAINING_CLASS_ID = 'Training_DEMO'
const TRAINING_TOPIC_LABELS = ['Topic 1', 'Topic 2', 'Topic 3']
const isTrainingSubject = (subjectId) => subjectId.startsWith('Training_')

function defaultClassTopics(subjectId) {
  const labels = isTrainingSubject(subjectId)
    ? TRAINING_TOPIC_LABELS.map((label, i) => [label, `Topic${i + 1}`])
    : [['Term 1', 'Term1'], ['Term 2', 'Term2'], ['Optional', 'Optional']]
  return labels.map(([topic, suffix]) => ({ id: `${subjectId}_${suffix}`, topic, isCompleted: false, completedAt: null }))
}
function defaultSubjectTopics(subjectId) {
  const labels = isTrainingSubject(subjectId) ? TRAINING_TOPIC_LABELS : ['Term 1', 'Term 2', 'Optional']
  return labels.map(topic => ({ topic, description: '', quiz: [] }))
}

const CSV_COLUMNS = ['school', 'collection', 'docId', 'detail', 'action', 'note']

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

// ── Plan ────────────────────────────────────────────────────────────────────
function planForClass(schoolId, docSnap) {
  const data = docSnap.data()
  const subjects = data.subjects || []
  const missing = subjects.filter(s => !(s.topics || []).length)
  if (!missing.length) {
    return { school: schoolId, collection: 'classes', docId: docSnap.id, detail: '', action: 'SKIP', note: '' }
  }
  const nextSubjects = subjects.map(s => (s.topics || []).length ? s : { ...s, topics: defaultClassTopics(s.subjectId) })
  return {
    school: schoolId, collection: 'classes', docId: docSnap.id,
    detail: missing.map(s => s.subjectId).join(';'),
    action: 'UPDATE',
    note: `${missing.length} subject entrie(s) missing topics`,
    _write: { subjects: nextSubjects },
  }
}

function planForSubject(schoolId, docSnap) {
  const data = docSnap.data()
  if ((data.topics || []).length) {
    return { school: schoolId, collection: 'subjects', docId: docSnap.id, detail: '', action: 'SKIP', note: '' }
  }
  const topics = defaultSubjectTopics(docSnap.id)
  return {
    school: schoolId, collection: 'subjects', docId: docSnap.id,
    detail: topics.map(t => t.topic).join(';'),
    action: 'UPDATE',
    note: 'topics missing or empty',
    _write: { topics },
  }
}

async function buildPlan(db) {
  const schoolsSnap = await db.collection('schools').get()
  const schoolIds = schoolsSnap.docs
    .map(d => d.id)
    .filter(id => !onlySchools.length || onlySchools.includes(id))

  if (onlySchools.length) {
    const missing = onlySchools.filter(id => !schoolIds.includes(id))
    if (missing.length) console.warn(`! No such school(s): ${missing.join(', ')}`)
  }

  const plan = []
  for (const schoolId of schoolIds) {
    const classesSnap = await db.collection('schools').doc(schoolId).collection('classes').get()
    for (const docSnap of classesSnap.docs) plan.push(planForClass(schoolId, docSnap))

    const subjectsSnap = await db.collection('schools').doc(schoolId).collection('subjects').get()
    for (const docSnap of subjectsSnap.docs) plan.push(planForSubject(schoolId, docSnap))
  }
  return plan
}

// ── Apply ───────────────────────────────────────────────────────────────────
async function applyPlan(db, plan) {
  const updates = plan.filter(r => r.action === 'UPDATE')

  for (let i = 0; i < updates.length; i += BATCH_LIMIT) {
    const chunk = updates.slice(i, i + BATCH_LIMIT)
    const batch = db.batch()
    for (const row of chunk) {
      const ref = db.collection('schools').doc(row.school).collection(row.collection).doc(row.docId)
      batch.update(ref, {
        ...row._write,
        updated_at: new Date(),
        updated_by: 'scripts/backfill-topics.mjs',
      })
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

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  initializeApp({ credential: applicationDefault(), projectId })
  const db = getFirestore()

  const mode = commit ? 'COMMIT' : 'DRY RUN (no writes)'
  console.log(`Project: ${projectId}`)
  console.log(`Mode:    ${mode}`)
  if (onlySchools.length) console.log(`Schools: ${onlySchools.join(', ')}`)
  console.log('')

  const plan = await buildPlan(db)
  const updates = plan.filter(r => r.action === 'UPDATE').length
  const skips = plan.filter(r => r.action === 'SKIP').length
  const schools = new Set(plan.map(r => r.school)).size

  // Flush the report before touching anything, so the review CSV always
  // exists on disk ahead of any write.
  writeReport(plan)
  console.log(`${plan.length} doc(s) across ${schools} school(s): ${updates} to update, ${skips} already have topics.`)
  console.log(`Report: ${outPath}`)

  if (!plan.length) return
  if (!commit) {
    console.log('\nDry run — nothing written. Review the CSV, then re-run with --commit.')
    return
  }
  if (!updates) {
    console.log('\nNothing to update.')
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

// The Firestore gRPC layer surfaces auth failures as an unhandled rejection
// rather than rejecting the call we awaited, so catch both.
process.on('unhandledRejection', fail)
main().catch(fail)
