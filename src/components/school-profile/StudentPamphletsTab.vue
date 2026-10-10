<template>
  <div class="space-y-4">
    <!-- ── Which teacher-app school + what goes on the pamphlet ─────────── -->
    <div class="bg-white rounded-xl border border-slate-200 p-4">
      <div class="text-sm font-bold text-slate-900 mb-1">Student Login Pamphlets</div>
      <p class="text-xs text-slate-500 mb-4">
        One pamphlet per student with their name, roll no, class, User ID / Password and the school website as a QR code.
        Nursery – Grade 2 get the Foundational design (English front, Hindi or Marathi back); Grade 3 and above get Middle + Prep.
      </p>

      <div class="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
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
          <label class="form-label">School name (printed at the top, as typed)</label>
          <InputText v-model="printedSchoolName" class="w-full" />
        </div>
        <div>
          <label class="form-label">Foundational back page</label>
          <Select v-model="foundationalBack" :options="FOUNDATIONAL_BACK_LANGUAGES" optionLabel="label" optionValue="value" class="w-full" />
          <p class="text-xs text-slate-400 mt-1">Front is always English. Middle + Prep is English only.</p>
        </div>
      </div>

      <!-- Logo -->
      <div class="mt-4 pt-4 border-t border-slate-100">
        <label class="form-label">School logo (printed at the top)</label>
        <div class="flex items-start gap-3 flex-wrap">
          <div class="w-28 h-20 rounded-lg border border-slate-200 bg-white flex items-center justify-center overflow-hidden p-1.5 shrink-0">
            <ProgressSpinner v-if="logoBusy" style="width:22px;height:22px" />
            <img v-else-if="logoPreview" :src="logoPreview" alt="School logo" class="max-w-full max-h-full object-contain" />
            <span v-else class="text-[11px] text-slate-400">No logo</span>
          </div>
          <div class="min-w-0 flex-1 space-y-1.5">
            <div class="text-xs text-slate-600">{{ logoSourceText }}</div>
            <div class="flex gap-1 flex-wrap items-center">
              <Button :label="savedLogo ? 'Upload a different logo' : 'Upload logo'" icon="pi pi-upload" size="small" outlined
                      :disabled="!!logoBusy" @click="logoInput?.click()" />
              <Button v-if="appLogo && logoChoice !== 'app'" label="Use teacher-app logo" size="small" text @click="logoChoice = 'app'" />
              <Button v-if="savedLogo && logoChoice !== 'saved'" label="Use uploaded logo" size="small" text @click="logoChoice = 'saved'" />
              <Button v-if="(appLogo || savedLogo) && logoChoice !== 'none'" label="Print without logo" size="small" text severity="secondary"
                      @click="logoChoice = 'none'" />
              <Button v-if="savedLogo" label="Delete uploaded logo" size="small" text severity="danger" :disabled="!!logoBusy" @click="removeSavedLogo" />
            </div>
            <input ref="logoInput" type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" class="hidden" @change="onLogoFile" />
            <p v-for="w in logoWarnings" :key="w" class="text-xs text-amber-600">{{ w }}</p>
            <p class="text-[11px] text-slate-400">PNG with a transparent background works best, at least 300 px across. Blank margins are trimmed automatically.</p>
          </div>
        </div>
      </div>
    </div>

    <!-- ── Live preview ─────────────────────────────────────────────────── -->
    <div class="bg-white rounded-xl border border-slate-200 p-4">
      <div class="flex items-center gap-2 flex-wrap mb-3">
        <div class="text-sm font-bold text-slate-900 mr-auto">
          Live preview <span v-if="previewLabel" class="text-slate-400 font-normal">· {{ previewLabel }}</span>
        </div>
        <span v-if="previewBusy" class="text-xs text-slate-400"><i class="pi pi-spin pi-spinner mr-1"></i>Updating…</span>
        <Button label="Open full size" icon="pi pi-external-link" size="small" text :disabled="!previewUrl" @click="openPreview" />
      </div>
      <div v-if="!canGenerateBlank" class="text-sm text-slate-400 text-center py-10">
        Add the website and school name to see the pamphlet.
      </div>
      <div v-else-if="previewError" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{{ previewError }}</div>
      <iframe v-else-if="previewUrl" :src="previewUrl + '#toolbar=0&navpanes=0&view=FitH'" title="Pamphlet preview"
              class="w-full rounded-lg border border-slate-200 bg-slate-50" style="height: 78vh"></iframe>
      <div v-else class="flex items-center justify-center py-10"><ProgressSpinner style="width:28px;height:28px" /></div>
      <p class="text-[11px] text-slate-400 mt-2">
        Updates as you change the logo, school name, website or selection. Shows the first selected student of each design, front and back
        (a blank copy when no students are selected).
      </p>
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
              <div class="text-sm font-medium text-slate-800 truncate">
                {{ row.className }}
                <span v-if="row.skip" class="ml-1 text-[10px] font-semibold uppercase text-slate-500 bg-slate-100 rounded px-1 py-0.5"
                      title="Not ticked by default — tick it to include">{{ row.skip }}</span>
              </div>
              <div class="flex items-center gap-1.5 flex-wrap mt-0.5">
                <span class="text-xs text-slate-400">
                  {{ row.count }} student{{ row.count === 1 ? '' : 's' }}<template v-if="row.stage"> · {{ STAGES[row.stage].label }}</template>
                </span>
                <span class="text-[10px] font-semibold px-1.5 py-0.5 rounded whitespace-nowrap" :class="designChip(designFor(row)).cls"
                      :title="row.design ? '' : 'Grade not recognised — using Middle + Prep'">
                  {{ designChip(designFor(row)).label }}<template v-if="!row.design && designOverride === 'auto'">?</template>
                </span>
              </div>
            </div>
            <button type="button" class="text-[11px] text-slate-400 hover:text-blue-600 px-1 self-start"
                    title="Select only this class" @click.prevent.stop="onlyClass(row.classId)">Only</button>
          </label>
        </div>

        <div v-if="warnings.length" class="mt-3 text-xs text-amber-700 bg-amber-50 rounded-lg px-3 py-2 space-y-0.5">
          <div v-for="w in warnings" :key="w">{{ w }}</div>
        </div>
      </div>

      <!-- ── Students — tick / untick within the selected classes ─────────── -->
      <div v-if="studentsInClasses.length" class="bg-white rounded-xl border border-slate-200 p-4">
        <div class="flex items-center gap-2 flex-wrap mb-3">
          <div class="text-sm font-bold text-slate-900 mr-auto">
            Students <span class="text-slate-400 font-normal">· {{ selectedStudents.length }} of {{ studentsInClasses.length }} in the selected classes</span>
          </div>
          <IconField class="w-64">
            <InputIcon class="pi pi-search" />
            <InputText v-model="studentSearch" placeholder="Search name, roll no, ID…" class="w-full" size="small" />
          </IconField>
          <Button :label="studentSearch ? 'Tick shown' : 'Tick all'" size="small" text @click="setIncluded(visibleStudents, true)" />
          <Button :label="studentSearch ? 'Untick shown' : 'Untick all'" size="small" text @click="setIncluded(visibleStudents, false)" />
        </div>
        <div class="rounded-lg border border-slate-200 overflow-hidden">
          <DataTable :value="visibleStudents" dataKey="id" size="small" stripedRows
                     paginator :rows="25" :rowsPerPageOptions="[25, 50, 100]">
            <Column style="width:44px">
              <template #body="{ data }">
                <Checkbox binary :modelValue="!excludedIds.has(data.id)" @update:modelValue="v => setIncluded([data], v)" />
              </template>
            </Column>
            <Column field="name" header="Name">
              <template #body="{ data }">
                <span class="text-sm" :class="data.name ? 'text-slate-800' : 'text-slate-400 italic'">{{ data.name || 'No name' }}</span>
              </template>
            </Column>
            <Column field="className" header="Class" style="width:140px" />
            <Column field="rollNo" header="Roll No" style="width:90px" />
            <Column field="id" header="User ID" style="width:130px">
              <template #body="{ data }"><span class="font-mono text-xs">{{ data.id }}</span></template>
            </Column>
            <Column style="width:60px">
              <template #body="{ data }">
                <Button icon="pi pi-download" text rounded size="small" title="Download this student's pamphlet"
                        :loading="busy === 'one:' + data.id" :disabled="!canGenerateBlank || !!busy" @click="generate('one', data)" />
              </template>
            </Column>
          </DataTable>
          <div v-if="!visibleStudents.length" class="text-center text-sm text-slate-400 py-6">No students match "{{ studentSearch }}".</div>
        </div>
      </div>

      <!-- ── Generate ─────────────────────────────────────────────────────── -->
      <div class="bg-white rounded-xl border border-slate-200 p-4 flex items-center gap-2 flex-wrap">
        <Button label="Download PDF" icon="pi pi-download" :loading="busy === 'pdf'" :disabled="!canGenerate || !!busy" @click="generate('pdf')" />
        <Button label="One PDF per class (ZIP)" icon="pi pi-folder" outlined :loading="busy === 'zip'" :disabled="!canGenerate || !!busy" @click="generate('zip')" />
        <Button label="Sample (first student)" icon="pi pi-eye" text :loading="busy === 'sample'" :disabled="!canGenerate || !!busy" @click="generate('sample')" />

        <!-- By stage: one PDF per stage, separately or all at once -->
        <div class="w-full flex items-center gap-2 flex-wrap pt-3 mt-1 border-t border-slate-100">
          <span class="text-xs font-semibold text-slate-500 uppercase tracking-wide mr-1">By stage</span>
          <Button
            v-for="g in stageGroups" :key="g.key"
            :label="`${g.label} · ${g.students.length}`" :title="g.grades" icon="pi pi-file-pdf" size="small" outlined
            :loading="busy === 'stage:' + g.key" :disabled="!g.students.length || !canGenerateBlank || !!busy"
            @click="generate('stage', null, g.key)"
          />
          <Button :label="`All stages · ${stageGroups.filter(g => g.students.length).length} PDFs (ZIP)`" icon="pi pi-folder" size="small"
                  :loading="busy === 'stages'" :disabled="!canGenerate || !!busy" @click="generate('stages')" />
        </div>
        <span v-if="progress && busy !== 'blank'" class="text-xs text-slate-500">{{ progress }}</span>
        <span v-else-if="!website" class="text-xs text-amber-600">Add the website first.</span>
        <span v-else-if="!printedSchoolName.trim()" class="text-xs text-amber-600">Add the school name first.</span>

        <div v-if="pendingFile" class="w-full flex items-center gap-3 bg-emerald-50 rounded-lg px-3 py-2 mt-1">
          <i class="pi pi-check-circle text-emerald-600"></i>
          <div class="min-w-0 flex-1 text-xs text-slate-700 break-all">{{ pendingFile.name }} is ready</div>
          <Button label="Save" icon="pi pi-download" size="small" @click="savePending" />
        </div>
      </div>
    </template>

    <!-- ── Blank copies — no roster needed ────────────────────────────── -->
    <div class="bg-white rounded-xl border border-slate-200 p-4">
      <div class="text-sm font-bold text-slate-900 mb-1">Blank copies</div>
      <p class="text-xs text-slate-500 mb-3">
        School name, website and QR printed; name, roll no, class, User ID and Password left blank to fill in by hand —
        for new admissions or lost pamphlets.
      </p>
      <div class="flex items-end gap-3 flex-wrap">
        <!-- One PDF per design: Foundational and Middle + Prep are printed separately. -->
        <div v-for="d in ['foundational', 'middle']" :key="d" class="rounded-lg border border-slate-200 px-3 py-2">
          <label class="form-label">{{ DESIGN_LABEL[d] }}</label>
          <div class="flex items-center gap-2">
            <InputNumber v-model="blankCounts[d]" :min="0" :max="2000" showButtons class="w-28" inputClass="w-full" />
            <Button :label="`Download (${blankCounts[d] || 0})`" icon="pi pi-file" outlined size="small"
                    :loading="busy === 'blank:' + d" :disabled="!canGenerateBlank || !blankCounts[d] || !!busy"
                    @click="generate('blank', null, d)" />
          </div>
          <div class="text-[11px] text-slate-400 mt-1">10% of {{ designStudentCounts[d] }} student{{ designStudentCounts[d] === 1 ? '' : 's' }}</div>
        </div>
        <Button label="Both, as two PDFs (ZIP)" icon="pi pi-folder" text
                :loading="busy === 'blankZip'" :disabled="!canGenerateBlank || !blankTotal || !!busy" @click="generate('blankZip')" />
        <span v-if="String(busy).startsWith('blank') && progress" class="text-xs text-slate-500">{{ progress }}</span>
        <span v-else-if="!website" class="text-xs text-amber-600">Add the website first.</span>
        <span v-else-if="!printedSchoolName.trim()" class="text-xs text-amber-600">Add the school name first.</span>
      </div>
      <div v-if="pendingFile && !appSchoolId" class="flex items-center gap-3 bg-emerald-50 rounded-lg px-3 py-2 mt-3">
        <i class="pi pi-check-circle text-emerald-600"></i>
        <div class="min-w-0 flex-1 text-xs text-slate-700 break-all">{{ pendingFile.name }} is ready</div>
        <Button label="Save" icon="pi pi-download" size="small" @click="savePending" />
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { getDocs, query, orderBy, limit, updateDoc, serverTimestamp } from 'firebase/firestore'
import { useToast } from 'primevue/usetoast'
import Select from 'primevue/select'
import InputText from 'primevue/inputtext'
import Button from 'primevue/button'
import Checkbox from 'primevue/checkbox'
import InputNumber from 'primevue/inputnumber'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import IconField from 'primevue/iconfield'
import InputIcon from 'primevue/inputicon'
import ProgressSpinner from 'primevue/progressspinner'
import JSZip from 'jszip'

