<template>
  <div class="space-y-4">
    <!-- ── Which teacher-app school + what goes on the pamphlet ─────────── -->
    <div class="bg-white rounded-xl border border-slate-200 p-4">
      <div class="text-sm font-bold text-slate-900 mb-1">Student Login Pamphlets</div>
      <p class="text-xs text-slate-500 mb-4">
        One pamphlet per student with their name, roll no, class, User ID / Password and the school website as a QR code.
        Nursery – Grade 2 get the Foundational design (English front, Hindi back); Grade 3 and above get Middle + Prep.
      </p>

      <div class="grid gap-4 md:grid-cols-3">
        <div>
          <label class="form-label">Teacher-app school</label>
          <Select
            v-model="appSchoolId" :options="appSchoolOptions" optionLabel="label" optionValue="value"
            filter placeholder="Pick the school whose students to use" class="w-full"
            :loading="loadingSchools" @change="onAppSchoolPicked"
          />
          <p v-if="linkHint" class="text-xs mt-1" :class="linkHint.cls">{{ linkHint.text }}</p>
        </div>
        <div>
          <label class="form-label">Website (printed + QR)</label>
          <InputText v-model="website" class="w-full font-mono text-sm" placeholder="www.school.myhpc.app" />
          <p class="text-xs mt-1" :class="website ? 'text-slate-400' : 'text-amber-600'">
            <template v-if="!website && appSchoolId && websitesLoaded">No website linked — type it, or link one on Tools → School Websites.</template>
            <template v-else-if="qrTarget(website)">QR opens {{ qrTarget(website) }}</template>
          </p>
        </div>
        <div>
          <label class="form-label">School name (footer)</label>
          <InputText v-model="footerName" class="w-full" />
        </div>
      </div>
    </div>

    <div v-if="loadingRoster" class="flex items-center justify-center py-10">
      <ProgressSpinner style="width:28px;height:28px" />
    </div>

    <div v-else-if="rosterError" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{{ rosterError }}</div>

    <template v-else-if="appSchoolId">
      <!-- ── Classes ──────────────────────────────────────────────────────── -->
      <div class="bg-white rounded-xl border border-slate-200 p-4">
        <div class="flex items-center gap-2 flex-wrap mb-3">
          <div class="text-sm font-bold text-slate-900 mr-auto">
            Classes <span class="text-slate-400 font-normal">· {{ selectedStudents.length }} of {{ students.length }} students selected</span>
          </div>
          <Select v-model="designOverride" :options="overrideOptions" optionLabel="label" optionValue="value" class="w-72" />
          <Button label="All" size="small" text @click="selectAll(true)" />
          <Button label="None" size="small" text @click="selectAll(false)" />
        </div>

        <div v-if="!classRows.length" class="text-center text-sm text-slate-400 py-8">
          This school has no students yet — add them in School Setup → Students.
        </div>
        <div v-else class="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <label
            v-for="row in classRows" :key="row.classId"
            class="flex items-center gap-2 rounded-lg border px-3 py-2 cursor-pointer transition-colors"
            :class="selectedClassIds.includes(row.classId) ? 'border-blue-300 bg-blue-50/50' : 'border-slate-200 hover:border-slate-300'"
          >
            <Checkbox v-model="selectedClassIds" :value="row.classId" />
            <div class="min-w-0 flex-1">
              <div class="text-sm font-medium text-slate-800 truncate">{{ row.className }}</div>
              <div class="text-xs text-slate-400">{{ row.count }} student{{ row.count === 1 ? '' : 's' }}</div>
            </div>
            <span class="text-[10px] font-semibold px-1.5 py-0.5 rounded" :class="designChip(designFor(row)).cls"
                  :title="row.design ? '' : 'Grade not recognised — using Middle + Prep'">
              {{ designChip(designFor(row)).label }}<template v-if="!row.design && designOverride === 'auto'">?</template>
            </span>
          </label>
        </div>

        <div v-if="warnings.length" class="mt-3 text-xs text-amber-700 bg-amber-50 rounded-lg px-3 py-2 space-y-0.5">
          <div v-for="w in warnings" :key="w">{{ w }}</div>
        </div>
      </div>

      <!-- ── Generate ─────────────────────────────────────────────────────── -->
      <div class="bg-white rounded-xl border border-slate-200 p-4 flex items-center gap-2 flex-wrap">
        <Button label="Download PDF" icon="pi pi-download" :loading="busy === 'pdf'" :disabled="!canGenerate || !!busy" @click="generate('pdf')" />
        <Button label="One PDF per class (ZIP)" icon="pi pi-folder" outlined :loading="busy === 'zip'" :disabled="!canGenerate || !!busy" @click="generate('zip')" />
        <Button label="Sample (first student)" icon="pi pi-eye" text :loading="busy === 'sample'" :disabled="!canGenerate || !!busy" @click="generate('sample')" />
        <span v-if="progress" class="text-xs text-slate-500">{{ progress }}</span>
        <span v-else-if="!website" class="text-xs text-amber-600">Add the website first.</span>
        <span v-else-if="!footerName.trim()" class="text-xs text-amber-600">Add the school name first.</span>

        <div v-if="pendingFile" class="w-full flex items-center gap-3 bg-emerald-50 rounded-lg px-3 py-2 mt-1">
          <i class="pi pi-check-circle text-emerald-600"></i>
          <div class="min-w-0 flex-1 text-xs text-slate-700 break-all">{{ pendingFile.name }} is ready</div>
          <Button label="Save" icon="pi pi-download" size="small" @click="savePending" />
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { getDocs, query, orderBy, limit, updateDoc, serverTimestamp } from 'firebase/firestore'
import { useToast } from 'primevue/usetoast'
import Select from 'primevue/select'
import InputText from 'primevue/inputtext'
import Button from 'primevue/button'
import Checkbox from 'primevue/checkbox'
import ProgressSpinner from 'primevue/progressspinner'
import JSZip from 'jszip'

