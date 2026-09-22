<template>
  <div>
    <div class="flex items-center gap-2 mb-3 flex-wrap">
      <InputText v-model="search" class="w-64" size="small" placeholder="Search student…" />
      <div class="flex items-center gap-2">
        <Checkbox v-model="needsReviewOnly" binary inputId="smartNeedsReview" />
        <label for="smartNeedsReview" class="text-sm text-slate-600">Needs review only</label>
      </div>
      <span class="text-xs text-slate-400">
        {{ visibleCount }} of {{ totalCount }} remarks · {{ approvedCount }} approved
      </span>
      <span v-if="saving" class="text-xs text-slate-400"><i class="pi pi-spin pi-spinner text-xs mr-1"></i>saving…</span>
      <Button
        v-if="selectableRows.length"
        :label="allSelected ? 'Clear selection' : `Select all ${selectableRows.length} shown`"
        size="small" text class="ml-auto" @click="toggleSelectAll"
      />
    </div>

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

    <div class="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <DataTable :value="rows" dataKey="rowKey" size="small" scrollable scrollHeight="560px">
        <Column style="width:44px">
          <template #body="{ data }">
            <Checkbox
              v-if="!data.empty" :modelValue="selectedKeys.has(data.rowKey)" binary
              @update:modelValue="v => toggleRow(data.rowKey, v)"
            />
          </template>
        </Column>

        <Column header="Student" style="min-width:200px">
          <template #body="{ data }">
            <div class="min-w-0">
              <div class="text-sm font-semibold text-slate-900 cell-truncate" :title="data.studentName">
                {{ data.studentName }}
              </div>
              <div class="text-[11px] text-slate-400">Roll {{ data.rollNo || '—' }}</div>
            </div>
          </template>
        </Column>

        <Column header="Category" style="min-width:160px">
          <template #body="{ data }">
            <span v-if="!data.empty" class="text-xs font-medium text-slate-600">{{ data.category }}</span>
          </template>
        </Column>

        <Column header="Ticked" style="min-width:90px">
          <template #body="{ data }">
            <span v-if="!data.empty" class="text-xs text-slate-500">{{ data.tickedCount }}</span>
          </template>
        </Column>

        <Column header="Comment" style="min-width:360px">
          <template #body="{ data }">
            <button
              v-if="!data.empty"
              type="button"
              class="text-sm text-left text-slate-700 hover:text-blue-600 line-clamp-2"
              @click="openEditor(data)"
            >
              <span v-if="data.lowConfidence" class="text-amber-500 mr-1" v-tooltip.top="'Based on few ticked items'">
                <i class="pi pi-info-circle" style="font-size:11px"></i>
              </span>
              {{ data.comment || 'No comment — click to write one' }}
            </button>
            <span v-else class="text-xs text-slate-400">
              No remarks ticked yet for this student.
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
        {{ students.length ? 'No students match this filter.' : 'No students in this class.' }}
      </div>
    </div>

    <Dialog v-model:visible="editorVisible" modal :style="{ width: '640px' }" :header="editorHeader">
      <div v-if="editing">
        <Textarea v-model="draft" rows="5" class="w-full" autoResize />
        <div class="flex items-center gap-2 mt-2">
          <span class="text-xs text-slate-400">{{ wordCount }} words</span>
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

import { useSmartRemarks, STATUS_APPROVED, STATUS_NEEDS_REVIEW } from '../../composables/useSmartRemarks.js'

/**
 * The review table: one row per (student, category) — General Remarks,
 * Physical Development, Socio-Emotional Development, etc. are independent
 * remarks, never blended into one, so each gets its own row. A student with
 * nothing generated yet still gets a single placeholder row. Editing and
 * status toggling write straight to that category's remark doc;
 * regenerating a single student belongs to the parent, same split as
 * AapRemarksTable.
 */
const props = defineProps({
  schoolId: { type: String, default: null },
  students: { type: Array, default: () => [] },
  remarksByStudent: { type: Object, default: () => ({}) }, // { studentId: [remark, ...] }
})
const emit = defineEmits(['saved'])

const toast = useToast()
const { saveComment, setStatus, setStatusBulk } = useSmartRemarks()

const search = ref('')
const needsReviewOnly = ref(false)
const saving = ref(false)
const selectedKeys = ref(new Set())

