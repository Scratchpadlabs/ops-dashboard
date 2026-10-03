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

    <Tabs value="remarks">
      <TabList>
        <Tab value="remarks"><i class="pi pi-comments text-xs mr-1.5"></i>Remarks</Tab>
        <Tab value="completion"><i class="pi pi-list-check text-xs mr-1.5"></i>Survey Completion</Tab>
      </TabList>
      <TabPanels>
        <TabPanel value="remarks">

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
          <label class="form-label">Classes</label>
          <!-- Several classes at once: a run goes class by class (one
               generate_aap_remarks call each, the function's own unit), and
               the review table below shows every selected class together. -->
          <MultiSelect
            v-model="classIds" :options="classes" optionLabel="label" optionValue="id"
            placeholder="Select classes" class="w-64" :loading="loadingClasses"
            :disabled="!schoolId || running" filter :maxSelectedLabels="3"
            :selectedItemsLabel="`${classIds.length} classes`"
          />
        </div>
        <div>
          <label class="form-label">Subjects</label>
          <MultiSelect
            v-model="selectedSubjects" :options="subjectOptions" optionLabel="label" optionValue="value"
            placeholder="All subjects" class="w-64" :loading="scanning"
            :disabled="!hasClasses || running" filter display="chip" :maxSelectedLabels="2"
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
        <div>
          <label class="form-label">Topics</label>
          <!-- Grouped by subject, values keyed by NAME so "Term 1" means the
               same topic in every selected section. Two or more topics of one
               subject are combined into one rubric per trait server-side
               (topic_combine.py). -->
          <MultiSelect
            v-model="selectedTopics" :options="topicOptions"
            optionLabel="label" optionValue="value"
            optionGroupLabel="label" optionGroupChildren="items"
            :placeholder="topicOptions.length ? 'All topics' : (scanning ? 'Reading topics…' : 'No topics found')"
            class="w-64" :loading="scanning"
            :disabled="!hasClasses || running || !topicOptions.length" filter :maxSelectedLabels="2"
            :selectedItemsLabel="`${selectedTopics.length} topics`"
          >
            <template #optiongroup="{ option }">
              <span class="text-xs font-semibold text-slate-500 uppercase tracking-wide">{{ option.label }}</span>
            </template>
            <template #option="{ option }">
              <div class="flex items-center gap-2 w-full">
                <span>{{ option.label }}</span>
                <span class="text-[11px] text-slate-400 ml-auto">{{ option.students }} rated</span>
              </div>
            </template>
          </MultiSelect>
        </div>
        <Button
          label="Generate remarks" icon="pi pi-sparkles"
          :loading="running" :disabled="!schoolId || !hasClasses || selectionPending"
          @click="confirmGenerate"
        />
        <Button
          label="Refresh" icon="pi pi-refresh" outlined
          :disabled="!hasClasses || running || loadingRoster" :loading="loadingRoster"
          @click="reload"
        />
        <div v-if="hasClasses && !loadingRoster && !selectionPending" class="text-xs ml-auto pb-2 text-right">
          <div class="text-slate-400">
            {{ students.length }} student{{ students.length === 1 ? '' : 's' }}
            in {{ classIds.length === 1 ? 'this class' : `${classIds.length} classes` }}
          </div>
          <div :class="ratedStudentCount < students.length ? 'text-amber-600 font-medium' : 'text-slate-400'">
            {{ ratedStudentCount }} of {{ students.length }} have ratings{{ scopeSubjects ? ' for the selected subject(s)' : '' }}
          </div>
        </div>
      </div>

      <!-- What the topic pick will actually do, said before the run rather
           than discovered in the table afterwards. -->
      <div v-if="selectedTopicPairs.length" class="mt-3 text-xs rounded-lg bg-indigo-50 text-indigo-900 px-3 py-2">
        <div v-for="group in topicPlan" :key="group.subject" class="flex items-center gap-1.5 flex-wrap">
          <span class="font-semibold">{{ group.subject }}:</span>
          <span>{{ group.topics.join(' + ') }}</span>
          <span v-if="group.topics.length > 1" class="px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700 font-semibold">
            combined rubric
          </span>
        </div>
        <div class="text-indigo-700/70 mt-1">
          Only these subjects are generated. Where a subject has several topics, each trait's level is the
          average of its per-topic levels (rounded half up), and the comment describes any growth or dip
          across the topics.
        </div>
      </div>

      <div v-if="hasClasses" class="flex items-center gap-2 flex-wrap mt-3">
        <Button label="Scan subjects" icon="pi pi-search" size="small" text
                :loading="scanning" :disabled="running" @click="runScan" />
        <Button label="Export CSV" icon="pi pi-download" size="small" outlined
                :disabled="!hasRemarks" @click="exportCsv" />
        <Button label="Export Excel" icon="pi pi-file-excel" size="small" outlined
                :loading="exportingXlsx" :disabled="!hasRemarks" @click="exportXlsx" />
        <Button label="Download classes (Excel / PDF)…" icon="pi pi-download" size="small"
                @click="openDownload" />
        <span class="text-xs text-slate-400">
          CSV/Excel export what is listed below; the download dialog takes any classes.
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
            <span v-if="runQueue.length > 1" class="text-xs font-normal text-slate-500 ml-1">
              (class {{ runIndex + 1 }} of {{ runQueue.length }})
            </span>
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

      <div v-if="runError" class="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2 whitespace-pre-line" :class="running ? 'mt-3' : ''">
        {{ runError }}
      </div>
    </div>

    <!-- ── Subjects with no rubric row ───────────────────────────────────── -->
    <!-- Shown from the scan AND from a run's result: a subject nothing matches
         produces no comment and no error, which is precisely the failure that
         is invisible unless the page says so out loud. -->
    <!-- One banner per Stage: classes of different Stages (a multi-class pick
         across grades) have different rubric rows, and a mapping is saved
         per Stage. -->
    <template v-if="!running">
      <div v-for="group in unmatchedByStage" :key="group.stage || 'none'"
           class="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 mb-4 flex items-center gap-3 flex-wrap">
        <i class="pi pi-exclamation-triangle text-amber-500"></i>
        <div class="text-sm text-amber-900 min-w-0">
          <strong>{{ group.subjects.length }}</strong>
          subject{{ group.subjects.length === 1 ? '' : 's' }} in
          {{ group.classIds.length === 1 ? group.classIds[0] : `${group.classIds.length} classes` }}
          match{{ group.subjects.length === 1 ? 'es' : '' }} no
          {{ group.stage || 'rubric' }} row, so no comment can be written for
          {{ group.subjects.length === 1 ? 'it' : 'them' }}:
          <span class="font-semibold">{{ group.subjects.map(s => s.subject).join(', ') }}</span>
        </div>
        <Button label="Relate subjects" icon="pi pi-link" size="small" class="ml-auto"
                :disabled="!group.stage" @click="openMapDialog(group.stage)" />
      </div>
    </template>

    <!-- ── File ready ────────────────────────────────────────────────────── -->
    <!-- A file that took longer to build than the browser's download window
         after the click lands here instead of being blocked; this button's
         own click is what lets the browser save it. -->
    <Dialog :visible="!!pendingFile" header="Your file is ready" modal :style="{ width: '460px' }"
            @update:visible="v => { if (!v) discardPending() }">
      <div v-if="pendingFile" class="flex items-center gap-3">
        <i :class="pendingFile.name.endsWith('.xlsx') ? 'pi pi-file-excel text-green-600'
          : pendingFile.name.endsWith('.zip') ? 'pi pi-folder text-amber-500' : 'pi pi-file-pdf text-red-500'"
           style="font-size:1.75rem"></i>
        <div class="min-w-0">
          <div class="text-sm font-semibold text-slate-900 break-all">{{ pendingFile.name }}</div>
          <div class="text-xs text-slate-400">{{ fileSize(pendingFile.size) }}</div>
        </div>
      </div>
      <p class="text-xs text-slate-500 mt-3">
        It took a moment to prepare, so your browser needs one more click to save it.
      </p>
      <template #footer>
        <Button label="Cancel" text @click="discardPending" />
        <Button label="Save file" icon="pi pi-download" autofocus @click="savePending" />
      </template>
    </Dialog>

    <!-- ── Multi-class download ──────────────────────────────────────────── -->
    <!-- Reads its own classes, so a whole grade can be downloaded without
         loading it into the review table first. -->
    <Dialog v-model:visible="downloadVisible" header="Download AAP remarks for classes" modal
            :style="{ width: '560px' }" :closable="!downloading">
      <div class="space-y-4 pt-1">
        <div>
          <label class="form-label">Classes</label>
          <MultiSelect
            v-model="downloadClassIds" :options="classes" optionLabel="label" optionValue="id"
            placeholder="Pick classes" class="w-full" filter display="chip" :maxSelectedLabels="8"
            :disabled="downloading"
          />
          <div class="flex gap-3 mt-1.5 text-xs">
            <button type="button" class="text-blue-600 hover:underline" :disabled="downloading"
                    @click="downloadClassIds = classes.map(c => c.id)">Select all {{ classes.length }}</button>
            <button type="button" class="text-slate-500 hover:underline" :disabled="downloading"
                    @click="downloadClassIds = []">Clear</button>
          </div>
        </div>
        <div>
          <label class="form-label">PDF report</label>
          <div class="flex flex-col gap-1.5">
            <div v-for="opt in PDF_LAYOUTS" :key="opt.value" class="flex items-start gap-2">
              <RadioButton v-model="pdfLayout" :value="opt.value" :inputId="`aapLayout-${opt.value}`" :disabled="downloading" />
              <label :for="`aapLayout-${opt.value}`" class="text-sm text-slate-700 cursor-pointer">
                {{ opt.label }}
                <span class="block text-xs text-slate-400">{{ opt.hint }}</span>
              </label>
            </div>
          </div>
        </div>
        <div>
          <label class="form-label">PDF title</label>
          <div class="flex flex-col gap-1.5">
            <div v-for="opt in titleOptions" :key="opt.value" class="flex items-center gap-2">
              <RadioButton v-model="titleChoice" :value="opt.value" :inputId="`aapTitle-${opt.value}`" :disabled="downloading" />
              <label :for="`aapTitle-${opt.value}`" class="text-sm text-slate-700">{{ opt.label }}</label>
            </div>
            <InputText
              v-if="titleChoice === 'custom'" v-model="customTitle" :maxlength="MAX_PDF_TITLE"
              placeholder="e.g. Summary For Term 1 (2026–27)" class="w-full" size="small" :disabled="downloading"
            />
          </div>
          <p class="text-[11px] text-slate-400 mt-1">
            The heading at the top of every PDF page. Also used by the PDF icon next to each student.
          </p>
        </div>
        <div class="flex items-center gap-2">
          <Checkbox v-model="downloadApprovedOnly" binary inputId="aapDownloadApproved" :disabled="downloading" />
          <label for="aapDownloadApproved" class="text-sm text-slate-700">Approved remarks only</label>
        </div>
        <ul class="text-xs text-slate-500 list-disc pl-4 space-y-1">
          <li><b>Excel</b> — laid out for teachers: a <b>Read me</b> explaining the abilities and levels,
            a <b>Summary</b> by class, one easy-to-read sheet per class (a block per student, remarks in
            full, levels colour-coded, print-ready), and an <b>All remarks</b> list with filters.</li>
          <li><b>PDF</b> — packaged as chosen under <b>PDF report</b>: one consolidated file, one file
            per class, or every student's page separately. Students with no remark get no page.</li>
        </ul>
        <div v-if="downloading" class="text-sm text-slate-600 flex items-center gap-2">
          <i class="pi pi-spin pi-spinner text-sm"></i>{{ downloadStatus }}
        </div>
      </div>
      <template #footer>
        <Button label="Cancel" text :disabled="downloading" @click="downloadVisible = false" />
        <Button label="Download Excel" icon="pi pi-file-excel" outlined
                :loading="downloading && downloadFormat === 'xlsx'"
                :disabled="downloading || !downloadClassIds.length" @click="runDownload('xlsx')" />
        <Button :label="pdfLayout === 'school' ? 'Download PDF' : 'Download PDFs'" icon="pi pi-file-pdf"
                :loading="downloading && downloadFormat === 'pdf'"
                :disabled="downloading || !downloadClassIds.length || (titleChoice === 'custom' && !customTitle.trim())"
                @click="runDownload('pdf')" />
      </template>
    </Dialog>

    <AapSubjectMapDialog
      v-model:visible="mapDialogVisible"
      :school-id="schoolId"
      :stage="mapGroup?.stage || ''"
      :unmatched="mapGroup?.subjects || []"
      :framework-subjects="mapGroup?.frameworkSubjects || []"
      @saved="onMappingsSaved"
    />

    <!-- ── Review table ──────────────────────────────────────────────────── -->
    <div v-if="!hasClasses" class="text-center py-20 bg-white rounded-xl border border-slate-200">
      <i class="pi pi-comments text-4xl text-slate-300 mb-3 block"></i>
      <p class="text-slate-500 font-medium">Pick a school and one or more classes to review their AAP remarks</p>
    </div>

    <div v-else-if="loadingRoster || selectionPending" class="flex items-center justify-center py-20">
      <ProgressSpinner style="width:32px;height:32px" />
    </div>

    <AapRemarksTable
      v-else
      :school-id="schoolId"
      :students="students"
      :remarks-by-student="remarksByStudent"
      :busy-student-id="regeneratingStudentId"
      :show-class="classIds.length > 1"
      @regenerate="regenerateStudent"
      @saved="onSaved"
    />

        </TabPanel>
        <TabPanel value="completion">
          <AapSurveyCompletionTab />
        </TabPanel>
      </TabPanels>
    </Tabs>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useToast } from 'primevue/usetoast'
