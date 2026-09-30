<template>
  <div class="pt-4">
    <div class="flex flex-wrap items-center justify-between gap-3 mb-3">
      <div class="flex flex-wrap items-center gap-3">
        <div class="text-sm font-bold text-slate-900">Sheets Status</div>
        <Select v-model="sheetTypeKey" :options="SHEET_TYPES" optionLabel="label" optionValue="key" class="w-44" />
        <Select v-model="selectedTermId" :options="terms" optionLabel="name" optionValue="id" placeholder="Select a term" class="w-56" />
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <Button label="Freeze Everything" icon="pi pi-lock" size="small" severity="secondary" outlined :disabled="!selectedTermId || busy" @click="confirmAllTypes(true)" />
        <Button label="Unfreeze Everything" icon="pi pi-lock-open" size="small" severity="secondary" outlined :disabled="!selectedTermId || busy" @click="confirmAllTypes(false)" />
      </div>
    </div>

    <div class="text-xs text-slate-500 mb-3">
      <template v-if="currentType.termScoped">{{ currentType.label }} sheets are per term — only the selected term's sheets are listed.</template>
      <template v-else>{{ currentType.label }} sheets are per class, not per term — freezing here applies to the whole year{{ currentType.key === 'attendance' ? ' (month-wise and every day-wise month)' : '' }}.</template>
      A sheet no teacher has opened yet doesn't exist, so it can't be frozen; it will open unfrozen.
      Admins can still edit frozen sheets in the teacher app.
    </div>

    <div v-if="needsTerm" class="text-center text-sm text-slate-400 py-10 bg-white rounded-xl border border-slate-200">
      Select a term to view sheet status.
    </div>
    <div v-else-if="loading" class="flex items-center justify-center py-10">
      <ProgressSpinner style="width:28px;height:28px" />
    </div>
    <div v-else class="bg-white rounded-xl border border-slate-200 overflow-hidden mb-6">
      <div class="flex flex-wrap items-center justify-between gap-2 px-3 py-2 border-b border-slate-200">
        <span class="text-xs text-slate-500">{{ frozenSummary }}</span>
        <div class="flex flex-wrap items-center gap-2">
          <Button :label="`Freeze Selected (${selectedRows.length})`" icon="pi pi-lock" size="small" text :disabled="!selectedRows.length || busy" @click="confirmBulk(selectedRows, true, 'selected')" />
          <Button :label="`Unfreeze Selected (${selectedRows.length})`" icon="pi pi-lock-open" size="small" text :disabled="!selectedRows.length || busy" @click="confirmBulk(selectedRows, false, 'selected')" />
          <Button :label="`Freeze All ${currentType.label}`" icon="pi pi-lock" size="small" outlined :disabled="!existingRows.length || busy" @click="confirmBulk(existingRows, true, 'all')" />
          <Button :label="`Unfreeze All ${currentType.label}`" icon="pi pi-lock-open" size="small" outlined :disabled="!existingRows.length || busy" @click="confirmBulk(existingRows, false, 'all')" />
        </div>
      </div>
      <DataTable :value="rows" dataKey="key" size="small" stripedRows>
        <Column style="width:44px">
          <template #header>
            <Checkbox :modelValue="allSelected" binary :disabled="!existingRows.length" @update:modelValue="toggleSelectAll" />
          </template>
          <template #body="{ data }">
            <Checkbox v-model="selectedKeys" :value="data.key" :disabled="!data.exists" />
          </template>
        </Column>
        <Column header="Class">
          <template #body="{ data }">
            {{ className(data.classId) }}
            <span v-if="!data.configured" class="text-xs text-amber-600" title="This class/subject is no longer set up, but a sheet for it still exists">(not set up)</span>
          </template>
        </Column>
        <Column v-if="currentType.key === 'academics'" header="Subject">
          <template #body="{ data }">{{ subjectName(data.subjectId) }}</template>
        </Column>
        <Column header="Exists" style="width:70px">
          <template #body="{ data }"><i :class="data.exists ? 'pi pi-check-circle text-emerald-500' : 'pi pi-circle text-slate-300'"></i></template>
        </Column>
        <Column header="Sheets" style="width:70px">
          <template #body="{ data }">
            <span class="text-xs text-slate-500" :title="currentType.key === 'attendance' ? 'Month-wise plus one per day-wise month' : 'More than one means duplicates — all are frozen together'">{{ data.sheets.length }}</span>
          </template>
        </Column>
        <Column field="entryCount" header="Entries" style="width:80px" />
        <Column header="Last Edited" style="width:160px">
          <template #body="{ data }"><span class="text-xs text-slate-500">{{ formatDate(data.lastEditedAt) }}</span></template>
        </Column>
        <Column header="By" style="width:140px">
          <template #body="{ data }"><span class="text-xs text-slate-500">{{ resolveStaff(data.lastEditedBy) }}</span></template>
        </Column>
        <Column header="Frozen" style="width:130px">
          <template #body="{ data }">
            <div v-if="data.exists" class="flex items-center gap-1">
              <Button
                :icon="data.isFrozen ? 'pi pi-lock' : data.partlyFrozen ? 'pi pi-exclamation-triangle' : 'pi pi-lock-open'"
                :severity="data.partlyFrozen ? 'warn' : undefined"
                :title="data.isFrozen ? 'Frozen — click to unfreeze' : 'Click to freeze'"
                :disabled="busy"
                text rounded size="small"
                @click="toggleFrozen(data)"
              />
              <span class="text-xs" :class="data.isFrozen ? 'text-slate-700' : data.partlyFrozen ? 'text-amber-600' : 'text-slate-400'">
                {{ data.isFrozen ? 'Frozen' : data.partlyFrozen ? 'Partly' : 'Open' }}
              </span>
            </div>
            <span v-else class="text-xs text-slate-300">Not started</span>
          </template>
        </Column>
      </DataTable>
      <div v-if="!rows.length" class="text-center text-sm text-slate-400 py-8">
        {{ currentType.key === 'academics' ? 'No class/subject combinations for this term' : 'No classes set up' }}
      </div>
    </div>

    <!-- ── Stray sheets (empty, referencing a deleted term) ────────────────── -->
    <div class="bg-white rounded-xl border border-slate-200 p-4">
      <div class="flex items-center justify-between mb-3">
        <div class="text-sm font-bold text-slate-900">Stray Sheets</div>
        <Button label="Scan" icon="pi pi-search" size="small" text :loading="scanningStray" @click="scanStray" />
      </div>
      <div v-if="!strayScanned" class="text-sm text-slate-400">Click Scan to look for empty sheets pointing at deleted terms.</div>
      <div v-else-if="!straySheets.length" class="text-sm text-emerald-600">✓ None found.</div>
      <div v-else class="space-y-2">
        <div v-for="s in straySheets" :key="s.id" class="flex items-center justify-between gap-3 border border-amber-200 bg-amber-50 rounded-lg px-3 py-2">
          <span class="text-sm text-amber-800">{{ s.id }} — termId "{{ s.termId }}" (missing), 0 entries</span>
          <Button label="Delete" size="small" outlined severity="danger" @click="confirmDeleteStray(s)" />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { getDocs, getCountFromServer, query, where, collection, writeBatch, deleteDoc } from 'firebase/firestore'
