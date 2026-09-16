#!/usr/bin/env node
/**
 * Read-only report: which class/subject smart_sheet_entries already have
 * marks entered, school-wide. Same data SheetsStatusTab.vue shows in the UI
 * (lastEditedAt/lastEditedBy/entryCount per classId+subjectId), surfaced as
 * a script so it can be checked before a destructive operation — e.g.
 * deciding whether it's safe to delete every assessment for a term and
 * re-upload a fresh CSV, or running delete-superseded-computer-assessments.mjs.
 *
 * Never writes anything — read-only.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *   # every term, every subject
 *   node scripts/check-entered-marks.mjs --school=Hillgreen_Highschool
 *
 *   # one term only
 *   node scripts/check-entered-marks.mjs --school=Hillgreen_Highschool --term=Term_1_2026_27
 *
 *   # limit to specific subjects (repeatable)
 *   node scripts/check-entered-marks.mjs --school=Hillgreen_Highschool --term=Term_1_2026_27 \
 *     --subject=I_Computer --subject=II_Computer
 *
 * Flags:
 *   --school=<id>      REQUIRED
 *   --term=<id>        optional — omit to check every term in one pass
 *   --subject=<id>     optional, repeatable — filter to specific subjectId(s)
 *   --only-entered     only print rows with entryCount > 0 (default: print all)
 *   --out=<path>       CSV path (default ./entered-marks-<stamp>.csv)
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

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const value = (name) => {
  const hit = argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : null
}
const values = (name) => argv.filter(a => a.startsWith(`--${name}=`)).map(a => a.slice(name.length + 3))

const schoolId = value('school')
const termId = value('term')
const subjectFilter = new Set(values('subject'))
const onlyEntered = flag('only-entered')
const projectId = value('project') || process.env.GOOGLE_CLOUD_PROJECT || DEFAULT_PROJECT
const outPath = value('out') || `entered-marks-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`

if (!schoolId) {
  console.error('Missing required --school=<id>')
  process.exit(1)
}

initializeApp({ credential: applicationDefault(), projectId })
const db = getFirestore()

async function main() {
  const base = db.collection('schools').doc(schoolId).collection('smart_sheet_entries')
  const snap = await (termId ? base.where('termId', '==', termId).get() : base.get())

  let sheets = snap.docs
  if (subjectFilter.size) sheets = sheets.filter(d => subjectFilter.has(d.data().subjectId))

  const rows = await Promise.all(sheets.map(async d => {
    const data = d.data()
    const entriesSnap = await d.ref.collection('entries').get()
    return {
      termId: data.termId || '', classId: data.classId || '', subjectId: data.subjectId || '',
      entryCount: entriesSnap.size,
      lastEditedAt: data.lastEditedAt?.toDate?.().toISOString() || '',
      lastEditedBy: data.lastEditedBy || '',
      isFrozen: !!data.isFrozen,
      sheetId: d.id,
    }
  }))

  rows.sort((a, b) => a.termId.localeCompare(b.termId) || a.subjectId.localeCompare(b.subjectId) || a.classId.localeCompare(b.classId))
  const toPrint = onlyEntered ? rows.filter(r => r.entryCount > 0) : rows

  const header = 'termId,classId,subjectId,entryCount,lastEditedAt,lastEditedBy,isFrozen,sheetId\n'
  const body = toPrint.map(r => `${r.termId},${r.classId},${r.subjectId},${r.entryCount},${r.lastEditedAt},"${r.lastEditedBy}",${r.isFrozen},${r.sheetId}`).join('\n')
  writeFileSync(outPath, header + body + '\n')

  const withEntries = rows.filter(r => r.entryCount > 0)
  console.log(`Wrote CSV: ${outPath}`)
  console.log(`${sheets.length} sheet(s) found${termId ? ` for term=${termId}` : ' across all terms'}${subjectFilter.size ? ` (filtered to ${[...subjectFilter].join(', ')})` : ''}.`)
  console.log(`${withEntries.length} sheet(s) have at least one mark entered:`)
  for (const r of withEntries) {
    console.log(`  ${r.termId} / ${r.subjectId} / ${r.classId} — ${r.entryCount} entries, last edited ${r.lastEditedAt || 'unknown'} by ${r.lastEditedBy || 'unknown'}${r.isFrozen ? ' [FROZEN]' : ''}`)
  }
  if (withEntries.length === 0) {
    console.log('No marks entered anywhere in scope — safe to delete and re-upload the assessments CSV for this scope.')
  }
}

main().catch(e => { console.error(e); process.exit(1) })
