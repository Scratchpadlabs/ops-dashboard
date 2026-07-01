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
import { doc, getDoc, setDoc } from 'firebase/firestore'
import { useToast } from 'primevue/usetoast'

import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import InputNumber from 'primevue/inputnumber'
import ProgressSpinner from 'primevue/progressspinner'

const toast = useToast()

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

onMounted(loadSettings)
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
