<template>
  <div class="bg-white rounded-xl border border-slate-200 p-4 mb-4">
    <!-- ── Header + overall bar ─────────────────────────────────────────── -->
    <div class="flex items-center justify-between gap-3 mb-2 flex-wrap">
      <div class="text-sm font-semibold text-slate-900 flex items-center">
        <i v-if="running" class="pi pi-spin pi-spinner text-sm mr-2 text-blue-500"></i>
        <i v-else-if="failedCount" class="pi pi-exclamation-circle text-sm mr-2 text-amber-500"></i>
        <i v-else class="pi pi-check-circle text-sm mr-2 text-emerald-500"></i>
        <template v-if="running">
          Generating remarks{{ items.length > 1 ? ` — class ${currentIndex} of ${countedTotal}` : ` for ${items[0]?.label}` }}
        </template>
        <template v-else>
          Run finished — {{ doneCount }} done<template v-if="failedCount">, {{ failedCount }} failed</template><template v-if="cancelledCount">, {{ cancelledCount }} cancelled</template>
        </template>
      </div>
      <div class="flex items-center gap-3 text-xs text-slate-500">
        <span v-if="totalWritten">{{ totalWritten }} remark{{ totalWritten === 1 ? '' : 's' }} written</span>
        <span v-if="runElapsed">{{ runElapsed }}</span>
        <Button v-if="running && items.length > 1" :label="cancelling ? 'Stopping after this class…' : 'Stop after this class'"
                size="small" text severity="secondary" :disabled="cancelling" @click="$emit('cancel')" />
        <Button v-if="!running" icon="pi pi-times" size="small" text rounded severity="secondary" v-tooltip.left="'Dismiss'" @click="$emit('dismiss')" />
      </div>
    </div>

    <div class="h-2.5 rounded-full bg-slate-100 overflow-hidden">
      <div class="h-full rounded-full transition-all duration-500"
           :class="running ? 'bg-blue-500 bar-stripes' : (failedCount ? 'bg-amber-400' : 'bg-emerald-500')"
           :style="{ width: `${Math.max(overall, running ? 2 : 0)}%` }"></div>
    </div>
    <div class="flex justify-between text-[11px] text-slate-400 mt-1">
      <span>{{ overall }}%</span>
      <span v-if="running">Keep this tab open — each class is generated in turn.</span>
    </div>

    <!-- ── Per-class rows ───────────────────────────────────────────────── -->
    <div class="mt-3 divide-y divide-slate-100 border border-slate-100 rounded-lg" :class="items.length > 6 ? 'max-h-80 overflow-y-auto' : ''">
      <div v-for="item in items" :key="item.classId" class="px-3 py-2 flex items-center gap-3"
           :class="item.status === RUN_STATUS.RUNNING ? 'bg-blue-50/50' : ''">
        <span class="text-[10px] font-semibold uppercase tracking-wide rounded px-1.5 py-0.5 w-20 text-center shrink-0" :class="chipClass(item.status)">
          {{ chipLabel(item.status) }}
        </span>
        <button class="text-sm font-medium text-slate-800 w-32 truncate text-left hover:text-indigo-600 shrink-0" :title="`Show ${item.label}`" @click="$emit('view', item.classId)">
          {{ item.label }}
        </button>

        <div class="flex-1 min-w-0">
          <template v-if="item.status === RUN_STATUS.RUNNING">
            <div class="h-1.5 rounded-full bg-slate-100 overflow-hidden">
              <div v-if="progressOf(item).pct != null" class="h-full bg-blue-500 rounded-full transition-all duration-500" :style="{ width: `${progressOf(item).pct}%` }"></div>
              <div v-else class="h-full w-1/3 bg-blue-300 rounded-full indeterminate"></div>
            </div>
            <div class="text-[11px] text-slate-500 mt-1 truncate">
              <template v-if="!item.job">Reading the class's remarks sheet…</template>
              <template v-else>
                {{ progressOf(item).done }} of {{ progressOf(item).total }} {{ progressOf(item).unit }}
                <template v-if="item.job.currentStudent"> · writing for <b>{{ item.job.currentStudent }}</b></template>
                <template v-if="eta(item)"> · about {{ eta(item) }} left</template>
              </template>
            </div>
          </template>
          <div v-else-if="item.status === RUN_STATUS.DONE" class="text-xs text-slate-500">
            {{ item.result?.written ?? 0 }} written<template v-if="item.result?.skippedApproved">, {{ item.result.skippedApproved }} already approved</template>
          </div>
          <div v-else-if="item.status === RUN_STATUS.FAILED" class="text-xs text-red-600 truncate" :title="item.error">{{ item.error }}</div>
          <div v-else-if="item.status === RUN_STATUS.SKIPPED" class="text-xs text-slate-400 truncate">{{ item.error }}</div>
          <div v-else-if="item.status === RUN_STATUS.CANCELLED" class="text-xs text-slate-400">Not started — run was stopped</div>
          <div v-else class="text-xs text-slate-400">Waiting</div>
        </div>

        <span class="text-[11px] text-slate-400 tabular-nums w-14 text-right shrink-0">{{ elapsedOf(item) }}</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import Button from 'primevue/button'
