/**
 * School Material Import — client-side glue between Firebase Storage,
 * the process_import/commit_import Cloud Functions, and the
 * staging_imports Firestore tree.
 *
 * buildCommitPlan stays client-side (plain Firestore reads against
 * classes/subjects/staffs to classify each row as CREATE/UPDATE_CHANGED/
 * UPDATE_UNCHANGED/ERROR for the confirm dialog — same pattern as
 * SubjectsTab.vue's classifyImportRow). The actual write half, commitImport,
 * hands that plan to the commit_import callable (functions/generate_import/
 * main.py), which re-verifies req.auth + the ops-admin allowlist server-side
 * before writing.
 */
import {
  doc, getDocs, setDoc, updateDoc, writeBatch, onSnapshot, query, orderBy, limit,
  serverTimestamp,
} from 'firebase/firestore'
import { ref as storageRef, uploadBytes } from 'firebase/storage'
import { db, storage, auth } from '../firebase/config'
import {
  stagingImportsCollection, stagingImportDoc, stagingImportRowsCollection,
  schoolCollection, importAliasDoc,
} from '../firebase/schoolCollections.js'
import { startProcessImport, commitImportRemote } from '../utils/api.js'
import { classify, GRADE } from '../utils/educationKB.js'
import { normalizeSectionValue } from '../utils/classResolver.js'
import { validateDoc, formatErrors } from '../schemas/schoolSchema.js'
import { gradeOrder } from '../utils/structureInference.js'
import { parseMaxMarks, resolveBlueprintSubjects } from '../utils/assessmentImport.js'
import { isCoScholasticArea } from '../utils/assessmentHelpers.js'
import { validateCurrentClassId } from '../schemas/currentClassId.js'
import { mapImportRowToStudent } from '../schemas/studentMapping.js'
import { ensureStudentsSchema } from '../utils/schoolSetupHelpers.js'

// ── Grade normalization — delegates to the shared education knowledge base
// (src/utils/educationKB.js), which is seeded from the very same
// education_kb.json that functions/generate_import/education_kb.py reads.
// The review UI needs the same "does this row's class-section exist" answer
// the Cloud Function used when it raised the flag, and the only way to
// guarantee that is one shared vocabulary rather than two hand-synced
// roman-numeral tables (which is what this used to be). ─────────────────────
export function normalizeGrade(g) {
  const s = (g || '').trim()
  if (!s) return ''
  // expect: GRADE is correct here — every caller already knows this value
  // came from a grade column, the context that lets a bare 'V' read as 5.
  const r = classify(s, { expect: GRADE })
  return r.type === GRADE && r.canonical ? r.canonical : s.toUpperCase()
}
// Board tokens stripped, so a teacher row's "SCI_CBSE_A" resolves to the same
// class as the configured "SCI_A". One rule, shared with the Cloud Function's
// normalize_section and the wizard's class derivation.
export function normalizeSection(s) {
  return normalizeSectionValue(s)
}

function slugPart(s) {
  return (s || '').trim().replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '')
}

// Comparison key only, never a display value — mirrors functions/
// generate_import/main.py's canonicalize() exactly (lowercase, strip
// spaces/hyphens/dots), so a suggestion/alias resolved here and one applied
// server-side on the next import agree on what counts as "the same value".
export function canonicalize(s) {
  return (s || '').trim().toLowerCase().replace(/[\s\-.]+/g, '')
}

// ── Upload + kick off extraction ────────────────────────────────────────────
export async function uploadAndProcess(schoolId, entity, files, onProgress) {
  const jobRef = doc(stagingImportsCollection())
  const jobId = jobRef.id
  const uploaded = []

  for (const file of files) {
    onProgress?.({ stage: 'uploading', file: file.name })
    const path = `imports/${schoolId}/${jobId}/${file.name}`
    await uploadBytes(storageRef(storage, path), file)
    uploaded.push({ path, name: file.name })
  }

  await setDoc(jobRef, {
    school_id: schoolId, entity,
    source_files: uploaded.map(f => f.path),
    status: 'processing',
    created_by: auth.currentUser?.email || 'unknown',
    created_at: serverTimestamp(),
  })

  onProgress?.({ stage: 'extracting' })
  try {
    await startProcessImport({ schoolId, jobId, entity, files: uploaded })
  } catch (e) {
    // The Cloud Function updates its own job doc to 'failed' on any error it
    // catches — but if the request itself never reached it (network drop,
    // cold-start timeout), the job would otherwise sit at 'processing'
    // forever. Belt-and-braces: mark it failed here too.
    await setDoc(jobRef, { status: 'failed', error: e.message || String(e) }, { merge: true }).catch(() => {})
    throw e
  }
  return jobId
}

