/**
 * AAP survey completion export — XLSX (four sheets) or CSV (summary only).
 *
 * Exports exactly the rows passed in, so the caller hands over its filtered
 * view: "Grade 7, not started" downloads just that.
 *
 *  - Summary: one row per class/subject/topic — what someone scans to find
 *    what's still outstanding.
 *  - Pending students: one row per actual gap — a specific student missing
 *    a specific question — because "Question 2 pending" only means something
 *    once it names who and which question.
 *  - By class / By subject: completion counts and % per class and per
 *    subject, for chasing the right teacher.
 */
import * as XLSX from 'xlsx'

import { toCsv, downloadCsv } from './csv.js'

const TRAIT_LABEL = { awareness: 'Awareness', sensitivity: 'Sensitivity', creativity: 'Creativity' }
const STATUS_LABEL = { not_started: 'Not started', partial: 'Partial', complete: 'Complete' }

export const SUMMARY_COLUMNS = [
  'Class', 'Subject', 'Topic', 'Status', 'Taught in class', 'Taught on', 'Teacher',
  'Expected Students', 'Responded Students', 'Gaps', 'Not Applicable answers',
  'Activity', 'Curricular Goals', 'Competencies', 'Note',
]

export const DETAIL_COLUMNS = [
  'Class', 'Subject', 'Topic', 'Student', 'Student ID', 'Question', 'Status',
]

export const GROUP_COLUMNS = (label) => [
  label, 'Topics', 'Complete', 'Partial', 'Not started', 'Taught but not surveyed', '% Complete',
]

// A row can carry more than one response (same class/topic filed under two
// activities) — each value is listed, one per line, in the same order.
const joinResponses = (r, pick) => (r.responses || []).map(pick).filter(Boolean).join('\n')

function formatDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

const taughtLabel = (r) => (r.taught === true ? 'Yes' : r.taught === false ? 'No' : '')

export const rowNote = (r) => (r.source === 'response_only'
  ? 'Survey filed for a topic not in this class\'s subjects'
  : '')

export function buildSummaryRows(rows) {
  return (rows || []).map(r => ({
    Class: r.classId,
    Subject: r.subject,
    Topic: r.topic || '—',
    Status: STATUS_LABEL[r.status] || r.status,
    'Taught in class': taughtLabel(r),
    'Taught on': formatDate(r.completedAt),
    Teacher: r.teacherId || '',
    'Expected Students': r.expectedStudents,
    'Responded Students': r.respondedStudents,
    Gaps: r.gaps?.length || 0,
    'Not Applicable answers': r.notApplicable || 0,
    Activity: joinResponses(r, x => x.activityName || x.activityId),
    'Curricular Goals': joinResponses(r, x => (x.selectedGoals || []).join('; ')),
    Competencies: joinResponses(r, x => (x.selectedCompetencies || []).join('; ')),
    Note: rowNote(r),
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

/** Completion counts grouped by `keyOf(row)`, sorted by that key. */
export function buildGroupRows(rows, keyOf, label) {
  const groups = new Map()
  for (const r of rows || []) {
    const key = keyOf(r) || '—'
    const g = groups.get(key) || { total: 0, complete: 0, partial: 0, not_started: 0, taughtNotSurveyed: 0 }
    g.total++
    g[r.status] = (g[r.status] || 0) + 1
    if (r.status === 'not_started' && r.taught === true) g.taughtNotSurveyed++
    groups.set(key, g)
  }
  return [...groups.entries()]
    .sort(([a], [b]) => String(a).localeCompare(String(b), undefined, { numeric: true }))
    .map(([key, g]) => ({
      [label]: key,
      Topics: g.total,
      Complete: g.complete,
      Partial: g.partial,
      'Not started': g.not_started,
      'Taught but not surveyed': g.taughtNotSurveyed,
      '% Complete': g.total ? Math.round((g.complete / g.total) * 100) : 0,
    }))
}

function columnWidths(columns) {
  return columns.map(column => ({ wch: Math.max(12, column.length + 4) }))
}

function sheetFor(rows, columns, freezeCols = 1) {
  const sheet = XLSX.utils.json_to_sheet(rows, { header: columns })
  sheet['!cols'] = columnWidths(columns)
  sheet['!freeze'] = { xSplit: freezeCols, ySplit: 1 }
  sheet['!autofilter'] = { ref: XLSX.utils.encode_range({
    s: { r: 0, c: 0 }, e: { r: rows.length, c: columns.length - 1 },
  }) }
  return sheet
}

/** `AAP_survey_completion_<school>[_filtered]_<yyyy-mm-dd>.<ext>` */
export function completionExportFilename(schoolId, extension = 'xlsx', filtered = false) {
  const safe = (text) => String(text || '').trim().replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '')
  const today = new Date().toISOString().slice(0, 10)
  return `AAP_survey_completion_${safe(schoolId)}${filtered ? '_filtered' : ''}_${today}.${extension}`
}

export function downloadAapCompletionXlsx(schoolId, rows, { filtered = false } = {}) {
  const summaryRows = buildSummaryRows(rows)
  const detailRows = buildDetailRows(rows)
  const classRows = buildGroupRows(rows, r => r.classId, 'Class')
  const subjectRows = buildGroupRows(rows, r => r.subject, 'Subject')

  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, sheetFor(summaryRows, SUMMARY_COLUMNS, 3), 'Summary')
  XLSX.utils.book_append_sheet(book, sheetFor(detailRows, DETAIL_COLUMNS, 3), 'Pending students')
  XLSX.utils.book_append_sheet(book, sheetFor(classRows, GROUP_COLUMNS('Class')), 'By class')
  XLSX.utils.book_append_sheet(book, sheetFor(subjectRows, GROUP_COLUMNS('Subject')), 'By subject')

  XLSX.writeFile(book, completionExportFilename(schoolId, 'xlsx', filtered))
  return { summaryRows: summaryRows.length, detailRows: detailRows.length }
}

export function downloadAapCompletionCsv(schoolId, rows, { filtered = false } = {}) {
  const summaryRows = buildSummaryRows(rows)
  downloadCsv(completionExportFilename(schoolId, 'csv', filtered), toCsv(summaryRows, SUMMARY_COLUMNS))
  return { summaryRows: summaryRows.length }
}

export function downloadAapPendingCsv(schoolId, rows, { filtered = false } = {}) {
  const detailRows = buildDetailRows(rows)
  const name = completionExportFilename(schoolId, 'csv', filtered).replace('AAP_survey_completion_', 'AAP_pending_students_')
  downloadCsv(name, toCsv(detailRows, DETAIL_COLUMNS))
  return { detailRows: detailRows.length }
}
