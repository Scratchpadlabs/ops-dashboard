/**
 * Year-wrap videos: roster → per-class storylines → render queue status.
 *
 * Storylines are built HERE, in the browser, with the same engine the
 * renderer's samples and tests use (video/src/storyline), so what ops review
 * and edit is exactly what gets rendered — the service receives the finished
 * storyline and never re-derives it.
 */
import { ref, computed } from 'vue'
import { buildStoryline } from '../../video/src/storyline/buildStoryline.mjs'
import { segmentFor, storyInput } from '../../video/src/storyline/roster.mjs'
import { SEGMENTS } from '../../video/src/storyline/questions.mjs'
import { buildSchoolContext, compareClasses, rawClassValue, resolveClass } from '../utils/classResolver.js'
import {
  yearWrapAnswers, yearWrapCancel, yearWrapRender, yearWrapRoster, yearWrapSave, yearWrapStatus,
} from '../utils/yearWrapApi.js'

export const NO_CLASS = '(no class)'
const STALE_MS = 30 * 60 * 1000 // mirrors server/jobs.mjs

export const SEGMENT_LABELS = { prep: 'Preparatory', mid: 'Middle' }

/** Academic year (April–March) a survey window opened in: Oct 2025 → "2025-26". */
export function academicYearOf(millis) {
  if (!millis) return null
  const d = new Date(millis)
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1
  return `${y}-${String(y + 1).slice(-2)}`
}

/** queued/rendering for longer than the service could still be working on it. */
export function videoState(v, now = Date.now()) {
  if (!v?.status) return 'none'
  if ((v.status === 'queued' || v.status === 'rendering') && now - (v.startedAt || v.queuedAt || now) > STALE_MS) return 'stale'
  return v.status
}

