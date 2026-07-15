<template>
  <div>
    <!-- Header -->
    <div class="flex items-center justify-between mb-5">
      <div class="flex items-center gap-1 bg-slate-100 rounded-lg p-1">
        <button
          @click="viewMode = 'kanban'"
          class="px-3 py-1.5 rounded-md text-sm font-medium transition-all flex items-center"
          :class="viewMode === 'kanban' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500 hover:text-slate-700'"
        ><i class="pi pi-th-large mr-1.5 text-xs"></i>Kanban</button>
        <button
          @click="viewMode = 'list'"
          class="px-3 py-1.5 rounded-md text-sm font-medium transition-all flex items-center"
          :class="viewMode === 'list' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500 hover:text-slate-700'"
        ><i class="pi pi-list mr-1.5 text-xs"></i>List</button>
      </div>
      <Button label="New Task" icon="pi pi-plus" @click="openCreate" />
    </div>

    <div v-if="tasksLoading" class="flex items-center justify-center py-20">
      <ProgressSpinner style="width:32px;height:32px" />
    </div>

    <template v-else>
      <!-- ── KANBAN ─────────────────────────────────────────────────────── -->
      <div v-if="viewMode === 'kanban'" class="grid grid-cols-4 gap-4">
        <div
          v-for="col in STATUSES" :key="col.value"
          class="bg-slate-50 rounded-2xl flex flex-col transition-all"
          :class="dragOverCol === col.value ? 'ring-2 ring-blue-300' : ''"
          @dragover.prevent="dragOverCol = col.value"
          @dragleave="onColDragLeave(col.value)"
          @drop.prevent="onDrop(col.value)"
        >
          <div class="px-4 py-3 flex items-center justify-between">
            <span class="text-sm font-bold text-slate-700">{{ col.label }}</span>
            <span class="text-xs font-semibold px-2 py-0.5 rounded-full bg-white text-slate-500">{{ tasksByStatus(col.value).length }}</span>
          </div>
          <div class="flex-1 px-3 pb-3 space-y-2.5 overflow-y-auto" style="min-height: 120px; max-height: calc(100vh - 260px)">
            <div
              v-for="t in tasksByStatus(col.value)" :key="t.id"
              draggable="true"
              @dragstart="onDragStart(t)"
              @dragend="onDragEnd"
              @click="openEdit(t)"
              class="bg-white rounded-xl border border-slate-200 p-3 cursor-pointer hover:shadow-md hover:border-slate-300 transition-all"
              :class="col.value === 'done' ? 'opacity-60' : ''"
            >
              <div class="flex items-start gap-2 mb-1.5">
                <span
                  class="w-2 h-2 rounded-full mt-1 flex-shrink-0"
                  :class="[priorityDotClass(t.priority), t.priority === 'urgent' ? 'pulse-dot' : '']"
                ></span>
                <span class="text-sm font-semibold text-slate-800 leading-snug" :class="col.value === 'done' ? 'line-through text-slate-400' : ''">{{ t.title }}</span>
              </div>

              <div v-if="(t.tags || []).length" class="flex flex-wrap gap-1 mb-2 ml-4">
                <span v-for="tag in t.tags" :key="tag" class="px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-slate-100 text-slate-500">{{ tag }}</span>
              </div>

              <div class="flex items-center justify-between ml-4 gap-2">
                <div class="flex items-center gap-1.5 min-w-0">
                  <span v-if="t.school_name" class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-50 text-blue-600 truncate max-w-[90px]">{{ t.school_name }}</span>
                  <span v-if="t.due_date" class="text-[11px] font-medium flex items-center gap-0.5 flex-shrink-0" :class="isTaskOverdue(t) ? 'text-red-500' : 'text-slate-400'">
                    <i class="pi pi-calendar text-[9px]"></i>{{ formatDue(t.due_date) }}
                    <span v-if="isTaskOverdue(t)" class="font-bold">&middot; Overdue</span>
                  </span>
                </div>
                <div class="flex items-center gap-1.5 flex-shrink-0">
                  <span v-if="(t.comments || []).length" class="flex items-center gap-0.5 text-[10px] text-slate-400"><i class="pi pi-comment text-[10px]"></i>{{ t.comments.length }}</span>
                  <span v-if="t.assignee" class="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold text-white" :class="assigneeChipClass(t.assignee)">{{ t.assignee[0] }}</span>
                </div>
              </div>
            </div>

            <div v-if="tasksByStatus(col.value).length === 0" class="text-center py-8 text-xs text-slate-300">No tasks</div>
          </div>
        </div>
      </div>

      <!-- ── LIST ───────────────────────────────────────────────────────── -->
      <div v-else>
        <div class="flex flex-wrap items-center gap-2 mb-4 bg-white rounded-xl border border-slate-200 p-3">
          <Select v-model="filters.status" :options="STATUSES" optionLabel="label" optionValue="value" placeholder="Status" showClear class="w-40" />
          <Select v-model="filters.priority" :options="PRIORITIES" optionLabel="label" optionValue="value" placeholder="Priority" showClear class="w-40" />
          <Select v-model="filters.assignee" :options="ASSIGNEES" placeholder="Assignee" showClear class="w-40" />
          <Select v-model="filters.tag" :options="allTags" placeholder="Tag" showClear class="w-40" />
          <button
            @click="filters.overdueOnly = !filters.overdueOnly"
            class="px-3 py-1.5 rounded-lg text-xs font-medium border transition-all whitespace-nowrap"
            :class="filters.overdueOnly ? 'bg-red-50 text-red-600 border-red-200' : 'bg-white text-slate-500 border-slate-200 hover:border-slate-300'"
          ><i class="pi pi-exclamation-circle mr-1"></i>Overdue only</button>
          <Button v-if="filtersActive" label="Clear Filters" text size="small" @click="clearFilters" />
        </div>

        <div v-if="filteredSortedTasks.length === 0" class="text-center py-14 text-slate-300 text-sm bg-white rounded-xl border border-slate-200">No tasks match these filters</div>
        <div v-else class="bg-white rounded-xl border border-slate-200 overflow-hidden overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="text-left text-xs text-slate-400 uppercase tracking-wide border-b border-slate-100">
                <th class="px-4 py-2.5 font-semibold w-10"></th>
                <th class="px-2 py-2.5 font-semibold">Title</th>
                <th class="px-3 py-2.5 font-semibold">Status</th>
                <th class="px-3 py-2.5 font-semibold">Priority</th>
                <th class="px-3 py-2.5 font-semibold">Assignee</th>
                <th class="px-3 py-2.5 font-semibold">Tags</th>
                <th class="px-3 py-2.5 font-semibold">Due Date</th>
                <th class="px-3 py-2.5 font-semibold">School</th>
                <th class="px-3 py-2.5 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="t in filteredSortedTasks" :key="t.id" class="border-b border-slate-50 last:border-0 hover:bg-slate-50 transition-colors">
                <td class="px-4 py-3">
                  <Checkbox :binary="true" :model-value="t.status === 'done'" @update:model-value="toggleDone(t)" />
                </td>
                <td class="px-2 py-3 font-medium text-slate-800 cursor-pointer" @click="openEdit(t)">
                  <span :class="t.status === 'done' ? 'line-through text-slate-400' : ''">{{ t.title }}</span>
                </td>
                <td class="px-3 py-3">
                  <span class="px-2 py-0.5 rounded-full text-xs font-semibold" :class="statusBadgeClass(t.status)">{{ statusLabel(t.status) }}</span>
                </td>
                <td class="px-3 py-3">
                  <span class="px-2 py-0.5 rounded-full text-xs font-semibold inline-flex items-center gap-1" :class="priorityBadgeClass(t.priority)">
                    <span class="w-1.5 h-1.5 rounded-full" :class="priorityDotClass(t.priority)"></span>{{ priorityLabel(t.priority) }}
                  </span>
                </td>
                <td class="px-3 py-3 text-slate-600">{{ t.assignee || '—' }}</td>
                <td class="px-3 py-3">
                  <div class="flex flex-wrap gap-1 max-w-[160px]">
                    <span v-for="tag in t.tags" :key="tag" class="px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-slate-100 text-slate-500">{{ tag }}</span>
                  </div>
                </td>
                <td class="px-3 py-3 text-xs font-medium" :class="isTaskOverdue(t) ? 'text-red-500' : 'text-slate-500'">
                  {{ t.due_date ? formatDue(t.due_date) : '—' }}
                  <span v-if="isTaskOverdue(t)" class="font-bold block">Overdue</span>
                </td>
                <td class="px-3 py-3 text-slate-600">{{ t.school_name || '—' }}</td>
                <td class="px-3 py-3 text-right">
                  <Button icon="pi pi-pencil" text rounded size="small" @click="openEdit(t)" />
                  <Button icon="pi pi-trash" text rounded size="small" severity="danger" @click="deleteTask(t)" />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>

    <TaskDialog
      v-model:visible="dialogVisible"
      :task="editingTask"
      :existing-tags="allTags"
      :all-schools="allSchools"
      @saved="loadTasks"
      @deleted="loadTasks"
    />
    <ConfirmDialog />
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { auth } from '../firebase/config'
import { opsDoc } from '../firebase/collections.js'
import { updateDoc, deleteDoc, serverTimestamp } from 'firebase/firestore'
import { useConfirm } from 'primevue/useconfirm'
import { useToast } from 'primevue/usetoast'
import { useCelebration } from '../composables/useCelebration'
import { useAllSchools } from '../composables/useAllSchools.js'
import {
  useTasks, STATUSES, PRIORITIES, ASSIGNEES,
  priorityDotClass, priorityBadgeClass, priorityLabel, priorityRank,
  statusBadgeClass, statusLabel, assigneeChipClass, isTaskOverdue,
} from '../composables/useTasks.js'
import TaskDialog from '../components/tasks/TaskDialog.vue'

