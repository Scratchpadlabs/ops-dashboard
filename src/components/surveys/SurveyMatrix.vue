<template>
  <div class="bg-white rounded-xl border border-slate-200 overflow-hidden">
    <!-- Metric toggle — switches what EVERY cell displays -->
    <div class="px-4 py-2.5 border-b border-slate-100 flex items-center gap-3 flex-wrap">
      <span class="text-xs font-semibold text-slate-400 uppercase tracking-wide">Show</span>
      <div class="flex gap-1">
        <button
          v-for="m in metrics" :key="m.value" type="button"
          class="px-2.5 py-1 rounded-lg text-xs font-medium transition-all"
          :class="metric === m.value
            ? 'bg-slate-900 text-white'
            : 'bg-white border border-slate-200 text-slate-600 hover:border-slate-300'"
          @click="$emit('update:metric', m.value)"
        >{{ m.label }}</button>
      </div>

      <div class="flex items-center gap-3 ml-auto text-[11px] text-slate-400">
        <span class="flex items-center gap-1"><span class="w-3 h-3 rounded" :class="shadeClass(0)"></span>none</span>
        <span class="flex items-center gap-1"><span class="w-3 h-3 rounded" :class="shadeClass(50)"></span>partial</span>
        <span class="flex items-center gap-1"><span class="w-3 h-3 rounded" :class="shadeClass(100)"></span>full</span>
      </div>
    </div>

    <div class="overflow-auto" style="max-height: 65vh" @mouseup="endDrag" @mouseleave="endDrag">
      <table class="text-sm border-collapse w-full" style="user-select: none">
        <thead class="sticky top-0 z-20">
          <tr>
            <th class="sticky left-0 z-30 bg-slate-50 border-b border-r border-slate-200 px-3 py-2 text-left text-xs font-semibold text-slate-400 uppercase" style="min-width:170px">
              Class
            </th>
            <th
              v-for="s in surveys" :key="s.id"
              class="bg-slate-50 border-b border-slate-200 px-2 py-2 text-center cursor-pointer hover:bg-slate-100 transition-colors"
              style="min-width:104px"
              :title="`Select ${s.label} across all classes`"
              @click="$emit('select-column', s.id, $event)"
            >
              <div class="text-xs font-semibold text-slate-700 truncate">{{ s.label }}</div>
              <div class="text-[10px] font-normal" :class="windowClass(s)">{{ windowLabel(s) }}</div>
            </th>
          </tr>
        </thead>

        <tbody>
          <!-- Pinned school total -->
          <tr class="bg-slate-50/70">
            <td class="sticky left-0 z-10 bg-slate-50 border-b border-r border-slate-200 px-3 py-2">
              <div class="text-xs font-bold text-slate-800">School total</div>
              <div class="text-[11px] text-slate-400">{{ activeStudentCount }} students</div>
            </td>
            <td v-for="s in surveys" :key="s.id" class="border-b border-slate-200 px-2 py-2 text-center">
              <CellContent :cell="totals[s.id]" :metric="metric" :unresolved="isUnresolved(s.id)" bold />
            </td>
          </tr>

          <template v-for="row in rows" :key="row.class_id">
            <tr class="hover:bg-slate-50/60">
              <td class="sticky left-0 z-10 bg-white border-b border-r border-slate-100 px-3 py-1.5">
                <div class="flex items-center gap-1.5">
                  <button
                    type="button" class="text-slate-300 hover:text-slate-600 flex-shrink-0"
                    :title="expanded === row.class_id ? 'Collapse' : 'Show students'"
                    @click="$emit('toggle-expand', row.class_id)"
                  >
                    <i class="pi text-xs" :class="expanded === row.class_id ? 'pi-chevron-down' : 'pi-chevron-right'"></i>
                  </button>
                  <button
                    type="button"
                    class="text-left min-w-0 hover:text-violet-700 transition-colors"
                    :title="`Select ${row.class_id} across all surveys`"
                    @click="$emit('select-row', row.class_id, $event)"
                  >
                    <div class="text-xs font-semibold text-slate-800 truncate">{{ row.class_id }}</div>
                    <div class="text-[11px] text-slate-400">{{ row.student_count }} students</div>
                  </button>
                </div>
              </td>

              <td
                v-for="s in surveys" :key="s.id"
                class="border-b border-slate-100 px-1 py-1 text-center cursor-pointer transition-colors"
                :class="cellClass(row, s.id)"
                @mousedown.prevent="startDrag(row.class_id, s.id, $event)"
                @mouseenter="extendDrag(row.class_id, s.id)"
              >
                <CellContent :cell="row.cells[s.id]" :metric="metric" :unresolved="isUnresolved(s.id)" />
              </td>
            </tr>

            <!-- Drill-down: this class's students, tick per survey -->
            <tr v-if="expanded === row.class_id">
              <td :colspan="surveys.length + 1" class="bg-slate-50 border-b border-slate-200 p-0">
                <slot name="drilldown" :class-id="row.class_id" />
              </td>
            </tr>
          </template>
        </tbody>
      </table>

      <div v-if="!rows.length" class="text-center text-sm text-slate-400 py-10">
        No classes match the current filters.
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, h } from 'vue'

/**
 * The classes x surveys grid.
 *
 * Selection is a set of "classId::surveyId" pair keys held by the parent, so
 * the action bar can act on an arbitrary rectangle (or scatter) of cells in
 * one assignment run. This component only reports intent; it owns no state
 * beyond the in-progress drag.
 */
