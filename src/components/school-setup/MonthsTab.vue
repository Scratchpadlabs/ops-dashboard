<template>
  <div class="pt-4">
    <div class="flex items-center justify-between mb-3">
      <div class="text-sm font-bold text-slate-900">Months</div>
      <div class="flex gap-2">
        <SectionTemplateActions section-type="months" :school-id="props.schoolId" @applied="loadMonths" />
        <Button :label="gridMode ? 'Exit Grid Edit' : 'Grid Edit'" icon="pi pi-table" size="small" outlined @click="gridMode ? exitGridMode() : enterGridMode()" />
        <Button label="Generate Academic Year" icon="pi pi-calendar-plus" size="small" outlined @click="openGenerateDialog" />
        <Button label="Import CSV" icon="pi pi-upload" size="small" outlined @click="importVisible = true" />
        <Button label="Download Sample CSV" icon="pi pi-download" size="small" text @click="downloadSample" />
        <Button label="Export CSV" icon="pi pi-file-export" size="small" text @click="exportCsv" />
        <Button label="Add Month" icon="pi pi-plus" size="small" @click="openAddMonth" />
      </div>
    </div>

    <CsvImportDialog
      v-model:visible="importVisible"
      title="Import Months CSV"
      :column-keys="MONTH_CSV_COLUMNS"
      :classify-row="classifyImportRow"
      :on-confirm="runImport"
    />

    <div v-if="loading" class="flex items-center justify-center py-10">
      <ProgressSpinner style="width:28px;height:28px" />
    </div>

    <!-- ── Grid Edit mode ───────────────────────────────────────────────── -->
    <div v-else-if="gridMode" class="bg-white rounded-xl border border-slate-200 p-3">
      <div class="flex items-center justify-between mb-3">
        <div class="text-sm font-semibold text-slate-700">{{ dirtyCount }} unsaved row(s)</div>
        <div class="flex gap-2">
          <Button label="+ Add Row" size="small" text @click="addBlankGridRow" />
          <Button label="Save All" size="small" :loading="savingGrid" :disabled="!dirtyCount" @click="saveAllGrid" />
        </div>
      </div>
      <DataTable :value="gridRows" editMode="cell" size="small" stripedRows @cell-edit-complete="onCellEditComplete">
        <Column style="width:24px">
          <template #body="{ data }"><i v-if="data._dirty" class="pi pi-circle-fill text-amber-400" style="font-size:8px"></i></template>
        </Column>
        <Column field="label" header="Label">
          <template #editor="{ data, field }"><InputText v-model="data[field]" class="w-full" /></template>
        </Column>
        <Column field="key" header="Key">
          <template #body="{ data }"><span :class="data._isNew ? '' : 'text-slate-400'">{{ data.key }}</span></template>
          <template #editor="{ data, field }">
            <InputText v-if="data._isNew" v-model="data[field]" class="w-full" placeholder="e.g. 2026-04" />
            <span v-else class="text-xs text-slate-400">locked</span>
          </template>
        </Column>
        <Column field="month" header="Month" style="width:80px">
          <template #editor="{ data, field }"><InputNumber v-model="data[field]" class="w-full" :min="1" :max="12" /></template>
        </Column>
        <Column field="year" header="Year" style="width:90px">
          <template #editor="{ data, field }"><InputNumber v-model="data[field]" class="w-full" :useGrouping="false" /></template>
        </Column>
        <Column field="order" header="#" style="width:60px">
          <template #editor="{ data, field }"><InputNumber v-model="data[field]" class="w-full" :min="1" /></template>
        </Column>
        <Column field="workingDays" header="Working Days" style="width:120px">
          <template #editor="{ data, field }"><InputNumber v-model="data[field]" class="w-full" :min="0" :max="31" /></template>
        </Column>
        <Column header="" style="width:200px">
          <template #body="{ data }"><span v-if="data._error" class="text-xs text-red-500">{{ data._error }}</span></template>
        </Column>
      </DataTable>
      <div v-if="!gridRows.length" class="text-center text-sm text-slate-400 py-8">No rows — add one</div>
      <div v-if="gridSaveError" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2 mt-3">{{ gridSaveError }}</div>
    </div>

    <div v-else class="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <DataTable :value="months" size="small" stripedRows>
        <Column field="order" header="#" style="width:50px" />
        <Column field="label" header="Month" />
        <Column field="key" header="Key" />
        <Column header="Working Days" style="width:160px">
          <template #body="{ data }">
            <InputNumber
              :modelValue="data.workingDays"
              class="w-24"
              :min="0" :max="31"
              @update:modelValue="v => updateWorkingDays(data, v)"
            />
          </template>
        </Column>
        <Column header="" style="width:80px">
          <template #body="{ data }">
            <div class="flex gap-1">
              <Button icon="pi pi-pencil" text rounded size="small" @click="openEditMonth(data)" />
              <Button icon="pi pi-trash" text rounded size="small" severity="danger" @click="confirmDeleteMonth(data)" />
            </div>
          </template>
        </Column>
      </DataTable>
      <div v-if="!months.length" class="text-center text-sm text-slate-400 py-8">No months yet</div>
    </div>

    <!-- ── Add/Edit Month Dialog ────────────────────────────────────────── -->
    <Dialog v-model:visible="dialogVisible" :header="editingMonth ? 'Edit Month' : 'Add Month'" modal :style="{ width: '420px' }">
      <div class="space-y-4 pt-2">
        <div>
          <label class="form-label">Label *</label>
          <InputText v-model="form.label" class="w-full" placeholder="e.g. April 2026" />
        </div>
        <div>
          <label class="form-label">Key *</label>
          <InputText v-model="form.key" class="w-full" placeholder="e.g. 2026-04" :disabled="!!editingMonth" />
        </div>
        <div class="grid grid-cols-3 gap-3">
          <div>
            <label class="form-label">Month *</label>
            <InputNumber v-model="form.month" class="w-full" :min="1" :max="12" />
          </div>
          <div>
            <label class="form-label">Year *</label>
            <InputNumber v-model="form.year" class="w-full" :useGrouping="false" />
          </div>
          <div>
            <label class="form-label">Order *</label>
            <InputNumber v-model="form.order" class="w-full" :min="1" />
          </div>
        </div>
        <div>
          <label class="form-label">Working Days</label>
          <InputNumber v-model="form.workingDays" class="w-full" :min="0" :max="31" />
        </div>
        <div v-if="formError" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{{ formError }}</div>
      </div>
      <template #footer>
        <Button label="Cancel" text @click="dialogVisible = false" />
        <Button :label="editingMonth ? 'Save Changes' : 'Add Month'" :loading="saving" @click="saveMonth" />
      </template>
    </Dialog>

    <!-- ── Generate Academic Year Dialog ────────────────────────────────── -->
    <Dialog v-model:visible="generateDialogVisible" header="Generate Academic Year" modal :style="{ width: '420px' }">
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
        <div>
          <label class="form-label">Number of Months *</label>
          <InputNumber v-model="genForm.span" class="w-full" :min="1" :max="24" />
        </div>
        <p class="text-xs text-slate-400">
          This will create or update {{ genForm.span || 0 }} month doc(s). Existing months in
          range keep their current Working Days; new ones default to 22.
        </p>
        <div v-if="generateError" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{{ generateError }}</div>
      </div>
      <template #footer>
        <Button label="Cancel" text @click="generateDialogVisible = false" />
        <Button label="Generate" :loading="generating" @click="generateAcademicYear" />
      </template>
    </Dialog>

    <ConfirmDialog />
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted } from 'vue'
import {
  getDocs, addDoc, updateDoc, deleteDoc, query, orderBy, serverTimestamp, writeBatch,
} from 'firebase/firestore'
import { useConfirm } from 'primevue/useconfirm'
import { useToast } from 'primevue/usetoast'

