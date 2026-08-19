<template>
  <div class="pt-4">
    <div class="flex items-center justify-between mb-3">
      <div>
        <div class="text-sm font-bold text-slate-900">Propose Structure From Data</div>
        <div class="text-xs text-slate-400 mt-0.5">
          Reads this school's imports and proposes its grades, sections, subjects and subject-class mappings. Nothing is written until you apply it.
        </div>
      </div>
      <Button
        label="Propose structure" icon="pi pi-sparkles" size="small"
        :loading="running" :disabled="!schoolId || !selectedJobIds.length"
        @click="runInference"
      />
    </div>

    <div v-if="!schoolId" class="text-center text-sm text-slate-400 py-10 bg-white rounded-xl border border-slate-200">
      Select a school first.
    </div>

    <template v-else>
      <!-- ── Source imports ─────────────────────────────────────────────── -->
      <div class="bg-white rounded-xl border border-slate-200 p-4 mb-4">
        <div class="flex items-center justify-between mb-2">
          <div class="text-xs font-semibold text-slate-400 uppercase tracking-wide">Source Imports</div>
          <Button label="Reload" icon="pi pi-refresh" text size="small" :loading="loadingJobs" @click="loadJobs" />
        </div>
        <div v-if="loadingJobs" class="flex items-center justify-center py-6"><ProgressSpinner style="width:24px;height:24px" /></div>
        <div v-else-if="!jobs.length" class="text-sm text-slate-400 py-4 text-center">
          No student or teacher imports for this school yet — run one from
          <router-link to="/import" class="text-violet-600 underline">School Material Import</router-link> first.
        </div>
        <div v-else class="space-y-1.5">
          <label v-for="j in jobs" :key="j.id" class="flex items-center gap-2.5 text-sm py-0.5">
            <Checkbox v-model="selectedJobIds" :value="j.id" />
            <span class="capitalize font-medium text-slate-700">{{ j.entity }}</span>
            <span class="px-2 py-0.5 rounded-full text-xs font-semibold" :class="j.status === 'committed' ? 'bg-green-50 text-green-700' : 'bg-blue-50 text-blue-700'">{{ j.status }}</span>
            <span class="text-xs text-slate-400">{{ j.included_row_count ?? j.row_count ?? 0 }} rows · {{ formatTs(j.created_at) }}</span>
          </label>
          <p class="text-xs text-slate-400 pt-1">Committed and staged jobs both count — staged rows let you propose a structure before committing the roster.</p>
        </div>
      </div>

      <div v-if="inferError" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2 mb-4">{{ inferError }}</div>

      <!-- ── Proposal ───────────────────────────────────────────────────── -->
      <div v-if="proposal">
        <div class="bg-white rounded-xl border border-slate-200 p-4 mb-4">
          <div class="flex items-center gap-6 flex-wrap">
            <div><span class="text-lg font-bold text-slate-900">{{ summary.classes }}</span> <span class="text-xs text-slate-400">classes to add</span></div>
            <div><span class="text-lg font-bold text-slate-900">{{ summary.subjects }}</span> <span class="text-xs text-slate-400">subjects to add</span></div>
            <div><span class="text-lg font-bold text-slate-900">{{ summary.mappings }}</span> <span class="text-xs text-slate-400">subject-class links</span></div>
            <div><span class="text-lg font-bold" :class="summary.conflicts ? 'text-red-600' : 'text-slate-900'">{{ summary.conflicts }}</span> <span class="text-xs text-slate-400">conflicts</span></div>
            <div class="text-xs text-slate-400">
              from {{ proposal.evidence.studentRows }} student and {{ proposal.evidence.teacherRows }} teacher rows
            </div>
            <div class="ml-auto">
              <Button label="Apply accepted items" icon="pi pi-check" size="small" :loading="applying" :disabled="!hasAnythingToApply" @click="confirmApply" />
            </div>
          </div>
        </div>

        <!-- Findings -->
        <div v-if="proposal.flags.length" class="bg-white rounded-xl border border-amber-200 p-4 mb-4">
          <div class="text-xs font-semibold text-amber-600 uppercase tracking-wide mb-2">Findings ({{ proposal.flags.length }})</div>
          <div v-for="(f, i) in proposal.flags" :key="i" class="flex items-start gap-2 text-sm py-0.5">
            <i class="pi text-xs mt-1" :class="f.severity === 'warning' ? 'pi-exclamation-triangle text-amber-500' : 'pi-info-circle text-slate-400'"></i>
            <span class="text-slate-600">{{ f.message }}</span>
          </div>
        </div>

        <!-- Classes -->
        <div class="bg-white rounded-xl border border-slate-200 overflow-hidden mb-4">
          <div class="px-4 py-2.5 border-b border-slate-100 flex items-center justify-between">
            <div class="text-sm font-bold text-slate-900">Grades &amp; Sections <span class="text-xs font-normal text-slate-400">from student data</span></div>
            <button type="button" class="text-xs text-violet-600 font-semibold" @click="toggleAll('classes')">Toggle all new</button>
          </div>
          <DataTable :value="proposal.classes" size="small" stripedRows>
            <Column style="width:3rem">
              <template #body="{ data }">
                <Checkbox v-model="data.accepted" binary :disabled="data.status === STATUS_EXISTING" />
              </template>
            </Column>
            <Column header="Class">
              <template #body="{ data }"><span class="font-medium text-slate-800">{{ data.clazz }} — {{ data.section }}</span></template>
            </Column>
            <Column header="Evidence">
              <template #body="{ data }">
                <span class="text-xs text-slate-500">
                  {{ data.studentCount }} student{{ data.studentCount !== 1 ? 's' : '' }}
                  <span v-if="!data.fromStudents" class="text-amber-600">· teacher data only</span>
                </span>
              </template>
            </Column>
            <Column header="Status" style="width:120px">
              <template #body="{ data }"><span class="px-2 py-0.5 rounded-full text-xs font-semibold" :class="statusClass(data.status)">{{ statusLabel(data.status) }}</span></template>
            </Column>
          </DataTable>
          <div v-if="!proposal.classes.length" class="text-center text-sm text-slate-400 py-6">No classes inferred</div>
        </div>

        <!-- Subjects -->
        <div class="bg-white rounded-xl border border-slate-200 overflow-hidden mb-4">
          <div class="px-4 py-2.5 border-b border-slate-100 flex items-center justify-between">
            <div class="text-sm font-bold text-slate-900">Subjects <span class="text-xs font-normal text-slate-400">from teacher data, split by the knowledge base</span></div>
            <button type="button" class="text-xs text-violet-600 font-semibold" @click="toggleAll('subjects')">Toggle all new</button>
          </div>
          <DataTable :value="proposal.subjects" size="small" stripedRows>
            <Column style="width:3rem">
              <template #body="{ data }">
                <Checkbox v-model="data.accepted" binary :disabled="data.status === STATUS_EXISTING" />
              </template>
            </Column>
            <Column header="Grade" style="width:80px">
              <template #body="{ data }"><span class="text-slate-700">{{ data.grade }}</span></template>
            </Column>
            <Column header="Subject">
              <template #body="{ data }">
                <InputText v-model="data.name" class="w-full text-sm" size="small" />
                <div v-if="data.rawNames.length > 1 || data.rawNames[0] !== data.name" class="text-[11px] text-slate-400 mt-0.5">
                  from {{ data.rawNames.map(n => `“${n}”`).join(', ') }}
                </div>
              </template>
            </Column>
            <Column header="Area" style="width:170px">
              <template #body="{ data }">
                <Select v-model="data.area" :options="areaOptions" placeholder="Unclassified" class="w-full" size="small" showClear />
              </template>
            </Column>
            <Column header="Evidence" style="width:150px">
              <template #body="{ data }">
                <span class="text-xs text-slate-500">
                  {{ data.teacherCount }} teacher{{ data.teacherCount !== 1 ? 's' : '' }}
                  <span v-if="data.sections.length">· {{ data.sections.join(', ') }}</span>
                </span>
              </template>
            </Column>
            <Column header="Status" style="width:130px">
              <template #body="{ data }">
                <span class="px-2 py-0.5 rounded-full text-xs font-semibold" :class="statusClass(data.status)">{{ statusLabel(data.status) }}</span>
                <div v-if="data.status === STATUS_CONFLICT" class="text-[11px] text-red-500 mt-0.5">
                  setup says {{ data.existingArea }}
                </div>
              </template>
            </Column>
          </DataTable>
          <div v-if="!proposal.subjects.length" class="text-center text-sm text-slate-400 py-6">No subjects inferred</div>
        </div>

        <!-- Subject ↔ class mappings -->
        <div class="bg-white rounded-xl border border-slate-200 overflow-hidden mb-4">
          <div class="px-4 py-2.5 border-b border-slate-100 flex items-center justify-between">
            <div class="text-sm font-bold text-slate-900">Subject → Class Mapping</div>
            <button type="button" class="text-xs text-violet-600 font-semibold" @click="toggleAll('classSubjects')">Toggle all new</button>
          </div>
          <DataTable :value="proposal.classSubjects" size="small" stripedRows :paginator="proposal.classSubjects.length > 50" :rows="50">
            <Column style="width:3rem">
              <template #body="{ data }">
                <Checkbox v-model="data.accepted" binary :disabled="data.status === STATUS_EXISTING" />
              </template>
            </Column>
            <Column header="Class" style="width:110px">
              <template #body="{ data }"><span class="text-slate-700">{{ data.grade }} — {{ data.section }}</span></template>
            </Column>
            <Column field="name" header="Subject" />
            <Column header="Teachers">
              <template #body="{ data }"><span class="text-xs text-slate-500">{{ data.teachers.join(', ') || '—' }}</span></template>
            </Column>
            <Column header="Status" style="width:120px">
              <template #body="{ data }"><span class="px-2 py-0.5 rounded-full text-xs font-semibold" :class="statusClass(data.status)">{{ statusLabel(data.status) }}</span></template>
            </Column>
          </DataTable>
          <div v-if="!proposal.classSubjects.length" class="text-center text-sm text-slate-400 py-6">No mappings inferred</div>
        </div>

        <div v-if="applyProgress" class="text-sm text-slate-500 mb-2">{{ applyProgress }}</div>
      </div>
    </template>

    <ConfirmDialog />
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { getDocs, query, where, orderBy, limit, writeBatch, serverTimestamp } from 'firebase/firestore'
import { useConfirm } from 'primevue/useconfirm'
import { useToast } from 'primevue/usetoast'

