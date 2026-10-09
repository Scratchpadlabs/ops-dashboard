/**
 * Firestore reads/writes for the year-wrap service. Everything takes `db`
 * (an Admin SDK Firestore) so the HTTP layer stays thin.
 *
 * Reads are scoped the way class_detail scopes them in assign_survey: the
 * roster carries ids and class fields only, and answers are fetched per batch
 * of student ids, so payloads stay bounded by class size, not school size.
 */
import { AAM_SURVEY_IDS } from '../src/storyline/roster.mjs'

export const VIDEOS = 'year_wrap_videos'

// Mirrors is_inactive() in functions/assign_survey/survey_rules.py.
const INACTIVE = new Set(['inactive', 'left', 'tc', 'tc issued', 'dropped', 'dropout',
  'alumni', 'passed out', 'transferred', 'withdrawn'])
export function isInactive(doc) {
  if (doc?.isActive === false) return true
  return INACTIVE.has(String(doc?.enrollmentStatus || doc?.status || '').trim().toLowerCase())
}

// The fields src/utils/classResolver.js reads, so the dashboard can resolve
// classes exactly the way the rest of the app does.
const CLASS_FIELDS = ['classId', 'currentClassId', 'class_id', 'classID', 'classid', 'className', 'class_name',
  'grade', 'clazz', 'standard', 'std', 'class', 'Grade', 'Class', 'section', 'sec', 'division', 'div', 'Section']

const en = (v) => (v && typeof v === 'object' ? v.en ?? Object.values(v)[0] : v) ?? ''

/** Survey doc → just what the storyline engine reads, English only. */
export function slimSurvey(id, doc) {
  const ms = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis() : null)
  return {
    id,
    // The survey window says which academic year the answers belong to.
    startAt: ms(doc.startAt), expiresAt: ms(doc.expiresAt),
    questions: (doc.questions || []).map((q) => ({
      id: String(q.id), type: q.type || '', questionText: String(en(q.questionText)).trim(),
      answers: (q.answers || []).map((o) => ({ id: String(o.id), label: String(en(o.label)).trim() })),
    })),
  }
}

/**
 * AAM survey docs for a school. The mobile app files responses under the
 * survey's `id` field, not necessarily its doc id, so both are returned.
 */
export async function loadSurveys(db, schoolId) {
  const school = db.collection('schools').doc(schoolId)
  const snaps = await db.getAll(...AAM_SURVEY_IDS.map((id) => school.collection('surveys').doc(id)))
  const out = {}
  for (const s of snaps) {
    if (!s.exists) continue
    const data = s.data() || {}
    out[s.id] = { ...slimSurvey(s.id, data), responsesPath: `schools/${schoolId}/surveys/${data.id || s.id}/responses` }
  }
  return out
}

export async function roster(db, schoolId) {
  const schoolRef = db.collection('schools').doc(schoolId)
  const [schoolSnap, surveys, studentSnap] = await Promise.all([
    schoolRef.get(), loadSurveys(db, schoolId), schoolRef.collection('students').get(),
  ])
  if (!schoolSnap.exists) throw httpError(404, `No school ${schoolId}`)

  // Who has a response doc in each AAM survey — ids and status only.
  const responded = {}
  await Promise.all(Object.entries(surveys).map(async ([id, s]) => {
    const snap = await db.collection(s.responsesPath).select('status').get()
    responded[id] = snap.docs.map((d) => ({ id: d.id, submitted: d.get('status') === 'submitted' }))
  }))

  const students = []
  for (const d of studentSnap.docs) {
    const doc = d.data() || {}
    if (String(doc.type || 'student') !== 'student' || isInactive(doc)) continue
    const classFields = {}
    for (const f of CLASS_FIELDS) if (doc[f] !== undefined && doc[f] !== null && doc[f] !== '') classFields[f] = doc[f]
    students.push({ id: d.id, name: doc.name || [doc.firstName, doc.lastName].filter(Boolean).join(' '), firstName: doc.firstName || '', ...classFields })
  }

  const data = schoolSnap.data() || {}
  return {
    school: { id: schoolId, name: data.name || schoolId },
    surveys: Object.fromEntries(Object.entries(surveys).map(([id, { responsesPath, ...s }]) => [id, s])),
    responded,
    students,
  }
}

