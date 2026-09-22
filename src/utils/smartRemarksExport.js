/**
 * Smart Remarks export — CSV and XLSX, one row per (student, category).
 *
 * Unlike aapExport.js's subject pivot, categories aren't fixed columns —
 * they're separate rows, since a student can have anywhere from zero to
 * several category remarks (General Remarks, Physical Development, ...),
 * each independently written and reviewed. A student with nothing
 * generated yet still gets one row (blank comment) — same reasoning as
 * AAP's export: "who has nothing yet" is one of the questions this file
 * gets opened to answer.
 */
import * as XLSX from 'xlsx'

import { toCsv, downloadCsv } from './csv.js'

export const COLUMNS = [
  'Student', 'Roll No', 'Student ID', 'Category', 'Ticked Count', 'Comment', 'Status',
  'Low Confidence', 'Last Updated', 'Updated By',
]

function formatTimestamp(value) {
  const date = value?.toDate ? value.toDate() : (typeof value === 'string' ? new Date(value) : null)
  if (!date || Number.isNaN(date.getTime())) return ''
  return date.toLocaleString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

function remarkRow(student, remark) {
  return {
    Student: student.name || student.id,
    'Roll No': student.rollNo || '',
    'Student ID': student.id,
    Category: remark?.category || '',
    'Ticked Count': remark?.tickedCount ?? '',
    Comment: remark?.comment || (remark ? '' : 'No remarks ticked yet'),
    Status: remark?.status || '',
    'Low Confidence': remark?.lowConfidence ? 'Yes' : '',
    'Last Updated': formatTimestamp(remark?.updatedAt),
    'Updated By': remark?.updatedBy || '',
  }
}

/**
 * @param students          roster rows ({ id, name, rollNo })
 * @param remarksByStudent  { studentId: [remark doc, ...] }
 */
export function buildRows(students, remarksByStudent) {
  return (students || []).flatMap(student => {
    const remarks = remarksByStudent?.[student.id] || []
    if (!remarks.length) return [remarkRow(student, null)]
    return remarks.map(remark => remarkRow(student, remark))
  })
}

/** `Smart_remarks_<school>_<class>_<yyyy-mm-dd>` */
export function exportFilename(schoolId, classId, extension) {
  const safe = (text) => String(text || '').trim().replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '')
  const today = new Date().toISOString().slice(0, 10)
  return `Smart_remarks_${safe(schoolId)}_${safe(classId)}_${today}.${extension}`
}

function columnWidths(columns) {
  return columns.map(column => ({
    wch: column === 'Comment' ? 80 : Math.max(12, column.length + 2),
  }))
}

export function downloadSmartRemarksCsv(schoolId, classId, students, remarksByStudent) {
  const rows = buildRows(students, remarksByStudent)
  downloadCsv(exportFilename(schoolId, classId, 'csv'), toCsv(rows, COLUMNS))
  return rows.length
}

export function downloadSmartRemarksXlsx(schoolId, classId, students, remarksByStudent) {
  const rows = buildRows(students, remarksByStudent)
  const sheet = XLSX.utils.json_to_sheet(rows, { header: COLUMNS })
  sheet['!cols'] = columnWidths(COLUMNS)
  sheet['!freeze'] = { xSplit: 3, ySplit: 1 }
  sheet['!autofilter'] = { ref: XLSX.utils.encode_range({
    s: { r: 0, c: 0 }, e: { r: rows.length, c: COLUMNS.length - 1 },
  }) }

  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, sheet, 'Smart remarks')
  XLSX.writeFile(book, exportFilename(schoolId, classId, 'xlsx'))
  return rows.length
}
