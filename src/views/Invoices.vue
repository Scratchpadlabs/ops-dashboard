<template>
  <div>

    <!-- Header -->
    <div class="flex items-center justify-between mb-6">
      <div>
        <h2 class="text-lg font-semibold text-slate-900">Invoices</h2>
        <p class="text-sm text-slate-500 mt-0.5">{{ activeInvoices.length }} total</p>
      </div>
      <Button label="New Invoice" icon="pi pi-plus" @click="openNewInvoice" />
    </div>

    <!-- Summary cards -->
    <div class="grid grid-cols-3 gap-4 mb-6">
      <div class="bg-white rounded-xl border border-slate-200 p-4">
        <div class="text-xs font-medium text-slate-400 uppercase tracking-wide mb-1">Total Receivable</div>
        <div class="text-2xl font-bold text-slate-900">{{ formatRupee(totalReceivable) }}</div>
        <div class="text-xs text-slate-400 mt-1">{{ unpaidInvoices.length }} unpaid invoice{{ unpaidInvoices.length !== 1 ? 's' : '' }}</div>
      </div>
      <div class="bg-white rounded-xl border border-slate-200 p-4">
        <div class="text-xs font-medium text-slate-400 uppercase tracking-wide mb-1">Overdue</div>
        <div class="text-2xl font-bold text-red-600">{{ formatRupee(overdueAmount) }}</div>
        <div class="text-xs text-slate-400 mt-1">{{ overdueInvoices.length }} overdue</div>
      </div>
      <div class="bg-white rounded-xl border border-slate-200 p-4">
        <div class="text-xs font-medium text-slate-400 uppercase tracking-wide mb-1">Collected (This Year)</div>
        <div class="text-2xl font-bold text-green-600">{{ formatRupee(totalCollected) }}</div>
        <div class="text-xs text-slate-400 mt-1">{{ paidInvoices.length }} paid</div>
      </div>
    </div>

    <!-- Filter tabs -->
    <div class="flex gap-2 mb-4">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        @click="activeTab = tab.key"
        class="px-3 py-1.5 rounded-lg text-sm font-medium transition-all"
        :class="activeTab === tab.key
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
    <div v-else-if="filteredSchoolGroups.length === 0" class="text-center py-20 bg-white rounded-xl border border-slate-200">
      <i class="pi pi-receipt text-4xl text-slate-300 mb-3 block"></i>
      <p class="text-slate-500 font-medium">No invoices here</p>
    </div>

    <!-- School groups -->
    <div v-else class="space-y-3">
      <div v-for="g in filteredSchoolGroups" :key="g.school_name" class="bg-white rounded-xl border border-slate-200 overflow-hidden">

        <button
          @click="toggleSchool(g.school_name)"
          class="w-full flex items-center justify-between px-4 py-3.5 hover:bg-slate-50 transition-colors"
        >
          <div class="flex items-center gap-3">
            <i class="pi text-xs text-slate-400" :class="isExpanded(g.school_name) ? 'pi-chevron-down' : 'pi-chevron-right'"></i>
            <div class="text-left">
              <div class="text-sm font-semibold text-slate-900">{{ g.school_name }}</div>
              <div class="text-xs text-slate-400 mt-0.5">{{ g.count }} invoice{{ g.count !== 1 ? 's' : '' }}</div>
            </div>
          </div>
          <div class="flex items-center gap-3">
            <span class="text-sm font-bold text-slate-900">{{ formatRupee(g.totalAmount) }}</span>
            <span class="px-2 py-0.5 rounded-full text-xs font-semibold" :class="groupBadgeClass(g)">{{ groupBadgeLabel(g) }}</span>
          </div>
        </button>

        <div v-if="isExpanded(g.school_name)" class="border-t border-slate-100">
          <DataTable :value="g.invoices" size="small" stripedRows>

            <Column field="invoice_number" header="Invoice #" style="width: 130px">
              <template #body="{ data }">
                <span class="font-mono text-xs text-slate-700">{{ data.invoice_number }}</span>
              </template>
            </Column>

            <Column field="description" header="Description">
              <template #body="{ data }">
                <span class="text-sm text-slate-600">{{ data.description }}</span>
              </template>
            </Column>

            <Column field="installment_type" header="Stage" style="width: 110px">
              <template #body="{ data }">
                <span v-if="data.installment_type" class="text-xs font-medium text-slate-500">{{ data.installment_type }}</span>
                <span v-else class="text-xs text-slate-300">—</span>
              </template>
            </Column>

            <Column field="amount" header="Amount" sortable>
              <template #body="{ data }">
                <span class="text-sm font-semibold text-slate-900">{{ formatRupee(data.price_per_student * data.quantity) }}</span>
              </template>
            </Column>

            <Column field="due_date" header="Due Date" sortable>
              <template #body="{ data }">
                <span
                  class="text-xs font-medium"
                  :class="isOverdue(data) ? 'text-red-600' : 'text-slate-500'"
                >
                  {{ formatDate(data.due_date) }}
                  <span v-if="isOverdue(data)" class="ml-1">⚠</span>
                </span>
              </template>
            </Column>

            <Column field="status" header="Status" style="width: 100px">
              <template #body="{ data }">
                <span
                  class="px-2 py-0.5 rounded-full text-xs font-semibold"
                  :class="data.status === 'paid'
                    ? 'bg-green-100 text-green-700'
                    : isOverdue(data)
                      ? 'bg-red-100 text-red-700'
                      : 'bg-amber-100 text-amber-700'"
                >
                  {{ data.status === 'paid' ? 'Paid' : isOverdue(data) ? 'Overdue' : 'Unpaid' }}
                </span>
              </template>
            </Column>

            <Column header="" style="width: 110px">
              <template #body="{ data }">
                <div class="flex gap-1">
                  <Button
                    :icon="downloadingId === data.id ? 'pi pi-spin pi-spinner' : 'pi pi-download'"
                    text rounded size="small"
                    :disabled="downloadingId === data.id"
                    v-tooltip="'Download PDF'"
                    @click="downloadInvoice(data)"
                  />
                  <Button
                    v-if="data.status !== 'paid'"
                    icon="pi pi-check"
                    text rounded size="small"
                    severity="success"
                    v-tooltip="'Mark as Paid'"
                    @click="markPaid(data)"
                  />
                  <Button
                    icon="pi pi-trash"
                    text rounded size="small"
                    severity="danger"
                    v-tooltip="'Delete'"
                    @click="confirmDelete(data)"
                  />
                </div>
              </template>
            </Column>

          </DataTable>
        </div>
      </div>
    </div>

    <!-- Recently Deleted -->
    <div v-if="deletedInvoices.length" class="mt-6 bg-white rounded-xl border border-slate-200 overflow-hidden">
      <div class="px-4 py-3 border-b border-slate-100">
        <h3 class="text-sm font-semibold text-slate-900">Recently Deleted</h3>
        <p class="text-xs text-slate-400 mt-0.5">Deleted in the last 30 days · restore to bring an invoice back</p>
      </div>
      <DataTable :value="deletedInvoices" size="small" stripedRows>
        <Column field="invoice_number" header="Invoice #" style="width: 130px">
          <template #body="{ data }">
            <span class="font-mono text-xs text-slate-500">{{ data.invoice_number }}</span>
          </template>
        </Column>
        <Column field="school_name" header="School">
          <template #body="{ data }">
            <span class="text-sm text-slate-600">{{ data.school_name }}</span>
          </template>
        </Column>
        <Column header="Amount">
          <template #body="{ data }">
            <span class="text-sm text-slate-500">{{ formatRupee(data.price_per_student * data.quantity) }}</span>
          </template>
        </Column>
        <Column header="Deleted">
          <template #body="{ data }">
            <span class="text-xs text-slate-400">{{ formatDate(data.deleted_at) }}</span>
          </template>
        </Column>
        <Column header="" style="width: 100px">
          <template #body="{ data }">
            <Button label="Restore" icon="pi pi-refresh" text size="small" @click="restoreInvoice(data)" />
          </template>
        </Column>
      </DataTable>
    </div>

    <!-- New Invoice Dialog -->
    <Dialog
      v-model:visible="dialogVisible"
      header="New Invoice"
      modal
      :style="{ width: '500px' }"
    >
      <div class="space-y-4 pt-2">

        <!-- School name - searchable dropdown, free text still works -->
        <div>
          <label class="form-label">School Name *</label>
          <SchoolSearchSelect v-model="form.school_name" :schools="allSchools" @select="onSchoolSelect" />
          <p class="text-xs text-slate-400 mt-1">Search an existing school or type a new name.</p>
        </div>

        <!-- School address + phone - auto-filled from agreement/school data when available -->
        <div class="grid grid-cols-2 gap-4">
          <div>
            <label class="form-label">School Address *</label>
            <InputText v-model="form.school_address" class="w-full" placeholder="Address" />
          </div>
          <div>
            <label class="form-label">School Phone *</label>
            <InputText v-model="form.school_phone" class="w-full" placeholder="Phone" />
          </div>
        </div>

        <!-- Payment Stage -->
        <div>
          <label class="form-label">Payment Stage *</label>
          <div class="grid grid-cols-2 gap-2">
            <button
              v-for="opt in installmentTypes"
              :key="opt"
              @click="form.installment_type = opt"
              class="py-2 px-3 rounded-lg text-sm font-medium border transition-all"
              :class="form.installment_type === opt
                ? 'bg-slate-900 text-white border-slate-900'
                : 'bg-white text-slate-600 border-slate-200 hover:border-slate-400'"
            >{{ opt }}</button>
          </div>
        </div>

        <!-- Description -->
        <div>
          <label class="form-label">Description *</label>
          <div class="flex gap-2 mb-2">
            <button
              v-for="preset in descPresets"
              :key="preset"
              @click="form.description = preset"
              class="px-3 py-1 rounded-lg text-xs font-medium border transition-all"
              :class="form.description === preset
                ? 'bg-slate-900 text-white border-slate-900'
                : 'bg-white text-slate-600 border-slate-200 hover:border-slate-400'"
            >{{ preset }}</button>
          </div>
          <InputText v-model="form.description" class="w-full" placeholder="e.g. Printed HPC — Payable Amount (50%)" />
        </div>

        <!-- Price per student -->
        <div class="grid grid-cols-2 gap-4">
          <div>
            <label class="form-label">Price per Student (₹) *</label>
            <InputNumber
              v-model="form.price_per_student"
              class="w-full"
              :min="1"
              @input="recalc"
            />
          </div>
          <div>
            <label class="form-label">No. of Students *</label>
            <InputNumber
              v-model="form.quantity"
              class="w-full"
              :min="1"
              @input="recalc"
            />
          </div>
        </div>

        <!-- Total preview -->
        <div v-if="form.price_per_student && form.quantity" class="bg-slate-50 rounded-lg px-4 py-3 flex justify-between items-center">
          <span class="text-sm text-slate-500">Total Amount</span>
          <span class="text-lg font-bold text-slate-900">{{ formatRupee(form.price_per_student * form.quantity) }}</span>
        </div>

        <!-- Invoice number -->
        <div>
          <label class="form-label">Invoice Number</label>
          <InputText v-model="form.invoice_number" class="w-full" readonly style="background:#f8fafc" />
          <p class="text-xs text-slate-400 mt-1">Auto-generated · DDMMYY + sequence</p>
        </div>

        <div v-if="formError" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">
          {{ formError }}
        </div>
      </div>

      <template #footer>
        <Button label="Cancel" text @click="dialogVisible = false" />
        <Button label="Create Invoice" :loading="saving" @click="saveInvoice" />
      </template>
    </Dialog>

    <ConfirmDialog />
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { db, auth } from '../firebase/config'
import { activeYear, effectiveAcademicYear } from '../composables/useAcademicYear.js'
import { opsCollection, opsDoc } from '../firebase/collections.js'
import {
  getDocs, getDoc, addDoc, updateDoc,
  doc, orderBy, query, serverTimestamp, Timestamp, limit
} from 'firebase/firestore'
import { useConfirm } from 'primevue/useconfirm'
import { useToast } from 'primevue/usetoast'
import { useCelebration } from '../composables/useCelebration'
import { generateInvoicePDF } from '../utils/api.js'
import { generateInvoiceNumber } from '../utils/invoicePDF.js'

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
const toast = useToast()
const { celebrate } = useCelebration()

