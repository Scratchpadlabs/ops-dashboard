<template>
  <div>
    <div class="bg-white rounded-xl border border-slate-200 p-4 mb-5">
      <div class="flex items-center justify-between mb-1">
        <div class="text-sm font-bold text-slate-900">Email Intake Queue</div>
        <div class="text-xs text-slate-400">Attachments emailed/forwarded to the intake mailbox land here automatically</div>
      </div>
      <div class="flex gap-2 mt-3">
        <button
          v-for="f in filters" :key="f.value"
          type="button"
          class="px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors"
          :class="activeFilter === f.value ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'"
          @click="activeFilter = f.value"
        >
          {{ f.label }} <span class="opacity-70">({{ countFor(f.value) }})</span>
        </button>
      </div>
    </div>

    <div class="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <DataTable :value="filteredFiles" size="small" stripedRows>
        <Column header="Received" style="width:150px">
          <template #body="{ data }"><span class="text-xs text-slate-500">{{ formatTs(data.received_at) }}</span></template>
        </Column>
        <Column header="From" style="width:200px">
          <template #body="{ data }">
            <div class="text-sm text-slate-700 truncate">{{ data.sender || '—' }}</div>
            <div class="text-xs text-slate-400 truncate">{{ data.subject || '' }}</div>
          </template>
        </Column>
        <Column header="File" style="width:220px">
          <template #body="{ data }">
            <div class="flex items-center gap-2 min-w-0">
              <i :class="fileIcon(data.content_type_guess)" class="text-slate-400"></i>
              <span class="text-sm text-slate-700 truncate">{{ data.filename }}</span>
            </div>
          </template>
        </Column>
        <Column header="Type Guess" style="width:110px">
          <template #body="{ data }">
            <span v-if="data.entity_guess" class="capitalize text-xs font-semibold text-blue-700">{{ data.entity_guess }}</span>
            <span v-else class="text-xs text-slate-300">—</span>
          </template>
        </Column>
        <Column header="School" style="width:200px">
          <template #body="{ data }">
            <button
              type="button"
              class="text-sm text-left truncate hover:underline"
              :class="data.school_id ? 'text-slate-800 font-medium' : 'text-amber-600 font-semibold'"
              @click="openAssign(data)"
            >
              {{ schoolName(data.school_id) || 'Assign school…' }}
            </button>
          </template>
        </Column>
        <Column header="Status" style="width:130px">
          <template #body="{ data }">
            <span
              class="px-2.5 py-1 rounded-full text-xs font-semibold" :class="statusClass(data.status)"
              v-tooltip.top="data.status === 'error' ? data.status_reason : null"
            >{{ data.status }}</span>
          </template>
        </Column>
        <Column header="" style="width:160px">
          <template #body="{ data }">
            <div class="flex items-center gap-1 justify-end">
              <Button
                v-if="data.status === 'staged' && data.staging_job_id"
                label="Review" size="small" text
                @click="router.push({ name: 'import-review', params: { jobId: data.staging_job_id } })"
              />
              <Button
                v-if="data.status === 'error' && data.school_id && data.entity_guess"
                label="Retry" size="small" text :loading="retryingId === data.id"
                @click="retry(data)"
              />
              <Button icon="pi pi-times" text rounded size="small" severity="danger" v-tooltip="'Dismiss'" @click="confirmDismiss(data)" />
            </div>
          </template>
        </Column>
      </DataTable>
      <div v-if="!filteredFiles.length" class="text-center text-sm text-slate-400 py-10">Nothing here</div>
    </div>

    <!-- ── Assign school dialog ─────────────────────────────────────────── -->
    <Dialog v-model:visible="assignDialogOpen" header="Assign School" modal style="width: 420px">
      <div v-if="assignTarget">
        <div class="text-xs text-slate-400 mb-3">
          From <span class="font-medium text-slate-600">{{ assignTarget.sender }}</span> — assigning remembers this
          sender for this school's future intake automatically.
        </div>
        <Select
          v-model="assignSchoolId"
          :options="schools"
          optionLabel="name"
          optionValue="id"
          placeholder="Select a school"
          class="w-full"
          filter
        />
        <div v-if="assignError" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2 mt-3">{{ assignError }}</div>
      </div>
      <template #footer>
        <Button label="Cancel" text @click="assignDialogOpen = false" />
        <Button label="Assign" :loading="assigning" :disabled="!assignSchoolId" @click="confirmAssign" />
      </template>
    </Dialog>

    <ConfirmDialog />
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { getDocs, query, orderBy, limit } from 'firebase/firestore'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import Select from 'primevue/select'
import ConfirmDialog from 'primevue/confirmdialog'
import { useConfirm } from 'primevue/useconfirm'
import { useToast } from 'primevue/usetoast'