import { useConfirm } from 'primevue/useconfirm'
import Select from 'primevue/select'
import MultiSelect from 'primevue/multiselect'
import Dialog from 'primevue/dialog'
import Checkbox from 'primevue/checkbox'
import RadioButton from 'primevue/radiobutton'
import InputText from 'primevue/inputtext'
import Password from 'primevue/password'
import Button from 'primevue/button'
import ProgressBar from 'primevue/progressbar'
import ProgressSpinner from 'primevue/progressspinner'
import ConfirmDialog from 'primevue/confirmdialog'
import Tabs from 'primevue/tabs'
import TabList from 'primevue/tablist'
import Tab from 'primevue/tab'
import TabPanels from 'primevue/tabpanels'
import TabPanel from 'primevue/tabpanel'

import { useStepUpAuth } from '../composables/useStepUpAuth.js'
import {
  useAapRemarks, pdfTitle, setPdfTitle, PDF_TITLE_PRESETS, MAX_PDF_TITLE, PDF_LAYOUTS,
} from '../composables/useAapRemarks.js'
import { downloadAapCsv, downloadAapWorkbook, approvedOnly } from '../utils/aapExport.js'
import { pendingFile, savePending, discardPending } from '../utils/deliverFile.js'
import AapRemarksTable from '../components/aap-remarks/AapRemarksTable.vue'
import AapSubjectMapDialog from '../components/aap-remarks/AapSubjectMapDialog.vue'
import AapSurveyCompletionTab from '../components/aap-remarks/AapSurveyCompletionTab.vue'

