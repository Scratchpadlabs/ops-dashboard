<template>
  <div class="pt-4">
    <div v-if="!run && resumable.length" class="bg-blue-50 border border-blue-200 rounded-xl p-4 mb-4">
      <div class="text-sm font-semibold text-blue-900 mb-1">You have an unfinished reset</div>
      <div v-for="r in resumable" :key="r.id" class="flex items-center gap-3 text-sm text-blue-800 py-1">
        <span class="font-medium">{{ r.school_id || '—' }}</span>
        <span class="text-xs text-blue-600">stopped at “{{ labelFor(r.current_step) }}”</span>
        <Button label="Continue" size="small" class="ml-auto" @click="resume(r.id)" />
        <Button label="Discard" text size="small" severity="danger" @click="discard(r.id)" />
      </div>
    </div>

    <div v-if="!run" class="text-center py-16 bg-white rounded-xl border border-slate-200">
      <i class="pi pi-refresh text-4xl text-slate-300 mb-3 block"></i>
      <p class="text-slate-600 font-medium mb-1">Prepare a returning school for a new session</p>
      <p class="text-sm text-slate-500 mb-4 max-w-xl mx-auto">
        Moves students up a grade, clears last session's survey and report state, and updates the
        roster — while keeping subjects, terms, scales and staff. The school's data is archived
        first, and nothing is written until you review an itemized list of every change.
      </p>
      <Button label="Start reset" icon="pi pi-play" @click="begin" />
    </div>

    <WizardShell
      v-else
      title="Reset school"
      :steps="STEPS" :current-step="currentStep" :current-index="currentIndex" :percent="percent"
      :status-of="statusOf" :summary-of="summaryOf" :is-unlocked="isUnlocked"
      :caption="caption" :error="error" :busy="busy" :can-continue="canContinue"
      @go="onGo" @back="onBack" @next="onNext" @skip="onSkip" @exit="onExit"
    >
      <!-- ── 1 · Select school + current state ─────────────────────────── -->
      <div v-if="currentStep === 'reset.select'" class="space-y-3">
        <div>
          <label class="form-label">School *</label>
          <Select v-model="form.schoolId" :options="schools" optionLabel="name" optionValue="id"
            placeholder="Select a school" class="w-80" filter @update:modelValue="loadState" />
        </div>

        <!-- Plain, unavoidable statement of what this operation is. No
             softening: the school tree has no year dimension, so this
             changes live data. -->
        <div class="text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2.5">
          <b>This school's data is not versioned by year.</b>
          There is no separate copy for 2024-25 and 2025-26 — the teacher and student apps read one
          live set of records. A reset therefore changes that live data in place. The next step takes
          a verified archive before anything can be modified.
        </div>

        <div v-if="loadingState" class="flex items-center justify-center py-6">
          <ProgressSpinner style="width:26px;height:26px" />
        </div>
        <div v-else-if="state" class="grid grid-cols-4 gap-2">
          <div v-for="c in STATE_COUNTS" :key="c.key" class="bg-slate-50 rounded-lg px-3 py-2.5">
            <div class="text-xs text-slate-500">{{ c.label }}</div>
            <div class="text-lg font-bold text-slate-900">{{ state.counts[c.key] ?? 0 }}</div>
          </div>
        </div>
      </div>

      <!-- ── 2 · Archive (mandatory) ───────────────────────────────────── -->
      <div v-else-if="currentStep === 'reset.archive'" class="space-y-3">
        <div class="flex items-end gap-2">
          <div>
            <label class="form-label">Session being archived *</label>
            <InputText v-model="form.archiveLabel" class="w-48" placeholder="2025-26" />
          </div>
          <Button label="Create archive" icon="pi pi-database" size="small"
            :loading="archiving" :disabled="!form.archiveLabel.trim() || !!archive?.verified"
            @click="runArchive" />
        </div>

        <div v-if="archiving" class="text-sm text-slate-600">
          Copying students, classes, sheet entries and survey responses. This may take a few minutes
          for a large school. Do not close this tab.
        </div>

        <div v-if="archive" class="border rounded-lg p-3"
             :class="archive.verified ? 'border-emerald-200 bg-emerald-50' : 'border-red-200 bg-red-50'">
          <div class="text-sm font-semibold mb-1" :class="archive.verified ? 'text-emerald-800' : 'text-red-700'">
            {{ archive.verified ? 'Archive verified' : 'Archive verification failed' }}
          </div>
          <div class="text-xs font-mono text-slate-600 mb-2">{{ archive.location }}</div>
          <table class="text-xs">
            <tr v-for="(n, coll) in archive.source_counts" :key="coll">
              <td class="pr-4 text-slate-500">{{ coll }}</td>
              <td class="pr-2 text-slate-700">{{ n }} source</td>
              <td class="text-slate-700">{{ archive.archived_counts[coll] }} archived</td>
              <td class="pl-2">
                <i v-if="archive.archived_counts[coll] === n" class="pi pi-check text-emerald-600" style="font-size:10px"></i>
                <i v-else class="pi pi-times text-red-600" style="font-size:10px"></i>
              </td>
            </tr>
          </table>
          <div v-if="!archive.verified" class="text-xs text-red-700 mt-2">
            Row counts do not match. The reset cannot proceed. Re-run the archive; if it fails again,
            do not continue.
          </div>
        </div>

        <p class="text-xs text-slate-500">
          The archive is written to a location the teacher and student apps never read. It is required:
          the following steps are locked until verification succeeds.
        </p>
      </div>

      <!-- ── 3 · Choose what to reset ──────────────────────────────────── -->
      <div v-else-if="currentStep === 'reset.choose'" class="space-y-2">
        <label v-for="o in RESET_OPTIONS" :key="o.key"
          class="flex items-start gap-2.5 p-2.5 rounded-lg border border-slate-200 cursor-pointer hover:border-slate-300">
          <Checkbox v-model="form.options[o.key]" binary class="mt-0.5" />
          <span>
            <span class="block text-sm font-medium text-slate-800">{{ o.label }}</span>
            <span class="block text-xs text-slate-500">{{ o.hint }}</span>
          </span>
        </label>

        <div class="text-sm text-slate-700 bg-slate-50 rounded-lg px-3 py-2.5">
          <b>Kept, not touched:</b> subjects, terms, grading scales, remark categories, months,
          teachers and staff, and the school's own details.
        </div>
      </div>

      <!-- ── 4 · Roster update ─────────────────────────────────────────── -->
      <div v-else-if="currentStep === 'reset.roster'" class="space-y-3">
        <p class="text-sm text-slate-600">
          Select students who have left. They are marked inactive, not deleted — the archive holds a
          full copy, but a record that disappears from the live tree cannot be recovered here.
          New intake is imported separately after the reset.
        </p>
        <InputText v-model="rosterSearch" class="w-72" placeholder="Search name, roll no or class…" />
        <div class="border border-slate-200 rounded-lg max-h-72 overflow-auto">
          <label v-for="s in filteredRoster" :key="s.id"
            class="flex items-center gap-2 px-3 py-1.5 border-b border-slate-100 last:border-0 text-sm">
            <Checkbox :modelValue="form.removeIds.includes(s.id)" binary
              @update:modelValue="v => toggleRemove(s.id, v)" />
            <span class="text-slate-700">{{ s.name }}</span>
            <span class="text-xs text-slate-400">{{ s.classId }}</span>
          </label>
          <div v-if="!filteredRoster.length" class="text-sm text-slate-400 text-center py-6">
            {{ roster.length ? 'No matching students.' : 'Roster not loaded.' }}
          </div>
        </div>
        <div class="text-sm text-slate-600">
          {{ form.removeIds.length }} marked as leaving · {{ roster.length - form.removeIds.length }} remaining
        </div>
      </div>

      <!-- ── 5 · Preview & confirm ─────────────────────────────────────── -->
      <div v-else-if="currentStep === 'reset.preview'" class="space-y-3">
        <div class="flex items-center gap-2">
          <Button label="Build preview" icon="pi pi-eye" size="small" outlined
            :loading="previewing" @click="runPreview" />
          <label class="flex items-center gap-2 text-sm text-slate-600 ml-2">
            <Checkbox v-model="form.dryRun" binary />
            Dry run — produce the full plan and run log without writing
          </label>
        </div>

        <div v-if="preview" class="border border-slate-200 rounded-lg p-3 space-y-2">
          <div class="text-sm text-slate-800">
            <b>{{ preview.total_students }} students.</b>
            <template v-if="preview.promote">
              {{ preview.promoted_count }} promoted,
              {{ preview.graduating_count }} graduating → marked inactive,
            </template>
            <template v-if="preview.removed_count">{{ preview.removed_count }} leaving → marked inactive,</template>
            <template v-if="preview.inbox_cleared_count">survey inbox cleared for {{ preview.inbox_cleared_count }},</template>
            <template v-if="preview.reports_detached_count">reports detached for {{ preview.reports_detached_count }},</template>
            {{ preview.write_estimate }} record writes in total.
          </div>

          <div v-if="preview.unmapped_count" class="text-sm text-amber-800 bg-amber-50 rounded px-2.5 py-2">
            {{ preview.unmapped_count }} student(s) have a class the promotion rules do not recognize.
            They will be left unchanged. Review them before continuing.
          </div>
          <div v-if="preview.missing_target_classes?.length" class="text-sm text-amber-800 bg-amber-50 rounded px-2.5 py-2">
            These target classes do not exist yet:
            <span class="font-mono">{{ preview.missing_target_classes.join(', ') }}</span>.
            Students promoted into them will reference a class that is not configured. Create the
            classes first, or those students will not appear in class lists.
          </div>

          <div v-if="preview.sample" class="text-xs text-slate-500">
            <div v-for="(rows, kind) in preview.sample" :key="kind">
              <template v-if="rows.length">
                <b class="text-slate-600">{{ kind }}</b> (first {{ rows.length }}):
                <span v-for="r in rows.slice(0, 6)" :key="r.id" class="font-mono mr-2">
                  {{ r.from }}→{{ r.to === '__graduated__' ? 'inactive' : r.to }}
                </span>
              </template>
            </div>
          </div>

          <!-- Stating what is NOT touched is as much a part of the confirm
               step as the change list: it is what stops someone assuming a
               reset wipes their subject and term configuration too. -->
          <div v-if="preview.kept?.length" class="text-sm text-slate-600 bg-slate-50 rounded px-2.5 py-2">
            Left unchanged: {{ preview.kept.join(', ') }}.
          </div>

          <div class="pt-2 border-t border-slate-100">
            <label class="form-label">Type the school id to confirm: <span class="font-mono">{{ form.schoolId }}</span></label>
            <InputText v-model="form.confirmText" class="w-72 font-mono" placeholder="school id" />
          </div>
        </div>
      </div>

      <!-- ── 6 · Execute ───────────────────────────────────────────────── -->
      <div v-else-if="currentStep === 'reset.execute'" class="space-y-3">
        <div v-if="!result" class="text-sm text-slate-700">
          <template v-if="form.dryRun">
            This is a dry run. It will produce the full plan and a run log entry, and will not write
            to any student record.
          </template>
          <template v-else>
            This will apply the changes listed in the previous step to
            <span class="font-mono font-semibold">{{ form.schoolId }}</span>.
            The archive at <span class="font-mono">{{ archive?.location }}</span> has been verified.
          </template>
        </div>

        <div v-if="runDoc || executing" class="border border-slate-200 rounded-lg p-3">
          <div class="flex items-center justify-between text-sm mb-1.5">
            <span class="text-slate-600">
              <i v-if="executing" class="pi pi-spin pi-spinner text-xs mr-1"></i>
              {{ runStatusText }}
            </span>
            <span class="text-slate-500">{{ runDoc?.written ?? 0 }} / {{ runDoc?.expected_writes ?? preview?.write_estimate ?? 0 }}</span>
          </div>
          <div class="h-2 rounded-full bg-slate-100 overflow-hidden">
            <div class="h-full rounded-full bg-blue-500 transition-all" :style="{ width: (runDoc?.progress || 0) + '%' }"></div>
          </div>
          <div v-if="runDoc?.error" class="text-xs text-red-600 mt-2">{{ runDoc.error }}</div>
        </div>

        <Button v-if="!result"
          :label="form.dryRun ? 'Run dry run' : 'Apply reset'"
          :icon="form.dryRun ? 'pi pi-play' : 'pi pi-exclamation-triangle'"
          :severity="form.dryRun ? undefined : 'danger'"
          :loading="executing" @click="runExecute" />

        <div v-if="result" class="text-sm rounded-lg px-3 py-2.5"
             :class="result.applied ? 'bg-emerald-50 text-emerald-800' : 'bg-slate-100 text-slate-700'">
          <template v-if="result.applied">
            Reset complete. {{ result.written }} record(s) updated.
            <span v-if="result.failures?.length">{{ result.failures.length }} failure(s) recorded in the run log.</span>
          </template>
          <template v-else>
            Dry run complete. {{ result.would_write }} record(s) would have been written. Nothing was changed.
          </template>
        </div>
      </div>

      <!-- ── 7 · Post-reset checklist ──────────────────────────────────── -->
      <div v-else-if="currentStep === 'reset.postcheck'" class="space-y-2">
        <p class="text-sm text-slate-600">The reset is done. These are the follow-ups for the new session.</p>
        <div v-for="t in POST_TASKS" :key="t.key"
          class="flex items-center gap-2.5 p-2.5 rounded-lg border border-slate-200">
          <Checkbox v-model="form.postDone[t.key]" binary />
          <span class="text-sm text-slate-700">{{ t.label }}</span>
          <Button :label="t.action" text size="small" class="ml-auto" @click="openTab(t.to)" />
        </div>
      </div>
    </WizardShell>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { doc, onSnapshot, getDocs, query, orderBy, limit } from 'firebase/firestore'
