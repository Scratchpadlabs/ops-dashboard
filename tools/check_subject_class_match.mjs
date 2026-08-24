/**
 * Behaviour check for ClassesTeachersTab's subject-to-class matching — the
 * "subject checklist" that fills a class doc's `subjects` array (spec §3.4).
 *
 *     node tools/check_subject_class_match.mjs
 *
 * The case that motivated it: Hillgreen writes subjects in Roman with a stream
 * (`XI Science_Biology`) and classes in Arabic (`clazz: "11"`, section
 * `SCI_A`). String-comparing the two grade tokens matched nothing at all, so
 * every checklist opened empty; matching on the ordinal alone over-matched,
 * offering Humanities subjects to a Science section.
 *
 * Mirrors the component's own helpers rather than importing the .vue, so keep
 * the two in sync — these cases are what catch a drift.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'subjmatch-'))
fs.writeFileSync(path.join(TMP, 'seed.json'),
  fs.readFileSync(path.join(ROOT, 'functions/generate_import/education_kb.json'), 'utf8'))
let src = fs.readFileSync(path.join(ROOT, 'src/utils/classResolver.js'), 'utf8')
src = src.replace(/import SEED from ['"][^'"]+['"]/,
  `import fs from 'node:fs'\nconst SEED = JSON.parse(fs.readFileSync('${path.join(TMP, 'seed.json')}','utf8'))`)
fs.writeFileSync(path.join(TMP, 'classResolver.js'), src)
const { parseClassValue } = await import(path.join(TMP, 'classResolver.js'))

// ── Mirrors ClassesTeachersTab.vue ────────────────────────────────────────
const parseGrade = id => (id || '').split('_')[0] || '?'
const STREAM_MIN_LENGTH = 3
function streamsAgree(subjectStream, cls) {
  if (!subjectStream) return true
  const norm = v => (v || '').toString().toLowerCase().replace(/[^a-z]/g, '')
  const want = norm(subjectStream)
  if (!want) return true
  return (cls.section || '').split(/[^a-zA-Z]+/).some(token => {
    const got = norm(token)
    if (got.length < STREAM_MIN_LENGTH) return false
    return want.startsWith(got) || got.startsWith(want)
  })
}
function subjectBelongsToClass(subject, cls) {
  const sg = parseClassValue(parseGrade(subject.id))
  if (sg.gradeOrdinal === null) return false
  const cg = parseClassValue(cls.clazz)
  if (cg.gradeOrdinal === null) return false
  if (sg.gradeOrdinal !== cg.gradeOrdinal) return false
  return streamsAgree(sg.section, cls)
}

// ── Hillgreen's real shapes ───────────────────────────────────────────────
const SUBJECTS = [
  'X_Biology', 'X_Maths', 'X_Seva',
  'XI Science_Biology', 'XI Science_Physics', 'XI Science_HPE',
  'XI Humanities_Economics', 'XI Humanities_Sociology',
  'XII Commerce_Accounts', 'XII Science_Physics',
].map(id => ({ id }))

const pick = cls => SUBJECTS.filter(s => subjectBelongsToClass(s, cls)).map(s => s.id)

let failures = 0
const check = (label, actual, expected) => {
  const a = JSON.stringify([...actual].sort()), e = JSON.stringify([...expected].sort())
  if (a === e) console.log(`  ok   ${label}`)
  else { failures++; console.log(`  FAIL ${label}\n         got ${a}\n    expected ${e}`) }
}

console.log('\nRoman subjects vs Arabic classes — the case that matched nothing\n')
check('10_KALAM gets every grade-10 subject',
  pick({ clazz: '10', section: 'KALAM' }), ['X_Biology', 'X_Maths', 'X_Seva'])
check('1_ASHOKA gets none of them',
  pick({ clazz: '1', section: 'ASHOKA' }), [])

console.log('\nStreams — same ordinal, different course\n')
check('11_SCI_A gets Science, not Humanities',
  pick({ clazz: '11', section: 'SCI_A' }),
  ['XI Science_Biology', 'XI Science_Physics', 'XI Science_HPE'])
check('11_COM_C gets neither stream of grade 11',
  pick({ clazz: '11', section: 'COM_C' }), [])
check('12_COM_C gets Commerce only',
  pick({ clazz: '12', section: 'COM_C' }), ['XII Commerce_Accounts'])
check('12_SCI_A gets Science only',
  pick({ clazz: '12', section: 'SCI_A' }), ['XII Science_Physics'])

console.log('\nA section naming no stream is not guessed at\n')
check('11_D gets nothing rather than both streams',
  pick({ clazz: '11', section: 'D' }), [])

console.log('\nA one/two-letter section never matches a stream by accident\n')
check('11_S does not match Science',
  pick({ clazz: '11', section: 'S' }), [])

console.log('\nSame notation on both sides still works (SAMARTH)\n')
check('III_A gets its Roman-graded subjects',
  [{ id: 'III_English' }, { id: 'IV_English' }]
    .filter(s => subjectBelongsToClass(s, { clazz: 'III', section: 'A' })).map(s => s.id),
  ['III_English'])

console.log(failures ? `\n${failures} failure(s)` : '\nAll cases pass.')
process.exit(failures ? 1 : 0)
