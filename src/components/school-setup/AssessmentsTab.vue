<template>
  <div class="pt-4">
    <div class="flex items-center justify-between mb-3">
      <div class="flex items-center gap-3">
        <div class="text-sm font-bold text-slate-900">Assessments</div>
        <Select v-model="selectedTermId" :options="terms" optionLabel="name" optionValue="id" placeholder="Select a term" class="w-56" />
      </div>
      <div class="flex gap-2">
        <Button :label="gridMode ? 'Exit Grid Edit' : 'Grid Edit'" icon="pi pi-table" size="small" outlined :disabled="!selectedTermId" @click="gridMode ? exitGridMode() : enterGridMode()" />
        <Button label="Import CSV" icon="pi pi-upload" size="small" outlined @click="importVisible = true" />
        <Button label="Sample CSV" icon="pi pi-download" size="small" text @click="downloadSample" />
        <Button label="Export CSV" icon="pi pi-file-export" size="small" text :disabled="!selectedTermId" @click="exportCsv" />
        <Button label="New Assessment (Bulk)" icon="pi pi-plus" size="small" :disabled="!selectedTermId" @click="openBuilder" />
      </div>
    </div>

    <CsvImportDialog
      v-model:visible="importVisible"
      title="Import Assessments CSV"
      :column-keys="ASSESSMENT_CSV_COLUMNS"
      :classify-row="classifyImportRow"
      :on-confirm="runImport"
    />

    <!-- Repairing what the old import already wrote. Scoped to the selected
         term, because that is the set on screen and the set the entered-marks
         gate can be checked against. -->
    <div
      v-if="selectedTermId && !loading && audit.length"
      class="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 mb-3"
    >
      <i class="pi pi-exclamation-triangle text-amber-500 mt-0.5"></i>
      <div class="flex-1 text-sm text-amber-800">
        <div class="font-semibold">
          {{ audit.length }} assessment(s) in this term need repair<span v-if="auditErrorCount">, {{ auditErrorCount }} seriously</span>.
        </div>
        <div class="text-xs text-amber-700 mt-0.5">
          The import that wrote these has since been fixed, but the documents it already wrote still carry
          its mistakes — composite marks stored as one long number, every row ordered 1, no conversion
          fields, and names taken from the subject. Review each proposed change before applying.
        </div>
      </div>
      <Button label="Review repairs" icon="pi pi-wrench" size="small" @click="openRepair" />
    </div>

    <!-- No terms at all is a different state from "pick a term": the school
         has never been set up, and assessments cannot exist without a term. -->
    <ConfigEmptyState
      v-if="!terms.length" label="Assessments" collection="assessments"
      blocked-by="Add a term in Terms &amp; Scales" blocked-tab="terms-scales"
    />
    <div v-else-if="!selectedTermId" class="text-center text-sm text-slate-400 py-10 bg-white rounded-xl border border-slate-200">
      Select a term to view or create assessments.
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

      <div class="mb-3">
        <label class="form-label">Paste TSV (from Excel/Sheets) — first row = headers (name, subjectId, order, entryType, maxMarks, gradingScaleId, conversionType, conversionFactor)</label>
        <Textarea v-model="pasteText" class="w-full font-mono text-xs" rows="3" placeholder="name	subjectId	order	entryType	maxMarks" />
        <Button label="Add Pasted Rows" size="small" text class="mt-1" @click="parsePaste" />
      </div>

      <DataTable :value="gridRows" editMode="cell" size="small" stripedRows @cell-edit-complete="onCellEditComplete">
        <Column style="width:24px">
          <template #body="{ data }"><i v-if="data._dirty" class="pi pi-circle-fill text-amber-400" style="font-size:8px"></i></template>
        </Column>
        <Column field="name" header="Name">
          <template #editor="{ data, field }"><InputText v-model="data[field]" class="w-full" /></template>
        </Column>
        <Column field="subjectId" header="Subject" style="width:150px">
          <template #body="{ data }"><span :class="data._isNew ? 'text-slate-900' : 'text-slate-400'">{{ data.subjectId }}</span></template>
          <template #editor="{ data, field }">
            <Select v-if="data._isNew" v-model="data[field]" :options="assignableSubjects" optionLabel="id" optionValue="id" class="w-full" />
            <span v-else class="text-xs text-slate-400">locked</span>
          </template>
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
        <Column header="" style="width:220px">
          <template #body="{ data }"><span v-if="data._error" class="text-xs text-red-500">{{ data._error }}</span></template>
        </Column>
      </DataTable>
      <div v-if="!gridRows.length" class="text-center text-sm text-slate-400 py-8">No rows — paste TSV or add a row</div>
      <div v-if="gridSaveError" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2 mt-3">{{ gridSaveError }}</div>
    </div>

    <div v-else>
      <!-- ── Matrix view ──────────────────────────────────────────────────── -->
      <div class="bg-white rounded-xl border border-slate-200 overflow-x-auto mb-5">
        <table class="w-full text-xs">
          <thead>
            <tr class="border-b border-slate-200">
              <th class="text-left px-3 py-2 font-semibold text-slate-400 uppercase">Assessment</th>
              <th v-for="subj in allSubjects" :key="subj.id" class="text-center px-2 py-2 font-semibold text-slate-400 uppercase">{{ subj.id }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="name in assessmentNames" :key="name" class="border-b border-slate-100">
              <td class="px-3 py-2 font-medium text-slate-700">{{ name }}</td>
              <td v-for="subj in allSubjects" :key="subj.id" class="text-center px-2 py-2">
                <i v-if="cellFor(name, subj.id)" class="pi pi-check-circle text-emerald-500"></i>
                <span v-else class="text-slate-300">—</span>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-if="!assessmentNames.length" class="text-center text-sm text-slate-400 py-8">No assessments for this term yet</div>
      </div>

      <!-- ── Flat table ───────────────────────────────────────────────────── -->
      <div class="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <DataTable :value="assessments" size="small" stripedRows>
          <Column field="order" header="#" style="width:50px" />
          <Column field="name" header="Name" />
          <Column field="subjectId" header="Subject" />
          <Column field="entryType" header="Type" style="width:80px" />
          <Column field="maxMarks" header="Max" style="width:70px" />
          <Column header="Conversion" style="width:180px">
            <template #body="{ data }"><span class="text-slate-500">{{ conversionLabel(data) }}</span></template>
          </Column>
          <Column header="" style="width:80px">
            <template #body="{ data }">
              <div class="flex gap-1">
                <Button icon="pi pi-pencil" text rounded size="small" @click="openEdit(data)" />
                <Button icon="pi pi-trash" text rounded size="small" severity="danger" @click="confirmDeleteAssessment(data)" />
              </div>
            </template>
          </Column>
        </DataTable>
        <div v-if="!assessments.length" class="text-center text-sm text-slate-400 py-8">No assessments for this term yet</div>
      </div>
    </div>

    <!-- ── Bulk Builder Dialog ──────────────────────────────────────────── -->
    <Dialog v-model:visible="builderVisible" header="New Assessment (Bulk)" modal :style="{ width: '640px' }">
      <div class="space-y-4 pt-2">
        <div class="grid grid-cols-2 gap-4">
          <div>
            <label class="form-label">Name *</label>
            <InputText v-model="builder.name" class="w-full" placeholder="e.g. Unit Test 1" />
          </div>
          <div>
            <label class="form-label">Term *</label>
            <Select v-model="builder.termId" :options="terms" optionLabel="name" optionValue="id" class="w-full" />
          </div>
          <div>
            <label class="form-label">Entry Type *</label>
            <Select v-model="builder.entryType" :options="entryTypeOptions" optionLabel="label" optionValue="value" class="w-full" />
          </div>
          <div>
            <label class="form-label">Max Marks *</label>
            <InputNumber v-model="builder.maxMarks" class="w-full" :min="1" />
          </div>
          <div>
            <label class="form-label">Grading Scale{{ builder.entryType === 'grade' || builder.conversionType === 'marks_to_grade' ? ' *' : '' }}</label>
            <Select v-model="builder.gradingScaleId" :options="scales" optionLabel="name" optionValue="id" showClear class="w-full" />
          </div>
          <div>
            <label class="form-label">Conversion Type *</label>
            <Select v-model="builder.conversionType" :options="conversionTypeOptions" optionLabel="label" optionValue="value" class="w-full" />
          </div>
          <div v-if="builder.conversionType === 'sum_up' || builder.conversionType === 'sum_down'">
            <label class="form-label">Conversion Factor *</label>
            <InputNumber v-model="builder.conversionFactor" class="w-full" :min="0.01" :maxFractionDigits="2" />
          </div>
          <div>
            <label class="form-label">Order *</label>
            <InputNumber v-model="builder.order" class="w-full" :min="1" />
          </div>
        </div>
        <p class="text-xs text-slate-400">{{ conversionPreview }}</p>

        <div>
          <div class="flex items-center justify-between mb-2">
            <label class="form-label mb-0">Subjects</label>
            <button type="button" class="text-xs text-violet-600 font-semibold" @click="selectAllSubjects">Select All</button>
          </div>
          <div class="flex flex-wrap gap-1.5 mb-2">
            <button
              v-for="grade in gradeList" :key="'g-' + grade"
              type="button"
              class="px-2 py-0.5 rounded-full text-xs font-medium border border-slate-200 text-slate-600 hover:border-violet-400"
              @click="selectGrade(grade)"
            >All of grade {{ grade }}</button>
            <button
              v-for="nameSuffix in subjectNameSuffixes" :key="'n-' + nameSuffix"
              type="button"
              class="px-2 py-0.5 rounded-full text-xs font-medium border border-slate-200 text-slate-600 hover:border-violet-400"
              @click="selectBySuffix(nameSuffix)"
            >All grades — {{ nameSuffix }}</button>
          </div>
          <div class="grid grid-cols-2 gap-1 max-h-48 overflow-auto border border-slate-200 rounded-lg p-2">
            <label v-for="subj in assignableSubjects" :key="subj.id" class="flex items-center gap-2 text-sm px-1 py-0.5">
              <Checkbox v-model="builder.subjectIds" :value="subj.id" />
              <span>{{ subj.id }}</span>
            </label>
          </div>
          <p class="text-xs text-slate-400 mt-1">{{ builder.subjectIds.length }} subject(s) selected — will create/update {{ builder.subjectIds.length }} assessment doc(s).</p>
        </div>

        <div v-if="builderError" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{{ builderError }}</div>
      </div>
      <template #footer>
        <Button label="Cancel" text @click="builderVisible = false" />
        <Button label="Create" :loading="building" @click="runBuilder" />
      </template>
    </Dialog>

    <!-- ── Edit Dialog ──────────────────────────────────────────────────── -->
    <Dialog v-model:visible="editVisible" header="Edit Assessment" modal :style="{ width: '520px' }">
      <div class="space-y-4 pt-2">
        <div class="text-xs text-slate-400">{{ editingAssessment?.id }}</div>
        <div class="grid grid-cols-2 gap-4">
          <div>
            <label class="form-label">Name *</label>
            <InputText v-model="editForm.name" class="w-full" />
          </div>
          <div>
            <label class="form-label">Entry Type *</label>
            <Select v-model="editForm.entryType" :options="entryTypeOptions" optionLabel="label" optionValue="value" class="w-full" />
          </div>
          <div>
            <label class="form-label">Max Marks *</label>
            <InputNumber v-model="editForm.maxMarks" class="w-full" :min="1" />
          </div>
          <div>
            <label class="form-label">Grading Scale</label>
            <Select v-model="editForm.gradingScaleId" :options="scales" optionLabel="name" optionValue="id" showClear class="w-full" />
          </div>
          <div>
            <label class="form-label">Conversion Type *</label>
            <Select v-model="editForm.conversionType" :options="conversionTypeOptions" optionLabel="label" optionValue="value" class="w-full" />
          </div>
          <div v-if="editForm.conversionType === 'sum_up' || editForm.conversionType === 'sum_down'">
            <label class="form-label">Conversion Factor *</label>
            <InputNumber v-model="editForm.conversionFactor" class="w-full" :min="0.01" :maxFractionDigits="2" />
          </div>
          <div>
            <label class="form-label">Order *</label>
            <InputNumber v-model="editForm.order" class="w-full" :min="1" />
          </div>
        </div>

        <div v-if="siblingCount > 0" class="flex items-start gap-2">
          <Checkbox v-model="applyToSiblings" binary />
          <span class="text-xs text-slate-500">Apply this change to the same-named assessment across {{ siblingCount }} other subject(s)</span>
        </div>

        <div v-if="editFormError" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{{ editFormError }}</div>
      </div>
      <template #footer>
        <Button label="Cancel" text @click="editVisible = false" />
        <Button label="Save Changes" :loading="savingEdit" @click="saveEdit" />
      </template>
    </Dialog>

    <!-- ── Repair existing assessments ──────────────────────────────────── -->
    <Dialog v-model:visible="repairVisible" header="Repair Assessments" modal :style="{ width: '900px' }">
      <div class="space-y-3 pt-2">
        <p class="text-sm text-slate-600">
          Every change below is shown before it is made, and nothing is applied to a row you untick.
          <span class="font-semibold">Max Marks is editable</span> — the suggested value is a reading of the
          mangled number, not a fact, so check it against the school's own paper before applying.
        </p>

        <div class="flex items-center gap-3 text-xs">
          <button type="button" class="text-violet-600 font-semibold" @click="setAllRepairs(true)">Select all</button>
          <button type="button" class="text-violet-600 font-semibold" @click="setAllRepairs(false)">Select none</button>
          <span class="text-slate-400">{{ selectedRepairs.length }} of {{ audit.length }} selected</span>
        </div>

        <div class="border border-slate-200 rounded-lg divide-y divide-slate-100 max-h-[420px] overflow-auto">
          <div v-for="r in audit" :key="r.id" class="px-3 py-2.5">
            <div class="flex items-start gap-2.5">
              <Checkbox v-model="r._selected" binary class="mt-0.5" />
              <div class="flex-1 min-w-0">
                <div class="flex items-baseline gap-2 flex-wrap">
                  <span class="font-mono text-xs text-slate-500 truncate">{{ r.id }}</span>
                  <span class="text-sm text-slate-800 font-medium">{{ r.doc.name || '(no name)' }}</span>
                </div>
                <div
                  v-for="(iss, idx) in r.issues" :key="idx"
                  class="text-xs mt-0.5"
                  :class="iss.severity === 'error' ? 'text-red-600' : 'text-amber-700'"
                >· {{ iss.message }}</div>
                <div v-if="!hasFixes(r)" class="text-xs text-slate-400 mt-0.5">
                  Nothing here can be corrected automatically — open the assessment and fix it by hand.
                </div>
              </div>
              <div v-if="r.needsMaxMarks" class="w-32 shrink-0">
                <label class="text-[10px] font-semibold text-slate-400 uppercase">Max Marks</label>
                <InputNumber v-model="r._maxMarks" class="w-full" size="small" :min="1" :maxFractionDigits="2" />
                <div class="text-[10px] text-slate-400 mt-0.5">was {{ r.doc.maxMarks }}</div>
              </div>
            </div>
          </div>
        </div>

        <div v-if="repairError" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{{ repairError }}</div>
      </div>
      <template #footer>
        <Button label="Cancel" text @click="repairVisible = false" />
        <Button
          :label="`Apply to ${selectedRepairs.length} assessment(s)`"
          :disabled="!selectedRepairs.length" :loading="repairing"
          @click="confirmRepair"
        />
      </template>
    </Dialog>

    <ConfirmDialog />
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted } from 'vue'
import { getDocs, getDoc, query, where, orderBy, writeBatch, serverTimestamp, deleteField } from 'firebase/firestore'
import { useConfirm } from 'primevue/useconfirm'
import { useToast } from 'primevue/usetoast'