import { useToast } from 'primevue/usetoast'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import Select from 'primevue/select'
import Checkbox from 'primevue/checkbox'
import ProgressSpinner from 'primevue/progressspinner'

import WizardShell from '../wizard/WizardShell.vue'
import { useWizardRun } from '../../composables/useWizardRun.js'
import { captionFor } from '../../utils/wizardCaptions.js'
import {
  rootSchoolsCollection, schoolCollection, schoolResetsCollection,
} from '../../firebase/schoolCollections.js'
import {
  schoolStateRemote, archiveSchoolRemote, resetPreviewRemote, resetExecuteRemote,
} from '../../utils/api.js'

const emit = defineEmits(['open-tab'])
const toast = useToast()

/**
 * Reset wizard.
 *
 * COPY RULE, applied throughout: the archive, choose, roster, preview and
 * execute steps use plain, precise language with no levity, and so does every
 * error message. captionFor() returns '' for those keys by design. Humour is
 * allowed only on the post-reset screen.
 */
const STEPS = [
  { key: 'reset.select', label: 'School & current state',
    blurb: 'Pick the school and see what it holds today. Nothing is modified in this step.' },
  { key: 'reset.archive', label: 'Archive',
    blurb: 'Copies students, classes, sheet entries and survey responses to a location the teacher and student apps never read, then verifies the copy by row count. Required before anything can be changed.' },
  { key: 'reset.choose', label: 'Choose what to reset',
    blurb: 'Each change is opted into individually. Anything not ticked is left exactly as it is.' },
  { key: 'reset.roster', label: 'Roster update', optional: true,
    blurb: 'Mark students who have left. New intake is imported after the reset, once classes reflect the new session.' },
  { key: 'reset.preview', label: 'Preview & confirm',
    blurb: 'An itemized list of every change, produced by the same code that will perform it. Confirmation requires typing the school id.' },
  { key: 'reset.execute', label: 'Execute',
    blurb: 'Applies the changes in batches, with progress and a full run log. A dry run produces the same plan and log without writing.' },
  { key: 'reset.postcheck', label: 'Post-reset checklist',
    blurb: 'What to do next for the new session.' },
]