import Button from 'primevue/button'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import InputNumber from 'primevue/inputnumber'
import Select from 'primevue/select'
import ProgressSpinner from 'primevue/progressspinner'
import ConfirmDialog from 'primevue/confirmdialog'
import SectionTemplateActions from './SectionTemplateActions.vue'
import CsvImportDialog from './CsvImportDialog.vue'

import { schoolCollection, schoolDoc } from '../../firebase/schoolCollections.js'
import { db } from '../../firebase/config'
import { auth } from '../../firebase/config'
import { toCsv, downloadCsv } from '../../utils/csv.js'

const props = defineProps({ schoolId: { type: String, default: null } })
const confirm = useConfirm()
const toast = useToast()

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const monthOptions = MONTH_NAMES.map((label, i) => ({ label, value: i + 1 }))

const months = ref([])
const loading = ref(false)
const dialogVisible = ref(false)
const editingMonth = ref(null)
const saving = ref(false)
const formError = ref('')
const form = reactive({ label: '', key: '', month: null, year: null, order: null, workingDays: null })

async function loadMonths() {
  if (!props.schoolId) { months.value = []; return }
  loading.value = true
  try {
    const snap = await getDocs(query(schoolCollection(props.schoolId, 'months'), orderBy('order')))
    months.value = snap.docs.map(d => ({ id: d.id, ...d.data() }))
  } catch (e) {
    console.error('Could not load months', e)
    months.value = []
  } finally {
    loading.value = false
  }
}

