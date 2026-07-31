import { ref } from 'vue'
import { getDocs, setDoc } from 'firebase/firestore'
import { opsCollection, opsDoc } from '../firebase/collections.js'

/**
 * Payment plans live in operations/ops/payment_plans and are editable in
 * Settings. First load seeds the two plans the app has always offered
 * (Plan A 50/25/25, Plan B 25/25/25/25) under fixed doc ids so that legacy
 * school docs carrying installment_plan 'A'/'B' resolve to them.
 */

export const SEED_PLANS = [
  {
    id: 'plan_a',
    name: 'Plan A',
    installments: [
      { label: '1st Installment', percent: 50 },
      { label: '2nd Installment', percent: 25 },
      { label: '3rd Installment', percent: 25 },
    ],
  },
  {
    id: 'plan_b',
    name: 'Plan B',
    installments: [
      { label: '1st Installment', percent: 25 },
      { label: '2nd Installment', percent: 25 },
      { label: '3rd Installment', percent: 25 },
      { label: '4th Installment', percent: 25 },
    ],
  },
]

const LEGACY_PLAN_IDS = { A: 'plan_a', B: 'plan_b' }

// Shared across the app — plans rarely change and several views need them.
const paymentPlans = ref([])
let loadPromise = null

async function fetchPlans() {
  const snap = await getDocs(opsCollection('payment_plans'))
  let plans = snap.docs.map(d => ({ id: d.id, ...d.data() }))

  if (plans.length === 0) {
    // Seed the defaults once; ignore individual failures (e.g. offline).
    await Promise.all(SEED_PLANS.map(({ id, ...data }) =>
      setDoc(opsDoc('payment_plans', id), data).catch(e => console.error('Could not seed plan', id, e))
    ))
    plans = SEED_PLANS.map(p => ({ ...p, installments: p.installments.map(i => ({ ...i })) }))
  }

  plans.sort((a, b) => (a.name || '').localeCompare(b.name || ''))
  paymentPlans.value = plans
}

export function usePaymentPlans() {
  function loadPaymentPlans(force = false) {
    if (!loadPromise || force) {
      loadPromise = fetchPlans().catch(e => {
        console.error('Could not load payment plans', e)
        loadPromise = null
      })
    }
    return loadPromise
  }

  // A school's plan id — new field first, then the legacy A/B letter.
  function resolveSchoolPlanId(school) {
    if (!school) return null
    return school.payment_plan_id || LEGACY_PLAN_IDS[school.installment_plan] || null
  }

  function getPlan(planId) {
    return paymentPlans.value.find(p => p.id === planId) || null
  }

  function getSchoolPlan(school) {
    return getPlan(resolveSchoolPlanId(school))
  }

  // Legacy letter for a plan id, so older screens (Agreements, Quotations)
  // that still speak 'A'/'B' keep working when the school uses a seeded plan.
  function legacyLetterFor(planId) {
    return Object.keys(LEGACY_PLAN_IDS).find(k => LEGACY_PLAN_IDS[k] === planId) || null
  }

  return { paymentPlans, loadPaymentPlans, resolveSchoolPlanId, getPlan, getSchoolPlan, legacyLetterFor }
}
