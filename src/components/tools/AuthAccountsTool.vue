<template>
  <div class="max-w-4xl space-y-4">
    <div>
      <div class="text-sm font-bold text-slate-900 mb-1">Create Auth Accounts</div>
      <p class="text-sm text-slate-500">
        Registering someone — through the Register tool or a roster import — creates their record
        but not their sign-in. This creates the Firebase Auth account for everyone still waiting,
        and links anyone whose account already exists.
      </p>
    </div>

    <div class="bg-white rounded-xl border border-slate-200 p-4 space-y-3">
      <div class="grid gap-3 md:grid-cols-3">
        <div>
          <label class="form-label">School</label>
          <Select v-model="schoolId" :options="schools" optionLabel="name" optionValue="id"
                  placeholder="Select a school" class="w-full" filter :loading="loadingSchools" />
        </div>
        <div>
          <label class="form-label">Who</label>
          <Select v-model="collection" :options="COLLECTIONS" optionLabel="label" optionValue="value"
                  class="w-full" />
        </div>
        <div>
          <label class="form-label">Per run</label>
          <InputNumber v-model="limit" class="w-full" :min="1" :max="500" />
          <p class="text-xs text-slate-400 mt-1">Run again for the rest — nothing is lost.</p>
        </div>
      </div>

      <div class="flex gap-2">
        <Button label="Check" icon="pi pi-search" size="small" outlined
                :loading="checking" :disabled="!schoolId" @click="runPreview" />
        <Button v-if="preview && willAct" label="Create accounts" icon="pi pi-user-plus" size="small"
                :loading="running" @click="confirmRun" />
      </div>
      <div v-if="error" class="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{{ error }}</div>
    </div>

    <!-- ── Result ─────────────────────────────────────────────────────────── -->
    <div v-if="report" class="bg-white rounded-xl border border-slate-200 p-4 space-y-3">
      <div class="flex items-center justify-between">
        <div class="text-sm font-semibold text-slate-800">
          {{ report.dryRun ? 'What a run would do' : 'Run complete' }}
        </div>
        <span v-if="report.moreRemaining" class="text-xs text-amber-700 bg-amber-50 rounded px-2 py-1">
          More remaining — run again
        </span>
      </div>

      <div class="flex flex-wrap gap-2">
        <span class="stat">{{ report.considered }} considered</span>
        <span class="stat stat-ok">{{ report.created }} {{ report.dryRun ? 'to create' : 'created' }}</span>
        <span class="stat stat-info">{{ report.linked }} {{ report.dryRun ? 'to link' : 'linked' }}</span>
        <span v-if="report.skipped" class="stat stat-warn">{{ report.skipped }} skipped</span>
        <span v-if="report.failed" class="stat stat-bad">{{ report.failed }} failed</span>
      </div>

      <p v-if="!report.considered" class="text-sm text-slate-500">
        Nobody is waiting for an account in {{ collectionLabel }} at this school.
      </p>

      <DataTable v-if="notableRows.length" :value="notableRows" size="small" stripedRows
                 paginator :rows="10">
        <Column field="id" header="ID" style="width:140px">
          <template #body="{ data }"><span class="font-mono text-xs">{{ data.id }}</span></template>
        </Column>
        <Column field="email" header="Email" />
        <Column field="status" header="Status" style="width:120px">
          <template #body="{ data }">
            <span class="text-xs font-semibold" :class="statusClass(data.status)">{{ data.status }}</span>
          </template>
        </Column>
        <Column field="reason" header="Detail">
          <template #body="{ data }"><span class="text-xs text-slate-500">{{ data.reason || '' }}</span></template>
        </Column>
      </DataTable>
      <p v-if="notableRows.length" class="text-xs text-slate-400">
        Showing everything that needs attention plus a sample of the rest.
      </p>
    </div>

    <p class="text-xs text-slate-400">
      The first-time password is the person's own ID, which is what the teacher and student apps
      expect. Passwords are never shown here or written to the log.
    </p>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { getDocs, query, orderBy } from 'firebase/firestore'
