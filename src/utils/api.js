import { httpsCallable } from 'firebase/functions'
import { functions } from '../firebase/config'

const API_KEY = '9421060748'

const URLS = {
  quotation:        'https://asia-south1-clarified-1501.cloudfunctions.net/generate_quotation',
  quotation_sheet2: 'https://asia-south1-clarified-1501.cloudfunctions.net/generate_quotation_sheet2',
  invoice:          'https://asia-south1-clarified-1501.cloudfunctions.net/generate_invoice',
  agreement:        'https://asia-south1-clarified-1501.cloudfunctions.net/generate_agreement',
  onboarding:       'https://generate-onboarding-q2w4pdi2ha-el.a.run.app',
  pendingLetter:    'https://asia-south1-clarified-1501.cloudfunctions.net/generate_pending_letter',
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


// ── Onboarding Document ───────────────────────────────────────────────────────
export async function generateOnboardingPDF(school, activeYear) {
  const res = await callCF(URLS.onboarding, {
    schoolName:   school.name,
    city:         school.city || '',
    academicYear: activeYear || '2026-27',
  })
  const blob = await res.blob()
  downloadBlob(blob, `Onboarding_${school.name}_${activeYear || '2026-27'}.pdf`)
}

// ── Import extraction + commit ────────────────────────────────────────────────
// Both are Firebase callable functions (httpsCallable), not raw fetch(): the
// callable protocol handles CORS/preflight itself and forwards the signed-in
// user's Firebase Auth ID token as req.auth, which process_import/commit_import
// verify server-side against the ops-admin allowlist. The region MUST match
// where the functions are deployed (asia-south1, see ../firebase/config.js) —
// a wrong or missing region silently targets us-central1 and looks exactly
// like a CORS failure in the browser.
const processImportCallable = httpsCallable(functions, 'process_import', { timeout: 540_000 })
const commitImportCallable = httpsCallable(functions, 'commit_import', { timeout: 120_000 })

export async function startProcessImport({ schoolId, jobId, entity, files }) {
  const res = await processImportCallable({ schoolId, jobId, entity, files })
  return res.data
}

export async function commitImportRemote({ schoolId, jobId, entity, items, overwriteExisting }) {
  const res = await commitImportCallable({ schoolId, jobId, entity, items, overwriteExisting })
  return res.data
}

// ── Pending Items letter ────────────────────────────────────────────────────
// Same raw-fetch + blob pattern as invoice/agreement, not a callable — the
// function is stateless (no Firestore/Storage access) and only ever returns
// a PDF. The item list is rendered verbatim server-side from `items`; the
// LLM there only drafts the intro/closing prose (see functions/
// generate_pending_letter/main.py's module docstring).
export async function generatePendingLetterPDF({ schoolName, contactName, contactDesignation, items, date }) {
  const res = await callCF(URLS.pendingLetter, { schoolName, contactName, contactDesignation, items, date })
  const blob = await res.blob()
  const safe = slugify(schoolName)
  const yyyymmdd = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  downloadBlob(blob, `pending-items-${safe}-${yyyymmdd}.pdf`)
}

function slugify(text) {
  return (text || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'school'
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
