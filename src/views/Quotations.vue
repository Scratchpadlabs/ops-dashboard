<template>
  <div>

    <!-- Header -->
    <div class="flex items-center justify-between mb-6">
      <div>
        <h2 class="text-lg font-semibold text-slate-900">Quotations</h2>
        <p class="text-sm text-slate-500 mt-0.5">{{ visibleQuotations.length }} total</p>
      </div>
      <Button label="New Quotation" icon="pi pi-plus" @click="openNew" />
    </div>

    <!-- Loading -->
    <div v-if="loading" class="flex items-center justify-center py-20">
      <ProgressSpinner style="width:32px;height:32px" />
    </div>

    <!-- Empty -->
    <div v-else-if="visibleQuotations.length === 0" class="text-center py-20 bg-white rounded-xl border border-slate-200">
      <i class="pi pi-file text-4xl text-slate-300 mb-3 block"></i>
      <p class="text-slate-500 font-medium">No quotations yet</p>
      <Button label="New Quotation" icon="pi pi-plus" class="mt-4" @click="openNew" />
    </div>

    <!-- Table -->
    <div v-else class="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <DataTable :value="visibleQuotations" size="small" stripedRows :rowClass="rowClass">

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

        <Column header="" style="width:190px">
          <template #body="{ data }">
            <div class="flex items-center justify-end gap-1">
              <span
                v-if="data.converted_to_agreement_id"
                class="px-2 py-0.5 rounded-full text-xs font-semibold bg-green-100 text-green-700"
              >Converted</span>
              <Button
                v-else
                label="Convert"
                icon="pi pi-arrow-right-arrow-left"
                text size="small"
                @click="startConvert(data)"
              />
              <Button
                :icon="downloadingId === data.id ? 'pi pi-spin pi-spinner' : 'pi pi-download'"
                text rounded size="small"
                :disabled="downloadingId === data.id"
                v-tooltip="'Download PDF'"
                @click="download(data)"
              />
              <Button icon="pi pi-trash" text rounded size="small" severity="danger" @click="confirmDelete(data)" />
            </div>
          </template>
        </Column>

      </DataTable>
    </div>

    <!-- Step 1: Add School First (if quotation's school doesn't exist yet) -->
    <Dialog v-model:visible="addSchoolDialogVisible" header="Add School First" modal :style="{ width: '480px' }">
      <div class="space-y-4 pt-2">
        <p class="text-sm text-slate-500">
          This quotation isn't linked to a school record yet. Add one before creating the agreement.
        </p>
        <div>
          <label class="form-label">School Name *</label>
          <InputText v-model="addSchoolForm.name" class="w-full" />
        </div>
        <div class="grid grid-cols-2 gap-4">
          <div>
            <label class="form-label">City *</label>
            <InputText v-model="addSchoolForm.city" class="w-full" />
          </div>
          <div>
            <label class="form-label">Student Count *</label>
            <InputNumber v-model="addSchoolForm.student_count" class="w-full" :min="1" />
          </div>
        </div>
        <div>
          <label class="form-label">Address</label>
          <InputText v-model="addSchoolForm.address" class="w-full" />
        </div>
        <div class="grid grid-cols-2 gap-4">
          <div>
            <label class="form-label">Contact Person *</label>
            <InputText v-model="addSchoolForm.contact_person" class="w-full" />
          </div>
          <div>
            <label class="form-label">Phone</label>
            <InputText v-model="addSchoolForm.contact_phone" class="w-full" />
          </div>
        </div>
        <div v-if="addSchoolError" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{{ addSchoolError }}</div>
      </div>
      <template #footer>
        <Button label="Cancel" text @click="addSchoolDialogVisible = false" />
        <Button label="Save & Continue" :loading="addSchoolSaving" @click="saveAddSchoolAndContinue" />
      </template>
    </Dialog>

    <!-- Step 2: Convert to Agreement -->
    <Dialog v-model:visible="convertDialogVisible" header="Convert to Agreement" modal :style="{ width: '540px' }">
      <div class="space-y-4 pt-2">

        <div class="bg-slate-50 rounded-lg px-4 py-3">
          <div class="text-sm font-semibold text-slate-800">{{ convertForm.school_name }}</div>
          <div class="text-xs text-slate-400">{{ convertForm.student_count }} students</div>
        </div>

        <div>
          <label class="form-label">School Address *</label>
          <InputText v-model="convertForm.school_address" class="w-full" placeholder="Required for the agreement PDF" />
        </div>

        <!-- Option picker, only if quotation had both options -->
        <div v-if="convertOptionChoices.length > 1">
          <label class="form-label">Which Option Was Chosen? *</label>
          <div class="grid grid-cols-2 gap-3">
            <button
              v-for="opt in convertOptionChoices"
              :key="opt.value"
              @click="chooseConvertOption(opt.value)"
              class="p-3 rounded-xl border text-left transition-all"
              :class="convertForm.option_choice === opt.value
                ? 'border-blue-500 bg-blue-50'
                : 'border-slate-200 hover:border-slate-300'"
            >
              <div class="font-semibold text-sm text-slate-900 mb-1">Option {{ opt.value }}</div>
              <div class="text-xs text-slate-500">{{ opt.label }}</div>
              <div class="text-xs font-medium text-blue-700 mt-1">₹{{ opt.price }}/student</div>
            </button>
          </div>
        </div>

        <div class="grid grid-cols-2 gap-4">
          <div>
            <label class="form-label">Authorised Signatory *</label>
            <InputText v-model="convertForm.signatory_name" class="w-full" placeholder="Full name" />
          </div>
          <div>
            <label class="form-label">Designation</label>
            <InputText v-model="convertForm.signatory_designation" class="w-full" placeholder="e.g. Principal" />
          </div>
        </div>

        <div class="grid grid-cols-2 gap-4">
          <div>
            <label class="form-label">Fee per Student (₹) *</label>
            <InputNumber v-model="convertForm.fee_per_student" class="w-full" :min="1" />
          </div>
          <div>
            <label class="form-label">No. of Students *</label>
            <InputNumber v-model="convertForm.student_count" class="w-full" :min="1" />
          </div>
        </div>

        <div v-if="convertForm.fee_per_student && convertForm.student_count" class="bg-slate-50 rounded-lg px-4 py-3 flex justify-between items-center">
          <span class="text-sm text-slate-500">Total Contract Value</span>
          <span class="text-lg font-bold text-slate-900">₹{{ (convertForm.fee_per_student * convertForm.student_count).toLocaleString('en-IN') }}</span>
        </div>

        <div>
          <label class="form-label">Installment Plan *</label>
          <div class="grid grid-cols-2 gap-3">
            <button
              @click="convertForm.installment_plan = 'A'"
              class="p-3 rounded-xl border text-left transition-all"
              :class="convertForm.installment_plan === 'A' ? 'border-blue-500 bg-blue-50' : 'border-slate-200 hover:border-slate-300'"
            >
              <div class="font-semibold text-sm text-slate-900 mb-1">Plan A</div>
              <div class="text-xs text-slate-500">50% · 25% · 25%</div>
            </button>
            <button
              @click="convertForm.installment_plan = 'B'"
              class="p-3 rounded-xl border text-left transition-all"
              :class="convertForm.installment_plan === 'B' ? 'border-blue-500 bg-blue-50' : 'border-slate-200 hover:border-slate-300'"
            >
              <div class="font-semibold text-sm text-slate-900 mb-1">Plan B</div>
              <div class="text-xs text-slate-500">25% · 25% · 25% · 25%</div>
            </button>
          </div>
        </div>

        <div v-if="convertError" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{{ convertError }}</div>

      </div>
      <template #footer>
        <Button label="Cancel" text @click="convertDialogVisible = false" />
        <Button label="Save & Download Agreement" icon="pi pi-download" :loading="convertSaving" @click="saveConvertedAgreement" />
      </template>
    </Dialog>

    <!-- New Quotation Dialog -->
    <Dialog v-model:visible="dialogVisible" header="New Quotation" modal :style="{ width: '520px' }">
      <div class="space-y-5 pt-2">

        <!-- School name - searchable dropdown, free text still works -->
        <div>
          <label class="form-label">School Name *</label>
          <div :class="{ 'ring-2 ring-red-400 rounded-lg': hasIssue('school_name') }">
            <SchoolSearchSelect v-model="form.school_name" :schools="allSchools" @select="onSchoolSelect" />
          </div>
          <p v-if="hasIssue('school_name')" class="text-xs text-red-500 mt-1">{{ issueMessage('school_name') }}</p>
          <p v-else class="text-xs text-slate-400 mt-1">Search an existing school or type a new name.</p>
        </div>

        <!-- Student count -->
        <div>
          <label class="form-label">Approx. Student Count *</label>
          <InputNumber v-model="form.student_count" class="w-full" :class="{ 'ring-2 ring-amber-400 rounded-lg': hasIssue('student_count') }" :min="1" />
          <p v-if="hasIssue('student_count')" class="text-xs text-amber-600 mt-1">{{ issueMessage('student_count') }}</p>
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
          <div v-if="form.show_a" class="grid grid-cols-2 gap-3">
            <div>
              <label class="form-label">Discount %</label>
              <InputNumber v-model="form.discount_a" class="w-full" :min="0" :max="100" suffix="%" @input="e => calcPrices('discount_a', e.value)" />
            </div>
            <div>
              <label class="form-label">Final Price / Student</label>
              <div class="px-3 py-2 bg-green-50 border border-green-200 rounded-lg text-sm font-bold text-green-700">
                ₹{{ form.price_a || 299 }} / student
              </div>
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
          <div v-if="form.show_b" class="grid grid-cols-2 gap-3">
            <div>
              <label class="form-label">Discount %</label>
              <InputNumber v-model="form.discount_b" class="w-full" :min="0" :max="100" suffix="%" @input="e => calcPrices('discount_b', e.value)" />
            </div>
            <div>
              <label class="form-label">Final Price / Student</label>
              <div class="px-3 py-2 bg-yellow-50 border border-yellow-200 rounded-lg text-sm font-bold text-yellow-700">
                ₹{{ form.price_b || 169 }} / student
              </div>
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

    <SanityCheckDialog
      :visible="sanityDialogVisible"
      :warnings="pendingWarnings"
      document-type="quotation"
      :on-confirm="onSanityConfirm"
      :on-cancel="onSanityCancel"
    />

    <ConfirmDialog />
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, watch } from 'vue'
import { db, auth } from '../firebase/config'
import { activeYear, effectiveAcademicYear } from '../composables/useAcademicYear.js'
import { opsCollection, opsDoc } from '../firebase/collections.js'
import {
  getDocs, getDoc, addDoc, updateDoc, deleteDoc,
  doc, orderBy, query, serverTimestamp, limit
} from 'firebase/firestore'
import { useRoute } from 'vue-router'
import { useConfirm } from 'primevue/useconfirm'
import { useToast } from 'primevue/usetoast'
import { useAllSchools } from '../composables/useAllSchools.js'
import { useSanityCheck } from '../composables/useSanityCheck.js'
import { generateQuotationPDF, generateAgreementFiles } from '../utils/api.js'
import { generateQuotationNumber, calcPrice } from '../utils/quotationPDF.js'
import { generateAgreementNumber } from '../utils/agreementPDF.js'

