<template>
  <div class="pt-4">
    <div class="flex items-start justify-between mb-3 gap-3 flex-wrap">
      <div>
        <div class="text-sm font-bold text-slate-900">Attendance Months</div>
        <p class="text-xs text-slate-500 mt-0.5 max-w-2xl">
          Class-wise: each class has its own months and working days, which is what the teacher app's
          Attendance sheet reads. Edit a cell, then <b>Save changes</b>. Tick classes to target the bulk actions;
          with none ticked they apply to every class.
        </p>
      </div>
      <div class="flex gap-2 flex-wrap">
        <Button label="Generate Academic Year" icon="pi pi-calendar-plus" size="small" outlined :disabled="!classes.length" @click="openGenerateDialog" />
        <Button label="Set Working Days" icon="pi pi-pencil" size="small" outlined :disabled="!columns.length" @click="openBulkDialog" />
        <Button label="Copy From Class" icon="pi pi-copy" size="small" outlined :disabled="!classesWithMonths.length" @click="openCopyDialog" />
        <Button label="Remove Month" icon="pi pi-trash" size="small" outlined severity="danger" :disabled="!columns.length" @click="openRemoveDialog" />
        <Button label="Import CSV" icon="pi pi-upload" size="small" outlined :disabled="!classes.length" @click="importVisible = true" />
        <Button label="Sample CSV" icon="pi pi-download" size="small" text @click="downloadSample" />
        <Button label="Export CSV" icon="pi pi-file-export" size="small" text :disabled="!columns.length" @click="exportCsv" />
        <Button icon="pi pi-refresh" size="small" text rounded :loading="loading" v-tooltip.top="'Reload'" @click="loadMonths" />
      </div>
    </div>

    <CsvImportDialog
      v-model:visible="importVisible"
      title="Import Class Months CSV"
      :column-keys="MONTH_CSV_COLUMNS"
      :classify-row="classifyImportRow"
      :on-confirm="runImport"
    />

    <div v-if="loadError" class="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2 mb-3">
      {{ loadError }}
    </div>

    <!-- Legacy school-wide months: the teacher app no longer reads them. -->
    <div v-if="legacy.length && classesWithoutMonths.length" class="flex items-center justify-between gap-3 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-3">
      <div class="text-xs text-amber-800">
        This school has {{ legacy.length }} school-wide month(s) from the old setup, but
        {{ classesWithoutMonths.length }} class(es) have no months of their own — the teacher app will show
        “No attendance months are set up” for them.
      </div>
      <Button label="Copy school months into those classes" size="small" :loading="copyingLegacy" @click="copyLegacy" />
    </div>

    <div v-if="loading && !classes.length" class="flex items-center justify-center py-10">
      <ProgressSpinner style="width:28px;height:28px" />
    </div>

    <ConfigEmptyState v-else-if="!classes.length && !loadError" label="Attendance months" collection="classes/{classId}/months" blocked-by="Classes" blocked-tab="classes-teachers" />

    <template v-else-if="classes.length">
      <div class="flex items-center justify-between mb-2 gap-3 flex-wrap">
        <div class="text-xs text-slate-500">
          {{ classes.length }} class(es) · {{ columns.length }} month column(s)
          <template v-if="selectedIds.length"> · <b>{{ selectedIds.length }} selected</b>
            <button class="text-indigo-600 ml-1 hover:underline" @click="selectedIds = []">clear</button>
          </template>
        </div>
        <div class="flex items-center gap-2">
          <span v-if="dirtyCount" class="text-xs text-amber-600 font-medium">{{ dirtyCount }} unsaved change(s)</span>
          <Button label="Discard" size="small" text :disabled="!dirtyCount || saving" @click="discardEdits" />
          <Button :label="`Save changes${dirtyCount ? ` (${dirtyCount})` : ''}`" icon="pi pi-check" size="small" :loading="saving" :disabled="!dirtyCount" @click="saveEdits" />
        </div>
      </div>
      <div v-if="saveError" class="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2 mb-2">{{ saveError }}</div>

      <div class="bg-white rounded-xl border border-slate-200 overflow-auto">
        <table class="text-sm min-w-full">
          <thead class="bg-slate-50 text-xs text-slate-500">
            <tr>
              <th class="sticky left-0 bg-slate-50 z-10 px-3 py-2 text-left">
                <input type="checkbox" :checked="allSelected" :indeterminate.prop="someSelected" @change="toggleAll" />
              </th>
              <th class="sticky left-8 bg-slate-50 z-10 px-3 py-2 text-left font-semibold min-w-[140px]">Class</th>
              <th v-for="col in columns" :key="col.key" class="px-2 py-2 text-center font-semibold whitespace-nowrap">
                {{ shortLabel(col) }}
                <div class="font-normal text-[10px] text-slate-400">{{ col.key }}</div>
              </th>
              <th class="px-3 py-2 text-right font-semibold whitespace-nowrap">Total</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in sortedClasses" :key="c.id" class="border-t border-slate-100" :class="selectedIds.includes(c.id) ? 'bg-indigo-50/40' : ''">
              <td class="sticky left-0 bg-white z-10 px-3 py-1.5">
                <input type="checkbox" :value="c.id" v-model="selectedIds" />
              </td>
              <td class="sticky left-8 bg-white z-10 px-3 py-1.5 whitespace-nowrap">
                <span class="font-medium text-slate-800">{{ c.name }}</span>
                <span v-if="!c.isActive" class="ml-1 text-[10px] text-slate-400 uppercase">inactive</span>
                <div v-if="!(c.months || []).length" class="text-[10px] text-amber-600">no months</div>
              </td>
              <td v-for="col in columns" :key="col.key" class="px-1 py-1 text-center">
                <template v-if="hasCell(c.id, col.key)">
                  <input
                    type="number" min="0" max="31"
                    class="w-14 text-center rounded border px-1 py-0.5 text-sm"
                    :class="isDirty(c.id, col.key) ? 'border-amber-400 bg-amber-50' : 'border-slate-200'"
                    :value="cellValue(c.id, col.key)"
                    @change="e => setCell(c.id, col.key, e.target.value)"
                  />
                </template>
                <button v-else class="text-slate-300 hover:text-indigo-600 text-xs px-2" v-tooltip.top="`Add ${col.label} to ${c.name}`" @click="addCell(c.id, col.key)">
                  <i class="pi pi-plus" style="font-size:10px"></i>
                </button>
              </td>
              <td class="px-3 py-1.5 text-right text-slate-600 tabular-nums">{{ rowTotal(c) }}</td>
            </tr>
          </tbody>
        </table>
        <div v-if="!columns.length" class="text-center text-sm text-slate-400 py-8">
          No class has any months yet — use <b>Generate Academic Year</b>.
        </div>
      </div>
    </template>

    <!-- ── Generate Academic Year ───────────────────────────────────────── -->
    <Dialog v-model:visible="generateDialogVisible" header="Generate Academic Year" modal :style="{ width: '460px' }">
      <div class="space-y-4 pt-2">
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="form-label">Start Month *</label>
            <Select v-model="genForm.startMonth" :options="monthOptions" optionLabel="label" optionValue="value" class="w-full" />
          </div>
          <div>
            <label class="form-label">Start Year *</label>
            <InputNumber v-model="genForm.startYear" class="w-full" :useGrouping="false" />
          </div>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="form-label">Number of Months *</label>
            <InputNumber v-model="genForm.span" class="w-full" :min="1" :max="24" />
          </div>
          <div>
            <label class="form-label">Default Working Days</label>
            <InputNumber v-model="genForm.workingDays" class="w-full" :min="0" :max="31" />
          </div>
        </div>
        <div>
          <label class="form-label">Classes *</label>
          <MultiSelect v-model="genForm.classIds" :options="classOptions" optionLabel="label" optionValue="value" filter display="chip" class="w-full" placeholder="Pick classes" :maxSelectedLabels="4" />
        </div>
        <p class="text-xs text-slate-400">
          Creates or updates {{ (genForm.span || 0) * genForm.classIds.length }} class-month(s). Months a class
          already has keep their working days.
        </p>
        <div v-if="dialogError" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{{ dialogError }}</div>
      </div>
      <template #footer>
        <Button label="Cancel" text @click="generateDialogVisible = false" />
        <Button label="Generate" :loading="dialogBusy" @click="generateAcademicYear" />
      </template>
    </Dialog>

    <!-- ── Set Working Days (bulk, staged as edits) ─────────────────────── -->
    <Dialog v-model:visible="bulkDialogVisible" header="Set Working Days" modal :style="{ width: '440px' }">
      <div class="space-y-4 pt-2">
        <div>
          <label class="form-label">Month(s) *</label>
          <MultiSelect v-model="bulkForm.keys" :options="columnOptions" optionLabel="label" optionValue="value" class="w-full" placeholder="Pick months" :maxSelectedLabels="3" />
        </div>
        <div>
          <label class="form-label">Working Days *</label>
          <InputNumber v-model="bulkForm.workingDays" class="w-full" :min="0" :max="31" />
        </div>
        <label class="flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" v-model="bulkForm.addMissing" /> Also add the month to classes that don't have it
        </label>
        <p class="text-xs text-slate-400">
          Applies to {{ targetLabel }}. Changes are staged — review them in the grid, then Save changes.
        </p>
      </div>
      <template #footer>
        <Button label="Cancel" text @click="bulkDialogVisible = false" />
        <Button label="Apply" :disabled="!bulkForm.keys.length || bulkForm.workingDays == null" @click="applyBulk" />
      </template>
    </Dialog>

    <!-- ── Copy From Class ──────────────────────────────────────────────── -->
    <Dialog v-model:visible="copyDialogVisible" header="Copy Months From Class" modal :style="{ width: '460px' }">
      <div class="space-y-4 pt-2">
        <div>
          <label class="form-label">Copy from *</label>
          <Select v-model="copyForm.sourceId" :options="sourceOptions" optionLabel="label" optionValue="value" filter class="w-full" placeholder="Pick a class" />
        </div>
        <div>
          <label class="form-label">Into *</label>
          <MultiSelect v-model="copyForm.targetIds" :options="classOptions.filter(o => o.value !== copyForm.sourceId)" optionLabel="label" optionValue="value" filter display="chip" class="w-full" placeholder="Pick classes" :maxSelectedLabels="4" />
        </div>
        <label class="flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" v-model="copyForm.overwrite" /> Overwrite working days the target classes already have
        </label>
        <div v-if="dialogError" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{{ dialogError }}</div>
      </div>
      <template #footer>
        <Button label="Cancel" text @click="copyDialogVisible = false" />
        <Button label="Copy" :loading="dialogBusy" :disabled="!copyForm.sourceId || !copyForm.targetIds.length" @click="copyFromClass" />
      </template>
    </Dialog>

    <!-- ── Remove Month ─────────────────────────────────────────────────── -->
    <Dialog v-model:visible="removeDialogVisible" header="Remove Month" modal :style="{ width: '420px' }">
      <div class="space-y-4 pt-2">
        <div>
          <label class="form-label">Month(s) *</label>
          <MultiSelect v-model="removeForm.keys" :options="columnOptions" optionLabel="label" optionValue="value" class="w-full" placeholder="Pick months" :maxSelectedLabels="3" />
        </div>
        <p class="text-xs text-red-500">
          Removes the month from {{ targetLabel }} straight away. Attendance already entered is not deleted,
          but the teacher app stops showing that month's column.
        </p>
        <div v-if="dialogError" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{{ dialogError }}</div>
      </div>
      <template #footer>
        <Button label="Cancel" text @click="removeDialogVisible = false" />
        <Button label="Remove" severity="danger" :loading="dialogBusy" :disabled="!removeForm.keys.length" @click="removeMonths" />
      </template>
    </Dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted } from 'vue'
