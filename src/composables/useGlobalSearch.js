import { ref } from 'vue'
import { getDocs } from 'firebase/firestore'
import { opsCollection } from '../firebase/collections.js'

// Shared across the whole app so the header button and a global Ctrl+K
// listener can both toggle the same modal instance.
export const isSearchOpen = ref(false)

const CACHE_TTL_MS = 5 * 60 * 1000
const MAX_PER_GROUP = 5
const MAX_TOTAL = 15

const cache = {
  schools: [],
  quotations: [],
  agreements: [],
  invoices: [],
  expenses: [],
  loadedAt: 0,
}
const cacheLoading = ref(false)
// Plain `cache` mutations aren't visible to Vue's reactivity system. Callers
// that need to recompute once the cache finishes loading should read this
// inside a computed so it becomes a tracked dependency.
const cacheVersion = ref(0)

async function ensureCache(force = false) {
  const stale = Date.now() - cache.loadedAt > CACHE_TTL_MS
  if (!force && !stale && cache.loadedAt) return
  cacheLoading.value = true
  try {
    const [sSnap, qSnap, aSnap, iSnap, eSnap] = await Promise.all([
      getDocs(opsCollection('schools')),
      getDocs(opsCollection('quotations')),
      getDocs(opsCollection('agreements')),
      getDocs(opsCollection('invoices')),
      getDocs(opsCollection('expenses')),
    ])
    cache.schools = sSnap.docs.map(d => ({ id: d.id, ...d.data() }))
    cache.quotations = qSnap.docs.map(d => ({ id: d.id, ...d.data() }))
    cache.agreements = aSnap.docs.map(d => ({ id: d.id, ...d.data() }))
    cache.invoices = iSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(i => !i.deleted)
    cache.expenses = eSnap.docs.map(d => ({ id: d.id, ...d.data() }))
    cache.loadedAt = Date.now()
    cacheVersion.value++
  } catch (e) {
    console.error('Could not load global search cache', e)
  } finally {
    cacheLoading.value = false
  }
}

// ── Fuzzy matching ──────────────────────────────────────────────────────────
// Exact substrings score highest; otherwise falls back to a subsequence match
// (every query character must appear, in order, somewhere in the text) so
// typos/missing letters ("samta" -> "Samta International School") still hit.
function fuzzyScore(query, text) {
  const q = (query || '').toLowerCase().trim()
  const t = (text || '').toLowerCase()
  if (!q) return 0
  if (!t) return -1

  const idx = t.indexOf(q)
  if (idx !== -1) {
    return 500 - idx * 2 + Math.max(0, 20 - (t.length - q.length))
  }

  let qi = 0
  let score = 0
  let lastIdx = -2
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += ti === lastIdx + 1 ? 4 : 1
      lastIdx = ti
      qi++
    }
  }
  return qi === q.length ? score : -1
}

// Highest field score wins; secondary fields count for less than the primary one.
function scoreRecord(query, texts) {
  let best = -1
  texts.forEach((txt, i) => {
    const sc = fuzzyScore(query, txt)
    if (sc < 0) return
    const weighted = i === 0 ? sc : sc * 0.6
    if (weighted > best) best = weighted
  })
  return best
}

function recencyBoost(ts) {
  if (!ts) return 0
  const d = ts.toDate ? ts.toDate() : new Date(ts)
  const days = (Date.now() - d.getTime()) / 86400000
  if (days < 2) return 15
  if (days < 7) return 8
  if (days < 30) return 3
  return 0
}

function amountProximityBoost(amount, target) {
  if (!target || !amount) return 0
  const diff = Math.abs(amount - target) / Math.max(amount, target, 1)
  if (diff < 0.02) return 40
  if (diff < 0.1) return 20
  if (diff < 0.3) return 8
  return 0
}

// Wraps matching characters in <b> for display. Falls back to per-character
// subsequence highlighting when there's no single contiguous substring hit.
export function highlightMatches(text, query) {
  const raw = text == null ? '' : String(text)
  const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const q = (query || '').trim()
  if (!q) return escape(raw)

  const lowerText = raw.toLowerCase()
  const lowerQ = q.toLowerCase()
  const idx = lowerText.indexOf(lowerQ)
  if (idx !== -1) {
    return escape(raw.slice(0, idx)) + '<b>' + escape(raw.slice(idx, idx + q.length)) + '</b>' + escape(raw.slice(idx + q.length))
  }

  let qi = 0
  let out = ''
  for (let ti = 0; ti < raw.length; ti++) {
    const ch = raw[ti]
    if (qi < lowerQ.length && lowerText[ti] === lowerQ[qi]) {
      out += '<b>' + escape(ch) + '</b>'
      qi++
    } else {
      out += escape(ch)
    }
  }
  return out
}

