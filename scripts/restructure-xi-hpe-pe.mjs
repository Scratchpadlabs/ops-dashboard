#!/usr/bin/env node
/**
 * One-school restructure for Class XI (first run: Hillgreen_Highschool):
 *
 *   1. HPE (Health & Physical Education) is Co-Scholastic and graded, not marked.
 *      Writes one co_scholastic_activities doc for the term:
 *        `{termId}_Health_Physical_Education`, entryType "grade", with the
 *        given grading scale, applied only to the Class XI classes (classIds).
 *
 *   2. PE (Physical Education, 048) is an Academic subject and gets the same
 *      assessment structure as XI Science_Biology:
 *        Periodic Test-I 5 · Multiple Assess 5 · Portfolio 5 · Sub Enrichment 5
 *        · Practical 10 · Term Exam 70   (= 100, all marks, no conversion)
 *      Applied to every `XI …_PE` subject (not `…_PE_Additional`). Doc IDs follow
 *      the dashboard's `{subjectId}_{termId}_{slug(name)}` rule, so the rows
 *      the dashboard already created are updated in place, not duplicated.
 *
 *   3. Optional (--remove-hpe-academic): take HPE out of Academics — delete the
 *      term's `XI …_HPE` assessments and drop the HPE subjectId from the XI
 *      class docs' `subjects` arrays. The HPE subjects doc itself is kept.
 *
 * Safety:
 *   - Dry run by default; the report CSV is written before any write.
 *   - Any change that would alter maxMarks/entryType of, or delete, an
 *     assessment whose (term, subject) already has entered marks is SKIPPED
 *     unless --force is given (same check as the dashboard's confirm dialog).
 *   - Assessments on a PE subject that are not part of the Biology structure
 *     are reported as EXTRA and left alone.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *   # Dry run — writes nothing, prints the plan and a CSV.
 *   node scripts/restructure-xi-hpe-pe.mjs --term=Term_1_2026_27 --scale=<gradingScaleId>
 *
 *   # Apply steps 1 + 2.
 *   node scripts/restructure-xi-hpe-pe.mjs --term=Term_1_2026_27 --scale=<id> --commit
 *
 *   # Apply steps 1 + 2 + 3.
 *   node scripts/restructure-xi-hpe-pe.mjs --term=Term_1_2026_27 --scale=<id> --commit --remove-hpe-academic
 *
 * Flags:
 *   --term=<termId>          required; run once per term
 *   --scale=<id>             grading_scales doc ID for HPE (A1…E); run without
 *                            it to list the school's scales and exit
 *   --school=<id>            default Hillgreen_Highschool
 *   --commit                 actually write
 *   --remove-hpe-academic    also do step 3
 *   --force                  proceed even where marks were already entered
 *   --out=<path>             report CSV path
 *   --project=<id>           Firestore project (default clarified-1501)
 *
 * Auth: application default credentials, as scripts/migrate-co-scholastic-subjects.mjs.
 */
import { writeFileSync } from 'node:fs'
import { initializeApp, applicationDefault } from 'firebase-admin/app'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'

const DEFAULT_PROJECT = 'clarified-1501'
const SCRIPT = 'scripts/restructure-xi-hpe-pe.mjs'

const HPE_ACTIVITY_NAME = 'Health & Physical Education'
// Unused for grade entry, but the schema requires maxMarks > 0.
const HPE_ACTIVITY_MAX = 100

// Copied from XI Science_Biology (Term_1_2026_27 export).
const PE_STRUCTURE = [
  { name: 'Periodic Test-I', order: 1, maxMarks: 5 },
  { name: 'Multiple Assess', order: 2, maxMarks: 5 },
  { name: 'Portfolio', order: 3, maxMarks: 5 },
  { name: 'Sub Enrichment', order: 4, maxMarks: 5 },
  { name: 'Practical', order: 5, maxMarks: 10 },
  { name: 'Term Exam', order: 6, maxMarks: 70 },
]