export function useYearWrap() {
  const school = ref(null)
  const surveys = ref({})
  const students = ref([])          // whole school, light
  const classRows = ref([])         // one class, with storylines
  const videos = ref({})            // studentId → video doc
  const loadingRoster = ref(false)
  const loadingClass = ref(false)
  let currentSchoolId = null
  let pollTimer = null

  async function loadRoster(schoolId) {
    stopPolling()
    currentSchoolId = schoolId
    students.value = []; classRows.value = []; videos.value = {}
    if (!schoolId) return
    loadingRoster.value = true
    try {
      const r = await yearWrapRoster({ schoolId })
      if (currentSchoolId !== schoolId) return
      school.value = r.school
      surveys.value = r.surveys
      const respondedIn = {}
      const submitted = {}
      for (const [surveyId, list] of Object.entries(r.responded)) {
        for (const x of list) {
          ;(respondedIn[x.id] ||= []).push(surveyId)
          if (x.submitted) (submitted[x.id] ||= new Set()).add(surveyId)
        }
      }
      const ctx = buildSchoolContext([...new Set(r.students.map((s) => rawClassValue(s)[0]).filter(Boolean))])
      students.value = r.students.map((s) => {
        const resolved = resolveClass(s, ctx)
        const classId = resolved.canonicalClassId && !resolved.canonicalClassId.startsWith('__') ? resolved.canonicalClassId : (rawClassValue(s)[0] || NO_CLASS)
        const segment = segmentFor({ respondedIn: respondedIn[s.id] || [], gradeOrdinal: resolved.gradeOrdinal })
        const ids = segment ? SEGMENTS[segment].surveys : null
        return {
          ...s, classId, segment,
          aam1: ids ? (respondedIn[s.id] || []).includes(ids.start) : false,
          aam2: ids ? (respondedIn[s.id] || []).includes(ids.end) : false,
          aam1Submitted: ids ? !!submitted[s.id]?.has(ids.start) : false,
          aam2Submitted: ids ? !!submitted[s.id]?.has(ids.end) : false,
        }
      }).filter((s) => s.segment)
    } finally {
      loadingRoster.value = false
    }
  }

  // The year the AAM answers are from — earliest AAM1 window — which is
  // not necessarily the current year: wraps are made after the year ends.
  const surveyYear = computed(() => {
    const starts = Object.entries(surveys.value).filter(([id]) => id.startsWith('AAM1')).map(([, s]) => s.startAt).filter(Boolean)
    return starts.length ? academicYearOf(Math.min(...starts)) : null
  })

  const classes = computed(() => {
    const by = {}
    for (const s of students.value) {
      const c = (by[s.classId] ||= { classId: s.classId, total: 0, withData: 0, segment: s.segment })
      c.total++
      if (s.aam1 || s.aam2) c.withData++
    }
    return Object.values(by).sort((a, b) => compareClasses(a.classId, b.classId))
  })

  async function loadClass(classId, academicYear) {
    classRows.value = []
    if (!currentSchoolId || !classId) return
    const schoolId = currentSchoolId
    const members = students.value.filter((s) => s.classId === classId)
      .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    loadingClass.value = true
    try {
      const responses = {}
      const saved = {}
      for (let i = 0; i < members.length; i += 200) {
        const r = await yearWrapAnswers({ schoolId, studentIds: members.slice(i, i + 200).map((s) => s.id) })
        Object.assign(responses, r.responses)
        Object.assign(saved, r.videos)
      }
      if (currentSchoolId !== schoolId) return
      videos.value = { ...videos.value, ...saved }
      classRows.value = members.map((s) => {
        const auto = buildStoryline(storyInput({
          segment: s.segment,
          student: { id: s.id, name: s.name, firstName: s.firstName, className: s.classId },
          school: school.value, academicYear, surveys: surveys.value, responses: responses[s.id] || {},
        }))
        const edited = saved[s.id]?.edited && saved[s.id]?.storyline ? saved[s.id].storyline : null
        return { ...s, auto, edited, storyline: edited || auto }
      })
      if (members.some((s) => ['queued', 'rendering'].includes(videos.value[s.id]?.status))) startPolling()
    } finally {
      loadingClass.value = false
    }
  }

  async function saveEdit(studentId, storyline) {
    await yearWrapSave({ schoolId: currentSchoolId, studentId, storyline })
    classRows.value = classRows.value.map((r) => (r.id === studentId
      ? { ...r, edited: storyline, storyline: storyline || r.auto }
      : r))
  }

  async function render(rows, academicYear) {
    const items = rows.filter((r) => r.storyline?.renderable).map((r) => ({ studentId: r.id, storyline: r.storyline }))
    if (!items.length) return { queued: 0 }
    const res = await yearWrapRender({ schoolId: currentSchoolId, academicYear, items })
    const now = Date.now()
    const next = { ...videos.value }
    for (const it of items) next[it.studentId] = { ...(next[it.studentId] || {}), status: 'queued', progress: 0, queuedAt: now, error: null }
    videos.value = next
    startPolling()
    return res
  }

  async function cancel() {
    const res = await yearWrapCancel({ schoolId: currentSchoolId })
    await refreshStatus()
    return res
  }

  async function refreshStatus() {
    const ids = classRows.value.map((r) => r.id)
    if (!currentSchoolId || !ids.length) return
    const r = await yearWrapStatus({ schoolId: currentSchoolId, studentIds: ids })
    videos.value = { ...videos.value, ...r.videos }
    const active = ids.some((id) => ['queued', 'rendering'].includes(videoState(videos.value[id])))
    if (!active) stopPolling()
  }

  // Polled rather than onSnapshot: the live rules for the teacher-app tree
  // aren't the ones in this repo (see firestore.rules), and a poll through
  // the service works whatever they say. Only runs while something renders.
  function startPolling() {
    if (pollTimer) return
    pollTimer = setInterval(() => refreshStatus().catch(() => {}), 4000)
  }
  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = null
  }

  return {
    school, students, classes, surveyYear, classRows, videos, loadingRoster, loadingClass,
    loadRoster, loadClass, saveEdit, render, cancel, refreshStatus, stopPolling,
  }
}
