/**
 * Structure inference — "propose this school's setup from its own data".
 *
 * Reads staged/committed import rows and works out what the school's
 * structure must be: which grades and sections exist (with student counts as
 * evidence), which subjects are taught and whether each is scholastic or
 * co-scholastic (via the shared education knowledge base), and which subjects
 * belong to which class.
 *
 * Two hard rules:
 *   - NEVER WRITES. This module returns a PROPOSAL. Applying it is a separate,
 *     explicit step after a human has reviewed every item (StructureTab.vue).
 *   - INCREMENTAL BY CONSTRUCTION. Everything is diffed against the school's
 *     existing setup, so re-running after a new import proposes only what
 *     actually changed instead of restating the whole structure. That is why
 *     each item carries a `status` (new | existing | conflict) rather than
 *     the caller having to work it out.
 *
 * Pure and dependency-light — no Firestore, no Vue. The UI supplies the data
 * and performs the writes.
 */
import { classify, SUBJECT, COSCHOLASTIC, SECTION, GRADE, UNKNOWN } from './educationKB.js'

// Grade/section normalization is the KB's, identical to the import parser's,
// so a class inferred here matches the class an import row resolves to.
function normGrade(g) {
  const s = (g || '').trim()
  if (!s) return ''
  const r = classify(s, { expect: GRADE })
  return r.type === GRADE && r.canonical ? r.canonical : s.toUpperCase()
}
function normSection(s) {
  return (s || '').trim().toUpperCase()
}
function slugPart(s) {
  return (s || '').trim().replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '')
}

export const STATUS_NEW = 'new'
export const STATUS_EXISTING = 'existing'
export const STATUS_CONFLICT = 'conflict'

/**
 * @param {Object}   input
 * @param {Array}    input.studentRows  [{grade, section, student_name}]
 * @param {Array}    input.teacherRows  [{teacher_name, email, subject, grade, section, class_teacher_of}]
 * @param {Object}   input.existing     {classes, subjects, staffs} straight from Firestore
 * @param {Map}      [input.overlay]    learned KB overlay
 * @returns {{classes, subjects, classSubjects, flags, evidence}}
 */
