/**
 * AAP remarks export — CSV and XLSX, ONE ROW PER STUDENT.
 *
 * Each subject contributes its own block of columns (levels, comment, status),
 * so a class of 25 students across 5 subjects is 25 rows, not 125. That is the
 * shape a report card is filled from and the shape a school reads: a person
 * scanning the file is looking for a child, not for a student-subject pair.
 *
 * The per-student-subject detail is not thrown away — the XLSX carries it on a
 * second sheet, with the word counts and the provenance (which rubric row
 * matched, and how) that the pivot has no room for. CSV, having no second
 * sheet, is the pivoted layout only.
 *
 * Students with no remarks still get a row with empty subject cells, because
 * "who is missing" is one of the questions this file gets opened to answer.
 *
 * Client-side rather than a Cloud Function (unlike survey_report): a class is
 * tens of rows of text already sitting in the browser, so shipping it to a
 * function and back would add a deploy and a round trip to save nothing.
 */
import * as XLSX from 'xlsx'

import { toCsv, downloadCsv } from './csv.js'

/** Word count, here rather than in the composable so this module stays free of
 *  Firebase imports and can be exercised by tools/check_aap_export.mjs. */
export function countWords(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length
}

/** Columns every row starts with, before the per-subject blocks. */
export const IDENTITY_COLUMNS = ['Student', 'Roll No', 'Student ID']

/** A multi-class export also needs to say which class each child is in —
 *  added whenever the roster rows carry a classId (the AAP page's always do). */
export function identityColumns(students) {
  return (students || []).some(s => s.classId) ? ['Class', ...IDENTITY_COLUMNS] : IDENTITY_COLUMNS
}

/** Per-subject block, in this order, prefixed with the subject name. */
export const SUBJECT_FIELDS = ['Awareness', 'Sensitivity', 'Creativity', 'Comment', 'Status']

/** The detail sheet — one row per student-subject, everything the pivot drops. */
export const DETAIL_COLUMNS = [
  'Student', 'Roll No', 'Student ID', 'Subject', 'Awareness', 'Sensitivity',
  'Creativity', 'Comment', 'Words', 'Status', 'Matched via', 'Rubric row',
  'Topics', 'Curricular goals', 'Competencies', 'Last updated', 'Updated by',
]

export function detailColumns(students) {
  return (students || []).some(s => s.classId) ? ['Class', ...DETAIL_COLUMNS] : DETAIL_COLUMNS
}

