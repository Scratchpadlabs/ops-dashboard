<template>
  <!-- ── Step-up reauth gate ──────────────────────────────────────────────── -->
  <div v-if="!isElevated" class="flex items-center justify-center py-20">
    <div class="bg-white rounded-xl border border-slate-200 p-6 w-full max-w-sm">
      <div class="flex items-center gap-2 mb-1">
        <i class="pi pi-shield text-slate-400"></i>
        <div class="text-sm font-bold text-slate-900">Confirm your password to continue</div>
      </div>
      <p class="text-xs text-slate-400 mb-4">Import writes into School Setup's data — re-enter your password to proceed.</p>

      <Password v-model="password" class="w-full" input-class="w-full" placeholder="Password" :feedback="false" toggleMask @keyup.enter="submitReauth" />
      <div v-if="reauthError" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2 mt-3">{{ reauthError }}</div>
      <Button label="Continue" class="w-full mt-4" :loading="reauthing" @click="submitReauth" />
    </div>
  </div>

  <!-- ── Page shell ───────────────────────────────────────────────────────── -->
  <div v-else @click.capture="markActivity" @keydown.capture="markActivity" @mousemove="throttledActivity">
    <div class="flex items-center gap-3 mb-4">
      <Button icon="pi pi-arrow-left" text rounded @click="router.push({ name: 'import' })" />
      <div>
        <div class="text-sm font-bold text-slate-900">{{ schoolName }} · <span class="capitalize">{{ job?.entity }}</span></div>
        <div class="text-xs text-slate-400">{{ job?.created_by }} · {{ formatTs(job?.created_at) }}</div>
      </div>
      <span v-if="job" class="px-2.5 py-1 rounded-full text-xs font-semibold ml-1" :class="statusClass(job.status)">{{ job.status }}</span>
    </div>

    <div v-if="!job" class="flex items-center justify-center py-20"><ProgressSpinner style="width:28px;height:28px" /></div>

    <div v-else-if="job.status === 'processing'" class="bg-white rounded-xl border border-slate-200 p-10 text-center">
      <ProgressSpinner style="width:32px;height:32px" />
      <div class="text-sm text-slate-500 mt-3">Extracting from {{ (job.source_files || []).length }} file(s)… this can take a few minutes for large PDFs.</div>
    </div>

    <div v-else-if="job.status === 'failed'" class="bg-white rounded-xl border border-red-200 p-6">
      <div class="text-sm font-bold text-red-600 mb-1"><i class="pi pi-times-circle mr-1"></i>Extraction failed</div>
      <div class="text-sm text-slate-600">{{ job.error }}</div>
    </div>

    <div v-else>
      <!-- ── Summary ──────────────────────────────────────────────────────── -->
      <div class="bg-white rounded-xl border border-slate-200 p-4 mb-4">
        <div class="flex items-center gap-6 flex-wrap">
          <div><span class="text-lg font-bold text-slate-900">{{ rows.length }}</span> <span class="text-xs text-slate-400">rows</span></div>
          <div><span class="text-lg font-bold" :class="flaggedCount ? 'text-amber-600' : 'text-slate-900'">{{ flaggedCount }}</span> <span class="text-xs text-slate-400">flagged</span></div>
          <div><span class="text-lg font-bold text-slate-900">{{ excludedCount }}</span> <span class="text-xs text-slate-400">excluded</span></div>
          <div v-if="job.entity === 'students'" class="flex-1 flex flex-wrap gap-1.5">
            <span v-for="(count, cls) in perClassCounts" :key="cls" class="px-2 py-0.5 rounded-full text-xs bg-slate-100 text-slate-600">{{ cls }}: {{ count }}</span>
          </div>
          <div class="ml-auto flex gap-2">
            <Button label="Source Files" icon="pi pi-file" size="small" outlined @click="sourceFilesVisible = true" />
          </div>
        </div>
        <div v-if="(job.class_level_flags || []).length" class="mt-3 border-t border-slate-100 pt-3">
          <div class="text-xs font-semibold text-amber-600 mb-1">Class-level flags</div>
          <div v-for="(f, i) in job.class_level_flags" :key="i" class="text-xs text-slate-500">{{ f }}</div>
        </div>
      </div>

      <!-- ── Rows table ───────────────────────────────────────────────────── -->
      <div class="bg-white rounded-xl border border-slate-200 overflow-hidden mb-4">
        <DataTable
          :value="tableRows"
          editMode="cell"
          size="small"
          stripedRows
          :rowClass="rowClass"
          v-model:expandedRows="expandedRows"
          dataKey="_id"
          :paginator="tableRows.length > 100"
          :rows="100"
          @cell-edit-init="editingCell = true"
          @cell-edit-complete="onCellEditComplete"
          @cell-edit-cancel="editingCell = false"
        >
          <Column expander style="width:3rem" />
          <Column style="width:3rem">
            <template #body="{ data }">
              <Checkbox :modelValue="!data._excluded" binary @update:modelValue="v => onToggleExclude(data, v)" />
            </template>
          </Column>
          <Column v-for="col in columns" :key="col" :field="col" :header="colLabel(col)">
            <template #editor="{ data, field }"><InputText v-model="data[field]" class="w-full" size="small" /></template>
          </Column>
          <Column header="" style="width:40px">
            <template #body="{ data }"><i v-if="(data._flags || []).length" class="pi pi-exclamation-triangle text-amber-500" v-tooltip="`${data._flags.length} flag(s)`"></i></template>
          </Column>
          <template #expansion="{ data }">
            <div class="px-4 py-2 bg-slate-50 text-xs text-slate-600">
              <div v-if="!(data._flags || []).length" class="text-slate-400">No flags</div>
              <div v-for="(f, i) in data._flags" :key="i" class="flex items-center gap-1.5 py-0.5"><i class="pi pi-exclamation-triangle text-amber-500 text-xs"></i>{{ f }}</div>
            </div>
          </template>
        </DataTable>
        <div v-if="!tableRows.length" class="text-center text-sm text-slate-400 py-10">No rows staged</div>
      </div>

      <!-- ── Commit ───────────────────────────────────────────────────────── -->
      <div class="bg-white rounded-xl border border-slate-200 p-4">
        <div v-if="job.entity === 'assessments'" class="mb-3">
          <label class="form-label">Term (assessments commit into a term) *</label>
          <Select v-model="selectedTermId" :options="terms" optionLabel="name" optionValue="id" placeholder="Select a term" class="w-80" />
        </div>
        <div v-if="job.status === 'committed'" class="text-sm text-green-600">
          <i class="pi pi-check-circle mr-1"></i>Committed {{ formatTs(job.committed_at) }} by {{ job.committed_by }} —
          <router-link to="/school-setup" class="underline">view in School Setup</router-link>
        </div>
        <div v-else class="flex items-center gap-3">
          <Button
            label="Commit to School Setup"
            icon="pi pi-check"
            :loading="committing"
            :disabled="editingCell || !rows.length"
            @click="openCommitConfirm"
          />
          <span v-if="editingCell" class="text-xs text-slate-400">Finish editing the row before committing</span>
        </div>
      </div>
    </div>

    <!-- ── Source files drawer ──────────────────────────────────────────── -->
    <Dialog v-model:visible="sourceFilesVisible" header="Source Files" modal :style="{ width: '640px' }">
      <div class="space-y-3">
        <div v-for="(url, path) in sourceUrls" :key="path" class="border border-slate-200 rounded-lg p-3">
          <div class="text-xs text-slate-500 mb-2 truncate">{{ path }}</div>
          <embed v-if="isPdf(path) && url" :src="url" type="application/pdf" style="width:100%;height:400px" />
          <img v-else-if="isImage(path) && url" :src="url" class="max-w-full max-h-96 rounded" />
          <a v-else-if="url" :href="url" target="_blank" class="text-sm text-violet-600 underline">Download</a>
          <ProgressSpinner v-else style="width:20px;height:20px" />
        </div>
      </div>
    </Dialog>

    <!-- ── Commit confirm ───────────────────────────────────────────────── -->
    <Dialog v-model:visible="commitConfirmVisible" header="Commit to School Setup" modal :style="{ width: '520px' }">
      <div v-if="plan" class="space-y-3">
        <p class="text-sm text-slate-600">Writing to <span class="font-semibold">{{ schoolName }}</span>'s live <span class="capitalize">{{ job.entity }}</span> data:</p>
        <div class="grid grid-cols-2 gap-2 text-sm">
          <div class="bg-green-50 text-green-700 rounded-lg px-3 py-2">{{ plan.summary.create }} new</div>
          <div class="bg-amber-50 text-amber-700 rounded-lg px-3 py-2">{{ plan.summary.changed }} changed</div>
          <div class="bg-slate-50 text-slate-500 rounded-lg px-3 py-2">{{ plan.summary.unchanged }} unchanged</div>
          <div class="bg-red-50 text-red-600 rounded-lg px-3 py-2">{{ plan.summary.errors }} skipped (errors)</div>
        </div>
        <div v-if="plan.summary.changed" class="flex items-center gap-2 pt-1">
          <Checkbox v-model="overwriteExisting" binary inputId="overwrite" />
          <label for="overwrite" class="text-sm text-slate-600">Overwrite the {{ plan.summary.changed }} changed record(s) with the imported values</label>
        </div>
        <p v-else class="text-xs text-slate-400">No existing records would change — only new ones are written.</p>
      </div>
      <template #footer>
        <Button label="Cancel" text @click="commitConfirmVisible = false" />
        <Button label="Confirm Commit" :loading="committing" @click="confirmCommit" />
      </template>
    </Dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { getDocs, getDoc, query, orderBy } from 'firebase/firestore'
