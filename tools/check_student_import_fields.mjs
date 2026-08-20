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
const { extraFieldsFor, extraColumnsFor, newSchemaColumnsFor } =
  await import(path.join(ROOT, 'src/utils/studentEnrichment.js'))
const { dropBlankOptionalFields, REQUIRED_STUDENT_KEYS, mapImportRowToStudent,
        CARRIED_SOURCE_FIELDS, UNMAPPED_SOURCE_FIELDS } =
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

console.log('\nRecognized columns the schema has no named field for are carried, not dropped')
// One real Hillgreen row, as the extractor hands it over.
const { payload: mapped, carried, dropped } = mapImportRowToStudent({
  student_name: 'Zayn Aman Arab', gender: 'Boy', dob: '2024-01-16',
  adm_no: '5701', gr_emis_sts: '', aadhaar: '', contact: '', email: '',
  sr_no: '1', roll_no: '12', branch_name: 'Hillgreen Highschool & Junior College',
  board: 'CBSE', enrollment_code: '26HHS0236', date_of_admission: '16 May 2026',
  status: 'Active', address: '2001, Princetown Towers, Pune',
  father_name: 'Arab Aman Mehboob', father_mobile: '8087867401',
  father_email: 'amanarab74@gmail.com', mother_name: 'Zeba Aman Arab',
  mother_mobile: '9359262211', mother_email: 'zebaman2318@gmail.com',
  using_transport: 'No', city: 'Pune',
}, { classId: 'Play_Group_A' })
const carriedKeys = carried.map(c => c.key).sort()
eq('every parent contact, the board and the address are carried', carriedKeys, [
  'address', 'board', 'branchName', 'city', 'dateOfAdmission', 'enrollmentCode',
  'fatherEmail', 'fatherMobile', 'fatherName', 'motherEmail', 'motherMobile',
  'motherName', 'rollNo', 'status', 'usingTransport',
])
eq("only the spreadsheet's own serial number is dropped", dropped, ['sr_no'])
eq('the fixed mapping is untouched by this',
   [mapped.name, mapped.gender, mapped.currentClassId, mapped.admNo],
   ['Zayn Aman Arab', 'Boy', 'Play_Group_A', '5701'])
check('a carried key matches what the enrichment screen would produce',
      carried.find(c => c.key === 'fatherMobile')?.value === '8087867401')
eq('blank carried fields are omitted',
   mapImportRowToStudent({ student_name: 'A B', father_name: '  ' }, { classId: 'X' })
     .carried.map(c => c.key), [])
eq('UNMAPPED_SOURCE_FIELDS is now only the file-level one', UNMAPPED_SOURCE_FIELDS, ['sr_no'])
check('no key collides with a real student field',
      !Object.values(CARRIED_SOURCE_FIELDS).some(
        v => REQUIRED_STUDENT_KEYS.includes(v.key) || ['email', 'phoneNo', 'dateOfBirth'].includes(v.key)),
      JSON.stringify(Object.values(CARRIED_SOURCE_FIELDS).map(v => v.key)))

console.log('\nstudents_schema columns the file implies')
const asItem = (extras) => ({ extraColumns: extraColumnsFor(extras) })
const plan = { items: [
  asItem({ House: 'Tagore', 'Bus Route': 'Route 4', 'Date Of Admission': '16 May 2026' }),
  asItem({ House: 'Bose', 'Bus Route': 'Route 4', 'Date Of Admission': '2 Jun 2026' }),
  asItem({ House: 'Tagore', 'Bus Route': 'Route 4', 'Date Of Admission': '9 Jul 2026' }),
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
   newSchemaColumnsFor({ items: [asItem({ Caste: 'OBC' })] }, []), [])
eq('carried fields are proposed as columns too, under their own labels',
   newSchemaColumnsFor({ items: [{ extraColumns: carried }] }, [])
     .filter(c => c.key === 'fatherMobile').map(c => [c.label, c.type]),
   [['Father Mobile', 'text']])
eq('an empty plan proposes nothing', newSchemaColumnsFor({ items: [] }, []), [])

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed')
process.exit(failures ? 1 : 0)
