<template>
  <Dialog
    :visible="visible"
    @update:visible="close"
    :header="mode === 'assign' ? 'Assign Survey' : 'Remove Survey'"
    modal
    :style="{ width: '680px' }"
    :closable="!running"
  >
    <div class="space-y-4 pt-1">

      <!-- Step 1 — survey -->
      <div>
        <label class="form-label">Survey *</label>
        <Select
          v-model="form.surveyId"
          :options="surveyOptions"
          optionLabel="label" optionValue="id"
          placeholder="Select a survey" class="w-full" filter
          :disabled="running"
          @update:modelValue="onSurveyChange"
        />
        <p v-if="hiddenCount" class="text-xs text-slate-400 mt-1">
          {{ hiddenCount }} incomplete/test document{{ hiddenCount !== 1 ? 's' : '' }} hidden — nothing was deleted.
        </p>
      </div>

      <!-- Step 1b — audience -->
      <div>
        <label class="form-label">Audience *</label>
        <div class="flex gap-2">
          <button
            v-for="opt in audienceOptions" :key="opt.value" type="button"
            class="flex-1 py-2 px-3 rounded-lg text-sm font-medium border transition-all"
            :class="form.audience === opt.value
              ? 'bg-slate-900 text-white border-slate-900'
              : 'bg-white text-slate-600 border-slate-200 hover:border-slate-400'"
            :disabled="running"
            @click="setAudience(opt.value)"
          >{{ opt.label }}</button>
        </div>
        <p v-if="audienceGuessed" class="text-xs text-slate-400 mt-1">
          Defaulted from the survey's own metadata — change it if that's wrong.
        </p>
      </div>

      <!-- Step 2 — scope -->
      <div v-if="form.audience === 'students'">
        <label class="form-label">Scope *</label>
        <div class="grid grid-cols-3 gap-2 mb-3">
          <button
            v-for="opt in scopeOptions" :key="opt.value" type="button"
            class="py-2 px-3 rounded-lg text-sm font-medium border transition-all"
            :class="form.scopeType === opt.value
              ? 'bg-slate-900 text-white border-slate-900'
              : 'bg-white text-slate-600 border-slate-200 hover:border-slate-400'"
            :disabled="running"
            @click="setScope(opt.value)"
          >{{ opt.label }}</button>
        </div>

        <div v-if="loadingRoster" class="flex items-center gap-2 text-xs text-slate-400 py-2">
          <i class="pi pi-spin pi-spinner"></i>Loading roster…
        </div>

        <!-- Entire school -->
        <div v-else-if="form.scopeType === 'school'" class="bg-slate-50 rounded-lg px-3 py-2.5 text-sm text-slate-600">
          All <b>{{ activeStudents.length }}</b> active students across {{ studentsByClass.size }} class(es).
        </div>

        <!-- By class -->
        <div v-else-if="form.scopeType === 'classes'" class="border border-slate-200 rounded-lg p-2 max-h-56 overflow-auto">
          <label v-for="c in classOptions" :key="c.id" class="flex items-center gap-2 text-sm px-1 py-1">
            <Checkbox v-model="form.classIds" :value="c.id" :disabled="running" />
            <span class="text-slate-700">{{ c.id }}</span>
            <span class="text-xs text-slate-400 ml-auto">{{ c.count }} student{{ c.count !== 1 ? 's' : '' }}</span>
          </label>
          <p v-if="!classOptions.length" class="text-xs text-slate-400 py-2 text-center">No classes with active students.</p>
        </div>

        <!-- Specific students -->
        <div v-else>
          <InputText v-model="studentSearch" class="w-full mb-2" placeholder="Search by name, class or roll no…" :disabled="running" />
          <div class="border border-slate-200 rounded-lg p-2 max-h-56 overflow-auto">
            <label v-for="s in filteredStudents" :key="s.id" class="flex items-center gap-2 text-sm px-1 py-1">
              <Checkbox v-model="form.studentIds" :value="s.id" :disabled="running" />
              <span class="text-slate-700">{{ s.name || s.id }}</span>
              <span class="text-xs text-slate-400">{{ s.classId }}</span>
              <span v-if="s.rollNo" class="text-xs text-slate-300">#{{ s.rollNo }}</span>
              <span
                v-if="form.surveyId && (s[INBOX_FIELD] || []).includes(form.surveyId)"
                class="ml-auto px-1.5 py-0.5 rounded text-[10px] font-semibold bg-green-100 text-green-700"
              >has it</span>
            </label>
            <p v-if="!filteredStudents.length" class="text-xs text-slate-400 py-2 text-center">No matching students.</p>
          </div>
          <p class="text-xs text-slate-400 mt-1">
            {{ form.studentIds.length }} selected
            <span v-if="filteredStudents.length < activeStudents.length">· showing {{ filteredStudents.length }} of {{ activeStudents.length }}</span>
          </p>
        </div>
      </div>

      <div v-else class="bg-slate-50 rounded-lg px-3 py-2.5 text-sm text-slate-600">
        All active staff for this school. Staff surveys are assigned school-wide — narrower staff scopes aren't supported yet.
      </div>

      <!-- Step 3 — preview -->
      <div v-if="preview" class="border rounded-lg p-3" :class="preview.will_change ? 'border-slate-200 bg-slate-50' : 'border-slate-200 bg-white'">
        <div class="text-sm text-slate-800">
          <template v-if="mode === 'assign'">
            This will assign <b>{{ surveyLabelFor(form.surveyId) }}</b> to
            <b>{{ preview.will_change }}</b> {{ form.audience === 'staff' ? 'staff' : 'student' }}{{ preview.will_change !== 1 ? 's' : '' }}{{ scopeSuffix }}.
          </template>
          <template v-else>
            This will remove <b>{{ surveyLabelFor(form.surveyId) }}</b> from
            <b>{{ preview.will_change }}</b> {{ form.audience === 'staff' ? 'staff' : 'student' }}{{ preview.will_change !== 1 ? 's' : '' }}{{ scopeSuffix }}.
          </template>
        </div>
        <div class="text-xs text-slate-500 mt-1 space-y-0.5">
          <div v-if="preview.already_count">
            {{ preview.already_count }} {{ mode === 'assign' ? 'already have it' : "don't have it" }} (will be skipped).
          </div>
          <div v-if="preview.inactive_skipped">
            {{ preview.inactive_skipped }} inactive record{{ preview.inactive_skipped !== 1 ? 's' : '' }} skipped.
          </div>
          <div v-if="!preview.will_change" class="text-slate-400">Nothing to do — every target is already in the desired state.</div>
        </div>

        <!-- Surfaces a wrong inbox-field assumption BEFORE any write. -->
        <div
          v-if="form.audience === 'staff' && preview.target_count && !preview.existing_field_count"
          class="mt-2 text-xs text-amber-700 bg-amber-50 rounded px-2 py-1.5"
        >
          <i class="pi pi-exclamation-triangle text-xs mr-1"></i>
          None of the {{ preview.target_count }} staff records currently have a <span class="font-mono">{{ INBOX_FIELD }}</span> field.
          Confirm that's the right field for staff before writing — otherwise this creates a new one the app may not read.
        </div>
      </div>

      <!-- Progress -->
      <div v-if="running || runDoc" class="border border-slate-200 rounded-lg p-3">
        <div class="flex items-center justify-between text-sm mb-1.5">
          <span class="text-slate-600">
            <i v-if="running" class="pi pi-spin pi-spinner text-xs mr-1"></i>
            {{ runDoc?.status === 'done' ? 'Done' : runDoc?.status === 'failed' ? 'Failed' : 'Writing…' }}
          </span>
          <span class="text-slate-500">{{ runDoc?.assigned_count ?? 0 }} / {{ runDoc?.target_count ?? preview?.will_change ?? 0 }}</span>
        </div>
        <div class="h-2 rounded-full bg-slate-100 overflow-hidden">
          <div class="h-full rounded-full bg-green-500 transition-all" :style="{ width: (runDoc?.progress || 0) + '%' }"></div>
        </div>
        <div v-if="runDoc?.error" class="text-xs text-red-500 mt-2">{{ runDoc.error }}</div>
      </div>

      <div v-if="error" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{{ error }}</div>
    </div>

    <template #footer>
      <Button label="Close" text :disabled="running" @click="close" />
      <Button
        v-if="!preview"
        label="Preview" icon="pi pi-eye"
        :loading="previewing" :disabled="!canPreview"
        @click="runPreview"
      />
      <template v-else>
        <Button label="Change selection" text :disabled="running" @click="preview = null" />
        <Button
          :label="mode === 'assign' ? `Assign to ${preview.will_change}` : `Remove from ${preview.will_change}`"
          :icon="mode === 'assign' ? 'pi pi-check' : 'pi pi-trash'"
          :severity="mode === 'assign' ? undefined : 'danger'"
          :loading="running" :disabled="!preview.will_change || done"
          @click="runApply"
        />
      </template>
    </template>
  </Dialog>
