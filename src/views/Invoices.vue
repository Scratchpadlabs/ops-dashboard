<template>
  <div>

    <!-- Header -->
    <div class="flex items-center justify-between mb-6">
      <div>
        <h2 class="text-lg font-semibold text-slate-900">Invoices</h2>
        <p class="text-sm text-slate-500 mt-0.5">{{ invoices.length }} total</p>
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
    <div v-else-if="filteredInvoices.length === 0" class="text-center py-20 bg-white rounded-xl border border-slate-200">
      <i class="pi pi-receipt text-4xl text-slate-300 mb-3 block"></i>
      <p class="text-slate-500 font-medium">No invoices here</p>
    </div>

    <!-- Table -->
    <div v-else class="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <DataTable :value="filteredInvoices" size="small" stripedRows>

        <Column field="invoice_number" header="Invoice #" style="width: 130px">
          <template #body="{ data }">
            <span class="font-mono text-xs text-slate-700">{{ data.invoice_number }}</span>
          </template>
        </Column>

        <Column field="school_name" header="School" sortable>
          <template #body="{ data }">
            <span class="text-sm font-medium text-slate-900">{{ data.school_name }}</span>
          </template>
        </Column>

        <Column field="description" header="Description">
          <template #body="{ data }">
            <span class="text-sm text-slate-600">{{ data.description }}</span>
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
                icon="pi pi-download"
                text rounded size="small"
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

    <!-- New Invoice Dialog -->
    <Dialog
      v-model:visible="dialogVisible"
      header="New Invoice"
      modal
      :style="{ width: '500px' }"
    >
      <div class="space-y-4 pt-2">

        <!-- School name - free text + converted quick-pick -->
        <div>
          <label class="form-label">School Name *</label>
          <InputText v-model="form.school_name" class="w-full" placeholder="Type school name..." />
          <div v-if="convertedSchools.length" class="mt-2">
            <div class="text-xs text-slate-400 mb-1.5">Quick pick — Converted schools:</div>
            <div class="flex flex-wrap gap-1.5">
              <button
                v-for="s in convertedSchools"
                :key="s.id"
                @click="pickConvertedSchool(s)"
                class="px-2.5 py-1 rounded-lg text-xs font-medium border transition-all"
                :class="form.school_name === s.name
                  ? 'bg-green-600 text-white border-green-600'
                  : 'bg-green-50 text-green-700 border-green-200 hover:border-green-400'"
              >{{ s.name }}</button>
            </div>
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
import { ref, reactive, computed, onMounted } from 'vue'
import { db } from '../firebase/config'
import { opsCollection, opsDoc } from '../firebase/collections.js'
import {
  getDocs, addDoc, updateDoc, deleteDoc,
  doc, orderBy, query, serverTimestamp, Timestamp
} from 'firebase/firestore'
import { useConfirm } from 'primevue/useconfirm'
import { useToast } from 'primevue/usetoast'
import { useCelebration } from '../composables/useCelebration'
import { useConvertedSchools } from '../composables/useConvertedSchools.js'
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

const confirm = useConfirm()
const toast = useToast()
const { celebrate } = useCelebration()
const { convertedSchools, loadConverted } = useConvertedSchools()

const invoices = ref([])
const loading  = ref(true)
const dialogVisible = ref(false)
const saving   = ref(false)
const formError = ref('')
const activeTab = ref('all')

const descPresets = ['Digital HPC', 'Printed HPC']

const emptyForm = () => ({
  school_id: null,
  school_name: '',
  school_address: '',
  school_phone: '',
  description: '',
  price_per_student: null,
  quantity: null,
  invoice_number: '',
})

const form = reactive(emptyForm())

// ── Computed ──────────────────────────────────────────────────────────────────