// ── Live listeners ───────────────────────────────────────────────────────────
export function listenJobs(schoolIdOrNull, cb) {
  return onSnapshot(query(stagingImportsCollection(), orderBy('created_at', 'desc'), limit(50)), (snap) => {
    const jobs = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    cb(schoolIdOrNull ? jobs.filter(j => j.school_id === schoolIdOrNull) : jobs)
  })
}

export function listenJob(jobId, cb) {
  return onSnapshot(stagingImportDoc(jobId), (snap) => cb(snap.exists() ? { id: snap.id, ...snap.data() } : null))
}

export function listenRows(jobId, cb) {
  return onSnapshot(stagingImportRowsCollection(jobId), (snap) => {
    const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    rows.sort((a, b) => parseInt(a.id, 10) - parseInt(b.id, 10))
    cb(rows)
  })
}

// ── Row edits ────────────────────────────────────────────────────────────────
export async function updateRowData(jobId, rowId, data) {
  await updateDoc(doc(db, 'staging_imports', jobId, 'rows', rowId), { data, edited: true })
}
export async function setRowExcluded(jobId, rowId, excluded) {
  await updateDoc(doc(db, 'staging_imports', jobId, 'rows', rowId), { excluded })
}

// ── School config lookups (shared by the commit planner) ───────────────────
async function loadClassLookup(schoolId) {
  const snap = await getDocs(schoolCollection(schoolId, 'classes'))
  const classLookup = new Map()
  const subjectsByClass = new Map()
  snap.docs.forEach(d => {
    const c = { id: d.id, ...d.data() }
    classLookup.set(`${normalizeGrade(c.clazz)}|${normalizeSection(c.section)}`, c.id)
    subjectsByClass.set(c.id, (c.subjects || []).map(s => s.subjectId).filter(Boolean))
  })
  return { classLookup, subjectsByClass }
}

/**
 * Why a (grade, section) missed classLookup, in words an operator can act on.
 *
 * "Class-section not configured for this school." was the entire message, on
 * every one of the rows, with no indication of what was looked for or what
 * exists — so a school whose Classes collection is simply empty looked exactly
 * like one section being misspelled. Both are common and the fixes are
 * completely different, so the message has to tell them apart.
 */
function describeClassMiss(classLookup, rawGrade, rawSection) {
  if (classLookup.size === 0) {
    return 'School Setup has no classes configured at all — set up the class structure before importing.'
  }
  const grade = normalizeGrade(rawGrade)
  const section = normalizeSection(rawSection)
  const sameGrade = [...classLookup.keys()]
    .filter(k => k.split('|')[0] === grade)
    .map(k => k.split('|')[1] || '(no section)')
  const looked = `looked for grade "${grade}" section "${section || '(none)'}"`
  return sameGrade.length
    ? `Class-section not configured — ${looked}. Grade "${grade}" has: ${sameGrade.sort().join(', ')}.`
    : `Class-section not configured — ${looked}, and grade "${grade}" has no classes at all in School Setup.`
}

async function loadSubjectLookup(schoolId) {
  const snap = await getDocs(schoolCollection(schoolId, 'subjects'))
  const subjectLookup = new Map() // `${normGrade}|${normName}` -> subjectId
  snap.docs.forEach(d => {
    const grade = d.id.includes('_') ? d.id.split('_')[0] : ''
    const name = (d.data().name || '').trim().toLowerCase()
    subjectLookup.set(`${normalizeGrade(grade)}|${name}`, d.id)
  })
  return subjectLookup
}

