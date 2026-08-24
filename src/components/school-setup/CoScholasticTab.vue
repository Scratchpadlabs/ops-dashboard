<template>
  <div class="pt-4">
    <div class="flex items-center justify-between mb-3">
      <div class="flex items-center gap-3">
        <div class="text-sm font-bold text-slate-900">Co-Scholastic Activities</div>
        <Select v-model="selectedTermId" :options="terms" optionLabel="name" optionValue="id" placeholder="Select a term" class="w-56" />
      </div>
      <div class="flex gap-2">
        <Button :label="gridMode ? 'Exit Grid Edit' : 'Grid Edit'" icon="pi pi-table" size="small" outlined :disabled="!selectedTermId" @click="gridMode ? exitGridMode() : enterGridMode()" />
        <Button label="Import CSV" icon="pi pi-upload" size="small" outlined @click="openImport" />
        <Button label="Sample CSV" icon="pi pi-download" size="small" text @click="downloadSample" />
        <Button label="Export CSV" icon="pi pi-file-export" size="small" text :disabled="!selectedTermId" @click="exportCsv" />
        <Button label="Add Activity" icon="pi pi-plus" size="small" :disabled="!selectedTermId" @click="openAdd" />
      </div>
    </div>

    <CsvImportDialog
      v-model:visible="importVisible"
      title="Import Co-Scholastic Activities CSV"
      :column-keys="ACTIVITY_CSV_COLUMNS"
      :classify-row="classifyImportRow"
      :on-confirm="runImport"
    />

    <!-- No terms at all is a different state from "pick a term": the school
         has never been set up, and assessments cannot exist without a term. -->
    <ConfigEmptyState
      v-if="!terms.length" label="Co-Scholastic activities" collection="co_scholastic_activities"
      blocked-by="Add a term in Terms &amp; Scales" blocked-tab="terms-scales"
    />
    <div v-else-if="!selectedTermId" class="text-center text-sm text-slate-400 py-10 bg-white rounded-xl border border-slate-200">
      Select a term to view or create activities.
    </div>
    <div v-else-if="loading" class="flex items-center justify-center py-10">
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
        <Column field="name" header="Name">
          <template #editor="{ data, field }"><InputText v-model="data[field]" class="w-full" /></template>
        </Column>
        <Column field="order" header="#" style="width:60px">
          <template #editor="{ data, field }"><InputNumber v-model="data[field]" class="w-full" :min="1" /></template>
        </Column>
        <Column field="entryType" header="Type" style="width:100px">
          <template #editor="{ data, field }"><Select v-model="data[field]" :options="entryTypeOptions" optionLabel="label" optionValue="value" class="w-full" /></template>
        </Column>
        <Column field="maxMarks" header="Max" style="width:80px">
          <template #editor="{ data, field }"><InputNumber v-model="data[field]" class="w-full" :min="1" /></template>
        </Column>
        <Column field="gradingScaleId" header="Scale" style="width:150px">
          <template #body="{ data }">{{ scaleLabel(data.gradingScaleId) }}</template>
          <template #editor="{ data, field }"><Select v-model="data[field]" :options="scales" optionLabel="name" optionValue="id" showClear class="w-full" /></template>
        </Column>
        <Column field="conversionType" header="Conversion" style="width:130px">
          <template #editor="{ data, field }"><Select v-model="data[field]" :options="conversionTypeOptions" optionLabel="label" optionValue="value" class="w-full" /></template>
        </Column>
        <Column field="conversionFactor" header="Factor" style="width:80px">
          <template #editor="{ data, field }"><InputNumber v-model="data[field]" class="w-full" :min="0.01" :maxFractionDigits="2" /></template>
        </Column>
        <Column header="" style="width:200px">
          <template #body="{ data }"><span v-if="data._error" class="text-xs text-red-500">{{ data._error }}</span></template>
        </Column>
      </DataTable>
      <div v-if="!gridRows.length" class="text-center text-sm text-slate-400 py-8">No rows — add one</div>
      <div v-if="gridSaveError" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2 mt-3">{{ gridSaveError }}</div>
    </div>

    <div v-else class="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <DataTable :value="activities" size="small" stripedRows>
        <Column field="order" header="#" style="width:50px" />
        <Column field="name" header="Name" />
        <Column field="entryType" header="Type" style="width:80px" />
        <Column field="maxMarks" header="Max" style="width:70px" />
        <Column header="Conversion" style="width:180px">
          <template #body="{ data }"><span class="text-slate-500">{{ conversionLabel(data) }}</span></template>
        </Column>
        <Column header="" style="width:80px">
          <template #body="{ data }">
            <div class="flex gap-1">
              <Button icon="pi pi-pencil" text rounded size="small" @click="openEdit(data)" />
              <Button icon="pi pi-trash" text rounded size="small" severity="danger" @click="confirmDeleteActivity(data)" />
            </div>
          </template>
        </Column>
      </DataTable>
      <div v-if="!activities.length" class="text-center text-sm text-slate-400 py-8">No activities for this term yet</div>
    </div>

    <!-- ── Add/Edit Dialog ──────────────────────────────────────────────── -->
    <Dialog v-model:visible="dialogVisible" :header="editingActivity ? 'Edit Activity' : 'Add Activity'" modal :style="{ width: '480px' }">
      <div class="space-y-4 pt-2">
        <div>
          <label class="form-label">Name *</label>
          <KbClassifiedInput
            v-model="form.name"
            :expect="COSCHOLASTIC"
            context="the Co-Scholastic activities list in School Setup"
            placeholder="e.g. Art & Craft"
            @classified="onNameClassified"
          />
          <p v-if="areaWarning" class="text-xs text-amber-600 mt-1">
            <i class="pi pi-exclamation-triangle text-xs mr-0.5"></i>{{ areaWarning }}
          </p>
        </div>
        <div class="grid grid-cols-2 gap-4">
          <div>
            <label class="form-label">Entry Type *</label>
            <Select v-model="form.entryType" :options="entryTypeOptions" optionLabel="label" optionValue="value" class="w-full" />
          </div>
          <div>
            <label class="form-label">Max Marks *</label>
            <InputNumber v-model="form.maxMarks" class="w-full" :min="1" />
          </div>
          <div>
            <label class="form-label">Grading Scale{{ form.entryType === 'grade' || form.conversionType === 'marks_to_grade' ? ' *' : '' }}</label>
            <Select v-model="form.gradingScaleId" :options="scales" optionLabel="name" optionValue="id" showClear class="w-full" />
          </div>
          <div>
            <label class="form-label">Conversion Type *</label>
            <Select v-model="form.conversionType" :options="conversionTypeOptions" optionLabel="label" optionValue="value" class="w-full" />
          </div>
          <div v-if="form.conversionType === 'sum_up' || form.conversionType === 'sum_down'">
            <label class="form-label">Conversion Factor *</label>
            <InputNumber v-model="form.conversionFactor" class="w-full" :min="0.01" :maxFractionDigits="2" />
          </div>
          <div>
            <label class="form-label">Order *</label>
            <InputNumber v-model="form.order" class="w-full" :min="1" />
          </div>
        </div>
        <div v-if="formError" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{{ formError }}</div>
      </div>
      <template #footer>
        <Button label="Cancel" text @click="dialogVisible = false" />
        <Button :label="editingActivity ? 'Save Changes' : 'Add Activity'" :loading="saving" @click="saveActivity" />
      </template>
    </Dialog>

    <ConfirmDialog />
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted } from 'vue'
import { getDocs, getDoc, query, where, setDoc, deleteDoc, serverTimestamp, writeBatch } from 'firebase/firestore'
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
import CsvImportDialog from './CsvImportDialog.vue'
import ConfigEmptyState from './ConfigEmptyState.vue'
import KbClassifiedInput from '../shared/KbClassifiedInput.vue'

