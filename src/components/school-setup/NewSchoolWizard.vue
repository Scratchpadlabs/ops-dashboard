<template>
  <div class="pt-4">
    <!-- Resume prompt: an unfinished run is offered, never silently resumed. -->
    <div v-if="!run && resumable.length" class="bg-blue-50 border border-blue-200 rounded-xl p-4 mb-4">
      <div class="text-sm font-semibold text-blue-900 mb-1">You have an unfinished school setup</div>
      <div v-for="r in resumable" :key="r.id" class="flex items-center gap-3 text-sm text-blue-800 py-1">
        <span class="font-medium">{{ r.school_id || 'New school' }}</span>
        <span class="text-xs text-blue-600">stopped at “{{ labelFor(r.current_step) }}”</span>
        <Button label="Continue setup" size="small" class="ml-auto" @click="resume(r.id)" />
        <Button label="Discard" text size="small" severity="danger" @click="discard(r.id)" />
      </div>
    </div>

    <div v-if="!run" class="text-center py-16 bg-white rounded-xl border border-slate-200">
      <i class="pi pi-building text-4xl text-slate-300 mb-3 block"></i>
      <p class="text-slate-600 font-medium mb-1">Set up a new school, start to finish</p>
      <p class="text-sm text-slate-400 mb-4 max-w-lg mx-auto">
        Eight guided steps: create the school, describe it, build its classes and subjects,
        load its people, and check nothing was missed. You can stop at any point and pick it up later.
      </p>
      <Button label="Start new school setup" icon="pi pi-play" @click="begin" />
    </div>

    <WizardShell
      v-else
      title="New school"
      :steps="STEPS" :current-step="currentStep" :current-index="currentIndex" :percent="percent"
      :status-of="statusOf" :summary-of="summaryOf" :is-unlocked="isUnlocked"
      :caption="caption" :error="error" :busy="busy" :can-continue="canContinue"
      @go="onGo" @back="onBack" @next="onNext" @skip="onSkip" @exit="onExit"
    >
      <!-- ── 1 · Create ────────────────────────────────────────────────── -->
      <div v-if="currentStep === 'new.create'" class="space-y-4">
        <div class="grid grid-cols-2 gap-4">
          <div>
            <label class="form-label">School name *</label>
            <InputText v-model="form.name" class="w-full" placeholder="e.g. Samartha International School"
              @blur="suggestId" />
          </div>
          <div>
            <label class="form-label">School ID (Firestore doc id) *</label>
            <InputText v-model="form.id" class="w-full font-mono text-sm" placeholder="e.g. Samartha_International_School" />
            <p class="text-xs text-slate-400 mt-1">Suggested from the name — edit it if you want a different id.</p>
          </div>
        </div>

        <Button label="Check availability" icon="pi pi-search" size="small" outlined
          :loading="checking" :disabled="!form.id.trim() || !form.name.trim()" @click="runCheck" />

        <div v-if="check" class="space-y-2">
          <div v-if="check.id_error" class="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{{ check.id_error }}</div>
          <div v-else-if="check.id_taken" class="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">
            <b>{{ form.id }}</b> already exists. Pick a different id.
          </div>
          <div v-else class="text-sm text-emerald-700 bg-emerald-50 rounded-lg px-3 py-2">
            <i class="pi pi-check-circle text-xs mr-1"></i><b>{{ form.id }}</b> is available.
          </div>

          <!-- Near-duplicate warning: the schools collection already carries
               several near-identical names, so this warns loudly but still
               lets a deliberate choice through. -->
          <div v-if="check.similar?.length" class="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            <div class="font-semibold mb-1">
              <i class="pi pi-exclamation-triangle text-xs mr-1"></i>Similar school{{ check.similar.length !== 1 ? 's' : '' }} already exist
            </div>
            <div v-for="s in check.similar" :key="s.id" class="text-xs py-0.5">
              <span class="font-medium">{{ s.name }}</span>
              <span class="text-amber-600 font-mono"> ({{ s.id }})</span>
              <span class="text-amber-600"> — {{ s.reason }}</span>
            </div>
            <label class="flex items-center gap-2 mt-2 text-xs">
              <Checkbox v-model="form.dupeAcknowledged" binary />
              This is a different school — create it anyway
            </label>
          </div>
        </div>
      </div>

      <!-- ── 2 · Details ───────────────────────────────────────────────── -->
      <div v-else-if="currentStep === 'new.details'" class="grid grid-cols-2 gap-4">
        <div><label class="form-label">City</label><InputText v-model="form.city" class="w-full" /></div>
        <div><label class="form-label">State</label><InputText v-model="form.state" class="w-full" /></div>
        <div><label class="form-label">Board</label>
          <Select v-model="form.board" :options="BOARDS" class="w-full" editable placeholder="CBSE / ICSE / State…" />
        </div>
        <div><label class="form-label">Pipeline stage</label>
          <Select v-model="form.stage" :options="STAGES" class="w-full" />
        </div>
        <div><label class="form-label">Contact person</label><InputText v-model="form.contact_person" class="w-full" /></div>
        <div><label class="form-label">Contact phone</label><InputText v-model="form.contact_phone" class="w-full" /></div>
        <div><label class="form-label">Contact email</label><InputText v-model="form.contact_email" class="w-full" /></div>
        <div><label class="form-label">Owner / relationship manager</label>
          <Select v-model="form.owner" :options="OWNERS" class="w-full" showClear />
        </div>
        <div class="col-span-2"><label class="form-label">Address</label>
          <Textarea v-model="form.address" class="w-full" rows="2" autoResize />
        </div>
      </div>

      <!-- ── 3 · Structure ─────────────────────────────────────────────── -->
      <div v-else-if="currentStep === 'new.structure'" class="space-y-3">
        <div class="grid grid-cols-3 gap-2">
          <button v-for="r in STRUCTURE_ROUTES" :key="r.value" type="button"
            class="p-3 rounded-lg border text-left transition-all"
            :class="form.structureRoute === r.value ? 'border-blue-500 bg-blue-50' : 'border-slate-200 hover:border-slate-300'"
            @click="form.structureRoute = r.value">
            <div class="text-sm font-semibold text-slate-900">{{ r.label }}</div>
            <div class="text-xs text-slate-500 mt-0.5">{{ r.hint }}</div>
          </button>
        </div>

        <div v-if="form.structureRoute === 'manual'" class="space-y-2">
          <div class="flex items-end gap-2">
            <div><label class="form-label">Grades</label>
              <MultiSelect v-model="form.grades" :options="GRADE_OPTIONS" class="w-72" display="chip" :maxSelectedLabels="6" />
            </div>
            <div><label class="form-label">Sections per grade</label>
              <InputText v-model="form.sections" class="w-56" placeholder="A, B, C  or  Diamond, Ruby" />
            </div>
          </div>
          <p class="text-xs text-slate-400">Every grade gets every section. Fine-tune individual classes later in Classes &amp; Teachers.</p>
        </div>

        <div v-else-if="form.structureRoute === 'import'" class="text-sm text-slate-600 bg-slate-50 rounded-lg px-3 py-2.5">
          Structure will be proposed from a staged student import.
          Run the import first, then use <b>Propose Structure</b> — it derives grades and sections
          from the roster and shows a reviewable proposal.
          <router-link to="/import" class="text-violet-600 underline ml-1">Open Import</router-link>
        </div>

        <div v-else class="text-sm text-slate-600 bg-slate-50 rounded-lg px-3 py-2.5">
          A config template will be applied after the school is created — pick one in the
          <b>Templates</b> tab. Templates carry terms, scales, assessments and co-scholastic
          activities, not classes.
        </div>

        <div v-if="previewClasses.length" class="border border-slate-200 rounded-lg p-3">
          <div class="text-xs font-semibold text-slate-400 uppercase mb-2">
            {{ previewClasses.length }} classes will be created
          </div>
          <div class="flex flex-wrap gap-1">
            <span v-for="c in previewClasses" :key="c"
              class="px-2 py-0.5 rounded text-xs font-mono bg-slate-100 text-slate-600">{{ c }}</span>
          </div>
        </div>
      </div>

      <!-- ── 4 · Subjects / 5 · Academics / 6 · People / 7 · Surveys ───── -->
      <div v-else-if="HANDOFF_STEPS[currentStep]" class="space-y-3">
        <div class="text-sm text-slate-600 bg-slate-50 rounded-lg px-3 py-2.5">
          {{ HANDOFF_STEPS[currentStep].body }}
        </div>
        <div class="flex flex-wrap gap-2">
          <Button v-for="l in HANDOFF_STEPS[currentStep].links" :key="l.to"
            :label="l.label" icon="pi pi-external-link" size="small" outlined
            @click="openTab(l.to)" />
        </div>
        <div>
          <label class="form-label">What did you set up? (one line, appears in the step rail)</label>
          <InputText v-model="form.notes[currentStep]" class="w-full"
            :placeholder="HANDOFF_STEPS[currentStep].placeholder" />
        </div>
      </div>

      <!-- ── 8 · Review ────────────────────────────────────────────────── -->
      <div v-else-if="currentStep === 'new.review'" class="space-y-3">
        <div v-if="loadingState" class="flex items-center justify-center py-8">
          <ProgressSpinner style="width:26px;height:26px" />
        </div>
        <template v-else-if="state">
          <div class="grid grid-cols-4 gap-2">
            <div v-for="c in REVIEW_COUNTS" :key="c.key"
              class="rounded-lg px-3 py-2.5" :class="(state.counts[c.key] || 0) > 0 ? 'bg-emerald-50' : 'bg-amber-50'">
              <div class="text-xs text-slate-500">{{ c.label }}</div>
              <div class="text-lg font-bold" :class="(state.counts[c.key] || 0) > 0 ? 'text-emerald-700' : 'text-amber-700'">
                {{ state.counts[c.key] || 0 }}
              </div>
            </div>
          </div>
          <!-- Gaps are LISTED, never hidden. A wizard that quietly reports
               success on a half-configured school is worse than no wizard. -->
          <div v-if="gaps.length" class="border border-amber-200 bg-amber-50 rounded-lg p-3">
            <div class="text-sm font-semibold text-amber-800 mb-1">Still missing ({{ gaps.length }})</div>
            <div v-for="g in gaps" :key="g.key" class="flex items-center gap-2 text-sm text-amber-800 py-0.5">
              <i class="pi pi-exclamation-triangle text-xs"></i>
              <span>{{ g.label }}</span>
              <Button :label="g.action" text size="small" class="ml-auto" @click="openTab(g.to)" />
            </div>
          </div>
          <div v-else class="text-sm text-emerald-700 bg-emerald-50 rounded-lg px-3 py-2">
            <i class="pi pi-check-circle text-xs mr-1"></i>Everything the wizard checks for is configured.
          </div>
        </template>
        <Button label="Re-check" icon="pi pi-refresh" text size="small" @click="loadState" />
      </div>
    </WizardShell>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { setDoc, getDoc, serverTimestamp, writeBatch } from 'firebase/firestore'
