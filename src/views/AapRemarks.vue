<template>
  <!-- ── Step-up reauth gate ──────────────────────────────────────────────── -->
  <div v-if="!isElevated" class="flex items-center justify-center py-20">
    <div class="bg-white rounded-xl border border-slate-200 p-6 w-full max-w-sm">
      <div class="flex items-center gap-2 mb-1">
        <i class="pi pi-shield text-slate-400"></i>
        <div class="text-sm font-bold text-slate-900">Confirm your password to continue</div>
      </div>
      <p class="text-xs text-slate-400 mb-4">AAP remarks are written onto student records and go out on report cards — re-enter your password to proceed.</p>

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
        <div>
          <label class="form-label">Subjects</label>
          <MultiSelect
            v-model="selectedSubjects" :options="subjectOptions" optionLabel="label" optionValue="value"
            placeholder="All subjects" class="w-72" :loading="scanning"
            :disabled="!classId || running" filter display="chip" :maxSelectedLabels="2"
          >
            <template #option="{ option }">
              <div class="flex items-center gap-2">
                <span>{{ option.label }}</span>
                <i v-if="!option.matched" class="pi pi-exclamation-triangle text-amber-500" style="font-size:10px"
                   v-tooltip="'No rubric row matches this subject yet'"></i>
              </div>
            </template>
          </MultiSelect>
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
        <Button label="Scan subjects" icon="pi pi-search" size="small" text
                :loading="scanning" :disabled="running" @click="runScan" />
        <Button label="Export CSV" icon="pi pi-download" size="small" outlined
                :disabled="!hasRemarks" @click="exportCsv" />
        <Button label="Export XLSX" icon="pi pi-file-excel" size="small" outlined
                :disabled="!hasRemarks" @click="exportXlsx" />
        <span class="text-xs text-slate-400">
          Exports one row per student-subject, exactly as listed below.
        </span>
      </div>

      <!-- Generation skips anything already approved, which is the difference
           between "run it again" and "lose an afternoon of review". Said here
           rather than in a tooltip because it is the answer to the question
           this button always raises. -->
      <p class="text-xs text-slate-400 mt-3">
        Generates a comment per student per subject from their AAP survey ratings.
        Remarks already marked approved are left alone — use the regenerate icon on a
        student to force those to be written again.
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
          <!-- totalStudents/processedStudents count student x SUBJECT records,
               not students — the function increments once per remark doc. The
               label says records so the number isn't read as a roster count. -->
          <div v-if="job?.totalStudents" class="text-xs text-slate-500">
            {{ job.processedStudents || 0 }} of {{ job.totalStudents }} remarks
          </div>
        </div>
        <ProgressBar
          v-if="job?.totalStudents"
          :value="progressPct"
          style="height:8px"
        />
        <ProgressBar v-else mode="indeterminate" style="height:8px" />
        <p class="text-xs text-slate-400 mt-2">
          {{ job ? 'Keep this tab open — progress updates as each remark is written.'
                 : 'Reading survey responses for this class…' }}
        </p>
      </div>

      <div v-if="runError" class="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2" :class="running ? 'mt-3' : ''">
        {{ runError }}
      </div>
    </div>

    <!-- ── Subjects with no rubric row ───────────────────────────────────── -->
    <!-- Shown from the scan AND from a run's result: a subject nothing matches
         produces no comment and no error, which is precisely the failure that
         is invisible unless the page says so out loud. -->
    <div v-if="unmatchedSubjects.length && !running"
         class="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 mb-4 flex items-center gap-3 flex-wrap">
      <i class="pi pi-exclamation-triangle text-amber-500"></i>
      <div class="text-sm text-amber-900 min-w-0">
        <strong>{{ unmatchedSubjects.length }}</strong>
        subject{{ unmatchedSubjects.length === 1 ? '' : 's' }} in this class
        match{{ unmatchedSubjects.length === 1 ? 'es' : '' }} no
        {{ scanStage || 'rubric' }} row, so no comment can be written for
        {{ unmatchedSubjects.length === 1 ? 'it' : 'them' }}:
        <span class="font-semibold">{{ unmatchedSubjects.map(s => s.subject).join(', ') }}</span>
      </div>
      <Button label="Relate subjects" icon="pi pi-link" size="small" class="ml-auto"
              :disabled="!scanStage" @click="mapDialogVisible = true" />
    </div>

    <AapSubjectMapDialog
      v-model:visible="mapDialogVisible"
      :school-id="schoolId"
      :stage="scanStage"
      :unmatched="unmatchedSubjects"
      :framework-subjects="frameworkSubjects"
      @saved="onMappingsSaved"
    />

    <!-- ── Review table ──────────────────────────────────────────────────── -->
    <div v-if="!classId" class="text-center py-20 bg-white rounded-xl border border-slate-200">
      <i class="pi pi-comments text-4xl text-slate-300 mb-3 block"></i>
      <p class="text-slate-500 font-medium">Pick a school and class to review its AAP remarks</p>
    </div>

    <div v-else-if="loadingRoster" class="flex items-center justify-center py-20">
      <ProgressSpinner style="width:32px;height:32px" />
    </div>

    <AapRemarksTable
      v-else
      :school-id="schoolId"
      :students="students"
      :remarks-by-student="remarksByStudent"
      :busy-student-id="regeneratingStudentId"
      @regenerate="regenerateStudent"
      @saved="onSaved"
    />
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useToast } from 'primevue/usetoast'
import { useConfirm } from 'primevue/useconfirm'
import Select from 'primevue/select'
import MultiSelect from 'primevue/multiselect'
import Password from 'primevue/password'
import Button from 'primevue/button'
import ProgressBar from 'primevue/progressbar'
import ProgressSpinner from 'primevue/progressspinner'
import ConfirmDialog from 'primevue/confirmdialog'