/**
 * AAP remarks — Awareness / Sensitivity / Creativity report-card comments.
 *
 * Generate for one or more classes — optionally scoped to subjects and to
 * topics, several topics of a subject being combined into one rubric — then
 * review: edit a comment, approve it, or regenerate one student. Generation is the Cloud Function (functions/generate_aap_remarks,
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
  schools, classes, students, remarksByStudent, scans, scanning,
  loadingSchools, loadingClasses, loadingRoster,
  loadSchools, loadClasses, loadClass, reloadStudent,
  recentJobIds, watchNewJob, generate, scanSubjects,
  fetchClassesRemarks, downloadClassPdfs,
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
const classIds = ref([])
const hasClasses = computed(() => classIds.value.length > 0)

const classLabel = (id) => classes.value.find(c => c.id === id)?.label || id
const classesLabel = (ids) => ids.length <= 3 ? ids.map(classLabel).join(', ') : `${ids.length} classes`

watch(schoolId, async (id) => {
  // Clearing the classes first also clears the table, via the watcher below —
  // a roster from the previous school must never be on screen under a new
  // school's name, however briefly.
  classIds.value = []
  if (!id) return
  try {
    await loadClasses(id)
  } catch (e) {
    console.error('Could not load classes', e)
    toast.add({ severity: 'error', summary: 'Could not load classes', detail: e.message, life: 4000 })
  }
})

// ── Subjects & topics ─────────────────────────────────────────────────────
const selectedSubjects = ref([])
const selectedTopics = ref([])     // values: `${subject}::${topicKey}`
const mapDialogVisible = ref(false)
const mapStage = ref('')

// Changing classes resets everything derived from the old ones. Debounced:
// ticking five classes one by one is one roster load and one scan, not five.
// Kept out of reload() so the Refresh button — which is also reload() —
// re-reads Firestore without throwing away the subject/topic scope.
const selectionPending = ref(false)
let selectionTimer = null
watch(classIds, () => {
  selectedSubjects.value = []
  selectedTopics.value = []
  // Called empty rather than just clearing the refs: each bumps its load
  // token, so a roster or scan still in flight for the OLD pick is dropped
  // when it lands instead of being painted under the new one.
  loadClass(null, [])
  scanSubjects(null, [])
  selectionPending.value = true
  clearTimeout(selectionTimer)
  selectionTimer = setTimeout(async () => {
    selectionPending.value = false
    // The scan is what lists each class's topics, so it runs on every class
    // change rather than only when nothing has been generated yet.
    await Promise.all([reload(), runScan()])
  }, 500)
})

async function reload() {
  try {
    await loadClass(schoolId.value, classIds.value)
  } catch (e) {
    console.error('Could not load the class roster', e)
    toast.add({ severity: 'error', summary: 'Could not load these classes', detail: e.message, life: 5000 })
  }
}

const hasRemarks = computed(() =>
  Object.values(remarksByStudent.value).some(rows => rows.length))

/** Same normalisation as the function's _norm_topic, so a key built here
 *  names the same topic the server filters on. */
