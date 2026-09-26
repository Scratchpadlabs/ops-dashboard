<template>
  <!-- ── Step-up reauth gate ──────────────────────────────────────────────── -->
  <div v-if="!isElevated" class="flex items-center justify-center py-20">
    <div class="bg-white rounded-xl border border-slate-200 p-6 w-full max-w-sm">
      <div class="flex items-center gap-2 mb-1">
        <i class="pi pi-shield text-slate-400"></i>
        <div class="text-sm font-bold text-slate-900">Confirm your password to continue</div>
      </div>
      <p class="text-xs text-slate-400 mb-4">Smart remarks are written onto student records and go out on report cards — re-enter your password to proceed.</p>

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
    <ConfirmDialog />

    <div class="bg-white rounded-xl border border-slate-200 p-4 mb-4">
      <div class="flex items-end gap-3 flex-wrap">
        <div>
          <label class="form-label">School</label>
          <Select
            v-model="schoolId" :options="schools" optionLabel="name" optionValue="id"
            placeholder="Select a school" class="w-72" :loading="loadingSchools"
            :disabled="running" filter
          />
        </div>
        <div>
          <label class="form-label">Class</label>
          <Select
            v-model="classId" :options="classes" optionLabel="label" optionValue="id"
            placeholder="Select a class" class="w-56" :loading="loadingClasses"
            :disabled="!schoolId || running" filter
          />
        </div>
        <Button
          label="Generate remarks" icon="pi pi-sparkles"
          :loading="running" :disabled="!schoolId || !classId"
          @click="confirmGenerate"
        />
        <Button
          label="Refresh" icon="pi pi-refresh" outlined
          :disabled="!classId || running || loadingRoster" :loading="loadingRoster"
          @click="reload"
        />
        <div v-if="classId && !loadingRoster" class="text-xs text-slate-400 ml-auto pb-2">
          {{ students.length }} student{{ students.length === 1 ? '' : 's' }} in this class
        </div>
      </div>

      <div v-if="classId" class="flex items-center gap-2 flex-wrap mt-3">
        <Button label="Export CSV" icon="pi pi-download" size="small" outlined
                :disabled="!students.length" @click="exportCsv" />
        <Button label="Export XLSX" icon="pi pi-file-excel" size="small" outlined
                :disabled="!students.length" @click="exportXlsx" />
        <span class="text-xs text-slate-400">Exports one row per student, exactly as listed below.</span>
      </div>

      <p class="text-xs text-slate-400 mt-3">
        Generates one general-conduct comment per student from the ticked boxes on this class's
        Smart Sheets remarks. Remarks already marked approved are left alone — use the regenerate
        icon on a student to force those to be written again.
      </p>
    </div>

    <!-- ── Live run progress ─────────────────────────────────────────────── -->
    <div v-if="running || runError" class="bg-white rounded-xl border border-slate-200 p-4 mb-4">
      <div v-if="running">
        <div class="flex items-center justify-between mb-2">
          <div class="text-sm font-semibold text-slate-900">
            <i class="pi pi-spin pi-spinner text-sm mr-2 text-blue-500"></i>
            Generating remarks for {{ runningLabel }}
          </div>
          <div v-if="job?.totalStudents" class="text-xs text-slate-500">
            {{ job.processedStudents || 0 }} of {{ job.totalStudents }} students
          </div>
        </div>
        <ProgressBar v-if="job?.totalStudents" :value="progressPct" style="height:8px" />
        <ProgressBar v-else mode="indeterminate" style="height:8px" />
        <p class="text-xs text-slate-400 mt-2">
          {{ job ? 'Keep this tab open — progress updates as each remark is written.'
                 : 'Reading the class\'s remarks sheet…' }}
        </p>
      </div>

      <div v-if="runError" class="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2" :class="running ? 'mt-3' : ''">
        {{ runError }}
      </div>
    </div>

    <!-- ── Scan-time findings ───────────────────────────────────────────── -->
    <div v-if="scan && !scan.band && !scan.categories?.length && !running" class="bg-red-50 border border-red-200 rounded-xl px-4 py-3 mb-4 text-sm text-red-900">
      <i class="pi pi-exclamation-triangle mr-1.5"></i>
      This class's stage ("{{ scan.stageIssue || 'not set' }}") doesn't map to a known remark band
      (Foundational/Preparatory/Middle/Secondary). Set the class's stage in School Setup before
      generating remarks for it.
    </div>
    <div v-else-if="scan && !scan.sheetFound && !running" class="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 mb-4 text-sm text-amber-900">
      <i class="pi pi-exclamation-triangle mr-1.5"></i>
      No remarks sheet exists yet for this class — a teacher hasn't ticked any boxes for it.
    </div>
    <div v-else-if="scan && scan.unmatchedTicks && !scan.tickedStudents && !running" class="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 mb-4 text-sm text-amber-900">
      <i class="pi pi-exclamation-triangle mr-1.5"></i>
      Teachers have ticked {{ scan.unmatchedTicks }} box{{ scan.unmatchedTicks === 1 ? '' : 'es' }} for this
      class, but none of them match a statement in any remark category assigned to it. Check the class's
      remark categories in School Setup.
    </div>
    <div v-else-if="scan && scan.tickedStudents && !hasRemarks && !running" class="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 mb-4 text-sm text-blue-900">
      <i class="pi pi-info-circle mr-1.5"></i>
      {{ scan.tickedStudents }} of {{ scan.students }} students have boxes ticked in Smart Sheets.
      Click <b>Generate remarks</b> to write their comments.
    </div>
    <div v-else-if="scan && scan.multipleSheetsFound && !running" class="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 mb-4 text-sm text-amber-900">
      <i class="pi pi-exclamation-triangle mr-1.5"></i>
      More than one remarks sheet was found for this class — ticks from every sheet were merged
      (a key ticked differently across sheets uses whichever sheet was edited most recently).
    </div>

    <!-- ── Review table ──────────────────────────────────────────────────── -->
    <div v-if="!classId" class="text-center py-20 bg-white rounded-xl border border-slate-200">
      <i class="pi pi-comments text-4xl text-slate-300 mb-3 block"></i>
      <p class="text-slate-500 font-medium">Pick a school and class to review its smart remarks</p>
    </div>

    <div v-else-if="loadingRoster" class="flex items-center justify-center py-20">
      <ProgressSpinner style="width:32px;height:32px" />
    </div>

    <SmartRemarksTable
      v-else
      :school-id="schoolId"
      :students="students"
      :remarks-by-student="remarksByStudent"
      @saved="onSaved"
    />
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useToast } from 'primevue/usetoast'
import { useConfirm } from 'primevue/useconfirm'
import Select from 'primevue/select'
import Password from 'primevue/password'
import Button from 'primevue/button'
import ProgressBar from 'primevue/progressbar'
import ProgressSpinner from 'primevue/progressspinner'
import ConfirmDialog from 'primevue/confirmdialog'

