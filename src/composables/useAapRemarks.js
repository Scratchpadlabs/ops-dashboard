/**
 * AAP remarks (Awareness / Sensitivity / Creativity) — the client half.
 *
 * Generation is a Cloud Function (functions/generate_aap_remarks): it resolves
 * each student's Beginner/Proficient/Advanced level per subject from the AAP
 * survey responses, looks the descriptor text up in the shared `aap_framework`
 * collection, and writes ONE doc per student per subject to
 * schools/{id}/students/{sid}/aap_remarks/{subject}.
 *
 * Everything after generation — listing remarks, editing a comment, flipping
 * approved / needs_review, bulk status, and confirming a subject mapping —
 * is ALSO a callable (list_aap_remarks / update_aap_remark /
 * bulk_update_aap_remarks / save_aap_subject_mapping), not a direct Firestore
 * read/write. That is deliberate: it keeps this whole feature off the
 * firestore.rules surface entirely, the same way class_map/resets/archives
 * keep sensitive writes on the Admin SDK elsewhere in this repo. The one
 * exception is `aap_jobs` progress polling below, which needs no rule change
 * because it's a path the generic schools/{schoolId}/{collection}/{docId}
 * read rule already covers.
 *
 * The roster comes from `class_detail` (functions/assign_survey) rather than a
 * client query on currentClassId, deliberately: that callable already resolves
 * a class the way the rest of the dashboard does, including the schools whose
 * students key their class off a different field entirely (AUDIT.md §2.3). A
 * naive equality query here would quietly show an empty class for those.
 */
import { ref } from 'vue'
import { getDocs, query, orderBy, limit, onSnapshot } from 'firebase/firestore'

import { rootSchoolsCollection, schoolCollection, aapJobsCollection } from '../firebase/schoolCollections.js'
import { compareClassIds } from './useSurveys.js'
import {
  classDetailRemote, generateAapRemarksRemote, scanAapSubjectsRemote,
  listAapRemarksRemote, updateAapRemarkRemote, bulkUpdateAapRemarksRemote,
  saveAapSubjectMappingRemote, generateAapSummaryPdfRemote, generateAapSummaryPdfsRemote,
  downloadReport,
} from '../utils/api.js'

export const STATUS_APPROVED = 'approved'
export const STATUS_NEEDS_REVIEW = 'needs_review'

/** The three traits, in the order the function prompts with them. */
export const TRAITS = ['awareness', 'sensitivity', 'creativity']

/** Word window the generator is prompted to hit — shown while editing so a
 *  hand-written comment can be held to the same shape as a generated one. */
export const MIN_WORDS = 40
export const MAX_WORDS = 55

// Defined in utils/aapExport.js and re-exported here for the editor's word
// counter. It lives there so the export module has no Firebase import and can
// be checked by tools/check_aap_export.mjs.
export { countWords } from '../utils/aapExport.js'

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
   * One callable call for the whole roster — list_aap_remarks reads every
   * student's aap_remarks subcollection through the Admin SDK and returns
   * them keyed by student id, since the client has no rule path to any of
   * those docs itself.
   */
  async function loadRemarks(schoolId, studentIds) {
    if (!studentIds.length) return
    const byStudent = await listAapRemarksRemote({ schoolId, studentIds })
    remarksByStudent.value = { ...remarksByStudent.value, ...byStudent }
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
   * Saving an edited comment approves it in the same call: someone who has
   * read the text closely enough to change it has reviewed it, and a separate
   * "now approve it" click would only be a way to forget. `update_aap_remark`
   * stamps updatedAt/updatedBy server-side from the caller's verified auth.
   */
  async function saveComment(schoolId, studentId, subject, comment) {
    await updateAapRemarkRemote({ schoolId, studentId, subject, comment, status: STATUS_APPROVED })
  }

  async function setStatus(schoolId, studentId, subject, status) {
    await updateAapRemarkRemote({ schoolId, studentId, subject, status })
  }

  /**
   * Flip many remarks in one go. `targets` is [{ studentId, subject }].
   *
   * One callable call rather than a loop of writes: approving a 40-student
   * class across 7 subjects is 280 documents, and a partially-applied bulk
   * action is worse than one that didn't run — a reviewer would have no way
   * to tell which half went through. bulk_update_aap_remarks chunks its own
   * batches server-side for the same reason.
   */
  async function setStatusBulk(schoolId, targets, status) {
    await bulkUpdateAapRemarksRemote({ schoolId, targets, status })
    return targets.length
  }

  // ── Subjects ────────────────────────────────────────────────────────────
  const scan = ref(null)          // last scan_only result for the loaded class
  const scanning = ref(false)

  /**
   * What the survey actually says for this class, and which rubric row each
   * subject resolves to. Reads only — no model calls, no writes — so it is
   * safe to run before deciding whether a generation run is worth starting.
   */
  async function scanSubjects(schoolId, classId) {
    if (!schoolId || !classId) { scan.value = null; return null }
    scanning.value = true
    try {
      scan.value = await scanAapSubjectsRemote({ schoolId, classId })
      return scan.value
    } finally {
      scanning.value = false
    }
  }

  /**
   * Confirm that a survey's subject token means a particular rubric row.
   *
   * Global by decision: one confirmation resolves that spelling for every
   * school. Keyed by stage as well as token because "Science" is a different
   * rubric row in Middle than in Preparatory. Goes through
   * save_aap_subject_mapping (Admin SDK) rather than a direct write, so
   * `aap_subject_map` needs no firestore.rules entry.
   */
  async function saveSubjectMapping({ stage, token, frameworkSubject }) {
    await saveAapSubjectMappingRemote({ stage, token, frameworkSubject })
  }

  // ── Per-student summary PDF ────────────────────────────────────────────────
  async function downloadSummaryPdf(schoolId, studentId) {
    const report = await generateAapSummaryPdfRemote({ schoolId, studentId })
    downloadReport(report)
  }

  async function downloadSummaryPdfs(schoolId, studentIds) {
    const report = await generateAapSummaryPdfsRemote({ schoolId, studentIds })
    downloadReport(report)
  }

  return {
    schools, classes, students, remarksByStudent, scan, scanning,
    loadingSchools, loadingClasses, loadingRoster,
    loadSchools, loadClasses, loadClass, loadRemarks, reloadStudent,
    recentJobIds, watchNewJob, generate, saveComment, setStatus, setStatusBulk,
    scanSubjects, saveSubjectMapping, downloadSummaryPdf, downloadSummaryPdfs,
  }
}
