<template>
  <div>

    <!-- Header -->
    <div class="flex items-center justify-between mb-6">
      <div>
        <h2 class="text-lg font-semibold text-slate-900">Schools</h2>
        <p class="text-sm text-slate-500 mt-0.5">{{ filteredSchools.length }} of {{ schools.length }}</p>
      </div>
      <Button label="Add School" icon="pi pi-plus" @click="openAddDialog" />
    </div>

    <!-- Filter tabs -->
    <div class="flex gap-2 mb-4">
      <button
        v-for="tab in statusTabs"
        :key="tab.key"
        @click="activeFilter = tab.key"
        class="px-3 py-1.5 rounded-lg text-sm font-medium transition-all"
        :class="activeFilter === tab.key
          ? 'bg-slate-900 text-white'
          : 'bg-white border border-slate-200 text-slate-600 hover:border-slate-300'"
      >
        {{ tab.label }}
        <span class="ml-1.5 text-xs opacity-70">{{ tab.count }}</span>
      </button>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="flex items-center justify-center py-20">
      <ProgressSpinner style="width:32px;height:32px" />
    </div>

    <!-- Empty -->
    <div v-else-if="filteredSchools.length === 0" class="text-center py-20 bg-white rounded-xl border border-slate-200">
      <i class="pi pi-building text-4xl text-slate-300 mb-3 block"></i>
      <p class="text-slate-500 font-medium">No schools here</p>
      <Button v-if="schools.length === 0" label="Add School" icon="pi pi-plus" class="mt-4" @click="openAddDialog" />
    </div>

    <!-- Table -->
    <div v-else class="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <DataTable :value="filteredSchools" size="small" stripedRows>

        <Column field="name" header="School" sortable>
          <template #body="{ data }">
            <div
              class="cursor-pointer hover:text-blue-600 transition-colors"
              @click="openProfile(data)"
            >
              <div class="font-medium text-slate-900 text-sm">{{ data.name }}</div>
              <div class="text-xs text-slate-400 mt-0.5">{{ data.city }}</div>
            </div>
          </template>
        </Column>

        <Column field="contact_person" header="Contact">
          <template #body="{ data }">
            <div>
              <div class="text-sm text-slate-700">{{ data.contact_person }}</div>
              <div class="text-xs text-slate-400">{{ data.contact_phone }}</div>
            </div>
          </template>
        </Column>

        <Column field="student_count" header="Students" sortable>
          <template #body="{ data }">
            <span class="text-sm font-mono text-slate-700">{{ data.student_count }}</span>
          </template>
        </Column>

        <Column field="statuses" header="Status">
          <template #body="{ data }">
            <div class="flex flex-wrap gap-1">
              <span
                v-for="s in (data.statuses || [])"
                :key="s"
                class="px-2 py-0.5 rounded-full text-xs font-semibold"
                :class="statusStyle(s)"
              >{{ s }}</span>
              <span v-if="!(data.statuses || []).length" class="text-xs text-slate-300">—</span>
            </div>
          </template>
        </Column>

        <Column field="rm" header="RM">
          <template #body="{ data }">
            <span
              v-if="data.rm"
              class="px-2 py-0.5 rounded-full text-xs font-semibold"
              :class="rmStyle(data.rm)"
            >{{ data.rm }}</span>
            <span v-else class="text-xs text-slate-300">—</span>
          </template>
        </Column>

        <Column field="created_at" header="Added" sortable>
          <template #body="{ data }">
            <span class="text-xs text-slate-400">{{ formatDate(data.created_at) }}</span>
          </template>
        </Column>

        <Column header="" style="width:80px">
          <template #body="{ data }">
            <div class="flex gap-1">
              <Button icon="pi pi-pencil" text rounded size="small" @click="openEditDialog(data)" />
              <Button icon="pi pi-trash" text rounded size="small" severity="danger" @click="confirmDelete(data)" />
            </div>
          </template>
        </Column>

      </DataTable>
    </div>

    <!-- Add/Edit Dialog -->
    <Dialog
      v-model:visible="dialogVisible"
      :header="editingSchool ? 'Edit School' : 'Add School'"
      modal
      :style="{ width: '520px' }"
    >
      <div class="space-y-4 pt-2">
        <div class="grid grid-cols-2 gap-4">
          <div class="col-span-2">
            <label class="form-label">School Name *</label>
            <InputText v-model="form.name" class="w-full" placeholder="e.g. Sangam School of Excellence" />
          </div>
          <div>
            <label class="form-label">City *</label>
            <InputText v-model="form.city" class="w-full" placeholder="e.g. Pune" />
          </div>
          <div>
            <label class="form-label">Student Count *</label>
            <InputNumber v-model="form.student_count" class="w-full" :min="1" />
          </div>
          <div class="col-span-2">
            <label class="form-label">Address</label>
            <Textarea v-model="form.address" class="w-full" rows="2" autoResize />
          </div>
          <div>
            <label class="form-label">Contact Person *</label>
            <InputText v-model="form.contact_person" class="w-full" />
          </div>
          <div>
            <label class="form-label">Designation</label>
            <InputText v-model="form.contact_designation" class="w-full" />
          </div>
          <div>
            <label class="form-label">Phone</label>
            <InputText v-model="form.contact_phone" class="w-full" />
          </div>
          <div>
            <label class="form-label">Email</label>
            <InputText v-model="form.contact_email" class="w-full" />
          </div>
          <div>
            <label class="form-label">Relationship Manager</label>
            <Select v-model="form.rm" :options="rmOptions" placeholder="Assign RM" class="w-full" showClear />
          </div>
          <div class="col-span-2">
            <label class="form-label">Modules</label>
            <MultiSelect v-model="form.modules" :options="moduleOptions" placeholder="Select modules" class="w-full" />
          </div>
        </div>
        <div v-if="formError" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{{ formError }}</div>
      </div>
      <template #footer>
        <Button label="Cancel" text @click="dialogVisible = false" />
        <Button :label="editingSchool ? 'Save Changes' : 'Add School'" :loading="saving" @click="saveSchool" />
      </template>
    </Dialog>

    <ConfirmDialog />
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { db, auth } from '../firebase/config'
import { opsCollection, opsDoc } from '../firebase/collections.js'
import { getDocs, getDoc, addDoc, updateDoc, deleteDoc, doc, orderBy, query, serverTimestamp, limit } from 'firebase/firestore'
import { useConfirm } from 'primevue/useconfirm'
import { useToast } from 'primevue/usetoast'
import { useCelebration } from '../composables/useCelebration'