import { useStepUpAuth } from '../composables/useStepUpAuth.js'
import { useAapRemarks } from '../composables/useAapRemarks.js'
import { downloadAapCsv, downloadAapXlsx } from '../utils/aapExport.js'
import AapRemarksTable from '../components/aap-remarks/AapRemarksTable.vue'
import AapSubjectMapDialog from '../components/aap-remarks/AapSubjectMapDialog.vue'

/**
 * AAP remarks — Awareness / Sensitivity / Creativity report-card comments.
 *
 * Generate for a class, then review: edit a comment, approve it, or regenerate
 * one student. Generation is the Cloud Function (functions/generate_aap_remarks,
 * asia-south1); everything else is a direct write to the remark doc.
 *
 * Gated exactly like School Setup — ops admins only (router meta), plus a
 * password re-entry, because this writes text that leaves the building on a
 * child's report card.
 */
const toast = useToast()
const confirm = useConfirm()
const { isElevated, markActivity, reauthenticate } = useStepUpAuth()

const {
  schools, classes, students, remarksByStudent, scan, scanning,
  loadingSchools, loadingClasses, loadingRoster,
  loadSchools, loadClasses, loadClass, reloadStudent,
  recentJobIds, watchNewJob, generate, scanSubjects,
} = useAapRemarks()

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
  // Clearing the class first also clears the table, via the watcher below —
  // a roster from the previous school must never be on screen under a new
  // school's name, however briefly.
  classId.value = null
  if (!id) return
  try {
    await loadClasses(id)
  } catch (e) {
    console.error('Could not load classes', e)
    toast.add({ severity: 'error', summary: 'Could not load classes', detail: e.message, life: 4000 })
  }
})

// ── Subjects ──────────────────────────────────────────────────────────────
const selectedSubjects = ref([])
const mapDialogVisible = ref(false)
// A run reports the same subject fields a scan does, so whichever happened
// last is the current truth about this class's subjects.
const lastRunSummary = ref(null)

// Changing class resets everything derived from the old one. Kept here rather
// than inside reload() so the Refresh button — which is also reload() — re-reads
// Firestore without silently throwing away the subject scope you just chose.
watch(classId, () => {
  selectedSubjects.value = []
  lastRunSummary.value = null
  scan.value = null
  reload()
})

async function reload() {
  try {
    await loadClass(schoolId.value, classId.value)
  } catch (e) {
    console.error('Could not load the class roster', e)
    toast.add({ severity: 'error', summary: 'Could not load this class', detail: e.message, life: 5000 })
    return
  }
  // A class with nothing generated yet is the one case where the subject list
  // can't be inferred from existing remarks, and it is also the case where
  // someone is about to press Generate — so the scan is worth its reads here
  // and offered as a button the rest of the time.
  if (classId.value && !hasRemarks.value) await runScan()
}

const subjectSource = computed(() => lastRunSummary.value || scan.value)
const scanStage = computed(() => subjectSource.value?.stage || '')
const frameworkSubjects = computed(() => subjectSource.value?.frameworkSubjects || [])
const unmatchedSubjects = computed(() => subjectSource.value?.unmatchedSubjects || [])

const hasRemarks = computed(() =>
  Object.values(remarksByStudent.value).some(rows => rows.length))

/**
 * Options for the subject picker: what the scan found, falling back to the
 * subjects already written when no scan has run. Unmatched subjects are
 * listed rather than hidden — being able to see that "Robotics" exists and
 * resolves to nothing is the point.
 */
const subjectOptions = computed(() => {
  const scanned = subjectSource.value?.subjects || []
  if (scanned.length) {
    return scanned.map(s => ({ label: s.subject, value: s.subject, matched: !!s.matched }))
  }
  const written = new Set()
  for (const rows of Object.values(remarksByStudent.value)) {
    for (const row of rows) written.add(row.id)
  }
  return [...written].sort().map(subject => ({ label: subject, value: subject, matched: true }))
})

async function runScan() {
  try {
    lastRunSummary.value = null
    await scanSubjects(schoolId.value, classId.value)
  } catch (e) {
    console.error('Could not scan subjects', e)
    toast.add({ severity: 'error', summary: 'Could not read this class\'s subjects', detail: e.message, life: 4000 })
  }
}