import { ref as storageRef, getDownloadURL } from 'firebase/storage'
import { useToast } from 'primevue/usetoast'

import Password from 'primevue/password'
import Button from 'primevue/button'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import InputText from 'primevue/inputtext'
import Checkbox from 'primevue/checkbox'
import Dialog from 'primevue/dialog'
import Select from 'primevue/select'
import ProgressSpinner from 'primevue/progressspinner'

import { useStepUpAuth } from '../composables/useStepUpAuth.js'
import { storage } from '../firebase/config'
import { rootSchoolDoc, schoolCollection } from '../firebase/schoolCollections.js'
import { listenJob, listenRows, updateRowData, setRowExcluded, buildCommitPlan, commitImport } from '../composables/useImport.js'

const route = useRoute()
const router = useRouter()
const toast = useToast()
const jobId = computed(() => route.params.jobId)

const { isElevated, markActivity, reauthenticate } = useStepUpAuth()
const password = ref('')
const reauthing = ref(false)
const reauthError = ref('')

async function submitReauth() {
  if (!password.value) { reauthError.value = 'Enter your password'; return }
  reauthError.value = ''
  reauthing.value = true
  try {
    await reauthenticate(password.value)
    password.value = ''
  } catch (e) {
    reauthError.value = e.code === 'auth/wrong-password' || e.code === 'auth/invalid-credential'
      ? 'Incorrect password'
      : (e.message || 'Could not verify your password')
  } finally {
    reauthing.value = false
  }
}
let lastMove = 0
function throttledActivity() {
  const now = Date.now()
  if (now - lastMove < 5000) return
  lastMove = now
  markActivity()
}

