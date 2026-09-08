#!/usr/bin/env node
/**
 * Read-only diagnostic: why a co_scholastic_activities doc isn't showing up
 * in the teacher app for a given teacher.
 *
 * Prints, for one school:
 *   - every co_scholastic_activities doc, with its termId, classIds (raw —
 *     empty/absent means "every class" per docs/school-setup-page-spec.md
 *     §"co_scholastic_activities"), and whether that termId matches an
 *     `isActive` term
 *   - all terms, flagging which one(s) are `isActive`
 *   - (with --teacher) that staff doc's assignments/classIds/
 *     coScholasticClassIds, since a teacher only sees Co-Scholastic
 *     activities for a class if that class is covered by the union of those
 *     three fields (or all three are empty, which is a documented
 *     show-everything fallback for unconfigured staff)
 *
 * Writes nothing — this is inspection only, safe to run any time.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *   node scripts/diagnose-coscholastic-visibility.mjs --school=Hillgreen_Highschool
 *   node scripts/diagnose-coscholastic-visibility.mjs --school=Hillgreen_Highschool --teacher=<staffId>
 *   node scripts/diagnose-coscholastic-visibility.mjs --school=Hillgreen_Highschool --activity="Height"
 *
 * Flags:
 *   --school=<id>      required. School doc ID.
 *   --teacher=<id>     optional. Also dump this staff doc's access fields.
 *   --activity=<text>  optional. Only print activities whose name contains this (case-insensitive).
 *   --project=<id>     Firestore project (default clarified-1501, or GOOGLE_CLOUD_PROJECT)
 *
 * Auth: application default credentials.
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json node scripts/...
 * or `gcloud auth application-default login` with access to the project.
 */
import { initializeApp, applicationDefault } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

const DEFAULT_PROJECT = 'clarified-1501'

const argv = process.argv.slice(2)
const value = (name) => {
  const hit = argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : null
}

const schoolId = value('school')
const teacherId = value('teacher')
const activityFilter = (value('activity') || '').toLowerCase()
const projectId = value('project') || process.env.GOOGLE_CLOUD_PROJECT || DEFAULT_PROJECT

if (!schoolId) {
  console.error('Usage: node scripts/diagnose-coscholastic-visibility.mjs --school=<schoolId> [--teacher=<staffId>] [--activity=<text>]')
  process.exit(1)
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

async function main() {
  initializeApp({ credential: applicationDefault(), projectId })
  const db = getFirestore()
  const school = db.collection('schools').doc(schoolId)

  console.log(`Project: ${projectId}`)
  console.log(`School:  ${schoolId}\n`)

  const [termsSnap, classesSnap, activitiesSnap] = await Promise.all([
    school.collection('terms').get(),
    school.collection('classes').get(),
    school.collection('co_scholastic_activities').get(),
  ])

  const allClassIds = classesSnap.docs.map(d => d.id).sort()
  const termsById = new Map(termsSnap.docs.map(d => [d.id, d.data()]))
  const activeTermIds = termsSnap.docs.filter(d => d.data().isActive !== false).map(d => d.id)

  console.log(`── Terms (${termsSnap.docs.length}) ──────────────────────────────`)
  for (const d of termsSnap.docs) {
    const data = d.data()
    console.log(`  ${d.id}  isActive=${data.isActive !== false}  name="${data.name || ''}"`)
  }
  console.log('')

  console.log(`── Classes (${allClassIds.length}) ──────────────────────────────`)
  console.log(`  ${allClassIds.join(', ') || '(none)'}\n`)

  const relevant = activitiesSnap.docs.filter(d => !activityFilter || (d.data().name || '').toLowerCase().includes(activityFilter))
  console.log(`── co_scholastic_activities (${relevant.length}${activityFilter ? ` matching "${activityFilter}"` : ''} of ${activitiesSnap.docs.length}) ──────────────────────────────`)
  for (const d of relevant) {
    const a = d.data()
    const classIds = a.classIds || []
    const scope = classIds.length ? classIds.join(', ') : 'ALL CLASSES (empty/absent classIds)'
    const term = termsById.get(a.termId)
    const termFlag = !a.termId ? '  [!] no termId set'
      : !term ? `  [!] termId '${a.termId}' does not exist in terms collection`
      : term.isActive === false ? `  [!] term '${a.termId}' is NOT active`
      : ''
    console.log(`  ${d.id}`)
    console.log(`    name: ${a.name}   entryType: ${a.entryType}   maxMarks: ${a.maxMarks}`)
    console.log(`    termId: ${a.termId || '(none)'}${termFlag}`)
    console.log(`    classIds scope: ${scope}`)
    console.log('')
  }
  if (!relevant.length) console.log('  (none)\n')

  if (teacherId) {
    console.log(`── staffs/${teacherId} ──────────────────────────────`)
    const snap = await school.collection('staffs').doc(teacherId).get()
    if (!snap.exists) {
      console.log('  [!] no such staff doc\n')
    } else {
      const s = snap.data()
      const assignments = s.assignments || {}
      const classIds = s.classIds || []
      const coScholasticClassIds = s.coScholasticClassIds || []
      const allEmpty = !Object.keys(assignments).length && !classIds.length && !coScholasticClassIds.length
      console.log(`  name: ${s.name || ''}   type: ${s.type || ''}`)
      console.log(`  assignments keys: ${Object.keys(assignments).join(', ') || '(none)'}`)
      console.log(`  classIds: ${classIds.join(', ') || '(none)'}`)
      console.log(`  coScholasticClassIds: ${coScholasticClassIds.join(', ') || '(none)'}`)
      if (allEmpty) {
        console.log('  => all three empty: legacy "show everything" fallback applies (should see every class\'s Co-Scholastic activities)')
      } else {
        const covered = new Set([...Object.keys(assignments), ...classIds, ...coScholasticClassIds])
        const uncovered = allClassIds.filter(c => !covered.has(c))
        console.log(`  => Co-Scholastic-visible classes for this teacher: ${[...covered].filter(c => allClassIds.includes(c)).join(', ') || '(none)'}`)
        if (uncovered.length) console.log(`  => classes NOT visible to this teacher for Co-Scholastic: ${uncovered.join(', ')}`)
      }
      console.log('')
    }
  }

  console.log('Reminder: this only inspects Firestore data against the ops-dashboard\'s documented contract')
  console.log('(docs/school-setup-page-spec.md). It cannot see the teacher app\'s actual read logic —')
  console.log('if everything above looks correct, the bug is likely in how the teacher app queries/filters this data.')
}

main().catch(fail)