import { rootSchoolsCollection } from '../firebase/schoolCollections.js'
import { listenIntakeFiles, assignSchoolToFile, dismissIntakeFile } from '../composables/useIntake.js'

const router = useRouter()
const confirm = useConfirm()
const toast = useToast()

// ── Schools (for name lookup + assign dropdown) ─────────────────────────────
const schools = ref([])
async function loadSchools() {
  const snap = await getDocs(query(rootSchoolsCollection(), orderBy('name'), limit(500)))
  schools.value = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(s => s.isActive !== false)
}
function schoolName(id) {
  if (!id) return ''
  return schools.value.find(s => s.id === id)?.name || id
}

// ── Live intake files ────────────────────────────────────────────────────────
const files = ref([])
let unsubscribe = null

const filters = [
  { value: 'attention', label: 'Needs Attention' },
  { value: 'unassigned', label: 'Unassigned' },
  { value: 'queued', label: 'Queued' },
  { value: 'staged', label: 'Staged' },
  { value: 'error', label: 'Error' },
  { value: 'dismissed', label: 'Dismissed' },
  { value: 'all', label: 'All' },
]
const activeFilter = ref('attention')

function matchesFilter(f, value) {
  if (value === 'all') return true
  if (value === 'attention') return ['unassigned', 'queued', 'error'].includes(f.status)
  return f.status === value
}
function countFor(value) {
  return files.value.filter(f => matchesFilter(f, value)).length
}
const filteredFiles = computed(() => files.value.filter(f => matchesFilter(f, activeFilter.value)))

function fileIcon(guess) {
  return {
    spreadsheet: 'pi pi-table', pdf: 'pi pi-file-pdf', image: 'pi pi-image', docx: 'pi pi-file-word',
  }[guess] || 'pi pi-file'
}
function statusClass(status) {
  return {
    unassigned: 'bg-amber-50 text-amber-700',
    queued: 'bg-blue-50 text-blue-700',
    staged: 'bg-green-50 text-green-700',
    dismissed: 'bg-slate-100 text-slate-500',
    error: 'bg-red-50 text-red-700',
  }[status] || 'bg-slate-100 text-slate-600'
}
function formatTs(ts) {
  if (!ts?.toDate) return ''
  return ts.toDate().toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

// ── Assign dialog ────────────────────────────────────────────────────────────
const assignDialogOpen = ref(false)
const assignTarget = ref(null)
const assignSchoolId = ref(null)
const assigning = ref(false)
const assignError = ref('')

function openAssign(file) {
  assignTarget.value = file
  assignSchoolId.value = file.school_id || null
  assignError.value = ''
  assignDialogOpen.value = true
}
async function confirmAssign() {
  if (!assignSchoolId.value || !assignTarget.value) return
  assignError.value = ''
  assigning.value = true
  try {
    await assignSchoolToFile(assignTarget.value, assignSchoolId.value)
    assignDialogOpen.value = false
    toast.add({ severity: 'success', summary: 'Assigned', life: 2000 })
  } catch (e) {
    assignError.value = e.message || 'Could not assign school'
  } finally {
    assigning.value = false
  }
}

// ── Retry (re-attempt auto-stage on an errored, already-assigned file) ──────
const retryingId = ref(null)
async function retry(file) {
  retryingId.value = file.id
  try {
    await assignSchoolToFile(file, file.school_id)
  } catch (e) {
    toast.add({ severity: 'error', summary: 'Retry failed', detail: e.message || String(e), life: 4000 })
  } finally {
    retryingId.value = null
  }
}

// ── Dismiss ──────────────────────────────────────────────────────────────────
function confirmDismiss(file) {
  confirm.require({
    message: `Dismiss "${file.filename}"? It'll be hidden from the active queue.`,
    header: 'Dismiss File', icon: 'pi pi-exclamation-triangle',
    rejectLabel: 'Cancel', acceptLabel: 'Dismiss', acceptClass: 'p-button-danger',
    accept: async () => {
      try {
        await dismissIntakeFile(file)
      } catch (e) {
        toast.add({ severity: 'error', summary: 'Error', detail: 'Could not dismiss', life: 3000 })
      }
    },
  })
}

onMounted(() => {
  loadSchools()
  unsubscribe = listenIntakeFiles((list) => { files.value = list })
})
onUnmounted(() => { unsubscribe?.() })
</script>
