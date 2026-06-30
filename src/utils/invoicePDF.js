import jsPDF from 'jspdf'

// ─── Constants ────────────────────────────────────────────────────────────────
const COMPANY = {
  name: 'Scratchpad Labs Pvt Ltd',
  address: 'Saroornagar, Hyderabad, Telangana, India - 500079.',
  phone: '+919421060748',
  email: 'scratchpadlabs@gmail.com',
  web: 'www.scratchpadlabs.com',
  udyam: 'UDYAM-TS-09-0017913',
}

const BANK = {
  bank: 'HDFC Bank',
  accountName: 'SCRATCHPAD LABS PVT LTD',
  accountNumber: '50200055780209',
  ifsc: 'HDFC0004111',
  branch: 'HASTINAPURAM, HYDERABAD, TELANGANA',
}

const TERMS = [
  'All payments must be made to the account details provided.',
  'If there are any discrepancies, please contact us within 7 days of receiving this invoice.',
  'No refunds will be provided once the service has been delivered.',
  'As a registered MSME under Udyam, payment is expected within 45 days as per MSMED Act.',
]

const BEIGE = [245, 240, 220]   // header bg
const DARK  = [45, 52, 70]      // payment section bg
const BLACK = [15, 15, 15]
const GRAY  = [100, 100, 100]
const WHITE = [255, 255, 255]
const LIGHT_GRAY = [220, 220, 220]

// ─── Helper ───────────────────────────────────────────────────────────────────
function hex(doc, color) {
  doc.setTextColor(...color)
}

function setFont(doc, style = 'normal', size = 10) {
  doc.setFontSize(size)
  doc.setFont('helvetica', style)
}

function rupee(amount) {
  return 'Rs. ' + Number(amount).toLocaleString('en-IN')
}

