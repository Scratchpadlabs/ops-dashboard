<template>
  <Dialog
    :visible="visible" @update:visible="close"
    header="Copy survey from another school"
    modal :style="{ width: '640px' }" :closable="!copying"
  >
    <div class="space-y-4 pt-1">
      <div>
        <label class="form-label">Source school</label>
        <Select
          v-model="sourceSchoolId" :options="sourceSchoolOptions" optionLabel="name" optionValue="id"
          placeholder="Pick a school to copy from" class="w-full" filter :loading="loadingSurveys"
        />
      </div>

      <div v-if="sourceSchoolId">
        <label class="form-label">Survey</label>
        <div v-if="loadingSurveys" class="text-sm text-slate-400 py-2">Loading surveys…</div>
        <div v-else-if="!sourceSurveys.length" class="text-sm text-slate-400 py-2">
          No real surveys found for this school.
        </div>
        <Select
          v-else v-model="selectedSurveyId" :options="sourceSurveys" optionLabel="label" optionValue="id"
          placeholder="Pick a survey" class="w-full" filter
        />
      </div>

      <div v-if="selectedSurvey" class="border border-slate-200 rounded-lg p-3 bg-slate-50 space-y-1">
        <div class="text-sm font-semibold text-slate-800">{{ selectedSurvey.label }}</div>
        <div class="text-xs text-slate-500">{{ selectedSurvey.questionCount }} question(s) · {{ windowLabel(selectedSurvey) }}</div>
      </div>

      <div v-if="selectedSurvey">
        <label class="form-label">New survey ID in {{ targetSchoolName }}</label>
        <InputText v-model="targetSurveyId" class="w-full font-mono text-sm" @update:modelValue="idChecked = false" />
        <div v-if="idChecked && idExists" class="text-xs text-amber-700 mt-1">
          <i class="pi pi-exclamation-triangle text-xs mr-1"></i>
          A survey with this ID already exists in {{ targetSchoolName }} — copying will overwrite it.
        </div>
      </div>

      <div v-if="formError" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{{ formError }}</div>
    </div>

    <template #footer>
      <Button label="Cancel" text :disabled="copying" @click="close" />
      <Button
        label="Copy survey" icon="pi pi-copy"
        :disabled="!selectedSurvey || !targetSurveyId.trim()" :loading="copying"
        @click="confirmCopy"
      />
    </template>
    <ConfirmDialog />
  </Dialog>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { getDoc, getDocs, setDoc } from 'firebase/firestore'
import { useConfirm } from 'primevue/useconfirm'
import { useToast } from 'primevue/usetoast'
import Dialog from 'primevue/dialog'
import Select from 'primevue/select'
import InputText from 'primevue/inputtext'
import Button from 'primevue/button'
import ConfirmDialog from 'primevue/confirmdialog'

import { surveysCollection, surveyDoc } from '../../firebase/schoolCollections.js'

/**
 * Copies one survey doc, verbatim, from a source school into the currently
 * selected (target) school under a new/reused doc id. An independent
 * duplicate — nothing links the copy back to its source afterward, so
 * editing either one never touches the other. See CloneSchoolTab.vue for
 * the same pattern at whole-school scope.
 */
const props = defineProps({
  visible: { type: Boolean, default: false },
  targetSchoolId: { type: String, default: null },
  targetSchoolName: { type: String, default: '' },
  schools: { type: Array, default: () => [] }, // [{id, name}], already loaded by useSurveys
})
const emit = defineEmits(['update:visible', 'copied'])

const confirm = useConfirm()
const toast = useToast()

const sourceSchoolId = ref(null)
const sourceSurveys = ref([])
const loadingSurveys = ref(false)
const selectedSurveyId = ref(null)
const targetSurveyId = ref('')
const idChecked = ref(false)
const idExists = ref(false)
const formError = ref('')
const copying = ref(false)
let sourceDocsById = {}

const sourceSchoolOptions = computed(() =>
  props.schools.filter(s => s.id !== props.targetSchoolId))