export function inferStructure({ studentRows = [], teacherRows = [], existing = {}, overlay = null } = {}) {
  const existingClasses = existing.classes || []
  const existingSubjects = existing.subjects || []
  const existingStaffs = existing.staffs || []

  // ── Existing setup, keyed the way inference will look it up ───────────────
  const classByKey = new Map()
  for (const c of existingClasses) {
    classByKey.set(`${normGrade(c.clazz)}|${normSection(c.section)}`, c)
  }
  const subjectByKey = new Map()
  for (const s of existingSubjects) {
    const grade = normGrade(s.id?.includes('_') ? s.id.split('_')[0] : '')
    subjectByKey.set(`${grade}|${(s.name || '').trim().toLowerCase()}`, s)
  }

  // ── Grades + sections from student data ───────────────────────────────────
  const classAgg = new Map() // key -> {clazz, section, studentCount}
  for (const r of studentRows) {
    const grade = normGrade(r.grade)
    if (!grade) continue
    const section = normSection(r.section)
    const key = `${grade}|${section}`
    if (!classAgg.has(key)) classAgg.set(key, { grade, section, studentCount: 0, fromStudents: true, fromTeachers: false })
    classAgg.get(key).studentCount++
  }

  // Teacher rows can reveal a section student data never mentioned — that is
  // a finding worth surfacing, not a class to silently create, so it is
  // recorded here and flagged below.
  for (const r of teacherRows) {
    const grade = normGrade(r.grade)
    if (!grade) continue
    const section = normSection(r.section)
    const key = `${grade}|${section}`
    if (!classAgg.has(key)) {
      classAgg.set(key, { grade, section, studentCount: 0, fromStudents: false, fromTeachers: true })
    } else {
      classAgg.get(key).fromTeachers = true
    }
  }

  const classes = Array.from(classAgg.entries())
    .filter(([, v]) => v.section) // a grade with no section can't become a class doc
    .map(([key, v]) => {
      const found = classByKey.get(key)
      return {
        key,
        clazz: v.grade,
        section: v.section,
        docId: found?.id || `${v.grade}_${v.section}`,
        studentCount: v.studentCount,
        fromStudents: v.fromStudents,
        fromTeachers: v.fromTeachers,
        status: found ? STATUS_EXISTING : STATUS_NEW,
        existingId: found?.id || null,
        // Default the proposal to accepting genuinely new classes only —
        // an existing class needs no action.
        accepted: !found,
      }
    })
    .sort((a, b) => gradeOrder(a.clazz) - gradeOrder(b.clazz) || a.section.localeCompare(b.section))

  // ── Subjects from teacher data, split by the knowledge base ───────────────
  const subjAgg = new Map() // `${grade}|${canonicalLower}` -> {...}
  for (const r of teacherRows) {
    const grade = normGrade(r.grade)
    const rawSubject = (r.subject || '').replace(/\?$/, '').trim()
    if (!grade || !rawSubject) continue

    const kb = classify(rawSubject, { expect: SUBJECT, overlay })
    const recognized = kb.type === SUBJECT || kb.type === COSCHOLASTIC
    const highConfidence = recognized && kb.confidence >= 0.95
    // Only a confident KB answer renames the subject; anything less keeps
    // the school's own wording and leaves `area` blank for a human to set.
    const name = highConfidence ? kb.canonical : rawSubject
    const area = highConfidence ? (kb.type === SUBJECT ? 'Scholastic' : 'Co-Scholastic') : ''

    const key = `${grade}|${name.toLowerCase()}`
    if (!subjAgg.has(key)) {
      subjAgg.set(key, {
        grade, name, area, rawNames: new Set(), teachers: new Set(), sections: new Set(),
        kbType: recognized ? kb.type : UNKNOWN, kbConfidence: kb.confidence,
      })
    }
    const agg = subjAgg.get(key)
    agg.rawNames.add(rawSubject)
    if (r.teacher_name) agg.teachers.add(r.teacher_name.trim().toLowerCase())
    if (normSection(r.section)) agg.sections.add(normSection(r.section))
  }

  const subjects = Array.from(subjAgg.entries()).map(([key, v]) => {
    const found = subjectByKey.get(key)
    // A subject the school already has but filed on the other side of the
    // scholastic line is a real disagreement — surface it, don't overwrite.
    const areaConflict = !!found && !!v.area && !!found.area && found.area !== v.area
    return {
      key,
      grade: v.grade,
      name: v.name,
      area: v.area,
      docId: found?.id || `${slugPart(v.grade)}_${slugPart(v.name)}`,
      rawNames: Array.from(v.rawNames),
      teacherCount: v.teachers.size,
      sections: Array.from(v.sections).sort(),
      unclassified: !v.area,
      status: areaConflict ? STATUS_CONFLICT : (found ? STATUS_EXISTING : STATUS_NEW),
      existingArea: found?.area || '',
      existingId: found?.id || null,
      accepted: !found,
    }
  }).sort((a, b) => gradeOrder(a.grade) - gradeOrder(b.grade) || a.name.localeCompare(b.name))

  // ── Subject ↔ class mappings from teacher data ────────────────────────────
  const mapAgg = new Map()
  for (const r of teacherRows) {
    const grade = normGrade(r.grade)
    const section = normSection(r.section)
    const rawSubject = (r.subject || '').replace(/\?$/, '').trim()
    if (!grade || !section || !rawSubject) continue
    const kb = classify(rawSubject, { expect: SUBJECT, overlay })
    const name = (kb.confidence >= 0.95 && kb.canonical) ? kb.canonical : rawSubject
    const classKey = `${grade}|${section}`
    const subjectKey = `${grade}|${name.toLowerCase()}`
    const key = `${classKey}::${subjectKey}`
    if (!mapAgg.has(key)) mapAgg.set(key, { classKey, subjectKey, grade, section, name, teachers: new Set() })
    if (r.teacher_name) mapAgg.get(key).teachers.add(r.teacher_name.trim())
  }

  const classSubjects = Array.from(mapAgg.values()).map(v => {
    const cls = classByKey.get(v.classKey)
    const subj = subjectByKey.get(v.subjectKey)
    const alreadyAttached = !!cls && !!subj &&
      (cls.subjects || []).some(s => s.subjectId === subj.id)
    return {
      ...v,
      teachers: Array.from(v.teachers).sort(),
      status: alreadyAttached ? STATUS_EXISTING : STATUS_NEW,
      accepted: !alreadyAttached,
    }
  }).sort((a, b) => gradeOrder(a.grade) - gradeOrder(b.grade) || a.section.localeCompare(b.section) || a.name.localeCompare(b.name))

  return {
    classes,
    subjects,
    classSubjects,
    flags: buildFlags({ classes, subjects, classSubjects, studentRows, teacherRows, existingStaffs, classByKey }),
    evidence: {
      studentRows: studentRows.length,
      teacherRows: teacherRows.length,
      gradesSeen: new Set(classes.map(c => c.clazz)).size,
    },
  }
}

