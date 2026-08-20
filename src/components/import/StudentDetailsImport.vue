<template>
  <div class="bg-white rounded-xl border border-slate-200 p-5">
    <div class="text-sm font-bold text-slate-900 mb-1">Fill student details from a CSV</div>
    <p class="text-xs text-slate-500 mb-4 max-w-3xl">
      For students who are already registered. Each row finds its student by ID and fills in the
      fields it carries. Nobody is created, and a value the student already has is never replaced.
    </p>

    <div class="grid gap-4 md:grid-cols-3 mb-4">
      <div>
        <label class="form-label">School *</label>
        <Select v-model="schoolId" :options="schools" optionLabel="name" optionValue="id"
                placeholder="Select a school" class="w-full" filter :loading="loadingSchools"
                @update:modelValue="reset" />
      </div>
      <div>
        <label class="form-label">CSV file *</label>
        <input type="file" accept=".csv,.tsv,text/csv" class="text-sm w-full" @change="onFile" />
      </div>
      <div>
        <label class="form-label">Which column holds the student ID? *</label>
        <Select v-model="idColumn" :options="headers" placeholder="Select a column" class="w-full"
                :disabled="!headers.length" @update:modelValue="plan = null" />
      </div>
    </div>

    <div class="flex gap-2">
      <Button label="Preview" icon="pi pi-search" size="small" outlined
              :loading="previewing" :disabled="!schoolId || !rows.length || !idColumn"
              @click="runPreview" />
    </div>
    <div v-if="error" class="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2 mt-3">{{ error }}</div>

    <!-- ── Preview ─────────────────────────────────────────────────────────── -->
    <div v-if="plan" class="mt-5 space-y-4 border-t border-slate-100 pt-4">
      <div class="flex flex-wrap gap-2">
        <span class="stat">{{ plan.totals.rows }} row(s)</span>
        <span class="stat stat-ok">{{ plan.totals.matched }} matched</span>
        <span v-if="plan.totals.unmatched" class="stat stat-warn">{{ plan.totals.unmatched }} unmatched</span>
        <span class="stat">{{ plan.totals.studentsToUpdate }} student(s) to update</span>
        <span class="stat">{{ plan.totals.fieldsToWrite }} field value(s)</span>
      </div>

      <div v-if="!plan.totals.matched"
           class="text-sm text-red-800 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
        <div class="font-semibold mb-1">No row matched a student — nothing can be filled in.</div>
        Every id in "{{ idColumn }}" is unknown to this school. Either these students have not been
        registered yet, or that column is not the one holding their registration id.
        Adding schema columns is blocked until at least one row matches, because a file that matches
        nothing has not been shown to belong to this school.
      </div>
      <div v-else-if="plan.totals.matchRate < 0.5"
           class="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
        Only {{ plan.totals.matched }} of {{ plan.totals.rows }} rows matched a student. Check that
        "{{ idColumn }}" is the right column before writing anything.
      </div>

      <div v-if="plan.isEmpty && plan.totals.matched" class="text-sm text-slate-500 bg-slate-50 rounded-lg px-3 py-2">
        Nothing to add — every matched student already has everything this file carries.
      </div>

      <!-- Step 1 -->
      <div class="rounded-lg border border-slate-200 p-3">
        <div class="flex items-center justify-between gap-4">
          <div>
            <div class="text-sm font-semibold text-slate-800">1. Fill in student fields</div>
            <p class="text-xs text-slate-500 mt-0.5">
              Writes {{ plan.totals.fieldsToWrite }} value(s) across
              {{ plan.totals.studentsToUpdate }} student(s). Existing values are left alone.
            </p>
          </div>
          <Button label="Fill fields" icon="pi pi-pencil" size="small"
                  :disabled="!plan.totals.fieldsToWrite" :loading="writingFields"
                  @click="confirmFields" />
        </div>
      </div>

      <!-- Step 2 — deliberately separate: this array is what the teacher app and
           the roster mapper both read, so growing it is a bigger decision than
           filling in one student's details. -->
      <div class="rounded-lg border border-slate-200 p-3">
        <div class="flex items-center justify-between gap-4 mb-2">
          <div>
            <div class="text-sm font-semibold text-slate-800">
              2. Add {{ plan.totals.newSchemaColumns }} column(s) to students_schema
            </div>
            <p class="text-xs text-slate-500 mt-0.5">
              Separate on purpose — this list decides what ops can map on every future import,
              and the teacher app reads it too.
              <span v-if="!plan.canAddColumns" class="text-red-700 font-medium">
                Blocked: no row matched a student.
              </span>
            </p>
          </div>
          <Button label="Add columns" icon="pi pi-plus" size="small" outlined
                  :disabled="!plan.totals.newSchemaColumns || !plan.canAddColumns"
                  :loading="writingSchema" @click="confirmSchema" />
        </div>
        <div v-if="plan.newColumns.length" class="flex flex-wrap gap-1.5">
          <span v-for="c in plan.newColumns" :key="c.key"
                class="text-xs bg-slate-100 text-slate-600 rounded px-2 py-0.5 font-mono"
                v-tooltip="`${c.header} — ${c.type}`">{{ c.key }}</span>
        </div>
      </div>

      <div v-if="plan.bannedColumns.length" class="text-xs text-amber-800 bg-amber-50 rounded px-2 py-1.5">
        Not stored (golden rule 3):
        <span class="font-mono">{{ plan.bannedColumns.map(c => c.header).join(', ') }}</span>
      </div>

      <div v-if="plan.unmatched.length">
        <div class="text-xs font-semibold text-slate-600 mb-1">
          {{ plan.unmatched.length }} row(s) matched no student
        </div>
        <DataTable :value="plan.unmatched" size="small" stripedRows paginator :rows="5">
          <Column field="row" header="Row" style="width:80px" />
          <Column field="id" header="ID in file">
            <template #body="{ data }"><span class="font-mono text-xs">{{ data.id || '—' }}</span></template>
          </Column>
          <Column field="reason" header="Why">
            <template #body="{ data }"><span class="text-xs text-slate-500">{{ data.reason }}</span></template>
          </Column>
        </DataTable>
      </div>

      <div v-if="progress" class="text-sm text-slate-500">{{ progress }}</div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { getDoc, getDocs, query, orderBy, setDoc, writeBatch, serverTimestamp } from 'firebase/firestore'