// ── Resolver dropdown options — for ImportReview.vue's per-field suggestion/
// unknown-value resolver, so Sid can pick the correct configured value
// directly instead of only accepting a fuzzy match. ─────────────────────────
export async function loadSectionsByGrade(schoolId) {
  const snap = await getDocs(schoolCollection(schoolId, 'classes'))
  const byGrade = new Map() // grade -> [display section, ...]
  snap.docs.forEach(d => {
    const c = d.data()
    const grade = normalizeGrade(c.clazz)
    const section = (c.section || '').trim()
    if (!section) return
    if (!byGrade.has(grade)) byGrade.set(grade, [])
    if (!byGrade.get(grade).includes(section)) byGrade.get(grade).push(section)
  })
  return byGrade
}

/**
 * grade -> [subjectId] for every subject configured in the Subjects tab.
 *
 * Backs the teacher-import default: a teacher row with a class but no subject
 * gets every subject of that grade. Separate from loadSubjectLookup (which is
 * keyed by name, for matching an explicit subject cell) because this one needs
 * the whole set for a grade, not a lookup by name.
 */
export async function loadSubjectIdsByGrade(schoolId, { scholasticOnly = false } = {}) {
  const snap = await getDocs(schoolCollection(schoolId, 'subjects'))
  const byGrade = new Map()
  snap.docs.forEach(d => {
    if (!d.id.includes('_')) return          // ungraded subject (e.g. "AAM")
    // Assessments are per-subject; a co-scholastic record misfiled into
    // `subjects` is a term-wide activity and must not collect assessments.
    if (scholasticOnly && isCoScholasticArea(d.data().area)) return
    const grade = normalizeGrade(d.id.split('_')[0])
    if (!grade) return
    if (!byGrade.has(grade)) byGrade.set(grade, [])
    if (!byGrade.get(grade).includes(d.id)) byGrade.get(grade).push(d.id)
  })
  for (const list of byGrade.values()) list.sort()
  return byGrade
}

export async function loadSubjectsByGrade(schoolId) {
  const snap = await getDocs(schoolCollection(schoolId, 'subjects'))
  const byGrade = new Map() // grade -> [display subject name, ...]
  snap.docs.forEach(d => {
    const s = d.data()
    const grade = normalizeGrade(d.id.includes('_') ? d.id.split('_')[0] : '')
    const name = (s.name || '').trim()
    if (!name) return
    if (!byGrade.has(grade)) byGrade.set(grade, [])
    if (!byGrade.get(grade).includes(name)) byGrade.get(grade).push(name)
  })
  return byGrade
}

// ── Suggestion / manual-mapping resolution ──────────────────────────────────
// Applies a chosen value (either the fuzzy suggestion or a manually-picked
// one — task explicitly treats both the same: "accepts a suggestion or
// manually maps a value") to one row: updates data[field], drops the
// suggestion and any flags for that field (they're resolved now), and writes
// the mapping to the global import_aliases collection so every future
// import — any school — auto-applies it via the Cloud Function's alias map.
export async function resolveFieldValue(jobId, row, field, chosenValue, aliasType) {
  const original = (row.suggestions || []).find(s => s.field === field)?.original
    ?? row.data[field]
  const newData = { ...row.data, [field]: chosenValue }
  const newSuggestions = (row.suggestions || []).filter(s => s.field !== field)
  const newFlags = (row.flags || []).filter(f => f.field !== field)

  await updateDoc(doc(db, 'staging_imports', jobId, 'rows', row.id), {
    data: newData, suggestions: newSuggestions, flags: newFlags, edited: true,
  })

  const canon = canonicalize(original)
  if (canon) {
    await setDoc(importAliasDoc(`${aliasType}_${canon}`), {
      type: aliasType, from: canon, to: chosenValue,
      updated_at: serverTimestamp(), updated_by: auth.currentUser?.email || 'unknown',
    }, { merge: true })
  }
}

