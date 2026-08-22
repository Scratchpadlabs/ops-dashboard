/**
 * Behaviour check for src/utils/classSubjects.js — the shape of a
 * `classes/{classId}.subjects[]` entry and the merge rules around it.
 *
 *     node tools/check_class_subjects.mjs
 *
 * The template is pinned against a real teacher-populated class doc
 * (SAMARTH DNYANPEETH SAHAYDRI / classes/III_A). The point of pinning it is
 * that School Setup and the teacher app read the same array: a topic id or
 * label that drifts from live data silently produces classes the app can't
 * render, which is exactly what happened when the template was written from
 * the spec's prose instead of a live doc.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const {
  defaultTopicsForSubject, newClassSubjectEntry,
  mergeClassSubjects, appendClassSubjects, detachClassSubject,
} = await import(path.join(ROOT, 'src/utils/classSubjects.js'))

let failures = 0
const check = (label, cond, extra) => {
  if (cond) console.log(`  ok   ${label}`)
  else { failures++; console.log(`  FAIL ${label}`, extra !== undefined ? JSON.stringify(extra) : '') }
}

// ── The reference doc ───────────────────────────────────────────────────────
// classes/III_A.subjects[0] as it exists in SAMARTH, minus the state the
// teacher app writes (isCompleted/completedAt/absentList).
const REFERENCE_TOPIC_IDS = ['III_English_Term1', 'III_English_Term2', 'III_English_Optional']
const REFERENCE_TOPIC_LABELS = ['Term 1 Activity', 'Term 2 Activity', 'Optional Activity']

const topics = defaultTopicsForSubject('III_English')
check('three topics per subject', topics.length === 3, topics.length)
check('topic ids match the live doc', topics.map(t => t.id).join(',') === REFERENCE_TOPIC_IDS.join(','), topics.map(t => t.id))
check('topic labels match the live doc', topics.map(t => t.topic).join(',') === REFERENCE_TOPIC_LABELS.join(','), topics.map(t => t.topic))
check('topics start incomplete', topics.every(t => t.isCompleted === false && t.completedAt === null))
// absentList is written by the teacher app when a topic is completed; seeding
// it here would put a field on fresh docs that live ones don't carry yet.
check('no absentList is seeded', topics.every(t => !('absentList' in t)))

const entry = newClassSubjectEntry('III_English')
check('entry fields match the live doc',
  Object.keys(entry).sort().join(',') === 'completedAt,isCompleted,subjectId,teacherId,topics',
  Object.keys(entry).sort())
check('teacherId starts empty (assignments live on staffs)', entry.teacherId === '')

// ── merge, never clobber ────────────────────────────────────────────────────
const taught = {
  subjectId: 'III_English', teacherId: '', isCompleted: true, completedAt: 'TS',
  topics: [{ id: 'III_English_Term1', topic: 'Term 1 Activity', isCompleted: true, completedAt: 'TS', absentList: ['s1'] }],
}
const merged = mergeClassSubjects([taught], ['III_English', 'III_Maths'])
check('merge keeps an already-attached entry byte-for-byte', merged[0] === taught)
check('merge adds the newly checked subject', merged[1].subjectId === 'III_Maths' && merged[1].topics.length === 3)

const dropped = mergeClassSubjects([taught], ['III_Maths'])
check('merge drops an unchecked subject', dropped.length === 1 && dropped[0].subjectId === 'III_Maths')

// ── append: additive only ───────────────────────────────────────────────────
const appended = appendClassSubjects([taught], ['III_English', 'III_Maths'])
check('append leaves an existing entry untouched', appended[0] === taught)
check('append only adds what is missing', appended.length === 2 && appended[1].subjectId === 'III_Maths')
check('append returns null when there is nothing to add', appendClassSubjects([taught], ['III_English']) === null)
check('append handles a class with no subjects field', appendClassSubjects(undefined, ['I_Hindi']).length === 1)

// ── detach ──────────────────────────────────────────────────────────────────
check('detach removes the subject', detachClassSubject([taught], 'III_English').length === 0)
check('detach returns null when the subject was not attached', detachClassSubject([taught], 'III_Maths') === null)
check('detach handles a class with no subjects field', detachClassSubject(null, 'III_Maths') === null)

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed')
process.exit(failures ? 1 : 0)
