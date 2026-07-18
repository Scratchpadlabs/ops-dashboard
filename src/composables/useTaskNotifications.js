import { ref } from 'vue'
import { getDocs, query } from 'firebase/firestore'
import { opsCollection } from '../firebase/collections.js'
import { isTaskOverdue } from './useTasks.js'

const ENABLED_KEY = 'task_notifications_enabled'
const NOTIFIED_KEY = 'task_notifications_notified_ids'
const POLL_INTERVAL_MS = 5 * 60 * 1000

const supported = typeof window !== 'undefined' && 'Notification' in window

// Module-level — shared globally so the header bell and the polling loop
// (started once from App.vue) stay in sync across every component.
export const notificationsSupported = ref(supported)
export const notificationPermission = ref(supported ? Notification.permission : 'unsupported')
export const notificationsEnabled = ref(supported && localStorage.getItem(ENABLED_KEY) === 'true')

function isDueOrOverdue(task) {
  if (!task.due_date || task.status === 'done') return false
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const due = new Date(task.due_date + 'T00:00:00')
  return due <= today
}

function loadNotifiedIds() {
  try {
    return new Set(JSON.parse(localStorage.getItem(NOTIFIED_KEY) || '[]'))
  } catch (e) {
    return new Set()
  }
}

function saveNotifiedIds(ids) {
  localStorage.setItem(NOTIFIED_KEY, JSON.stringify([...ids]))
}

// Must be called from a user gesture (e.g. a click handler) — browsers reject
// permission prompts triggered any other way.
export async function requestTaskNotificationPermission() {
  if (!supported) return 'unsupported'
  const result = await Notification.requestPermission()
  notificationPermission.value = result
  if (result === 'granted') {
    notificationsEnabled.value = true
    localStorage.setItem(ENABLED_KEY, 'true')
  }
  return result
}

export function disableTaskNotifications() {
  notificationsEnabled.value = false
  localStorage.setItem(ENABLED_KEY, 'false')
}

// Fires one browser notification per pending/overdue task, remembering what's
// already been shown (keyed by task id + due date) so re-polling doesn't repeat it.
export function notifyDueTasks(tasks) {
  if (!supported || !notificationsEnabled.value || notificationPermission.value !== 'granted') return

  const notified = loadNotifiedIds()
  const due = tasks.filter(t => isDueOrOverdue(t) && !notified.has(`${t.id}:${t.due_date}`))
  if (!due.length) return

  due.forEach(t => {
    const overdue = isTaskOverdue(t)
    const n = new Notification(overdue ? 'Task overdue' : 'Task due today', {
      body: t.title + (t.school_name ? ` · ${t.school_name}` : ''),
      tag: `task-${t.id}`,
      icon: '/logo.png',
    })
    n.onclick = () => {
      window.focus()
      n.close()
    }
    notified.add(`${t.id}:${t.due_date}`)
  })
  saveNotifiedIds(notified)
}

let pollTimer = null

// Polls Firestore directly (rather than relying on a shared task list) so it
// keeps running regardless of which page the user is on.
async function pollOnce() {
  if (!notificationsEnabled.value || notificationPermission.value !== 'granted') return
  try {
    const snap = await getDocs(query(opsCollection('tasks')))
    const tasks = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    notifyDueTasks(tasks)
  } catch (e) {
    console.error('Could not check tasks for notifications', e)
  }
}

export function startTaskNotificationPolling() {
  if (pollTimer || !supported) return
  pollOnce()
  pollTimer = setInterval(pollOnce, POLL_INTERVAL_MS)
}

export function stopTaskNotificationPolling() {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
}

export function useTaskNotifications() {
  return {
    notificationsSupported,
    notificationPermission,
    notificationsEnabled,
    requestTaskNotificationPermission,
    disableTaskNotifications,
    notifyDueTasks,
    startTaskNotificationPolling,
    stopTaskNotificationPolling,
  }
}
