<template>
  <div>
    <div class="flex items-center gap-2 mb-3 flex-wrap">
      <InputText v-model="search" class="w-64" size="small" placeholder="Search student or subject…" />
      <div class="flex items-center gap-2">
        <Checkbox v-model="needsReviewOnly" binary inputId="aapNeedsReview" />
        <label for="aapNeedsReview" class="text-sm text-slate-600">Needs review only</label>
      </div>
      <span class="text-xs text-slate-400">
        {{ visibleRemarkCount }} of {{ totalRemarkCount }} remarks · {{ approvedCount }} approved
      </span>
      <span v-if="saving" class="text-xs text-slate-400"><i class="pi pi-spin pi-spinner text-xs mr-1"></i>saving…</span>
      <Button
        v-if="selectableRows.length"
        :label="allSelected ? 'Clear selection' : `Select all ${selectableRows.length} shown`"
        size="small" text class="ml-auto" @click="toggleSelectAll"
      />
    </div>

    <!-- Bulk action bar — same idiom as the survey drill-down's. Acts on the
         SHOWN selection, so "needs review only" plus select-all is how a whole
         review queue gets approved in one go. -->
    <div v-if="selectedKeys.size"
         class="flex items-center gap-2 mb-3 flex-wrap bg-slate-900 text-white rounded-lg px-3 py-2">
      <span class="text-sm font-semibold">
        {{ selectedKeys.size }} remark{{ selectedKeys.size === 1 ? '' : 's' }} selected
      </span>
      <Button label="Approve" icon="pi pi-check" size="small" :loading="saving"
              @click="applyBulk(STATUS_APPROVED)" />
      <Button label="Mark needs review" icon="pi pi-clock" size="small" severity="secondary"
              :loading="saving" @click="applyBulk(STATUS_NEEDS_REVIEW)" />
      <Button label="Clear" size="small" text class="!text-slate-300 ml-auto" @click="clearSelection" />
    </div>

    <!-- `scrollable` gives the table its own x/y scroll container, which is
         what keeps a 7-column table from widening the page (style.css §2). -->
    <div class="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <DataTable :value="rows" dataKey="key" size="small" :rowClass="rowClass" scrollable scrollHeight="560px">
        <!-- Hand-rolled rather than DataTable's selectionMode: a placeholder
             row for a student with no remarks has nothing to approve, and the
             built-in column has no way to leave one row's checkbox out. -->
        <Column style="width:44px">
          <template #body="{ data }">
            <Checkbox
              v-if="!data.empty" :modelValue="selectedKeys.has(data.key)" binary
              @update:modelValue="v => toggleRow(data.key, v)"
            />
          </template>
        </Column>

        <Column header="Student" style="min-width:190px">
          <template #body="{ data }">
            <!-- Name printed once per student rather than repeated down every
                 subject row: the rows are already contiguous per student, so
                 this reads as a group without needing DataTable's row grouping
                 (which would impose its own sort and lose the roster order the
                 class_detail call returns). -->
            <div v-if="data.firstOfStudent" class="flex items-center gap-2">
              <div class="min-w-0">
                <div class="text-sm font-semibold text-slate-900 cell-truncate" :title="data.studentName">
                  {{ data.studentName }}
                </div>
                <div class="text-[11px] text-slate-400">
                  Roll {{ data.rollNo || '—' }}
                  <span v-if="data.subjectCount">· {{ data.subjectCount }} subject{{ data.subjectCount === 1 ? '' : 's' }}</span>
                </div>
              </div>
              <Button
                icon="pi pi-refresh" text rounded size="small" class="ml-auto flex-shrink-0"
                :loading="busyStudentId === data.studentId"
                :disabled="!!busyStudentId"
                v-tooltip.top="'Regenerate every subject for this student — replaces approved remarks too'"
                @click="$emit('regenerate', data.studentId)"
              />
            </div>
          </template>
        </Column>

        <Column header="Subject" style="min-width:130px">
          <template #body="{ data }">
            <span v-if="data.empty" class="text-xs text-slate-400 italic">No remarks generated</span>
            <span v-else class="text-sm text-slate-700 cell-truncate" :title="data.subject">{{ data.subject }}</span>
          </template>
        </Column>

        <Column v-for="trait in TRAITS" :key="trait" :header="traitLabel(trait)" style="min-width:118px">
          <template #body="{ data }">
            <span v-if="data[trait]" class="px-2 py-0.5 rounded-full text-xs font-semibold" :class="levelClass(data[trait])">
              {{ data[trait] }}
            </span>
            <span v-else class="text-xs text-slate-300">—</span>
          </template>
        </Column>

        <Column header="Comment" style="min-width:340px">
          <template #body="{ data }">
            <button
              v-if="!data.empty"
              type="button"
              class="text-sm text-left text-slate-700 hover:text-blue-600 line-clamp-2"
              @click="openEditor(data)"
            >
              {{ data.comment || 'No comment — click to write one' }}
            </button>
            <!-- The function only writes remarks for students the AAP surveys
                 actually rated, so an empty row is a data gap, not a failure. -->
            <span v-else class="text-xs text-slate-400">
              No AAP survey ratings found for this student in this class.
            </span>
          </template>
        </Column>

        <Column header="Status" style="min-width:140px">
          <template #body="{ data }">
            <button
              v-if="!data.empty"
              type="button"
              class="px-2.5 py-1 rounded-full text-xs font-semibold flex items-center gap-1.5 transition-colors"
              :class="data.status === STATUS_APPROVED
                ? 'bg-green-50 text-green-700 hover:bg-green-100'
                : 'bg-amber-50 text-amber-700 hover:bg-amber-100'"
              :disabled="saving"
              v-tooltip.top="data.status === STATUS_APPROVED ? 'Move back to needs review' : 'Mark as approved'"
              @click="toggleStatus(data)"
            >
              <i :class="data.status === STATUS_APPROVED ? 'pi pi-check-circle' : 'pi pi-clock'" style="font-size:10px"></i>
              {{ data.status === STATUS_APPROVED ? 'Approved' : 'Needs review' }}
            </button>
          </template>
        </Column>

        <Column header="" style="width:60px">
          <template #body="{ data }">
            <Button
              v-if="!data.empty"
              icon="pi pi-pencil" text rounded size="small"
              v-tooltip.left="'Edit this comment'"
              @click="openEditor(data)"
            />
          </template>
        </Column>
      </DataTable>

      <div v-if="!rows.length" class="text-center text-sm text-slate-400 py-10">
        {{ students.length ? 'No remarks match this filter.' : 'No students in this class.' }}
      </div>
    </div>

    <!-- ── Comment editor ─────────────────────────────────────────────────── -->
    <Dialog v-model:visible="editorVisible" modal :style="{ width: '640px' }" :header="editorHeader">
      <div v-if="editing">
        <div class="flex flex-wrap gap-1.5 mb-3">
          <span v-for="trait in TRAITS" :key="trait"
                class="px-2 py-0.5 rounded-full text-xs font-semibold" :class="levelClass(editing[trait])">
            {{ traitLabel(trait) }}: {{ editing[trait] || '—' }}
          </span>
        </div>

        <Textarea v-model="draft" rows="6" class="w-full" autoResize />

        <div class="flex items-center gap-2 mt-2">
          <!-- The generator is prompted for 40-55 words; a hand-edited comment
               is held to the same window so one report card doesn't read
               noticeably longer than the rest. Advisory only — it never blocks
               a save, because a teacher's wording beats a word count. -->
          <span class="text-xs" :class="wordCount < MIN_WORDS || wordCount > MAX_WORDS ? 'text-amber-600' : 'text-slate-400'">
            {{ wordCount }} words
            <span v-if="wordCount < MIN_WORDS || wordCount > MAX_WORDS">· generated remarks sit between {{ MIN_WORDS }} and {{ MAX_WORDS }}</span>
          </span>
          <span class="text-xs text-slate-400 ml-auto">Saving also marks this remark approved</span>
        </div>
      </div>

      <template #footer>
        <Button label="Cancel" text @click="editorVisible = false" />
        <Button label="Save &amp; approve" icon="pi pi-check" :loading="saving" :disabled="!draft.trim()" @click="save" />
      </template>
    </Dialog>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { useToast } from 'primevue/usetoast'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import Textarea from 'primevue/textarea'