import Button from 'primevue/button'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import InputNumber from 'primevue/inputnumber'
import Select from 'primevue/select'
import Checkbox from 'primevue/checkbox'
import Textarea from 'primevue/textarea'
import ProgressSpinner from 'primevue/progressspinner'
import ConfirmDialog from 'primevue/confirmdialog'
import CsvImportDialog from './CsvImportDialog.vue'
import ConfigEmptyState from './ConfigEmptyState.vue'

import { schoolCollection, schoolDoc } from '../../firebase/schoolCollections.js'
import { db } from '../../firebase/config'
import { auth } from '../../firebase/config'
import { checkEnteredMarks, slugify, isCoScholasticArea } from '../../utils/assessmentHelpers.js'
import { auditAssessments } from '../../utils/assessmentRepair.js'
import { toCsv, downloadCsv } from '../../utils/csv.js'

const props = defineProps({ schoolId: { type: String, default: null } })
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
const subjects = ref([])
const assessments = ref([])
const selectedTermId = ref(null)
const loading = ref(false)

const allSubjects = computed(() => [...subjects.value].sort((a, b) => a.id.localeCompare(b.id)))
// Assessments are per-subject; a co-scholastic record is term-wide and is
// marked through co_scholastic_activities instead (§3.6). Any still misfiled in
// `subjects` stays visible in the matrix — existing assessments against it are
// real and must not vanish — but can't be picked for a NEW one.
const assignableSubjects = computed(() => allSubjects.value.filter(s => !isCoScholasticArea(s.area)))
const gradeList = computed(() => Array.from(new Set(subjects.value.map(s => (s.id || '').split('_')[0]))).sort())
const subjectNameSuffixes = computed(() =>
  Array.from(new Set(subjects.value.map(s => (s.id || '').split('_').slice(1).join('_')))).filter(Boolean).sort()
)