import { schoolCollection, schoolDoc } from '../../firebase/schoolCollections.js'
import { guardedSetDoc, guardedUpdateDoc, MODE_UPDATE, SchemaViolation } from '../../schemas/guardedWrite.js'
import { db, auth } from '../../firebase/config'
import { checkEnteredMarksCoScholastic, slugify } from '../../utils/assessmentHelpers.js'
import { toCsv, downloadCsv } from '../../utils/csv.js'
import { useEducationKB } from '../../composables/useEducationKB.js'
import { COSCHOLASTIC, SUBJECT } from '../../utils/educationKB.js'

const props = defineProps({ schoolId: { type: String, default: null } })

// The knowledge base knows which side of the scholastic line an activity
// belongs on. Here it earns its keep by catching the genuine mistake: an
// academic subject typed into the Co-Scholastic tab. Warned, never blocked —
// a school is allowed to grade Computer as an activity if it wants to.
const { loadKB } = useEducationKB()
const areaWarning = ref('')

function onNameClassified({ type, canonical }) {
  areaWarning.value = type === SUBJECT
    ? `“${canonical}” is normally a scholastic subject — add it under Subjects unless this school grades it as an activity.`
    : ''
}
const confirm = useConfirm()
const toast = useToast()

const entryTypeOptions = [{ label: 'Marks', value: 'marks' }, { label: 'Grade', value: 'grade' }]
const conversionTypeOptions = [
  { label: 'None', value: 'none' },
  { label: 'Marks → Grade', value: 'marks_to_grade' },
  { label: 'Sum Up', value: 'sum_up' },
  { label: 'Sum Down', value: 'sum_down' },
]

