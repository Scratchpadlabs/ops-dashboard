<template>
  <Dialog :visible="visible" @update:visible="$emit('update:visible', $event)"
    header="Download report" modal :style="{ width: '560px' }">
    <div class="space-y-4 pt-1">

      <div>
        <label class="form-label">Scope *</label>
        <div class="space-y-1.5">
          <label v-for="s in scopes" :key="s.value" class="flex items-start gap-2 text-sm cursor-pointer">
            <RadioButton v-model="scope" :value="s.value" />
            <span>
              <span class="text-slate-700 font-medium">{{ s.label }}</span>
              <span class="block text-xs text-slate-400">{{ s.hint }}</span>
            </span>
          </label>
        </div>
      </div>

      <div v-if="scope === 'survey_wise'">
        <label class="form-label">Survey *</label>
        <Select v-model="singleSurveyId" :options="surveys" optionLabel="label" optionValue="id"
          placeholder="Choose one survey" class="w-full" filter />
      </div>

      <div>
        <label class="form-label">Format</label>
        <div class="flex gap-2">
          <button v-for="f in formats" :key="f.value" type="button"
            class="flex-1 py-2 px-3 rounded-lg text-sm font-medium border transition-all"
            :class="format === f.value
              ? 'bg-slate-900 text-white border-slate-900'
              : 'bg-white text-slate-600 border-slate-200 hover:border-slate-400'"
            @click="format = f.value">{{ f.label }}</button>
        </div>
        <p class="text-xs text-slate-400 mt-1">{{ formatHint }}</p>
      </div>

      <!-- The report follows the screen: a filtered view downloads filtered
           data, and the file's header row states which filters were on. -->
      <div class="bg-slate-50 rounded-lg px-3 py-2.5 text-xs text-slate-600">
        <div class="font-semibold text-slate-700 mb-1">Active filters carried into the report</div>
        <div>Classes: {{ filters.classIds?.length ? filters.classIds.join(', ') : 'all' }}</div>
        <div>Status: {{ filters.status === 'all' ? 'any' : filters.status }}</div>
        <div>Surveys: {{ surveyScopeLabel }}</div>
        <div v-if="filters.search">Search: “{{ filters.search }}”</div>
        <div v-if="filters.activeWindowOnly">Active window surveys only</div>
      </div>

      <div v-if="error" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{{ error }}</div>
    </div>

    <template #footer>
      <Button label="Cancel" text @click="$emit('update:visible', false)" />
      <Button label="Download" icon="pi pi-download" :loading="busy" :disabled="!canDownload" @click="download" />
    </template>
  </Dialog>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useToast } from 'primevue/usetoast'
import Dialog from 'primevue/dialog'
import Button from 'primevue/button'
import Select from 'primevue/select'
import RadioButton from 'primevue/radiobutton'

import { useSurveys, INBOX_FIELD } from '../../composables/useSurveys.js'
import { downloadReport } from '../../utils/api.js'

const props = defineProps({
  visible: { type: Boolean, default: false },
  schoolId: { type: String, default: null },
  surveys: { type: Array, default: () => [] },
  // The view's live filter state — the report is generated against exactly
  // these, so what you see is what you download.
  filters: { type: Object, default: () => ({}) },
  visibleSurveyIds: { type: Array, default: () => [] },
})
defineEmits(['update:visible'])

const toast = useToast()
const { generateReport } = useSurveys()

const scopes = [
  { value: 'class_wise', label: 'Class-wise',
    hint: 'One row per student, with a status column per survey.' },
  { value: 'survey_wise', label: 'Survey-wise',
    hint: 'One survey, every student in scope, plus a per-class summary.' },
  { value: 'cumulative', label: 'Cumulative',
    hint: 'One row per class × survey with counts and completion %, plus school totals.' },
]
const formats = [{ value: 'csv', label: 'CSV' }, { value: 'xlsx', label: 'XLSX' }]

const scope = ref('class_wise')
const format = ref('csv')
const singleSurveyId = ref(null)
const busy = ref(false)
const error = ref('')

const formatHint = computed(() => {
  if (format.value === 'csv') return 'Single flat file; summary blocks are appended after the detail rows.'
  return scope.value === 'class_wise'
    ? 'One sheet per class.'
    : 'Separate sheets for detail and summary.'
})

const surveyScopeLabel = computed(() => {
  if (scope.value === 'survey_wise') {
    return props.surveys.find(s => s.id === singleSurveyId.value)?.label || 'not chosen'
  }
  return props.visibleSurveyIds.length
    ? `${props.visibleSurveyIds.length} in view`
    : 'all'
})

const canDownload = computed(() =>
  !!props.schoolId && (scope.value !== 'survey_wise' || !!singleSurveyId.value))

async function download() {
  busy.value = true
  error.value = ''
  try {
    const surveyIds = scope.value === 'survey_wise'
      ? [singleSurveyId.value]
      : props.visibleSurveyIds
    const result = await generateReport({
      schoolId: props.schoolId, scope: scope.value, format: format.value,
      surveyIds, filters: props.filters, inboxField: INBOX_FIELD,
    })
    downloadReport(result)
    toast.add({ severity: 'success', summary: 'Report ready', detail: `${result.row_count} row(s)`, life: 3000 })
    if ((result.unresolved_response_surveys || []).length) {
      toast.add({
        severity: 'warn', summary: 'Some responses not measurable',
        detail: `Completion is blank for: ${result.unresolved_response_surveys.join(', ')}`, life: 6000,
      })
    }
  } catch (e) {
    error.value = e.message || 'Could not generate the report.'
  } finally {
    busy.value = false
  }
}
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
