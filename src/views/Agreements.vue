<template>
  <div>

    <!-- Header -->
    <div class="flex items-center justify-between mb-6">
      <div>
        <h2 class="text-lg font-semibold text-slate-900">Agreements</h2>
        <p class="text-sm text-slate-500 mt-0.5">{{ visibleAgreements.length }} total</p>
      </div>
      <Button label="New Agreement" icon="pi pi-plus" @click="openNew" />
    </div>

    <!-- Loading -->
    <div v-if="loading" class="flex items-center justify-center py-20">
      <ProgressSpinner style="width:32px;height:32px" />
    </div>

    <!-- Empty -->
    <div v-else-if="visibleAgreements.length === 0" class="text-center py-20 bg-white rounded-xl border border-slate-200">
      <i class="pi pi-file-edit text-4xl text-slate-300 mb-3 block"></i>
      <p class="text-slate-500 font-medium">No agreements yet</p>
      <Button label="New Agreement" icon="pi pi-plus" class="mt-4" @click="openNew" />
    </div>

    <!-- Table -->
    <div v-else class="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <DataTable :value="visibleAgreements" size="small" stripedRows :rowClass="rowClass">

        <Column field="agreement_number" header="Ref #" style="width:140px">
          <template #body="{ data }">
            <span class="font-mono text-xs text-slate-600">{{ data.agreement_number }}</span>
          </template>
        </Column>

        <Column field="school_name" header="School" sortable>
          <template #body="{ data }">
            <div>
              <div class="text-sm font-medium text-slate-900">{{ data.school_name }}</div>
              <div class="text-xs text-slate-400">{{ data.signatory_name }}{{ data.signatory_designation ? ' · ' + data.signatory_designation : '' }}</div>
            </div>
          </template>
        </Column>

        <Column field="fee_per_student" header="Fee / Student">
          <template #body="{ data }">
            <span class="text-sm font-semibold text-slate-900">₹{{ data.fee_per_student }}/-</span>
          </template>
        </Column>

        <Column header="Total Value">
          <template #body="{ data }">
            <span class="text-sm text-slate-700">₹{{ (data.fee_per_student * data.student_count).toLocaleString('en-IN') }}</span>
          </template>
        </Column>

        <Column field="installment_plan" header="Plan">
          <template #body="{ data }">
            <span class="px-2 py-0.5 rounded-full text-xs font-semibold bg-blue-50 text-blue-700">
              Plan {{ data.installment_plan }} · {{ data.installment_plan === 'B' ? '25-25-25-25' : '50-25-25' }}
            </span>
          </template>
        </Column>

        <Column field="status" header="Status" style="width:90px">
          <template #body="{ data }">
            <span
              class="px-2 py-0.5 rounded-full text-xs font-semibold"
              :class="data.status === 'Signed' ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'"
            >{{ data.status || 'Sent' }}</span>
          </template>
        </Column>

        <Column field="created_at" header="Date" sortable>
          <template #body="{ data }">
            <span class="text-xs text-slate-400">{{ formatDate(data.created_at) }}</span>
          </template>
        </Column>

        <Column header="" style="width:130px">
          <template #body="{ data }">
            <div class="flex gap-1">
              <Button
                :icon="downloadingId === data.id ? 'pi pi-spin pi-spinner' : 'pi pi-download'"
                text rounded size="small"
                :disabled="downloadingId === data.id"
                v-tooltip="'Download PDF'"
                @click="download(data)"
              />
              <Button
                v-if="data.signed_pdf_url"
                icon="pi pi-file-check"
                text rounded size="small"
                severity="success"
                v-tooltip="'View Signed PDF'"
                @click="viewSignedPdf(data)"
              />
              <Button
                icon="pi pi-upload"
                text rounded size="small"
                :loading="uploadingId === data.id"
                v-tooltip="'Upload Signed PDF'"
                @click="triggerUpload(data)"
              />
              <Button icon="pi pi-trash" text rounded size="small" severity="danger" @click="confirmDelete(data)" />
            </div>
          </template>
        </Column>

      </DataTable>
    </div>

    <input
      ref="fileInputEl"
      type="file"
      accept="application/pdf"
      class="hidden"
      @change="onFileSelected"
    />

    <!-- New Agreement Dialog -->
    <Dialog v-model:visible="dialogVisible" header="New Agreement" modal :style="{ width: '540px' }">
      <div class="space-y-4 pt-2">

        <!-- School name - searchable dropdown, free text still works -->
        <div>
          <label class="form-label">School Name *</label>
          <SchoolSearchSelect v-model="form.school_name" :schools="allSchools" @select="onSchoolSelect" />
          <p class="text-xs text-slate-400 mt-1">Search an existing school or type a new name.</p>
        </div>

        <!-- Signatory -->
        <div class="grid grid-cols-2 gap-4">
          <div>
            <label class="form-label">Authorised Signatory *</label>
            <InputText v-model="form.signatory_name" class="w-full" placeholder="Full name" />
          </div>
          <div>
            <label class="form-label">Designation</label>
            <InputText v-model="form.signatory_designation" class="w-full" placeholder="e.g. Principal" />
          </div>
        </div>

        <!-- HPC Type -->
        <div>
          <label class="form-label">HPC Type *</label>
          <div class="flex gap-2">
            <button
              v-for="opt in hpcTypes"
              :key="opt.value"
              @click="form.hpc_type = opt.value"
              class="flex-1 py-2 px-3 rounded-lg text-sm font-medium border transition-all"
              :class="form.hpc_type === opt.value
                ? 'bg-slate-900 text-white border-slate-900'
                : 'bg-white text-slate-600 border-slate-200 hover:border-slate-400'"
            >{{ opt.label }}</button>
          </div>
        </div>

        <!-- Fee + Students -->
        <div class="grid grid-cols-2 gap-4">
          <div>
            <label class="form-label">Fee per Student (₹) *</label>
            <InputNumber v-model="form.fee_per_student" class="w-full" :min="1" @input="calcTotal" />
          </div>
          <div>
            <label class="form-label">No. of Students *</label>
            <InputNumber v-model="form.student_count" class="w-full" :min="1" @input="calcTotal" />
          </div>
        </div>

        <!-- Total preview -->
        <div v-if="form.fee_per_student && form.student_count" class="bg-slate-50 rounded-lg px-4 py-3">
          <div class="flex justify-between items-center mb-2">
            <span class="text-sm text-slate-500">Total Contract Value</span>
            <span class="text-lg font-bold text-slate-900">₹{{ totalValue.toLocaleString('en-IN') }}</span>
          </div>
        </div>

        <!-- Installment Plan -->
        <div>
          <label class="form-label">Installment Plan *</label>
          <div class="grid grid-cols-2 gap-3">
            <button
              @click="form.installment_plan = 'A'"
              class="p-3 rounded-xl border text-left transition-all"
              :class="form.installment_plan === 'A'
                ? 'border-blue-500 bg-blue-50'
                : 'border-slate-200 hover:border-slate-300'"
            >
              <div class="font-semibold text-sm text-slate-900 mb-1">Plan A</div>
              <div class="text-xs text-slate-500">50% · 25% · 25%</div>
              <div v-if="form.fee_per_student && form.student_count" class="mt-2 space-y-0.5">
                <div v-for="(pct, i) in [50,25,25]" :key="i" class="text-xs font-medium text-blue-700">
                  Inst. {{ i+1 }}: ₹{{ Math.round(totalValue * pct / 100).toLocaleString('en-IN') }}
                </div>
              </div>
            </button>
            <button
              @click="form.installment_plan = 'B'"
              class="p-3 rounded-xl border text-left transition-all"
              :class="form.installment_plan === 'B'
                ? 'border-blue-500 bg-blue-50'
                : 'border-slate-200 hover:border-slate-300'"
            >
              <div class="font-semibold text-sm text-slate-900 mb-1">Plan B</div>
              <div class="text-xs text-slate-500">25% · 25% · 25% · 25%</div>
              <div v-if="form.fee_per_student && form.student_count" class="mt-2 space-y-0.5">
                <div v-for="(pct, i) in [25,25,25,25]" :key="i" class="text-xs font-medium text-blue-700">
                  Inst. {{ i+1 }}: ₹{{ Math.round(totalValue * pct / 100).toLocaleString('en-IN') }}
                </div>
              </div>
            </button>
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
import { ref, reactive, computed, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { db, storage, auth } from '../firebase/config'
import { activeYear, effectiveAcademicYear } from '../composables/useAcademicYear.js'
import { opsCollection, opsDoc } from '../firebase/collections.js'
import {
  getDocs, getDoc, addDoc, updateDoc, deleteDoc,
  doc, orderBy, query, serverTimestamp, limit
} from 'firebase/firestore'
import { ref as storageRef, uploadBytes, getDownloadURL } from 'firebase/storage'
import { useConfirm } from 'primevue/useconfirm'
import { useCelebration } from '../composables/useCelebration'
import { useAllSchools } from '../composables/useAllSchools.js'
import { useToast } from 'primevue/usetoast'
import { generateAgreementFiles } from '../utils/api.js'
import { generateAgreementNumber } from '../utils/agreementPDF.js'

import Button from 'primevue/button'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import InputNumber from 'primevue/inputnumber'
import ProgressSpinner from 'primevue/progressspinner'
import ConfirmDialog from 'primevue/confirmdialog'
import SchoolSearchSelect from '../components/shared/SchoolSearchSelect.vue'

const route = useRoute()
const confirm = useConfirm()
const { celebrate } = useCelebration()
const toast = useToast()
const { allSchools, loadAllSchools } = useAllSchools()

const agreements = ref([])
const loading    = ref(true)
const dialogVisible = ref(false)
const saving     = ref(false)
const formError  = ref('')
const fileInputEl  = ref(null)
const uploadTarget = ref(null)
const uploadingId  = ref(null)
const downloadingId = ref(null)
const settings     = ref({ default_installment_plan: 'A' })

const hpcTypes = [
  { label: 'Printed + Digital HPC', value: 'printed and digital' },
  { label: 'Only Digital HPC',      value: 'digital only' },
]

const emptyForm = () => ({
  school_id:             null,
  school_name:           '',
  school_address:        '',
  signatory_name:        '',
  signatory_designation: '',
  hpc_type:              'printed and digital',
  fee_per_student:       null,
  student_count:         null,
  installment_plan:      'A',
})

const form = reactive(emptyForm())

const totalValue = computed(() =>
  form.fee_per_student && form.student_count
    ? form.fee_per_student * form.student_count
    : 0
)

const visibleAgreements = computed(() => {
  if (!activeYear.value || activeYear.value === 'All Years') return agreements.value
  return agreements.value.filter(a => a.academic_year === activeYear.value)
})

// Row highlight from a global search result (?highlight=id)
const highlightedId = ref(route.query.highlight || null)
function rowClass(data) {
  return data.id === highlightedId.value ? 'gs-highlight-row' : ''
}
watch(() => route.query.highlight, (id) => {
  if (!id) return
  highlightedId.value = id
  setTimeout(() => { highlightedId.value = null }, 4000)
})

async function loadSettings() {
  try {
    const snap = await getDoc(doc(db, 'operations', 'settings'))
    if (snap.exists()) settings.value = { ...settings.value, ...snap.data() }
  } catch (e) {
    console.error('Could not load settings', e)
  }
}

// ── Load ──────────────────────────────────────────────────────────────────────
async function loadAgreements() {
  loading.value = true
  try {
    const q = query(opsCollection('agreements'), orderBy('created_at', 'desc'), limit(500))
    const snap = await getDocs(q)
    agreements.value = snap.docs.map(d => ({ id: d.id, ...d.data() }))
  } catch (e) {
    toast.add({ severity: 'error', summary: 'Error', detail: 'Could not load agreements', life: 3000 })
  } finally {
    loading.value = false
  }
}

// ── Handlers ──────────────────────────────────────────────────────────────────
function onSchoolSelect(s) {
  form.school_id             = s.id || null
  form.school_name           = s.name
  form.school_address        = s.address || ''
  form.student_count         = s.student_count || null
  if (!form.signatory_name) {
    form.signatory_name        = s.contact_person || ''
    form.signatory_designation = s.contact_designation || ''
  }
}

function calcTotal() { /* reactive via computed */ }

function openNew() {
  Object.assign(form, {
    school_id:             null,
    school_name:           '',
    school_address:        '',
    signatory_name:        '',
    signatory_designation: '',
    hpc_type:              'printed and digital',
    fee_per_student:       null,
    student_count:         null,
    installment_plan:      settings.value.default_installment_plan || 'A',
  })
  formError.value = ''
  dialogVisible.value = true
}

function validate() {
  if (!form.school_name.trim())  return 'School name is required'
  if (!form.signatory_name.trim()) return 'Signatory name is required'
  if (!form.fee_per_student)     return 'Fee per student is required'
  if (!form.student_count)       return 'Student count is required'
  if (!form.installment_plan)    return 'Select an installment plan'
  return ''
}

async function saveAndDownload() {
  formError.value = validate()
  if (formError.value) return

  saving.value = true
  try {
    const existingNums = agreements.value.map(a => a.agreement_number)
    const aNum = generateAgreementNumber(existingNums)

    const payload = {
      school_id:             form.school_id || null,
      school_name:           form.school_name,
      school_address:        form.school_address,
      signatory_name:        form.signatory_name.trim(),
      signatory_designation: form.signatory_designation.trim(),
      hpc_type:              form.hpc_type,
      fee_per_student:       form.fee_per_student,
      student_count:         form.student_count,
      installment_plan:      form.installment_plan,
      agreement_number:      aNum,
      status:                'Sent',
      academic_year:         effectiveAcademicYear(),
      created_at:            serverTimestamp(),
      created_by:            auth.currentUser?.email || 'unknown',
    }

    await addDoc(opsCollection('agreements'), payload)

    await generateAgreementFiles({ ...payload, agreement_number: aNum })


    toast.add({ severity: 'success', summary: 'Done', detail: `Agreement ${aNum} saved & downloaded`, life: 3000 })
    dialogVisible.value = false
    await loadAgreements()
  } catch (e) {
    formError.value = 'Something went wrong. Try again.'
    console.error(e)
  } finally {
    saving.value = false
  }
}

async function download(a) {
  downloadingId.value = a.id
  try {
    await generateAgreementFiles(a)
  } catch (e) {
    console.error(e)
    toast.add({ severity: 'error', summary: 'Download failed', detail: e.message || 'Could not generate files', life: 4000 })
  } finally {
    downloadingId.value = null
  }
}

function viewSignedPdf(a) {
  if (a.signed_pdf_url) window.open(a.signed_pdf_url, '_blank')
}

function triggerUpload(a) {
  uploadTarget.value = a
  fileInputEl.value?.click()
}

async function onFileSelected(e) {
  const file = e.target.files?.[0]
  e.target.value = ''
  if (!file || !uploadTarget.value) return

  const a = uploadTarget.value
  uploadingId.value = a.id
  try {
    const path = `agreements/${a.id}/signed_${Date.now()}.pdf`
    const sRef = storageRef(storage, path)
    await uploadBytes(sRef, file)
    const url = await getDownloadURL(sRef)

    await updateDoc(opsDoc('agreements', a.id), {
      status: 'Signed',
      signed_pdf_url: url,
      updated_at: serverTimestamp(),
      updated_by: auth.currentUser?.email || 'unknown',
    })
    toast.add({ severity: 'success', summary: 'Signed', detail: `Signed agreement saved for ${a.school_name}`, life: 3000 })
    celebrate(`${a.school_name} signed the agreement!`, '✍️', 'agreement')
    await loadAgreements()
  } catch (err) {
    console.error(err)
    toast.add({ severity: 'error', summary: 'Upload failed', detail: err.message || 'Could not upload signed PDF', life: 4000 })
  } finally {
    uploadingId.value = null
    uploadTarget.value = null
  }
}

function confirmDelete(a) {
  confirm.require({
    message: `Delete agreement ${a.agreement_number}?`,
    header: 'Delete Agreement',
    icon: 'pi pi-exclamation-triangle',
    rejectLabel: 'Cancel',
    acceptLabel: 'Delete',
    acceptClass: 'p-button-danger',
    accept: async () => {
      try {
        await deleteDoc(opsDoc('agreements', a.id))
        toast.add({ severity: 'info', summary: 'Deleted', life: 2000 })
        await loadAgreements()
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
  await Promise.all([loadAgreements(), loadAllSchools(), loadSettings()])

  // Pre-fill from "New Agreement" launched off a school's profile page
  if (route.query.school_name) {
    openNew()
    form.school_id      = route.query.school_id || null
    form.school_name     = route.query.school_name
    form.school_address  = route.query.school_address || ''
    form.student_count   = route.query.student_count ? Number(route.query.student_count) : null

    const fullSchool = form.school_id ? allSchools.value.find(s => s.id === form.school_id) : null
    if (fullSchool) {
      const poc = (fullSchool.pocs || [])[0]
      form.signatory_name        = poc?.name || fullSchool.contact_person || ''
      form.signatory_designation = poc?.position || fullSchool.contact_designation || ''
      if (fullSchool.price_per_student) form.fee_per_student = fullSchool.price_per_student
      if (fullSchool.hpc_type)          form.hpc_type = fullSchool.hpc_type
      if (fullSchool.installment_plan)  form.installment_plan = fullSchool.installment_plan
    }
  }

  if (highlightedId.value) {
    setTimeout(() => { highlightedId.value = null }, 4000)
  }
})

watch(activeYear, () => { loadAgreements() })
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
