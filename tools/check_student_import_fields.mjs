/**
 * Behaviour check for the register-then-enrich import: the school's own extra
 * columns becoming student fields, the students_schema columns they imply,
 * and the rule that a blank cell never erases a registered student's value.
 *
 *     node tools/check_student_import_fields.mjs
 *
 * These three are the difference between an import that fills in the students
 * ops registered and one that quietly wipes the email addresses their auth
 * accounts were created with. Hillgreen's export has an empty Email column on
 * all 1622 rows.
 *
 * Pure modules, loaded as they ship — no Firestore, no Vue.
 */
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { extraFieldsFor, newSchemaColumnsFor } =
  await import(path.join(ROOT, 'src/utils/studentEnrichment.js'))
const { dropBlankOptionalFields, REQUIRED_STUDENT_KEYS } =
  await import(path.join(ROOT, 'src/schemas/studentMapping.js'))

let failures = 0
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) console.log(`  ok   ${label}`)
  else { failures++; console.log(`  FAIL ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`) }
}
const check = (label, cond, extra) => {
  if (cond) console.log(`  ok   ${label}`)
  else { failures++; console.log(`  FAIL ${label}`, extra ?? '') }
}

console.log('\nExtra columns become student fields')
eq('headers camelCase', extraFieldsFor({ 'House': 'Tagore', 'Bus Route': 'Route 4' }),
   { house: 'Tagore', busRoute: 'Route 4' })
eq('blank values are skipped', extraFieldsFor({ House: '', 'Bus Route': '   ' }), {})
eq('values are trimmed', extraFieldsFor({ House: '  Tagore  ' }), { house: 'Tagore' })
eq('nothing in, nothing out', extraFieldsFor(undefined), {})

console.log('\nGolden rule 3, enforced again on the way out')
eq('caste is dropped', extraFieldsFor({ Caste: 'OBC', House: 'Tagore' }), { house: 'Tagore' })
eq('religion is dropped', extraFieldsFor({ Religion: 'Hindu' }), {})
eq('sssm id is dropped', extraFieldsFor({ 'SSSM ID': '12345' }), {})
eq('category is allowed (2026-08-20 decision)',
   extraFieldsFor({ Category: 'Day Scholar' }), { category: 'Day Scholar' })

console.log('\nA blank cell never erases a registered value')
const payload = {
  name: 'Raj Ayush', firstName: 'Raj', lastName: '', currentClassId: '12_COM_C',
  type: 'student', email: '', phoneNo: null, gender: 'Boy', dateOfBirth: null,
  admNo: '2580', grEmisSts: '', aadhaarNumber: '',
}
const kept = dropBlankOptionalFields(payload)
check('empty email is dropped, not written', !('email' in kept))
check('null phoneNo is dropped', !('phoneNo' in kept))
check('null dateOfBirth is dropped', !('dateOfBirth' in kept))
check('empty grEmisSts is dropped', !('grEmisSts' in kept))
check('a real value survives', kept.admNo === '2580' && kept.gender === 'Boy')
for (const k of REQUIRED_STUDENT_KEYS) {
  check(`required "${k}" is kept even when empty`, k in kept, JSON.stringify(kept))
}
check('empty lastName is kept (schema calls it required)', kept.lastName === '')

console.log('\nstudents_schema columns the file implies')
const plan = { items: [
  { row: { extras: { House: 'Tagore', 'Bus Route': 'Route 4', 'Date Of Admission': '16 May 2026' } } },
  { row: { extras: { House: 'Bose', 'Bus Route': 'Route 4', 'Date Of Admission': '2 Jun 2026' } } },
  { row: { extras: { House: 'Tagore', 'Bus Route': 'Route 4', 'Date Of Admission': '9 Jul 2026' } } },
] }
const cols = newSchemaColumnsFor(plan, [{ key: 'house', order: 3 }])
eq('a column the school already has is not re-proposed',
   cols.map(c => c.key), ['busRoute', 'dateOfAdmission'])
eq('order continues from the highest existing', cols.map(c => c.order), [4, 5])
check('a date column is typed as a date',
      cols.find(c => c.key === 'dateOfAdmission').type === 'date', JSON.stringify(cols))
check('a small repeating vocabulary is typed as a select',
      cols.find(c => c.key === 'busRoute').type === 'select', JSON.stringify(cols))
check('the label keeps the school\'s own header',
      cols.find(c => c.key === 'busRoute').label === 'Bus Route')
eq('banned columns are never proposed',
   newSchemaColumnsFor({ items: [{ row: { extras: { Caste: 'OBC' } } }] }, []), [])
eq('an empty plan proposes nothing', newSchemaColumnsFor({ items: [] }, []), [])

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed')
process.exit(failures ? 1 : 0)