const terms = ref([])
const scales = ref([])
const activities = ref([])
const selectedTermId = ref(null)
const loading = ref(false)

function scaleLabel(id) { return scales.value.find(s => s.id === id)?.name || id }
function conversionLabel(a) {
  if (a.conversionType === 'marks_to_grade') return `Grade via ${scaleLabel(a.gradingScaleId)}`
  if (a.conversionType === 'sum_up') return `Out of ${(a.maxMarks * (a.conversionFactor || 1)).toFixed(2)}`
  if (a.conversionType === 'sum_down') return `Out of ${(a.maxMarks / (a.conversionFactor || 1)).toFixed(2)}`
  return 'None'
}

async function loadStatic() {
  if (!props.schoolId) { terms.value = []; scales.value = []; return }
  try {
    const [tSnap, gSnap] = await Promise.all([
      getDocs(schoolCollection(props.schoolId, 'terms')),
      getDocs(schoolCollection(props.schoolId, 'grading_scales')),
    ])
    terms.value = tSnap.docs.map(d => ({ id: d.id, ...d.data() }))
    scales.value = gSnap.docs.map(d => ({ id: d.id, ...d.data() }))
  } catch (e) {
    console.error('Could not load terms/scales', e)
  }
}

async function loadActivities() {
  if (!props.schoolId || !selectedTermId.value) { activities.value = []; return }
  loading.value = true
  try {
    const snap = await getDocs(query(schoolCollection(props.schoolId, 'co_scholastic_activities'), where('termId', '==', selectedTermId.value)))
    activities.value = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order || 0) - (b.order || 0))
  } catch (e) {
    console.error('Could not load co-scholastic activities', e)
    activities.value = []
  } finally {
    loading.value = false
  }
}

const dialogVisible = ref(false)
const editingActivity = ref(null)
const saving = ref(false)
const formError = ref('')
const form = reactive({ name: '', entryType: 'marks', maxMarks: null, gradingScaleId: null, conversionType: 'none', conversionFactor: null, order: 1 })

