<template>
  <div class="pt-4">
    <div class="flex items-center justify-between mb-3">
      <div class="flex items-center gap-3">
        <div class="text-sm font-bold text-slate-900">Sheets Status</div>
        <Select v-model="selectedTermId" :options="terms" optionLabel="name" optionValue="id" placeholder="Select a term" class="w-56" />
      </div>
      <Button label="Freeze All For Term" icon="pi pi-lock" size="small" outlined :disabled="!selectedTermId || !rows.length" @click="confirmFreezeAll" />
    </div>

    <div v-if="!selectedTermId" class="text-center text-sm text-slate-400 py-10 bg-white rounded-xl border border-slate-200">
      Select a term to view sheet status.
    </div>
    <div v-else-if="loading" class="flex items-center justify-center py-10">
      <ProgressSpinner style="width:28px;height:28px" />
    </div>
    <div v-else class="bg-white rounded-xl border border-slate-200 overflow-hidden mb-6">
      <DataTable :value="rows" size="small" stripedRows>
        <Column field="classId" header="Class" />
        <Column field="subjectId" header="Subject" />
        <Column header="Exists" style="width:70px">
          <template #body="{ data }"><i :class="data.exists ? 'pi pi-check-circle text-emerald-500' : 'pi pi-circle text-slate-300'"></i></template>
        </Column>
        <Column field="entryCount" header="Entries" style="width:80px" />
        <Column header="Last Edited" style="width:160px">
          <template #body="{ data }"><span class="text-xs text-slate-500">{{ formatDate(data.lastEditedAt) }}</span></template>
        </Column>
        <Column header="By" style="width:140px">
          <template #body="{ data }"><span class="text-xs text-slate-500">{{ resolveStaff(data.lastEditedBy) }}</span></template>
        </Column>
        <Column header="Frozen" style="width:90px">
          <template #body="{ data }">
            <Button
              v-if="data.exists"
              :icon="data.isFrozen ? 'pi pi-lock' : 'pi pi-lock-open'"
              text rounded size="small"
              @click="toggleFrozen(data)"
            />
          </template>
        </Column>
      </DataTable>
      <div v-if="!rows.length" class="text-center text-sm text-slate-400 py-8">No class/subject combinations for this term</div>
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
import { ref, watch, onMounted } from 'vue'
import { getDocs, query, where, collection, writeBatch, deleteDoc } from 'firebase/firestore'
import { useConfirm } from 'primevue/useconfirm'
import { useToast } from 'primevue/usetoast'

import Button from 'primevue/button'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import Select from 'primevue/select'
import ProgressSpinner from 'primevue/progressspinner'

import { schoolCollection, schoolDoc } from '../../firebase/schoolCollections.js'
import { db } from '../../firebase/config'

const props = defineProps({ schoolId: { type: String, default: null } })
const confirm = useConfirm()
const toast = useToast()

const terms = ref([])
const classes = ref([])
const staffs = ref([])
const selectedTermId = ref(null)
const rows = ref([])
const loading = ref(false)

function resolveStaff(idOrEmail) {
  if (!idOrEmail) return '—'
  const match = staffs.value.find(s => s.id === idOrEmail || s.authUid === idOrEmail)
  return match?.name || idOrEmail
}
function formatDate(ts) {
  if (!ts) return '—'
  const d = ts.toDate ? ts.toDate() : new Date(ts)
  return d.toLocaleString()
}

async function loadStatic() {
  if (!props.schoolId) { terms.value = []; classes.value = []; staffs.value = []; return }
  try {
    const [tSnap, cSnap, stSnap] = await Promise.all([
      getDocs(schoolCollection(props.schoolId, 'terms')),
      getDocs(schoolCollection(props.schoolId, 'classes')),
      getDocs(schoolCollection(props.schoolId, 'staffs')),
    ])
    terms.value = tSnap.docs.map(d => ({ id: d.id, ...d.data() }))
    classes.value = cSnap.docs.map(d => ({ id: d.id, ...d.data() }))
    staffs.value = stSnap.docs.map(d => ({ id: d.id, ...d.data() }))
  } catch (e) {
    console.error('Could not load terms/classes/staffs', e)
  }
}

async function loadRows() {
  if (!props.schoolId || !selectedTermId.value) { rows.value = []; return }
  loading.value = true
  try {
    const snap = await getDocs(query(schoolCollection(props.schoolId, 'smart_sheet_entries'), where('termId', '==', selectedTermId.value)))
    const sheetByKey = new Map()
    snap.docs.forEach(d => sheetByKey.set(`${d.data().classId}_${d.data().subjectId}`, { id: d.id, ref: d.ref, ...d.data() }))

    const combos = []
    classes.value.forEach(cls => {
      ;(cls.subjects || []).forEach(s => combos.push({ classId: cls.id, subjectId: s.subjectId }))
    })

    const built = await Promise.all(combos.map(async ({ classId, subjectId }) => {
      const sheet = sheetByKey.get(`${classId}_${subjectId}`)
      if (!sheet) return { classId, subjectId, exists: false, entryCount: 0, lastEditedAt: null, lastEditedBy: null, isFrozen: false }
      const entriesSnap = await getDocs(collection(sheet.ref, 'entries'))
      return {
        classId, subjectId, exists: true, entryCount: entriesSnap.size,
        lastEditedAt: sheet.lastEditedAt || null, lastEditedBy: sheet.lastEditedBy || null,
        isFrozen: !!sheet.isFrozen, sheetId: sheet.id,
      }
    }))
    rows.value = built.sort((a, b) => a.classId.localeCompare(b.classId) || a.subjectId.localeCompare(b.subjectId))
  } catch (e) {
    console.error('Could not load sheet status', e)
    rows.value = []
  } finally {
    loading.value = false
  }
}

async function toggleFrozen(row) {
  try {
    await writeBatchUpdate(row.sheetId, { isFrozen: !row.isFrozen })
    row.isFrozen = !row.isFrozen
  } catch (e) {
    toast.add({ severity: 'error', summary: 'Error', detail: 'Could not update', life: 3000 })
  }
}

async function writeBatchUpdate(sheetId, fields) {
  const batch = writeBatch(db)
  batch.update(schoolDoc(props.schoolId, 'smart_sheet_entries', sheetId), fields)
  await batch.commit()
}

function confirmFreezeAll() {
  const toFreeze = rows.value.filter(r => r.exists && !r.isFrozen)
  if (!toFreeze.length) { toast.add({ severity: 'info', summary: 'Nothing to freeze', life: 2000 }); return }
  confirm.require({
    message: `Freeze ${toFreeze.length} sheet(s) for this term?`,
    header: 'Freeze All', icon: 'pi pi-lock',
    rejectLabel: 'Cancel', acceptLabel: 'Freeze',
    accept: async () => {
      try {
        const chunks = []
        for (let i = 0; i < toFreeze.length; i += 450) chunks.push(toFreeze.slice(i, i + 450))
        for (const chunk of chunks) {
          const batch = writeBatch(db)
          chunk.forEach(r => batch.update(schoolDoc(props.schoolId, 'smart_sheet_entries', r.sheetId), { isFrozen: true }))
          await batch.commit()
        }
        toast.add({ severity: 'success', summary: 'Frozen', life: 2000 })
        await loadRows()
      } catch (e) {
        toast.add({ severity: 'error', summary: 'Error', detail: 'Could not freeze all', life: 3000 })
      }
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

watch(() => props.schoolId, () => { loadStatic(); rows.value = []; selectedTermId.value = null; strayScanned.value = false })
watch(selectedTermId, loadRows)
onMounted(loadStatic)
</script>