import { useToast } from 'primevue/usetoast'

import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import InputNumber from 'primevue/inputnumber'
import Select from 'primevue/select'
import MultiSelect from 'primevue/multiselect'
import ProgressSpinner from 'primevue/progressspinner'
import CsvImportDialog from './CsvImportDialog.vue'
import ConfigEmptyState from './ConfigEmptyState.vue'

import { listClassMonthsRemote, saveClassMonthsRemote, deleteClassMonthsRemote } from '../../utils/api.js'
import { assertValid, SchemaViolation } from '../../schemas/guardedWrite.js'
import { toCsv, downloadCsv } from '../../utils/csv.js'
import {
  MONTH_NAMES, DEFAULT_WORKING_DAYS, buildAcademicYear, buildColumns, indexMonths, editsToRows,
  rowsForMonths, cellId, compareClasses, toCsvRows,
} from '../../utils/classMonths.js'

const props = defineProps({ schoolId: { type: String, default: null } })
const toast = useToast()

const monthOptions = MONTH_NAMES.map((label, i) => ({ label, value: i + 1 }))

const classes = ref([])
const legacy = ref([])
const loading = ref(false)
const loadError = ref('')
const selectedIds = ref([])

// Pending cell edits, { [classId|key]: workingDays } — staged until Save.
const edits = ref({})
const saving = ref(false)
const saveError = ref('')