const topicKey = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '')

/**
 * Every selected class's scan folded into one subject list: a subject counts
 * as matched only if it matched in every class that has it, and its topics are
 * the union, in the order the scans list them (teaching order).
 */
const mergedSubjects = computed(() => {
  const bySubject = new Map()
  for (const scan of Object.values(scans.value)) {
    for (const row of scan?.subjects || []) {
      const entry = bySubject.get(row.subject) || { subject: row.subject, matched: true, students: 0, topics: new Map() }
      entry.matched = entry.matched && !!row.matched
      entry.students += row.students || 0
      for (const t of row.topics || []) {
        const key = topicKey(t.topic)
        const topic = entry.topics.get(key) || { topic: t.topic, students: 0 }
        topic.students += t.students || 0
        entry.topics.set(key, topic)
      }
      bySubject.set(row.subject, entry)
    }
  }
  return [...bySubject.values()].sort((a, b) => a.subject.localeCompare(b.subject))
})

/**
 * Options for the subject picker: what the scans found, falling back to the
 * subjects already written when no scan has run. Unmatched subjects are
 * listed rather than hidden — being able to see that "Robotics" exists and
 * resolves to nothing is the point.
 */
const subjectOptions = computed(() => {
  if (mergedSubjects.value.length) {
    return mergedSubjects.value.map(s => ({ label: s.subject, value: s.subject, matched: s.matched }))
  }
  const written = new Set()
  for (const rows of Object.values(remarksByStudent.value)) {
    for (const row of rows) written.add(row.id)
  }
  return [...written].sort().map(subject => ({ label: subject, value: subject, matched: true }))
})

