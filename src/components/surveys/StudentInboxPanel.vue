<template>
  <div class="bg-white rounded-xl border border-slate-200 overflow-hidden">
    <div class="px-4 py-2.5 border-b border-slate-100 flex items-center justify-between">
      <div>
        <div class="text-sm font-bold text-slate-900">Student inboxes</div>
        <div class="text-xs text-slate-400">Look up one student and add or remove a single survey.</div>
      </div>
      <Button v-if="!loaded" label="Load roster" icon="pi pi-users" size="small" outlined
        :loading="loadingRoster" :disabled="!schoolId" @click="load" />
    </div>

    <div v-if="loaded" class="p-4">
      <InputText v-model="search" class="w-full mb-3" placeholder="Search by name, class or roll no…" />

      <div v-if="!search.trim()" class="text-sm text-slate-400 text-center py-6">
        {{ activeStudents.length }} active students — start typing to find one.
      </div>

      <div v-else-if="!matches.length" class="text-sm text-slate-400 text-center py-6">No matching students.</div>

      <div v-else class="space-y-2">
        <div v-for="s in matches" :key="s.id" class="border border-slate-200 rounded-lg p-3">
          <div class="flex items-center gap-2 mb-2">
            <span class="text-sm font-semibold text-slate-900">{{ s.name || s.id }}</span>
            <span class="text-xs text-slate-400">{{ s.classId }}</span>
            <span v-if="s.rollNo" class="text-xs text-slate-300">#{{ s.rollNo }}</span>
            <span class="text-xs text-slate-400 ml-auto">{{ (inboxOf(s) || []).length }} in inbox</span>
          </div>

          <div class="flex flex-wrap gap-1.5 mb-2">
            <span v-for="sid in inboxOf(s)" :key="sid"
              class="px-2 py-0.5 rounded-full text-xs font-medium flex items-center gap-1"
              :class="isKnownSurvey(sid) ? 'bg-blue-50 text-blue-700' : 'bg-slate-100 text-slate-500'">
              {{ surveyLabelFor(sid) }}
              <button type="button" class="hover:text-red-600" :disabled="busyId === s.id"
                v-tooltip="'Remove this survey from this student'"
                @click="change(s, sid, 'unassign')">
                <i class="pi pi-times" style="font-size:9px"></i>
              </button>
            </span>
            <span v-if="!(inboxOf(s) || []).length" class="text-xs text-slate-300">Inbox is empty</span>
          </div>

          <div class="flex items-center gap-2">
            <Select
              v-model="addSelection[s.id]"
              :options="assignableFor(s)" optionLabel="label" optionValue="id"
              placeholder="Add a survey…" class="flex-1" size="small" filter
              :disabled="busyId === s.id"
            />
            <Button label="Add" size="small" :loading="busyId === s.id"
              :disabled="!addSelection[s.id]" @click="change(s, addSelection[s.id], 'assign')" />
          </div>
        </div>
      </div>

      <p class="text-xs text-slate-400 mt-3">
        Single-student changes go through the same audited Cloud Function as bulk runs, so they show up in the run history too.
      </p>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { doc } from 'firebase/firestore'
import { useToast } from 'primevue/usetoast'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import Select from 'primevue/select'

import { surveyAssignmentsCollection } from '../../firebase/schoolCollections.js'
import { useSurveys, surveyLabel, INBOX_FIELD } from '../../composables/useSurveys.js'

/**
 * Per-student survey inbox management.
 *
 * The task asks for this on "a student's detail view (if one exists)" — this
 * app has no student detail page, so it lives here alongside the bulk flow
 * rather than inventing one. Every change reuses the same Cloud Function
 * with a one-id scope, which keeps single edits idempotent, auditable, and
 * visible in the run history exactly like bulk runs.
 */
const props = defineProps({
  schoolId: { type: String, default: null },
  surveys: { type: Array, default: () => [] },   // already junk-filtered
})
const emit = defineEmits(['changed'])

const toast = useToast()
const { students, activeStudents, loadingRoster, loadRoster, apply: applyRemote } = useSurveys()

const loaded = ref(false)
const search = ref('')
const busyId = ref(null)
const addSelection = ref({})

async function load() {
  await loadRoster(props.schoolId)
  loaded.value = true
}

const matches = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return []
  return activeStudents.value.filter(s =>
    String(s.name || '').toLowerCase().includes(q) ||
    String(s.classId || '').toLowerCase().includes(q) ||
    String(s.rollNo || '').toLowerCase().includes(q)
  ).slice(0, 25)
})

function inboxOf(s) { return s[INBOX_FIELD] || [] }
function isKnownSurvey(id) { return props.surveys.some(x => x.id === id) }
function surveyLabelFor(id) {
  const s = props.surveys.find(x => x.id === id)
  // An id with no matching (real) survey is shown as-is rather than hidden —
  // it's usually something an old script pushed, and being able to see it is
  // the only way to remove it.
  return s ? surveyLabel(s) : id
}
function assignableFor(s) {
  const have = new Set(inboxOf(s))
  return props.surveys.filter(x => !have.has(x.id)).map(x => ({ id: x.id, label: surveyLabel(x) }))
}

async function change(student, surveyId, mode) {
  busyId.value = student.id
  try {
    const runId = doc(surveyAssignmentsCollection(props.schoolId)).id
    await applyRemote({
      schoolId: props.schoolId, runId, surveyId, audience: 'students', mode,
      scope: { type: 'ids', ids: [student.id] },
    })
    // Reflect it locally so the chips update without re-reading the roster.
    const local = students.value.find(x => x.id === student.id)
    if (local) {
      const current = new Set(local[INBOX_FIELD] || [])
      mode === 'assign' ? current.add(surveyId) : current.delete(surveyId)
      local[INBOX_FIELD] = Array.from(current)
    }
    addSelection.value = { ...addSelection.value, [student.id]: null }
    toast.add({
      severity: 'success',
      summary: mode === 'assign' ? 'Added' : 'Removed',
      detail: `${surveyLabelFor(surveyId)} · ${student.name || student.id}`, life: 2500,
    })
    emit('changed')
  } catch (e) {
    toast.add({ severity: 'error', summary: 'Could not update', detail: e.message, life: 4000 })
  } finally {
    busyId.value = null
  }
}

watch(() => props.schoolId, () => {
  loaded.value = false
  search.value = ''
  students.value = []
})
</script>
