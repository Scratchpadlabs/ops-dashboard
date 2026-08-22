<template>
  <div class="pt-4">
    <div class="flex items-center justify-between mb-3">
      <div class="text-sm font-bold text-slate-900">Subjects</div>
      <div class="flex gap-2">
        <Button label="Import CSV" icon="pi pi-upload" size="small" outlined @click="importVisible = true" />
        <Button label="Sample CSV" icon="pi pi-download" size="small" text @click="downloadSample" />
        <Button label="Export CSV" icon="pi pi-file-export" size="small" text @click="exportCsv" />
        <Button label="Add Subject" icon="pi pi-plus" size="small" @click="openAddSubject" />
      </div>
    </div>

    <CsvImportDialog
      v-model:visible="importVisible"
      title="Import Subjects CSV"
      :column-keys="SUBJECT_CSV_COLUMNS"
      :classify-row="classifyImportRow"
      :on-confirm="runImport"
    />

    <div
      v-if="!loading && misfiledSubjects.length"
      class="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 mb-4"
    >
      <i class="pi pi-exclamation-triangle text-amber-500 mt-0.5"></i>
      <div class="flex-1 text-sm text-amber-800">
        <div class="font-semibold">
          {{ misfiledSubjects.length }} Co-Scholastic record(s) are filed as subjects<span
            v-if="unclassifiedCoCount"
          >, {{ unclassifiedCoCount }} of them unclassified until the knowledge base learned the name</span>.
        </div>
        <div class="text-xs text-amber-700 mt-0.5">
          Co-Scholastic entries are term-wide activities and belong in
          <span class="font-mono">co_scholastic_activities</span>, not <span class="font-mono">subjects</span>.
          Moving them rewrites each one in the activity schema, detaches it from every class's subject list and deletes the subjects doc.
        </div>
      </div>
      <Button label="Move to Co-Scholastic" icon="pi pi-arrow-right" size="small" @click="openMoveDialog(misfiledSubjects)" />
    </div>

    <div v-if="loading" class="flex items-center justify-center py-10">
      <ProgressSpinner style="width:28px;height:28px" />
    </div>
    <div v-else>
      <div v-for="grade in gradeGroups" :key="grade.grade" class="mb-5">
        <div class="text-xs font-semibold text-slate-400 uppercase mb-2">Grade {{ grade.grade }}</div>
        <div class="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <DataTable :value="grade.subjects" size="small" stripedRows>
            <Column field="id" header="ID" style="width:220px">
              <template #body="{ data }"><span class="font-mono text-xs text-slate-500">{{ data.id }}</span></template>
            </Column>
            <Column field="name" header="Name">
              <template #body="{ data }">
                <span>{{ data.name }}</span>
                <span v-if="data.name_original" class="text-xs text-slate-400 ml-1.5">(from “{{ data.name_original }}”)</span>
              </template>
            </Column>
            <Column field="area" header="Area" style="width:130px">
              <template #body="{ data }">
                <span
                  v-if="data.area"
                  class="px-2 py-0.5 rounded-full text-xs font-semibold"
                  :class="isCoScholasticArea(data.area) ? 'bg-amber-100 text-amber-700' : 'bg-blue-50 text-blue-700'"
                  v-tooltip="isCoScholasticArea(data.area) ? 'Misfiled: Co-Scholastic records belong in co_scholastic_activities. Use the → button to move it.' : ''"
                >{{ data.area }}{{ isCoScholasticArea(data.area) ? ' ⚠' : '' }}</span>
                <span
                  v-else-if="areaFor(data.name) === AREA_CO_SCHOLASTIC"
                  class="px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-700"
                  v-tooltip="'Stored unclassified, but the knowledge base now reads this name as Co-Scholastic — use the → button to move it.'"
                >Co-Scholastic? ⚠</span>
                <span v-else class="text-xs text-slate-300" v-tooltip="'Not classified — open the subject and let the knowledge base categorize it'">—</span>
              </template>
            </Column>
            <Column field="curricular_goals" header="Goals" style="width:100px">
              <template #body="{ data }"><span class="text-xs text-slate-400">{{ (data.curricular_goals || []).length }}</span></template>
            </Column>
            <Column header="" style="width:110px">
              <template #body="{ data }">
                <Button icon="pi pi-pencil" text rounded size="small" @click="openEditSubject(data)" />
                <Button
                  icon="pi pi-arrow-right" text rounded size="small"
                  :severity="isCoScholasticArea(data.area) ? 'warning' : 'secondary'"
                  v-tooltip="'Move to Co-Scholastic — files this as a term-wide activity and removes it from subjects'"
                  @click="openMoveDialog([data])"
                />
              </template>
            </Column>
          </DataTable>
        </div>
      </div>
      <ConfigEmptyState v-if="!subjects.length" label="Subjects" collection="subjects" />
    </div>

    <!-- ── Add/Edit Subject Dialog ──────────────────────────────────────── -->
    <Dialog v-model:visible="dialogVisible" :header="dialogHeader" modal :style="{ width: '640px' }">
      <div class="space-y-4 pt-2">
        <div class="grid grid-cols-2 gap-4">
          <div v-if="!isCoScholasticForm">
            <label class="form-label">Grade *</label>
            <!-- Options come from the school's OWN classes, never a fixed roman
                 list: a school onboarded from a student file keeps its own
                 notation (`1`, `Nursery`), and a subject filed under `III` would
                 never attach to a class whose clazz is `1`. Still `editable`, so
                 a grade whose class does not exist yet is not blocked. -->
            <Select
              v-model="form.grade"
              :options="classGrades"
              editable
              class="w-full"
              :placeholder="classGrades.length ? 'Pick the grade as this school writes it' : 'e.g. III'"
              :disabled="!!editingSubject"
            />
            <p v-if="gradeWarning" class="text-xs text-amber-700 bg-amber-50 rounded px-2 py-1 mt-1">
              {{ gradeWarning }}
            </p>
          </div>
          <div v-else>
            <label class="form-label">Term *</label>
            <Select v-model="form.termId" :options="terms" optionLabel="name" optionValue="id" placeholder="Select a term" class="w-full" />
          </div>
          <div>
            <label class="form-label">Name *</label>
            <KbClassifiedInput
              v-model="form.name"
              :expect="SUBJECT"
              context="the Subjects list in School Setup"
              placeholder="e.g. English"
              :disabled="!!editingSubject"
              @classified="onNameClassified"
            />
          </div>
        </div>

        <div>
          <label class="form-label">Area *</label>
          <Select v-model="form.area" :options="AREA_OPTIONS" placeholder="Not classified" showClear class="w-full" :disabled="!!editingSubject" />
          <p class="text-xs text-slate-400 mt-1">
            Set automatically by the knowledge base from the name — override it here if that's wrong.
          </p>
          <p v-if="editingSubject" class="text-xs text-slate-400 mt-1">
            Area is locked on an existing subject because it decides the collection: if this is really a
            Co-Scholastic activity, use <span class="font-semibold">Move to Co-Scholastic</span> below — flipping the
            label alone would leave the record in <span class="font-mono">subjects</span>.
          </p>
        </div>

        <div v-if="isCoScholasticForm" class="rounded-lg bg-violet-50 border border-violet-100 px-3 py-2 text-xs text-violet-700">
          Co-Scholastic entries are term-wide activities — this will be saved to
          <span class="font-mono">co_scholastic_activities</span>, not <span class="font-mono">subjects</span>.
        </div>

        <div v-if="isCoScholasticForm" class="grid grid-cols-2 gap-4">
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

        <div>
          <label class="form-label">Doc ID</label>
          <InputText v-model="form.id" class="w-full font-mono text-sm" :disabled="!!editingSubject" />
          <p class="text-xs text-slate-400 mt-1">
            {{ isCoScholasticForm ? 'Auto-slugged from term + name — editable until first save, locked after.' : 'Auto-slugged from grade + name — editable until first save, locked after.' }}
          </p>
        </div>

        <div v-if="!isCoScholasticForm">
          <div class="flex items-center justify-between mb-2">
            <label class="form-label mb-0">Curricular Goals</label>
            <div class="flex gap-2">
              <button type="button" class="text-xs text-violet-600 font-semibold" @click="copyGoalsDialogVisible = true">Copy from another subject</button>
              <button type="button" class="text-xs text-violet-600 font-semibold" @click="copySchoolDialogVisible = true">Copy from another school</button>
              <button type="button" class="text-xs text-violet-600 font-semibold" @click="addGoal">+ Add Goal</button>
            </div>
          </div>
          <div v-for="(goal, gi) in form.goals" :key="gi" class="border border-slate-200 rounded-lg p-3 mb-2">
            <div class="flex items-center gap-2 mb-2">
              <InputText v-model="goal.goal" placeholder="Goal text" class="flex-1 text-sm" />
              <Button icon="pi pi-trash" text rounded size="small" severity="danger" @click="form.goals.splice(gi, 1)" />
            </div>
            <div v-for="(comp, ci) in goal.competencies" :key="ci" class="flex items-center gap-2 mb-1 ml-4">
              <InputText v-model="goal.competencies[ci]" placeholder="Competency text" class="flex-1 text-sm" />
              <Button icon="pi pi-trash" text rounded size="small" severity="danger" @click="goal.competencies.splice(ci, 1)" />
            </div>
            <button type="button" class="text-xs text-violet-600 font-semibold ml-4" @click="goal.competencies.push('')">+ Add Competency</button>
          </div>
          <p v-if="!form.goals.length" class="text-xs text-slate-400">No goals yet.</p>
        </div>

        <div v-if="editingSubject && (editingSubject.topics || []).length">
          <label class="form-label">Topics (read-only)</label>
          <div class="bg-slate-50 rounded-lg p-3 text-xs text-slate-500 max-h-32 overflow-auto">
            <div v-for="(t, i) in editingSubject.topics" :key="i">{{ typeof t === 'string' ? t : (t.topic || JSON.stringify(t)) }}</div>
          </div>
        </div>

        <div v-if="formError" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{{ formError }}</div>
      </div>
      <template #footer>
        <Button
          v-if="editingSubject"
          label="Move to Co-Scholastic" icon="pi pi-arrow-right" text severity="warning"
          @click="dialogVisible = false; openMoveDialog([editingSubject])"
        />
        <Button label="Cancel" text @click="dialogVisible = false" />
        <Button :label="editingSubject ? 'Save Changes' : (isCoScholasticForm ? 'Add Activity' : 'Add Subject')" :loading="saving" @click="saveSubject" />
      </template>
    </Dialog>

    <!-- ── Copy Goals From Another Subject (same school) ────────────────── -->
    <Dialog v-model:visible="copyGoalsDialogVisible" header="Copy Goals From Another Subject" modal :style="{ width: '420px' }">
      <div class="space-y-4 pt-2">
        <label class="form-label">Subject *</label>
        <Select
          v-model="copySourceSubjectId"
          :options="subjects.filter(s => s.id !== form.id)"
          optionLabel="id" optionValue="id"
          placeholder="Select a subject" class="w-full" filter
        />
      </div>
      <template #footer>
        <Button label="Cancel" text @click="copyGoalsDialogVisible = false" />
        <Button label="Copy" @click="copyGoalsFromSubject" />
      </template>
    </Dialog>

    <!-- ── Copy Goals From Another School ───────────────────────────────── -->
    <Dialog v-model:visible="copySchoolDialogVisible" header="Copy Goals From Another School" modal :style="{ width: '420px' }">
      <div class="space-y-4 pt-2">
        <div>
          <label class="form-label">Source School *</label>
          <Select v-model="copySchoolId" :options="otherSchools" optionLabel="name" optionValue="id" placeholder="Select a school" class="w-full" filter @update:modelValue="loadOtherSchoolSubjects" />
        </div>
        <div>
          <label class="form-label">Subject *</label>
          <Select v-model="copySchoolSubjectId" :options="otherSchoolSubjects" optionLabel="id" optionValue="id" placeholder="Select a subject" class="w-full" filter :disabled="!copySchoolId" />
        </div>
        <div v-if="copySchoolError" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{{ copySchoolError }}</div>
      </div>
      <template #footer>
        <Button label="Cancel" text @click="copySchoolDialogVisible = false" />
        <Button label="Copy" @click="copyGoalsFromSchool" />
      </template>
    </Dialog>

    <!-- ── Move Subject(s) → Co-Scholastic ──────────────────────────────── -->
    <Dialog v-model:visible="moveDialogVisible" header="Move to Co-Scholastic" modal :style="{ width: '640px' }">
      <div class="space-y-4 pt-2">
        <p class="text-sm text-slate-600">
          A Co-Scholastic record is a <span class="font-semibold">term-wide activity</span>, not a per-grade subject.
          Moving rewrites each one into <span class="font-mono">co_scholastic_activities</span>, detaches it from every class's
          subject list, and deletes the <span class="font-mono">subjects</span> doc.
        </p>

        <div v-if="!terms.length" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">
          This school has no terms yet — add one in Terms &amp; Scales first.
        </div>

        <template v-else>
          <div class="grid grid-cols-2 gap-4">
            <div>
              <label class="form-label">Term *</label>
              <Select v-model="moveForm.termId" :options="terms" optionLabel="name" optionValue="id" placeholder="Select a term" class="w-full" />
            </div>
            <div>
              <label class="form-label">Entry Type *</label>
              <Select v-model="moveForm.entryType" :options="entryTypeOptions" optionLabel="label" optionValue="value" class="w-full" />
            </div>
            <div>
              <label class="form-label">Max Marks *</label>
              <InputNumber v-model="moveForm.maxMarks" class="w-full" :min="1" />
            </div>
            <div>
              <label class="form-label">Grading Scale{{ moveForm.entryType === 'grade' || moveForm.conversionType === 'marks_to_grade' ? ' *' : '' }}</label>
              <Select v-model="moveForm.gradingScaleId" :options="scales" optionLabel="name" optionValue="id" showClear class="w-full" />
            </div>
            <div>
              <label class="form-label">Conversion Type *</label>
              <Select v-model="moveForm.conversionType" :options="conversionTypeOptions" optionLabel="label" optionValue="value" class="w-full" />
            </div>
            <div v-if="moveForm.conversionType === 'sum_up' || moveForm.conversionType === 'sum_down'">
              <label class="form-label">Conversion Factor *</label>
              <InputNumber v-model="moveForm.conversionFactor" class="w-full" :min="0.01" :maxFractionDigits="2" />
            </div>
          </div>
          <p class="text-xs text-slate-400 -mt-2">
            These settings apply to every record in this move — edit them individually afterwards in the Co-Scholastic tab.
          </p>

          <div class="border border-slate-200 rounded-lg divide-y divide-slate-100 max-h-64 overflow-auto">
            <div v-for="row in movePlan" :key="row.subject.id" class="px-3 py-2 text-sm">
              <div class="flex items-center gap-2">
                <i class="pi text-xs" :class="row.blocked ? 'pi-times-circle text-red-500' : 'pi-arrow-right text-green-600'"></i>
                <span class="font-mono text-xs text-slate-500">{{ row.subject.id }}</span>
                <span class="text-slate-300">→</span>
                <span class="font-mono text-xs" :class="row.blocked ? 'text-red-500' : 'text-slate-700'">{{ row.newId || '—' }}</span>
              </div>
              <div v-if="row.notes.length" class="text-xs mt-0.5 ml-5" :class="row.blocked ? 'text-red-500' : 'text-amber-600'">
                {{ row.notes.join('; ') }}
              </div>
            </div>
          </div>
        </template>

        <div v-if="moveError" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{{ moveError }}</div>
      </div>
      <template #footer>
        <Button label="Cancel" text @click="moveDialogVisible = false" />
        <Button
          :label="`Move ${movablePlan.length} record(s) → ${moveWriteCount} activity(ies)`"
          :disabled="!movablePlan.length" :loading="moving"
          @click="confirmMove"
        />
      </template>
    </Dialog>

  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted, inject } from 'vue'
