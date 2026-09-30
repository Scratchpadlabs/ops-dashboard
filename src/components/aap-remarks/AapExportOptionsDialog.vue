<template>
  <Dialog :visible="visible" modal :style="{ width: '480px' }" header="Export options"
          @update:visible="onVisibilityChange">
    <label class="form-label">Header columns</label>
    <MultiSelect
      v-model="selectedHeaders" :options="headerOptions" optionLabel="label" optionValue="value"
      class="w-full mb-4" display="chip" :showToggleAll="false"
    />

    <label class="form-label">Subjects</label>
    <div class="flex items-center gap-2 mb-2">
      <Checkbox v-model="allSubjects" binary inputId="aapExportAllSubjects" />
      <label for="aapExportAllSubjects" class="text-sm text-slate-700 cursor-pointer">
        All subjects ({{ subjects.length }})
      </label>
    </div>
    <MultiSelect
      v-if="!allSubjects"
      v-model="pickedSubjects" :options="subjects"
      class="w-full" display="chip" filter placeholder="Choose subjects"
    />

    <div v-if="error" class="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2 mt-3">{{ error }}</div>

    <template #footer>
      <Button label="Cancel" text @click="close" />
      <Button label="Export CSV" icon="pi pi-download" outlined @click="doExport('csv')" />
      <Button label="Export XLSX" icon="pi pi-file-excel" @click="doExport('xlsx')" />
    </template>
  </Dialog>
</template>

<script setup>
import { ref, watch } from 'vue'
import Dialog from 'primevue/dialog'
import MultiSelect from 'primevue/multiselect'
import Checkbox from 'primevue/checkbox'
import Button from 'primevue/button'

import { IDENTITY_COLUMNS } from '../../utils/aapExport.js'

/**
 * Lets a reviewer trim the export before it downloads: which identity
 * columns (Student / Roll No / Student ID) show up, and whether every
 * subject in the class goes in or just a chosen few. Both Export CSV and
 * Export XLSX on the main toolbar open this instead of downloading
 * straight away.
 */
const props = defineProps({
  visible: { type: Boolean, default: false },
  subjects: { type: Array, default: () => [] },
})
const emit = defineEmits(['update:visible', 'export'])

const headerOptions = IDENTITY_COLUMNS.map(c => ({ label: c, value: c }))
const selectedHeaders = ref([...IDENTITY_COLUMNS])
const allSubjects = ref(true)
const pickedSubjects = ref([])
const error = ref('')

// Reopening with a different class's subject list shouldn't carry over a
// stale pick from the last one.
watch(() => props.visible, (v) => {
  if (v) {
    pickedSubjects.value = []
    allSubjects.value = true
    error.value = ''
  }
})

function close() {
  emit('update:visible', false)
}

function onVisibilityChange(v) {
  if (!v) close()
}

function doExport(format) {
  if (!selectedHeaders.value.length) {
    error.value = 'Pick at least one header column.'
    return
  }
  if (!allSubjects.value && !pickedSubjects.value.length) {
    error.value = 'Pick at least one subject, or choose "All subjects".'
    return
  }
  error.value = ''
  emit('export', {
    format,
    identityColumns: IDENTITY_COLUMNS.filter(c => selectedHeaders.value.includes(c)),
    subjects: allSubjects.value ? null : pickedSubjects.value,
  })
  close()
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