const STATE_COUNTS = [
  { key: 'students', label: 'Students' }, { key: 'classes', label: 'Classes' },
  { key: 'staffs', label: 'Teachers' }, { key: 'surveys', label: 'Surveys' },
  { key: 'students_with_surveys', label: 'With survey inbox' },
  { key: 'students_with_reports', label: 'With reports' },
  { key: 'smart_sheet_entries', label: 'Sheet entries' },
  { key: 'inactive_students', label: 'Already inactive' },
]

const RESET_OPTIONS = [
  { key: 'promote', label: 'Promote students one grade',
    hint: 'Each class moves up one. The highest grade is marked inactive/graduated rather than promoted, and counted separately.' },
  { key: 'clear_inbox', label: 'Clear survey inbox on all students',
    hint: "Removes last session's assigned surveys. Responses already given are archived and are not deleted." },
  { key: 'clear_reports', label: 'Detach reports from student records',
    hint: 'Empties the reports array on each student. The archive holds the previous contents.' },
  { key: 'clear_sheets', label: 'Clear smart sheet entries',
    hint: "Deletes this school's sheet entries so the new session starts empty." },
]

// DELIBERATELY ABSENT: the Operations and Data-Receivable checklists.
// They live in the ops CRM tree (operations/ops/school_operations/<id> and
// .../school_data_receivable/<id>), keyed by the OPS school doc id — a
// different id space from the root schools/<schoolId> this wizard resets,
// with no link between the two. Offering them here would mean guessing which
// CRM school matches, and a wrong guess silently wipes another school's
// delivery checklist. Reset those from that school's profile page instead,
// where the id is unambiguous.

