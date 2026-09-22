<template>
  <div class="pt-4">
    <div class="flex items-center justify-between mb-3">
      <div class="text-sm font-bold text-slate-900">Sheets Overview</div>
      <Button label="Run overview" icon="pi pi-search" size="small" :loading="running"
              :disabled="!schoolId" @click="run" />
    </div>
    <p class="text-xs text-slate-400 mb-3">
      Whole-school rollup across all four Smart Sheets areas, summed across every sheet found —
      not scoped to one term. For a per-subject, per-term breakdown with freeze controls, use
      Sheets Status instead; this is the "how much has happened, everywhere" picture.
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

    <template v-else>
      <!-- ── Whole-school summary — the "one screen" picture ─────────────── -->
      <div class="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
        <div class="bg-white rounded-xl border border-slate-200 p-3">
          <div class="text-xs text-slate-400 uppercase tracking-wide font-semibold">Classes</div>
          <div class="text-2xl font-bold text-slate-900 mt-1">{{ result.rows.length }}</div>
        </div>
        <div class="bg-white rounded-xl border border-slate-200 p-3">
          <div class="text-xs text-slate-400 uppercase tracking-wide font-semibold">Academics</div>
          <div class="text-2xl font-bold text-slate-900 mt-1">{{ totals.academicsEntries }}</div>
          <div class="text-[11px] text-slate-400">entries · {{ totals.academicsSheets }} sheet(s)</div>
        </div>
        <div class="bg-white rounded-xl border border-slate-200 p-3">
          <div class="text-xs text-slate-400 uppercase tracking-wide font-semibold">Co-Scholastic</div>
          <div class="text-2xl font-bold text-slate-900 mt-1">{{ totals.coScholasticEntries }}</div>
          <div class="text-[11px] text-slate-400">entries · {{ totals.coScholasticSheets }} sheet(s)</div>
        </div>
        <div class="bg-white rounded-xl border border-slate-200 p-3">
          <div class="text-xs text-slate-400 uppercase tracking-wide font-semibold">Attendance</div>
          <div class="text-2xl font-bold text-slate-900 mt-1">{{ totals.attendanceEntries }}</div>
          <div class="text-[11px] text-slate-400">entries · {{ totals.attendanceSheets }} sheet(s)</div>
        </div>
        <div class="bg-white rounded-xl border border-slate-200 p-3">
          <div class="text-xs text-slate-400 uppercase tracking-wide font-semibold">Remarks</div>
          <div class="text-2xl font-bold text-slate-900 mt-1">{{ totals.remarksEntries }}</div>
          <div class="text-[11px] text-slate-400">entries · {{ totals.remarksSheets }} sheet(s)</div>
        </div>
      </div>

      <div class="flex items-center gap-2 mb-3">
        <InputText v-model="search" class="w-64" size="small" placeholder="Search class…" />
        <span class="text-xs text-slate-400">{{ filteredRows.length }} of {{ result.rows.length }} shown</span>
      </div>

      <div class="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <DataTable :value="filteredRows" size="small" scrollable scrollHeight="600px" stripedRows>
          <Column header="Class" style="min-width:160px">
            <template #body="{ data }">
              <div class="text-sm font-semibold text-slate-900">{{ data.className }}</div>
              <div class="text-[11px] text-slate-400">{{ data.classId }}</div>
            </template>
          </Column>

          <Column header="Academics" style="min-width:140px">
            <template #body="{ data }">
              <span class="text-sm text-slate-700">{{ data.academics.entryCount }} entries</span>
              <div class="text-[11px] text-slate-400">{{ data.academics.sheetCount }} sheet(s)</div>
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
        <div v-if="!filteredRows.length" class="text-center text-sm text-slate-400 py-8">
          {{ result.rows.length ? 'No class matches this search.' : 'No active classes found.' }}
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useToast } from 'primevue/usetoast'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import ProgressSpinner from 'primevue/progressspinner'

import { sheetsOverviewRemote } from '../../utils/api.js'

/**
 * Read-only whole-school rollup across academics/co-scholastic/attendance/
 * remarks, with a summary strip so the whole picture lands on one screen
 * without needing Sheets Status's per-subject/term grid alongside it.
 */
const props = defineProps({ schoolId: { type: String, default: null } })

const toast = useToast()
const running = ref(false)
const result = ref(null)
const search = ref('')

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

const filteredRows = computed(() => {
  const term = search.value.trim().toLowerCase()
  if (!term) return result.value?.rows || []
  return (result.value?.rows || []).filter(r =>
    r.className.toLowerCase().includes(term) || r.classId.toLowerCase().includes(term))
})

const totals = computed(() => {
  const rows = result.value?.rows || []
  const sum = (fn) => rows.reduce((acc, r) => acc + fn(r), 0)
  return {
    academicsEntries: sum(r => r.academics.entryCount),
    academicsSheets: sum(r => r.academics.sheetCount),
    coScholasticEntries: sum(r => r.coScholastic.entryCount),
    coScholasticSheets: sum(r => r.coScholastic.sheetCount),
    attendanceEntries: sum(r => r.attendance.entryCount),
    attendanceSheets: sum(r => r.attendance.sheetCount),
    remarksEntries: sum(r => r.remarks.entryCount),
    remarksSheets: sum(r => r.remarks.sheetCount),
  }
})
</script>