import { auth } from '../../firebase/config'
import { opsDoc } from '../../firebase/collections.js'
import { rootSchoolsCollection, schoolCollection } from '../../firebase/schoolCollections.js'
import { useSchoolWebsites, primaryUrl } from '../../composables/useSchoolWebsites.js'
import { parseClassValue, compareClasses } from '../../utils/classResolver.js'
import { pendingFile, savePending, deliverFile } from '../../utils/deliverFile.js'
import { normalizeLogo, logoFromUrl, logoDataUrl, LOGO_MIN_SIDE } from '../../utils/pamphletLogo.js'
import { loadSavedLogo, saveLogo, deleteSavedLogo } from '../../utils/pamphletLogoStore.js'
import {
  buildStudentPamphletsPDF, loadPamphletAssets, designForGrade, compareStudents,
  displayWebsite, qrTarget, guessAppSchool, pamphletFilename, blankCopies, stageForGrade, STAGES, defaultBlankPamphlets, classSkipReason,
  FOUNDATIONAL_BACK_LANGUAGES,
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

// ── Website + school name ──────────────────────────────────────────────────────
const { sitesFor, load: loadWebsites, loaded: websitesLoaded } = useSchoolWebsites()
const website = ref('')
const printedSchoolName = ref(props.school.name || '')

// Defaults to the school's Second Language (Overview → Details) when it is one
// we have a back page for; Hindi otherwise.
const foundationalBack = ref(
  FOUNDATIONAL_BACK_LANGUAGES.find(l => l.label.toLowerCase() === String(props.school.second_language || '').trim().toLowerCase())?.value
  || 'hindi')
const backLabel = computed(() => FOUNDATIONAL_BACK_LANGUAGES.find(l => l.value === foundationalBack.value)?.label || '')

function prefillWebsite() {
  const site = sitesFor(appSchoolId.value)[0]
  website.value = site ? displayWebsite(primaryUrl(site)) : ''
}
watch([appSchoolId, websitesLoaded], prefillWebsite)

// ── Logo ──────────────────────────────────────────────────────────────────
// An uploaded logo (saved per ops school) wins over the teacher-app school's
// logoUrl; either can be switched off for one run with "Print without logo".
const savedLogo = ref(null)
const appLogo = ref(null)
const appLogoError = ref('')
const logoChoice = ref(null)          // null = automatic: uploaded, else app, else none
const logoBusy = ref('')
const logoInput = ref(null)

const effectiveLogoChoice = computed(() =>
  logoChoice.value ?? (savedLogo.value ? 'saved' : appLogo.value ? 'app' : 'none'))
const logo = computed(() =>
  effectiveLogoChoice.value === 'saved' ? savedLogo.value
    : effectiveLogoChoice.value === 'app' ? appLogo.value : null)
const logoPreview = computed(() => logoDataUrl(logo.value))

const logoSourceText = computed(() => {
  if (logoBusy.value === 'app') return 'Loading the logo from the teacher app…'
  if (logoBusy.value === 'upload') return 'Reading the logo…'
  if (effectiveLogoChoice.value === 'saved') {
    const s = savedLogo.value
    return `Uploaded logo${s.fileName ? ` (${s.fileName})` : ''}${s.updatedBy ? ` — by ${s.updatedBy}` : ''}. Used every time for this school.`
  }
  if (effectiveLogoChoice.value === 'app') return 'From the teacher-app school record.'
  if (logoChoice.value === 'none') return 'Printing without a logo — the school name is centred on its own.'
  return appSchoolId.value
    ? 'No logo found — upload one, or the school name is centred on its own.'
    : 'Pick the teacher-app school to use its logo, or upload one.'
})

const logoWarnings = computed(() => {
  const out = []
  if (appLogoError.value && !savedLogo.value) out.push(`Teacher-app logo: ${appLogoError.value}`)
  const l = logo.value
  if (l && Math.max(l.sourceWidth, l.sourceHeight) < LOGO_MIN_SIDE) {
    out.push(`This logo is only ${l.sourceWidth} × ${l.sourceHeight} px — it may print soft. Upload a larger one if you have it.`)
  }
  return out
})

async function loadAppLogo() {
  appLogo.value = null
  appLogoError.value = ''
  const school = appSchools.value.find(s => s.id === appSchoolId.value)
  const url = school?.logoUrl || school?.logoUrlDark
  if (!url) return
  logoBusy.value = 'app'
  try {
    appLogo.value = await logoFromUrl(url)
  } catch (e) {
    appLogoError.value = e.message
  } finally {
    if (logoBusy.value === 'app') logoBusy.value = ''
  }
}
watch(appSchoolId, loadAppLogo)

async function onLogoFile(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file) return
  logoBusy.value = 'upload'
  try {
    const normalized = await normalizeLogo(file)
    const user = auth.currentUser?.email || 'unknown'
    await saveLogo(props.school.id, normalized, { fileName: file.name, user })
    savedLogo.value = { ...normalized, fileName: file.name, updatedBy: user, updatedAt: new Date() }
    logoChoice.value = 'saved'
    toast.add({ severity: 'success', summary: 'Logo saved', detail: 'Used for this school\'s pamphlets from now on.', life: 2500 })
  } catch (e) {
    console.error('Logo upload failed', e)
    toast.add({ severity: 'error', summary: 'Could not use that logo', detail: e.message, life: 5000 })
  } finally {
    logoBusy.value = ''
  }
}