import { useToast } from 'primevue/usetoast'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import Textarea from 'primevue/textarea'
import Select from 'primevue/select'
import MultiSelect from 'primevue/multiselect'
import Checkbox from 'primevue/checkbox'
import ProgressSpinner from 'primevue/progressspinner'

import WizardShell from '../wizard/WizardShell.vue'
import { useWizardRun } from '../../composables/useWizardRun.js'
import { captionFor } from '../../utils/wizardCaptions.js'
import { rootSchoolDoc, schoolDoc } from '../../firebase/schoolCollections.js'
import { db, auth } from '../../firebase/config'
import { checkNewSchoolRemote, schoolStateRemote } from '../../utils/api.js'
import { slugifySchoolId } from '../../utils/wizardHelpers.js'

const emit = defineEmits(['open-tab', 'school-created'])
const toast = useToast()

const STEPS = [
  { key: 'new.create', label: 'Create the school',
    blurb: 'Creates the Firestore document everything else hangs off. The id is yours to choose — it is how the school is addressed everywhere, so it cannot be changed later.' },
  { key: 'new.details', label: 'School details',
    blurb: 'Location, board, contact and owner. Used on generated documents and for filtering across the dashboard.' },
  { key: 'new.structure', label: 'Grades & sections',
    blurb: 'The classes students will belong to. Everything downstream — subjects, surveys, reports — is scoped by class, so this comes before people.' },
  { key: 'new.subjects', label: 'Subjects',
    blurb: 'Scholastic and co-scholastic subjects per grade. The knowledge base classifies each name so the split is consistent across schools.' },
  { key: 'new.academics', label: 'Terms, scales & remarks',
    blurb: 'The assessment machinery: terms, grading scales, months and remark categories. Applying a template is usually faster than building it by hand.' },
  { key: 'new.people', label: 'Teachers & students',
    blurb: 'Import staff first, then the student roster — students need their classes to exist, which they now do.' },
  { key: 'new.surveys', label: 'Surveys', optional: true,
    blurb: 'Assign the standard survey set to the new students. Safe to leave until the roster settles.' },
  { key: 'new.review', label: 'Review & finish',
    blurb: 'What is configured, what is missing, and where to fix each gap. Nothing incomplete is hidden.' },
]

