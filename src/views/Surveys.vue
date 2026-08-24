<template>
  <div>
    <!-- Surveys live in the teacher-app tree (schools/<id>/surveys), the same
         tree School Setup works in — NOT the ops CRM's operations/ops/schools,
         which has no link to a root school id to resolve a roster from. -->
    <div class="flex items-center justify-between gap-4 mb-4 flex-wrap">
      <div class="flex items-center gap-2">
        <Select
          v-model="schoolId" :options="schools" optionLabel="name" optionValue="id"
          placeholder="Select a school" class="w-72" :loading="loadingSchools" filter
        />
        <span v-if="matrix" class="text-xs text-slate-400">
          {{ matrix.active_student_count }} active students
          <span v-if="matrix.from_cache" v-tooltip="'Served from the cached matrix — refresh to recount'">· cached</span>
        </span>
      </div>
      <div class="flex gap-2">
        <Button label="Refresh" icon="pi pi-refresh" size="small" text
          :loading="loadingMatrix" :disabled="!schoolId" @click="reload(true)" />
        <Button label="Copy survey" icon="pi pi-copy" size="small" outlined
          :disabled="!schoolId" @click="copyVisible = true" />
        <Button label="Download report" icon="pi pi-download" size="small" outlined
          :disabled="!schoolId || !surveys.length" @click="reportVisible = true" />
      </div>
    </div>

    <div v-if="!schoolId" class="text-center py-20 bg-white rounded-xl border border-slate-200">
      <i class="pi pi-th-large text-4xl text-slate-300 mb-3 block"></i>
      <p class="text-slate-500 font-medium">Select a school to see its survey matrix</p>
    </div>

    <template v-else>
      <!-- ── Filters (persisted in the URL so a view is shareable) ───────── -->
      <div class="bg-white rounded-xl border border-slate-200 p-3 mb-4 flex items-end gap-3 flex-wrap">
        <div>
          <label class="form-label">Classes</label>
          <MultiSelect
            v-model="filters.classIds" :options="classOptions" optionLabel="label" optionValue="value"
            placeholder="All classes" class="w-64" filter display="chip" :maxSelectedLabels="2"
          />
        </div>
        <div>
          <label class="form-label">Grade</label>
          <MultiSelect
            v-model="filters.grades" :options="grades" placeholder="All grades" class="w-40"
            :maxSelectedLabels="3"
          />
        </div>
        <div>
          <label class="form-label">Status</label>
          <Select v-model="filters.status" :options="statusOptions" optionLabel="label" optionValue="value" class="w-48" />
        </div>
        <div class="flex items-center gap-2 pb-1">
          <Checkbox v-model="filters.activeWindowOnly" binary inputId="activeOnly" @update:modelValue="reload(true)" />
          <label for="activeOnly" class="text-sm text-slate-600">Active window only</label>
        </div>
        <Button v-if="hasFilters" label="Clear" text size="small" class="ml-auto" @click="clearFilters" />
      </div>

      <div v-if="loadingMatrix" class="flex items-center justify-center py-20">
        <ProgressSpinner style="width:32px;height:32px" />
      </div>

      <div v-else-if="!surveys.length" class="text-center py-20 bg-white rounded-xl border border-slate-200">
        <i class="pi pi-inbox text-4xl text-slate-300 mb-3 block"></i>
        <p class="text-slate-500 font-medium">No surveys for this school</p>
        <p v-if="filters.activeWindowOnly" class="text-xs text-slate-400 mt-1">
          Only active-window surveys are shown — clear that filter to see all.
        </p>
      </div>

      <template v-else>
        <div v-if="(matrix?.unresolved_response_surveys || []).length"
             class="text-xs text-amber-700 bg-amber-50 rounded-lg px-3 py-2 mb-3">
          <i class="pi pi-exclamation-triangle text-xs mr-1"></i>
          Responses aren't attributable for {{ matrix.unresolved_response_surveys.join(', ') }} —
          those cells show “—” for responded/completion rather than a misleading zero.
        </div>

        <SurveyMatrix
          :surveys="visibleSurveys"
          :all-surveys="surveys"
          :visible-survey-ids="visibleSurveyIds"
          @update:visible-survey-ids="setVisibleSurveys"
          :rows="filteredRows"
          :totals="totals"
          :selection="selection"
          :metric="metric"
          :expanded="expandedClass"
          :active-student-count="matrix?.active_student_count || 0"
          :unresolved-response-surveys="matrix?.unresolved_response_surveys || []"
          @update:metric="setMetric"
          @select-cells="onSelectCells"
          @select-row="onSelectRow"
          @select-column="onSelectColumn"
          @toggle-expand="onToggleExpand"
          @view-survey="onViewSurvey"
        >
          <template #drilldown="{ classId }">
            <ClassDrilldown
              :school-id="schoolId"
              :class-id="classId"
              :surveys="visibleSurveys"
              :students="students"
              :loading="loadingRoster"
              :responders="drilldownResponders"
              :status-filter="filters.status"
              @changed="onDrilldownChanged"
              @bulk="onStudentBulk"
            />
          </template>
        </SurveyMatrix>

        <!-- Run history -->
        <div class="bg-white rounded-xl border border-slate-200 overflow-hidden mt-4">
          <div class="px-4 py-2.5 border-b border-slate-100 flex items-center justify-between">
            <div class="text-sm font-bold text-slate-900">Recent assignment runs</div>
            <Button icon="pi pi-refresh" text rounded size="small" :loading="loadingRuns" @click="refreshRuns" />
          </div>
          <DataTable v-if="runs.length" :value="runs" size="small" stripedRows>
            <Column header="Surveys">
              <template #body="{ data }">
                <span class="text-sm text-slate-700 cell-truncate" :title="(data.survey_names || [data.survey_id]).join(', ')">{{ (data.survey_names || [data.survey_id]).join(', ') }}</span>
              </template>
            </Column>
            <Column header="Action" style="width:100px">
              <template #body="{ data }">
                <span class="px-2 py-0.5 rounded-full text-xs font-semibold"
                  :class="data.mode === 'unassign' ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-700'">
                  {{ data.mode === 'unassign' ? 'Removed' : 'Assigned' }}
                </span>
              </template>
            </Column>
            <Column header="Scope" style="width:150px">
              <template #body="{ data }"><span class="text-xs text-slate-500">{{ scopeLabel(data) }}</span></template>
            </Column>
            <Column header="Result" style="width:170px">
              <template #body="{ data }">
                <span class="text-xs text-slate-600">{{ data.assigned_count }} of {{ data.target_count }}</span>
                <span v-if="data.skipped_count" class="text-xs text-slate-400"> · {{ data.skipped_count }} skipped</span>
              </template>
            </Column>
            <Column header="Status" style="width:90px">
              <template #body="{ data }">
                <span class="px-2 py-0.5 rounded-full text-xs font-semibold" :class="runStatusClass(data.status)">{{ data.status }}</span>
              </template>
            </Column>
            <Column header="By" style="width:190px">
              <template #body="{ data }">
                <div class="text-xs text-slate-500">{{ data.run_by }}</div>
                <div class="text-xs text-slate-400">{{ formatTs(data.run_at) }}</div>
              </template>
            </Column>
          </DataTable>
          <div v-else-if="runsError" class="text-center text-sm text-red-500 py-8">
            <i class="pi pi-exclamation-triangle text-xs mr-1"></i>{{ runsError }}
          </div>
          <div v-else class="text-center text-sm text-slate-400 py-8">
            No assignment runs yet for this school — the log is written by the Cloud Function on each run.
          </div>
        </div>
      </template>
    </template>

    <!-- ── Sticky action bar — acts on the whole selection at once ───────── -->
    <Transition name="fade">
      <div v-if="selection.size" class="fixed bottom-0 left-0 right-0 z-40 flex justify-center pb-4 px-4 pointer-events-none">
        <div class="pointer-events-auto bg-slate-900 text-white rounded-xl shadow-lg px-4 py-2.5 flex items-center gap-3 flex-wrap">
          <span class="text-sm font-semibold">{{ selection.size }} class-survey pair{{ selection.size !== 1 ? 's' : '' }} selected</span>
          <span class="text-xs text-slate-300">{{ selectedClassCount }} class(es) · {{ selectedSurveyCount }} survey(s)</span>
          <div class="flex gap-2 ml-2">
            <Button label="Assign selected" icon="pi pi-check" size="small" @click="openAction('assign')" />
            <Button label="Unassign selected" icon="pi pi-times" size="small" severity="danger" @click="openAction('unassign')" />
            <Button label="Clear" size="small" text class="!text-slate-300" @click="selection = new Set()" />
          </div>
        </div>
      </div>
    </Transition>

    <SelectionActionDialog
      v-model:visible="actionVisible"
      :school-id="schoolId"
      :mode="actionMode"
      :pairs="[...selection]"
      :surveys="surveys"
      :student-ids="studentScope.studentIds"
      :student-survey-ids="studentScope.surveyIds"
      :student-class-id="studentScope.classId"
      @applied="onApplied"
    />

    <ReportDialog
      v-model:visible="reportVisible"
      :school-id="schoolId"
      :surveys="surveys"
      :filters="reportFilters"
      :visible-survey-ids="visibleSurveyIds"
    />

    <CopySurveyDialog
      v-model:visible="copyVisible"
      :target-school-id="schoolId"
      :target-school-name="currentSchoolName"
      :schools="schools"
      @copied="onSurveyCopied"
    />

    <SurveyDetailDialog
      v-model:visible="detailVisible"
      :school-id="schoolId"
      :survey-id="detailSurveyId"
      @saved="onSurveyEdited"
    />
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useToast } from 'primevue/usetoast'
import Select from 'primevue/select'
import MultiSelect from 'primevue/multiselect'
import Checkbox from 'primevue/checkbox'
import Button from 'primevue/button'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import ProgressSpinner from 'primevue/progressspinner'

