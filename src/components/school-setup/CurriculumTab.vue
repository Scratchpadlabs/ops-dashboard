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

      <!-- ── Language slots ────────────────────────────────────────────── -->
      <div v-if="languageCandidates.length" class="bg-white rounded-xl border border-slate-200 p-4">
        <div class="text-sm font-semibold text-slate-800 mb-1">Language subjects</div>
        <p class="text-sm text-slate-500 mb-3">
          The framework names slots (Language 1, 2, 3), not languages. Say which of this school's
          subjects fills each slot, or leave a subject unset to skip its goals.
        </p>
        <div class="grid gap-2 md:grid-cols-2">
          <div v-for="s in languageCandidates" :key="s.id" class="flex items-center gap-2">
            <span class="font-mono text-xs w-40 shrink-0 text-slate-600">{{ s.id }}</span>
            <Select v-model="languageMap[s.id]" :options="slotOptionsFor(s.id)" class="w-full"
                    size="small" showClear placeholder="Not a language / skip" />
          </div>
        </div>
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
import { ref, reactive, computed } from 'vue'
import { getDocs, writeBatch, serverTimestamp } from 'firebase/firestore'
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
import { ambiguousSlots } from '../../utils/curriculumTemplates.js'
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
const error = ref('')
const progress = ref('')
const languageMap = reactive({})

// Subjects that matched no template are the ones that may be languages. Offered
// after a preview, so the list reflects this school rather than a guess.
const languageCandidates = computed(() => {
  if (!plan.value) return []
  const ids = new Set(plan.value.warnings.filter(w => w.kind === 'needs-language-slot').map(w => w.subjectId))
  for (const id of Object.keys(languageMap)) ids.add(id)
  return subjects.value.filter(s => ids.has(s.id))
})

function slotOptionsFor(subjectId) {
  return ambiguousSlots(stageForGrade(String(subjectId).split('_')[0]) || '')
}

async function loadAll() {
  const [cSnap, sSnap, fSnap] = await Promise.all([
    getDocs(schoolCollection(props.schoolId, 'classes')),
    getDocs(schoolCollection(props.schoolId, 'subjects')),
    getDocs(schoolCollection(props.schoolId, 'subject_feedbacks')).catch(() => null),
  ])
  classes.value = cSnap.docs.map(d => ({ id: d.id, ...d.data() }))
  subjects.value = sSnap.docs.map(d => ({ id: d.id, ...d.data() }))
  feedbackIds.value = new Set((fSnap?.docs || []).map(d => d.id))
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
      languageMap: { ...languageMap },
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