const sortedClasses = computed(() => [...classes.value].sort(compareClasses))
const columns = computed(() => buildColumns(classes.value))
const existing = computed(() => indexMonths(classes.value))

const classesWithMonths = computed(() => classes.value.filter(c => (c.months || []).length))
const classesWithoutMonths = computed(() => classes.value.filter(c => !(c.months || []).length))
const classOptions = computed(() => sortedClasses.value.map(c => ({ label: c.name, value: c.id })))
const sourceOptions = computed(() => [...classesWithMonths.value].sort(compareClasses)
  .map(c => ({ label: `${c.name} (${c.months.length} months)`, value: c.id })))
const columnOptions = computed(() => columns.value.map(c => ({ label: c.label, value: c.key })))
const allSelected = computed(() => classes.value.length > 0 && selectedIds.value.length === classes.value.length)
const someSelected = computed(() => selectedIds.value.length > 0 && !allSelected.value)
const targetIds = computed(() => (selectedIds.value.length ? selectedIds.value : classes.value.map(c => c.id)))
const targetLabel = computed(() => (selectedIds.value.length ? `the ${selectedIds.value.length} selected class(es)` : `all ${classes.value.length} classes`))
const dirtyCount = computed(() => Object.keys(edits.value).length)

function errText(e) {
  if (e instanceof SchemaViolation) return e.userMessage
  return e?.message || 'Something went wrong. Try again.'
}