import { auth } from '../../firebase/config'
import { opsDoc } from '../../firebase/collections.js'
import { rootSchoolsCollection, schoolCollection } from '../../firebase/schoolCollections.js'
import { useSchoolWebsites, primaryUrl } from '../../composables/useSchoolWebsites.js'
import { parseClassValue, compareClasses } from '../../utils/classResolver.js'
import { pendingFile, savePending, deliverFile } from '../../utils/deliverFile.js'
import {
  buildStudentPamphletsPDF, loadPamphletAssets, designForGrade, compareStudents,
  displayWebsite, qrTarget, guessAppSchool, pamphletFilename,
} from '../../utils/studentPamphletPDF.js'

const props = defineProps({
  school: { type: Object, required: true },   // ops-dashboard school record
})
const emit = defineEmits(['linked'])
const toast = useToast()

// ── Teacher-app school link ───────────────────────────────────────────────
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
    // Doc id after the spread: root school docs carry their own `id` field.
    appSchools.value = snap.docs.map(d => ({ ...d.data(), id: d.id }))
    const saved = props.school.app_school_id
    if (saved && appSchools.value.some(s => s.id === saved)) {
      appSchoolId.value = saved
    } else {
      const guess = guessAppSchool(props.school.name, appSchools.value)
      if (guess) { appSchoolId.value = guess.id; guessed.value = true }
    }
  } catch (e) {
    console.error('Could not load teacher-app schools', e)
    toast.add({ severity: 'error', summary: 'Could not load schools', detail: e.message, life: 4000 })
  } finally {
    loadingSchools.value = false
  }
}

async function rememberLink(id) {
  try {
    await updateDoc(opsDoc('schools', props.school.id), {
      app_school_id: id,
      updated_at: serverTimestamp(),
      updated_by: auth.currentUser?.email || 'unknown',
    })
    emit('linked', id)
  } catch (e) {
    console.error('Could not save teacher-app school link', e)
  }
}

function onAppSchoolPicked() {
  guessed.value = false
  if (appSchoolId.value) rememberLink(appSchoolId.value)
}

