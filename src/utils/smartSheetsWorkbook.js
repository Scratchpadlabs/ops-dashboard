/**
 * Writes smart_sheets_export's tables (functions/sheets_overview/sheet_tables.py)
 * to Excel: one consolidated workbook with a sheet per class, or one workbook
 * per class (zipped when there is more than one).
 *
 * Each table is { className, header: [[...]], merges: [[r1, c1, r2, c2]], rows: [[...]] }
 * — already laid out like the teacher app's own export, so this only styles it.
 */
import { deliverFile } from './deliverFile.js'
import { sheetName } from './aapTeacherWorkbook.js'

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const IDENTITY_COLS = 5   // ID, Admission No., GR/EMIS No., Roll No., Student Name

export const REPORT_KINDS = [
  { value: 'academics', label: 'Academics', needsTerm: true, file: 'Academics' },
  { value: 'co-scholastic', label: 'Co-Scholastic', needsTerm: true, file: 'CoScholastic' },
  { value: 'attendance', label: 'Attendance (month-wise)', needsTerm: false, file: 'Attendance_Monthwise' },
]

function addTableSheet(wb, name, table) {
  const headerRows = table.header.length
  const ws = wb.addWorksheet(name, {
    views: [{ state: 'frozen', xSplit: IDENTITY_COLS, ySplit: headerRows }],
  })
  for (const row of [...table.header, ...table.rows]) ws.addRow(row)
  for (const [r1, c1, r2, c2] of table.merges || []) ws.mergeCells(r1 + 1, c1 + 1, r2 + 1, c2 + 1)
  for (let r = 1; r <= headerRows; r++) {
    const row = ws.getRow(r)
    row.font = { bold: true }
    row.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
    row.eachCell({ includeEmpty: true }, cell => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: r === 1 ? 'FFDBEAFE' : 'FFF1F5F9' } }
      cell.border = { bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } } }
    })
  }
  const width = table.header[0]?.length || 0
  for (let c = 1; c <= width; c++) {
    ws.getColumn(c).width = c === 5 ? 28 : c <= IDENTITY_COLS ? 14 : 16
  }
}

function safe(text) {
  return String(text || '').trim().replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '')
}

function filename(parts, ext) {
  const today = new Date().toISOString().slice(0, 10)
  return `${parts.filter(Boolean).map(safe).filter(Boolean).join('_')}_${today}.${ext}`
}

/**
 * @param kind      one of REPORT_KINDS' values
 * @param tables    smart_sheets_export's `classes`
 * @param perClass  false: one workbook, a sheet per class; true: a workbook per class
 * @returns { files, status: 'downloaded' | 'pending' }
 */
export async function downloadSmartSheetsReport({ schoolName, kind, termName, tables, perClass = false }) {
  const { default: ExcelJS } = await import('exceljs')
  const label = REPORT_KINDS.find(k => k.value === kind)?.file || kind
  const book = (list) => {
    const wb = new ExcelJS.Workbook()
    wb.creator = 'ClarifiEd ops dashboard'
    const used = new Set()
    for (const t of list) addTableSheet(wb, sheetName(t.className, used), t)
    return wb.xlsx.writeBuffer()
  }

  if (!perClass) {
    const scope = tables.length === 1 ? tables[0].className : `${tables.length}_classes`
    const blob = new Blob([await book(tables)], { type: XLSX_MIME })
    return { files: 1, status: deliverFile(blob, filename([schoolName, 'Consolidated', label, termName, scope], 'xlsx')) }
  }

  const files = []
  for (const t of tables) {
    files.push({ name: filename([schoolName, t.className, label, termName], 'xlsx'), buffer: await book([t]) })
  }
  if (files.length === 1) {
    return { files: 1, status: deliverFile(new Blob([files[0].buffer], { type: XLSX_MIME }), files[0].name) }
  }
  const { default: JSZip } = await import('jszip')
  const zip = new JSZip()
  for (const f of files) zip.file(f.name, f.buffer)
  const blob = await zip.generateAsync({ type: 'blob', mimeType: 'application/zip' })
  return { files: files.length, status: deliverFile(blob, filename([schoolName, label, termName, `${files.length}_classes`], 'zip')) }
}
