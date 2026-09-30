<template>
  <Dialog :visible="visible" modal :style="{ width: '480px' }" header="Download PDFs for multiple classes"
          @update:visible="onVisibilityChange">
    <p class="text-sm text-slate-600 mb-4">
      Pick as many classes as you like — every student across them who already has at
      least one AAP remark is bundled into a single zip, one PDF per child.
    </p>

    <label class="form-label">Classes</label>
    <MultiSelect
      v-model="selectedClassIds" :options="classes" optionLabel="label" optionValue="id"
      placeholder="Select classes" class="w-full" filter display="chip"
      :disabled="running" :maxSelectedLabels="3"
    />

    <div v-if="running" class="mt-4">
      <div class="text-sm text-slate-700 mb-1.5">
        {{ phase === 'zipping'
            ? `Building the PDF zip for ${collectedCount} student${collectedCount === 1 ? '' : 's'}…`
            : `Reading class ${progress.done} of ${progress.total}…` }}
      </div>
      <ProgressBar
        :value="phase === 'zipping' ? 100 : Math.round((progress.done / Math.max(progress.total, 1)) * 100)"
        :mode="phase === 'zipping' ? 'indeterminate' : 'determinate'"
        style="height:8px"
      />
    </div>

    <div v-if="error" class="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2 mt-3">{{ error }}</div>

    <template #footer>
      <Button label="Cancel" text :disabled="running" @click="close" />
      <Button label="Download" icon="pi pi-file-pdf" :loading="running"
              :disabled="!selectedClassIds.length" @click="run" />
    </template>
  </Dialog>
</template>

<script setup>
import { ref } from 'vue'
import Dialog from 'primevue/dialog'
import MultiSelect from 'primevue/multiselect'
import Button from 'primevue/button'
import ProgressBar from 'primevue/progressbar'
import { useToast } from 'primevue/usetoast'

import { classDetailRemote, listAapRemarksRemote, generateAapSummaryPdfsRemote, downloadReport } from '../../utils/api.js'

/**
 * "Download all PDFs" on the main page is scoped to whatever class is
 * currently loaded. This dialog is the cross-class version: it reads each
 * selected class's roster + remarks itself (rather than reusing
 * useAapRemarks's shared state, which would clobber whatever the page
 * behind this dialog has on screen), then makes ONE
 * generate_aap_summary_pdfs call across the union of students so the
 * result is a single zip, not one download per class.
 */
const props = defineProps({
  visible: { type: Boolean, default: false },
  schoolId: { type: String, default: null },
  classes: { type: Array, default: () => [] },
})
const emit = defineEmits(['update:visible'])

const toast = useToast()
const selectedClassIds = ref([])
const running = ref(false)
const phase = ref('scanning') // 'scanning' | 'zipping'
const progress = ref({ done: 0, total: 0 })
const collectedCount = ref(0)
const error = ref('')

function close() {
  if (running.value) return
  emit('update:visible', false)
}

function onVisibilityChange(v) {
  if (!v) close()
}

async function run() {
  error.value = ''
  running.value = true
  phase.value = 'scanning'
  progress.value = { done: 0, total: selectedClassIds.value.length }
  collectedCount.value = 0
  try {
    const studentIds = []
    for (const classId of selectedClassIds.value) {
      const detail = await classDetailRemote({ schoolId: props.schoolId, classId })
      const rosterIds = (detail.students || []).map(s => s.id)
      if (rosterIds.length) {
        const remarksByStudent = await listAapRemarksRemote({ schoolId: props.schoolId, studentIds: rosterIds })
        for (const id of rosterIds) {
          if ((remarksByStudent[id] || []).length) studentIds.push(id)
        }
      }
      progress.value = { done: progress.value.done + 1, total: progress.value.total }
      collectedCount.value = studentIds.length
    }

    if (!studentIds.length) {
      error.value = 'None of the selected classes have any generated remarks yet.'
      return
    }

    phase.value = 'zipping'
    const report = await generateAapSummaryPdfsRemote({ schoolId: props.schoolId, studentIds })
    downloadReport(report)
    toast.add({
      severity: 'success',
      summary: `Downloaded PDFs for ${studentIds.length} student${studentIds.length === 1 ? '' : 's'}`,
      detail: `Across ${selectedClassIds.value.length} class${selectedClassIds.value.length === 1 ? '' : 'es'}`,
      life: 4000,
    })
    selectedClassIds.value = []
    emit('update:visible', false)
  } catch (e) {
    console.error('Could not generate the multi-class PDF zip', e)
    error.value = e.message || 'Could not generate the PDFs'
  } finally {
    running.value = false
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