import Button from 'primevue/button'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import InputNumber from 'primevue/inputnumber'
import ToggleButton from 'primevue/togglebutton'
import ProgressSpinner from 'primevue/progressspinner'
import ConfirmDialog from 'primevue/confirmdialog'
import SchoolSearchSelect from '../components/shared/SchoolSearchSelect.vue'
import SanityCheckDialog from '../components/shared/SanityCheckDialog.vue'

const route = useRoute()
const confirm = useConfirm()
const toast = useToast()
const { allSchools, loadAllSchools } = useAllSchools()
const { checkQuotation } = useSanityCheck()

const quotations = ref([])
const agreements = ref([])
const loading    = ref(true)
const dialogVisible = ref(false)
const saving     = ref(false)
const downloadingId = ref(null)
const formError  = ref('')
const settings   = ref({ default_installment_plan: 'A' })

// ── Sanity check ─────────────────────────────────────────────────────────────
const sanityDialogVisible = ref(false)
const pendingWarnings     = ref([])
const issueFields         = ref(new Set())

function hasIssue(field) {
  return issueFields.value.has(field)
}
function issueMessage(field) {
  return pendingWarnings.value.find(w => w.field === field)?.msg || ''
}

// ── Convert-to-Agreement flow ───────────────────────────────────────────────
const pendingQuotation      = ref(null)
const addSchoolDialogVisible = ref(false)
const addSchoolSaving       = ref(false)
const addSchoolError        = ref('')
const addSchoolForm = reactive({
  name: '', city: '', address: '',
  contact_person: '', contact_phone: '', student_count: null,
})