const COLUMNS = {
  students: ['grade', 'section', 'roll_no', 'student_name', 'gender', 'dob', 'sr_no', 'mother_name', 'father_name', 'contact'],
  teachers: ['teacher_name', 'email', 'class_teacher_of', 'subject', 'grade', 'section'],
  subjects: ['stream', 'grade_band', 'subject', 'area'],
  assessments: ['stream', 'grade_band', 'assessment', 'date_start', 'date_end', 'instructional_days', 'syllabus_covered', 'exam_syllabus', 'max_written', 'activity_weight', 'total', 'duration'],
}
const LABELS = { roll_no: 'Roll No', student_name: 'Name', dob: 'DOB', sr_no: 'Sr No', mother_name: 'Mother', father_name: 'Father', teacher_name: 'Teacher', class_teacher_of: 'Class Teacher Of', grade_band: 'Grade Band', date_start: 'Start', date_end: 'End', instructional_days: 'Inst. Days', syllabus_covered: 'Syllabus Covered', exam_syllabus: 'Exam Syllabus', max_written: 'Max Written', activity_weight: 'Activity Wt', total: 'Total', duration: 'Duration' }
function colLabel(c) { return LABELS[c] || c.charAt(0).toUpperCase() + c.slice(1) }

const job = ref(null)
const rows = ref([])
const schoolName = ref('')
let unsubJob = null, unsubRows = null

const columns = computed(() => COLUMNS[job.value?.entity] || [])
const tableRows = computed(() => rows.value.map(r => ({ _id: r.id, _flags: r.flags || [], _excluded: !!r.excluded, ...r.data })))
const flaggedCount = computed(() => rows.value.filter(r => (r.flags || []).length).length)
const excludedCount = computed(() => rows.value.filter(r => r.excluded).length)
const expandedRows = ref({})
const editingCell = ref(false)

