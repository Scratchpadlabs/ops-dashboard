<template>
  <div class="pt-4">
    <div class="flex items-center justify-between mb-3">
      <div class="text-sm font-bold text-slate-900">Teachers</div>
      <div class="flex gap-2">
        <Button label="Import CSV" icon="pi pi-upload" size="small" outlined @click="importVisible = true" />
        <Button label="Sample CSV" icon="pi pi-download" size="small" text @click="downloadSample" />
        <Button label="Export CSV" icon="pi pi-file-export" size="small" text @click="exportCsv" />
        <Button label="Add Teacher" icon="pi pi-plus" size="small" @click="openAddTeacher" />
      </div>
    </div>

    <CsvImportDialog
      v-model:visible="importVisible"
      title="Import Teachers CSV"
      :column-keys="TEACHER_CSV_COLUMNS"
      :classify-row="classifyImportRow"
      :on-confirm="runImport"
    />

    <div v-if="loading" class="flex items-center justify-center py-10">
      <ProgressSpinner style="width:28px;height:28px" />
    </div>
    <div v-else class="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <DataTable :value="staffs" size="small" stripedRows>
        <Column field="name" header="Name">
          <template #body="{ data }">
            <div class="font-medium text-sm text-slate-900">{{ data.name || data.id }}</div>
            <div class="text-xs text-slate-400 font-mono">{{ data.id }}</div>
          </template>
        </Column>
        <Column field="email" header="Email" />
        <Column field="phoneNo" header="Phone" style="width:120px" />
        <Column field="type" header="Type" style="width:100px" />
        <Column header="Classes" style="width:90px">
          <template #body="{ data }"><span class="text-xs text-slate-500">{{ (data.classIds || []).length }}</span></template>
        </Column>
        <Column header="Assignments" style="width:110px">
          <template #body="{ data }"><span class="text-xs text-slate-500">{{ Object.keys(data.assignments || {}).length }}</span></template>
        </Column>
        <Column header="" style="width:70px">
          <template #body="{ data }">
            <Button icon="pi pi-pencil" text rounded size="small" @click="openEditTeacher(data)" />
          </template>
        </Column>
      </DataTable>
      <ConfigEmptyState v-if="!staffs.length" label="Teachers" collection="staffs" />
    </div>

    <!-- ── Add/Edit Teacher Dialog ──────────────────────────────────────── -->
    <Dialog v-model:visible="dialogVisible" :header="editingStaff ? `Edit ${editingStaff.id}` : 'Add Teacher'" modal :style="{ width: '680px' }">
      <div class="space-y-4 pt-2">
        <div class="grid grid-cols-2 gap-4">
          <div>
            <label class="form-label">Name *</label>
            <InputText v-model="form.name" class="w-full" placeholder="e.g. Asha Kulkarni" />
          </div>
          <div>
            <label class="form-label">Doc ID *</label>
            <InputText v-model="form.id" class="w-full font-mono text-sm" :disabled="!!editingStaff" />
            <p class="text-xs text-slate-400 mt-1">Auto-slugged from name — editable until first save, locked after.</p>
          </div>
          <div>
            <label class="form-label">Email</label>
            <InputText v-model="form.email" class="w-full" placeholder="name@school.org" />
          </div>
          <div>
            <label class="form-label">Phone</label>
            <InputNumber v-model="form.phoneNo" class="w-full" :useGrouping="false" />
          </div>
          <div>
            <label class="form-label">Sex</label>
            <Select v-model="form.sex" :options="SEX_OPTIONS" placeholder="Not set" showClear editable class="w-full" />
          </div>
          <div>
            <label class="form-label">Type</label>
            <Select v-model="form.type" :options="TYPE_OPTIONS" editable class="w-full" />
          </div>
        </div>

        <div>
          <label class="form-label mb-2 block">Classes &amp; Subjects</label>
          <MultiSelect v-model="selectedClassIds" :options="classes" optionLabel="id" optionValue="id" placeholder="Select classes" filter display="chip" class="w-full" />
          <div v-if="selectedClassIds.length" class="mt-3 space-y-3">
            <div v-for="classId in selectedClassIds" :key="classId" class="border border-slate-200 rounded-lg p-3">
              <div class="text-xs font-semibold text-slate-600 mb-1.5">{{ classId }}</div>
              <div v-if="subjectsForClass(classId).length" class="grid grid-cols-2 gap-1">
                <label v-for="subjId in subjectsForClass(classId)" :key="subjId" class="flex items-center gap-2 text-sm">
                  <Checkbox v-model="assignmentsState[classId]" :value="subjId" />
                  <span>{{ subjId }}</span>
                </label>
              </div>
              <p v-else class="text-xs text-slate-400">This class has no subjects assigned yet — kept as class-level access only.</p>
            </div>
          </div>
        </div>

        <div v-if="formError" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{{ formError }}</div>
      </div>
      <template #footer>
        <Button label="Cancel" text @click="dialogVisible = false" />
        <Button :label="editingStaff ? 'Save Changes' : 'Add Teacher'" :loading="saving" @click="saveTeacher" />
      </template>
    </Dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted } from 'vue'
