/**
 * AAP remarks as an Excel file a TEACHER can read — the file that goes back
 * to the school, as opposed to aapExport.js's wide CSV (one row per child,
 * five columns per subject) which suits a mail-merge but not a person.
 *
 *   Read me          what the traits, levels and statuses mean, and what is in
 *                    the file
 *   Summary          one line per class: students, remarks, approved, to
 *                    review, children with no ratings yet
 *   <one per class>  the class as a teacher reads it: a block per child (roll
 *                    and name merged down the block), one row per subject,
 *                    levels colour-coded, the remark wrapped in full, printable
 *                    on landscape A4 with the header repeated on every page
 *   All remarks      the same data flat, one row per child x subject, with a
 *                    filter on every column — for sorting and checking, and
 *                    for anyone who needs Student ID or the curricular goals
 *
 * Styling needs exceljs (SheetJS community writes no styles), which is passed
 * in rather than imported so the dashboard can load it only when a download
 * is asked for, and tools/check_aap_export.mjs can drive this from Node.
 */

export const TRAIT_ORDER = ['awareness', 'sensitivity', 'creativity']
export const TRAIT_LABEL = { awareness: 'Awareness', sensitivity: 'Sensitivity', creativity: 'Creativity' }

/** What each trait looks at — shown on the Read me sheet. */
export const TRAIT_HELP = {
  awareness: 'Understands the ideas of the subject and connects them to everyday life.',
  sensitivity: 'Shows care, empathy and respect for others and their surroundings.',
  creativity: 'Brings original ideas, imagination and their own way of expressing things.',
}

export const LEVELS = ['Beginner', 'Proficient', 'Advanced']
export const LEVEL_HELP = {
  Beginner: 'Beginning to show this — growing with support.',
  Proficient: 'Shows this regularly and with confidence.',
  Advanced: 'Shows this strongly and goes beyond what is expected.',
}
// Same families as the dashboard's level chips, lightened for print.
const LEVEL_COLOURS = {
  Beginner: { fill: 'FFFEF3C7', font: 'FF92400E' },
  Proficient: { fill: 'FFDBEAFE', font: 'FF1E40AF' },
  Advanced: { fill: 'FFDCFCE7', font: 'FF166534' },
}

const NAVY = 'FF1C3A5E'
const BORDER = 'FFD6DBE0'
const BAND = 'FFF8FAFC'      // every other child, so blocks read apart
const MUTED = 'FF64748B'

export function statusLabel(status) {
  return status === 'approved' ? 'Approved' : 'To review'
}

/** "1_ASHOKA" -> the class's display label when one is known. */
function labelFor(classes, classId) {
  return classes.find(c => c.id === classId)?.label || String(classId || '').replace(/_/g, ' ')
}

/**
 * The class sheet's content, before any styling: a block per child in roster
 * order, each with that child's remarks in subject order. A child with no
 * remarks keeps a block (with no rows) — "who is missing" is one of the
 * things this file is opened to find out.
 */
export function classBlocks(students, remarksByStudent) {
  return (students || []).map(student => ({
    student,
    remarks: [...(remarksByStudent?.[student.id] || [])].sort((a, b) => a.id.localeCompare(b.id)),
  }))
}

/** One Summary row per class that has anyone on its roster. */
export function classSummaryRows(classes, students, remarksByStudent) {
  return classes.map(cls => {
    const roster = students.filter(s => s.classId === cls.id)
    const remarks = roster.flatMap(s => remarksByStudent?.[s.id] || [])
    const approved = remarks.filter(r => r.status === 'approved').length
    return {
      Class: cls.label || cls.id,
      Students: roster.length,
      'Students with remarks': roster.filter(s => (remarksByStudent?.[s.id] || []).length).length,
      'No ratings yet': roster.filter(s => !(remarksByStudent?.[s.id] || []).length).length,
      Remarks: remarks.length,
      Approved: approved,
      'To review': remarks.length - approved,
    }
  }).filter(r => r.Students)
}

/** A wrapped remark's line count at a given column width, for row heights —
 *  exceljs cannot auto-fit, and Excel does not re-measure on open. */
