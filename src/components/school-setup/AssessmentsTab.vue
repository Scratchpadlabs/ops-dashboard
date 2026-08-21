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
        <Button label="Apply Exam Template" icon="pi pi-sitemap" size="small" severity="secondary"
                :disabled="!terms.length || !subjects.length" @click="openTemplate" />
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
            <Select v-if="data._isNew" v-model="data[field]" :options="allSubjects" optionLabel="id" optionValue="id" class="w-full" />
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
            <label v-for="subj in allSubjects" :key="subj.id" class="flex items-center gap-2 text-sm px-1 py-0.5">
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


    <!-- ── Exam template ─────────────────────────────────────────────────
         The school's exam scheme applied across every subject at once. The
         numbers come from src/data/assessmentTemplates.json, which is a
         reading of the school's own marks sheet and report cards — so the one
         thing this dialog must do is show what it read BEFORE writing it,
         including everything the documents could not answer. -->
    <Dialog v-model:visible="templateVisible" header="Apply Exam Template" modal :style="{ width: '760px' }">
      <div class="space-y-4">
        <p class="text-sm text-slate-600">
          Creates the written and internal assessment for every exam, on every subject,
          in one pass. Doc ids are deterministic, so running it twice updates rather
          than duplicates.
        </p>

        <!-- Terms are Firestore ids; nothing in the source documents names them,
             so ops maps them rather than the template guessing. -->
        <div class="grid grid-cols-2 gap-3">
          <div v-for="t in [1, 2]" :key="t">
            <label class="form-label">Term {{ t === 1 ? 'I' : 'II' }} is this school's *</label>
            <Select v-model="templateTermIds[t]" :options="terms" optionLabel="name" optionValue="id"
                    placeholder="Select a term" class="w-full" />
          </div>
        </div>

        <div v-if="scaleCheck" class="rounded-lg px-3 py-2 text-[11px]"
             :class="scaleCheck.matches ? 'bg-emerald-50 text-emerald-800 border border-emerald-100'
                                        : 'bg-amber-50 text-amber-800 border border-amber-100'">
          <span v-if="scaleCheck.matches">
            <i class="pi pi-check-circle mr-1"></i>
            "{{ scaleCheck.name }}" matches the 8-point scale the report cards print.
          </span>
          <span v-else>
            <i class="pi pi-exclamation-triangle mr-1"></i>
            No grading scale in this school matches the report cards' 8-point bands
            (91–100 A1 … 32 and below E). Printed grades will not agree with entered
            marks. These assessments are entered as marks and reference no scale, so
            this does not block them — but it is worth fixing in Terms &amp; Scales.
          </span>
        </div>

        <div v-if="templatePlan">
          <div class="flex flex-wrap gap-2 mb-3">
            <span class="stat stat-ok">{{ templatePlan.totals.create }} to create</span>
            <span v-if="templatePlan.totals.update" class="stat">{{ templatePlan.totals.update }} to update</span>
            <span class="stat">{{ templatePlan.totals.subjects }} subject(s) read</span>
            <span v-if="templatePlan.totals.uncoveredSubjects" class="stat stat-warn">
              {{ templatePlan.totals.uncoveredSubjects }} subject(s) not covered
            </span>
          </div>

          <div v-if="templatePlan.warnings.length" class="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 mb-3">
            <div class="text-xs font-semibold text-amber-800 mb-1">
              {{ templatePlan.warnings.length }} thing(s) to verify
            </div>
            <div class="text-[11px] text-amber-800 space-y-0.5 max-h-32 overflow-auto">
              <div v-for="(w, i) in templatePlan.warnings" :key="i">{{ w }}</div>
            </div>
          </div>

          <div v-if="templatePlan.uncovered.length" class="rounded-lg border border-slate-200 px-3 py-2 mb-3">
            <div class="text-xs font-semibold text-slate-600 mb-1">
              Nothing will be created for these — the documents do not cover them
            </div>
            <div class="text-[11px] text-slate-500 space-y-0.5 max-h-28 overflow-auto">
              <div v-for="(u, i) in templatePlan.uncovered" :key="i">
                <span class="font-mono">{{ u.subjectId }}</span> — {{ u.reason }}
              </div>
            </div>
          </div>

          <DataTable :value="templatePlan.items" size="small" stripedRows paginator :rows="8"
                     class="text-xs">
            <Column field="subjectId" header="Subject" style="width:150px">
              <template #body="{ data }"><span class="font-mono text-[11px]">{{ data.subjectId }}</span></template>
            </Column>
            <Column field="name" header="Assessment" />
            <Column field="maxMarks" header="Max" style="width:60px" />
            <Column header="Conversion" style="width:130px">
              <template #body="{ data }">
                <span v-if="data.conversionType === 'none'" class="text-slate-400">—</span>
                <span v-else>{{ data.conversionType }} ×{{ Number(data.conversionFactor).toFixed(4).replace(/0+$/, '').replace(/\.$/, '') }}</span>
              </template>
            </Column>
            <Column field="status" header="" style="width:80px">
              <template #body="{ data }">
                <span class="text-[10px] px-1.5 py-0.5 rounded"
                      :class="data.status === 'CREATE' ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'">
                  {{ data.status }}
                </span>
              </template>
            </Column>
          </DataTable>
        </div>

        <div v-if="templateError" class="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{{ templateError }}</div>
        <div v-if="templateProgress" class="text-sm text-slate-500">{{ templateProgress }}</div>
      </div>
      <template #footer>
        <Button label="Cancel" text @click="templateVisible = false" />
        <Button label="Preview" icon="pi pi-search" outlined :loading="templatePreviewing"
                :disabled="!templateTermIds[1] || !templateTermIds[2]" @click="previewTemplate" />
        <Button label="Apply" icon="pi pi-check" :loading="applyingTemplate"
                :disabled="!templatePlan || !templatePlan.items.length" @click="confirmApplyTemplate" />
      </template>
    </Dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted } from 'vue'