import { useConfirm } from 'primevue/useconfirm'
import { useToast } from 'primevue/usetoast'
import Button from 'primevue/button'
import Select from 'primevue/select'
import InputNumber from 'primevue/inputnumber'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'

import { rootSchoolsCollection } from '../../firebase/schoolCollections.js'
import { createAuthAccountsRemote } from '../../utils/api.js'

const COLLECTIONS = [
  { label: 'Students', value: 'students' },
  { label: 'Teachers / staff', value: 'staffs' },
]

const confirm = useConfirm()
const toast = useToast()

const schools = ref([])
const loadingSchools = ref(false)
const schoolId = ref(null)
const collection = ref('students')
const limit = ref(200)
const checking = ref(false)
const running = ref(false)
const report = ref(null)
const error = ref('')

const collectionLabel = computed(() =>
  COLLECTIONS.find(c => c.value === collection.value)?.label.toLowerCase() || collection.value)

const preview = computed(() => (report.value?.dryRun ? report.value : null))
const willAct = computed(() => !!preview.value && (preview.value.created + preview.value.linked) > 0)

// Everything that needs a human's attention, then a sample of the routine rows —
// a 200-person run should not bury three failures in two hundred successes.
const notableRows = computed(() => {
  const rows = report.value?.results || []
  const notable = rows.filter(r => r.status === 'skipped' || r.status === 'failed' || r.status === 'error')
  const routine = rows.filter(r => !notable.includes(r)).slice(0, 20)
  return [...notable, ...routine]
})

function statusClass(s) {
  if (s === 'created' || s === 'would_create') return 'text-emerald-700'
  if (s === 'linked' || s === 'would_link') return 'text-blue-700'
  if (s === 'skipped') return 'text-amber-700'
  return 'text-red-600'
}

async function loadSchools() {
  loadingSchools.value = true
  try {
    const snap = await getDocs(query(rootSchoolsCollection(), orderBy('name')))
    schools.value = snap.docs.map(d => ({ id: d.id, name: d.data().name || d.id }))
  } catch (e) {
    console.error(e)
    error.value = 'Could not load the school list.'
  } finally {
    loadingSchools.value = false
  }
}
loadSchools()

async function call(dryRun) {
  error.value = ''
  try {
    report.value = await createAuthAccountsRemote({
      schoolId: schoolId.value, collection: collection.value, dryRun, limit: limit.value,
    })
  } catch (e) {
    console.error(e)
    error.value = e?.message || 'The call failed. Check the console.'
    report.value = null
  }
}

async function runPreview() {
  checking.value = true
  await call(true)
  checking.value = false
}

function confirmRun() {
  const p = preview.value
  confirm.require({
    message: `Create ${p.created} auth account(s) and link ${p.linked} existing one(s) `
           + `for ${collectionLabel.value} at "${schoolId.value}"?`
           + (p.skipped ? ` ${p.skipped} record(s) will be skipped.` : '')
           + ' Each person\'s first-time password is their own ID.',
    header: 'Create Auth Accounts',
    icon: 'pi pi-user-plus',
    rejectLabel: 'Cancel',
    acceptLabel: 'Create',
    accept: async () => {
      running.value = true
      await call(false)
      running.value = false
      if (report.value && !report.value.dryRun) {
        toast.add({
          severity: report.value.failed ? 'warn' : 'success',
          summary: 'Accounts processed',
          detail: `${report.value.created} created, ${report.value.linked} linked`
                + (report.value.failed ? `, ${report.value.failed} failed` : ''),
          life: 4000,
        })
      }
    },
  })
}
</script>

<style scoped>
.form-label {
  display: block; font-size: 12px; font-weight: 500; color: #64748b;
  margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.04em;
}
.stat { font-size: 12px; background: #f1f5f9; color: #334155; border-radius: 6px; padding: 3px 8px; }
.stat-ok   { background: #ecfdf5; color: #047857; }
.stat-info { background: #eff6ff; color: #1d4ed8; }
.stat-warn { background: #fffbeb; color: #b45309; }
.stat-bad  { background: #fef2f2; color: #b91c1c; }
</style>