import { getDocs, getDoc, setDoc, updateDoc, deleteDoc, query, orderBy, serverTimestamp, writeBatch } from 'firebase/firestore'
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
import CsvImportDialog from './CsvImportDialog.vue'
import ConfigEmptyState from './ConfigEmptyState.vue'
import KbClassifiedInput from '../shared/KbClassifiedInput.vue'

import { schoolCollection, schoolDoc, rootSchoolsCollection } from '../../firebase/schoolCollections.js'
import { guardedSetDoc, guardedUpdateDoc, SchemaViolation } from '../../schemas/guardedWrite.js'
import { db, auth } from '../../firebase/config'
import { toCsv, downloadCsv } from '../../utils/csv.js'
import { useEducationKB } from '../../composables/useEducationKB.js'
import { SUBJECT, COSCHOLASTIC, classify as classifyValue } from '../../utils/educationKB.js'
import { checkEnteredMarksCoScholastic, isCoScholasticArea, slugify as slugifyText } from '../../utils/assessmentHelpers.js'
import { detachClassSubject } from '../../utils/classSubjects.js'

const props = defineProps({ schoolId: { type: String, default: null } })
const confirm = useConfirm()
const toast = useToast()

const subjects = ref([])
const loading = ref(false)

// ── Co-Scholastic routing ────────────────────────────────────────────────
// `area` is not just a label — it decides the collection. The KB classifies
// the name (areaFor / onNameClassified below); "Co-Scholastic" means a
// term-wide activity, which belongs in co_scholastic_activities with that
// collection's schema (see CoScholasticTab), NOT in subjects.
const AREA_SCHOLASTIC = 'Scholastic'
const AREA_CO_SCHOLASTIC = 'Co-Scholastic'
const AREA_OPTIONS = [AREA_SCHOLASTIC, AREA_CO_SCHOLASTIC]