const BOARDS = ['CBSE', 'ICSE', 'State Board', 'IB', 'Cambridge']
const STAGES = ['Onboarding', 'Active', 'Pilot', 'Paused']
const OWNERS = ['Angel', 'Siddhesh']
const GRADE_OPTIONS = ['Nursery', 'LKG', 'UKG', 'I', 'II', 'III', 'IV', 'V', 'VI',
                        'VII', 'VIII', 'IX', 'X', 'XI', 'XII']
const STRUCTURE_ROUTES = [
  { value: 'manual', label: 'Enter manually', hint: 'Pick grades and sections' },
  { value: 'import', label: 'From a student file', hint: 'Derive it from a staged import' },
  { value: 'template', label: 'Apply a template', hint: 'Use a saved config bundle' },
]
const REVIEW_COUNTS = [
  { key: 'classes', label: 'Classes' }, { key: 'subjects', label: 'Subjects' },
  { key: 'terms', label: 'Terms' }, { key: 'staffs', label: 'Staff' },
  { key: 'students', label: 'Students' }, { key: 'surveys', label: 'Surveys' },
  { key: 'students_with_surveys', label: 'With surveys' },
]
const HANDOFF_STEPS = {
  'new.subjects': {
    body: 'Add subjects in the Subjects tab. Type a name and the knowledge base will classify it as scholastic or co-scholastic; section-level differences (3A/B/C Hindi+Marathi, 3D Hindi+Sanskrit) are handled per class in Classes & Teachers.',
    links: [{ to: 'subjects', label: 'Subjects tab' }, { to: 'classes-teachers', label: 'Classes & Teachers' }],
    placeholder: 'e.g. 8 subjects across I–V',
  },
  'new.academics': {
    body: 'Set terms, grading scales, months and remark categories. Applying a template from the Templates tab is usually the fastest route; you can adjust afterwards.',
    links: [{ to: 'templates', label: 'Templates' }, { to: 'terms-scales', label: 'Terms & Scales' },
             { to: 'months', label: 'Months' }, { to: 'remarks', label: 'Remarks' }],
    placeholder: 'e.g. 2 terms, 5-point scale, template applied',
  },
  'new.people': {
    body: 'Import teachers first so class-teacher links resolve, then the student roster. The importer cleans names, emails and grades, and shows a review screen before anything is written.',
    links: [{ to: '/import', label: 'Open Import' }, { to: 'classes-teachers', label: 'Classes & Teachers' }],
    placeholder: 'e.g. 21 teachers, 342 students',
  },
  'new.surveys': {
    body: 'Assign this year\'s surveys from the Surveys section — pick classes and surveys in the matrix and assign them in one action.',
    links: [{ to: '/surveys', label: 'Open Surveys' }],
    placeholder: 'e.g. AAM1-prep assigned to all classes',
  },
}

