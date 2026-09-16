<template>
  <Dialog :visible="visible" modal :style="{ width: '760px' }" header="Relate subjects to the rubric"
          @update:visible="$emit('update:visible', $event)">
    <p class="text-sm text-slate-600 mb-1">
      These subjects appear in this class's AAP survey responses, but no
      <strong>{{ stage }}</strong> rubric row matches their spelling. Until each one is
      related to a row, no comment can be written for it — the descriptor text has to
      come from somewhere.
    </p>
    <!-- Global by decision, and said plainly here: this is the one screen in
         the flow whose effect reaches past the school you are looking at. -->
    <p class="text-xs text-slate-400 mb-4">
      A mapping applies to every school, not just {{ schoolId }} — the next school whose
      survey says the same word resolves without anyone confirming it again.
    </p>

    <div v-if="!unmatched.length" class="text-sm text-slate-500 py-6 text-center">
      Every subject in this class already matches a rubric row.
    </div>

    <div v-for="row in unmatched" :key="row.subject"
         class="flex items-center gap-3 py-2.5 border-t border-slate-100">
      <div class="w-48 min-w-0">
        <div class="text-sm font-semibold text-slate-900 cell-truncate" :title="row.subject">{{ row.subject }}</div>
        <div class="text-[11px] text-slate-400">{{ row.students }} student{{ row.students === 1 ? '' : 's' }}</div>
      </div>
      <i class="pi pi-arrow-right text-xs text-slate-300"></i>
      <Select
        v-model="choices[row.subject]"
        :options="frameworkSubjects"
        placeholder="Choose the rubric row this means"
        class="flex-1" filter showClear
      />
    </div>

    <div v-if="error" class="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2 mt-3">{{ error }}</div>

    <template #footer>
      <span class="text-xs text-slate-400 mr-auto">{{ chosenCount }} of {{ unmatched.length }} chosen</span>
      <Button label="Cancel" text @click="$emit('update:visible', false)" />
      <Button
        label="Save mappings" icon="pi pi-check"
        :loading="saving" :disabled="!chosenCount" @click="save"
      />
    </template>
  </Dialog>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { useToast } from 'primevue/usetoast'
import Dialog from 'primevue/dialog'
import Select from 'primevue/select'
import Button from 'primevue/button'

import { useAapRemarks } from '../../composables/useAapRemarks.js'

/**
 * The answer to "this subject has no framework data".
 *
 * Deliberately a confirmation, never a guess: the function's matcher already
 * tries the label, its alternatives and a plural relaxation, and anything that
 * reaches this dialog is a spelling no rule could resolve. Picking the row for
 * it decides which rubric text ends up on a child's report card, so a person
 * makes that call — and once made it is remembered.
 */
const props = defineProps({
  visible: { type: Boolean, default: false },
  schoolId: { type: String, default: '' },
  stage: { type: String, default: '' },
  unmatched: { type: Array, default: () => [] },       // [{ subject, students }]
  frameworkSubjects: { type: Array, default: () => [] },
})
const emit = defineEmits(['update:visible', 'saved'])

const toast = useToast()
const { saveSubjectMapping } = useAapRemarks()

const choices = ref({})
const saving = ref(false)
const error = ref('')

// Reopening starts clean rather than showing choices from a class you have
// since navigated away from.
watch(() => props.visible, (open) => {
  if (open) { choices.value = {}; error.value = '' }
})

const chosen = computed(() =>
  Object.entries(choices.value).filter(([, label]) => !!label))
const chosenCount = computed(() => chosen.value.length)

async function save() {
  saving.value = true
  error.value = ''
  try {
    for (const [token, frameworkSubject] of chosen.value) {
      await saveSubjectMapping({ stage: props.stage, token, frameworkSubject })
    }
    const mapped = chosen.value.map(([token]) => token)
    toast.add({
      severity: 'success',
      summary: `${mapped.length} subject${mapped.length === 1 ? '' : 's'} related`,
      detail: 'Generate again to write comments for them',
      life: 4000,
    })
    emit('saved', mapped)
    emit('update:visible', false)
  } catch (e) {
    console.error('Could not save subject mappings', e)
    error.value = e.message || 'Could not save the mappings'
  } finally {
    saving.value = false
  }
}
</script>