async function loadMonths() {
  if (!props.schoolId) { classes.value = []; legacy.value = []; return }
  const forSchool = props.schoolId
  loading.value = true
  loadError.value = ''
  try {
    const res = await listClassMonthsRemote({ schoolId: forSchool })
    if (forSchool !== props.schoolId) return
    classes.value = res.classes || []
    legacy.value = res.legacy || []
    selectedIds.value = selectedIds.value.filter(id => classes.value.some(c => c.id === id))
  } catch (e) {
    console.error('Could not load class months', e)
    loadError.value = `Could not load class months: ${errText(e)}`
  } finally {
    loading.value = false
  }
}

function shortLabel(col) {
  return col.month ? `${MONTH_NAMES[col.month - 1].slice(0, 3)} ${String(col.year).slice(-2)}` : col.label
}

const hasCell = (classId, key) => cellId(classId, key) in edits.value || !!existing.value[cellId(classId, key)]
const isDirty = (classId, key) => cellId(classId, key) in edits.value
function cellValue(classId, key) {
  const id = cellId(classId, key)
  return id in edits.value ? edits.value[id] : existing.value[id]?.workingDays
}
function rowTotal(c) {
  return columns.value.reduce((sum, col) => {
    const v = hasCell(c.id, col.key) ? Number(cellValue(c.id, col.key)) : 0
    return sum + (Number.isFinite(v) ? v : 0)
  }, 0)
}

function setCell(classId, key, raw) {
  const id = cellId(classId, key)
  const v = raw === '' ? null : Math.round(Number(raw))
  const next = { ...edits.value }
  if (v == null || !Number.isFinite(v) || v < 0 || v > 31) {
    toast.add({ severity: 'warn', summary: 'Working days must be 0–31', life: 2500 })
    delete next[id]
  } else if (existing.value[id]?.workingDays === v) {
    delete next[id]
  } else {
    next[id] = v
  }
  edits.value = next
}

function defaultFor(key) {
  // The most common value other classes use for this month, else the default.
  const counts = {}
  for (const c of classes.value) {
    const v = existing.value[cellId(c.id, key)]?.workingDays
    if (v != null) counts[v] = (counts[v] || 0) + 1
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]
  return best ? Number(best[0]) : DEFAULT_WORKING_DAYS
}

function addCell(classId, key) {
  edits.value = { ...edits.value, [cellId(classId, key)]: defaultFor(key) }
}

