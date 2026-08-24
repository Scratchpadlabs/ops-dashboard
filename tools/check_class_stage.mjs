/**
 * Behaviour check for src/utils/classStage.js and the grade parsing the class
 * stage migration relies on.
 *
 *     node tools/check_class_stage.mjs
 *
 * Every class-creation path used to hardcode `stage: 'foundation'`, so a
 * grade 10 section shipped as foundational. These are the cases that catch a
 * drift in the NEP mapping, and the pre-primary/unreadable ends that must NOT
 * be guessed at.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stageForGrade } from '../src/utils/classStage.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-'))
fs.writeFileSync(path.join(TMP, 'seed.json'),
  fs.readFileSync(path.join(ROOT, 'functions/generate_import/education_kb.json'), 'utf8'))
fs.writeFileSync(path.join(TMP, 'classResolver.js'),
  fs.readFileSync(path.join(ROOT, 'src/utils/classResolver.js'), 'utf8')
    .replace(/import SEED from ['"][^'"]+['"]/,
      `import fs from 'node:fs'\nconst SEED = JSON.parse(fs.readFileSync('${path.join(TMP, 'seed.json')}','utf8'))`))
const { parseClassValue } = await import(path.join(TMP, 'classResolver.js'))

let failures = 0
const check = (label, actual, expected) => {
  if (actual === expected) console.log(`  ok   ${label}`)
  else { failures++; console.log(`  FAIL ${label} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`) }
}
// What the migration does: doc's clazz (or the ID prefix) -> ordinal -> stage.
const stageOf = clazz => stageForGrade(parseClassValue(clazz).gradeOrdinal)

console.log('\nNEP boundaries\n')
check('grade 2 is the last foundational', stageForGrade(2), 'foundation')
check('grade 3 starts preparatory', stageForGrade(3), 'prepratory')
check('grade 5 is the last preparatory', stageForGrade(5), 'prepratory')
check('grade 6 starts middle', stageForGrade(6), 'middle')
check('grade 8 is the last middle', stageForGrade(8), 'middle')
check('grade 9 starts secondary', stageForGrade(9), 'secondary')
check('grade 12 is the last secondary', stageForGrade(12), 'secondary')

console.log('\nPre-primary is foundational, not unknown\n')
check('Pre-Nursery', stageOf('Pre-Nursery'), 'foundation')
check('Nursery', stageOf('Nursery'), 'foundation')
check('LKG', stageOf('LKG'), 'foundation')
check('UKG', stageOf('UKG'), 'foundation')

console.log('\nHillgreen writes classes in Arabic, SAMARTH in Roman\n')
check('10_KALAM -> clazz "10"', stageOf('10'), 'secondary')
check('11_SCI_A -> clazz "11"', stageOf('11'), 'secondary')
check('1_ASHOKA -> clazz "1"', stageOf('1'), 'foundation')
check('III_A -> clazz "III"', stageOf('III'), 'prepratory')
check('VIII_A -> clazz "VIII"', stageOf('VIII'), 'middle')

console.log('\nAn unreadable grade is never given a stage\n')
check('nonsense', stageOf('Sample Class II'), null)
check('empty', stageOf(''), null)
check('out of range', stageForGrade(13), null)
check('not a number', stageForGrade(null), null)

console.log(failures ? `\n${failures} failure(s)` : '\nAll cases pass.')
process.exit(failures ? 1 : 0)
