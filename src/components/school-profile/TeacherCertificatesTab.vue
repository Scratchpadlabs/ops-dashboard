<template>
  <div class="space-y-4">
    <!-- ── School + what is printed ──────────────────────────────────────── -->
    <div class="bg-white rounded-xl border border-slate-200 p-4">
      <div class="text-sm font-bold text-slate-900 mb-1">Teacher Certificates</div>
      <p class="text-xs text-slate-500 mb-4">
        Certificate of Completion for the Holistic Progress Card Workshop, one page per teacher. Long names shrink to fit
        the line, very long ones go on two lines.
      </p>

      <div class="grid gap-4 md:grid-cols-3">
        <div>
          <label class="form-label">Teacher-app school</label>
          <Select
            v-model="appSchoolId" :options="appSchoolOptions" optionLabel="label" optionValue="value"
            filter placeholder="Pick the school whose teachers to use" class="w-full"
            :loading="loadingSchools" @change="onAppSchoolPicked"
          />
          <p v-if="linkHint" class="text-xs mt-1" :class="linkHint.cls">{{ linkHint.text }}</p>
        </div>
        <div>
          <label class="form-label">School (printed, as typed)</label>
          <InputText v-model="printedSchool" class="w-full" placeholder="Navodaya Central School, Raichur" />
          <p class="text-xs text-slate-400 mt-1">Printed in bold: "as part of {{ printedSchool || '…' }}, during the academic year …"</p>
        </div>
        <div>
          <label class="form-label">Academic year</label>
          <InputText v-model="academicYear" class="w-full" placeholder="2025-26" />
        </div>
      </div>
    </div>

    <div v-if="loadingStaff" class="flex items-center justify-center py-10">
      <ProgressSpinner style="width:28px;height:28px" />
    </div>
    <div v-else-if="staffError" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{{ staffError }}</div>

    <!-- ── Teachers ───────────────────────────────────────────────────────── -->
    <div v-else-if="appSchoolId" class="bg-white rounded-xl border border-slate-200 p-4">
      <div class="flex items-center gap-2 flex-wrap mb-3">
        <div class="text-sm font-bold text-slate-900 mr-auto">
          Teachers <span class="text-slate-400 font-normal">· {{ selectedTeachers.length }} of {{ allPeople.length }} selected</span>
        </div>
        <IconField class="w-64">
          <InputIcon class="pi pi-search" />
          <InputText v-model="search" placeholder="Search name or type…" class="w-full" size="small" />
        </IconField>
        <Button :label="search ? 'Tick shown' : 'Tick all'" size="small" text @click="setIncluded(visible, true)" />
        <Button :label="search ? 'Untick shown' : 'Untick all'" size="small" text @click="setIncluded(visible, false)" />
      </div>

      <div v-if="!allPeople.length" class="text-center text-sm text-slate-400 py-8">
        No teachers for this school yet — add them in School Setup → Teachers, or type names below.
      </div>
      <div v-else class="rounded-lg border border-slate-200 overflow-hidden">
        <DataTable :value="visible" dataKey="key" size="small" stripedRows paginator :rows="25" :rowsPerPageOptions="[25, 50, 100]">
          <Column style="width:44px">
            <template #body="{ data }">
              <Checkbox binary :modelValue="!excluded.has(data.key)" @update:modelValue="v => setIncluded([data], v)" />
            </template>
          </Column>
          <Column field="name" header="Name">
            <template #body="{ data }">
              <span class="text-sm text-slate-800">{{ data.name }}</span>
              <span v-if="data.extra" class="ml-2 text-[10px] font-semibold text-amber-700 bg-amber-100 rounded-full px-1.5 py-0.5">ADDED HERE</span>
            </template>
          </Column>
          <Column field="type" header="Type" style="width:120px" />
          <Column header="On the certificate" style="width:46%">
            <template #body="{ data }">
              <span class="text-xs tracking-wide text-slate-500">{{ printedName(data.name) }}</span>
            </template>
          </Column>
          <Column style="width:60px">
            <template #body="{ data }">
              <Button icon="pi pi-download" text rounded size="small" title="Download this certificate"
                      :loading="busy === 'one:' + data.key" :disabled="!canGenerate || !!busy" @click="generate('one', data)" />
            </template>
          </Column>
        </DataTable>
        <div v-if="!visible.length" class="text-center text-sm text-slate-400 py-6">No one matches "{{ search }}".</div>
      </div>

      <div class="mt-4">
        <label class="form-label">Add names not in the list (one per line)</label>
        <Textarea v-model="extraNames" class="w-full" rows="2" autoResize placeholder="e.g. a guest teacher who attended the workshop" />
      </div>

      <div v-if="warnings.length" class="mt-3 text-xs text-amber-700 bg-amber-50 rounded-lg px-3 py-2 space-y-0.5">
        <div v-for="w in warnings" :key="w">{{ w }}</div>
      </div>
    </div>

    <!-- ── Generate ───────────────────────────────────────────────────────── -->
    <div class="bg-white rounded-xl border border-slate-200 p-4 space-y-3">
      <div class="flex items-center gap-2 flex-wrap">
        <Button :label="`Download certificates (${selectedTeachers.length})`" icon="pi pi-download"
                :loading="busy === 'all'" :disabled="!canGenerate || !selectedTeachers.length || !!busy" @click="generate('all')" />
        <span v-if="progress" class="text-xs text-slate-500">{{ progress }}</span>
        <span v-else-if="!canGenerate" class="text-xs text-amber-600">Add the school name and academic year first.</span>
      </div>
      <div class="flex items-end gap-3 flex-wrap pt-3 border-t border-slate-100">
        <div>
          <label class="form-label">Blank certificates</label>
          <InputNumber v-model="blankCount" :min="1" :max="200" showButtons class="w-32" inputClass="w-full" />
        </div>
        <Button label="Download blank" icon="pi pi-file" outlined :loading="busy === 'blank'"
                :disabled="!canGenerate || !!busy" @click="generate('blank')" />
        <span class="text-xs text-slate-400">School and year printed, name left blank to write by hand.</span>
      </div>
      <div v-if="pendingFile" class="flex items-center gap-3 bg-emerald-50 rounded-lg px-3 py-2">
        <i class="pi pi-check-circle text-emerald-600"></i>
        <div class="min-w-0 flex-1 text-xs text-slate-700 break-all">{{ pendingFile.name }} is ready</div>
        <Button label="Save" icon="pi pi-download" size="small" @click="savePending" />
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { getDocs, query, orderBy, limit, updateDoc, serverTimestamp } from 'firebase/firestore'
import { useToast } from 'primevue/usetoast'
import Select from 'primevue/select'
import InputText from 'primevue/inputtext'
import InputNumber from 'primevue/inputnumber'
import Textarea from 'primevue/textarea'
import Button from 'primevue/button'
import Checkbox from 'primevue/checkbox'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import IconField from 'primevue/iconfield'
import InputIcon from 'primevue/inputicon'
import ProgressSpinner from 'primevue/progressspinner'