function discardEdits() {
  edits.value = {}
  saveError.value = ''
}

function toggleAll(e) {
  selectedIds.value = e.target.checked ? classes.value.map(c => c.id) : []
}

function validateRows(rows) {
  for (const r of rows) {
    const { classId, ...payload } = r
    assertValid('months', payload)
  }
}

async function saveRows(rows) {
  validateRows(rows)
  return saveClassMonthsRemote({ schoolId: props.schoolId, rows })
}

async function saveEdits() {
  saveError.value = ''
  const rows = editsToRows(edits.value, existing.value, columns.value)
  if (!rows.length) return
  saving.value = true
  try {
    const res = await saveRows(rows)
    toast.add({ severity: 'success', summary: 'Saved', detail: `${res.written} class-month(s) updated`, life: 2500 })
    discardEdits()
    await loadMonths()
  } catch (e) {
    saveError.value = errText(e)
  } finally {
    saving.value = false
  }
}

// ── Shared dialog state ────────────────────────────────────────────────
const dialogBusy = ref(false)
const dialogError = ref('')

// ── Generate Academic Year ─────────────────────────────────────────────
const generateDialogVisible = ref(false)
const genForm = reactive({ startMonth: 6, startYear: new Date().getFullYear(), span: 12, workingDays: DEFAULT_WORKING_DAYS, classIds: [] })

function openGenerateDialog() {
  dialogError.value = ''
  genForm.classIds = [...targetIds.value]
  generateDialogVisible.value = true
}

async function generateAcademicYear() {
  if (!genForm.startMonth || !genForm.startYear || !genForm.span || !genForm.classIds.length) {
    dialogError.value = 'Fill in all fields and pick at least one class'
    return
  }
  dialogBusy.value = true
  dialogError.value = ''
  try {
    const months = buildAcademicYear(genForm)
    const rows = rowsForMonths(months, genForm.classIds, existing.value, { defaultWorkingDays: genForm.workingDays ?? DEFAULT_WORKING_DAYS })
    const res = await saveRows(rows)
    generateDialogVisible.value = false
    toast.add({ severity: 'success', summary: 'Generated', detail: `${res.written} class-month(s) created/updated`, life: 2500 })
    await loadMonths()
  } catch (e) {
    dialogError.value = errText(e)
  } finally {
    dialogBusy.value = false
  }
}

// ── Set Working Days (staged) ──────────────────────────────────────────
const bulkDialogVisible = ref(false)
const bulkForm = reactive({ keys: [], workingDays: null, addMissing: false })

function openBulkDialog() {
  Object.assign(bulkForm, { keys: [], workingDays: null, addMissing: false })
  bulkDialogVisible.value = true
}

function applyBulk() {
  const next = { ...edits.value }
  let staged = 0
  for (const classId of targetIds.value) {
    for (const key of bulkForm.keys) {
      if (!hasCell(classId, key) && !bulkForm.addMissing) continue
      const id = cellId(classId, key)
      if (existing.value[id]?.workingDays === bulkForm.workingDays) { delete next[id]; continue }
      next[id] = bulkForm.workingDays
      staged++
    }
  }
  edits.value = next
  bulkDialogVisible.value = false
  toast.add({ severity: 'info', summary: 'Staged', detail: `${staged} cell(s) changed — Save changes to apply`, life: 3000 })
}

// ── Copy From Class ────────────────────────────────────────────────────
const copyDialogVisible = ref(false)
const copyForm = reactive({ sourceId: null, targetIds: [], overwrite: false })

function openCopyDialog() {
  dialogError.value = ''
  Object.assign(copyForm, { sourceId: null, targetIds: [...selectedIds.value], overwrite: false })
  copyDialogVisible.value = true
}

async function copyFromClass() {
  const source = classes.value.find(c => c.id === copyForm.sourceId)
  if (!source) return
  dialogBusy.value = true
  dialogError.value = ''
  try {
    const targets = copyForm.targetIds.filter(id => id !== source.id)
    const rows = rowsForMonths(source.months, targets, existing.value, { overwriteWorkingDays: copyForm.overwrite })
    const res = await saveRows(rows)
    copyDialogVisible.value = false
    toast.add({ severity: 'success', summary: 'Copied', detail: `${res.written} class-month(s) written`, life: 2500 })
    await loadMonths()
  } catch (e) {
    dialogError.value = errText(e)
  } finally {
    dialogBusy.value = false
  }
}

