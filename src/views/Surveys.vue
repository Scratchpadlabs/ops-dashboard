<template>
  <div>
    <!-- School selector — surveys live in the teacher-app tree
         (schools/<id>/surveys), the same tree School Setup works in, NOT the
         ops CRM's operations/ops/schools. -->
    <div class="flex items-center justify-between gap-4 mb-5">
      <div class="flex items-center gap-2">
        <Select
          v-model="selectedSchoolId"
          :options="schools" optionLabel="name" optionValue="id"
          placeholder="Select a school" class="w-80" :loading="loadingSchools" filter
        />
        <span v-if="overview" class="text-xs text-slate-400">
          {{ overview.active_student_count }} active students
        </span>
      </div>
      <div class="flex gap-2">
        <Button label="Refresh counts" icon="pi pi-refresh" size="small" text
          :loading="loadingOverview" :disabled="!selectedSchoolId" @click="refreshOverview" />
        <Button label="Assign Survey" icon="pi pi-send" size="small"
          :disabled="!selectedSchoolId" @click="openDialog('assign')" />
      </div>
    </div>

    <div v-if="!selectedSchoolId" class="text-center py-20 bg-white rounded-xl border border-slate-200">
      <i class="pi pi-inbox text-4xl text-slate-300 mb-3 block"></i>
      <p class="text-slate-500 font-medium">Select a school to see its surveys</p>
    </div>

    <template v-else>
      <div v-if="loading" class="flex items-center justify-center py-20">
        <ProgressSpinner style="width:32px;height:32px" />
      </div>

      <div v-else-if="!visibleSurveys.length" class="text-center py-20 bg-white rounded-xl border border-slate-200">
        <i class="pi pi-inbox text-4xl text-slate-300 mb-3 block"></i>
        <p class="text-slate-500 font-medium">No surveys for this school</p>
        <p v-if="hiddenCount" class="text-xs text-slate-400 mt-1">
          {{ hiddenCount }} incomplete/test document{{ hiddenCount !== 1 ? 's' : '' }} hidden.
        </p>
      </div>

      <div v-else>
        <div class="bg-white rounded-xl border border-slate-200 overflow-hidden mb-4">
          <DataTable :value="visibleSurveys" size="small" stripedRows>
            <Column header="Survey">
              <template #body="{ data }">
                <div class="font-medium text-sm text-slate-900">{{ label(data) }}</div>
                <div class="font-mono text-xs text-slate-400">{{ data.id }}</div>
              </template>
            </Column>
            <Column header="Audience" style="width:110px">
              <template #body="{ data }">
                <span class="px-2 py-0.5 rounded-full text-xs font-semibold"
                  :class="audienceOf(data) === 'staff' ? 'bg-violet-100 text-violet-700' : 'bg-blue-50 text-blue-700'">
                  {{ audienceOf(data) === 'staff' ? 'Staff' : 'Students' }}
                </span>
              </template>
            </Column>
            <Column header="Window" style="width:200px">
              <template #body="{ data }">
                <span class="text-xs" :class="windowClass(data)">{{ windowLabel(data) }}</span>
              </template>
            </Column>
            <Column header="Assigned" style="width:110px">
              <template #body="{ data }">
                <span v-if="overview" class="text-sm font-semibold text-slate-900">{{ assignedCount(data) }}</span>
                <span v-else class="text-xs text-slate-300">—</span>
              </template>
            </Column>
            <Column header="Responded" style="width:110px">
              <template #body="{ data }">
                <!-- null (not measurable) is deliberately shown differently
                     from 0 (measurable, none yet) — see survey_overview. -->
                <span v-if="overview && respondedCount(data) !== null" class="text-sm text-slate-700">{{ respondedCount(data) }}</span>
                <span v-else class="text-xs text-slate-300" v-tooltip="overview ? 'No responses subcollection for this survey' : 'Load counts to see this'">—</span>
              </template>
            </Column>
            <Column header="" style="width:150px">
              <template #body="{ data }">
                <div class="flex gap-1">
                  <Button label="Assign" text size="small" @click="openDialog('assign', data.id)" />
                  <Button label="Remove" text size="small" severity="danger" @click="openDialog('unassign', data.id)" />
                </div>
              </template>
            </Column>
          </DataTable>
        </div>

        <p v-if="hiddenCount" class="text-xs text-slate-400 mb-4">
          {{ hiddenCount }} incomplete/test document{{ hiddenCount !== 1 ? 's' : '' }} hidden from this list — filtered from the UI only, nothing was deleted.
        </p>

        <!-- Per-student inbox management -->
        <div class="mb-4">
          <StudentInboxPanel :school-id="selectedSchoolId" :surveys="visibleSurveys" @changed="onApplied" />
        </div>

        <!-- Run history -->
        <div class="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <div class="px-4 py-2.5 border-b border-slate-100 flex items-center justify-between">
            <div class="text-sm font-bold text-slate-900">Recent assignment runs</div>
            <Button icon="pi pi-refresh" text rounded size="small" :loading="loadingRuns" @click="refreshRuns" />
          </div>
          <DataTable v-if="runs.length" :value="runs" size="small" stripedRows>
            <Column header="Survey">
              <template #body="{ data }"><span class="text-sm text-slate-700">{{ data.survey_name || data.survey_id }}</span></template>
            </Column>
            <Column header="Action" style="width:100px">
              <template #body="{ data }">
                <span class="px-2 py-0.5 rounded-full text-xs font-semibold"
                  :class="data.mode === 'unassign' ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-700'">
                  {{ data.mode === 'unassign' ? 'Removed' : 'Assigned' }}
                </span>
              </template>
            </Column>
            <Column header="Scope" style="width:160px">
              <template #body="{ data }">
                <span class="text-xs text-slate-500">{{ scopeLabel(data) }}</span>
              </template>
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
          <div v-else class="text-center text-sm text-slate-400 py-8">No assignment runs yet for this school</div>
        </div>
      </div>
    </template>

    <AssignSurveyDialog
      v-model:visible="dialogVisible"
      :school-id="selectedSchoolId"
      :mode="dialogMode"
      :preset-survey-id="dialogSurveyId"
      @applied="onApplied"
    />
  </div>