export function estimateLines(text, columnWidth) {
  const perLine = Math.max(10, Math.floor(columnWidth * 1.15))
  return String(text || '').split('\n')
    .reduce((n, para) => n + Math.max(1, Math.ceil(para.length / perLine)), 0)
}

/** Excel sheet names: at most 31 characters, none of []:*?/\, unique. */
export function sheetName(label, used) {
  const base = String(label || 'Class').replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31) || 'Class'
  let name = base
  for (let i = 2; used.has(name.toLowerCase()); i++) {
    const suffix = ` (${i})`
    name = base.slice(0, 31 - suffix.length) + suffix
  }
  used.add(name.toLowerCase())
  return name
}

// ── Styling helpers ─────────────────────────────────────────────────────────
const thin = { style: 'thin', color: { argb: BORDER } }
const allThin = { top: thin, left: thin, bottom: thin, right: thin }
const solid = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } })

function styleHeader(row) {
  row.eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
    cell.fill = solid(NAVY)
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
    cell.border = allThin
  })
  row.height = 22
}

function styleLevel(cell, level) {
  const c = LEVEL_COLOURS[level]
  cell.alignment = { vertical: 'middle', horizontal: 'center' }
  if (!c) return
  cell.fill = solid(c.fill)
  cell.font = { bold: true, color: { argb: c.font } }
}

function styleStatus(cell, status) {
  cell.alignment = { vertical: 'middle', horizontal: 'center' }
  cell.font = status === 'approved'
    ? { bold: true, color: { argb: 'FF166534' } }
    : { color: { argb: 'FFB45309' } }
}

function titleRows(ws, lastCol, title, subtitle) {
  ws.mergeCells(1, 1, 1, lastCol)
  const t = ws.getCell(1, 1)
  t.value = title
  t.font = { bold: true, size: 15, color: { argb: NAVY } }
  t.alignment = { vertical: 'middle' }
  ws.getRow(1).height = 26
  ws.mergeCells(2, 1, 2, lastCol)
  const s = ws.getCell(2, 1)
  s.value = subtitle
  s.font = { italic: true, color: { argb: MUTED } }
}

function printSetup(ws, headerRow, landscape = true) {
  ws.pageSetup = {
    paperSize: 9, orientation: landscape ? 'landscape' : 'portrait',
    fitToPage: true, fitToWidth: 1, fitToHeight: 0,
    margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
    printTitlesRow: `${headerRow}:${headerRow}`,
  }
  ws.headerFooter = { oddFooter: '&L&8&A&R&8Page &P of &N' }
}

// ── Sheets ──────────────────────────────────────────────────────────────────
const CLASS_COLUMNS = [
  { header: 'Roll No', width: 8 },
  { header: 'Student', width: 26 },
  { header: 'Subject', width: 16 },
  { header: 'Awareness', width: 13 },
  { header: 'Sensitivity', width: 13 },
  { header: 'Creativity', width: 13 },
  { header: 'Remark', width: 78 },
  { header: 'Status', width: 12 },
]
const REMARK_COL = 7