import {
  RUN_STATUS, jobProgress, overallProgress, etaMs, elapsedMs, formatDuration,
} from '../../utils/smartRemarksProgress.js'

const props = defineProps({
  items: { type: Array, required: true },
  running: { type: Boolean, default: false },
  cancelling: { type: Boolean, default: false },
  // Ticks every second from the parent so elapsed/ETA stay live.
  now: { type: Number, required: true },
})
defineEmits(['cancel', 'dismiss', 'view'])

const overall = computed(() => overallProgress(props.items))
const countedTotal = computed(() => props.items.filter(i => i.status !== RUN_STATUS.SKIPPED).length)
const currentIndex = computed(() => {
  const counted = props.items.filter(i => i.status !== RUN_STATUS.SKIPPED)
  const idx = counted.findIndex(i => i.status === RUN_STATUS.RUNNING)
  return idx === -1 ? counted.filter(i => i.status !== RUN_STATUS.QUEUED).length : idx + 1
})
const doneCount = computed(() => props.items.filter(i => i.status === RUN_STATUS.DONE).length)
const failedCount = computed(() => props.items.filter(i => i.status === RUN_STATUS.FAILED).length)
const cancelledCount = computed(() => props.items.filter(i => i.status === RUN_STATUS.CANCELLED).length)
const totalWritten = computed(() => props.items.reduce((sum, i) =>
  sum + (i.status === RUN_STATUS.DONE ? (i.result?.written || 0) : (i.job?.writtenRemarks || 0)), 0))
const runElapsed = computed(() => {
  const starts = props.items.map(i => i.startedAtMs).filter(Boolean)
  if (!starts.length) return ''
  const ends = props.items.map(i => i.finishedAtMs).filter(Boolean)
  const end = props.running || !ends.length ? props.now : Math.max(...ends)
  return formatDuration(end - Math.min(...starts))
})

const progressOf = item => jobProgress(item.job)
const eta = item => formatDuration(etaMs(item.job, props.now))
const elapsedOf = item => formatDuration(elapsedMs(item, props.now))

function chipLabel(status) {
  return {
    [RUN_STATUS.QUEUED]: 'Queued', [RUN_STATUS.RUNNING]: 'Generating', [RUN_STATUS.DONE]: 'Done',
    [RUN_STATUS.FAILED]: 'Failed', [RUN_STATUS.SKIPPED]: 'Skipped', [RUN_STATUS.CANCELLED]: 'Stopped',
  }[status] || status
}
function chipClass(status) {
  return {
    [RUN_STATUS.QUEUED]: 'bg-slate-100 text-slate-500',
    [RUN_STATUS.RUNNING]: 'bg-blue-100 text-blue-700',
    [RUN_STATUS.DONE]: 'bg-emerald-100 text-emerald-700',
    [RUN_STATUS.FAILED]: 'bg-red-100 text-red-700',
    [RUN_STATUS.SKIPPED]: 'bg-slate-100 text-slate-400',
    [RUN_STATUS.CANCELLED]: 'bg-slate-100 text-slate-400',
  }[status] || 'bg-slate-100 text-slate-500'
}
</script>

<style scoped>
.bar-stripes {
  background-image: linear-gradient(45deg, rgba(255,255,255,.18) 25%, transparent 25%, transparent 50%, rgba(255,255,255,.18) 50%, rgba(255,255,255,.18) 75%, transparent 75%, transparent);
  background-size: 16px 16px;
  animation: stripes 1s linear infinite;
}
@keyframes stripes { from { background-position: 16px 0 } to { background-position: 0 0 } }
.indeterminate { animation: slide 1.2s ease-in-out infinite; }
@keyframes slide { 0% { transform: translateX(-100%) } 100% { transform: translateX(300%) } }
</style>
