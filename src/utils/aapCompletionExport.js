/**
 * AAP survey completion export — XLSX, whole school.
 *
 * Two sheets, same shape as aapExport.js's remarks export: a summary (one row
 * per class/subject/topic, the thing someone scans to find what's still
 * outstanding) and a detail sheet (one row per actual gap — a specific
 * student missing a specific question — because "Question 2 pending" only
 * means something once it names who and which question).
 */
import * as XLSX from 'xlsx'

const TRAIT_LABEL = { awareness: 'Awareness', sensitivity: 'Sensitivity', creativity: 'Creativity' }
const STATUS_LABEL = { not_started: 'Not started', partial: 'Partial', complete: 'Complete' }

export const SUMMARY_COLUMNS = [
  'Class', 'Subject', 'Topic', 'Status', 'Teacher', 'Expected Students',
  'Responded Students', 'Gaps', 'Activity', 'Curricular Goals', 'Competencies',
]

export const DETAIL_COLUMNS = [
  'Class', 'Subject', 'Topic', 'Student', 'Student ID', 'Question', 'Status',
]

// A row can carry more than one response (same class/topic filed under two
// activities) — each value is listed, one per line, in the same order.
const joinResponses = (r, pick) => (r.responses || []).map(pick).filter(Boolean).join('\n')

export function buildSummaryRows(rows) {
  return (rows || []).map(r => ({
    Class: r.classId,
    Subject: r.subject,
    Topic: r.topic || '—',
    Status: STATUS_LABEL[r.status] || r.status,
    Teacher: r.teacherId || '',
    'Expected Students': r.expectedStudents,
    'Responded Students': r.respondedStudents,
    Gaps: r.gaps?.length || 0,
    Activity: joinResponses(r, x => x.activityName || x.activityId),
    'Curricular Goals': joinResponses(r, x => (x.selectedGoals || []).join('; ')),
    Competencies: joinResponses(r, x => (x.selectedCompetencies || []).join('; ')),
  }))
}

/** One row per (student, missing question) — this is the "Question 2
 *  pending for this child" view. A complete row contributes nothing here. */
export function buildDetailRows(rows) {
  const out = []
  for (const r of rows || []) {
    for (const gap of r.gaps || []) {
      for (const trait of gap.missing || []) {
        out.push({
          Class: r.classId,
          Subject: r.subject,
          Topic: r.topic || '—',
          Student: gap.studentName,
          'Student ID': gap.studentId,
          Question: TRAIT_LABEL[trait] || trait,
          Status: 'Pending',
        })
      }
    }
  }
  return out
}

function columnWidths(columns) {
  return columns.map(column => ({ wch: Math.max(12, column.length + 4) }))
}

/** `AAP_survey_completion_<school>_<yyyy-mm-dd>.xlsx` */
export function completionExportFilename(schoolId) {
  const safe = (text) => String(text || '').trim().replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '')
  const today = new Date().toISOString().slice(0, 10)
  return `AAP_survey_completion_${safe(schoolId)}_${today}.xlsx`
}

export function downloadAapCompletionXlsx(schoolId, rows) {
  const summaryRows = buildSummaryRows(rows)
  const detailRows = buildDetailRows(rows)

  const summarySheet = XLSX.utils.json_to_sheet(summaryRows, { header: SUMMARY_COLUMNS })
  summarySheet['!cols'] = columnWidths(SUMMARY_COLUMNS)
  summarySheet['!freeze'] = { xSplit: 3, ySplit: 1 }
  summarySheet['!autofilter'] = { ref: XLSX.utils.encode_range({
    s: { r: 0, c: 0 }, e: { r: summaryRows.length, c: SUMMARY_COLUMNS.length - 1 },
  }) }

  const detailSheet = XLSX.utils.json_to_sheet(detailRows, { header: DETAIL_COLUMNS })
  detailSheet['!cols'] = columnWidths(DETAIL_COLUMNS)
  detailSheet['!freeze'] = { xSplit: 3, ySplit: 1 }
  detailSheet['!autofilter'] = { ref: XLSX.utils.encode_range({
    s: { r: 0, c: 0 }, e: { r: detailRows.length, c: DETAIL_COLUMNS.length - 1 },
  }) }

  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, summarySheet, 'Summary')
  XLSX.utils.book_append_sheet(book, detailSheet, 'Pending detail')

  XLSX.writeFile(book, completionExportFilename(schoolId))
  return { summaryRows: summaryRows.length, detailRows: detailRows.length }
}
