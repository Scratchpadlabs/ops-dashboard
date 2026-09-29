// One row per STUDENT, subjects across columns — the layout the export moved
// to after the first real file came back as 125 rows for 25 children.
//
//   node tools/check_aap_export.mjs
import {
  buildWideRows, buildDetailRows, subjectsInClass, wideColumns, countWords,
  IDENTITY_COLUMNS, SUBJECT_FIELDS, exportFilename,
  approvedOnly,
} from '../src/utils/aapExport.js'
import {
  buildTeacherWorkbook, classSummaryRows, estimateLines, sheetName, statusLabel,
} from '../src/utils/aapTeacherWorkbook.js'
import ExcelJS from 'exceljs'

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

console.log('=== several classes in one export ===')
const multiStudents = [
  { id: 'sakc0024', name: 'Ahamad Raza', rollNo: '', classId: 'IV_A' },
  { id: 'sakc0031', name: 'Divya Shah', rollNo: '4', classId: 'IV_B' },
]
const multiRemarks = {
  sakc0024: remarksByStudent.sakc0024,
  sakc0031: [{ ...remark('Maths', 'Proficient', 'Divya reasons carefully in Maths.'), topics: ['Term 1', 'Term 2'] }],
}
const multi = buildWideRows(multiStudents, multiRemarks)
ok('a Class column leads when rows carry a class',
  multi.columns[0] === 'Class' && multi.rows[1].Class === 'IV_B', JSON.stringify(multi.columns.slice(0, 4)))
ok('subjects are the union across classes',
  JSON.stringify(multi.subjects) === JSON.stringify(['English', 'Hindi', 'Maths']), JSON.stringify(multi.subjects))
const multiDetail = buildDetailRows(multiStudents, multiRemarks)
ok('the detail sheet names the class and the combined topics',
  multiDetail.some(r => r.Class === 'IV_B' && r.Topics === 'Term 1 + Term 2'),
  JSON.stringify(multiDetail.at(-1)))
ok('a single-class roster without classId keeps the old columns',
  !columns.includes('Class') && !('Class' in detail[0]))

console.log('=== teacher workbook ===')
const classesPicked = [{ id: 'IV_A', label: 'IV A' }, { id: 'IV_B', label: 'IV B' }, { id: 'IV_C', label: 'IV C' }]
const wb = buildTeacherWorkbook(ExcelJS, {
  schoolName: 'A K C School', classes: classesPicked, students: multiStudents, remarksByStudent: multiRemarks,
  date: new Date('2026-09-29'),
})
ok('Read me, Summary, a sheet per class with students, then All remarks',
  JSON.stringify(wb.worksheets.map(w => w.name)) === JSON.stringify(['Read me', 'Summary', 'IV A', 'IV B', 'All remarks']),
  JSON.stringify(wb.worksheets.map(w => w.name)))
// Round-trip through a real .xlsx so merges/styles are what Excel will see.
const back = new ExcelJS.Workbook()
await back.xlsx.load(await wb.xlsx.writeBuffer())
const ivA = back.getWorksheet('IV A')
ok('class sheet header is plain words',
  JSON.stringify(ivA.getRow(3).values.slice(1)) === JSON.stringify(
    ['Roll No', 'Student', 'Subject', 'Awareness', 'Sensitivity', 'Creativity', 'Remark', 'Status']),
  JSON.stringify(ivA.getRow(3).values))
ok('one row per subject for a child, name merged down the block',
  ivA.getCell('C4').value === 'English' && ivA.getCell('C6').value === 'Maths'
    && ivA.getCell('B6').isMerged && ivA.getCell('B6').master.address === 'B4',
  `${ivA.getCell('C4').value} ${ivA.getCell('C6').value} ${ivA.getCell('B6').master?.address}`)
ok('status reads as words, not codes',
  ivA.getCell('H4').value === 'Approved' && ivA.getCell('H5').value === 'To review',
  `${ivA.getCell('H4').value} / ${ivA.getCell('H5').value}`)
ok('levels are colour-coded',
  ivA.getCell('D4').fill?.fgColor?.argb === 'FFDCFCE7', JSON.stringify(ivA.getCell('D4').fill))
ok('remarks wrap and rows are tall enough for them',
  ivA.getCell('G4').alignment?.wrapText === true && ivA.getRow(4).height >= 20, String(ivA.getRow(4).height))
ok('class sheet prints landscape, one page wide, header repeated',
  ivA.pageSetup.orientation === 'landscape' && ivA.pageSetup.fitToWidth === 1 && ivA.pageSetup.printTitlesRow === '3:3',
  JSON.stringify(ivA.pageSetup))
const noRemarkWb = buildTeacherWorkbook(ExcelJS, { schoolName: 'S', classes: [{ id: 'IV_A', label: 'IV A' }],
  students: students.map(s => ({ ...s, classId: 'IV_A' })), remarksByStudent })
const unrated = noRemarkWb.getWorksheet('IV A').getColumn(7).values.find(v => String(v).startsWith('No AAP ratings'))
ok('a child with no remarks keeps a row saying so', !!unrated)
const summary = classSummaryRows(classesPicked, multiStudents, multiRemarks)
ok('summary counts per class, classes without students left out',
  summary.length === 2 && summary[0].Remarks === 3 && summary[0].Approved === 1 && summary[0]['To review'] === 2,
  JSON.stringify(summary))
const data = back.getWorksheet('All remarks')
ok('All remarks has a filter and one row per remark',
  !!data.autoFilter && data.rowCount === 1 + 4, `${data.rowCount} rows`)
ok('no technical columns in the teacher file',
  !data.getRow(1).values.some(v => v === 'Matched via' || v === 'Rubric row'), JSON.stringify(data.getRow(1).values))
ok('status labels', statusLabel('approved') === 'Approved' && statusLabel('needs_review') === 'To review')
ok('line estimate grows with text', estimateLines('x'.repeat(300), 78) > estimateLines('short', 78))
const used = new Set()
ok('sheet names are unique, <= 31 chars, no forbidden characters',
  sheetName('VII A', used) === 'VII A' && sheetName('vii a', used) === 'vii a (2)'
    && sheetName('X/Y:'.repeat(20), used).length <= 31 && !/[[\]:*?/\\]/.test(sheetName('A:B', used)))
const onlyApproved = approvedOnly(multiRemarks)
ok('approved-only keeps approved remarks and every student',
  onlyApproved.sakc0024.length === 1 && onlyApproved.sakc0031.length === 0, JSON.stringify(onlyApproved))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
