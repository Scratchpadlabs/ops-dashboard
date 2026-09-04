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
    schoolSignatoryName:        a.signatory_name || '',
    schoolSignatoryDesignation: a.signatory_designation || '',
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
const surveyMatrixCallable = httpsCallable(functions, 'survey_matrix', { timeout: 300_000 })
const surveyReportCallable = httpsCallable(functions, 'survey_report', { timeout: 300_000 })
const classDetailCallable = httpsCallable(functions, 'class_detail', { timeout: 120_000 })

// surveyIds is a LIST: the matrix selects N surveys x M classes and assigns
// all of it as one action.
export async function assignSurveyRemote({ schoolId, runId, surveyIds, audience, mode, scope, dryRun, inboxField }) {
  const res = await assignSurveyCallable({ schoolId, runId, surveyIds, audience, mode, scope, dryRun, inboxField })
  return res.data
}

export async function surveyMatrixRemote({ schoolId, activeWindowOnly, force, inboxField }) {
  const res = await surveyMatrixCallable({ schoolId, activeWindowOnly, force, inboxField })
  return res.data
}

// Returns {filename, mime, content_base64} — the file is built server-side
// and handed back inline; downloadReport() turns it into a download.
export async function surveyReportRemote({ schoolId, scope, format, surveyIds, filters, inboxField }) {
  const res = await surveyReportCallable({ schoolId, scope, format, surveyIds, filters, inboxField })
  return res.data
}

// One class's students + who among them responded. Scoped server-side so
// the drill-down never pulls a whole school's roster to show 30 rows.
export async function classDetailRemote({ schoolId, classId, inboxField }) {
  const res = await classDetailCallable({ schoolId, classId, inboxField })
  return res.data
}

// ── Setup wizards: new school / reset school ──────────────────────────────
// All five are server-side for the same reason as survey assignment: a reset
// touches every student document, and it must not depend on a browser tab
// staying open. The split matters —
//   check_new_school / school_state / reset_preview  read only
//   archive_school                                   writes only to archives/
//   reset_execute                                    the only one that can
//                                                    touch live school data,
//                                                    and it refuses without a
//                                                    verified archive.
// reset_execute is also preview-and-apply in one call via dryRun, so the
// numbers shown in the confirm step are the numbers that happen.
const checkNewSchoolCallable = httpsCallable(functions, 'check_new_school', { timeout: 60_000 })
const schoolStateCallable = httpsCallable(functions, 'school_state', { timeout: 120_000 })
const archiveSchoolCallable = httpsCallable(functions, 'archive_school', { timeout: 540_000 })
const resetPreviewCallable = httpsCallable(functions, 'reset_preview', { timeout: 300_000 })
const resetExecuteCallable = httpsCallable(functions, 'reset_execute', { timeout: 540_000 })

export async function checkNewSchoolRemote({ schoolId, name }) {
  const res = await checkNewSchoolCallable({ schoolId, name })
  return res.data
}

export async function schoolStateRemote({ schoolId }) {
  const res = await schoolStateCallable({ schoolId })
  return res.data
}

// `label` names the session being archived (e.g. "2025-26"). The archive id is
// `${schoolId}__${label}`, so re-archiving the same session overwrites that
// snapshot rather than accumulating copies.
export async function archiveSchoolRemote({ schoolId, label }) {
  const res = await archiveSchoolCallable({ schoolId, label })
  return res.data
}

export async function resetPreviewRemote({ schoolId, options }) {
  const res = await resetPreviewCallable({ schoolId, options })
  return res.data
}

// confirmSchoolId must equal schoolId — checked server-side, not just in the
// dialog — and archiveId must point at an archive the server can re-verify.
// planFingerprint is the digest the preview returned. The server recomputes
// the plan and refuses if it no longer matches — a roster that moved between
// preview and confirm must not be reset against a plan nobody saw.
export async function resetExecuteRemote({
  schoolId, confirmSchoolId, archiveId, runId, options, dryRun, planFingerprint,
}) {
  const res = await resetExecuteCallable({
    schoolId, confirmSchoolId, archiveId, runId, options, dryRun, planFingerprint,
  })
  return res.data
}

// ── Class map + class health (universal class resolution) ─────────────────
// scan_classes and class_health are READ-ONLY: they resolve what is already
// there and write nothing. save_class_map is the only writer, and it writes
// only to schools/{id}/class_map — never to a student document.
const scanClassesCallable = httpsCallable(functions, 'scan_classes', { timeout: 300_000 })
const saveClassMapCallable = httpsCallable(functions, 'save_class_map', { timeout: 120_000 })
const classHealthCallable = httpsCallable(functions, 'class_health', { timeout: 540_000 })

export async function scanClassesRemote({ schoolId }) {
  const res = await scanClassesCallable({ schoolId })
  return res.data
}

// shareAliases feeds confirmed corrections back to the shared dictionary so
// the next school with the same odd value resolves without anyone confirming
// it again.
export async function saveClassMapRemote({ schoolId, rows, shareAliases = true }) {
  const res = await saveClassMapCallable({ schoolId, rows, shareAliases })
  return res.data
}

export async function classHealthRemote() {
  const res = await classHealthCallable({})
  return res.data
}

// ── Create auth accounts (Tools > Authentication) ──────────────────────────
// Creates Firebase Auth accounts for students/staff flagged
// needsAuthCreation, then marks them done. dryRun previews without writing.
// Same callable pattern as school_reset — see functions/create_auth_accounts.
const createAuthAccountsCallable = httpsCallable(functions, 'create_auth_accounts', { timeout: 300_000 })

export async function createAuthAccountsRemote({ schoolId, roles, dryRun }) {
  const res = await createAuthAccountsCallable({ schoolId, roles, dryRun })
  return res.data
}

export function downloadReport({ filename, mime, content_base64 }) {
  const bytes = Uint8Array.from(atob(content_base64), c => c.charCodeAt(0))
  downloadBlob(new Blob([bytes], { type: mime }), filename)
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