/** Topics grouped by subject — only the selected subjects' when any are. */
const topicOptions = computed(() => {
  const only = selectedSubjects.value.length ? new Set(selectedSubjects.value) : null
  return mergedSubjects.value
    .filter(s => s.topics.size && (!only || only.has(s.subject)))
    .map(s => ({
      label: s.subject,
      items: [...s.topics.entries()].map(([key, t]) => ({
        label: t.topic, value: `${s.subject}::${key}`,
        subject: s.subject, topic: t.topic, students: t.students,
      })),
    }))
})

// Narrowing the subjects drops topics of subjects no longer picked, so the
// topic chips never scope a run to something the subject picker excludes.
watch(selectedSubjects, (subjects) => {
  if (!subjects.length) return
  const keep = new Set(subjects)
  selectedTopics.value = selectedTopics.value.filter(v => keep.has(v.split('::')[0]))
})

const selectedTopicPairs = computed(() => {
  const byValue = new Map(topicOptions.value.flatMap(g => g.items).map(o => [o.value, o]))
  return selectedTopics.value
    .map(v => byValue.get(v))
    .filter(Boolean)
    .map(o => ({ subject: o.subject, topic: o.topic }))
})

/** { subject, topics[] } per subject the topic pick covers. */
const topicPlan = computed(() => {
  const bySubject = new Map()
  for (const { subject, topic } of selectedTopicPairs.value) {
    if (!bySubject.has(subject)) bySubject.set(subject, [])
    bySubject.get(subject).push(topic)
  }
  return [...bySubject.entries()].map(([subject, topics]) => ({ subject, topics }))
})

/** The subjects a run will touch, or null for every subject. */
const scopeSubjects = computed(() => {
  if (selectedTopicPairs.value.length) return new Set(topicPlan.value.map(g => g.subject))
  return selectedSubjects.value.length ? new Set(selectedSubjects.value) : null
})

// How many students actually have a rating, scoped to the selected subjects
// (or any subject, if none chosen) — the thing a "1 of 41" table full of
// "No AAP survey ratings found" rows makes you scroll to notice otherwise.
const ratedStudentCount = computed(() => {
  const scope = scopeSubjects.value
  return students.value.filter(s => {
    const rows = remarksByStudent.value[s.id] || []
    return rows.some(r => !scope || scope.has(r.id))
  }).length
})

/**
 * Unmatched subjects grouped by Stage — a mapping is saved per Stage, so a
 * pick spanning Middle and Preparatory classes needs one dialog for each.
 */
