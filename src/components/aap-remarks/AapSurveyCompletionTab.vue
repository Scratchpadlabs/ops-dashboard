<template>
  <div>
    <div class="bg-white rounded-xl border border-slate-200 p-4 mb-4">
      <div class="flex items-end gap-3 flex-wrap">
        <div>
          <label class="form-label">School</label>
          <Select
            v-model="schoolId" :options="schools" optionLabel="name" optionValue="id"
            placeholder="Select a school" class="w-72" :loading="loadingSchools" filter
          />
        </div>
        <Button
          label="Check completion" icon="pi pi-search" :loading="running"
          :disabled="!schoolId" @click="run"
        />
        <Button
          :label="isFiltered ? `Download Excel (${filteredRows.length} rows)` : 'Download Excel'"
          icon="pi pi-file-excel" outlined
          :disabled="!filteredRows.length" @click="downloadXlsx"
        />
        <Button
          icon="pi pi-download" label="CSV" outlined
          :disabled="!filteredRows.length" @click="csvMenu.toggle($event)"
          aria-haspopup="true" aria-controls="aap_csv_menu"
        />
        <Menu ref="csvMenu" id="aap_csv_menu" :model="csvItems" popup />
        <div v-if="rows.length" class="text-xs text-slate-400 ml-auto pb-2">
          {{ rows.length }} class/subject/topic row{{ rows.length === 1 ? '' : 's' }} · scanned whole school
        </div>
      </div>
      <p class="text-xs text-slate-400 mt-3">
        Whole-school scan: each class's own subjects and topics (as set up for that class — what the
        teacher app surveys from), every AAP survey response, and each class's roster. A topic with no
        response yet is "Not started"; one with a response but gaps for some students/questions is
        "Partial". "Not Applicable" counts as answered. Downloads contain the rows currently filtered.
      </p>
    </div>

    <div v-if="runError" class="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-4 py-3 mb-4">
      {{ runError }}
    </div>

    <div v-if="result && (result.unmatchedSubjectTokens?.length || result.unparsedResponses)"
         class="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 mb-4 text-sm text-amber-900">
      <div v-if="result.unmatchedSubjectTokens?.length">
        <i class="pi pi-exclamation-triangle mr-1.5"></i>
        Survey subject token{{ result.unmatchedSubjectTokens.length === 1 ? '' : 's' }} that matched no
        school-setup subject: <span class="font-semibold">{{ result.unmatchedSubjectTokens.join(', ') }}</span>
        — rows for these still show below under the raw token, but they aren't counted against the
        school-setup subject they were probably meant to be.
      </div>
      <div v-if="result.unparsedResponses" :class="result.unmatchedSubjectTokens?.length ? 'mt-1' : ''">
        <i class="pi pi-exclamation-triangle mr-1.5"></i>
        {{ result.unparsedResponses }} response doc{{ result.unparsedResponses === 1 ? '' : 's' }} across the
        school didn't fit the expected naming convention and couldn't be read at all.
      </div>
    </div>

    <div v-if="result && result.diagnostics?.responsesNotInSetup"
         class="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 mb-4 text-sm text-amber-900">
      <i class="pi pi-exclamation-triangle mr-1.5"></i>
      {{ result.diagnostics.responsesNotInSetup }} survey{{ result.diagnostics.responsesNotInSetup === 1 ? ' was' : 's were' }}
      filed for a topic that isn't in that class's subjects (a topic renamed or removed after the survey, or a
      subject the class no longer has). They're listed below with a
      <span class="font-semibold">"Not in class setup"</span> tag rather than dropped —
      <button type="button" class="underline font-semibold" @click="sourceFilter = 'response_only'">show them</button>.
    </div>

    <div v-if="result && result.diagnostics?.classesWithoutSubjects?.length"
         class="bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 mb-4 text-sm text-slate-600">
      <i class="pi pi-info-circle mr-1.5"></i>
      {{ result.diagnostics.classesWithoutSubjects.length }} class{{ result.diagnostics.classesWithoutSubjects.length === 1 ? ' has' : 'es have' }}
      no subjects assigned, so the grade-wide School Setup subject list was used for
      {{ result.diagnostics.classesWithoutSubjects.length === 1 ? 'it' : 'them' }}:
      <span class="font-semibold">{{ result.diagnostics.classesWithoutSubjects.join(', ') }}</span>
    </div>

    <div v-if="result && result.diagnostics?.gradesWithNoResolvedClasses?.length"
         class="bg-red-50 border border-red-200 rounded-xl px-4 py-3 mb-4 text-sm text-red-900">
      <i class="pi pi-exclamation-triangle mr-1.5"></i>
      Grade{{ result.diagnostics.gradesWithNoResolvedClasses.length === 1 ? '' : 's' }}
      <span class="font-semibold">{{ result.diagnostics.gradesWithNoResolvedClasses.join(', ') }}</span>
      {{ result.diagnostics.gradesWithNoResolvedClasses.length === 1 ? 'has' : 'have' }} subjects/topics
      configured in School Setup, but no student's class field could be resolved for that grade at all —
      so nothing could be built for it below. This is why a subject you know has topics can show zero rows.
      <span v-if="result.diagnostics.unresolvedStudents?.length">
        {{ result.diagnostics.unresolvedStudents.length }} student{{ result.diagnostics.unresolvedStudents.length === 1 ? '' : 's' }}
        had an unreadable class value, e.g. "{{ result.diagnostics.unresolvedStudents[0].studentName }}":
        "{{ result.diagnostics.unresolvedStudents[0].rawClassValue }}".
      </span>
    </div>

    <div v-if="result && result.diagnostics?.mergedStreamGrades?.length"
         class="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 mb-4 text-sm text-amber-900">
      <i class="pi pi-exclamation-triangle mr-1.5"></i>
      Subject grade{{ result.diagnostics.mergedStreamGrades.length === 1 ? '' : 's' }}
      <span class="font-semibold">{{ result.diagnostics.mergedStreamGrades.join(', ') }}</span>
      fold a stream into the grade name in School Setup. There's no stream field on a class to match
      against, so these were collapsed to their base grade (e.g. "XI Commerce" → grade XI) — a
      stream-only subject will therefore show as expected for every section of that grade, streams
      included, not just its own.
    </div>

    <div v-if="result && result.diagnostics?.skippedBlankCompetencies?.length"
         class="bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 mb-4 text-sm text-slate-600">
      <i class="pi pi-info-circle mr-1.5"></i>
      {{ result.diagnostics.skippedBlankCompetencies.length }} subject{{ result.diagnostics.skippedBlankCompetencies.length === 1 ? '' : 's' }}
      with no curricular goal/competency set in School Setup {{ result.diagnostics.skippedBlankCompetencies.length === 1 ? 'was' : 'were' }} left out of this report entirely:
      <span class="font-semibold">{{ result.diagnostics.skippedBlankCompetencies.join(', ') }}</span>
    </div>

    <div v-if="rows.length" class="bg-white rounded-xl border border-slate-200 p-3 mb-3">
      <div class="flex items-center gap-2 flex-wrap">
        <Select v-model="statusFilter" :options="statusOptions" optionLabel="label" optionValue="value" class="w-44" size="small" />
        <MultiSelect v-model="gradeFilter" :options="gradeOptions" placeholder="All grades" class="w-36" size="small"
                     :maxSelectedLabels="2" selectedItemsLabel="{0} grades" />
        <MultiSelect v-model="classFilter" :options="classOptions" placeholder="All classes" class="w-44" size="small"
                     filter :maxSelectedLabels="2" selectedItemsLabel="{0} classes" />
        <MultiSelect v-model="subjectFilter" :options="subjectOptions" placeholder="All subjects" class="w-44" size="small"
                     filter :maxSelectedLabels="2" selectedItemsLabel="{0} subjects" />
        <MultiSelect v-model="topicFilter" :options="topicOptions" placeholder="All topics" class="w-40" size="small"
                     filter :maxSelectedLabels="2" selectedItemsLabel="{0} topics" />
        <Select v-model="teacherFilter" :options="teacherOptions" placeholder="Any teacher" class="w-40" size="small"
                filter showClear />
        <Select v-model="taughtFilter" :options="taughtOptions" optionLabel="label" optionValue="value" class="w-56" size="small" />
        <Select v-model="sourceFilter" :options="sourceOptions" optionLabel="label" optionValue="value" class="w-48" size="small" />
        <InputText v-model="search" class="w-56" size="small" placeholder="Search class, subject, topic, activity…" />
        <Button v-if="isFiltered" label="Clear filters" icon="pi pi-filter-slash" size="small" text @click="clearFilters" />
      </div>
      <div class="text-xs text-slate-500 mt-2 flex gap-3 flex-wrap">
        <span>{{ filteredRows.length }} of {{ rows.length }} shown</span>
        <button type="button" class="hover:underline" @click="statusFilter = 'not_started'">{{ counts.not_started }} not started</button>
        <button type="button" class="hover:underline text-amber-700" @click="statusFilter = 'partial'">{{ counts.partial }} partial</button>
        <button type="button" class="hover:underline text-green-700" @click="statusFilter = 'complete'">{{ counts.complete }} complete</button>
        <button type="button" class="hover:underline text-red-600 font-semibold" @click="statusFilter = 'not_started'; taughtFilter = 'taught'">
          {{ counts.taughtNotSurveyed }} taught but not surveyed
        </button>
        <span v-if="filteredStudentsPending">· {{ filteredStudentsPending }} student-question gaps</span>
      </div>
    </div>

    <div v-if="running" class="flex items-center justify-center py-20">
      <ProgressSpinner style="width:32px;height:32px" />
    </div>

    <div v-else-if="!rows.length" class="text-center py-20 bg-white rounded-xl border border-slate-200">
      <i class="pi pi-list-check text-4xl text-slate-300 mb-3 block"></i>
      <p class="text-slate-500 font-medium">
        {{ result ? 'No class/subject/topic combinations found.' : 'Pick a school and run the check.' }}
      </p>
    </div>

    <div v-else class="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <DataTable :value="filteredRows" size="small" scrollable scrollHeight="560px" dataKey="key">
        <Column header="Class" field="classId" style="min-width:100px" />
        <Column header="Subject" field="subject" style="min-width:140px" />
        <Column header="Topic" style="min-width:140px">
          <template #body="{ data }">
            <div>{{ data.topic || '—' }}</div>
            <span v-if="data.source === 'response_only'" class="text-[10px] font-semibold uppercase tracking-wide text-amber-700"
                  v-tooltip.top="'A survey was filed for this topic, but it is not in this class\'s subjects'">Not in class setup</span>
          </template>
        </Column>
        <Column header="Taught" style="min-width:100px">
          <template #body="{ data }">
            <span v-if="data.taught === true" class="text-xs text-green-700" v-tooltip.top="'Marked taught in the teacher app'">
              <i class="pi pi-check text-xs mr-0.5"></i>{{ shortDate(data.completedAt) || 'Yes' }}
            </span>
            <span v-else-if="data.taught === false" class="text-xs text-slate-400">Not yet</span>
            <span v-else class="text-xs text-slate-300">—</span>
          </template>
        </Column>
        <Column header="Status" style="min-width:130px">
          <template #body="{ data }">
            <span class="px-2 py-0.5 rounded-full text-xs font-semibold" :class="statusClass(data.status)">
              {{ statusLabel(data.status) }}
            </span>
          </template>
        </Column>
        <Column header="Responded" style="min-width:110px">
          <template #body="{ data }">
            {{ data.respondedStudents }} / {{ data.expectedStudents }}
            <div v-if="data.absentStudents" class="text-[11px] text-slate-400">{{ data.absentStudents }} absent</div>
            <div v-if="data.notApplicable" class="text-[11px] text-slate-400">{{ data.notApplicable }} N/A</div>
          </template>
        </Column>
        <Column header="Teacher" field="teacherId" style="min-width:100px">
          <template #body="{ data }">{{ data.teacherId || '—' }}</template>
        </Column>
        <Column header="Activity · Goals / Competencies" style="min-width:300px">
          <template #body="{ data }">
            <span v-if="!data.responses?.length" class="text-xs text-slate-300">—</span>
            <button v-else type="button" class="text-sm text-left hover:text-blue-600 w-full" @click="openEditor(data)">
              <div v-if="data.responses.length > 1" class="text-xs font-semibold text-amber-700 mb-1">
                <i class="pi pi-exclamation-triangle text-xs mr-1"></i>Filed under {{ data.responses.length }} activities
              </div>
              <div v-for="(r, i) in data.responses" :key="i"
                   :class="data.responses.length > 1 ? 'border-l-2 border-amber-200 pl-2 mb-1' : ''">
                <div class="text-slate-800">{{ activityLabel(r) }}</div>
                <div v-if="!r.selectedGoals.length && !r.selectedCompetencies.length" class="text-xs text-amber-700">
                  Goals/competencies not selected
                </div>
                <div v-else class="text-xs text-slate-500" v-tooltip.top="goalsTooltip(r)">
                  {{ r.selectedGoals.length }} goal{{ r.selectedGoals.length === 1 ? '' : 's' }} ·
                  {{ r.selectedCompetencies.length }} competenc{{ r.selectedCompetencies.length === 1 ? 'y' : 'ies' }}
                </div>
              </div>
              <span class="text-xs text-blue-600"><i class="pi pi-pencil text-xs mr-1"></i>View / edit</span>
            </button>
          </template>
        </Column>
        <Column header="Gaps" style="min-width:200px">
          <template #body="{ data }">
            <button
              v-if="data.gaps?.length"
              type="button" class="text-sm text-left text-slate-700 hover:text-blue-600"
              @click="openGaps(data)"
            >
              {{ data.gaps.length }} student{{ data.gaps.length === 1 ? '' : 's' }} — view
            </button>
            <span v-else class="text-xs text-slate-300">—</span>
          </template>
        </Column>
      </DataTable>
    </div>

    <Dialog v-model:visible="gapsVisible" modal :style="{ width: '560px' }" :header="gapsHeader">
      <div v-if="gapsRow" class="max-h-96 overflow-y-auto">
        <div v-for="gap in gapsRow.gaps" :key="gap.studentId" class="flex items-center gap-2 py-1.5 border-b border-slate-100 last:border-0">
          <span class="text-sm text-slate-700 flex-1">{{ gap.studentName }}</span>
          <span v-for="trait in gap.missing" :key="trait" class="px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-50 text-amber-700">
            {{ traitLabel(trait) }} pending
          </span>
        </div>
      </div>
    </Dialog>

    <AapSurveyResponseDialog
      v-model:visible="editorVisible" :schoolId="scannedSchoolId" :row="editorRow"
      :activities="result?.activities || []" :goalOptionsBySubject="result?.goalOptions || {}"
      :classStages="result?.classStages || {}" @saved="onResponseSaved"
    />
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useToast } from 'primevue/usetoast'
import Select from 'primevue/select'
import MultiSelect from 'primevue/multiselect'
import Menu from 'primevue/menu'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import Dialog from 'primevue/dialog'
import ProgressSpinner from 'primevue/progressspinner'
import AapSurveyResponseDialog from './AapSurveyResponseDialog.vue'

