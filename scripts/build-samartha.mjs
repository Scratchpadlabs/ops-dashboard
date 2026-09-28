#!/usr/bin/env node
/**
 * One-time onboarding build for Samartha School, Mahabubnagar (2026-27):
 *   schools/samarthaschool
 *
 * The school doc, its 9 classes, 27 subjects, 269 students and 12 staff
 * already exist from the survey-app era. This fills in everything SmartSheets
 * needs and fixes what the survey-era import got wrong. Sources:
 *   - "ON-BOARDING PRE-REQUISITES SAMARTHA.pdf" — school details, subjects per
 *     class, co-scholastic areas, teacher → subject → section list, class teachers
 *   - "HPC Requirements" (handwritten) — assessment pattern and max marks,
 *     co-scholastic 50-mark → A–E bands
 *   - "Copy of Student Details 1 to 5" (Drive sheet, exported as .xlsx) —
 *     real DOB / admission no. / Aadhaar per student
 *   - Ops decisions (2026-09-28): add Dance as a 4th co-scholastic area;
 *     best-of-weekly-tests is worked out at report time, not in the app;
 *     General Remarks only (the 3 anecdote rounds are not modelled);
 *     22 working days for every month; create logins for the teachers not
 *     yet in staffs.
 *
 * What it writes (all under schools/samarthaschool):
 *   school doc          merge address / board / affiliation / UDISE / contacts
 *   terms               Term_1_2026_27, Term_2_2026_27            (create if missing)
 *   grading_scales      Samartha_A_to_E                            (create if missing)
 *   assessments         13 per subject × 26 subjects               (create if missing)
 *   co_scholastic_activities  4 areas × 2 terms                    (create if missing)
 *   remark_categories   General Remarks, foundational + preparatory (create if missing)
 *   months              2026-06 … 2027-04, 22 working days          (create if missing)
 *   config/students_schema                                          (create if missing)
 *   classes             subjects[] for classes whose list is empty; isActive
 *   staffs              assignments/classIds from the checklist (union, never
 *                       stripped), classTeacherOf, the dangling V_Sample class
 *                       removed from coScholasticClassIds, names cleaned;
 *                       11 new teachers + their Firebase Auth logins
 *                       (email tssNNNN@samarthaschool.com, password = doc id,
 *                       the create_auth_accounts convention)
 *   students            dateOfBirth / admNo / aadhaarNumber from the sheet
 *
 * Nothing is deleted. Config docs that already exist are left untouched.
 *
 * DOB note: the Drive sheet was typed day-first (16/10/2019) into a
 * month-first sheet. Values Sheets could read as a date (day ≤ 12) were stored
 * with day and month swapped (7/11/2017 → 11 July); everything else stayed
 * text. Date cells are swapped back here; text is parsed day-first.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *   # Dry run (default): prints the plan, writes nothing. --students is optional.
 *   node scripts/build-samartha.mjs --students=/path/to/student-details.xlsx
 *
 *   # Apply.
 *   node scripts/build-samartha.mjs --students=/path/to/student-details.xlsx --commit
 *
 * Flags:
 *   --students=<path>  the student-details workbook (sheet "All Students Master").
 *                      Optional: without it the student DOB / admission no. /
 *                      Aadhaar fix is skipped and everything else still runs.
 *   --commit           actually write and create Auth accounts
 *   --plan=<path>      write the full plan as JSON (default: none)
 *   --project=<id>     Firestore project (default clarified-1501)
 *
 * Auth: application default credentials.
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json node scripts/build-samartha.mjs ...
 */
import { writeFileSync } from 'node:fs'
import { initializeApp, applicationDefault } from 'firebase-admin/app'
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore'
import { getAuth } from 'firebase-admin/auth'
import XLSX from 'xlsx'

const SCHOOL_ID = 'samarthaschool'
const ACTOR = 'scripts/build-samartha.mjs'
const BATCH_LIMIT = 400
const EMAIL_DOMAIN = 'samarthaschool.com'

// ── CLI ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const value = (name) => {
  const hit = argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : null
}
const COMMIT = flag('commit')
const STUDENTS_PATH = value('students')
const PLAN_PATH = value('plan')
const PROJECT = value('project') || process.env.GOOGLE_CLOUD_PROJECT || 'clarified-1501'