const unmatchedByStage = computed(() => {
  const groups = new Map()
  for (const [classId, scan] of Object.entries(scans.value)) {
    if (!scan?.unmatchedSubjects?.length) continue
    const stage = scan.stage || ''
    const group = groups.get(stage) || { stage, classIds: [], bySubject: new Map(), frameworkSubjects: scan.frameworkSubjects || [] }
    group.classIds.push(classId)
    for (const row of scan.unmatchedSubjects) {
      const entry = group.bySubject.get(row.subject) || { subject: row.subject, students: 0 }
      entry.students += row.students || 0
      group.bySubject.set(row.subject, entry)
    }
    groups.set(stage, group)
  }
  return [...groups.values()].map(g => ({
    stage: g.stage, classIds: g.classIds, frameworkSubjects: g.frameworkSubjects,
    subjects: [...g.bySubject.values()].sort((a, b) => a.subject.localeCompare(b.subject)),
  }))
})
const mapGroup = computed(() => unmatchedByStage.value.find(g => g.stage === mapStage.value) || null)

function openMapDialog(stage) {
  mapStage.value = stage
  mapDialogVisible.value = true
}

async function runScan() {
  try {
    await scanSubjects(schoolId.value, classIds.value)
  } catch (e) {
    console.error('Could not scan subjects', e)
    toast.add({ severity: 'error', summary: 'Could not read the classes\' subjects', detail: e.message, life: 4000 })
  }
}

/** A new mapping only changes anything on the next run, so say so and offer
 *  it rather than silently spending a run's worth of model calls. */
async function onMappingsSaved(mappedTokens) {
  await runScan()
  selectedTopics.value = []
  selectedSubjects.value = mappedTokens
  confirm.require({
    header: 'Generate for the newly related subjects?',
    message: `${mappedTokens.join(', ')} can be written now. Generate remarks for `
      + `${mappedTokens.length === 1 ? 'it' : 'them'} in ${classesLabel(classIds.value)}?`,
    icon: 'pi pi-sparkles',
    rejectLabel: 'Not now',
    acceptLabel: 'Generate',
    accept: runGenerate,
  })
}

// ── Export ────────────────────────────────────────────────────────────────
const exportClassLabel = computed(() =>
  classIds.value.length <= 3 ? classIds.value.join('+') : `${classIds.value.length}_classes`)

function exportCsv() {
  const count = downloadAapCsv(schoolId.value, exportClassLabel.value, students.value, remarksByStudent.value)
  toast.add({ severity: 'success', summary: `Exported ${count} rows`, life: 2500 })
}

const schoolName = computed(() => schools.value.find(s => s.id === schoolId.value)?.name || schoolId.value)

// The same teacher-facing workbook the download dialog builds, for exactly
// what is on screen.
const exportingXlsx = ref(false)
async function exportXlsx() {
  exportingXlsx.value = true
  try {
    const { count, status } = await downloadAapWorkbook({
      schoolId: schoolId.value, schoolName: schoolName.value,
      classes: classIds.value.map(id => ({ id, label: classLabel(id) })),
      students: students.value, remarksByStudent: remarksByStudent.value,
    })
    if (status === 'downloaded') {
      toast.add({ severity: 'success', summary: `Excel downloaded — ${count} student${count === 1 ? '' : 's'}`, life: 2500 })
    }
  } catch (e) {
    console.error('Could not build the Excel file', e)
    toast.add({ severity: 'error', summary: 'Could not build the Excel file', detail: e.message, life: 5000 })
  } finally {
    exportingXlsx.value = false
  }
}

// ── Multi-class download ──────────────────────────────────────────────────
const fileSize = (bytes) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
const downloadVisible = ref(false)
const downloadClassIds = ref([])
const downloadApprovedOnly = ref(false)
const downloading = ref(false)
const downloadFormat = ref('')
const downloadStatus = ref('')
const pdfLayout = ref('class')

// PDF heading: the two presets, or the admin's own text.
const titleOptions = [
  { value: 'year', label: PDF_TITLE_PRESETS[0] },
  { value: 'term', label: PDF_TITLE_PRESETS[1] },
  { value: 'custom', label: 'Custom…' },
]
const titleChoice = ref('year')
const customTitle = ref('')
function syncTitleFromStore() {
  const i = PDF_TITLE_PRESETS.indexOf(pdfTitle.value)
  titleChoice.value = i === 0 ? 'year' : i === 1 ? 'term' : 'custom'
  customTitle.value = i === -1 ? pdfTitle.value : ''
}
syncTitleFromStore()
watch([titleChoice, customTitle], ([choice, custom]) => {
  if (choice === 'year') setPdfTitle(PDF_TITLE_PRESETS[0])
  else if (choice === 'term') setPdfTitle(PDF_TITLE_PRESETS[1])
  // An empty custom box keeps the last title rather than snapping back.
  else if (custom.trim()) setPdfTitle(custom)
})