import { useAapRemarks } from '../../composables/useAapRemarks.js'
import { aapSurveyCompletionRemote } from '../../utils/api.js'
import {
  downloadAapCompletionXlsx, downloadAapCompletionCsv, downloadAapPendingCsv,
} from '../../utils/aapCompletionExport.js'

/**
 * Whole-school AAP survey completion — a separate concern from the Remarks
 * tab: that one turns already-submitted survey ratings into report-card
 * text, this one answers "who hasn't submitted yet, and for whom
 * specifically". Owns its own school picker rather than sharing the Remarks
 * tab's, since this never needs a class/subject scope — it IS the whole
 * school in one scan.
 */
const toast = useToast()
const { schools, loadingSchools, loadSchools } = useAapRemarks()
onMounted(async () => {
  try {
    await loadSchools()
  } catch (e) {
    console.error('Could not load schools', e)
    toast.add({ severity: 'error', summary: 'Could not load schools', detail: e.message, life: 4000 })
  }
})

const schoolId = ref(null)
const running = ref(false)
const runError = ref('')
const result = ref(null)
// The school the current result belongs to — edits go there even if the
// picker has since been changed without re-running the check.
const scannedSchoolId = ref(null)

// Awareness/Sensitivity/Creativity, or a non-AAP survey's own question tag
// ("classroom_demeanour" -> "Classroom demeanour").
const traitLabel = (t) => { const s = String(t).replace(/_/g, ' '); return s.charAt(0).toUpperCase() + s.slice(1) }

