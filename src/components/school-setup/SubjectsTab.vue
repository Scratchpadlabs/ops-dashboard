<template>
  <div class="pt-4">
    <div class="flex items-center justify-between mb-3">
      <div class="text-sm font-bold text-slate-900">Subjects</div>
      <div class="flex gap-2">
        <Button label="Import CSV" icon="pi pi-upload" size="small" outlined @click="importVisible = true" />
        <Button label="Sample CSV" icon="pi pi-download" size="small" text @click="downloadSample" />
        <Button label="Export CSV" icon="pi pi-file-export" size="small" text @click="exportCsv" />
        <Button
          label="Backfill Goals" icon="pi pi-sparkles" size="small" outlined
          :loading="backfilling" :disabled="!subjects.length" @click="backfillGoals"
          v-tooltip="'Copy curricular goals into subjects with 0 goals from a matching grade+subject at another school'"
        />
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
                  v-tooltip="isCoScholasticArea(data.area) ? 'Misfiled: Co-Scholastic records belong in co_scholastic_activities. Run scripts/migrate-co-scholastic-subjects.mjs to move it.' : ''"
                >{{ data.area }}{{ isCoScholasticArea(data.area) ? ' ⚠' : '' }}</span>
                <span v-else class="text-xs text-slate-300" v-tooltip="'Not classified — open the subject and let the knowledge base categorize it'">—</span>
              </template>
            </Column>
            <Column field="curricular_goals" header="Goals" style="width:100px">
              <template #body="{ data }"><span class="text-xs text-slate-400">{{ (data.curricular_goals || []).length }}</span></template>
            </Column>
            <Column field="topics" header="Topics" style="width:100px">
              <template #body="{ data }"><span class="text-xs text-slate-400">{{ (data.topics || []).length }}</span></template>
            </Column>
            <Column header="" style="width:80px">
              <template #body="{ data }">
                <Button icon="pi pi-pencil" text rounded size="small" @click="openEditSubject(data)" />
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
            <InputText v-model="form.grade" class="w-full" placeholder="e.g. III" :disabled="!!editingSubject" />
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

        <div v-if="!isCoScholasticForm">
          <div class="flex items-center justify-between mb-2">
            <label class="form-label mb-0">Topics</label>
            <button type="button" class="text-xs text-violet-600 font-semibold" @click="addTopic">+ Add Topic</button>
          </div>
          <div v-for="(topic, ti) in form.topics" :key="ti" class="border border-slate-200 rounded-lg p-3 mb-2">
            <div class="flex items-center gap-2 mb-2">
              <InputText v-model="topic.topic" placeholder="Topic name" class="flex-1 text-sm" />
              <Button icon="pi pi-trash" text rounded size="small" severity="danger" @click="form.topics.splice(ti, 1)" />
            </div>
            <InputText v-model="topic.description" placeholder="Description (optional)" class="w-full text-sm mb-2" />

            <div class="ml-4">
              <div class="flex items-center justify-between mb-1">
                <span class="text-xs font-semibold text-slate-500">Quiz</span>
                <button type="button" class="text-xs text-violet-600 font-semibold" @click="addQuizQuestion(topic)">+ Add Question</button>
              </div>
              <div v-for="(q, qi) in topic.quiz" :key="qi" class="bg-slate-50 rounded-lg p-2 mb-1.5">
                <div class="flex items-center gap-2 mb-1.5">
                  <InputText v-model="q.question" placeholder="Question" class="flex-1 text-sm" />
                  <Button icon="pi pi-trash" text rounded size="small" severity="danger" @click="topic.quiz.splice(qi, 1)" />
                </div>
                <div v-for="(opt, oi) in q.options" :key="oi" class="flex items-center gap-2 mb-1 ml-4">
                  <RadioButton :modelValue="q.correctIndex" :value="oi" @update:modelValue="q.correctIndex = oi" v-tooltip="'Correct answer'" />
                  <InputText v-model="q.options[oi]" placeholder="Option text" class="flex-1 text-sm" />
                  <Button
                    icon="pi pi-trash" text rounded size="small" severity="danger" :disabled="q.options.length <= 2"
                    @click="removeQuizOption(q, oi)"
                  />
                </div>
                <button type="button" class="text-xs text-violet-600 font-semibold ml-4" @click="q.options.push('')">+ Add Option</button>
              </div>
              <p v-if="!(topic.quiz || []).length" class="text-xs text-slate-400">No quiz questions yet.</p>
            </div>
          </div>
          <p v-if="!form.topics.length" class="text-xs text-slate-400">No topics yet.</p>
        </div>

        <div v-if="formError" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{{ formError }}</div>
      </div>
      <template #footer>
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

    <ConfirmDialog />
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted } from 'vue'
import { getDocs, setDoc, updateDoc, query, orderBy, serverTimestamp, writeBatch } from 'firebase/firestore'
import { useConfirm } from 'primevue/useconfirm'
import { useToast } from 'primevue/usetoast'