const assessmentNames = computed(() => Array.from(new Set(assessments.value.map(a => a.name))).sort())
function cellFor(name, subjectId) {
  return assessments.value.find(a => a.name === name && a.subjectId === subjectId) || null
}

function scaleLabel(id) {
  return scales.value.find(s => s.id === id)?.name || id
}
function conversionLabel(a) {
  if (a.conversionType === 'marks_to_grade') return `Grade via ${scaleLabel(a.gradingScaleId)}`
  if (a.conversionType === 'sum_up') return `Out of ${(a.maxMarks * (a.conversionFactor || 1)).toFixed(2)}`
  if (a.conversionType === 'sum_down') return `Out of ${(a.maxMarks / (a.conversionFactor || 1)).toFixed(2)}`
  return 'None'
}

async function loadStatic() {
  if (!props.schoolId) { terms.value = []; scales.value = []; subjects.value = []; return }
  try {
    const [tSnap, gSnap, sSnap] = await Promise.all([
      getDocs(schoolCollection(props.schoolId, 'terms')),
      getDocs(schoolCollection(props.schoolId, 'grading_scales')),
      getDocs(query(schoolCollection(props.schoolId, 'subjects'), orderBy('name'))),
    ])
    terms.value = tSnap.docs.map(d => ({ id: d.id, ...d.data() }))
    scales.value = gSnap.docs.map(d => ({ id: d.id, ...d.data() }))
    subjects.value = sSnap.docs.map(d => ({ id: d.id, ...d.data() }))
    // The audit compares against these, so a load that finished after the
    // assessments did has to re-run it.
    runAudit()
  } catch (e) {
    console.error('Could not load terms/scales/subjects', e)
  }
}