import { auth } from '../../firebase/config'
import { opsDoc } from '../../firebase/collections.js'
import { rootSchoolsCollection, schoolCollection } from '../../firebase/schoolCollections.js'
import { effectiveAcademicYear } from '../../composables/useAcademicYear.js'
import { pendingFile, savePending, deliverFile } from '../../utils/deliverFile.js'
import { guessAppSchool } from '../../utils/studentPamphletPDF.js'
import {
  buildTeacherCertificatesPDF, loadCertificateAssets, certificateFilename, hasUnprintable, defaultPrintedSchool,
} from '../../utils/teacherCertificatePDF.js'

const props = defineProps({
  school: { type: Object, required: true },   // ops-dashboard school record
})
const emit = defineEmits(['linked'])
const toast = useToast()

// ── Teacher-app school link (shared with Student Pamphlets: app_school_id) ──
const appSchools = ref([])
const loadingSchools = ref(false)
const appSchoolId = ref(null)
const guessed = ref(false)

const appSchoolOptions = computed(() =>
  appSchools.value.map(s => ({ value: s.id, label: s.name ? `${s.name} (${s.id})` : s.id })))
const linkHint = computed(() => {
  if (!appSchoolId.value) return { cls: 'text-amber-600', text: 'Not linked yet — pick the school once and it is remembered.' }
  if (guessed.value) return { cls: 'text-amber-600', text: 'Matched by name — check it is the right school.' }
  return null
})

async function loadAppSchools() {
  loadingSchools.value = true
  try {
    const snap = await getDocs(query(rootSchoolsCollection(), orderBy('name'), limit(500)))
    appSchools.value = snap.docs.map(d => ({ ...d.data(), id: d.id }))
    const saved = props.school.app_school_id
    if (saved && appSchools.value.some(s => s.id === saved)) {
      appSchoolId.value = saved
    } else {
      const guess = guessAppSchool(props.school.name, appSchools.value)
      if (guess) { appSchoolId.value = guess.id; guessed.value = true }
    }
  } catch (e) {
    toast.add({ severity: 'error', summary: 'Could not load schools', detail: e.message, life: 4000 })
  } finally {
    loadingSchools.value = false
  }
}

