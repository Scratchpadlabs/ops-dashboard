#!/usr/bin/env node
/**
 * One-off correction, same pattern as fix-ai-assessments.mjs's IX_AI fix.
 *
 * X_IT (grade 10 IT) still has the old 5-component structure (Periodic
 * Test-I, Multiple Assess, Portfolio, Sub Enrichment, Term Exam, total 70)
 * — no Practical/Theory split. This creates Practical(50) + Theory(50) for
 * X_IT, then deletes the 5 old components (same entered-marks safety check
 * used by the Computer and AI fixes).
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *   # 1. Dry run (default). Touches nothing, writes the review CSV.
 *   node scripts/fix-it-assessments.mjs --school=Hillgreen_Highschool
 *
 *   # 2. Apply the fix.
 *   node scripts/fix-it-assessments.mjs --school=Hillgreen_Highschool --commit
 *
 * Flags:
 *   --commit           actually write/delete (without it nothing is written)
 *   --school=<id>      REQUIRED
 *   --term=<id>        default Term_1_2026_27
 *   --out=<path>       CSV path (default ./fix-it-assessments-<stamp>.csv)
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

const SUBJECT_ID = 'X_IT'
const DELETE_NAMES = new Set(['Periodic Test-I', 'Multiple Assess', 'Portfolio', 'Sub Enrichment', 'Term Exam'])

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
const outPath = value('out') || `fix-it-assessments-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`

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

async function main() {
  const rows = []
  const assessmentsCol = db.collection('schools').doc(schoolId).collection('assessments')

  const entered = await hasEnteredMarks(termId, SUBJECT_ID).catch(() => 'error')
  if (entered === 'error') {
    rows.push({ subjectId: SUBJECT_ID, name: '(all)', action: 'SKIP — could not verify entered marks' })
  } else if (entered) {
    rows.push({ subjectId: SUBJECT_ID, name: '(all)', action: 'SKIP — marks already entered, orphaning risk' })
  } else {
    const snap = await assessmentsCol.where('termId', '==', termId).where('subjectId', '==', SUBJECT_ID).get()
    const existingNames = new Set(snap.docs.map(d => d.data().name))

    for (const [name, order] of [['Practical', 1], ['Theory', 2]]) {
      if (existingNames.has(name)) {
        rows.push({ subjectId: SUBJECT_ID, name, action: 'SKIP — already exists' })
        continue
      }
      const docId = `${SUBJECT_ID}_${termId}_${slugPart(name)}`
      rows.push({ subjectId: SUBJECT_ID, name, action: commit ? 'CREATED (50 marks)' : 'WOULD CREATE (50 marks)' })
      if (commit) {
        await assessmentsCol.doc(docId).set({
          name, termId, subjectId: SUBJECT_ID, order, entryType: 'marks',
          maxMarks: 50, gradingScaleId: null, conversionType: 'none', conversionFactor: null,
          created_at: FieldValue.serverTimestamp(),
        })
      }
    }

    for (const d of snap.docs) {
      const name = d.data().name
      if (!DELETE_NAMES.has(name)) continue
      rows.push({ subjectId: SUBJECT_ID, name, action: commit ? 'DELETED' : 'WOULD DELETE' })
      if (commit) await d.ref.delete()
    }
  }

  const header = 'subjectId,name,action\n'
  const body = rows.map(r => `${r.subjectId},"${r.name}",${r.action}`).join('\n')
  writeFileSync(outPath, header + body + '\n')
  console.log(`Wrote review CSV: ${outPath}`)
  for (const r of rows) console.log(`  ${r.subjectId} / ${r.name} — ${r.action}`)

  if (!commit) console.log('\nDry run only — nothing was written. Re-run with --commit to apply.')
  else console.log('\nDone.')
}

main().catch(e => { console.error(e); process.exit(1) })
