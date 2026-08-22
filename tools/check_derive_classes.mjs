/**
 * Behaviour check for src/utils/deriveClasses.js — the New School wizard's
 * "From a student file" route.
 *
 * The route exists for a school with NO classes, so every case here runs with
 * zero Firestore state. Pre-primary with a blank section column is the case
 * that used to vanish entirely (structureInference drops sectionless grades).
 *
 *     node tools/check_derive_classes.mjs
 *
 * Loads the REAL modules with only the JSON import line rewritten (Vite
 * resolves bare JSON imports, plain Node does not) — same trick as
 * tools/check_resolver_parity.mjs, so what runs here is what ships.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'derive-'))
fs.mkdirSync(TMP, { recursive: true })

const seed = fs.readFileSync(path.join(ROOT, 'functions/shared/education_kb.json'), 'utf8')
fs.writeFileSync(path.join(TMP, 'seed.json'), seed)

let cr = fs.readFileSync(path.join(ROOT, 'src/utils/classResolver.js'), 'utf8')
cr = cr.replace(/import SEED from ['"][^'"]+['"]/,
  `import fs from 'node:fs'\nconst SEED = JSON.parse(fs.readFileSync('${path.join(TMP, 'seed.json')}','utf8'))`)
fs.writeFileSync(path.join(TMP, 'classResolver.js'), cr)
fs.writeFileSync(path.join(TMP, 'deriveClasses.js'),
  fs.readFileSync(path.join(ROOT, 'src/utils/deriveClasses.js'), 'utf8'))

const { deriveClassStructure } = await import(path.join(TMP, 'deriveClasses.js'))

let failures = 0
const check = (label, cond, extra) => {
  if (cond) console.log(`  ok   ${label}`)
  else { failures++; console.log(`  FAIL ${label}`, extra ?? '') }
}

// ── Hillgreen-shaped roster ────────────────────────────────────────────────
// Pre-primary with NO section column filled (the case structureInference
// dropped outright), plus 1-12 with sections, plus the messy variants a real
// export carries.
const rows = []
const add = (grade, section, n = 1) => {
  for (let i = 0; i < n; i++) rows.push({ grade, section, student_name: `S${rows.length}` })
}
add('Nursery', '', 18)
add('LKG', '', 22)
add('UKG', '', 20)
for (let g = 1; g <= 12; g++) { add(String(g), 'A', 30); add(String(g), 'B', 28) }
// Real-world noise
add('1', 'a', 5)            // lowercase section -> folds into 1_A
add(' 2 ', 'B', 3)          // padded grade
add('', '', 4)              // no grade at all -> counted, not proposed

const out = deriveClassStructure(rows)
const ids = out.classes.map(c => c.docId)

console.log('\n=== derived classes ===')
console.log(ids.join('  '))
console.log(`\ngrades: ${out.grades.join(', ')}`)
console.log(`rowsScanned=${out.rowsScanned} rowsWithoutGrade=${out.rowsWithoutGrade}`)

console.log('\n=== assertions ===')
check('works with ZERO existing classes (no Firestore input at all)', ids.length > 0)

for (const g of ['Nursery', 'LKG', 'UKG']) {
  check(`${g} proposed despite blank section column`,
    ids.some(id => id.startsWith(`${g}_`)), ids)
}
check('pre-primary sections marked as assumed, not read',
  out.classes.filter(c => ['Nursery', 'LKG', 'UKG'].includes(c.grade)).every(c => c.sectionInferred))

for (let g = 1; g <= 12; g++) {
  const roman = ['I','II','III','IV','V','VI','VII','VIII','IX','X','XI','XII'][g - 1]
  const found = ids.some(id => id === `${g}_A` || id === `${roman}_A`)
  check(`grade ${g} section A proposed`, found, ids)
}

// ── the real-file shapes: "Grade VI" prefix, board tokens, streams ─────────
const real = deriveClassStructure([
  { Class: 'Grade VI', Section: 'EINSTEIN' },
  { Class: 'Grade XI Science', Section: 'SCI_CBSE_A' },
  { Class: 'Grade XII Commerce', Section: 'COM_CBSE_C' },
  { Class: 'Play Group', Section: 'A' },
])
const realIds = real.classes.map(c => c.docId)
check('"Grade VI" -> VI_EINSTEIN, prefix stripped', realIds.includes('VI_EINSTEIN'), realIds)
check('stream kept in the ID', realIds.includes('XI_Science_SCI_A'), realIds)
check('board token stripped from the section', !realIds.some(id => /CBSE/i.test(id)), realIds)
check('no whitespace in any ID', !realIds.some(id => /\s/.test(id)), realIds)
check('grade order correct (Play Group first)', real.classes[0].grade === 'Play Group', realIds)

check('lowercase section folds into the same class',
  out.classes.filter(c => c.section === 'A' && (c.grade === '1' || c.grade === 'I')).length === 1)
check('padded grade does not create a duplicate',
  new Set(ids).size === ids.length, ids)
check('rows with no grade are counted, not proposed', out.rowsWithoutGrade === 4)
check('student counts carried through',
  out.classes.find(c => c.grade === 'Nursery')?.studentCount === 18,
  out.classes.find(c => c.grade === 'Nursery'))
check('pre-primary sorts before grade 1',
  out.classes[0].grade === 'Nursery', out.classes.slice(0, 3))

// ── the specific regression: grade seen both with AND without a section ────
const mixed = deriveClassStructure([
  { grade: 'Nursery', section: '' }, { grade: 'Nursery', section: '' },
  { grade: 'Nursery', section: 'B' },
])
check('blank-section rows fold into a real section, no invented Nursery_A',
  mixed.classes.map(c => c.docId).join(',') === 'Nursery_B',
  mixed.classes.map(c => c.docId))

// ── alternate column names ─────────────────────────────────────────────────
const alt = deriveClassStructure([{ Class: 'III', Section: 'C' }, { std: 'IV', div: 'D' }])
check('alternate column names (Class/Section, std/div) are read',
  alt.classes.map(c => c.docId).sort().join(',') === 'III_C,IV_D',
  alt.classes.map(c => c.docId))

check('empty input is handled', deriveClassStructure([]).classes.length === 0)

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed')
process.exit(failures ? 1 : 0)

fs.rmSync(TMP, { recursive: true, force: true })