const POST_TASKS = [
  { key: 'surveys', label: "Assign this session's surveys", to: '/surveys', action: 'Open Surveys' },
  { key: 'teachers', label: 'Verify the teacher list and class-teacher links', to: 'classes-teachers', action: 'Classes & Teachers' },
  { key: 'classes', label: 'Confirm classes match the new session', to: 'classes-teachers', action: 'Classes' },
  { key: 'intake', label: 'Import the new intake', to: '/import', action: 'Open Import' },
]

const wizard = useWizardRun('reset', STEPS)
const { run, currentStep, currentIndex, percent, statusOf, summaryOf, isUnlocked } = wizard

const schools = ref([])
const resumable = ref([])
const state = ref(null)
const roster = ref([])
const archive = ref(null)
const preview = ref(null)
const result = ref(null)
const runDoc = ref(null)
const rosterSearch = ref('')

const busy = ref(false)
const error = ref('')
const caption = ref('')
const loadingState = ref(false)
const archiving = ref(false)
const previewing = ref(false)
const executing = ref(false)
let unsubRun = null

const form = reactive({
  schoolId: null, archiveLabel: '', confirmText: '', dryRun: false,
  options: { promote: true, clear_inbox: true, clear_reports: true,
              clear_sheets: false },
  removeIds: [], postDone: {},
})

