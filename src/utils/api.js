const API_KEY = '9421060748'

const URLS = {
  quotation:  'https://asia-south1-clarified-1501.cloudfunctions.net/generate_quotation',
  invoice:    'https://asia-south1-clarified-1501.cloudfunctions.net/generate_invoice',
  agreement:  'https://asia-south1-clarified-1501.cloudfunctions.net/generate_agreement',
}

async function callCF(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': API_KEY,
    },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Cloud Function error ${res.status}: ${text}`)
  }
  return res
}

// ── Quotation ─────────────────────────────────────────────────────────────────
export async function generateQuotationPDF(q) {
  const res = await callCF(URLS.quotation, {
    schoolName:      q.school_name,
    date:            formatDate(new Date()),
    studentCount:    q.student_count,
    printedDiscount: q.show_a ? (q.discount_a || 0) : 100, // 100% discount = hidden
    digitalDiscount: q.show_b ? (q.discount_b || 0) : 100,
  })
  const blob = await res.blob()
  downloadBlob(blob, `Quotation_${q.school_name}_${q.quotation_number}.pdf`)
}

// ── Invoice ───────────────────────────────────────────────────────────────────
export async function generateInvoicePDF(inv) {
  const res = await callCF(URLS.invoice, {
    schoolName:      inv.school_name,
    schoolAddress:   inv.school_address || '',
    schoolPhone:     inv.school_phone || '',
    invoiceNumber:   inv.invoice_number,
    description:     inv.description,
    pricePerStudent: inv.price_per_student,
    quantity:        inv.quantity,
    date:            formatDate(inv.created_at?.toDate ? inv.created_at.toDate() : new Date()),
  })
  const blob = await res.blob()
  downloadBlob(blob, `Invoice_${inv.invoice_number}_${inv.school_name}.pdf`)
}

// ── Agreement ─────────────────────────────────────────────────────────────────
export async function generateAgreementFiles(a) {
  const res = await callCF(URLS.agreement, {
    schoolName:            a.school_name,
    schoolAddress:         a.school_address || '',
    signatoryName:         a.signatory_name,
    signatoryDesignation:  a.signatory_designation || '',
    hpcType:               a.hpc_type || 'printed and digital',
    feePerStudent:         a.fee_per_student,
    studentCount:          a.student_count,
    installmentPlan:       a.installment_plan,
    agreementNumber:       a.agreement_number,
  })

  const data = await res.json()

  // Download PDF
  const pdfBytes  = base64ToBlob(data.pdf, 'application/pdf')
  downloadBlob(pdfBytes, `${data.filename}.pdf`)

  // Download DOCX
  const docxBytes = base64ToBlob(data.docx, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  downloadBlob(docxBytes, `${data.filename}.docx`)
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a   = document.createElement('a')
  a.href     = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function base64ToBlob(b64, mime) {
  const binary = atob(b64)
  const bytes  = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}

function formatDate(d) {
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })
}