// Batch version — "Accept-all-identical": every OTHER row in this job with
// the exact same pending suggestion/value for this field gets the same fix,
// in one set of batched writes. The alias itself only needs writing once.
export async function resolveFieldValueForAllMatching(jobId, rows, field, originalValue, chosenValue, aliasType) {
  const canon = canonicalize(originalValue)
  const matches = rows.filter(r => {
    const sugg = (r.suggestions || []).find(s => s.field === field)
    if (sugg) return canonicalize(sugg.original) === canon
    return canonicalize(r.data[field]) === canon && (r.flags || []).some(f => f.field === field)
  })

  for (let i = 0; i < matches.length; i += 450) {
    const batch = writeBatch(db)
    matches.slice(i, i + 450).forEach(r => {
      const newData = { ...r.data, [field]: chosenValue }
      const newSuggestions = (r.suggestions || []).filter(s => s.field !== field)
      const newFlags = (r.flags || []).filter(f => f.field !== field)
      batch.update(doc(db, 'staging_imports', jobId, 'rows', r.id), {
        data: newData, suggestions: newSuggestions, flags: newFlags, edited: true,
      })
    })
    await batch.commit()
  }

  if (canon) {
    await setDoc(importAliasDoc(`${aliasType}_${canon}`), {
      type: aliasType, from: canon, to: chosenValue,
      updated_at: serverTimestamp(), updated_by: auth.currentUser?.email || 'unknown',
    }, { merge: true })
  }
  return matches.length
}

async function loadStaffLookup(schoolId) {
  const snap = await getDocs(schoolCollection(schoolId, 'staffs'))
  const byEmail = new Map()
  const byName = new Map()
  const all = []
  snap.docs.forEach(d => {
    const s = { id: d.id, ...d.data() }
    all.push(s)
    if (s.email) byEmail.set(s.email.trim().toLowerCase(), s)
    if (s.name) byName.set(s.name.trim().toLowerCase(), s)
  })
  return { byEmail, byName, all }
}

// ── Commit planning — classify each staged row as CREATE / UPDATE_CHANGED /
// UPDATE_UNCHANGED / ERROR, mirroring CsvImportDialog's classifyRow pattern,
// so the confirm dialog can show accurate new/changed/unchanged counts
// before anything is written. ───────────────────────────────────────────────
export async function buildCommitPlan(job, rows, options = {}) {
  const schoolId = job.school_id
  const included = rows.filter(r => !r.excluded)

  if (job.entity === 'students') return buildStudentsPlan(schoolId, included)
  if (job.entity === 'teachers') return buildTeachersPlan(schoolId, included)
  if (job.entity === 'subjects') return buildSubjectsPlan(schoolId, included)
  if (job.entity === 'assessments') return buildAssessmentsPlan(schoolId, included, options.termId)
  throw new Error(`Unknown entity: ${job.entity}`)
}

/**
 * Existing docs come back with Firestore Timestamps while a freshly mapped
 * payload holds a Date, and `phoneNo` is a number on both sides. Comparing
 * those raw made every row read as UPDATE_CHANGED, so normalize to a
 * comparable primitive first.
 */
function comparable(v) {
  if (v === null || v === undefined) return ''
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (typeof v?.toDate === 'function') return v.toDate().toISOString().slice(0, 10)
  return typeof v === 'object' ? JSON.stringify(v) : String(v)
}

function fieldsEqual(a, b, keys) {
  return keys.every(k => comparable(a?.[k]) === comparable(b?.[k]))
}