/** A new mapping only changes anything on the next run, so say so and offer
 *  it rather than silently spending a run's worth of model calls. */
async function onMappingsSaved(mappedTokens) {
  await runScan()
  selectedSubjects.value = mappedTokens
  confirm.require({
    header: 'Generate for the newly related subjects?',
    message: `${mappedTokens.join(', ')} can be written now. Generate remarks for `
      + `${mappedTokens.length === 1 ? 'it' : 'them'} in ${classId.value}?`,
    icon: 'pi pi-sparkles',
    rejectLabel: 'Not now',
    acceptLabel: 'Generate',
    accept: runGenerate,
  })
}

// ── Export ────────────────────────────────────────────────────────────────
function exportCsv() {
  const count = downloadAapCsv(schoolId.value, classId.value, students.value, remarksByStudent.value)
  toast.add({ severity: 'success', summary: `Exported ${count} rows`, life: 2500 })
}

function exportXlsx() {
  const count = downloadAapXlsx(schoolId.value, classId.value, students.value, remarksByStudent.value)
  toast.add({ severity: 'success', summary: `Exported ${count} rows`, life: 2500 })
}

// ── Generation run ────────────────────────────────────────────────────────
const running = ref(false)
const runError = ref('')
const job = ref(null)
const regeneratingStudentId = ref(null)
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

const scopeLabel = computed(() =>
  selectedSubjects.value.length ? selectedSubjects.value.join(', ') : 'every subject')

function confirmGenerate() {
  if (!hasRemarks.value) { runGenerate(); return }
  confirm.require({
    header: 'Generate remarks',
    message: `${classId.value} already has remarks. Running again for ${scopeLabel.value} `
      + `rewrites every comment in that scope that isn't approved yet. Continue?`,
    icon: 'pi pi-exclamation-triangle',
    rejectLabel: 'Cancel',
    acceptLabel: 'Generate',
    accept: runGenerate,
  })
}

async function runGenerate() {
  running.value = true
  runError.value = ''
  job.value = null
  try {
    // Started BEFORE the call: the callable only returns its jobId when the
    // whole run is finished, so the progress doc has to be found rather than
    // addressed. See watchNewJob for how a run is identified.
    const known = await recentJobIds(schoolId.value)
    unsubJob = watchNewJob(schoolId.value, classId.value, known, (j) => { job.value = j })

    const result = await generate({
      schoolId: schoolId.value,
      classId: classId.value,
      subjects: selectedSubjects.value,
    })
    lastRunSummary.value = result
    // Report what was WRITTEN, and account for the rest. The earlier version
    // announced "126 remarks processed" for a run that wrote nothing, because
    // a skipped record and a written one counted the same.
    const skipped = []
    if (result.skippedApproved) skipped.push(`${result.skippedApproved} already approved`)
    if (result.skippedNoFramework) skipped.push(`${result.skippedNoFramework} with no rubric row`)
    toast.add({
      severity: result.written ? 'success' : 'warn',
      summary: result.written
        ? `${result.written} remark${result.written === 1 ? '' : 's'} written`
        : 'No remarks written',
      detail: skipped.length ? `Skipped: ${skipped.join(', ')}` : undefined,
      life: 6000,
    })
    await loadClass(schoolId.value, classId.value)
  } catch (e) {
    console.error('AAP generation failed', e)
    runError.value = e.message || 'Generation failed'
    // Whatever was written before the failure is real and worth showing.
    // loadClass, not reload(): reload resets the subject scope and rescans,
    // which would throw away the scope the failed run was using.
    await loadClass(schoolId.value, classId.value)
  } finally {
    stopWatching()
    running.value = false
    job.value = null
  }
}

/**
 * One student — every subject, or just the selected ones. This is the only
 * path that overwrites remarks already marked approved: the function treats an
 * explicit student_ids list as "the dashboard asked for this one on purpose".
 */
async function regenerateStudent(studentId) {
  regeneratingStudentId.value = studentId
  runError.value = ''
  try {
    const result = await generate({
      schoolId: schoolId.value,
      classId: classId.value,
      studentIds: [studentId],
      subjects: selectedSubjects.value,
    })
    await reloadStudent(schoolId.value, studentId)
    toast.add({
      severity: result.written ? 'success' : 'warn',
      summary: result.written ? `${result.written} rewritten` : 'Nothing to write for this student',
      life: 3000,
    })
  } catch (e) {
    console.error('AAP regeneration failed', e)
    runError.value = e.message || 'Regeneration failed'
  } finally {
    regeneratingStudentId.value = null
  }
}

// A bulk action passes null: it touched many students, so the whole class is
// re-read rather than guessing which rows moved.
const onSaved = (studentId) => studentId
  ? reloadStudent(schoolId.value, studentId)
  : loadClass(schoolId.value, classId.value)

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