import Button from 'primevue/button'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import Checkbox from 'primevue/checkbox'
import InputText from 'primevue/inputtext'
import Select from 'primevue/select'
import ProgressSpinner from 'primevue/progressspinner'
import ConfirmDialog from 'primevue/confirmdialog'

import { db, auth } from '../../firebase/config'
import {
  schoolCollection, schoolDoc, stagingImportsCollection, stagingImportRowsCollection,
} from '../../firebase/schoolCollections.js'
import { useEducationKB } from '../../composables/useEducationKB.js'
import {
  inferStructure, proposalSummary, STATUS_NEW, STATUS_EXISTING, STATUS_CONFLICT,
} from '../../utils/structureInference.js'
import { stageForGrade } from '../../utils/stages.js'
import { regenerateStudentsSchemaClassOptions } from '../../utils/schoolSetupHelpers.js'

const props = defineProps({ schoolId: { type: String, default: null } })
const confirm = useConfirm()
const toast = useToast()
const { loadKB, overlay } = useEducationKB()

const areaOptions = ['Scholastic', 'Co-Scholastic']

const jobs = ref([])
const selectedJobIds = ref([])
const loadingJobs = ref(false)
const running = ref(false)
const applying = ref(false)
const proposal = ref(null)
const inferError = ref('')
const applyProgress = ref('')