async function buildStudentsPlan(schoolId, rows) {
  const { classLookup } = await loadClassLookup(schoolId)
  const classIds = Array.from(new Set(classLookup.values()))
  // One fetch for the whole existing roster instead of a getDoc per row —
  // matters at the 1000+ row scale imports are sized for.
  const existingSnap = await getDocs(schoolCollection(schoolId, 'students'))
  const existingById = new Map(existingSnap.docs.map(d => [d.id, d.data()]))
  const usedIds = new Map() // dedupe doc ids within this batch
  const items = []

  for (const row of rows) {
    const d = row.data
    if ((row.suggestions || []).length) {
      items.push({ row, status: 'SUGGESTION_PENDING', reason: 'Resolve suggested fixes before committing' })
      continue
    }
    const classId = classLookup.get(`${normalizeGrade(d.grade)}|${normalizeSection(d.section)}`)
    if (!classId) {
      items.push({ row, status: 'ERROR', reason: describeClassMiss(classLookup, d.grade, d.section) })
      continue
    }
    const base = slugPart(d.roll_no) || slugPart(d.student_name) || 'student'
    let docId = `${classId}_${base}`
    const dupeCount = (usedIds.get(docId) || 0) + 1
    usedIds.set(docId, dupeCount)
    if (dupeCount > 1) docId = `${docId}_${dupeCount}`

    // Mapped, not copied: source columns the student schema has no home for
    // are dropped and reported rather than written into fields nothing reads.
    const { payload, dropped, warnings } = mapImportRowToStudent(d, { classId })

    // The class value is the one field where live data is genuinely broken,
    // so it is checked on its own terms as well as by the schema.
    const classCheck = validateCurrentClassId(payload.currentClassId, { studentId: docId, classIds })
    if (!classCheck.ok) {
      items.push({ row, status: 'ERROR', reason: classCheck.message })
      continue
    }

    const check = validateDoc('students', payload)
    if (!check.ok) {
      items.push({ row, status: 'ERROR', reason: `Does not match the student schema — ${formatErrors(check.errors)}` })
      continue
    }

    const notes = [...warnings]
    if (classCheck.severity === 'warning') notes.push(classCheck.message)
    if (dropped.length) notes.push(`no field in the student schema for: ${dropped.join(', ')} — not saved`)

    const item = { row, docId, payload, notes, derived: { firstName: payload.firstName, lastName: payload.lastName } }
    const existing = existingById.get(docId)
    if (!existing) {
      items.push({ ...item, status: 'CREATE' })
    } else {
      const same = fieldsEqual(existing, payload, Object.keys(payload))
      items.push({ ...item, status: same ? 'UPDATE_UNCHANGED' : 'UPDATE_CHANGED' })
    }
  }
  return summarize('students', items)
}

async function buildTeachersPlan(schoolId, rows) {
  const { classLookup } = await loadClassLookup(schoolId)
  const subjectLookup = await loadSubjectLookup(schoolId)
  const subjectIdsByGrade = await loadSubjectIdsByGrade(schoolId)
  const { byEmail, byName } = await loadStaffLookup(schoolId)
  const items = []
  const pendingNewStaff = new Map() // name/email key -> synthetic staff record, so repeat rows for a not-yet-created teacher resolve to the same one

  for (const row of rows) {
    const d = row.data
    if ((row.suggestions || []).length) {
      items.push({ row, status: 'SUGGESTION_PENDING', reason: 'Resolve suggested fixes before committing' })
      continue
    }
    const classId = classLookup.get(`${normalizeGrade(d.grade)}|${normalizeSection(d.section)}`)
    const subject = (d.subject || '').replace(/\?$/, '').trim()
    if (!d.teacher_name?.trim()) {
      items.push({ row, status: 'ERROR', reason: 'Missing teacher name' })
      continue
    }
    if (!classId) {
      items.push({ row, status: 'ERROR', reason: describeClassMiss(classLookup, d.grade, d.section) })
      continue
    }
    const subjectId = subject ? subjectLookup.get(`${normalizeGrade(d.grade)}|${subject.toLowerCase()}`) : null
    if (subject && !subjectId) {
      items.push({ row, status: 'ERROR', reason: `Subject "${subject}" not found in this school's Subjects list.` })
      continue
    }

    // No subject cell, but a real class: default to every subject configured
    // for that grade rather than leaving the teacher with none. This is an
    // INFERENCE, not something the file said — subjectsInferred marks it so the
    // review screen can show it separately from an explicit subject list.
    // Schools with subject specialists (common from Grade VI up) need to
    // correct these, which is only possible if they are visibly distinct.
    const gradeSubjectIds = subjectIdsByGrade.get(normalizeGrade(d.grade)) || []
    const subjectsInferred = !subject && gradeSubjectIds.length > 0
    const subjectIds = subject ? [subjectId] : gradeSubjectIds
    const inferenceNote = subjectsInferred
      ? `subjects inferred from class assignment — verify (${gradeSubjectIds.length} subject(s) of grade ${d.grade})`
      : (!subject && !gradeSubjectIds.length
          ? `no subjects configured for grade ${d.grade} — assign manually in Classes & Teachers`
          : '')

    const emailKey = (d.email || '').trim().toLowerCase()
    const nameKey = (d.teacher_name || '').trim().toLowerCase()
    let staff = (emailKey && byEmail.get(emailKey)) || byName.get(nameKey)
    let isNewStaff = false
    if (!staff) {
      const pendingKey = emailKey || nameKey
      staff = pendingNewStaff.get(pendingKey)
      if (!staff) {
        staff = {
          id: slugPart(d.teacher_name) || `teacher_${pendingNewStaff.size + 1}`,
          name: d.teacher_name.trim(), email: d.email || '', type: 'teacher',
          assignments: {}, classIds: [], needsAuthCreation: true, authUid: null,
        }
        pendingNewStaff.set(pendingKey, staff)
      }
      isNewStaff = true
    }

    items.push({
      row, status: isNewStaff ? 'CREATE' : (subjectIds.length ? 'UPDATE_CHANGED' : 'UPDATE_UNCHANGED'),
      staffId: staff.id, staffIsNew: isNewStaff, classId,
      // subjectId kept for the single explicit case; subjectIds is what the
      // commit actually writes.
      subjectId, subjectIds, subjectsInferred,
      notes: inferenceNote ? [inferenceNote] : [],
      classTeacherOf: d.class_teacher_of || '',
      staffBase: staff,
    })
  }

  // Re-derive real UPDATE_CHANGED / UPDATE_UNCHANGED for existing staff by
  // checking whether every (classId, subjectId) pair is already assigned.
  // Unchanged only when the assignment adds nothing new.
  for (const item of items) {
    if (item.status === 'ERROR' || item.staffIsNew) continue
    const existing = new Set(item.staffBase.assignments?.[item.classId] || [])
    const adds = (item.subjectIds || []).filter(Boolean)
    item.status = adds.length && adds.every(id => existing.has(id))
      ? 'UPDATE_UNCHANGED' : 'UPDATE_CHANGED'
  }

  return summarize('teachers', items)
}

