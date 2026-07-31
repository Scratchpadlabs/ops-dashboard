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
          filter
        />
        <Button
          v-if="!hasTestSchool"
          label="Create TEST_SCHOOL sandbox"
          size="small"
          text
          :loading="creatingTestSchool"
          @click="createTestSchool"
        />
      </div>
      <div class="flex items-center gap-2">
        <ApplyBundleDialog :school-id="selectedSchoolId" @applied="reloadTabs" />
        <span class="px-3 py-1.5 rounded-full text-xs font-semibold bg-slate-100 text-slate-600">
          {{ activeYear === 'All Years' ? 'All Years' : `AY ${activeYear}` }}
        </span>
      </div>
    </div>

    <Tabs value="overview" :key="tabsKey">
      <TabList>
        <Tab value="overview">Overview</Tab>
        <Tab value="terms-scales">Terms &amp; Scales</Tab>
        <Tab value="subjects">Subjects</Tab>
        <Tab value="classes-teachers">Classes &amp; Teachers</Tab>
        <Tab value="assessments">Assessments</Tab>
        <Tab value="co-scholastic">Co-Scholastic</Tab>
        <Tab value="remarks">Remarks</Tab>
        <Tab value="months">Months</Tab>
        <Tab value="sheets-status">Sheets Status</Tab>
        <Tab value="clone-school">Clone School</Tab>
      </TabList>
      <TabPanels>
        <TabPanel value="overview"><OverviewTab :school-id="selectedSchoolId" :school="selectedSchoolObject" @saved="loadSchools" /></TabPanel>
        <TabPanel value="terms-scales"><TermsScalesTab :school-id="selectedSchoolId" /></TabPanel>
        <TabPanel value="subjects"><SubjectsTab :school-id="selectedSchoolId" /></TabPanel>
        <TabPanel value="classes-teachers"><ClassesTeachersTab :school-id="selectedSchoolId" /></TabPanel>
        <TabPanel value="assessments"><AssessmentsTab :school-id="selectedSchoolId" /></TabPanel>
        <TabPanel value="co-scholastic"><CoScholasticTab :school-id="selectedSchoolId" /></TabPanel>
        <TabPanel value="remarks"><RemarksTab :school-id="selectedSchoolId" /></TabPanel>
        <TabPanel value="months"><MonthsTab :school-id="selectedSchoolId" /></TabPanel>
        <TabPanel value="sheets-status"><SheetsStatusTab :school-id="selectedSchoolId" /></TabPanel>
        <TabPanel value="clone-school"><CloneSchoolTab :school-id="selectedSchoolId" :school="selectedSchoolObject" /></TabPanel>
      </TabPanels>
    </Tabs>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
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
import ApplyBundleDialog from '../components/school-setup/ApplyBundleDialog.vue'

// Dedicated sandbox school — every Phase 2+ CRUD tab should default here so
// trial writes never touch a real school's config.
const TEST_SCHOOL_ID = 'TEST_SCHOOL'

const { isElevated, markActivity, reauthenticate } = useStepUpAuth()

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

// Bumped after "Apply Bundle" writes across multiple sections at once —
// forces every tab to remount and reload its own data fresh, since a bundle
// touches sections beyond whichever single tab is currently open (unlike
// SectionTemplateActions' single-section @applied, which just calls that
// one tab's own reload function).
const tabsKey = ref(0)
function reloadTabs() { tabsKey.value++ }

async function loadSchools() {
  loadingSchools.value = true
  try {
    const snap = await getDocs(query(rootSchoolsCollection(), orderBy('name'), limit(500)))
    schools.value = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
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
