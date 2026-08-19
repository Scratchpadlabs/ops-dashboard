<template>
  <div class="pt-4 space-y-4">
    <ConfigEmptyState v-if="!schoolId" message="Select a school to apply curriculum templates." />

    <template v-else>
      <div class="bg-white rounded-xl border border-slate-200 p-4">
        <div class="flex items-start justify-between gap-4">
          <div>
            <div class="text-sm font-semibold text-slate-800 mb-1">Curriculum Templates</div>
            <p class="text-sm text-slate-500 max-w-3xl">
              Fills each subject's curricular goals and competencies from the NCF template for its
              stage, and creates the per-term student feedback documents. Adds only what is
              missing — a goal this school already wrote keeps its own wording, and nothing is
              ever removed or overwritten.
            </p>
          </div>
          <Button label="Preview" icon="pi pi-search" size="small" :loading="scanning"
                  :disabled="!schoolId" @click="runPreview" />
        </div>
      </div>

      <!-- ── Subject mapping ───────────────────────────────────────────── -->
      <div v-if="groups.length" class="bg-white rounded-xl border border-slate-200 p-4">
        <div class="flex items-start justify-between gap-4 mb-1">
          <div class="text-sm font-semibold text-slate-800">
            Map subjects <span class="font-normal text-slate-400">({{ groups.length }} decision(s) covering {{ mappedSubjectCount }} subject(s))</span>
          </div>
          <div class="flex gap-2">
            <Button label="Accept suggestions" icon="pi pi-bolt" size="small" outlined
                    :disabled="!suggestedCount" @click="acceptSuggestions" />
            <Button label="Save mapping" icon="pi pi-save" size="small" outlined
                    :loading="savingMap" @click="saveMap" />
          </div>
        </div>
        <p class="text-sm text-slate-500 mb-3">
          One row per subject name, not per grade — a choice here applies to every grade that
          uses it. The framework names slots (Language 1, 2, 3) rather than languages, and
          Preparatory groups Science and Social Science as "The World Around Us".
        </p>

        <table class="w-full text-sm">
          <tbody>
            <tr v-for="g in groups" :key="g.key" class="border-b border-slate-100 last:border-0">
              <td class="py-2 pr-3 w-40 align-middle">
                <div class="font-medium text-slate-800">{{ g.name }}</div>
                <div class="text-xs text-slate-400">{{ STAGE_LABELS[g.stage] || g.stage }} · {{ g.count }} grade(s)</div>
              </td>
              <td class="py-2 pr-3 align-middle">
                <Select v-model="choices[g.key]" :options="optionsFor(g.stage)" class="w-full"
                        size="small" showClear filter placeholder="Leave unmapped / skip" />
              </td>
              <td class="py-2 w-52 align-middle">
                <span v-if="g.confidence === 'high'" class="text-xs text-emerald-700">{{ g.reason }}</span>
                <span v-else-if="g.confidence === 'low'" class="text-xs text-amber-700">{{ g.reason }}</span>
                <span v-else class="text-xs text-slate-400">{{ g.reason }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- ── Preview ───────────────────────────────────────────────────── -->
      <div v-if="plan" class="bg-white rounded-xl border border-slate-200 p-4 space-y-4">
        <div class="flex items-center justify-between gap-4">
          <div class="text-sm font-semibold text-slate-800">What this run would do</div>
          <Button v-if="!plan.isEmpty" label="Apply" icon="pi pi-check" size="small"
                  :loading="applying" @click="confirmApply" />
        </div>

        <div v-if="plan.isEmpty" class="text-sm text-slate-500 bg-slate-50 rounded-lg px-3 py-2">
          Nothing to add — this school already matches the templates.
        </div>

        <template v-else>
          <div class="flex flex-wrap gap-2">
            <span class="stat">{{ plan.totals.subjectsTouched }} subject(s)</span>
            <span class="stat">+{{ plan.totals.goalsAdded }} goal(s)</span>
            <span class="stat">+{{ plan.totals.competenciesAdded }} competenc(ies)</span>
            <span class="stat">{{ plan.totals.feedbackDocs }} feedback doc(s)</span>
            <span class="stat font-semibold">{{ plan.totals.writes }} write(s)</span>
          </div>

          <DataTable v-if="plan.subjectRows.length" :value="plan.subjectRows" size="small" stripedRows>
            <Column field="subjectId" header="Subject">
              <template #body="{ data }"><span class="font-mono text-xs">{{ data.subjectId }}</span></template>
            </Column>
            <Column field="stage" header="Stage">
              <template #body="{ data }">{{ STAGE_LABELS[data.stage] || data.stage }}</template>
            </Column>
            <Column header="Adds">
              <template #body="{ data }">
                <span class="text-xs text-slate-600">+{{ data.addedGoals }} goals, +{{ data.addedCompetencies }} competencies</span>
              </template>
            </Column>
          </DataTable>

          <div v-if="plan.feedbackRows.length" class="text-xs text-slate-500">
            Feedback documents to create:
            <span class="font-mono">{{ plan.feedbackRows.slice(0, 6).map(r => r.docId).join(', ') }}</span>
            <span v-if="plan.feedbackRows.length > 6"> … and {{ plan.feedbackRows.length - 6 }} more</span>
          </div>
        </template>

        <div v-if="plan.warnings.length" class="space-y-1">
          <div class="text-xs font-semibold text-amber-800">{{ plan.warnings.length }} thing(s) to look at</div>
          <div v-for="(w, i) in plan.warnings" :key="i"
               class="text-xs text-amber-800 bg-amber-50 rounded px-2 py-1">{{ w.message }}</div>
        </div>
      </div>

      <div v-if="error" class="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{{ error }}</div>
      <div v-if="progress" class="text-sm text-slate-500">{{ progress }}</div>
    </template>

    <ConfirmDialog />
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch } from 'vue'
import { getDoc, getDocs, setDoc, writeBatch, serverTimestamp } from 'firebase/firestore'
import { useConfirm } from 'primevue/useconfirm'
import { useToast } from 'primevue/usetoast'
import Button from 'primevue/button'
import Select from 'primevue/select'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import ConfirmDialog from 'primevue/confirmdialog'

