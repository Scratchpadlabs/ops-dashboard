// One row per STUDENT, subjects across columns — the layout the export moved
// to after the first real file came back as 125 rows for 25 children.
//
//   node tools/check_aap_export.mjs
import {
  buildWideRows, buildDetailRows, subjectsInClass, wideColumns, countWords,
  IDENTITY_COLUMNS, SUBJECT_FIELDS, exportFilename,
} from '../src/utils/aapExport.js'

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  cond ? pass++ : fail++
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : '  <-- ' + extra}`)
}

// Shaped like the real A K CSchool IV A export: 3 students, 3 subjects, one
// student short a subject and one with nothing at all.
const students = [
  { id: 'sakc0024', name: 'Ahamad Raza', rollNo: '' },
  { id: 'sakc0025', name: 'Bhavna Kaur', rollNo: '12' },
  { id: 'sakc0026', name: 'Chandan Rao', rollNo: '13' },
]
const remark = (id, level, comment, status = 'needs_review') => ({
  id, awareness: level, sensitivity: level, creativity: level, comment, status,
  matchedBy: 'alias', frameworkSubject: 'L2 (English / French / Sanskrit / Urdu)',
})
const remarksByStudent = {
  sakc0024: [remark('English', 'Advanced', 'Ahamad expresses original ideas beautifully.', 'approved'),
             remark('Hindi', 'Proficient', 'Ahamad shows remarkable creativity in Hindi.'),
             remark('Maths', 'Proficient', 'Ahamad approaches problems with confidence.')],
  sakc0025: [remark('English', 'Beginner', 'Bhavna is building her confidence in English.')],
  // sakc0026 deliberately absent — a student the survey never rated.
}

console.log('=== one row per student ===')
const { columns, rows, subjects } = buildWideRows(students, remarksByStudent)
ok('one row per student, not per remark', rows.length === 3, `${rows.length} rows`)
ok('subjects are the class-wide union, sorted',
  JSON.stringify(subjects) === JSON.stringify(['English', 'Hindi', 'Maths']), JSON.stringify(subjects))
ok('a student with no remarks still gets a row',
  rows.some(r => r['Student ID'] === 'sakc0026'), 'missing student dropped')

console.log('=== columns ===')
ok('identity columns come first',
  JSON.stringify(columns.slice(0, 3)) === JSON.stringify(IDENTITY_COLUMNS), JSON.stringify(columns.slice(0, 3)))
ok('one block per subject',
  columns.length === IDENTITY_COLUMNS.length + subjects.length * SUBJECT_FIELDS.length, `${columns.length} columns`)
ok('block is prefixed with the subject',
  columns.includes('Hindi Comment') && columns.includes('Hindi Awareness'), JSON.stringify(columns))
ok('wideColumns agrees with buildWideRows',
  JSON.stringify(wideColumns(subjects)) === JSON.stringify(columns))

console.log('=== cells ===')
const ahamad = rows.find(r => r['Student ID'] === 'sakc0024')
ok("a subject's values land in that subject's block",
  ahamad['English Awareness'] === 'Advanced' && ahamad['English Status'] === 'approved',
  JSON.stringify([ahamad['English Awareness'], ahamad['English Status']]))
ok('comments are not truncated or merged',
  ahamad['Hindi Comment'] === 'Ahamad shows remarkable creativity in Hindi.', ahamad['Hindi Comment'])

const bhavna = rows.find(r => r['Student ID'] === 'sakc0025')
ok('a subject a student lacks is blank, and the row does NOT shift',
  bhavna['Hindi Comment'] === '' && bhavna['English Comment'].startsWith('Bhavna'),
  JSON.stringify([bhavna['Hindi Comment'], bhavna['English Comment']]))
ok('every row carries every column',
  rows.every(r => columns.every(c => c in r)), 'ragged row')

const chandan = rows.find(r => r['Student ID'] === 'sakc0026')
ok('the unrated student is blank across every subject',
  subjects.every(s => chandan[`${s} Comment`] === '' && chandan[`${s} Status`] === ''))
ok('roll number is carried through', bhavna['Roll No'] === '12', bhavna['Roll No'])

console.log('=== detail sheet still has what the pivot drops ===')
const detail = buildDetailRows(students, remarksByStudent)
ok('one row per student-subject', detail.length === 5, `${detail.length} rows`)
ok('word counts survive', detail[0].Words === countWords(detail[0].Comment), String(detail[0].Words))
ok('provenance survives', detail[0]['Matched via'] === 'alias' && !!detail[0]['Rubric row'])
ok('the unrated student is called out, not silently absent',
  detail.some(r => r['Student ID'] === 'sakc0026' && r.Comment === 'No remarks generated'))

console.log('=== filename ===')
ok('school and class are in the name, spaces normalised',
  exportFilename('A K CSchool', 'IV_A', 'xlsx').startsWith('AAP_remarks_A_K_CSchool_IV_A_'),
  exportFilename('A K CSchool', 'IV_A', 'xlsx'))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