import { useConfirm } from 'primevue/useconfirm'
import { useToast } from 'primevue/usetoast'
import Button from 'primevue/button'
import Select from 'primevue/select'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'

import { rootSchoolsCollection, schoolCollection, schoolDoc } from '../../firebase/schoolCollections.js'
import { db, auth } from '../../firebase/config'
import { parseCsv, readFileAsText } from '../../utils/csv.js'
import { buildEnrichmentPlan, schemaAdditionsFor } from '../../utils/studentEnrichment.js'
import { guardedBatchSet, MODE_UPDATE, SchemaViolation } from '../../schemas/guardedWrite.js'

const confirm = useConfirm()
const toast = useToast()

const schools = ref([])
const loadingSchools = ref(false)
const schoolId = ref(null)
const rows = ref([])
const headers = ref([])
const idColumn = ref(null)
const plan = ref(null)
const schemaColumns = ref([])
const previewing = ref(false)
const writingFields = ref(false)
const writingSchema = ref(false)
const error = ref('')
const progress = ref('')

function reset() { plan.value = null; progress.value = '' }

async function loadSchools() {
  loadingSchools.value = true
  try {
    const snap = await getDocs(query(rootSchoolsCollection(), orderBy('name')))
    schools.value = snap.docs.map(d => ({ id: d.id, name: d.data().name || d.id }))
  } catch (e) {
    console.error(e); error.value = 'Could not load the school list.'
  } finally { loadingSchools.value = false }
}
loadSchools()

async function onFile(ev) {
  reset()
  error.value = ''
  const file = ev.target.files?.[0]
  if (!file) { rows.value = []; headers.value = []; return }
  try {
    const { rows: parsed, errors } = parseCsv(await readFileAsText(file))
    if (errors?.length) console.warn('CSV parse warnings', errors)
    rows.value = parsed
    headers.value = parsed.length ? Object.keys(parsed[0]) : []
    // A column literally called ID is the usual case; still overridable.
    idColumn.value = headers.value.find(h => h.trim().toLowerCase() === 'id') || null
  } catch (e) {
    console.error(e); error.value = 'Could not read that file.'
  }
}