import Button from 'primevue/button'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import InputNumber from 'primevue/inputnumber'
import Select from 'primevue/select'
import RadioButton from 'primevue/radiobutton'
import ProgressSpinner from 'primevue/progressspinner'
import ConfirmDialog from 'primevue/confirmdialog'
import CsvImportDialog from './CsvImportDialog.vue'
import ConfigEmptyState from './ConfigEmptyState.vue'
import KbClassifiedInput from '../shared/KbClassifiedInput.vue'

import { schoolCollection, schoolDoc, rootSchoolsCollection } from '../../firebase/schoolCollections.js'
import { guardedSetDoc, guardedUpdateDoc, SchemaViolation } from '../../schemas/guardedWrite.js'
import { db, auth } from '../../firebase/config'
import { toCsv, downloadCsv } from '../../utils/csv.js'
import { useEducationKB } from '../../composables/useEducationKB.js'
import { loadGoalsLibrary, normalizeGrade } from '../../composables/useImport.js'
import { SUBJECT, COSCHOLASTIC, classify as classifyValue } from '../../utils/educationKB.js'
import { checkEnteredMarksCoScholastic, isCoScholasticArea, slugify as slugifyText } from '../../utils/assessmentHelpers.js'

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

async function loadCoScholasticContext() {
  if (!props.schoolId) { terms.value = []; scales.value = []; coActivities.value = []; return }
  try {
    const [tSnap, gSnap, aSnap] = await Promise.all([
      getDocs(schoolCollection(props.schoolId, 'terms')),
      getDocs(schoolCollection(props.schoolId, 'grading_scales')),
      getDocs(schoolCollection(props.schoolId, 'co_scholastic_activities')),
    ])
    terms.value = tSnap.docs.map(d => ({ id: d.id, ...d.data() }))
    scales.value = gSnap.docs.map(d => ({ id: d.id, ...d.data() }))
    coActivities.value = aSnap.docs.map(d => ({ id: d.id, ...d.data() }))
  } catch (e) {
    console.error('Could not load terms/scales/co-scholastic activities', e)
  }
}

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
  grade: '', name: '', id: '', goals: [], topics: [], area: '', name_original: '',
  termId: null, entryType: CO_DEFAULTS.entryType, maxMarks: CO_DEFAULTS.maxMarks,
  gradingScaleId: null, conversionType: CO_DEFAULTS.conversionType, conversionFactor: null, order: 1,
})

// Only ever true while *adding*. Editing an existing subjects doc keeps the
// plain subject form and keeps writing to subjects — moving an already-filed
// doc between collections is the migration script's job, not a side effect of
// an edit (scripts/migrate-co-scholastic-subjects.mjs).
const isCoScholasticForm = computed(() => !editingSubject.value && isCoScholasticArea(form.area))
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
    grade: '', name: '', id: '', goals: [], topics: [], area: '', name_original: '',
    termId: terms.value.length === 1 ? terms.value[0].id : null, ...CO_DEFAULTS, order: 1,
  })
  formError.value = ''
  dialogVisible.value = true
}

function openEditSubject(subject) {
  editingSubject.value = subject
  Object.assign(form, {
    grade: parseGrade(subject.id), name: subject.name || '', id: subject.id, goals: goalsFromDoc(subject),
    topics: topicsFromDoc(subject), area: subject.area || '', name_original: subject.name_original || '',
  })
  formError.value = ''
  dialogVisible.value = true
}

function addGoal() {
  form.goals.push({ goal: '', competencies: [''] })
}