// ── Website + footer ──────────────────────────────────────────────────────
const { sitesFor, load: loadWebsites, loaded: websitesLoaded } = useSchoolWebsites()
const website = ref('')
const footerName = ref(props.school.name || '')

function prefillWebsite() {
  const site = sitesFor(appSchoolId.value)[0]
  website.value = site ? displayWebsite(primaryUrl(site)) : ''
}
watch([appSchoolId, websitesLoaded], prefillWebsite)

// ── Roster ────────────────────────────────────────────────────────────────
const students = ref([])
const classes = ref([])
const loadingRoster = ref(false)
const rosterError = ref('')
const selectedClassIds = ref([])

async function loadRoster(id) {
  students.value = []
  classes.value = []
  selectedClassIds.value = []
  rosterError.value = ''
  if (!id) return
  loadingRoster.value = true
  try {
    const [sSnap, cSnap] = await Promise.all([
      getDocs(schoolCollection(id, 'students')),
      getDocs(schoolCollection(id, 'classes')),
    ])
    students.value = sSnap.docs.map(d => ({ ...d.data(), id: d.id }))
    classes.value = cSnap.docs.map(d => ({ ...d.data(), id: d.id }))
    selectedClassIds.value = classRows.value.map(r => r.classId)
  } catch (e) {
    rosterError.value = `Could not load students: ${e.message}`
  } finally {
    loadingRoster.value = false
  }
}
watch(appSchoolId, loadRoster)

const NO_CLASS = '__none__'

function classLabel(classId) {
  if (classId === NO_CLASS) return 'No class'
  const c = classes.value.find(x => x.id === classId)
  if (c?.name) return c.name
  if (c?.clazz) return [c.clazz, c.section].filter(Boolean).join(' ')
  return String(classId).replace(/_/g, ' ')
}

function classDesign(classId) {
  if (classId === NO_CLASS) return null
  const c = classes.value.find(x => x.id === classId)
  const parsed = parseClassValue(c?.clazz || classId)
  return designForGrade(parsed.gradeOrdinal)
}

const classRows = computed(() => {
  const counts = new Map()
  for (const s of students.value) {
    const cid = s.currentClassId || NO_CLASS
    counts.set(cid, (counts.get(cid) || 0) + 1)
  }
  return [...counts.entries()]
    .map(([classId, count]) => ({ classId, count, className: classLabel(classId), design: classDesign(classId) }))
    .sort((a, b) => (a.classId === NO_CLASS) - (b.classId === NO_CLASS) || compareClasses(a.classId, b.classId))
})

// ── Design ────────────────────────────────────────────────────────────────
const designOverride = ref('auto')
const overrideOptions = [
  { value: 'auto', label: 'Design: by grade (recommended)' },
  { value: 'foundational', label: 'Design: Foundational for all' },
  { value: 'middle', label: 'Design: Middle + Prep for all' },
]
function designFor(row) {
  if (designOverride.value !== 'auto') return designOverride.value
  return row.design || 'middle'
}
function designChip(design) {
  return design === 'foundational'
    ? { label: 'Foundational', cls: 'bg-violet-100 text-violet-700' }
    : { label: 'Middle + Prep', cls: 'bg-sky-100 text-sky-700' }
}

function selectAll(on) {
  selectedClassIds.value = on ? classRows.value.map(r => r.classId) : []
}

// ── What gets printed ─────────────────────────────────────────────────────
const selectedStudents = computed(() => {
  const rows = new Map(classRows.value.map(r => [r.classId, r]))
  const chosen = new Set(selectedClassIds.value)
  return students.value
    .map(s => ({ ...s, classId: s.currentClassId || NO_CLASS }))
    .filter(s => chosen.has(s.classId))
    .map(s => {
      const row = rows.get(s.classId)
      return {
        id: s.id,
        name: s.name || '',
        rollNo: s.rollNo ?? '',
        classId: s.classId,
        className: s.classId === NO_CLASS ? '' : row.className,
        design: designFor(row),
      }
    })
    .sort((a, b) => compareStudents(a, b, (x, y) =>
      (x === NO_CLASS) - (y === NO_CLASS) || compareClasses(x, y)))
})