async function loadAssessments() {
  if (!props.schoolId || !selectedTermId.value) { assessments.value = []; return }
  loading.value = true
  try {
    const snap = await getDocs(query(schoolCollection(props.schoolId, 'assessments'), where('termId', '==', selectedTermId.value)))
    assessments.value = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order || 0) - (b.order || 0))
  } catch (e) {
    console.error('Could not load assessments', e)
    assessments.value = []
  } finally {
    loading.value = false
    // Audited on every load so the repair banner reflects what is on screen,
    // including right after a save that fixed (or introduced) something.
    runAudit()
  }
}

// ── Bulk builder ─────────────────────────────────────────────────────────
const builderVisible = ref(false)
const building = ref(false)
const builderError = ref('')
const builder = reactive({
  name: '', termId: null, entryType: 'marks', maxMarks: null, gradingScaleId: null,
  conversionType: 'none', conversionFactor: null, order: 1, subjectIds: [],
})

const conversionPreview = computed(() => {
  if (builder.conversionType === 'marks_to_grade') return builder.gradingScaleId ? `Converted to grade using ${scaleLabel(builder.gradingScaleId)}` : 'Select a grading scale'
  if (builder.conversionType === 'sum_up' && builder.maxMarks && builder.conversionFactor) return `Shown to teachers as out of ${(builder.maxMarks * builder.conversionFactor).toFixed(2)}`
  if (builder.conversionType === 'sum_down' && builder.maxMarks && builder.conversionFactor) return `Shown to teachers as out of ${(builder.maxMarks / builder.conversionFactor).toFixed(2)}`
  return ''
})

function openBuilder() {
  const nextOrder = assessments.value.length ? Math.max(...assessments.value.map(a => a.order || 0)) + 1 : 1
  Object.assign(builder, {
    name: '', termId: selectedTermId.value, entryType: 'marks', maxMarks: null, gradingScaleId: null,
    conversionType: 'none', conversionFactor: null, order: nextOrder, subjectIds: [],
  })
  builderError.value = ''
  builderVisible.value = true
}

function selectAllSubjects() { builder.subjectIds = assignableSubjects.value.map(s => s.id) }
function selectGrade(grade) {
  const ids = assignableSubjects.value.filter(s => (s.id || '').split('_')[0] === grade).map(s => s.id)
  builder.subjectIds = Array.from(new Set([...builder.subjectIds, ...ids]))
}
function selectBySuffix(suffix) {
  const ids = assignableSubjects.value.filter(s => (s.id || '').split('_').slice(1).join('_') === suffix).map(s => s.id)
  builder.subjectIds = Array.from(new Set([...builder.subjectIds, ...ids]))
}

function validateAssessmentFields(f) {
  if (!f.name.trim()) return 'Name is required'
  if (!f.termId) return 'Term is required'
  if (!f.maxMarks || f.maxMarks <= 0) return 'Max marks must be greater than 0'
  if (f.conversionType !== 'none' && f.conversionType !== 'marks_to_grade' && !f.conversionFactor) return 'Conversion factor is required for this conversion type'
  if ((f.conversionType === 'marks_to_grade' || f.entryType === 'grade') && !f.gradingScaleId) return 'Grading scale is required'
  return ''
}

async function runBuilder() {
  builderError.value = validateAssessmentFields(builder)
  if (!builderError.value && !builder.subjectIds.length) builderError.value = 'Select at least one subject'
  if (builderError.value) return
  building.value = true
  try {
    const nameSlug = slugify(builder.name)
    const chunks = []
    for (let i = 0; i < builder.subjectIds.length; i += 450) chunks.push(builder.subjectIds.slice(i, i + 450))
    for (const chunk of chunks) {
      const batch = writeBatch(db)
      for (const subjectId of chunk) {
        const docId = `${subjectId}_${builder.termId}_${nameSlug}`
        batch.set(schoolDoc(props.schoolId, 'assessments', docId), {
          name: builder.name.trim(), termId: builder.termId, subjectId, order: builder.order,
          entryType: builder.entryType, maxMarks: builder.maxMarks, gradingScaleId: builder.gradingScaleId || null,
          conversionType: builder.conversionType, conversionFactor: builder.conversionFactor || null,
          updated_at: serverTimestamp(), updated_by: auth.currentUser?.email || 'unknown',
        }, { merge: true })
      }
      await batch.commit()
    }
    builderVisible.value = false
    toast.add({ severity: 'success', summary: 'Created', detail: `${builder.subjectIds.length} assessment(s) created/updated`, life: 2500 })
    await loadAssessments()
  } catch (e) {
    console.error(e)
    builderError.value = 'Something went wrong. Try again.'
  } finally {
    building.value = false
  }
}