function openAdd() {
  editingActivity.value = null
  const nextOrder = activities.value.length ? Math.max(...activities.value.map(a => a.order || 0)) + 1 : 1
  Object.assign(form, { name: '', entryType: 'marks', maxMarks: null, gradingScaleId: null, conversionType: 'none', conversionFactor: null, order: nextOrder })
  areaWarning.value = ''
  formError.value = ''
  dialogVisible.value = true
}

function openEdit(activity) {
  editingActivity.value = activity
  Object.assign(form, {
    name: activity.name, entryType: activity.entryType, maxMarks: activity.maxMarks,
    gradingScaleId: activity.gradingScaleId || null, conversionType: activity.conversionType || 'none',
    conversionFactor: activity.conversionFactor || null, order: activity.order || 1,
  })
  areaWarning.value = ''
  formError.value = ''
  dialogVisible.value = true
}

function validateActivity() {
  if (!form.name.trim()) return 'Name is required'
  if (!form.maxMarks || form.maxMarks <= 0) return 'Max marks must be greater than 0'
  if (form.conversionType !== 'none' && form.conversionType !== 'marks_to_grade' && !form.conversionFactor) return 'Conversion factor is required for this conversion type'
  if ((form.conversionType === 'marks_to_grade' || form.entryType === 'grade') && !form.gradingScaleId) return 'Grading scale is required'
  return ''
}

async function saveActivity() {
  formError.value = validateActivity()
  if (formError.value) return

  if (editingActivity.value) {
    const sensitiveChange = form.maxMarks !== editingActivity.value.maxMarks || form.entryType !== editingActivity.value.entryType
    if (sensitiveChange) {
      const hasEntries = await checkEnteredMarksCoScholastic(props.schoolId, selectedTermId.value).catch(() => 'error')
      if (hasEntries === 'error') { formError.value = 'Could not verify whether marks have been entered — aborting to be safe.'; return }
      if (hasEntries) {
        const proceed = await new Promise(resolve => {
          confirm.require({
            message: 'Teachers may have already entered marks for co-scholastic activities this term. Changing Max Marks or Entry Type may invalidate those values. Continue anyway?',
            header: 'Entered marks exist', icon: 'pi pi-exclamation-triangle',
            rejectLabel: 'Cancel', acceptLabel: 'Continue anyway', acceptClass: 'p-button-danger',
            accept: () => resolve(true), reject: () => resolve(false),
          })
        })
        if (!proceed) return
      }
    }
  }

  saving.value = true
  try {
    const docId = editingActivity.value ? editingActivity.value.id : `${selectedTermId.value}_${slugify(form.name)}`
    const payload = {
      name: form.name.trim(), termId: selectedTermId.value, entryType: form.entryType, maxMarks: form.maxMarks,
      gradingScaleId: form.gradingScaleId || null, conversionType: form.conversionType,
      conversionFactor: form.conversionFactor || null, order: form.order,
      updated_at: serverTimestamp(), updated_by: auth.currentUser?.email || 'unknown',
    }
    if (!editingActivity.value) {
      payload.created_at = serverTimestamp()
      payload.created_by = auth.currentUser?.email || 'unknown'
    }
    await guardedSetDoc('co_scholastic_activities', schoolDoc(props.schoolId, 'co_scholastic_activities', docId), payload,
      { mode: editingActivity.value ? MODE_UPDATE : undefined })
    dialogVisible.value = false
    toast.add({ severity: 'success', summary: 'Saved', life: 2000 })
    await loadActivities()
  } catch (e) {
    console.error(e)
    formError.value = e instanceof SchemaViolation ? e.userMessage : 'Something went wrong. Try again.'
  } finally {
    saving.value = false
  }
}