import InputText from 'primevue/inputtext'
import Checkbox from 'primevue/checkbox'

import {
  useAapRemarks, countWords, TRAITS, MIN_WORDS, MAX_WORDS,
  STATUS_APPROVED, STATUS_NEEDS_REVIEW,
} from '../../composables/useAapRemarks.js'

/**
 * The review table: one row per student per subject, with the three resolved
 * levels, the generated comment, and the two things a reviewer does to it —
 * edit the text, or flip approved / needs review.
 *
 * Both of those write STRAIGHT to the remark doc. Regenerating is the only
 * action that needs the Cloud Function, and it belongs to the parent (which
 * owns the run state), so it leaves here as an event.
 */
const props = defineProps({
  schoolId: { type: String, default: null },
  students: { type: Array, default: () => [] },
  remarksByStudent: { type: Object, default: () => ({}) },
  busyStudentId: { type: String, default: null },
})
const emit = defineEmits(['regenerate', 'saved'])

const toast = useToast()
const { saveComment, setStatus, setStatusBulk } = useAapRemarks()

const search = ref('')
const needsReviewOnly = ref(false)
const saving = ref(false)
const selectedKeys = ref(new Set())

const traitLabel = (trait) => trait.charAt(0).toUpperCase() + trait.slice(1)

const LEVEL_CLASSES = {
  Beginner: 'bg-amber-50 text-amber-700',
  Proficient: 'bg-blue-50 text-blue-700',
  Advanced: 'bg-green-50 text-green-700',
}
const levelClass = (level) => LEVEL_CLASSES[level] || 'bg-slate-100 text-slate-500'

