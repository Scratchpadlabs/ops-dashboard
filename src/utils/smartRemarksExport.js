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
    Comment: remark?.comment || (remark ? '' : 'Not generated yet'),
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

// ── Several classes in one file ───────────────────────────────────────────

export const MULTI_COLUMNS = ['Class', ...COLUMNS]

/**
 * @param classBlocks  [{ classId, label, students, remarksByStudent }, ...] in
 *                     the order they should appear
 * @param approvedOnly drop every remark that isn't approved (and students left
 *                     with nothing) — the "ready for report cards" view
 */
export function buildMultiClassRows(classBlocks, { approvedOnly = false } = {}) {
  return (classBlocks || []).flatMap(block => {
    let remarksByStudent = block.remarksByStudent || {}
    let students = block.students || []
    if (approvedOnly) {
      remarksByStudent = Object.fromEntries(Object.entries(remarksByStudent)
        .map(([sid, list]) => [sid, (list || []).filter(r => r.status === 'approved')]))
      students = students.filter(s => remarksByStudent[s.id]?.length)
    }
    return buildRows(students, remarksByStudent)
      .map(row => ({ Class: block.label || block.classId, ...row }))
  })
}

/** Excel sheet names: max 31 chars, none of : \ / ? * [ ], unique per book. */
export function sheetName(label, used) {
  const base = String(label || 'Class').replace(/[:\\/?*[\]]/g, ' ').trim().slice(0, 31) || 'Class'
  let name = base
  for (let n = 2; used.has(name.toLowerCase()); n++) {
    const suffix = ` (${n})`
    name = base.slice(0, 31 - suffix.length) + suffix
  }
  used.add(name.toLowerCase())
  return name
}

function multiFilename(schoolId, count, extension) {
  return exportFilename(schoolId, `${count}_classes`, extension)
}

function writeSheet(rows, columns) {
  const sheet = XLSX.utils.json_to_sheet(rows, { header: columns })
  sheet['!cols'] = columnWidths(columns)
  sheet['!autofilter'] = { ref: XLSX.utils.encode_range({
    s: { r: 0, c: 0 }, e: { r: rows.length, c: columns.length - 1 },
  }) }
  return sheet
}

export function downloadSmartRemarksMultiCsv(schoolId, classBlocks, opts) {
  const rows = buildMultiClassRows(classBlocks, opts)
  downloadCsv(multiFilename(schoolId, classBlocks.length, 'csv'), toCsv(rows, MULTI_COLUMNS))
  return rows.length
}

/** One "All classes" sheet (with a Class column), then one sheet per class. */
export function downloadSmartRemarksMultiXlsx(schoolId, classBlocks, opts) {
  const all = buildMultiClassRows(classBlocks, opts)
  const book = XLSX.utils.book_new()
  const used = new Set()
  XLSX.utils.book_append_sheet(book, writeSheet(all, MULTI_COLUMNS), sheetName('All classes', used))
  for (const block of classBlocks) {
    const rows = buildMultiClassRows([block], opts).map(({ Class, ...rest }) => rest)
    XLSX.utils.book_append_sheet(book, writeSheet(rows, COLUMNS), sheetName(block.label || block.classId, used))
  }
  XLSX.writeFile(book, multiFilename(schoolId, classBlocks.length, 'xlsx'))
  return all.length
}
