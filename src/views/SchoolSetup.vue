<template>
  <!-- ── Step-up reauth gate ──────────────────────────────────────────────── -->
  <div v-if="!isElevated" class="flex items-center justify-center py-20">
    <div class="bg-white rounded-xl border border-slate-200 p-6 w-full max-w-sm">
      <div class="flex items-center gap-2 mb-1">
        <i class="pi pi-shield text-slate-400"></i>
        <div class="text-sm font-bold text-slate-900">Confirm your password to continue</div>
      </div>
      <p class="text-xs text-slate-400 mb-4">School Setup holds sensitive per-school configuration — re-enter your password to proceed.</p>

      <Password
        v-model="password"
        class="w-full"
        input-class="w-full"
        placeholder="Password"
        :feedback="false"
        toggleMask
        @keyup.enter="submitReauth"
      />
      <div v-if="reauthError" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2 mt-3">{{ reauthError }}</div>

      <Button label="Continue" class="w-full mt-4" :loading="reauthing" @click="submitReauth" />
    </div>
  </div>

  <!-- ── Page shell ───────────────────────────────────────────────────────── -->
  <div v-else @click.capture="markActivity" @keydown.capture="markActivity" @mousemove="throttledActivity">
    <div class="flex items-center justify-between gap-4 mb-5">
      <div class="flex items-center gap-2">
        <Select
          v-model="selectedSchoolId"
          :options="schools"
          optionLabel="name"
          optionValue="id"
          placeholder="Select a school"
          class="w-80"
          :loading="loadingSchools"
          :disabled="!!resetTargetSchoolId"
          filter
        />
        <!-- While a reset run is active the page selector follows it and is
             frozen. A destructive flow must never be able to show one school
             at the top of the page and act on another. -->
        <span v-if="resetTargetSchoolId"
              class="px-2.5 py-1 rounded-full text-xs font-semibold bg-red-100 text-red-700 flex items-center gap-1">
          <i class="pi pi-lock" style="font-size:10px"></i>
          Reset in progress
        </span>
        <Button
          v-if="!hasTestSchool"
          label="Create TEST_SCHOOL sandbox"
          size="small"
          text
          :loading="creatingTestSchool"
          @click="createTestSchool"
        />
      </div>
      <span class="px-3 py-1.5 rounded-full text-xs font-semibold bg-slate-100 text-slate-600">
        {{ activeYear === 'All Years' ? 'All Years' : `AY ${activeYear}` }}
      </span>
    </div>

    <!-- `scrollable` because the tab strip is now long enough to overflow at
         1280px; without it the whole page gains a horizontal scrollbar. -->
    <Tabs v-model:value="activeTab" scrollable>
      <TabList>
        <Tab value="new-school"><i class="pi pi-sparkles text-xs mr-1.5"></i>New School</Tab>
        <Tab value="reset-school"><i class="pi pi-refresh text-xs mr-1.5"></i>Reset School</Tab>
        <Tab value="overview">Overview</Tab>
        <Tab value="terms-scales">Terms &amp; Scales</Tab>
        <Tab value="subjects">Subjects</Tab>
        <Tab value="classes-teachers">Classes &amp; Teachers</Tab>
        <Tab value="assessments">Assessments</Tab>
        <Tab value="co-scholastic">Co-Scholastic</Tab>
        <Tab value="remarks">Remarks</Tab>
        <Tab value="months">Months</Tab>
        <Tab value="class-map">Class Map</Tab>
        <Tab value="class-health">Class Health</Tab>
        <Tab value="structure">Propose Structure</Tab>
        <Tab value="knowledge-base">Knowledge Base</Tab>
        <Tab value="sheets-status">Sheets Status</Tab>
        <Tab value="clone-school">Clone School</Tab>
        <Tab value="templates">Templates</Tab>
      </TabList>
      <TabPanels>
        <!-- The wizards pick their own school (New School creates one, Reset
             selects one explicitly), so neither takes the page selector's
             value — a reset must never inherit a selection made for another
             purpose. -->
        <TabPanel value="new-school">
          <NewSchoolWizard @open-tab="handleOpenTab" @school-created="handleSchoolCreated" />
        </TabPanel>
        <TabPanel value="reset-school">
          <ResetSchoolWizard @open-tab="handleOpenTab" @active-school="onResetTarget" />
        </TabPanel>
        <TabPanel value="overview"><OverviewTab :school-id="selectedSchoolId" :school="selectedSchoolObject" @saved="loadSchools" /></TabPanel>
        <TabPanel value="terms-scales"><TermsScalesTab :school-id="selectedSchoolId" /></TabPanel>
        <TabPanel value="subjects"><SubjectsTab :school-id="selectedSchoolId" /></TabPanel>
        <TabPanel value="classes-teachers"><ClassesTeachersTab :school-id="selectedSchoolId" /></TabPanel>
        <TabPanel value="assessments"><AssessmentsTab :school-id="selectedSchoolId" /></TabPanel>
        <TabPanel value="co-scholastic"><CoScholasticTab :school-id="selectedSchoolId" /></TabPanel>
        <TabPanel value="remarks"><RemarksTab :school-id="selectedSchoolId" /></TabPanel>
        <TabPanel value="months"><MonthsTab :school-id="selectedSchoolId" /></TabPanel>
        <TabPanel value="class-map"><ClassMapTab :school-id="selectedSchoolId" /></TabPanel>
        <TabPanel value="class-health"><ClassHealthTab /></TabPanel>
        <TabPanel value="structure"><StructureTab :school-id="selectedSchoolId" /></TabPanel>
        <TabPanel value="knowledge-base"><KnowledgeBaseTab /></TabPanel>
        <TabPanel value="sheets-status"><SheetsStatusTab :school-id="selectedSchoolId" /></TabPanel>
        <TabPanel value="clone-school"><CloneSchoolTab :school-id="selectedSchoolId" :school="selectedSchoolObject" /></TabPanel>
        <TabPanel value="templates"><TemplatesTab :school-id="selectedSchoolId" /></TabPanel>
      </TabPanels>
    </Tabs>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { getDocs, query, orderBy, limit, setDoc, serverTimestamp } from 'firebase/firestore'
