<template>
  <div class="pt-4">
    <div class="flex items-center justify-between mb-3">
      <div class="text-sm font-bold text-slate-900">Classes &amp; Teachers</div>
      <Button label="Add Section" icon="pi pi-plus" size="small" @click="openAddSection" />
    </div>

    <div v-if="loading" class="flex items-center justify-center py-10">
      <ProgressSpinner style="width:28px;height:28px" />
    </div>
    <div v-else class="bg-white rounded-xl border border-slate-200 overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-slate-200">
            <th class="text-left px-3 py-2 text-xs font-semibold text-slate-400 uppercase">Grade</th>
            <th v-for="sec in allSections" :key="sec" class="text-left px-3 py-2 text-xs font-semibold text-slate-400 uppercase">{{ sec }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="grade in allGrades" :key="grade" class="border-b border-slate-100">
            <td class="px-3 py-2 font-medium text-slate-700">{{ grade }}</td>
            <td v-for="sec in allSections" :key="sec" class="px-3 py-2">
              <button
                v-if="classByGradeSection(grade, sec)"
                type="button"
                class="px-2.5 py-1 rounded-full text-xs font-semibold"
                :class="classByGradeSection(grade, sec).isActive !== false ? 'bg-blue-50 text-blue-700 hover:bg-blue-100' : 'bg-slate-100 text-slate-400 hover:bg-slate-200'"
                @click="openSectionEditor(classByGradeSection(grade, sec))"
              >{{ grade }}_{{ sec }}</button>
              <button v-else type="button" class="text-xs text-slate-300 hover:text-violet-600" @click="openAddSection(grade, sec)">+ add</button>
            </td>
          </tr>
        </tbody>
      </table>
      <ConfigEmptyState v-if="!classes.length" label="Classes" collection="classes" />
    </div>

    <!-- ── Section Editor Dialog ────────────────────────────────────────── -->
    <Dialog v-model:visible="sectionDialogVisible" :header="editingClass ? `Edit ${editingClass.id}` : 'Add Section'" modal :style="{ width: '680px' }">
      <div class="space-y-4 pt-2">
        <div class="grid grid-cols-3 gap-4">
          <div>
            <label class="form-label">Grade (clazz) *</label>
            <KbClassifiedInput
              v-model="form.clazz"
              :expect="GRADE"
              context="a grade/class in School Setup"
              :allowed-types="[GRADE, OTHER]"
              placeholder="e.g. III"
              :disabled="!!editingClass"
            />
          </div>
          <div>
            <label class="form-label">Section *</label>
            <KbClassifiedInput
              v-model="form.section"
              :expect="SECTION"
              context="a section name in School Setup"
              :allowed-types="[SECTION, OTHER]"
              placeholder="e.g. A, Rose, Champion"
              :disabled="!!editingClass"
            />
          </div>
          <div>
            <label class="form-label">Stage *</label>
            <Select v-model="form.stage" :options="stageOptions" optionLabel="label" optionValue="value" class="w-full" />
          </div>
        </div>
        <div>
          <label class="form-label">Name</label>
          <InputText v-model="form.name" class="w-full" placeholder="e.g. III A" />
        </div>
        <div class="flex items-center gap-2">
          <label class="form-label mb-0">Active</label>
          <ToggleButton v-model="form.isActive" onLabel="Yes" offLabel="No" size="small" />
        </div>

        <div v-if="!editingClass && siblingSections.length">
          <label class="form-label">Clone subject list from sibling section</label>
          <Select v-model="cloneFromClassId" :options="siblingSections" optionLabel="id" optionValue="id" placeholder="None (start empty)" class="w-full" showClear @update:modelValue="applyCloneSubjects" />
        </div>

        <div>
          <div class="flex items-center justify-between mb-2">
            <label class="form-label mb-0">Subjects</label>
          </div>
          <div class="grid grid-cols-2 gap-1 max-h-64 overflow-auto border border-slate-200 rounded-lg p-2">
            <label v-for="subj in allSubjects" :key="subj.id" class="flex items-center gap-2 text-sm px-1 py-0.5">
              <Checkbox v-model="form.subjectIds" :value="subj.id" />
              <span :class="parseGrade(subj.id) === form.clazz ? 'text-slate-800' : 'text-slate-500'">{{ subj.id }}</span>
            </label>
          </div>
          <p class="text-xs text-slate-400 mt-1">Grade-matching subjects are pre-checked when adding a new section; any subject can be attached.</p>
        </div>

        <div v-if="formError" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{{ formError }}</div>
      </div>
      <template #footer>
        <Button v-if="editingClass" label="Teacher Assignments" text @click="openTeacherMatrix(editingClass)" />
        <Button v-if="editingClass" label="Deactivate Section" text severity="danger" @click="deactivateSection" />
        <Button label="Cancel" text @click="sectionDialogVisible = false" />
        <Button :label="editingClass ? 'Save Changes' : 'Add Section'" :loading="saving" @click="saveSection" />
      </template>
    </Dialog>

    <!-- ── Teacher Assignment Matrix ─────────────────────────────────────── -->
    <Dialog v-model:visible="teacherMatrixVisible" :header="`Teacher Assignments — ${activeClassForMatrix?.id || ''}`" modal :style="{ width: '640px' }">
      <div class="pt-2">
        <div v-if="matrixSubjects.length === 0" class="text-sm text-slate-400 py-6 text-center">This class has no subjects assigned yet.</div>
        <table v-else class="w-full text-sm">
          <thead>
            <tr class="border-b border-slate-200">
              <th class="text-left px-2 py-2 text-xs font-semibold text-slate-400 uppercase">Teacher</th>
              <th v-for="subjId in matrixSubjects" :key="subjId" class="text-center px-2 py-2 text-xs font-semibold text-slate-400 uppercase">{{ subjId }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="staff in teachers" :key="staff.id" class="border-b border-slate-100">
              <td class="px-2 py-2 text-slate-700">{{ staff.name || staff.id }}</td>
              <td v-for="subjId in matrixSubjects" :key="subjId" class="text-center px-2 py-2">
                <Checkbox v-model="matrixState[staff.id]" :value="subjId" />
              </td>
            </tr>
          </tbody>
        </table>
        <div v-if="!teachers.length" class="text-sm text-slate-400 py-4 text-center">No teacher staff records for this school.</div>
        <div v-if="matrixError" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2 mt-3">{{ matrixError }}</div>
      </div>
      <template #footer>
        <Button label="Cancel" text @click="teacherMatrixVisible = false" />
        <Button label="Save Assignments" :loading="savingMatrix" @click="saveTeacherMatrix" />
      </template>
    </Dialog>

    <ConfirmDialog />
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted } from 'vue'
import { getDocs, setDoc, updateDoc, query, orderBy, serverTimestamp } from 'firebase/firestore'
import { useConfirm } from 'primevue/useconfirm'
import { useToast } from 'primevue/usetoast'

import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import Select from 'primevue/select'
import ToggleButton from 'primevue/togglebutton'
import Checkbox from 'primevue/checkbox'
import ProgressSpinner from 'primevue/progressspinner'
import ConfirmDialog from 'primevue/confirmdialog'

import { schoolCollection, schoolDoc } from '../../firebase/schoolCollections.js'
import ConfigEmptyState from './ConfigEmptyState.vue'
import { auth } from '../../firebase/config'
import { regenerateStudentsSchemaClassOptions } from '../../utils/schoolSetupHelpers.js'
import KbClassifiedInput from '../shared/KbClassifiedInput.vue'
import { useEducationKB } from '../../composables/useEducationKB.js'
import { GRADE, SECTION, OTHER } from '../../utils/educationKB.js'

const props = defineProps({ schoolId: { type: String, default: null } })
const confirm = useConfirm()
const toast = useToast()
const { loadKB } = useEducationKB()

const stageOptions = [
  { label: 'Foundation', value: 'foundation' },
  { label: 'Preparatory (sic — matches existing data)', value: 'prepratory' },
  { label: 'Middle', value: 'middle' },
  { label: 'Secondary', value: 'secondary' },
]

const classes = ref([])
const subjects = ref([])
const staffs = ref([])
const loading = ref(false)

function parseGrade(id) {
  return (id || '').split('_')[0] || '?'
}

const allSubjects = computed(() => [...subjects.value].sort((a, b) => a.id.localeCompare(b.id)))
const teachers = computed(() => staffs.value.filter(s => s.type === 'teacher'))

const allGrades = computed(() => Array.from(new Set(classes.value.map(c => c.clazz))).sort())
const allSections = computed(() => Array.from(new Set(classes.value.map(c => c.section))).sort())

function classByGradeSection(grade, section) {
  return classes.value.find(c => c.clazz === grade && c.section === section) || null
}

async function loadAll() {
  if (!props.schoolId) { classes.value = []; subjects.value = []; staffs.value = []; return }
  loading.value = true
  try {
    const [cSnap, sSnap, stSnap] = await Promise.all([
      getDocs(query(schoolCollection(props.schoolId, 'classes'), orderBy('clazz'))),
      getDocs(query(schoolCollection(props.schoolId, 'subjects'), orderBy('name'))),
      getDocs(schoolCollection(props.schoolId, 'staffs')),
    ])
    classes.value = cSnap.docs.map(d => ({ id: d.id, ...d.data() }))
    subjects.value = sSnap.docs.map(d => ({ id: d.id, ...d.data() }))
    staffs.value = stSnap.docs.map(d => ({ id: d.id, ...d.data() }))
  } catch (e) {
    console.error('Could not load classes/subjects/staffs', e)
  } finally {
    loading.value = false
  }
}

// ── Section editor ──────────────────────────────────────────────────────
const sectionDialogVisible = ref(false)
const editingClass = ref(null)
const saving = ref(false)
const formError = ref('')
const cloneFromClassId = ref(null)
const form = reactive({ clazz: '', section: '', stage: 'foundation', name: '', isActive: true, subjectIds: [] })

const siblingSections = computed(() =>
  classes.value.filter(c => c.clazz === form.clazz && c.id !== editingClass.value?.id)
)

function openAddSection(grade, section) {
  editingClass.value = null
  cloneFromClassId.value = null
  const clazz = grade || ''
  Object.assign(form, {
    clazz, section: section || '', stage: 'foundation', name: '', isActive: true,
    subjectIds: subjects.value.filter(s => parseGrade(s.id) === clazz).map(s => s.id),
  })
  formError.value = ''
  sectionDialogVisible.value = true
}

function openSectionEditor(cls) {
  editingClass.value = cls
  cloneFromClassId.value = null
  Object.assign(form, {
    clazz: cls.clazz, section: cls.section, stage: cls.stage || 'foundation',
    name: cls.name || `${cls.clazz} ${cls.section}`, isActive: cls.isActive !== false,
    subjectIds: (cls.subjects || []).map(s => s.subjectId),
  })
  formError.value = ''
  sectionDialogVisible.value = true
}

function applyCloneSubjects(sourceId) {
  const src = classes.value.find(c => c.id === sourceId)
  if (src) form.subjectIds = (src.subjects || []).map(s => s.subjectId)
}

function validateSection() {
  if (!form.clazz.trim()) return 'Grade is required'
  if (!form.section.trim()) return 'Section is required'
  if (!editingClass.value && classes.value.some(c => c.clazz === form.clazz.trim() && c.section === form.section.trim())) {
    return 'This grade/section already exists'
  }
  return ''
}

// Fixed per-subject topic template — {subjectId}_Term1|Term2|Optional.
// NOTE: inferred from the spec's description, not verified against a live
// class doc — double-check against a real school (e.g. SAMARTH) before
// relying on this for anything beyond TEST_SCHOOL.
function defaultTopicsForSubject(subjectId) {
  return [
    { id: `${subjectId}_Term1`, topic: 'Term 1', isCompleted: false, completedAt: null },
    { id: `${subjectId}_Term2`, topic: 'Term 2', isCompleted: false, completedAt: null },
    { id: `${subjectId}_Optional`, topic: 'Optional', isCompleted: false, completedAt: null },
  ]
}

// CRITICAL: merge, never clobber — preserve isCompleted/completedAt/topics
// for subjects that were already assigned.
function regenerateSubjectsArray(existingSubjects, checkedSubjectIds) {
  const existingBydId = new Map((existingSubjects || []).map(s => [s.subjectId, s]))
  return checkedSubjectIds.map(subjectId => {
    const existing = existingBydId.get(subjectId)
    if (existing) return existing
    return { subjectId, teacherId: '', isCompleted: false, completedAt: null, topics: defaultTopicsForSubject(subjectId) }
  })
}

async function saveSection() {
  formError.value = validateSection()
  if (formError.value) return
  saving.value = true
  try {
    const classId = editingClass.value ? editingClass.value.id : `${form.clazz.trim()}_${form.section.trim()}`
    const existingSubjects = editingClass.value ? (editingClass.value.subjects || []) : []
    const payload = {
      clazz: form.clazz.trim(),
      section: form.section.trim(),
      stage: form.stage,
      name: form.name.trim() || `${form.clazz.trim()} ${form.section.trim()}`,
      isActive: form.isActive,
      subjects: regenerateSubjectsArray(existingSubjects, form.subjectIds),
      updated_at: serverTimestamp(),
      updated_by: auth.currentUser?.email || 'unknown',
    }
    if (!editingClass.value) {
      payload.id = classId
      payload.created_at = serverTimestamp()
      payload.created_by = auth.currentUser?.email || 'unknown'
    }
    await setDoc(schoolDoc(props.schoolId, 'classes', classId), payload, { merge: true })
    sectionDialogVisible.value = false
    toast.add({ severity: 'success', summary: 'Saved', life: 2000 })
    await loadAll()
    await regenerateStudentsSchemaClassOptions(props.schoolId, classes.value.map(c => c.id))
  } catch (e) {
    console.error(e)
    formError.value = 'Something went wrong. Try again.'
  } finally {
    saving.value = false
  }
}

function deactivateSection() {
  if (!editingClass.value) return
  confirm.require({
    message: `Deactivate "${editingClass.value.id}"? It will be hidden from active use but not deleted.`,
    header: 'Deactivate Section',
    icon: 'pi pi-exclamation-triangle',
    rejectLabel: 'Cancel', acceptLabel: 'Deactivate', acceptClass: 'p-button-danger',
    accept: async () => {
      try {
        await updateDoc(schoolDoc(props.schoolId, 'classes', editingClass.value.id), {
          isActive: false, updated_at: serverTimestamp(), updated_by: auth.currentUser?.email || 'unknown',
        })
        sectionDialogVisible.value = false
        toast.add({ severity: 'info', summary: 'Deactivated', life: 2000 })
        await loadAll()
      } catch (e) {
        toast.add({ severity: 'error', summary: 'Error', detail: 'Could not deactivate', life: 3000 })
      }
    },
  })
}

// ── Teacher assignment matrix ───────────────────────────────────────────
// CRITICAL: writes to staffs.assignments/classIds ONLY — never to
// classes.subjects[].teacherId.
const teacherMatrixVisible = ref(false)
const activeClassForMatrix = ref(null)
const matrixState = reactive({})
const matrixError = ref('')
const savingMatrix = ref(false)

const matrixSubjects = computed(() => (activeClassForMatrix.value?.subjects || []).map(s => s.subjectId))

function openTeacherMatrix(cls) {
  activeClassForMatrix.value = cls
  matrixError.value = ''
  Object.keys(matrixState).forEach(k => delete matrixState[k])
  teachers.value.forEach(staff => {
    matrixState[staff.id] = [...(staff.assignments?.[cls.id] || [])]
  })
  teacherMatrixVisible.value = true
}

async function saveTeacherMatrix() {
  if (!activeClassForMatrix.value) return
  savingMatrix.value = true
  matrixError.value = ''
  try {
    const classId = activeClassForMatrix.value.id
    await Promise.all(teachers.value.map(async staff => {
      const newSubjectIds = matrixState[staff.id] || []
      const assignments = { ...(staff.assignments || {}) }
      if (newSubjectIds.length) {
        assignments[classId] = newSubjectIds
      } else {
        delete assignments[classId]
      }
      // classIds: union with assignment keys — only ever adds, never strips
      // manually-granted class-level access this matrix doesn't know about.
      const classIds = new Set(staff.classIds || [])
      if (newSubjectIds.length) classIds.add(classId)
      await updateDoc(schoolDoc(props.schoolId, 'staffs', staff.id), {
        assignments, classIds: Array.from(classIds),
        updated_at: serverTimestamp(), updated_by: auth.currentUser?.email || 'unknown',
      })
    }))
    teacherMatrixVisible.value = false
    toast.add({ severity: 'success', summary: 'Assignments saved', life: 2000 })
    await loadAll()
  } catch (e) {
    console.error(e)
    matrixError.value = 'Something went wrong. Try again.'
  } finally {
    savingMatrix.value = false
  }
}

watch(() => props.schoolId, loadAll)
onMounted(() => { loadAll(); loadKB() })
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