// ── Source data ─────────────────────────────────────────────────────────────
const SCHOOL_FIELDS = {
  address: 'Government Medical College Road, Thirumala Hills, Appanapally, Mahabubnagar, Telangana 509002',
  city: 'Mahabubnagar',
  state: 'Telangana',
  pincode: '509002',
  board: 'CBSE',
  affiliationNo: '130445',
  udiseCode: '36251090459',
  academicYear: '2026-27',
  schoolPhone: '9133355651 / 9133355652',
  principalName: 'Mr. Srikanth Kota',
  principalPhone: '9963012311',
  hpcInchargeName: 'B. Swetha',
  hpcInchargePhone: '9391694498',
  hpcInchargeEmail: 'swethamukherjeeb@gmail.com',
}

const TERMS = [
  { id: 'Term_1_2026_27', name: 'Term 1' },
  { id: 'Term_2_2026_27', name: 'Term 2' },
]

// Co-scholastic: 50 marks → 40–50 A, 30–40 B, 20–30 C, 10–20 D, 0–10 E.
// A mark on a boundary (40/50) takes the higher band; the teacher app's
// whole-number-edge fallback covers the fractional gaps (79.5%).
const SCALE_ID = 'Samartha_A_to_E'
const SCALE = {
  name: 'Samartha A–E (Co-Scholastic)',
  levels: [
    { label: 'E', minPercent: 0, maxPercent: 19 },
    { label: 'D', minPercent: 20, maxPercent: 39 },
    { label: 'C', minPercent: 40, maxPercent: 59 },
    { label: 'B', minPercent: 60, maxPercent: 79 },
    { label: 'A', minPercent: 80, maxPercent: 100 },
  ],
}

const marks = (name, maxMarks, conversionType = 'none', conversionFactor = null) =>
  ({ name, entryType: 'marks', maxMarks, gradingScaleId: null, conversionType, conversionFactor })

// Per term: weekly tests 20M (shown out of 5), SA written 40M (shown doubled
// to 80), then three 5-mark components. Term total 80 + 20 = 100.
const ASSESSMENTS = {
  Term_1_2026_27: [
    marks('Weekly Test 1.1', 20, 'sum_down', 4),
    marks('Weekly Test 1.2', 20, 'sum_down', 4),
    marks('Weekly Test 1.3', 20, 'sum_down', 4),
    marks('SA-1 Written', 40, 'sum_up', 2),
    marks('Multiple Assessment', 5),
    marks('Portfolio', 5),
    marks('Subject Enrichment', 5),
  ],
  Term_2_2026_27: [
    marks('Weekly Test 2.1', 20, 'sum_down', 4),
    marks('Weekly Test 2.2', 20, 'sum_down', 4),
    marks('SA-2 Written', 40, 'sum_up', 2),
    marks('Multiple Assessment', 5),
    marks('Portfolio', 5),
    marks('Subject Enrichment', 5),
  ],
}

const CO_SCHOLASTIC = ['Art and Craft', 'Music', 'Dance', 'Health and Physical Education']

const CLASS_IDS = ['I_DRDO', 'II_DRDO', 'II_ISRO', 'III_DRDO', 'III_ISRO', 'IV_DRDO', 'IV_ISRO', 'V_DRDO', 'V_ISRO']
const FOUNDATIONAL = ['I_DRDO', 'II_DRDO', 'II_ISRO']
const PREPARATORY = ['III_DRDO', 'III_ISRO', 'IV_DRDO', 'IV_ISRO', 'V_DRDO', 'V_ISRO']

// Class-wise subjects (onboarding §5). AAM ("All About Me") is on every
// existing class list, so the classes being filled in get it too.
const CLASS_SUBJECTS = {
  I: ['English', 'Telugu', 'Mathematics', 'EVS'],
  II: ['English', 'Telugu', 'Mathematics', 'EVS'],
  III: ['English', 'Hindi', 'Telugu', 'Mathematics', 'Science', 'Social_Studies'],
  IV: ['English', 'Hindi', 'Telugu', 'Mathematics', 'Science', 'Social_Studies'],
  V: ['English', 'Hindi', 'Telugu', 'Mathematics', 'Science', 'Social_Studies'],
}

