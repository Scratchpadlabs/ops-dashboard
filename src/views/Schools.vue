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
              @click="openDrawer(data)"
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

        <Column field="notes" header="Notes">
          <template #body="{ data }">
            <span class="text-xs text-slate-400">
              {{ (data.notes || []).length }} note{{ (data.notes || []).length !== 1 ? 's' : '' }}
            </span>
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

    <!-- ── DRAWER ──────────────────────────────────────────────────────────── -->
    <Drawer v-model:visible="drawerVisible" position="right" :style="{ width: '600px' }">
      <template #header>
        <div>
          <div class="font-semibold text-slate-900 text-base">{{ drawerSchool?.name }}</div>
          <div class="text-xs text-slate-400 mt-0.5">{{ drawerSchool?.city }}</div>
        </div>
      </template>

      <Tabs v-if="drawerSchool" v-model:value="drawerTab" value="overview">
        <TabList>
          <Tab value="overview">Overview</Tab>
          <Tab value="quotations">Quotations</Tab>
          <Tab value="agreements">Agreements</Tab>
          <Tab value="invoices">Invoices</Tab>
          <Tab value="documents">Documents</Tab>
        </TabList>
        <TabPanels>

          <!-- ── Overview ────────────────────────────────────────────────── -->
          <TabPanel value="overview">
            <div class="space-y-6 pt-4">

              <!-- Status tags -->
              <div>
                <div class="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Status</div>
                <div class="flex flex-wrap gap-2">
                  <button
                    v-for="s in allStatuses"
                    :key="s"
                    @click="toggleStatus(s)"
                    class="px-3 py-1.5 rounded-full text-xs font-semibold border-2 transition-all"
                    :class="drawerSchool.statuses?.includes(s)
                      ? statusStyle(s) + ' border-transparent'
                      : 'bg-white text-slate-400 border-slate-200 hover:border-slate-300'"
                  >
                    {{ s }}
                    <i v-if="drawerSchool.statuses?.includes(s)" class="pi pi-check ml-1 text-xs"></i>
                  </button>
                </div>
              </div>

              <!-- School details -->
              <div>
                <div class="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Details</div>
                <div class="bg-slate-50 rounded-xl p-3 space-y-1.5 text-sm">
                  <div class="flex gap-2"><span class="text-slate-400 w-24 flex-shrink-0">Contact</span><span class="text-slate-700">{{ drawerSchool.contact_person }}{{ drawerSchool.contact_designation ? ' · ' + drawerSchool.contact_designation : '' }}</span></div>
                  <div class="flex gap-2"><span class="text-slate-400 w-24 flex-shrink-0">Phone</span><span class="text-slate-700">{{ drawerSchool.contact_phone || '—' }}</span></div>
                  <div class="flex gap-2"><span class="text-slate-400 w-24 flex-shrink-0">Email</span><span class="text-slate-700">{{ drawerSchool.contact_email || '—' }}</span></div>
                  <div class="flex gap-2"><span class="text-slate-400 w-24 flex-shrink-0">Students</span><span class="text-slate-700">{{ drawerSchool.student_count }}</span></div>
                  <div class="flex gap-2"><span class="text-slate-400 w-24 flex-shrink-0">Modules</span><span class="text-slate-700">{{ (drawerSchool.modules || []).join(', ') || '—' }}</span></div>
                  <div class="flex gap-2"><span class="text-slate-400 w-24 flex-shrink-0">Address</span><span class="text-slate-700">{{ drawerSchool.address || '—' }}</span></div>
                </div>
              </div>

              <!-- Notes -->
              <div>
                <div class="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Notes</div>

                <!-- Add note -->
                <div class="flex gap-2 mb-3">
                  <InputText
                    v-model="newNote"
                    class="flex-1 text-sm"
                    placeholder="Add a note..."
                    @keyup.enter="addNote"
                  />
                  <Button icon="pi pi-plus" size="small" :disabled="!newNote.trim()" @click="addNote" />
                </div>

                <!-- Notes list -->
                <div v-if="(drawerSchool.notes || []).length === 0" class="text-center py-6 text-slate-300 text-sm">
                  No notes yet
                </div>
                <div v-else class="space-y-2">
                  <div
                    v-for="(note, i) in [...(drawerSchool.notes || [])].reverse()"
                    :key="note.id"
                    class="bg-slate-50 rounded-lg p-3"
                  >
                    <div v-if="editingNoteId !== note.id">
                      <p class="text-sm text-slate-800 leading-relaxed">{{ note.text }}</p>
                      <div class="flex items-center justify-between mt-1.5">
                        <span class="text-xs text-slate-400">{{ formatDateTime(note.created_at) }}</span>
                        <div class="flex gap-1">
                          <Button icon="pi pi-pencil" text rounded size="small" @click="startEditNote(note)" />
                          <Button icon="pi pi-trash" text rounded size="small" severity="danger" @click="deleteNote(note.id)" />
                        </div>
                      </div>
                    </div>
                    <div v-else class="space-y-2">
                      <InputText v-model="editNoteText" class="w-full text-sm" @keyup.enter="saveEditNote(note.id)" />
                      <div class="flex gap-2 justify-end">
                        <Button label="Cancel" text size="small" @click="editingNoteId = null" />
                        <Button label="Save" size="small" @click="saveEditNote(note.id)" />
                      </div>
                    </div>
                  </div>
                </div>
              </div>

            </div>
          </TabPanel>

          <!-- ── Quotations ──────────────────────────────────────────────── -->
          <TabPanel value="quotations">
            <div class="pt-4">
              <div class="flex justify-end mb-3">
                <Button label="New Quotation" icon="pi pi-plus" size="small" @click="newQuotationForSchool" />
              </div>
              <div v-if="schoolQuotations.length === 0" class="text-center py-10 text-slate-300 text-sm">
                No quotations yet
              </div>
              <div v-else class="space-y-2">
                <div
                  v-for="q in schoolQuotations"
                  :key="q.id"
                  class="bg-slate-50 rounded-lg p-3 flex items-center justify-between"
                >
                  <div>
                    <div class="text-sm font-medium text-slate-800">{{ q.quotation_number }}</div>
                    <div class="text-xs text-slate-400">{{ formatDate(q.created_at) }}</div>
                  </div>
                  <Button icon="pi pi-download" text rounded size="small" @click="downloadQuotation(q)" />
                </div>
              </div>
            </div>
          </TabPanel>

          <!-- ── Agreements ──────────────────────────────────────────────── -->
          <TabPanel value="agreements">
            <div class="pt-4">
              <div v-if="schoolAgreements.length === 0" class="text-center py-10 text-slate-300 text-sm">
                No agreements yet
              </div>
              <div v-else class="space-y-2">
                <div
                  v-for="a in schoolAgreements"
                  :key="a.id"
                  class="bg-slate-50 rounded-lg p-3 flex items-center justify-between"
                >
                  <div>
                    <div class="text-sm font-medium text-slate-800">{{ a.agreement_number }}</div>
                    <div class="text-xs text-slate-400">
                      {{ formatDate(a.created_at) }} · Plan {{ a.installment_plan }} · ₹{{ (a.fee_per_student * a.student_count).toLocaleString('en-IN') }}
                    </div>
                  </div>
                  <div class="flex items-center gap-2">
                    <span
                      class="px-2 py-0.5 rounded-full text-xs font-semibold"
                      :class="a.status === 'Signed' ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'"
                    >{{ a.status || 'Sent' }}</span>
                    <Button icon="pi pi-download" text rounded size="small" v-tooltip="'Download PDF'" @click="downloadAgreement(a)" />
                    <Button
                      v-if="a.signed_pdf_url"
                      icon="pi pi-file-check"
                      text rounded size="small"
                      severity="success"
                      v-tooltip="'View Signed PDF'"
                      @click="viewSignedPdf(a)"
                    />
                    <Button
                      icon="pi pi-upload"
                      text rounded size="small"
                      :loading="uploadingAgreementId === a.id"
                      v-tooltip="'Upload Signed PDF'"
                      @click="triggerAgreementUpload(a)"
                    />
                  </div>
                </div>
              </div>
            </div>
          </TabPanel>

          <!-- ── Invoices ────────────────────────────────────────────────── -->
          <TabPanel value="invoices">
            <div class="pt-4">
              <div class="grid grid-cols-3 gap-3 mb-4">
                <div class="bg-slate-50 rounded-lg p-3">
                  <div class="text-xs text-slate-400 uppercase tracking-wide mb-1">Invoiced</div>
                  <div class="text-sm font-bold text-slate-900">{{ formatRupee(invoiceSummary.total) }}</div>
                </div>
                <div class="bg-green-50 rounded-lg p-3">
                  <div class="text-xs text-slate-400 uppercase tracking-wide mb-1">Paid</div>
                  <div class="text-sm font-bold text-green-700">{{ formatRupee(invoiceSummary.paid) }}</div>
                </div>
                <div class="bg-amber-50 rounded-lg p-3">
                  <div class="text-xs text-slate-400 uppercase tracking-wide mb-1">Outstanding</div>
                  <div class="text-sm font-bold text-amber-700">{{ formatRupee(invoiceSummary.outstanding) }}</div>
                </div>
              </div>

              <div v-if="schoolInvoices.length === 0" class="text-center py-10 text-slate-300 text-sm">
                No invoices yet
              </div>
              <div v-else class="space-y-2">
                <div
                  v-for="inv in schoolInvoices"
                  :key="inv.id"
                  class="bg-slate-50 rounded-lg p-3 flex items-center justify-between"
                >
                  <div>
                    <div class="text-sm font-medium text-slate-800">{{ inv.invoice_number }}</div>
                    <div class="text-xs text-slate-400">{{ inv.description }} · ₹{{ (inv.price_per_student * inv.quantity).toLocaleString('en-IN') }}</div>
                  </div>
                  <div class="flex items-center gap-2">
                    <span
                      class="px-2 py-0.5 rounded-full text-xs font-semibold"
                      :class="inv.status === 'paid' ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'"
                    >{{ inv.status === 'paid' ? 'Paid' : 'Unpaid' }}</span>
                    <Button
                      v-if="inv.status !== 'paid'"
                      icon="pi pi-check"
                      text rounded size="small"
                      severity="success"
                      v-tooltip="'Mark as Paid'"
                      @click="markInvoicePaid(inv)"
                    />
                    <Button icon="pi pi-download" text rounded size="small" v-tooltip="'Download PDF'" @click="downloadInvoice(inv)" />
                  </div>
                </div>
              </div>
            </div>
          </TabPanel>

          <!-- ── Documents ───────────────────────────────────────────────── -->
          <TabPanel value="documents">
            <div class="pt-4">
              <div class="flex justify-end mb-3">
                <Button label="Upload Document" icon="pi pi-upload" size="small" :loading="uploadingDoc" @click="triggerDocUpload" />
              </div>
              <div v-if="(drawerSchool.documents || []).length === 0" class="text-center py-10 text-slate-300 text-sm">
                No documents yet
              </div>
              <div v-else class="space-y-2">
                <div
                  v-for="item in [...(drawerSchool.documents || [])].reverse()"
                  :key="item.id"
                  class="bg-slate-50 rounded-lg p-3 flex items-center justify-between"
                >
                  <div class="flex items-center gap-2 min-w-0">
                    <i class="pi pi-file text-slate-400"></i>
                    <div class="min-w-0">
                      <div class="text-sm font-medium text-slate-800 truncate">{{ item.name }}</div>
                      <div class="text-xs text-slate-400">{{ formatDateTime(item.uploaded_at) }}</div>
                    </div>
                  </div>
                  <div class="flex items-center gap-1 flex-shrink-0">
                    <Button icon="pi pi-download" text rounded size="small" @click="downloadDocument(item)" />
                    <Button icon="pi pi-trash" text rounded size="small" severity="danger" @click="deleteDocument(item)" />
                  </div>
                </div>
              </div>
            </div>
          </TabPanel>

        </TabPanels>
      </Tabs>
    </Drawer>

    <input
      ref="agreementFileInputEl"
      type="file"
      accept="application/pdf"
      class="hidden"
      @change="onAgreementFileSelected"
    />
    <input
      ref="docFileInputEl"
      type="file"
      class="hidden"
      @change="onDocFileSelected"
    />

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
import { db, storage } from '../firebase/config'
import { opsCollection, opsDoc } from '../firebase/collections.js'
import { getDocs, getDoc, addDoc, updateDoc, deleteDoc, doc, orderBy, query, serverTimestamp } from 'firebase/firestore'
import { ref as storageRef, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage'
import { useConfirm } from 'primevue/useconfirm'
import { useToast } from 'primevue/usetoast'
import { useCelebration } from '../composables/useCelebration'
import { generateAgreementFiles, generateQuotationPDF, generateInvoicePDF } from '../utils/api.js'

import Button from 'primevue/button'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import Dialog from 'primevue/dialog'
import Drawer from 'primevue/drawer'
import InputText from 'primevue/inputtext'
import InputNumber from 'primevue/inputnumber'
import Textarea from 'primevue/textarea'
import MultiSelect from 'primevue/multiselect'
import ProgressSpinner from 'primevue/progressspinner'
import ConfirmDialog from 'primevue/confirmdialog'
import Tabs from 'primevue/tabs'
import TabList from 'primevue/tablist'
import Tab from 'primevue/tab'
import TabPanels from 'primevue/tabpanels'
import TabPanel from 'primevue/tabpanel'

const router = useRouter()
const confirm = useConfirm()
const toast = useToast()
const { celebrate } = useCelebration()

const schools       = ref([])
const agreements    = ref([])
const quotations    = ref([])
const invoices      = ref([])
const loading       = ref(true)
const dialogVisible = ref(false)
const drawerVisible = ref(false)
const drawerSchool  = ref(null)
const drawerTab     = ref('overview')
const editingSchool = ref(null)
const saving        = ref(false)
const formError     = ref('')
const activeFilter  = ref('all')
const newNote       = ref('')
const editingNoteId = ref(null)
const editNoteText  = ref('')

const uploadingAgreementId = ref(null)
const agreementFileInputEl = ref(null)
const agreementUploadTarget = ref(null)

const uploadingDoc   = ref(false)
const docFileInputEl = ref(null)

const allStatuses   = ['Lead', 'Negotiation', 'Converted']
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

// ── Status style ──────────────────────────────────────────────────────────────
function statusStyle(s) {
  if (s === 'Converted')   return 'bg-green-100 text-green-700'
  if (s === 'Negotiation') return 'bg-amber-100 text-amber-700'
  return 'bg-blue-100 text-blue-700'
}

// ── Load ──────────────────────────────────────────────────────────────────────
async function loadSchools() {
  loading.value = true
  try {
    const q    = query(opsCollection('schools'), orderBy('created_at', 'desc'))
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

async function loadAgreements() {
  try {
    const snap = await getDocs(opsCollection('agreements'))
    agreements.value = snap.docs.map(d => ({ id: d.id, ...d.data() }))
  } catch (e) {
    console.error('Could not load agreements', e)
  }
}

async function loadQuotations() {
  try {
    const snap = await getDocs(opsCollection('quotations'))
    quotations.value = snap.docs.map(d => ({ id: d.id, ...d.data() }))
  } catch (e) {
    console.error('Could not load quotations', e)
  }
}

async function loadInvoices() {
  try {
    const snap = await getDocs(opsCollection('invoices'))
    invoices.value = snap.docs.map(d => ({ id: d.id, ...d.data() }))
  } catch (e) {
    console.error('Could not load invoices', e)
  }
}

function belongsToDrawerSchool(record) {
  if (!drawerSchool.value) return false
  if (record.school_id && record.school_id === drawerSchool.value.id) return true
  const name = (drawerSchool.value.name || '').trim().toLowerCase()
  return (record.school_name || '').trim().toLowerCase() === name
}

const schoolAgreements = computed(() => agreements.value.filter(belongsToDrawerSchool))
const schoolQuotations = computed(() => quotations.value.filter(belongsToDrawerSchool))
const schoolInvoices   = computed(() => invoices.value.filter(belongsToDrawerSchool))

const invoiceSummary = computed(() => {
  const total = schoolInvoices.value.reduce((s, i) => s + i.price_per_student * i.quantity, 0)
  const paid  = schoolInvoices.value.filter(i => i.status === 'paid').reduce((s, i) => s + i.price_per_student * i.quantity, 0)
  return { total, paid, outstanding: total - paid }
})

async function downloadAgreement(a) {
  try {
    await generateAgreementFiles(a)
  } catch (e) {
    console.error(e)
    toast.add({ severity: 'error', summary: 'Download failed', detail: e.message || 'Could not generate files', life: 4000 })
  }
}

function viewSignedPdf(a) {
  if (a.signed_pdf_url) window.open(a.signed_pdf_url, '_blank')
}

function triggerAgreementUpload(a) {
  agreementUploadTarget.value = a
  agreementFileInputEl.value?.click()
}

async function onAgreementFileSelected(e) {
  const file = e.target.files?.[0]
  e.target.value = ''
  if (!file || !agreementUploadTarget.value) return

  const a = agreementUploadTarget.value
  uploadingAgreementId.value = a.id
  try {
    const path = `agreements/${a.id}/signed_${Date.now()}.pdf`
    const sRef = storageRef(storage, path)
    await uploadBytes(sRef, file)
    const url = await getDownloadURL(sRef)

    await updateDoc(opsDoc('agreements', a.id), { status: 'Signed', signed_pdf_url: url })
    toast.add({ severity: 'success', summary: 'Signed', detail: `Signed agreement saved for ${a.school_name}`, life: 3000 })
    await loadAgreements()
  } catch (err) {
    console.error(err)
    toast.add({ severity: 'error', summary: 'Upload failed', detail: err.message || 'Could not upload signed PDF', life: 4000 })
  } finally {
    uploadingAgreementId.value = null
    agreementUploadTarget.value = null
  }
}

function newQuotationForSchool() {
  router.push({
    name: 'quotations',
    query: {
      school_id:     drawerSchool.value.id,
      school_name:   drawerSchool.value.name,
      student_count: drawerSchool.value.student_count || undefined,
    },
  })
}

async function downloadQuotation(q) {
  try {
    await generateQuotationPDF(q)
  } catch (e) {
    console.error(e)
    toast.add({ severity: 'error', summary: 'Download failed', detail: e.message || 'Could not generate PDF', life: 4000 })
  }
}

async function downloadInvoice(inv) {
  try {
    await generateInvoicePDF(inv)
  } catch (e) {
    console.error(e)
    toast.add({ severity: 'error', summary: 'Download failed', detail: e.message || 'Could not generate PDF', life: 4000 })
  }
}

function markInvoicePaid(invoice) {
  confirm.require({
    message: `Mark invoice ${invoice.invoice_number} as paid?`,
    header: 'Mark as Paid',
    icon: 'pi pi-check-circle',
    rejectLabel: 'Cancel',
    acceptLabel: 'Mark Paid',
    accept: async () => {
      try {
        await updateDoc(opsDoc('invoices', invoice.id), { status: 'paid', paid_on: serverTimestamp() })
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

// ── Documents ─────────────────────────────────────────────────────────────────
function triggerDocUpload() {
  docFileInputEl.value?.click()
}

async function onDocFileSelected(e) {
  const file = e.target.files?.[0]
  e.target.value = ''
  if (!file || !drawerSchool.value) return

  uploadingDoc.value = true
  try {
    const path = `schools/${drawerSchool.value.id}/documents/${Date.now()}_${file.name}`
    const sRef = storageRef(storage, path)
    await uploadBytes(sRef, file)
    const url = await getDownloadURL(sRef)

    const docEntry = {
      id:          Date.now().toString(),
      name:        file.name,
      url,
      path,
      uploaded_at: new Date().toISOString(),
    }
    const documents = [...(drawerSchool.value.documents || []), docEntry]
    drawerSchool.value.documents = documents
    await saveDrawerField('documents', documents)
    syncSchoolField('documents', documents)
    toast.add({ severity: 'success', summary: 'Uploaded', detail: `${file.name} added`, life: 2500 })
  } catch (err) {
    console.error(err)
    toast.add({ severity: 'error', summary: 'Upload failed', detail: err.message || 'Could not upload document', life: 4000 })
  } finally {
    uploadingDoc.value = false
  }
}

function downloadDocument(docEntry) {
  if (docEntry.url) window.open(docEntry.url, '_blank')
}

async function deleteDocument(docEntry) {
  const documents = (drawerSchool.value.documents || []).filter(d => d.id !== docEntry.id)
  drawerSchool.value.documents = documents
  await saveDrawerField('documents', documents)
  syncSchoolField('documents', documents)
  if (docEntry.path) {
    try {
      await deleteObject(storageRef(storage, docEntry.path))
    } catch (e) {
      console.error('Could not delete file from storage', e)
    }
  }
}

// ── Drawer ────────────────────────────────────────────────────────────────────
function openDrawer(school) {
  drawerSchool.value = { ...school, statuses: school.statuses || [], notes: school.notes || [], documents: school.documents || [] }
  drawerVisible.value = true
  drawerTab.value = 'overview'
  newNote.value = ''
  editingNoteId.value = null
}

async function toggleStatus(status) {
  const current = [...(drawerSchool.value.statuses || [])]
  let newStatuses

  if (status === 'Converted' && !current.includes('Converted')) {
    newStatuses = ['Converted']
  } else if (!current.includes(status)) {
    newStatuses = current.filter(s => s !== 'Converted').concat(status)
  } else {
    newStatuses = current.filter(s => s !== status)
  }

  // Replace entire drawerSchool object so Vue 3 ref reactivity fires reliably
  drawerSchool.value = { ...drawerSchool.value, statuses: newStatuses }

  await saveDrawerField('statuses', newStatuses)
  const idx = schools.value.findIndex(s => s.id === drawerSchool.value.id)
  if (idx !== -1) schools.value[idx].statuses = newStatuses
}

async function addNote() {
  if (!newNote.value.trim()) return
  const note = {
    id:         Date.now().toString(),
    text:       newNote.value.trim(),
    created_at: new Date().toISOString(),
  }
  const notes = [...(drawerSchool.value.notes || []), note]
  drawerSchool.value.notes = notes
  newNote.value = ''
  await saveDrawerField('notes', notes)
  syncSchoolField('notes', notes)
}

function startEditNote(note) {
  editingNoteId.value = note.id
  editNoteText.value  = note.text
}

async function saveEditNote(id) {
  const notes = drawerSchool.value.notes.map(n =>
    n.id === id ? { ...n, text: editNoteText.value.trim() } : n
  )
  drawerSchool.value.notes = notes
  editingNoteId.value = null
  await saveDrawerField('notes', notes)
  syncSchoolField('notes', notes)
}

async function deleteNote(id) {
  const notes = drawerSchool.value.notes.filter(n => n.id !== id)
  drawerSchool.value.notes = notes
  await saveDrawerField('notes', notes)
  syncSchoolField('notes', notes)
}

async function saveDrawerField(field, value) {
  try {
    await updateDoc(opsDoc('schools', drawerSchool.value.id), { [field]: value })
  } catch (e) {
    toast.add({ severity: 'error', summary: 'Error', detail: 'Could not save', life: 3000 })
  }
}

function syncSchoolField(field, value) {
  const idx = schools.value.findIndex(s => s.id === drawerSchool.value.id)
  if (idx !== -1) schools.value[idx][field] = value
}

// ── Add/Edit dialog ───────────────────────────────────────────────────────────
const emptyForm = () => ({
  name: '', city: '', address: '', student_count: null,
  contact_person: '', contact_designation: '',
  contact_phone: '', contact_email: '', modules: [],
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
    modules: school.modules || [],
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
      modules: form.modules,
    }
    if (editingSchool.value) {
      await updateDoc(opsDoc('schools', editingSchool.value.id), payload)
      toast.add({ severity: 'success', summary: 'Saved', detail: 'School updated', life: 2500 })
    } else {
      payload.created_at = serverTimestamp()
      payload.statuses   = ['Lead']
      payload.notes      = []
      await addDoc(opsCollection('schools'), payload)
      toast.add({ severity: 'success', summary: 'Added', detail: `${form.name} added`, life: 2500 })
      celebrate(`${form.name} is now a partner!`, '🏫')
    }
    dialogVisible.value = false
    await loadSchools()
  } catch (e) {
    formError.value = 'Something went wrong. Try again.'
  } finally {
    saving.value = false
  }
}

function confirmDelete(school) {
  confirm.require({
    message: `Remove ${school.name}?`,
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

function formatDateTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) + ' · ' +
    d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
}

function formatRupee(amount) {
  if (!amount) return '₹0'
  return '₹' + Number(amount).toLocaleString('en-IN')
}

onMounted(async () => {
  await Promise.all([loadSchools(), loadAgreements(), loadQuotations(), loadInvoices(), loadModuleSettings()])
})
</script>

<style scoped>
.form-label {
  display: block; font-size: 12px; font-weight: 500;
  color: #64748b; margin-bottom: 4px;
  text-transform: uppercase; letter-spacing: 0.04em;
}
</style>