/** Full AAM responses + saved video state for up to 200 students. */
export async function answers(db, schoolId, studentIds) {
  const ids = [...new Set(studentIds || [])].map((x) => checkId(x, 'studentId'))
  if (!ids.length) return { responses: {}, videos: {} }
  if (ids.length > 200) throw httpError(400, 'At most 200 students per request')
  const surveys = await loadSurveys(db, schoolId)
  const responses = Object.fromEntries(ids.map((id) => [id, {}]))
  await Promise.all(Object.entries(surveys).map(async ([surveyId, s]) => {
    const snaps = await db.getAll(...ids.map((id) => db.doc(`${s.responsesPath}/${id}`)))
    for (const snap of snaps) {
      if (!snap.exists) continue
      const { answers: a = {}, status = '' } = snap.data() || {}
      responses[snap.id][surveyId] = { status, answers: a }
    }
  }))
  return { responses, videos: await videoDocs(db, schoolId, ids, { withStoryline: true }) }
}

export async function videoDocs(db, schoolId, ids, { withStoryline = false } = {}) {
  const col = db.collection('schools').doc(schoolId).collection(VIDEOS)
  ids?.forEach((id) => checkId(id, 'studentId'))
  const snaps = ids
    ? (ids.length ? await db.getAll(...ids.map((id) => col.doc(id))) : [])
    : (await col.get()).docs
  const out = {}
  for (const s of snaps) {
    if (!s.exists) continue
    // The storyline that was rendered stays in Firestore for audit, but
    // never rides along on a status poll.
    const { storyline, renderedStoryline, ...rest } = s.data() || {}
    out[s.id] = serialise(withStoryline && rest.edited ? { ...rest, storyline } : rest)
  }
  return out
}

/** Validates an incoming storyline enough that the renderer can't choke on it. */
export function checkStoryline(s) {
  if (!s || typeof s !== 'object') throw httpError(400, 'storyline missing')
  if (!['mid', 'prep'].includes(s.segment)) throw httpError(400, 'storyline.segment must be mid or prep')
  if (!Array.isArray(s.scenes) || !s.scenes.length) throw httpError(400, 'storyline has no scenes')
  if (JSON.stringify(s).length > 200_000) throw httpError(400, 'storyline too large')
  const total = s.scenes.reduce((n, x) => n + (Number(x?.durationInFrames) || 0), 0)
  if (total <= 0 || total > 30 * 180) throw httpError(400, 'storyline duration out of range')
  return { ...s, durationInFrames: total }
}

export async function saveEdit(db, schoolId, studentId, storyline, email, now) {
  checkId(studentId, 'studentId')
  const ref = db.collection('schools').doc(schoolId).collection(VIDEOS).doc(studentId)
  if (storyline === null) {
    await ref.set({ edited: false, storyline: null, editedBy: email, editedAt: now }, { merge: true })
  } else {
    await ref.set({ edited: true, storyline: checkStoryline(storyline), editedBy: email, editedAt: now }, { merge: true })
  }
}

// Timestamps → millis so the JSON is plain.
function serialise(obj) {
  const out = {}
  for (const [k, v] of Object.entries(obj)) out[k] = v && typeof v.toMillis === 'function' ? v.toMillis() : v
  return out
}

/** A Firestore doc id we're willing to put in a path: no slashes, no dots-only. */
export function checkId(id, what = 'id') {
  if (typeof id !== 'string' || !id || id.length > 300 || id.includes('/') || /^\.+$/.test(id)) throw httpError(400, `Invalid ${what}`)
  return id
}

export function httpError(status, message) {
  return Object.assign(new Error(message), { status })
}
