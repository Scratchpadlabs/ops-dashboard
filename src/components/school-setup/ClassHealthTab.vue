<template>
  <div class="space-y-4">
    <div class="bg-white rounded-xl border border-slate-200 p-4">
      <div class="flex items-start gap-3">
        <div class="min-w-0 flex-1">
          <h3 class="text-base font-bold text-slate-900">Class health — all schools</h3>
          <p class="text-sm text-slate-500 mt-1">
            How well every active school's roster resolves under the shared class
            resolver. Read-only: this resolves what is already there and writes nothing.
            A school with unmapped students shows exactly which values need confirming.
          </p>
        </div>
        <Button label="Run report" icon="pi pi-chart-bar" size="small"
          :loading="loading" @click="run" />
      </div>

      <div v-if="data" class="grid grid-cols-5 gap-2 mt-4">
        <div v-for="t in tiles" :key="t.label" class="rounded-lg px-3 py-2.5" :class="t.tone">
          <div class="text-xs text-slate-500">{{ t.label }}</div>
          <div class="text-lg font-bold" :class="t.textTone">{{ t.value }}</div>
        </div>
      </div>
    </div>

    <div v-if="loading" class="bg-white rounded-xl border border-slate-200 p-8 text-center">
      <ProgressSpinner style="width:28px;height:28px" />
      <p class="text-sm text-slate-400 mt-2">
        Reading every active school's roster — this can take a minute.
      </p>
    </div>

    <div v-if="error" class="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{{ error }}</div>

    <div v-if="data" class="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <div class="table-scroll">
        <table class="w-full text-sm">
          <thead class="bg-slate-50 text-xs text-slate-500">
            <tr>
              <th class="text-left font-medium px-4 py-2">School</th>
              <th class="text-right font-medium px-3 py-2">Students</th>
              <th class="text-right font-medium px-3 py-2">Distinct</th>
              <th class="text-right font-medium px-3 py-2">Resolved</th>
              <th class="text-right font-medium px-3 py-2">Unmapped</th>
              <th class="text-right font-medium px-3 py-2">%</th>
              <th class="text-left font-medium px-3 py-2">Class map</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="s in data.schools" :key="s.school_id">
              <tr class="border-t border-slate-100" :class="s.unmapped ? 'bg-amber-50/40' : ''">
                <td class="px-4 py-2">
                  <div class="font-medium text-slate-800 cell-truncate">{{ s.name }}</div>
                  <div class="text-[11px] text-slate-400 font-mono">{{ s.school_id }}</div>
                </td>
                <td class="px-3 py-2 text-right tabular-nums">{{ s.students ?? '—' }}</td>
                <td class="px-3 py-2 text-right tabular-nums">{{ s.distinct_class_values ?? '—' }}</td>
                <td class="px-3 py-2 text-right tabular-nums text-emerald-700">{{ s.resolved ?? '—' }}</td>
                <td class="px-3 py-2 text-right tabular-nums"
                    :class="s.unmapped ? 'text-red-600 font-semibold' : 'text-slate-400'">
                  {{ s.unmapped ?? '—' }}
                </td>
                <td class="px-3 py-2 text-right tabular-nums">{{ s.pct_resolved ?? '—' }}%</td>
                <td class="px-3 py-2">
                  <span class="px-2 py-0.5 rounded-full text-[11px] font-semibold"
                    :class="s.has_confirmed_map ? 'bg-emerald-100 text-emerald-700'
                            : s.class_map_entries ? 'bg-slate-100 text-slate-500'
                            : 'bg-slate-100 text-slate-400'">
                    {{ s.has_confirmed_map ? 'confirmed'
                       : s.class_map_entries ? `auto (${s.class_map_entries})` : 'none' }}
                  </span>
                </td>
              </tr>
              <!-- What to fix, inline — a school that fails must show exactly
                   what needs confirming rather than just a red number. -->
              <tr v-if="s.top_unmapped?.length" class="border-t border-slate-50">
                <td colspan="7" class="px-4 py-2 bg-slate-50/60">
                  <div class="text-[11px] text-slate-500 mb-1">Needs confirming:</div>
                  <div class="flex flex-wrap gap-1.5">
                    <span v-for="([label, count]) in s.top_unmapped" :key="label"
                      class="px-2 py-0.5 rounded bg-white border border-slate-200 text-[11px] font-mono">
                      {{ label }} <span class="text-slate-400">× {{ count }}</span>
                    </span>
                  </div>
                </td>
              </tr>
              <tr v-if="s.error" class="border-t border-slate-50">
                <td colspan="7" class="px-4 py-2 text-xs text-red-600 bg-red-50/50">{{ s.error }}</td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import Button from 'primevue/button'
import ProgressSpinner from 'primevue/progressspinner'
import { classHealthRemote } from '../../utils/api.js'

/**
 * Part 5: the estate-wide verification the task asks for. The same numbers
 * tools/class_inventory.py prints, available without a shell.
 */
const data = ref(null)
const loading = ref(false)
const error = ref('')

const tiles = computed(() => {
  const t = data.value?.totals
  if (!t) return []
  return [
    { label: 'Schools', value: t.schools, tone: 'bg-slate-50', textTone: 'text-slate-700' },
    { label: 'Students', value: t.students, tone: 'bg-slate-50', textTone: 'text-slate-700' },
    { label: 'Resolved', value: t.resolved, tone: 'bg-emerald-50', textTone: 'text-emerald-700' },
    { label: 'Unmapped', value: t.unmapped,
      tone: t.unmapped ? 'bg-red-50' : 'bg-emerald-50',
      textTone: t.unmapped ? 'text-red-700' : 'text-emerald-700' },
    { label: 'Need attention', value: t.schools_needing_attention,
      tone: t.schools_needing_attention ? 'bg-amber-50' : 'bg-emerald-50',
      textTone: t.schools_needing_attention ? 'text-amber-700' : 'text-emerald-700' },
  ]
})

async function run() {
  loading.value = true
  error.value = ''
  try {
    data.value = await classHealthRemote()
  } catch (e) {
    error.value = e.message || 'Could not run the class health report.'
  } finally {
    loading.value = false
  }
}
</script>
