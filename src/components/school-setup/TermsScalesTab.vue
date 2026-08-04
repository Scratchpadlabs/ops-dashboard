<template>
  <div class="grid gap-6 lg:grid-cols-2 pt-4">

    <!-- ── Terms ────────────────────────────────────────────────────────── -->
    <div>
      <div class="flex items-center justify-between mb-3">
        <div class="text-sm font-bold text-slate-900">Terms</div>
        <div class="flex gap-2">
          <Button label="Import CSV" icon="pi pi-upload" size="small" outlined @click="termImportVisible = true" />
          <Button label="Sample CSV" icon="pi pi-download" size="small" text @click="downloadTermSample" />
          <Button label="Export CSV" icon="pi pi-file-export" size="small" text @click="exportTerms" />
          <Button label="Add Term" icon="pi pi-plus" size="small" @click="openAddTerm" />
        </div>
      </div>

      <CsvImportDialog
        v-model:visible="termImportVisible"
        title="Import Terms CSV"
        :column-keys="TERM_CSV_COLUMNS"
        :classify-row="classifyTermRow"
        :on-confirm="runTermImport"
      />

      <div v-if="loadingTerms" class="flex items-center justify-center py-10">
        <ProgressSpinner style="width:28px;height:28px" />
      </div>
      <div v-else class="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <DataTable :value="terms" size="small" stripedRows>
          <Column field="name" header="Name">
            <template #body="{ data }">
              <div class="font-medium text-sm text-slate-900">{{ data.name }}</div>
              <div class="text-xs text-slate-400">{{ data.academicYear }}</div>
            </template>
          </Column>
          <Column field="isActive" header="Active" style="width:80px">
            <template #body="{ data }">
              <i :class="data.isActive !== false ? 'pi pi-check-circle text-emerald-500' : 'pi pi-circle text-slate-300'"></i>
            </template>
          </Column>
          <Column header="" style="width:80px">
            <template #body="{ data }">
              <div class="flex gap-1">
                <Button icon="pi pi-pencil" text rounded size="small" @click="openEditTerm(data)" />
                <Button icon="pi pi-trash" text rounded size="small" severity="danger" @click="confirmDeleteTerm(data)" />
              </div>
            </template>
          </Column>
        </DataTable>
        <ConfigEmptyState v-if="!terms.length" label="Terms" collection="terms" />
      </div>
    </div>

    <!-- ── Grading Scales ───────────────────────────────────────────────── -->
    <div>
      <div class="flex items-center justify-between mb-3">
        <div class="text-sm font-bold text-slate-900">Grading Scales</div>
        <div class="flex gap-2">
          <Button label="Import CSV" icon="pi pi-upload" size="small" outlined @click="openScaleImport" />
          <Button label="Sample CSV" icon="pi pi-download" size="small" text @click="downloadScaleSample" />
          <Button label="Export CSV" icon="pi pi-file-export" size="small" text @click="exportScales" />
          <Button label="Add Scale" icon="pi pi-plus" size="small" @click="openAddScale" />
        </div>
      </div>

      <div v-if="loadingScales" class="flex items-center justify-center py-10">
        <ProgressSpinner style="width:28px;height:28px" />
      </div>
      <div v-else class="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <DataTable :value="scales" size="small" stripedRows>
          <Column field="name" header="Name">
            <template #body="{ data }">
              <div class="font-medium text-sm text-slate-900">{{ data.name }}</div>
              <div class="text-xs text-slate-400">{{ (data.levels || []).length }} level(s)</div>
            </template>
          </Column>
          <Column header="" style="width:80px">
            <template #body="{ data }">
              <div class="flex gap-1">
                <Button icon="pi pi-pencil" text rounded size="small" @click="openEditScale(data)" />
                <Button icon="pi pi-trash" text rounded size="small" severity="danger" @click="confirmDeleteScale(data)" />
              </div>
            </template>
          </Column>
        </DataTable>
        <ConfigEmptyState v-if="!scales.length" label="Grading scales" collection="grading_scales" />
      </div>
    </div>

    <!-- ── Term Dialog ──────────────────────────────────────────────────── -->
    <Dialog v-model:visible="termDialogVisible" :header="editingTerm ? 'Edit Term' : 'Add Term'" modal :style="{ width: '420px' }">
      <div class="space-y-4 pt-2">
        <div>
          <label class="form-label">Name *</label>
          <InputText v-model="termForm.name" class="w-full" placeholder="e.g. Term 1" />
        </div>
        <div>
          <label class="form-label">Academic Year *</label>
          <InputText v-model="termForm.academicYear" class="w-full" placeholder="e.g. 2025-26" />
        </div>
        <div class="flex items-center gap-2">
          <label class="form-label mb-0">Active</label>
          <ToggleButton v-model="termForm.isActive" onLabel="Yes" offLabel="No" size="small" />
        </div>
        <div v-if="termFormError" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{{ termFormError }}</div>
      </div>
      <template #footer>
        <Button label="Cancel" text @click="termDialogVisible = false" />
        <Button :label="editingTerm ? 'Save Changes' : 'Add Term'" :loading="savingTerm" @click="saveTerm" />
      </template>
    </Dialog>

    <!-- ── Grading Scale Dialog ─────────────────────────────────────────── -->
    <Dialog v-model:visible="scaleDialogVisible" :header="editingScale ? 'Edit Grading Scale' : 'Add Grading Scale'" modal :style="{ width: '560px' }">
      <div class="space-y-4 pt-2">
        <div>
          <label class="form-label">Name *</label>
          <InputText v-model="scaleForm.name" class="w-full" placeholder="e.g. Standard Scale" />
        </div>

        <div>
          <div class="flex items-center justify-between mb-2">
            <label class="form-label mb-0">Levels (must cover 0-100 with no gaps/overlaps)</label>
            <button type="button" class="text-xs text-violet-600 font-semibold" @click="addLevel">+ Add Level</button>
          </div>
          <div v-for="(level, i) in scaleForm.levels" :key="i" class="grid grid-cols-12 gap-2 mb-2 items-center">
            <InputText v-model="level.label" placeholder="Label (e.g. A+)" class="col-span-4 text-sm" />
            <InputNumber v-model="level.minPercent" placeholder="Min %" class="col-span-2" :min="0" :max="100" />
            <InputNumber v-model="level.maxPercent" placeholder="Max %" class="col-span-2" :min="0" :max="100" />
            <div class="col-span-4 flex gap-1 justify-end">
              <Button icon="pi pi-chevron-up" text rounded size="small" :disabled="i === 0" @click="moveLevel(i, -1)" />
              <Button icon="pi pi-chevron-down" text rounded size="small" :disabled="i === scaleForm.levels.length - 1" @click="moveLevel(i, 1)" />
              <Button icon="pi pi-trash" text rounded size="small" severity="danger" @click="removeLevel(i)" />
            </div>
          </div>
          <p v-if="!scaleForm.levels.length" class="text-xs text-slate-400">No levels yet — add at least one.</p>
        </div>

        <div v-if="scaleFormError" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{{ scaleFormError }}</div>
      </div>
      <template #footer>
        <Button label="Cancel" text @click="scaleDialogVisible = false" />
        <Button :label="editingScale ? 'Save Changes' : 'Add Scale'" :loading="savingScale" @click="saveScale" />
      </template>
    </Dialog>

    <!-- ── Grading Scale CSV Import (bespoke — rows group into scales) ────── -->
    <Dialog v-model:visible="scaleImportVisible" header="Import Grading Scales CSV" modal :style="{ width: '760px' }">
      <div class="space-y-3 pt-2">
        <p class="text-xs text-slate-400">One row per level — rows sharing the same scaleName group into one scale doc.</p>
        <input type="file" accept=".csv,.tsv,text/csv,text/tab-separated-values" @change="onScaleFileChange" class="text-sm" />
        <div v-if="scaleImportParsing" class="text-sm text-slate-400">Parsing...</div>
        <div v-else-if="scaleImportGroups.length">
          <div class="flex items-center gap-4 text-xs mb-2">
            <span class="text-emerald-600 font-semibold">{{ scaleImportGroups.filter(g => g.status === 'CREATE').length }} create</span>
            <span class="text-blue-600 font-semibold">{{ scaleImportGroups.filter(g => g.status === 'UPDATE').length }} update</span>
            <span class="text-red-600 font-semibold">{{ scaleImportGroups.filter(g => g.status === 'ERROR').length }} error</span>
            <button v-if="scaleImportGroups.some(g => g.status === 'ERROR')" type="button" class="text-violet-600 font-semibold ml-auto" @click="downloadScaleImportErrors">Download errors as CSV</button>
          </div>
          <div class="max-h-96 overflow-auto border border-slate-200 rounded-lg">
            <table class="w-full text-xs">
              <thead class="sticky top-0 bg-white">
                <tr class="border-b border-slate-200">
                  <th class="text-left px-2 py-1.5">Status</th>
                  <th class="text-left px-2 py-1.5">Scale</th>
                  <th class="text-left px-2 py-1.5">Levels</th>
                  <th class="text-left px-2 py-1.5">Notes</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(g, i) in scaleImportGroups" :key="i" class="border-b border-slate-100" :class="g.status === 'ERROR' ? 'bg-red-50' : ''">
                  <td class="px-2 py-1.5">
                    <span class="px-1.5 py-0.5 rounded text-[10px] font-semibold"
                      :class="{'bg-emerald-100 text-emerald-700': g.status==='CREATE', 'bg-blue-100 text-blue-700': g.status==='UPDATE', 'bg-red-100 text-red-700': g.status==='ERROR'}">{{ g.status }}</span>
                  </td>
                  <td class="px-2 py-1.5">{{ g.scaleName }}</td>
                  <td class="px-2 py-1.5">{{ g.levels.map(l => `${l.label} (${l.minPercent}-${l.maxPercent})`).join(', ') }}</td>
                  <td class="px-2 py-1.5 text-red-500">{{ g.reason }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <div v-if="scaleImportError" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{{ scaleImportError }}</div>
      </div>
      <template #footer>
        <Button label="Cancel" text @click="scaleImportVisible = false" />
        <Button label="Confirm" :loading="scaleImportConfirming" :disabled="!scaleImportValidCount" @click="confirmScaleImport" />
      </template>
    </Dialog>

    <ConfirmDialog />
  </div>
</template>

<script setup>
import { ref, reactive, watch, onMounted } from 'vue'
import {
  getDocs, setDoc, updateDoc, deleteDoc, query, where, orderBy, serverTimestamp,
} from 'firebase/firestore'
import { useConfirm } from 'primevue/useconfirm'
import { useToast } from 'primevue/usetoast'

import Button from 'primevue/button'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import InputNumber from 'primevue/inputnumber'
import ToggleButton from 'primevue/togglebutton'
import ProgressSpinner from 'primevue/progressspinner'
import ConfirmDialog from 'primevue/confirmdialog'
import CsvImportDialog from './CsvImportDialog.vue'
import ConfigEmptyState from './ConfigEmptyState.vue'

import { schoolCollection, schoolDoc } from '../../firebase/schoolCollections.js'
import { guardedSetDoc, guardedUpdateDoc, SchemaViolation } from '../../schemas/guardedWrite.js'
import { db, auth } from '../../firebase/config'
import { slugify } from '../../utils/assessmentHelpers.js'
import { parseCsv, toCsv, downloadCsv, readFileAsText } from '../../utils/csv.js'
import { writeBatch } from 'firebase/firestore'

const props = defineProps({ schoolId: { type: String, default: null } })
const confirm = useConfirm()
const toast = useToast()

// ── Referential integrity — checked before any term/scale delete ─────────
async function countReferences(field, value) {
  const [aSnap, cSnap] = await Promise.all([
    getDocs(query(schoolCollection(props.schoolId, 'assessments'), where(field, '==', value))),
    getDocs(query(schoolCollection(props.schoolId, 'co_scholastic_activities'), where(field, '==', value))),
  ])
  return aSnap.size + cSnap.size
}

// ── Terms ────────────────────────────────────────────────────────────────
const terms = ref([])
const loadingTerms = ref(false)
const termDialogVisible = ref(false)
const editingTerm = ref(null)
const savingTerm = ref(false)
const termFormError = ref('')
const termForm = reactive({ name: '', academicYear: '', isActive: true })

async function loadTerms() {
  if (!props.schoolId) { terms.value = []; return }
  loadingTerms.value = true
  try {
    // Single orderBy only — ordering by two fields would need a composite index.
    const snap = await getDocs(query(schoolCollection(props.schoolId, 'terms'), orderBy('academicYear')))
    terms.value = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.academicYear || '').localeCompare(b.academicYear || '') || (a.name || '').localeCompare(b.name || ''))
  } catch (e) {
    console.error('Could not load terms', e)
    terms.value = []
  } finally {
    loadingTerms.value = false
  }
}

