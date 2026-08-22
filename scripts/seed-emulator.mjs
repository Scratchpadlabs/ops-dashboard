#!/usr/bin/env node
/**
 * Seed the local Firestore + Auth emulators with a school that reproduces the
 * defects this branch fixes, so the fixes can be exercised in the real app.
 *
 *     npm run emulators           # terminal 1
 *     npm run seed:emulator       # terminal 2
 *     npm run dev:emulate         # terminal 3
 *
 * The data is modelled on Hillgreen Highschool as it actually is (see the
 * Firestore screenshots on this branch's task), NOT on a tidy fixture — that
 * is the whole point. Every defect below is a real one:
 *
 *   1. subjects/ holds co-scholastic records (Conc, Dict, Linguistic, CLB,
 *      KRT, V_Edu), some with area "Co-Scholastic" and some with area "" —
 *      the unclassified ones are how most of them actually arrive.
 *   2. classes/ all carry `subjects: []` — created by the New School Wizard
 *      and never filled.
 *   3. assessments/ carry the old importer's output: named after their own
 *      subject, maxMarks 804040 from "80 (40+40)", every order 1, no
 *      conversionType/conversionFactor, plus blueprint junk fields.
 *   4. config/students_schema is absent entirely.
 *
 * A second school (SAMARTH_REF) carries one correct class doc, copied from the
 * live reference, so the topic template can be compared against it in the app.
 */
import { initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { getAuth } from 'firebase-admin/auth'

const PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'clarified-1501'
process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080'
process.env.FIREBASE_AUTH_EMULATOR_HOST ||= '127.0.0.1:9099'

initializeApp({ projectId: PROJECT })
const db = getFirestore()
const auth = getAuth()

const SCHOOL = 'Hillgreen_Highschool'
const stamp = { created_by: 'sid@ops.clarified.in', updated_by: 'sid@ops.clarified.in' }

// Grade I–III, mirroring the screenshot's per-grade subject lists.
const GRADES = ['I', 'II', 'III']
const SCHOLASTIC = ['Computer', 'English', 'EVS', 'Hindi', 'Marathi', 'Maths']
// Confirmed co-scholastic by the school. `area` is how the doc is filed today:
// two were tagged, four were never classified at all.
const CO_SCHOLASTIC = [
  ['Conc', ''], ['Dict', ''], ['Linguistic', ''],
  ['CLB', ''], ['KRT', 'Co-Scholastic'], ['V_Edu', 'Co-Scholastic'],
]
const SECTIONS = ['A', 'B']

// Re-seeding has to start from nothing: a previous run's repairs (deleted
// subjects, created activities, a rebuilt students_schema) would otherwise
// survive and the next run would test a half-fixed school.
async function wipe(ref) {
  for (const col of await ref.listCollections()) {
    const snap = await col.get()
    await Promise.all(snap.docs.map(d => wipe(d.ref)))
    const bulk = db.bulkWriter()
    snap.docs.forEach(d => bulk.delete(d.ref))
    await bulk.close()
  }
}

async function seed() {
  for (const id of [SCHOOL, 'SAMARTH_REF']) {
    const ref = db.collection('schools').doc(id)
    await wipe(ref)
    await ref.delete()
  }
  const bulk = db.bulkWriter()
  const school = db.collection('schools').doc(SCHOOL)

  bulk.set(school, {
    id: SCHOOL, name: 'Hillgreen Highschool', isActive: true, board: 'CBSE',
    city: 'Pune', owner: 'Siddhesh', created_via: 'new_school_wizard', ...stamp,
  })

  bulk.set(school.collection('terms').doc('term1'), { name: 'Term 1', academicYear: '2025-26', isActive: true })
  bulk.set(school.collection('terms').doc('term2'), { name: 'Term 2', academicYear: '2025-26', isActive: true })
  bulk.set(school.collection('grading_scales').doc('standard_scale'), {
    name: 'Standard Scale',
    levels: [
      { label: 'A', minPercent: 75, maxPercent: 100 },
      { label: 'B', minPercent: 50, maxPercent: 74 },
      { label: 'C', minPercent: 0, maxPercent: 49 },
    ],
  })

  // ── Defect 1: co-scholastic records filed as subjects ─────────────────────
  for (const grade of GRADES) {
    for (const name of SCHOLASTIC) {
      bulk.set(school.collection('subjects').doc(`${grade}_${name}`), {
        id: `${grade}_${name}`, name, area: 'Scholastic', curricular_goals: [], ...stamp,
      })
    }
    for (const [name, area] of CO_SCHOLASTIC) {
      bulk.set(school.collection('subjects').doc(`${grade}_${name}`), {
        id: `${grade}_${name}`, name, area, curricular_goals: [], ...stamp,
      })
    }
  }

  // ── Defect 2: every class has an empty subjects array ─────────────────────
  for (const grade of GRADES) {
    for (const section of SECTIONS) {
      const id = `${grade}_${section}`
      bulk.set(school.collection('classes').doc(id), {
        id, clazz: grade, section, name: `${grade} ${section}`,
        stage: 'foundation', isActive: true, subjects: [],
        created_via: 'new_school_wizard', ...stamp,
      })
    }
  }

  // ── Defect 3: assessments as the old importer wrote them ──────────────────
  // Named after their own subject (the only rows that survived name-matching),
  // maxMarks from the digit-strip, order 1 on every row, no conversion fields,
  // and the blueprint columns written as fields nothing reads.
  for (const grade of GRADES) {
    for (const name of ['English', 'Maths']) {
      const subjectId = `${grade}_${name}`
      bulk.set(school.collection('assessments').doc(`${subjectId}_term1_${name}`), {
        name,                       // ← named after the subject
        termId: 'term1', subjectId,
        order: 1,                   // ← every row 1
        entryType: 'marks',
        maxMarks: 804040,           // ← "80 (40+40)" digit-stripped
        gradingScaleId: null,
        // no conversionType / conversionFactor at all
        dateStart: '2026-04-01', dateEnd: '2026-04-10',
        instructionalDays: '45', syllabusCovered: 'Ch 1-4',
        examSyllabus: 'Ch 1-4', maxWrittenRaw: '80 (40+40)',
        activityWeight: '20', total: '', duration: '3 hrs',
        ...stamp,
      })
    }
  }
  // One assessment mangled beyond a confident reading, and one already correct.
  bulk.set(school.collection('assessments').doc('III_EVS_term1_unit_1'), {
    name: 'Unit 1', termId: 'term1', subjectId: 'III_EVS', order: 1,
    entryType: 'marks', maxMarks: 803030, gradingScaleId: null, ...stamp,
  })
  bulk.set(school.collection('assessments').doc('III_Hindi_term1_unit_1'), {
    name: 'Unit 1', termId: 'term1', subjectId: 'III_Hindi', order: 1,
    entryType: 'marks', maxMarks: 20, gradingScaleId: null,
    conversionType: 'none', conversionFactor: null, ...stamp,
  })

  // A teacher, so the assignment matrix has a row.
  bulk.set(school.collection('staffs').doc('tsds0001'), {
    id: 'tsds0001', staffId: 'tsds0001', name: 'Asha Kulkarni',
    firstName: 'Asha', lastName: 'Kulkarni', type: 'teacher',
    email: 'asha@example.com', classIds: [], assignments: {}, ...stamp,
  })

  // ── Defect 4: no config/students_schema at all. Nothing written here. ──────

  // ── Reference school: one correct class doc from SAMARTH ───────────────────
  const ref = db.collection('schools').doc('SAMARTH_REF')
  bulk.set(ref, { id: 'SAMARTH_REF', name: 'SAMARTH DNYANPEETH SAHAYDRI (reference)', isActive: true })
  bulk.set(ref.collection('subjects').doc('III_English'), {
    id: 'III_English', name: 'English', area: 'Scholastic', curricular_goals: [],
  })
  bulk.set(ref.collection('classes').doc('III_A'), {
    id: 'III_A', clazz: 'III', section: 'A', name: 'III A',
    stage: 'prepratory', isActive: true,
    subjects: [{
      subjectId: 'III_English', teacherId: '', isCompleted: false, completedAt: null,
      topics: [
        { id: 'III_English_Term1', topic: 'Term 1 Activity', isCompleted: true, completedAt: new Date(), absentList: ['ssds0139', 'ssds0140'] },
        { id: 'III_English_Term2', topic: 'Term 2 Activity', isCompleted: false, completedAt: null },
        { id: 'III_English_Optional', topic: 'Optional Activity', isCompleted: false, completedAt: null },
      ],
    }],
  })

  await bulk.close()

  // An ops-admin to sign in as (src/config/opsAdmins.js gates the page).
  const email = 'sid@ops.clarified.in'
  await auth.createUser({ email, password: 'emulator-password', emailVerified: true })
    .catch(e => { if (e.code !== 'auth/email-already-exists') throw e })

  const counts = await Promise.all(
    ['subjects', 'classes', 'assessments', 'terms'].map(async c =>
      `${c}=${(await school.collection(c).count().get()).data().count}`))
  console.log(`Seeded ${SCHOOL}: ${counts.join(' ')}`)
  console.log(`Sign in as ${email} / emulator-password`)
}

seed().catch(e => { console.error(e); process.exit(1) })