/**
 * Flattened student x subject rows, kept in roster order. A student with no
 * remark docs still gets a row — a missing student is the single most useful
 * thing this table can show, and dropping them would hide it.
 */
const allRows = computed(() => {
  const out = []
  for (const student of props.students) {
    const name = student.name || student.id
    const remarks = props.remarksByStudent[student.id] || []
    if (!remarks.length) {
      out.push({
        key: student.id, studentId: student.id, studentName: name, rollNo: student.rollNo,
        firstOfStudent: true, subjectCount: 0, empty: true,
      })
      continue
    }
    remarks.forEach((remark, i) => out.push({
      key: `${student.id}__${remark.id}`,
      studentId: student.id, studentName: name, rollNo: student.rollNo,
      firstOfStudent: i === 0, subjectCount: remarks.length, empty: false,
      subject: remark.id,
      awareness: remark.awareness, sensitivity: remark.sensitivity, creativity: remark.creativity,
      comment: remark.comment || '',
      status: remark.status || STATUS_NEEDS_REVIEW,
    }))
  }
  return out
})

// A new class means new rows; keeping keys from the old one would let a bulk
// action fire at students who are no longer on screen.
// (arrow, not a bare reference — clearSelection is declared further down)
watch(() => props.students, () => clearSelection())

const rows = computed(() => {
  const term = search.value.trim().toLowerCase()
  const kept = allRows.value.filter(r => {
    if (needsReviewOnly.value && (r.empty || r.status === STATUS_APPROVED)) return false
    if (!term) return true
    return r.studentName.toLowerCase().includes(term) || String(r.subject || '').toLowerCase().includes(term)
  })
  // Filtering can strip a student's first row, which is the one carrying the
  // name — so the flag is recomputed over what actually renders.
  let previousStudentId = null
  return kept.map(r => {
    const row = { ...r, firstOfStudent: r.studentId !== previousStudentId }
    previousStudentId = r.studentId
    return row
  })
})