// ── Intent detection ─────────────────────────────────────────────────────────
function detectIntent(query) {
  const q = query.trim()
  if (!q) return { type: 'empty' }
  const lower = q.toLowerCase()

  if (/^\d/.test(q)) {
    return { type: 'number', numeric: parseFloat(q.replace(/[^\d.]/g, '')) || null }
  }
  if (/\bunpaid\b/.test(lower)) return { type: 'invoice_status', status: 'unpaid' }
  if (/\boverdue\b/.test(lower)) return { type: 'invoice_status', status: 'overdue' }
  if (/\bpaid\b/.test(lower))   return { type: 'invoice_status', status: 'paid' }
  if (/\bunsigned\b/.test(lower)) return { type: 'agreement_status', status: 'unsigned' }
  if (/\bsigned\b/.test(lower))   return { type: 'agreement_status', status: 'signed' }

  const cities = new Set(cache.schools.map(s => (s.city || '').toLowerCase().trim()).filter(Boolean))
  if (cities.has(lower)) return { type: 'city', city: lower }

  return { type: 'text' }
}

// ── Per-type result builders ─────────────────────────────────────────────────
function isOverdueInvoice(inv) {
  if (inv.status === 'paid' || !inv.due_date) return false
  const due = inv.due_date.toDate ? inv.due_date.toDate() : new Date(inv.due_date)
  return due < new Date()
}

function schoolResult(s, score) {
  return {
    type: 'school', id: s.id, score,
    primary: s.name || '(unnamed school)',
    secondary: [s.city, s.rm].filter(Boolean).join(' · '),
    badge: s.statuses?.[0] ? { text: s.statuses[0], cls: statusBadgeClass(s.statuses[0]) } : null,
    raw: s,
  }
}

function quotationResult(q, score) {
  const amount = q.student_count ? (q.price_a || q.price_b || 0) * q.student_count : null
  return {
    type: 'quotation', id: q.id, score,
    primary: q.quotation_number || '(quotation)',
    secondary: [q.school_name, amount ? `~₹${amount.toLocaleString('en-IN')}` : null].filter(Boolean).join(' · '),
    badge: q.converted_to_agreement_id ? { text: 'Converted', cls: 'bg-green-100 text-green-700' } : null,
    raw: q,
  }
}

