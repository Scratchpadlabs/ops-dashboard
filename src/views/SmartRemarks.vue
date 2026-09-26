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
          :loading="running && runItems.length === 1" :disabled="!schoolId || !classId || running"
          @click="confirmGenerate"
        />
        <Button
          label="Generate for multiple classes" icon="pi pi-th-large" outlined
          :loading="running && runItems.length > 1" :disabled="!schoolId || !classes.length || running"
          @click="openMulti"
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
        Generates one general-conduct comment per student and remark category from the ticked boxes on
        the class's Smart Sheets remarks. Remarks already marked approved are left alone. Use
        <b>Generate for multiple classes</b> to queue several classes in one go — they run one after another.
      </p>
    </div>

    <!-- ── Live run progress ─────────────────────────────────────────────── -->
    <SmartRemarksRunPanel
      v-if="runItems.length"
      :items="runItems" :running="running" :cancelling="cancelling" :now="now"
      @cancel="cancelling = true"
      @dismiss="runItems = []"
      @view="id => { if (!running) classId = id }"
    />

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

    <!-- ── Multi-class generation ────────────────────────────────────────── -->
    <Dialog v-model:visible="multiVisible" header="Generate for multiple classes" modal :style="{ width: '720px' }" :closable="!checking">
      <div class="space-y-4 pt-1">
        <div class="flex items-end gap-2">
          <div class="flex-1">
            <label class="form-label">Classes</label>
            <MultiSelect
              v-model="multiClassIds" :options="classes" optionLabel="label" optionValue="id"
              filter display="chip" :maxSelectedLabels="6" class="w-full" placeholder="Pick classes"
              :disabled="checking"
            />
          </div>
          <Button label="Check classes" icon="pi pi-search" outlined :loading="checking" :disabled="!multiClassIds.length" @click="checkClasses" />
        </div>

        <div v-if="preflight.length" class="border border-slate-200 rounded-lg overflow-hidden">
          <table class="w-full text-sm">
            <thead class="bg-slate-50 text-xs text-slate-500">
              <tr>
                <th class="px-3 py-2 w-8"><input type="checkbox" :checked="allIncluded" @change="e => preflight.forEach(r => { if (r.scan) r.include = e.target.checked })" /></th>
                <th class="px-3 py-2 text-left">Class</th>
                <th class="px-3 py-2 text-right">Students</th>
                <th class="px-3 py-2 text-right">With ticks</th>
                <th class="px-3 py-2 text-left">Notes</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in preflight" :key="r.classId" class="border-t border-slate-100" :class="r.include ? '' : 'text-slate-400'">
                <td class="px-3 py-1.5"><input type="checkbox" v-model="r.include" :disabled="!r.scan" /></td>
                <td class="px-3 py-1.5 font-medium">{{ r.label }}</td>
                <td class="px-3 py-1.5 text-right tabular-nums">
                  <i v-if="r.checking" class="pi pi-spin pi-spinner text-xs text-slate-400"></i>
                  <template v-else>{{ r.scan?.students ?? '—' }}</template>
                </td>
                <td class="px-3 py-1.5 text-right tabular-nums">{{ r.scan?.tickedStudents ?? '—' }}</td>
                <td class="px-3 py-1.5 text-xs">
                  <span v-if="r.error" class="text-red-600">{{ r.error }}</span>
                  <span v-else-if="r.reason" class="text-amber-600">{{ r.reason }}</span>
                  <span v-if="r.scan?.genderIssue" class="text-amber-600">Gender data incomplete</span>
                  <span v-if="r.scan?.multipleSheetsFound" class="text-slate-400"> · several sheets merged</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <label v-if="genderIssueCount" class="flex items-start gap-2 text-sm text-amber-800 bg-amber-50 rounded-lg px-3 py-2">
          <input type="checkbox" v-model="proceedGender" class="mt-1" />
          <span>
            Proceed for the {{ genderIssueCount }} class(es) whose gender data is missing or suspiciously uniform —
            a blank gender is written about as “She”. Unticked, those classes are skipped.
          </span>
        </label>

        <p class="text-xs text-slate-400">
          Classes run one after another (each within the function's 9-minute limit). Comments that aren't
          approved yet are rewritten; approved ones are kept. Keep this tab open until the run finishes.
        </p>
      </div>
      <template #footer>
        <Button label="Cancel" text :disabled="checking" @click="multiVisible = false" />
        <Button :label="`Generate ${startCount} class${startCount === 1 ? '' : 'es'}`" icon="pi pi-sparkles"
                :disabled="checking || !startCount" @click="startMulti" />
      </template>
    </Dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted, onUnmounted } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { useToast } from 'primevue/usetoast'