function openAddTerm() {
  editingTerm.value = null
  Object.assign(termForm, { name: '', academicYear: '', isActive: true })
  termFormError.value = ''
  termDialogVisible.value = true
}

function openEditTerm(term) {
  editingTerm.value = term
  Object.assign(termForm, { name: term.name || '', academicYear: term.academicYear || '', isActive: term.isActive !== false })
  termFormError.value = ''
  termDialogVisible.value = true
}

function validateTerm() {
  if (!termForm.name.trim()) return 'Name is required'
  if (!termForm.academicYear.trim()) return 'Academic year is required'
  return ''
}

async function saveTerm() {
  termFormError.value = validateTerm()
  if (termFormError.value) return
  savingTerm.value = true
  try {
    const payload = {
      name: termForm.name.trim(),
      academicYear: termForm.academicYear.trim(),
      isActive: termForm.isActive,
    }
    if (editingTerm.value) {
      payload.updated_at = serverTimestamp()
      payload.updated_by = auth.currentUser?.email || 'unknown'
      await guardedUpdateDoc('terms', schoolDoc(props.schoolId, 'terms', editingTerm.value.id), payload)
    } else {
      payload.created_at = serverTimestamp()
      payload.created_by = auth.currentUser?.email || 'unknown'
      // Deterministic slug ID (matching subjects/classes/assessments) so CSV
      // import can match this doc by ID rather than always creating a duplicate.
      const id = `${slugify(termForm.name)}_${slugify(termForm.academicYear)}`
      await guardedSetDoc('terms', schoolDoc(props.schoolId, 'terms', id), payload)
    }
    termDialogVisible.value = false
    toast.add({ severity: 'success', summary: 'Saved', life: 2000 })
    await loadTerms()
  } catch (e) {
    termFormError.value = e instanceof SchemaViolation ? e.userMessage : 'Something went wrong. Try again.'
  } finally {
    savingTerm.value = false
  }
}