function openAddMonth() {
  editingMonth.value = null
  const nextOrder = months.value.length ? Math.max(...months.value.map(m => m.order || 0)) + 1 : 1
  Object.assign(form, { label: '', key: '', month: null, year: null, order: nextOrder, workingDays: null })
  formError.value = ''
  dialogVisible.value = true
}

function openEditMonth(month) {
  editingMonth.value = month
  Object.assign(form, {
    label: month.label || '', key: month.key || '', month: month.month || null,
    year: month.year || null, order: month.order || null, workingDays: month.workingDays ?? null,
  })
  formError.value = ''
  dialogVisible.value = true
}

function validateMonth() {
  if (!form.label.trim()) return 'Label is required'
  if (!form.key.trim()) return 'Key is required'
  if (!form.month || form.month < 1 || form.month > 12) return 'Month must be 1-12'
  if (!form.year) return 'Year is required'
  if (!form.order) return 'Order is required'
  return ''
}

async function saveMonth() {
  formError.value = validateMonth()
  if (formError.value) return
  saving.value = true
  try {
    const payload = {
      label: form.label.trim(), key: form.key.trim(), month: form.month,
      year: form.year, order: form.order, workingDays: form.workingDays,
    }
    if (editingMonth.value) {
      payload.updated_at = serverTimestamp()
      payload.updated_by = auth.currentUser?.email || 'unknown'
      await updateDoc(schoolDoc(props.schoolId, 'months', editingMonth.value.id), payload)
    } else {
      payload.created_at = serverTimestamp()
      payload.created_by = auth.currentUser?.email || 'unknown'
      await addDoc(schoolCollection(props.schoolId, 'months'), payload)
    }
    dialogVisible.value = false
    toast.add({ severity: 'success', summary: 'Saved', life: 2000 })
    await loadMonths()
  } catch (e) {
    formError.value = 'Something went wrong. Try again.'
  } finally {
    saving.value = false
  }
}

async function updateWorkingDays(month, value) {
  try {
    await updateDoc(schoolDoc(props.schoolId, 'months', month.id), {
      workingDays: value, updated_at: serverTimestamp(), updated_by: auth.currentUser?.email || 'unknown',
    })
    month.workingDays = value
  } catch (e) {
    toast.add({ severity: 'error', summary: 'Error', detail: 'Could not update working days', life: 3000 })
  }
}