function agreementResult(a, score) {
  const total = a.fee_per_student && a.student_count ? a.fee_per_student * a.student_count : null
  return {
    type: 'agreement', id: a.id, score,
    primary: a.agreement_number || '(agreement)',
    secondary: [a.school_name, total ? `₹${total.toLocaleString('en-IN')}` : null].filter(Boolean).join(' · '),
    badge: { text: a.status || 'Sent', cls: a.status === 'Signed' ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700' },
    raw: a,
  }
}

function invoiceResult(i, score) {
  const amount = (i.price_per_student || 0) * (i.quantity || 0)
  const overdue = isOverdueInvoice(i)
  return {
    type: 'invoice', id: i.id, score,
    primary: i.invoice_number || '(invoice)',
    secondary: [i.school_name, `₹${amount.toLocaleString('en-IN')}`].filter(Boolean).join(' · '),
    badge: {
      text: i.status === 'paid' ? 'Paid' : overdue ? 'Overdue' : 'Unpaid',
      cls: i.status === 'paid' ? 'bg-green-100 text-green-700' : overdue ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700',
    },
    raw: i,
  }
}

function expenseResult(e, score) {
  return {
    type: 'expense', id: e.id, score,
    primary: e.name || '(expense)',
    secondary: [e.category, e.amount ? `₹${Number(e.amount).toLocaleString('en-IN')}` : null].filter(Boolean).join(' · '),
    badge: e.recurring ? { text: e.frequency || 'Recurring', cls: 'bg-purple-100 text-purple-700' } : null,
    raw: e,
  }
}

function statusBadgeClass(status) {
  if (status === 'Converted')   return 'bg-green-100 text-green-700'
  if (status === 'Negotiation') return 'bg-amber-100 text-amber-700'
  return 'bg-blue-100 text-blue-700'
}

// ── Canned "smart suggestions" (shown when the search box is empty) ─────────
export const SUGGESTIONS = [
  { label: 'Schools with overdue invoices', icon: 'pi pi-building' },
  { label: 'Unsigned agreements', icon: 'pi pi-file-edit' },
  { label: "This month's expenses", icon: 'pi pi-wallet' },
  { label: 'Unpaid invoices', icon: 'pi pi-receipt' },
]

function suggestionResults(label) {
  if (label === 'Schools with overdue invoices') {
    const overdueSchoolNames = new Set(cache.invoices.filter(isOverdueInvoice).map(i => (i.school_name || '').toLowerCase().trim()))
    return cache.schools
      .filter(s => overdueSchoolNames.has((s.name || '').toLowerCase().trim()))
      .map(s => schoolResult(s, 100))
  }
  if (label === 'Unsigned agreements') {
    return cache.agreements.filter(a => a.status !== 'Signed').map(a => agreementResult(a, 100))
  }
  if (label === "This month's expenses") {
    const now = new Date()
    return cache.expenses
      .filter(e => {
        const d = e.date?.toDate ? e.date.toDate() : e.date ? new Date(e.date) : null
        return d && d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()
      })
      .map(e => expenseResult(e, 100))
  }
  if (label === 'Unpaid invoices') {
    return cache.invoices.filter(i => i.status !== 'paid').map(i => invoiceResult(i, 100))
  }
  return []
}

// ── Main search entry point ──────────────────────────────────────────────────
function search(query) {
  const trimmed = (query || '').trim()
  if (!trimmed) return { groups: [], totalCount: 0, intent: { type: 'empty' } }

  const isSuggestion = SUGGESTIONS.some(s => s.label === trimmed)
  if (isSuggestion) {
    const items = suggestionResults(trimmed)
    return buildGroups(items, { type: 'suggestion' }, items.length)
  }

  const intent = detectIntent(trimmed)
  let items = []

  if (intent.type === 'invoice_status') {
    items = cache.invoices
      .filter(i => {
        if (intent.status === 'paid') return i.status === 'paid'
        if (intent.status === 'unpaid') return i.status !== 'paid'
        if (intent.status === 'overdue') return isOverdueInvoice(i)
        return false
      })
      .map(i => invoiceResult(i, 100 + recencyBoost(i.created_at)))
  } else if (intent.type === 'agreement_status') {
    items = cache.agreements
      .filter(a => (intent.status === 'signed' ? a.status === 'Signed' : a.status !== 'Signed'))
      .map(a => agreementResult(a, 100 + recencyBoost(a.created_at)))
  } else if (intent.type === 'city') {
    items = cache.schools
      .filter(s => (s.city || '').toLowerCase().trim() === intent.city)
      .map(s => schoolResult(s, 100 + recencyBoost(s.created_at)))
  } else {
    // Fuzzy match across everything. A leading digit also boosts invoices/
    // expenses whose amount is close to the typed number.
    const schoolItems = cache.schools
      .map(s => ({ s, score: scoreRecord(trimmed, [s.name, s.city, s.contact_person, s.rm]) }))
      .filter(x => x.score >= 0)
      .map(x => schoolResult(x.s, x.score + recencyBoost(x.s.created_at)))

    const quotationItems = cache.quotations
      .map(q => ({ q, score: scoreRecord(trimmed, [q.quotation_number, q.school_name]) }))
      .filter(x => x.score >= 0)
      .map(x => quotationResult(x.q, x.score + recencyBoost(x.q.created_at)))

    const agreementItems = cache.agreements
      .map(a => ({ a, score: scoreRecord(trimmed, [a.agreement_number, a.school_name, a.signatory_name]) }))
      .filter(x => x.score >= 0)
      .map(x => agreementResult(x.a, x.score + recencyBoost(x.a.created_at)))

    const invoiceItems = cache.invoices
      .map(i => {
        let score = scoreRecord(trimmed, [i.invoice_number, i.school_name, i.description])
        if (intent.type === 'number' && intent.numeric != null) {
          const amount = (i.price_per_student || 0) * (i.quantity || 0)
          score = Math.max(score, amountProximityBoost(amount, intent.numeric))
        }
        return { i, score }
      })
      .filter(x => x.score >= 0)
      .map(x => invoiceResult(x.i, x.score + recencyBoost(x.i.created_at)))

    const expenseItems = cache.expenses
      .map(e => {
        let score = scoreRecord(trimmed, [e.name, e.category, e.notes])
        if (intent.type === 'number' && intent.numeric != null) {
          score = Math.max(score, amountProximityBoost(e.amount, intent.numeric))
        }
        return { e, score }
      })
      .filter(x => x.score >= 0)
      .map(x => expenseResult(x.e, x.score + recencyBoost(x.e.created_at)))

    items = [...schoolItems, ...quotationItems, ...agreementItems, ...invoiceItems, ...expenseItems]
  }

  return buildGroups(items, intent, items.length)
}

const GROUP_META = {
  school:     { label: 'Schools',     icon: '🏫', color: '#3b82f6' },
  quotation:  { label: 'Quotations',  icon: '📄', color: '#16a34a' },
  agreement:  { label: 'Agreements',  icon: '📝', color: '#9333ea' },
  invoice:    { label: 'Invoices',    icon: '🧾', color: '#d97706' },
  expense:    { label: 'Expenses',    icon: '💸', color: '#dc2626' },
}

function buildGroups(items, intent, totalBeforeLimit) {
  const byType = {}
  items.forEach(item => {
    if (!byType[item.type]) byType[item.type] = []
    byType[item.type].push(item)
  })

  const groups = Object.keys(byType)
    .map(type => {
      const sorted = byType[type].sort((a, b) => b.score - a.score)
      return {
        type,
        ...GROUP_META[type],
        count: sorted.length,
        items: sorted.slice(0, MAX_PER_GROUP),
      }
    })
    .sort((a, b) => (b.items[0]?.score || 0) - (a.items[0]?.score || 0))

  // Trim to MAX_TOTAL across groups, preserving per-group order.
  let remaining = MAX_TOTAL
  const trimmedGroups = []
  for (const g of groups) {
    if (remaining <= 0) break
    const items = g.items.slice(0, remaining)
    remaining -= items.length
    trimmedGroups.push({ ...g, items })
  }

  return { groups: trimmedGroups, totalCount: totalBeforeLimit, intent }
}

export function useGlobalSearch() {
  return { isSearchOpen, ensureCache, search, highlightMatches, SUGGESTIONS, cacheLoading, cacheVersion }
}
