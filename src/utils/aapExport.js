/**
 * AAP remarks export — CSV and XLSX, one row per student-subject.
 *
 * The layout deliberately mirrors the review table on screen, column for
 * column: an export nobody can reconcile against what they just reviewed is
 * an export nobody trusts. Students with no remarks are included as a row
 * with an empty subject, because "who is missing" is one of the questions
 * this file gets opened to answer.
 *
 * Client-side rather than a Cloud Function (unlike survey_report): a class is
 * tens of rows of text already sitting in the browser, so shipping it to a
 * function and back would add a deploy and a round trip to save nothing.
 */
import * as XLSX from 'xlsx'

import { toCsv, downloadCsv } from './csv.js'
import { countWords } from '../composables/useAapRemarks.js'

export const EXPORT_COLUMNS = [
  'Student', 'Roll No', 'Student ID', 'Subject', 'Awareness', 'Sensitivity',
  'Creativity', 'Comment', 'Words', 'Status', 'Matched via', 'Rubric row',
  'Last updated', 'Updated by',
]

function formatTimestamp(value) {
  const date = value?.toDate ? value.toDate() : (value instanceof Date ? value : null)
  if (!date) return ''
  return date.toLocaleString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

/**
 * @param students          roster rows ({ id, name, rollNo })
 * @param remarksByStudent  { studentId: [remark docs] }
 */
export function buildExportRows(students, remarksByStudent) {
  const rows = []
  for (const student of students || []) {
    const name = student.name || student.id
    const remarks = remarksByStudent?.[student.id] || []
    if (!remarks.length) {
      rows.push({
        Student: name, 'Roll No': student.rollNo || '', 'Student ID': student.id,
        Subject: '', Awareness: '', Sensitivity: '', Creativity: '',
        Comment: 'No remarks generated', Words: 0, Status: '',
        'Matched via': '', 'Rubric row': '', 'Last updated': '', 'Updated by': '',
      })
      continue
    }
    for (const remark of remarks) {
      rows.push({
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

export function downloadAapCsv(schoolId, classId, students, remarksByStudent) {
  const rows = buildExportRows(students, remarksByStudent)
  downloadCsv(exportFilename(schoolId, classId, 'csv'), toCsv(rows, EXPORT_COLUMNS))
  return rows.length
}

export function downloadAapXlsx(schoolId, classId, students, remarksByStudent) {
  const rows = buildExportRows(students, remarksByStudent)
  const sheet = XLSX.utils.json_to_sheet(rows, { header: EXPORT_COLUMNS })
  // Without explicit widths every column comes out at the default and the
  // comment — the only column anyone reads — is the one that gets clipped.
  sheet['!cols'] = EXPORT_COLUMNS.map(column => ({
    wch: column === 'Comment' ? 90 : Math.max(12, column.length + 4),
  }))
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, sheet, 'AAP Remarks')
  XLSX.writeFile(book, exportFilename(schoolId, classId, 'xlsx'))
  return rows.length
}
