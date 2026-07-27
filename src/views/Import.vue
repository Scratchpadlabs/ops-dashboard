<template>
  <!-- ── Step-up reauth gate ──────────────────────────────────────────────── -->
  <div v-if="!isElevated" class="flex items-center justify-center py-20">
    <div class="bg-white rounded-xl border border-slate-200 p-6 w-full max-w-sm">
      <div class="flex items-center gap-2 mb-1">
        <i class="pi pi-shield text-slate-400"></i>
        <div class="text-sm font-bold text-slate-900">Confirm your password to continue</div>
      </div>
      <p class="text-xs text-slate-400 mb-4">Import writes into School Setup's data — re-enter your password to proceed.</p>

      <Password
        v-model="password"
        class="w-full"
        input-class="w-full"
        placeholder="Password"
        :feedback="false"
        toggleMask
        @keyup.enter="submitReauth"
      />
      <div v-if="reauthError" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2 mt-3">{{ reauthError }}</div>

      <Button label="Continue" class="w-full mt-4" :loading="reauthing" @click="submitReauth" />
    </div>
  </div>

  <!-- ── Page shell ───────────────────────────────────────────────────────── -->
  <div v-else @click.capture="markActivity" @keydown.capture="markActivity" @mousemove="throttledActivity">
    <div class="bg-white rounded-xl border border-slate-200 p-5 mb-5">
      <div class="text-sm font-bold text-slate-900 mb-3">New Import</div>
      <div class="grid grid-cols-2 gap-4 mb-4">
        <div>
          <label class="form-label">School *</label>
          <Select
            v-model="selectedSchoolId"
            :options="schools"
            optionLabel="name"
            optionValue="id"
            placeholder="Select a school"
            class="w-full"
            :loading="loadingSchools"
            filter
          />
        </div>
        <div>
          <label class="form-label">Entity *</label>
          <Select v-model="entity" :options="entityOptions" optionLabel="label" optionValue="value" class="w-full" />
        </div>
      </div>

      <div
        @dragover.prevent="isDragging = true"
        @dragleave.prevent="isDragging = false"
        @drop.prevent="onDrop"
        @click="triggerFileInput"
        class="border-2 border-dashed rounded-lg py-8 px-3 text-center text-sm cursor-pointer transition-colors"
        :class="isDragging ? 'border-blue-400 bg-blue-50 text-blue-600' : 'border-slate-200 text-slate-400 hover:border-slate-300'"
      >
        <i class="pi pi-cloud-upload text-2xl mb-2 block"></i>
        Drag &amp; drop files here or click to browse
        <div class="text-xs text-slate-300 mt-1">.xlsx .docx .pdf .png .jpg — multiple files allowed</div>
      </div>
      <input ref="fileInputEl" type="file" multiple class="hidden" accept=".xlsx,.xlsm,.docx,.pdf,.png,.jpg,.jpeg" @change="onFileSelected" />

      <div v-if="pendingFiles.length" class="space-y-1.5 mt-3">
        <div v-for="(f, i) in pendingFiles" :key="i" class="flex items-center gap-2 text-xs bg-slate-50 rounded-lg px-2.5 py-1.5">
          <i class="pi pi-file text-slate-400"></i>
          <span class="flex-1 truncate text-slate-600">{{ f.name }}</span>
          <button type="button" class="text-slate-300 hover:text-red-500" @click="pendingFiles.splice(i, 1)"><i class="pi pi-times"></i></button>
        </div>
      </div>

      <div v-if="startError" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2 mt-3">{{ startError }}</div>

      <div class="flex justify-end mt-4">
        <Button
          label="Start Extraction"
          icon="pi pi-bolt"
          :loading="starting"
          :disabled="!selectedSchoolId || !pendingFiles.length"
          @click="startImport"
        />
      </div>
    </div>

    <div class="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <div class="px-5 py-3 border-b border-slate-100 text-sm font-bold text-slate-900">Recent Imports</div>
      <DataTable :value="jobs" size="small" stripedRows @row-click="e => goToReview(e.data)" class="cursor-pointer">
        <Column header="School" style="width:220px">
          <template #body="{ data }">{{ schoolName(data.school_id) }}</template>
        </Column>
        <Column field="entity" header="Entity" style="width:120px">
          <template #body="{ data }"><span class="capitalize">{{ data.entity }}</span></template>
        </Column>
        <Column header="Status" style="width:140px">
          <template #body="{ data }">
            <span class="px-2.5 py-1 rounded-full text-xs font-semibold" :class="statusClass(data.status)">{{ data.status }}</span>
          </template>
        </Column>
        <Column header="Rows" style="width:100px">
          <template #body="{ data }">{{ data.row_count ?? '—' }}</template>
        </Column>
        <Column header="Flags" style="width:100px">
          <template #body="{ data }">{{ data.flag_count ?? '—' }}</template>
        </Column>
        <Column header="Created" style="width:200px">
          <template #body="{ data }">
            <span class="text-xs text-slate-400">{{ formatTs(data.created_at) }} · {{ data.created_by }}</span>
          </template>
        </Column>
      </DataTable>
      <div v-if="!jobs.length" class="text-center text-sm text-slate-400 py-10">No imports yet</div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { getDocs, query, orderBy, limit } from 'firebase/firestore'