import Button from 'primevue/button'
import Select from 'primevue/select'
import Checkbox from 'primevue/checkbox'
import ProgressSpinner from 'primevue/progressspinner'
import ConfirmDialog from 'primevue/confirmdialog'

const confirm = useConfirm()
const toast = useToast()
const { celebrate } = useCelebration()

const { tasks, tasksLoading, loadTasks } = useTasks()
const { allSchools, loadAllSchools } = useAllSchools()

const viewMode = ref('kanban')
const dialogVisible = ref(false)
const editingTask = ref(null)

function openCreate() { editingTask.value = null; dialogVisible.value = true }
function openEdit(t) { editingTask.value = t; dialogVisible.value = true }

// ── Kanban drag & drop ───────────────────────────────────────────────────
const draggingTask = ref(null)
const dragOverCol = ref(null)

function tasksByStatus(status) {
  return tasks.value
    .filter(t => t.status === status)
    .sort((a, b) => {
      const pr = priorityRank(a.priority) - priorityRank(b.priority)
      if (pr !== 0) return pr
      const aDue = a.due_date || '9999-99-99'
      const bDue = b.due_date || '9999-99-99'
      return aDue < bDue ? -1 : aDue > bDue ? 1 : 0
    })
}

function onDragStart(t) { draggingTask.value = t }
function onDragEnd() { draggingTask.value = null; dragOverCol.value = null }
function onColDragLeave(col) { if (dragOverCol.value === col) dragOverCol.value = null }