import { useConfirm } from 'primevue/useconfirm'
import { useToast } from 'primevue/usetoast'

import Button from 'primevue/button'
import Checkbox from 'primevue/checkbox'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import Select from 'primevue/select'
import ProgressSpinner from 'primevue/progressspinner'

import { schoolCollection, schoolDoc } from '../../firebase/schoolCollections.js'
import { db } from '../../firebase/config'
import { SHEET_TYPES, sheetType, buildRows, idsToWrite, chunk, applyFrozen, sortRows } from '../../utils/sheetFreeze.js'

const props = defineProps({ schoolId: { type: String, default: null } })
const confirm = useConfirm()
const toast = useToast()

const terms = ref([])
const classes = ref([])
const subjects = ref([])
const staffs = ref([])
const sheetTypeKey = ref('academics')
const selectedTermId = ref(null)
const rows = ref([])
const loading = ref(false)
const busy = ref(false)
const selectedKeys = ref([])

const currentType = computed(() => sheetType(sheetTypeKey.value))
const needsTerm = computed(() => currentType.value.termScoped && !selectedTermId.value)
const existingRows = computed(() => rows.value.filter(r => r.exists))
const selectedRows = computed(() => existingRows.value.filter(r => selectedKeys.value.includes(r.key)))
const allSelected = computed(() => existingRows.value.length > 0 && selectedRows.value.length === existingRows.value.length)
const frozenSummary = computed(() => {
  const frozen = existingRows.value.filter(r => r.isFrozen).length
  const partly = existingRows.value.filter(r => r.partlyFrozen).length
  return `${frozen} of ${existingRows.value.length} started sheet(s) frozen` + (partly ? `, ${partly} partly frozen` : '') +
    ` · ${rows.value.length - existingRows.value.length} not started`
})