</template>

<script setup>
import { ref, reactive, computed, watch } from 'vue'
import { doc } from 'firebase/firestore'
import { useToast } from 'primevue/usetoast'
import Dialog from 'primevue/dialog'
import Button from 'primevue/button'
import Select from 'primevue/select'
import Checkbox from 'primevue/checkbox'
import InputText from 'primevue/inputtext'

import { db } from '../../firebase/config'
import { surveyAssignmentsCollection } from '../../firebase/schoolCollections.js'
import { useSurveys, surveyLabel, guessAudience, isInactive, INBOX_FIELD } from '../../composables/useSurveys.js'

/**
 * Assign or unassign one survey over a scope.
 *
 * The flow is deliberately two-stage and cannot be short-circuited: nothing
 * is written until a preview has been fetched and the resulting count
 * confirmed. Preview and apply are the same server call with `dryRun`
 * flipped, so the number on the button is the number that happens.
 */
const props = defineProps({
  visible: { type: Boolean, default: false },
  schoolId: { type: String, default: null },
  mode: { type: String, default: 'assign' },   // assign | unassign
  presetSurveyId: { type: String, default: null },
  presetStudentIds: { type: Array, default: () => [] },
})
const emit = defineEmits(['update:visible', 'applied'])

const toast = useToast()
const {
  visibleSurveys, hiddenCount, classes, students, activeStudents, studentsByClass,
  loadingRoster, loadSurveys, loadClasses, loadRoster, preview: previewRemote, apply: applyRemote, watchRun,
} = useSurveys()