import Button from 'primevue/button'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import InputNumber from 'primevue/inputnumber'
import Textarea from 'primevue/textarea'
import MultiSelect from 'primevue/multiselect'
import Select from 'primevue/select'
import ProgressSpinner from 'primevue/progressspinner'
import ConfirmDialog from 'primevue/confirmdialog'

const router = useRouter()
const confirm = useConfirm()
const toast = useToast()
const { celebrate } = useCelebration()

const schools       = ref([])
const loading       = ref(true)
const dialogVisible = ref(false)
const editingSchool = ref(null)
const saving        = ref(false)
const formError     = ref('')
const activeFilter  = ref('all')

const allStatuses   = ['Lead', 'Negotiation', 'Converted']
const rmOptions     = ['Angel', 'Siddhesh']
const moduleOptions = ref(['HPC', 'SEW', 'Co-Scholastic', 'Remarks', 'Parent App'])

// ── Filters ───────────────────────────────────────────────────────────────────
const statusTabs = computed(() => [
  { key: 'all',         label: 'All',         count: schools.value.length },
  { key: 'Lead',        label: 'Lead',        count: schools.value.filter(s => s.statuses?.includes('Lead')).length },
  { key: 'Negotiation', label: 'Negotiation', count: schools.value.filter(s => s.statuses?.includes('Negotiation')).length },
  { key: 'Converted',   label: 'Converted',   count: schools.value.filter(s => s.statuses?.includes('Converted')).length },
])

const filteredSchools = computed(() => {
  if (activeFilter.value === 'all') return schools.value
  return schools.value.filter(s => s.statuses?.includes(activeFilter.value))
})

// ── Style helpers ──────────────────────────────────────────────────────────────
function statusStyle(s) {
  if (s === 'Converted')   return 'bg-green-100 text-green-700'
  if (s === 'Negotiation') return 'bg-amber-100 text-amber-700'
  return 'bg-blue-100 text-blue-700'
}

function rmStyle(rm) {
  if (rm === 'Angel') return 'bg-purple-100 text-purple-700'
  if (rm === 'Siddhesh') return 'bg-blue-100 text-blue-700'
  return 'bg-slate-100 text-slate-600'
}

// ── Load ──────────────────────────────────────────────────────────────────────
async function loadSchools() {
  loading.value = true
  try {
    const q    = query(opsCollection('schools'), orderBy('created_at', 'desc'), limit(500))
    const snap = await getDocs(q)
    schools.value = snap.docs.map(d => ({ id: d.id, ...d.data() }))
  } catch (e) {
    toast.add({ severity: 'error', summary: 'Error', detail: 'Could not load schools', life: 3000 })
  } finally {
    loading.value = false
  }
}

async function loadModuleSettings() {
  try {
    const snap = await getDoc(doc(db, 'operations', 'settings'))
    if (snap.exists()) {
      const data = snap.data()
      if (Array.isArray(data.modules) && data.modules.length) moduleOptions.value = data.modules
    }
  } catch (e) {
    console.error('Could not load settings', e)
  }
}

// ── Navigation ────────────────────────────────────────────────────────────────
function openProfile(school) {
  router.push({ name: 'school-profile', params: { id: school.id } })
}