const unpaidInvoices  = computed(() => invoices.value.filter(i => i.status !== 'paid'))
const paidInvoices    = computed(() => invoices.value.filter(i => i.status === 'paid'))
const overdueInvoices = computed(() => invoices.value.filter(i => i.status !== 'paid' && isOverdue(i)))

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
  { key: 'all',     label: 'All',     count: invoices.value.length },
  { key: 'unpaid',  label: 'Unpaid',  count: unpaidInvoices.value.length },
  { key: 'overdue', label: 'Overdue', count: overdueInvoices.value.length },
  { key: 'paid',    label: 'Paid',    count: paidInvoices.value.length },
])

const filteredInvoices = computed(() => {
  if (activeTab.value === 'all')     return invoices.value
  if (activeTab.value === 'unpaid')  return unpaidInvoices.value
  if (activeTab.value === 'overdue') return overdueInvoices.value
  if (activeTab.value === 'paid')    return paidInvoices.value
  return invoices.value
})

// ── Data loading ──────────────────────────────────────────────────────────────

async function loadInvoices() {
  loading.value = true
  try {
    const q = query(opsCollection('invoices'), orderBy('created_at', 'desc'))
    const snap = await getDocs(q)
    invoices.value = snap.docs.map(d => ({ id: d.id, ...d.data() }))
  } catch (e) {
    toast.add({ severity: 'error', summary: 'Error', detail: 'Could not load invoices', life: 3000 })
  } finally {
    loading.value = false
  }
}

// ── Form helpers ──────────────────────────────────────────────────────────────

function pickConvertedSchool(s) {
  form.school_name    = s.name
  form.school_address = s.address || ''
  form.school_phone   = s.contact_phone || ''
  form.quantity       = s.student_count || null
}

function recalc() {
  // just reactive — total computed in template
}

async function openNewInvoice() {
  Object.assign(form, {
    school_name:       '',
    school_address:    '',
    school_phone:      '',
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
  if (!form.school_name.trim())  return 'School name is required'
  if (!form.description.trim())  return 'Description is required'
  if (!form.price_per_student)   return 'Price per student is required'
  if (!form.quantity)            return 'Student count is required'
  return ''
}

async function saveInvoice() {
  formError.value = validate()
  if (formError.value) return

  saving.value = true
  try {
    const now = new Date()
    const dueDate = new Date(now)
    dueDate.setDate(dueDate.getDate() + 45)

    await addDoc(opsCollection('invoices'), {
      school_name:       form.school_name,
      school_address:    form.school_address,
      school_phone:      form.school_phone,
      description:       form.description.trim(),
      price_per_student: form.price_per_student,
      quantity:          form.quantity,
      invoice_number:    form.invoice_number,
      status:            'unpaid',
      due_date:          Timestamp.fromDate(dueDate),
      created_at:        serverTimestamp(),
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
        })
        const amount = formatRupee(invoice.price_per_student * invoice.quantity)
        toast.add({ severity: 'success', summary: 'Paid!', detail: `${amount} received from ${invoice.school_name}`, life: 3000 })
        celebrate(`${amount} received from ${invoice.school_name}!`, '💰')
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
    message: `Delete invoice ${invoice.invoice_number}?`,
    header: 'Delete Invoice',
    icon: 'pi pi-exclamation-triangle',
    rejectLabel: 'Cancel',
    acceptLabel: 'Delete',
    acceptClass: 'p-button-danger',
    accept: async () => {
      try {
        await deleteDoc(opsDoc('invoices', invoice.id))
        toast.add({ severity: 'info', summary: 'Deleted', life: 2000 })
        await loadInvoices()
      } catch (e) {
        toast.add({ severity: 'error', summary: 'Error', detail: 'Could not delete', life: 3000 })
      }
    }
  })
}

// ── Download PDF ──────────────────────────────────────────────────────────────

async function downloadInvoice(invoice) {
  try {
    await generateInvoicePDF(invoice)
  } catch (e) {
    console.error(e)
    toast.add({ severity: 'error', summary: 'Download failed', detail: e.message || 'Could not generate PDF', life: 4000 })
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
  await Promise.all([loadInvoices(), loadConverted()])
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