const selectedSurvey = computed(() =>
  sourceSurveys.value.find(s => s.id === selectedSurveyId.value) || null)

function windowLabel(s) {
  const fmt = (ms) => ms ? new Date(ms).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : null
  const a = fmt(s.startAt), b = fmt(s.expiresAt)
  if (!a && !b) return 'no date window'
  return `${a || '…'} – ${b || '…'}`
}

// Structural "is this a real survey" check, mirroring is_real_survey() in
// functions/assign_survey/survey_rules.py — hides the zzzz... test docs and
// bootstrap stubs that otherwise clutter the picker.
function isRealSurvey(data) {
  const name = data?.name
  const hasName = name && typeof name === 'object' && Object.values(name).some(v => String(v || '').trim())
  const questions = data?.questions
  return hasName && Array.isArray(questions) && questions.length > 0
}

function toMillis(v) {
  return v?.toMillis ? v.toMillis() : (typeof v === 'number' ? v : null)
}

async function loadSourceSurveys(schoolId) {
  loadingSurveys.value = true
  sourceSurveys.value = []
  sourceDocsById = {}
  try {
    const snap = await getDocs(surveysCollection(schoolId))
    const real = snap.docs.filter(d => isRealSurvey(d.data()))
    sourceDocsById = Object.fromEntries(real.map(d => [d.id, d.data()]))
    sourceSurveys.value = real.map(d => {
      const data = d.data()
      return {
        id: d.id,
        label: data.name?.en || d.id,
        questionCount: (data.questions || []).length,
        startAt: toMillis(data.startAt),
        expiresAt: toMillis(data.expiresAt),
      }
    }).sort((a, b) => a.label.localeCompare(b.label))
  } catch (e) {
    formError.value = e.message || 'Could not load surveys for that school.'
  } finally {
    loadingSurveys.value = false
  }
}

watch(sourceSchoolId, (id) => {
  selectedSurveyId.value = null
  targetSurveyId.value = ''
  if (id) loadSourceSurveys(id)
})
watch(selectedSurveyId, (id) => {
  targetSurveyId.value = id || ''
  idChecked.value = false
})

async function confirmCopy() {
  formError.value = ''
  const newId = targetSurveyId.value.trim()
  if (!newId) { formError.value = 'A target survey ID is required.'; return }

  idChecked.value = true
  const targetSnap = await getDoc(surveyDoc(props.targetSchoolId, newId))
  idExists.value = targetSnap.exists()

  const message = idExists.value
    ? `A survey "${newId}" already exists in ${props.targetSchoolName}. Overwrite it with the copy of "${selectedSurvey.value.label}"?`
    : `Copy "${selectedSurvey.value.label}" into ${props.targetSchoolName} as "${newId}"?`

  confirm.require({
    message, header: 'Copy survey', icon: 'pi pi-exclamation-triangle',
    rejectLabel: 'Cancel', acceptLabel: idExists.value ? 'Overwrite' : 'Copy',
    accept: runCopy,
  })
}

async function runCopy() {
  copying.value = true
  formError.value = ''
  try {
    const newId = targetSurveyId.value.trim()
    const sourceData = sourceDocsById[selectedSurveyId.value]
    await setDoc(surveyDoc(props.targetSchoolId, newId), { ...sourceData, id: newId })
    toast.add({ severity: 'success', summary: 'Survey copied', detail: `${newId} in ${props.targetSchoolName}`, life: 4000 })
    emit('copied', { id: newId })
    close()
  } catch (e) {
    formError.value = e.message || 'Could not copy the survey.'
  } finally {
    copying.value = false
  }
}

function close() {
  emit('update:visible', false)
}

watch(() => props.visible, (v) => {
  if (v) return
  sourceSchoolId.value = null
  sourceSurveys.value = []
  selectedSurveyId.value = null
  targetSurveyId.value = ''
  formError.value = ''
  idChecked.value = false
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