import { getDocs, query, orderBy, serverTimestamp, writeBatch } from 'firebase/firestore'
import { useToast } from 'primevue/usetoast'

import Button from 'primevue/button'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import InputNumber from 'primevue/inputnumber'
import Select from 'primevue/select'
import MultiSelect from 'primevue/multiselect'
import Checkbox from 'primevue/checkbox'
import ProgressSpinner from 'primevue/progressspinner'
import CsvImportDialog from './CsvImportDialog.vue'
import ConfigEmptyState from './ConfigEmptyState.vue'

import { schoolCollection, schoolDoc } from '../../firebase/schoolCollections.js'
import { guardedSetDoc, guardedUpdateDoc, guardedBatchSet, SchemaViolation } from '../../schemas/guardedWrite.js'
import { db, auth } from '../../firebase/config'
import { toCsv, downloadCsv } from '../../utils/csv.js'
import { splitName } from '../../schemas/studentMapping.js'

const props = defineProps({ schoolId: { type: String, default: null } })
const toast = useToast()

const staffs = ref([])
const classes = ref([])
const loading = ref(false)

const SEX_OPTIONS = ['Male', 'Female', 'Other']
const TYPE_OPTIONS = ['teacher', 'admin', 'principal']

async function loadAll() {
  if (!props.schoolId) { staffs.value = []; classes.value = []; return }
  loading.value = true
  try {
    const [stSnap, cSnap] = await Promise.all([
      getDocs(query(schoolCollection(props.schoolId, 'staffs'), orderBy('name'))),
      getDocs(schoolCollection(props.schoolId, 'classes')),
    ])
    staffs.value = stSnap.docs.map(d => ({ id: d.id, ...d.data() }))
    classes.value = cSnap.docs.map(d => ({ id: d.id, ...d.data() }))
  } catch (e) {
    console.error('Could not load staffs/classes', e)
    staffs.value = []
    classes.value = []
  } finally {
    loading.value = false
  }
}

function subjectsForClass(classId) {
  const cls = classes.value.find(c => c.id === classId)
  return (cls?.subjects || []).map(s => s.subjectId)
}

// ── Add/Edit form ────────────────────────────────────────────────────────
const dialogVisible = ref(false)
const editingStaff = ref(null)
const saving = ref(false)
const formError = ref('')
const form = reactive({ name: '', id: '', email: '', phoneNo: null, sex: '', type: 'teacher' })
// Per-teacher class -> [subjectId, ...]. A class present here with an empty
// array is still class-level access (kept in classIds) — same invariant as
// "a class with no subjects still grants access" elsewhere in this codebase.
const selectedClassIds = ref([])
const assignmentsState = reactive({})

function slugifyName(name) {
  return (name || '').trim().replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '')
}

watch(() => form.name, name => {
  if (editingStaff.value) return
  form.id = slugifyName(name)
})

// Keep assignmentsState's keys in sync with the class MultiSelect — this is
// the ONLY editor for a teacher's assignments, so saving reconciles fully:
// a class removed here is removed from both `assignments` and `classIds`.
watch(selectedClassIds, next => {
  next.forEach(id => { if (!(id in assignmentsState)) assignmentsState[id] = [] })
  Object.keys(assignmentsState).forEach(id => { if (!next.includes(id)) delete assignmentsState[id] })
})

function openAddTeacher() {
  editingStaff.value = null
  Object.assign(form, { name: '', id: '', email: '', phoneNo: null, sex: '', type: 'teacher' })
  selectedClassIds.value = []
  Object.keys(assignmentsState).forEach(k => delete assignmentsState[k])
  formError.value = ''
  dialogVisible.value = true
}

function openEditTeacher(staff) {
  editingStaff.value = staff
  Object.assign(form, {
    name: staff.name || '', id: staff.id, email: staff.email || '',
    phoneNo: staff.phoneNo ?? null, sex: staff.sex || '', type: staff.type || 'teacher',
  })
  Object.keys(assignmentsState).forEach(k => delete assignmentsState[k])
  selectedClassIds.value = [...(staff.classIds || [])]
  selectedClassIds.value.forEach(classId => {
    assignmentsState[classId] = [...(staff.assignments?.[classId] || [])]
  })
  formError.value = ''
  dialogVisible.value = true
}

function validateTeacher() {
  if (!form.name.trim()) return 'Name is required'
  if (!form.id.trim()) return 'Doc ID is required'
  if (!editingStaff.value && staffs.value.some(s => s.id === form.id.trim())) return 'A staff record with this ID already exists'
  return ''
}

function buildAssignments() {
  const assignments = {}
  selectedClassIds.value.forEach(classId => {
    const subs = assignmentsState[classId] || []
    if (subs.length) assignments[classId] = [...subs]
  })
  return assignments
}

