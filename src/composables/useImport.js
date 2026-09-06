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
  schoolCollection, importAliasDoc, rootSchoolsCollection,
} from '../firebase/schoolCollections.js'
import { startProcessImport, commitImportRemote, getImportTemplateRemote } from '../utils/api.js'
import { classify, GRADE } from '../utils/educationKB.js'
import { normalizeSectionValue } from '../utils/classResolver.js'
import { validateDoc, formatErrors } from '../schemas/schoolSchema.js'
import { validateCurrentClassId } from '../schemas/currentClassId.js'
import { mapImportRowToStudent } from '../schemas/studentMapping.js'

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
export async function loadSubjectIdsByGrade(schoolId) {
  const snap = await getDocs(schoolCollection(schoolId, 'subjects'))
  const byGrade = new Map()
  snap.docs.forEach(d => {
    if (!d.id.includes('_')) return          // ungraded subject (e.g. "AAM")
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

  if (job.entity === 'students') return buildStudentsPlan(schoolId, included, { fieldsToWrite: options.fieldsToWrite })
  if (job.entity === 'teachers') return buildTeachersPlan(schoolId, included)
  if (job.entity === 'subjects') return buildSubjectsPlan(schoolId, included)
  if (job.entity === 'assessments') return buildAssessmentsPlan(schoolId, included, options.termId)
  return buildGenericTemplatePlan(schoolId, included, job.entity)
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

// Which student fields a commit is allowed to touch, for the "which fields do
// you actually want to update" step in ImportReview.vue. classPlacement is
// its own group, checked on by default same as every other — unchecking it is
// what lets an import update an EXISTING student (matched by externalId,
// below) without moving them to whatever class the file happens to say.
// A brand-new student ignores this entirely — there is no live document for
// a merge write to preserve anything on, so creating one always needs every
// field, classPlacement included.
// `sourceKeys` are the extractor's OWN field names (row.data.*, before
// mapImportRowToStudent derives anything) — what ImportReview.vue checks to
// decide whether a group is worth showing at all, since a group the file
// never carried has nothing to protect and nothing to write either way.
export const STUDENT_UPDATE_FIELD_GROUPS = [
  { key: 'classPlacement', label: 'Class placement (Grade / Section)',
    payloadKeys: ['currentClassId'], sourceKeys: ['grade', 'section', 'combined_class'] },
  { key: 'name', label: 'Name', payloadKeys: ['name', 'firstName', 'lastName'], sourceKeys: ['student_name'] },
  { key: 'gender', label: 'Gender', payloadKeys: ['gender'], sourceKeys: ['gender'] },
  { key: 'dob', label: 'Date of birth', payloadKeys: ['dateOfBirth'], sourceKeys: ['dob'] },
  { key: 'contact', label: 'Contact number', payloadKeys: ['phoneNo'], sourceKeys: ['contact'] },
  { key: 'email', label: 'Email', payloadKeys: ['email'], sourceKeys: ['email'] },
  { key: 'registers', label: 'Admission No / GR-EMIS-STS',
    payloadKeys: ['admNo', 'grEmisSts'], sourceKeys: ['adm_no', 'gr_emis_sts'] },
  { key: 'aadhaar', label: 'Aadhaar', payloadKeys: ['aadhaarNumber'], sourceKeys: ['aadhaar'] },
]

function isBlankValue(v) {
  if (v === null || v === undefined) return true
  if (v instanceof Date || typeof v === 'number') return false
  return String(v).trim() === ''
}

// For ImportReview.vue: only the groups this file actually carries data for —
// a group with nothing in ANY row has nothing to update and nothing to
// protect, so there is no reason to offer a checkbox for it at all.
export function studentFieldGroupsWithData(rows) {
  return STUDENT_UPDATE_FIELD_GROUPS.filter(g =>
    (rows || []).some(r => g.sourceKeys.some(k => !isBlankValue(r.data?.[k]))))
}

// `selectedGroupKeys` null/undefined means "no restriction" (every group, the
// pre-existing default) — a Set of STUDENT_UPDATE_FIELD_GROUPS keys otherwise.
function expandFieldGroups(selectedGroupKeys) {
  if (!selectedGroupKeys) return null
  const keys = new Set()
  for (const group of STUDENT_UPDATE_FIELD_GROUPS) {
    if (selectedGroupKeys.has(group.key)) group.payloadKeys.forEach(k => keys.add(k))
  }
  return keys
}

// Keeps only keys that are both selected AND actually carry a value on THIS
// row. The second part matters as much as the first: a field the file never
// gave this particular row a value for must never be written as blank onto
// an existing student — that would silently erase whatever was already
// there, not "leave it alone" as a deselected/absent field is supposed to.
function pick(obj, keys) {
  const out = {}
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, k) && !isBlankValue(obj[k])) out[k] = obj[k]
  }
  return out
}

