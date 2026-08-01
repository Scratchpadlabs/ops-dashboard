/**
 * Survey management (v2) — class-first matrix, multi-survey assignment,
 * completion reports.
 *
 * The matrix, the assignment writes and the reports all happen in Cloud
 * Functions (functions/assign_survey): a 3000-student school is 3000 reads
 * plus an id-only pass per survey, which is not work for a browser tab. This
 * composable is the client half — it holds the loaded matrix, the roster used
 * for drill-down, and the filter state.
 *
 * Nothing here ever writes to a survey document.
 */
import { ref, computed } from 'vue'
import { getDocs, query, orderBy, limit, onSnapshot } from 'firebase/firestore'
import {
  surveyAssignmentsCollection, surveyAssignmentDoc, rootSchoolsCollection,
} from '../firebase/schoolCollections.js'
import {
  assignSurveyRemote, surveyMatrixRemote, surveyReportRemote, classDetailRemote,
} from '../utils/api.js'

// Mirrors DEFAULT_INBOX_FIELD in functions/assign_survey/survey_rules.py.
// Verified for students; assumed for staff (see that file) — the preview
// reports how many targeted docs actually carry it, which is what surfaces a
// wrong assumption before any write.
export const INBOX_FIELD = 'surveyInbox'

export const STATUS_NOT_ASSIGNED = 'not assigned'
export const STATUS_PENDING = 'pending'
export const STATUS_COMPLETED = 'completed'

/**
 * Grade-aware class ordering, mirroring class_sort_key in survey_rules.py.
 *
 * Plain string sorting gets these WRONG — '_' (0x5F) sorts after 'I', so
 * "II_Ruby" lands before "I_Diamond", and "10_A" before "2_A". The matrix
 * rows arrive already sorted by the server; this exists for anything the
 * client groups itself (drill-down, class filter lists).
 */
const PRE_PRIMARY_ORDER = { 'PRE-NURSERY': -4, NURSERY: -3, LKG: -2, UKG: -1 }
const ROMAN_ORDER = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10, XI: 11, XII: 12 }

export function gradeOrder(grade) {
  const g = String(grade || '').trim().toUpperCase()
  if (g in PRE_PRIMARY_ORDER) return PRE_PRIMARY_ORDER[g]
  if (g in ROMAN_ORDER) return ROMAN_ORDER[g]
  if (/^\d+$/.test(g)) return parseInt(g, 10)
  return 999
}

export function compareClassIds(a, b) {
  const [ga, , sa] = String(a || '').match(/^([^_]*)(_)?(.*)$/).slice(1)
  const [gb, , sb] = String(b || '').match(/^([^_]*)(_)?(.*)$/).slice(1)
  return gradeOrder(ga) - gradeOrder(gb)
    || String(sa).toLowerCase().localeCompare(String(sb).toLowerCase())
    || String(a).localeCompare(String(b))
}

export function gradeOf(classId) {
  return String(classId || '').split('_')[0] || ''
}

// Mirrors is_inactive() in survey_rules.py: active unless it explicitly says
// otherwise, so a roster predating the flag isn't skipped wholesale.
const INACTIVE_VALUES = new Set([
  'inactive', 'left', 'tc', 'tc issued', 'dropped', 'dropout',
  'alumni', 'passed out', 'transferred', 'withdrawn',
])
export function isInactive(doc) {
  if (doc?.isActive === false) return true
  const status = String(doc?.enrollmentStatus || doc?.status || '').trim().toLowerCase()
  return INACTIVE_VALUES.has(status)
}

/** One student's status on one survey — mirrors student_status() exactly. */
export function studentStatus(student, surveyId, responderIds) {
  const inbox = student?.[INBOX_FIELD]
  if (!Array.isArray(inbox) || !inbox.includes(surveyId)) return STATUS_NOT_ASSIGNED
  return responderIds?.has?.(student.id) ? STATUS_COMPLETED : STATUS_PENDING
}

export function useSurveys() {
  const schools = ref([])
  const matrix = ref(null)          // {surveys, rows, totals, ...}
  const students = ref([])
  const loadingMatrix = ref(false)
  const loadingRoster = ref(false)

  async function loadSchools() {
    const snap = await getDocs(query(rootSchoolsCollection(), orderBy('name'), limit(500)))
    schools.value = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(s => s.isActive !== false)
    return schools.value
  }

  async function loadMatrix(schoolId, { activeWindowOnly = false, force = false } = {}) {
    if (!schoolId) { matrix.value = null; return null }
    loadingMatrix.value = true
    try {
      matrix.value = await surveyMatrixRemote({ schoolId, activeWindowOnly, force, inboxField: INBOX_FIELD })
      return matrix.value
    } finally {
      loadingMatrix.value = false
    }
  }

  /**
   * One class's students plus who among them responded — for drill-down.
   *
   * Deliberately per-class rather than a whole-school roster read: the
   * payload and the response lookup both stay bounded by class size. The
   * matrix itself never needs this (it arrives pre-counted), and neither
   * does assignment (the function re-resolves targets server-side from the
   * scope, so stale data here cannot produce a wrong write).
   */
  async function loadClassDetail(schoolId, classId) {
    if (!schoolId || !classId) return { students: [], responders: {} }
    loadingRoster.value = true
    try {
      const detail = await classDetailRemote({ schoolId, classId, inboxField: INBOX_FIELD })
      students.value = detail.students || []
      // Response ids arrive as arrays; Sets are what studentStatus() wants.
      const responders = {}
      for (const [sid, ids] of Object.entries(detail.responders || {})) responders[sid] = new Set(ids)
      return { students: students.value, responders }
    } finally {
      loadingRoster.value = false
    }
  }

  async function loadRuns(schoolId) {
    const snap = await getDocs(query(surveyAssignmentsCollection(schoolId), orderBy('run_at', 'desc'), limit(25)))
    return snap.docs.map(d => ({ id: d.id, ...d.data() }))
  }

  // Preview and apply are the same server call with dryRun flipped, so the
  // count on the confirm button is the count that happens.
  const preview = (args) => assignSurveyRemote({ ...args, dryRun: true, inboxField: INBOX_FIELD })
  const apply = (args) => assignSurveyRemote({ ...args, dryRun: false, inboxField: INBOX_FIELD })

  // Progress streams through the run doc the function updates per chunk.
  function watchRun(schoolId, runId, cb) {
    return onSnapshot(surveyAssignmentDoc(schoolId, runId), snap => {
      cb(snap.exists() ? { id: snap.id, ...snap.data() } : null)
    })
  }

  const surveys = computed(() => matrix.value?.surveys || [])
  const rows = computed(() => matrix.value?.rows || [])
  const totals = computed(() => matrix.value?.totals || {})
  const allClassIds = computed(() => rows.value.map(r => r.class_id))
  const grades = computed(() => [...new Set(allClassIds.value.map(gradeOf))]
    .sort((a, b) => gradeOrder(a) - gradeOrder(b)))

  return {
    schools, matrix, surveys, rows, totals, allClassIds, grades, students,
    loadingMatrix, loadingRoster,
    loadSchools, loadMatrix, loadClassDetail, loadRuns,
    preview, apply, watchRun,
    generateReport: surveyReportRemote,
  }
}

/** Cell arithmetic used by both the grid and the drill-down. */
export function completionPct(cell) {
  if (!cell?.assigned) return 0
  return Math.round(cell.responded / cell.assigned * 100)
}
export function assignedPct(cell) {
  if (!cell?.total) return 0
  return Math.round(cell.assigned / cell.total * 100)
}
