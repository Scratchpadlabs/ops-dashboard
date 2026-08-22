/**
 * Behaviour check for src/utils/assessmentImport.js — how an exam-blueprint
 * row becomes assessment documents.
 *
 *     node tools/check_assessment_import.mjs
 *
 * The two cases that produced the wrong data at Hillgreen are pinned first:
 * the composite marks cell, and resolving a row's subjects from its grade band
 * rather than from the assessment's own name.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { parseMarksCell, parseMaxMarks, resolveBlueprintSubjects, expandGradeBand } =
  await import(path.join(ROOT, 'src/utils/assessmentImport.js'))

let failures = 0
const check = (label, cond, extra) => {
  if (cond) console.log(`  ok   ${label}`)
  else { failures++; console.log(`  FAIL ${label}`, extra !== undefined ? JSON.stringify(extra) : '') }
}

// ── parseMarksCell ──────────────────────────────────────────────────────────
// THE bug: the old digit-strip turned "80 (40+40)" into 804040.
check('composite "80 (40+40)" reads as 80', parseMarksCell('80 (40+40)').value === 80, parseMarksCell('80 (40+40)'))
check('composite without a space reads as 80', parseMarksCell('80(40+40)').value === 80)
check('a bare sum "40+40" is the total 80', parseMarksCell('40+40').value === 80)
check('a bracket-only "(40+40)" is 80', parseMarksCell('(40+40)').value === 80)
check('"80 marks" reads as 80', parseMarksCell('80 marks').value === 80)
check('a decimal survives', parseMarksCell('7.5').value === 7.5)
check('blank is null', parseMarksCell('').value === null)
check('text with no digits is null', parseMarksCell('NA').value === null)
check('zero is not a usable maximum', parseMarksCell('0').value === null)
check('a breakdown that does not add up is reported',
  /adds to 90/.test(parseMarksCell('80 (40+50)').note), parseMarksCell('80 (40+50)').note)

// ── parseMaxMarks ───────────────────────────────────────────────────────────
check('an explicit total wins', parseMaxMarks({ total: '100', max_written: '80', activity_weight: '20' }).maxMarks === 100)
check('written + activity when there is no total',
  parseMaxMarks({ max_written: '80', activity_weight: '20' }).maxMarks === 100)
check('written alone', parseMaxMarks({ max_written: '80 (40+40)' }).maxMarks === 80)
check('the source column is reported',
  parseMaxMarks({ max_written: '80', activity_weight: '20' }).source === 'max_written + activity_weight')
check('a total that disagrees with the parts is reported',
  parseMaxMarks({ total: '100', max_written: '80', activity_weight: '30' }).notes.some(n => /used total/.test(n)))
check('an empty row yields no marks', parseMaxMarks({}).maxMarks === null)

// ── grade bands ─────────────────────────────────────────────────────────────
const known = ['Nursery', 'LKG', 'UKG', '1', '2', '3', '4', '5']
const norm = g => String(g ?? '').trim()
check('a single grade', expandGradeBand('3', { normalizeGrade: norm, knownGrades: known }).join(',') === '3')
check('a numeric range', expandGradeBand('3-5', { normalizeGrade: norm, knownGrades: known }).join(',') === '3,4,5')
check('a "to" range', expandGradeBand('3 to 5', { normalizeGrade: norm, knownGrades: known }).join(',') === '3,4,5')
// Resolved against the grades the school HAS, so pre-primary works like the rest.
check('a pre-primary range', expandGradeBand('Nursery-UKG', { normalizeGrade: norm, knownGrades: known }).join(',') === 'Nursery,LKG,UKG')
check('a reversed range still spans it', expandGradeBand('5-3', { normalizeGrade: norm, knownGrades: known }).join(',') === '3,4,5')
check('a comma list', expandGradeBand('1,3,5', { normalizeGrade: norm, knownGrades: known }).join(',') === '1,3,5')
check('an unknown grade is not invented', expandGradeBand('11-12', { normalizeGrade: norm, knownGrades: known }).length === 0)
check('blank is empty', expandGradeBand('', { normalizeGrade: norm, knownGrades: known }).length === 0)

// ── resolveBlueprintSubjects ────────────────────────────────────────────────
const subjectsByGrade = new Map([
  ['3', ['III_English', 'III_Maths']],
  ['4', ['IV_English', 'IV_Maths']],
])
const subjectLookup = new Map([
  ['3|english', 'III_English'], ['3|maths', 'III_Maths'],
  ['4|english', 'IV_English'], ['4|maths', 'IV_Maths'],
])
const opts = { normalizeGrade: norm, subjectsByGrade, subjectLookup }

// THE bug: "Term 1 Exam" used to be matched against subject NAMES, so it
// resolved to nothing (or, when a row was named "English", to that subject —
// which is how assessments ended up named after subjects).
const wide = resolveBlueprintSubjects({ grade_band: '3', assessment: 'Term 1 Exam' }, opts)
check('a grade-wide row fans out over that grade', wide.subjectIds.join(',') === 'III_English,III_Maths', wide)
check('the assessment name never selects the subject',
  resolveBlueprintSubjects({ grade_band: '3', assessment: 'English' }, opts).subjectIds.length === 2)

const banded = resolveBlueprintSubjects({ grade_band: '3-4', assessment: 'Term 1 Exam' }, opts)
check('a banded row covers every grade in the band',
  banded.subjectIds.join(',') === 'III_English,III_Maths,IV_English,IV_Maths', banded)

const named = resolveBlueprintSubjects({ grade_band: '3', subject: 'Maths', assessment: 'Unit Test' }, opts)
check('an explicit subject column wins', named.subjectIds.join(',') === 'III_Maths', named)
check('an explicit subject is reported as the reason', /subject column/.test(named.reason))

const missing = resolveBlueprintSubjects({ grade_band: '3', subject: 'Sanskrit', assessment: 'Unit Test' }, opts)
check('a named subject the grade lacks resolves to nothing', missing.subjectIds.length === 0)
check('...and says so', /no subject "Sanskrit"/.test(missing.reason), missing.reason)

const noBand = resolveBlueprintSubjects({ assessment: 'Term 1 Exam' }, opts)
check('a row with no grade band resolves to nothing', noBand.subjectIds.length === 0)
check('...and says why', /no grade band/.test(noBand.reason), noBand.reason)

// `stream` is the fallback band column in the extractor's row shape.
check('stream is used when grade_band is empty',
  resolveBlueprintSubjects({ stream: '4', assessment: 'Term 1 Exam' }, opts).subjectIds.join(',') === 'IV_English,IV_Maths')

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed')
process.exit(failures ? 1 : 0)