import { useStepUpAuth } from '../composables/useStepUpAuth.js'
import { useSmartRemarks } from '../composables/useSmartRemarks.js'
import SmartRemarksTable from '../components/smart-remarks/SmartRemarksTable.vue'
import { downloadSmartRemarksCsv, downloadSmartRemarksXlsx } from '../utils/smartRemarksExport.js'

/**
 * Smart Remarks — general-conduct report-card comments, generated from the
 * "Smart Sheets" ticking system (a different data source from AAP Remarks,
 * which is subject-scoped survey ratings). Gated the same way: ops-admin
 * only (router meta) plus a password re-entry, since this writes text that
 * leaves the building on a child's report card.
 */
const toast = useToast()
const confirm = useConfirm()
const { isElevated, markActivity, reauthenticate } = useStepUpAuth()

const {
  schools, classes, students, remarksByStudent,
  loadingSchools, loadingClasses, loadingRoster,
  loadSchools, loadClasses, loadClass, reloadStudent,
  generate, recentJobIds, watchNewJob,
} = useSmartRemarks()

// ── Step-up gate ──────────────────────────────────────────────────────────
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

// ── Selection ─────────────────────────────────────────────────────────────
const schoolId = ref(null)
const classId = ref(null)

watch(schoolId, async (id) => {
  classId.value = null
  if (!id) return
  try {
    await loadClasses(id)
  } catch (e) {
    console.error('Could not load classes', e)
    toast.add({ severity: 'error', summary: 'Could not load classes', detail: e.message, life: 4000 })
  }
})