const invoices = ref([])
const loading  = ref(true)
const dialogVisible = ref(false)
const saving   = ref(false)
const formError = ref('')
const activeTab = ref('all')
const agreements = ref([])
const allSchools = ref([])
const settings   = ref({ invoice_due_days: 45 })
const expandedSchools = ref(new Set())
const downloadingId = ref(null)

const descPresets = ['Digital HPC', 'Printed HPC']
const installmentTypes = ['Onboarding', 'Installment 2', 'After Delivery', 'Ad-hoc']

const emptyForm = () => ({
  school_id: null,
  school_name: '',
  school_address: '',
  school_phone: '',
  installment_type: '',
  description: '',
  price_per_student: null,
  quantity: null,
  invoice_number: '',
})

const form = reactive(emptyForm())

// ── Computed ──────────────────────────────────────────────────────────────────

// Soft-deleted invoices are hidden from every list/stat below, but still live in Firestore.
const activeInvoices = computed(() => {
  const nonDeleted = invoices.value.filter(i => !i.deleted)
  if (!activeYear.value || activeYear.value === 'All Years') return nonDeleted
  return nonDeleted.filter(i => i.academic_year === activeYear.value)
})

const deletedInvoices = computed(() => {
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000
  return invoices.value.filter(i => {
    if (!i.deleted) return false
    const ts = i.deleted_at?.toDate ? i.deleted_at.toDate() : (i.deleted_at ? new Date(i.deleted_at) : null)
    return ts ? ts.getTime() >= cutoff : true
  })
})

