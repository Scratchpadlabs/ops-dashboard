<template>
  <div class="space-y-4">
    <!-- ── Intro ────────────────────────────────────────────────────────── -->
    <div class="bg-white rounded-xl border border-slate-200 p-4">
      <div class="flex items-start gap-3">
        <div class="min-w-0 flex-1">
          <h3 class="text-base font-bold text-slate-900">Class map</h3>
          <p class="text-sm text-slate-500 mt-1">
            Every feature that needs a student's class — the Surveys matrix, promotion,
            reports, exports — reads this map. Scanning is read-only; nothing is written
            until you confirm rows below.
          </p>
        </div>
        <Button label="Scan classes" icon="pi pi-search" size="small"
          :loading="scanning" :disabled="!schoolId" @click="scan" />
      </div>

      <div v-if="scan_" class="grid grid-cols-4 gap-2 mt-4">
        <div v-for="s in summaryTiles" :key="s.label"
          class="rounded-lg px-3 py-2.5" :class="s.tone">
          <div class="text-xs text-slate-500">{{ s.label }}</div>
          <div class="text-lg font-bold" :class="s.textTone">{{ s.value }}</div>
        </div>
      </div>

      <div v-if="scan_?.unresolved_count" class="mt-3 text-sm text-amber-800 bg-amber-50 rounded-lg px-3 py-2">
        <i class="pi pi-exclamation-triangle text-xs mr-1"></i>
        {{ scan_.unresolved_count }} value(s) could not be resolved automatically.
        Set the grade and section for each below, then save — promotion and grouping
        stay blocked for those students until you do.
      </div>
    </div>

    <div v-if="error" class="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{{ error }}</div>

    <!-- ── Review table ─────────────────────────────────────────────────── -->
    <div v-if="rows.length" class="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <div class="flex items-center gap-2 px-4 py-3 border-b border-slate-100">
        <span class="text-sm font-semibold text-slate-700">
          {{ rows.length }} distinct class value{{ rows.length === 1 ? '' : 's' }}
        </span>
        <label class="flex items-center gap-1.5 text-xs text-slate-500 ml-2">
          <Checkbox v-model="onlyUnresolved" binary />
          Show only unresolved
        </label>
        <label class="flex items-center gap-1.5 text-xs text-slate-500">
          <Checkbox v-model="shareAliases" binary />
          Share corrections with other schools
        </label>
        <div class="ml-auto flex items-center gap-2">
          <span v-if="dirtyCount" class="text-xs text-amber-700">{{ dirtyCount }} unsaved</span>
          <Button label="Save class map" icon="pi pi-check" size="small"
            :loading="saving" :disabled="!dirtyCount" @click="save" />
        </div>
      </div>

      <div class="table-scroll">
        <table class="w-full text-sm">
          <thead class="bg-slate-50 text-xs text-slate-500">
            <tr>
              <th class="text-left font-medium px-4 py-2">Raw value</th>
              <th class="text-left font-medium px-3 py-2">Field</th>
              <th class="text-right font-medium px-3 py-2">Students</th>
              <th class="text-left font-medium px-3 py-2">Grade</th>
              <th class="text-left font-medium px-3 py-2">Section</th>
              <th class="text-left font-medium px-3 py-2">Resolves to</th>
              <th class="text-left font-medium px-3 py-2">Confidence</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in visibleRows" :key="r.raw_value"
              class="border-t border-slate-100" :class="r._dirty ? 'bg-amber-50/60' : ''">
              <td class="px-4 py-2 font-mono text-xs text-slate-800">
                <!-- Item 5: never render an unmapped value as blank. -->
                <span v-if="r.raw_value">{{ r.raw_value }}</span>
                <span v-else class="text-slate-400 italic">(empty)</span>
              </td>
              <td class="px-3 py-2 text-xs text-slate-500">{{ r.field || '—' }}</td>
              <td class="px-3 py-2 text-right tabular-nums text-slate-600">{{ r.student_count }}</td>
              <td class="px-3 py-2">
                <Select v-model="r.grade_ordinal" :options="GRADE_OPTIONS"
                  optionLabel="label" optionValue="value" class="w-36" size="small"
                  placeholder="Set grade" @change="markDirty(r)" />
              </td>
              <td class="px-3 py-2">
                <InputText v-model="r.section" class="w-28" size="small"
                  placeholder="—" @input="markDirty(r)" />
              </td>
              <td class="px-3 py-2 font-mono text-xs">
                <span v-if="targetOf(r)" class="text-slate-800">{{ targetOf(r) }}</span>
                <span v-else class="text-red-600">{{ r.label || 'unresolved' }}</span>
              </td>
              <td class="px-3 py-2">
                <span class="px-2 py-0.5 rounded-full text-[11px] font-semibold"
                  :class="confidenceTone(r)">{{ confidenceLabel(r) }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div v-else-if="scan_ && !scanning"
      class="bg-white rounded-xl border border-slate-200 p-8 text-center text-sm text-slate-400">
      No students found for this school.
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useToast } from 'primevue/usetoast'
import Button from 'primevue/button'
import Select from 'primevue/select'
import InputText from 'primevue/inputtext'
import Checkbox from 'primevue/checkbox'

import { scanClassesRemote, saveClassMapRemote } from '../../utils/api.js'
import { ordinalToToken, composeClassId } from '../../utils/classResolver.js'

