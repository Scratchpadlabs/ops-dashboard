<template>
  <div>
    <div class="bg-white rounded-xl border border-slate-200 p-4 mb-4">
      <div class="flex items-end gap-3 flex-wrap">
        <div>
          <label class="form-label">School</label>
          <Select
            v-model="schoolId" :options="schools" optionLabel="name" optionValue="id"
            placeholder="Select a school" class="w-72" :loading="loadingSchools" filter
          />
        </div>
        <Button
          label="Check completion" icon="pi pi-search" :loading="running"
          :disabled="!schoolId" @click="run"
        />
        <Button
          label="Download Excel" icon="pi pi-file-excel" outlined
          :disabled="!rows.length" @click="downloadXlsx"
        />
        <div v-if="rows.length" class="text-xs text-slate-400 ml-auto pb-2">
          {{ rows.length }} class/subject/topic row{{ rows.length === 1 ? '' : 's' }} · scanned whole school
        </div>
      </div>
      <p class="text-xs text-slate-400 mt-3">
        Whole-school scan: cross-references school-setup's subjects/topics, every AAP survey
        response, and each class's roster. A subject/topic with no response yet is "Not started";
        one with a response but gaps for some students/questions is "Partial".
      </p>
    </div>

    <div v-if="runError" class="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-4 py-3 mb-4">
      {{ runError }}
    </div>

    <div v-if="result && (result.unmatchedSubjectTokens?.length || result.unparsedResponses)"
         class="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 mb-4 text-sm text-amber-900">
      <div v-if="result.unmatchedSubjectTokens?.length">
        <i class="pi pi-exclamation-triangle mr-1.5"></i>
        Survey subject token{{ result.unmatchedSubjectTokens.length === 1 ? '' : 's' }} that matched no
        school-setup subject: <span class="font-semibold">{{ result.unmatchedSubjectTokens.join(', ') }}</span>
        — rows for these still show below under the raw token, but they aren't counted against the
        school-setup subject they were probably meant to be.
      </div>
      <div v-if="result.unparsedResponses" :class="result.unmatchedSubjectTokens?.length ? 'mt-1' : ''">
        <i class="pi pi-exclamation-triangle mr-1.5"></i>
        {{ result.unparsedResponses }} response doc{{ result.unparsedResponses === 1 ? '' : 's' }} across the
        school didn't fit the expected naming convention and couldn't be read at all.
      </div>
    </div>

    <div v-if="rows.length" class="flex items-center gap-2 mb-3 flex-wrap">
      <Select v-model="statusFilter" :options="statusOptions" optionLabel="label" optionValue="value" class="w-52" />
      <InputText v-model="search" class="w-64" size="small" placeholder="Search class, subject, topic…" />
      <span class="text-xs text-slate-400">
        {{ filteredRows.length }} of {{ rows.length }} shown ·
        {{ counts.not_started }} not started · {{ counts.partial }} partial · {{ counts.complete }} complete
      </span>
    </div>

    <div v-if="running" class="flex items-center justify-center py-20">
      <ProgressSpinner style="width:32px;height:32px" />
    </div>

    <div v-else-if="!rows.length" class="text-center py-20 bg-white rounded-xl border border-slate-200">
      <i class="pi pi-list-check text-4xl text-slate-300 mb-3 block"></i>
      <p class="text-slate-500 font-medium">
        {{ result ? 'No class/subject/topic combinations found.' : 'Pick a school and run the check.' }}
      </p>
    </div>

    <div v-else class="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <DataTable :value="filteredRows" size="small" scrollable scrollHeight="560px" dataKey="key">
        <Column header="Class" field="classId" style="min-width:100px" />
        <Column header="Subject" field="subject" style="min-width:140px" />
        <Column header="Topic" style="min-width:140px">
          <template #body="{ data }">{{ data.topic || '—' }}</template>
        </Column>
        <Column header="Status" style="min-width:130px">
          <template #body="{ data }">
            <span class="px-2 py-0.5 rounded-full text-xs font-semibold" :class="statusClass(data.status)">
              {{ statusLabel(data.status) }}
            </span>
          </template>
        </Column>
        <Column header="Responded" style="min-width:110px">
          <template #body="{ data }">{{ data.respondedStudents }} / {{ data.expectedStudents }}</template>
        </Column>
        <Column header="Teacher" field="teacherId" style="min-width:100px">
          <template #body="{ data }">{{ data.teacherId || '—' }}</template>
        </Column>
        <Column header="Gaps" style="min-width:200px">
          <template #body="{ data }">
            <button
              v-if="data.gaps?.length"
              type="button" class="text-sm text-left text-slate-700 hover:text-blue-600"
              @click="openGaps(data)"
            >
              {{ data.gaps.length }} student{{ data.gaps.length === 1 ? '' : 's' }} — view
            </button>
            <span v-else class="text-xs text-slate-300">—</span>
          </template>
        </Column>
      </DataTable>
    </div>

    <Dialog v-model:visible="gapsVisible" modal :style="{ width: '560px' }" :header="gapsHeader">
      <div v-if="gapsRow" class="max-h-96 overflow-y-auto">
        <div v-for="gap in gapsRow.gaps" :key="gap.studentId" class="flex items-center gap-2 py-1.5 border-b border-slate-100 last:border-0">
          <span class="text-sm text-slate-700 flex-1">{{ gap.studentName }}</span>
          <span v-for="trait in gap.missing" :key="trait" class="px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-50 text-amber-700">
            {{ traitLabel(trait) }} pending
          </span>
        </div>
      </div>
    </Dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useToast } from 'primevue/usetoast'
