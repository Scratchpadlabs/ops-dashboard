<template>
  <Dialog
    :visible="visible" @update:visible="close"
    :header="mode === 'assign' ? 'Assign selected' : 'Unassign selected'"
    modal :style="{ width: '620px' }" :closable="!running"
  >
    <div class="space-y-4 pt-1">
      <div class="text-sm text-slate-600">
        <b>{{ pairs.length }}</b> class-survey pair{{ pairs.length !== 1 ? 's' : '' }} selected —
        {{ surveyIds.length }} survey{{ surveyIds.length !== 1 ? 's' : '' }} across
        {{ classIds.length }} class{{ classIds.length !== 1 ? 'es' : '' }}.
      </div>

      <!-- A selection is a scatter of cells, not necessarily a rectangle. The
           writes are per (survey, class) pair, so a partial rectangle is
           spelled out rather than rounded up to the full cross-product. -->
      <div v-if="!isRectangle" class="text-xs text-amber-700 bg-amber-50 rounded-lg px-3 py-2">
        <i class="pi pi-info-circle text-xs mr-1"></i>
        The selection isn't a full rectangle — only the {{ pairs.length }} selected pairs are affected,
        not all {{ surveyIds.length * classIds.length }} combinations.
      </div>

      <div v-if="preview" class="border border-slate-200 rounded-lg p-3 bg-slate-50">
        <div class="text-sm text-slate-800">
          <template v-if="mode === 'assign'">
            This will assign <b>{{ surveyLabels }}</b> to <b>{{ preview.will_change }}</b>
            student record{{ preview.will_change !== 1 ? 's' : '' }} across {{ classIds.length }} class(es).
          </template>
          <template v-else>
            This will remove <b>{{ surveyLabels }}</b> from <b>{{ preview.will_change }}</b>
            student record{{ preview.will_change !== 1 ? 's' : '' }} across {{ classIds.length }} class(es).
          </template>
        </div>
        <div class="text-xs text-slate-500 mt-1 space-y-0.5">
          <div v-if="preview.already_count">
            {{ preview.already_count }} {{ mode === 'assign' ? 'already assigned' : 'not assigned' }} (skipped).
          </div>
          <div v-if="preview.inactive_skipped">
            {{ preview.inactive_skipped }} inactive student{{ preview.inactive_skipped !== 1 ? 's' : '' }} (skipped).
          </div>
          <div v-if="!preview.will_change" class="text-slate-400">
            Nothing to do — every selected pair is already in the desired state.
          </div>
        </div>

        <!-- Per-survey breakdown, so a mixed selection explains itself
             instead of showing one opaque total. -->
        <div v-if="(preview.per_survey || []).length > 1" class="mt-2 pt-2 border-t border-slate-200 space-y-0.5">
          <div v-for="p in preview.per_survey" :key="p.survey_id" class="text-xs text-slate-500 flex justify-between">
            <span>{{ p.label }}</span>
            <span><b class="text-slate-700">{{ p.will_change }}</b> to change · {{ p.already }} skipped</span>
          </div>
        </div>
      </div>

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
        v-if="!preview" label="Preview" icon="pi pi-eye"
        :loading="previewing" @click="runPreview"
      />
      <Button
        v-else
        :label="mode === 'assign' ? `Assign to ${preview.will_change}` : `Remove from ${preview.will_change}`"
        :icon="mode === 'assign' ? 'pi pi-check' : 'pi pi-trash'"
        :severity="mode === 'assign' ? undefined : 'danger'"
        :loading="running" :disabled="!preview.will_change || done"
        @click="runApply"
      />
    </template>
  </Dialog>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { doc } from 'firebase/firestore'
import { useToast } from 'primevue/usetoast'
import Dialog from 'primevue/dialog'
import Button from 'primevue/button'

import { surveyAssignmentsCollection } from '../../firebase/schoolCollections.js'
import { useSurveys } from '../../composables/useSurveys.js'

/**
 * Confirm + execute an assignment over the matrix selection.
 *
 * The selection is N surveys x M classes and it is applied as ONE run — no
 * survey-name-first prompt, which is the whole point of the v2 flow. Preview
 * and apply are the same server call with dryRun flipped, so the count on the
 * button is exactly what happens.
 */
const props = defineProps({
  visible: { type: Boolean, default: false },
  schoolId: { type: String, default: null },
  mode: { type: String, default: 'assign' },
  pairs: { type: Array, default: () => [] },      // ["classId::surveyId", ...]
  surveys: { type: Array, default: () => [] },
})
const emit = defineEmits(['update:visible', 'applied'])

const toast = useToast()
const { preview: previewRemote, apply: applyRemote, watchRun } = useSurveys()

const preview = ref(null)
const previewing = ref(false)
const running = ref(false)
const done = ref(false)
const error = ref('')
const runDoc = ref(null)
let unsubRun = null

const classIds = computed(() => [...new Set(props.pairs.map(p => p.split('::')[0]))])
const surveyIds = computed(() => [...new Set(props.pairs.map(p => p.split('::')[1]))])
const isRectangle = computed(() => props.pairs.length === classIds.value.length * surveyIds.value.length)
const surveyLabels = computed(() => {
  const labels = surveyIds.value.map(id => props.surveys.find(s => s.id === id)?.label || id)
  return labels.length <= 3 ? labels.join(', ') : `${labels.slice(0, 3).join(', ')} +${labels.length - 3} more`
})

async function runPreview() {
  previewing.value = true
  error.value = ''
  try {
    preview.value = await previewRemote({
      schoolId: props.schoolId, surveyIds: surveyIds.value,
      audience: 'students', mode: props.mode,
      scope: { type: 'classes', classIds: classIds.value },
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
  const runId = doc(surveyAssignmentsCollection(props.schoolId)).id
  unsubRun = watchRun(props.schoolId, runId, d => { runDoc.value = d })
  try {
    const result = await applyRemote({
      schoolId: props.schoolId, runId, surveyIds: surveyIds.value,
      audience: 'students', mode: props.mode,
      scope: { type: 'classes', classIds: classIds.value },
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

function close() {
  unsubRun?.()
  unsubRun = null
  emit('update:visible', false)
}

watch(() => props.visible, (v) => {
  if (!v) { unsubRun?.(); unsubRun = null; return }
  preview.value = null
  runDoc.value = null
  done.value = false
  error.value = ''
})
</script>