import Select from 'primevue/select'
import Password from 'primevue/password'
import Button from 'primevue/button'
import Tabs from 'primevue/tabs'
import TabList from 'primevue/tablist'
import Tab from 'primevue/tab'
import TabPanels from 'primevue/tabpanels'
import TabPanel from 'primevue/tabpanel'

import { useStepUpAuth } from '../composables/useStepUpAuth.js'
import { rootSchoolsCollection, rootSchoolDoc } from '../firebase/schoolCollections.js'
import { activeYear } from '../composables/useAcademicYear.js'
import { auth } from '../firebase/config'
import TermsScalesTab from '../components/school-setup/TermsScalesTab.vue'
import MonthsTab from '../components/school-setup/MonthsTab.vue'
import RemarksTab from '../components/school-setup/RemarksTab.vue'
import SubjectsTab from '../components/school-setup/SubjectsTab.vue'
import ClassesTeachersTab from '../components/school-setup/ClassesTeachersTab.vue'
import AssessmentsTab from '../components/school-setup/AssessmentsTab.vue'
import CoScholasticTab from '../components/school-setup/CoScholasticTab.vue'
import OverviewTab from '../components/school-setup/OverviewTab.vue'
import SheetsStatusTab from '../components/school-setup/SheetsStatusTab.vue'
import CloneSchoolTab from '../components/school-setup/CloneSchoolTab.vue'
import TemplatesTab from '../components/school-setup/TemplatesTab.vue'
import StructureTab from '../components/school-setup/StructureTab.vue'
import KnowledgeBaseTab from '../components/school-setup/KnowledgeBaseTab.vue'
import ClassMapTab from '../components/school-setup/ClassMapTab.vue'
import ClassHealthTab from '../components/school-setup/ClassHealthTab.vue'
import NewSchoolWizard from '../components/school-setup/NewSchoolWizard.vue'
import ResetSchoolWizard from '../components/school-setup/ResetSchoolWizard.vue'

// Dedicated sandbox school — every Phase 2+ CRUD tab should default here so
// trial writes never touch a real school's config.
const TEST_SCHOOL_ID = 'TEST_SCHOOL'

const { isElevated, markActivity, reauthenticate } = useStepUpAuth()
const router = useRouter()

