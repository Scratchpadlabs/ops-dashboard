/**
 * Smart Remarks — general-conduct report-card comments, generated from the
 * "Smart Sheets" ticking system (schools/{id}/remark_categories +
 * remarks_sheets/*\/entries), NOT the AAP survey. See
 * functions/generate_smart_remarks/main.py's module docstring for the full
 * data-shape writeup — this composable is the thin client wrapper, same
 * shape as useAapRemarks.js.
 *
 * The roster comes from `class_detail` (functions/assign_survey), same as
 * AAP Remarks — that callable already resolves a class the way the rest of
 * the dashboard does, including schools whose students key their class off
 * a different field entirely.
 */
import { ref } from 'vue'
import { getDocs, query, orderBy, limit, onSnapshot } from 'firebase/firestore'

import { rootSchoolsCollection, schoolCollection, smartRemarksJobsCollection } from '../firebase/schoolCollections.js'
import { compareClassIds } from './useSurveys.js'
import {
  classDetailRemote, generateSmartRemarksRemote, scanSmartRemarksRemote,
  listSmartRemarksRemote, updateSmartRemarkRemote, bulkUpdateSmartRemarksRemote,
} from '../utils/api.js'

export const STATUS_APPROVED = 'approved'
export const STATUS_NEEDS_REVIEW = 'needs_review'

export function useSmartRemarks() {
  const schools = ref([])
  const classes = ref([])
  const students = ref([])
  // { studentId: remark | null }
  const remarksByStudent = ref({})

  const loadingSchools = ref(false)
  const loadingClasses = ref(false)
  const loadingRoster = ref(false)

  async function loadSchools() {
    loadingSchools.value = true
    try {
      const snap = await getDocs(query(rootSchoolsCollection(), orderBy('name'), limit(500)))
      schools.value = snap.docs
        .map(d => ({ ...d.data(), id: d.id }))
        .filter(s => s.isActive !== false)
      return schools.value
    } finally {
      loadingSchools.value = false
    }
  }

  async function loadClasses(schoolId) {
    classes.value = []
    if (!schoolId) return classes.value
    loadingClasses.value = true
    try {
      const snap = await getDocs(schoolCollection(schoolId, 'classes'))
      classes.value = snap.docs
        .map(d => ({ ...d.data(), id: d.id }))
        .filter(c => c.isActive !== false)
        .map(c => ({ id: c.id, label: c.name || c.id, stage: c.stage || '' }))
        .sort((a, b) => compareClassIds(a.id, b.id))
      return classes.value
    } finally {
      loadingClasses.value = false
    }
  }

  async function loadClass(schoolId, classId) {
    students.value = []
    remarksByStudent.value = {}
    if (!schoolId || !classId) return
    loadingRoster.value = true
    try {
      const detail = await classDetailRemote({ schoolId, classId })
      students.value = detail.students || []
      await loadRemarks(schoolId, students.value.map(s => s.id))
    } finally {
      loadingRoster.value = false
    }
  }

  async function loadRemarks(schoolId, studentIds) {
    if (!studentIds.length) return
    const byStudent = await listSmartRemarksRemote({ schoolId, studentIds })
    remarksByStudent.value = { ...remarksByStudent.value, ...byStudent }
  }

  async function reloadStudent(schoolId, studentId) {
    await loadRemarks(schoolId, [studentId])
  }

  const generate = generateSmartRemarksRemote
  const scan = scanSmartRemarksRemote

  async function saveComment(schoolId, studentId, comment) {
    await updateSmartRemarkRemote({ schoolId, studentId, comment, status: STATUS_APPROVED })
  }

  async function setStatus(schoolId, studentId, status) {
    await updateSmartRemarkRemote({ schoolId, studentId, status })
  }

  async function setStatusBulk(schoolId, studentIds, status) {
    await bulkUpdateSmartRemarksRemote({ schoolId, studentIds, status })
    return studentIds.length
  }

  // ── Generation job progress ─────────────────────────────────────────────
  // Same "job doc written before the model calls start" pattern as AAP —
  // the callable only returns jobId once the whole run finishes, so a
  // still-running job is found rather than addressed.
  async function recentJobIds(schoolId) {
    const snap = await getDocs(query(smartRemarksJobsCollection(schoolId), orderBy('startedAt', 'desc'), limit(20)))
    return new Set(snap.docs.map(d => d.id))
  }

  function watchNewJob(schoolId, classId, knownJobIds, cb) {
    return onSnapshot(
      query(smartRemarksJobsCollection(schoolId), orderBy('startedAt', 'desc'), limit(20)),
      (snap) => {
        const job = snap.docs
          .map(d => ({ ...d.data(), id: d.id }))
          .find(j => j.classId === classId && !knownJobIds.has(j.id))
        if (job) cb(job)
      },
      (e) => { console.error('Smart remarks job listener failed', e) },
    )
  }

  return {
    schools, classes, students, remarksByStudent,
    loadingSchools, loadingClasses, loadingRoster,
    loadSchools, loadClasses, loadClass, loadRemarks, reloadStudent,
    generate, scan, saveComment, setStatus, setStatusBulk,
    recentJobIds, watchNewJob,
  }
}
