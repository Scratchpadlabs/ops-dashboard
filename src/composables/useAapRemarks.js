/**
 * AAP remarks (Awareness / Sensitivity / Creativity) — the client half.
 *
 * Generation is a Cloud Function (functions/generate_aap_remarks): it resolves
 * each student's Beginner/Proficient/Advanced level per subject from the AAP
 * survey responses, looks the descriptor text up in the shared `aap_framework`
 * collection, and writes ONE doc per student per subject to
 * schools/{id}/students/{sid}/aap_remarks/{subject}.
 *
 * Everything after generation is a plain Firestore write from here: editing a
 * comment and flipping approved / needs_review touch the remark doc directly.
 * The function is never called to approve or edit — only to (re)generate text.
 *
 * The roster comes from `class_detail` (functions/assign_survey) rather than a
 * client query on currentClassId, deliberately: that callable already resolves
 * a class the way the rest of the dashboard does, including the schools whose
 * students key their class off a different field entirely (AUDIT.md §2.3). A
 * naive equality query here would quietly show an empty class for those.
 */
import { ref } from 'vue'
import {
  getDocs, query, orderBy, limit, onSnapshot, setDoc, serverTimestamp,
} from 'firebase/firestore'

import {
  rootSchoolsCollection, schoolCollection, aapJobsCollection,
  studentAapRemarksCollection, studentAapRemarkDoc,
} from '../firebase/schoolCollections.js'
import { compareClassIds } from './useSurveys.js'
import { classDetailRemote, generateAapRemarksRemote } from '../utils/api.js'
import { auth } from '../firebase/config'

export const STATUS_APPROVED = 'approved'
export const STATUS_NEEDS_REVIEW = 'needs_review'

/** The three traits, in the order the function prompts with them. */
export const TRAITS = ['awareness', 'sensitivity', 'creativity']

/** Word window the generator is prompted to hit — shown while editing so a
 *  hand-written comment can be held to the same shape as a generated one. */
export const MIN_WORDS = 40
export const MAX_WORDS = 55

export function countWords(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length
}

export function useAapRemarks() {
  const schools = ref([])
  const classes = ref([])
  const students = ref([])
  // { studentId: [{ id: subject, awareness, sensitivity, creativity, comment, status }] }
  const remarksByStudent = ref({})

  const loadingSchools = ref(false)
  const loadingClasses = ref(false)
  const loadingRoster = ref(false)

  async function loadSchools() {
    loadingSchools.value = true
    try {
      const snap = await getDocs(query(rootSchoolsCollection(), orderBy('name'), limit(500)))
      // `...d.data()` FIRST, doc id after: root school docs carry their own
      // `id` field, and letting that win is what once made the Surveys picker
      // address a different school than the one it displayed. The doc id is
      // the only thing that addresses a subcollection.
      schools.value = snap.docs
        .map(d => ({ ...d.data(), id: d.id }))
        .filter(s => s.isActive !== false)
      return schools.value
    } finally {
      loadingSchools.value = false
    }
  }

  /**
   * The school's configured classes. The class doc id (`{grade}_{section}`) is
   * exactly the `class_id` the function matches survey responses against, so
   * the picker's value can be passed straight through.
   */
  async function loadClasses(schoolId) {
    classes.value = []
    if (!schoolId) return classes.value
    loadingClasses.value = true
    try {
      const snap = await getDocs(schoolCollection(schoolId, 'classes'))
      classes.value = snap.docs
        .map(d => ({ ...d.data(), id: d.id }))
        .filter(c => c.isActive !== false)
        .map(c => ({ id: c.id, label: c.name || c.id }))
        .sort((a, b) => compareClassIds(a.id, b.id))
      return classes.value
    } finally {
      loadingClasses.value = false
    }
  }

  /** The class roster plus whatever remarks already exist for it. */
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

  /**
   * One subcollection read per student. Bounded by class size (30-60 docs),
   * the same trade the survey drill-down makes — a collectionGroup query would
   * be one read but needs its own index and would pull every school's remarks
   * back through the rules layer to filter client-side.
   */
  async function loadRemarks(schoolId, studentIds) {
    const entries = await Promise.all(studentIds.map(async (sid) => {
      const snap = await getDocs(studentAapRemarksCollection(schoolId, sid))
      const rows = snap.docs
        .map(d => ({ ...d.data(), id: d.id }))
        .sort((a, b) => a.id.localeCompare(b.id))
      return [sid, rows]
    }))
    remarksByStudent.value = {
      ...remarksByStudent.value,
      ...Object.fromEntries(entries),
    }
  }

  /** Re-read one student after a regenerate or an edit, leaving the rest be. */
  async function reloadStudent(schoolId, studentId) {
    await loadRemarks(schoolId, [studentId])
  }

  /**
   * Job ids that already existed when a run is about to start.
   *
   * The callable returns its jobId only when it FINISHES, so the id cannot be
   * used to follow a run that is still going. The function does write the job
   * doc early — before the first model call — so the run is identified instead
   * as "the newest job for this class that wasn't here a moment ago".
   *
   * Ids rather than a timestamp comparison on purpose: startedAt is a SERVER
   * timestamp and the browser's clock is not, so "started after now" is not a
   * question this side can answer honestly.
   */
  async function recentJobIds(schoolId) {
    const snap = await getDocs(query(aapJobsCollection(schoolId), orderBy('startedAt', 'desc'), limit(20)))
    return new Set(snap.docs.map(d => d.id))
  }

  function watchNewJob(schoolId, classId, knownJobIds, cb) {
    return onSnapshot(
      query(aapJobsCollection(schoolId), orderBy('startedAt', 'desc'), limit(20)),
      (snap) => {
        const job = snap.docs
          .map(d => ({ ...d.data(), id: d.id }))
          .find(j => j.classId === classId && !knownJobIds.has(j.id))
        if (job) cb(job)
      },
      (e) => {
        // A failed listener costs the progress bar, never the run itself —
        // the callable is still going and still returns its result.
        console.error('AAP job listener failed', e)
      },
    )
  }

  const generate = generateAapRemarksRemote

  /**
   * Saving an edited comment approves it in the same write: someone who has
   * read the text closely enough to change it has reviewed it, and a separate
   * "now approve it" click would only be a way to forget.
   *
   * `updatedBy` is ours — the function stamps updatedAt but has no caller to
   * name. merge:true so a partial write can never drop the ratings.
   */
  async function saveComment(schoolId, studentId, subject, comment) {
    await setDoc(studentAapRemarkDoc(schoolId, studentId, subject), {
      comment,
      status: STATUS_APPROVED,
      updatedAt: serverTimestamp(),
      updatedBy: auth.currentUser?.email || 'unknown',
    }, { merge: true })
  }

  async function setStatus(schoolId, studentId, subject, status) {
    await setDoc(studentAapRemarkDoc(schoolId, studentId, subject), {
      status,
      updatedAt: serverTimestamp(),
      updatedBy: auth.currentUser?.email || 'unknown',
    }, { merge: true })
  }

  return {
    schools, classes, students, remarksByStudent,
    loadingSchools, loadingClasses, loadingRoster,
    loadSchools, loadClasses, loadClass, loadRemarks, reloadStudent,
    recentJobIds, watchNewJob, generate, saveComment, setStatus,
  }
}