async function saveTeacher() {
  formError.value = validateTeacher()
  if (formError.value) return
  saving.value = true
  try {
    const { firstName, lastName } = splitName(form.name)
    const payload = {
      name: form.name.trim(), firstName, lastName,
      email: form.email.trim(), phoneNo: form.phoneNo,
      sex: form.sex || '', type: (form.type || 'teacher').trim(),
      classIds: [...selectedClassIds.value],
      assignments: buildAssignments(),
      updated_at: serverTimestamp(), updated_by: auth.currentUser?.email || 'unknown',
    }
    if (editingStaff.value) {
      await guardedUpdateDoc('staffs', schoolDoc(props.schoolId, 'staffs', editingStaff.value.id), payload)
    } else {
      payload.id = form.id.trim()
      payload.staffId = form.id.trim()
      payload.needsAuthCreation = true
      payload.authUid = null
      payload.created_at = serverTimestamp()
      payload.created_by = auth.currentUser?.email || 'unknown'
      await guardedSetDoc('staffs', schoolDoc(props.schoolId, 'staffs', form.id.trim()), payload, { merge: false })
    }
    dialogVisible.value = false
    toast.add({ severity: 'success', summary: 'Saved', life: 2000 })
    await loadAll()
  } catch (e) {
    formError.value = e instanceof SchemaViolation ? e.userMessage : 'Something went wrong. Try again.'
  } finally {
    saving.value = false
  }
}

// ── CSV import/export ────────────────────────────────────────────────────
// Identity fields + classIds (class-level access) only — `assignments` (the
// nested per-class-subject map) doesn't flatten into a row, same precedent
// as SubjectsTab excluding curricular_goals from its CSV. Per-class-subject
// assignment stays a UI-only concern, edited via the dialog above.
// classIds from a CSV row are ADDED to whatever a teacher already has, never
// used to strip existing access — the same additive convention every other
// classIds/assignments writer in this codebase already follows.
const TEACHER_CSV_COLUMNS = ['name', 'id', 'email', 'phoneNo', 'sex', 'type', 'classIds']
const importVisible = ref(false)

async function classifyImportRow(raw) {
  const name = (raw.name || '').trim()
  if (!name) return { raw, _status: 'ERROR', _reason: 'Missing name' }
  const id = (raw.id || '').trim() || slugifyName(name)
  if (!id) return { raw, _status: 'ERROR', _reason: 'Could not derive a doc ID from name' }

  const classIdsRaw = (raw.classIds || '').trim()
  const classIds = classIdsRaw ? classIdsRaw.split(';').map(s => s.trim()).filter(Boolean) : []
  const unknown = classIds.filter(cid => !classes.value.some(c => c.id === cid))
  if (unknown.length) return { raw, _status: 'ERROR', _reason: `Unknown class id(s): ${unknown.join(', ')}` }

  const { firstName, lastName } = splitName(name)
  const phoneRaw = (raw.phoneNo ?? '').toString().trim()
  const existing = staffs.value.find(s => s.id === id)
  const payload = {
    name, firstName, lastName,
    email: (raw.email || '').trim(),
    phoneNo: phoneRaw ? Number(phoneRaw) : null,
    sex: (raw.sex || '').trim(),
    type: (raw.type || '').trim() || 'teacher',
    classIds,
  }
  return { raw, id, _status: existing ? 'UPDATE' : 'CREATE', payload }
}

async function runImport(validRows) {
  const batch = writeBatch(db)
  for (const r of validRows) {
    const existing = staffs.value.find(s => s.id === r.id)
    const mergedClassIds = Array.from(new Set([...(existing?.classIds || []), ...r.payload.classIds]))
    const payload = {
      ...r.payload, classIds: mergedClassIds,
      updated_at: serverTimestamp(), updated_by: auth.currentUser?.email || 'unknown',
    }
    if (r._status === 'CREATE') {
      payload.id = r.id
      payload.staffId = r.id
      payload.needsAuthCreation = true
      payload.authUid = null
      payload.created_at = serverTimestamp()
      payload.created_by = auth.currentUser?.email || 'unknown'
    }
    guardedBatchSet(batch, 'staffs', schoolDoc(props.schoolId, 'staffs', r.id), payload, { merge: true })
  }
  await batch.commit()
  toast.add({ severity: 'success', summary: 'Imported', detail: `${validRows.length} staff record(s)`, life: 3000 })
  await loadAll()
  return true
}

function downloadSample() {
  const sample = [
    { name: 'Asha Kulkarni', id: '', email: 'asha.kulkarni@example.com', phoneNo: '9876543210', sex: 'Female', type: 'teacher', classIds: '' },
    { name: 'Rohit Sharma', id: '', email: 'rohit.sharma@example.com', phoneNo: '9876500000', sex: 'Male', type: 'teacher', classIds: '' },
  ]
  downloadCsv('teachers_sample.csv', toCsv(sample, TEACHER_CSV_COLUMNS))
}

function exportCsv() {
  const rows = staffs.value.map(s => ({
    name: s.name || '', id: s.id, email: s.email || '', phoneNo: s.phoneNo ?? '',
    sex: s.sex || '', type: s.type || '', classIds: (s.classIds || []).join(';'),
  }))
  downloadCsv(`teachers_${props.schoolId}.csv`, toCsv(rows, TEACHER_CSV_COLUMNS))
}

watch(() => props.schoolId, loadAll)
onMounted(loadAll)
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
