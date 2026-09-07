#!/usr/bin/env node
/**
 * One-time backfill: split each teacher's `classIds` into the two
 * independent access fields the teacher app now reads (see
 * docs/school-setup-page-spec.md §"staffs/{staffId}"):
 *
 *   assignments: { [classId]: [subjectId, ...] }  — Academics (per-subject)
 *   classIds:    [classId, ...]                    — Academics (class-level)
 *   coScholasticClassIds: [classId, ...]           — Co-Scholastic/Attendance/Remarks
 *
 * Background: before coScholasticClassIds existed, the ONLY way to grant a
 * teacher Co-Scholastic/Attendance/Remarks access to a class with no subject
 * assignment (an Art/Karate/PT teacher, or a class teacher's homeroom) was a
 * bare `classIds` entry with nothing in `assignments` for that class. Under
 * the new per-tab rules, the Academics tab reads `assignments` AND
 * `classIds`, so those same bare entries now also show up as empty-subject
 * rows in Academics — which is exactly the confusion the new field exists to
 * avoid (see the two worked examples in the schema doc: a co-scholastic-only
 * teacher should show *zero* classes in Academics, and a mixed teacher's
 * Academics should show only their subject classes).
 *
 * So for every staffs doc:
 *   - a classId that IS a key in `assignments` stays in `classIds` (real
 *     academic access, unchanged)
 *   - a classId that is NOT a key in `assignments` (bare class-level grant)
 *     is MOVED into `coScholasticClassIds` and dropped from `classIds`
 *   - anything already in `coScholasticClassIds` is kept (union, never
 *     stripped)
 *   - `assignments` itself is never touched
 *
 * A staff doc where classIds/assignments/coScholasticClassIds are ALL empty
 * after this can't be fixed by inference — there's no signal to move — so it
 * is only flagged (NO_ACCESS) in the report for manual follow-up, matching
 * the "No access set" warning the Teachers tab now shows in the dashboard.
 *
 * Idempotent: a doc with no bare classIds left (e.g. already migrated, or
 * created fresh under the new model) reports SKIP and is never written.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *   # 1. Dry run (default). Touches nothing, writes the review CSV.
 *   node scripts/backfill-teacher-co-scholastic-classids.mjs
 *
 *   # 2. Apply the moves.
 *   node scripts/backfill-teacher-co-scholastic-classids.mjs --commit
 *
 * Flags:
 *   --commit           actually write (without it nothing is written)
 *   --school=<id>      limit to one school (repeatable)
 *   --type=<type>      limit to one staff `type` (repeatable, default: teacher)
 *   --all-types        process every staff doc regardless of `type`
 *   --out=<path>       CSV path (default ./co-scholastic-classids-backfill-<stamp>.csv)
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
const allTypes = flag('all-types')
const onlyTypes = allTypes ? [] : (values('type').length ? values('type') : ['teacher'])
const projectId = value('project') || process.env.GOOGLE_CLOUD_PROJECT || DEFAULT_PROJECT
const outPath = value('out') || `co-scholastic-classids-backfill-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`

// ── Helpers ─────────────────────────────────────────────────────────────────
function dedupe(arr) {
  return Array.from(new Set(arr))
}

const CSV_COLUMNS = [
  'school', 'staffId', 'name', 'type', 'action',
  'before_classIds', 'before_assignmentKeys', 'before_coScholasticClassIds',
  'moved_to_coScholastic', 'after_classIds', 'after_coScholasticClassIds', 'note',
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

// ── Plan ────────────────────────────────────────────────────────────────────
function planForStaff(schoolId, docSnap) {
  const data = docSnap.data()
  const base = { school: schoolId, staffId: docSnap.id, name: data.name || '', type: data.type || '' }

  const classIds = data.classIds || []
  const assignments = data.assignments || {}
  const existingCoScholastic = data.coScholasticClassIds || []
  const assignmentKeys = Object.keys(assignments)
  const assignmentKeySet = new Set(assignmentKeys)

  const bareClassIds = classIds.filter(id => !assignmentKeySet.has(id))
  const afterClassIds = dedupe([...assignmentKeys, ...classIds.filter(id => assignmentKeySet.has(id))])
  const afterCoScholastic = dedupe([...existingCoScholastic, ...bareClassIds])

  const classIdsChanged = afterClassIds.length !== classIds.length || afterClassIds.some(id => !classIds.includes(id))
  const coScholasticChanged = afterCoScholastic.length !== existingCoScholastic.length
    || afterCoScholastic.some(id => !existingCoScholastic.includes(id))

  const commonFields = {
    ...base,
    before_classIds: classIds.join(';'),
    before_assignmentKeys: assignmentKeys.join(';'),
    before_coScholasticClassIds: existingCoScholastic.join(';'),
  }

  if (!classIdsChanged && !coScholasticChanged) {
    const hasNoAccess = !classIds.length && !assignmentKeys.length && !existingCoScholastic.length
    return {
      ...commonFields,
      action: hasNoAccess ? 'NO_ACCESS' : 'SKIP',
      moved_to_coScholastic: '', after_classIds: classIds.join(';'), after_coScholasticClassIds: existingCoScholastic.join(';'),
      note: hasNoAccess ? 'No classIds/assignments/coScholasticClassIds at all — cannot infer access, needs manual review' : '',
    }
  }

  return {
    ...commonFields,
    action: 'UPDATE',
    moved_to_coScholastic: bareClassIds.join(';'),
    after_classIds: afterClassIds.join(';'),
    after_coScholasticClassIds: afterCoScholastic.join(';'),
    note: bareClassIds.length
      ? `${bareClassIds.length} bare classId(s) with no subject assignment moved to coScholasticClassIds`
      : '',
    _write: { classIds: afterClassIds, coScholasticClassIds: afterCoScholastic },
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
    const staffsSnap = await db.collection('schools').doc(schoolId).collection('staffs').get()
    for (const docSnap of staffsSnap.docs) {
      const data = docSnap.data()
      if (onlyTypes.length && !onlyTypes.includes(data.type)) continue
      plan.push(planForStaff(schoolId, docSnap))
    }
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
      batch.update(db.collection('schools').doc(row.school).collection('staffs').doc(row.staffId), {
        ...row._write,
        updated_at: new Date(),
        updated_by: 'scripts/backfill-teacher-co-scholastic-classids.mjs',
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
  console.log(`Types:   ${onlyTypes.length ? onlyTypes.join(', ') : '(all)'}`)
  if (onlySchools.length) console.log(`Schools: ${onlySchools.join(', ')}`)
  console.log('')

  const plan = await buildPlan(db)
  const updates = plan.filter(r => r.action === 'UPDATE').length
  const noAccess = plan.filter(r => r.action === 'NO_ACCESS').length
  const skips = plan.filter(r => r.action === 'SKIP').length
  const schools = new Set(plan.map(r => r.school)).size

  // Flush the report before touching anything, so the review CSV always
  // exists on disk ahead of any write.
  writeReport(plan)
  console.log(`${plan.length} staff doc(s) across ${schools} school(s): ${updates} to update, ${noAccess} flagged NO_ACCESS, ${skips} already correct.`)
  console.log(`Report: ${outPath}`)

  if (!plan.length) return
  if (!commit) {
    console.log('\nDry run — nothing written. Review the CSV, then re-run with --commit.')
    if (noAccess) console.log(`${noAccess} staff doc(s) have no access signal at all — these are NOT touched by this script and need manual review.`)
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