const audienceOptions = [
  { value: 'students', label: 'Students' },
  { value: 'staff', label: 'Staff' },
]
const scopeOptions = [
  { value: 'school', label: 'Entire school' },
  { value: 'classes', label: 'By class' },
  { value: 'ids', label: 'Specific students' },
]

const form = reactive({ surveyId: null, audience: 'students', scopeType: 'school', classIds: [], studentIds: [] })
const preview = ref(null)
const previewing = ref(false)
const running = ref(false)
const done = ref(false)
const error = ref('')
const runDoc = ref(null)
const studentSearch = ref('')
const audienceGuessed = ref(false)
let unsubRun = null

const surveyOptions = computed(() =>
  visibleSurveys.value.map(s => ({ id: s.id, label: `${surveyLabel(s)} · ${s.id}` })))

function surveyLabelFor(id) {
  const s = visibleSurveys.value.find(x => x.id === id)
  return s ? surveyLabel(s) : id
}

const classOptions = computed(() => {
  const ids = new Set([...classes.value.map(c => c.id), ...studentsByClass.value.keys()])
  return Array.from(ids)
    .map(id => ({ id, count: studentsByClass.value.get(id) || 0 }))
    .filter(c => c.count > 0)
    .sort((a, b) => a.id.localeCompare(b.id))
})

