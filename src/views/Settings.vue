<template>
  <div>
    <div class="mb-6">
      <h2 class="text-lg font-semibold text-slate-900">Settings</h2>
      <p class="text-sm text-slate-500 mt-0.5">Global defaults used across Invoices, Agreements and Schools</p>
    </div>

    <div v-if="loading" class="flex items-center justify-center py-20">
      <ProgressSpinner style="width:32px;height:32px" />
    </div>

    <div v-else class="max-w-xl space-y-4">

      <!-- Invoice Due Days -->
      <div class="bg-white rounded-xl border border-slate-200 p-4">
        <label class="form-label">Invoice Due Days</label>
        <InputNumber v-model="form.invoice_due_days" class="w-full" :min="1" />
        <p class="text-xs text-slate-400 mt-2">Days after creation before a new invoice's due date passes and it's marked overdue.</p>
      </div>

      <!-- Default Installment Plan -->
      <div class="bg-white rounded-xl border border-slate-200 p-4">
        <label class="form-label">Default Installment Plan</label>
        <div class="grid grid-cols-2 gap-3 mt-1">
          <button
            @click="form.default_installment_plan = 'A'"
            class="p-3 rounded-xl border text-left transition-all"
            :class="form.default_installment_plan === 'A'
              ? 'border-blue-500 bg-blue-50'
              : 'border-slate-200 hover:border-slate-300'"
          >
            <div class="font-semibold text-sm text-slate-900">Plan A</div>
            <div class="text-xs text-slate-500">50% · 25% · 25%</div>
          </button>
          <button
            @click="form.default_installment_plan = 'B'"
            class="p-3 rounded-xl border text-left transition-all"
            :class="form.default_installment_plan === 'B'
              ? 'border-blue-500 bg-blue-50'
              : 'border-slate-200 hover:border-slate-300'"
          >
            <div class="font-semibold text-sm text-slate-900">Plan B</div>
            <div class="text-xs text-slate-500">25% · 25% · 25% · 25%</div>
          </button>
        </div>
        <p class="text-xs text-slate-400 mt-2">Pre-selected when creating a new agreement.</p>
      </div>

      <!-- Payment Plans -->
      <div class="bg-white rounded-xl border border-slate-200 p-4">
        <div class="flex items-center justify-between mb-1">
          <label class="form-label mb-0">Payment Plans</label>
          <Button label="+ Add Plan" text size="small" @click="addPlan" />
        </div>
        <p class="text-xs text-slate-400 mb-3">Installment splits schools can be put on. Percentages of each plan must total 100.</p>

        <div v-if="plansLoading" class="flex items-center justify-center py-6">
          <ProgressSpinner style="width:24px;height:24px" />
        </div>

        <div v-else class="space-y-3">
          <div v-for="(plan, pi) in editablePlans" :key="plan.id || 'new-' + pi" class="bg-slate-50 rounded-lg p-3">
            <div class="flex items-center gap-2 mb-2">
              <InputText v-model="plan.name" class="flex-1 text-sm" placeholder="Plan name" />
              <span
                class="px-2 py-0.5 rounded-full text-xs font-semibold flex-shrink-0"
                :class="planTotal(plan) === 100 ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'"
              >{{ planTotal(plan) }}%</span>
              <Button icon="pi pi-trash" text rounded size="small" severity="danger" v-tooltip="'Delete plan'" @click="deletePlan(plan, pi)" />
            </div>

            <div v-for="(inst, ii) in plan.installments" :key="ii" class="flex items-center gap-2 mb-1.5">
              <InputText v-model="inst.label" class="flex-1 text-sm" placeholder="Installment label" />
              <InputNumber v-model="inst.percent" class="w-24" :min="0" :max="100" suffix="%" />
              <Button icon="pi pi-times" text rounded size="small" :disabled="plan.installments.length <= 1" @click="plan.installments.splice(ii, 1)" />
            </div>

            <div class="flex items-center justify-between mt-2">
              <button type="button" class="text-xs text-violet-600 font-semibold" @click="plan.installments.push({ label: nextInstallmentLabel(plan), percent: null })">+ Installment</button>
              <Button
                label="Save Plan"
                size="small"
                :loading="savingPlanId === (plan.id || 'new-' + pi)"
                :disabled="planTotal(plan) !== 100 || !plan.name?.trim()"
                v-tooltip="planTotal(plan) !== 100 ? 'Percentages must total 100' : ''"
                @click="savePlan(plan, pi)"
              />
            </div>
          </div>

          <p v-if="editablePlans.length === 0" class="text-xs text-slate-300 text-center py-4">No payment plans yet — add one.</p>
        </div>
      </div>

      <!-- School Modules -->
      <div class="bg-white rounded-xl border border-slate-200 p-4">
        <label class="form-label">School Modules</label>
        <div class="flex gap-2 mb-3">
          <InputText
            v-model="newModule"
            class="flex-1"
            placeholder="Add a module..."
            @keyup.enter="addModule"
          />
          <Button icon="pi pi-plus" :disabled="!newModule.trim()" @click="addModule" />
        </div>
        <div class="flex flex-wrap gap-2">
          <span
            v-for="m in form.modules"
            :key="m"
            class="px-3 py-1.5 rounded-full text-xs font-medium bg-slate-100 text-slate-700 flex items-center gap-1.5"
          >
            {{ m }}
            <button @click="removeModule(m)" class="text-slate-400 hover:text-red-500">
              <i class="pi pi-times text-xs"></i>
            </button>
          </span>
          <span v-if="form.modules.length === 0" class="text-xs text-slate-300">No modules configured</span>
        </div>
        <p class="text-xs text-slate-400 mt-3">Options offered in the Schools "Modules" picker.</p>
      </div>

      <div v-if="formError" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{{ formError }}</div>

      <div class="flex justify-end">
        <Button label="Save Settings" :loading="saving" @click="save" />
      </div>
    </div>

  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { db } from '../firebase/config'
