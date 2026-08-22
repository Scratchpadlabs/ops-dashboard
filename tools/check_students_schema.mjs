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
check('creating from nothing is reported', fresh.created === true)
check('the defaults are used', fresh.columns.length === STUDENT_SCHEMA_COLUMNS.length, fresh.columns.length)
check('order is 1..n with no gaps',
  fresh.columns.every((c, i) => c.order === i + 1), fresh.columns.map(c => c.order))
check('class options come from the live list, sorted',
  fresh.columns.find(c => c.key === 'currentClassId').options.join(',') === 'III_A,III_B')

// ── Repairing an existing doc ───────────────────────────────────────────────
// Which columns a school HAS is the enrichment flow's decision (it derives them
// from that school's own CSV headers and appends). This must never conform an
// existing schema to a canonical list: the only change it makes is lifting ID.
const stored = [
  { key: 'name', label: 'Student Name', type: 'text', editable: true, order: 1 },
  { key: 'houseColour', label: 'House', type: 'text', editable: true, order: 2 },
  { key: 'id', label: 'Student ID', type: 'text', editable: true, order: 3 },
  { key: 'currentClassId', label: 'Class', type: 'select', editable: true, order: 4, options: ['OLD'] },
]
const repaired = buildStudentsSchemaColumns(stored, CLASSES)
check('a buried ID column is moved to the front', repaired.columns[0].key === 'id')
check('...and that is reported', repaired.movedId === true)
check('a stored label is preserved', repaired.columns[0].label === 'Student ID')
check('a stored editable flag is preserved', repaired.columns[0].editable === true)
check('NO column is invented for an existing schema',
  repaired.columns.length === stored.length, repaired.columns.map(c => c.key))
check("a school's own column survives", repaired.columns.some(c => c.key === 'houseColour'))
check('...keeping its position relative to the others',
  repaired.columns.map(c => c.key).join(',') === 'id,name,houseColour,currentClassId',
  repaired.columns.map(c => c.key))
check('class options are still refreshed',
  repaired.columns.find(c => c.key === 'currentClassId').options.join(',') === 'III_A,III_B')
check('order is renumbered 1..n', repaired.columns.every((c, i) => c.order === i + 1))

// A schema with no ID column at all gets one, at the front.
const noId = buildStudentsSchemaColumns(
  [{ key: 'name', label: 'Name', type: 'text', editable: true, order: 1 }], CLASSES)
check('a missing ID column is added', noId.columns[0].key === 'id' && noId.addedId === true)
check('...and nothing else is added', noId.columns.length === 2, noId.columns.map(c => c.key))

// Idempotent: running it on its own output changes nothing.
const again = buildStudentsSchemaColumns(repaired.columns, CLASSES)
check('re-running reports no move', again.movedId === false && again.addedId === false)
check('...and is byte-identical', JSON.stringify(again.columns) === JSON.stringify(repaired.columns))

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed')
fs.rmSync(TMP, { recursive: true, force: true })
process.exit(failures ? 1 : 0)