const warnings = computed(() => {
  const out = []
  const chosen = selectedStudents.value
  const unknown = classRows.value.filter(r => selectedClassIds.value.includes(r.classId) && !r.design && r.classId !== NO_CLASS)
  if (designOverride.value === 'auto' && unknown.length) {
    out.push(`Grade not recognised for ${unknown.map(r => r.className).join(', ')} — these use Middle + Prep. Pick a design above to override.`)
  }
  const noName = chosen.filter(s => !s.name.trim()).length
  if (noName) out.push(`${noName} student${noName === 1 ? ' has' : 's have'} no name — the header will show only roll no and class.`)
  const noRoll = chosen.filter(s => !String(s.rollNo).trim()).length
  if (noRoll) out.push(`${noRoll} student${noRoll === 1 ? ' has' : 's have'} no roll number.`)
  // The pamphlet fonts are Latin-only; anything else is left out of the header.
  const nonLatin = chosen.filter(s => /[^\u0000-\u024F\u2018-\u201D]/.test(s.name)).length
  if (nonLatin) out.push(`${nonLatin} name${nonLatin === 1 ? '' : 's'} use non-English letters (e.g. Hindi script) — those letters are left out. Fix the names in School Setup → Students.`)
  if (chosen.some(s => s.classId === NO_CLASS)) out.push('Some students have no class — they are printed last, without a class.')
  return out
})

const canGenerate = computed(() =>
  selectedStudents.value.length > 0 && !!displayWebsite(website.value) && !!footerName.value.trim())

// ── Generate ──────────────────────────────────────────────────────────────
const busy = ref('')
const progress = ref('')
let assetsPromise = null

async function build(list, label) {
  assetsPromise ||= loadPamphletAssets(import.meta.env.BASE_URL || '/')
  const assets = await assetsPromise.catch(e => { assetsPromise = null; throw e })
  return buildStudentPamphletsPDF({
    students: list,
    schoolName: footerName.value.trim(),
    website: website.value,
    assets,
    onProgress: (done, total) => { progress.value = `${label}${done} / ${total} students…` },
  })
}

async function generate(kind) {
  busy.value = kind
  progress.value = 'Loading templates…'
  const school = footerName.value.trim()
  try {
    if (kind === 'sample') {
      const bytes = await build(selectedStudents.value.slice(0, 1), '')
      deliverFile(new Blob([bytes], { type: 'application/pdf' }), pamphletFilename(school, 'Sample'))
    } else if (kind === 'pdf') {
      const bytes = await build(selectedStudents.value, '')
      deliverFile(new Blob([bytes], { type: 'application/pdf' }), pamphletFilename(school))
    } else {
      const zip = new JSZip()
      const byClass = new Map()
      for (const s of selectedStudents.value) {
        if (!byClass.has(s.classId)) byClass.set(s.classId, [])
        byClass.get(s.classId).push(s)
      }
      let i = 0
      for (const [classId, list] of byClass) {
        i++
        const bytes = await build(list, `Class ${i} / ${byClass.size}: `)
        zip.file(pamphletFilename(school, classLabel(classId)), bytes)
      }
      progress.value = 'Zipping…'
      const blob = await zip.generateAsync({ type: 'blob' })
      deliverFile(blob, pamphletFilename(school).replace(/\.pdf$/, '.zip'))
    }
    toast.add({ severity: 'success', summary: 'Pamphlets ready', life: 2500,
      detail: kind === 'sample' ? 'Sample for the first student' : `${selectedStudents.value.length} students` })
  } catch (e) {
    console.error('Pamphlet generation failed', e)
    toast.add({ severity: 'error', summary: 'Could not generate pamphlets', detail: e.message, life: 5000 })
  } finally {
    busy.value = ''
    progress.value = ''
  }
}

onMounted(() => {
  loadAppSchools()
  loadWebsites()
})
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
