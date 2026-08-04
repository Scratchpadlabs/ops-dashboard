#!/usr/bin/env node
/**
 * One-time migration: move Co-Scholastic-tagged docs out of
 *   schools/{schoolId}/subjects
 * and into
 *   schools/{schoolId}/co_scholastic_activities
 *
 * Background: the School Setup Subjects page used to write every row into
 * `subjects` regardless of its `area` tag, so activities that belong in
 * `co_scholastic_activities` (a different schema — see docs/school-setup-page-spec.md §2)
 * ended up misfiled. The page now routes on `area`; this script cleans up the
 * docs written before that fix.
 *
 * The two collections don't have the same shape. A subjects doc carries
 * { id, name, area, curricular_goals, topics, ... }; an activity needs
 * { name, termId, order, entryType, maxMarks, gradingScaleId, conversionType,
 *   conversionFactor }. The fields subjects never had get these defaults:
 *
 *   termId      → the school's first active term (lowest doc ID); no terms ⇒ row skipped
 *   entryType   → "marks"
 *   maxMarks    → 10
 *   gradingScaleId → null
 *   conversionType → "none"
 *   conversionFactor → null
 *   order       → appended after the term's existing activities
 *
 * `curricular_goals` / `topics` have no home in the activity schema and are
 * dropped — the CSV flags any doc that had them so they can be checked first.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *   # 1. Dry run (default). Touches nothing, writes the review CSV.
 *   node scripts/migrate-co-scholastic-subjects.mjs
 *
 *   # 2. Copy into co_scholastic_activities, leave the subjects docs in place.
 *   node scripts/migrate-co-scholastic-subjects.mjs --commit
 *
 *   # 3. Same, then delete the migrated subjects docs.
 *   node scripts/migrate-co-scholastic-subjects.mjs --commit --delete-source
 *
 * Flags:
 *   --commit           actually write (without it nothing is written)
 *   --delete-source    delete the source subjects doc after its target is
 *                      written AND verified to exist; requires --commit
 *   --school=<id>      limit to one school (repeatable)
 *   --out=<path>       CSV path (default ./co-scholastic-migration-<stamp>.csv)
 *   --project=<id>     Firestore project (default clarified-1501, or GOOGLE_CLOUD_PROJECT)
 *
 * The review CSV is flushed to disk BEFORE any write or delete happens, so
 * there is always a record of what was about to move. It is rewritten with the
 * real per-doc outcome once the run finishes.
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

// Defaults for the activity fields a subjects doc never carried.
const DEFAULTS = {
  entryType: 'marks',
  maxMarks: 10,
  gradingScaleId: null,
  conversionType: 'none',
  conversionFactor: null,
}

// ── CLI ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const value = (name) => {
  const hit = argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : null
}
const values = (name) => argv.filter(a => a.startsWith(`--${name}=`)).map(a => a.slice(name.length + 3))

const commit = flag('commit')
const deleteSource = flag('delete-source')
const onlySchools = values('school')
const projectId = value('project') || process.env.GOOGLE_CLOUD_PROJECT || DEFAULT_PROJECT
const outPath = value('out') || `co-scholastic-migration-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`

if (deleteSource && !commit) {
  console.error('--delete-source requires --commit. A dry run never deletes anything.')
  process.exit(1)
}

// ── Helpers ─────────────────────────────────────────────────────────────────
// Mirrors isCoScholasticArea() in src/utils/assessmentHelpers.js — kept as a
// copy because this script runs under firebase-admin and can't import the app
// bundle. Keep the two in sync.
function isCoScholasticArea(area) {
  return (area ?? '').toString().toLowerCase().replace(/[^a-z]/g, '') === 'coscholastic'
}

// Same slug rule as slugify() in src/utils/assessmentHelpers.js.
function slugify(text) {
  return (text || '').trim().replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '')
}

// Subjects doc IDs look like `{Grade}_{Name}` — strip the grade so the derived
// activity name isn't "III Art Craft" when the doc had no `name` field.
function nameFromDoc(id, data) {
  const name = (data.name || '').trim()
  if (name) return name
  const parts = id.split('_')
  return (parts.length > 1 ? parts.slice(1).join(' ') : id).trim() || id
}

const CSV_COLUMNS = [
  'school', 'old_id', 'new_id', 'action', 'name', 'termId', 'order', 'entryType',
  'maxMarks', 'gradingScaleId', 'conversionType', 'conversionFactor', 'area_raw', 'note',
]

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

// ── Scan ────────────────────────────────────────────────────────────────────
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
    const subjectsSnap = await db.collection('schools').doc(schoolId).collection('subjects').get()
    const candidates = subjectsSnap.docs.filter(d => isCoScholasticArea(d.data().area))
    if (!candidates.length) continue

    const [termsSnap, activitiesSnap] = await Promise.all([
      db.collection('schools').doc(schoolId).collection('terms').get(),
      db.collection('schools').doc(schoolId).collection('co_scholastic_activities').get(),
    ])

    // Prefer an active term; fall back to any term. Ties broken by doc ID so
    // repeat runs pick the same one.
    const termIds = termsSnap.docs.map(d => ({ id: d.id, isActive: d.data().isActive })).sort((a, b) => a.id.localeCompare(b.id))
    const defaultTerm = (termIds.find(t => t.isActive !== false) || termIds[0])?.id || null

    const existingActivityIds = new Set(activitiesSnap.docs.map(d => d.id))
    const existingOrders = activitiesSnap.docs.map(d => d.data())
    const nextOrderByTerm = new Map()
    const orderFor = (termId) => {
      if (!nextOrderByTerm.has(termId)) {
        const inTerm = existingOrders.filter(a => a.termId === termId).map(a => a.order || 0)
        nextOrderByTerm.set(termId, inTerm.length ? Math.max(...inTerm) + 1 : 1)
      }
      const order = nextOrderByTerm.get(termId)
      nextOrderByTerm.set(termId, order + 1)
      return order
    }

    // Deterministic order so re-running assigns the same `order` values.
    for (const docSnap of [...candidates].sort((a, b) => a.id.localeCompare(b.id))) {
      const data = docSnap.data()
      const base = { school: schoolId, old_id: docSnap.id, area_raw: data.area ?? '', name: nameFromDoc(docSnap.id, data) }

      if (!defaultTerm) {
        plan.push({ ...base, new_id: '', action: 'SKIP', note: 'School has no terms — add one, then re-run' })
        continue
      }

      const newId = `${defaultTerm}_${slugify(base.name)}`
      if (existingActivityIds.has(newId)) {
        plan.push({ ...base, new_id: newId, termId: defaultTerm, action: 'SKIP', note: 'A co_scholastic_activities doc with this ID already exists — resolve by hand' })
        continue
      }
      // Two subjects docs can slug to the same activity ID (e.g. "Art Craft"
      // and "Art & Craft"). Skip the later one rather than silently merging.
      if (plan.some(p => p.school === schoolId && p.new_id === newId && p.action === 'MOVE')) {
        plan.push({ ...base, new_id: newId, termId: defaultTerm, action: 'SKIP', note: 'Another subjects doc in this school maps to the same new ID — resolve by hand' })
        continue
      }

      const notes = []
      if ((data.curricular_goals || []).length) notes.push(`${data.curricular_goals.length} curricular goal(s) dropped`)
      if ((data.topics || []).length) notes.push(`${data.topics.length} topic(s) dropped`)
      if (!data.name) notes.push('name derived from doc ID')
      if (termIds.length > 1) notes.push(`school has ${termIds.length} terms — defaulted to ${defaultTerm}`)

      plan.push({
        ...base,
        new_id: newId,
        action: 'MOVE',
        termId: defaultTerm,
        order: orderFor(defaultTerm),
        ...DEFAULTS,
        note: notes.join('; '),
      })
    }
  }
  return plan
}

// ── Apply ───────────────────────────────────────────────────────────────────
function payloadOf(row) {
  return {
    name: row.name,
    termId: row.termId,
    order: row.order,
    entryType: row.entryType,
    maxMarks: row.maxMarks,
    gradingScaleId: row.gradingScaleId,
    conversionType: row.conversionType,
    conversionFactor: row.conversionFactor,
    migrated_from_subject_id: row.old_id,
    migrated_at: new Date(),
    migrated_by: 'scripts/migrate-co-scholastic-subjects.mjs',
  }
}

async function applyPlan(db, plan) {
  const moves = plan.filter(r => r.action === 'MOVE')

  for (let i = 0; i < moves.length; i += BATCH_LIMIT) {
    const chunk = moves.slice(i, i + BATCH_LIMIT)
    const batch = db.batch()
    for (const row of chunk) {
      batch.set(db.collection('schools').doc(row.school).collection('co_scholastic_activities').doc(row.new_id), payloadOf(row))
    }
    try {
      await batch.commit()
      chunk.forEach(r => { r.action = 'MIGRATED' })
    } catch (e) {
      chunk.forEach(r => { r.action = 'FAILED'; r.note = [r.note, `write failed: ${e.message}`].filter(Boolean).join('; ') })
    }
    console.log(`  wrote ${Math.min(i + chunk.length, moves.length)}/${moves.length}`)
  }

  if (!deleteSource) return

  // Only delete a source doc once its target is confirmed present.
  const migrated = plan.filter(r => r.action === 'MIGRATED')
  const verified = []
  for (const row of migrated) {
    const target = await db.collection('schools').doc(row.school).collection('co_scholastic_activities').doc(row.new_id).get()
    if (target.exists) verified.push(row)
    else { row.action = 'FAILED'; row.note = [row.note, 'target doc missing after write — source kept'].filter(Boolean).join('; ') }
  }

  for (let i = 0; i < verified.length; i += BATCH_LIMIT) {
    const chunk = verified.slice(i, i + BATCH_LIMIT)
    const batch = db.batch()
    for (const row of chunk) {
      batch.delete(db.collection('schools').doc(row.school).collection('subjects').doc(row.old_id))
    }
    try {
      await batch.commit()
      chunk.forEach(r => { r.action = 'MIGRATED_AND_DELETED' })
    } catch (e) {
      chunk.forEach(r => { r.note = [r.note, `source delete failed: ${e.message}`].filter(Boolean).join('; ') })
    }
    console.log(`  deleted ${Math.min(i + chunk.length, verified.length)}/${verified.length} source doc(s)`)
  }
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  initializeApp({ credential: applicationDefault(), projectId })
  const db = getFirestore()

  const mode = commit ? (deleteSource ? 'COMMIT + DELETE SOURCE' : 'COMMIT (source docs kept)') : 'DRY RUN (no writes)'
  console.log(`Project: ${projectId}`)
  console.log(`Mode:    ${mode}`)
  if (onlySchools.length) console.log(`Schools: ${onlySchools.join(', ')}`)
  console.log('')

  const plan = await buildPlan(db)
  const moves = plan.filter(r => r.action === 'MOVE').length
  const skips = plan.filter(r => r.action === 'SKIP').length
  const schools = new Set(plan.map(r => r.school)).size

  // Flush the report before touching anything, so the review CSV always
  // exists on disk ahead of any write or delete.
  writeReport(plan)
  console.log(`${plan.length} misfiled doc(s) across ${schools} school(s): ${moves} to move, ${skips} skipped.`)
  console.log(`Report: ${outPath}`)

  if (!plan.length) return
  if (!commit) {
    console.log('\nDry run — nothing written. Review the CSV, then re-run with --commit.')
    return
  }
  if (!moves) {
    console.log('\nNothing to move.')
    return
  }

  console.log('')
  await applyPlan(db, plan)
  writeReport(plan)

  const tally = plan.reduce((acc, r) => ({ ...acc, [r.action]: (acc[r.action] || 0) + 1 }), {})
  console.log('\nDone: ' + Object.entries(tally).map(([k, v]) => `${k}=${v}`).join(' '))
  console.log(`Report: ${outPath}`)
  if (!deleteSource) console.log('Source docs kept in `subjects` — re-run with --delete-source once the CSV checks out.')
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