const totalRemarkCount = computed(() => allRows.value.filter(r => !r.empty).length)
const visibleRemarkCount = computed(() => rows.value.filter(r => !r.empty).length)
const approvedCount = computed(() => allRows.value.filter(r => r.status === STATUS_APPROVED).length)

const rowClass = (data) => (data.firstOfStudent ? 'aap-student-start' : '')

// ── Bulk selection ────────────────────────────────────────────────────────
const selectableRows = computed(() => rows.value.filter(r => !r.empty))
const allSelected = computed(() =>
  selectableRows.value.length > 0 && selectableRows.value.every(r => selectedKeys.value.has(r.key)))

function toggleRow(key, checked) {
  const next = new Set(selectedKeys.value)
  if (checked) next.add(key)
  else next.delete(key)
  selectedKeys.value = next
}

function toggleSelectAll() {
  selectedKeys.value = allSelected.value
    ? new Set()
    : new Set(selectableRows.value.map(r => r.key))
}

const clearSelection = () => { selectedKeys.value = new Set() }

// Filtering can hide a selected row, and acting on something the reviewer
// can no longer see is exactly the surprise to avoid — the selection is
// therefore intersected with what is on screen at the moment of the action.
async function applyBulk(status) {
  const visible = new Set(selectableRows.value.map(r => r.key))
  const targets = selectableRows.value
    .filter(r => selectedKeys.value.has(r.key) && visible.has(r.key))
    .map(r => ({ studentId: r.studentId, subject: r.subject }))
  if (!targets.length) return

  saving.value = true
  try {
    await setStatusBulk(props.schoolId, targets, status)
    clearSelection()
    emit('saved', null)   // null = reload the whole class, not one student
    toast.add({
      severity: 'success',
      summary: status === STATUS_APPROVED
        ? `${targets.length} approved`
        : `${targets.length} moved to needs review`,
      life: 2500,
    })
  } catch (e) {
    console.error('Could not apply the bulk status change', e)
    toast.add({ severity: 'error', summary: 'Could not update those remarks', detail: e.message, life: 4000 })
  } finally {
    saving.value = false
  }
}

// ── Editing ───────────────────────────────────────────────────────────────
const editorVisible = ref(false)
const editing = ref(null)
const draft = ref('')

const wordCount = computed(() => countWords(draft.value))
const editorHeader = computed(() =>
  editing.value ? `${editing.value.studentName} · ${editing.value.subject}` : 'Edit comment')

function openEditor(row) {
  editing.value = row
  draft.value = row.comment || ''
  editorVisible.value = true
}

async function save() {
  saving.value = true
  try {
    await saveComment(props.schoolId, editing.value.studentId, editing.value.subject, draft.value.trim())
    editorVisible.value = false
    emit('saved', editing.value.studentId)
    toast.add({ severity: 'success', summary: 'Saved & approved', life: 2000 })
  } catch (e) {
    console.error('Could not save AAP comment', e)
    toast.add({ severity: 'error', summary: 'Could not save', detail: e.message, life: 4000 })
  } finally {
    saving.value = false
  }
}

async function toggleStatus(row) {
  const next = row.status === STATUS_APPROVED ? STATUS_NEEDS_REVIEW : STATUS_APPROVED
  saving.value = true
  try {
    await setStatus(props.schoolId, row.studentId, row.subject, next)
    emit('saved', row.studentId)
  } catch (e) {
    console.error('Could not change AAP remark status', e)
    toast.add({ severity: 'error', summary: 'Could not update status', detail: e.message, life: 4000 })
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
/* The only visual grouping the flattened rows need: a rule where one
   student's block ends and the next begins. */
:deep(.aap-student-start > td) {
  border-top: 1px solid #e2e8f0;
}
</style>
