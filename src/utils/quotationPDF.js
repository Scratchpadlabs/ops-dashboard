import jsPDF from 'jspdf'

// ─── Constants ────────────────────────────────────────────────────────────────
const COMPANY = {
  name:    'SCRATCHPAD LABS PVT LTD',
  address: 'SCEI, Sus, Pune',
  phone:   '+91-9421060748',
  email:   'team@scratchpadlabs.com',
  web:     'www.scratchpadlabs.com',
}

const MRP = {
  A: 299,
  B: 169,
}

const ACADEMIC_YEAR = '2026-27'

// ─── Colors ───────────────────────────────────────────────────────────────────
const GREEN       = [76, 175, 80]
const GREEN_DARK  = [46, 125, 50]
const GREEN_LIGHT = [232, 245, 233]
const BLACK       = [15, 15, 15]
const WHITE       = [255, 255, 255]
const GRAY        = [100, 100, 100]
const YELLOW      = [255, 193, 7]
const DARK_GREEN  = [27, 94, 32]

// ─── Helpers ──────────────────────────────────────────────────────────────────
function rgb(doc, ...color) { doc.setTextColor(...color) }
function fill(doc, ...color) { doc.setFillColor(...color) }
function draw(doc, ...color) { doc.setDrawColor(...color) }
function setFont(doc, style = 'normal', size = 10) {
  doc.setFontSize(size)
  doc.setFont('helvetica', style)
}