import { getDocs, getDoc, query, where, orderBy, writeBatch, serverTimestamp } from 'firebase/firestore'
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
import CsvImportDialog from './CsvImportDialog.vue'
import ConfigEmptyState from './ConfigEmptyState.vue'

import { schoolCollection, schoolDoc } from '../../firebase/schoolCollections.js'
import { db } from '../../firebase/config'
import { auth } from '../../firebase/config'
import { checkEnteredMarks, slugify } from '../../utils/assessmentHelpers.js'
import { buildAssessmentPlan, compareGradingScale } from '../../utils/assessmentPlan.js'
import { guardedBatchSet, MODE_CREATE, SchemaViolation } from '../../schemas/guardedWrite.js'
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
  }
}

// ── Exam template ────────────────────────────────────────────────────────
// The school's whole exam scheme, applied across every subject at once. The
// numbers live in src/data/assessmentTemplates.json (a reading of the school's
// marks sheet and report cards) and the arithmetic in utils/assessmentPlan.js,
// which is pure and checked against the report cards' own worked examples —
// node tools/check_assessment_templates.mjs.
const templateVisible = ref(false)
const templateTermIds = reactive({ 1: null, 2: null })
const templatePlan = ref(null)
const templatePreviewing = ref(false)
const applyingTemplate = ref(false)
const templateError = ref('')
const templateProgress = ref('')

// Which of the school's scales, if any, says what the report cards print. Not a
// blocker — these assessments are entered as marks and reference no scale —
// but a school whose scale disagrees prints grades that do not match the marks
// underneath them, and nobody notices until a parent does.
const scaleCheck = computed(() => {
  if (!scales.value.length) return { matches: false }
  for (const s of scales.value) {
    if (compareGradingScale(s).matches) return { matches: true, name: s.name || s.id }
  }
  return { matches: false }
})