const convertDialogVisible = ref(false)
const convertSaving        = ref(false)
const convertError         = ref('')
const convertForm = reactive({
  school_id: null, school_name: '', school_address: '', school_phone: '',
  student_count: null, signatory_name: '', signatory_designation: '',
  hpc_type: 'printed and digital', fee_per_student: null,
  installment_plan: 'A', option_choice: null,
})

const convertOptionChoices = computed(() => {
  const q = pendingQuotation.value
  if (!q) return []
  const choices = []
  if (q.show_a !== false && q.price_a) choices.push({ value: 'A', label: 'Printed + Digital HPC', price: q.price_a })
  if (q.show_b !== false && q.price_b) choices.push({ value: 'B', label: 'Only Digital HPC', price: q.price_b })
  return choices
})

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

const visibleQuotations = computed(() => {
  if (!activeYear.value || activeYear.value === 'All Years') return quotations.value
  return quotations.value.filter(q => q.academic_year === activeYear.value)
})

// Row highlight from a global search result (?highlight=id)
const highlightedId = ref(route.query.highlight || null)
function rowClass(data) {
  return data.id === highlightedId.value ? 'gs-highlight-row' : ''
}
// Handles jumping to a result while already on this page (router.push only
// changes the query, so the component doesn't remount and onMounted won't rerun).
watch(() => route.query.highlight, (id) => {
  if (!id) return
  highlightedId.value = id
  setTimeout(() => { highlightedId.value = null }, 4000)
})