function toggleSelectAll(on) {
  selectedKeys.value = on ? existingRows.value.map(r => r.key) : []
}

function resolveStaff(idOrEmail) {
  if (!idOrEmail) return '—'
  const match = staffs.value.find(s => s.id === idOrEmail || s.authUid === idOrEmail)
  return match?.name || idOrEmail
}
function className(id) {
  return classes.value.find(c => c.id === id)?.name || id
}
function subjectName(id) {
  if (!id) return '—'
  return subjects.value.find(s => s.id === id)?.name || id
}
function formatDate(ts) {
  if (!ts) return '—'
  const d = ts.toDate ? ts.toDate() : new Date(ts)
  return d.toLocaleString()
}
function termName(id) {
  return terms.value.find(t => t.id === id)?.name || id
}

async function loadStatic() {
  if (!props.schoolId) { terms.value = []; classes.value = []; subjects.value = []; staffs.value = []; return }
  try {
    const [tSnap, cSnap, suSnap, stSnap] = await Promise.all([
      getDocs(schoolCollection(props.schoolId, 'terms')),
      getDocs(schoolCollection(props.schoolId, 'classes')),
      getDocs(schoolCollection(props.schoolId, 'subjects')),
      getDocs(schoolCollection(props.schoolId, 'staffs')),
    ])
    terms.value = tSnap.docs.map(d => ({ id: d.id, ...d.data() }))
    classes.value = cSnap.docs.map(d => ({ id: d.id, ...d.data() }))
    subjects.value = suSnap.docs.map(d => ({ id: d.id, ...d.data() }))
    staffs.value = stSnap.docs.map(d => ({ id: d.id, ...d.data() }))
  } catch (e) {
    console.error('Could not load terms/classes/subjects/staffs', e)
  }
}

// Every sheet doc of this type (for term-scoped types, only the given term's).
async function fetchSheetDocs(typeKey, termId) {
  const t = sheetType(typeKey)
  const coll = schoolCollection(props.schoolId, t.collection)
  const snap = await getDocs(t.termScoped ? query(coll, where('termId', '==', termId)) : coll)
  return snap.docs.map(d => ({ id: d.id, ref: d.ref, data: d.data() }))
}

// A load that finishes after a newer one started (type/term switched meanwhile) must not
// overwrite the newer rows.
let loadSeq = 0
async function loadRows() {
  const seq = ++loadSeq
  selectedKeys.value = []
  if (!props.schoolId || needsTerm.value) { rows.value = []; loading.value = false; return }
  const typeKey = sheetTypeKey.value
  loading.value = true
  try {
    const docs = await fetchSheetDocs(typeKey, selectedTermId.value)
    const built = buildRows(typeKey, classes.value, docs)
    const refById = new Map(docs.map(d => [d.id, d.ref]))
    await Promise.all(built.map(async r => {
      const counts = await Promise.all(r.sheets.map(async s =>
        (await getCountFromServer(collection(refById.get(s.id), 'entries'))).data().count))
      r.entryCount = counts.reduce((a, b) => a + b, 0)
    }))
    if (seq !== loadSeq) return
    rows.value = sortRows(built, className, subjectName)
  } catch (e) {
    if (seq !== loadSeq) return
    console.error('Could not load sheet status', e)
    toast.add({ severity: 'error', summary: 'Error', detail: 'Could not load sheet status', life: 3000 })
    rows.value = []
  } finally {
    if (seq === loadSeq) loading.value = false
  }
}