function labelFor(key) { return STEPS.find(s => s.key === key)?.label || key }
function openTab(to) { emit('open-tab', to) }

const filteredRoster = computed(() => {
  const q = rosterSearch.value.trim().toLowerCase()
  if (!q) return roster.value.slice(0, 200)
  return roster.value.filter(s =>
    String(s.name || '').toLowerCase().includes(q) ||
    String(s.rollNo || '').toLowerCase().includes(q) ||
    String(s.classId || '').toLowerCase().includes(q)).slice(0, 200)
})

const runStatusText = computed(() => {
  const s = runDoc.value?.status
  if (s === 'done') return 'Complete'
  if (s === 'dry_run_complete') return 'Dry run complete'
  if (s === 'failed') return 'Failed'
  return 'Writing…'
})

// Gating: the archive step cannot be passed without verification, and the
// preview step cannot be passed without the typed confirmation.
const canContinue = computed(() => {
  switch (currentStep.value) {
    case 'reset.select': return !!form.schoolId && !!state.value
    case 'reset.archive': return !!archive.value?.verified
    case 'reset.choose': return Object.values(form.options).some(Boolean)
    case 'reset.preview': return !!preview.value && form.confirmText.trim() === form.schoolId
    case 'reset.execute': return !!result.value
    default: return true
  }
})

// ── Lifecycle ───────────────────────────────────────────────────────────────
async function begin() { busy.value = true; try { await wizard.start() } finally { busy.value = false } }
async function resume(runId) {
  await wizard.load(runId)
  if (run.value?.school_id) { form.schoolId = run.value.school_id; await loadState() }
}
async function discard(runId) {
  await wizard.load(runId); await wizard.abandon()
  wizard.run.value = null
  resumable.value = resumable.value.filter(r => r.id !== runId)
}
function onExit() { unsubRun?.(); wizard.run.value = null; refreshResumable() }
async function refreshResumable() { resumable.value = await wizard.findResumable() }

async function loadState() {
  if (!form.schoolId) return
  loadingState.value = true
  error.value = ''
  try {
    state.value = await schoolStateRemote({ schoolId: form.schoolId })
    await wizard.setSchool(form.schoolId)
  } catch (e) {
    error.value = e.message || 'Could not read the school state.'
  } finally {
    loadingState.value = false
  }
}

async function loadRoster() {
  if (!form.schoolId) return
  const snap = await getDocs(schoolCollection(form.schoolId, 'students'))
  // Doc id assigned AFTER the spread: a student document carrying its own
  // `id` field must not shadow the real one. removeIds is matched against
  // the doc id server-side, so a shadowed id here would silently mark the
  // wrong student as left — or none at all.
  roster.value = snap.docs.map(d => ({ ...d.data(), id: d.id }))
    .filter(s => (s.type || 'student') === 'student' && s.isActive !== false)
    .sort((a, b) => String(a.classId || '').localeCompare(String(b.classId || '')))
}