function openDownload() {
  // Starts from the classes on screen — the common case is "download what I
  // just generated" — and any others can be added in the dialog.
  downloadClassIds.value = [...classIds.value]
  syncTitleFromStore()
  downloadVisible.value = true
}

async function runDownload(format) {
  const ids = classes.value.map(c => c.id).filter(id => downloadClassIds.value.includes(id))
  downloading.value = true
  downloadFormat.value = format
  downloadStatus.value = `Collecting remarks — 0 of ${ids.length} classes…`
  try {
    const data = await fetchClassesRemarks(schoolId.value, ids, (done, total) => {
      downloadStatus.value = `Collecting remarks — ${done} of ${total} classes…`
    })
    const remarks = downloadApprovedOnly.value ? approvedOnly(data.remarksByStudent) : data.remarksByStudent
    const picked = ids.map(id => ({ id, label: classLabel(id) }))

    if (format === 'xlsx') {
      const { count, status } = await downloadAapWorkbook({
        schoolId: schoolId.value, schoolName: schoolName.value, classes: picked,
        students: data.students, remarksByStudent: remarks, approvedOnly: downloadApprovedOnly.value,
      })
      if (status === 'downloaded') toast.add({ severity: 'success', life: 4000, summary: `Excel downloaded — ${count} student${count === 1 ? '' : 's'} `
        + `in ${picked.length} class${picked.length === 1 ? '' : 'es'}` })
    } else {
      // Only students with something to print: a child with no (approved)
      // remark would be a blank summary page.
      const groups = picked
        .map(c => ({
          classId: c.id, label: c.label,
          studentIds: data.students
            .filter(s => s.classId === c.id && (remarks[s.id] || []).length)
            .map(s => s.id),
        }))
        .filter(g => g.studentIds.length)
      const total = groups.reduce((n, g) => n + g.studentIds.length, 0)
      if (!total) {
        toast.add({ severity: 'warn', summary: 'Nothing to download',
          detail: downloadApprovedOnly.value ? 'No approved remarks in these classes yet.' : 'No remarks in these classes yet.', life: 5000 })
        return
      }
      downloadStatus.value = `Building ${total} PDF page${total === 1 ? '' : 's'} across ${groups.length} class${groups.length === 1 ? '' : 'es'}…`
      const status = await downloadClassPdfs(schoolId.value, groups, {
        approvedOnly: downloadApprovedOnly.value, layout: pdfLayout.value,
      })
      if (status === 'downloaded') toast.add({ severity: 'success', life: 4000, summary: `PDFs downloaded — ${total} student${total === 1 ? '' : 's'} `
        + `in ${groups.length} class${groups.length === 1 ? '' : 'es'}` })
    }
    downloadVisible.value = false
  } catch (e) {
    console.error('AAP download failed', e)
    toast.add({ severity: 'error', summary: 'Could not download', detail: e.message, life: 5000 })
  } finally {
    downloading.value = false
    downloadFormat.value = ''
  }
}

// ── Generation run ────────────────────────────────────────────────────────
const running = ref(false)
const runError = ref('')
const job = ref(null)
const runQueue = ref([])
const runIndex = ref(0)
const regeneratingStudentId = ref(null)
let unsubJob = null

const runningLabel = computed(() => classLabel(runQueue.value[runIndex.value] || ''))
const progressPct = computed(() => {
  const total = job.value?.totalStudents || 0
  if (!total) return 0
  return Math.min(100, Math.round((job.value.processedStudents || 0) / total * 100))
})

function stopWatching() {
  if (unsubJob) { unsubJob(); unsubJob = null }
}

const scopeLabel = computed(() => {
  if (topicPlan.value.length) {
    return topicPlan.value.map(g => `${g.subject} (${g.topics.join(' + ')})`).join(', ')
  }
  return selectedSubjects.value.length ? selectedSubjects.value.join(', ') : 'every subject'
})