function addClassSheet(wb, name, cls, blocks, meta) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 3, xSplit: 2 }] })
  ws.columns = CLASS_COLUMNS.map(c => ({ width: c.width }))
  const withRemarks = blocks.filter(b => b.remarks.length).length
  titleRows(ws, CLASS_COLUMNS.length, `AAP Remarks — Class ${cls.label || cls.id}`,
    `${meta.schoolName} · ${blocks.length} students (${withRemarks} with remarks) · ${meta.dateLabel}`
    + (meta.approvedOnly ? ' · approved remarks only' : ''))
  styleHeader(ws.addRow(CLASS_COLUMNS.map(c => c.header)))

  blocks.forEach((block, i) => {
    const { student, remarks } = block
    const band = i % 2 ? BAND : null
    const first = ws.rowCount + 1
    const rows = remarks.length ? remarks : [null]
    for (const remark of rows) {
      const row = ws.addRow([
        student.rollNo || '', student.name || student.id,
        remark ? remark.id : '',
        remark?.awareness || '', remark?.sensitivity || '', remark?.creativity || '',
        remark ? (remark.comment || '') : 'No AAP ratings yet for this student.',
        remark ? statusLabel(remark.status) : '',
      ])
      row.eachCell({ includeEmpty: true }, (cell, col) => {
        cell.border = allThin
        cell.alignment = { vertical: 'middle', wrapText: col === REMARK_COL || col === 2 }
        if (band) cell.fill = solid(band)
      })
      row.getCell(1).alignment = { vertical: 'middle', horizontal: 'center' }
      row.getCell(3).font = { bold: true }
      if (remark) {
        TRAIT_ORDER.forEach((t, k) => styleLevel(row.getCell(4 + k), remark[t]))
        styleStatus(row.getCell(8), remark.status)
        row.getCell(REMARK_COL).alignment = { vertical: 'top', wrapText: true }
      } else {
        row.getCell(REMARK_COL).font = { italic: true, color: { argb: MUTED } }
      }
      row.height = Math.max(20, estimateLines(row.getCell(REMARK_COL).value, CLASS_COLUMNS[REMARK_COL - 1].width) * 15 + 6)
    }
    const last = ws.rowCount
    // Roll and name once per child, down the whole block.
    if (last > first) {
      ws.mergeCells(first, 1, last, 1)
      ws.mergeCells(first, 2, last, 2)
    }
    ws.getCell(first, 2).font = { bold: true }
    // A heavier rule where one child's block starts.
    for (let c = 1; c <= CLASS_COLUMNS.length; c++) {
      ws.getCell(first, c).border = { ...allThin, top: { style: 'medium', color: { argb: 'FF94A3B8' } } }
    }
  })
  printSetup(ws, 3)
  return ws
}

function addReadMe(wb, meta, classes) {
  const ws = wb.addWorksheet('Read me')
  ws.columns = [{ width: 18 }, { width: 90 }]
  titleRows(ws, 2, 'AAP Remarks — Awareness · Sensitivity · Creativity',
    `${meta.schoolName} · ${meta.dateLabel}`)
  const section = (text) => {
    ws.addRow([])
    const r = ws.addRow([text])
    ws.mergeCells(r.number, 1, r.number, 2)
    r.getCell(1).font = { bold: true, size: 12, color: { argb: NAVY } }
  }
  const line = (a, b, style) => {
    const r = ws.addRow([a, b])
    r.getCell(1).font = { bold: true }
    r.getCell(2).alignment = { wrapText: true, vertical: 'top' }
    r.getCell(1).alignment = { vertical: 'top' }
    if (style) style(r)
    return r
  }

  section('What is in this file')
  line('Summary', 'One line per class: how many students, how many remarks, and how many are approved.')
  line('Class sheets', 'One sheet per class. Each student has a block with one row per subject: the three '
    + 'levels and the remark written for that subject.')
  line('All remarks', 'Every remark in one list with a filter on each column — handy for sorting or checking.')
  line('Classes', classes.map(c => c.label || c.id).join(', '))
  if (meta.approvedOnly) line('Note', 'Only remarks already approved are included.')

  section('The three abilities')
  for (const t of TRAIT_ORDER) line(TRAIT_LABEL[t], TRAIT_HELP[t])

  section('Levels')
  for (const level of LEVELS) line(level, LEVEL_HELP[level], r => styleLevel(r.getCell(1), level))

  section('Status')
  line('Approved', 'Checked and ready for the report card.', r => styleStatus(r.getCell(1), 'approved'))
  line('To review', 'Written but not yet checked — please read it and suggest any changes.',
    r => styleStatus(r.getCell(1), 'needs_review'))
  printSetup(ws, 1, false)
}