const filteredStudents = computed(() => {
  const q = studentSearch.value.trim().toLowerCase()
  const list = activeStudents.value
  if (!q) return list.slice(0, 300)
  return list.filter(s =>
    String(s.name || '').toLowerCase().includes(q) ||
    String(s.classId || '').toLowerCase().includes(q) ||
    String(s.rollNo || '').toLowerCase().includes(q)
  ).slice(0, 300)
})

const scopeSuffix = computed(() => {
  if (form.audience === 'staff') return ''
  if (form.scopeType === 'school') return ` across ${studentsByClass.value.size} class(es)`
  if (form.scopeType === 'classes') return ` across ${form.classIds.length} class(es)`
  return ''
})

const canPreview = computed(() => {
  if (!form.surveyId || !props.schoolId) return false
  if (form.audience === 'staff') return true
  if (form.scopeType === 'classes') return form.classIds.length > 0
  if (form.scopeType === 'ids') return form.studentIds.length > 0
  return true
})

function scopePayload() {
  if (form.audience === 'staff') return { type: 'school' }
  if (form.scopeType === 'classes') return { type: 'classes', classIds: [...form.classIds] }
  if (form.scopeType === 'ids') return { type: 'ids', ids: [...form.studentIds] }
  return { type: 'school' }
}

function onSurveyChange(id) {
  preview.value = null
  const s = visibleSurveys.value.find(x => x.id === id)
  if (s) {
    const guessed = guessAudience(s)
    audienceGuessed.value = guessed === 'staff'
    form.audience = guessed
  }
}
function setAudience(v) { form.audience = v; audienceGuessed.value = false; preview.value = null }
function setScope(v) { form.scopeType = v; preview.value = null }

async function runPreview() {
  previewing.value = true
  error.value = ''
  try {
    preview.value = await previewRemote({
      schoolId: props.schoolId, surveyId: form.surveyId,
      audience: form.audience, mode: props.mode, scope: scopePayload(),
    })
  } catch (e) {
    error.value = e.message || 'Could not build the preview.'
  } finally {
    previewing.value = false
  }
}

async function runApply() {
  running.value = true
  error.value = ''
  // Client-generated id so the run doc can be watched from the moment the
  // call starts, same pattern as the import pipeline's jobId.
  const runId = doc(surveyAssignmentsCollection(props.schoolId)).id
  unsubRun = watchRun(props.schoolId, runId, d => { runDoc.value = d })
  try {
    const result = await applyRemote({
      schoolId: props.schoolId, runId, surveyId: form.surveyId,
      audience: form.audience, mode: props.mode, scope: scopePayload(),
    })
    done.value = true
    toast.add({
      severity: 'success',
      summary: props.mode === 'assign' ? 'Assigned' : 'Removed',
      detail: `${result.written} record(s) updated`, life: 4000,
    })
    emit('applied', result)
  } catch (e) {
    error.value = e.message || 'The run failed. Re-open the preview to see the current state.'
  } finally {
    running.value = false
  }
}

function reset() {
  Object.assign(form, {
    surveyId: props.presetSurveyId || null, audience: 'students', scopeType: 'school',
    classIds: [], studentIds: [...props.presetStudentIds],
  })
  if (props.presetStudentIds.length) form.scopeType = 'ids'
  preview.value = null
  runDoc.value = null
  done.value = false
  error.value = ''
  studentSearch.value = ''
  audienceGuessed.value = false
  if (props.presetSurveyId) onSurveyChange(props.presetSurveyId)
}

function close() {
  unsubRun?.()
  unsubRun = null
  emit('update:visible', false)
}

watch(() => props.visible, async (v) => {
  if (!v) { unsubRun?.(); unsubRun = null; return }
  reset()
  await Promise.all([loadSurveys(props.schoolId), loadClasses(props.schoolId)])
  if (props.presetSurveyId) onSurveyChange(props.presetSurveyId)
  // Roster loads after the dialog is interactive — it's the big read, and
  // nothing above the preview button depends on it.
  await loadRoster(props.schoolId)
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
