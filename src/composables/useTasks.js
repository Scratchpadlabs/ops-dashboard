import { ref } from 'vue'
import { getDocs, query, orderBy, limit } from 'firebase/firestore'
import { opsCollection } from '../firebase/collections.js'

export const STATUSES = [
  { value: 'todo', label: 'To Do' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'done', label: 'Done' },
]

export const PRIORITIES = [
  { value: 'urgent', label: 'Urgent' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
]

export const ASSIGNEES = ['Sid', 'Angel', 'Ruchika']

const DISPLAY_NAMES = { sid: 'Sid', angel: 'Angel', ruchika: 'Ruchika' }

export function displayNameFromEmail(email) {
  const prefix = (email || '').split('@')[0].toLowerCase()
  if (DISPLAY_NAMES[prefix]) return DISPLAY_NAMES[prefix]
  return prefix ? prefix[0].toUpperCase() + prefix.slice(1) : 'Someone'
}

export function priorityDotClass(priority) {
  return {
    urgent: 'bg-red-500',
    high: 'bg-orange-500',
    medium: 'bg-blue-500',
    low: 'bg-slate-400',
  }[priority] || 'bg-slate-400'
}

export function priorityBadgeClass(priority) {
  return {
    urgent: 'bg-red-50 text-red-600',
    high: 'bg-orange-50 text-orange-600',
    medium: 'bg-blue-50 text-blue-600',
    low: 'bg-slate-100 text-slate-500',
  }[priority] || 'bg-slate-100 text-slate-500'
}

export function statusBadgeClass(status) {
  return {
    todo: 'bg-slate-100 text-slate-600',
    in_progress: 'bg-blue-50 text-blue-600',
    blocked: 'bg-red-50 text-red-600',
    done: 'bg-green-50 text-green-600',
  }[status] || 'bg-slate-100 text-slate-600'
}

export function statusLabel(status) {
  return STATUSES.find(s => s.value === status)?.label || status
}

export function priorityLabel(priority) {
  return PRIORITIES.find(p => p.value === priority)?.label || priority
}

export function priorityRank(priority) {
  return { urgent: 0, high: 1, medium: 2, low: 3 }[priority] ?? 4
}

export function isTaskOverdue(task) {
  if (!task.due_date || task.status === 'done') return false
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const due = new Date(task.due_date + 'T00:00:00')
  return due < today
}

export function assigneeChipClass(assignee) {
  if (assignee === 'Sid') return 'bg-purple-500'
  if (assignee === 'Angel') return 'bg-blue-500'
  if (assignee === 'Ruchika') return 'bg-emerald-500'
  return 'bg-slate-300'
}

export function sortTasksForWidget(tasks) {
  return [...tasks].sort((a, b) => {
    const aOverdue = isTaskOverdue(a)
    const bOverdue = isTaskOverdue(b)
    if (aOverdue !== bOverdue) return aOverdue ? -1 : 1
    const aDue = a.due_date || '9999-99-99'
    const bDue = b.due_date || '9999-99-99'
    if (aDue !== bDue) return aDue < bDue ? -1 : 1
    return priorityRank(a.priority) - priorityRank(b.priority)
  })
}

export function timeAgo(date) {
  const diff = Math.floor((new Date() - date) / 1000)
  if (diff < 60) return 'just now'
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago'
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago'
  if (diff < 604800) return Math.floor(diff / 86400) + 'd ago'
  return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}

export function useTasks() {
  const tasks = ref([])
  const tasksLoading = ref(false)

  async function loadTasks() {
    tasksLoading.value = true
    try {
      const snap = await getDocs(query(opsCollection('tasks'), orderBy('created_at', 'desc'), limit(500)))
      tasks.value = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    } catch (e) {
      console.error('Could not load tasks', e)
    } finally {
      tasksLoading.value = false
    }
  }

  return { tasks, tasksLoading, loadTasks }
}