async function confirmDeleteTerm(term) {
  const refCount = await countReferences('termId', term.id).catch(() => null)
  if (refCount === null) {
    toast.add({ severity: 'error', summary: 'Error', detail: 'Could not check references', life: 3000 })
    return
  }
  if (refCount > 0) {
    confirm.require({
      message: `"${term.name}" is referenced by ${refCount} assessment/activity doc(s). Remove those first.`,
      header: 'Cannot delete',
      icon: 'pi pi-exclamation-triangle',
      acceptLabel: 'OK', rejectClass: 'hidden',
      accept: () => {},
    })
    return
  }
  confirm.require({
    message: `Remove term "${term.name}"? This cannot be undone.`,
    header: 'Remove Term',
    icon: 'pi pi-exclamation-triangle',
    rejectLabel: 'Cancel', acceptLabel: 'Remove', acceptClass: 'p-button-danger',
    accept: async () => {
      try {
        await deleteDoc(schoolDoc(props.schoolId, 'terms', term.id))
        toast.add({ severity: 'info', summary: 'Removed', life: 2000 })
        await loadTerms()
      } catch (e) {
        toast.add({ severity: 'error', summary: 'Error', detail: 'Could not remove', life: 3000 })
      }
    },
  })
}

// ── Grading Scales ─────────────────────────────────────────────────────────
const scales = ref([])
const loadingScales = ref(false)
const scaleDialogVisible = ref(false)
const editingScale = ref(null)
const savingScale = ref(false)
const scaleFormError = ref('')
const scaleForm = reactive({ name: '', levels: [] })