function toggleRemove(id, wanted) {
  form.removeIds = wanted
    ? [...new Set([...form.removeIds, id])]
    : form.removeIds.filter(x => x !== id)
}

// ── Step operations ─────────────────────────────────────────────────────────
async function runArchive() {
  archiving.value = true
  error.value = ''
  try {
    archive.value = await archiveSchoolRemote({
      schoolId: form.schoolId, label: form.archiveLabel.trim(),
    })
    if (!archive.value.verified) {
      error.value = 'Archive verification failed. The reset cannot proceed until an archive verifies.'
    }
  } catch (e) {
    error.value = e.message || 'The archive could not be created. The reset cannot proceed.'
  } finally {
    archiving.value = false
  }
}

async function runPreview() {
  previewing.value = true
  error.value = ''
  try {
    preview.value = await resetPreviewRemote({
      schoolId: form.schoolId,
      options: { ...form.options, remove_ids: form.removeIds },
    })
  } catch (e) {
    error.value = e.message || 'The preview could not be built.'
  } finally {
    previewing.value = false
  }
}

async function runExecute() {
  executing.value = true
  error.value = ''
  const runId = doc(schoolResetsCollection(form.schoolId)).id
  unsubRun = onSnapshot(doc(schoolResetsCollection(form.schoolId), runId),
    snap => { runDoc.value = snap.exists() ? snap.data() : null })
  try {
    result.value = await resetExecuteRemote({
      schoolId: form.schoolId, confirmSchoolId: form.confirmText.trim(),
      archiveId: archive.value?.archive_id, runId,
      options: { ...form.options, remove_ids: form.removeIds },
      dryRun: form.dryRun,
    })
  } catch (e) {
    error.value = e.message || 'The reset failed. See the run log for what completed.'
  } finally {
    executing.value = false
  }
}

// ── Navigation ──────────────────────────────────────────────────────────────
async function onGo(key) { caption.value = ''; await wizard.goTo(key) }
async function onBack() { caption.value = ''; await wizard.goTo(STEPS[Math.max(0, currentIndex.value - 1)].key) }
async function onSkip() { await wizard.completeStep(currentStep.value, 'Skipped', { skipped: true }); caption.value = '' }

async function onNext() {
  busy.value = true
  error.value = ''
  try {
    const key = currentStep.value
    let summary = ''
    switch (key) {
      case 'reset.select':
        summary = `${form.schoolId} · ${state.value?.counts?.students ?? 0} students`
        await loadRoster()
        break
      case 'reset.archive':
        summary = `Archived to ${archive.value.location}`
        break
      case 'reset.choose':
        summary = RESET_OPTIONS.filter(o => form.options[o.key]).length + ' change(s) selected'
        break
      case 'reset.roster':
        summary = `${form.removeIds.length} leaving`
        break
      case 'reset.preview':
        summary = `${preview.value.write_estimate} record writes confirmed`
        break
      case 'reset.execute':
        summary = result.value.applied
          ? `${result.value.written} records updated`
          : `Dry run · ${result.value.would_write} would change`
        break
      case 'reset.postcheck':
        summary = `${Object.values(form.postDone).filter(Boolean).length} of ${POST_TASKS.length} follow-ups done`
        await wizard.finish(summary)
        toast.add({ severity: 'success', summary: 'Reset complete', detail: summary, life: 5000 })
        break
    }
    // Empty for every destructive step by design — see wizardCaptions.js.
    caption.value = captionFor(key)
    await wizard.completeStep(key, summary)
  } catch (e) {
    console.error(e)
    error.value = e.message || 'This step could not be completed.'
  } finally {
    busy.value = false
  }
}

onMounted(async () => {
  const snap = await getDocs(query(rootSchoolsCollection(), orderBy('name'), limit(500)))
  // data() first: school docs carry their own `id` field, which would
  // otherwise shadow the real Firestore doc id.
  schools.value = snap.docs.map(d => ({ ...d.data(), id: d.id })).filter(s => s.isActive !== false)
  await refreshResumable()
})
</script>

<style scoped>
.form-label {
  display: block; font-size: 12px; font-weight: 500; color: #64748b;
  margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.04em;
}
</style>
