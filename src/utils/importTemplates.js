/**
 * Sample import templates for the New School wizard's Teachers & Students step.
 *
 * The headers here are taken from STUDENT_HEADER_ALIASES in
 * functions/generate_import/normalize.py — the canonical spelling of each
 * field the importer recognizes. They are a STARTING POINT, not a
 * requirement: the importer matches dozens of aliases per field ("Class",
 * "Std", "Standard" all reach `grade`), tolerates junk rows above the header,
 * merged header rows, and mixed formats. The templates exist so a school that
 * asks "what format do you want?" gets a concrete answer.
 *
 * Only `student_name` is genuinely required. Everything else improves what
 * the dashboard can do but never blocks an import.
 */

export const STUDENT_COLUMNS = [
  { key: 'Name', required: true, note: 'The only required column' },
  { key: 'Class', required: false, note: 'I / 1 / Grade 1 — any notation' },
  { key: 'Section', required: false, note: 'A, B, Diamond, Rose…' },
  { key: 'Roll No', required: false, note: '' },
  { key: 'Admission No', required: false, note: 'Also accepted as GR No' },
  { key: 'Gender', required: false, note: '' },
  { key: 'DOB', required: false, note: 'Excel dates are converted' },
  { key: "Father's Name", required: false, note: '' },
  { key: "Mother's Name", required: false, note: '' },
  { key: 'Contact', required: false, note: 'Mobile / phone' },
  { key: 'Email', required: false, note: '' },
]

export const TEACHER_COLUMNS = [
  { key: 'Name', required: true, note: 'The only required column' },
  { key: 'Email', required: false, note: 'Used for their app login' },
  { key: 'Contact', required: false, note: '' },
  { key: 'Class', required: false, note: 'Class teacher of, if any' },
  { key: 'Section', required: false, note: '' },
  { key: 'Subjects', required: false, note: 'Comma-separated is fine' },
  { key: 'Designation', required: false, note: '' },
]

const STUDENT_SAMPLE = [
  ['Aditya Kulkarni', 'I', 'A', '1', 'ADM1001', 'M', '12/04/2018',
   'Ramesh Kulkarni', 'Sunita Kulkarni', '9876543210', ''],
  ['Sneha Patil', 'I', 'A', '2', 'ADM1002', 'F', '03/09/2018',
   'Mahesh Patil', 'Kavita Patil', '9876543211', ''],
  ['Rohan Deshmukh', 'II', 'B', '1', 'ADM0987', 'M', '21/11/2017',
   'Suresh Deshmukh', 'Anita Deshmukh', '9876543212', ''],
]

const TEACHER_SAMPLE = [
  ['Priya Sharma', 'priya@example.com', '9876500001', 'I', 'A', 'English, EVS', 'Class Teacher'],
  ['Anil Joshi', 'anil@example.com', '9876500002', 'II', 'B', 'Mathematics', 'Class Teacher'],
  ['Meera Rao', 'meera@example.com', '9876500003', '', '', 'Music', 'Subject Teacher'],
]

function csvCell(value) {
  const s = String(value ?? '')
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function toCsv(columns, rows) {
  return [columns.map(c => csvCell(c.key)).join(','),
    ...rows.map(r => r.map(csvCell).join(','))].join('\n')
}

export function studentTemplateCsv() {
  return toCsv(STUDENT_COLUMNS, STUDENT_SAMPLE)
}

export function teacherTemplateCsv() {
  return toCsv(TEACHER_COLUMNS, TEACHER_SAMPLE)
}

export function downloadCsv(filename, content) {
  // A BOM so Excel opens UTF-8 names (Marathi/Devanagari) correctly rather
  // than as mojibake — these files go to schools, who open them in Excel.
  const blob = new Blob(['﻿' + content], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