async function run() {
  running.value = true
  runError.value = ''
  result.value = null
  try {
    result.value = await aapSurveyCompletionRemote({ schoolId: schoolId.value })
    scannedSchoolId.value = schoolId.value
  } catch (e) {
    console.error('AAP survey completion check failed', e)
    runError.value = e.message || 'Could not run the completion check'
  } finally {
    running.value = false
  }
}

const rows = computed(() => (result.value?.rows || []).map((r, i) => ({
  ...r, key: `${r.classId}__${r.subject}__${r.topic || ''}__${i}`,
})))

const STATUS_CLASSES = {
  not_started: 'bg-slate-100 text-slate-600',
  partial: 'bg-amber-50 text-amber-700',
  complete: 'bg-green-50 text-green-700',
}
const STATUS_LABELS = { not_started: 'Not started', partial: 'Partial', complete: 'Complete' }
const statusClass = (s) => STATUS_CLASSES[s] || STATUS_CLASSES.not_started
const statusLabel = (s) => STATUS_LABELS[s] || s

const statusOptions = [
  { label: 'All statuses', value: '' },
  { label: 'Not started', value: 'not_started' },
  { label: 'Partial', value: 'partial' },
  { label: 'Complete', value: 'complete' },
]
const statusFilter = ref('')
const search = ref('')
const gradeFilter = ref([])
const classFilter = ref([])
const subjectFilter = ref([])
const topicFilter = ref([])
const teacherFilter = ref(null)
const taughtFilter = ref('')
const sourceFilter = ref('')

