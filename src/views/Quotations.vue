<template>
  <div>

    <!-- Header -->
    <div class="flex items-center justify-between mb-6">
      <div>
        <h2 class="text-lg font-semibold text-slate-900">Quotations</h2>
        <p class="text-sm text-slate-500 mt-0.5">{{ quotations.length }} total</p>
      </div>
      <Button label="New Quotation" icon="pi pi-plus" @click="openNew" />
    </div>

    <!-- Loading -->
    <div v-if="loading" class="flex items-center justify-center py-20">
      <ProgressSpinner style="width:32px;height:32px" />
    </div>

    <!-- Empty -->
    <div v-else-if="quotations.length === 0" class="text-center py-20 bg-white rounded-xl border border-slate-200">
      <i class="pi pi-file text-4xl text-slate-300 mb-3 block"></i>
      <p class="text-slate-500 font-medium">No quotations yet</p>
      <Button label="New Quotation" icon="pi pi-plus" class="mt-4" @click="openNew" />
    </div>

    <!-- Table -->
    <div v-else class="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <DataTable :value="quotations" size="small" stripedRows>

        <Column field="quotation_number" header="Ref #" style="width:130px">
          <template #body="{ data }">
            <span class="font-mono text-xs text-slate-600">{{ data.quotation_number }}</span>
          </template>
        </Column>

        <Column field="school_name" header="School" sortable>
          <template #body="{ data }">
            <span class="text-sm font-medium text-slate-900">{{ data.school_name }}</span>
          </template>
        </Column>

        <Column field="student_count" header="Students">
          <template #body="{ data }">
            <span class="text-sm font-mono text-slate-600">{{ data.student_count }}</span>
          </template>
        </Column>

        <Column header="Options">
          <template #body="{ data }">
            <div class="flex gap-1">
              <span v-if="data.show_a !== false" class="px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">
                A: ₹{{ data.price_a }}/student
              </span>
              <span v-if="data.show_b !== false" class="px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-700">
                B: ₹{{ data.price_b }}/student
              </span>
            </div>
          </template>
        </Column>

        <Column field="created_at" header="Date" sortable>
          <template #body="{ data }">
            <span class="text-xs text-slate-400">{{ formatDate(data.created_at) }}</span>
          </template>
        </Column>

        <Column header="" style="width:80px">
          <template #body="{ data }">
            <div class="flex gap-1">
              <Button icon="pi pi-download" text rounded size="small" v-tooltip="'Download PDF'" @click="download(data)" />
              <Button icon="pi pi-trash" text rounded size="small" severity="danger" @click="confirmDelete(data)" />
            </div>
          </template>
        </Column>

      </DataTable>
    </div>

    <!-- New Quotation Dialog -->
    <Dialog v-model:visible="dialogVisible" header="New Quotation" modal :style="{ width: '520px' }">
      <div class="space-y-5 pt-2">

        <!-- School -->
        <div>
          <label class="form-label">School *</label>
          <SchoolSearchSelect v-model="form.school_name" :schools="allSchools" @select="onSchoolSelect" />
          <p class="text-xs text-slate-400 mt-1">Search an existing school or type a new name.</p>
        </div>

        <!-- Student count -->
        <div>
          <label class="form-label">Approx. Student Count *</label>
          <InputNumber v-model="form.student_count" class="w-full" :min="1" />
        </div>

        <!-- Option A -->
        <div class="border border-slate-200 rounded-xl p-4">
          <div class="flex items-center justify-between mb-3">
            <div class="flex items-center gap-2">
              <span class="px-2 py-0.5 rounded text-xs font-bold bg-green-100 text-green-700">Option A</span>
              <span class="text-sm font-medium text-slate-700">Printed + Digital HPC</span>
              <span class="text-xs text-slate-400">MRP ₹299/student</span>
            </div>
            <div class="flex items-center gap-2">
              <label class="text-xs text-slate-500">Include</label>
              <ToggleButton v-model="form.show_a" onLabel="Yes" offLabel="No" size="small" />
            </div>
          </div>
          <div v-if="form.show_a">
            <label class="form-label">Discount %</label>
            <InputNumber v-model="form.discount_a" class="w-full" :min="0" :max="100" suffix="%" @input="calcPrices" />
            <div class="price-pill mt-3">
              ₹{{ form.price_a || 299 }} <span class="price-pill-unit">/ student</span>
            </div>
          </div>
        </div>

        <!-- Option B -->
        <div class="border border-slate-200 rounded-xl p-4">
          <div class="flex items-center justify-between mb-3">
            <div class="flex items-center gap-2">
              <span class="px-2 py-0.5 rounded text-xs font-bold bg-yellow-100 text-yellow-700">Option B</span>
              <span class="text-sm font-medium text-slate-700">Only Digital HPC</span>
              <span class="text-xs text-slate-400">MRP ₹169/student</span>
            </div>
            <div class="flex items-center gap-2">
              <label class="text-xs text-slate-500">Include</label>
              <ToggleButton v-model="form.show_b" onLabel="Yes" offLabel="No" size="small" />
            </div>
          </div>
          <div v-if="form.show_b">
            <label class="form-label">Discount %</label>
            <InputNumber v-model="form.discount_b" class="w-full" :min="0" :max="100" suffix="%" @input="calcPrices" />
            <div class="price-pill mt-3">
              ₹{{ form.price_b || 169 }} <span class="price-pill-unit">/ student</span>
            </div>
          </div>
        </div>

        <div v-if="formError" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">
          {{ formError }}
        </div>

      </div>

      <template #footer>
        <Button label="Cancel" text @click="dialogVisible = false" />
        <Button label="Save & Download" icon="pi pi-download" :loading="saving" @click="saveAndDownload" />
      </template>
    </Dialog>

    <ConfirmDialog />
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { db } from '../firebase/config'
import { opsCollection, opsDoc } from '../firebase/collections.js'
import {
  getDocs, addDoc, deleteDoc,
  doc, orderBy, query, serverTimestamp
} from 'firebase/firestore'
import { useConfirm } from 'primevue/useconfirm'
import { useToast } from 'primevue/usetoast'
import { useAllSchools } from '../composables/useAllSchools.js'
import { generateQuotationPDF } from '../utils/api.js'
import { generateQuotationNumber, calcPrice } from '../utils/quotationPDF.js'