// ── Legacy school-wide months → classes with none ──────────────────────
const copyingLegacy = ref(false)

async function copyLegacy() {
  copyingLegacy.value = true
  try {
    const months = legacy.value.filter(m => m.key && m.label && m.month && m.year)
      .map((m, i) => ({ ...m, order: m.order ?? i + 1 }))
    const rows = rowsForMonths(months, classesWithoutMonths.value.map(c => c.id), existing.value)
    const res = await saveRows(rows)
    toast.add({ severity: 'success', summary: 'Copied', detail: `${res.written} class-month(s) written`, life: 2500 })
    await loadMonths()
  } catch (e) {
    toast.add({ severity: 'error', summary: 'Could not copy', detail: errText(e), life: 5000 })
  } finally {
    copyingLegacy.value = false
  }
}

// ── Remove Month ───────────────────────────────────────────────────────
const removeDialogVisible = ref(false)
const removeForm = reactive({ keys: [] })

function openRemoveDialog() {
  dialogError.value = ''
  removeForm.keys = []
  removeDialogVisible.value = true
}

async function removeMonths() {
  dialogBusy.value = true
  dialogError.value = ''
  try {
    const rows = []
    for (const classId of targetIds.value) {
      for (const key of removeForm.keys) if (existing.value[cellId(classId, key)]) rows.push({ classId, key })
    }
    const res = await deleteClassMonthsRemote({ schoolId: props.schoolId, rows })
    // Drop any staged edits for what was just removed.
    const next = { ...edits.value }
    for (const r of rows) delete next[cellId(r.classId, r.key)]
    edits.value = next
    removeDialogVisible.value = false
    toast.add({ severity: 'info', summary: 'Removed', detail: `${res.deleted} class-month(s) removed`, life: 2500 })
    await loadMonths()
  } catch (e) {
    dialogError.value = errText(e)
  } finally {
    dialogBusy.value = false
  }
}

// ── CSV import/export ──────────────────────────────────────────────────
const MONTH_CSV_COLUMNS = ['classId', 'className', 'key', 'label', 'month', 'year', 'order', 'workingDays']
const importVisible = ref(false)

async function classifyImportRow(raw) {
  const classId = (raw.classId || '').trim()
  const key = (raw.key || '').trim()
  const payload = {
    key,
    label: (raw.label || '').trim(),
    month: Number(raw.month),
    year: Number(raw.year),
    order: Number(raw.order),
    workingDays: Number((raw.workingDays ?? '').toString().trim() || DEFAULT_WORKING_DAYS),
  }
  if (!classId) return { raw, _status: 'ERROR', _reason: 'Missing classId' }
  if (!classes.value.some(c => c.id === classId)) return { raw, _status: 'ERROR', _reason: `Unknown class "${classId}"` }
  try {
    assertValid('months', payload)
  } catch (e) {
    return { raw, _status: 'ERROR', _reason: errText(e) }
  }
  return {
    raw, _status: existing.value[cellId(classId, key)] ? 'UPDATE' : 'CREATE',
    row: { classId, ...payload },
  }
}

async function runImport(validRows) {
  const res = await saveRows(validRows.map(r => r.row))
  toast.add({ severity: 'success', summary: 'Imported', detail: `${res.written} class-month(s)`, life: 2500 })
  await loadMonths()
}

function downloadSample() {
  const y = new Date().getFullYear()
  const first = sortedClasses.value[0] || { id: 'class-id', name: 'Class name' }
  const sample = [
    { classId: first.id, className: first.name, key: `${y}-04`, label: `April ${y}`, month: 4, year: y, order: 1, workingDays: 22 },
    { classId: first.id, className: first.name, key: `${y}-05`, label: `May ${y}`, month: 5, year: y, order: 2, workingDays: 20 },
  ]
  downloadCsv('class_months_sample.csv', toCsv(sample, MONTH_CSV_COLUMNS))
}

function exportCsv() {
  downloadCsv(`class_months_${props.schoolId}.csv`, toCsv(toCsvRows(classes.value), MONTH_CSV_COLUMNS))
}

watch(() => props.schoolId, () => { discardEdits(); selectedIds.value = []; loadMonths() })
onMounted(loadMonths)
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
