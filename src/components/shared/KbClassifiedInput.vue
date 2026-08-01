<template>
  <div>
    <InputText
      :modelValue="modelValue"
      @update:modelValue="onInput"
      @blur="onBlur"
      class="w-full"
      :class="inputClass"
      :placeholder="placeholder"
      :disabled="disabled"
    />

    <!-- HIGH — normalized silently on blur; this is just the receipt. -->
    <div v-if="state === 'high'" class="flex items-center gap-1.5 mt-1 text-xs text-slate-500">
      <i class="pi pi-check-circle text-green-500 text-xs"></i>
      <span class="font-medium text-slate-600">{{ typeLabel(result.type) }}</span>
      <span v-if="normalizedFrom" class="text-slate-400">· read “{{ normalizedFrom }}” as <b class="text-slate-600">{{ result.canonical }}</b></span>
    </div>

    <!-- MEDIUM — a near match. Offered, never applied on its own. -->
    <div v-else-if="state === 'medium'" class="flex items-center gap-2 mt-1.5 flex-wrap">
      <span class="text-xs text-slate-500">Did you mean</span>
      <button
        type="button"
        class="px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-800 hover:bg-amber-200 transition-colors"
        @click="accept(result.type, result.canonical)"
      >{{ result.canonical }} <span class="opacity-70">· {{ typeLabel(result.type) }}</span></button>
      <button
        v-for="alt in result.alternatives"
        :key="alt.canonical"
        type="button"
        class="px-2 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-600 hover:bg-slate-200 transition-colors"
        @click="accept(alt.type, alt.canonical)"
      >{{ alt.canonical }}</button>
      <button type="button" class="text-xs text-slate-400 hover:text-slate-600" @click="dismiss">Keep as typed</button>
    </div>

    <!-- UNKNOWN — deterministic KB has never seen it. Offer the one LLM call. -->
    <div v-else-if="state === 'unknown'" class="mt-1.5">
      <div class="flex items-center gap-2 flex-wrap">
        <span class="text-xs text-slate-400">
          <i class="pi pi-question-circle text-xs mr-0.5"></i>Not in the knowledge base
        </span>
        <Button
          v-if="!asking && !suggestion"
          label="Classify with AI" icon="pi pi-sparkles" text size="small"
          @click="askLLM"
        />
        <span v-if="asking" class="text-xs text-slate-400"><i class="pi pi-spin pi-spinner text-xs mr-1"></i>Asking…</span>
      </div>

      <!-- The model answered. It is a SUGGESTION: nothing is stored until
           this is confirmed, and confirming is what teaches the KB. -->
      <div v-if="suggestion" class="mt-2 border border-slate-200 rounded-lg p-2.5 bg-slate-50">
        <div v-if="suggestion.source === 'unavailable'" class="text-xs text-slate-500 mb-2">
          {{ suggestion.reason || 'No suggestion available' }} — set the type yourself to remember it.
        </div>
        <div v-else class="text-xs text-slate-600 mb-2">
          <b>Suggested:</b> {{ typeLabel(confirmType) }}<span v-if="confirmCanonical"> · {{ confirmCanonical }}</span>
          <div v-if="suggestion.reason" class="text-slate-400 mt-0.5">{{ suggestion.reason }}</div>
        </div>
        <div class="flex items-center gap-2 flex-wrap">
          <Select
            v-model="confirmType" :options="typeOptions" optionLabel="label" optionValue="value"
            class="w-48" size="small"
          />
          <InputText
            v-if="confirmType !== OTHER"
            v-model="confirmCanonical" class="w-40" placeholder="Canonical form" size="small"
          />
          <Button label="Confirm & remember" size="small" :loading="confirming" @click="confirm" />
          <Button label="Not now" text size="small" @click="dismiss" />
        </div>
        <p class="text-[11px] text-slate-400 mt-2">
          Confirming teaches this to every school — imports and School Setup stop asking about “{{ modelValue }}” for good.
        </p>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import InputText from 'primevue/inputtext'
import Button from 'primevue/button'
import Select from 'primevue/select'
import { useToast } from 'primevue/usetoast'
import { useEducationKB } from '../../composables/useEducationKB.js'
import { TYPE_LABELS, SUBJECT, COSCHOLASTIC, GRADE, SECTION, OTHER, UNKNOWN } from '../../utils/educationKB.js'

/**
 * A text input that UNDERSTANDS what it is being given.
 *
 * The three confidence bands the task calls for, in one place so every
 * School Setup surface behaves identically:
 *   high    -> normalize + categorize silently on blur (canonical shown,
 *              what was typed reported to the parent via @classified)
 *   medium  -> inline suggestion chip, one-click accept
 *   unknown -> one LLM call on request, answer shown as a suggestion, and
 *              only a human confirming it writes to the knowledge base
 */
