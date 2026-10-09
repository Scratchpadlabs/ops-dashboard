<template>
  <Dialog :visible="visible" @update:visible="v => emit('update:visible', v)" header="Match with the school's student list"
          modal :style="{ width: '980px', maxWidth: '96vw' }">
    <div class="space-y-4">
      <!-- 1. File -->
      <div>
        <p class="text-xs text-slate-500 mb-2">
          Upload the student list the school sent (Excel or CSV). Students are matched by scholar / admission number,
          then by name + class, then by name alone. Nothing changes until you press Remove and confirm.
        </p>
        <div class="flex items-center gap-2 flex-wrap">
          <Button :label="fileName ? 'Choose a different file' : 'Choose file'" icon="pi pi-upload" size="small" outlined
                  :loading="parsing" @click="fileInput?.click()" />
          <span v-if="fileName" class="text-xs text-slate-600">{{ fileName }}</span>
          <input ref="fileInput" type="file" accept=".xlsx,.xls,.csv" class="hidden" @change="onFile" />
        </div>
        <div v-if="parseError" class="mt-2 text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{{ parseError }}</div>
      </div>

      <template v-if="result">
        <!-- 2. Summary -->
        <div class="grid grid-cols-2 md:grid-cols-5 gap-2">
          <div v-for="c in summary" :key="c.label" class="rounded-lg border px-3 py-2" :class="c.cls">
            <div class="text-lg font-bold">{{ c.value }}</div>
            <div class="text-[11px] leading-tight">{{ c.label }}</div>
          </div>
        </div>

        <div v-if="duplicates.length" class="text-xs text-amber-700 bg-amber-50 rounded-lg px-3 py-2">
          The school's file uses the same scholar number for different students — worth telling the school:
          <span v-for="(d, i) in duplicates" :key="i" class="block">• {{ d }}</span>
        </div>

        <!-- 3. Not in the school's file -->
        <div>
          <div class="flex items-center gap-2 mb-2 flex-wrap">
            <div class="text-sm font-bold text-slate-900 mr-auto">
              In the system but not in the school's file
              <span class="text-slate-400 font-normal">· {{ toRemove.length }} of {{ result.notInFile.length }} ticked for removal</span>
            </div>
            <Button label="Tick all" size="small" text @click="setAll(true)" />
            <Button label="Untick all" size="small" text @click="setAll(false)" />
          </div>
          <div v-if="!result.notInFile.length" class="text-sm text-emerald-700 bg-emerald-50 rounded-lg px-3 py-2">
            Every student in the system is in the school's file. Nothing to remove.
          </div>
          <DataTable v-else :value="result.notInFile" dataKey="id" size="small" stripedRows paginator :rows="10"
                     :rowsPerPageOptions="[10, 25, 100]" class="border border-slate-200 rounded-lg overflow-hidden">
            <Column style="width:44px">
              <template #body="{ data }">
                <Checkbox binary :modelValue="!kept.has(data.id)" @update:modelValue="v => toggle(data.id, v)" />
              </template>
            </Column>
            <Column field="name" header="Name" />
            <Column header="Class" style="width:140px">
              <template #body="{ data }">{{ data.currentClassId || '—' }}</template>
            </Column>
            <Column field="rollNo" header="Roll" style="width:70px" />
            <Column field="admNo" header="Adm No" style="width:110px" />
            <Column field="id" header="User ID" style="width:120px">
              <template #body="{ data }"><span class="font-mono text-xs">{{ data.id }}</span></template>
            </Column>
          </DataTable>
        </div>

        <!-- 4. Informational lists -->
        <details v-if="result.classChanged.length" class="text-sm">
          <summary class="cursor-pointer font-semibold text-slate-700">
            Found in both, but in a different class · {{ result.classChanged.length }} (kept)
          </summary>
          <div class="mt-2 max-h-56 overflow-auto text-xs border border-slate-200 rounded-lg">
            <div v-for="m in result.classChanged" :key="m.system.id" class="px-3 py-1.5 border-b border-slate-100">
              {{ m.system.name }} — system: <b>{{ m.system.currentClassId || '—' }}</b>, school file: <b>{{ m.file.className || '—' }}</b>
              <span class="text-slate-400">(matched by {{ m.by }})</span>
            </div>
          </div>
        </details>
        <details v-if="result.notInSystem.length" class="text-sm">
          <summary class="cursor-pointer font-semibold text-slate-700">
            In the school's file but not in the system · {{ result.notInSystem.length }}
          </summary>
          <div class="mt-2 flex items-center gap-2">
            <Button label="Download this list (CSV)" icon="pi pi-download" size="small" text @click="downloadMissing" />
            <span class="text-xs text-slate-400">Add them with Import CSV or Add Student.</span>
          </div>
          <div class="mt-1 max-h-56 overflow-auto text-xs border border-slate-200 rounded-lg">
            <div v-for="(f, i) in result.notInSystem" :key="i" class="px-3 py-1.5 border-b border-slate-100">
              {{ f.name }} · {{ f.className || '—' }}<template v-if="f.scholarNo"> · {{ f.scholarNo }}</template>
            </div>
          </div>
        </details>
      </template>
    </div>

    <template #footer>
      <div class="flex items-center gap-2 w-full">
        <span v-if="busyText" class="text-xs text-slate-500 mr-auto">{{ busyText }}</span>
        <span v-else class="mr-auto"></span>
        <Button label="Close" text @click="emit('update:visible', false)" />
        <Button :label="`Remove ${toRemove.length} student${toRemove.length === 1 ? '' : 's'}`" icon="pi pi-trash"
                severity="danger" :disabled="!toRemove.length || !!busyText" @click="askRemove" />
      </div>
    </template>
  </Dialog>

  <Dialog v-model:visible="confirmVisible" header="Remove students?" modal :style="{ width: '480px' }">
    <div class="space-y-3 text-sm">
      <p>
        This permanently deletes <b>{{ toRemove.length }}</b> student{{ toRemove.length === 1 ? '' : 's' }} from
        <b>{{ schoolId }}</b>. They disappear from the teacher app, pamphlets and reports.
      </p>
      <p class="text-xs text-slate-500">
        Before deleting, a backup file (JSON, every field of every removed student) is downloaded to your computer and a
        copy is saved in the ops records (student_removals).
      </p>
      <div>
        <label class="text-xs text-slate-500">Type <b>{{ confirmWord }}</b> to confirm</label>
        <InputText v-model="confirmText" class="w-full mt-1" />
      </div>
    </div>
    <template #footer>
      <Button label="Cancel" text @click="confirmVisible = false" />
      <Button label="Back up and remove" severity="danger" :disabled="confirmText.trim() !== confirmWord" @click="remove" />
    </template>
  </Dialog>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import * as XLSX from 'xlsx'
