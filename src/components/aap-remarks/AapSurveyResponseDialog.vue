<template>
  <Dialog :visible="visible" @update:visible="$emit('update:visible', $event)" modal
          :style="{ width: '720px' }" :breakpoints="{ '768px': '95vw' }" :header="header">
    <div v-if="row">
      <div v-if="row.responses.length > 1" class="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-4 text-sm text-amber-900">
        <i class="pi pi-exclamation-triangle mr-1.5"></i>
        {{ row.teacherId }} filed this class/topic under {{ row.responses.length }} different activities —
        each is a separate response. Pick which one to edit:
        <Select v-model="responseIndex" :options="responseOptions" optionLabel="label" optionValue="value"
                class="w-full mt-2" size="small" />
      </div>

      <div class="mb-5">
        <label class="form-label">Activity</label>
        <Select v-model="activityId" :options="activityOptions" optionLabel="name" optionValue="id"
                placeholder="Select an activity" class="w-full" filter />
        <p v-if="activityId !== original.activityId" class="text-xs text-amber-700 mt-1">
          Saving moves this response (answers included) under the new activity, the same place the
          teacher app would have filed it.
        </p>
        <label v-if="classStage && hasOtherStages" class="flex items-center gap-2 text-xs text-slate-500 mt-2">
          <Checkbox v-model="showAllStages" :binary="true" /> Show activities from other stages too
          (this class is {{ classStage }})
        </label>
      </div>

      <div class="mb-5">
        <label class="form-label">Curricular goals</label>
        <p v-if="!goalOptions.length" class="text-sm text-slate-400">
          No curricular goals are set up for this subject in School Setup.
        </p>
        <div class="space-y-1.5">
          <label v-for="goal in goalChoices" :key="goal.goal" class="flex items-start gap-2 text-sm text-slate-700">
            <Checkbox :modelValue="goals.includes(goal.goal)" :binary="true" class="mt-0.5"
                      @update:modelValue="toggleGoal(goal.goal, $event)" />
            <span>
              {{ goal.goal }}
              <span v-if="goal.legacy" class="text-xs text-amber-600">(no longer in School Setup)</span>
            </span>
          </label>
        </div>
      </div>

      <div>
        <label class="form-label">Competencies</label>
        <p v-if="!competencyGroups.length && !orphanCompetencies.length" class="text-sm text-slate-400">
          Pick a curricular goal to see its competencies.
        </p>
        <div v-for="group in competencyGroups" :key="group.goal" class="mb-3">
          <div class="text-xs font-semibold text-slate-500 mb-1">{{ group.goal }}</div>
          <p v-if="!group.competencies.length" class="text-xs text-slate-400">No competencies under this goal.</p>
          <label v-for="c in group.competencies" :key="c" class="flex items-start gap-2 text-sm text-slate-700 py-0.5">
            <Checkbox :modelValue="competencies.includes(c)" :binary="true" class="mt-0.5"
                      @update:modelValue="toggleCompetency(c, $event)" />
            <span>{{ c }}</span>
          </label>
        </div>
        <div v-if="orphanCompetencies.length" class="mb-3">
          <div class="text-xs font-semibold text-amber-700 mb-1">
            Selected, but not under any ticked goal in School Setup
          </div>
          <label v-for="c in orphanCompetencies" :key="c" class="flex items-start gap-2 text-sm text-slate-700 py-0.5">
            <Checkbox :modelValue="true" :binary="true" class="mt-0.5" @update:modelValue="toggleCompetency(c, $event)" />
            <span>{{ c }}</span>
          </label>
        </div>
      </div>
    </div>

    <template #footer>
      <Button label="Cancel" text @click="$emit('update:visible', false)" />
      <Button label="Save" icon="pi pi-check" :loading="saving" :disabled="!dirty || !activityId" @click="save" />
    </template>
  </Dialog>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { useToast } from 'primevue/usetoast'
import Dialog from 'primevue/dialog'
import Select from 'primevue/select'
import Button from 'primevue/button'
import Checkbox from 'primevue/checkbox'

import { updateAapSurveyResponseRemote } from '../../utils/api.js'

/**
 * Edits the three things a teacher picks in the teacher app before answering
 * an AAP survey — Activity → Curricular Goals → Competencies — for one
 * submitted response. Offers the same choices the teacher app does: the
 * subject's curricular_goals from School Setup, and competencies only under
 * a ticked goal. Anything already selected that School Setup no longer
 * lists is still shown (and can be unticked) rather than silently dropped.
 */