async function confirmDeleteActivity(activity) {
  const hasEntries = await checkEnteredMarksCoScholastic(props.schoolId, selectedTermId.value).catch(() => 'error')
  if (hasEntries === 'error') {
    toast.add({ severity: 'error', summary: 'Error', detail: 'Could not verify whether marks exist — not deleting', life: 4000 })
    return
  }
  confirm.require({
    message: hasEntries
      ? `Teachers may have already entered marks for "${activity.name}". Deleting will orphan those values. Delete anyway?`
      : `Remove activity "${activity.name}"? This cannot be undone.`,
    header: 'Remove Activity', icon: 'pi pi-exclamation-triangle',
    rejectLabel: 'Cancel', acceptLabel: 'Remove', acceptClass: 'p-button-danger',
    accept: async () => {
      try {
        await deleteDoc(schoolDoc(props.schoolId, 'co_scholastic_activities', activity.id))
        toast.add({ severity: 'info', summary: 'Removed', life: 2000 })
        await loadActivities()
      } catch (e) {
        toast.add({ severity: 'error', summary: 'Error', detail: 'Could not remove', life: 3000 })
      }
    },
  })
}

// ── Grid Edit mode ───────────────────────────────────────────────────────
const gridMode = ref(false)
const gridRows = ref([])
const savingGrid = ref(false)
const gridSaveError = ref('')

const dirtyCount = computed(() => gridRows.value.filter(r => r._dirty).length)

function validateGridRow(row) {
  if (!row.name || !row.name.trim()) return 'Name is required'
  if (!row.maxMarks || row.maxMarks <= 0) return 'Max marks must be greater than 0'
  if (row.conversionType !== 'none' && row.conversionType !== 'marks_to_grade' && !row.conversionFactor) return 'Conversion factor is required for this conversion type'
  if ((row.conversionType === 'marks_to_grade' || row.entryType === 'grade') && !row.gradingScaleId) return 'Grading scale is required'
  return ''
}

function enterGridMode() {
  gridRows.value = activities.value.map(a => ({ ...a, _dirty: false, _isNew: false, _error: '' }))
  gridSaveError.value = ''
  gridMode.value = true
}
function exitGridMode() {
  gridMode.value = false
  gridRows.value = []
}

function addBlankGridRow() {
  const nextOrder = gridRows.value.length ? Math.max(...gridRows.value.map(r => r.order || 0)) + 1
    : (activities.value.length ? Math.max(...activities.value.map(a => a.order || 0)) + 1 : 1)
  const row = {
    name: '', entryType: 'marks', maxMarks: null, gradingScaleId: null,
    conversionType: 'none', conversionFactor: null, order: nextOrder, _isNew: true, _dirty: true, _error: '',
  }
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

  // Safety gate: existing rows where maxMarks/entryType changed, fired per row
  // (co-scholastic entries are term-wide, so the check itself is per-term, but
  // we still confirm once, listing exactly which rows triggered it).
  const originalById = new Map(activities.value.map(a => [a.id, a]))
  const sensitiveRows = dirtyRows.filter(r => !r._isNew && originalById.has(r.id)
    && (r.maxMarks !== originalById.get(r.id).maxMarks || r.entryType !== originalById.get(r.id).entryType))

  if (sensitiveRows.length) {
    const hasEntries = await checkEnteredMarksCoScholastic(props.schoolId, selectedTermId.value).catch(() => 'error')
    if (hasEntries === 'error') { gridSaveError.value = 'Could not verify entered marks — aborting to be safe.'; return }
    if (hasEntries) {
      const proceed = await new Promise(resolve => {
        confirm.require({
          message: `Teachers may have already entered marks this term. ${sensitiveRows.length} changed row(s) (${sensitiveRows.map(r => r.name).join(', ')}) may invalidate those values. Continue anyway?`,
          header: 'Entered marks exist', icon: 'pi pi-exclamation-triangle',
          rejectLabel: 'Cancel', acceptLabel: 'Continue anyway', acceptClass: 'p-button-danger',
          accept: () => resolve(true), reject: () => resolve(false),
        })
      })
      if (!proceed) return
    }
  }

  savingGrid.value = true
  try {
    for (let i = 0; i < dirtyRows.length; i += 450) {
      const chunk = dirtyRows.slice(i, i + 450)
      const batch = writeBatch(db)
      chunk.forEach(r => {
        const payload = {
          name: r.name.trim(), termId: selectedTermId.value, entryType: r.entryType, maxMarks: r.maxMarks,
          gradingScaleId: r.gradingScaleId || null, conversionType: r.conversionType,
          conversionFactor: r.conversionFactor || null, order: r.order,
          updated_at: serverTimestamp(), updated_by: auth.currentUser?.email || 'unknown',
        }
        const docId = r._isNew ? `${selectedTermId.value}_${slugify(r.name)}` : r.id
        batch.set(schoolDoc(props.schoolId, 'co_scholastic_activities', docId), payload, { merge: true })
      })
      await batch.commit()
    }
    toast.add({ severity: 'success', summary: 'Saved', detail: `${dirtyRows.length} row(s) saved`, life: 2500 })
    await loadActivities()
    exitGridMode()
  } catch (e) {
    console.error(e)
    gridSaveError.value = 'Something went wrong while saving. Some rows may have been written.'
  } finally {
    savingGrid.value = false
  }
}

