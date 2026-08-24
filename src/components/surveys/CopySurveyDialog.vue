<template>
  <Dialog
    :visible="visible" @update:visible="close"
    header="Copy surveys from another school"
    modal :style="{ width: '680px' }" :closable="!copying"
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
        <div class="flex items-center justify-between mb-1.5">
          <label class="form-label mb-0">Surveys to copy</label>
          <button v-if="sourceSurveys.length" type="button" class="text-xs text-violet-600 hover:underline"
            @click="toggleAll">{{ allSelected ? 'Clear all' : 'Select all' }}</button>
        </div>
        <div v-if="loadingSurveys" class="text-sm text-slate-400 py-2">Loading surveys…</div>
        <div v-else-if="!sourceSurveys.length" class="text-sm text-slate-400 py-2">
          No real surveys found for this school.
        </div>

        <div v-else class="border border-slate-200 rounded-lg divide-y divide-slate-100 max-h-64 overflow-auto">
          <div v-for="s in sourceSurveys" :key="s.id" class="p-2.5">
            <label class="flex items-start gap-2 cursor-pointer">
              <Checkbox v-model="selectedIds" :value="s.id" class="mt-0.5" />
              <div class="min-w-0 flex-1">
                <div class="text-sm font-medium text-slate-800">{{ s.label }}</div>
                <div class="text-xs text-slate-500">{{ s.questionCount }} question(s) · {{ windowLabel(s) }}</div>
              </div>
            </label>

            <!-- Per-survey target id, only shown once picked — most copies
                 keep the source id, so this stays out of the way otherwise. -->
            <div v-if="selectedIds.includes(s.id)" class="mt-2 ml-6 flex items-center gap-2">
              <span class="text-xs text-slate-400 whitespace-nowrap">ID in {{ targetSchoolName }}</span>
              <InputText v-model="targetIds[s.id]" class="font-mono text-xs" style="max-width:220px"
                @update:modelValue="idsChecked = false" />
              <span v-if="idsChecked && collisions[s.id]" class="text-xs text-amber-700 whitespace-nowrap">
                <i class="pi pi-exclamation-triangle text-xs mr-0.5"></i>will overwrite
              </span>
            </div>
          </div>
        </div>
      </div>

      <div v-if="formError" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{{ formError }}</div>
      <div v-if="progress.total" class="text-sm text-slate-500">
        Copying {{ progress.done }} / {{ progress.total }}…
      </div>
    </div>

    <template #footer>
      <Button label="Cancel" text :disabled="copying" @click="close" />
      <Button
        :label="`Copy ${selectedIds.length || ''} survey${selectedIds.length !== 1 ? 's' : ''}`" icon="pi pi-copy"
        :disabled="!selectedIds.length || !allTargetIdsFilled" :loading="copying"
        @click="confirmCopy"
      />
    </template>
    <ConfirmDialog />
  </Dialog>
</template>

<script setup>
import { ref, reactive, computed, watch } from 'vue'
import { getDoc, getDocs, writeBatch } from 'firebase/firestore'
import { useConfirm } from 'primevue/useconfirm'
import { useToast } from 'primevue/usetoast'
import Dialog from 'primevue/dialog'
import Select from 'primevue/select'
import Checkbox from 'primevue/checkbox'
import InputText from 'primevue/inputtext'
import Button from 'primevue/button'
import ConfirmDialog from 'primevue/confirmdialog'

import { surveysCollection, surveyDoc } from '../../firebase/schoolCollections.js'
import { db } from '../../firebase/config'

/**
 * Copies one or more survey docs, verbatim, from a source school into the
 * currently selected (target) school — each under its own new/reused doc id.
 * Independent duplicates: nothing links a copy back to its source
 * afterward, so editing one never touches another. See CloneSchoolTab.vue
 * for the same pattern at whole-school scope.
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
const selectedIds = ref([])
const targetIds = reactive({}) // sourceId -> target survey id
const idsChecked = ref(false)
const collisions = reactive({}) // sourceId -> bool (target id already exists)
const formError = ref('')
const copying = ref(false)
const progress = reactive({ total: 0, done: 0 })
let sourceDocsById = {}

const sourceSchoolOptions = computed(() =>
  props.schools.filter(s => s.id !== props.targetSchoolId))

const allSelected = computed(() =>
  sourceSurveys.value.length > 0 && selectedIds.value.length === sourceSurveys.value.length)

const allTargetIdsFilled = computed(() =>
  selectedIds.value.every(id => (targetIds[id] || '').trim()))

function toggleAll() {
  selectedIds.value = allSelected.value ? [] : sourceSurveys.value.map(s => s.id)
}

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
    // Default: every real survey selected, target id = source id — copying
    // "the standard set" as-is is the common case, per-row edits are the
    // exception.
    selectedIds.value = sourceSurveys.value.map(s => s.id)
    sourceSurveys.value.forEach(s => { targetIds[s.id] = s.id })
  } catch (e) {
    formError.value = e.message || 'Could not load surveys for that school.'
  } finally {
    loadingSurveys.value = false
  }
}

watch(sourceSchoolId, (id) => {
  selectedIds.value = []
  Object.keys(targetIds).forEach(k => delete targetIds[k])
  idsChecked.value = false
  if (id) loadSourceSurveys(id)
})

async function confirmCopy() {
  formError.value = ''
  idsChecked.value = true
  Object.keys(collisions).forEach(k => delete collisions[k])

  await Promise.all(selectedIds.value.map(async (sourceId) => {
    const targetId = (targetIds[sourceId] || '').trim()
    const snap = await getDoc(surveyDoc(props.targetSchoolId, targetId))
    collisions[sourceId] = snap.exists()
  }))

  const overwriteCount = selectedIds.value.filter(id => collisions[id]).length
  const message = overwriteCount
    ? `Copy ${selectedIds.value.length} survey(s) into ${props.targetSchoolName}? ${overwriteCount} will overwrite an existing survey with the same ID.`
    : `Copy ${selectedIds.value.length} survey(s) into ${props.targetSchoolName}?`

  confirm.require({
    message, header: 'Copy surveys', icon: 'pi pi-exclamation-triangle',
    rejectLabel: 'Cancel', acceptLabel: overwriteCount ? 'Overwrite & copy' : 'Copy',
    accept: runCopy,
  })
}

async function runCopy() {
  copying.value = true
  formError.value = ''
  progress.total = selectedIds.value.length
  progress.done = 0
  try {
    const batch = writeBatch(db)
    const copiedIds = []
    for (const sourceId of selectedIds.value) {
      const targetId = targetIds[sourceId].trim()
      const sourceData = sourceDocsById[sourceId]
      batch.set(surveyDoc(props.targetSchoolId, targetId), { ...sourceData, id: targetId })
      copiedIds.push(targetId)
    }
    await batch.commit()
    progress.done = progress.total
    toast.add({
      severity: 'success', summary: 'Surveys copied',
      detail: `${copiedIds.length} survey(s) copied into ${props.targetSchoolName}`, life: 4000,
    })
    emit('copied', { ids: copiedIds })
    close()
  } catch (e) {
    formError.value = e.message || 'Could not copy these surveys — nothing was changed.'
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
  selectedIds.value = []
  Object.keys(targetIds).forEach(k => delete targetIds[k])
  Object.keys(collisions).forEach(k => delete collisions[k])
  formError.value = ''
  idsChecked.value = false
  progress.total = 0
  progress.done = 0
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