// Applied when the form or a CSV row leaves a co-scholastic field blank.
const CO_DEFAULTS = { entryType: 'marks', maxMarks: 10, conversionType: 'none', conversionFactor: null, gradingScaleId: null }

const entryTypeOptions = [{ label: 'Marks', value: 'marks' }, { label: 'Grade', value: 'grade' }]
const conversionTypeOptions = [
  { label: 'None', value: 'none' },
  { label: 'Marks → Grade', value: 'marks_to_grade' },
  { label: 'Sum Up', value: 'sum_up' },
  { label: 'Sum Down', value: 'sum_down' },
]

const terms = ref([])
const scales = ref([])
const coActivities = ref([])
// Classes are read here only so a move can detach the subject from every
// `classes/{id}.subjects[]` that references it — leaving a dangling subjectId
// behind would break the teacher app's subject dropdown for that class.
const classes = ref([])

async function loadCoScholasticContext() {
  if (!props.schoolId) { terms.value = []; scales.value = []; coActivities.value = []; classes.value = []; return }
  try {
    const [tSnap, gSnap, aSnap, cSnap] = await Promise.all([
      getDocs(schoolCollection(props.schoolId, 'terms')),
      getDocs(schoolCollection(props.schoolId, 'grading_scales')),
      getDocs(schoolCollection(props.schoolId, 'co_scholastic_activities')),
      getDocs(schoolCollection(props.schoolId, 'classes')),
    ])
    terms.value = tSnap.docs.map(d => ({ id: d.id, ...d.data() }))
    scales.value = gSnap.docs.map(d => ({ id: d.id, ...d.data() }))
    coActivities.value = aSnap.docs.map(d => ({ id: d.id, ...d.data() }))
    classes.value = cSnap.docs.map(d => ({ id: d.id, ...d.data() }))
  } catch (e) {
    console.error('Could not load terms/scales/co-scholastic activities/classes', e)
  }
}

