<template>
  <div class="pt-4">
    <div class="flex items-center justify-between mb-3">
      <div class="text-sm font-bold text-slate-900">Students</div>
      <div class="flex gap-2">
        <Button label="Import CSV" icon="pi pi-upload" size="small" outlined @click="importVisible = true" />
        <Button label="Sample CSV" icon="pi pi-download" size="small" text @click="downloadSample" />
        <Button label="Export CSV" icon="pi pi-file-export" size="small" text @click="exportCsv" />
        <Button label="Add Student" icon="pi pi-plus" size="small" @click="openAddStudent" />
      </div>
    </div>

    <CsvImportDialog
      v-model:visible="importVisible"
      title="Import Students CSV"
      :column-keys="STUDENT_CSV_COLUMNS"
      :classify-row="classifyImportRow"
      :on-confirm="runImport"
    />

    <div v-if="loading" class="flex items-center justify-center py-10">
      <ProgressSpinner style="width:28px;height:28px" />
    </div>
    <template v-else>
      <!-- ── Filters — the roster can run 1000+ rows, so nothing below renders
           without narrowing first via search/class/gender. ────────────────── -->
      <div v-if="students.length" class="flex items-center gap-2 mb-3 flex-wrap">
        <IconField class="w-64">
          <InputIcon class="pi pi-search" />
          <InputText v-model="search" placeholder="Search name, roll no, adm no, ID..." class="w-full" />
        </IconField>
        <MultiSelect
          v-model="classFilter" :options="classes" optionLabel="id" optionValue="id"
          placeholder="All classes" filter display="chip" class="w-64"
        />
        <Select v-model="genderFilter" :options="GENDER_OPTIONS" placeholder="All genders" showClear class="w-40" />
        <Button v-if="hasActiveFilters" label="Clear Filters" text size="small" @click="clearFilters" />
        <span class="text-xs text-slate-400 ml-auto">{{ filteredStudents.length }} of {{ students.length }} students</span>
      </div>

      <div class="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <DataTable
          :value="filteredStudents" size="small" stripedRows
          paginator :rows="50" :rowsPerPageOptions="[25, 50, 100, 200]"
        >
          <Column field="name" header="Name">
            <template #body="{ data }">
              <div class="font-medium text-sm text-slate-900">{{ data.name || data.id }}</div>
              <div class="text-xs text-slate-400 font-mono">{{ data.id }}</div>
            </template>
          </Column>
          <Column field="currentClassId" header="Class" style="width:110px" />
          <Column field="gender" header="Gender" style="width:90px" />
          <Column header="Date of Birth" style="width:120px">
            <template #body="{ data }">{{ formatDob(data.dateOfBirth) }}</template>
          </Column>
          <Column field="rollNo" header="Roll No" style="width:90px" />
          <Column field="admNo" header="Adm No" style="width:100px" />
          <Column header="" style="width:70px">
            <template #body="{ data }">
              <Button icon="pi pi-pencil" text rounded size="small" @click="openEditStudent(data)" />
            </template>
          </Column>
        </DataTable>
        <ConfigEmptyState v-if="!students.length" label="Students" collection="students" />
        <div v-else-if="!filteredStudents.length" class="text-center text-sm text-slate-400 py-10">
          No students match the current filters.
        </div>
      </div>
    </template>

    <!-- ── Add/Edit Student Dialog ──────────────────────────────────────── -->
    <Dialog v-model:visible="dialogVisible" :header="editingStudent ? `Edit ${editingStudent.id}` : 'Add Student'" modal :style="{ width: '640px' }">
      <div class="space-y-5 pt-2">
        <div>
          <label class="form-label mb-2 block">Basic Info</label>
          <div class="grid grid-cols-2 gap-4">
            <div>
              <label class="form-label">Name *</label>
              <InputText v-model="form.name" class="w-full" placeholder="e.g. Ananya Sharma" />
            </div>
            <div>
              <label class="form-label">Student ID *</label>
              <InputText v-model="form.id" class="w-full font-mono text-sm" :disabled="!!editingStudent" placeholder="e.g. ssds0001" />
              <p class="text-xs text-slate-400 mt-1">
                <template v-if="editingStudent">Permanent — a student ID can never be changed once created.</template>
                <template v-else-if="idConventionDetected">Auto-continues this school's existing ID sequence. Cannot be changed after saving.</template>
                <template v-else>No existing student IDs to continue from — set this school's convention now (e.g. <span class="font-mono">ssds0001</span>). Cannot be changed after saving.</template>
              </p>
            </div>
            <div>
              <label class="form-label">Class *</label>
              <Select v-model="form.currentClassId" :options="classes" optionLabel="id" optionValue="id" filter placeholder="Select class" class="w-full" />
            </div>
            <div>
              <label class="form-label">Gender</label>
              <Select v-model="form.gender" :options="GENDER_OPTIONS" placeholder="Not set" showClear editable class="w-full" />
            </div>
            <div>
              <label class="form-label">Date of Birth</label>
              <DatePicker v-model="form.dateOfBirth" class="w-full" dateFormat="d M yy" showIcon :maxDate="new Date()" />
            </div>
            <div>
              <label class="form-label">Phone</label>
              <InputNumber v-model="form.phoneNo" class="w-full" :useGrouping="false" />
            </div>
          </div>
        </div>

        <div>
          <label class="form-label mb-2 block">Additional Details</label>
          <div class="grid grid-cols-2 gap-4">
            <div>
              <label class="form-label">Roll No</label>
              <InputText v-model="form.rollNo" class="w-full" />
            </div>
            <div>
              <label class="form-label">Adm No</label>
              <InputText v-model="form.admNo" class="w-full" />
            </div>
            <div>
              <label class="form-label">GR / EMIS No</label>
              <InputText v-model="form.grEmisSts" class="w-full" />
            </div>
            <div>
              <label class="form-label">Aadhaar Number</label>
              <InputText v-model="form.aadhaarNumber" class="w-full font-mono" placeholder="12 digits" maxlength="12" />
            </div>
            <div class="col-span-2">
              <label class="form-label">Address</label>
              <Textarea v-model="form.address" class="w-full" rows="2" autoResize />
            </div>
          </div>
        </div>

        <div v-if="formError" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{{ formError }}</div>
      </div>
      <template #footer>
        <Button label="Cancel" text @click="dialogVisible = false" />
        <Button :label="editingStudent ? 'Save Changes' : 'Add Student'" :loading="saving" @click="saveStudent" />
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
import Textarea from 'primevue/textarea'
import Select from 'primevue/select'
import MultiSelect from 'primevue/multiselect'
import DatePicker from 'primevue/datepicker'
import IconField from 'primevue/iconfield'
import InputIcon from 'primevue/inputicon'
import ProgressSpinner from 'primevue/progressspinner'
import CsvImportDialog from './CsvImportDialog.vue'
import ConfigEmptyState from './ConfigEmptyState.vue'