import ConfigEmptyState from './ConfigEmptyState.vue'
import { schoolCollection, schoolDoc } from '../../firebase/schoolCollections.js'
import { db, auth } from '../../firebase/config'
import { buildCurriculumPlan } from '../../utils/curriculumPlan.js'
import { templateSubjectNames } from '../../utils/curriculumTemplates.js'
import { groupForMapping, expandGroups, canonicalSubject, isLanguageSubject } from '../../utils/curriculumSuggest.js'
import { stageForGrade, STAGE_LABELS } from '../../utils/stages.js'
import { guardedBatchSet, MODE_UPDATE, SchemaViolation } from '../../schemas/guardedWrite.js'

const props = defineProps({ schoolId: { type: String, default: null } })
const confirm = useConfirm()
const toast = useToast()

const classes = ref([])
const subjects = ref([])
const feedbackIds = ref(new Set())
const plan = ref(null)
const scanning = ref(false)
const applying = ref(false)
const savingMap = ref(false)
const error = ref('')
const progress = ref('')
const choices = reactive({})   // groupKey -> framework subject
const savedMap = ref({})       // subjectId -> framework subject, from Firestore

// Subjects that matched no template are the ones that may be languages. Offered
// after a preview, so the list reflects this school rather than a guess.
// The order a school teaches its languages in, inferred from how many grades
// each appears in — the most widely taught language is usually the first. It
// only seeds the SUGGESTION; every language row still says "check this".
const languageOrder = computed(() => {
  const counts = new Map()
  for (const s of subjects.value) {
    if (!isLanguageSubject(s.name || s.id)) continue
    const c = canonicalSubject(s.name || s.id)
    counts.set(c, (counts.get(c) || 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([c]) => c)
})

// One row per (stage, subject name) rather than per subject id: SAMARTH's 24
// unmapped ids are 8 decisions, and a school spanning I–XII is still 8.
const groups = computed(() => {
  if (!plan.value) return []
  const refs = plan.value.warnings
    .filter(w => w.kind === 'needs-mapping')
    .map(w => {
      const subj = subjects.value.find(s => s.id === w.subjectId)
      return { subjectId: w.subjectId, name: subj?.name || w.subjectId, stage: stageForGrade(String(w.subjectId).split('_')[0]) }
    })
    .filter(r => r.stage)
  return groupForMapping(refs, { languageOrder: languageOrder.value })
})

const mappedSubjectCount = computed(() => groups.value.reduce((n, g) => n + g.count, 0))
const suggestedCount = computed(() => groups.value.filter(g => g.suggestion && !choices[g.key]).length)

function optionsFor(stage) { return templateSubjectNames(stage) }

function acceptSuggestions() {
  for (const g of groups.value) if (g.suggestion && !choices[g.key]) choices[g.key] = g.suggestion
}

async function loadAll() {
  const [cSnap, sSnap, fSnap, mSnap] = await Promise.all([
    getDocs(schoolCollection(props.schoolId, 'classes')),
    getDocs(schoolCollection(props.schoolId, 'subjects')),
    getDocs(schoolCollection(props.schoolId, 'subject_feedbacks')).catch(() => null),
    getDoc(mapDocRef()).catch(() => null),
  ])
  classes.value = cSnap.docs.map(d => ({ id: d.id, ...d.data() }))
  subjects.value = sSnap.docs.map(d => ({ id: d.id, ...d.data() }))
  feedbackIds.value = new Set((fSnap?.docs || []).map(d => d.id))

  // A saved mapping is a per-school fact worth keeping — re-picking it every
  // session is how it gets picked wrong. Stored per subject id, because that is
  // what the plan consumes and what stays correct if a school renames a subject
  // in one grade only.
  savedMap.value = mSnap?.exists?.() ? (mSnap.data().map || {}) : {}
}

// A saved id whose group is on screen pre-fills that row, so a returning user
// sees their previous decision rather than the suggestion again.
watch([groups, savedMap], () => {
  for (const g of groups.value) {
    if (choices[g.key] !== undefined) continue
    const prev = g.subjectIds.map(id => savedMap.value[id]).find(Boolean)
    if (prev) choices[g.key] = prev
  }
})

function mapDocRef() {
  return schoolDoc(props.schoolId, 'config', 'curriculum_map')
}

async function saveMap() {
  savingMap.value = true
  error.value = ''
  try {
    // Saved per subject id: the group key is a UI construct and would not
    // survive a subject being renamed or a stage boundary moving.
    const clean = { ...savedMap.value, ...expandGroups(groups.value, choices) }
    for (const k of Object.keys(clean)) if (!clean[k]) delete clean[k]
    await setDoc(mapDocRef(), {
      map: clean,
      updated_at: serverTimestamp(),
      updated_by: auth.currentUser?.email || 'unknown',
    }, { merge: true })
    toast.add({ severity: 'success', summary: 'Mapping saved', detail: `${Object.keys(clean).length} subject(s)`, life: 2500 })
  } catch (e) {
    console.error(e)
    error.value = 'Could not save the mapping.'
  } finally {
    savingMap.value = false
  }
}

async function runPreview() {
  scanning.value = true
  error.value = ''
  progress.value = ''
  try {
    await loadAll()
    plan.value = buildCurriculumPlan({
      classes: classes.value,
      subjects: subjects.value,
      existingFeedbackIds: feedbackIds.value,
      subjectMap: { ...savedMap.value, ...expandGroups(groups.value, choices) },
    })
  } catch (e) {
    console.error(e)
    error.value = 'Could not read this school. Check the console.'
  } finally {
    scanning.value = false
  }
}

function confirmApply() {
  const t = plan.value.totals
  confirm.require({
    message: `Write ${t.writes} document(s) to "${props.schoolId}"? `
           + `${t.subjectsTouched} subject(s) gain ${t.goalsAdded} goal(s), and `
           + `${t.feedbackDocs} feedback document(s) are created. `
           + 'Existing goals and wording are left exactly as they are.',
    header: 'Apply Curriculum Templates',
    icon: 'pi pi-exclamation-triangle',
    rejectLabel: 'Cancel',
    acceptLabel: 'Apply',
    accept: runApply,
  })
}

async function runApply() {
  applying.value = true
  error.value = ''
  try {
    const stamp = { updated_at: serverTimestamp(), updated_by: auth.currentUser?.email || 'unknown' }
    const ops = []

    // Goals merge into the EXISTING subject doc, so this is an update: it must
    // never create a subject, and never touch a field it did not compute.
    for (const r of plan.value.subjectRows) {
      ops.push({
        kind: 'subjects',
        ref: schoolDoc(props.schoolId, 'subjects', r.subjectId),
        payload: { curricular_goals: r.goals, ...stamp },
      })
    }
    for (const r of plan.value.feedbackRows) {
      ops.push({
        kind: 'subject_feedbacks',
        ref: schoolDoc(props.schoolId, 'subject_feedbacks', r.docId),
        payload: {
          id: r.docId, isActive: null, questions: r.questions,
          created_at: serverTimestamp(), created_by: auth.currentUser?.email || 'unknown',
        },
      })
    }

    let done = 0
    for (let i = 0; i < ops.length; i += 450) {
      const chunk = ops.slice(i, i + 450)
      const batch = writeBatch(db)
      for (const op of chunk) {
        // subject_feedbacks has no schema entry, so it is written directly;
        // subjects goes through the guard the rest of the page uses.
        if (op.kind === 'subjects') {
          guardedBatchSet(batch, 'subjects', op.ref, op.payload, { mode: MODE_UPDATE, merge: true })
        } else {
          batch.set(op.ref, op.payload, { merge: true })
        }
      }
      await batch.commit()
      done += chunk.length
      progress.value = `Wrote ${done}/${ops.length} document(s)…`
    }

    await saveMap()   // the mapping that produced this run is worth keeping
    toast.add({ severity: 'success', summary: 'Templates applied', detail: `${ops.length} document(s)`, life: 3000 })
    await runPreview()   // re-preview: a correct run leaves nothing to do
  } catch (e) {
    console.error(e)
    error.value = e instanceof SchemaViolation
      ? e.userMessage
      : 'Something went wrong while writing. Check the console — some documents may have been written.'
  } finally {
    applying.value = false
  }
}
</script>

<style scoped>
.stat {
  font-size: 12px;
  background: #f1f5f9;
  color: #334155;
  border-radius: 6px;
  padding: 3px 8px;
}
</style>