// ─── Main generator ───────────────────────────────────────────────────────────
export function generateInvoicePDF(invoice) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const W = 210
  const margin = 14

  // ── HEADER BACKGROUND (beige) ──────────────────────────────────────────────
  doc.setFillColor(...BEIGE)
  doc.rect(0, 0, W, 52, 'F')

  // ClarifiEd logo text (bold, styled)
  doc.setFillColor(...BLACK)
  setFont(doc, 'bold', 18)
  hex(doc, BLACK)
  doc.text('ClarifiEd', margin, 14)

  setFont(doc, 'normal', 7)
  hex(doc, GRAY)
  doc.text('By ScratchPAD Labs', margin, 19)

  // Company details
  setFont(doc, 'bold', 10)
  hex(doc, BLACK)
  doc.text(COMPANY.name, margin, 27)

  setFont(doc, 'normal', 8)
  hex(doc, GRAY)
  doc.text(COMPANY.address, margin, 32)
  doc.text(COMPANY.phone, margin, 36.5)
  doc.text(COMPANY.email, margin, 41)
  doc.text(COMPANY.web, margin, 45.5)
  doc.text('UDYAM Registration Number: ' + COMPANY.udyam, margin, 50)

  // BIG "INVOICE" text top right
  setFont(doc, 'bold', 38)
  hex(doc, BLACK)
  doc.text('INVOICE', W - margin, 32, { align: 'right' })

  // ── DATE ──────────────────────────────────────────────────────────────────
  setFont(doc, 'normal', 9)
  hex(doc, BLACK)
  const dateStr = formatDate(invoice.created_at || new Date())
  doc.text('Date: ' + dateStr, W - margin, 60, { align: 'right' })

  // ── BILLED TO ─────────────────────────────────────────────────────────────
  setFont(doc, 'bold', 20)
  hex(doc, BLACK)
  doc.text('Billed To:', margin, 70)

  // Fields
  const fields = [
    ['Customer Name', invoice.school_name],
    ['Address',       invoice.school_address || ''],
    ['Phone',         invoice.school_phone || ''],
    ['Invoice Number', invoice.invoice_number],
  ]

  setFont(doc, 'normal', 9)
  let fy = 80
  fields.forEach(([label, value]) => {
    hex(doc, GRAY)
    doc.text(label, margin, fy)
    hex(doc, BLACK)
    doc.text(': ' + (value || ''), margin + 32, fy)
    fy += 6
  })

  // ── LINE ITEMS TABLE ───────────────────────────────────────────────────────
  const tableTop = 110
  const tableLeft = margin
  const tableRight = W - margin
  const tableW = tableRight - tableLeft
  const rowH = 10

  // Table header background (rounded pill look via rect)
  doc.setFillColor(...BLACK)
  doc.roundedRect(tableLeft, tableTop, tableW, rowH, 3, 3, 'F')

  // Header text
  setFont(doc, 'bold', 9)
  hex(doc, WHITE)
  doc.text('Description',  tableLeft + 4,        tableTop + 6.5)
  doc.text('Price',        tableLeft + 92,        tableTop + 6.5, { align: 'center' })
  doc.text('Quantity',     tableLeft + 128,       tableTop + 6.5, { align: 'center' })
  doc.text('Amount',       tableRight - 4,        tableTop + 6.5, { align: 'right' })

  // Row
  const rowTop = tableTop + rowH + 2
  hex(doc, BLACK)
  setFont(doc, 'normal', 9)

  const price = invoice.price_per_student
  const qty   = invoice.quantity
  const amount = price * qty

  // Description (may be multiline)
  const descLines = doc.splitTextToSize(invoice.description, 75)
  doc.text(descLines, tableLeft + 4, rowTop + 5)

  hex(doc, BLACK)
  doc.text('Rs. ' + Number(price).toLocaleString('en-IN'), tableLeft + 92, rowTop + 5, { align: 'center' })
  doc.text(String(qty),                                   tableLeft + 128, rowTop + 5, { align: 'center' })

  setFont(doc, 'bold', 9)
  doc.text('Rs. ' + Number(amount).toLocaleString('en-IN'), tableRight - 4, rowTop + 5, { align: 'right' })

  // Divider line
  const dividerY = rowTop + 14
  doc.setDrawColor(...LIGHT_GRAY)
  doc.setLineWidth(0.3)
  doc.line(tableLeft, dividerY, tableRight, dividerY)

  // ── TOTAL BOX ──────────────────────────────────────────────────────────────
  const totalY = dividerY + 8
  doc.setFillColor(240, 240, 240)
  doc.roundedRect(tableLeft + 90, totalY, tableW - 90, 10, 3, 3, 'F')

  setFont(doc, 'bold', 10)
  hex(doc, BLACK)
  doc.text('Total', tableLeft + 120, totalY + 6.5, { align: 'center' })
  doc.text('Rs. ' + Number(amount).toLocaleString('en-IN'), tableRight - 4, totalY + 6.5, { align: 'right' })

  // ── PAYMENT DETAILS (dark section) ─────────────────────────────────────────
  const payTop = totalY + 22
  doc.setFillColor(...DARK)
  doc.rect(0, payTop, W, 42, 'F')

  setFont(doc, 'bold', 11)
  hex(doc, WHITE)
  doc.text('Payment Detail:', margin, payTop + 10)

  const bankFields = [
    ['Bank',           BANK.bank],
    ['Account Name',   BANK.accountName],
    ['Account Number', BANK.accountNumber],
    ['IFSC',          BANK.ifsc],
    ['Branch',        BANK.branch],
  ]

  setFont(doc, 'normal', 8.5)
  let by = payTop + 18
  bankFields.forEach(([label, value]) => {
    doc.setTextColor(180, 185, 200)
    doc.text(label, margin + 4, by)
    hex(doc, WHITE)
    doc.text(': ' + value, margin + 36, by)
    by += 5.2
  })

  // ── TERMS & CONDITIONS ─────────────────────────────────────────────────────
  const termsTop = payTop + 46
  setFont(doc, 'normal', 8)
  hex(doc, BLACK)
  doc.text('Terms & Conditions:', margin, termsTop)

  let ty = termsTop + 6
  TERMS.forEach(term => {
    doc.text('• ' + term, margin + 2, ty)
    ty += 5
  })

  // ── THANK YOU (bottom right) ───────────────────────────────────────────────
  const thankY = termsTop
  setFont(doc, 'bold', 14)
  hex(doc, BLACK)
  doc.text('Thank you for your business!', W - margin, thankY, { align: 'right' })

  setFont(doc, 'normal', 7.5)
  hex(doc, GRAY)
  doc.text('If you have any questions regarding this invoice, please contact us', W - margin, thankY + 6, { align: 'right' })

  return doc
}

// ─── Invoice number generator: DDMMYY + sequence ─────────────────────────────
export function generateInvoiceNumber(existingNumbers) {
  const now = new Date()
  const dd   = String(now.getDate()).padStart(2, '0')
  const mm   = String(now.getMonth() + 1).padStart(2, '0')
  const yy   = String(now.getFullYear()).slice(-2)
  const prefix = dd + mm + yy

  // Find highest sequence for today
  const todayNums = existingNumbers
    .filter(n => n && n.startsWith(prefix))
    .map(n => parseInt(n.slice(6)) || 0)

  const next = todayNums.length > 0 ? Math.max(...todayNums) + 1 : 1
  return prefix + String(next).padStart(2, '0')
}

// ─── Date formatter ───────────────────────────────────────────────────────────
function formatDate(ts) {
  const d = ts?.toDate ? ts.toDate() : new Date(ts)
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })
}