const wizard = useWizardRun('new', STEPS)
const {
  run, currentStep, currentIndex, percent, statusOf, summaryOf, isUnlocked,
} = wizard

const resumable = ref([])
const busy = ref(false)
const error = ref('')
const caption = ref('')
const checking = ref(false)
const check = ref(null)
const state = ref(null)
const loadingState = ref(false)

const form = reactive({
  id: '', name: '', dupeAcknowledged: false,
  city: '', state: '', board: '', stage: 'Onboarding',
  contact_person: '', contact_phone: '', contact_email: '', owner: null, address: '',
  structureRoute: 'manual', grades: [], sections: 'A, B',
  notes: {},
})

function labelFor(key) { return STEPS.find(s => s.key === key)?.label || key }
function openTab(to) { emit('open-tab', to) }

const previewClasses = computed(() => {
  if (form.structureRoute !== 'manual') return []
  const sections = form.sections.split(',').map(s => s.trim()).filter(Boolean)
  if (!form.grades.length || !sections.length) return []
  return form.grades.flatMap(g => sections.map(s => `${g}_${s}`))
})

const gaps = computed(() => {
  if (!state.value) return []
  const c = state.value.counts
  const out = []
  if (!c.classes) out.push({ key: 'classes', label: 'No classes configured', to: 'classes-teachers', action: 'Add classes' })
  if (!c.subjects) out.push({ key: 'subjects', label: 'No subjects configured', to: 'subjects', action: 'Add subjects' })
  if (!c.terms) out.push({ key: 'terms', label: 'No terms configured', to: 'terms-scales', action: 'Add terms' })
  if (!c.staffs) out.push({ key: 'staffs', label: 'No staff imported', to: '/import', action: 'Import staff' })
  if (!c.students) out.push({ key: 'students', label: 'No students imported', to: '/import', action: 'Import students' })
  if (c.students && !c.students_with_surveys) out.push({ key: 'surveys', label: 'No students have surveys assigned', to: '/surveys', action: 'Assign surveys' })
  return out
})