import Select from 'primevue/select'
import Password from 'primevue/password'
import Button from 'primevue/button'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'

import { useStepUpAuth } from '../composables/useStepUpAuth.js'
import { rootSchoolsCollection } from '../firebase/schoolCollections.js'
import { uploadAndProcess, listenJobs } from '../composables/useImport.js'

const router = useRouter()
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

// ── Schools ──────────────────────────────────────────────────────────────
const schools = ref([])
const loadingSchools = ref(false)
const selectedSchoolId = ref(null)

async function loadSchools() {
  loadingSchools.value = true
  try {
    const snap = await getDocs(query(rootSchoolsCollection(), orderBy('name'), limit(500)))
    schools.value = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(s => s.isActive !== false)
  } catch (e) {
    console.error('Could not load schools', e)
  } finally {
    loadingSchools.value = false
  }
}
function schoolName(id) {
  return schools.value.find(s => s.id === id)?.name || id
}

// ── Upload form ──────────────────────────────────────────────────────────
const entityOptions = [
  { label: 'Students', value: 'students' },
  { label: 'Teachers', value: 'teachers' },
  { label: 'Subjects', value: 'subjects' },
  { label: 'Assessments', value: 'assessments' },
]
const entity = ref('students')
const pendingFiles = ref([])
const isDragging = ref(false)
const fileInputEl = ref(null)
const starting = ref(false)
const startError = ref('')

function triggerFileInput() { fileInputEl.value?.click() }
function onFileSelected(e) {
  pendingFiles.value.push(...Array.from(e.target.files || []))
  e.target.value = ''
}
function onDrop(e) {
  isDragging.value = false
  pendingFiles.value.push(...Array.from(e.dataTransfer?.files || []))
}

async function startImport() {
  startError.value = ''
  starting.value = true
  try {
    const jobId = await uploadAndProcess(selectedSchoolId.value, entity.value, pendingFiles.value)
    pendingFiles.value = []
    router.push({ name: 'import-review', params: { jobId } })
  } catch (e) {
    console.error(e)
    startError.value = e.message || 'Could not start extraction — try again.'
  } finally {
    starting.value = false
  }
}

// ── Jobs list ────────────────────────────────────────────────────────────
const jobs = ref([])
let unsubscribeJobs = null

function goToReview(job) {
  router.push({ name: 'import-review', params: { jobId: job.id } })
}
function statusClass(status) {
  return {
    processing: 'bg-amber-50 text-amber-700',
    ready: 'bg-blue-50 text-blue-700',
    committed: 'bg-green-50 text-green-700',
    failed: 'bg-red-50 text-red-700',
  }[status] || 'bg-slate-100 text-slate-600'
}
function formatTs(ts) {
  if (!ts?.toDate) return ''
  return ts.toDate().toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

onMounted(() => {
  loadSchools()
  unsubscribeJobs = listenJobs(null, (list) => { jobs.value = list })
})
onUnmounted(() => { unsubscribeJobs?.() })
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