async function removeSavedLogo() {
  logoBusy.value = 'delete'
  try {
    await deleteSavedLogo(props.school.id)
    savedLogo.value = null
    if (logoChoice.value === 'saved') logoChoice.value = null
  } catch (e) {
    toast.add({ severity: 'error', summary: 'Could not delete the logo', detail: e.message, life: 4000 })
  } finally {
    logoBusy.value = ''
  }
}

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
  excludedIds.value = new Set()
  studentSearch.value = ''
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
    selectedClassIds.value = classRows.value.filter(r => !r.skip).map(r => r.classId)
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

function classGrade(classId) {
  if (classId === NO_CLASS) return null
  const c = classes.value.find(x => x.id === classId)
  return parseClassValue(c?.clazz || classId).gradeOrdinal
}
const classDesign = (classId) => designForGrade(classGrade(classId))
const classStage = (classId) => stageForGrade(classGrade(classId))

const classRows = computed(() => {
  const counts = new Map()
  for (const s of students.value) {
    const cid = s.currentClassId || NO_CLASS
    counts.set(cid, (counts.get(cid) || 0) + 1)
  }
  return [...counts.entries()]
    .map(([classId, count]) => ({
      classId, count, className: classLabel(classId), design: classDesign(classId), stage: classStage(classId),
      skip: classSkipReason(classes.value.find(c => c.id === classId), classId, { noClassId: NO_CLASS }),
    }))
    .sort((a, b) => (a.classId === NO_CLASS) - (b.classId === NO_CLASS) || compareClasses(a.classId, b.classId))
})