const canContinue = computed(() => {
  if (currentStep.value === 'new.create') {
    if (!form.id.trim() || !form.name.trim()) return false
    if (!check.value) return false
    if (check.value.id_error || check.value.id_taken) return false
    if (check.value.similar?.length && !form.dupeAcknowledged) return false
    return true
  }
  if (currentStep.value === 'new.structure' && form.structureRoute === 'manual') {
    return previewClasses.value.length > 0
  }
  return true
})

// ── Run lifecycle ───────────────────────────────────────────────────────────
async function begin() {
  busy.value = true
  try { await wizard.start() } finally { busy.value = false }
}
async function resume(runId) {
  await wizard.load(runId)
  if (run.value?.school_id) { form.id = run.value.school_id; await loadState() }
}
async function discard(runId) {
  await wizard.load(runId)
  await wizard.abandon()
  wizard.run.value = null
  resumable.value = resumable.value.filter(r => r.id !== runId)
}
function onExit() { wizard.run.value = null; refreshResumable() }
async function refreshResumable() { resumable.value = await wizard.findResumable() }

function suggestId() {
  if (!form.id.trim() && form.name.trim()) form.id = slugifySchoolId(form.name)
}

async function runCheck() {
  checking.value = true
  error.value = ''
  try {
    check.value = await checkNewSchoolRemote({ schoolId: form.id.trim(), name: form.name.trim() })
    form.dupeAcknowledged = false
  } catch (e) {
    error.value = e.message || 'Could not check the school id.'
  } finally {
    checking.value = false
  }
}

async function loadState() {
  const sid = run.value?.school_id || form.id.trim()
  if (!sid) return
  loadingState.value = true
  try {
    state.value = await schoolStateRemote({ schoolId: sid })
  } catch (e) {
    error.value = e.message || 'Could not read the school state.'
  } finally {
    loadingState.value = false
  }
}