async function loadScales() {
  if (!props.schoolId) { scales.value = []; return }
  loadingScales.value = true
  try {
    const snap = await getDocs(query(schoolCollection(props.schoolId, 'grading_scales'), orderBy('name')))
    scales.value = snap.docs.map(d => ({ id: d.id, ...d.data() }))
  } catch (e) {
    console.error('Could not load grading scales', e)
    scales.value = []
  } finally {
    loadingScales.value = false
  }
}

function openAddScale() {
  editingScale.value = null
  Object.assign(scaleForm, { name: '', levels: [] })
  scaleFormError.value = ''
  scaleDialogVisible.value = true
}

function openEditScale(scale) {
  editingScale.value = scale
  Object.assign(scaleForm, {
    name: scale.name || '',
    levels: (scale.levels || []).map(l => ({ ...l })),
  })
  scaleFormError.value = ''
  scaleDialogVisible.value = true
}

function addLevel() {
  scaleForm.levels.push({ label: '', minPercent: null, maxPercent: null })
}
function removeLevel(i) {
  scaleForm.levels.splice(i, 1)
}
function moveLevel(i, dir) {
  const j = i + dir
  if (j < 0 || j >= scaleForm.levels.length) return
  const [item] = scaleForm.levels.splice(i, 1)
  scaleForm.levels.splice(j, 0, item)
}

