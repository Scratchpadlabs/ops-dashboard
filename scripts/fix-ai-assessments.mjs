#!/usr/bin/env node
/**
 * One-off correction, follow-up to delete-superseded-computer-assessments.mjs.
 * Two independent fixes to the "AI" subjects, both scoped to one term:
 *
 * 1. IX_AI (grade 9) still has the old 5-component structure (Periodic
 *    Test-I, Multiple Assess, Portfolio, Sub Enrichment, Term Exam, total
 *    70) — it never got a Practical/Theory split. This creates
 *    Practical(50) + Theory(50) for IX_AI, then deletes the 5 old
 *    components (same entered-marks safety check as the Computer fix).
 *
 * 2. XI Commerce/Humanities/Science_Artificial_Intelligence already have
 *    exactly Practical(50) + Term Exam(50) — already the right 50-50 split,
 *    just named "Term Exam" instead of "Theory". This renames that
 *    component to "Theory" in place (same doc, same marks/order — the app's
 *    own edit flow treats doc IDs as immutable and never re-slugs on
 *    rename, see AssessmentsTab.vue's saveEdit()).
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *   # 1. Dry run (default). Touches nothing, writes the review CSV.
 *   node scripts/fix-ai-assessments.mjs --school=Hillgreen_Highschool
 *
 *   # 2. Apply the fix.
 *   node scripts/fix-ai-assessments.mjs --school=Hillgreen_Highschool --commit
 *
 * Flags:
 *   --commit           actually write/delete (without it nothing is written)
 *   --school=<id>      REQUIRED
 *   --term=<id>        default Term_1_2026_27
 *   --out=<path>       CSV path (default ./fix-ai-assessments-<stamp>.csv)
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

const IX_AI_SUBJECT = 'IX_AI'
const IX_AI_DELETE_NAMES = new Set(['Periodic Test-I', 'Multiple Assess', 'Portfolio', 'Sub Enrichment', 'Term Exam'])

const XI_AI_SUBJECTS = [
  'XI Commerce_Artificial_Intelligence',
  'XI Humanities_Artificial_Intelligence',
  'XI Science_Artificial_Intelligence',
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
const outPath = value('out') || `fix-ai-assessments-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`

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

  // ── 1. IX_AI: create Practical + Theory, delete the 5 old components ────
  {
    const entered = await hasEnteredMarks(termId, IX_AI_SUBJECT).catch(() => 'error')
    if (entered === 'error') {
      rows.push({ subjectId: IX_AI_SUBJECT, name: '(all)', action: 'SKIP — could not verify entered marks' })
    } else if (entered) {
      rows.push({ subjectId: IX_AI_SUBJECT, name: '(all)', action: 'SKIP — marks already entered, orphaning risk' })
    } else {
      const snap = await assessmentsCol.where('termId', '==', termId).where('subjectId', '==', IX_AI_SUBJECT).get()
      const existingNames = new Set(snap.docs.map(d => d.data().name))

      for (const [name, order] of [['Practical', 1], ['Theory', 2]]) {
        if (existingNames.has(name)) {
          rows.push({ subjectId: IX_AI_SUBJECT, name, action: 'SKIP — already exists' })
          continue
        }
        const docId = `${IX_AI_SUBJECT}_${termId}_${slugPart(name)}`
        rows.push({ subjectId: IX_AI_SUBJECT, name, action: commit ? 'CREATED (50 marks)' : 'WOULD CREATE (50 marks)' })
        if (commit) {
          await assessmentsCol.doc(docId).set({
            name, termId, subjectId: IX_AI_SUBJECT, order, entryType: 'marks',
            maxMarks: 50, gradingScaleId: null, conversionType: 'none', conversionFactor: null,
            created_at: FieldValue.serverTimestamp(),
          })
        }
      }

      for (const d of snap.docs) {
        const name = d.data().name
        if (!IX_AI_DELETE_NAMES.has(name)) continue
        rows.push({ subjectId: IX_AI_SUBJECT, name, action: commit ? 'DELETED' : 'WOULD DELETE' })
        if (commit) await d.ref.delete()
      }
    }
  }

  // ── 2. XI AI subjects: rename "Term Exam" -> "Theory" in place ──────────
  for (const subjectId of XI_AI_SUBJECTS) {
    const snap = await assessmentsCol.where('termId', '==', termId).where('subjectId', '==', subjectId).get()
    const termExamDoc = snap.docs.find(d => d.data().name === 'Term Exam')
    if (!termExamDoc) {
      rows.push({ subjectId, name: '(none)', action: 'SKIP — no "Term Exam" component found' })
      continue
    }
    rows.push({ subjectId, name: 'Term Exam -> Theory', action: commit ? 'RENAMED' : 'WOULD RENAME' })
    if (commit) {
      await termExamDoc.ref.update({ name: 'Theory', updated_at: FieldValue.serverTimestamp() })
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
