<template>
  <Dialog
    :visible="visible" @update:visible="close"
    header="Survey details" modal :style="{ width: '680px' }" :closable="!saving"
  >
    <div v-if="loading" class="py-10 text-center text-sm text-slate-400">Loading…</div>

    <div v-else-if="loadError" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{{ loadError }}</div>

    <div v-else-if="survey" class="space-y-5 pt-1">
      <!-- ── Editable ────────────────────────────────────────────────────── -->
      <div>
        <label class="form-label">Name</label>
        <div class="grid grid-cols-3 gap-2">
          <InputText v-model="form.name.en" placeholder="English" />
          <InputText v-model="form.name.hi" placeholder="Hindi" />
          <InputText v-model="form.name.mr" placeholder="Marathi" />
        </div>
      </div>

      <div class="grid grid-cols-2 gap-4">
        <div>
          <label class="form-label">Start date</label>
          <DatePicker v-model="form.startAt" class="w-full" showIcon dateFormat="d M yy" :showTime="false" />
        </div>
        <div>
          <label class="form-label">End date</label>
          <DatePicker v-model="form.expiresAt" class="w-full" showIcon dateFormat="d M yy" :showTime="false" />
        </div>
      </div>

      <div v-if="saveError" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{{ saveError }}</div>

      <!-- ── Read-only ───────────────────────────────────────────────────── -->
      <div class="border-t border-slate-200 pt-4 space-y-3">
        <div class="text-xs font-semibold text-slate-400 uppercase tracking-wide">View only</div>

        <div v-if="localeText(survey.card_desc)">
          <div class="text-xs text-slate-400 mb-0.5">Card description</div>
          <div class="text-sm text-slate-700">{{ localeText(survey.card_desc) }}</div>
        </div>
        <div v-if="localeText(survey.desc)">
          <div class="text-xs text-slate-400 mb-0.5">Description</div>
          <div class="text-sm text-slate-700 whitespace-pre-line">{{ localeText(survey.desc) }}</div>
        </div>
        <div v-if="localeText(survey.parameter)">
          <div class="text-xs text-slate-400 mb-0.5">Parameter</div>
          <div class="text-sm text-slate-700">{{ localeText(survey.parameter) }}</div>
        </div>
        <div v-if="survey.card_image" class="flex items-center gap-2">
          <img :src="survey.card_image" alt="" class="w-10 h-10 rounded object-cover border border-slate-200" />
          <a :href="survey.card_image" target="_blank" rel="noopener" class="text-xs text-violet-600 hover:underline">Open image</a>
        </div>
        <div class="text-xs text-slate-400">
          <span v-if="survey.clazzId">clazzId: <span class="font-mono text-slate-600">{{ survey.clazzId }}</span></span>
          <span v-if="survey.isLiveInternal !== undefined" class="ml-3">
            isLiveInternal: <span class="font-mono text-slate-600">{{ String(survey.isLiveInternal) }}</span>
          </span>
        </div>

        <div v-if="questions.length" class="space-y-2">
          <div class="text-xs text-slate-400 mb-1.5">{{ questions.length }} question(s)</div>
          <div v-for="(q, i) in questions" :key="i" class="border border-slate-200 rounded-lg p-2.5">
            <div class="text-sm font-medium text-slate-800">{{ questionHeader(q, i) }}</div>
            <div v-if="q.options && q.options.length" class="mt-1.5 space-y-1">
              <div v-for="(opt, j) in q.options" :key="j" class="text-sm text-slate-600 flex items-start gap-1.5">
                <span class="text-slate-300">•</span>
                <span>{{ optionText(opt) }}</span>
              </div>
            </div>
            <div v-else class="text-xs text-slate-400 mt-1">No options on this question.</div>
          </div>
        </div>
      </div>
    </div>

    <template #footer>
      <Button label="Close" text :disabled="saving" @click="close" />
      <Button v-if="survey" label="Save" icon="pi pi-check" :loading="saving" @click="save" />
    </template>
  </Dialog>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { getDoc, updateDoc, Timestamp } from 'firebase/firestore'
import { useToast } from 'primevue/usetoast'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import DatePicker from 'primevue/datepicker'
import Button from 'primevue/button'

import { surveyDoc } from '../../firebase/schoolCollections.js'

/**
 * View + edit one survey doc. Editable: name (per-locale) and the
 * startAt/expiresAt window — the only fields the user asked to change.
 * Everything else (desc, card copy, parameter, questions/options) is
 * rendered read-only; there's no editor for it here.
 */
const props = defineProps({
  visible: { type: Boolean, default: false },
  schoolId: { type: String, default: null },
  surveyId: { type: String, default: null },
})
const emit = defineEmits(['update:visible', 'saved'])

const toast = useToast()

const loading = ref(false)
const loadError = ref('')
const saving = ref(false)
const saveError = ref('')
const survey = ref(null)
const form = ref({ name: { en: '', hi: '', mr: '' }, startAt: null, expiresAt: null })

const questions = computed(() => Array.isArray(survey.value?.questions) ? survey.value.questions : [])

function localeText(m) {
  if (!m || typeof m !== 'object') return ''
  return m.en || Object.values(m).find(v => String(v || '').trim()) || ''
}
function questionHeader(q, i) {
  return `${i + 1}. ${localeText(q.text) || q.text || q.question || `Question ${i + 1}`}`
}
function optionText(opt) {
  if (typeof opt === 'string') return opt
  return localeText(opt.text) || opt.label || opt.value || JSON.stringify(opt)
}

// Firestore stores startAt/expiresAt as Timestamp values (functions/assign_survey
// converts them to millis for the matrix API specifically because the raw field
// isn't already millis) — convert to/from JS Date at the edges rather than
// passing raw numbers around, or writes here would silently corrupt the type
// that in_active_window() and the matrix's window dot both depend on.
function toDate(v) {
  return v?.toDate ? v.toDate() : (typeof v === 'number' ? new Date(v) : null)
}

async function load() {
  loading.value = true
  loadError.value = ''
  survey.value = null
  try {
    const snap = await getDoc(surveyDoc(props.schoolId, props.surveyId))
    if (!snap.exists()) { loadError.value = 'This survey no longer exists.'; return }
    survey.value = snap.data()
    form.value = {
      name: { en: survey.value.name?.en || '', hi: survey.value.name?.hi || '', mr: survey.value.name?.mr || '' },
      startAt: toDate(survey.value.startAt),
      expiresAt: toDate(survey.value.expiresAt),
    }
  } catch (e) {
    loadError.value = e.message || 'Could not load this survey.'
  } finally {
    loading.value = false
  }
}

async function save() {
  saving.value = true
  saveError.value = ''
  try {
    await updateDoc(surveyDoc(props.schoolId, props.surveyId), {
      name: { ...survey.value.name, ...form.value.name },
      startAt: form.value.startAt ? Timestamp.fromDate(form.value.startAt) : null,
      expiresAt: form.value.expiresAt ? Timestamp.fromDate(form.value.expiresAt) : null,
    })
    toast.add({ severity: 'success', summary: 'Survey updated', life: 3000 })
    emit('saved')
    close()
  } catch (e) {
    saveError.value = e.message || 'Could not save these changes.'
  } finally {
    saving.value = false
  }
}

function close() {
  emit('update:visible', false)
}

watch(() => props.visible, (v) => {
  if (v && props.schoolId && props.surveyId) load()
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
