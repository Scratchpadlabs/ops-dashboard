#!/usr/bin/env node
/**
 * One-off backfill: set students/{id}.gender for The Keystone Ankuram School
 * from the school's own student export (SCHOOL_STUDENT_DATA dataport CSV).
 *
 * The export has TWO "Gender" columns: the first holds Male/Female, the
 * second holds G/B (per the school, G = girl and B = boy). Either column is
 * used when the other is blank. Where the two disagree, the Male/Female
 * column wins — the G/B letter was found to be wrong on those rows — and the
 * row is flagged in the report (note starts with "CONFLICT"). A few of
 * those rows had the Male/Female column wrong instead; the school confirmed
 * them as girls, so GENDER_OVERRIDES pins them by name.
 *
 * Values are written in the canonical form the rest of the app uses
 * (StudentsTab.vue's GENDER_OPTIONS, generate_import's clean_gender):
 * "Female" / "Male".
 *
 * Matching a CSV row to a student doc, in order:
 *   1. admNo   — "Admission No." (e.g. TKA/NU26/001), spaces ignored — only
 *                when that admNo appears once in the CSV: the export reuses
 *                some admission numbers for different children
 *   2. name    — "Student F Name" vs students/{id}.name, case/space-insensitive,
 *                only when exactly one student has that name
 * Anything that doesn't match exactly one student is reported, not guessed.
 *
 * Only empty genders are filled. A student that already has a DIFFERENT
 * gender is reported as SKIP unless --overwrite is passed.
 *
 * The CSV itself is NOT checked in — it holds student PII. Pass its path.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *   # 1. Dry run (default). Touches nothing, writes the review CSV.
 *   node scripts/backfill-keystone-gender.mjs --csv=/path/to/SCHOOL_STUDENT_DATA.csv
 *
 *   # 2. Apply.
 *   node scripts/backfill-keystone-gender.mjs --csv=/path/to/SCHOOL_STUDENT_DATA.csv --commit
 *
 * Flags:
 *   --csv=<path>       the school's export (REQUIRED)
 *   --commit           actually write (without it nothing is written)
 *   --overwrite        also replace a gender that is already set and differs
 *   --school=<id>      default THE_KEYSTONE_ANKURAM_SCHOOL
 *   --out=<path>       report path (default ./keystone-gender-backfill-<stamp>.csv)
 *   --project=<id>     Firestore project (default clarified-1501, or GOOGLE_CLOUD_PROJECT)
 *
 * Auth: application default credentials.
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json node scripts/...
 * or `gcloud auth application-default login` with access to the project.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { initializeApp, applicationDefault } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

const DEFAULT_PROJECT = 'clarified-1501'
const DEFAULT_SCHOOL = 'THE_KEYSTONE_ANKURAM_SCHOOL'
const BATCH_LIMIT = 400

// ── CLI ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const value = (name) => {
  const hit = argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : null
}

const commit = flag('commit')
const overwrite = flag('overwrite')
const csvPath = value('csv')
const schoolId = value('school') || DEFAULT_SCHOOL
const projectId = value('project') || process.env.GOOGLE_CLOUD_PROJECT || DEFAULT_PROJECT
const outPath = value('out') || `keystone-gender-backfill-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`

if (!csvPath) {
  console.error('Missing --csv=<path to the school\'s student export>.')
  process.exit(1)
}

// ── Source CSV ──────────────────────────────────────────────────────────────
function parseCsv(text) {
  const rows = []
  let row = [], field = '', quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++ }
      else if (c === '"') quoted = false
      else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field); rows.push(row); row = []; field = ''
    } else field += c
  }
  if (field || row.length) { row.push(field); rows.push(row) }
  return rows
}

const LETTER_TO_GENDER = { g: 'Female', b: 'Male' }
const WORD_TO_GENDER = { female: 'Female', male: 'Male' }

const normAdmNo = (s) => String(s ?? '').replace(/\s+/g, '').toUpperCase()
const normName = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase()

// Confirmed by the school: the export's Male/Female column is wrong for these.
const GENDER_OVERRIDES = new Map([
  'Tanirika Rohit Nandanwar',
  'Swara Sandeep Shewale',
  'Dnyanada Sudhir Bhadle',
  'Shubhra Vitthal Raut',
  'Anuradha Hanumant Mane',
  'Aaradhya Rama Shewale',
  'Adhishtha Purushottam Waghmare',
].map(name => [normName(name), 'Female']))

function readSource(path) {
  const [header, ...body] = parseCsv(readFileSync(path, 'utf8'))
  const genderCols = header.map((h, i) => (h.trim().toLowerCase() === 'gender' ? i : -1)).filter(i => i >= 0)
  if (genderCols.length !== 2) throw new Error(`expected two "Gender" columns in ${path}, found ${genderCols.length}`)
  const [wordCol, letterCol] = genderCols
  const admCol = header.findIndex(h => h.trim().toLowerCase().startsWith('admission no'))
  const nameCol = header.findIndex(h => h.trim().toLowerCase().startsWith('student f name'))
  const classCol = header.findIndex(h => h.trim().toLowerCase().startsWith('class-section'))
  if (admCol < 0 || nameCol < 0) throw new Error('could not find "Admission No." / "Student F Name" columns')

  const out = []
  body.forEach((r, i) => {
    const name = (r[nameCol] || '').trim()
    if (!name) return // blank spacer rows in the export
    const letter = LETTER_TO_GENDER[(r[letterCol] || '').trim().toLowerCase()] || ''
    const word = WORD_TO_GENDER[(r[wordCol] || '').trim().toLowerCase()] || ''
    const override = GENDER_OVERRIDES.get(normName(name))
    const gender = override || word || letter
    let note = ''
    if (override) note = `OVERRIDE: confirmed ${override} by the school (G/B says ${letter || 'blank'}, Male/Female says ${word || 'blank'})`
    else if (letter && word && letter !== word) note = `CONFLICT: G/B column says ${letter}, Male/Female column says ${word} — used Male/Female`
    else if (!letter && word) note = 'G/B blank — used Male/Female column'
    else if (letter && !word) note = 'Male/Female blank — used G/B column'
    out.push({
      line: i + 2, name, admNo: (r[admCol] || '').trim(), className: (r[classCol] || '').trim(),
      gender, note,
    })
  })
  return out
}

// ── Report ──────────────────────────────────────────────────────────────────
const CSV_COLUMNS = ['line', 'csv_name', 'csv_admNo', 'csv_class', 'docId', 'matched_by', 'action', 'before_gender', 'after_gender', 'note']

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
function indexBy(docs, keyFn) {
  const map = new Map()
  for (const d of docs) {
    const k = keyFn(d)
    if (!k) continue
    if (!map.has(k)) map.set(k, [])
    map.get(k).push(d)
  }
  return map
}

async function buildPlan(db, source) {
  const snap = await db.collection('schools').doc(schoolId).collection('students').get()
  const byAdm = indexBy(snap.docs, d => normAdmNo(d.data().admNo))
  const byName = indexBy(snap.docs, d => normName(d.data().name))
  const claimed = new Map() // docId -> csv line, so two rows never write one doc
  const csvAdmCounts = new Map()
  for (const src of source) {
    const k = normAdmNo(src.admNo)
    if (k) csvAdmCounts.set(k, (csvAdmCounts.get(k) || 0) + 1)
  }

  return source.map(src => {
    const row = {
      line: src.line, csv_name: src.name, csv_admNo: src.admNo, csv_class: src.className,
      docId: '', matched_by: '', action: 'SKIP', before_gender: '', after_gender: src.gender, note: src.note,
    }
    const addNote = (n) => { row.note = [row.note, n].filter(Boolean).join('; ') }

    if (!src.gender) { addNote('no gender in either column'); return row }

    const adm = normAdmNo(src.admNo)
    let hits = csvAdmCounts.get(adm) === 1 ? (byAdm.get(adm) || []) : []
    row.matched_by = 'admNo'
    if (hits.length !== 1) {
      hits = byName.get(normName(src.name)) || []
      row.matched_by = 'name'
    }
    if (hits.length === 0) { row.action = 'NO_MATCH'; row.matched_by = ''; addNote('no student with this admNo or name'); return row }
    if (hits.length > 1) { row.action = 'AMBIGUOUS'; addNote(`${hits.length} students share this ${row.matched_by}`); return row }

    const doc = hits[0]
    row.docId = doc.id
    if (claimed.has(doc.id)) { addNote(`same student already matched by CSV line ${claimed.get(doc.id)}`); return row }
    claimed.set(doc.id, src.line)

    const current = String(doc.data().gender ?? '').trim()
    row.before_gender = current
    if (current === src.gender) { addNote('already set'); return row }
    if (current && !overwrite) { addNote('already set to a different value — pass --overwrite to replace'); return row }
    row.action = 'UPDATE'
    return row
  })
}

async function applyPlan(db, plan) {
  const updates = plan.filter(r => r.action === 'UPDATE')
  for (let i = 0; i < updates.length; i += BATCH_LIMIT) {
    const chunk = updates.slice(i, i + BATCH_LIMIT)
    const batch = db.batch()
    for (const row of chunk) {
      const ref = db.collection('schools').doc(schoolId).collection('students').doc(row.docId)
      batch.update(ref, { gender: row.after_gender, updated_at: new Date(), updated_by: 'scripts/backfill-keystone-gender.mjs' })
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

async function main() {
  const source = readSource(csvPath)

  initializeApp({ credential: applicationDefault(), projectId })
  const db = getFirestore()

  console.log(`Project: ${projectId}`)
  console.log(`Mode:    ${commit ? 'COMMIT' : 'DRY RUN (no writes)'}${overwrite ? ' + OVERWRITE' : ''}`)
  console.log(`School:  ${schoolId}`)
  console.log(`Source:  ${csvPath} (${source.length} student rows)`)
  console.log('')

  const plan = await buildPlan(db, source)
  const tally = () => plan.reduce((acc, r) => ({ ...acc, [r.action]: (acc[r.action] || 0) + 1 }), {})
  const conflicts = plan.filter(r => r.note.startsWith('CONFLICT')).length

  writeReport(plan)
  console.log('Plan: ' + Object.entries(tally()).map(([k, v]) => `${k}=${v}`).join(' '))
  if (conflicts) console.log(`${conflicts} row(s) where the two gender columns disagree — see "CONFLICT" in the report.`)
  console.log(`Report: ${outPath}`)

  if (!commit) {
    console.log('\nDry run — nothing written. Review the CSV, then re-run with --commit.')
    return
  }
  if (!plan.some(r => r.action === 'UPDATE')) {
    console.log('\nNothing to update.')
    return
  }

  console.log('')
  await applyPlan(db, plan)
  writeReport(plan)
  console.log('\nDone: ' + Object.entries(tally()).map(([k, v]) => `${k}=${v}`).join(' '))
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

process.on('unhandledRejection', fail)
main().catch(fail)