// ─── Main generator ───────────────────────────────────────────────────────────
export function generateQuotationPDF(q) {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' })
  const W = 595.5
  const H = 842.25

  // ── HEADER: green gradient background ─────────────────────────────────────
  // Main green header block
  fill(doc, ...GREEN)
  doc.rect(0, 0, W, 110, 'F')

  // Darker green diagonal accent (top right)
  fill(doc, ...GREEN_DARK)
  doc.triangle(W - 180, 0, W, 0, W, 110, 'F')

  // "QUOTATION" pill (white rounded rect + black text)
  fill(doc, ...WHITE)
  doc.roundedRect(30, 18, 165, 42, 8, 8, 'F')
  setFont(doc, 'bold', 22)
  rgb(doc, ...BLACK)
  doc.text('QUOTATION', 113, 46, { align: 'center' })

  // ClarifiEd logo area (top right)
  setFont(doc, 'bold', 16)
  rgb(doc, ...WHITE)
  doc.text('ClarifiEd', W - 40, 30, { align: 'right' })
  setFont(doc, 'normal', 8)
  rgb(doc, 220, 255, 220)
  doc.text('By ScratchPAD Labs', W - 40, 44, { align: 'right' })

  // ── ACADEMIC YEAR BANNER ──────────────────────────────────────────────────
  fill(doc, ...GREEN_DARK)
  doc.rect(W - 240, 110, 240, 32, 'F')
  // small triangle to left of banner
  fill(doc, ...GREEN_DARK)
  doc.triangle(W - 260, 142, W - 240, 110, W - 240, 142, 'F')

  setFont(doc, 'bold', 13)
  rgb(doc, ...WHITE)
  doc.text(`Academic Year : ${ACADEMIC_YEAR}`, W - 36, 131, { align: 'right' })

  // ── DATE ─────────────────────────────────────────────────────────────────
  setFont(doc, 'bold', 10)
  rgb(doc, ...BLACK)
  doc.text('Date: ', 40, 152)
  setFont(doc, 'normal', 10)
  doc.text(formatDate(new Date()), 72, 152)

  // ── SCRATCHPAD LABS (left) ────────────────────────────────────────────────
  setFont(doc, 'bold', 11)
  rgb(doc, ...BLACK)
  doc.text(COMPANY.name, 40, 190)
  // Underline
  draw(doc, ...BLACK)
  doc.setLineWidth(0.8)
  doc.line(40, 193, 40 + doc.getTextWidth(COMPANY.name), 193)

  setFont(doc, 'normal', 9)
  rgb(doc, ...GRAY)
  doc.text(COMPANY.address, 40, 208)
  doc.text(COMPANY.phone,   40, 222)
  doc.text(COMPANY.email,   40, 236)
  doc.text(COMPANY.web,     40, 250)

  // ── QUOTATION FOR (right) ─────────────────────────────────────────────────
  setFont(doc, 'bold', 11)
  rgb(doc, ...BLACK)
  doc.text('QUOTATION FOR', 297, 190)
  draw(doc, ...BLACK)
  doc.setLineWidth(0.8)
  doc.line(297, 193, 297 + doc.getTextWidth('QUOTATION FOR'), 193)

  setFont(doc, 'normal', 10)
  rgb(doc, ...BLACK)
  doc.text(q.school_name || '', 297, 208)

  // ── ITEMS TABLE ───────────────────────────────────────────────────────────
  const tableTop = 310
  const tableLeft = 40
  const tableRight = W - 40
  const tableW = tableRight - tableLeft

  // Header row (rounded pill)
  fill(doc, ...BLACK)
  doc.roundedRect(tableLeft, tableTop, tableW, 28, 6, 6, 'F')

  setFont(doc, 'bold', 10)
  rgb(doc, ...WHITE)
  doc.text('ITEM',                   tableLeft + 12, tableTop + 18)
  doc.text('MRP',                    tableLeft + 185, tableTop + 14, { align: 'center' })
  doc.text('(per student per year)', tableLeft + 185, tableTop + 24, { align: 'center' })
  doc.text('INTRODUCTORY DISCOUNT',  tableLeft + 360, tableTop + 18, { align: 'center' })
  doc.text('PRICE',                  tableRight - 12, tableTop + 18, { align: 'right' })

  let rowY = tableTop + 28

  // ── Option A ──────────────────────────────────────────────────────────────
  if (q.show_a !== false) {
    // Option A label (green pill)
    fill(doc, ...GREEN_LIGHT)
    doc.roundedRect(tableLeft, rowY, 110, 20, 4, 4, 'F')
    setFont(doc, 'bold', 10)
    rgb(doc, ...DARK_GREEN)
    doc.text('Option A', tableLeft + 55, rowY + 14, { align: 'center' })
    rowY += 24

    // Option A row (rounded rect border)
    draw(doc, 200, 200, 200)
    doc.setLineWidth(0.5)
    doc.roundedRect(tableLeft, rowY, tableW, 50, 6, 6, 'S')

    setFont(doc, 'normal', 10)
    rgb(doc, ...BLACK)
    doc.text('Printed+Digital', tableLeft + 12, rowY + 18)
    doc.text('HPC',             tableLeft + 12, rowY + 34)

    setFont(doc, 'normal', 10)
    doc.text(`${MRP.A}/- Rs`, tableLeft + 185, rowY + 28, { align: 'center' })

    // Discount %
    if (q.discount_a) {
      doc.text(`${q.discount_a}%`, tableLeft + 360, rowY + 28, { align: 'center' })
    }

    // Price (green pill)
    if (q.price_a) {
      fill(doc, ...GREEN_LIGHT)
      draw(doc, ...GREEN)
      doc.setLineWidth(0.5)
      doc.roundedRect(tableRight - 80, rowY + 12, 72, 26, 6, 6, 'FD')
      setFont(doc, 'bold', 10)
      rgb(doc, ...DARK_GREEN)
      doc.text(`${q.price_a}/- Rs`, tableRight - 44, rowY + 29, { align: 'center' })
    }

    rowY += 60
  }

  // ── Option B ──────────────────────────────────────────────────────────────
  if (q.show_b !== false) {
    // Option B label (yellow pill)
    fill(doc, 255, 243, 205)
    doc.roundedRect(tableLeft, rowY, 110, 20, 4, 4, 'F')
    setFont(doc, 'bold', 10)
    rgb(doc, 120, 90, 0)
    doc.text('Option B', tableLeft + 55, rowY + 14, { align: 'center' })
    rowY += 24

    // Option B row
    draw(doc, 200, 200, 200)
    doc.setLineWidth(0.5)
    doc.roundedRect(tableLeft, rowY, tableW, 50, 6, 6, 'S')

    setFont(doc, 'normal', 10)
    rgb(doc, ...BLACK)
    doc.text('Only Digital', tableLeft + 12, rowY + 18)
    doc.text('HPC',          tableLeft + 12, rowY + 34)

    doc.text(`${MRP.B}/- Rs`, tableLeft + 185, rowY + 28, { align: 'center' })

    if (q.discount_b) {
      doc.text(`${q.discount_b}%`, tableLeft + 360, rowY + 28, { align: 'center' })
    }

    if (q.price_b) {
      fill(doc, 255, 249, 220)
      draw(doc, ...YELLOW)
      doc.setLineWidth(0.5)
      doc.roundedRect(tableRight - 80, rowY + 12, 72, 26, 6, 6, 'FD')
      setFont(doc, 'bold', 10)
      rgb(doc, 120, 90, 0)
      doc.text(`${q.price_b}/- Rs`, tableRight - 44, rowY + 29, { align: 'center' })
    }

    rowY += 60
  }

  // ── "Quotation based on: Approx. X students" ─────────────────────────────
  setFont(doc, 'bold', 12)
  rgb(doc, ...BLACK)
  doc.text('Quotation based on: Approx.', W / 2, rowY + 24, { align: 'center' })
  setFont(doc, 'normal', 12)
  doc.text(`  ${q.student_count || ''} students`, W / 2 + 2, rowY + 24)

  // ── Disclaimer box ────────────────────────────────────────────────────────
  const disclaimerY = rowY + 45
  draw(doc, ...GREEN)
  doc.setLineWidth(0.8)
  doc.roundedRect(tableLeft, disclaimerY, tableW, 28, 8, 8, 'S')
  setFont(doc, 'normal', 9)
  rgb(doc, ...BLACK)
  doc.text(
    'The pricing is inclusive of all taxes, year-round maintenance, and customisation. There are no hidden charges of any kind.',
    W / 2, disclaimerY + 17, { align: 'center', maxWidth: tableW - 20 }
  )

  // ── Contact line ──────────────────────────────────────────────────────────
  setFont(doc, 'normal', 9)
  rgb(doc, ...GRAY)
  doc.text(
    'If you have any questions, please contact us at +919421060748',
    W / 2, disclaimerY + 50, { align: 'center' }
  )

  // ── Bottom green circle (decorative) ─────────────────────────────────────
  fill(doc, ...GREEN)
  doc.circle(W / 2, H + 20, 120, 'F')

  return doc
}

// ─── Price calculator ─────────────────────────────────────────────────────────
export function calcPrice(mrp, discountPct) {
  if (!discountPct) return mrp
  return Math.round(mrp * (1 - discountPct / 100))
}

// ─── Quotation number generator ───────────────────────────────────────────────
export function generateQuotationNumber(existingNumbers) {
  const now = new Date()
  const yy = String(now.getFullYear()).slice(-2)
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const prefix = `Q-${yy}${mm}-`
  const existing = (existingNumbers || [])
    .filter(n => n && n.startsWith(prefix))
    .map(n => parseInt(n.replace(prefix, '')) || 0)
  const next = existing.length > 0 ? Math.max(...existing) + 1 : 1
  return prefix + String(next).padStart(3, '0')
}

function formatDate(d) {
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })
}