import { getDoc, writeBatch, addDoc, serverTimestamp } from 'firebase/firestore'
import { useToast } from 'primevue/usetoast'
import Dialog from 'primevue/dialog'
import Button from 'primevue/button'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import Checkbox from 'primevue/checkbox'
import InputText from 'primevue/inputtext'

import { db, auth } from '../../firebase/config'
import { opsCollection } from '../../firebase/collections.js'
import { schoolDoc } from '../../firebase/schoolCollections.js'
import { parseClassValue, normalizeSectionValue } from '../../utils/classResolver.js'
import { parseRosterRows, matchRoster, duplicateScholarNos } from '../../utils/rosterMatch.js'
import { toCsv, downloadCsv } from '../../utils/csv.js'
import { deliverFile } from '../../utils/deliverFile.js'

const props = defineProps({
  visible: Boolean,
  schoolId: { type: String, default: null },
  students: { type: Array, default: () => [] },
})
const emit = defineEmits(['update:visible', 'removed'])
const toast = useToast()

// ── File ───────────────────────────────────────────────────────────────────
const fileInput = ref(null)
const fileName = ref('')
const parsing = ref(false)
const parseError = ref('')
const fileStudents = ref([])

async function onFile(e) {
  const file = e.target.files?.[0]
  e.target.value = ''
  if (!file) return
  parsing.value = true
  parseError.value = ''
  try {
    const wb = XLSX.read(await file.arrayBuffer())
    const rows = wb.SheetNames.flatMap(n => XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: false, defval: '' }))
    const parsed = parseRosterRows(rows)
    if (!parsed.length) throw new Error('No students found — the file needs a "Name of student" (or "Name") column.')
    fileStudents.value = parsed
    fileName.value = `${file.name} · ${parsed.length} students`
  } catch (err) {
    parseError.value = err.message || 'Could not read the file'
    fileStudents.value = []
    fileName.value = ''
  } finally {
    parsing.value = false
  }
}

// ── Match ──────────────────────────────────────────────────────────────────
// "III - A", "III_A", "3 A" all meet as "3|A".
function classKey(raw) {
  const p = parseClassValue(raw || '')
  if (p.gradeCanonical === null) return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  return `${p.gradeCanonical}|${String(normalizeSectionValue(p.section) || '').toUpperCase()}`
}