async function buildSubjectsPlan(schoolId, rows) {
  const snap = await getDocs(schoolCollection(schoolId, 'subjects'))
  const existingById = new Map(snap.docs.map(d => [d.id, d.data()]))
  const items = []
  for (const row of rows) {
    const d = row.data
    if ((row.suggestions || []).length) {
      items.push({ row, status: 'SUGGESTION_PENDING', reason: 'Resolve suggested fixes before committing' })
      continue
    }
    const grade = (d.grade_band || d.stream || '').trim()
    const name = (d.subject || '').trim()
    if (!name) { items.push({ row, status: 'ERROR', reason: 'Missing subject name' }); continue }
    const docId = `${slugPart(grade) || 'UNSPECIFIED'}_${slugPart(name)}`
    const payload = { name, area: d.area || '' }
    const existing = existingById.get(docId)
    if (!existing) items.push({ row, status: 'CREATE', docId, payload })
    else items.push({ row, status: fieldsEqual(existing, payload, ['name', 'area']) ? 'UPDATE_UNCHANGED' : 'UPDATE_CHANGED', docId, payload })
  }
  return summarize('subjects', items)
}

/**
 * Exam-blueprint rows -> assessment documents.
 *
 * Assessments are the one entity where the extractor's schema (an exam
 * blueprint: syllabus coverage, instructional days, activity weighting) does
 * not map cleanly onto the live one (name/termId/subjectId/order/entryType/
 * maxMarks/gradingScaleId/conversion*). Assessments are scoped to a Term the
 * import cannot know, so `termId` comes from the review screen's Select; the
 * blueprint's scheduling and syllabus columns have no field on an assessment
 * and are reported per row rather than written into fields nothing reads.
 *
 * A blueprint row is grade-band-wide, not per-subject, so ONE row becomes one
 * assessment per subject of that band (see resolveBlueprintSubjects). It used
 * to be matched to a subject by its own NAME, which is why the committed
 * assessments came out named after subjects, and its maxMarks came from a
 * digit-strip that read "80 (40+40)" as 804040. Both are fixed in
 * utils/assessmentImport.js; this function's job is to turn the result into
 * schema-valid documents and to say plainly, per row, what it did.
 */