const unpaidInvoices  = computed(() => activeInvoices.value.filter(i => i.status !== 'paid'))
const paidInvoices    = computed(() => activeInvoices.value.filter(i => i.status === 'paid'))
const overdueInvoices = computed(() => activeInvoices.value.filter(i => i.status !== 'paid' && isOverdue(i)))

const totalReceivable = computed(() =>
  unpaidInvoices.value.reduce((s, i) => s + i.price_per_student * i.quantity, 0)
)
const overdueAmount = computed(() =>
  overdueInvoices.value.reduce((s, i) => s + i.price_per_student * i.quantity, 0)
)
const totalCollected = computed(() =>
  paidInvoices.value.reduce((s, i) => s + i.price_per_student * i.quantity, 0)
)

const tabs = computed(() => [
  { key: 'all',     label: 'All',     count: activeInvoices.value.length },
  { key: 'unpaid',  label: 'Unpaid',  count: unpaidInvoices.value.length },
  { key: 'overdue', label: 'Overdue', count: overdueInvoices.value.length },
  { key: 'paid',    label: 'Paid',    count: paidInvoices.value.length },
])

// ── Grouping by school ───────────────────────────────────────────────────────

const schoolGroups = computed(() => {
  const map = new Map()
  activeInvoices.value.forEach(inv => {
    const key = inv.school_name || 'Unknown School'
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(inv)
  })
  return Array.from(map.entries())
    .map(([school_name, invs]) => {
      const unpaidCount  = invs.filter(i => i.status !== 'paid').length
      const paidCount    = invs.filter(i => i.status === 'paid').length
      const overdueCount = invs.filter(i => i.status !== 'paid' && isOverdue(i)).length
      return {
        school_name,
        invoices: invs,
        count: invs.length,
        totalAmount: invs.reduce((s, i) => s + i.price_per_student * i.quantity, 0),
        unpaidCount,
        paidCount,
        overdueCount,
      }
    })
    .sort((a, b) => a.school_name.localeCompare(b.school_name))
})