async function onDrop(colValue) {
  dragOverCol.value = null
  const t = draggingTask.value
  draggingTask.value = null
  if (!t || t.status === colValue) return

  const prevStatus = t.status
  const wasNotDone = prevStatus !== 'done'
  const becomingDone = colValue === 'done'
  t.status = colValue // optimistic

  try {
    await updateDoc(opsDoc('tasks', t.id), {
      status: colValue,
      completed_at: becomingDone ? serverTimestamp() : null,
      updated_at: serverTimestamp(),
      updated_by: auth.currentUser?.email || 'unknown',
    })
    if (becomingDone && wasNotDone) celebrate('Task crushed ✅', '✅', 'task')
  } catch (e) {
    t.status = prevStatus
    toast.add({ severity: 'error', summary: 'Error', detail: 'Could not update task', life: 3000 })
  }
}

// ── List: toggle done / delete ──────────────────────────────────────────
async function toggleDone(t) {
  const becomingDone = t.status !== 'done'
  const newStatus = becomingDone ? 'done' : 'todo'
  const prevStatus = t.status
  t.status = newStatus // optimistic

  try {
    await updateDoc(opsDoc('tasks', t.id), {
      status: newStatus,
      completed_at: becomingDone ? serverTimestamp() : null,
      updated_at: serverTimestamp(),
      updated_by: auth.currentUser?.email || 'unknown',
    })
    if (becomingDone) celebrate('Task crushed ✅', '✅', 'task')
  } catch (e) {
    t.status = prevStatus
    toast.add({ severity: 'error', summary: 'Error', detail: 'Could not update task', life: 3000 })
  }
}

function deleteTask(t) {
  confirm.require({
    message: `Delete task "${t.title}"?`,
    header: 'Delete Task',
    icon: 'pi pi-exclamation-triangle',
    rejectLabel: 'Cancel', acceptLabel: 'Delete', acceptClass: 'p-button-danger',
    accept: async () => {
      try {
        await deleteDoc(opsDoc('tasks', t.id))
        await loadTasks()
        toast.add({ severity: 'info', summary: 'Task deleted', life: 2000 })
      } catch (e) {
        toast.add({ severity: 'error', summary: 'Error', detail: 'Could not delete', life: 3000 })
      }
    }
  })
}

// ── List: filters ────────────────────────────────────────────────────────
const filters = reactive({ status: null, priority: null, assignee: null, tag: null, overdueOnly: false })
const filtersActive = computed(() => !!(filters.status || filters.priority || filters.assignee || filters.tag || filters.overdueOnly))
function clearFilters() { Object.assign(filters, { status: null, priority: null, assignee: null, tag: null, overdueOnly: false }) }

const allTags = computed(() => {
  const set = new Set()
  tasks.value.forEach(t => (t.tags || []).forEach(tag => set.add(tag)))
  return Array.from(set).sort()
})

const filteredSortedTasks = computed(() => {
  return tasks.value
    .filter(t => {
      if (filters.status && t.status !== filters.status) return false
      if (filters.priority && t.priority !== filters.priority) return false
      if (filters.assignee && t.assignee !== filters.assignee) return false
      if (filters.tag && !(t.tags || []).includes(filters.tag)) return false
      if (filters.overdueOnly && !isTaskOverdue(t)) return false
      return true
    })
    .sort((a, b) => {
      const aDue = a.due_date || '9999-99-99'
      const bDue = b.due_date || '9999-99-99'
      return aDue < bDue ? -1 : aDue > bDue ? 1 : 0
    })
})

function formatDue(dateStr) {
  if (!dateStr) return ''
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}

onMounted(() => {
  Promise.all([loadTasks(), loadAllSchools()])
})
</script>

<style scoped>
.pulse-dot {
  animation: task-pulse 1.4s ease-in-out infinite;
}
@keyframes task-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.5); }
  50% { box-shadow: 0 0 0 4px rgba(239, 68, 68, 0); }
}
</style>