// Onboarding §8. key → { name, existing staff doc id when already in staffs }.
const TEACHERS = {
  neha_fatima: { name: 'Neha Fatima' },
  huma_afreen: { name: 'Huma Afreen' },
  nagamani: { name: 'K. Nagamani', existing: 'tss0003', match: 'NAGAMANI' },
  maheshwari: { name: 'Maheshwari' },
  b_shireesha: { name: 'B. Shireesha', existing: 'tss0005', match: 'SHIREESHA' },
  b_deena: { name: 'B. Deena' },
  ananya: { name: 'Ananya' },
  manjula: { name: 'Manjula' },
  saniya: { name: 'Saniya' },
  neha: { name: 'Neha' },
  a_shireesha: { name: 'A. Shireesha', existing: 'tss0012', match: 'SHIREESHA' },
  fathima_begum: { name: 'Fathima Begum', existing: 'tss0011', match: 'FATHIMA' },
  sri_ramya: { name: 'I. Sri Ramya', existing: 'tss0008', match: 'RAMYA' },
  usha_rani: { name: 'O. Usha Rani', existing: 'tss0007', match: 'USHA' },
  radha: { name: 'Radha' },
  swetha: { name: 'B. Swetha', existing: 'tss0006', match: 'SWETHA' },
  yashodha: { name: 'Yashodha' },
  swathi: { name: 'Swathi' },
}

// [teacher, subject suffix, sections]
const TEACHING = [
  ['neha_fatima', 'English', ['I_DRDO', 'II_ISRO', 'II_DRDO']],
  ['huma_afreen', 'EVS', ['I_DRDO', 'II_ISRO', 'II_DRDO']],
  ['huma_afreen', 'Science', ['III_DRDO', 'III_ISRO']],
  ['nagamani', 'Mathematics', ['I_DRDO', 'II_ISRO', 'II_DRDO', 'III_ISRO']],
  ['maheshwari', 'Telugu', ['I_DRDO']],
  ['b_shireesha', 'Telugu', ['II_ISRO']],
  ['b_deena', 'Telugu', ['II_DRDO']],
  ['ananya', 'English', ['III_DRDO', 'III_ISRO']],
  ['ananya', 'Social_Studies', ['V_ISRO', 'V_DRDO']],
  ['manjula', 'Mathematics', ['III_DRDO']],
  ['saniya', 'Social_Studies', ['III_ISRO']],
  ['neha', 'Social_Studies', ['III_DRDO']],
  ['a_shireesha', 'Telugu', ['III_DRDO', 'III_ISRO', 'IV_DRDO', 'IV_ISRO', 'V_ISRO']],
  ['fathima_begum', 'Hindi', ['III_DRDO', 'III_ISRO']],
  ['sri_ramya', 'Mathematics', ['IV_DRDO', 'IV_ISRO', 'V_ISRO', 'V_DRDO']],
  ['usha_rani', 'Science', ['IV_DRDO', 'IV_ISRO', 'V_ISRO', 'V_DRDO']],
  ['radha', 'Social_Studies', ['IV_DRDO', 'IV_ISRO']],
  ['swetha', 'English', ['IV_DRDO', 'IV_ISRO', 'V_ISRO', 'V_DRDO']],
  ['yashodha', 'Hindi', ['IV_DRDO', 'IV_ISRO', 'V_ISRO', 'V_DRDO']],
  ['swathi', 'Telugu', ['V_DRDO']],
]

const CLASS_TEACHERS = {
  I_DRDO: 'neha_fatima', II_DRDO: 'huma_afreen', II_ISRO: 'nagamani',
  III_DRDO: 'ananya', III_ISRO: 'a_shireesha', IV_DRDO: 'sri_ramya',
  IV_ISRO: 'radha', V_ISRO: 'swetha', V_DRDO: 'usha_rani',
}