// The grade tokens THIS school actually uses. Read from classes rather than a
// fixed list because ClassesTeachersTab attaches a subject to a class by exact
// string equality on the id prefix (`parseGrade(subject.id) === class.clazz`) —
// so a subject filed under a token no class uses can never be attached, and the
// teacher app's subject dropdown (classes.subjects[] ∩ assignments[classId])
// comes back empty.
const classGrades = computed(() => {
  const seen = new Set()
  for (const c of classes.value) {
    const g = (c.clazz || '').trim()
    if (g) seen.add(g)
  }
  return Array.from(seen).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
})

// Co-scholastic activities are ordered within a term — a new one lands last.
function nextCoOrder(termId) {
  const inTerm = coActivities.value.filter(a => a.termId === termId)
  return inTerm.length ? Math.max(...inTerm.map(a => a.order || 0)) + 1 : 1
}

function parseGrade(id) {
  return (id || '').split('_')[0] || '?'
}

const gradeGroups = computed(() => {
  const map = new Map()
  for (const s of subjects.value) {
    const g = parseGrade(s.id)
    if (!map.has(g)) map.set(g, [])
    map.get(g).push(s)
  }
  return Array.from(map.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([grade, list]) => ({ grade, subjects: list.sort((a, b) => a.name.localeCompare(b.name)) }))
})

async function loadSubjects() {
  if (!props.schoolId) { subjects.value = []; return }
  loading.value = true
  try {
    const snap = await getDocs(query(schoolCollection(props.schoolId, 'subjects'), orderBy('name')))
    subjects.value = snap.docs.map(d => ({ id: d.id, ...d.data() }))
  } catch (e) {
    console.error('Could not load subjects', e)
    subjects.value = []
  } finally {
    loading.value = false
  }
}

// ── Add/Edit form ────────────────────────────────────────────────────────
const dialogVisible = ref(false)
const editingSubject = ref(null)
const saving = ref(false)
const formError = ref('')
const form = reactive({
  grade: '', name: '', id: '', goals: [], area: '', name_original: '',
  termId: null, entryType: CO_DEFAULTS.entryType, maxMarks: CO_DEFAULTS.maxMarks,
  gradingScaleId: null, conversionType: CO_DEFAULTS.conversionType, conversionFactor: null, order: 1,
})

// Only ever true while *adding*. Editing an existing subjects doc keeps the
// plain subject form and keeps writing to subjects — moving an already-filed
// doc between collections is the migration script's job, not a side effect of
// an edit (scripts/migrate-co-scholastic-subjects.mjs).
const isCoScholasticForm = computed(() => !editingSubject.value && isCoScholasticArea(form.area))

// Must stay below `form`, `editingSubject` and `isCoScholasticForm` — same
// ordering rule as the watch in SchoolSetup.vue. Advisory only: it never blocks
// a save, because a subject may legitimately be created before its class exists
// and this tab has to keep working for a school with no classes yet.
const gradeWarning = computed(() => {
  if (isCoScholasticForm.value || editingSubject.value) return ''
  const g = (form.grade || '').trim()
  if (!g) return ''
  if (!classes.value.length) return 'This school has no classes yet — nothing to check this grade against.'
  if (classGrades.value.includes(g)) return ''
  return `No class in this school uses grade "${g}". Its classes use: ${classGrades.value.join(', ')}. `
       + 'A subject whose grade does not match a class can never be attached to it.'
})
const dialogHeader = computed(() => {
  if (editingSubject.value) return 'Edit Subject'
  return isCoScholasticForm.value ? 'Add Co-Scholastic Activity' : 'Add Subject'
})

// The knowledge base decides scholastic vs co-scholastic; the subject doc
// records it as `area` so the import parser's core-subject coverage check
// (functions/generate_import/main.py) and the Co-Scholastic tab agree with
// School Setup instead of each guessing separately.
const { loadKB, overlay } = useEducationKB()

function onNameClassified({ type, canonical, original }) {
  if (type === SUBJECT) form.area = 'Scholastic'
  else if (type === COSCHOLASTIC) form.area = 'Co-Scholastic'
  // Keep what was actually typed — 'Eng' stays recoverable after the field
  // itself has been normalized to 'English'.
  form.name_original = original && original !== canonical ? original : ''
}

function slugify(grade, name) {
  const cleanName = name.trim().replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '')
  return `${grade.trim()}_${cleanName}`
}

// Doc ID convention differs per target: `{Grade}_{Name}` for subjects,
// `{termId}_{Name}` for co_scholastic_activities (matches CoScholasticTab).
watch([() => form.area, () => form.grade, () => form.name, () => form.termId], () => {
  if (editingSubject.value) return
  form.id = isCoScholasticForm.value
    ? (form.termId ? `${form.termId}_${slugifyText(form.name)}` : '')
    : slugify(form.grade || '', form.name || '')
})

// Default the term (when unambiguous) and the order the moment the KB — or the
// user — flips this into a co-scholastic record.
watch([() => form.area, () => form.termId], () => {
  if (editingSubject.value || !isCoScholasticForm.value) return
  if (!form.termId && terms.value.length === 1) form.termId = terms.value[0].id
  if (form.termId) form.order = nextCoOrder(form.termId)
})

function goalsFromDoc(doc) {
  return (doc.curricular_goals || []).map(obj => {
    const [goal, competencies] = Object.entries(obj || {})[0] || ['', []]
    return { goal, competencies: [...(competencies || [])] }
  })
}
function goalsToDoc(goals) {
  return goals
    .filter(g => g.goal.trim())
    .map(g => ({ [g.goal.trim()]: g.competencies.map(c => c.trim()).filter(Boolean) }))
}

function openAddSubject() {
  editingSubject.value = null
  Object.assign(form, {
    grade: '', name: '', id: '', goals: [], area: '', name_original: '',
    termId: terms.value.length === 1 ? terms.value[0].id : null, ...CO_DEFAULTS, order: 1,
  })
  formError.value = ''
  dialogVisible.value = true
}