import { doc, getDoc, setDoc, addDoc, deleteDoc } from 'firebase/firestore'
import { useToast } from 'primevue/usetoast'
import { useConfirm } from 'primevue/useconfirm'
import { opsCollection, opsDoc } from '../firebase/collections.js'
import { usePaymentPlans } from '../composables/usePaymentPlans.js'
import { planPercentTotal, ordinal } from '../utils/paymentMath.js'

import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import InputNumber from 'primevue/inputnumber'
import ProgressSpinner from 'primevue/progressspinner'

const toast = useToast()
const confirm = useConfirm()

// ── Payment plans (operations/ops/payment_plans) ─────────────────────────────
const { paymentPlans, loadPaymentPlans } = usePaymentPlans()
const plansLoading  = ref(true)
const editablePlans = ref([])
const savingPlanId  = ref(null)

function planTotal(plan) {
  return Math.round(planPercentTotal(plan) * 100) / 100
}

function nextInstallmentLabel(plan) {
  return `${ordinal(plan.installments.length + 1)} Installment`
}

async function initPlans() {
  await loadPaymentPlans()
  editablePlans.value = paymentPlans.value.map(p => ({
    ...p,
    installments: (p.installments || []).map(i => ({ ...i })),
  }))
  plansLoading.value = false
}

function addPlan() {
  editablePlans.value.push({
    id: null,
    name: '',
    installments: [
      { label: '1st Installment', percent: null },
      { label: '2nd Installment', percent: null },
    ],
  })
}

async function savePlan(plan, index) {
  const key = plan.id || 'new-' + index
  savingPlanId.value = key
  try {
    const data = {
      name: plan.name.trim(),
      installments: plan.installments.map(i => ({ label: (i.label || '').trim(), percent: Number(i.percent) || 0 })),
    }
    if (plan.id) {
      await setDoc(opsDoc('payment_plans', plan.id), data)
    } else {
      const ref = await addDoc(opsCollection('payment_plans'), data)
      plan.id = ref.id
    }
    await loadPaymentPlans(true)
    toast.add({ severity: 'success', summary: 'Saved', detail: `${data.name} saved`, life: 2500 })
  } catch (e) {
    console.error(e)
    toast.add({ severity: 'error', summary: 'Error', detail: 'Could not save the plan', life: 3000 })
  } finally {
    savingPlanId.value = null
  }
}

function deletePlan(plan, index) {
  if (!plan.id) {
    editablePlans.value.splice(index, 1)
    return
  }
  confirm.require({
    message: `Delete ${plan.name || 'this plan'}? Schools already on it keep working — they just lose the plan reference for future suggestions.`,
    header: 'Delete Payment Plan',
    icon: 'pi pi-exclamation-triangle',
    rejectLabel: 'Cancel', acceptLabel: 'Delete', acceptClass: 'p-button-danger',
    accept: async () => {
      try {
        await deleteDoc(opsDoc('payment_plans', plan.id))
        editablePlans.value.splice(index, 1)
        await loadPaymentPlans(true)
        toast.add({ severity: 'info', summary: 'Deleted', life: 2000 })
      } catch (e) {
        toast.add({ severity: 'error', summary: 'Error', detail: 'Could not delete the plan', life: 3000 })
      }
    },
  })
}

const DEFAULTS = {
  invoice_due_days: 45,
  default_installment_plan: 'A',
  modules: ['HPC', 'SEW', 'Co-Scholastic', 'Remarks', 'Parent App'],
}

const loading    = ref(true)
const saving     = ref(false)
const formError  = ref('')
const newModule  = ref('')
const form = reactive({ ...DEFAULTS, modules: [...DEFAULTS.modules] })

async function loadSettings() {
  loading.value = true
  try {
    const snap = await getDoc(doc(db, 'operations', 'settings'))
    if (snap.exists()) {
      const data = snap.data()
      form.invoice_due_days         = data.invoice_due_days ?? DEFAULTS.invoice_due_days
      form.default_installment_plan = data.default_installment_plan ?? DEFAULTS.default_installment_plan
      form.modules                  = Array.isArray(data.modules) && data.modules.length
        ? [...data.modules]
        : [...DEFAULTS.modules]
    }
  } catch (e) {
    toast.add({ severity: 'error', summary: 'Error', detail: 'Could not load settings', life: 3000 })
  } finally {
    loading.value = false
  }
}

function addModule() {
  const val = newModule.value.trim()
  if (!val || form.modules.includes(val)) return
  form.modules.push(val)
  newModule.value = ''
}

function removeModule(m) {
  form.modules = form.modules.filter(x => x !== m)
}

async function save() {
  formError.value = ''
  if (!form.invoice_due_days || form.invoice_due_days < 1) {
    formError.value = 'Invoice due days must be at least 1'
    return
  }
  saving.value = true
  try {
    await setDoc(doc(db, 'operations', 'settings'), {
      invoice_due_days:         form.invoice_due_days,
      default_installment_plan: form.default_installment_plan,
      modules:                  form.modules,
    }, { merge: true })
    toast.add({ severity: 'success', summary: 'Saved', detail: 'Settings updated', life: 2500 })
  } catch (e) {
    formError.value = 'Something went wrong. Try again.'
  } finally {
    saving.value = false
  }
}

onMounted(async () => {
  await Promise.all([loadSettings(), initPlans()])
})
</script>

<style scoped>
.form-label {
  display: block;
  font-size: 12px;
  font-weight: 500;
  color: #64748b;
  margin-bottom: 4px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
</style>