async function buildAssessmentsPlan(schoolId, rows, termId) {
  const subjectLookup = await loadSubjectLookup(schoolId)
  const subjectIdsByGrade = await loadSubjectIdsByGrade(schoolId, { scholasticOnly: true })
  // Grade bands are resolved against the grades this school HAS, in real grade
  // order — "Nursery-II" has to work the same as "III-V".
  const knownGrades = Array.from(subjectIdsByGrade.keys()).sort((a, b) => gradeOrder(a) - gradeOrder(b))
  const orderedByGrade = new Map(knownGrades.map(g => [g, subjectIdsByGrade.get(g)]))

  const existingSnap = await getDocs(schoolCollection(schoolId, 'assessments'))
  const existingById = new Map(existingSnap.docs.map(d => [d.id, d.data()]))

  // `order` sequences within (subjectId, termId) and continues after whatever
  // that pair already has — every row used to be written with order: 1, which
  // left the teacher app sorting arbitrarily.
  const nextOrder = new Map()
  for (const [, a] of existingById) {
    const key = `${a.subjectId}|${a.termId}`
    nextOrder.set(key, Math.max(nextOrder.get(key) || 0, (a.order || 0) + 1))
  }

  const items = []
  const seenDocIds = new Set()
  for (const row of rows) {
    const d = row.data
    if ((row.suggestions || []).length) {
      items.push({ row, status: 'SUGGESTION_PENDING', reason: 'Resolve suggested fixes before committing' })
      continue
    }
    const name = (d.assessment || '').trim()
    if (!name) { items.push({ row, status: 'ERROR', reason: 'Missing assessment name' }); continue }
    if (!termId) { items.push({ row, status: 'ERROR', reason: 'Select a Term to commit assessments into.' }); continue }

    const { maxMarks, source, notes: markNotes } = parseMaxMarks(d)
    if (maxMarks === null) {
      items.push({ row, status: 'ERROR', reason: 'No usable marks in total / max_written / activity_weight — the assessment has no maximum to mark against' })
      continue
    }

    const { subjectIds, reason } = resolveBlueprintSubjects(d, {
      normalizeGrade, subjectsByGrade: orderedByGrade, subjectLookup,
    })
    if (!subjectIds.length) {
      items.push({ row, status: 'ERROR', reason: `Could not decide which subjects this row covers — ${reason}` })
      continue
    }

    // Notes are written once per ROW, in wording that does not vary across the
    // fan-out, so the commit dialog's dedupe collapses a 60-subject fan-out
    // into one line instead of burying the marks warnings under 60 of them.
    const rowNotes = [
      `${name}: ${subjectIds.length} assessment(s) — ${reason}`,
      `maxMarks ${maxMarks} from ${source}`,
      ...markNotes,
    ]
    // A blueprint carries scheduling and syllabus detail the assessment schema
    // has no field for. Reported rather than written into fields nothing reads
    // — same rule as the student import.
    const carried = ['date_start', 'date_end', 'instructional_days', 'syllabus_covered',
                     'exam_syllabus', 'duration'].filter(k => String(d[k] ?? '').trim())
    if (carried.length) rowNotes.push(`not saved (no field on an assessment): ${carried.join(', ')}`)

    // One row, one document per subject it covers.
    for (const subjectId of subjectIds) {
      const key = `${subjectId}|${termId}`
      const order = nextOrder.get(key) || 1
      nextOrder.set(key, order + 1)
      const docId = `${subjectId}_${termId}_${slugPart(name)}`
      const payload = {
        name, termId, subjectId, order,
        entryType: 'marks',
        maxMarks,
        gradingScaleId: null,
        // Required by the schema and by the teacher app's mark conversion.
        // A blueprint file never states these, so they take the neutral
        // values; change them per assessment in the Assessments tab.
        conversionType: 'none',
        conversionFactor: null,
      }

      const check = validateDoc('assessments', payload)
      if (!check.ok) {
        items.push({ row, status: 'ERROR', reason: `Does not match the assessment schema — ${formatErrors(check.errors)}` })
        continue
      }

      // Two rows in one file naming the same assessment for the same subject
      // would write the same doc twice; report it instead of letting the last
      // one win silently.
      if (seenDocIds.has(docId)) {
        items.push({ row, status: 'ERROR', reason: `"${name}" appears twice for ${subjectId} in this file — the second row would overwrite the first` })
        continue
      }
      seenDocIds.add(docId)

      const existing = existingById.get(docId)
      if (!existing) {
        items.push({ row, status: 'CREATE', docId, payload, notes: rowNotes })
      } else {
        // An assessment that already exists keeps the order it was given —
        // re-importing a blueprint must not reshuffle what the teacher app
        // shows. `order` is therefore also excluded from the change
        // comparison, or every re-import would read as changed.
        payload.order = existing.order || order
        const same = fieldsEqual(existing, payload, Object.keys(payload).filter(k => k !== 'order'))
        items.push({ row, docId, payload, notes: rowNotes, status: same ? 'UPDATE_UNCHANGED' : 'UPDATE_CHANGED' })
      }
    }
  }
  return summarize('assessments', items)
}