// ── Add/Edit dialog ───────────────────────────────────────────────────────────
const emptyForm = () => ({
  name: '', city: '', address: '', student_count: null,
  contact_person: '', contact_designation: '',
  contact_phone: '', contact_email: '', modules: [], rm: null,
})
const form = reactive(emptyForm())

function openAddDialog() {
  editingSchool.value = null
  Object.assign(form, emptyForm())
  formError.value = ''
  dialogVisible.value = true
}

function openEditDialog(school) {
  editingSchool.value = school
  Object.assign(form, {
    name: school.name || '', city: school.city || '',
    address: school.address || '', student_count: school.student_count || null,
    contact_person: school.contact_person || '', contact_designation: school.contact_designation || '',
    contact_phone: school.contact_phone || '', contact_email: school.contact_email || '',
    modules: school.modules || [], rm: school.rm || null,
  })
  formError.value = ''
  dialogVisible.value = true
}

function validate() {
  if (!form.name.trim())           return 'School name is required'
  if (!form.city.trim())           return 'City is required'
  if (!form.contact_person.trim()) return 'Contact person is required'
  if (!form.student_count)         return 'Student count is required'
  return ''
}

async function saveSchool() {
  formError.value = validate()
  if (formError.value) return
  saving.value = true
  try {
    const payload = {
      name: form.name.trim(), city: form.city.trim(),
      address: form.address.trim(), student_count: form.student_count,
      contact_person: form.contact_person.trim(), contact_designation: form.contact_designation.trim(),
      contact_phone: form.contact_phone.trim(), contact_email: form.contact_email.trim(),
      modules: form.modules, rm: form.rm || null,
    }
    if (editingSchool.value) {
      payload.updated_at = serverTimestamp()
      payload.updated_by = auth.currentUser?.email || 'unknown'
      await updateDoc(opsDoc('schools', editingSchool.value.id), payload)
      toast.add({ severity: 'success', summary: 'Saved', detail: 'School updated', life: 2500 })
    } else {
      payload.created_at = serverTimestamp()
      payload.created_by = auth.currentUser?.email || 'unknown'
      payload.statuses   = ['Converted']
      payload.notes      = []
      await addDoc(opsCollection('schools'), payload)
      toast.add({ severity: 'success', summary: 'Added', detail: `${form.name} added`, life: 2500 })
      celebrate(`${form.name} is now a partner!`, '🏫', 'school')
    }
    dialogVisible.value = false
    await loadSchools()
  } catch (e) {
    formError.value = 'Something went wrong. Try again.'
  } finally {
    saving.value = false
  }
}

async function confirmDelete(school) {
  let quotationsCount = 0, agreementsCount = 0, invoicesCount = 0
  try {
    const belongs = (data) => {
      if (data.school_id && data.school_id === school.id) return true
      return (data.school_name || '').trim().toLowerCase() === (school.name || '').trim().toLowerCase()
    }
    const [qSnap, aSnap, iSnap] = await Promise.all([
      getDocs(opsCollection('quotations')),
      getDocs(opsCollection('agreements')),
      getDocs(opsCollection('invoices')),
    ])
    quotationsCount = qSnap.docs.filter(d => belongs(d.data())).length
    agreementsCount = aSnap.docs.filter(d => belongs(d.data())).length
    invoicesCount   = iSnap.docs.filter(d => !d.data().deleted && belongs(d.data())).length
  } catch (e) {
    console.error('Could not check linked records', e)
  }

  const totalLinked = quotationsCount + agreementsCount + invoicesCount
  const message = totalLinked === 0
    ? `Remove ${school.name}? This cannot be undone.`
    : `Remove ${school.name}? This school has ${quotationsCount} quotation${quotationsCount !== 1 ? 's' : ''}, `
      + `${agreementsCount} agreement${agreementsCount !== 1 ? 's' : ''}, and ${invoicesCount} invoice${invoicesCount !== 1 ? 's' : ''} `
      + `linked to it. Those documents will NOT be deleted but will lose their school link.`

  confirm.require({
    message,
    header: 'Remove School',
    icon: 'pi pi-exclamation-triangle',
    rejectLabel: 'Cancel', acceptLabel: 'Remove', acceptClass: 'p-button-danger',
    accept: async () => {
      try {
        await deleteDoc(opsDoc('schools', school.id))
        toast.add({ severity: 'info', summary: 'Removed', life: 2500 })
        await loadSchools()
      } catch (e) {
        toast.add({ severity: 'error', summary: 'Error', detail: 'Could not remove', life: 3000 })
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
  await Promise.all([loadSchools(), loadModuleSettings()])
})
</script>

<style scoped>
.form-label {
  display: block; font-size: 12px; font-weight: 500;
  color: #64748b; margin-bottom: 4px;
  text-transform: uppercase; letter-spacing: 0.04em;
}
</style>
