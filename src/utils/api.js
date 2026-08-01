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
  const payload = {
    schoolName:      inv.school_name,
    schoolAddress:   inv.school_address || '',
    schoolPhone:     inv.school_phone || '',
    invoiceNumber:   inv.invoice_number,
    description:     inv.description,
    pricePerStudent: inv.price_per_student,
    quantity:        inv.quantity,
    date:            formatDate(inv.created_at?.toDate ? inv.created_at.toDate() : new Date()),
  }
  // Installment invoices render as percent × contract value instead of
  // price × quantity, plus an "invoiced to date" summary line.
  if (inv.percent != null && inv.base_amount) {
    payload.installmentLabel  = inv.installment_label || inv.installment_type || ''
    payload.percent           = inv.percent
    payload.baseAmount        = inv.base_amount
    payload.amount            = inv.amount
    payload.invoicedToDatePct = inv.invoiced_to_date_percent ?? null
  }
  const res = await callCF(URLS.invoice, payload)
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

// Education-KB LLM fallback — LAST RESORT, one call per never-before-seen
// value. Callers must check the deterministic KB first (useEducationKB.js
// does); the function itself re-checks and short-circuits rather than
// spending a model call on something already known. It returns a SUGGESTION
// and never writes to kb_entries — only a human confirming does that.
const classifyValueCallable = httpsCallable(functions, 'classify_value', { timeout: 60_000 })

export async function classifyValueRemote({ value, context }) {
  const res = await classifyValueCallable({ value, context })
  return res.data
}

// ── Survey assignment ─────────────────────────────────────────────────────
// Server-side for the reason the task gives: a 3000-student school is 3000
// reads and several batched writes, which must not depend on a browser tab
// staying open. Preview and apply are THE SAME CALL with dryRun flipped, so
// the number in the confirm dialog is the number that happens.
const assignSurveyCallable = httpsCallable(functions, 'assign_survey', { timeout: 540_000 })
const surveyOverviewCallable = httpsCallable(functions, 'survey_overview', { timeout: 120_000 })

export async function assignSurveyRemote({ schoolId, runId, surveyId, audience, mode, scope, dryRun, inboxField }) {
  const res = await assignSurveyCallable({ schoolId, runId, surveyId, audience, mode, scope, dryRun, inboxField })
  return res.data
}

export async function surveyOverviewRemote({ schoolId, inboxField }) {
  const res = await surveyOverviewCallable({ schoolId, inboxField })
  return res.data
}

export async function startProcessImport({ schoolId, jobId, entity, files }) {
  const res = await processImportCallable({ schoolId, jobId, entity, files })
  return res.data
}

export async function commitImportRemote({ schoolId, jobId, entity, items, overwriteExisting }) {
  const res = await commitImportCallable({ schoolId, jobId, entity, items, overwriteExisting })
  return res.data
}

// ── Pending Items letter (v2: draft -> edit -> render compose flow) ────────
// Same raw-fetch + blob pattern as invoice/agreement, not a callable — the
// function is stateless (no Firestore/Storage access). Two modes now:
//   draft  — LLM call only, returns {intro, closing} JSON for the dialog's
//            editable preview (see PendingLetterDialog.vue).
//   render — pure render, NO LLM call — takes the (possibly edited)
//            intro/closing/extraNote and the selected items (each optionally
//            carrying a `comment`) and returns the PDF verbatim. See
//            functions/generate_pending_letter/main.py's module docstring.
export async function draftPendingLetter({ schoolName, contactName, contactDesignation }) {
  const res = await callCF(URLS.pendingLetter, { mode: 'draft', schoolName, contactName, contactDesignation })
  return res.json()
}

export async function generatePendingLetterPDF({ schoolName, contactName, contactDesignation, items, date, intro, closing, extraNote }) {
  const res = await callCF(URLS.pendingLetter, {
    mode: 'render', schoolName, contactName, contactDesignation, items, date, intro, closing, extraNote,
  })
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