// ── Load ──────────────────────────────────────────────────────────────────────
async function loadQuotations() {
  loading.value = true
  try {
    const q = query(opsCollection('quotations'), orderBy('created_at', 'desc'), limit(500))
    const snap = await getDocs(q)
    quotations.value = snap.docs.map(d => ({ id: d.id, ...d.data() }))
  } catch (e) {
    toast.add({ severity: 'error', summary: 'Error', detail: 'Could not load quotations', life: 3000 })
  } finally {
    loading.value = false
  }
}

async function loadAgreements() {
  try {
    const snap = await getDocs(opsCollection('agreements'))
    agreements.value = snap.docs.map(d => ({ id: d.id, ...d.data() }))
  } catch (e) {
    console.error('Could not load agreements', e)
  }
}

async function loadSettings() {
  try {
    const snap = await getDoc(doc(db, 'operations', 'settings'))
    if (snap.exists()) settings.value = { ...settings.value, ...snap.data() }
  } catch (e) {
    console.error('Could not load settings', e)
  }
}

// ── Handlers ──────────────────────────────────────────────────────────────────
function onSchoolSelect(s) {
  form.school_id     = s.id || null
  form.school_name   = s.name
  form.student_count = s.student_count || null
}

function calcPrices(field, value) {
  if (field) form[field] = value
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
  issueFields.value = new Set()
  pendingWarnings.value = []
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

  const warnings = checkQuotation(form)
  if (warnings.length > 0) {
    pendingWarnings.value = warnings
    sanityDialogVisible.value = true
    return
  }

  await executeSaveAndDownload()
}