// ── CSV import/export ────────────────────────────────────────────────────
const ACTIVITY_CSV_COLUMNS = ['name', 'termId', 'order', 'entryType', 'maxMarks', 'gradingScaleId', 'conversionType', 'conversionFactor']
const importVisible = ref(false)

// Re-read terms and grading scales before validating an import.
// loadStatic otherwise runs only on mount and on a schoolId change, and every
// School Setup tab is mounted at once — so importing grading scales (or
// subjects) on another tab leaves this one holding the list it read before
// they existed, and every row that references one is rejected as "Unknown".
async function openImport() {
  await loadStatic()
  importVisible.value = true
}

async function classifyImportRow(raw) {
  const name = (raw.name || '').trim()
  const termId = (raw.termId || '').trim()
  const order = Number(raw.order)
  const entryType = (raw.entryType || '').trim()
  const maxMarks = Number(raw.maxMarks)
  const gradingScaleId = (raw.gradingScaleId || '').trim() || null
  const conversionType = (raw.conversionType || 'none').trim()
  const conversionFactorRaw = (raw.conversionFactor ?? '').toString().trim()
  const conversionFactor = conversionFactorRaw ? Number(conversionFactorRaw) : null

  if (!name) return { raw, _status: 'ERROR', _reason: 'Missing name' }
  if (!termId) return { raw, _status: 'ERROR', _reason: 'Missing termId' }
  if (!terms.value.some(t => t.id === termId)) return { raw, _status: 'ERROR', _reason: `Unknown termId "${termId}"` }
  if (!order || Number.isNaN(order)) return { raw, _status: 'ERROR', _reason: 'Missing/invalid order' }
  if (!['marks', 'grade'].includes(entryType)) return { raw, _status: 'ERROR', _reason: 'entryType must be "marks" or "grade"' }
  if (!maxMarks || Number.isNaN(maxMarks) || maxMarks <= 0) return { raw, _status: 'ERROR', _reason: 'maxMarks must be a number greater than 0' }
  if (!['none', 'marks_to_grade', 'sum_up', 'sum_down'].includes(conversionType)) return { raw, _status: 'ERROR', _reason: 'conversionType must be none/marks_to_grade/sum_up/sum_down' }
  if (conversionType !== 'none' && conversionType !== 'marks_to_grade' && !conversionFactor) return { raw, _status: 'ERROR', _reason: 'conversionFactor is required for this conversionType' }
  if ((conversionType === 'marks_to_grade' || entryType === 'grade') && !gradingScaleId) return { raw, _status: 'ERROR', _reason: 'gradingScaleId is required' }
  if (gradingScaleId && !scales.value.some(s => s.id === gradingScaleId)) return { raw, _status: 'ERROR', _reason: `Unknown gradingScaleId "${gradingScaleId}"` }

  const id = `${termId}_${slugify(name)}`
  const payload = { name, termId, order, entryType, maxMarks, gradingScaleId, conversionType, conversionFactor }
  const existingSnap = await getDoc(schoolDoc(props.schoolId, 'co_scholastic_activities', id))
  if (!existingSnap.exists()) return { raw, id, _status: 'CREATE', payload }

  const existing = existingSnap.data()
  const sensitiveChange = maxMarks !== existing.maxMarks || entryType !== existing.entryType
  return {
    raw, id, _status: 'UPDATE', payload, _sensitiveChange: sensitiveChange,
    _warning: sensitiveChange ? 'Changes maxMarks/entryType — entered-marks check runs on confirm' : undefined,
  }
}