const XI_PE_RE = /^XI [^_]+_PE$/
const XI_HPE_RE = /^XI [^_]+_HPE$/
const XI_CLASS_RE = /^XI[\s_]/

// ── CLI ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const value = (name) => {
  const hit = argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : null
}

const commit = flag('commit')
const force = flag('force')
const removeHpeAcademic = flag('remove-hpe-academic')
const schoolId = value('school') || 'Hillgreen_Highschool'
const termId = value('term')
const scaleId = value('scale')
const projectId = value('project') || process.env.GOOGLE_CLOUD_PROJECT || DEFAULT_PROJECT
const outPath = value('out') || `xi-hpe-pe-${schoolId}-${termId}-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`

if (!termId) {
  console.error('--term=<termId> is required (e.g. --term=Term_1_2026_27).')
  process.exit(1)
}

// Same slug rule as slugify() in src/utils/assessmentHelpers.js.
function slugify(text) {
  return (text || '').trim().replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '')
}

const CSV_COLUMNS = ['step', 'collection', 'doc_id', 'action', 'name', 'subjectId', 'order', 'entryType', 'maxMarks', 'before', 'note']

function writeReport(rows) {
  const escape = (v) => {
    const s = v === null || v === undefined ? '' : String(v)
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  writeFileSync(outPath, [CSV_COLUMNS.join(','), ...rows.map(r => CSV_COLUMNS.map(c => escape(r[c])).join(','))].join('\n') + '\n')
}

// Mirrors checkEnteredMarks() in src/utils/assessmentHelpers.js.
async function hasEnteredMarks(school, subjectId) {
  const snap = await school.collection('smart_sheet_entries')
    .where('termId', '==', termId).where('subjectId', '==', subjectId).get()
  for (const sheet of snap.docs) {
    if (!(await sheet.ref.collection('entries').limit(1).get()).empty) return true
  }
  return false
}

// ── Plan ────────────────────────────────────────────────────────────────────
async function buildPlan(db) {
  const school = db.collection('schools').doc(schoolId)
  if (!(await school.get()).exists) throw new Error(`No such school: ${schoolId}`)

  const [termSnap, scaleSnap, subjectsSnap, classesSnap, assessSnap, activitiesSnap] = await Promise.all([
    school.collection('terms').doc(termId).get(),
    school.collection('grading_scales').doc(scaleId).get(),
    school.collection('subjects').get(),
    school.collection('classes').get(),
    school.collection('assessments').where('termId', '==', termId).get(),
    school.collection('co_scholastic_activities').where('termId', '==', termId).get(),
  ])
  if (!termSnap.exists) throw new Error(`No such term: ${termId}`)
  if (!scaleSnap.exists) throw new Error(`No such grading scale: ${scaleId}`)

  const subjectIds = subjectsSnap.docs.map(d => d.id)
  const peSubjects = subjectIds.filter(id => XI_PE_RE.test(id)).sort()
  const hpeSubjects = subjectIds.filter(id => XI_HPE_RE.test(id)).sort()
  const xiClasses = classesSnap.docs.filter(d => XI_CLASS_RE.test(d.id)).sort((a, b) => a.id.localeCompare(b.id))
  const assessments = assessSnap.docs.map(d => ({ id: d.id, ...d.data() }))

  const plan = []
  const marksCache = new Map()
  const entered = async (subjectId) => {
    if (!marksCache.has(subjectId)) marksCache.set(subjectId, await hasEnteredMarks(school, subjectId))
    return marksCache.get(subjectId)
  }

  // Step 1 — HPE co-scholastic activity for the XI classes.
  if (!xiClasses.length) {
    plan.push({ step: 1, collection: 'co_scholastic_activities', action: 'SKIP', note: 'No Class XI class docs found' })
  } else {
    const docId = `${termId}_${slugify(HPE_ACTIVITY_NAME)}`
    const existing = activitiesSnap.docs.find(d => d.id === docId)
    const maxOrder = Math.max(0, ...activitiesSnap.docs.filter(d => d.id !== docId).map(d => d.data().order || 0))
    plan.push({
      step: 1, collection: 'co_scholastic_activities', doc_id: docId,
      action: existing ? 'UPDATE' : 'CREATE', name: HPE_ACTIVITY_NAME,
      order: existing?.data().order || maxOrder + 1, entryType: 'grade', maxMarks: HPE_ACTIVITY_MAX,
      before: existing ? `${existing.data().entryType}/${existing.data().maxMarks}` : '',
      note: `classIds: ${xiClasses.map(d => d.id).join('; ')}`,
      payload: {
        name: HPE_ACTIVITY_NAME, termId, order: existing?.data().order || maxOrder + 1,
        entryType: 'grade', maxMarks: HPE_ACTIVITY_MAX, gradingScaleId: scaleId,
        conversionType: 'none', conversionFactor: null,
        classIds: xiClasses.map(d => d.id),
      },
    })
  }

  // Step 2 — Biology structure on each XI PE subject.
  if (!peSubjects.length) plan.push({ step: 2, collection: 'assessments', action: 'SKIP', note: 'No XI …_PE subjects found' })
  for (const subjectId of peSubjects) {
    const wantedIds = new Set()
    for (const a of PE_STRUCTURE) {
      const docId = `${subjectId}_${termId}_${slugify(a.name)}`
      wantedIds.add(docId)
      const cur = assessments.find(x => x.id === docId)
      const payload = {
        name: a.name, subjectId, termId, order: a.order, entryType: 'marks', maxMarks: a.maxMarks,
        gradingScaleId: null, conversionType: 'none', conversionFactor: null,
      }
      const row = {
        step: 2, collection: 'assessments', doc_id: docId, name: a.name, subjectId,
        order: a.order, entryType: 'marks', maxMarks: a.maxMarks, payload,
        before: cur ? `${cur.entryType}/${cur.maxMarks}/${cur.conversionType}${cur.conversionFactor ? ' ' + cur.conversionFactor : ''}` : '',
      }
      if (!cur) { plan.push({ ...row, action: 'CREATE' }); continue }
      const same = cur.order === a.order && cur.entryType === 'marks' && cur.maxMarks === a.maxMarks
        && (cur.conversionType || 'none') === 'none' && cur.conversionFactor == null && !cur.gradingScaleId
      if (same) { plan.push({ ...row, action: 'UNCHANGED' }); continue }
      const sensitive = cur.entryType !== 'marks' || cur.maxMarks !== a.maxMarks
      if (sensitive && await entered(subjectId) && !force) {
        plan.push({ ...row, action: 'SKIP', note: 'Marks already entered for this subject/term — re-run with --force to change anyway' })
        continue
      }
      plan.push({ ...row, action: 'UPDATE', note: sensitive && await entered(subjectId) ? 'FORCED: marks already entered' : '' })
    }
    for (const extra of assessments.filter(x => x.subjectId === subjectId && !wantedIds.has(x.id))) {
      plan.push({
        step: 2, collection: 'assessments', doc_id: extra.id, action: 'EXTRA', name: extra.name, subjectId,
        order: extra.order, entryType: extra.entryType, maxMarks: extra.maxMarks,
        note: 'Not part of the Biology structure — left as is; remove in the dashboard if unwanted',
      })
    }
  }

  // Step 3 — take HPE out of Academics.
  if (removeHpeAcademic) {
    for (const subjectId of hpeSubjects) {
      const rows = assessments.filter(x => x.subjectId === subjectId)
      const blocked = rows.length && await entered(subjectId) && !force
      for (const a of rows) {
        plan.push({
          step: 3, collection: 'assessments', doc_id: a.id, action: blocked ? 'SKIP' : 'DELETE', name: a.name, subjectId,
          order: a.order, entryType: a.entryType, maxMarks: a.maxMarks,
          note: blocked ? 'Marks already entered for this subject/term — re-run with --force to delete anyway' : '',
        })
      }
    }
    for (const cls of xiClasses) {
      const subs = Array.isArray(cls.data().subjects) ? cls.data().subjects : []
      const keep = subs.filter(s => !XI_HPE_RE.test(s?.subjectId || ''))
      if (keep.length === subs.length) continue
      plan.push({
        step: 3, collection: 'classes', doc_id: cls.id, action: 'UPDATE',
        before: subs.map(s => s.subjectId).join('; '),
        note: `remove ${subs.filter(s => XI_HPE_RE.test(s?.subjectId || '')).map(s => s.subjectId).join('; ')} from subjects[] (affects every term)`,
        payload: { subjects: keep },
      })
    }
  }
  return plan
}

// ── Apply ───────────────────────────────────────────────────────────────────
async function applyPlan(db, plan) {
  const school = db.collection('schools').doc(schoolId)
  const stamp = { updated_at: FieldValue.serverTimestamp(), updated_by: SCRIPT }
  const batch = db.batch()
  const touched = []
  for (const r of plan) {
    const ref = school.collection(r.collection).doc(r.doc_id || '_')
    if (r.action === 'CREATE') batch.set(ref, { ...r.payload, ...stamp, created_at: FieldValue.serverTimestamp(), created_by: SCRIPT })
    else if (r.action === 'UPDATE') batch.set(ref, { ...r.payload, ...stamp }, { merge: true })
    else if (r.action === 'DELETE') batch.delete(ref)
    else continue
    touched.push(r)
  }
  if (!touched.length) return 0
  // Well under Firestore's 500-write batch limit, and all-or-nothing is what we want here.
  await batch.commit()
  touched.forEach(r => { r.action = `${r.action}D` })
  return touched.length
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  initializeApp({ credential: applicationDefault(), projectId })
  const db = getFirestore()

  console.log(`Project: ${projectId}`)
  console.log(`School:  ${schoolId}`)
  console.log(`Term:    ${termId}`)
  console.log(`Mode:    ${commit ? 'COMMIT' : 'DRY RUN (no writes)'}${removeHpeAcademic ? ' + remove HPE from Academics' : ''}${force ? ' + FORCE' : ''}\n`)

  if (!scaleId) {
    const scales = await db.collection('schools').doc(schoolId).collection('grading_scales').get()
    console.log('No --scale given. Grading scales in this school:\n')
    for (const d of scales.docs) {
      const levels = (d.data().levels || []).map(l => l.label).join(' ')
      console.log(`  --scale=${d.id}    ${d.data().name || ''}  [${levels}]`)
    }
    if (scales.empty) console.log('  (none — create the A1–E scale in Terms & Scales first)')
    console.log('\nRe-run with the --scale=… of the A1–E scale.')
    return
  }

  const plan = await buildPlan(db)
  writeReport(plan)
  for (const r of plan) {
    console.log(`  [${r.step}] ${r.action.padEnd(9)} ${r.collection}/${r.doc_id || '-'}${r.maxMarks ? `  ${r.entryType} ${r.maxMarks}` : ''}${r.before ? `  (was ${r.before})` : ''}${r.note ? `  — ${r.note}` : ''}`)
  }
  console.log(`\nReport: ${outPath}`)

  if (!commit) {
    console.log('Dry run — nothing written. Review the plan, then re-run with --commit.')
    return
  }
  const n = await applyPlan(db, plan)
  writeReport(plan)
  console.log(n ? `\nDone: ${n} write(s) committed.` : '\nNothing to write.')
}

function fail(err) {
  if (/default credentials/i.test(err?.message || '')) {
    console.error('\nCould not authenticate to Firestore.')
    console.error('Set GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json,')
    console.error('or run `gcloud auth application-default login` with access to the project.')
  } else {
    console.error(err?.message || err)
  }
  process.exit(1)
}

process.on('unhandledRejection', fail)
main().catch(fail)