// ── Design ────────────────────────────────────────────────────────────────
const designOverride = ref('auto')
const overrideOptions = [
  { value: 'auto', label: 'Design: by grade' },
  { value: 'foundational', label: 'Design: Foundational for all' },
  { value: 'middle', label: 'Design: Middle + Prep for all' },
]
function designFor(row) {
  if (designOverride.value !== 'auto') return designOverride.value
  return row.design || 'middle'
}
function designChip(design) {
  return design === 'foundational'
    ? { label: `Foundational · ${backLabel.value}`, cls: 'bg-violet-100 text-violet-700' }
    : { label: 'Middle + Prep', cls: 'bg-sky-100 text-sky-700' }
}

function onlyClass(classId) {
  selectedClassIds.value = [classId]
}

// "All" means every real class; inactive / sample / no-class stay unticked.
function selectAll(on) {
  selectedClassIds.value = on ? classRows.value.filter(r => !r.skip).map(r => r.classId) : []
}

// ── What gets printed ─────────────────────────────────────────────────────
// Every student in the ticked classes, in print order. Individual students
// are then unticked via excludedIds — kept as exclusions so ticking another
// class brings all of its students in without extra clicks.
const studentsInClasses = computed(() => {
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
        stage: row.stage,
      }
    })
    .sort((a, b) => compareStudents(a, b, (x, y) =>
      (x === NO_CLASS) - (y === NO_CLASS) || compareClasses(x, y)))
})

