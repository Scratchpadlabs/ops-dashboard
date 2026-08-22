/**
 * Behaviour check for buildStudentsSchemaColumns in
 * src/utils/schoolSetupHelpers.js — the layout of config/students_schema.
 *
 *     node tools/check_students_schema.mjs
 *
 * Rule 1 is the one that made the app unusable and is pinned first: ID is
 * always the first column. Rule 2 is that a column exists for every field an
 * import writes, so imported data is visible rather than sitting unreferenced
 * on the student document.
 *
 * Loads the real module with only the Firebase imports stubbed — those pull in
 * the browser SDK, and the function under test is pure.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'students-schema-'))

let src = fs.readFileSync(path.join(ROOT, 'src/utils/schoolSetupHelpers.js'), 'utf8')
src = src.replace(/^import .*$/gm, '')
  .replace(/\bgetDoc\b|\bsetDoc\b|\bupdateDoc\b|\bserverTimestamp\b|\bschoolDoc\b|\bauth\b/g, 'undefined')
fs.writeFileSync(path.join(TMP, 'helpers.js'), src)

const { buildStudentsSchemaColumns, STUDENT_SCHEMA_COLUMNS } = await import(path.join(TMP, 'helpers.js'))

let failures = 0
const check = (label, cond, extra) => {
  if (cond) console.log(`  ok   ${label}`)
  else { failures++; console.log(`  FAIL ${label}`, extra !== undefined ? JSON.stringify(extra) : '') }
}

const CLASSES = ['III_B', 'III_A']

// ── From nothing (a wizard-created school has no schema doc at all) ─────────
const fresh = buildStudentsSchemaColumns([], CLASSES)
check('ID is the first column', fresh.columns[0].key === 'id', fresh.columns[0])
check('ID is not editable', fresh.columns[0].editable === false)
check('every preset column is present', fresh.columns.length === STUDENT_SCHEMA_COLUMNS.length, fresh.columns.length)
check('order is 1..n with no gaps',
  fresh.columns.every((c, i) => c.order === i + 1), fresh.columns.map(c => c.order))
check('class options come from the live list, sorted',
  fresh.columns.find(c => c.key === 'currentClassId').options.join(',') === 'III_A,III_B')
check('every added column is reported', fresh.added.length === fresh.columns.length)

// Columns an import writes must have somewhere to show up.
for (const key of ['rollNo', 'srNo', 'fatherName', 'motherMobile', 'dateOfAdmission', 'admNo']) {
  check(`"${key}" has a column`, fresh.columns.some(c => c.key === key))
}

// ── Repairing an existing doc ───────────────────────────────────────────────
// A human's label/type/editable choices are theirs; only order is normalized.
const stored = [
  { key: 'name', label: 'Student Name', type: 'text', editable: true, order: 1 },
  { key: 'id', label: 'Student ID', type: 'text', editable: true, order: 2 },
]
const repaired = buildStudentsSchemaColumns(stored, CLASSES)
check('a buried ID column is moved to the front', repaired.columns[0].key === 'id')
check('a stored label is preserved', repaired.columns[0].label === 'Student ID')
check('a stored editable flag is preserved', repaired.columns[0].editable === true)
check('the reorder is reported', repaired.reordered === true)
check('missing columns are reported as added', repaired.added.includes('rollNo'))
check('a preserved column is not reported as added', !repaired.added.includes('name'))

// A column the school added by hand survives, after the known ones.
const custom = buildStudentsSchemaColumns(
  [{ key: 'houseColour', label: 'House', type: 'text', editable: true, order: 1 }], CLASSES)
check('an unknown school-added column survives', custom.columns.some(c => c.key === 'houseColour'))
check('...and lands after the known columns',
  custom.columns[custom.columns.length - 1].key === 'houseColour', custom.columns.map(c => c.key))

// Idempotent: running it on its own output changes nothing.
const again = buildStudentsSchemaColumns(fresh.columns, CLASSES)
check('rebuilding an already-correct doc adds nothing', again.added.length === 0)
check('...and reports no reorder', again.reordered === false)
check('...and is byte-identical', JSON.stringify(again.columns) === JSON.stringify(fresh.columns))

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed')
fs.rmSync(TMP, { recursive: true, force: true })
process.exit(failures ? 1 : 0)