async function buildStudentsPlan(schoolId, rows, { fieldsToWrite } = {}) {
  const selectedKeys = expandFieldGroups(fieldsToWrite) // Set|null
  const writeClassPlacement = !selectedKeys || selectedKeys.has('currentClassId')

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

    // A school's own stable student code, if the file carries one, IS the
    // doc id and is looked up directly — no class needed to find the row's
    // existing document at all. Without one, identity is still class + roll/
    // name, same as before externalId existed.
    const externalId = String(d.external_id ?? '').trim()
    let docId = externalId || null
    let existing = docId ? existingById.get(docId) : undefined

    // A brand-new student has no live document for a merge write to leave
    // anything on, so creating one always needs a real, resolved class —
    // regardless of what this run's field selection says. An existing match
    // only needs one resolved when class placement is itself selected.
    const needsClass = !existing || writeClassPlacement
    let classId = null
    if (needsClass) {
      classId = classLookup.get(`${normalizeGrade(d.grade)}|${normalizeSection(d.section)}`)
      if (!classId) {
        items.push({ row, status: 'ERROR', reason: describeClassMiss(classLookup, d.grade, d.section) })
        continue
      }
    }

    if (!docId) {
      const base = slugPart(d.roll_no) || slugPart(d.student_name) || 'student'
      docId = `${classId}_${base}`
      const dupeCount = (usedIds.get(docId) || 0) + 1
      usedIds.set(docId, dupeCount)
      if (dupeCount > 1) docId = `${docId}_${dupeCount}`
      existing = existingById.get(docId)
    }

    // Mapped, not copied: source columns the student schema has no home for
    // are dropped and reported rather than written into fields nothing reads.
    const { payload: fullPayload, dropped, warnings } = mapImportRowToStudent(d, {
      classId, includeClassId: needsClass,
    })

    const notes = [...warnings]
    if (needsClass) {
      // The class value is the one field where live data is genuinely
      // broken, so it is checked on its own terms as well as by the schema.
      const classCheck = validateCurrentClassId(fullPayload.currentClassId, { studentId: docId, classIds })
      if (!classCheck.ok) {
        items.push({ row, status: 'ERROR', reason: classCheck.message })
        continue
      }
      if (classCheck.severity === 'warning') notes.push(classCheck.message)
    } else if (d.grade || d.section || d.combined_class) {
      notes.push('Grade/Section in the file were not applied — class placement is excluded from this import')
    }
    if (dropped.length) notes.push(`no field in the student schema for: ${dropped.join(', ')} — not saved`)

    // CREATE always writes every derivable field, blanks included — there is
    // nothing on a brand-new document yet for blank-protection to protect.
    // An UPDATE always goes through pick(), selection restriction or not:
    // blank-value skipping must apply unconditionally, or a field the file
    // simply has no data for this row would silently erase whatever an
    // existing student already had recorded.
    const isCreate = !existing
    const payload = isCreate ? fullPayload : pick(fullPayload, selectedKeys || Object.keys(fullPayload))

    const check = validateDoc('students', payload, { partial: !isCreate })
    if (!check.ok) {
      items.push({ row, status: 'ERROR', reason: `Does not match the student schema — ${formatErrors(check.errors)}` })
      continue
    }

    const item = { row, docId, payload, notes, derived: { firstName: fullPayload.firstName, lastName: fullPayload.lastName } }
    if (isCreate) {
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

// Curricular goals for a brand-new subject aren't typed by hand — they're the
// same goal set another school already keeps for the same grade + subject
// (e.g. Grade III English). Every other school's subjects collection is
// scanned once per plan build and indexed by that grade|name key, then a new
// subject row is auto-filled from it. Only CREATE rows are touched — an
// existing subject's own curricular_goals are never overwritten by import.
export async function loadGoalsLibrary(schoolId) {
  const goalsByKey = new Map() // `${normGrade}|${normName}` -> curricular_goals
  try {
    const schoolsSnap = await getDocs(rootSchoolsCollection())
    const otherSchoolIds = schoolsSnap.docs.map(d => d.id).filter(id => id !== schoolId)
    const subjectSnaps = await Promise.all(
      otherSchoolIds.map(id => getDocs(schoolCollection(id, 'subjects')).catch(() => null))
    )
    subjectSnaps.forEach(snap => {
      if (!snap) return
      snap.docs.forEach(d => {
        const data = d.data()
        const goals = data.curricular_goals || []
        if (!goals.length) return
        const grade = d.id.includes('_') ? d.id.split('_')[0] : ''
        const name = (data.name || '').trim().toLowerCase()
        if (!name) return
        const key = `${normalizeGrade(grade)}|${name}`
        // Keep the richest match seen so far if more than one school has it.
        const existing = goalsByKey.get(key)
        if (!existing || goals.length > existing.length) goalsByKey.set(key, goals)
      })
    })
  } catch (e) {
    console.error('Could not load curricular goals library', e)
  }
  return goalsByKey
}

async function buildSubjectsPlan(schoolId, rows) {
  const [snap, goalsLibrary] = await Promise.all([
    getDocs(schoolCollection(schoolId, 'subjects')),
    loadGoalsLibrary(schoolId),
  ])
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
    if (!existing) {
      const goals = goalsLibrary.get(`${normalizeGrade(grade)}|${name.toLowerCase()}`)
      if (goals && goals.length) payload.curricular_goals = goals.map(g => ({ ...g }))
      items.push({ row, status: 'CREATE', docId, payload })
    } else {
      items.push({ row, status: fieldsEqual(existing, payload, ['name', 'area']) ? 'UPDATE_UNCHANGED' : 'UPDATE_CHANGED', docId, payload })
    }
  }
  return summarize('subjects', items)
}

// Assessments are the one entity where extract.py's schema (exam blueprint:
// syllabus coverage, instructional days, activity weighting...) doesn't map
// cleanly onto AssessmentsTab's live schema (name/termId/subjectId/order/
// entryType/maxMarks/gradingScaleId) — assessments there are scoped to a
// Term the import can't know about. `termId` must be supplied by the review
// screen (a Select, same as AssessmentsTab requires) before committing;
// the richer extracted fields are preserved as extra doc fields for now.
async function buildAssessmentsPlan(schoolId, rows, termId) {
  const subjectLookup = await loadSubjectLookup(schoolId)
  const items = []
  for (const row of rows) {
    const d = row.data
    if ((row.suggestions || []).length) {
      items.push({ row, status: 'SUGGESTION_PENDING', reason: 'Resolve suggested fixes before committing' })
      continue
    }
    const name = (d.assessment || '').trim()
    if (!name) { items.push({ row, status: 'ERROR', reason: 'Missing assessment name' }); continue }
    if (!termId) { items.push({ row, status: 'ERROR', reason: 'Select a Term to commit assessments into.' }); continue }
    const grade = (d.grade_band || d.stream || '').trim()
    const subjectId = subjectLookup.get(`${normalizeGrade(grade)}|${name.toLowerCase()}`) || null
    // No reliable per-row subject match for exam-blueprint rows (they're
    // usually grade/stream-wide, not per-subject) — flag for manual subject
    // pick rather than guessing.
    if (!subjectId) { items.push({ row, status: 'ERROR', reason: 'Could not resolve a subject for this assessment row — commit skipped, add manually in Assessments tab.' }); continue }
    const maxWritten = parseFloat(String(d.max_written || '').replace(/[^\d.]/g, ''))
    const docId = `${subjectId}_${termId}_${slugPart(name)}`
    const payload = {
      name, termId, subjectId, order: 1, entryType: 'marks',
      maxMarks: Number.isFinite(maxWritten) ? maxWritten : null, gradingScaleId: null,
      dateStart: d.date_start || '', dateEnd: d.date_end || '',
      instructionalDays: d.instructional_days || '', syllabusCovered: d.syllabus_covered || '',
      examSyllabus: d.exam_syllabus || '', maxWrittenRaw: d.max_written || '',
      activityWeight: d.activity_weight || '', total: d.total || '', duration: d.duration || '',
    }
    items.push({ row, status: 'CREATE', docId, payload })
  }
  return summarize('assessments', items)
}

// ── Generic commit plan — for any custom import template (Manage Templates
// page), not one of the 4 built-in entities above. No class/staff/subject
// resolution (a generic template has no notion of grade/section — that's a
// legacy-teacher/student-specific concept), just: filter each row's payload
// to the template's declared columns, and classify CREATE/UPDATE_CHANGED/
// UPDATE_UNCHANGED against whatever already exists in the target collection.
async function buildGenericTemplatePlan(schoolId, rows, entitySlug) {
  const template = await getImportTemplateRemote({ slug: entitySlug })
  if (!template) throw new Error(`No import template found for '${entitySlug}' — it may have been deleted.`)

  const columnKeys = (template.columns || []).map(c => c.key)
  const keyField = template.keyField || ''

  const existingSnap = await getDocs(schoolCollection(schoolId, template.targetCollectionName))
  const existingById = new Map(existingSnap.docs.map(d => [d.id, d.data()]))
  const usedIds = new Map()
  const items = []

  for (const row of rows) {
    const d = row.data
    if ((row.suggestions || []).length) {
      items.push({ row, status: 'SUGGESTION_PENDING', reason: 'Resolve suggested fixes before committing' })
      continue
    }

    const payload = {}
    for (const key of columnKeys) payload[key] = d[key] ?? ''

    let docId
    if (keyField) {
      const base = slugPart(d[keyField])
      if (!base) {
        items.push({ row, status: 'ERROR', reason: `Missing key field '${keyField}' — cannot determine which record this row belongs to` })
        continue
      }
      docId = base
      const dupeCount = (usedIds.get(docId) || 0) + 1
      usedIds.set(docId, dupeCount)
      if (dupeCount > 1) docId = `${docId}_${dupeCount}`
    } else {
      // No key field declared — this template always creates new records,
      // same as buildAssessmentsPlan does for exam-blueprint rows.
      docId = doc(schoolCollection(schoolId, template.targetCollectionName)).id
    }

    const existing = existingById.get(docId)
    if (!existing) {
      items.push({ row, status: 'CREATE', docId, payload })
    } else {
      items.push({ row, status: fieldsEqual(existing, payload, columnKeys) ? 'UPDATE_UNCHANGED' : 'UPDATE_CHANGED', docId, payload })
    }
  }
  return summarize(entitySlug, items)
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
    goalsAutoFetched: items.filter(i => i.status === 'CREATE' && (i.payload?.curricular_goals || []).length > 0).length,
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

  return { written: result.written, skipped: plan.items.length - result.written }
}