import { schoolCollection, schoolDoc } from '../../firebase/schoolCollections.js'
import { guardedSetDoc, guardedUpdateDoc, guardedBatchSet, SchemaViolation, MODE_CREATE, MODE_UPDATE } from '../../schemas/guardedWrite.js'
import { db, auth } from '../../firebase/config'
import { toCsv, downloadCsv } from '../../utils/csv.js'
import { splitName, toDateOfBirth, toPhoneNo, toAadhaar } from '../../schemas/studentMapping.js'

const props = defineProps({ schoolId: { type: String, default: null } })
const toast = useToast()

const students = ref([])
const classes = ref([])
const loading = ref(false)

const GENDER_OPTIONS = ['Male', 'Female', 'Other']

async function loadAll() {
  if (!props.schoolId) { students.value = []; classes.value = []; return }
  loading.value = true
  try {
    const [stSnap, cSnap] = await Promise.all([
      getDocs(query(schoolCollection(props.schoolId, 'students'), orderBy('name'))),
      getDocs(schoolCollection(props.schoolId, 'classes')),
    ])
    students.value = stSnap.docs.map(d => {
      const data = d.data()
      return { id: d.id, ...data, dateOfBirth: data.dateOfBirth?.toDate ? data.dateOfBirth.toDate() : null }
    })
    classes.value = cSnap.docs.map(d => ({ id: d.id, ...d.data() }))
  } catch (e) {
    console.error('Could not load students/classes', e)
    students.value = []
    classes.value = []
  } finally {
    loading.value = false
  }
}