function validateLevelsCoverage(levels) {
  if (!levels.length) return 'Add at least one level'
  for (const l of levels) {
    if (!l.label.trim()) return 'Every level needs a label'
    if (l.minPercent === null || l.minPercent === undefined || l.maxPercent === null || l.maxPercent === undefined) {
      return 'Every level needs a min and max percent'
    }
    if (l.minPercent > l.maxPercent) return `"${l.label}": min% cannot exceed max%`
  }
  const labels = levels.map(l => l.label.trim().toLowerCase())
  if (new Set(labels).size !== labels.length) return 'Level labels must be unique'
  const sorted = [...levels].sort((a, b) => a.minPercent - b.minPercent)
  if (sorted[0].minPercent !== 0) return 'Levels must start at 0%'
  if (sorted[sorted.length - 1].maxPercent !== 100) return 'Levels must end at 100%'
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].minPercent !== sorted[i - 1].maxPercent + 1) {
      return `Gap or overlap between "${sorted[i - 1].label}" and "${sorted[i].label}"`
    }
  }
  return ''
}

function validateScale() {
  if (!scaleForm.name.trim()) return 'Name is required'
  return validateLevelsCoverage(scaleForm.levels)
}

async function saveScale() {
  scaleFormError.value = validateScale()
  if (scaleFormError.value) return
  savingScale.value = true
  try {
    const payload = {
      name: scaleForm.name.trim(),
      levels: scaleForm.levels.map(l => ({ label: l.label.trim(), minPercent: l.minPercent, maxPercent: l.maxPercent })),
    }
    if (editingScale.value) {
      payload.updated_at = serverTimestamp()
      payload.updated_by = auth.currentUser?.email || 'unknown'
      await guardedUpdateDoc('grading_scales', schoolDoc(props.schoolId, 'grading_scales', editingScale.value.id), payload)
    } else {
      payload.created_at = serverTimestamp()
      payload.created_by = auth.currentUser?.email || 'unknown'
      const id = slugify(scaleForm.name)
      await guardedSetDoc('grading_scales', schoolDoc(props.schoolId, 'grading_scales', id), payload)
    }
    scaleDialogVisible.value = false
    toast.add({ severity: 'success', summary: 'Saved', life: 2000 })
    await loadScales()
  } catch (e) {
    scaleFormError.value = e instanceof SchemaViolation ? e.userMessage : 'Something went wrong. Try again.'
  } finally {
    savingScale.value = false
  }
}

