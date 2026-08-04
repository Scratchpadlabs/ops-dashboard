/**
 * Cross-language parity check for the school schema.
 *
 * src/schemas/schoolSchema.js is a HAND-PORT of
 * functions/shared/school_schema.py. Both gate real writes — the browser so a
 * human sees the problem before committing, the Python so commit_import (which
 * writes with the Admin SDK and bypasses Firestore rules) cannot be talked into
 * writing something malformed. Two implementations that must agree is the same
 * drift risk the shared class resolver has, and it gets the same treatment.
 *
 *     python3 tools/check_schema_parity.py   # emits the Python side + verdicts
 *     node    tools/check_schema_parity.mjs  # runs JS, compares, exits 1 on drift
 *
 * Compares the declared SHAPE (collections, fields, required flags, types,
 * enums) and the VERDICT on a shared fixture list, because a shape can match
 * while a cross-field `check` rule quietly disagrees.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RESULTS = path.join(ROOT, 'tools', '.schema_fixtures.json')

if (!fs.existsSync(RESULTS)) {
  console.error('Missing fixtures. Run first:\n  python3 tools/check_schema_parity.py')
  process.exit(2)
}

const { shape: pyShape, verdicts: pyVerdicts } = JSON.parse(fs.readFileSync(RESULTS, 'utf8'))
const { SCHOOL_SCHEMAS, validateDoc } = await import(path.join(ROOT, 'src/schemas/schoolSchema.js'))

let failures = 0
function report(scope, detail, expected, actual) {
  failures++
  console.error(`DRIFT ${scope} — ${detail}\n   python: ${expected}\n   js:     ${actual}`)
}

// ── 1. shape ────────────────────────────────────────────────────────────────
const jsCollections = Object.keys(SCHOOL_SCHEMAS).sort()
const pyCollections = Object.keys(pyShape).sort()
if (jsCollections.join(',') !== pyCollections.join(',')) {
  report('collections', 'set mismatch', pyCollections.join(','), jsCollections.join(','))
}

for (const col of pyCollections) {
  const jsSchema = SCHOOL_SCHEMAS[col]
  if (!jsSchema) continue
  const jsFields = Object.keys(jsSchema.fields).sort()
  const pyFields = Object.keys(pyShape[col]).sort()
  if (jsFields.join(',') !== pyFields.join(',')) {
    report(`${col}.fields`, 'set mismatch', pyFields.join(','), jsFields.join(','))
    continue
  }
  for (const field of pyFields) {
    const py = pyShape[col][field]
    const js = jsSchema.fields[field]
    if (js.type !== py.type) report(`${col}.${field}`, 'type', py.type, js.type)
    if (!!js.required !== !!py.required) report(`${col}.${field}`, 'required', py.required, js.required)
    if (!!js.nullable !== !!py.nullable) report(`${col}.${field}`, 'nullable', py.nullable, js.nullable)
    const jsEnum = (js.enum || []).join('|')
    const pyEnum = (py.enum || []).join('|')
    if (jsEnum !== pyEnum) report(`${col}.${field}`, 'enum', pyEnum, jsEnum)
  }
}

// ── 2. verdicts on shared fixtures ──────────────────────────────────────────
for (const fx of pyVerdicts) {
  const js = validateDoc(fx.collection, reviveDoc(fx.doc), { partial: !!fx.partial })
  if (js.ok !== fx.ok) {
    report('verdict', `${fx.collection}: ${fx.label}`, `ok=${fx.ok}`, `ok=${js.ok}`)
    continue
  }
  // Error FIELDS must agree; wording is allowed to differ between languages.
  const jsFields = js.errors.map(e => e.field).sort().join(',')
  if (jsFields !== fx.error_fields.sort().join(',')) {
    report('verdict fields', `${fx.collection}: ${fx.label}`, fx.error_fields.join(','), jsFields)
  }
}

/** The fixture file is JSON, so timestamps arrive as a tagged marker. */
function reviveDoc(doc) {
  const out = {}
  for (const [k, v] of Object.entries(doc || {})) {
    out[k] = v && typeof v === 'object' && v.__timestamp__ ? new Date(v.__timestamp__) : v
  }
  return out
}

const checked = pyCollections.length + pyVerdicts.length
if (failures) {
  console.error(`\nFAIL — ${failures} mismatch(es).`)
  console.error('school_schema.py and schoolSchema.js have drifted. Fix both, then re-run.')
  process.exit(1)
}
console.log(`OK — ${pyCollections.length} collections and ${pyVerdicts.length} verdicts agree `
  + 'between school_schema.py and schoolSchema.js')