// ── Filters ──────────────────────────────────────────────────────────────
const search = ref('')
const classFilter = ref([])
const genderFilter = ref(null)

const hasActiveFilters = computed(() => !!search.value.trim() || classFilter.value.length || !!genderFilter.value)
function clearFilters() {
  search.value = ''
  classFilter.value = []
  genderFilter.value = null
}

const filteredStudents = computed(() => {
  let list = students.value
  const term = search.value.trim().toLowerCase()
  if (term) {
    list = list.filter(s =>
      (s.name || '').toLowerCase().includes(term)
      || (s.rollNo || '').toLowerCase().includes(term)
      || (s.admNo || '').toLowerCase().includes(term)
      || (s.id || '').toLowerCase().includes(term)
    )
  }
  if (classFilter.value.length) list = list.filter(s => classFilter.value.includes(s.currentClassId))
  if (genderFilter.value) list = list.filter(s => s.gender === genderFilter.value)
  return list
})

function formatDob(dob) {
  if (!dob) return ''
  return dob.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}

// ── Student ID convention ────────────────────────────────────────────────
// Real student IDs in this estate are a per-school prefix + zero-padded
// sequence (e.g. ssds0001, sttka0033) — NOT derived from class or name. A
// student ID is permanent once saved (Firestore doc IDs can't be renamed),
// so the only sane thing to auto-fill is "the next number in whatever
// convention this school already uses," detected live from its own roster
// rather than hard-coded, since every school's prefix differs.
const ID_RE = /^([a-z]{2,6})(\d{3,6})$/

function detectIdConvention() {
  const parsed = students.value
    .map(s => ID_RE.exec(s.id || ''))
    .filter(Boolean)
    .map(m => ({ prefix: m[1], digits: m[2] }))
  if (!parsed.length) return null
  const counts = {}
  parsed.forEach(p => { counts[p.prefix] = (counts[p.prefix] || 0) + 1 })
  const [prefix] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]
  const forPrefix = parsed.filter(p => p.prefix === prefix)
  const width = Math.max(...forPrefix.map(p => p.digits.length))
  const next = Math.max(...forPrefix.map(p => parseInt(p.digits, 10))) + 1
  return { prefix, width, next }
}

const idConventionDetected = computed(() => !!detectIdConvention())

/** @param {Set<string>} reserved  ids already claimed within the same run (e.g. a CSV batch) that aren't in `students` yet. */
function nextStudentId(reserved = new Set()) {
  const conv = detectIdConvention()
  if (!conv) return ''
  let n = conv.next
  let id = `${conv.prefix}${String(n).padStart(conv.width, '0')}`
  while (students.value.some(s => s.id === id) || reserved.has(id)) {
    n += 1
    id = `${conv.prefix}${String(n).padStart(conv.width, '0')}`
  }
  return id
}

// ── Add/Edit form ────────────────────────────────────────────────────────
const dialogVisible = ref(false)
const editingStudent = ref(null)
const saving = ref(false)
const formError = ref('')
const form = reactive({
  name: '', id: '', currentClassId: null, gender: '', dateOfBirth: null, phoneNo: null,
  rollNo: '', admNo: '', grEmisSts: '', aadhaarNumber: '', address: '',
})