async function runImport(validRows) {
  const sensitiveRows = validRows.filter(r => r._sensitiveChange)
  if (sensitiveRows.length) {
    const hasEntries = await checkEnteredMarksCoScholastic(props.schoolId, sensitiveRows[0].payload.termId).catch(() => 'error')
    if (hasEntries === 'error') {
      toast.add({ severity: 'error', summary: 'Error', detail: 'Could not verify entered marks — aborting.', life: 4000 })
      return false
    }
    if (hasEntries) {
      const proceed = await new Promise(resolve => {
        confirm.require({
          message: `Teachers may have already entered marks this term. ${sensitiveRows.length} changed row(s) (${sensitiveRows.map(r => r.payload.name).join(', ')}) may invalidate those values. Continue anyway?`,
          header: 'Entered marks exist', icon: 'pi pi-exclamation-triangle',
          rejectLabel: 'Cancel', acceptLabel: 'Continue anyway', acceptClass: 'p-button-danger',
          accept: () => resolve(true), reject: () => resolve(false),
        })
      })
      if (!proceed) return false
    }
  }

  for (let i = 0; i < validRows.length; i += 450) {
    const chunk = validRows.slice(i, i + 450)
    const batch = writeBatch(db)
    chunk.forEach(r => batch.set(schoolDoc(props.schoolId, 'co_scholastic_activities', r.id), {
      ...r.payload, updated_at: serverTimestamp(), updated_by: auth.currentUser?.email || 'unknown',
    }, { merge: true }))
    await batch.commit()
  }
  toast.add({ severity: 'success', summary: 'Imported', detail: `${validRows.length} row(s)`, life: 2500 })
  if (selectedTermId.value) await loadActivities()
  return true
}

function downloadSample() {
  const term = terms.value[0]
  const scale = scales.value[0]
  if (!term) {
    toast.add({ severity: 'warn', summary: 'Add a term first', detail: 'The sample needs at least one real term from this school to reference', life: 4000 })
    return
  }
  const sample = [
    { name: 'Art & Craft', termId: term.id, order: 1, entryType: 'marks', maxMarks: 10, gradingScaleId: '', conversionType: 'none', conversionFactor: '' },
    { name: 'Discipline', termId: term.id, order: 2, entryType: 'grade', maxMarks: 10, gradingScaleId: scale?.id || '', conversionType: 'marks_to_grade', conversionFactor: '' },
  ]
  downloadCsv('co_scholastic_sample.csv', toCsv(sample, ACTIVITY_CSV_COLUMNS))
}

function exportCsv() {
  downloadCsv(`co_scholastic_${selectedTermId.value}.csv`, toCsv(activities.value, ACTIVITY_CSV_COLUMNS))
}

watch(() => props.schoolId, () => { loadStatic(); activities.value = []; selectedTermId.value = null })
watch(selectedTermId, () => { loadActivities(); exitGridMode() })
onMounted(() => { loadStatic(); loadKB() })
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