const filteredSchoolGroups = computed(() => {
  return schoolGroups.value.filter(g => {
    if (activeTab.value === 'all')     return true
    if (activeTab.value === 'unpaid')  return g.unpaidCount > 0
    if (activeTab.value === 'overdue') return g.overdueCount > 0
    if (activeTab.value === 'paid')    return g.paidCount > 0
    return true
  })
})

function isExpanded(name) {
  return expandedSchools.value.has(name)
}

function toggleSchool(name) {
  const next = new Set(expandedSchools.value)
  if (next.has(name)) next.delete(name)
  else next.add(name)
  expandedSchools.value = next
}

function groupBadgeLabel(g) {
  if (g.unpaidCount === 0)   return 'All Paid'
  if (g.overdueCount > 0)    return `${g.overdueCount} Overdue`
  return `${g.unpaidCount} Unpaid`
}

function groupBadgeClass(g) {
  if (g.unpaidCount === 0)   return 'bg-green-100 text-green-700'
  if (g.overdueCount > 0)    return 'bg-red-100 text-red-700'
  return 'bg-amber-100 text-amber-700'
}

// ── Data loading ──────────────────────────────────────────────────────────────

async function loadInvoices() {
  loading.value = true
  try {
    const q = query(opsCollection('invoices'), orderBy('created_at', 'desc'), limit(500))
    const snap = await getDocs(q)
    invoices.value = snap.docs.map(d => ({ id: d.id, ...d.data() }))
  } catch (e) {
    toast.add({ severity: 'error', summary: 'Error', detail: 'Could not load invoices', life: 3000 })
  } finally {
    loading.value = false
  }
}