const taughtOptions = [
  { label: 'Taught or not', value: '' },
  { label: 'Marked taught in class', value: 'taught' },
  { label: 'Not marked taught yet', value: 'not_taught' },
]
const sourceOptions = [
  { label: 'All rows', value: '' },
  { label: 'Class setup topics only', value: 'setup' },
  { label: 'Not in class setup', value: 'response_only' },
]

const gradeOf = (r) => String(r.classId || '').split('_')[0]
const uniq = (values) => [...new Set(values.filter(Boolean))]
  .sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }))
const teachersOf = (r) => String(r.teacherId || '').split(',').map(t => t.trim()).filter(Boolean)

// Each option list narrows to what the filters to its left still allow, so
// picking grade 7 leaves only grade-7 classes in the class list.
const gradeOptions = computed(() => uniq(rows.value.map(gradeOf)))
const classOptions = computed(() => uniq(rows.value
  .filter(r => !gradeFilter.value.length || gradeFilter.value.includes(gradeOf(r)))
  .map(r => r.classId)))
const subjectOptions = computed(() => uniq(rows.value
  .filter(r => (!gradeFilter.value.length || gradeFilter.value.includes(gradeOf(r)))
    && (!classFilter.value.length || classFilter.value.includes(r.classId)))
  .map(r => r.subject)))