function openEditSubject(subject) {
  editingSubject.value = subject
  Object.assign(form, {
    grade: parseGrade(subject.id), name: subject.name || '', id: subject.id, goals: goalsFromDoc(subject),
    area: subject.area || '', name_original: subject.name_original || '',
  })
  formError.value = ''
  dialogVisible.value = true
}

function addGoal() {
  form.goals.push({ goal: '', competencies: [''] })
}

function validateSubject() {
  if (!form.name.trim()) return 'Name is required'
  if (isCoScholasticForm.value) {
    if (!terms.value.length) return 'This school has no terms yet — add one in Terms & Scales first'
    if (!form.termId) return 'Term is required for Co-Scholastic activities'
    if (!form.maxMarks || form.maxMarks <= 0) return 'Max marks must be greater than 0'
    if (form.conversionType !== 'none' && form.conversionType !== 'marks_to_grade' && !form.conversionFactor) return 'Conversion factor is required for this conversion type'
    if ((form.conversionType === 'marks_to_grade' || form.entryType === 'grade') && !form.gradingScaleId) return 'Grading scale is required'
    if (!form.order || form.order <= 0) return 'Order must be greater than 0'
    if (!form.id.trim()) return 'Doc ID is required'
    if (coActivities.value.some(a => a.id === form.id.trim())) return 'A co-scholastic activity with this ID already exists — edit it in the Co-Scholastic tab'
    return ''
  }
  if (!form.grade.trim()) return 'Grade is required'
  if (!form.id.trim()) return 'Doc ID is required'
  if (!editingSubject.value && subjects.value.some(s => s.id === form.id.trim())) return 'A subject with this ID already exists'
  return ''
}

async function saveSubject() {
  formError.value = validateSubject()
  if (formError.value) return
  saving.value = true
  try {
    // Area "Co-Scholastic" ⇒ a term-wide activity, written to
    // co_scholastic_activities in that collection's shape — never to subjects.
    if (isCoScholasticForm.value) {
      await setDoc(schoolDoc(props.schoolId, 'co_scholastic_activities', form.id.trim()), {
        name: form.name.trim(), termId: form.termId, entryType: form.entryType, maxMarks: form.maxMarks,
        gradingScaleId: form.gradingScaleId || null, conversionType: form.conversionType,
        conversionFactor: form.conversionFactor || null, order: form.order,
        ...(form.name_original ? { name_original: form.name_original } : {}),
        updated_at: serverTimestamp(), updated_by: auth.currentUser?.email || 'unknown',
        created_at: serverTimestamp(), created_by: auth.currentUser?.email || 'unknown',
      }, { merge: true })
      dialogVisible.value = false
      toast.add({ severity: 'success', summary: 'Saved to Co-Scholastic', detail: 'Manage it in the Co-Scholastic tab', life: 3000 })
      await loadCoScholasticContext()
      return
    }

    const payload = {
      name: form.name.trim(),
      area: form.area || areaFor(form.name),
      name_original: form.name_original || '',
      curricular_goals: goalsToDoc(form.goals),
      updated_at: serverTimestamp(),
      updated_by: auth.currentUser?.email || 'unknown',
    }
    if (editingSubject.value) {
      await guardedUpdateDoc('subjects', schoolDoc(props.schoolId, 'subjects', editingSubject.value.id), payload)
    } else {
      payload.id = form.id.trim()
      payload.created_at = serverTimestamp()
      payload.created_by = auth.currentUser?.email || 'unknown'
      await guardedSetDoc('subjects', schoolDoc(props.schoolId, 'subjects', form.id.trim()), payload, { merge: false })
    }
    dialogVisible.value = false
    toast.add({ severity: 'success', summary: 'Saved', life: 2000 })
    await loadSubjects()
  } catch (e) {
    formError.value = e instanceof SchemaViolation ? e.userMessage : 'Something went wrong. Try again.'
  } finally {
    saving.value = false
  }
}

// ── Move a misfiled subject into co_scholastic_activities ─────────────────
// The Subjects tab now routes on `area` at write time, but schools set up
// before that — and any row whose name the knowledge base couldn't place —
// still carry co-scholastic records in `subjects`. This is the in-app version
// of scripts/migrate-co-scholastic-subjects.mjs: same target schema, same
// defaults, but scoped to one school with the term and marking settings chosen
// rather than guessed, and it also cleans up the class references the script
// leaves alone.
// Two ways a subjects doc is really a co-scholastic record:
//   - it is tagged Co-Scholastic and was written to `subjects` anyway; or
//   - its `area` is blank because the knowledge base could not place the name
//     when it was written, and the KB HAS since learned it. That second case is
//     how most of them actually arrive — Hillgreen's Conc/Dict/Linguistic/CLB/
//     KRT/V_Edu were all stored unclassified — so leaving it out would mean the
//     bulk move quietly skipped the majority of them.
// A doc explicitly tagged Scholastic is never second-guessed here: that is a
// human's answer, and the → button on the row is there to override it.
const misfiledSubjects = computed(() => subjects.value.filter(s =>
  isCoScholasticArea(s.area) || (!s.area && areaFor(s.name) === AREA_CO_SCHOLASTIC)))

const moveDialogVisible = ref(false)
const moveTargets = ref([])
const moving = ref(false)
const moveError = ref('')
const moveForm = reactive({ termId: null, ...CO_DEFAULTS })

function classesUsing(subjectId) {
  return classes.value.filter(c => (c.subjects || []).some(x => x?.subjectId === subjectId))
}

function openMoveDialog(targets) {
  moveTargets.value = [...targets]
  moveError.value = ''
  Object.assign(moveForm, {
    termId: terms.value.length ? (terms.value.find(t => t.isActive !== false) || terms.value[0]).id : null,
    ...CO_DEFAULTS,
  })
  moveDialogVisible.value = true
}

