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
import Password from 'primevue/password'
import Button from 'primevue/button'
import ProgressBar from 'primevue/progressbar'
import ProgressSpinner from 'primevue/progressspinner'
import ConfirmDialog from 'primevue/confirmdialog'

import { useStepUpAuth } from '../composables/useStepUpAuth.js'
import { useAapRemarks } from '../composables/useAapRemarks.js'
import AapRemarksTable from '../components/aap-remarks/AapRemarksTable.vue'

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
  schools, classes, students, remarksByStudent,
  loadingSchools, loadingClasses, loadingRoster,
  loadSchools, loadClasses, loadClass, reloadStudent,
  recentJobIds, watchNewJob, generate,
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

watch(classId, () => reload())

async function reload() {
  try {
    await loadClass(schoolId.value, classId.value)
  } catch (e) {
    console.error('Could not load the class roster', e)
    toast.add({ severity: 'error', summary: 'Could not load this class', detail: e.message, life: 5000 })
  }
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

function confirmGenerate() {
  const generated = Object.values(remarksByStudent.value).some(rows => rows.length)
  if (!generated) { runGenerate(); return }
  confirm.require({
    header: 'Generate remarks',
    message: `${classId.value} already has remarks. Running again rewrites every comment that isn't approved yet. Continue?`,
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

    const result = await generate({ schoolId: schoolId.value, classId: classId.value })
    toast.add({
      severity: 'success',
      summary: 'Remarks generated',
      detail: `${result.processed} student-subject remark${result.processed === 1 ? '' : 's'} processed`,
      life: 4000,
    })
    await reload()
  } catch (e) {
    console.error('AAP generation failed', e)
    runError.value = e.message || 'Generation failed'
    // Whatever was written before the failure is real and worth showing.
    await reload()
  } finally {
    stopWatching()
    running.value = false
    job.value = null
  }
}

/**
 * One student, every subject. This is the only path that overwrites remarks
 * already marked approved — the function treats an explicit student_ids list
 * as "the dashboard asked for this one on purpose".
 */
async function regenerateStudent(studentId) {
  regeneratingStudentId.value = studentId
  runError.value = ''
  try {
    await generate({ schoolId: schoolId.value, classId: classId.value, studentIds: [studentId] })
    await reloadStudent(schoolId.value, studentId)
    toast.add({ severity: 'success', summary: 'Regenerated', life: 2500 })
  } catch (e) {
    console.error('AAP regeneration failed', e)
    runError.value = e.message || 'Regeneration failed'
  } finally {
    regeneratingStudentId.value = null
  }
}

const onSaved = (studentId) => reloadStudent(schoolId.value, studentId)

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