const props = defineProps({
  modelValue: { type: String, default: '' },
  // Context hint that breaks genuine ties ('Art' the house name vs Art &
  // Craft the activity). Pass what the field is FOR.
  expect: { type: String, default: null },
  // Human-readable origin, sent to the classifier for context and never
  // used for anything else, e.g. 'the Subjects list in School Setup'.
  context: { type: String, default: '' },
  placeholder: { type: String, default: '' },
  disabled: { type: Boolean, default: false },
  // Restricts which families the confirm dropdown offers.
  allowedTypes: { type: Array, default: () => [SUBJECT, COSCHOLASTIC, GRADE, SECTION, OTHER] },
})
const emit = defineEmits(['update:modelValue', 'classified'])

const toast = useToast()
const { loadKB, classify, classifyWithLLM, confirmClassification } = useEducationKB()

const result = ref({ type: UNKNOWN, canonical: null, confidence: 0, source: 'none', alternatives: [] })
const dismissed = ref(false)
const asking = ref(false)
const suggestion = ref(null)
const confirming = ref(false)
const confirmType = ref(SUBJECT)
const confirmCanonical = ref('')
const normalizedFrom = ref('')

const typeOptions = computed(() =>
  props.allowedTypes.map(v => ({ value: v, label: TYPE_LABELS[v] || v })))

function typeLabel(t) { return TYPE_LABELS[t] || t }

const state = computed(() => {
  if (dismissed.value || !props.modelValue?.trim()) return 'none'
  if (result.value.type === OTHER) return 'none'
  if (result.value.type === UNKNOWN) return 'unknown'
  if (result.value.confidence >= 0.95) return 'high'
  if (result.value.confidence >= 0.80) return 'medium'
  return 'unknown'
})

const inputClass = computed(() => ({
  'ring-1 ring-amber-300 rounded-lg': state.value === 'medium',
}))

function reclassify() {
  result.value = classify(props.modelValue, props.expect)
}

function onInput(v) {
  emit('update:modelValue', v ?? '')
  dismissed.value = false
  suggestion.value = null
  normalizedFrom.value = ''
  reclassify()
}

// Normalizing on blur rather than per keystroke — rewriting the field while
// someone is still typing into it is hostile ("Eng" -> "English" mid-word).
function onBlur() {
  reclassify()
  const r = result.value
  if (state.value === 'high' && r.canonical && r.canonical !== props.modelValue.trim()) {
    normalizedFrom.value = props.modelValue.trim()
    emit('update:modelValue', r.canonical)
  }
  if (state.value === 'high') emitClassified(r.type, r.canonical)
}

function emitClassified(type, canonical) {
  emit('classified', { type, canonical, original: normalizedFrom.value || props.modelValue.trim() })
}

function accept(type, canonical) {
  normalizedFrom.value = props.modelValue.trim()
  emit('update:modelValue', canonical)
  result.value = { ...result.value, type, canonical, confidence: 1 }
  emitClassified(type, canonical)
}

function dismiss() {
  dismissed.value = true
  suggestion.value = null
}

async function askLLM() {
  asking.value = true
  try {
    const r = await classifyWithLLM(props.modelValue, { context: props.context })
    suggestion.value = r
    confirmType.value = props.allowedTypes.includes(r.type) ? r.type : (props.allowedTypes[0] || OTHER)
    confirmCanonical.value = r.canonical || props.modelValue.trim()
  } catch (e) {
    toast.add({ severity: 'error', summary: 'Could not classify', detail: e.message, life: 4000 })
  } finally {
    asking.value = false
  }
}

async function confirm() {
  confirming.value = true
  try {
    const typed = props.modelValue.trim()
    const canonical = confirmType.value === OTHER ? '' : (confirmCanonical.value.trim() || typed)
    await confirmClassification(typed, confirmType.value, canonical, { source: 'school_setup' })
    if (canonical && canonical !== typed) {
      normalizedFrom.value = typed
      emit('update:modelValue', canonical)
    }
    suggestion.value = null
    reclassify()
    emitClassified(confirmType.value, canonical)
    toast.add({ severity: 'success', summary: 'Learned', detail: `“${typed}” is now known to every school`, life: 3000 })
  } catch (e) {
    toast.add({ severity: 'error', summary: 'Could not save', detail: e.message, life: 4000 })
  } finally {
    confirming.value = false
  }
}

watch(() => props.modelValue, reclassify)
onMounted(async () => { await loadKB(); reclassify() })
</script>
