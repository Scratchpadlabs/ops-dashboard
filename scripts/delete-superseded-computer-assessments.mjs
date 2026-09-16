#!/usr/bin/env node
/**
 * One-off correction: the "Computer" subject for classes I–VIII was moved to
 * a 50-50 Practical/Theory split (2 assessment components) via a CSV import,
 * but the CSV importer's buildAssessmentsPlan() (src/composables/useImport.js)
 * only ever emits CREATE — it never diffs against what's already in Firestore
 * and never deletes. So the old 5-component structure (Periodic Test-I,
 * Multiple Assess, Portfolio, Sub Enrichment, Term Exam) is still sitting
 * next to the new Practical/Theory rows for every I_Computer .. VIII_Computer
 * subject, doubling up the Smart Sheets marks-entry columns (confirmed via
 * screenshot: 7 EINSTEIN / Term 1 / Computer showing both).
 *
 * This script deletes just those 5 leftover components, for just the
 * Computer subjects, for just Term_1_2026_27 — leaving Practical and Theory
 * (and every other subject) untouched. It mirrors the same safety check
 * AssessmentsTab.vue's confirmDeleteAssessment() uses: skip (never force)
 * any assessment a teacher has already entered marks against.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *   # 1. Dry run (default). Touches nothing, writes the review CSV.
 *   node scripts/delete-superseded-computer-assessments.mjs --school=Hillgreen_Highschool
 *
 *   # 2. Apply the fix.
 *   node scripts/delete-superseded-computer-assessments.mjs --school=Hillgreen_Highschool --commit
 *
 * Flags:
 *   --commit           actually delete (without it nothing is written)
 *   --school=<id>      REQUIRED — no accidental all-schools run
 *   --term=<id>        default Term_1_2026_27
 *   --out=<path>       CSV path (default ./superseded-computer-assessments-<stamp>.csv)
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

const GRADES = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII']
const SUBJECT_IDS = GRADES.map(g => `${g}_Computer`)
const KEEP_NAMES = new Set(['Practical', 'Theory'])
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
const outPath = value('out') || `superseded-computer-assessments-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`

if (!schoolId) {
  console.error('Missing required --school=<id> (no accidental all-schools run for a targeted fix like this)')
  process.exit(1)
}

initializeApp({ credential: applicationDefault(), projectId })
const db = getFirestore()

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
  const toDelete = []

  for (const subjectId of SUBJECT_IDS) {
    const snap = await db.collection('schools').doc(schoolId).collection('assessments')
      .where('termId', '==', termId).where('subjectId', '==', subjectId).get()

    if (snap.empty) {
      rows.push({ subjectId, name: '(none found)', action: 'SKIP — no assessment docs for this subject/term' })
      continue
    }

    const names = snap.docs.map(d => d.data().name)
    const unexpected = names.filter(n => !KEEP_NAMES.has(n) && !DELETE_NAMES.has(n))
    if (unexpected.length) {
      rows.push({ subjectId, name: unexpected.join('|'), action: `SKIP — unrecognized component name(s), not touching this subject` })
      continue
    }

    const entered = await hasEnteredMarks(termId, subjectId).catch(() => 'error')
    if (entered === 'error') {
      rows.push({ subjectId, name: '(all)', action: 'SKIP — could not verify entered marks, not deleting' })
      continue
    }

    for (const docSnap of snap.docs) {
      const d = docSnap.data()
      if (KEEP_NAMES.has(d.name)) {
        rows.push({ subjectId, name: d.name, action: 'KEEP' })
        continue
      }
      if (!DELETE_NAMES.has(d.name)) continue // already reported as unexpected above
      if (entered) {
        rows.push({ subjectId, name: d.name, action: 'SKIP — marks already entered, orphaning risk' })
        continue
      }
      rows.push({ subjectId, name: d.name, action: commit ? 'DELETED' : 'WOULD DELETE' })
      toDelete.push(docSnap.ref)
    }
  }

  const header = 'subjectId,name,action\n'
  const body = rows.map(r => `${r.subjectId},"${r.name}",${r.action}`).join('\n')
  writeFileSync(outPath, header + body + '\n')
  console.log(`Wrote review CSV: ${outPath}`)
  console.log(`${toDelete.length} assessment doc(s) ${commit ? 'deleted' : 'would be deleted'} across ${SUBJECT_IDS.length} subjects.`)

  if (!commit) {
    console.log('Dry run only — nothing was written. Re-run with --commit to apply.')
    return
  }

  const BATCH_LIMIT = 400
  for (let i = 0; i < toDelete.length; i += BATCH_LIMIT) {
    const batch = db.batch()
    for (const ref of toDelete.slice(i, i + BATCH_LIMIT)) batch.delete(ref)
    await batch.commit()
  }
  console.log('Done.')
}

main().catch(e => { console.error(e); process.exit(1) })