import { useConfirm } from 'primevue/useconfirm'
import Select from 'primevue/select'
import Password from 'primevue/password'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import MultiSelect from 'primevue/multiselect'
import ProgressSpinner from 'primevue/progressspinner'
import ConfirmDialog from 'primevue/confirmdialog'

import { useStepUpAuth } from '../composables/useStepUpAuth.js'
import { useSmartRemarks } from '../composables/useSmartRemarks.js'
import SmartRemarksTable from '../components/smart-remarks/SmartRemarksTable.vue'
import SmartRemarksRunPanel from '../components/smart-remarks/SmartRemarksRunPanel.vue'
import { RUN_STATUS, preflightVerdict, mapLimit } from '../utils/smartRemarksProgress.js'
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
  generate, scan: scanClass, recentJobIds, newJobId, watchJob,
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
// A run is a queue of classes, generated one at a time (each call is one
// class and must finish inside the function's 540s limit). A single-class
// Generate is just a queue of one. Each class gets a job id minted here, so
// its progress doc can be watched while the call is still in flight.
const runItems = ref([])
const running = ref(false)
const cancelling = ref(false)
const now = ref(Date.now())
let ticker = null

const hasRemarks = computed(() =>
  Object.values(remarksByStudent.value).some(r => r && r.length))

function makeItem(id, { confirmGender = false, status = RUN_STATUS.QUEUED, error = '' } = {}) {
  const label = classes.value.find(c => c.id === id)?.label || id
  return reactive({ classId: id, label, status, error, confirmGender, job: null, result: null, startedAtMs: null, finishedAtMs: null })
}

async function runOne(item) {
  const sid = schoolId.value
  item.status = RUN_STATUS.RUNNING
  item.startedAtMs = Date.now()
  let unsub = null
  try {
    const known = await recentJobIds(sid)
    const jobId = newJobId(sid)
    unsub = watchJob(sid, item.classId, jobId, known, (j) => {
      item.job = j
      // A long run is activity: don't let the 30-minute step-up window lapse mid-queue.
      markActivity()
    })
    item.result = await generate({ schoolId: sid, classId: item.classId, confirmGenderIssue: item.confirmGender, jobId })
    item.status = RUN_STATUS.DONE
  } catch (e) {
    console.error(`Smart remarks generation failed for ${item.classId}`, e)
    item.status = RUN_STATUS.FAILED
    item.error = e.message || 'Generation failed'
    item.genderIssue = !!e.message?.includes('Gender data looks incomplete')
  } finally {
    if (unsub) unsub()
    item.finishedAtMs = Date.now()
  }
  if (item.classId === classId.value && sid === schoolId.value) await reload()
}

async function runQueue(items) {
  runItems.value = items
  running.value = true
  cancelling.value = false
  now.value = Date.now()
  ticker = setInterval(() => { now.value = Date.now() }, 1000)
  try {
    for (const item of runItems.value) {
      if (item.status !== RUN_STATUS.QUEUED) continue
      if (cancelling.value) { item.status = RUN_STATUS.CANCELLED; continue }
      await runOne(item)
    }
  } finally {
    clearInterval(ticker)
    ticker = null
    running.value = false
    cancelling.value = false
    now.value = Date.now()
  }
}

function confirmGenerate() {
  if (!hasRemarks.value) { runSingle(); return }
  confirm.require({
    header: 'Generate remarks',
    message: `${classLabel(classId.value)} already has remarks. Running again rewrites every comment that isn't approved yet. Continue?`,
    icon: 'pi pi-exclamation-triangle',
    rejectLabel: 'Cancel', acceptLabel: 'Generate',
    accept: () => runSingle(),
  })
}