const props = defineProps({
  visible: Boolean,
  schoolId: { type: String, default: null },
  row: { type: Object, default: null },
  activities: { type: Array, default: () => [] },
  goalOptionsBySubject: { type: Object, default: () => ({}) },
  classStages: { type: Object, default: () => ({}) },
})
const emit = defineEmits(['update:visible', 'saved'])
const toast = useToast()

const responseIndex = ref(0)
const activityId = ref(null)
const goals = ref([])
const competencies = ref([])
const showAllStages = ref(false)
const saving = ref(false)

const response = computed(() => props.row?.responses?.[responseIndex.value] || null)
const original = computed(() => response.value || { activityId: null, selectedGoals: [], selectedCompetencies: [] })

function reset() {
  const r = response.value
  activityId.value = r?.activityId || null
  goals.value = [...(r?.selectedGoals || [])]
  competencies.value = [...(r?.selectedCompetencies || [])]
}

watch(() => [props.visible, props.row], ([visible]) => {
  if (!visible) return
  responseIndex.value = 0
  showAllStages.value = false
  reset()
})
watch(responseIndex, reset)

const header = computed(() => props.row
  ? `${props.row.classId} · ${props.row.subject}${props.row.topic ? ' · ' + props.row.topic : ''}`
  : 'Edit survey response')

const activityName = (id) => props.activities.find(a => a.id === id)?.name || id
const responseOptions = computed(() => (props.row?.responses || []).map((r, i) => ({
  value: i, label: r.activityName || activityName(r.activityId),
})))

const classStage = computed(() => props.row ? props.classStages[props.row.classId] || null : null)
const hasOtherStages = computed(() => props.activities.some(a => a.stage !== classStage.value))
const activityOptions = computed(() => {
  const list = (!classStage.value || showAllStages.value)
    ? props.activities
    : props.activities.filter(a => a.stage === classStage.value)
  const current = original.value.activityId
  // The response's own activity always stays selectable, even if it's from
  // another stage or no longer listed, so opening the dialog never blanks it.
  if (current && !list.some(a => a.id === current)) {
    return [{ id: current, name: original.value.activityName || current }, ...list]
  }
  return list
})

const goalOptions = computed(() => props.goalOptionsBySubject[response.value?.subjectDocId] || [])
const goalChoices = computed(() => {
  const known = goalOptions.value.map(g => ({ ...g, legacy: false }))
  const legacy = goals.value
    .filter(g => !known.some(k => k.goal === g))
    .map(g => ({ goal: g, competencies: [], legacy: true }))
  return [...known, ...legacy]
})

const competencyGroups = computed(() => goalOptions.value.filter(g => goals.value.includes(g.goal)))
const offeredCompetencies = computed(() => new Set(competencyGroups.value.flatMap(g => g.competencies)))
const orphanCompetencies = computed(() => competencies.value.filter(c => !offeredCompetencies.value.has(c)))

function toggleGoal(goal, on) {
  if (on) {
    if (!goals.value.includes(goal)) goals.value = [...goals.value, goal]
    return
  }
  goals.value = goals.value.filter(g => g !== goal)
  // Drop competencies that only this goal offered — a competency the
  // teacher app would no longer show shouldn't stay selected behind it.
  const stillOffered = offeredCompetencies.value
  const onlyThisGoal = new Set((goalOptions.value.find(g => g.goal === goal)?.competencies || [])
    .filter(c => !stillOffered.has(c)))
  competencies.value = competencies.value.filter(c => !onlyThisGoal.has(c))
}

function toggleCompetency(c, on) {
  competencies.value = on
    ? (competencies.value.includes(c) ? competencies.value : [...competencies.value, c])
    : competencies.value.filter(x => x !== c)
}

const sameList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i])
const dirty = computed(() => !!response.value && (
  activityId.value !== original.value.activityId
  || !sameList(goals.value, original.value.selectedGoals || [])
  || !sameList(competencies.value, original.value.selectedCompetencies || [])
))

async function save() {
  const r = response.value
  if (!r) return
  saving.value = true
  try {
    const updated = await updateAapSurveyResponseRemote({
      schoolId: props.schoolId,
      surveyId: r.surveyId,
      responseId: r.responseId,
      activityId: activityId.value !== r.activityId ? activityId.value : undefined,
      selectedGoals: goals.value,
      selectedCompetencies: competencies.value,
    })
    emit('saved', { row: props.row, index: responseIndex.value, updated })
    toast.add({ severity: 'success', summary: 'Survey response updated', life: 3000 })
    emit('update:visible', false)
  } catch (e) {
    console.error('Could not update AAP survey response', e)
    toast.add({ severity: 'error', summary: 'Could not save', detail: e.message, life: 6000 })
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.form-label {
  display: block;
  font-size: 12px;
  font-weight: 500;
  color: #64748b;
  margin-bottom: 6px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
</style>