const summary = computed(() => proposal.value ? proposalSummary(proposal.value) : null)
const hasAnythingToApply = computed(() =>
  !!proposal.value && (summary.value.classes + summary.value.subjects + summary.value.mappings) > 0)

function statusLabel(s) {
  return { [STATUS_NEW]: 'New', [STATUS_EXISTING]: 'Already set up', [STATUS_CONFLICT]: 'Conflict' }[s] || s
}
function statusClass(s) {
  return {
    [STATUS_NEW]: 'bg-green-100 text-green-700',
    [STATUS_EXISTING]: 'bg-slate-100 text-slate-500',
    [STATUS_CONFLICT]: 'bg-red-100 text-red-700',
  }[s] || 'bg-slate-100 text-slate-600'
}
function formatTs(ts) {
  if (!ts?.toDate) return ''
  return ts.toDate().toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}

function toggleAll(section) {
  const list = proposal.value?.[section] || []
  const actionable = list.filter(i => i.status !== STATUS_EXISTING)
  const turnOn = actionable.some(i => !i.accepted)
  actionable.forEach(i => { i.accepted = turnOn })
}

// ── Source imports ──────────────────────────────────────────────────────────
// Only students/teachers matter here: subjects/assessments jobs carry no
// grade-section evidence to infer a structure from.
async function loadJobs() {
  if (!props.schoolId) { jobs.value = []; return }
  loadingJobs.value = true
  try {
    const snap = await getDocs(query(
      stagingImportsCollection(), where('school_id', '==', props.schoolId),
      orderBy('created_at', 'desc'), limit(50)))
    jobs.value = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(j => ['students', 'teachers'].includes(j.entity) && ['ready', 'committed'].includes(j.status))
    // Default to the newest job of each entity — re-running inference on
    // every historical import would double-count a re-uploaded roster.
    const seen = new Set()
    selectedJobIds.value = jobs.value.filter(j => {
      if (seen.has(j.entity)) return false
      seen.add(j.entity)
      return true
    }).map(j => j.id)
  } catch (e) {
    console.error('Could not load import jobs', e)
    inferError.value = 'Could not load this school\'s imports.'
  } finally {
    loadingJobs.value = false
  }
}