import Button from 'primevue/button'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import Dialog from 'primevue/dialog'
import InputNumber from 'primevue/inputnumber'
import ToggleButton from 'primevue/togglebutton'
import ProgressSpinner from 'primevue/progressspinner'
import ConfirmDialog from 'primevue/confirmdialog'
import SchoolSearchSelect from '../components/shared/SchoolSearchSelect.vue'

const confirm = useConfirm()
const toast = useToast()
const { allSchools, loadAllSchools } = useAllSchools()

const quotations = ref([])
const loading    = ref(true)
const dialogVisible = ref(false)
const saving     = ref(false)
const formError  = ref('')

const emptyForm = () => ({
  school_id:    null,
  school_name:  '',
  student_count: null,
  show_a:       true,
  discount_a:   null,
  price_a:      299,
  show_b:       true,
  discount_b:   null,
  price_b:      169,
})

const form = reactive(emptyForm())

// ── Load ──────────────────────────────────────────────────────────────────────
async function loadQuotations() {
  loading.value = true
  try {
    const q = query(opsCollection('quotations'), orderBy('created_at', 'desc'))
    const snap = await getDocs(q)
    quotations.value = snap.docs.map(d => ({ id: d.id, ...d.data() }))
  } catch (e) {
    toast.add({ severity: 'error', summary: 'Error', detail: 'Could not load quotations', life: 3000 })
  } finally {
    loading.value = false
  }
}

// ── Handlers ──────────────────────────────────────────────────────────────────
function onSchoolSelect(s) {
  form.school_id      = s.id || null
  form.school_name    = s.name
  form.student_count  = s.student_count || form.student_count
}

function calcPrices() {
  form.price_a = calcPrice(299, form.discount_a)
  form.price_b = calcPrice(169, form.discount_b)
}

function openNew() {
  Object.assign(form, {
    school_id:    null,
    school_name:  '',
    student_count: null,
    show_a:       true,
    discount_a:   null,
    price_a:      299,
    show_b:       true,
    discount_b:   null,
    price_b:      169,
  })
  formError.value = ''
  dialogVisible.value = true
}

function validate() {
  if (!form.school_name.trim())   return 'School name is required'
  if (!form.student_count)        return 'Student count is required'
  if (!form.show_a && !form.show_b) return 'At least one option must be included'
  return ''
}

async function saveAndDownload() {
  formError.value = validate()
  if (formError.value) return

  saving.value = true
  try {
    const existingNums = quotations.value.map(q => q.quotation_number)
    const qNum = generateQuotationNumber(existingNums)

    const payload = {
      school_id:      form.school_id || null,
      school_name:    form.school_name,
      student_count:  form.student_count,
      show_a:         form.show_a,
      discount_a:     form.show_a ? (form.discount_a || 0) : null,
      price_a:        form.show_a ? form.price_a : null,
      show_b:         form.show_b,
      discount_b:     form.show_b ? (form.discount_b || 0) : null,
      price_b:        form.show_b ? form.price_b : null,
      quotation_number: qNum,
      created_at:     serverTimestamp(),
    }

    await addDoc(opsCollection('quotations'), payload)

    // Generate and download PDF
    await generateQuotationPDF({ ...payload, quotation_number: qNum })
    

    toast.add({ severity: 'success', summary: 'Done', detail: `Quotation ${qNum} saved & downloaded`, life: 3000 })
    dialogVisible.value = false
    await loadQuotations()
  } catch (e) {
    formError.value = 'Something went wrong. Try again.'
    console.error(e)
  } finally {
    saving.value = false
  }
}

async function download(q) {
  try {
    await generateQuotationPDF(q)
  } catch (e) {
    console.error(e)
    toast.add({ severity: 'error', summary: 'Download failed', detail: e.message || 'Could not generate PDF', life: 4000 })
  }
}

function confirmDelete(q) {
  confirm.require({
    message: `Delete quotation ${q.quotation_number}?`,
    header: 'Delete Quotation',
    icon: 'pi pi-exclamation-triangle',
    rejectLabel: 'Cancel',
    acceptLabel: 'Delete',
    acceptClass: 'p-button-danger',
    accept: async () => {
      try {
        await deleteDoc(opsDoc('quotations', q.id))
        toast.add({ severity: 'info', summary: 'Deleted', life: 2000 })
        await loadQuotations()
      } catch (e) {
        toast.add({ severity: 'error', summary: 'Error', detail: 'Could not delete', life: 3000 })
      }
    }
  })
}

function formatDate(ts) {
  if (!ts) return '—'
  const d = ts.toDate ? ts.toDate() : new Date(ts)
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

onMounted(async () => {
  await Promise.all([loadQuotations(), loadAllSchools()])
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

.price-pill {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  background: linear-gradient(135deg, #22c55e, #16a34a);
  color: white;
  font-size: 20px;
  font-weight: 800;
  padding: 10px 18px;
  border-radius: 999px;
  box-shadow: 0 4px 14px -4px rgba(22, 163, 74, 0.5);
}

.price-pill-unit {
  font-size: 12px;
  font-weight: 600;
  opacity: 0.85;
}
</style>
