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
  'Class', 'Subject', 'Topic', 'Status', 'Why pending', 'Taught in class', 'Taught on', 'Teacher',
  'Expected Students', 'Responded Students', 'Gaps', 'Not Applicable / absent students',
  'Activity', 'Curricular Goals', 'Competencies', 'Note',
]

export const DETAIL_COLUMNS = [
  'Class', 'Subject', 'Topic', 'Student', 'Student ID', 'Question', 'Status', 'Why pending',
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

// ── "Why pending": one plain sentence a school coordinator can act on ──

const QUESTION = {
  awareness: 'Question 1 (Awareness)',
  sensitivity: 'Question 2 (Sensitivity)',
  creativity: 'Question 3 (Creativity)',
}
const TRAITS = ['awareness', 'sensitivity', 'creativity']

const andList = (items) => (items.length <= 1 ? items.join('')
  : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`)
const students = (n) => `${n} student${n === 1 ? '' : 's'}`
const shortDate = (iso) => formatDate(iso).replace(/ \d{4}$/, '')

/** Why one student is still pending on this row, in plain words. */
export function studentReason(row, gap) {
  if (row.status === 'not_started') return 'The teacher has not started this survey yet.'
  if (gap.addedAfterSurvey) {
    const on = gap.addedAt ? ` on ${shortDate(gap.addedAt)}` : ''
    return `New student: joined the class${on}, after the teacher took the survey. The teacher needs to rate this child.`
  }
  const missing = gap.missing || []
  if (missing.length === TRAITS.length) return 'The teacher did not rate this student in the survey.'
  const done = TRAITS.filter(t => !missing.includes(t)).map(t => QUESTION[t])
  return `The teacher filled ${andList(done)} but has not filled ${andList(missing.map(t => QUESTION[t]))} yet.`
}

/** Why a class/subject/topic is not Complete, in plain words ('' when it is). */
export function rowReason(r) {
  if (r.source === 'response_only') {
    return 'A survey was saved under a topic this class does not have. Check which topic it belongs to.'
  }
  if (r.status === 'complete') return ''
  if (r.status === 'not_started') {
    if (r.taught === true) {
      const on = r.completedAt ? ` on ${shortDate(r.completedAt)}` : ''
      return `The lesson was marked as taught${on}, but the teacher has not started the survey yet.`
    }
    if (r.taught === false) return 'The lesson is not marked as taught yet, so the survey has not started.'
    return 'The teacher has not started this survey yet.'
  }
  const gaps = r.gaps || []
  const parts = []
  const newKids = gaps.filter(g => g.addedAfterSurvey)
  const others = gaps.filter(g => !g.addedAfterSurvey)
  // Students missing the same questions are described together.
  const groups = new Map()
  for (const g of others) {
    const key = (g.missing || []).join(',')
    groups.set(key, [...(groups.get(key) || []), g])
  }
  for (const [key, list] of groups) {
    const missing = key.split(',').filter(Boolean)
    if (missing.length === TRAITS.length) {
      parts.push(`${students(list.length)} not rated at all.`)
    } else if (missing.join(',') === 'sensitivity,creativity' && list.length === others.length
        && r.respondedStudents <= (r.notApplicable || 0)) {
      // Nobody (apart from absent / N.A. children) got past question 1.
      parts.push('The teacher filled only Question 1 (Awareness) and stopped. '
        + 'Question 2 (Sensitivity) and Question 3 (Creativity) are blank for every student.')
    } else {
      parts.push(`${students(list.length)}: ${andList(missing.map(t => QUESTION[t]))} not filled.`)
    }
  }
  if (newKids.length) {
    const dates = [...new Set(newKids.map(g => g.addedAt && shortDate(g.addedAt)).filter(Boolean))]
    const on = dates.length ? ` on ${andList(dates)}` : ''
    parts.push(`${students(newKids.length)} joined the class${on}, after the survey was done. The teacher needs to rate ${newKids.length === 1 ? 'this child' : 'them'}.`)
  }
  return parts.join(' ')
}

export function buildSummaryRows(rows) {
  return (rows || []).map(r => ({
    Class: r.classId,
    Subject: r.subject,
    Topic: r.topic || '—',
    Status: STATUS_LABEL[r.status] || r.status,
    'Why pending': rowReason(r),
    'Taught in class': taughtLabel(r),
    'Taught on': formatDate(r.completedAt),
    Teacher: r.teacherId || '',
    'Expected Students': r.expectedStudents,
    'Responded Students': r.respondedStudents,
    Gaps: r.gaps?.length || 0,
    'Not Applicable / absent students': r.notApplicable || 0,
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
          'Why pending': studentReason(r, gap),
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
  return columns.map(column => ({ wch: column === 'Why pending' ? 90 : Math.max(12, column.length + 4) }))
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