function openAddStudent() {
  editingStudent.value = null
  Object.assign(form, {
    name: '', id: nextStudentId(), currentClassId: null, gender: '', dateOfBirth: null, phoneNo: null,
    rollNo: '', admNo: '', grEmisSts: '', aadhaarNumber: '', address: '',
  })
  formError.value = ''
  dialogVisible.value = true
}

function openEditStudent(student) {
  editingStudent.value = student
  Object.assign(form, {
    name: student.name || '', id: student.id, currentClassId: student.currentClassId || null,
    gender: student.gender || '', dateOfBirth: student.dateOfBirth || null, phoneNo: student.phoneNo ?? null,
    rollNo: student.rollNo || '', admNo: student.admNo || '', grEmisSts: student.grEmisSts || '',
    aadhaarNumber: student.aadhaarNumber || '', address: student.address || '',
  })
  formError.value = ''
  dialogVisible.value = true
}

function validateStudent() {
  if (!form.name.trim()) return 'Name is required'
  if (!form.currentClassId) return 'Class is required'
  if (!form.id.trim()) return 'Student ID is required'
  if (!editingStudent.value && students.value.some(s => s.id === form.id.trim())) return 'A student record with this ID already exists'
  if (form.aadhaarNumber && !/^\d{12}$/.test(form.aadhaarNumber.trim())) return 'Aadhaar number must be 12 digits'
  return ''
}