// One row per subject being moved, with everything that changes or blocks it.
// Recomputes as the term changes, since the target doc ID is term-scoped.
//
// A co-scholastic activity is TERM-WIDE, so the per-grade copies a school
// keeps in `subjects` (I_KRT, II_KRT, III_KRT) are three filings of ONE
// activity. They therefore collapse into a single target: the activity is
// written once and every one of those source docs is removed. Treating the
// second and third as conflicts instead would move one and strand the rest as
// permanently-misfiled duplicates.
const movePlan = computed(() => {
  const termId = moveForm.termId
  const firstFor = new Map()
  return moveTargets.value.map(subject => {
    const name = (subject.name || '').trim() || subject.id
    const newId = termId ? `${termId}_${slugifyText(name)}` : ''
    const notes = []
    let blocked = false
    let mergedInto = null

    if (!termId) {
      notes.push('pick a term first'); blocked = true
    } else if (coActivities.value.some(a => a.id === newId)) {
      // A pre-existing activity is a real conflict — it may already carry
      // marking settings and entered marks, so it is never overwritten here.
      notes.push(`an activity "${newId}" already exists — rename the subject or edit that activity instead`)
      blocked = true
    } else if (firstFor.has(newId)) {
      mergedInto = firstFor.get(newId)
      notes.push(`same term-wide activity as ${mergedInto} — merged into one "${newId}", this subjects doc is removed`)
    } else {
      firstFor.set(newId, subject.id)
    }

    const goals = (subject.curricular_goals || []).length
    const topics = (subject.topics || []).length
    if (goals) notes.push(`${goals} curricular goal(s) dropped — the activity schema has no field for them`)
    if (topics) notes.push(`${topics} topic(s) dropped`)
    const usedBy = classesUsing(subject.id)
    if (usedBy.length) notes.push(`detached from ${usedBy.length} class(es)`)
    return { subject, newId, notes, blocked, mergedInto, usedBy }
  })
})
const movablePlan = computed(() => movePlan.value.filter(r => !r.blocked))
const unclassifiedCoCount = computed(() =>
  misfiledSubjects.value.filter(s => !s.area).length)
// The activities that actually get written — one per distinct target ID.
const moveWriteCount = computed(() => new Set(movablePlan.value.map(r => r.newId)).size)

function validateMove() {
  if (!terms.value.length) return 'This school has no terms yet — add one in Terms & Scales first'
  if (!moveForm.termId) return 'Term is required'
  if (!moveForm.maxMarks || moveForm.maxMarks <= 0) return 'Max marks must be greater than 0'
  if (moveForm.conversionType !== 'none' && moveForm.conversionType !== 'marks_to_grade' && !moveForm.conversionFactor) {
    return 'Conversion factor is required for this conversion type'
  }
  if ((moveForm.conversionType === 'marks_to_grade' || moveForm.entryType === 'grade') && !moveForm.gradingScaleId) {
    return 'Grading scale is required'
  }
  return ''
}

function confirmMove() {
  moveError.value = validateMove()
  if (moveError.value) return
  const rows = movablePlan.value
  const detaching = rows.reduce((n, r) => n + r.usedBy.length, 0)
  confirm.require({
    message: `Move ${rows.length} record(s) into ${moveWriteCount.value} co_scholastic_activities doc(s)? Each subjects doc is deleted`
      + (detaching ? `, and ${detaching} class subject-list reference(s) are removed` : '')
      + '. Curricular goals and topics on these docs are not carried over.',
    header: 'Move to Co-Scholastic',
    icon: 'pi pi-exclamation-triangle',
    rejectLabel: 'Cancel', acceptLabel: 'Move', acceptClass: 'p-button-danger',
    accept: runMove,
  })
}

async function runMove() {
  moving.value = true
  moveError.value = ''
  const rows = movablePlan.value
  try {
    // Order within the term continues after whatever is already there.
    const inTerm = coActivities.value.filter(a => a.termId === moveForm.termId).map(a => a.order || 0)
    let nextOrder = inTerm.length ? Math.max(...inTerm) + 1 : 1

    // Detaches accumulate per class across the whole move. Writing each one
    // from its own loaded snapshot would make the second moved subject on a
    // class restore the first one it had just removed.
    const classSubjectsNow = new Map()

    // Detach from every class before deleting, so no class is left pointing at
    // a subjects doc that no longer exists.
    const detachAndDelete = async (row) => {
      for (const cls of row.usedBy) {
        const current = classSubjectsNow.has(cls.id) ? classSubjectsNow.get(cls.id) : cls.subjects
        const next = detachClassSubject(current, row.subject.id)
        if (!next) continue
        classSubjectsNow.set(cls.id, next)
        await updateDoc(schoolDoc(props.schoolId, 'classes', cls.id), {
          subjects: next, updated_at: serverTimestamp(), updated_by: auth.currentUser?.email || 'unknown',
        })
      }
      await deleteDoc(schoolDoc(props.schoolId, 'subjects', row.subject.id))
    }

    const writtenActivityIds = new Set()
    for (const row of rows) {
      const target = schoolDoc(props.schoolId, 'co_scholastic_activities', row.newId)
      // Written once per activity; the sibling rows that merged into it skip
      // straight to detaching and deleting their own subjects doc.
      if (writtenActivityIds.has(row.newId)) {
        await detachAndDelete(row)
        continue
      }
      writtenActivityIds.add(row.newId)
      await setDoc(target, {
        name: (row.subject.name || '').trim() || row.subject.id,
        termId: moveForm.termId,
        order: nextOrder++,
        entryType: moveForm.entryType,
        maxMarks: moveForm.maxMarks,
        gradingScaleId: moveForm.gradingScaleId || null,
        conversionType: moveForm.conversionType,
        conversionFactor: moveForm.conversionFactor || null,
        ...(row.subject.name_original ? { name_original: row.subject.name_original } : {}),
        migrated_from_subject_id: row.subject.id,
        created_at: serverTimestamp(), created_by: auth.currentUser?.email || 'unknown',
        updated_at: serverTimestamp(), updated_by: auth.currentUser?.email || 'unknown',
      }, { merge: true })

      // Only delete the source once the target is confirmed on the server —
      // same rule the migration script follows, so a failed write can never
      // lose the record.
      const written = await getDoc(target)
      if (!written.exists()) {
        moveError.value = `"${row.subject.id}" could not be written to co_scholastic_activities — it was left in subjects.`
        continue
      }

      await detachAndDelete(row)
    }

    moveDialogVisible.value = !!moveError.value
    if (!moveError.value) {
      toast.add({ severity: 'success', summary: 'Moved to Co-Scholastic', detail: `${rows.length} record(s) → ${moveWriteCount.value} activity(ies) — manage them in the Co-Scholastic tab`, life: 4000 })
    }
    await Promise.all([loadSubjects(), loadCoScholasticContext()])
  } catch (e) {
    console.error(e)
    moveError.value = 'Something went wrong during the move. Re-open this dialog to see what is left in subjects.'
  } finally {
    moving.value = false
  }
}

// ── Copy goals from another subject (same school) ──────────────────────────
const copyGoalsDialogVisible = ref(false)
const copySourceSubjectId = ref(null)