// ── Step actions ────────────────────────────────────────────────────────────
async function onGo(key) { caption.value = ''; await wizard.goTo(key) }
async function onBack() {
  caption.value = ''
  const prev = STEPS[Math.max(0, currentIndex.value - 1)]
  await wizard.goTo(prev.key)
}
async function onSkip() {
  const key = currentStep.value
  await wizard.completeStep(key, 'Skipped', { skipped: true })
  caption.value = ''
}

async function onNext() {
  busy.value = true
  error.value = ''
  try {
    const key = currentStep.value
    const summary = await commitStep(key)
    if (summary === false) return
    if (key === 'new.review') {
      await wizard.finish(summary)
      toast.add({ severity: 'success', summary: 'School setup complete', detail: summary, life: 5000 })
    }
    caption.value = captionFor(key)
    await wizard.completeStep(key, summary)
  } catch (e) {
    console.error(e)
    error.value = e.message || 'Something went wrong on this step.'
  } finally {
    busy.value = false
  }
}

/**
 * Performs the step's actual work and returns its one-line summary, or
 * `false` to stay put. Only two steps write to the school tree — creation
 * and structure — and both are reached through an explicit Continue.
 */
async function commitStep(key) {
  if (key === 'new.create') {
    const sid = form.id.trim()
    const existing = await getDoc(rootSchoolDoc(sid))
    if (existing.exists()) {
      error.value = `${sid} already exists. Pick a different id.`
      return false
    }
    await setDoc(rootSchoolDoc(sid), {
      id: sid, name: form.name.trim(), isActive: true,
      created_at: serverTimestamp(), created_by: auth.currentUser?.email || 'unknown',
      created_via: 'new_school_wizard',
    })
    await wizard.setSchool(sid)
    emit('school-created', sid)
    return `${form.name.trim()} (${sid})`
  }

  if (key === 'new.details') {
    const sid = run.value?.school_id
    if (!sid) { error.value = 'The school has not been created yet.'; return false }
    await setDoc(rootSchoolDoc(sid), {
      city: form.city.trim(), state: form.state.trim(), board: form.board || '',
      stage: form.stage, contact_person: form.contact_person.trim(),
      contact_phone: form.contact_phone.trim(), contact_email: form.contact_email.trim(),
      owner: form.owner || null, address: form.address.trim(),
      updated_at: serverTimestamp(), updated_by: auth.currentUser?.email || 'unknown',
    }, { merge: true })
    return [form.city, form.board, form.owner].filter(Boolean).join(' · ') || 'Details saved'
  }

  if (key === 'new.structure') {
    const sid = run.value?.school_id
    if (form.structureRoute !== 'manual') {
      return form.structureRoute === 'import' ? 'From student import' : 'From template'
    }
    const classes = previewClasses.value
    for (let i = 0; i < classes.length; i += 400) {
      const batch = writeBatch(db)
      for (const cid of classes.slice(i, i + 400)) {
        const [clazz, section] = cid.split('_')
        batch.set(schoolDoc(sid, 'classes', cid), {
          id: cid, clazz, section, name: `${clazz} ${section}`,
          stage: 'foundation', isActive: true, subjects: [],
          created_at: serverTimestamp(), created_by: auth.currentUser?.email || 'unknown',
          created_via: 'new_school_wizard',
        }, { merge: true })
      }
      await batch.commit()
    }
    return `${classes.length} classes`
  }

  if (key === 'new.review') {
    await loadState()
    const c = state.value?.counts || {}
    return `${c.classes || 0} classes, ${c.students || 0} students, ${gaps.value.length} gap(s)`
  }

  // Hand-off steps record what the user did elsewhere.
  return (form.notes[key] || '').trim() || 'Done'
}

onMounted(async () => {
  await refreshResumable()
})
</script>

<style scoped>
.form-label {
  display: block; font-size: 12px; font-weight: 500; color: #64748b;
  margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.04em;
}
</style>