const props = defineProps({
  surveys: { type: Array, default: () => [] },
  rows: { type: Array, default: () => [] },
  totals: { type: Object, default: () => ({}) },
  selection: { type: Set, default: () => new Set() },
  metric: { type: String, default: 'all' },
  expanded: { type: String, default: null },
  activeStudentCount: { type: Number, default: 0 },
  unresolvedResponseSurveys: { type: Array, default: () => [] },
})
const emit = defineEmits(['update:metric', 'select-cells', 'select-row', 'select-column', 'toggle-expand'])

const metrics = [
  { value: 'all', label: 'All' },
  { value: 'assigned', label: 'Assigned' },
  { value: 'responded', label: 'Responded' },
  { value: 'completion', label: 'Completion %' },
]

const unresolvedSet = computed(() => new Set(props.unresolvedResponseSurveys))
const isUnresolved = (sid) => unresolvedSet.value.has(sid)

// ── Drag selection ──────────────────────────────────────────────────────────
// mousedown starts a range, mouseenter extends it, mouseup commits. A plain
// click is just a 1x1 range, so click and drag share one code path.
const dragging = ref(false)
const dragStart = ref(null)
const dragAdditive = ref(false)

function startDrag(classId, surveyId, event) {
  dragging.value = true
  dragStart.value = { classId, surveyId }
  // Shift or ctrl/cmd adds to the existing selection instead of replacing it.
  dragAdditive.value = event.shiftKey || event.ctrlKey || event.metaKey
  emitRange(classId, surveyId)
}
function extendDrag(classId, surveyId) {
  if (!dragging.value) return
  emitRange(classId, surveyId)
}
function endDrag() {
  dragging.value = false
  dragStart.value = null
}

function emitRange(classId, surveyId) {
  if (!dragStart.value) return
  const classIds = props.rows.map(r => r.class_id)
  const surveyIds = props.surveys.map(s => s.id)
  const r1 = classIds.indexOf(dragStart.value.classId)
  const r2 = classIds.indexOf(classId)
  const c1 = surveyIds.indexOf(dragStart.value.surveyId)
  const c2 = surveyIds.indexOf(surveyId)
  if (r1 < 0 || r2 < 0 || c1 < 0 || c2 < 0) return

  const pairs = []
  for (let r = Math.min(r1, r2); r <= Math.max(r1, r2); r++) {
    for (let c = Math.min(c1, c2); c <= Math.max(c1, c2); c++) {
      pairs.push(`${classIds[r]}::${surveyIds[c]}`)
    }
  }
  emit('select-cells', pairs, { additive: dragAdditive.value })
}

// ── Presentation ────────────────────────────────────────────────────────────
function pctFor(cell) {
  if (!cell) return 0
  if (props.metric === 'assigned') return cell.total ? cell.assigned / cell.total * 100 : 0
  // Every other metric grades on response completion against those assigned.
  return cell.assigned ? cell.responded / cell.assigned * 100 : 0
}

function shadeClass(pct) {
  if (pct <= 0) return 'bg-slate-100'
  if (pct >= 100) return 'bg-green-200'
  if (pct >= 60) return 'bg-green-100'
  if (pct >= 25) return 'bg-amber-100'
  return 'bg-red-100'
}

function cellClass(row, surveyId) {
  const key = `${row.class_id}::${surveyId}`
  const selected = props.selection.has(key)
  return [
    shadeClass(pctFor(row.cells[surveyId])),
    selected ? 'ring-2 ring-inset ring-violet-500' : 'hover:brightness-95',
  ]
}

function fmtDate(ms) {
  return ms ? new Date(ms).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : null
}
function windowLabel(s) {
  const a = fmtDate(s.start_at), b = fmtDate(s.expires_at)
  if (!a && !b) return 'no window'
  return `${a || '…'}–${b || '…'}`
}
function windowClass(s) {
  const now = Date.now()
  if (s.expires_at && s.expires_at < now) return 'text-slate-300'
  if (s.start_at && s.start_at > now) return 'text-amber-500'
  return 'text-slate-400'
}

// Small render-function component — the cell body changes with the metric and
// is rendered once per class x survey, so it stays allocation-light.
const CellContent = (p) => {
  const c = p.cell || { assigned: 0, responded: 0, total: 0 }
  const weight = p.bold ? 'font-bold' : 'font-medium'
  const pctTxt = c.assigned ? `${Math.round(c.responded / c.assigned * 100)}%` : '—'

  if (p.metric === 'assigned') {
    return h('div', { class: `text-xs ${weight} text-slate-700` }, `${c.assigned}/${c.total}`)
  }
  if (p.metric === 'responded') {
    return h('div', { class: `text-xs ${weight}`, title: p.unresolved ? 'Responses not measurable for this survey' : undefined },
      p.unresolved ? '—' : `${c.responded}/${c.assigned}`)
  }
  if (p.metric === 'completion') {
    return h('div', { class: `text-xs ${weight} text-slate-700` }, p.unresolved ? '—' : pctTxt)
  }
  // "All" — compact three-part cell
  return h('div', { class: 'leading-tight py-0.5' }, [
    h('div', { class: `text-xs ${weight} text-slate-800` }, `${c.assigned}/${c.total}`),
    h('div', { class: 'text-[10px] text-slate-500' },
      p.unresolved ? 'resp. n/a' : `${c.responded} resp · ${pctTxt}`),
  ])
}
CellContent.props = ['cell', 'metric', 'bold', 'unresolved']
</script>