function formatTimestamp(value) {
  const date = value?.toDate ? value.toDate() : (value instanceof Date ? value : null)
  if (!date) return ''
  return date.toLocaleString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

/**
 * Every subject any student in the class has a remark for, sorted.
 *
 * Taken from the whole class rather than per student, so every row carries the
 * same columns — a student missing a subject shows blank cells there, which is
 * a visible gap rather than a shifted row.
 */
export function subjectsInClass(students, remarksByStudent) {
  const subjects = new Set()
  for (const student of students || []) {
    for (const remark of remarksByStudent?.[student.id] || []) subjects.add(remark.id)
  }
  return [...subjects].sort()
}

export function wideColumns(subjects, identity = IDENTITY_COLUMNS) {
  return [
    ...identity,
    ...subjects.flatMap(subject => SUBJECT_FIELDS.map(field => `${subject} ${field}`)),
  ]
}

/**
 * ONE ROW PER STUDENT, subjects spread across columns.
 *
 * @param students          roster rows ({ id, name, rollNo })
 * @param remarksByStudent  { studentId: [remark docs] }
 */
export function buildWideRows(students, remarksByStudent) {
  const subjects = subjectsInClass(students, remarksByStudent)
  const identity = identityColumns(students)
  const rows = (students || []).map(student => {
    const row = {
      ...(identity.includes('Class') ? { Class: student.classId || '' } : {}),
      Student: student.name || student.id,
      'Roll No': student.rollNo || '',
      'Student ID': student.id,
    }
    const bySubject = new Map(
      (remarksByStudent?.[student.id] || []).map(remark => [remark.id, remark]))
    for (const subject of subjects) {
      const remark = bySubject.get(subject)
      row[`${subject} Awareness`] = remark?.awareness || ''
      row[`${subject} Sensitivity`] = remark?.sensitivity || ''
      row[`${subject} Creativity`] = remark?.creativity || ''
      row[`${subject} Comment`] = remark?.comment || ''
      row[`${subject} Status`] = remark?.status || ''
    }
    return row
  })
  return { columns: wideColumns(subjects, identity), rows, subjects }
}

/**
 * One row per student-subject — the detail sheet.
 *
 * @param students          roster rows ({ id, name, rollNo })
 * @param remarksByStudent  { studentId: [remark docs] }
 */
export function buildDetailRows(students, remarksByStudent) {
  const rows = []
  const withClass = detailColumns(students).includes('Class')
  for (const student of students || []) {
    const name = student.name || student.id
    const remarks = remarksByStudent?.[student.id] || []
    const cls = withClass ? { Class: student.classId || '' } : {}
    if (!remarks.length) {
      rows.push({
        ...cls,
        Student: name, 'Roll No': student.rollNo || '', 'Student ID': student.id,
        Subject: '', Awareness: '', Sensitivity: '', Creativity: '',
        Comment: 'No remarks generated', Words: 0, Status: '',
        'Matched via': '', 'Rubric row': '', Topics: '', 'Curricular goals': '', Competencies: '',
        'Last updated': '', 'Updated by': '',
      })
      continue
    }
    for (const remark of remarks) {
      rows.push({
        ...cls,
        Student: name,
        'Roll No': student.rollNo || '',
        'Student ID': student.id,
        Subject: remark.id,
        Awareness: remark.awareness || '',
        Sensitivity: remark.sensitivity || '',
        Creativity: remark.creativity || '',
        Comment: remark.comment || '',
        Words: countWords(remark.comment),
        Status: remark.status || 'needs_review',
        // How the subject reached its rubric row — a comment written off a
        // human-confirmed mapping is a different kind of fact from one that
        // matched exactly, and the export should not flatten the two.
        'Matched via': remark.matchedBy || '',
        'Rubric row': remark.frameworkSubject || '',
        // Several topics = the levels were combined across them.
        Topics: (remark.topics || []).join(' + '),
        // What the class worked on, as the generator saw it.
        'Curricular goals': (remark.curricularGoals || []).join('; '),
        Competencies: (remark.competencies || []).join('; '),
        'Last updated': formatTimestamp(remark.updatedAt),
        'Updated by': remark.updatedBy || '',
      })
    }
  }
  return rows
}

/** `AAP_remarks_<school>_<class>_<yyyy-mm-dd>` — school and class in the name
 *  because these files get mailed around and renamed by nobody. */
export function exportFilename(schoolId, classId, extension) {
  const safe = (text) => String(text || '').trim().replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '')
  const today = new Date().toISOString().slice(0, 10)
  return `AAP_remarks_${safe(schoolId)}_${safe(classId)}_${today}.${extension}`
}

/** Comment columns get the width; a level or status column never needs it. */
function columnWidths(columns) {
  return columns.map(column => ({
    wch: column.endsWith('Comment') ? 80
      : (column === 'Competencies' || column === 'Curricular goals') ? 50
        : Math.max(12, column.length + 2),
  }))
}

/** Only approved remarks — what a school should see when the rest are
 *  still being reviewed. Students keep their row either way. */
export function approvedOnly(remarksByStudent) {
  return Object.fromEntries(Object.entries(remarksByStudent || {}).map(
    ([id, rows]) => [id, (rows || []).filter(r => r.status === 'approved')]))
}