async function loadLookupData() {
  try {
    const [agreementsSnap, schoolsSnap] = await Promise.all([
      getDocs(opsCollection('agreements')),
      getDocs(opsCollection('schools')),
    ])
    agreements.value = agreementsSnap.docs.map(d => d.data())
    allSchools.value = schoolsSnap.docs.map(d => ({ id: d.id, ...d.data() }))
  } catch (e) {
    console.error('Could not load agreement/school lookup data', e)
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

// ── Form helpers ──────────────────────────────────────────────────────────────

function onSchoolSelect(s) {
  form.school_id       = s.id || null
  form.school_name     = s.name
  form.school_address  = s.address || ''
  form.school_phone    = s.contact_phone || ''
  form.quantity        = s.student_count || null
}

// Auto-fills address/phone for a free-typed school name — prefers the
// matching Agreement's school data, falls back to the Schools record.
// Never overwrites a value the user already typed.
function autoFillFromLookup() {
  const name = form.school_name.trim().toLowerCase()
  if (!name) return

  const agreement = agreements.value.find(a => (a.school_name || '').trim().toLowerCase() === name)
  const school     = allSchools.value.find(s => (s.name || '').trim().toLowerCase() === name)

  if (!form.school_address.trim()) {
    form.school_address = agreement?.school_address || school?.address || ''
  }
  if (!form.school_phone.trim()) {
    form.school_phone = school?.contact_phone || ''
  }
}

watch(() => form.school_name, autoFillFromLookup)

function recalc() {
  // just reactive — total computed in template
}

async function openNewInvoice() {
  Object.assign(form, {
    school_id:         null,
    school_name:       '',
    school_address:    '',
    school_phone:      '',
    installment_type:  '',
    description:       '',
    price_per_student: null,
    quantity:          null,
    invoice_number:    '',
  })
  formError.value = ''
  const existingNums = invoices.value.map(i => i.invoice_number)
  form.invoice_number = generateInvoiceNumber(existingNums)
  dialogVisible.value = true
}

function validate() {
  if (!form.school_name.trim())    return 'School name is required'
  if (!form.school_address.trim()) return 'School address is required'
  if (!form.school_phone.trim())   return 'School phone is required'
  if (!form.installment_type)      return 'Select a payment stage'
  if (!form.description.trim())    return 'Description is required'
  if (!form.price_per_student)     return 'Price per student is required'
  if (!form.quantity)              return 'Student count is required'
  return ''
}

// Checks for an existing active invoice for the same school + payment stage.
// "Ad-hoc" invoices are expected to repeat, so they're excluded from the check.
function findDuplicateInvoice() {
  if (form.installment_type === 'Ad-hoc') return null
  const name = form.school_name.trim().toLowerCase()
  const year = effectiveAcademicYear()
  return invoices.value.filter(i => !i.deleted).find(i => {
    const sameSchool = form.school_id ? i.school_id === form.school_id : (i.school_name || '').trim().toLowerCase() === name
    return sameSchool && i.installment_type === form.installment_type && i.academic_year === year
  })
}

async function saveInvoice() {
  formError.value = validate()
  if (formError.value) return

  const duplicate = findDuplicateInvoice()
  if (duplicate) {
    confirm.require({
      message: `An invoice for this installment already exists (${duplicate.invoice_number}). Create another one?`,
      header: 'Possible Duplicate Invoice',
      icon: 'pi pi-exclamation-triangle',
      rejectLabel: 'Cancel',
      acceptLabel: 'Create Anyway',
      accept: () => createInvoiceRecord(),
    })
    return
  }

  await createInvoiceRecord()
}

async function createInvoiceRecord() {
  saving.value = true
  try {
    const now = new Date()
    const dueDate = new Date(now)
    dueDate.setDate(dueDate.getDate() + (settings.value.invoice_due_days || 45))

    await addDoc(opsCollection('invoices'), {
      school_id:         form.school_id || null,
      school_name:       form.school_name,
      school_address:    form.school_address,
      school_phone:      form.school_phone,
      installment_type:  form.installment_type,
      description:       form.description.trim(),
      price_per_student: form.price_per_student,
      quantity:          form.quantity,
      invoice_number:    form.invoice_number,
      status:            'unpaid',
      due_date:          Timestamp.fromDate(dueDate),
      academic_year:     effectiveAcademicYear(),
      created_at:        serverTimestamp(),
      created_by:        auth.currentUser?.email || 'unknown',
    })

    toast.add({ severity: 'success', summary: 'Created', detail: `Invoice ${form.invoice_number} created`, life: 2500 })
    dialogVisible.value = false
    await loadInvoices()
  } catch (e) {
    formError.value = 'Something went wrong. Try again.'
    console.error(e)
  } finally {
    saving.value = false
  }
}

// ── Mark paid ─────────────────────────────────────────────────────────────────

async function markPaid(invoice) {
  confirm.require({
    message: `Mark invoice ${invoice.invoice_number} as paid?`,
    header: 'Mark as Paid',
    icon: 'pi pi-check-circle',
    rejectLabel: 'Cancel',
    acceptLabel: 'Mark Paid',
    accept: async () => {
      try {
        await updateDoc(opsDoc('invoices', invoice.id), {
          status: 'paid',
          paid_on: serverTimestamp(),
          updated_at: serverTimestamp(),
          updated_by: auth.currentUser?.email || 'unknown',
        })
        const amount = formatRupee(invoice.price_per_student * invoice.quantity)
        toast.add({ severity: 'success', summary: 'Paid!', detail: `${amount} received from ${invoice.school_name}`, life: 3000 })
        celebrate(`${amount} received from ${invoice.school_name}!`, '💰', 'invoice')
        await loadInvoices()
      } catch (e) {
        toast.add({ severity: 'error', summary: 'Error', detail: 'Could not update invoice', life: 3000 })
      }
    }
  })
}

// ── Delete ────────────────────────────────────────────────────────────────────

function confirmDelete(invoice) {
  confirm.require({
    message: `Delete invoice ${invoice.invoice_number}? It will move to Recently Deleted for 30 days before it's just hidden for good.`,
    header: 'Delete Invoice',
    icon: 'pi pi-exclamation-triangle',
    rejectLabel: 'Cancel',
    acceptLabel: 'Delete',
    acceptClass: 'p-button-danger',
    accept: async () => {
      try {
        await updateDoc(opsDoc('invoices', invoice.id), {
          deleted: true,
          deleted_at: serverTimestamp(),
          updated_at: serverTimestamp(),
          updated_by: auth.currentUser?.email || 'unknown',
        })
        toast.add({ severity: 'info', summary: 'Deleted', life: 2000 })
        await loadInvoices()
      } catch (e) {
        toast.add({ severity: 'error', summary: 'Error', detail: 'Could not delete', life: 3000 })
      }
    }
  })
}

async function restoreInvoice(invoice) {
  try {
    await updateDoc(opsDoc('invoices', invoice.id), {
      deleted: false,
      deleted_at: null,
      updated_at: serverTimestamp(),
      updated_by: auth.currentUser?.email || 'unknown',
    })
    toast.add({ severity: 'success', summary: 'Restored', detail: `Invoice ${invoice.invoice_number} restored`, life: 2500 })
    await loadInvoices()
  } catch (e) {
    toast.add({ severity: 'error', summary: 'Error', detail: 'Could not restore invoice', life: 3000 })
  }
}

// ── Download PDF ──────────────────────────────────────────────────────────────

async function downloadInvoice(invoice) {
  downloadingId.value = invoice.id
  try {
    await generateInvoicePDF(invoice)
  } catch (e) {
    console.error(e)
    toast.add({ severity: 'error', summary: 'Download failed', detail: e.message || 'Could not generate PDF', life: 4000 })
  } finally {
    downloadingId.value = null
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isOverdue(invoice) {
  if (invoice.status === 'paid') return false
  if (!invoice.due_date) return false
  const due = invoice.due_date.toDate ? invoice.due_date.toDate() : new Date(invoice.due_date)
  return due < new Date()
}

function formatDate(ts) {
  if (!ts) return '—'
  const d = ts.toDate ? ts.toDate() : new Date(ts)
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

function formatRupee(amount) {
  if (!amount) return '₹0'
  return '₹' + Number(amount).toLocaleString('en-IN')
}

onMounted(async () => {
  await Promise.all([loadInvoices(), loadLookupData(), loadSettings()])

  // Pre-fill from "New Invoice" launched off a school's profile page
  if (route.query.school_name) {
    await openNewInvoice()
    form.school_id      = route.query.school_id || null
    form.school_name     = route.query.school_name
    form.school_address  = route.query.school_address || ''
    form.school_phone    = route.query.school_phone || ''
    form.quantity        = route.query.student_count ? Number(route.query.student_count) : null
  }
})

watch(activeYear, () => { loadInvoices() })
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