</template>

<script setup>
import { ref, watch, onMounted } from 'vue'
import { useToast } from 'primevue/usetoast'
import Select from 'primevue/select'
import Button from 'primevue/button'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import ProgressSpinner from 'primevue/progressspinner'

import AssignSurveyDialog from '../components/surveys/AssignSurveyDialog.vue'
import StudentInboxPanel from '../components/surveys/StudentInboxPanel.vue'
import { useSurveys, surveyLabel, guessAudience } from '../composables/useSurveys.js'

const toast = useToast()
const {
  schools, visibleSurveys, hiddenCount, overview, loading,
  loadSchools, loadSurveys, loadOverview, loadRuns,
} = useSurveys()

const selectedSchoolId = ref(null)
const loadingSchools = ref(false)
const loadingOverview = ref(false)
const loadingRuns = ref(false)
const runs = ref([])

const dialogVisible = ref(false)
const dialogMode = ref('assign')
const dialogSurveyId = ref(null)

const label = surveyLabel
const audienceOf = guessAudience

function openDialog(mode, surveyId = null) {
  dialogMode.value = mode
  dialogSurveyId.value = surveyId
  dialogVisible.value = true
}

function assignedCount(s) {
  if (!overview.value) return 0
  const map = audienceOf(s) === 'staff' ? overview.value.staff_assigned : overview.value.assigned
  return map?.[s.id] || 0
}
function respondedCount(s) {
  const v = overview.value?.responses?.[s.id]
  return v === undefined ? null : v
}

function toDate(ts) {
  if (!ts) return null
  return ts.toDate ? ts.toDate() : new Date(ts)
}
function fmt(d) {
  return d ? d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' }) : '—'
}
function windowLabel(s) {
  const start = toDate(s.startAt), end = toDate(s.expiresAt)
  if (!start && !end) return 'No window set'
  return `${fmt(start)} – ${fmt(end)}`
}
function windowClass(s) {
  const now = new Date()
  const start = toDate(s.startAt), end = toDate(s.expiresAt)
  if (end && end < now) return 'text-slate-400'
  if (start && start > now) return 'text-amber-600'
  return 'text-slate-600'
}

function scopeLabel(r) {
  if (r.scope_type === 'school') return 'Entire school'
  if (r.scope_type === 'classes') return `${(r.scope_value || []).length} class(es)`
  if (r.scope_type === 'ids') return `${(r.scope_value || []).length} specific`
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
  const d = toDate(ts)
  return d ? d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''
}

// Counts need a full roster pass server-side, so they are explicitly
// requested rather than loaded with the page — cheap to skip when you're
// just here to assign something.
async function refreshOverview() {
  if (!selectedSchoolId.value) return
  loadingOverview.value = true
  try {
    await loadOverview(selectedSchoolId.value)
  } catch (e) {
    toast.add({ severity: 'error', summary: 'Could not load counts', detail: e.message, life: 4000 })
  } finally {
    loadingOverview.value = false
  }
}

async function refreshRuns() {
  if (!selectedSchoolId.value) return
  loadingRuns.value = true
  try {
    runs.value = await loadRuns(selectedSchoolId.value)
  } catch (e) {
    console.error('Could not load assignment runs', e)
    runs.value = []
  } finally {
    loadingRuns.value = false
  }
}

async function onApplied() {
  await Promise.all([refreshRuns(), overview.value ? refreshOverview() : Promise.resolve()])
}

watch(selectedSchoolId, async (id) => {
  overview.value = null
  runs.value = []
  if (!id) return
  await Promise.all([loadSurveys(id), refreshRuns()])
})

onMounted(async () => {
  loadingSchools.value = true
  try {
    const list = await loadSchools()
    if (!selectedSchoolId.value && list.length) selectedSchoolId.value = list[0].id
  } catch (e) {
    toast.add({ severity: 'error', summary: 'Could not load schools', detail: e.message, life: 4000 })
  } finally {
    loadingSchools.value = false
  }
})
</script>