async function saveStudent() {
  formError.value = validateStudent()
  if (formError.value) return
  saving.value = true
  try {
    const { firstName, lastName } = splitName(form.name)
    const payload = {
      name: form.name.trim(), firstName, lastName,
      currentClassId: form.currentClassId,
      gender: form.gender || '',
      dateOfBirth: form.dateOfBirth || null,
      phoneNo: form.phoneNo,
      rollNo: form.rollNo.trim(), admNo: form.admNo.trim(), grEmisSts: form.grEmisSts.trim(),
      aadhaarNumber: form.aadhaarNumber.trim(), address: form.address.trim(),
      updated_at: serverTimestamp(), updated_by: auth.currentUser?.email || 'unknown',
    }
    if (editingStudent.value) {
      // The doc ID (student ID) is never part of an update payload — it's the
      // Firestore path segment, which is exactly what makes it unchangeable.
      await guardedUpdateDoc('students', schoolDoc(props.schoolId, 'students', editingStudent.value.id), payload)
    } else {
      payload.type = 'student'
      payload.created_at = serverTimestamp()
      payload.created_by = auth.currentUser?.email || 'unknown'
      await guardedSetDoc('students', schoolDoc(props.schoolId, 'students', form.id.trim()), payload, { merge: false })
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
const STUDENT_CSV_COLUMNS = [
  'name', 'id', 'currentClassId', 'gender', 'dateOfBirth', 'phoneNo',
  'rollNo', 'admNo', 'grEmisSts', 'aadhaarNumber', 'address',
]
const importVisible = ref(false)

// IDs auto-generated for rows with a blank `id` column, within one file —
// reserved so two blank-id rows in the same file never collide before either
// is actually saved. Reset per file (rowIndex 0 = first row of a fresh pick).
let reservedIds = new Set()

async function classifyImportRow(raw, rowIndex) {
  if (rowIndex === 0) reservedIds = new Set()

  const name = (raw.name || '').trim()
  if (!name) return { raw, _status: 'ERROR', _reason: 'Missing name' }

  const currentClassId = (raw.currentClassId || '').trim()
  if (!currentClassId) return { raw, _status: 'ERROR', _reason: 'Missing currentClassId' }
  if (!classes.value.some(c => c.id === currentClassId)) return { raw, _status: 'ERROR', _reason: `Unknown class id: ${currentClassId}` }

  let id = (raw.id || '').trim()
  const existing = id ? students.value.find(s => s.id === id) : undefined
  // A blank id ALWAYS means "new student" — an existing student is matched by
  // its id (the one thing that can't change), never guessed at from name/roll.
  if (!id) {
    id = nextStudentId(reservedIds)
    if (!id) return { raw, _status: 'ERROR', _reason: 'No existing student ID to continue from — add the first student manually to set this school\'s ID convention' }
    reservedIds.add(id)
  }

  const dobRaw = (raw.dateOfBirth || '').trim()
  const dateOfBirth = toDateOfBirth(dobRaw)
  if (dobRaw && !dateOfBirth) return { raw, _status: 'ERROR', _reason: `Unreadable date of birth "${dobRaw}" — use yyyy-mm-dd` }

  const phoneRaw = (raw.phoneNo || '').trim()
  const phoneNo = toPhoneNo(phoneRaw)
  if (phoneRaw && phoneNo === null) return { raw, _status: 'ERROR', _reason: `Unusable phone number "${phoneRaw}"` }

  const aadhaarRaw = (raw.aadhaarNumber || '').trim()
  const aadhaarNumber = toAadhaar(aadhaarRaw)
  if (aadhaarRaw && !aadhaarNumber) return { raw, _status: 'ERROR', _reason: `Aadhaar "${aadhaarRaw}" is not 12 digits` }

  const { firstName, lastName } = splitName(name)
  const payload = {
    name, firstName, lastName,
    currentClassId,
    gender: (raw.gender || '').trim(),
    dateOfBirth,
    phoneNo,
    rollNo: (raw.rollNo || '').trim(),
    admNo: (raw.admNo || '').trim(),
    grEmisSts: (raw.grEmisSts || '').trim(),
    aadhaarNumber,
    address: (raw.address || '').trim(),
  }
  return { raw, id, _status: existing ? 'UPDATE' : 'CREATE', payload }
}

async function runImport(validRows) {
  const batch = writeBatch(db)
  for (const r of validRows) {
    const payload = {
      ...r.payload,
      updated_at: serverTimestamp(), updated_by: auth.currentUser?.email || 'unknown',
    }
    if (r._status === 'CREATE') {
      payload.type = 'student'
      payload.created_at = serverTimestamp()
      payload.created_by = auth.currentUser?.email || 'unknown'
    }
    const mode = r._status === 'CREATE' ? MODE_CREATE : MODE_UPDATE
    guardedBatchSet(batch, 'students', schoolDoc(props.schoolId, 'students', r.id), payload, { mode, merge: true })
  }
  await batch.commit()
  toast.add({ severity: 'success', summary: 'Imported', detail: `${validRows.length} student record(s)`, life: 3000 })
  await loadAll()
  return true
}

function downloadSample() {
  const sample = [
    { name: 'Ananya Sharma', id: '', currentClassId: '6_NEWTON', gender: 'Female', dateOfBirth: '2014-05-12', phoneNo: '9876543210', rollNo: '12', admNo: 'ADM1023', grEmisSts: '', aadhaarNumber: '', address: '' },
    { name: 'Rohan Verma', id: '', currentClassId: '7_KALAM', gender: 'Male', dateOfBirth: '2013-11-03', phoneNo: '', rollNo: '5', admNo: 'ADM1044', grEmisSts: '', aadhaarNumber: '', address: '' },
  ]
  downloadCsv('students_sample.csv', toCsv(sample, STUDENT_CSV_COLUMNS))
}

function exportCsv() {
  const rows = students.value.map(s => ({
    name: s.name || '', id: s.id, currentClassId: s.currentClassId || '',
    gender: s.gender || '', dateOfBirth: s.dateOfBirth ? s.dateOfBirth.toISOString().slice(0, 10) : '',
    phoneNo: s.phoneNo ?? '',
    rollNo: s.rollNo || '', admNo: s.admNo || '', grEmisSts: s.grEmisSts || '',
    aadhaarNumber: s.aadhaarNumber || '', address: s.address || '',
  }))
  downloadCsv(`students_${props.schoolId}.csv`, toCsv(rows, STUDENT_CSV_COLUMNS))
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