import Select from 'primevue/select'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import Dialog from 'primevue/dialog'
import ProgressSpinner from 'primevue/progressspinner'

import { useAapRemarks } from '../../composables/useAapRemarks.js'
import { aapSurveyCompletionRemote } from '../../utils/api.js'
import { downloadAapCompletionXlsx } from '../../utils/aapCompletionExport.js'

/**
 * Whole-school AAP survey completion — a separate concern from the Remarks
 * tab: that one turns already-submitted survey ratings into report-card
 * text, this one answers "who hasn't submitted yet, and for whom
 * specifically". Owns its own school picker rather than sharing the Remarks
 * tab's, since this never needs a class/subject scope — it IS the whole
 * school in one scan.
 */
const toast = useToast()
const { schools, loadingSchools, loadSchools } = useAapRemarks()
onMounted(async () => {
  try {
    await loadSchools()
  } catch (e) {
    console.error('Could not load schools', e)
    toast.add({ severity: 'error', summary: 'Could not load schools', detail: e.message, life: 4000 })
  }
})

const schoolId = ref(null)
const running = ref(false)
const runError = ref('')
const result = ref(null)

const traitLabel = (t) => t.charAt(0).toUpperCase() + t.slice(1)

async function run() {
  running.value = true
  runError.value = ''
  result.value = null
  try {
    result.value = await aapSurveyCompletionRemote({ schoolId: schoolId.value })
  } catch (e) {
    console.error('AAP survey completion check failed', e)
    runError.value = e.message || 'Could not run the completion check'
  } finally {
    running.value = false
  }
}

const rows = computed(() => (result.value?.rows || []).map((r, i) => ({
  ...r, key: `${r.classId}__${r.subject}__${r.topic || ''}__${i}`,
})))

const STATUS_CLASSES = {
  not_started: 'bg-slate-100 text-slate-600',
  partial: 'bg-amber-50 text-amber-700',
  complete: 'bg-green-50 text-green-700',
}
const STATUS_LABELS = { not_started: 'Not started', partial: 'Partial', complete: 'Complete' }
const statusClass = (s) => STATUS_CLASSES[s] || STATUS_CLASSES.not_started
const statusLabel = (s) => STATUS_LABELS[s] || s

const statusOptions = [
  { label: 'All statuses', value: '' },
  { label: 'Not started', value: 'not_started' },
  { label: 'Partial', value: 'partial' },
  { label: 'Complete', value: 'complete' },
]
const statusFilter = ref('')
const search = ref('')

const filteredRows = computed(() => {
  const term = search.value.trim().toLowerCase()
  return rows.value.filter(r => {
    if (statusFilter.value && r.status !== statusFilter.value) return false
    if (!term) return true
    return [r.classId, r.subject, r.topic].some(v => String(v || '').toLowerCase().includes(term))
  })
})

const counts = computed(() => {
  const out = { not_started: 0, partial: 0, complete: 0 }
  for (const r of rows.value) out[r.status] = (out[r.status] || 0) + 1
  return out
})

const gapsVisible = ref(false)
const gapsRow = ref(null)
const gapsHeader = computed(() => gapsRow.value
  ? `${gapsRow.value.classId} · ${gapsRow.value.subject}${gapsRow.value.topic ? ' · ' + gapsRow.value.topic : ''}`
  : 'Gaps')

function openGaps(row) {
  gapsRow.value = row
  gapsVisible.value = true
}

function downloadXlsx() {
  const { summaryRows, detailRows } = downloadAapCompletionXlsx(schoolId.value, rows.value)
  toast.add({ severity: 'success', summary: `Exported ${summaryRows} rows, ${detailRows} pending items`, life: 3000 })
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