/** Excel sheet names: at most 31 characters, none of []:*?/\\, unique. */
export function sheetName(label, used) {
  const base = String(label || 'Class').replace(/[\[\]:*?/\\]/g, ' ').trim().slice(0, 31) || 'Class'
  let name = base
  for (let i = 2; used.has(name.toLowerCase()); i++) {
    const suffix = ` (${i})`
    name = base.slice(0, 31 - suffix.length) + suffix
  }
  used.add(name.toLowerCase())
  return name
}

function wideSheet(students, remarksByStudent) {
  const { columns, rows } = buildWideRows(students, remarksByStudent)
  const sheet = XLSX.utils.json_to_sheet(rows, { header: columns })
  sheet['!cols'] = columnWidths(columns)
  sheet['!freeze'] = { xSplit: identityColumns(students).length, ySplit: 1 }
  sheet['!autofilter'] = { ref: XLSX.utils.encode_range({
    s: { r: 0, c: 0 }, e: { r: rows.length, c: Math.max(0, columns.length - 1) },
  }) }
  return sheet
}

/**
 * Several classes in one workbook: an "All classes" sheet (a Class column
 * first), one sheet per class holding only that class's children and
 * subjects, and the Detail sheet across all of them.
 *
 * @param classes           [{ id, label }] in the order the sheets should run
 * @param students          roster rows, each with its classId
 * @returns the number of student rows written
 */
export function buildMultiClassWorkbook(classes, students, remarksByStudent) {
  const book = XLSX.utils.book_new()
  const used = new Set()
  XLSX.utils.book_append_sheet(book, wideSheet(students, remarksByStudent), sheetName('All classes', used))
  for (const cls of classes) {
    const inClass = students.filter(s => s.classId === cls.id)
    if (!inClass.length) continue
    XLSX.utils.book_append_sheet(book, wideSheet(inClass, remarksByStudent), sheetName(cls.label || cls.id, used))
  }
  const detailHeader = detailColumns(students)
  const detail = XLSX.utils.json_to_sheet(buildDetailRows(students, remarksByStudent), { header: detailHeader })
  detail['!cols'] = columnWidths(detailHeader)
  XLSX.utils.book_append_sheet(book, detail, sheetName('Detail', used))
  return book
}

export function downloadAapXlsxMulti(schoolId, classes, students, remarksByStudent) {
  const book = buildMultiClassWorkbook(classes, students, remarksByStudent)
  const label = classes.length <= 3 ? classes.map(c => c.id).join('+') : `${classes.length}_classes`
  XLSX.writeFile(book, exportFilename(schoolId, label, 'xlsx'))
  return students.length
}

export function downloadAapCsv(schoolId, classId, students, remarksByStudent) {
  const { columns, rows } = buildWideRows(students, remarksByStudent)
  downloadCsv(exportFilename(schoolId, classId, 'csv'), toCsv(rows, columns))
  return rows.length
}

export function downloadAapXlsx(schoolId, classId, students, remarksByStudent) {
  const { columns, rows } = buildWideRows(students, remarksByStudent)
  const sheet = XLSX.utils.json_to_sheet(rows, { header: columns })
  sheet['!cols'] = columnWidths(columns)
  // Identity columns frozen: at five subjects the sheet is 28 columns wide,
  // and scrolling right without the name pinned makes it unreadable.
  sheet['!freeze'] = { xSplit: identityColumns(students).length, ySplit: 1 }
  sheet['!autofilter'] = { ref: XLSX.utils.encode_range({
    s: { r: 0, c: 0 }, e: { r: rows.length, c: Math.max(0, columns.length - 1) },
  }) }

  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, sheet, 'By student')

  // Sheet 2 keeps what the pivot has no room for — word counts, which rubric
  // row matched and how, who last touched each remark.
  const detailRows = buildDetailRows(students, remarksByStudent)
  const detailHeader = detailColumns(students)
  const detail = XLSX.utils.json_to_sheet(detailRows, { header: detailHeader })
  detail['!cols'] = columnWidths(detailHeader)
  XLSX.utils.book_append_sheet(book, detail, 'Detail')

  XLSX.writeFile(book, exportFilename(schoolId, classId, 'xlsx'))
  return rows.length
}