const result = computed(() => (fileStudents.value.length
  ? matchRoster(fileStudents.value, props.students, classKey)
  : null))

const duplicates = computed(() => duplicateScholarNos(fileStudents.value)
  .map(list => `${list[0].scholarNo}: ${list.map(f => `${f.name} (${f.className || '—'})`).join(', ')}`))

const summary = computed(() => {
  const r = result.value
  return [
    { label: "In the school's file", value: fileStudents.value.length, cls: 'border-slate-200 text-slate-700' },
    { label: 'In the system', value: props.students.length, cls: 'border-slate-200 text-slate-700' },
    { label: 'Matched', value: r.matched.length + r.classChanged.length, cls: 'border-emerald-200 bg-emerald-50 text-emerald-800' },
    { label: 'Not in the school file', value: r.notInFile.length, cls: 'border-red-200 bg-red-50 text-red-800' },
    { label: 'Missing from the system', value: r.notInSystem.length, cls: 'border-amber-200 bg-amber-50 text-amber-800' },
  ]
})

// ── Selection: every unmatched student ticked, untick to keep ─────────────
const kept = ref(new Set())
watch(result, () => { kept.value = new Set() })
const toRemove = computed(() => (result.value?.notInFile || []).filter(s => !kept.value.has(s.id)))
function toggle(id, remove) {
  const next = new Set(kept.value)
  remove ? next.delete(id) : next.add(id)
  kept.value = next
}
function setAll(remove) {
  kept.value = remove ? new Set() : new Set((result.value?.notInFile || []).map(s => s.id))
}

function downloadMissing() {
  const rows = result.value.notInSystem.map(f => ({
    name: f.name, class: f.className, scholarNo: f.scholarNo, gender: f.gender, dob: f.dob, fileRow: f.row,
  }))
  downloadCsv(`${props.schoolId} - missing from system.csv`, toCsv(rows, Object.keys(rows[0] || { name: '' })))
}

// ── Remove ─────────────────────────────────────────────────────────────────
const confirmVisible = ref(false)
const confirmText = ref('')
const confirmWord = computed(() => `REMOVE ${toRemove.value.length}`)
const busyText = ref('')

function askRemove() {
  confirmText.value = ''
  confirmVisible.value = true
}

// Firestore Timestamps etc. → plain JSON for the backup file.
function plain(value) {
  if (value?.toDate) return { __timestamp: value.toDate().toISOString() }
  if (Array.isArray(value)) return value.map(plain)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]))
  return value
}

async function remove() {
  confirmVisible.value = false
  const list = toRemove.value
  const by = auth.currentUser?.email || 'unknown'
  try {
    // 1. Backup: the raw documents, read fresh.
    busyText.value = 'Backing up…'
    const docs = []
    for (const s of list) {
      const snap = await getDoc(schoolDoc(props.schoolId, 'students', s.id))
      if (snap.exists()) docs.push({ id: snap.id, data: plain(snap.data()) })
    }
    const backup = {
      schoolId: props.schoolId, removedAt: new Date().toISOString(), removedBy: by,
      reason: `Not in the school's student list (${fileName.value})`, students: docs,
    }
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
    deliverFile(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }),
      `${props.schoolId} - removed students backup ${stamp}.json`)
    // Firestore docs cap at 1 MB: keep the full copy when it fits, ids + names otherwise.
    const full = JSON.stringify(docs)
    await addDoc(opsCollection('student_removals'), {
      schoolId: props.schoolId, removedBy: by, removedAt: serverTimestamp(), reason: backup.reason,
      count: docs.length,
      students: full.length < 800_000 ? full : JSON.stringify(docs.map(d => ({ id: d.id, name: d.data.name, currentClassId: d.data.currentClassId }))),
      complete: full.length < 800_000,
    })

    // 2. Delete, 400 per batch.
    for (let i = 0; i < list.length; i += 400) {
      busyText.value = `Removing ${Math.min(i + 400, list.length)} / ${list.length}…`
      const batch = writeBatch(db)
      for (const s of list.slice(i, i + 400)) batch.delete(schoolDoc(props.schoolId, 'students', s.id))
      await batch.commit()
    }
    toast.add({ severity: 'success', summary: 'Students removed', detail: `${list.length} removed; backup downloaded`, life: 4000 })
    emit('removed', list.map(s => s.id))
  } catch (e) {
    console.error('Removing students failed', e)
    toast.add({ severity: 'error', summary: 'Could not remove students', detail: e.message, life: 6000 })
  } finally {
    busyText.value = ''
  }
}
</script>
