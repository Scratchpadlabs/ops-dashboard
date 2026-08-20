/**
 * Behaviour check for src/utils/classLookup.js — how an import row finds the
 * class School Setup holds.
 *
 *     node tools/check_class_lookup.mjs
 *
 * The case that matters: a school's export can carry the class as one complete
 * id ("Play_Group_A", "8_KALAM") instead of a Class + Section pair. Hillgreen's
 * 2026-27 export does exactly that, and because STUDENT_HEADER_ALIASES maps
 * "class" onto grade, every one of its 1621 rows was rejected. The equally
 * important half is the other direction: the two-column files that worked
 * before must resolve by the SAME key they always did.
 *
 * Loads the REAL modules with only the JSON import line rewritten (Vite
 * resolves bare JSON imports, plain Node does not) — same trick as
 * tools/check_derive_classes.mjs, so what runs here is what ships.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'classlookup-'))

const seed = fs.readFileSync(path.join(ROOT, 'functions/shared/education_kb.json'), 'utf8')
fs.writeFileSync(path.join(TMP, 'seed.json'), seed)
const inlineSeed = (src) => src.replace(/import SEED from ['"][^'"]+['"]/,
  `import fs from 'node:fs'\nconst SEED = JSON.parse(fs.readFileSync('${path.join(TMP, 'seed.json')}','utf8'))`)
const inlineKb = (src) => src.replace(/import KB from ['"][^'"]+['"]/,
  `import fs from 'node:fs'\nconst KB = JSON.parse(fs.readFileSync('${path.join(TMP, 'seed.json')}','utf8'))`)

for (const [name, tweak] of [
  ['classResolver.js', inlineSeed],
  ['educationKB.js', (s) => inlineKb(inlineSeed(s))],
  ['classLookup.js', (s) => s],
]) {
  fs.writeFileSync(path.join(TMP, name), tweak(fs.readFileSync(path.join(ROOT, 'src/utils', name), 'utf8')))
}

const { buildClassLookup, resolveClassId, describeClassMiss, classIdKey } =
  await import(path.join(TMP, 'classLookup.js'))

let failures = 0
const check = (label, cond, extra) => {
  if (cond) console.log(`  ok   ${label}`)
  else { failures++; console.log(`  FAIL ${label}`, extra ?? '') }
}

// A Hillgreen-shaped school: pre-primary sections, numeric grades with named
// sections, and one class whose section carries a board token.
const lookup = buildClassLookup([
  { id: 'Play_Group_A', clazz: 'Play Group', section: 'A' },
  { id: 'Nursery_A', clazz: 'Nursery', section: 'A' },
  { id: '8_KALAM', clazz: '8', section: 'KALAM' },
  { id: '8_RAMAN', clazz: '8', section: 'RAMAN' },
  { id: 'III_A', clazz: 'III', section: 'A' },
  { id: 'SCI_A', clazz: 'XI', section: 'SCI' },
])

console.log('\nTwo-column files — unchanged behaviour')
check('grade + section still resolves', resolveClassId(lookup, '8', 'KALAM') === '8_KALAM')
check('roman grade resolves', resolveClassId(lookup, 'III', 'A') === 'III_A')
check('numeric grade folds onto roman class', resolveClassId(lookup, '3', 'A') === 'III_A')
check('lowercase section folds', resolveClassId(lookup, '8', 'kalam') === '8_KALAM')
check('board token stripped from section', resolveClassId(lookup, 'XI', 'SCI_CBSE') === 'SCI_A')
check('sectionless pre-primary resolves', resolveClassId(lookup, 'Play Group', 'A') === 'Play_Group_A')

console.log('\nOne-column files — the Hillgreen 2026-27 export')
check('whole class id in the Class cell', resolveClassId(lookup, '8_KALAM', '') === '8_KALAM')
check('pre-primary whole id', resolveClassId(lookup, 'Play_Group_A', '') === 'Play_Group_A')
check('spaces instead of underscores', resolveClassId(lookup, 'play group a', '') === 'Play_Group_A')
check('hyphenated id', resolveClassId(lookup, '8-KALAM', '') === '8_KALAM')
check('grade cell + separate section spelling a doc id',
  resolveClassId(lookup, 'Play_Group', 'A') === 'Play_Group_A')

console.log('\nStill misses when it should')
check('unconfigured id misses', resolveClassId(lookup, '9_TAGORE', '') === null)
check('unconfigured section misses', resolveClassId(lookup, '8', 'BOSE') === null)
check('blank misses', resolveClassId(lookup, '', '') === null)
check('a whole id never outranks an exact grade+section match',
  resolveClassId(lookup, '8', 'RAMAN') === '8_RAMAN')

console.log('\nWhat the operator is told')
const miss = describeClassMiss(lookup, '9_TAGORE', '')
check('names the id it tried', miss.includes('No class document is named "9_TAGORE"'), miss)
const empty = describeClassMiss(buildClassLookup([]), '8_KALAM', '')
check('empty school says so', empty.includes('no classes configured at all'), empty)
const sameGrade = describeClassMiss(lookup, '8', 'BOSE')
check('lists the sections that grade does have', sameGrade.includes('KALAM'), sameGrade)

console.log('\nKey normalisation')
check('trims and folds separators', classIdKey('  Play-Group.A  ') === 'play_group_a')
check('empty stays empty', classIdKey(null) === '')

fs.rmSync(TMP, { recursive: true, force: true })
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed')
process.exit(failures ? 1 : 0)