function openTemplate() {
  templatePlan.value = null
  templateError.value = ''
  templateProgress.value = ''
  // Two terms and nothing else to go on is the common case — offer it, but as
  // a starting point the operator confirms, never as a silent default.
  if (terms.value.length === 2) {
    const ordered = [...terms.value].sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    templateTermIds[1] = templateTermIds[1] || ordered[0].id
    templateTermIds[2] = templateTermIds[2] || ordered[1].id
  }
  templateVisible.value = true
}

async function previewTemplate() {
  templatePreviewing.value = true
  templateError.value = ''
  try {
    // Every term, not just the selected one: the template spans both.
    const snap = await getDocs(schoolCollection(props.schoolId, 'assessments'))
    templatePlan.value = buildAssessmentPlan({
      subjects: subjects.value,
      termIds: { 1: templateTermIds[1], 2: templateTermIds[2] },
      existing: snap.docs.map(d => ({ id: d.id })),
    })
  } catch (e) {
    console.error(e)
    templateError.value = 'Could not read this school\'s assessments. Check the console.'
  } finally {
    templatePreviewing.value = false
  }
}

function confirmApplyTemplate() {
  const t = templatePlan.value.totals
  confirm.require({
    message: `Write ${t.create} new and ${t.update} updated assessment(s) across `
           + `${t.subjects - t.uncoveredSubjects} subject(s)? `
           + 'Existing assessments with the same id are overwritten; anything created '
           + 'by hand under a different id is left alone.',
    header: 'Apply exam template',
    icon: 'pi pi-sitemap',
    rejectLabel: 'Cancel', acceptLabel: 'Apply',
    accept: applyTemplate,
  })
}

async function applyTemplate() {
  applyingTemplate.value = true
  templateError.value = ''
  try {
    const items = templatePlan.value.items
    let done = 0
    for (let i = 0; i < items.length; i += 450) {
      const batch = writeBatch(db)
      for (const a of items.slice(i, i + 450)) {
        // MODE_CREATE: these are whole documents, so validate them in full.
        // A malformed assessment is the kind that reaches a teacher as an
        // un-fillable column rather than as an error here.
        guardedBatchSet(batch, 'assessments', schoolDoc(props.schoolId, 'assessments', a.docId), {
          name: a.name, termId: a.termId, subjectId: a.subjectId, order: a.order,
          entryType: a.entryType, maxMarks: a.maxMarks,
          gradingScaleId: a.gradingScaleId, conversionType: a.conversionType,
          conversionFactor: a.conversionFactor,
          updated_at: serverTimestamp(), updated_by: auth.currentUser?.email || 'unknown',
        }, { mode: MODE_CREATE, merge: true })
      }
      await batch.commit()
      done += Math.min(450, items.length - i)
      templateProgress.value = `Wrote ${done}/${items.length} assessment(s)…`
    }
    toast.add({ severity: 'success', summary: 'Exam template applied',
                detail: `${items.length} assessment(s)`, life: 3000 })
    templateVisible.value = false
    await loadAssessments()
  } catch (e) {
    console.error(e)
    templateError.value = e instanceof SchemaViolation ? e.userMessage
      : 'Something went wrong writing assessments. Check the console.'
  } finally {
    applyingTemplate.value = false
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

function selectAllSubjects() { builder.subjectIds = allSubjects.value.map(s => s.id) }
function selectGrade(grade) {
  const ids = subjects.value.filter(s => (s.id || '').split('_')[0] === grade).map(s => s.id)
  builder.subjectIds = Array.from(new Set([...builder.subjectIds, ...ids]))
}
function selectBySuffix(suffix) {
  const ids = subjects.value.filter(s => (s.id || '').split('_').slice(1).join('_') === suffix).map(s => s.id)
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
    name: '', subjectId: allSubjects.value[0]?.id || '', order: nextOrder, entryType: 'marks',
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
.stat { font-size: 12px; background: #f1f5f9; color: #334155; border-radius: 6px; padding: 3px 8px; }
.stat-ok   { background: #ecfdf5; color: #047857; }
.stat-warn { background: #fffbeb; color: #b45309; }
</style>
