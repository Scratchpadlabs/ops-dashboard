#!/usr/bin/env node
/**
 * One-time backfill: link existing `subjects/{id}` docs into their matching
 * `classes/{id}.subjects[]` arrays.
 *
 * Background: a CSV subjects import (School Material Import → Subjects) only
 * ever wrote `schools/{schoolId}/subjects/{docId}` docs. Manual entry and the
 * Structure-inference tool both also add an entry to every matching class's
 * `subjects[]` — the array marks entry, teacher assignment and the student's
 * subject list actually read — but the CSV import path never did, so an
 * imported subject was invisible everywhere except the Subjects tab. That
 * gap is fixed going forward in commit_import (see `_link_subjects_to_classes`
 * in functions/generate_import/main.py); this script catches up subjects that
 * were already imported before the fix (e.g. Hillgreen).
 *
 * Subject docIds are `{grade}_{name}` (grade-scoped, not section-scoped), so
 * a subject is linked into every class of that grade, across all sections. A
 * docId with no grade prefix ('UNSPECIFIED_...') can't be matched to any
 * class and is skipped/flagged.
 *
 * Idempotent: a class that already has a subjectId in its `subjects[]` is
 * left untouched for that subject — re-running only adds what's missing.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *   # 1. Dry run (default). Touches nothing, writes the review CSV.
 *   node scripts/backfill-subjects-into-classes.mjs --school=hillgreen
 *
 *   # 2. Apply the links.
 *   node scripts/backfill-subjects-into-classes.mjs --school=hillgreen --commit
 *
 * Flags:
 *   --commit           actually write (without it nothing is written)
 *   --school=<id>      limit to one school (repeatable) — omit to run every school
 *   --out=<path>       CSV path (default ./subjects-classes-backfill-<stamp>.csv)
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
const outPath = value('out') || `subjects-classes-backfill-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`

// ── Grade normalization ─────────────────────────────────────────────────────
// Mirrors normalize_grade() in functions/generate_import/normalize.py without
// pulling in the education-KB classifier this script can't import: roman
// numerals and plain numbers both collapse to the same canonical digit
// string, everything else just upper-cases. Good enough for the common
// I-XII / 1-12 / Nursery-LKG-UKG schools this backfill targets; a grade this
// can't reconcile just falls through as a straight uppercase match, same as
// the Python original's fallback.
const ROMAN_TO_NUM = {
  I: '1', II: '2', III: '3', IV: '4', V: '5', VI: '6', VII: '7', VIII: '8',
  IX: '9', X: '10', XI: '11', XII: '12',
}
function normalizeGrade(g) {
  const s = (g || '').trim().toUpperCase()
  if (!s) return ''
  if (ROMAN_TO_NUM[s]) return ROMAN_TO_NUM[s]
  if (/^\d+$/.test(s)) return String(Number(s))
  return s
}

const CSV_COLUMNS = [
  'school', 'subjectId', 'grade_prefix', 'grade_normalized', 'classId', 'action', 'note',
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
    const [subjectsSnap, classesSnap] = await Promise.all([
      db.collection('schools').doc(schoolId).collection('subjects').get(),
      db.collection('schools').doc(schoolId).collection('classes').get(),
    ])
    if (!subjectsSnap.docs.length || !classesSnap.docs.length) continue

    const classesByGrade = new Map()
    for (const c of classesSnap.docs) {
      const grade = normalizeGrade(c.data().clazz)
      if (!classesByGrade.has(grade)) classesByGrade.set(grade, [])
      classesByGrade.get(grade).push({ id: c.id, subjects: c.data().subjects || [] })
    }

    for (const s of subjectsSnap.docs) {
      const subjectId = s.id
      if (!subjectId.includes('_')) {
        plan.push({ school: schoolId, subjectId, grade_prefix: '', grade_normalized: '', classId: '', action: 'SKIP', note: "docId has no grade prefix — can't match a class" })
        continue
      }
      const gradePrefix = subjectId.split('_')[0]
      if (gradePrefix === 'UNSPECIFIED') {
        plan.push({ school: schoolId, subjectId, grade_prefix: gradePrefix, grade_normalized: '', classId: '', action: 'SKIP', note: 'Subject has no grade — link manually if needed' })
        continue
      }
      const grade = normalizeGrade(gradePrefix)
      const classes = classesByGrade.get(grade) || []
      if (!classes.length) {
        plan.push({ school: schoolId, subjectId, grade_prefix: gradePrefix, grade_normalized: grade, classId: '', action: 'SKIP', note: `No class configured for grade '${grade}'` })
        continue
      }
      for (const c of classes) {
        const already = c.subjects.some(sub => sub.subjectId === subjectId)
        plan.push({
          school: schoolId, subjectId, grade_prefix: gradePrefix, grade_normalized: grade, classId: c.id,
          action: already ? 'SKIP' : 'LINK',
          note: already ? 'Already linked' : '',
        })
      }
    }
  }
  return plan
}

// ── Apply ───────────────────────────────────────────────────────────────────
async function applyPlan(db, plan) {
  const links = plan.filter(r => r.action === 'LINK')
  const bySchoolClass = new Map()
  for (const row of links) {
    const key = `${row.school} ${row.classId}`
    if (!bySchoolClass.has(key)) bySchoolClass.set(key, [])
    bySchoolClass.get(key).push(row)
  }

  const entries = Array.from(bySchoolClass.entries())
  for (let i = 0; i < entries.length; i += BATCH_LIMIT) {
    const chunk = entries.slice(i, i + BATCH_LIMIT)
    const batch = db.batch()
    for (const [key, rows] of chunk) {
      const [schoolId, classId] = key.split(' ')
      const classRef = db.collection('schools').doc(schoolId).collection('classes').doc(classId)
      const additions = rows.map(row => ({
        subjectId: row.subjectId, teacherId: '', isCompleted: false, completedAt: null,
        topics: [
          { id: `${row.subjectId}_Term1`, topic: 'Term 1', isCompleted: false, completedAt: null },
          { id: `${row.subjectId}_Term2`, topic: 'Term 2', isCompleted: false, completedAt: null },
          { id: `${row.subjectId}_Optional`, topic: 'Optional', isCompleted: false, completedAt: null },
        ],
      }))
      batch.update(classRef, {
        subjects: [...(rows[0]._existingSubjects || []), ...additions],
        updated_at: new Date(),
        updated_by: 'scripts/backfill-subjects-into-classes.mjs',
      })
    }
    try {
      await batch.commit()
      chunk.forEach(([, rows]) => rows.forEach(r => { r.action = 'LINKED' }))
    } catch (e) {
      chunk.forEach(([, rows]) => rows.forEach(r => { r.action = 'FAILED'; r.note = [r.note, `write failed: ${e.message}`].filter(Boolean).join('; ') }))
    }
    console.log(`  wrote ${Math.min(i + chunk.length, entries.length)}/${entries.length} class doc(s)`)
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

  // Re-fetch each class's live subjects[] just before writing (not from the
  // plan pass) so a batch write never clobbers something added between the
  // scan and the commit.
  const plan = await buildPlan(db)
  const links = plan.filter(r => r.action === 'LINK')
  if (links.length) {
    const classKeys = new Set(links.map(r => `${r.school} ${r.classId}`))
    for (const key of classKeys) {
      const [schoolId, classId] = key.split(' ')
      const snap = await db.collection('schools').doc(schoolId).collection('classes').doc(classId).get()
      const existing = snap.data()?.subjects || []
      for (const row of links) {
        if (row.school === schoolId && row.classId === classId) row._existingSubjects = existing
      }
    }
  }

  const linkCount = links.length
  const skips = plan.filter(r => r.action === 'SKIP').length
  const schools = new Set(plan.map(r => r.school)).size

  writeReport(plan)
  console.log(`${plan.length} subject-class pairing(s) across ${schools} school(s): ${linkCount} to link, ${skips} skipped/already linked.`)
  console.log(`Report: ${outPath}`)

  if (!plan.length) return
  if (!commit) {
    console.log('\nDry run — nothing written. Review the CSV, then re-run with --commit.')
    return
  }
  if (!linkCount) {
    console.log('\nNothing to link.')
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