// ── Repair existing assessment documents ─────────────────────────────────
// The import that wrote most of these is fixed (utils/assessmentImport.js),
// but that does nothing for what it already wrote. This is the cleanup pass:
// audit what is stored, propose a correction, and let a human confirm every
// one. Nothing here decides a mark on its own — a recovered maxMarks is
// presented as an editable suggestion, never applied silently.
const audit = ref([])

const auditErrorCount = computed(() =>
  audit.value.filter(r => r.issues.some(i => i.severity === 'error')).length)

function runAudit() {
  if (!selectedTermId.value) { audit.value = []; return }
  const results = auditAssessments(assessments.value, {
    scaleIds: new Set(scales.value.map(s => s.id)),
    termIds: new Set(terms.value.map(t => t.id)),
    subjectNames: new Map(subjects.value.map(s => [s.id, s.name || ''])),
  })
  audit.value = results.map(r => ({
    ...r,
    _selected: true,
    // Pre-filled with the recovered reading when there is one, otherwise the
    // stored value — so an implausible mark with no reading still gets a box
    // to correct by hand rather than being left as the only unfixable row.
    _maxMarks: r.marksSuggestion !== null
      ? r.marksSuggestion
      : (typeof r.doc.maxMarks === 'number' && r.doc.maxMarks > 0 ? r.doc.maxMarks : null),
  }))
}

const repairVisible = ref(false)
const repairing = ref(false)
const repairError = ref('')

const selectedRepairs = computed(() => audit.value.filter(r => r._selected))

/** True when this row has something the repair can actually write. */
function hasFixes(r) {
  return Object.keys(r.patch).length > 0 || r.strip.length > 0 || r.needsMaxMarks
}

function openRepair() {
  repairError.value = ''
  runAudit()
  repairVisible.value = true
}

function setAllRepairs(value) {
  audit.value.forEach(r => { r._selected = value })
}

// What will actually be written for one row: the auto-fixable patch, plus the
// operator's Max Marks if they changed it, plus deletions for the fields the
// old importer left behind.
function repairUpdateFor(r) {
  const update = { ...r.patch }
  const maxMarks = r._maxMarks
  if (typeof maxMarks === 'number' && maxMarks > 0 && maxMarks !== r.doc.maxMarks) {
    update.maxMarks = maxMarks
  }
  for (const field of r.strip) update[field] = deleteField()
  return update
}

function confirmRepair() {
  repairError.value = ''
  const rows = selectedRepairs.value.map(r => ({ r, update: repairUpdateFor(r) }))
    .filter(({ update }) => Object.keys(update).length)
  if (!rows.length) {
    repairError.value = 'Nothing to write — the selected rows have no automatic correction. Open each one and fix it by hand.'
    return
  }
  const markChanges = rows.filter(({ update }) => update.maxMarks !== undefined || update.entryType !== undefined)
  const stripped = rows.reduce((n, { r }) => n + r.strip.length, 0)
  confirm.require({
    message: `Update ${rows.length} assessment(s)?`
      + (markChanges.length ? ` ${markChanges.length} change what marks are scored against — entered marks are checked first.` : '')
      + (stripped ? ` ${stripped} unused field(s) are removed.` : ''),
    header: 'Apply Repairs', icon: 'pi pi-wrench',
    rejectLabel: 'Cancel', acceptLabel: 'Apply',
    accept: () => applyRepairs(rows),
  })
}

async function applyRepairs(rows) {
  repairing.value = true
  repairError.value = ''
  try {
    // Same gate as the editor and the CSV import: lowering maxMarks or
    // flipping entryType on an assessment teachers have already marked can
    // invalidate those values. Checked once per subject, not once per row.
    const gated = rows.filter(({ update }) => update.maxMarks !== undefined || update.entryType !== undefined)
    if (gated.length) {
      const subjectIds = Array.from(new Set(gated.map(({ r }) => r.doc.subjectId)))
      const checks = await Promise.all(subjectIds.map(sid =>
        checkEnteredMarks(props.schoolId, selectedTermId.value, sid).catch(() => 'error')))
      if (checks.includes('error')) {
        repairError.value = 'Could not verify whether marks have been entered — aborting to be safe.'
        return
      }
      const withEntries = subjectIds.filter((_, i) => checks[i])
      if (withEntries.length) {
        const affected = gated.filter(({ r }) => withEntries.includes(r.doc.subjectId))
        const proceed = await new Promise(resolve => {
          confirm.require({
            message: `Teachers have already entered marks for ${withEntries.join(', ')}. `
              + `Repairing ${affected.length} assessment(s) there changes what those marks are scored against — `
              + 'the stored marks are NOT rescaled, so they will need re-checking. Continue anyway?',
            header: 'Entered marks exist', icon: 'pi pi-exclamation-triangle',
            rejectLabel: 'Cancel', acceptLabel: 'Continue anyway', acceptClass: 'p-button-danger',
            accept: () => resolve(true), reject: () => resolve(false),
          })
        })
        if (!proceed) return
      }
    }

    for (let i = 0; i < rows.length; i += 400) {
      const batch = writeBatch(db)
      for (const { r, update } of rows.slice(i, i + 400)) {
        batch.update(schoolDoc(props.schoolId, 'assessments', r.id), {
          ...update,
          updated_at: serverTimestamp(), updated_by: auth.currentUser?.email || 'unknown',
        })
      }
      await batch.commit()
    }

    repairVisible.value = false
    toast.add({ severity: 'success', summary: 'Repaired', detail: `${rows.length} assessment(s) updated`, life: 3500 })
    await loadAssessments()
  } catch (e) {
    console.error(e)
    repairError.value = 'Something went wrong while applying. Re-open this dialog to see what is still outstanding.'
  } finally {
    repairing.value = false
  }
}