function confirmGenerate() {
  const multi = classIds.value.length > 1
  if (!hasRemarks.value && !multi) { runGenerate(); return }
  const parts = []
  if (multi) parts.push(`This runs ${classIds.value.length} classes one after another (${classesLabel(classIds.value)}).`)
  if (hasRemarks.value) {
    parts.push(`Running again for ${scopeLabel.value} rewrites every comment in that scope that isn't approved yet.`)
  } else {
    parts.push(`Scope: ${scopeLabel.value}.`)
  }
  confirm.require({
    header: 'Generate remarks',
    message: `${parts.join(' ')} Continue?`,
    icon: hasRemarks.value ? 'pi pi-exclamation-triangle' : 'pi pi-sparkles',
    rejectLabel: 'Cancel',
    acceptLabel: 'Generate',
    accept: runGenerate,
  })
}

/**
 * Class by class, one callable each — the function's unit of work and its
 * 540s budget are per class, so a multi-class run is a queue of ordinary
 * runs. A class that fails is reported and the queue moves on: one class's
 * gender-data gate should not cost the other classes their remarks.
 */
async function runGenerate() {
  running.value = true
  runError.value = ''
  job.value = null
  runQueue.value = [...classIds.value]
  const totals = { written: 0, skippedApproved: 0, skippedNoFramework: 0 }
  const failures = []
  const results = {}
  try {
    for (let i = 0; i < runQueue.value.length; i++) {
      const classId = runQueue.value[i]
      runIndex.value = i
      job.value = null
      try {
        // Started BEFORE the call: the callable only returns its jobId when
        // the whole run is finished, so the progress doc has to be found
        // rather than addressed. See watchNewJob for how a run is identified.
        const known = await recentJobIds(schoolId.value)
        unsubJob = watchNewJob(schoolId.value, classId, known, (j) => { job.value = j })
        const result = await generate({
          schoolId: schoolId.value,
          classId,
          subjects: selectedSubjects.value,
          topics: selectedTopicPairs.value,
        })
        results[classId] = result
        totals.written += result.written || 0
        totals.skippedApproved += result.skippedApproved || 0
        totals.skippedNoFramework += result.skippedNoFramework || 0
      } catch (e) {
        console.error(`AAP generation failed for ${classId}`, e)
        failures.push(`${classLabel(classId)}: ${e.message || 'generation failed'}`)
      } finally {
        stopWatching()
      }
    }
    // A run reports the same subject fields a scan does, so it is the
    // current truth about those classes' subjects.
    scans.value = { ...scans.value, ...results }
    if (failures.length) runError.value = failures.join('\n')

    // Report what was WRITTEN, and account for the rest. The earlier version
    // announced "126 remarks processed" for a run that wrote nothing, because
    // a skipped record and a written one counted the same.
    const skipped = []
    if (totals.skippedApproved) skipped.push(`${totals.skippedApproved} already approved`)
    if (totals.skippedNoFramework) skipped.push(`${totals.skippedNoFramework} with no rubric row`)
    if (failures.length) skipped.push(`${failures.length} class${failures.length === 1 ? '' : 'es'} failed`)
    toast.add({
      severity: totals.written && !failures.length ? 'success' : 'warn',
      summary: totals.written
        ? `${totals.written} remark${totals.written === 1 ? '' : 's'} written`
        : 'No remarks written',
      detail: skipped.length ? `Skipped: ${skipped.join(', ')}` : undefined,
      life: 6000,
    })
  } finally {
    running.value = false
    job.value = null
    // Whatever was written — including before a failure — is real and worth
    // showing. loadClass, not the class watcher: that resets the subject and
    // topic scope the run was using.
    await reload()
  }
}

/**
 * One student — every subject, or just the selected subjects/topics. This is
 * the only path that overwrites remarks already marked approved: the function
 * treats an explicit student_ids list as "the dashboard asked for this one on
 * purpose".
 */
async function regenerateStudent(studentId) {
  const student = students.value.find(s => s.id === studentId)
  regeneratingStudentId.value = studentId
  runError.value = ''
  try {
    const result = await generate({
      schoolId: schoolId.value,
      classId: student?.classId || classIds.value[0],
      studentIds: [studentId],
      subjects: selectedSubjects.value,
      topics: selectedTopicPairs.value,
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

// A bulk action passes null: it touched many students, so every selected
// class is re-read rather than guessing which rows moved.
const onSaved = (studentId) => studentId
  ? reloadStudent(schoolId.value, studentId)
  : reload()

onMounted(async () => {
  try {
    await loadSchools()
  } catch (e) {
    console.error('Could not load schools', e)
    toast.add({ severity: 'error', summary: 'Could not load schools', detail: e.message, life: 4000 })
  }
})
onUnmounted(() => { stopWatching(); clearTimeout(selectionTimer); discardPending() })
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
