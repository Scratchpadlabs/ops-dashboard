/**
 * Surveys — day-to-day assignment operations.
 *
 * Reads are client-side (surveys, classes, and the student roster for the
 * pickers); every WRITE goes through the assign_survey Cloud Function, which
 * owns batching, progress and the audit log. Nothing here ever writes to a
 * survey document — this feature assigns, it does not edit surveys.
 */
import { ref, computed } from 'vue'
import { getDocs, query, orderBy, limit, onSnapshot } from 'firebase/firestore'
import {
  surveysCollection, schoolCollection, surveyAssignmentsCollection, surveyAssignmentDoc,
  rootSchoolsCollection,
} from '../firebase/schoolCollections.js'
import { assignSurveyRemote, surveyOverviewRemote } from '../utils/api.js'

// Mirrors functions/assign_survey/main.py's DEFAULT_INBOX_FIELD. Verified in
// the data model for students; assumed for staff (see that file's comment) —
// the preview reports how many targeted docs actually carry the field, which
// is what surfaces a wrong assumption before any write.
export const INBOX_FIELD = 'surveyInbox'

/**
 * The junk/test filter, mirroring is_real_survey() in the Cloud Function.
 *
 * The collection holds test docs (ids like 'zzzzzzzzzzzzzzzzzy1'..'y17').
 * Structural rather than an id blocklist: a real survey has at least one
 * non-empty name translation and a non-empty questions array. This only ever
 * hides — nothing is deleted, and the same doc stays visible to unassign if
 * an old script already pushed it into inboxes.
 */
export function isRealSurvey(s) {
  const hasName = s?.name && typeof s.name === 'object' &&
    Object.values(s.name).some(v => String(v || '').trim())
  return !!hasName && Array.isArray(s?.questions) && s.questions.length > 0
}

export function surveyLabel(s) {
  return s?.name?.en || s?.name?.mr || Object.values(s?.name || {}).find(Boolean) || s?.id || ''
}

/**
 * Whether a survey targets staff rather than students.
 *
 * There is no dedicated audience field on the survey docs, so this is a
 * best-effort read of the id/segment metadata (TEACHERAAM is the known
 * staff-facing one). It only ever seeds the dialog's default — the user
 * picks the audience explicitly and can override it, which is the behavior
 * the task asks for when the metadata can't answer.
 */
export function guessAudience(s) {
  const haystack = `${s?.id || ''} ${s?.segmentForInternalPurpose || ''}`.toLowerCase()
  return /teacher|staff/.test(haystack) ? 'staff' : 'students'
}

export function useSurveys() {
  const schools = ref([])
  const surveys = ref([])
  const classes = ref([])
  const students = ref([])
  const overview = ref(null)
  const loading = ref(false)
  const loadingRoster = ref(false)

  const visibleSurveys = ref([])
  const hiddenCount = ref(0)

  async function loadSchools() {
    const snap = await getDocs(query(rootSchoolsCollection(), orderBy('name'), limit(500)))
    schools.value = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(s => s.isActive !== false)
    return schools.value
  }

  async function loadSurveys(schoolId) {
    if (!schoolId) { surveys.value = []; visibleSurveys.value = []; hiddenCount.value = 0; return }
    loading.value = true
    try {
      const snap = await getDocs(surveysCollection(schoolId))
      surveys.value = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      visibleSurveys.value = surveys.value
        .filter(isRealSurvey)
        .sort((a, b) => surveyLabel(a).localeCompare(surveyLabel(b)))
      hiddenCount.value = surveys.value.length - visibleSurveys.value.length
    } finally {
      loading.value = false
    }
  }

  async function loadClasses(schoolId) {
    if (!schoolId) { classes.value = []; return }
    const snap = await getDocs(schoolCollection(schoolId, 'classes'))
    classes.value = snap.docs.map(d => ({ id: d.id, ...d.data() }))
  }

  /**
   * The roster, for the class counts and the specific-student picker.
   *
   * This is the one genuinely large client-side read (3000+ docs at the top
   * end), so it is loaded on demand when the dialog opens rather than with
   * the page. Assignment itself never depends on it — the Cloud Function
   * re-resolves targets server-side from the scope, so a stale or partial
   * roster here can't produce a wrong write.
   */
  async function loadRoster(schoolId) {
    if (!schoolId) { students.value = []; return }
    loadingRoster.value = true
    try {
      const snap = await getDocs(schoolCollection(schoolId, 'students'))
      students.value = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(s => (s.type || 'student') === 'student')
    } finally {
      loadingRoster.value = false
    }
  }

  const activeStudents = computed(() => students.value.filter(s => !isInactive(s)))

  const studentsByClass = computed(() => {
    const map = new Map()
    for (const s of activeStudents.value) {
      const key = s.classId || '(no class)'
      map.set(key, (map.get(key) || 0) + 1)
    }
    return map
  })

  async function loadOverview(schoolId) {
    overview.value = await surveyOverviewRemote({ schoolId, inboxField: INBOX_FIELD })
    return overview.value
  }

  async function loadRuns(schoolId) {
    const snap = await getDocs(query(surveyAssignmentsCollection(schoolId), orderBy('run_at', 'desc'), limit(25)))
    return snap.docs.map(d => ({ id: d.id, ...d.data() }))
  }

  // Preview and apply are the same call with dryRun flipped — see api.js.
  function preview(args) { return assignSurveyRemote({ ...args, dryRun: true, inboxField: INBOX_FIELD }) }
  function apply(args) { return assignSurveyRemote({ ...args, dryRun: false, inboxField: INBOX_FIELD }) }

  // Progress streams through the run doc the function updates per chunk,
  // rather than the UI polling the callable.
  function watchRun(schoolId, runId, cb) {
    return onSnapshot(surveyAssignmentDoc(schoolId, runId), snap => {
      cb(snap.exists() ? { id: snap.id, ...snap.data() } : null)
    })
  }

  return {
    schools, surveys, visibleSurveys, hiddenCount, classes, students, activeStudents,
    studentsByClass, overview, loading, loadingRoster,
    loadSchools, loadSurveys, loadClasses, loadRoster, loadOverview, loadRuns,
    preview, apply, watchRun,
  }
}

// Mirrors is_inactive() in functions/assign_survey/main.py: a record is
// active unless it explicitly says otherwise, so a roster that predates the
// flag isn't silently skipped in its entirety.
const INACTIVE_VALUES = new Set([
  'inactive', 'left', 'tc', 'tc issued', 'dropped', 'dropout',
  'alumni', 'passed out', 'transferred', 'withdrawn',
])
export function isInactive(doc) {
  if (doc?.isActive === false) return true
  const status = String(doc?.enrollmentStatus || doc?.status || '').trim().toLowerCase()
  return INACTIVE_VALUES.has(status)
}
