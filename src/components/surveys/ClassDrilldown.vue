<template>
  <div class="p-3">
    <div class="flex items-center gap-2 mb-2 flex-wrap">
      <InputText v-model="search" class="w-64" size="small" placeholder="Search name or roll no…" />
      <span class="text-xs text-slate-400">{{ filtered.length }} of {{ members.length }} students</span>
      <span v-if="busy" class="text-xs text-slate-400"><i class="pi pi-spin pi-spinner text-xs mr-1"></i>saving…</span>
      <span class="text-[11px] text-slate-400 ml-auto">
        Tick a cell to assign one survey, or select students for a bulk action.
      </span>
    </div>

    <!-- Student-level action bar: assign/unassign the CHOSEN SURVEYS to just
         these students, without touching the rest of the class. Same preview
         + arrayUnion/arrayRemove path as the matrix selection. -->
    <div v-if="selectedIds.size" class="flex items-center gap-2 mb-2 flex-wrap bg-slate-900 text-white rounded-lg px-3 py-2">
      <span class="text-sm font-semibold">{{ selectedIds.size }} student{{ selectedIds.size !== 1 ? 's' : '' }} selected</span>
      <MultiSelect
        v-model="bulkSurveyIds" :options="surveys" optionLabel="label" optionValue="id"
        placeholder="Choose surveys" class="w-64" size="small" filter display="chip" :maxSelectedLabels="2"
      />
      <Button label="Assign" icon="pi pi-check" size="small"
        :disabled="!bulkSurveyIds.length" @click="openBulk('assign')" />
      <Button label="Unassign" icon="pi pi-times" size="small" severity="danger"
        :disabled="!bulkSurveyIds.length" @click="openBulk('unassign')" />
      <Button label="Clear" size="small" text class="!text-slate-300 ml-auto" @click="clearSelection" />
    </div>

    <div v-if="loading" class="flex items-center justify-center py-6">
      <ProgressSpinner style="width:22px;height:22px" />
    </div>

    <div v-else class="overflow-auto bg-white rounded-lg border border-slate-200" style="max-height:340px">
      <table class="w-full text-sm">
        <thead class="sticky top-0 bg-slate-50 z-10">
          <tr>
            <th class="px-2 py-1.5" style="width:34px">
              <Checkbox
                :modelValue="allVisibleSelected" binary
                :indeterminate="someVisibleSelected && !allVisibleSelected"
                v-tooltip="'Select all shown'"
                @update:modelValue="toggleAllVisible"
              />
            </th>
            <th class="text-left px-3 py-1.5 text-xs font-semibold text-slate-400 uppercase" style="min-width:180px">Student</th>
            <th class="text-left px-2 py-1.5 text-xs font-semibold text-slate-400 uppercase" style="width:70px">Roll</th>
            <th v-for="s in surveys" :key="s.id" class="px-2 py-1.5 text-center text-xs font-semibold text-slate-500" style="min-width:92px">
              {{ s.label }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="st in filtered" :key="st.id" class="border-t border-slate-100 hover:bg-slate-50"
              :class="selectedIds.has(st.id) ? 'bg-violet-50' : ''">
            <td class="px-2 py-1">
              <Checkbox :modelValue="selectedIds.has(st.id)" binary @update:modelValue="v => toggleStudent(st.id, v)" />
            </td>
            <td class="px-3 py-1 text-slate-700 truncate">{{ st.name || st.id }}</td>
            <td class="px-2 py-1 text-xs text-slate-400">{{ st.rollNo || '—' }}</td>
            <td v-for="s in surveys" :key="s.id" class="px-2 py-1 text-center">
              <div class="flex items-center justify-center gap-1">
                <Checkbox
                  :modelValue="isAssigned(st, s.id)" binary
                  :disabled="busy"
                  @update:modelValue="v => toggle(st, s.id, v)"
                />
                <!-- Status is what the tick can't say: a ticked box is
                     "assigned", but only a response makes it complete. -->
                <i
                  v-if="statusOf(st, s.id) === STATUS_COMPLETED"
                  class="pi pi-check-circle text-green-500" style="font-size:10px"
                  v-tooltip="'Responded'"
                ></i>
                <i
                  v-else-if="statusOf(st, s.id) === STATUS_PENDING"
                  class="pi pi-clock text-amber-400" style="font-size:10px"
                  v-tooltip="'Assigned, no response yet'"
                ></i>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="!filtered.length" class="text-center text-sm text-slate-400 py-6">No matching students.</div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { doc } from 'firebase/firestore'
import { useToast } from 'primevue/usetoast'
import InputText from 'primevue/inputtext'
import Checkbox from 'primevue/checkbox'
import MultiSelect from 'primevue/multiselect'
import Button from 'primevue/button'
import ProgressSpinner from 'primevue/progressspinner'

import { surveyAssignmentsCollection } from '../../firebase/schoolCollections.js'
import {
  useSurveys, INBOX_FIELD, studentStatus, STATUS_COMPLETED, STATUS_PENDING,
} from '../../composables/useSurveys.js'

/**
 * A class's students with a tick per survey — specific-student assignment in
 * the same grid idiom as the matrix above it.
 *
 * Each tick reuses the same Cloud Function with a one-student scope, so a
 * single change is as idempotent and as auditable as a bulk run.
 */
const props = defineProps({
  schoolId: { type: String, default: null },
  classId: { type: String, default: null },
  surveys: { type: Array, default: () => [] },
  students: { type: Array, default: () => [] },
  loading: { type: Boolean, default: false },
  // {surveyId: Set(studentId)} — supplied by the parent from the matrix load.
  responders: { type: Object, default: () => ({}) },
  statusFilter: { type: String, default: 'all' },
})
const emit = defineEmits(['changed', 'bulk'])

const toast = useToast()
const { apply: applyRemote } = useSurveys()

const search = ref('')
const busy = ref(false)
const selectedIds = ref(new Set())
const bulkSurveyIds = ref([])

const members = computed(() => props.students.filter(s => (s.classId || '(no class)') === props.classId))

const filtered = computed(() => {
  let list = members.value
  const q = search.value.trim().toLowerCase()
  if (q) {
    list = list.filter(s =>
      String(s.name || '').toLowerCase().includes(q) ||
      String(s.rollNo || '').toLowerCase().includes(q))
  }
  // The status filter narrows the DRILL-DOWN too, which is what makes
  // "show only students not assigned AAM2-mid" actionable rather than
  // just informational.
  if (props.statusFilter !== 'all') {
    list = list.filter(s => props.surveys.some(sv => statusOf(s, sv.id) === props.statusFilter))
  }
  return list
})

function isAssigned(student, surveyId) {
  return Array.isArray(student[INBOX_FIELD]) && student[INBOX_FIELD].includes(surveyId)
}
function statusOf(student, surveyId) {
  return studentStatus(student, surveyId, props.responders[surveyId])
}

// ── Student multi-select ────────────────────────────────────────────────
const allVisibleSelected = computed(() =>
  filtered.value.length > 0 && filtered.value.every(s => selectedIds.value.has(s.id)))
const someVisibleSelected = computed(() => filtered.value.some(s => selectedIds.value.has(s.id)))

function toggleStudent(id, wanted) {
  const next = new Set(selectedIds.value)
  wanted ? next.add(id) : next.delete(id)
  selectedIds.value = next
}
// Operates on the FILTERED set, not the whole class — "select all" after a
// search must mean the students actually on screen.
function toggleAllVisible(wanted) {
  const next = new Set(selectedIds.value)
  filtered.value.forEach(s => (wanted ? next.add(s.id) : next.delete(s.id)))
  selectedIds.value = next
}
function clearSelection() {
  selectedIds.value = new Set()
  bulkSurveyIds.value = []
}
function openBulk(mode) {
  emit('bulk', {
    mode,
    studentIds: [...selectedIds.value],
    surveyIds: [...bulkSurveyIds.value],
    classId: props.classId,
  })
}

async function toggle(student, surveyId, wanted) {
  busy.value = true
  try {
    const runId = doc(surveyAssignmentsCollection(props.schoolId)).id
    await applyRemote({
      schoolId: props.schoolId, runId, surveyIds: [surveyId],
      audience: 'students', mode: wanted ? 'assign' : 'unassign',
      scope: { type: 'ids', ids: [student.id] },
    })
    // Reflect locally so the tick doesn't wait on a roster reload.
    const current = new Set(student[INBOX_FIELD] || [])
    wanted ? current.add(surveyId) : current.delete(surveyId)
    student[INBOX_FIELD] = Array.from(current)
    emit('changed')
  } catch (e) {
    toast.add({ severity: 'error', summary: 'Could not update', detail: e.message, life: 4000 })
  } finally {
    busy.value = false
  }
}

// A drill-down is per class; carrying a selection across classes would let a
// bulk action target students no longer on screen.
watch(() => props.classId, clearSelection)
</script>