const excludedIds = ref(new Set())
const selectedStudents = computed(() => studentsInClasses.value.filter(s => !excludedIds.value.has(s.id)))

function setIncluded(list, on) {
  const next = new Set(excludedIds.value)
  for (const s of list) on ? next.delete(s.id) : next.add(s.id)
  excludedIds.value = next
}

const studentSearch = ref('')
const visibleStudents = computed(() => {
  const q = studentSearch.value.trim().toLowerCase()
  if (!q) return studentsInClasses.value
  return studentsInClasses.value.filter(s =>
    [s.name, s.id, s.rollNo, s.className].some(v => String(v ?? '').toLowerCase().includes(q)))
})

const warnings = computed(() => {
  const out = []
  const chosen = selectedStudents.value
  const unknown = classRows.value.filter(r => selectedClassIds.value.includes(r.classId) && !r.design && r.classId !== NO_CLASS)
  if (designOverride.value === 'auto' && unknown.length) {
    out.push(`Grade not recognised for ${unknown.map(r => r.className).join(', ')} — these use Middle + Prep. Pick a design above to override.`)
  }
  const noName = chosen.filter(s => !String(s.name ?? '').trim()).length
  if (noName) out.push(`${noName} student${noName === 1 ? ' has' : 's have'} no name — a blank line is printed to fill in by hand.`)
  const noRoll = chosen.filter(s => !String(s.rollNo ?? '').trim()).length
  if (noRoll) out.push(`${noRoll} student${noRoll === 1 ? ' has' : 's have'} no roll number — Roll No. is left out of their header. Add them in School Setup → Students to print them.`)
  // The pamphlet font covers English and Hindi (Devanagari); other scripts are left out.
  const unprintable = chosen.filter(s => /[^\u0000-\u024F\u2018-\u201D\u0900-\u097F\u200C\u200D]/.test(s.name)).length
  if (unprintable) out.push(`${unprintable} name${unprintable === 1 ? '' : 's'} use letters other than English or Hindi — those letters are left out. Fix the names in School Setup → Students.`)
  if (chosen.some(s => s.classId === NO_CLASS)) out.push('Some students have no class — they are printed last, with a blank class to fill in by hand.')
  return out
})