async function runPreview() {
  previewing.value = true
  error.value = ''
  progress.value = ''
  try {
    const [sSnap, schemaSnap] = await Promise.all([
      getDocs(schoolCollection(schoolId.value, 'students')),
      getDoc(schoolDoc(schoolId.value, 'config', 'students_schema')).catch(() => null),
    ])
    const students = sSnap.docs.map(d => ({ docId: d.id, ...d.data() }))
    schemaColumns.value = schemaSnap?.exists?.() ? (schemaSnap.data().columns || []) : []
    plan.value = buildEnrichmentPlan({
      csvRows: rows.value, idColumn: idColumn.value, students, schemaColumns: schemaColumns.value,
    })
  } catch (e) {
    console.error(e); error.value = 'Could not read this school. Check the console.'
  } finally { previewing.value = false }
}

function confirmFields() {
  const t = plan.value.totals
  confirm.require({
    message: `Fill ${t.fieldsToWrite} value(s) across ${t.studentsToUpdate} student(s) in "${schoolId.value}"? `
           + 'Values a student already has are left exactly as they are.',
    header: 'Fill student fields',
    icon: 'pi pi-pencil',
    rejectLabel: 'Cancel', acceptLabel: 'Fill',
    accept: runFields,
  })
}

async function runFields() {
  writingFields.value = true
  error.value = ''
  try {
    const items = plan.value.withChanges
    let done = 0
    for (let i = 0; i < items.length; i += 450) {
      const batch = writeBatch(db)
      for (const m of items.slice(i, i + 450)) {
        guardedBatchSet(batch, 'students', schoolDoc(schoolId.value, 'students', m.docId), {
          ...m.fields,
          updated_at: serverTimestamp(),
          updated_by: auth.currentUser?.email || 'unknown',
        }, { mode: MODE_UPDATE, merge: true })
      }
      await batch.commit()
      done += Math.min(450, items.length - i)
      progress.value = `Updated ${done}/${items.length} student(s)…`
    }
    toast.add({ severity: 'success', summary: 'Student fields filled',
                detail: `${plan.value.totals.fieldsToWrite} value(s)`, life: 3000 })
    await runPreview()   // a correct run leaves nothing to do
  } catch (e) {
    console.error(e)
    error.value = e instanceof SchemaViolation ? e.userMessage
      : 'Something went wrong writing student fields. Check the console.'
  } finally { writingFields.value = false }
}

const additions = computed(() => plan.value ? schemaAdditionsFor(plan.value, schemaColumns.value) : [])

function confirmSchema() {
  if (!plan.value?.canAddColumns) {
    error.value = 'No row matched a student, so this file has not been shown to belong to this school.'
    return
  }
  const list = additions.value.map(c => c.key).join(', ')
  confirm.require({
    message: `Add ${additions.value.length} column(s) to config/students_schema for "${schoolId.value}"?\n\n${list}\n\n`
           + 'This list is what ops can map on every future import, and the teacher app reads it too. '
           + 'Existing columns are not touched.',
    header: 'Add columns to students_schema',
    icon: 'pi pi-plus',
    rejectLabel: 'Cancel', acceptLabel: 'Add columns',
    accept: runSchema,
  })
}

async function runSchema() {
  writingSchema.value = true
  error.value = ''
  try {
    // Append only. Rewriting the array wholesale would drop anything the
    // teacher app or a hand edit put there that this file knows nothing about.
    const merged = [...schemaColumns.value, ...additions.value]
    await setDoc(schoolDoc(schoolId.value, 'config', 'students_schema'), {
      columns: merged,
      updated_at: serverTimestamp(),
      updated_by: auth.currentUser?.email || 'unknown',
    }, { merge: true })
    toast.add({ severity: 'success', summary: 'Schema columns added',
                detail: `${additions.value.length} column(s)`, life: 3000 })
    await runPreview()
  } catch (e) {
    console.error(e)
    error.value = 'Could not update students_schema. Check the console.'
  } finally { writingSchema.value = false }
}
</script>

<style scoped>
.form-label {
  display: block; font-size: 12px; font-weight: 500; color: #64748b;
  margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.04em;
}
.stat { font-size: 12px; background: #f1f5f9; color: #334155; border-radius: 6px; padding: 3px 8px; }
.stat-ok   { background: #ecfdf5; color: #047857; }
.stat-warn { background: #fffbeb; color: #b45309; }
</style>