async function onAppSchoolPicked() {
  guessed.value = false
  if (!appSchoolId.value) return
  try {
    await updateDoc(opsDoc('schools', props.school.id), {
      app_school_id: appSchoolId.value,
      updated_at: serverTimestamp(),
      updated_by: auth.currentUser?.email || 'unknown',
    })
    emit('linked', appSchoolId.value)
  } catch (e) {
    console.error('Could not save teacher-app school link', e)
  }
}

// ── What is printed ───────────────────────────────────────────────────────
const printedSchool = ref(defaultPrintedSchool(props.school))
const academicYear = ref(effectiveAcademicYear())
const canGenerate = computed(() => !!printedSchool.value.trim() && !!academicYear.value.trim())

// ── Teachers ──────────────────────────────────────────────────────────────
const staff = ref([])
const loadingStaff = ref(false)
const staffError = ref('')
const extraNames = ref('')
const excluded = ref(new Set())
const search = ref('')

async function loadStaff(id) {
  staff.value = []
  excluded.value = new Set()
  staffError.value = ''
  if (!id) return
  loadingStaff.value = true
  try {
    const snap = await getDocs(query(schoolCollection(id, 'staffs'), orderBy('name')))
    staff.value = snap.docs
      .map(d => ({ key: d.id, name: String(d.data().name || '').trim(), type: d.data().type || 'teacher' }))
      .filter(s => s.name)
  } catch (e) {
    staffError.value = `Could not load teachers: ${e.message}`
  } finally {
    loadingStaff.value = false
  }
}
watch(appSchoolId, loadStaff)

const extraPeople = computed(() => extraNames.value.split('\n').map(n => n.trim()).filter(Boolean)
  .map((name, i) => ({ key: `extra:${i}:${name}`, name, type: '—', extra: true })))
const allPeople = computed(() => [...staff.value, ...extraPeople.value])
const visible = computed(() => {
  const q = search.value.trim().toLowerCase()
  return q ? allPeople.value.filter(p => `${p.name} ${p.type}`.toLowerCase().includes(q)) : allPeople.value
})
const selectedTeachers = computed(() => allPeople.value.filter(p => !excluded.value.has(p.key)))

function setIncluded(list, on) {
  const next = new Set(excluded.value)
  for (const p of list) on ? next.delete(p.key) : next.add(p.key)
  excluded.value = next
}
const printedName = (name) => String(name || '').replace(/\s+/g, ' ').trim().toUpperCase()

const warnings = computed(() => {
  const out = []
  const odd = selectedTeachers.value.filter(p => hasUnprintable(p.name)).length
  if (odd) out.push(`${odd} name${odd === 1 ? ' uses' : 's use'} non-English letters — those letters can't be printed in the certificate font and are left out. Fix the names in School Setup → Teachers.`)
  const dupes = new Set()
  const seen = new Set()
  for (const p of selectedTeachers.value) {
    const k = printedName(p.name)
    if (seen.has(k)) dupes.add(p.name)
    seen.add(k)
  }
  if (dupes.size) out.push(`Listed twice: ${[...dupes].join(', ')}.`)
  return out
})

// ── Generate ──────────────────────────────────────────────────────────────
const busy = ref('')
const progress = ref('')
const blankCount = ref(5)
let assetsPromise = null

async function build(teachers) {
  assetsPromise ||= loadCertificateAssets(import.meta.env.BASE_URL || '/')
  const assets = await assetsPromise.catch(e => { assetsPromise = null; throw e })
  return buildTeacherCertificatesPDF({
    teachers,
    schoolName: printedSchool.value,
    academicYear: academicYear.value,
    assets,
    onProgress: (done, total) => { progress.value = `${done} / ${total}…` },
  })
}

async function generate(kind, person = null) {
  busy.value = kind === 'one' ? `one:${person.key}` : kind
  progress.value = 'Loading…'
  const school = printedSchool.value
  try {
    let list, suffix
    if (kind === 'one') { list = [person]; suffix = person.name }
    else if (kind === 'blank') { list = Array.from({ length: blankCount.value || 1 }, () => ({ name: '' })); suffix = 'Blank' }
    else { list = selectedTeachers.value; suffix = '' }
    const bytes = await build(list)
    deliverFile(new Blob([bytes], { type: 'application/pdf' }), certificateFilename(school, suffix))
    toast.add({ severity: 'success', summary: 'Certificates ready', detail: `${list.length} page${list.length === 1 ? '' : 's'}`, life: 2500 })
  } catch (e) {
    console.error('Certificate generation failed', e)
    toast.add({ severity: 'error', summary: 'Could not generate certificates', detail: e.message, life: 5000 })
  } finally {
    busy.value = ''
    progress.value = ''
  }
}

onMounted(loadAppSchools)
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