// Only the isFrozen field is ever written, and only on sheets that already exist (update, never
// create — the teacher app find-or-creates sheets).
async function writeFrozen(collectionName, ids, frozen) {
  for (const part of chunk(ids)) {
    const batch = writeBatch(db)
    part.forEach(id => batch.update(schoolDoc(props.schoolId, collectionName, id), { isFrozen: frozen }))
    await batch.commit()
  }
}

function writeErrorDetail(e) {
  return e?.code === 'permission-denied'
    ? 'Permission denied by Firestore rules for this collection.'
    : 'Some sheets may not have been updated — the list has been reloaded.'
}

async function toggleFrozen(row) {
  const frozen = !row.isFrozen // a partly frozen row gets fully frozen
  const ids = idsToWrite([row], frozen)
  if (!ids.length) return
  busy.value = true
  try {
    await writeFrozen(currentType.value.collection, ids, frozen)
    applyFrozen(rows.value, ids, frozen)
  } catch (e) {
    console.error('Could not update freeze', e)
    toast.add({ severity: 'error', summary: 'Could not update', detail: writeErrorDetail(e), life: 4000 })
    await loadRows()
  } finally {
    busy.value = false
  }
}

function confirmBulk(targetRows, frozen, scope) {
  const t = currentType.value
  const ids = idsToWrite(targetRows, frozen)
  const verb = frozen ? 'Freeze' : 'Unfreeze'
  if (!ids.length) {
    toast.add({ severity: 'info', summary: `Nothing to ${verb.toLowerCase()}`, life: 2000 })
    return
  }
  const forTerm = t.termScoped ? ` for ${termName(selectedTermId.value)}` : ''
  confirm.require({
    message: `${verb} ${scope === 'all' ? 'all' : 'the selected'} ${t.label} sheets${forTerm}? ` +
      `${ids.length} sheet doc(s) across ${targetRows.length} row(s) will change.`,
    header: `${verb} ${t.label}`, icon: frozen ? 'pi pi-lock' : 'pi pi-lock-open',
    rejectLabel: 'Cancel', acceptLabel: verb,
    accept: async () => {
      busy.value = true
      try {
        await writeFrozen(t.collection, ids, frozen)
        toast.add({ severity: 'success', summary: frozen ? 'Frozen' : 'Unfrozen', detail: `${ids.length} sheet(s)`, life: 2000 })
      } catch (e) {
        console.error(`Could not ${verb.toLowerCase()} sheets`, e)
        toast.add({ severity: 'error', summary: `Could not ${verb.toLowerCase()}`, detail: writeErrorDetail(e), life: 4000 })
      } finally {
        busy.value = false
        await loadRows()
      }
    },
  })
}

