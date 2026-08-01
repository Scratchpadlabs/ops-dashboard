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
                  :class="data.area === 'Co-Scholastic' ? 'bg-violet-100 text-violet-700' : 'bg-blue-50 text-blue-700'"
                >{{ data.area }}</span>
                <span v-else class="text-xs text-slate-300" v-tooltip="'Not classified — open the subject and let the knowledge base categorize it'">—</span>
              </template>
            </Column>
            <Column field="curricular_goals" header="Goals" style="width:100px">
              <template #body="{ data }"><span class="text-xs text-slate-400">{{ (data.curricular_goals || []).length }}</span></template>
            </Column>
            <Column header="" style="width:80px">
              <template #body="{ data }">
                <Button icon="pi pi-pencil" text rounded size="small" @click="openEditSubject(data)" />
              </template>
            </Column>
          </DataTable>
        </div>
      </div>
      <div v-if="!subjects.length" class="text-center text-sm text-slate-400 py-10 bg-white rounded-xl border border-slate-200">No subjects yet</div>
    </div>

    <!-- ── Add/Edit Subject Dialog ──────────────────────────────────────── -->
    <Dialog v-model:visible="dialogVisible" :header="editingSubject ? 'Edit Subject' : 'Add Subject'" modal :style="{ width: '640px' }">
      <div class="space-y-4 pt-2">
        <div class="grid grid-cols-2 gap-4">
          <div>
            <label class="form-label">Grade *</label>
            <InputText v-model="form.grade" class="w-full" placeholder="e.g. III" :disabled="!!editingSubject" />
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
          <label class="form-label">Doc ID</label>
          <InputText v-model="form.id" class="w-full font-mono text-sm" :disabled="!!editingSubject" />
          <p class="text-xs text-slate-400 mt-1">Auto-slugged from grade + name — editable until first save, locked after.</p>
        </div>

        <div>
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
        <Button label="Cancel" text @click="dialogVisible = false" />
        <Button :label="editingSubject ? 'Save Changes' : 'Add Subject'" :loading="saving" @click="saveSubject" />
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
import { useToast } from 'primevue/usetoast'

import Button from 'primevue/button'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import Select from 'primevue/select'
import ProgressSpinner from 'primevue/progressspinner'
import ConfirmDialog from 'primevue/confirmdialog'
import CsvImportDialog from './CsvImportDialog.vue'
import KbClassifiedInput from '../shared/KbClassifiedInput.vue'

import { schoolCollection, schoolDoc, rootSchoolsCollection } from '../../firebase/schoolCollections.js'
import { db, auth } from '../../firebase/config'
import { toCsv, downloadCsv } from '../../utils/csv.js'
import { useEducationKB } from '../../composables/useEducationKB.js'
import { SUBJECT, COSCHOLASTIC, classify as classifyValue } from '../../utils/educationKB.js'

const props = defineProps({ schoolId: { type: String, default: null } })
const toast = useToast()

const subjects = ref([])
const loading = ref(false)

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
const form = reactive({ grade: '', name: '', id: '', goals: [], area: '', name_original: '' })

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

watch([() => form.grade, () => form.name], () => {
  if (!editingSubject.value) form.id = slugify(form.grade || '', form.name || '')
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
  Object.assign(form, { grade: '', name: '', id: '', goals: [], area: '', name_original: '' })
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
  if (!form.grade.trim()) return 'Grade is required'
  if (!form.name.trim()) return 'Name is required'
  if (!form.id.trim()) return 'Doc ID is required'
  if (!editingSubject.value && subjects.value.some(s => s.id === form.id.trim())) return 'A subject with this ID already exists'
  return ''
}

async function saveSubject() {
  formError.value = validateSubject()
  if (formError.value) return
  saving.value = true
  try {
    const payload = {
      name: form.name.trim(),
      area: form.area || areaFor(form.name),
      name_original: form.name_original || '',
      curricular_goals: goalsToDoc(form.goals),
      updated_at: serverTimestamp(),
      updated_by: auth.currentUser?.email || 'unknown',
    }
    if (editingSubject.value) {
      await updateDoc(schoolDoc(props.schoolId, 'subjects', editingSubject.value.id), payload)
    } else {
      payload.id = form.id.trim()
      payload.created_at = serverTimestamp()
      payload.created_by = auth.currentUser?.email || 'unknown'
      await setDoc(schoolDoc(props.schoolId, 'subjects', form.id.trim()), payload)
    }
    dialogVisible.value = false
    toast.add({ severity: 'success', summary: 'Saved', life: 2000 })
    await loadSubjects()
  } catch (e) {
    formError.value = 'Something went wrong. Try again.'
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

// ── CSV import/export ────────────────────────────────────────────────────
// Curricular goals aren't included — they're a nested goal→competencies
// structure that doesn't flatten cleanly into a row; use the goals editor
// (or "copy from" actions) for those. CSV covers grade/name/id only.
const SUBJECT_CSV_COLUMNS = ['grade', 'name', 'id']
const importVisible = ref(false)

async function classifyImportRow(raw) {
  const grade = (raw.grade || '').trim()
  const name = (raw.name || '').trim()
  if (!grade) return { raw, _status: 'ERROR', _reason: 'Missing grade' }
  if (!name) return { raw, _status: 'ERROR', _reason: 'Missing name' }
  const id = (raw.id || '').trim() || slugify(grade, name)
  const existing = subjects.value.find(s => s.id === id)
  return { raw, id, _status: existing ? 'UPDATE' : 'CREATE', payload: { name, area: areaFor(name) } }
}

async function runImport(validRows) {
  for (let i = 0; i < validRows.length; i += 450) {
    const chunk = validRows.slice(i, i + 450)
    const batch = writeBatch(db)
    chunk.forEach(r => {
      const payload = { ...r.payload, updated_at: serverTimestamp(), updated_by: auth.currentUser?.email || 'unknown' }
      if (r._status === 'CREATE') { payload.id = r.id; payload.created_at = serverTimestamp(); payload.created_by = auth.currentUser?.email || 'unknown' }
      batch.set(schoolDoc(props.schoolId, 'subjects', r.id), payload, { merge: true })
    })
    await batch.commit()
  }
  toast.add({ severity: 'success', summary: 'Imported', detail: `${validRows.length} row(s)`, life: 2500 })
  await loadSubjects()
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
  const sample = [
    { grade: g1, name: 'English', id: '' },
    { grade: g1, name: 'Maths', id: '' },
    { grade: g2, name: 'Science', id: '' },
  ]
  downloadCsv('subjects_sample.csv', toCsv(sample, SUBJECT_CSV_COLUMNS))
}
function exportCsv() {
  const rows = subjects.value.map(s => ({ grade: parseGrade(s.id), name: s.name, id: s.id }))
  downloadCsv(`subjects_${props.schoolId}.csv`, toCsv(rows, SUBJECT_CSV_COLUMNS))
}

watch(() => props.schoolId, loadSubjects)
onMounted(() => { loadSubjects(); loadOtherSchools(); loadKB() })
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
