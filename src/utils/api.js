const API_KEY = '9421060748'

const URLS = {
  quotation:        'https://asia-south1-clarified-1501.cloudfunctions.net/generate_quotation',
  quotation_sheet2: 'https://asia-south1-clarified-1501.cloudfunctions.net/generate_quotation_sheet2',
  invoice:          'https://asia-south1-clarified-1501.cloudfunctions.net/generate_invoice',
  agreement:        'https://asia-south1-clarified-1501.cloudfunctions.net/generate_agreement',
  onboarding:       'https://asia-south1-clarified-1501.cloudfunctions.net/generate_onboarding',
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
  const onlyA = q.show_a !== false && q.show_b === false
  const onlyB = q.show_a === false && q.show_b !== false
  const both  = !onlyA && !onlyB

  let res

  if (both) {
    // Two-option layout — Sheet1 background
    res = await callCF(URLS.quotation, {
      schoolName:      q.school_name,
      date:            formatDate(new Date()),
      studentCount:    q.student_count,
      printedDiscount: q.discount_a || 0,
      digitalDiscount: q.discount_b || 0,
    })
  } else {
    // Single-option layout — Sheet2 background
    const item     = onlyA ? 'Printed+Digital HPC' : 'Only Digital HPC'
    const discount = onlyA ? (q.discount_a || 0) : (q.discount_b || 0)
    res = await callCF(URLS.quotation_sheet2, {
      schoolName:   q.school_name,
      date:         formatDate(new Date()),
      studentCount: q.student_count,
      item:         item,
      discount:     discount,
    })
  }

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
    schoolName:       a.school_name,
    schoolAddress:    a.school_address || '',
    hpcType:          a.hpc_type || 'printed and digital',
    feePerStudent:    a.fee_per_student,
    studentCount:     a.student_count,
    installmentPlan:  a.installment_plan,
    agreementNumber:  a.agreement_number,
  })
  const blob = await res.blob()
  downloadBlob(blob, `Agreement_${a.school_name}_${a.agreement_number}.pdf`)
}

// ── Onboarding ────────────────────────────────────────────────────────────────
export async function generateOnboardingPDF(school, activeYear) {
  const res = await callCF(URLS.onboarding, {
    schoolName:    school.name,
    academicYear:  activeYear || '2026-27',
    city:          school.city || '',
    pocName:       school.pocs?.[0]?.name || school.contact_person || '',
    pocPhone:      school.pocs?.[0]?.phone || school.contact_phone || '',
  })
  const blob = await res.blob()
  downloadBlob(blob, `Onboarding_${school.name}_${activeYear || '2026-27'}.pdf`)
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

function formatDate(d) {
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })
}