async function loadJobRows(jobId) {
  const snap = await getDocs(stagingImportRowsCollection(jobId))
  return snap.docs.map(d => d.data()).filter(r => !r.excluded).map(r => r.data || {})
}

// ── Inference ───────────────────────────────────────────────────────────────
async function runInference() {
  running.value = true
  inferError.value = ''
  applyProgress.value = ''
  try {
    await loadKB()
    const selected = jobs.value.filter(j => selectedJobIds.value.includes(j.id))
    const studentRows = []
    const teacherRows = []
    for (const j of selected) {
      const rows = await loadJobRows(j.id)
      if (j.entity === 'students') studentRows.push(...rows)
      else teacherRows.push(...rows)
    }

    const [cSnap, sSnap, stSnap] = await Promise.all([
      getDocs(schoolCollection(props.schoolId, 'classes')),
      getDocs(schoolCollection(props.schoolId, 'subjects')),
      getDocs(schoolCollection(props.schoolId, 'staffs')),
    ])
    const existing = {
      classes: cSnap.docs.map(d => ({ id: d.id, ...d.data() })),
      subjects: sSnap.docs.map(d => ({ id: d.id, ...d.data() })),
      staffs: stSnap.docs.map(d => ({ id: d.id, ...d.data() })),
    }

    proposal.value = inferStructure({ studentRows, teacherRows, existing, overlay: overlay.value })
    if (!proposal.value.classes.length && !proposal.value.subjects.length) {
      inferError.value = 'Nothing could be inferred from the selected imports — check they contain grade/section columns.'
    }
  } catch (e) {
    console.error(e)
    inferError.value = e.message || 'Could not build a proposal.'
  } finally {
    running.value = false
  }
}

// ── Apply ───────────────────────────────────────────────────────────────────
function confirmApply() {
  const s = summary.value
  confirm.require({
    message: `Write ${s.classes} class(es), ${s.subjects} subject(s) and ${s.mappings} subject-class link(s) into ${props.schoolId}'s live setup? Existing records are merged, never replaced.`,
    header: 'Apply Proposed Structure',
    icon: 'pi pi-exclamation-triangle',
    rejectLabel: 'Cancel', acceptLabel: 'Apply',
    accept: applyProposal,
  })
}