import SurveyMatrix from '../components/surveys/SurveyMatrix.vue'
import SelectionActionDialog from '../components/surveys/SelectionActionDialog.vue'
import ClassDrilldown from '../components/surveys/ClassDrilldown.vue'
import ReportDialog from '../components/surveys/ReportDialog.vue'
import CopySurveyDialog from '../components/surveys/CopySurveyDialog.vue'
import SurveyDetailDialog from '../components/surveys/SurveyDetailDialog.vue'
import {
  useSurveys, gradeOf, STATUS_NOT_ASSIGNED, STATUS_PENDING, STATUS_COMPLETED,
} from '../composables/useSurveys.js'

const route = useRoute()
const router = useRouter()
const toast = useToast()
const {
  schools, matrix, surveys, rows, totals, grades, students,
  loadingMatrix, loadingRoster,
  loadSchools, loadMatrix, loadClassDetail, loadRuns,
} = useSurveys()

const schoolId = ref(null)
const loadingSchools = ref(false)
const loadingRuns = ref(false)
const runsError = ref('')
const runs = ref([])
const metric = ref('all')
// Column picker. Empty = show everything, so the URL stays short in the
// common case and only carries a `cols` param once columns are hidden.
const hiddenSurveyIds = ref([])
const visibleSurveys = computed(() => {
  const hidden = new Set(hiddenSurveyIds.value)
  return surveys.value.filter(s => !hidden.has(s.id))
})
const visibleSurveyIds = computed(() => visibleSurveys.value.map(s => s.id))
function setVisibleSurveys(ids) {
  const keep = new Set(ids)
  hiddenSurveyIds.value = surveys.value.filter(s => !keep.has(s.id)).map(s => s.id)
  // Dropping a column must drop its cells from the selection too, or an
  // assign would target a survey no longer on screen.
  if (selection.value.size) {
    selection.value = new Set([...selection.value].filter(p => keep.has(p.split('::')[1])))
  }
}
const selection = ref(new Set())
const expandedClass = ref(null)
const drilldownResponders = ref({})
const actionVisible = ref(false)
const actionMode = ref('assign')
// Set when the action comes from the drill-down's student selection rather
// than from matrix cells — the dialog switches to an ids scope.
const studentScope = ref({ studentIds: [], surveyIds: [], classId: null })
const reportVisible = ref(false)
const copyVisible = ref(false)
const detailVisible = ref(false)
const detailSurveyId = ref(null)
const currentSchoolName = computed(() => schools.value.find(s => s.id === schoolId.value)?.name || schoolId.value || '')