function confirmDeleteMonth(month) {
  confirm.require({
    message: `Remove "${month.label}"? This cannot be undone.`,
    header: 'Remove Month',
    icon: 'pi pi-exclamation-triangle',
    rejectLabel: 'Cancel', acceptLabel: 'Remove', acceptClass: 'p-button-danger',
    accept: async () => {
      try {
        await deleteDoc(schoolDoc(props.schoolId, 'months', month.id))
        toast.add({ severity: 'info', summary: 'Removed', life: 2000 })
        await loadMonths()
      } catch (e) {
        toast.add({ severity: 'error', summary: 'Error', detail: 'Could not remove', life: 3000 })
      }
    },
  })
}

// ── Generate Academic Year ────────────────────────────────────────────────
const generateDialogVisible = ref(false)
const generating = ref(false)
const generateError = ref('')
const genForm = reactive({ startMonth: 6, startYear: new Date().getFullYear(), span: 12 })

function openGenerateDialog() {
  generateError.value = ''
  generateDialogVisible.value = true
}

async function generateAcademicYear() {
  if (!genForm.startMonth || !genForm.startYear || !genForm.span) {
    generateError.value = 'Fill in all fields'
    return
  }
  generating.value = true
  generateError.value = ''
  try {
    const existingKeys = new Set(months.value.map(m => m.key))
    const batch = writeBatch(db)
    for (let i = 0; i < genForm.span; i++) {
      const month = ((genForm.startMonth - 1 + i) % 12) + 1
      const year = genForm.startYear + Math.floor((genForm.startMonth - 1 + i) / 12)
      const key = `${year}-${String(month).padStart(2, '0')}`
      const payload = {
        key, label: `${MONTH_NAMES[month - 1]} ${year}`, month, year, order: i + 1,
        updated_at: serverTimestamp(), updated_by: auth.currentUser?.email || 'unknown',
      }
      if (!existingKeys.has(key)) {
        payload.workingDays = 22
        payload.created_at = serverTimestamp()
        payload.created_by = auth.currentUser?.email || 'unknown'
      }
      batch.set(schoolDoc(props.schoolId, 'months', key), payload, { merge: true })
    }
    await batch.commit()
    generateDialogVisible.value = false
    toast.add({ severity: 'success', summary: 'Generated', detail: `${genForm.span} month(s) created/updated`, life: 2500 })
    await loadMonths()
  } catch (e) {
    generateError.value = 'Something went wrong. Try again.'
  } finally {
    generating.value = false
  }
}

// ── Grid Edit mode ───────────────────────────────────────────────────────
const gridMode = ref(false)
const gridRows = ref([])
const savingGrid = ref(false)
const gridSaveError = ref('')

const dirtyCount = computed(() => gridRows.value.filter(r => r._dirty).length)

function validateGridRow(row) {
  if (!row.label.trim()) return 'Label is required'
  if (!row.key.trim()) return 'Key is required'
  if (!row.month || row.month < 1 || row.month > 12) return 'Month must be 1-12'
  if (!row.year) return 'Year is required'
  if (!row.order) return 'Order is required'
  return ''
}

function enterGridMode() {
  gridRows.value = months.value.map(m => ({ ...m, _dirty: false, _isNew: false, _error: '' }))
  gridSaveError.value = ''
  gridMode.value = true
}
function exitGridMode() {
  gridMode.value = false
  gridRows.value = []
}

function addBlankGridRow() {
  const nextOrder = gridRows.value.length ? Math.max(...gridRows.value.map(r => r.order || 0)) + 1
    : (months.value.length ? Math.max(...months.value.map(m => m.order || 0)) + 1 : 1)
  const row = { label: '', key: '', month: null, year: null, order: nextOrder, workingDays: null, _isNew: true, _dirty: true, _error: '' }
  row._error = validateGridRow(row)
  gridRows.value.push(row)
}

function onCellEditComplete(event) {
  const { data, newValue, field } = event
  data[field] = newValue
  data._dirty = true
  data._error = validateGridRow(data)
}