// One group per stage, in stage order; classes whose grade isn't recognised
// (and students with no class) go in a last "Other" group, only if there are any.
const OTHER_STAGE = { label: 'Other', grades: 'Grade not recognised, or no class' }
const stageGroups = computed(() => {
  const groups = Object.entries(STAGES).map(([key, st]) => ({ key, ...st, students: [] }))
  const other = { key: 'other', ...OTHER_STAGE, students: [] }
  for (const s of selectedStudents.value) (groups.find(g => g.key === s.stage) || other).students.push(s)
  return other.students.length ? [...groups, other] : groups
})
const stageFileLabel = (g) => (g.key === 'other' ? g.label : `${g.label} (${g.grades})`)

const canGenerateBlank = computed(() => !!displayWebsite(website.value) && !!printedSchoolName.value.trim())
const canGenerate = computed(() => selectedStudents.value.length > 0 && canGenerateBlank.value)

// ── Blank copies ──────────────────────────────────────────────────────────
// One count per design, defaulting to 10% of that design's selected students
// (rounded up) until someone types a number; 0 skips the design.
const designStudentCounts = computed(() => ({
  foundational: selectedStudents.value.filter(s => s.design === 'foundational').length,
  middle: selectedStudents.value.filter(s => s.design === 'middle').length,
}))
const blankCounts = reactive({ foundational: 0, middle: 0 })
// The default each field was last given: a field still showing it follows
// the roster as it loads or changes; anything else was typed and is kept.
const blankDefaults = { foundational: 0, middle: 0 }
watch(designStudentCounts, counts => {
  for (const d of ['foundational', 'middle']) {
    const next = defaultBlankPamphlets(counts[d])
    if (blankCounts[d] === blankDefaults[d]) blankCounts[d] = next
    blankDefaults[d] = next
  }
}, { immediate: true })
const blankTotal = computed(() => (blankCounts.foundational || 0) + (blankCounts.middle || 0))