async function executeSaveAndDownload(bypassedWarnings = 0) {
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
      academic_year:  effectiveAcademicYear(),
      created_at:     serverTimestamp(),
      created_by:     auth.currentUser?.email || 'unknown',
    }

    await addDoc(opsCollection('quotations'), payload)

    // Generate and download PDF
    await generateQuotationPDF({ ...payload, quotation_number: qNum })

    toast.add({ severity: 'success', summary: 'Done', detail: `Quotation ${qNum} saved & downloaded`, life: 3000 })
    if (bypassedWarnings > 0) {
      toast.add({ severity: 'warn', summary: 'Heads up', detail: `Generated with ${bypassedWarnings} unresolved warning${bypassedWarnings !== 1 ? 's' : ''} — please review`, life: 5000 })
    }
    dialogVisible.value = false
    await loadQuotations()
  } catch (e) {
    formError.value = 'Something went wrong. Try again.'
    console.error(e)
  } finally {
    saving.value = false
  }
}

function onSanityConfirm() {
  const count = pendingWarnings.value.length
  sanityDialogVisible.value = false
  issueFields.value = new Set()
  executeSaveAndDownload(count)
}

function onSanityCancel() {
  issueFields.value = new Set(pendingWarnings.value.filter(w => w.field).map(w => w.field))
  sanityDialogVisible.value = false
}

async function download(q) {
  downloadingId.value = q.id
  try {
    await generateQuotationPDF(q)
  } catch (e) {
    console.error(e)
    toast.add({ severity: 'error', summary: 'Download failed', detail: e.message || 'Could not generate PDF', life: 4000 })
  } finally {
    downloadingId.value = null
  }
}

// ── Convert to Agreement ──────────────────────────────────────────────────────
async function startConvert(q) {
  pendingQuotation.value = q
  const school = allSchools.value.find(s => s.id === q.school_id)
  if (school) {
    await openConvertDialog(school)
  } else {
    openAddSchoolDialog(q)
  }
}

function openAddSchoolDialog(q) {
  Object.assign(addSchoolForm, {
    name: q.school_name || '',
    city: '',
    address: '',
    contact_person: '',
    contact_phone: '',
    student_count: q.student_count || null,
  })
  addSchoolError.value = ''
  addSchoolDialogVisible.value = true
}

async function saveAddSchoolAndContinue() {
  if (!addSchoolForm.name.trim())           { addSchoolError.value = 'School name is required'; return }
  if (!addSchoolForm.city.trim())           { addSchoolError.value = 'City is required'; return }
  if (!addSchoolForm.contact_person.trim()) { addSchoolError.value = 'Contact person is required'; return }
  if (!addSchoolForm.student_count)         { addSchoolError.value = 'Student count is required'; return }
  addSchoolError.value = ''

  addSchoolSaving.value = true
  try {
    const payload = {
      name:           addSchoolForm.name.trim(),
      city:           addSchoolForm.city.trim(),
      address:        addSchoolForm.address.trim(),
      contact_person: addSchoolForm.contact_person.trim(),
      contact_phone:  addSchoolForm.contact_phone.trim(),
      student_count:  addSchoolForm.student_count,
      statuses:       ['Converted'],
      notes:          [],
      created_at:     serverTimestamp(),
      created_by:     auth.currentUser?.email || 'unknown',
    }
    const ref = await addDoc(opsCollection('schools'), payload)
    await loadAllSchools()

    addSchoolDialogVisible.value = false
    await openConvertDialog({ id: ref.id, ...payload })
  } catch (e) {
    console.error(e)
    addSchoolError.value = 'Something went wrong. Try again.'
  } finally {
    addSchoolSaving.value = false
  }
}