async function saveAllGrid() {
  gridSaveError.value = ''
  const dirtyRows = gridRows.value.filter(r => r._dirty)
  if (!dirtyRows.length) return
  dirtyRows.forEach(r => { r._error = validateGridRow(r) })
  const errored = dirtyRows.filter(r => r._error)
  if (errored.length) { gridSaveError.value = `${errored.length} row(s) have errors — fix them before saving.`; return }

  savingGrid.value = true
  try {
    for (let i = 0; i < dirtyRows.length; i += 450) {
      const chunk = dirtyRows.slice(i, i + 450)
      const batch = writeBatch(db)
      chunk.forEach(r => {
        const payload = {
          label: r.label.trim(), key: r.key.trim(), month: r.month, year: r.year,
          order: r.order, workingDays: r.workingDays,
          updated_at: serverTimestamp(), updated_by: auth.currentUser?.email || 'unknown',
        }
        if (r._isNew) {
          batch.set(schoolDoc(props.schoolId, 'months', r.key.trim()), payload, { merge: true })
        } else {
          batch.update(schoolDoc(props.schoolId, 'months', r.id), payload)
        }
      })
      await batch.commit()
    }
    toast.add({ severity: 'success', summary: 'Saved', detail: `${dirtyRows.length} row(s) saved`, life: 2500 })
    await loadMonths()
    exitGridMode()
  } catch (e) {
    console.error(e)
    gridSaveError.value = 'Something went wrong while saving. Some rows may have been written.'
  } finally {
    savingGrid.value = false
  }
}

// ── CSV import/export ────────────────────────────────────────────────────
const MONTH_CSV_COLUMNS = ['key', 'label', 'month', 'year', 'order', 'workingDays']
const importVisible = ref(false)

async function classifyImportRow(raw) {
  const key = (raw.key || '').trim()
  const label = (raw.label || '').trim()
  const month = Number(raw.month)
  const year = Number(raw.year)
  const order = Number(raw.order)
  const workingDaysRaw = (raw.workingDays ?? '').toString().trim()
  const workingDays = workingDaysRaw ? Number(workingDaysRaw) : null

  if (!key) return { raw, _status: 'ERROR', _reason: 'Missing key' }
  if (!label) return { raw, _status: 'ERROR', _reason: 'Missing label' }
  if (!month || month < 1 || month > 12) return { raw, _status: 'ERROR', _reason: 'Month must be 1-12' }
  if (!year || Number.isNaN(year)) return { raw, _status: 'ERROR', _reason: 'Missing/invalid year' }
  if (!order || Number.isNaN(order)) return { raw, _status: 'ERROR', _reason: 'Missing/invalid order' }
  if (workingDaysRaw && Number.isNaN(workingDays)) return { raw, _status: 'ERROR', _reason: 'Working days must be numeric' }

  const existing = months.value.find(m => m.id === key)
  return {
    raw, id: key, _status: existing ? 'UPDATE' : 'CREATE',
    payload: { key, label, month, year, order, workingDays },
  }
}

async function runImport(validRows) {
  for (let i = 0; i < validRows.length; i += 450) {
    const chunk = validRows.slice(i, i + 450)
    const batch = writeBatch(db)
    chunk.forEach(r => batch.set(schoolDoc(props.schoolId, 'months', r.id), {
      ...r.payload, updated_at: serverTimestamp(), updated_by: auth.currentUser?.email || 'unknown',
    }, { merge: true }))
    await batch.commit()
  }
  toast.add({ severity: 'success', summary: 'Imported', detail: `${validRows.length} row(s)`, life: 2500 })
  await loadMonths()
}

function downloadSample() {
  const y = new Date().getFullYear()
  const sample = [
    { key: `${y}-04`, label: `April ${y}`, month: 4, year: y, order: 1, workingDays: 22 },
    { key: `${y}-05`, label: `May ${y}`, month: 5, year: y, order: 2, workingDays: 20 },
  ]
  downloadCsv('months_sample.csv', toCsv(sample, MONTH_CSV_COLUMNS))
}

function exportCsv() {
  downloadCsv(`months_${props.schoolId}.csv`, toCsv(months.value, MONTH_CSV_COLUMNS))
}

watch(() => props.schoolId, () => { loadMonths(); exitGridMode() })
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