const perClassCounts = computed(() => {
  const out = {}
  for (const r of rows.value) {
    if (r.excluded) continue
    const key = `${r.data.grade || '?'}${r.data.section ? ' ' + r.data.section : ''}`
    out[key] = (out[key] || 0) + 1
  }
  return out
})

function rowClass(data) {
  return (data._flags || []).length ? 'bg-amber-50/60' : ''
}

async function onCellEditComplete(event) {
  const { data, newValue, field } = event
  data[field] = newValue
  const payload = {}
  columns.value.forEach(c => { payload[c] = data[c] })
  try {
    await updateRowData(jobId.value, data._id, payload)
  } catch (e) {
    toast.add({ severity: 'error', summary: 'Could not save edit', detail: e.message, life: 3000 })
  }
}

async function onToggleExclude(data, included) {
  try {
    await setRowExcluded(jobId.value, data._id, !included)
  } catch (e) {
    toast.add({ severity: 'error', summary: 'Could not update', detail: e.message, life: 3000 })
  }
}

function statusClass(status) {
  return {
    processing: 'bg-amber-50 text-amber-700', ready: 'bg-blue-50 text-blue-700',
    committed: 'bg-green-50 text-green-700', failed: 'bg-red-50 text-red-700',
  }[status] || 'bg-slate-100 text-slate-600'
}
function formatTs(ts) {
  if (!ts?.toDate) return ''
  return ts.toDate().toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

// ── Source file viewer ─────────────────────────────────────────────────────
const sourceFilesVisible = ref(false)
const sourceUrls = ref({})
function isPdf(path) { return path.toLowerCase().endsWith('.pdf') }
function isImage(path) { return /\.(png|jpe?g|webp)$/i.test(path) }
watch(sourceFilesVisible, async (visible) => {
  if (!visible || !job.value) return
  for (const path of job.value.source_files || []) {
    if (sourceUrls.value[path]) continue
    try {
      const url = await getDownloadURL(storageRef(storage, path))
      sourceUrls.value = { ...sourceUrls.value, [path]: url }
    } catch (e) {
      console.error('Could not resolve source file URL', path, e)
    }
  }
})

// ── Commit ───────────────────────────────────────────────────────────────
const terms = ref([])
const selectedTermId = ref(null)
const plan = ref(null)
const commitConfirmVisible = ref(false)
const committing = ref(false)
const overwriteExisting = ref(false)

async function loadTerms() {
  if (job.value?.entity !== 'assessments' || !job.value?.school_id) return
  const snap = await getDocs(query(schoolCollection(job.value.school_id, 'terms'), orderBy('name')))
  terms.value = snap.docs.map(d => ({ id: d.id, ...d.data() }))
}

async function openCommitConfirm() {
  if (job.value.entity === 'assessments' && !selectedTermId.value) {
    toast.add({ severity: 'warn', summary: 'Select a Term first', life: 2500 })
    return
  }
  try {
    plan.value = await buildCommitPlan(job.value, rows.value, { termId: selectedTermId.value })
    overwriteExisting.value = false
    commitConfirmVisible.value = true
  } catch (e) {
    toast.add({ severity: 'error', summary: 'Could not build commit plan', detail: e.message, life: 4000 })
  }
}

async function confirmCommit() {
  committing.value = true
  try {
    const result = await commitImport(job.value, plan.value, { overwriteExisting: overwriteExisting.value })
    commitConfirmVisible.value = false
    toast.add({ severity: 'success', summary: 'Committed', detail: `${result.written} record(s) written`, life: 3000 })
  } catch (e) {
    console.error(e)
    toast.add({ severity: 'error', summary: 'Commit failed', detail: e.message, life: 4000 })
  } finally {
    committing.value = false
  }
}

onMounted(() => {
  unsubJob = listenJob(jobId.value, async (j) => {
    job.value = j
    if (j?.school_id && !schoolName.value) {
      const snap = await getDoc(rootSchoolDoc(j.school_id))
      schoolName.value = snap.exists() ? (snap.data().name || j.school_id) : j.school_id
    }
    await loadTerms()
  })
  unsubRows = listenRows(jobId.value, (list) => { rows.value = list })
})
onUnmounted(() => { unsubJob?.(); unsubRows?.() })
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