const filters = reactive({ classIds: [], grades: [], status: 'all', activeWindowOnly: false })

const statusOptions = [
  { value: 'all', label: 'Any status' },
  { value: STATUS_NOT_ASSIGNED, label: 'Not assigned' },
  { value: STATUS_PENDING, label: 'Assigned, not responded' },
  { value: STATUS_COMPLETED, label: 'Responded' },
]

const classOptions = computed(() =>
  rows.value.map(r => ({ value: r.class_id, label: `${r.class_id} (${r.student_count})` })))

const hasFilters = computed(() =>
  filters.classIds.length || filters.grades.length || filters.status !== 'all' || filters.activeWindowOnly)

/**
 * Row filtering. The status filter is a CELL-level predicate here (does this
 * class have any student in that state for any survey?) — the precise
 * per-student version lives in the drill-down, where individual students are
 * actually visible.
 */
const filteredRows = computed(() => {
  let list = rows.value
  if (filters.classIds.length) {
    const set = new Set(filters.classIds)
    list = list.filter(r => set.has(r.class_id))
  }
  if (filters.grades.length) {
    const set = new Set(filters.grades)
    list = list.filter(r => set.has(gradeOf(r.class_id)))
  }
  if (filters.status !== 'all') {
    list = list.filter(r => surveys.value.some(s => matchesStatus(r.cells[s.id], filters.status)))
  }
  return list
})

