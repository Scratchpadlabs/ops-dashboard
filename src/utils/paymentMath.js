/**
 * Pure helpers for installment invoicing and the payment-position overview.
 *
 * Single source of truth rule: every number here derives from the invoice
 * docs (and the school's contract value) at read time — nothing is kept as
 * a separately maintained total.
 *
 * Back-compat rule: invoices created before installments have no `amount` /
 * `percent` fields. Their amount is price_per_student × quantity and their
 * percent is null — convertible to a percent only when a contract value
 * exists.
 */

// Tolerance for float drift when comparing percentages.
export const PCT_EPS = 0.5

// ── Per-invoice ───────────────────────────────────────────────────────────────

export function invoiceAmount(inv) {
  if (inv.amount != null) return inv.amount
  return (inv.price_per_student || 0) * (inv.quantity || 0)
}

// 'paid' | 'partially_paid' | 'unpaid' — legacy invoices only have `status`.
export function invoicePaymentStatus(inv) {
  if (inv.payment_status) return inv.payment_status
  return inv.status === 'paid' ? 'paid' : 'unpaid'
}

export function invoicePaidAmount(inv) {
  const status = invoicePaymentStatus(inv)
  if (status === 'paid') return inv.paid_amount != null ? inv.paid_amount : invoiceAmount(inv)
  if (status === 'partially_paid') return inv.paid_amount || 0
  return 0
}

export function invoiceOutstanding(inv) {
  return Math.max(0, invoiceAmount(inv) - invoicePaidAmount(inv))
}

// Percent of the contract this invoice represents; null when unknowable.
export function invoicePercent(inv, contractValue) {
  if (inv.percent != null) return inv.percent
  if (!contractValue) return null
  return invoiceAmount(inv) / contractValue * 100
}

// ── Contract value ────────────────────────────────────────────────────────────

// Explicit contract_value wins; otherwise derive from the school's agreed
// per-student pricing. Null when neither is known.
export function effectiveContractValue(school) {
  if (!school) return null
  if (school.contract_value) return school.contract_value
  if (school.price_per_student && school.student_count) {
    return school.price_per_student * school.student_count
  }
  return null
}

// ── Aggregations (read-time, from invoice docs) ───────────────────────────────

// Sum of percents across invoices. Amount-only invoices are converted via the
// contract value; without one they simply can't contribute a percent.
export function invoicedPercentSoFar(invoices, contractValue) {
  return invoices.reduce((sum, inv) => {
    const pct = invoicePercent(inv, contractValue)
    return pct != null ? sum + pct : sum
  }, 0)
}

/**
 * Payment position of a school, derived from its (non-deleted) invoices.
 * Percentages are null when there is no contract value to compare against.
 */
export function paymentPosition(school, invoices) {
  const contractValue = effectiveContractValue(school)
  const invoicedAmount = invoices.reduce((s, i) => s + invoiceAmount(i), 0)
  const receivedAmount = invoices.reduce((s, i) => s + invoicePaidAmount(i), 0)

  const pct = (amount) => contractValue ? Math.min(999, amount / contractValue * 100) : null

  const invoicedPct = pct(invoicedAmount)
  const receivedPct = pct(receivedAmount)

  return {
    contractValue,
    invoicedAmount,
    receivedAmount,
    pendingAmount: contractValue ? Math.max(0, contractValue - receivedAmount) : null,
    notInvoicedAmount: contractValue ? Math.max(0, contractValue - invoicedAmount) : null,
    invoicedPct,
    receivedPct,
    pendingPct: contractValue ? Math.max(0, 100 - receivedPct) : null,
    // Segment bar: received / invoiced-but-unpaid / not yet invoiced (of contract).
    segments: contractValue ? {
      received: Math.min(100, receivedPct),
      invoicedUnpaid: Math.max(0, Math.min(100, invoicedPct) - Math.min(100, receivedPct)),
      notInvoiced: Math.max(0, 100 - Math.min(100, invoicedPct)),
    } : null,
  }
}

// ── Next-installment suggestion ───────────────────────────────────────────────

const ORDINALS = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th']
export function ordinal(n) {
  return ORDINALS[n - 1] || `${n}th`
}

/**
 * Suggest the next uninvoiced installment of a plan.
 *
 * An installment counts as invoiced when an existing invoice carries its label,
 * or when the cumulative invoiced percent already covers it (e.g. plan 50/25/25
 * with 50% invoiced → suggest the 2nd installment at 25%).
 *
 * Returns { label, percent, index, ordinal } or null when the plan is fully
 * invoiced (or has no installments).
 */
export function suggestNextInstallment(plan, invoices, contractValue) {
  const installments = plan?.installments || []
  if (!installments.length) return null

  const invoicedPct = invoicedPercentSoFar(invoices, contractValue)
  const usedLabels = new Set(
    invoices
      .map(i => (i.installment_label || i.installment_type || '').trim().toLowerCase())
      .filter(Boolean)
  )

  let cum = 0
  for (let i = 0; i < installments.length; i++) {
    const inst = installments[i]
    cum += inst.percent || 0
    const labelUsed = usedLabels.has((inst.label || '').trim().toLowerCase())
    if (!labelUsed && cum > invoicedPct + PCT_EPS) {
      // Spread keeps future plan fields (e.g. due dates) flowing through.
      return { ...inst, index: i, ordinal: ordinal(i + 1) }
    }
  }
  return null
}

// ── Plan validation ───────────────────────────────────────────────────────────

export function planPercentTotal(plan) {
  return (plan?.installments || []).reduce((s, i) => s + (Number(i.percent) || 0), 0)
}

export function planTotalsTo100(plan) {
  return Math.abs(planPercentTotal(plan) - 100) < 0.01
}