const activeTab = ref('overview')

/**
 * The school an in-progress reset targets. While set, the page selector is
 * pinned to it and frozen — the alternative is a destructive wizard acting on
 * NAVODAYA while the header reads TEST_SCHOOL, which is what happened once.
 */
const resetTargetSchoolId = ref(null)

function onResetTarget(schoolId) {
  resetTargetSchoolId.value = schoolId || null
  if (schoolId) selectedSchoolId.value = schoolId
}

/**
 * The wizards hand off to the place that actually does a piece of work rather
 * than reimplementing it. A target is either a tab key on this page or an app
 * route ('/import', '/surveys') — leading slash is the discriminator.
 *
 * Wizard progress lives in Firestore (setup_wizard_runs), not in component
 * state, so leaving for another tab or route and coming back resumes at the
 * same step. That's why this can navigate away freely.
 */
function handleOpenTab(to) {
  if (!to) return
  if (String(to).startsWith('/')) router.push(to)
  else activeTab.value = to
}

/** New School wizard created a school: refresh the selector and point it at
 *  the new school, so the config tabs it links to open on the right one. */
async function handleSchoolCreated(schoolId) {
  await loadSchools()
  if (schools.value.some(s => s.id === schoolId)) selectedSchoolId.value = schoolId
}

const password = ref('')
const reauthing = ref(false)
const reauthError = ref('')

async function submitReauth() {
  if (!password.value) { reauthError.value = 'Enter your password'; return }
  reauthError.value = ''
  reauthing.value = true
  try {
    await reauthenticate(password.value)
    password.value = ''
  } catch (e) {
    reauthError.value = e.code === 'auth/wrong-password' || e.code === 'auth/invalid-credential'
      ? 'Incorrect password'
      : (e.message || 'Could not verify your password')
  } finally {
    reauthing.value = false
  }
}

// Throttle mousemove so it doesn't spam markActivity on every pixel.
let lastMove = 0
function throttledActivity() {
  const now = Date.now()
  if (now - lastMove < 5000) return
  lastMove = now
  markActivity()
}

// ── School selector — root `schools/{id}` (teacher-app config tree), NOT the
// ops CRM's operations/ops/schools used elsewhere in this dashboard. ────────
const schools = ref([])
const loadingSchools = ref(false)
const selectedSchoolId = ref(null)
const creatingTestSchool = ref(false)

const hasTestSchool = computed(() => schools.value.some(s => s.id === TEST_SCHOOL_ID))
const selectedSchoolObject = computed(() => schools.value.find(s => s.id === selectedSchoolId.value) || null)

async function loadSchools() {
  loadingSchools.value = true
  try {
    const snap = await getDocs(query(rootSchoolsCollection(), orderBy('name'), limit(500)))
    // Doc id assigned AFTER the spread. Root school documents in this tree
    // are known to carry their own `id` field, and letting it win is what
    // made the Surveys picker disagree with the URL (see the "(no class)"
    // fix); every id-based comparison below depends on the real doc id.
    schools.value = snap.docs
      .map(d => ({ ...d.data(), id: d.id }))
      .filter(s => s.isActive !== false)
  } catch (e) {
    console.error('Could not load schools', e)
  } finally {
    loadingSchools.value = false
  }
  // Only re-pin the selection when the current one is no longer valid (first
  // load, or the selected school vanished) — a reload triggered by e.g. saving
  // a name change in Overview must not silently switch the selected school.
  if (!schools.value.some(s => s.id === selectedSchoolId.value)) {
    selectedSchoolId.value = hasTestSchool.value ? TEST_SCHOOL_ID : (schools.value[0]?.id || null)
  }
}

async function createTestSchool() {
  creatingTestSchool.value = true
  try {
    await setDoc(rootSchoolDoc(TEST_SCHOOL_ID), {
      id: TEST_SCHOOL_ID,
      name: TEST_SCHOOL_ID,
      isActive: true,
      created_by: auth.currentUser?.email || 'unknown',
      created_at: serverTimestamp(),
    })
    await loadSchools()
  } catch (e) {
    console.error('Could not create TEST_SCHOOL', e)
  } finally {
    creatingTestSchool.value = false
  }
}

onMounted(loadSchools)
</script>