/**
 * Part 2 of the class-resolution work: the per-school class map.
 *
 * Scanning resolves every DISTINCT class value in the roster (a few dozen
 * rows even for a 3000-student school) and proposes a grade + section. A
 * human confirms or corrects, and from then on every feature uses the
 * confirmed answer — which is what makes an odd school permanently fixable
 * without a code change.
 *
 * The scan writes nothing. Only "Save class map" writes, and only to
 * schools/<id>/class_map.
 */
const props = defineProps({ schoolId: { type: String, default: null } })
const toast = useToast()

const scan_ = ref(null)
const rows = ref([])
const scanning = ref(false)
const saving = ref(false)
const error = ref('')
const onlyUnresolved = ref(false)
const shareAliases = ref(true)

// Ordinals, not labels — promotion is arithmetic on these. The scale puts
// pre-primary below Grade 1 so +1 walks the ladder with no special case.
const GRADE_OPTIONS = [
  { label: 'Pre-Nursery', value: -3 },
  { label: 'Nursery', value: -2 },
  { label: 'LKG', value: -1 },
  { label: 'UKG', value: 0 },
  ...Array.from({ length: 12 }, (_, i) => ({ label: `Grade ${i + 1}`, value: i + 1 })),
]

const dirtyCount = computed(() => rows.value.filter(r => r._dirty).length)

const visibleRows = computed(() =>
  onlyUnresolved.value
    ? rows.value.filter(r => r.grade_ordinal === null || r.grade_ordinal === undefined)
    : rows.value)

const summaryTiles = computed(() => {
  const s = scan_.value
  if (!s) return []
  const unresolved = s.unresolved_count || 0
  return [
    { label: 'Students', value: s.student_count, tone: 'bg-slate-50', textTone: 'text-slate-700' },
    { label: 'Distinct values', value: s.distinct_count, tone: 'bg-slate-50', textTone: 'text-slate-700' },
    { label: 'Configured classes', value: (s.configured_classes || []).length,
      tone: 'bg-slate-50', textTone: 'text-slate-700' },
    { label: 'Unresolved', value: unresolved,
      tone: unresolved ? 'bg-amber-50' : 'bg-emerald-50',
      textTone: unresolved ? 'text-amber-700' : 'text-emerald-700' },
  ]
})

/** What this row will resolve to once saved, in the school's own notation. */
function targetOf(r) {
  if (r.grade_ordinal === null || r.grade_ordinal === undefined) return null
  const token = ordinalToToken(r.grade_ordinal, scan_.value?.notation || 'roman')
  return composeClassId(token, (r.section || '').trim(), scan_.value?.separator || '_')
}

function confidenceLabel(r) {
  if (r._dirty) return 'edited'
  if (r.source === 'confirmed') return 'confirmed'
  if (r.grade_ordinal === null || r.grade_ordinal === undefined) return 'unresolved'
  return r.confidence || 'auto'
}

function confidenceTone(r) {
  const l = confidenceLabel(r)
  if (l === 'confirmed') return 'bg-emerald-100 text-emerald-700'
  if (l === 'edited') return 'bg-amber-100 text-amber-700'
  if (l === 'unresolved') return 'bg-red-100 text-red-700'
  if (l === 'high') return 'bg-emerald-50 text-emerald-600'
  return 'bg-slate-100 text-slate-500'
}

function markDirty(r) { r._dirty = true }

async function scan() {
  scanning.value = true
  error.value = ''
  try {
    const data = await scanClassesRemote({ schoolId: props.schoolId })
    scan_.value = data
    rows.value = (data.rows || []).map(r => ({ ...r, _dirty: false }))
  } catch (e) {
    error.value = e.message || 'Could not scan classes.'
  } finally {
    scanning.value = false
  }
}

async function save() {
  saving.value = true
  error.value = ''
  try {
    const payload = rows.value.filter(r => r._dirty).map(r => ({
      raw_value: r.raw_value,
      canonical_class_id: targetOf(r),
      grade_token: ordinalToToken(r.grade_ordinal, scan_.value?.notation || 'roman'),
      grade_canonical: gradeCanonicalFor(r.grade_ordinal),
      grade_ordinal: r.grade_ordinal,
      section: (r.section || '').trim(),
      student_count: r.student_count,
    }))
    const res = await saveClassMapRemote({
      schoolId: props.schoolId, rows: payload, shareAliases: shareAliases.value,
    })
    rows.value.forEach(r => { if (r._dirty) { r._dirty = false; r.source = 'confirmed' } })
    toast.add({
      severity: 'success', summary: 'Class map saved',
      detail: `${res.written} value(s) confirmed` +
        (res.aliases_shared ? `, ${res.aliases_shared} shared with other schools` : ''),
      life: 4000,
    })
  } catch (e) {
    error.value = e.message || 'Could not save the class map.'
  } finally {
    saving.value = false
  }
}

/** Canonical grade name for the shared alias dictionary. */
function gradeCanonicalFor(ordinal) {
  if (ordinal === null || ordinal === undefined) return null
  const preprimary = { '-3': 'Pre-Nursery', '-2': 'Nursery', '-1': 'LKG', 0: 'UKG' }
  return preprimary[String(ordinal)] ?? String(ordinal)
}
</script>