function matchesStatus(cell, status) {
  if (!cell) return false
  if (status === STATUS_NOT_ASSIGNED) return cell.assigned < cell.total
  if (status === STATUS_PENDING) return cell.assigned - cell.responded > 0
  if (status === STATUS_COMPLETED) return cell.responded > 0
  return true
}

const selectedClassCount = computed(() => new Set([...selection.value].map(p => p.split('::')[0])).size)
const selectedSurveyCount = computed(() => new Set([...selection.value].map(p => p.split('::')[1])).size)

// Filters passed to the report generator — a filtered view downloads
// filtered data, and the file states these in its header row.
const reportFilters = computed(() => ({
  classIds: filters.classIds.length
    ? filters.classIds
    : (filters.grades.length ? filteredRows.value.map(r => r.class_id) : []),
  status: filters.status,
  activeWindowOnly: filters.activeWindowOnly,
  search: '',
}))

// ── Selection ───────────────────────────────────────────────────────────────
function onSelectCells(pairs, { additive } = {}) {
  const next = additive ? new Set(selection.value) : new Set()
  pairs.forEach(p => next.add(p))
  selection.value = next
}
function onSelectRow(classId, event) {
  const pairs = surveys.value.map(s => `${classId}::${s.id}`)
  toggleGroup(pairs, event)
}
function onSelectColumn(surveyId, event) {
  const pairs = filteredRows.value.map(r => `${r.class_id}::${surveyId}`)
  toggleGroup(pairs, event)
}
// Clicking a header that is already fully selected deselects it — otherwise
// there is no way to undo a row/column click without clearing everything.
function toggleGroup(pairs, event) {
  const additive = event?.shiftKey || event?.ctrlKey || event?.metaKey
  const allSelected = pairs.every(p => selection.value.has(p))
  const next = additive ? new Set(selection.value) : new Set(allSelected ? selection.value : [])
  pairs.forEach(p => (allSelected ? next.delete(p) : next.add(p)))
  selection.value = next
}
function setMetric(m) { metric.value = m }

async function onToggleExpand(classId) {
  expandedClass.value = expandedClass.value === classId ? null : classId
  if (!expandedClass.value) return
  // Loaded per class on expand — bounded by class size rather than pulling
  // the whole school's roster to show 30 rows.
  try {
    const detail = await loadClassDetail(schoolId.value, classId)
    drilldownResponders.value = detail.responders
  } catch (e) {
    toast.add({ severity: 'error', summary: 'Could not load the class', detail: e.message, life: 4000 })
  }
}

function openAction(mode) {
  studentScope.value = { studentIds: [], surveyIds: [], classId: null }
  actionMode.value = mode
  actionVisible.value = true
}

// Bulk action on specific students inside an expanded class.
function onStudentBulk({ mode, studentIds, surveyIds, classId }) {
  studentScope.value = { studentIds, surveyIds, classId }
  actionMode.value = mode
  actionVisible.value = true
}

async function onApplied() {
  selection.value = new Set()
  studentScope.value = { studentIds: [], surveyIds: [], classId: null }
  // Re-read the open class so its ticks reflect what was just written.
  if (expandedClass.value) {
    try {
      const detail = await loadClassDetail(schoolId.value, expandedClass.value)
      drilldownResponders.value = detail.responders
    } catch { /* the matrix reload below is the source of truth anyway */ }
  }
  await Promise.all([reload(true), refreshRuns()])
}
async function onDrilldownChanged() {
  await refreshRuns()
}