// ── Edit ─────────────────────────────────────────────────────────────────
const editVisible = ref(false)
const editingAssessment = ref(null)
const editForm = reactive({ name: '', entryType: 'marks', maxMarks: null, gradingScaleId: null, conversionType: 'none', conversionFactor: null, order: 1 })
const editFormError = ref('')
const savingEdit = ref(false)
const applyToSiblings = ref(false)

const siblingCount = computed(() => {
  if (!editingAssessment.value) return 0
  return assessments.value.filter(a => a.name === editingAssessment.value.name && a.id !== editingAssessment.value.id).length
})

function openEdit(assessment) {
  editingAssessment.value = assessment
  Object.assign(editForm, {
    name: assessment.name, entryType: assessment.entryType, maxMarks: assessment.maxMarks,
    gradingScaleId: assessment.gradingScaleId || null, conversionType: assessment.conversionType || 'none',
    conversionFactor: assessment.conversionFactor || null, order: assessment.order || 1,
  })
  applyToSiblings.value = false
  editFormError.value = ''
  editVisible.value = true
}

async function saveEdit() {
  editFormError.value = validateAssessmentFields({ ...editForm, termId: selectedTermId.value })
  if (editFormError.value) return

  const sensitiveChange = editForm.maxMarks !== editingAssessment.value.maxMarks || editForm.entryType !== editingAssessment.value.entryType
  if (sensitiveChange) {
    const hasEntries = await checkEnteredMarks(props.schoolId, selectedTermId.value, editingAssessment.value.subjectId).catch(() => 'error')
    if (hasEntries === 'error') { editFormError.value = 'Could not verify whether marks have been entered — aborting to be safe.'; return }
    if (hasEntries) {
      const proceed = await new Promise(resolve => {
        confirm.require({
          message: 'Teachers have already entered marks for this assessment. Changing Max Marks or Entry Type may invalidate those values. Continue anyway?',
          header: 'Entered marks exist', icon: 'pi pi-exclamation-triangle',
          rejectLabel: 'Cancel', acceptLabel: 'Continue anyway', acceptClass: 'p-button-danger',
          accept: () => resolve(true), reject: () => resolve(false),
        })
      })
      if (!proceed) return
    }
  }

  savingEdit.value = true
  try {
    const payload = {
      name: editForm.name.trim(), entryType: editForm.entryType, maxMarks: editForm.maxMarks,
      gradingScaleId: editForm.gradingScaleId || null, conversionType: editForm.conversionType,
      conversionFactor: editForm.conversionFactor || null, order: editForm.order,
      updated_at: serverTimestamp(), updated_by: auth.currentUser?.email || 'unknown',
    }
    const batch = writeBatch(db)
    // Doc ID is immutable — always update the existing doc, never re-slug.
    batch.update(schoolDoc(props.schoolId, 'assessments', editingAssessment.value.id), payload)
    if (applyToSiblings.value) {
      assessments.value
        .filter(a => a.name === editingAssessment.value.name && a.id !== editingAssessment.value.id)
        .forEach(sibling => batch.update(schoolDoc(props.schoolId, 'assessments', sibling.id), payload))
    }
    await batch.commit()
    editVisible.value = false
    toast.add({ severity: 'success', summary: 'Saved', life: 2000 })
    await loadAssessments()
  } catch (e) {
    console.error(e)
    editFormError.value = 'Something went wrong. Try again.'
  } finally {
    savingEdit.value = false
  }
}

async function confirmDeleteAssessment(assessment) {
  const hasEntries = await checkEnteredMarks(props.schoolId, selectedTermId.value, assessment.subjectId).catch(() => 'error')
  if (hasEntries === 'error') {
    toast.add({ severity: 'error', summary: 'Error', detail: 'Could not verify whether marks exist — not deleting', life: 4000 })
    return
  }
  confirm.require({
    message: hasEntries
      ? `Teachers have already entered marks for "${assessment.name}" (${assessment.subjectId}). Deleting will orphan those values. Delete anyway?`
      : `Remove assessment "${assessment.name}" (${assessment.subjectId})? This cannot be undone.`,
    header: 'Remove Assessment', icon: 'pi pi-exclamation-triangle',
    rejectLabel: 'Cancel', acceptLabel: 'Remove', acceptClass: 'p-button-danger',
    accept: async () => {
      try {
        const batch = writeBatch(db)
        batch.delete(schoolDoc(props.schoolId, 'assessments', assessment.id))
        await batch.commit()
        toast.add({ severity: 'info', summary: 'Removed', life: 2000 })
        await loadAssessments()
      } catch (e) {
        toast.add({ severity: 'error', summary: 'Error', detail: 'Could not remove', life: 3000 })
      }
    },
  })
}

// ── Grid Edit mode ───────────────────────────────────────────────────────
const gridMode = ref(false)
const gridRows = ref([])
const pasteText = ref('')
const savingGrid = ref(false)
const gridSaveError = ref('')

const dirtyCount = computed(() => gridRows.value.filter(r => r._dirty).length)

function validateGridRow(row) {
  if (!row.name || !row.name.trim()) return 'Name is required'
  if (!row.subjectId) return 'Subject is required'
  return validateAssessmentFields({ ...row, termId: selectedTermId.value })
}

function enterGridMode() {
  gridRows.value = assessments.value.map(a => ({ ...a, _dirty: false, _isNew: false, _error: '' }))
  gridSaveError.value = ''
  pasteText.value = ''
  gridMode.value = true
}
function exitGridMode() {
  gridMode.value = false
  gridRows.value = []
  pasteText.value = ''
}

