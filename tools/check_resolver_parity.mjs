/**
 * Cross-language parity check for the class resolver.
 *
 * src/utils/classResolver.js is a HAND-PORT of
 * functions/shared/class_resolver.py. Two implementations that must agree is
 * the exact drift risk the shared-resolver work exists to remove, so this
 * runs both over the same fixture list and fails on any disagreement.
 *
 *     python3 tools/check_resolver_parity.py   # emits fixtures + Python results
 *     node    tools/check_resolver_parity.mjs  # runs JS, compares, exits 1 on drift
 *
 * The JS module is loaded from its REAL source; only the JSON import line is
 * rewritten, because Vite resolves bare `import x from './y.json'` and plain
 * Node does not. Nothing else is touched, so what runs here is what ships.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RESULTS = path.join(ROOT, 'tools', '.resolver_fixtures.json')

if (!fs.existsSync(RESULTS)) {
  console.error('Missing fixtures. Run first:\n  python3 tools/check_resolver_parity.py')
  process.exit(2)
}

// Load the real module with only the JSON import substituted.
const src = fs.readFileSync(path.join(ROOT, 'src/utils/classResolver.js'), 'utf8')
const seed = fs.readFileSync(path.join(ROOT, 'functions/shared/education_kb.json'), 'utf8')
const patched = src.replace(/^import SEED from .*$/m, `const SEED = ${seed};`)
if (patched === src) {
  console.error('Could not find the SEED import line — parity harness needs updating.')
  process.exit(2)
}

const tmp = path.join(os.tmpdir(), `classResolver.parity.${process.pid}.mjs`)
fs.writeFileSync(tmp, patched)

let mod
try {
  mod = await import(`file://${tmp}`)
} finally {
  fs.unlinkSync(tmp)
}

const { parseClassValue, notationOf, ordinalToToken, classIdKey } = mod
const fixtures = JSON.parse(fs.readFileSync(RESULTS, 'utf8'))

let failures = 0
const report = (what, raw, field, py, js) => {
  failures++
  console.error(`  MISMATCH ${what}  ${JSON.stringify(raw)}  ${field}: python=${JSON.stringify(py)} js=${JSON.stringify(js)}`)
}

for (const row of fixtures.parse) {
  const js = parseClassValue(row.raw)
  if (js.gradeOrdinal !== row.grade_ordinal) report('parse', row.raw, 'gradeOrdinal', row.grade_ordinal, js.gradeOrdinal)
  if ((js.section || '') !== (row.section || '')) report('parse', row.raw, 'section', row.section, js.section)
  if ((js.gradeCanonical ?? null) !== (row.grade_canonical ?? null)) {
    report('parse', row.raw, 'gradeCanonical', row.grade_canonical, js.gradeCanonical)
  }
  if (js.confidence !== row.confidence) report('parse', row.raw, 'confidence', row.confidence, js.confidence)
}

for (const row of fixtures.notation) {
  const js = notationOf(row.class_ids)
  if (js !== row.notation) report('notation', row.class_ids.join(','), 'notation', row.notation, js)
}

for (const row of fixtures.ordinal_to_token) {
  const js = ordinalToToken(row.ordinal, row.notation)
  if ((js ?? null) !== (row.token ?? null)) {
    report('ordinalToToken', `${row.ordinal}/${row.notation}`, 'token', row.token, js)
  }
}

for (const row of fixtures.class_id_key) {
  const js = classIdKey(row.raw)
  if (js !== row.key) report('classIdKey', row.raw, 'key', row.key, js)
}

const total = fixtures.parse.length + fixtures.notation.length
  + fixtures.ordinal_to_token.length + fixtures.class_id_key.length
if (failures) {
  console.error(`\nFAIL — ${failures} mismatch(es) across ${total} fixtures.`)
  console.error('The Python and JS resolvers have drifted. Fix both, then re-run.')
  process.exit(1)
}
console.log(`OK — ${total} fixtures agree between class_resolver.py and classResolver.js`)