function onViewSurvey(surveyId) {
  detailSurveyId.value = surveyId
  detailVisible.value = true
}
// Copying/editing a survey doc changes its name/date window, which the
// matrix's column labels and window dot read straight from the survey doc —
// force a reload so those reflect the change immediately rather than on the
// next cache expiry.
async function onSurveyCopied() {
  await reload(true)
}
async function onSurveyEdited() {
  await reload(true)
}

// ── Data ────────────────────────────────────────────────────────────────────
async function reload(force = false) {
  if (!schoolId.value) return
  try {
    await loadMatrix(schoolId.value, { activeWindowOnly: filters.activeWindowOnly, force })
  } catch (e) {
    toast.add({ severity: 'error', summary: 'Could not load the matrix', detail: e.message, life: 5000 })
  }
}
async function refreshRuns() {
  if (!schoolId.value) return
  loadingRuns.value = true
  runsError.value = ''
  try {
    runs.value = await loadRuns(schoolId.value)
  } catch (e) {
    // An empty table used to mean both "no runs yet" and "the query broke".
    // Say which.
    console.error('Could not load assignment runs', e)
    runs.value = []
    runsError.value = e.message || 'Could not read the assignment log.'
  } finally {
    loadingRuns.value = false
  }
}

function clearFilters() {
  const wasWindowFiltered = filters.activeWindowOnly
  Object.assign(filters, { classIds: [], grades: [], status: 'all', activeWindowOnly: false })
  if (wasWindowFiltered) reload(true)
}

// ── URL persistence — the whole view is shareable ───────────────────────────
function syncUrl() {
  const q = {}
  if (schoolId.value) q.school = schoolId.value
  if (filters.classIds.length) q.classes = filters.classIds.join(',')
  if (filters.grades.length) q.grades = filters.grades.join(',')
  if (filters.status !== 'all') q.status = filters.status
  if (filters.activeWindowOnly) q.active = '1'
  if (metric.value !== 'all') q.metric = metric.value
  if (hiddenSurveyIds.value.length) q.hide = hiddenSurveyIds.value.join(',')
  router.replace({ query: q }).catch(() => {})
}

function readUrl() {
  const q = route.query
  if (q.school) schoolId.value = String(q.school)
  filters.classIds = q.classes ? String(q.classes).split(',').filter(Boolean) : []
  filters.grades = q.grades ? String(q.grades).split(',').filter(Boolean) : []
  filters.status = q.status ? String(q.status) : 'all'
  filters.activeWindowOnly = q.active === '1'
  metric.value = q.metric ? String(q.metric) : 'all'
  hiddenSurveyIds.value = q.hide ? String(q.hide).split(',').filter(Boolean) : []
}

watch([() => ({ ...filters }), metric, schoolId, hiddenSurveyIds], syncUrl, { deep: true })

watch(schoolId, async (id) => {
  selection.value = new Set()
  expandedClass.value = null
  students.value = []
  runs.value = []
  matrix.value = null
  if (!id) return
  await Promise.all([reload(), refreshRuns()])
})

// ── Presentation ────────────────────────────────────────────────────────────
function scopeLabel(r) {
  if (r.scope_type === 'school') return 'Entire school'
  if (r.scope_type === 'classes') return `${(r.scope_value || []).length} class(es)`
  if (r.scope_type === 'ids') return `${(r.scope_value || []).length} student(s)`
  return r.scope_type || '—'
}
function runStatusClass(s) {
  return {
    done: 'bg-green-50 text-green-700',
    running: 'bg-amber-50 text-amber-700',
    failed: 'bg-red-50 text-red-700',
  }[s] || 'bg-slate-100 text-slate-600'
}
function formatTs(ts) {
  const d = ts?.toDate ? ts.toDate() : (ts ? new Date(ts) : null)
  return d ? d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''
}

onMounted(async () => {
  readUrl()
  loadingSchools.value = true
  try {
    const list = await loadSchools()
    if (!schoolId.value && list.length) schoolId.value = list[0].id
    else if (schoolId.value) await Promise.all([reload(), refreshRuns()])
  } catch (e) {
    toast.add({ severity: 'error', summary: 'Could not load schools', detail: e.message, life: 4000 })
  } finally {
    loadingSchools.value = false
  }
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
.fade-enter-active, .fade-leave-active { transition: opacity 0.15s, transform 0.15s; }
.fade-enter-from, .fade-leave-to { opacity: 0; transform: translateY(8px); }
</style>