function copyGoalsFromSubject() {
  const src = subjects.value.find(s => s.id === copySourceSubjectId.value)
  if (!src) return
  form.goals = goalsFromDoc(src)
  copyGoalsDialogVisible.value = false
  toast.add({ severity: 'success', summary: 'Goals copied', detail: 'Review and save to apply', life: 2500 })
}

// ── Copy goals from another school ──────────────────────────────────────────
const copySchoolDialogVisible = ref(false)
const copySchoolId = ref(null)
const copySchoolSubjectId = ref(null)
const copySchoolError = ref('')
const otherSchools = ref([])
const otherSchoolSubjects = ref([])

async function loadOtherSchools() {
  try {
    const snap = await getDocs(query(rootSchoolsCollection(), orderBy('name')))
    otherSchools.value = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(s => s.id !== props.schoolId && s.isActive !== false)
  } catch (e) {
    console.error('Could not load schools', e)
  }
}

async function loadOtherSchoolSubjects() {
  copySchoolSubjectId.value = null
  otherSchoolSubjects.value = []
  if (!copySchoolId.value) return
  try {
    const snap = await getDocs(query(schoolCollection(copySchoolId.value, 'subjects'), orderBy('name')))
    otherSchoolSubjects.value = snap.docs.map(d => ({ id: d.id, ...d.data() }))
  } catch (e) {
    console.error('Could not load subjects for source school', e)
  }
}

function copyGoalsFromSchool() {
  const src = otherSchoolSubjects.value.find(s => s.id === copySchoolSubjectId.value)
  if (!src) { copySchoolError.value = 'Select a subject'; return }
  form.goals = goalsFromDoc(src)
  copySchoolDialogVisible.value = false
  copySchoolError.value = ''
  toast.add({ severity: 'success', summary: 'Goals copied', detail: 'Review and save to apply', life: 2500 })
}

// ── CSV import/export ────────────────────────────────────────────────────
// Curricular goals aren't included — they're a nested goal→competencies
// structure that doesn't flatten cleanly into a row; use the goals editor
// (or "copy from" actions) for those. CSV covers grade/name/id only.
// `area` routes each row. It's optional: left blank, the knowledge base
// classifies the name (areaFor), same as it always has — the difference is
// that a Co-Scholastic verdict now decides the *collection*, not just a label.
// The trailing columns apply to co-scholastic rows only.
const SUBJECT_CSV_COLUMNS = ['grade', 'name', 'id', 'area', 'termId', 'order', 'entryType', 'maxMarks', 'gradingScaleId', 'conversionType', 'conversionFactor']
const importVisible = ref(false)

function classifyCoScholasticRow(raw, name, areaSource) {
  if (!terms.value.length) return { raw, _status: 'ERROR', _reason: 'School has no terms — add one in Terms & Scales first' }
  // Only safe to infer the term when there's exactly one; otherwise the row
  // has to name it rather than have us guess which term it belongs to.
  const termId = (raw.termId || '').trim() || (terms.value.length === 1 ? terms.value[0].id : '')
  if (!termId) return { raw, _status: 'ERROR', _reason: `${areaSource} is Co-Scholastic but school has multiple terms — add a termId column` }
  if (!terms.value.some(t => t.id === termId)) return { raw, _status: 'ERROR', _reason: `Unknown termId "${termId}"` }

  const entryType = (raw.entryType || '').trim() || CO_DEFAULTS.entryType
  if (!['marks', 'grade'].includes(entryType)) return { raw, _status: 'ERROR', _reason: 'entryType must be "marks" or "grade"' }

  const maxMarksRaw = (raw.maxMarks ?? '').toString().trim()
  const maxMarks = maxMarksRaw ? Number(maxMarksRaw) : CO_DEFAULTS.maxMarks
  if (!maxMarks || Number.isNaN(maxMarks) || maxMarks <= 0) return { raw, _status: 'ERROR', _reason: 'maxMarks must be a number greater than 0' }

  const conversionType = (raw.conversionType || '').trim() || CO_DEFAULTS.conversionType
  if (!['none', 'marks_to_grade', 'sum_up', 'sum_down'].includes(conversionType)) return { raw, _status: 'ERROR', _reason: 'conversionType must be none/marks_to_grade/sum_up/sum_down' }

  const conversionFactorRaw = (raw.conversionFactor ?? '').toString().trim()
  const conversionFactor = conversionFactorRaw ? Number(conversionFactorRaw) : null
  if (conversionType !== 'none' && conversionType !== 'marks_to_grade' && !conversionFactor) return { raw, _status: 'ERROR', _reason: 'conversionFactor is required for this conversionType' }

  const gradingScaleId = (raw.gradingScaleId || '').trim() || null
  if ((conversionType === 'marks_to_grade' || entryType === 'grade') && !gradingScaleId) return { raw, _status: 'ERROR', _reason: 'gradingScaleId is required' }
  if (gradingScaleId && !scales.value.some(s => s.id === gradingScaleId)) return { raw, _status: 'ERROR', _reason: `Unknown gradingScaleId "${gradingScaleId}"` }

  const orderRaw = (raw.order ?? '').toString().trim()
  const order = orderRaw ? Number(orderRaw) : null
  if (orderRaw && (!order || Number.isNaN(order) || order <= 0)) return { raw, _status: 'ERROR', _reason: 'order must be a number greater than 0' }

  const id = (raw.id || '').trim() || `${termId}_${slugifyText(name)}`
  const existing = coActivities.value.find(a => a.id === id)
  const sensitiveChange = !!existing && (maxMarks !== existing.maxMarks || entryType !== existing.entryType)
  const notes = [`${areaSource} Co-Scholastic → co_scholastic_activities`]
  if (order === null) notes.push('order auto-assigned')
  if (sensitiveChange) notes.push('changes maxMarks/entryType — entered-marks check runs on confirm')
  return {
    raw, id, _target: 'co_scholastic_activities',
    _status: existing ? 'UPDATE' : 'CREATE',
    // order stays null when unspecified — runImport appends it to the term.
    payload: { name, termId, order, entryType, maxMarks, gradingScaleId, conversionType, conversionFactor },
    _sensitiveChange: sensitiveChange,
    _warning: notes.join('; '),
  }
}