// Writes in dependency order — subjects, then classes (whose `subjects[]`
// references them), then the mappings that attach one to the other. Existing
// docs are merged, never clobbered: an accepted item only ever ADDS.
async function applyProposal() {
  applying.value = true
  applyProgress.value = 'Writing subjects…'
  try {
    const p = proposal.value
    const acceptedSubjects = p.subjects.filter(i => i.accepted && i.status !== STATUS_EXISTING)
    const acceptedClasses = p.classes.filter(i => i.accepted && i.status !== STATUS_EXISTING)
    const acceptedMappings = p.classSubjects.filter(i => i.accepted && i.status !== STATUS_EXISTING)

    const stamp = () => ({
      updated_at: serverTimestamp(), updated_by: auth.currentUser?.email || 'unknown',
    })
    const created = () => ({
      created_at: serverTimestamp(), created_by: auth.currentUser?.email || 'unknown',
      inferred_from_import: true,
    })

    let batch = writeBatch(db)
    let ops = 0
    const flush = async () => { if (ops) { await batch.commit(); batch = writeBatch(db); ops = 0 } }

    for (const s of acceptedSubjects) {
      batch.set(schoolDoc(props.schoolId, 'subjects', s.docId),
        { id: s.docId, name: s.name.trim(), area: s.area || '', ...stamp(), ...created() }, { merge: true })
      if (++ops >= 400) await flush()
    }
    await flush()

    applyProgress.value = 'Writing classes…'
    // Re-read classes so mappings merge onto whatever exists now, including
    // the ones just created above.
    const cSnap = await getDocs(schoolCollection(props.schoolId, 'classes'))
    const liveClasses = new Map(cSnap.docs.map(d => [d.id, { id: d.id, ...d.data() }]))

    for (const c of acceptedClasses) {
      if (liveClasses.has(c.docId)) continue
      const doc = {
        id: c.docId, clazz: c.clazz, section: c.section,
        name: `${c.clazz} ${c.section}`, stage: stageForGrade(c.clazz) || 'foundation',
        isActive: true, subjects: [],
        ...stamp(), ...created(),
      }
      batch.set(schoolDoc(props.schoolId, 'classes', c.docId), doc, { merge: true })
      liveClasses.set(c.docId, doc)
      if (++ops >= 400) await flush()
    }
    await flush()

    applyProgress.value = 'Linking subjects to classes…'
    // Group by class so each class doc is written once with a merged
    // subjects[] — never overwriting entries (and their isCompleted/topics
    // state) that are already attached.
    const bySubjectClass = new Map()
    for (const m of acceptedMappings) {
      const classDocId = `${m.grade}_${m.section}`
      if (!bySubjectClass.has(classDocId)) bySubjectClass.set(classDocId, [])
      const subj = p.subjects.find(s => s.key === m.subjectKey)
      if (subj) bySubjectClass.get(classDocId).push(subj.docId)
    }
    for (const [classDocId, subjectIds] of bySubjectClass) {
      const cls = liveClasses.get(classDocId)
      if (!cls) continue
      const existingSubjects = cls.subjects || []
      const have = new Set(existingSubjects.map(s => s.subjectId))
      const additions = subjectIds.filter(id => !have.has(id)).map(subjectId => ({
        subjectId, teacherId: '', isCompleted: false, completedAt: null,
        topics: [
          { id: `${subjectId}_Term1`, topic: 'Term 1', isCompleted: false, completedAt: null },
          { id: `${subjectId}_Term2`, topic: 'Term 2', isCompleted: false, completedAt: null },
          { id: `${subjectId}_Optional`, topic: 'Optional', isCompleted: false, completedAt: null },
        ],
      }))
      if (!additions.length) continue
      batch.set(schoolDoc(props.schoolId, 'classes', classDocId),
        { subjects: [...existingSubjects, ...additions], ...stamp() }, { merge: true })
      if (++ops >= 400) await flush()
    }
    await flush()

    await regenerateStudentsSchemaClassOptions(props.schoolId, Array.from(liveClasses.keys()))

    applyProgress.value = `Done — ${acceptedSubjects.length} subject(s), ${acceptedClasses.length} class(es), ${acceptedMappings.length} link(s) applied.`
    toast.add({ severity: 'success', summary: 'Structure applied', life: 3000 })
    // Re-run so the proposal now reflects reality — this is the incremental
    // loop: after applying, everything just written shows as "already set up".
    await runInference()
  } catch (e) {
    console.error(e)
    inferError.value = 'Something went wrong while applying. Some records may have been written — re-run the proposal to see the current state.'
  } finally {
    applying.value = false
  }
}

watch(() => props.schoolId, () => { proposal.value = null; loadJobs() })
onMounted(() => { loadJobs(); loadKB() })
</script>