// Generic General Remarks bank (same wording already live at shardakalamb).
const GENERAL_REMARKS = {
  Foundational_General_Remarks: {
    keyPrefix: 'foundational_gr', classIds: FOUNDATIONAL,
    positive: [
      'Enjoys learning new things', 'Listens carefully to the teacher', 'Tries to do work neatly',
      'Plays very nicely with others', 'Is very creative', 'Always helps classmates',
      'Follows class rules', 'Finishes classwork on time', 'Is very gentle and caring',
      'Always shows good manners', 'Speaks politely', 'Very curious mind',
    ],
    negative: [
      'Encouraged to focus more on completing the tasks independently.',
      'Can benefit from more practice in writing and coordination skills.',
      'Encouraged to pay more attention in class',
      'Can benefit from more participation in activities',
      'Encouraged to express ideas more clearly',
    ],
  },
  Preparatory_General_Remarks: {
    keyPrefix: 'preparatory_gr', classIds: PREPARATORY,
    positive: [
      'Always submits work on time', 'Shows excellent leadership qualities', 'Keeps things tidy',
      'Works really well in a team', 'Shows good manners', 'Very curious mind',
      'Enjoys learning new things', 'Listens carefully in class', 'Is friendly to everyone',
      'Follows class rules', 'Always shares ideas confidently', 'Is very creative',
      'Always polite in conversations',
    ],
    negative: [
      'Encouraged to pay more attention in class', 'Encouraged to finish work on time',
      'Encouraged to avoid talking during lessons', 'Can benefit from more participation in activities',
      'Encouraged to organise things better', 'Encouraged to express ideas more clearly',
      'Can benefit from improved handwriting',
    ],
  },
}

// June 2026 – April 2027 (Telangana school year), 22 working days each.
const MONTHS = (() => {
  const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
    'September', 'October', 'November', 'December']
  const out = []
  let y = 2026, m = 6
  for (let order = 1; order <= 11; order++) {
    out.push({ key: `${y}-${String(m).padStart(2, '0')}`, label: `${names[m - 1]} ${y}`, month: m, year: y, order, workingDays: 22 })
    m++
    if (m > 12) { m = 1; y++ }
  }
  return out
})()

// ── Helpers ─────────────────────────────────────────────────────────────────
const slug = (s) => s.replace(/&/g, 'and').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '')
const normName = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z]/g, '')
const gradeOf = (classId) => classId.split('_')[0]
const splitName = (full) => {
  const parts = full.trim().split(/\s+/)
  return { firstName: parts.slice(0, -1).join(' ') || parts[0], lastName: parts.length > 1 ? parts[parts.length - 1] : '' }
}
const union = (...lists) => [...new Set(lists.flat().filter(Boolean))]

function parseDob(raw) {
  if (raw === null || raw === undefined || raw === '') return null
  if (raw instanceof Date) {
    // Stored month-first from a day-first entry — swap back (see header).
    return Date.UTC(raw.getFullYear(), raw.getDate() - 1, raw.getMonth() + 1)
  }
  const m = String(raw).trim().match(/^(\d{1,2})\s*[/.\-]\s*(\d{1,2})\s*[/.\-]\s*(\d{4})$/)
  if (!m) return undefined
  const [d, mo, y] = [+m[1], +m[2], +m[3]]
  const t = Date.UTC(y, mo - 1, d)
  const back = new Date(t)
  if (mo < 1 || mo > 12 || back.getUTCDate() !== d) return undefined
  return t
}

function cleanId(raw) {
  if (raw === null || raw === undefined) return ''
  const s = typeof raw === 'number' ? String(Math.round(raw)) : String(raw).trim()
  return /^\d+$/.test(s) ? s : ''
}

function readStudentSheet(path) {
  const wb = XLSX.readFile(path, { cellDates: true })
  const ws = wb.Sheets['All Students Master']
  if (!ws) throw new Error(`"All Students Master" sheet not found in ${path}`)
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null })
  const header = rows[0].map(h => String(h ?? '').trim().toUpperCase())
  const col = (name) => {
    const i = header.indexOf(name)
    if (i < 0) throw new Error(`column ${name} missing from student sheet`)
    return i
  }
  const c = { cls: col('CLASS'), adm: col('ADMN NO'), name: col('NAME OF THE STUDENT'), dob: col('DOB'), aadhaar: col('AADHAR NO') }
  return rows.slice(1).filter(r => r[c.name]).map(r => {
    // One row carries its DOB typed into the name cell ("NAME      08/01/2017").
    let name = String(r[c.name]).trim()
    let dobRaw = r[c.dob]
    const inName = name.match(/^(.*?)\s+(\d{1,2}\s*[/.\-]\s*\d{1,2}\s*[/.\-]\s*\d{4})$/)
    if (inName) {
      name = inName[1].trim()
      if (dobRaw === null || dobRaw === '') dobRaw = inName[2]
    }
    return { classId: String(r[c.cls]).trim(), name, admNo: cleanId(r[c.adm]), dobRaw, aadhaar: cleanId(r[c.aadhaar]) }
  })
}