async function confirmDeleteScale(scale) {
  const refCount = await countReferences('gradingScaleId', scale.id).catch(() => null)
  if (refCount === null) {
    toast.add({ severity: 'error', summary: 'Error', detail: 'Could not check references', life: 3000 })
    return
  }
  if (refCount > 0) {
    confirm.require({
      message: `"${scale.name}" is referenced by ${refCount} assessment/activity doc(s). Remove those first.`,
      header: 'Cannot delete',
      icon: 'pi pi-exclamation-triangle',
      acceptLabel: 'OK', rejectClass: 'hidden',
      accept: () => {},
    })
    return
  }
  confirm.require({
    message: `Remove grading scale "${scale.name}"? This cannot be undone.`,
    header: 'Remove Grading Scale',
    icon: 'pi pi-exclamation-triangle',
    rejectLabel: 'Cancel', acceptLabel: 'Remove', acceptClass: 'p-button-danger',
    accept: async () => {
      try {
        await deleteDoc(schoolDoc(props.schoolId, 'grading_scales', scale.id))
        toast.add({ severity: 'info', summary: 'Removed', life: 2000 })
        await loadScales()
      } catch (e) {
        toast.add({ severity: 'error', summary: 'Error', detail: 'Could not remove', life: 3000 })
      }
    },
  })
}

// ── Terms CSV import/export ─────────────────────────────────────────────
const TERM_CSV_COLUMNS = ['name', 'academicYear', 'isActive']
const termImportVisible = ref(false)

async function classifyTermRow(raw) {
  const name = (raw.name || '').trim()
  const academicYear = (raw.academicYear || '').trim()
  const isActiveRaw = (raw.isActive ?? '').toString().trim().toLowerCase()
  const isActive = isActiveRaw === '' ? true : ['true', '1', 'yes'].includes(isActiveRaw)

  if (!name) return { raw, _status: 'ERROR', _reason: 'Missing name' }
  if (!academicYear) return { raw, _status: 'ERROR', _reason: 'Missing academicYear' }

  const id = `${slugify(name)}_${slugify(academicYear)}`
  const existing = terms.value.find(t => t.id === id)
  return { raw, id, _status: existing ? 'UPDATE' : 'CREATE', payload: { name, academicYear, isActive } }
}

async function runTermImport(validRows) {
  for (let i = 0; i < validRows.length; i += 450) {
    const chunk = validRows.slice(i, i + 450)
    const batch = writeBatch(db)
    chunk.forEach(r => batch.set(schoolDoc(props.schoolId, 'terms', r.id), {
      ...r.payload, updated_at: serverTimestamp(), updated_by: auth.currentUser?.email || 'unknown',
    }, { merge: true }))
    await batch.commit()
  }
  toast.add({ severity: 'success', summary: 'Imported', detail: `${validRows.length} row(s)`, life: 2500 })
  await loadTerms()
}

function downloadTermSample() {
  const sample = [
    { name: 'Term 1', academicYear: '2025-26', isActive: 'true' },
    { name: 'Term 2', academicYear: '2025-26', isActive: 'true' },
  ]
  downloadCsv('terms_sample.csv', toCsv(sample, TERM_CSV_COLUMNS))
}
function exportTerms() {
  downloadCsv(`terms_${props.schoolId}.csv`, toCsv(terms.value, TERM_CSV_COLUMNS))
}

// ── Grading Scales CSV import/export (bespoke — rows group into scales) ──
const SCALE_CSV_COLUMNS = ['scaleName', 'label', 'minPercent', 'maxPercent']
const scaleImportVisible = ref(false)
const scaleImportParsing = ref(false)
const scaleImportGroups = ref([])
const scaleImportError = ref('')
const scaleImportConfirming = ref(false)
const scaleImportValidCount = ref(0)

function openScaleImport() {
  scaleImportGroups.value = []
  scaleImportError.value = ''
  scaleImportValidCount.value = 0
  scaleImportVisible.value = true
}