async function runSingle(confirmGenderIssue = false) {
  const item = makeItem(classId.value, { confirmGender: confirmGenderIssue })
  await runQueue([item])
  if (item.status === RUN_STATUS.DONE) {
    const result = item.result || {}
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
  } else if (item.genderIssue && !confirmGenderIssue) {
    confirm.require({
      header: 'Gender data looks incomplete or unusual',
      message: 'This class\'s gender data is missing for some students, or suspiciously uniform. '
        + 'A blank gender is written about as "She" by default — proceed anyway?',
      icon: 'pi pi-exclamation-triangle',
      rejectLabel: 'Cancel', acceptLabel: 'Proceed anyway',
      accept: () => runSingle(true),
      reject: () => { runItems.value = [] },
    })
  }
}

const classLabel = id => classes.value.find(c => c.id === id)?.label || id

// ── Multi-class dialog ────────────────────────────────────────────────────
const multiVisible = ref(false)
const multiClassIds = ref([])
const preflight = ref([])
const checking = ref(false)
const proceedGender = ref(false)

const allIncluded = computed(() => preflight.value.length > 0 && preflight.value.every(r => r.include || !r.scan))
const genderIssueCount = computed(() => preflight.value.filter(r => r.include && r.scan?.genderIssue).length)
const startCount = computed(() => preflight.value.filter(r => r.include && (!r.scan?.genderIssue || proceedGender.value)).length)

function openMulti() {
  multiClassIds.value = classId.value ? [classId.value] : []
  preflight.value = []
  proceedGender.value = false
  multiVisible.value = true
}

// Scan every picked class first (read-only, no model calls) so classes with
// nothing to generate are left out and the gender question is asked once.
async function checkClasses() {
  const sid = schoolId.value
  checking.value = true
  preflight.value = multiClassIds.value.map(id => reactive({
    classId: id, label: classLabel(id), scan: null, include: false, reason: '', error: '', checking: true,
  }))
  try {
    await mapLimit(preflight.value, 3, async (row) => {
      try {
        row.scan = await scanClass({ schoolId: sid, classId: row.classId })
        const v = preflightVerdict(row.scan)
        row.include = v.include
        row.reason = v.reason
      } catch (e) {
        row.error = e.message || 'Could not check this class'
      } finally {
        row.checking = false
      }
    })
  } finally {
    checking.value = false
  }
}

function startMulti() {
  const items = preflight.value.map((r) => {
    if (!r.include) return makeItem(r.classId, { status: RUN_STATUS.SKIPPED, error: r.error || r.reason || 'Left out' })
    if (r.scan?.genderIssue && !proceedGender.value) {
      return makeItem(r.classId, { status: RUN_STATUS.SKIPPED, error: 'Gender data incomplete — not confirmed' })
    }
    return makeItem(r.classId, { confirmGender: !!r.scan?.genderIssue })
  })
  // Queued first, skipped listed after, so the panel reads top-down.
  items.sort((a, b) => (a.status === RUN_STATUS.SKIPPED) - (b.status === RUN_STATUS.SKIPPED))
  multiVisible.value = false
  runQueue(items).then(() => {
    const done = items.filter(i => i.status === RUN_STATUS.DONE)
    const failed = items.filter(i => i.status === RUN_STATUS.FAILED).length
    const written = done.reduce((sum, i) => sum + (i.result?.written || 0), 0)
    toast.add({
      severity: failed ? 'warn' : 'success',
      summary: `${done.length} class${done.length === 1 ? '' : 'es'} done, ${written} remark${written === 1 ? '' : 's'} written`,
      detail: failed ? `${failed} class(es) failed — see the run panel` : undefined,
      life: 8000,
    })
  })
}

// Leaving mid-run would orphan the queue (the current class still finishes
// server-side, the rest never start).
function beforeUnload(e) {
  if (!running.value) return
  e.preventDefault()
  e.returnValue = ''
}
onBeforeRouteLeave(() => {
  if (!running.value) return true
  return window.confirm('Remarks are still being generated. Leave anyway? The class in progress finishes, the rest are not started.')
})

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
  window.addEventListener('beforeunload', beforeUnload)
  try {
    await loadSchools()
  } catch (e) {
    console.error('Could not load schools', e)
    toast.add({ severity: 'error', summary: 'Could not load schools', detail: e.message, life: 4000 })
  }
})
onUnmounted(() => {
  window.removeEventListener('beforeunload', beforeUnload)
  if (ticker) clearInterval(ticker)
  cancelling.value = true
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