async function classifyImportRow(raw) {
  const name = (raw.name || '').trim()
  if (!name) return { raw, _status: 'ERROR', _reason: 'Missing name' }

  // An explicit area column wins; otherwise fall back to the KB, exactly as
  // before. Either way, Co-Scholastic changes the destination collection.
  const explicitArea = (raw.area || '').trim()
  const area = explicitArea || areaFor(name)
  if (isCoScholasticArea(area)) {
    return classifyCoScholasticRow(raw, name, explicitArea ? 'area column' : 'knowledge base says')
  }

  const grade = (raw.grade || '').trim()
  if (!grade) return { raw, _status: 'ERROR', _reason: 'Missing grade' }
  const id = (raw.id || '').trim() || slugify(grade, name)
  const existing = subjects.value.find(s => s.id === id)
  return { raw, id, _target: 'subjects', _status: existing ? 'UPDATE' : 'CREATE', payload: { name, area } }
}

async function writeImportChunks(rows, collectionName) {
  for (let i = 0; i < rows.length; i += 450) {
    const chunk = rows.slice(i, i + 450)
    const batch = writeBatch(db)
    chunk.forEach(r => {
      const payload = { ...r.payload, updated_at: serverTimestamp(), updated_by: auth.currentUser?.email || 'unknown' }
      if (r._status === 'CREATE') {
        // co_scholastic_activities docs carry no `id` field (see spec §2).
        if (collectionName === 'subjects') payload.id = r.id
        payload.created_at = serverTimestamp()
        payload.created_by = auth.currentUser?.email || 'unknown'
      }
      batch.set(schoolDoc(props.schoolId, collectionName, r.id), payload, { merge: true })
    })
    await batch.commit()
  }
}

async function runImport(validRows) {
  const coRows = validRows.filter(r => r._target === 'co_scholastic_activities')
  const subjectRows = validRows.filter(r => r._target !== 'co_scholastic_activities')

  // Same gate as the Co-Scholastic tab: lowering maxMarks or flipping
  // entryType on an activity teachers have already entered marks against can
  // invalidate those values.
  const sensitiveRows = coRows.filter(r => r._sensitiveChange)
  if (sensitiveRows.length) {
    const termIds = Array.from(new Set(sensitiveRows.map(r => r.payload.termId)))
    const checks = await Promise.all(termIds.map(t => checkEnteredMarksCoScholastic(props.schoolId, t).catch(() => 'error')))
    if (checks.includes('error')) {
      toast.add({ severity: 'error', summary: 'Error', detail: 'Could not verify entered marks — aborting.', life: 4000 })
      return false
    }
    if (checks.some(Boolean)) {
      const proceed = await new Promise(resolve => {
        confirm.require({
          message: `Teachers may have already entered co-scholastic marks. ${sensitiveRows.length} changed row(s) (${sensitiveRows.map(r => r.payload.name).join(', ')}) may invalidate those values. Continue anyway?`,
          header: 'Entered marks exist', icon: 'pi pi-exclamation-triangle',
          rejectLabel: 'Cancel', acceptLabel: 'Continue anyway', acceptClass: 'p-button-danger',
          accept: () => resolve(true), reject: () => resolve(false),
        })
      })
      if (!proceed) return false
    }
  }

  // Fill in `order` for rows that didn't specify one, appending to each term's
  // existing list and keeping rows within one file distinct.
  const nextByTerm = new Map()
  for (const r of coRows) {
    const termId = r.payload.termId
    if (!nextByTerm.has(termId)) nextByTerm.set(termId, nextCoOrder(termId))
    if (r.payload.order == null) {
      r.payload.order = nextByTerm.get(termId)
      nextByTerm.set(termId, r.payload.order + 1)
    } else {
      nextByTerm.set(termId, Math.max(nextByTerm.get(termId), r.payload.order + 1))
    }
  }

  await writeImportChunks(subjectRows, 'subjects')
  await writeImportChunks(coRows, 'co_scholastic_activities')

  const detail = coRows.length
    ? `${subjectRows.length} subject(s), ${coRows.length} co-scholastic activity(ies)`
    : `${subjectRows.length} row(s)`
  toast.add({ severity: 'success', summary: 'Imported', detail, life: 3500 })
  await loadSubjects()
  if (coRows.length) await loadCoScholasticContext()
  return true
}

// Scholastic/Co-Scholastic straight from the shared knowledge base. Only a
// HIGH-confidence answer sets it — a name the KB can't place is left blank
// rather than mis-filed, and shows up as unclassified in the table.
function areaFor(name) {
  const r = classifyValue(name, { overlay: overlay.value })
  if (r.confidence < 0.95) return ''
  if (r.type === SUBJECT) return 'Scholastic'
  if (r.type === COSCHOLASTIC) return 'Co-Scholastic'
  return ''
}

function downloadSample() {
  // Prefer grades already in use, then the school's actual class grades. The
  // roman literals are a last resort only — handing a numeric-notation school a
  // sample that says "III" is how a subject gets filed under a grade none of its
  // classes use.
  const existingGrades = Array.from(new Set(subjects.value.map(s => parseGrade(s.id))))
  const candidates = existingGrades.length ? existingGrades : classGrades.value
  const g1 = candidates[0] || 'III'
  const g2 = candidates[1] || candidates[0] || 'IV'
  const termId = terms.value[0]?.id || 'term1'
  const sample = [
    // area left blank — the knowledge base classifies these from the name.
    { grade: g1, name: 'English', id: '' },
    { grade: g1, name: 'Maths', id: '' },
    { grade: g2, name: 'Science', id: '' },
    // Co-Scholastic rows ignore `grade` and go to co_scholastic_activities.
    { grade: '', name: 'Art & Craft', id: '', area: AREA_CO_SCHOLASTIC, termId, order: 1, entryType: 'marks', maxMarks: 10, gradingScaleId: '', conversionType: 'none', conversionFactor: '' },
  ]
  downloadCsv('subjects_sample.csv', toCsv(sample, SUBJECT_CSV_COLUMNS))
}
function exportCsv() {
  const rows = subjects.value.map(s => ({ grade: parseGrade(s.id), name: s.name, id: s.id, area: s.area || '' }))
  downloadCsv(`subjects_${props.schoolId}.csv`, toCsv(rows, SUBJECT_CSV_COLUMNS))
}

watch(() => props.schoolId, () => { loadSubjects(); loadCoScholasticContext() })
// Reload when this tab becomes the active one: sibling tabs edit the same
// collections and every panel stays mounted, so what was loaded on mount
// goes stale the moment another tab writes (see SchoolSetup.vue).
const activeSetupTab = inject('activeSetupTab', null)
if (activeSetupTab) watch(activeSetupTab, v => { if (v === 'subjects') { loadSubjects(); loadCoScholasticContext() } })

onMounted(() => { loadSubjects(); loadCoScholasticContext(); loadOtherSchools(); loadKB() })
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
