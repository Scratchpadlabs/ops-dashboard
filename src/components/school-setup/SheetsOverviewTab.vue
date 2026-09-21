<template>
  <div class="pt-4">
    <div class="flex items-center justify-between mb-3">
      <div class="text-sm font-bold text-slate-900">Sheets Overview</div>
      <Button label="Run overview" icon="pi pi-search" size="small" :loading="running"
              :disabled="!schoolId" @click="run" />
    </div>
    <p class="text-xs text-slate-400 mb-3">
      Whole-school rollup across all four Smart Sheets areas. Academics comes from each class's
      own topic-completion flags (no extra reads); Co-Scholastic, Attendance and Remarks report
      entries actually written, summed across every sheet found for that class. This is a heavier,
      whole-school read — run on demand rather than automatically.
    </p>

    <div v-if="result?.diagnostics?.unknownClassSheets && Object.keys(result.diagnostics.unknownClassSheets).length"
         class="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 mb-4 text-sm text-amber-900">
      <i class="pi pi-exclamation-triangle mr-1.5"></i>
      Some sheets reference a class that no longer exists (deleted or renamed) — excluded from the
      totals below, not silently blended in:
      <div v-for="(byClass, area) in result.diagnostics.unknownClassSheets" :key="area" class="mt-1">
        <span class="font-semibold capitalize">{{ area }}:</span>
        {{ Object.entries(byClass).map(([cid, n]) => `${cid} (${n})`).join(', ') }}
      </div>
    </div>

    <div v-if="running" class="flex items-center justify-center py-16">
      <ProgressSpinner style="width:28px;height:28px" />
    </div>

    <div v-else-if="!result" class="text-center text-sm text-slate-400 py-16 bg-white rounded-xl border border-slate-200">
      Click "Run overview" to scan this school's sheets.
    </div>

    <div v-else class="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <DataTable :value="result.rows" size="small" scrollable scrollHeight="600px" stripedRows>
        <Column header="Class" style="min-width:160px">
          <template #body="{ data }">
            <div class="text-sm font-semibold text-slate-900">{{ data.className }}</div>
            <div class="text-[11px] text-slate-400">{{ data.classId }}</div>
          </template>
        </Column>

        <Column header="Academics" style="min-width:150px">
          <template #body="{ data }">
            <span class="px-2 py-0.5 rounded-full text-xs font-semibold" :class="ratioClass(data.academics.completedTopics, data.academics.totalTopics)">
              {{ data.academics.completedTopics }} / {{ data.academics.totalTopics }} topics
            </span>
            <div class="text-[11px] text-slate-400 mt-0.5">{{ data.academics.subjectCount }} subject(s)</div>
          </template>
        </Column>

        <Column header="Co-Scholastic" style="min-width:140px">
          <template #body="{ data }">
            <span class="text-sm text-slate-700">{{ data.coScholastic.entryCount }} entries</span>
            <div class="text-[11px] text-slate-400">{{ data.coScholastic.sheetCount }} sheet(s)</div>
          </template>
        </Column>

        <Column header="Attendance" style="min-width:140px">
          <template #body="{ data }">
            <span class="text-sm text-slate-700">{{ data.attendance.entryCount }} entries</span>
            <div class="text-[11px] text-slate-400">{{ data.attendance.sheetCount }} sheet(s)</div>
          </template>
        </Column>

        <Column header="Remarks" style="min-width:140px">
          <template #body="{ data }">
            <span class="text-sm text-slate-700">{{ data.remarks.entryCount }} entries</span>
            <div class="text-[11px] text-slate-400">{{ data.remarks.sheetCount }} sheet(s)</div>
          </template>
        </Column>
      </DataTable>
      <div v-if="!result.rows.length" class="text-center text-sm text-slate-400 py-8">No active classes found.</div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useToast } from 'primevue/usetoast'
import Button from 'primevue/button'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import ProgressSpinner from 'primevue/progressspinner'

import { sheetsOverviewRemote } from '../../utils/api.js'

/**
 * Read-only whole-school rollup across academics/co-scholastic/attendance/
 * remarks. A different scope than Sheets Status (which drills into one
 * term's academic sheets in detail, with freeze actions) — this answers
 * "how much has actually been entered, across every area, at a glance."
 */
const props = defineProps({ schoolId: { type: String, default: null } })

const toast = useToast()
const running = ref(false)
const result = ref(null)

async function run() {
  running.value = true
  try {
    result.value = await sheetsOverviewRemote({ schoolId: props.schoolId })
  } catch (e) {
    console.error('Could not load the sheets overview', e)
    toast.add({ severity: 'error', summary: 'Could not load overview', detail: e.message, life: 4000 })
  } finally {
    running.value = false
  }
}

function ratioClass(done, total) {
  if (!total) return 'bg-slate-100 text-slate-500'
  const pct = done / total
  if (pct >= 1) return 'bg-green-50 text-green-700'
  if (pct > 0) return 'bg-amber-50 text-amber-700'
  return 'bg-slate-100 text-slate-500'
}
</script>