async function onScaleFileChange(e) {
  const file = e.target.files[0]
  if (!file) return
  scaleImportParsing.value = true
  scaleImportError.value = ''
  try {
    const text = await readFileAsText(file)
    const { rows } = parseCsv(text)
    const byScale = new Map()
    rows.forEach(r => {
      const scaleName = (r.scaleName || '').trim()
      if (!scaleName) return
      if (!byScale.has(scaleName)) byScale.set(scaleName, [])
      byScale.get(scaleName).push({
        label: (r.label || '').trim(),
        minPercent: r.minPercent !== '' ? Number(r.minPercent) : null,
        maxPercent: r.maxPercent !== '' ? Number(r.maxPercent) : null,
      })
    })
    const groups = Array.from(byScale.entries()).map(([scaleName, levels]) => {
      const reason = validateLevelsCoverage(levels)
      const id = slugify(scaleName)
      const existing = scales.value.find(s => s.id === id)
      return { scaleName, id, levels, status: reason ? 'ERROR' : (existing ? 'UPDATE' : 'CREATE'), reason }
    })
    scaleImportGroups.value = groups
    scaleImportValidCount.value = groups.filter(g => g.status !== 'ERROR').length
  } catch (err) {
    console.error(err)
    scaleImportError.value = 'Could not parse the file.'
  } finally {
    scaleImportParsing.value = false
    e.target.value = ''
  }
}

async function confirmScaleImport() {
  scaleImportError.value = ''
  scaleImportConfirming.value = true
  try {
    const validGroups = scaleImportGroups.value.filter(g => g.status !== 'ERROR')
    for (let i = 0; i < validGroups.length; i += 450) {
      const chunk = validGroups.slice(i, i + 450)
      const batch = writeBatch(db)
      chunk.forEach(g => batch.set(schoolDoc(props.schoolId, 'grading_scales', g.id), {
        name: g.scaleName, levels: g.levels,
        updated_at: serverTimestamp(), updated_by: auth.currentUser?.email || 'unknown',
      }, { merge: true }))
      await batch.commit()
    }
    toast.add({ severity: 'success', summary: 'Imported', detail: `${validGroups.length} scale(s)`, life: 2500 })
    scaleImportVisible.value = false
    scaleImportGroups.value = []
    await loadScales()
  } catch (e) {
    console.error(e)
    scaleImportError.value = 'Something went wrong while importing.'
  } finally {
    scaleImportConfirming.value = false
  }
}

function downloadScaleImportErrors() {
  const errorRows = scaleImportGroups.value
    .filter(g => g.status === 'ERROR')
    .flatMap(g => g.levels.map(l => ({ scaleName: g.scaleName, label: l.label, minPercent: l.minPercent, maxPercent: l.maxPercent, reason: g.reason })))
  downloadCsv('grading_scales_import_errors.csv', toCsv(errorRows, [...SCALE_CSV_COLUMNS, 'reason']))
}

function downloadScaleSample() {
  const sample = [
    { scaleName: 'Standard Scale', label: 'A+', minPercent: 90, maxPercent: 100 },
    { scaleName: 'Standard Scale', label: 'A', minPercent: 75, maxPercent: 89 },
    { scaleName: 'Standard Scale', label: 'B', minPercent: 60, maxPercent: 74 },
    { scaleName: 'Standard Scale', label: 'C', minPercent: 0, maxPercent: 59 },
  ]
  downloadCsv('grading_scales_sample.csv', toCsv(sample, SCALE_CSV_COLUMNS))
}
function exportScales() {
  const flat = scales.value.flatMap(s => (s.levels || []).map(l => ({ scaleName: s.name, label: l.label, minPercent: l.minPercent, maxPercent: l.maxPercent })))
  downloadCsv(`grading_scales_${props.schoolId}.csv`, toCsv(flat, SCALE_CSV_COLUMNS))
}

watch(() => props.schoolId, () => { loadTerms(); loadScales() })
onMounted(() => { loadTerms(); loadScales() })
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