const allRows = computed(() => props.students.flatMap(student => {
  const remarks = props.remarksByStudent[student.id] || []
  const studentName = student.name || student.id
  if (!remarks.length) {
    return [{
      rowKey: student.id, studentId: student.id, studentName, rollNo: student.rollNo, empty: true,
    }]
  }
  return remarks.map(remark => ({
    rowKey: `${student.id}::${remark.categorySlug}`,
    studentId: student.id, studentName, rollNo: student.rollNo, empty: false,
    categorySlug: remark.categorySlug, category: remark.category || '',
    comment: remark.comment || '', status: remark.status || STATUS_NEEDS_REVIEW,
    tickedCount: remark.tickedCount || 0, lowConfidence: !!remark.lowConfidence,
  }))
}))

watch(() => props.students, () => clearSelection())

const rows = computed(() => {
  const term = search.value.trim().toLowerCase()
  return allRows.value.filter(r => {
    if (needsReviewOnly.value && (r.empty || r.status === STATUS_APPROVED)) return false
    if (!term) return true
    return r.studentName.toLowerCase().includes(term)
  })
})

const totalCount = computed(() => allRows.value.filter(r => !r.empty).length)
const visibleCount = computed(() => rows.value.filter(r => !r.empty).length)
const approvedCount = computed(() => allRows.value.filter(r => r.status === STATUS_APPROVED).length)

const selectableRows = computed(() => rows.value.filter(r => !r.empty))
const allSelected = computed(() =>
  selectableRows.value.length > 0 && selectableRows.value.every(r => selectedKeys.value.has(r.rowKey)))

function toggleRow(rowKey, checked) {
  const next = new Set(selectedKeys.value)
  if (checked) next.add(rowKey)
  else next.delete(rowKey)
  selectedKeys.value = next
}

function toggleSelectAll() {
  selectedKeys.value = allSelected.value
    ? new Set()
    : new Set(selectableRows.value.map(r => r.rowKey))
}

const clearSelection = () => { selectedKeys.value = new Set() }

async function applyBulk(status) {
  const visible = new Set(selectableRows.value.map(r => r.rowKey))
  const targets = selectableRows.value
    .filter(r => selectedKeys.value.has(r.rowKey) && visible.has(r.rowKey))
    .map(r => ({ studentId: r.studentId, categorySlug: r.categorySlug }))
  if (!targets.length) return

  saving.value = true
  try {
    await setStatusBulk(props.schoolId, targets, status)
    clearSelection()
    emit('saved', null)
    toast.add({
      severity: 'success',
      summary: status === STATUS_APPROVED ? `${targets.length} approved` : `${targets.length} moved to needs review`,
      life: 2500,
    })
  } catch (e) {
    console.error('Could not apply the bulk status change', e)
    toast.add({ severity: 'error', summary: 'Could not update those remarks', detail: e.message, life: 4000 })
  } finally {
    saving.value = false
  }
}

const editorVisible = ref(false)
const editing = ref(null)
const draft = ref('')

const wordCount = computed(() => draft.value.trim().split(/\s+/).filter(Boolean).length)
const editorHeader = computed(() => editing.value
  ? `${editing.value.studentName} — ${editing.value.category}`
  : 'Edit comment')

function openEditor(row) {
  editing.value = row
  draft.value = row.comment || ''
  editorVisible.value = true
}

async function save() {
  saving.value = true
  try {
    await saveComment(props.schoolId, editing.value.studentId, editing.value.categorySlug, draft.value.trim())
    editorVisible.value = false
    emit('saved', editing.value.studentId)
    toast.add({ severity: 'success', summary: 'Saved & approved', life: 2000 })
  } catch (e) {
    console.error('Could not save smart remark', e)
    toast.add({ severity: 'error', summary: 'Could not save', detail: e.message, life: 4000 })
  } finally {
    saving.value = false
  }
}

async function toggleStatus(row) {
  const next = row.status === STATUS_APPROVED ? STATUS_NEEDS_REVIEW : STATUS_APPROVED
  saving.value = true
  try {
    await setStatus(props.schoolId, row.studentId, row.categorySlug, next)
    emit('saved', row.studentId)
  } catch (e) {
    console.error('Could not change smart remark status', e)
    toast.add({ severity: 'error', summary: 'Could not update status', detail: e.message, life: 4000 })
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
</style>