function addBlankGridRow() {
  const nextOrder = gridRows.value.length ? Math.max(...gridRows.value.map(r => r.order || 0)) + 1
    : (assessments.value.length ? Math.max(...assessments.value.map(a => a.order || 0)) + 1 : 1)
  const row = {
    name: '', subjectId: assignableSubjects.value[0]?.id || '', order: nextOrder, entryType: 'marks',
    maxMarks: null, gradingScaleId: null, conversionType: 'none', conversionFactor: null,
    _isNew: true, _dirty: true, _error: '',
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

const PASTE_HEADER_MAP = {
  name: 'name', subject: 'subjectId', subjectid: 'subjectId', order: 'order',
  entrytype: 'entryType', type: 'entryType', maxmarks: 'maxMarks', max: 'maxMarks',
  scale: 'gradingScaleId', gradingscaleid: 'gradingScaleId', conversiontype: 'conversionType',
  conversionfactor: 'conversionFactor', factor: 'conversionFactor',
}

function parsePaste() {
  if (!pasteText.value.trim()) return
  const lines = pasteText.value.trim().split(/\r?\n/)
  if (lines.length < 2) { gridSaveError.value = 'Paste needs a header row plus at least one data row'; return }
  const headerFields = lines[0].split('\t').map(h => PASTE_HEADER_MAP[h.trim().toLowerCase().replace(/\s+/g, '')] || null)
  if (!headerFields.some(Boolean)) { gridSaveError.value = 'Could not recognize any column headers'; return }

  const nextOrderStart = gridRows.value.length ? Math.max(...gridRows.value.map(r => r.order || 0)) + 1
    : (assessments.value.length ? Math.max(...assessments.value.map(a => a.order || 0)) + 1 : 1)

  const newRows = lines.slice(1).filter(l => l.trim()).map((line, i) => {
    const cells = line.split('\t')
    const row = {
      name: '', subjectId: '', order: nextOrderStart + i, entryType: 'marks', maxMarks: null,
      gradingScaleId: null, conversionType: 'none', conversionFactor: null, _isNew: true, _dirty: true, _error: '',
    }
    headerFields.forEach((field, ci) => {
      if (!field) return
      const raw = (cells[ci] || '').trim()
      if (!raw) return
      if (field === 'order' || field === 'maxMarks' || field === 'conversionFactor') row[field] = Number(raw) || null
      else row[field] = raw
    })
    row._error = validateGridRow(row)
    return row
  })
  gridRows.value.push(...newRows)
  pasteText.value = ''
  gridSaveError.value = ''
}

async function saveAllGrid() {
  gridSaveError.value = ''
  const dirtyRows = gridRows.value.filter(r => r._dirty)
  if (!dirtyRows.length) return

  dirtyRows.forEach(r => { r._error = validateGridRow(r) })
  const errored = dirtyRows.filter(r => r._error)
  if (errored.length) { gridSaveError.value = `${errored.length} row(s) have errors — fix them before saving.`; return }

  // Safety gate: existing rows where maxMarks/entryType changed, fired per row.
  const originalById = new Map(assessments.value.map(a => [a.id, a]))
  const sensitiveRows = dirtyRows.filter(r => !r._isNew && originalById.has(r.id)
    && (r.maxMarks !== originalById.get(r.id).maxMarks || r.entryType !== originalById.get(r.id).entryType))

  const flagged = []
  for (const r of sensitiveRows) {
    const hasEntries = await checkEnteredMarks(props.schoolId, selectedTermId.value, r.subjectId).catch(() => 'error')
    if (hasEntries === 'error') { gridSaveError.value = 'Could not verify entered marks for one or more rows — aborting to be safe.'; return }
    if (hasEntries) flagged.push(r)
  }
  if (flagged.length) {
    const proceed = await new Promise(resolve => {
      confirm.require({
        message: `Teachers have already entered marks for ${flagged.length} changed row(s) (${flagged.map(r => r.subjectId).join(', ')}). Changing Max Marks/Entry Type may invalidate those values. Continue anyway?`,
        header: 'Entered marks exist', icon: 'pi pi-exclamation-triangle',
        rejectLabel: 'Cancel', acceptLabel: 'Continue anyway', acceptClass: 'p-button-danger',
        accept: () => resolve(true), reject: () => resolve(false),
      })
    })
    if (!proceed) return
  }

  savingGrid.value = true
  try {
    for (let i = 0; i < dirtyRows.length; i += 450) {
      const chunk = dirtyRows.slice(i, i + 450)
      const batch = writeBatch(db)
      chunk.forEach(r => {
        const payload = {
          name: r.name.trim(), termId: selectedTermId.value, subjectId: r.subjectId, order: r.order,
          entryType: r.entryType, maxMarks: r.maxMarks, gradingScaleId: r.gradingScaleId || null,
          conversionType: r.conversionType, conversionFactor: r.conversionFactor || null,
          updated_at: serverTimestamp(), updated_by: auth.currentUser?.email || 'unknown',
        }
        if (r._isNew) {
          const docId = `${r.subjectId}_${selectedTermId.value}_${slugify(r.name)}`
          batch.set(schoolDoc(props.schoolId, 'assessments', docId), payload, { merge: true })
        } else {
          batch.update(schoolDoc(props.schoolId, 'assessments', r.id), payload)
        }
      })
      await batch.commit()
    }
    toast.add({ severity: 'success', summary: 'Saved', detail: `${dirtyRows.length} row(s) saved`, life: 2500 })
    await loadAssessments()
    exitGridMode()
  } catch (e) {
    console.error(e)
    gridSaveError.value = 'Something went wrong while saving. Some rows may have been written.'
  } finally {
    savingGrid.value = false
  }
}

// ── CSV import/export ────────────────────────────────────────────────────
const ASSESSMENT_CSV_COLUMNS = ['name', 'subjectId', 'termId', 'order', 'entryType', 'maxMarks', 'gradingScaleId', 'conversionType', 'conversionFactor']
const importVisible = ref(false)

async function classifyImportRow(raw) {
  const name = (raw.name || '').trim()
  const subjectId = (raw.subjectId || '').trim()
  const termId = (raw.termId || '').trim()
  const order = Number(raw.order)
  const entryType = (raw.entryType || '').trim()
  const maxMarks = Number(raw.maxMarks)
  const gradingScaleId = (raw.gradingScaleId || '').trim() || null
  const conversionType = (raw.conversionType || 'none').trim()
  const conversionFactorRaw = (raw.conversionFactor ?? '').toString().trim()
  const conversionFactor = conversionFactorRaw ? Number(conversionFactorRaw) : null

  if (!name) return { raw, _status: 'ERROR', _reason: 'Missing name' }
  if (!subjectId) return { raw, _status: 'ERROR', _reason: 'Missing subjectId' }
  if (!subjects.value.some(s => s.id === subjectId)) return { raw, _status: 'ERROR', _reason: `Unknown subjectId "${subjectId}"` }
  if (!termId) return { raw, _status: 'ERROR', _reason: 'Missing termId' }
  if (!terms.value.some(t => t.id === termId)) return { raw, _status: 'ERROR', _reason: `Unknown termId "${termId}"` }
  if (!order || Number.isNaN(order)) return { raw, _status: 'ERROR', _reason: 'Missing/invalid order' }
  if (!['marks', 'grade'].includes(entryType)) return { raw, _status: 'ERROR', _reason: 'entryType must be "marks" or "grade"' }
  if (!maxMarks || Number.isNaN(maxMarks) || maxMarks <= 0) return { raw, _status: 'ERROR', _reason: 'maxMarks must be a number greater than 0' }
  if (!['none', 'marks_to_grade', 'sum_up', 'sum_down'].includes(conversionType)) return { raw, _status: 'ERROR', _reason: 'conversionType must be none/marks_to_grade/sum_up/sum_down' }
  if (conversionType !== 'none' && conversionType !== 'marks_to_grade' && !conversionFactor) return { raw, _status: 'ERROR', _reason: 'conversionFactor is required for this conversionType' }
  if ((conversionType === 'marks_to_grade' || entryType === 'grade') && !gradingScaleId) return { raw, _status: 'ERROR', _reason: 'gradingScaleId is required' }
  if (gradingScaleId && !scales.value.some(s => s.id === gradingScaleId)) return { raw, _status: 'ERROR', _reason: `Unknown gradingScaleId "${gradingScaleId}"` }

  const id = `${subjectId}_${termId}_${slugify(name)}`
  const payload = { name, subjectId, termId, order, entryType, maxMarks, gradingScaleId, conversionType, conversionFactor }
  const existingSnap = await getDoc(schoolDoc(props.schoolId, 'assessments', id))
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
  const flagged = []
  for (const r of sensitiveRows) {
    const hasEntries = await checkEnteredMarks(props.schoolId, r.payload.termId, r.payload.subjectId).catch(() => 'error')
    if (hasEntries === 'error') {
      toast.add({ severity: 'error', summary: 'Error', detail: 'Could not verify entered marks for one or more rows — aborting.', life: 4000 })
      return false
    }
    if (hasEntries) flagged.push(r)
  }
  if (flagged.length) {
    const proceed = await new Promise(resolve => {
      confirm.require({
        message: `Teachers have already entered marks for ${flagged.length} row(s) (${flagged.map(r => `${r.payload.subjectId}/${r.payload.name}`).join(', ')}). Changing Max Marks/Entry Type may invalidate those values. Continue anyway?`,
        header: 'Entered marks exist', icon: 'pi pi-exclamation-triangle',
        rejectLabel: 'Cancel', acceptLabel: 'Continue anyway', acceptClass: 'p-button-danger',
        accept: () => resolve(true), reject: () => resolve(false),
      })
    })
    if (!proceed) return false
  }

  for (let i = 0; i < validRows.length; i += 450) {
    const chunk = validRows.slice(i, i + 450)
    const batch = writeBatch(db)
    chunk.forEach(r => batch.set(schoolDoc(props.schoolId, 'assessments', r.id), {
      ...r.payload, updated_at: serverTimestamp(), updated_by: auth.currentUser?.email || 'unknown',
    }, { merge: true }))
    await batch.commit()
  }
  toast.add({ severity: 'success', summary: 'Imported', detail: `${validRows.length} row(s)`, life: 2500 })
  if (selectedTermId.value) await loadAssessments()
  return true
}

function downloadSample() {
  const term = terms.value[0]
  const subj1 = subjects.value[0]
  const subj2 = subjects.value[1] || subjects.value[0]
  const scale = scales.value[0]
  if (!term || !subj1) {
    toast.add({ severity: 'warn', summary: 'Add a term and subject first', detail: 'The sample needs at least one real term/subject from this school to reference', life: 4000 })
    return
  }
  const sample = [
    { name: 'Unit Test 1', subjectId: subj1.id, termId: term.id, order: 1, entryType: 'marks', maxMarks: 20, gradingScaleId: '', conversionType: 'none', conversionFactor: '' },
    { name: 'Unit Test 1', subjectId: subj2.id, termId: term.id, order: 1, entryType: 'grade', maxMarks: 20, gradingScaleId: scale?.id || '', conversionType: 'marks_to_grade', conversionFactor: '' },
    { name: 'Half-Yearly', subjectId: subj1.id, termId: term.id, order: 2, entryType: 'marks', maxMarks: 50, gradingScaleId: '', conversionType: 'sum_up', conversionFactor: 2 },
  ]
  downloadCsv('assessments_sample.csv', toCsv(sample, ASSESSMENT_CSV_COLUMNS))
}

function exportCsv() {
  downloadCsv(`assessments_${selectedTermId.value}.csv`, toCsv(assessments.value, ASSESSMENT_CSV_COLUMNS))
}

watch(() => props.schoolId, () => { loadStatic(); assessments.value = []; selectedTermId.value = null })
watch(selectedTermId, () => { loadAssessments(); exitGridMode() })
onMounted(loadStatic)
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