async function openConvertDialog(school) {
  const q = pendingQuotation.value

  // Re-fetch the school record fresh so we never prefill a stale address
  // (allSchools may not reflect edits made since the last load).
  let freshSchool = school
  try {
    const snap = await getDoc(opsDoc('schools', school.id))
    if (snap.exists()) freshSchool = { id: snap.id, ...snap.data() }
  } catch (e) {
    console.error('Could not re-fetch school record', e)
  }

  const choices = convertOptionChoices.value
  const option = choices.length === 1 ? choices[0].value : null

  Object.assign(convertForm, {
    school_id:             freshSchool.id,
    school_name:           freshSchool.name || q.school_name,
    school_address:        freshSchool.address || '',
    school_phone:          freshSchool.contact_phone || '',
    student_count:         q.student_count || freshSchool.student_count || null,
    signatory_name:        freshSchool.contact_person || '',
    signatory_designation: freshSchool.contact_designation || '',
    option_choice:         option,
    hpc_type:              option === 'B' ? 'digital only' : 'printed and digital',
    fee_per_student:       option === 'B' ? q.price_b : q.price_a,
    installment_plan:      settings.value.default_installment_plan || 'A',
  })
  convertError.value = ''
  convertDialogVisible.value = true
}

function chooseConvertOption(opt) {
  convertForm.option_choice   = opt
  convertForm.hpc_type        = opt === 'B' ? 'digital only' : 'printed and digital'
  convertForm.fee_per_student = opt === 'B' ? pendingQuotation.value.price_b : pendingQuotation.value.price_a
}

async function saveConvertedAgreement() {
  if (convertOptionChoices.value.length > 1 && !convertForm.option_choice) {
    convertError.value = 'Select which option the school chose'; return
  }
  if (!convertForm.school_address.trim())  { convertError.value = 'School address is required'; return }
  if (!convertForm.signatory_name.trim())  { convertError.value = 'Signatory name is required'; return }
  if (!convertForm.fee_per_student)        { convertError.value = 'Fee per student is required'; return }
  if (!convertForm.student_count)          { convertError.value = 'Student count is required'; return }
  convertError.value = ''

  convertSaving.value = true
  try {
    const existingNums = agreements.value.map(a => a.agreement_number)
    const aNum = generateAgreementNumber(existingNums)

    const payload = {
      school_id:             convertForm.school_id,
      school_name:           convertForm.school_name,
      school_address:        convertForm.school_address.trim(),
      school_phone:          convertForm.school_phone,
      signatory_name:        convertForm.signatory_name.trim(),
      signatory_designation: convertForm.signatory_designation.trim(),
      hpc_type:              convertForm.hpc_type,
      fee_per_student:       convertForm.fee_per_student,
      student_count:         convertForm.student_count,
      installment_plan:      convertForm.installment_plan,
      agreement_number:      aNum,
      status:                'Sent',
      academic_year:         effectiveAcademicYear(),
      created_at:            serverTimestamp(),
      created_by:            auth.currentUser?.email || 'unknown',
    }

    const agreementRef = await addDoc(opsCollection('agreements'), payload)
    await generateAgreementFiles({ ...payload, agreement_number: aNum })

    await updateDoc(opsDoc('quotations', pendingQuotation.value.id), {
      converted_to_agreement_id: agreementRef.id,
      converted: true,
      updated_at: serverTimestamp(),
      updated_by: auth.currentUser?.email || 'unknown',
    })

    toast.add({ severity: 'success', summary: 'Converted', detail: `Agreement ${aNum} created`, life: 3000 })
    convertDialogVisible.value = false
    pendingQuotation.value = null
    await Promise.all([loadQuotations(), loadAgreements()])
  } catch (e) {
    console.error(e)
    convertError.value = 'Something went wrong. Try again.'
  } finally {
    convertSaving.value = false
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
  await Promise.all([loadQuotations(), loadAllSchools(), loadAgreements(), loadSettings()])

  // Pre-fill from "New Quotation" launched off a school's drawer
  if (route.query.school_name) {
    openNew()
    form.school_id     = route.query.school_id || null
    form.school_name   = route.query.school_name
    form.student_count = route.query.student_count ? Number(route.query.student_count) : null
  }

  if (highlightedId.value) {
    setTimeout(() => { highlightedId.value = null }, 4000)
  }
})

watch(activeYear, () => { loadQuotations() })
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

:deep(.gs-highlight-row) {
  animation: gs-row-fade 4s ease-out;
}
@keyframes gs-row-fade {
  0%   { background-color: #fef9c3; }
  70%  { background-color: #fef9c3; }
  100% { background-color: transparent; }
}
</style>
