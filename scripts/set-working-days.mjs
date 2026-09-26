#!/usr/bin/env node
/**
 * Set the attendance working days for every month of every class in a school.
 *
 * The teacher app's Attendance sheet reads its month columns (and each
 * month's working days) from schools/{schoolId}/classes/{classId}/months —
 * per class, not the school-level schools/{schoolId}/months the Months tab
 * edits. So this writes both:
 *
 *   schools/{schoolId}/months/{YYYY-MM}                    (Months tab)
 *   schools/{schoolId}/classes/{classId}/months/{YYYY-MM}  (teacher app)
 *
 * Which months: the school-level months if the school has any; otherwise an
 * academic year generated from --start/--span, the same way the Months tab's
 * "Generate Academic Year" does (default June, 12 months). Each class gets
 * those months, plus any month it already has of its own. Existing docs are
 * merged: only `workingDays` (and updated_at/by) changes on them.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *   # Dry run (default). Prints what would change, writes nothing.
 *   node scripts/set-working-days.mjs --school=shardakalamb --days=22
 *
 *   # Apply.
 *   node scripts/set-working-days.mjs --school=shardakalamb --days=22 --commit
 *
 * Flags:
 *   --school=<id>      school doc id (required)
 *   --days=<n>         working days per month, 0-31 (required)
 *   --start=<YYYY-MM>  first month when the school has no months (default <this year>-06)
 *   --span=<n>         number of months to generate in that case (default 12)
 *   --commit           actually write
 *   --project=<id>     Firestore project (default clarified-1501, or GOOGLE_CLOUD_PROJECT)
 *
 * Auth: application default credentials.
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json node scripts/...
 * or `gcloud auth application-default login` with access to the project.
 */
import { initializeApp, applicationDefault } from 'firebase-admin/app'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'

const DEFAULT_PROJECT = 'clarified-1501'
const BATCH_LIMIT = 400
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December']
const ACTOR = 'script:set-working-days'

// ── CLI ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const value = (name) => {
  const hit = argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : null
}

const commit = flag('commit')
const schoolId = value('school')
const days = Number(value('days'))
const start = value('start') || `${new Date().getFullYear()}-06`
const span = Number(value('span') || 12)
const project = value('project') || process.env.GOOGLE_CLOUD_PROJECT || DEFAULT_PROJECT

function die(msg) { console.error(msg); process.exit(1) }
if (!schoolId) die('--school=<id> is required')
if (!Number.isInteger(days) || days < 0 || days > 31) die('--days must be a whole number 0-31')
if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(start)) die('--start must look like 2026-06')
if (!Number.isInteger(span) || span < 1 || span > 24) die('--span must be 1-24')

initializeApp({ credential: applicationDefault(), projectId: project })
const db = getFirestore()

// ── Months ──────────────────────────────────────────────────────────────────
function generateMonths() {
  const [y0, m0] = start.split('-').map(Number)
  return Array.from({ length: span }, (_, i) => {
    const month = ((m0 - 1 + i) % 12) + 1
    const year = y0 + Math.floor((m0 - 1 + i) / 12)
    const key = `${year}-${String(month).padStart(2, '0')}`
    return { key, label: `${MONTH_NAMES[month - 1]} ${year}`, month, year, order: i + 1 }
  })
}

// Only the fields that define a month; timestamps and workingDays are set below.
const monthShape = (id, d) => ({
  key: d.key || id, label: d.label, month: d.month, year: d.year, order: d.order,
})

const schoolRef = db.collection('schools').doc(schoolId)
const schoolSnap = await schoolRef.get()
if (!schoolSnap.exists) die(`schools/${schoolId} does not exist in ${project}`)

const schoolMonthsSnap = await schoolRef.collection('months').get()
const schoolMonths = schoolMonthsSnap.empty
  ? generateMonths()
  : schoolMonthsSnap.docs.map(d => monthShape(d.id, d.data()))
schoolMonths.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
console.log(schoolMonthsSnap.empty
  ? `School has no months; generating ${span} from ${start}.`
  : `School has ${schoolMonths.length} month(s).`)
console.log(`Months: ${schoolMonths.map(m => m.key).join(', ')}`)

// ── Plan writes ─────────────────────────────────────────────────────────────
const writes = [] // { ref, data, isNew, where }
const existingSchool = new Map(schoolMonthsSnap.docs.map(d => [d.id, d.data()]))
for (const m of schoolMonths) {
  const old = existingSchool.get(m.key)
  writes.push({ ref: schoolRef.collection('months').doc(m.key), month: m, old, where: 'school' })
}

const classesSnap = await schoolRef.collection('classes').get()
if (classesSnap.empty) die(`schools/${schoolId}/classes is empty`)
for (const cls of classesSnap.docs) {
  const own = await cls.ref.collection('months').get()
  const existing = new Map(own.docs.map(d => [d.id, d.data()]))
  const keys = new Set(schoolMonths.map(m => m.key))
  const months = [...schoolMonths, ...own.docs.filter(d => !keys.has(d.id)).map(d => monthShape(d.id, d.data()))]
  for (const m of months) {
    writes.push({ ref: cls.ref.collection('months').doc(m.key), month: m, old: existing.get(m.key), where: cls.id })
  }
}

let created = 0, changed = 0, unchanged = 0
for (const w of writes) {
  if (!w.old) created++
  else if (w.old.workingDays !== days) changed++
  else unchanged++
}
console.log(`\n${classesSnap.size} class(es). Month docs: ${created} to create, ${changed} to change, ${unchanged} already at ${days}.`)
for (const w of writes) {
  if (w.old && w.old.workingDays === days) continue
  console.log(`  ${w.where.padEnd(28)} ${w.month.key}  ${w.old ? `${w.old.workingDays ?? '(none)'} -> ${days}` : `new, ${days}`}`)
}

if (!commit) {
  console.log('\nDry run: nothing written. Re-run with --commit to apply.')
  process.exit(0)
}

// ── Apply ───────────────────────────────────────────────────────────────────
const todo = writes.filter(w => !w.old || w.old.workingDays !== days)
for (let i = 0; i < todo.length; i += BATCH_LIMIT) {
  const batch = db.batch()
  for (const w of todo.slice(i, i + BATCH_LIMIT)) {
    const data = { workingDays: days, updated_at: FieldValue.serverTimestamp(), updated_by: ACTOR }
    if (!w.old) Object.assign(data, w.month, { created_at: FieldValue.serverTimestamp(), created_by: ACTOR })
    batch.set(w.ref, data, { merge: true })
  }
  await batch.commit()
}
console.log(`\nDone: ${todo.length} month doc(s) written.`)