// ── Generate ──────────────────────────────────────────────────────────────
const busy = ref('')
const progress = ref('')
let assetsPromise = null

async function build(list, label) {
  assetsPromise ||= loadPamphletAssets(import.meta.env.BASE_URL || '/')
  const assets = await assetsPromise.catch(e => { assetsPromise = null; throw e })
  return buildStudentPamphletsPDF({
    students: list,
    schoolName: printedSchoolName.value.trim(),
    website: website.value,
    logo: logo.value,
    assets,
    foundationalBack: foundationalBack.value,
    onProgress: (done, total) => { progress.value = `${label}${done} / ${total}…` },
  })
}

async function generate(kind, student = null, stageKey = null) {
  busy.value = kind === 'one' ? `one:${student.id}` : kind === 'stage' ? `stage:${stageKey}`
    : kind === 'blank' ? `blank:${stageKey}` : kind
  progress.value = 'Loading templates…'
  const school = printedSchoolName.value.trim()
  try {
    // Blank copies: one PDF per design (stageKey carries the design here).
    if (kind === 'blank') {
      const d = stageKey
      const list = blankCopies(d, blankCounts[d])
      const bytes = await build(list, `Blank ${DESIGN_LABEL[d]}: `)
      deliverFile(new Blob([bytes], { type: 'application/pdf' }), pamphletFilename(school, `Blank - ${DESIGN_LABEL[d]}`))
      toast.add({ severity: 'success', summary: 'Blank copies ready', detail: `${list.length} ${DESIGN_LABEL[d]}`, life: 2500 })
      return
    }
    if (kind === 'blankZip') {
      const zip = new JSZip()
      for (const d of ['foundational', 'middle']) {
        if (!blankCounts[d]) continue
        const bytes = await build(blankCopies(d, blankCounts[d]), `Blank ${DESIGN_LABEL[d]}: `)
        zip.file(pamphletFilename(school, `Blank - ${DESIGN_LABEL[d]}`), bytes)
      }
      progress.value = 'Zipping…'
      deliverFile(await zip.generateAsync({ type: 'blob' }), pamphletFilename(school, 'Blank').replace(/\.pdf$/, '.zip'))
      toast.add({ severity: 'success', summary: 'Blank copies ready', detail: `${blankTotal.value} copies in two PDFs`, life: 2500 })
      return
    }
    if (kind === 'one') {
      const bytes = await build([student], '')
      deliverFile(new Blob([bytes], { type: 'application/pdf' }),
        pamphletFilename(school, [student.name || student.id, student.className].filter(Boolean).join(' - ')))
      toast.add({ severity: 'success', summary: 'Pamphlet ready', detail: student.name || student.id, life: 2500 })
      return
    }
    if (kind === 'stage') {
      const g = stageGroups.value.find(x => x.key === stageKey)
      const bytes = await build(g.students, `${g.label}: `)
      deliverFile(new Blob([bytes], { type: 'application/pdf' }), pamphletFilename(school, stageFileLabel(g)))
      toast.add({ severity: 'success', summary: `${g.label} pamphlets ready`, detail: `${g.students.length} students`, life: 2500 })
      return
    }
    if (kind === 'stages') {
      const zip = new JSZip()
      const groups = stageGroups.value.filter(g => g.students.length)
      for (const [i, g] of groups.entries()) {
        const bytes = await build(g.students, `${g.label} (${i + 1} / ${groups.length}): `)
        zip.file(pamphletFilename(school, stageFileLabel(g)), bytes)
      }
      progress.value = 'Zipping…'
      const blob = await zip.generateAsync({ type: 'blob' })
      deliverFile(blob, pamphletFilename(school, 'By stage').replace(/\.pdf$/, '.zip'))
      toast.add({ severity: 'success', summary: 'Stage PDFs ready', life: 3000,
        detail: groups.map(g => `${g.label}: ${g.students.length}`).join(' · ') })
      return
    }
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

// ── Live preview ──────────────────────────────────────────────────────────
const previewUrl = ref('')
const previewBusy = ref(false)
const previewError = ref('')
const DESIGN_LABEL = { foundational: 'Foundational', middle: 'Middle + Prep' }

// First selected student of each design; blank copies when none are selected.
const previewStudents = computed(() => {
  const picks = []
  for (const design of ['foundational', 'middle']) {
    const s = selectedStudents.value.find(x => x.design === design)
    if (s) picks.push(s)
  }
  if (picks.length) return picks
  const designs = ['foundational', 'middle'].filter(d => blankCounts[d] > 0)
  return (designs.length ? designs : ['foundational']).map(d => ({ blank: true, design: d }))
})
const previewLabel = computed(() => previewStudents.value
  .map(s => `${s.blank ? 'Blank copy' : (s.name || s.id)} (${DESIGN_LABEL[s.design]})`).join(' · '))

let previewTimer = null
let previewRun = 0
async function refreshPreview() {
  if (!canGenerateBlank.value) return
  const run = ++previewRun
  previewBusy.value = true
  try {
    assetsPromise ||= loadPamphletAssets(import.meta.env.BASE_URL || '/')
    const assets = await assetsPromise.catch(e => { assetsPromise = null; throw e })
    const bytes = await buildStudentPamphletsPDF({
      students: previewStudents.value,
      schoolName: printedSchoolName.value.trim(),
      website: website.value,
      logo: logo.value,
      assets,
      foundationalBack: foundationalBack.value,
    })
    if (run !== previewRun) return
    if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
    previewUrl.value = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }))
    previewError.value = ''
  } catch (e) {
    if (run === previewRun) previewError.value = `Could not build the preview: ${e.message}`
  } finally {
    if (run === previewRun) previewBusy.value = false
  }
}
watch(
  () => [logo.value, printedSchoolName.value, website.value, foundationalBack.value,
    previewStudents.value.map(s => `${s.id}|${s.design}|${s.name}|${s.rollNo}|${s.className}`).join(',')],
  () => { clearTimeout(previewTimer); previewTimer = setTimeout(refreshPreview, 500) },
  { immediate: true },
)
onBeforeUnmount(() => {
  clearTimeout(previewTimer)
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
})
function openPreview() {
  if (previewUrl.value) window.open(previewUrl.value, '_blank')
}

onMounted(() => {
  loadAppSchools()
  loadWebsites()
  loadSavedLogo(props.school.id)
    .then(l => { savedLogo.value = l })
    .catch(e => console.error('Could not load the saved logo', e))
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