const scan = ref(null)

watch(classId, () => {
  scan.value = null
  reload()
})

async function reload() {
  if (!classId.value) return
  try {
    scan.value = await loadClass(schoolId.value, classId.value)
  } catch (e) {
    console.error('Could not load the class', e)
    toast.add({ severity: 'error', summary: 'Could not load this class', detail: e.message, life: 5000 })
  }
}

// ── Generation run ────────────────────────────────────────────────────────
const running = ref(false)
const runError = ref('')
const job = ref(null)
let unsubJob = null

const runningLabel = computed(() => job.value?.classId || classId.value || '')
const progressPct = computed(() => {
  const total = job.value?.totalStudents || 0
  if (!total) return 0
  return Math.min(100, Math.round((job.value.processedStudents || 0) / total * 100))
})

function stopWatching() {
  if (unsubJob) { unsubJob(); unsubJob = null }
}

const hasRemarks = computed(() =>
  Object.values(remarksByStudent.value).some(r => r && r.length))

function confirmGenerate() {
  if (!hasRemarks.value) { runGenerate(); return }
  confirm.require({
    header: 'Generate remarks',
    message: `${classId.value} already has remarks. Running again rewrites every comment that isn't approved yet. Continue?`,
    icon: 'pi pi-exclamation-triangle',
    rejectLabel: 'Cancel', acceptLabel: 'Generate',
    accept: () => runGenerate(),
  })
}

async function runGenerate(confirmGenderIssue = false) {
  running.value = true
  runError.value = ''
  job.value = null
  try {
    const known = await recentJobIds(schoolId.value)
    unsubJob = watchNewJob(schoolId.value, classId.value, known, (j) => { job.value = j })

    const result = await generate({ schoolId: schoolId.value, classId: classId.value, confirmGenderIssue })
    scan.value = result
    const skipped = []
    if (result.skippedApproved) skipped.push(`${result.skippedApproved} already approved`)
    if (result.skippedNoTicks) skipped.push(`${result.skippedNoTicks} with nothing ticked`)
    toast.add({
      severity: result.written ? 'success' : 'warn',
      summary: result.written ? `${result.written} remark${result.written === 1 ? '' : 's'} written` : 'No remarks written',
      detail: skipped.length ? `Skipped: ${skipped.join(', ')}` : undefined,
      life: 6000,
    })
    await loadClass(schoolId.value, classId.value)
  } catch (e) {
    console.error('Smart remarks generation failed', e)
    stopWatching()
    running.value = false
    job.value = null
    if (!confirmGenderIssue && e.message?.includes('Gender data looks incomplete')) {
      confirm.require({
        header: 'Gender data looks incomplete or unusual',
        message: 'This class\'s gender data is missing for some students, or suspiciously uniform. '
          + 'A blank gender is written about as "She" by default — proceed anyway?',
        icon: 'pi pi-exclamation-triangle',
        rejectLabel: 'Cancel', acceptLabel: 'Proceed anyway',
        accept: () => runGenerate(true),
      })
      return
    }
    runError.value = e.message || 'Generation failed'
    await loadClass(schoolId.value, classId.value)
    return
  }
  stopWatching()
  running.value = false
  job.value = null
}

const onSaved = (studentId) => studentId
  ? reloadStudent(schoolId.value, studentId)
  : loadClass(schoolId.value, classId.value)

function exportCsv() {
  const count = downloadSmartRemarksCsv(schoolId.value, classId.value, students.value, remarksByStudent.value)
  toast.add({ severity: 'success', summary: `Exported ${count} rows`, life: 2500 })
}

function exportXlsx() {
  const count = downloadSmartRemarksXlsx(schoolId.value, classId.value, students.value, remarksByStudent.value)
  toast.add({ severity: 'success', summary: `Exported ${count} rows`, life: 2500 })
}

onMounted(async () => {
  try {
    await loadSchools()
  } catch (e) {
    console.error('Could not load schools', e)
    toast.add({ severity: 'error', summary: 'Could not load schools', detail: e.message, life: 4000 })
  }
})
onUnmounted(stopWatching)
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