function addSummary(wb, rows, meta) {
  const headers = ['Class', 'Students', 'Students with remarks', 'No ratings yet', 'Remarks', 'Approved', 'To review']
  const ws = wb.addWorksheet('Summary', { views: [{ state: 'frozen', ySplit: 3 }] })
  ws.columns = headers.map((h, i) => ({ width: i ? 14 : 18 }))
  titleRows(ws, headers.length, 'Summary by class', `${meta.schoolName} · ${meta.dateLabel}`)
  const head = ws.addRow(headers)
  styleHeader(head)
  head.height = 34   // "Students with remarks" wraps to two lines
  const addLine = (r, bold) => {
    const row = ws.addRow(headers.map(h => r[h]))
    row.eachCell(cell => {
      cell.border = allThin
      cell.alignment = { horizontal: 'center' }
      if (bold) { cell.font = { bold: true }; cell.fill = solid('FFF1F5F9') }
    })
    row.getCell(1).alignment = { horizontal: 'left' }
    // Draw the eye to the two numbers someone acts on.
    if (r['No ratings yet']) row.getCell(4).font = { bold: true, color: { argb: 'FFB45309' } }
    if (r['To review']) row.getCell(7).font = { bold: true, color: { argb: 'FFB45309' } }
  }
  rows.forEach(r => addLine(r))
  if (rows.length > 1) {
    const total = { Class: 'All classes' }
    for (const h of headers.slice(1)) total[h] = rows.reduce((n, r) => n + r[h], 0)
    addLine(total, true)
  }
  printSetup(ws, 3, false)
}

const DATA_COLUMNS = [
  ['Class', 12], ['Roll No', 8], ['Student', 26], ['Student ID', 12], ['Subject', 14],
  ['Awareness', 12], ['Sensitivity', 12], ['Creativity', 12], ['Remark', 70], ['Words', 8],
  ['Status', 11], ['Topics', 16], ['Curricular goals', 40], ['Competencies', 50],
]

function addData(wb, classes, blocksByClass) {
  const ws = wb.addWorksheet('All remarks', { views: [{ state: 'frozen', ySplit: 1, xSplit: 3 }] })
  ws.columns = DATA_COLUMNS.map(([, width]) => ({ width }))
  styleHeader(ws.addRow(DATA_COLUMNS.map(([h]) => h)))
  for (const cls of classes) {
    for (const { student, remarks } of blocksByClass.get(cls.id) || []) {
      for (const r of remarks) {
        const row = ws.addRow([
          cls.label || cls.id, student.rollNo || '', student.name || student.id, student.id, r.id,
          r.awareness || '', r.sensitivity || '', r.creativity || '', r.comment || '',
          String(r.comment || '').trim().split(/\s+/).filter(Boolean).length,
          statusLabel(r.status), (r.topics || []).join(' + '),
          (r.curricularGoals || []).join('; '), (r.competencies || []).join('; '),
        ])
        row.alignment = { vertical: 'top', wrapText: true }
        TRAIT_ORDER.forEach((t, k) => styleLevel(row.getCell(6 + k), r[t]))
        styleStatus(row.getCell(11), r.status)
      }
    }
  }
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, ws.rowCount), column: DATA_COLUMNS.length } }
}

/**
 * @param ExcelJS          the exceljs module (default export)
 * @param schoolName       shown in every sheet's subtitle
 * @param classes          [{ id, label }] in sheet order
 * @param students         roster rows, each with classId
 * @param remarksByStudent { studentId: [remark docs] } — already filtered
 *                         when approvedOnly
 */
export function buildTeacherWorkbook(ExcelJS, {
  schoolName, classes, students, remarksByStudent, approvedOnly = false, date = new Date(),
}) {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'ClarifiEd ops dashboard'
  wb.created = date
  const meta = {
    schoolName: schoolName || '',
    approvedOnly,
    dateLabel: date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }),
  }
  const withStudents = classes
    .map(c => ({ ...c, label: c.label || labelFor(classes, c.id) }))
    .filter(c => students.some(s => s.classId === c.id))
  const blocksByClass = new Map(withStudents.map(c =>
    [c.id, classBlocks(students.filter(s => s.classId === c.id), remarksByStudent)]))

  addReadMe(wb, meta, withStudents)
  addSummary(wb, classSummaryRows(withStudents, students, remarksByStudent), meta)
  const used = new Set(['read me', 'summary', 'all remarks'])
  for (const cls of withStudents) {
    addClassSheet(wb, sheetName(cls.label, used), cls, blocksByClass.get(cls.id), meta)
  }
  addData(wb, withStudents, blocksByClass)
  // Open on the first class sheet — that is what a teacher came for.
  wb.views = [{ activeTab: Math.min(2, wb.worksheets.length - 1) }]
  return wb
}