// All four types at once: academics + co-scholastic for the selected term, and attendance +
// remarks for every class (they aren't per term).
async function confirmAllTypes(frozen) {
  if (!props.schoolId || !selectedTermId.value) return
  const verb = frozen ? 'Freeze' : 'Unfreeze'
  busy.value = true
  let plan
  try {
    plan = await Promise.all(SHEET_TYPES.map(async t => {
      const docs = await fetchSheetDocs(t.key, selectedTermId.value)
      return { type: t, ids: idsToWrite(buildRows(t.key, classes.value, docs), frozen) }
    }))
  } catch (e) {
    console.error('Could not read sheets', e)
    toast.add({ severity: 'error', summary: 'Error', detail: 'Could not read sheets', life: 3000 })
    busy.value = false
    return
  }
  busy.value = false
  const total = plan.reduce((n, p) => n + p.ids.length, 0)
  if (!total) {
    toast.add({ severity: 'info', summary: `Nothing to ${verb.toLowerCase()}`, life: 2000 })
    return
  }
  const breakdown = plan.map(p => `${p.type.label}: ${p.ids.length}`).join(', ')
  confirm.require({
    message: `${verb} all four sheet types? Academics and Co-Scholastic for ${termName(selectedTermId.value)}; ` +
      `Attendance and Remarks for the whole year (they aren't per term). ${total} sheet doc(s) will change — ${breakdown}.`,
    header: `${verb} Everything`, icon: frozen ? 'pi pi-lock' : 'pi pi-lock-open',
    rejectLabel: 'Cancel', acceptLabel: verb,
    accept: async () => {
      busy.value = true
      const failed = []
      for (const p of plan) {
        if (!p.ids.length) continue
        try {
          await writeFrozen(p.type.collection, p.ids, frozen)
        } catch (e) {
          console.error(`Could not ${verb.toLowerCase()} ${p.type.label}`, e)
          failed.push(`${p.type.label}${e?.code === 'permission-denied' ? ' (permission denied)' : ''}`)
        }
      }
      if (failed.length) {
        toast.add({ severity: 'error', summary: `Could not ${verb.toLowerCase()} everything`, detail: `Failed: ${failed.join(', ')}`, life: 6000 })
      } else {
        toast.add({ severity: 'success', summary: frozen ? 'Frozen' : 'Unfrozen', detail: `${total} sheet(s)`, life: 2000 })
      }
      busy.value = false
      await loadRows()
    },
  })
}

// ── Stray sheets ──────────────────────────────────────────────────────────
const straySheets = ref([])
const strayScanned = ref(false)
const scanningStray = ref(false)

async function scanStray() {
  if (!props.schoolId) return
  scanningStray.value = true
  try {
    const validTermIds = new Set(terms.value.map(t => t.id))
    const snap = await getDocs(schoolCollection(props.schoolId, 'smart_sheet_entries'))
    const candidates = snap.docs.filter(d => d.data().termId && !validTermIds.has(d.data().termId))
    const withCounts = await Promise.all(candidates.map(async d => {
      const entriesSnap = await getDocs(collection(d.ref, 'entries'))
      return { id: d.id, termId: d.data().termId, entryCount: entriesSnap.size }
    }))
    straySheets.value = withCounts.filter(s => s.entryCount === 0)
    strayScanned.value = true
  } catch (e) {
    console.error('Stray scan failed', e)
    toast.add({ severity: 'error', summary: 'Scan failed', life: 3000 })
  } finally {
    scanningStray.value = false
  }
}

function confirmDeleteStray(sheet) {
  confirm.require({
    message: `Delete stray sheet ${sheet.id}? This cannot be undone.`,
    header: 'Delete Stray Sheet', icon: 'pi pi-exclamation-triangle',
    rejectLabel: 'Cancel', acceptLabel: 'Delete', acceptClass: 'p-button-danger',
    accept: async () => {
      try {
        await deleteDoc(schoolDoc(props.schoolId, 'smart_sheet_entries', sheet.id))
        toast.add({ severity: 'info', summary: 'Deleted', life: 2000 })
        await scanStray()
      } catch (e) {
        toast.add({ severity: 'error', summary: 'Error', detail: 'Could not delete', life: 3000 })
      }
    },
  })
}

watch(() => props.schoolId, async () => {
  loadSeq++
  rows.value = []; selectedKeys.value = []; selectedTermId.value = null; strayScanned.value = false
  await loadStatic()
  if (!currentType.value.termScoped) await loadRows()
})
watch([selectedTermId, sheetTypeKey], loadRows)
onMounted(async () => {
  await loadStatic()
  if (!currentType.value.termScoped) await loadRows()
})
</script>