function summarize(entity, items) {
  // autoFixed isn't its own status — a row can be CREATE/CHANGED/UNCHANGED
  // *and* carry auto-fixes; it's counted separately so the confirm dialog can
  // show "N committing, of which M were auto-fixed" rather than hiding that
  // the data was touched. suggestionsPending and errors are real, mutually
  // exclusive statuses that both block commit but for different reasons —
  // task requires distinguishing them, not collapsing both into "errors".
  const committable = i => i.status === 'CREATE' || i.status === 'UPDATE_CHANGED' || i.status === 'UPDATE_UNCHANGED'
  const summary = {
    total: items.length,
    create: items.filter(i => i.status === 'CREATE').length,
    changed: items.filter(i => i.status === 'UPDATE_CHANGED').length,
    unchanged: items.filter(i => i.status === 'UPDATE_UNCHANGED').length,
    autoFixed: items.filter(i => committable(i) && (i.row?.fixes || []).length > 0).length,
    suggestionsPending: items.filter(i => i.status === 'SUGGESTION_PENDING').length,
    errors: items.filter(i => i.status === 'ERROR').length,
  }
  return { entity, items, summary }
}

// ── Commit — hands the plan to the commit_import callable, which performs
// the actual writes into schools/{schoolId}/... server-side (re-verifying
// req.auth + the ops-admin allowlist there) honoring the overwrite-existing
// gate on changed records. Trimmed to just what the callable needs to write;
// `row`/`reason`/error/pending-suggestion items aren't sent since they carry
// nothing writable (a pending suggestion means the row isn't resolved yet —
// never commit its unresolved original value). ─────────────────────────────
export async function commitImport(job, plan, { overwriteExisting } = {}) {
  const nonError = plan.items.filter(i => i.status !== 'ERROR' && i.status !== 'SUGGESTION_PENDING')

  const items = plan.entity === 'teachers'
    ? nonError.map(i => ({
        status: i.status, staffId: i.staffId, staffIsNew: i.staffIsNew,
        classId: i.classId, subjectId: i.subjectId, subjectIds: i.subjectIds || [],
        subjectsInferred: !!i.subjectsInferred,
        staffBase: { name: i.staffBase?.name || '', email: i.staffBase?.email || '' },
      }))
    : nonError.map(i => ({ status: i.status, docId: i.docId, payload: i.payload }))

  const result = await commitImportRemote({
    schoolId: job.school_id, jobId: job.id, entity: plan.entity,
    items, overwriteExisting: !!overwriteExisting,
  })

  // A roster the app can't display isn't imported. config/students_schema is
  // what renders the student table, and a wizard-created school has none — so
  // it is created (or brought up to date with the columns this import just
  // wrote) as part of committing, not left for someone to notice later.
  // Never fatal: the rows are already written, and the hygiene panel offers
  // the same repair.
  if (plan.entity === 'students' && result.written) {
    try {
      const classesSnap = await getDocs(schoolCollection(job.school_id, 'classes'))
      await ensureStudentsSchema(job.school_id, classesSnap.docs.map(d => d.id))
    } catch (e) {
      console.error('Could not refresh config/students_schema after the import', e)
    }
  }

  return { written: result.written, skipped: plan.items.length - result.written }
}