// ── Main ────────────────────────────────────────────────────────────────────
initializeApp({ credential: applicationDefault(), projectId: PROJECT })
const db = getFirestore()
const auth = getAuth()
const school = db.collection('schools').doc(SCHOOL_ID)
const stamp = (created) => ({
  ...(created ? { created_at: FieldValue.serverTimestamp(), created_by: ACTOR } : {}),
  updated_at: FieldValue.serverTimestamp(), updated_by: ACTOR,
})

const ops = []            // { ref, data, mode: 'create'|'merge', label }
const authToCreate = []   // { docId, email, displayName }
const report = { created: {}, skippedExisting: {}, updated: {}, warnings: [] }
const bump = (bucket, key, n = 1) => { report[bucket][key] = (report[bucket][key] || 0) + n }

async function createIfMissing(collection, id, data) {
  const ref = school.collection(collection).doc(id)
  if ((await ref.get()).exists) { bump('skippedExisting', collection); return }
  ops.push({ ref, data: { ...data, ...stamp(true) }, mode: 'create', label: `${collection}/${id}` })
  bump('created', collection)
}

async function main() {
  const schoolSnap = await school.get()
  if (!schoolSnap.exists) throw new Error(`schools/${SCHOOL_ID} does not exist`)

  // School doc
  ops.push({ ref: school, data: { ...SCHOOL_FIELDS, ...stamp(false) }, mode: 'merge', label: `schools/${SCHOOL_ID}` })
  bump('updated', 'school doc')

  // Subjects that must exist
  const subjectsSnap = await school.collection('subjects').get()
  const subjectIds = new Set(subjectsSnap.docs.map(d => d.id))
  const academicSubjects = [...new Set(Object.entries(CLASS_SUBJECTS).flatMap(([g, subs]) => subs.map(s => `${g}_${s}`)))]
  const missingSubjects = academicSubjects.filter(id => !subjectIds.has(id))
  if (missingSubjects.length) throw new Error(`subjects missing: ${missingSubjects.join(', ')}`)

  // Terms, scale
  for (const t of TERMS) await createIfMissing('terms', t.id, { name: t.name, academicYear: '2026-27', isActive: true })
  await createIfMissing('grading_scales', SCALE_ID, SCALE)

  // Assessments
  for (const subjectId of academicSubjects) {
    for (const [termId, list] of Object.entries(ASSESSMENTS)) {
      for (const [i, a] of list.entries()) {
        await createIfMissing('assessments', `${subjectId}_${termId}_${slug(a.name)}`, { ...a, termId, subjectId, order: i + 1 })
      }
    }
  }

  // Co-scholastic
  for (const t of TERMS) {
    for (const [i, name] of CO_SCHOLASTIC.entries()) {
      await createIfMissing('co_scholastic_activities', `${t.id}_${slug(name)}`, {
        name, termId: t.id, order: i + 1, entryType: 'marks', maxMarks: 50,
        gradingScaleId: SCALE_ID, conversionType: 'marks_to_grade', conversionFactor: null,
      })
    }
  }

  // Remarks
  for (const [id, bank] of Object.entries(GENERAL_REMARKS)) {
    const texts = [...bank.positive.map(t => ['positive', t]), ...bank.negative.map(t => ['negative', t])]
    await createIfMissing('remark_categories', id, {
      label: 'General Remarks', order: 1, classIds: bank.classIds,
      remarks: texts.map(([type, text], i) => ({ key: `${bank.keyPrefix}${i + 1}`, text, type, order: i + 1 })),
    })
  }

  // Months
  for (const m of MONTHS) await createIfMissing('months', m.key, m)

  // students_schema
  await createIfMissing('config', 'students_schema', {
    columns: [
      { key: 'id', label: 'ID', type: 'text', editable: false, order: 1 },
      { key: 'name', label: 'Student Name', type: 'text', editable: true, order: 2 },
      { key: 'currentClassId', label: 'Class', type: 'select', editable: true, order: 3, options: CLASS_IDS },
      { key: 'rollNo', label: 'Roll No', type: 'text', editable: true, order: 4 },
      { key: 'admNo', label: 'Admission No', type: 'text', editable: true, order: 5 },
      { key: 'gender', label: 'Gender', type: 'select', editable: true, order: 6, options: ['Male', 'Female'] },
      { key: 'dateOfBirth', label: 'Date of Birth', type: 'date', editable: true, order: 7 },
    ],
  })

  // Classes
  const classesSnap = await school.collection('classes').get()
  const classDocs = Object.fromEntries(classesSnap.docs.map(d => [d.id, d.data()]))
  for (const classId of CLASS_IDS) {
    const cls = classDocs[classId]
    if (!cls) throw new Error(`class ${classId} missing`)
    const patch = {}
    if (!Array.isArray(cls.subjects) || cls.subjects.length === 0) {
      const ids = [...CLASS_SUBJECTS[gradeOf(classId)].map(s => `${gradeOf(classId)}_${s}`), 'AAM']
      patch.subjects = ids.map(subjectId => ({
        subjectId, teacherId: '', isCompleted: false, completedAt: null,
        topics: ['Term1', 'Term2', 'Optional'].map(t => ({
          id: `${subjectId}_${t}`, topic: t === 'Optional' ? 'Optional' : t.replace('Term', 'Term '), isCompleted: false, completedAt: null,
        })),
      }))
    } else {
      const have = new Set(cls.subjects.map(s => s.subjectId))
      const missing = CLASS_SUBJECTS[gradeOf(classId)].map(s => `${gradeOf(classId)}_${s}`).filter(id => !have.has(id))
      if (missing.length) report.warnings.push(`${classId} subject list is missing ${missing.join(', ')} (left as is)`)
    }
    if (cls.isActive !== true) patch.isActive = true
    if (Object.keys(patch).length) {
      ops.push({ ref: school.collection('classes').doc(classId), data: { ...patch, ...stamp(false) }, mode: 'merge', label: `classes/${classId}` })
      bump('updated', patch.subjects ? 'classes (subjects filled)' : 'classes (isActive)')
    }
  }
  if (classDocs.sample) report.warnings.push('classes/sample (test class) still present — not touched')

  // Staff
  const staffSnap = await school.collection('staffs').get()
  const staffDocs = Object.fromEntries(staffSnap.docs.map(d => [d.id, d.data()]))
  const assignmentsByTeacher = {}
  const covered = {}
  for (const [key, suffix, sections] of TEACHING) {
    if (!TEACHERS[key]) throw new Error(`unknown teacher key ${key}`)
    for (const classId of sections) {
      const subjectId = `${gradeOf(classId)}_${suffix}`
      if (!subjectIds.has(subjectId)) throw new Error(`${key}: subject ${subjectId} not found`)
      const a = (assignmentsByTeacher[key] ||= {})
      a[classId] = union(a[classId] || [], [subjectId])
      const cell = `${classId}:${subjectId}`
      if (covered[cell]) throw new Error(`${cell} assigned to both ${covered[cell]} and ${key}`)
      covered[cell] = key
    }
  }
  for (const classId of CLASS_IDS) {
    for (const s of CLASS_SUBJECTS[gradeOf(classId)]) {
      if (!covered[`${classId}:${gradeOf(classId)}_${s}`]) report.warnings.push(`no teacher for ${classId} ${s}`)
    }
  }

  let nextNum = Math.max(0, ...Object.keys(staffDocs).map(id => +(id.match(/^tss(\d+)$/)?.[1] ?? 0))) + 1
  const staffIdOf = {}
  for (const [key, t] of Object.entries(TEACHERS)) {
    const assignments = assignmentsByTeacher[key] || {}
    const classTeacherOf = Object.entries(CLASS_TEACHERS).find(([, k]) => k === key)?.[0] || ''
    const { firstName, lastName } = splitName(t.name)

    // A teacher this script created on an earlier run is found by its exact
    // name, so a re-run updates that doc instead of adding a duplicate.
    const existingId = t.existing
      || Object.keys(staffDocs).find(id => staffDocs[id].created_by === ACTOR && normName(staffDocs[id].name) === normName(t.name))
    if (existingId) {
      const cur = staffDocs[existingId]
      if (!cur) throw new Error(`${existingId} (${t.name}) not found`)
      if (!normName(cur.name).includes(t.match || normName(t.name))) throw new Error(`${existingId} is "${cur.name}", expected ${t.name}`)
      const mergedAssignments = { ...(cur.assignments || {}) }
      for (const [c, subs] of Object.entries(assignments)) mergedAssignments[c] = union(mergedAssignments[c] || [], subs)
      const patch = {
        name: t.name, firstName, lastName,
        assignments: mergedAssignments,
        classIds: union(cur.classIds || [], Object.keys(assignments)),
        coScholasticClassIds: (cur.coScholasticClassIds || []).filter(c => CLASS_IDS.includes(c)),
        classTeacherOf,
      }
      ops.push({ ref: school.collection('staffs').doc(existingId), data: { ...patch, ...stamp(false) }, mode: 'merge', label: `staffs/${existingId} (${cur.name} → ${t.name})` })
      bump('updated', 'staffs (existing, assigned)')
      staffIdOf[key] = existingId
      // Login still pending from an earlier run (e.g. an Auth call failed) — retry it.
      if (cur.needsAuthCreation === true && cur.email) authToCreate.push({ docId: existingId, email: cur.email, displayName: t.name })
      continue
    }

    const id = `tss${String(nextNum++).padStart(4, '0')}`
    const email = `${id}@${EMAIL_DOMAIN}`
    staffIdOf[key] = id
    ops.push({
      ref: school.collection('staffs').doc(id), mode: 'create', label: `staffs/${id} (${t.name}, new)`,
      data: {
        id, staffId: id, name: t.name, firstName, lastName, email, phoneNo: null, sex: '',
        profileUrl: '', type: 'teacher', isActive: true,
        assignments, classIds: Object.keys(assignments), coScholasticClassIds: [], classTeacherOf,
        needsAuthCreation: true, authUid: null, ...stamp(true),
      },
    })
    authToCreate.push({ docId: id, email, displayName: t.name })
    bump('created', 'staffs (new teachers)')
  }
  // Staff not on the checklist: only drop the dangling class id.
  for (const [id, cur] of Object.entries(staffDocs)) {
    if (Object.values(staffIdOf).includes(id)) continue
    const cleaned = (cur.coScholasticClassIds || []).filter(c => CLASS_IDS.includes(c))
    if (cleaned.length !== (cur.coScholasticClassIds || []).length) {
      ops.push({ ref: school.collection('staffs').doc(id), data: { coScholasticClassIds: cleaned, ...stamp(false) }, mode: 'merge', label: `staffs/${id} (${cur.name}, not on checklist: V_Sample removed)` })
      bump('updated', 'staffs (not on checklist, V_Sample removed)')
    }
  }
  for (const { email } of authToCreate) {
    try { await auth.getUserByEmail(email); report.warnings.push(`Auth account ${email} already exists — will be linked, not recreated`) } catch { /* expected: free */ }
  }

  // Students
  if (!STUDENTS_PATH) report.warnings.push('no --students sheet given: student DOB / admission no. / Aadhaar left unchanged')
  const sheet = STUDENTS_PATH ? readStudentSheet(STUDENTS_PATH) : []
  const studentsSnap = await school.collection('students').get()
  const byKey = new Map()
  for (const d of studentsSnap.docs) {
    const s = d.data()
    const k = `${s.currentClassId}|${normName(s.name)}`
    if (byKey.has(k)) report.warnings.push(`duplicate student name in ${s.currentClassId}: ${s.name}`)
    byKey.set(k, d)
  }
  const matched = new Set()
  const noDob = []
  for (const row of sheet) {
    const doc = byKey.get(`${row.classId}|${normName(row.name)}`)
    if (!doc) { report.warnings.push(`sheet row not matched to a student: ${row.classId} ${row.name}`); continue }
    matched.add(doc.id)
    const patch = {}
    const dob = parseDob(row.dobRaw)
    if (dob === undefined) report.warnings.push(`unreadable DOB "${row.dobRaw}" for ${row.classId} ${row.name}`)
    else if (dob === null) noDob.push(`${row.classId} ${row.name}`)
    else patch.dateOfBirth = Timestamp.fromMillis(dob)
    if (row.admNo) patch.admNo = row.admNo
    if (row.aadhaar && row.aadhaar.length === 12) patch.aadhaarNumber = row.aadhaar
    if (Object.keys(patch).length) {
      ops.push({ ref: doc.ref, data: { ...patch, ...stamp(false) }, mode: 'merge', label: `students/${doc.id}`, preview: { name: row.name, dob: dob ? new Date(dob).toISOString().slice(0, 10) : null, admNo: row.admNo } })
      bump('updated', 'students')
    }
  }
  const unmatchedDocs = STUDENTS_PATH ? studentsSnap.docs.filter(d => !matched.has(d.id)) : []
  for (const d of unmatchedDocs) report.warnings.push(`student not in sheet: ${d.id} ${d.data().currentClassId} ${d.data().name}`)
  if (noDob.length) report.warnings.push(`${noDob.length} students have no DOB in the sheet (placeholder kept): ${noDob.join('; ')}`)

  // ── Output ────────────────────────────────────────────────────────────────
  console.log(`\n${COMMIT ? 'COMMIT' : 'DRY RUN'} — schools/${SCHOOL_ID} (${PROJECT})`)
  console.log('\nCreate:', report.created)
  console.log('Already existed (left alone):', report.skippedExisting)
  console.log('Update:', report.updated)
  console.log(`Auth accounts to create: ${authToCreate.length}`)
  console.log('\nStaff changes:')
  for (const o of ops.filter(o => o.label.startsWith('staffs/'))) {
    console.log(`  ${o.label}\n     classes/subjects: ${JSON.stringify(o.data.assignments ?? '—')}${o.data.classTeacherOf ? `  class teacher: ${o.data.classTeacherOf}` : ''}`)
  }
  console.log('\nSample student updates:')
  for (const o of ops.filter(o => o.preview).slice(0, 8)) console.log(`  ${o.label}  ${JSON.stringify(o.preview)}`)
  console.log(`\nWarnings (${report.warnings.length}):`)
  for (const w of report.warnings) console.log(`  - ${w}`)
  console.log(`\nTotal document writes: ${ops.length}`)

  if (PLAN_PATH) {
    writeFileSync(PLAN_PATH, JSON.stringify({
      commit: COMMIT, report, authToCreate,
      writes: ops.map(o => ({ path: o.label, mode: o.mode, data: o.data, preview: o.preview })),
    }, (k, v) => (v instanceof Timestamp ? v.toDate().toISOString() : (v && v.constructor?.name?.includes('Transform')) ? '<serverTimestamp>' : v), 2))
    console.log(`Plan written to ${PLAN_PATH}`)
  }

  if (!COMMIT) { console.log('\nDry run only. Re-run with --commit to apply.'); return }

  for (let i = 0; i < ops.length; i += BATCH_LIMIT) {
    const batch = db.batch()
    for (const o of ops.slice(i, i + BATCH_LIMIT)) {
      if (o.mode === 'create') batch.create(o.ref, o.data)
      else batch.set(o.ref, o.data, { merge: true })
    }
    await batch.commit()
    console.log(`  committed ${Math.min(i + BATCH_LIMIT, ops.length)}/${ops.length}`)
  }

  for (const a of authToCreate) {
    let uid
    try {
      uid = (await auth.createUser({ email: a.email, password: a.docId, displayName: a.displayName })).uid
      console.log(`  auth created ${a.email}`)
    } catch (e) {
      if (e.code !== 'auth/email-already-exists') { console.error(`  auth FAILED ${a.email}: ${e.message}`); continue }
      uid = (await auth.getUserByEmail(a.email)).uid
      console.log(`  auth existing ${a.email}`)
    }
    await school.collection('staffs').doc(a.docId).update({ authUid: uid, needsAuthCreation: false })
  }
  console.log('\nDone.')
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