const topicOptions = computed(() => uniq(rows.value
  .filter(r => !subjectFilter.value.length || subjectFilter.value.includes(r.subject))
  .map(r => r.topic)))
const teacherOptions = computed(() => uniq(rows.value.flatMap(teachersOf)))

const isFiltered = computed(() => !!(statusFilter.value || search.value.trim() || gradeFilter.value.length
  || classFilter.value.length || subjectFilter.value.length || topicFilter.value.length
  || teacherFilter.value || taughtFilter.value || sourceFilter.value))

function clearFilters() {
  statusFilter.value = ''
  search.value = ''
  gradeFilter.value = []
  classFilter.value = []
  subjectFilter.value = []
  topicFilter.value = []
  teacherFilter.value = null
  taughtFilter.value = ''
  sourceFilter.value = ''
}

// Everything except status — the counts line shows how the current scope
// splits by status, and clicking a count then narrows to it.
const scopedRows = computed(() => {
  const term = search.value.trim().toLowerCase()
  return rows.value.filter(r => {
    if (gradeFilter.value.length && !gradeFilter.value.includes(gradeOf(r))) return false
    if (classFilter.value.length && !classFilter.value.includes(r.classId)) return false
    if (subjectFilter.value.length && !subjectFilter.value.includes(r.subject)) return false
    if (topicFilter.value.length && !topicFilter.value.includes(r.topic)) return false
    if (teacherFilter.value && !teachersOf(r).includes(teacherFilter.value)) return false
    if (taughtFilter.value === 'taught' && r.taught !== true) return false
    if (taughtFilter.value === 'not_taught' && r.taught === true) return false
    if (sourceFilter.value === 'response_only' && r.source !== 'response_only') return false
    if (sourceFilter.value === 'setup' && r.source === 'response_only') return false
    if (!term) return true
    return [r.classId, r.subject, r.topic, r.teacherId, ...(r.responses || []).map(activityLabel)]
      .some(v => String(v || '').toLowerCase().includes(term))
  })
})