// ── Topics + quiz ────────────────────────────────────────────────────────
// Legacy docs hold plain strings (or bare {topic} objects); the editor
// upgrades whatever it finds into the full { topic, description, quiz } shape
// the moment it's opened, so editing a legacy topic never loses its name.
function topicsFromDoc(doc) {
  return (doc.topics || []).map(t => {
    if (typeof t === 'string') return { topic: t, description: '', quiz: [] }
    return {
      topic: t.topic || '',
      description: t.description || '',
      quiz: (t.quiz || []).map(q => ({ question: q.question || '', options: [...(q.options || ['', ''])], correctIndex: q.correctIndex || 0 })),
    }
  })
}
function topicsToDoc(topics) {
  return topics
    .filter(t => t.topic.trim())
    .map(t => ({
      topic: t.topic.trim(),
      description: t.description.trim(),
      quiz: (t.quiz || [])
        .filter(q => q.question.trim() && q.options.filter(o => o.trim()).length >= 2)
        .map(q => {
          const options = q.options.map(o => o.trim()).filter(Boolean)
          // Re-anchor the correct answer to its new position if trimming
          // blank options shifted the list.
          const correctText = q.options[q.correctIndex]
          const correctIndex = options.indexOf((correctText || '').trim())
          return { question: q.question.trim(), options, correctIndex: correctIndex >= 0 ? correctIndex : 0 }
        }),
    }))
}

function addTopic() {
  form.topics.push({ topic: '', description: '', quiz: [] })
}
function addQuizQuestion(topic) {
  topic.quiz = topic.quiz || []
  topic.quiz.push({ question: '', options: ['', ''], correctIndex: 0 })
}
function removeQuizOption(q, oi) {
  q.options.splice(oi, 1)
  if (q.correctIndex >= q.options.length) q.correctIndex = q.options.length - 1
  else if (q.correctIndex > oi) q.correctIndex -= 1
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
  for (const topic of form.topics) {
    if (!topic.topic.trim()) continue
    for (const q of topic.quiz || []) {
      if (!q.question.trim()) continue
      const filled = q.options.filter(o => o.trim())
      if (filled.length < 2) return `"${topic.topic.trim()}": each quiz question needs at least 2 options`
      if (!q.options[q.correctIndex] || !q.options[q.correctIndex].trim()) return `"${topic.topic.trim()}": pick a non-empty correct answer`
    }
  }
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
      topics: topicsToDoc(form.topics),
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

// ── Backfill goals for existing subjects ─────────────────────────────────
// For subjects already sitting at 0 goals (imported before curricular_goals
// was auto-fetched, or added by hand and never filled in) — same
// grade+name match against other schools that "Copy from another school"
// does one subject at a time, but as one bulk pass over every 0-goal
// subject in this school.
const backfilling = ref(false)

async function backfillGoals() {
  if (!props.schoolId) return
  backfilling.value = true
  try {
    const goalsLibrary = await loadGoalsLibrary(props.schoolId)
    const candidates = subjects.value.filter(s => !(s.curricular_goals || []).length)
    const matches = candidates
      .map(s => ({ subject: s, goals: goalsLibrary.get(`${normalizeGrade(parseGrade(s.id))}|${(s.name || '').trim().toLowerCase()}`) }))
      .filter(m => m.goals && m.goals.length)

    if (!matches.length) {
      toast.add({ severity: 'info', summary: 'Nothing to backfill', detail: 'No matching goals found at other schools for subjects with 0 goals.', life: 3500 })
      return
    }

    const proceed = await new Promise(resolve => {
      confirm.require({
        message: `${matches.length} of ${candidates.length} subject(s) with 0 goals have a matching subject at another school. Copy those curricular goals in now?`,
        header: 'Backfill Curricular Goals', icon: 'pi pi-sparkles',
        rejectLabel: 'Cancel', acceptLabel: `Copy ${matches.length}`,
        accept: () => resolve(true), reject: () => resolve(false),
      })
    })
    if (!proceed) return

    for (let i = 0; i < matches.length; i += 450) {
      const chunk = matches.slice(i, i + 450)
      const batch = writeBatch(db)
      chunk.forEach(({ subject, goals }) => {
        batch.set(schoolDoc(props.schoolId, 'subjects', subject.id), {
          curricular_goals: goals.map(g => ({ ...g })),
          updated_at: serverTimestamp(),
          updated_by: auth.currentUser?.email || 'unknown',
        }, { merge: true })
      })
      await batch.commit()
    }

    toast.add({ severity: 'success', summary: 'Goals backfilled', detail: `${matches.length} subject(s) updated`, life: 3000 })
    await loadSubjects()
  } catch (e) {
    console.error('Backfill goals failed', e)
    toast.add({ severity: 'error', summary: 'Error', detail: 'Could not backfill goals. Check console.', life: 4000 })
  } finally {
    backfilling.value = false
  }
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
  const existingGrades = Array.from(new Set(subjects.value.map(s => parseGrade(s.id))))
  const g1 = existingGrades[0] || 'III'
  const g2 = existingGrades[1] || 'IV'
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