/**
 * The findings that make this an inspection rather than a bulk-add: places
 * where the school's data disagrees with itself or with its setup. Every one
 * is advisory — nothing here blocks applying the proposal.
 */
function buildFlags({ classes, subjects, classSubjects, studentRows, teacherRows, existingStaffs, classByKey }) {
  const flags = []

  // Class teachers, from the import's own class_teacher_of column plus any
  // already recorded in the school's staff assignments.
  const classTeacherKeys = new Set()
  for (const r of teacherRows) {
    const raw = (r.class_teacher_of || '').trim()
    if (!raw) continue
    const m = raw.match(/^\s*(.+?)\s*[-_\s]\s*([A-Za-z0-9]+)\s*$/)
    if (m) classTeacherKeys.add(`${normGrade(m[1])}|${normSection(m[2])}`)
  }
  for (const s of existingStaffs) {
    for (const cid of s.classIds || []) {
      const [g, sec] = String(cid).split('_')
      if (g && sec) classTeacherKeys.add(`${normGrade(g)}|${normSection(sec)}`)
    }
  }

  for (const c of classes) {
    if (c.studentCount > 0 && !classTeacherKeys.has(c.key)) {
      flags.push({
        kind: 'no_class_teacher', severity: 'warning',
        message: `${c.clazz}-${c.section} has ${c.studentCount} student${c.studentCount !== 1 ? 's' : ''} but no class teacher in the data.`,
      })
    }
    if (!c.fromStudents && c.fromTeachers) {
      flags.push({
        kind: 'section_without_students', severity: 'warning',
        message: `${c.clazz}-${c.section} appears in teacher data but has no students — check the student import covers this section.`,
      })
    }
  }

  // Core (scholastic) subjects nobody teaches, per grade.
  const taughtByGrade = new Map()
  for (const m of classSubjects) {
    if (!taughtByGrade.has(m.grade)) taughtByGrade.set(m.grade, new Set())
    taughtByGrade.get(m.grade).add(m.name.toLowerCase())
  }
  for (const s of subjects) {
    if (s.area !== 'Scholastic') continue
    if (s.teacherCount === 0) {
      flags.push({
        kind: 'subject_without_teacher', severity: 'warning',
        message: `Grade ${s.grade} · ${s.name} has no teacher assigned in the data.`,
      })
    }
  }

  // Grades with students but not a single subject inferred for them.
  const gradesWithStudents = new Set(classes.filter(c => c.studentCount > 0).map(c => c.clazz))
  const gradesWithSubjects = new Set(subjects.map(s => s.grade))
  for (const g of gradesWithStudents) {
    if (!gradesWithSubjects.has(g)) {
      flags.push({
        kind: 'grade_without_subjects', severity: 'warning',
        message: `Grade ${g} has students but no subjects could be inferred — import its teacher data to complete the picture.`,
      })
    }
  }

  // Subject names the KB couldn't place at all.
  for (const s of subjects) {
    if (s.unclassified) {
      flags.push({
        kind: 'unclassified_subject', severity: 'info',
        message: `“${s.name}” (grade ${s.grade}) isn't in the knowledge base — set Scholastic/Co-Scholastic below, or classify it once in School Setup to teach every school.`,
      })
    }
  }

  if (!studentRows.length) {
    flags.push({ kind: 'no_student_data', severity: 'info',
      message: 'No student rows in the selected imports — grades and sections cannot be inferred without them.' })
  }
  if (!teacherRows.length) {
    flags.push({ kind: 'no_teacher_data', severity: 'info',
      message: 'No teacher rows in the selected imports — subjects and subject-class mappings cannot be inferred without them.' })
  }

  return flags
}

// Nursery < LKG < UKG < 1..12, so proposals read in school order rather than
// alphabetically ('10' before '2').
const PRE_PRIMARY_ORDER = { 'Pre-Nursery': -4, Nursery: -3, LKG: -2, UKG: -1 }
export function gradeOrder(grade) {
  if (grade in PRE_PRIMARY_ORDER) return PRE_PRIMARY_ORDER[grade]
  const n = parseInt(grade, 10)
  return Number.isFinite(n) ? n : 99
}

/** Counts for the proposal header — accepted items only. */
export function proposalSummary(proposal) {
  const count = (list) => list.filter(i => i.accepted && i.status !== STATUS_EXISTING).length
  return {
    classes: count(proposal.classes),
    subjects: count(proposal.subjects),
    mappings: count(proposal.classSubjects),
    conflicts: proposal.subjects.filter(s => s.status === STATUS_CONFLICT).length,
    flags: proposal.flags.length,
  }
}
