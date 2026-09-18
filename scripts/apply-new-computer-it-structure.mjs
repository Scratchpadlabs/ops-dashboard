#!/usr/bin/env node
/**
 * Replace the current assessment structure for Computer (grades I-VIII),
 * IX_AI, and X_IT with a newly received official structure, entirely
 * superseding the Practical(50)+Theory(50) split applied earlier this term.
 *
 * Grades I-VIII (I_Computer .. VIII_Computer) — total 100:
 *   Periodic Test-I   5   marks, none
 *   Multiple Assess   5   marks, none
 *   Portfolio         5   marks, none
 *   Sub Enrichment    5   marks, none
 *   Practical         20  marks, none
 *   Term / Board Exam 40  marks, sum_up x1.5 -> 60
 *
 * Grades IX-X (IX_AI, X_IT) — total 100:
 *   Periodic Test-I   5   marks, none
 *   Multiple Assess   5   marks, none
 *   Portfolio         5   marks, none
 *   Sub Enrichment    5   marks, none
 *   Practical         30  marks, none
 *   Term / Board Exam 50  marks, none
 *
 * For each subject: deletes every existing assessment doc for that
 * subject+term (whatever it currently is — Practical/Theory from the
 * earlier fix), then creates the 6 new components above. Skips a subject
 * entirely (deletes nothing, creates nothing) if a teacher has already
 * entered marks against it this term — same safety check used by every
 * other script in this series.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *   # 1. Dry run (default). Touches nothing, writes the review CSV.
 *   node scripts/apply-new-computer-it-structure.mjs --school=Hillgreen_Highschool
 *
 *   # 2. Apply the fix.
 *   node scripts/apply-new-computer-it-structure.mjs --school=Hillgreen_Highschool --commit
 *
 * Flags:
 *   --commit           actually write/delete (without it nothing is written)
 *   --school=<id>      REQUIRED
 *   --term=<id>        default Term_1_2026_27
 *   --out=<path>       CSV path (default ./new-computer-it-structure-<stamp>.csv)
 *   --project=<id>     Firestore project (default clarified-1501, or GOOGLE_CLOUD_PROJECT)
 *
 * Auth: application default credentials.
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json node scripts/...
 * or `gcloud auth application-default login` with access to the project.
 */
import { writeFileSync } from 'node:fs'
import { initializeApp, applicationDefault } from 'firebase-admin/app'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'

const DEFAULT_PROJECT = 'clarified-1501'

const GRADES_1_8 = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'].map(g => `${g}_Computer`)
const GRADES_9_10 = ['IX_AI', 'X_IT']

const STRUCTURE_1_8 = [
  { name: 'Periodic Test-I', order: 1, maxMarks: 5, conversionType: 'none', conversionFactor: null },
  { name: 'Multiple Assess', order: 2, maxMarks: 5, conversionType: 'none', conversionFactor: null },
  { name: 'Portfolio', order: 3, maxMarks: 5, conversionType: 'none', conversionFactor: null },
  { name: 'Sub Enrichment', order: 4, maxMarks: 5, conversionType: 'none', conversionFactor: null },
  { name: 'Practical', order: 5, maxMarks: 20, conversionType: 'none', conversionFactor: null },
  { name: 'Term Exam', order: 6, maxMarks: 40, conversionType: 'sum_up', conversionFactor: 1.5 },
]
const STRUCTURE_9_10 = [
  { name: 'Periodic Test-I', order: 1, maxMarks: 5, conversionType: 'none', conversionFactor: null },
  { name: 'Multiple Assess', order: 2, maxMarks: 5, conversionType: 'none', conversionFactor: null },
  { name: 'Portfolio', order: 3, maxMarks: 5, conversionType: 'none', conversionFactor: null },
  { name: 'Sub Enrichment', order: 4, maxMarks: 5, conversionType: 'none', conversionFactor: null },
  { name: 'Practical', order: 5, maxMarks: 30, conversionType: 'none', conversionFactor: null },
  { name: 'Term Exam', order: 6, maxMarks: 50, conversionType: 'none', conversionFactor: null },
]

// ── CLI ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const value = (name) => {
  const hit = argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : null
}

const commit = flag('commit')
const schoolId = value('school')
const termId = value('term') || 'Term_1_2026_27'
const projectId = value('project') || process.env.GOOGLE_CLOUD_PROJECT || DEFAULT_PROJECT
const outPath = value('out') || `new-computer-it-structure-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`

if (!schoolId) {
  console.error('Missing required --school=<id>')
  process.exit(1)
}

initializeApp({ credential: applicationDefault(), projectId })
const db = getFirestore()

function slugPart(s) {
  return (s || '').trim().replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '')
}

async function hasEnteredMarks(termId, subjectId) {
  const sheetsSnap = await db.collection('schools').doc(schoolId).collection('smart_sheet_entries')
    .where('termId', '==', termId).where('subjectId', '==', subjectId).get()
  if (sheetsSnap.empty) return false
  const checks = await Promise.all(sheetsSnap.docs.map(async sheetDoc => {
    const entriesSnap = await sheetDoc.ref.collection('entries').limit(1).get()
    return !entriesSnap.empty
  }))
  return checks.some(Boolean)
}

async function processSubject(rows, assessmentsCol, subjectId, structure) {
  const entered = await hasEnteredMarks(termId, subjectId).catch(() => 'error')
  if (entered === 'error') {
    rows.push({ subjectId, name: '(all)', action: 'SKIP — could not verify entered marks' })
    return
  }
  if (entered) {
    rows.push({ subjectId, name: '(all)', action: 'SKIP — marks already entered, orphaning risk' })
    return
  }

  const snap = await assessmentsCol.where('termId', '==', termId).where('subjectId', '==', subjectId).get()
  for (const d of snap.docs) {
    rows.push({ subjectId, name: d.data().name, action: commit ? 'DELETED (old)' : 'WOULD DELETE (old)' })
    if (commit) await d.ref.delete()
  }

  for (const comp of structure) {
    const docId = `${subjectId}_${termId}_${slugPart(comp.name)}`
    rows.push({ subjectId, name: comp.name, action: commit ? `CREATED (${comp.maxMarks} marks)` : `WOULD CREATE (${comp.maxMarks} marks)` })
    if (commit) {
      await assessmentsCol.doc(docId).set({
        name: comp.name, termId, subjectId, order: comp.order, entryType: 'marks',
        maxMarks: comp.maxMarks, gradingScaleId: null,
        conversionType: comp.conversionType, conversionFactor: comp.conversionFactor,
        created_at: FieldValue.serverTimestamp(),
      })
    }
  }
}

async function main() {
  const rows = []
  const assessmentsCol = db.collection('schools').doc(schoolId).collection('assessments')

  for (const subjectId of GRADES_1_8) await processSubject(rows, assessmentsCol, subjectId, STRUCTURE_1_8)
  for (const subjectId of GRADES_9_10) await processSubject(rows, assessmentsCol, subjectId, STRUCTURE_9_10)

  const header = 'subjectId,name,action\n'
  const body = rows.map(r => `${r.subjectId},"${r.name}",${r.action}`).join('\n')
  writeFileSync(outPath, header + body + '\n')
  console.log(`Wrote review CSV: ${outPath}`)
  for (const r of rows) console.log(`  ${r.subjectId} / ${r.name} — ${r.action}`)

  if (!commit) console.log('\nDry run only — nothing was written. Re-run with --commit to apply.')
  else console.log('\nDone.')
}

main().catch(e => { console.error(e); process.exit(1) })