const filteredRows = computed(() => scopedRows.value
  .filter(r => !statusFilter.value || r.status === statusFilter.value))

const counts = computed(() => {
  const out = { not_started: 0, partial: 0, complete: 0, taughtNotSurveyed: 0 }
  for (const r of scopedRows.value) {
    out[r.status] = (out[r.status] || 0) + 1
    if (r.status === 'not_started' && r.taught === true) out.taughtNotSurveyed++
  }
  return out
})

const filteredStudentsPending = computed(() => filteredRows.value
  .reduce((sum, r) => sum + (r.gaps || []).reduce((n, g) => n + (g.missing?.length || 0), 0), 0))

const shortDate = (iso) => {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}

const gapsVisible = ref(false)
const gapsRow = ref(null)
const gapsHeader = computed(() => gapsRow.value
  ? `${gapsRow.value.classId} · ${gapsRow.value.subject}${gapsRow.value.topic ? ' · ' + gapsRow.value.topic : ''}`
  : 'Gaps')

function openGaps(row) {
  gapsRow.value = row
  gapsVisible.value = true
}

const activityLabel = (r) => r.activityName
  || result.value?.activities?.find(a => a.id === r.activityId)?.name
  || r.activityId

function goalsTooltip(r) {
  const parts = []
  if (r.selectedGoals.length) parts.push('Goals:\n• ' + r.selectedGoals.join('\n• '))
  if (r.selectedCompetencies.length) parts.push('Competencies:\n• ' + r.selectedCompetencies.join('\n• '))
  return parts.join('\n\n')
}

const editorVisible = ref(false)
const editorRow = ref(null)
function openEditor(row) {
  editorRow.value = row
  editorVisible.value = true
}

// Patch the saved response into the loaded result in place, rather than
// re-running a whole-school scan for one edit. `rows` spreads each result
// row shallowly, so row.responses IS the loaded result's (reactive) array.
function onResponseSaved({ row, index, updated }) {
  row.responses.splice(index, 1, { ...row.responses[index], ...updated })
}

function downloadXlsx() {
  const { summaryRows, detailRows } = downloadAapCompletionXlsx(
    scannedSchoolId.value, filteredRows.value, { filtered: isFiltered.value })
  toast.add({ severity: 'success', summary: `Exported ${summaryRows} rows, ${detailRows} pending items`, life: 3000 })
}

const csvMenu = ref(null)
const csvItems = [
  {
    label: 'Summary (one row per topic)', icon: 'pi pi-list',
    command: () => {
      const { summaryRows } = downloadAapCompletionCsv(scannedSchoolId.value, filteredRows.value, { filtered: isFiltered.value })
      toast.add({ severity: 'success', summary: `Exported ${summaryRows} rows`, life: 2500 })
    },
  },
  {
    label: 'Pending students (one row per gap)', icon: 'pi pi-users',
    command: () => {
      const { detailRows } = downloadAapPendingCsv(scannedSchoolId.value, filteredRows.value, { filtered: isFiltered.value })
      toast.add({ severity: 'success', summary: `Exported ${detailRows} pending items`, life: 2500 })
    },
  },
]
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
