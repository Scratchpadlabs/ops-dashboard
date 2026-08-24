/**
 * Generate a school's assessment config as CSVs the School Setup tabs import.
 *
 *     node tools/build_school_assessments.mjs \
 *       --pattern tools/patterns/hillgreen.json \
 *       --subjects hillgreen_subjects.csv \
 *       --out build/hillgreen-config
 *
 * The pattern JSON is the school's own marks scheme, transcribed once. The
 * subjects CSV is the Subjects tab's own "Export CSV" — so the subject IDs
 * this writes are the school's real ones, never guessed.
 *
 * WHY A GENERATOR AND NOT THE BULK BUILDER: the builder applies ONE set of
 * max-marks/conversion values across the subjects you tick. Hillgreen's scheme
 * varies those values by grade band (a class 3 PT 2 paper is out of 60, a class
 * 6 one out of 80), so the builder would need one pass per band per exam per
 * term — 20 passes, each a chance to mistype a conversion factor. Assessment
 * doc IDs can never be renamed once marks exist (AUDIT.md §4), so a typo here
 * is permanent.
 *
 * The output is plain CSV for the existing Import buttons. This tool never
 * touches Firestore.
 *
 * Loads the REAL classResolver with only its JSON import line rewritten (Vite
 * resolves bare JSON imports, plain Node does not) — same trick as
 * tools/check_derive_classes.mjs, so grades parse here exactly as they do in
 * the dashboard.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Papa from 'papaparse'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'assess-'))
fs.writeFileSync(path.join(TMP, 'seed.json'),
  fs.readFileSync(path.join(ROOT, 'functions/generate_import/education_kb.json'), 'utf8'))
let resolverSrc = fs.readFileSync(path.join(ROOT, 'src/utils/classResolver.js'), 'utf8')
resolverSrc = resolverSrc.replace(/import SEED from ['"][^'"]+['"]/,
  `import fs from 'node:fs'\nconst SEED = JSON.parse(fs.readFileSync('${path.join(TMP, 'seed.json')}','utf8'))`)
fs.writeFileSync(path.join(TMP, 'classResolver.js'), resolverSrc)
const { parseClassValue } = await import(path.join(TMP, 'classResolver.js'))

// ── Column sets — must stay identical to the tabs that import them ─────────
// AssessmentsTab.vue ASSESSMENT_CSV_COLUMNS
const ASSESSMENT_COLUMNS = ['name', 'subjectId', 'termId', 'order', 'entryType', 'maxMarks', 'gradingScaleId', 'conversionType', 'conversionFactor']
// CoScholasticTab.vue ACTIVITY_CSV_COLUMNS
const ACTIVITY_COLUMNS = ['name', 'termId', 'order', 'entryType', 'maxMarks', 'gradingScaleId', 'conversionType', 'conversionFactor']
// TermsScalesTab.vue TERM_CSV_COLUMNS / SCALE_CSV_COLUMNS
const TERM_COLUMNS = ['name', 'academicYear', 'isActive']
const SCALE_COLUMNS = ['scaleName', 'label', 'minPercent', 'maxPercent']

/** AssessmentsTab.vue / assessmentHelpers.js slugify — doc IDs depend on it. */
function slugify(text) {
  return (text || '').trim().replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '')
}

/** TermsScalesTab.vue classifyTermRow builds term doc IDs this way. */
const termDocId = (name, academicYear) => `${slugify(name)}_${slugify(academicYear)}`
/** TermsScalesTab.vue onScaleFileChange builds scale doc IDs this way. */
const scaleDocId = name => slugify(name)
/** AssessmentsTab.vue runBuilder / runImport build assessment doc IDs this way. */
const assessmentDocId = (subjectId, termId, name) => `${subjectId}_${termId}_${slugify(name)}`

/**
 * Express written -> convertedTo as the tab's conversion fields.
 *
 * conversionFactor is capped at 2 decimals in the UI (:maxFractionDigits="2"),
 * so a ratio needing more precision has to be expressed from the other side:
 * 60 -> 80 is not sum_up 1.33 (that yields 79.8), it is sum_down 0.75, which
 * AssessmentsTab renders as `maxMarks / factor` = exactly 80.
 */
function conversionFor(written, convertedTo) {
  if (written === convertedTo) return { conversionType: 'none', conversionFactor: '' }
  const exactAt2dp = n => Number(n.toFixed(2)) === n
  const up = convertedTo / written
  if (exactAt2dp(up)) return { conversionType: 'sum_up', conversionFactor: up }
  const down = written / convertedTo
  if (exactAt2dp(down)) return { conversionType: 'sum_down', conversionFactor: down }
  throw new Error(`Cannot express ${written} -> ${convertedTo} within 2 decimal places (sum_up ${up}, sum_down ${down})`)
}

function argOf(flag, fallback = null) {
  const i = process.argv.indexOf(flag)
  if (i === -1 || i === process.argv.length - 1) return fallback
  return process.argv[i + 1]
}

const patternPath = argOf('--pattern')
const subjectsPath = argOf('--subjects')
const outDir = argOf('--out', 'build/school-config')
if (!patternPath || !subjectsPath) {
  console.error('usage: node tools/build_school_assessments.mjs --pattern <pattern.json> --subjects <subjects.csv> [--out <dir>]')
  process.exit(2)
}

const pattern = JSON.parse(fs.readFileSync(patternPath, 'utf8'))
const { rows: subjectRows, errors } = (() => {
  const text = fs.readFileSync(subjectsPath, 'utf8').trim()
  const r = Papa.parse(text, { header: true, skipEmptyLines: true, transformHeader: h => h.trim() })
  return { rows: r.data, errors: r.errors }
})()
if (errors.length) console.warn(`! ${errors.length} CSV parse warning(s) in ${subjectsPath}`)

const termIdOf = new Map(pattern.terms.map(t => [t.name, termDocId(t.name, t.academicYear)]))
const scholasticScaleId = scaleDocId(pattern.scales.scholastic.name)
const coScholasticScaleId = scaleDocId(pattern.scales.coScholastic.name)

const warnings = []
const skipped = []
const pending = []
const pendingBands = new Set()

/** Grade band for an ordinal, or null when the pattern does not cover it. */
function bandFor(ordinal) {
  return pattern.bands.find(b => ordinal >= b.minGrade && ordinal <= b.maxGrade) || null
}

/** An override replaces an exam's marks split for particular subjects. */
function overrideFor(subjectName, exam) {
  const total = exam.convertedTo + exam.internal
  const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  return (pattern.subjectOverrides || []).find(o =>
    o.appliesToExamTotal === total && o.match.some(m => norm(m) === norm(subjectName))
  ) || null
}

// ── Assessments ───────────────────────────────────────────────────────────
const assessments = []
for (const row of subjectRows) {
  const subjectId = (row.id || '').trim()
  const subjectName = (row.name || '').trim()
  if (!subjectId) continue

  // Co-Scholastic records are co_scholastic_activities docs, never subjects
  // docs (AUDIT.md §3.1) — they get their own file below.
  if ((row.area || '').toLowerCase().replace(/[^a-z]/g, '') === 'coscholastic') continue

  const parsed = parseClassValue(row.grade || subjectId.split('_')[0])
  const ordinal = parsed.gradeOrdinal
  if (ordinal === null) { skipped.push(`${subjectId}: grade "${row.grade || ''}" not recognised`); continue }
  if (ordinal < 1) { skipped.push(`${subjectId}: pre-primary (${parsed.gradeCanonical}) — the marks scheme starts at grade 1`); continue }

  const band = bandFor(ordinal)
  if (!band) { skipped.push(`${subjectId}: grade ${ordinal} is outside every band in the pattern`); continue }

  // A band the school has not confirmed emits nothing. Assessment doc IDs can
  // never be renamed once marks exist (AUDIT.md §4), so a guess that turns out
  // wrong cannot be corrected in place — the wrong docs have to be deleted and
  // any marks entered against them are orphaned. Better to ship no rows.
  if (band.pending) { pending.push(subjectId); pendingBands.add(band.id); continue }

  // The Subjects tab already records whether a subject is marked or graded.
  // A graded subject (Hillgreen's "Scholastic Areas II", e.g. IX Marathi) is
  // one column per exam, not a written/internal pair — there are no marks to
  // convert.
  const isGraded = (row.entryType || 'marks').trim() === 'grade'

  const orderByTerm = new Map()
  for (const exam of band.exams) {
    const termId = termIdOf.get(exam.term)
    if (!termId) throw new Error(`Pattern band ${band.id} references unknown term "${exam.term}"`)
    const next = () => { const n = (orderByTerm.get(termId) || 0) + 1; orderByTerm.set(termId, n); return n }

    const ov = overrideFor(subjectName, exam)
    const written = ov ? ov.written : exam.written
    const convertedTo = ov ? ov.convertedTo : exam.convertedTo
    const internal = ov ? ov.internal : exam.internal

    if (isGraded) {
      assessments.push({
        name: exam.name, subjectId, termId, order: next(),
        entryType: 'grade', maxMarks: convertedTo + internal,
        gradingScaleId: scholasticScaleId, conversionType: 'none', conversionFactor: '',
      })
      continue
    }

    let conv
    try {
      conv = conversionFor(written, convertedTo)
    } catch (e) {
      throw new Error(`${subjectId} / ${exam.name}: ${e.message}`)
    }
    assessments.push({
      name: `${exam.name} Written`, subjectId, termId, order: next(),
      entryType: 'marks', maxMarks: written, gradingScaleId: '', ...conv,
    })
    if (internal > 0) {
      assessments.push({
        name: `${exam.name} Internal`, subjectId, termId, order: next(),
        entryType: 'marks', maxMarks: internal, gradingScaleId: '',
        conversionType: 'none', conversionFactor: '',
      })
    }
  }
}

// ── Co-scholastic ─────────────────────────────────────────────────────────
// co_scholastic_activities is term-wide with no exam dimension, and its doc ID
// is `{termId}_{slug(name)}` — so an activity graded at two exams in one term
// needs the exam baked into the NAME or the second doc overwrites the first.
const activities = []
{
  const examNamesByTerm = new Map()
  for (const band of pattern.bands) {
    // A pending band contributes no columns here either. Its exam names are a
    // guess, and co-scholastic has no grade dimension to confine them to — an
    // unconfirmed "Prelim" would show up as a column for every grade.
    if (band.pending) continue
    for (const exam of band.exams) {
      const termId = termIdOf.get(exam.term)
      if (!examNamesByTerm.has(termId)) examNamesByTerm.set(termId, new Set())
      examNamesByTerm.get(termId).add(exam.name)
    }
  }
  for (const [termId, examNames] of examNamesByTerm) {
    let order = 0
    for (const activity of pattern.coScholastic.activities) {
      for (const examName of [...examNames].sort()) {
        activities.push({
          name: `${activity} ${examName}`, termId, order: ++order,
          // maxMarks is unused for a graded item but must be > 0. 10 is the
          // default the Co-Scholastic CSV import itself applies (spec §3.3).
          entryType: 'grade', maxMarks: 10, gradingScaleId: coScholasticScaleId,
          conversionType: 'none', conversionFactor: '',
        })
      }
    }
  }
}

// ── Validation ────────────────────────────────────────────────────────────
// Mirrors AssessmentsTab.validateAssessmentFields plus the doc-ID uniqueness
// the tabs cannot check for you (a collision silently merges two assessments
// into one doc, and the loser's column disappears from every teacher's sheet).
let failures = 0
const fail = msg => { failures++; console.error(`  FAIL ${msg}`) }

const seenIds = new Map()
for (const a of assessments) {
  if (!a.name) fail(`${a.subjectId}: assessment with no name`)
  if (!(a.maxMarks > 0)) fail(`${a.subjectId} / ${a.name}: maxMarks must be > 0`)
  if (a.conversionType !== 'none' && a.conversionType !== 'marks_to_grade' && !a.conversionFactor) {
    fail(`${a.subjectId} / ${a.name}: conversionFactor required for ${a.conversionType}`)
  }
  if ((a.conversionType === 'marks_to_grade' || a.entryType === 'grade') && !a.gradingScaleId) {
    fail(`${a.subjectId} / ${a.name}: gradingScaleId required`)
  }
  const id = assessmentDocId(a.subjectId, a.termId, a.name)
  if (seenIds.has(id)) fail(`doc ID collision "${id}" — "${seenIds.get(id)}" and "${a.name}"`)
  else seenIds.set(id, a.name)
}

const seenActivityIds = new Map()
for (const a of activities) {
  const id = `${a.termId}_${slugify(a.name)}`
  if (seenActivityIds.has(id)) fail(`co-scholastic doc ID collision "${id}"`)
  else seenActivityIds.set(id, a.name)
}

// Every band's exams must total what the model report cards print.
for (const band of pattern.bands) {
  const byTerm = new Map()
  for (const exam of band.exams) {
    const total = exam.convertedTo + exam.internal
    byTerm.set(exam.term, (byTerm.get(exam.term) || 0) + total)
  }
  for (const [term, total] of byTerm) {
    if (band.expectedTermTotal && total !== band.expectedTermTotal[term]) {
      fail(`band ${band.id} / ${term}: exams total ${total}, report card says ${band.expectedTermTotal[term]}`)
    }
  }
}

for (const s of pattern.scales ? Object.values(pattern.scales) : []) {
  const sorted = [...s.levels].sort((a, b) => a.minPercent - b.minPercent)
  if (sorted[0].minPercent !== 0) fail(`scale "${s.name}" does not start at 0%`)
  if (sorted[sorted.length - 1].maxPercent !== 100) fail(`scale "${s.name}" does not end at 100%`)
  for (let i = 1; i < sorted.length; i++) {
    // TermsScalesTab.validateLevelsCoverage requires integer-contiguous bands.
    if (sorted[i].minPercent !== sorted[i - 1].maxPercent + 1) {
      fail(`scale "${s.name}": gap or overlap between "${sorted[i - 1].label}" and "${sorted[i].label}"`)
    }
  }
}

// ── Write ─────────────────────────────────────────────────────────────────
const write = (file, rows, columns) => {
  const full = path.join(outDir, file)
  fs.writeFileSync(full, Papa.unparse({ fields: columns, data: rows.map(r => columns.map(c => r[c] ?? '')) }))
  console.log(`  ${String(rows.length).padStart(5)} rows  ${full}`)
}

fs.mkdirSync(outDir, { recursive: true })
console.log(`\n${pattern.school} — ${pattern.academicYear}\n`)
write('1_terms.csv', pattern.terms.map(t => ({ ...t, isActive: String(t.isActive) })), TERM_COLUMNS)
write('2_grading_scales.csv', Object.values(pattern.scales).flatMap(s =>
  s.levels.map(l => ({ scaleName: s.name, ...l }))), SCALE_COLUMNS)
write('3_assessments.csv', assessments, ASSESSMENT_COLUMNS)
write('4_co_scholastic.csv', activities, ACTIVITY_COLUMNS)

console.log(`\nImport in this order — each file references IDs the previous one creates:`)
console.log(`  1_terms.csv           Terms & Scales tab -> Terms -> Import CSV`)
console.log(`  2_grading_scales.csv  Terms & Scales tab -> Grading Scales -> Import CSV`)
console.log(`  3_assessments.csv     Assessments tab -> Import CSV`)
console.log(`  4_co_scholastic.csv   Co-Scholastic tab -> Import CSV`)
console.log(`\nTerm doc IDs: ${[...termIdOf.values()].join(', ')}`)
console.log(`Scale doc IDs: ${scholasticScaleId}, ${coScholasticScaleId}`)

if (pending.length) {
  console.log(`\n${pending.length} subject(s) NOT emitted — band(s) awaiting confirmation: ${[...pendingBands].join(', ')}`)
  console.log(`  Import what is here, or wait — re-running after the pattern is confirmed`)
  console.log(`  only ADDS rows, it never changes an ID already written.`)
}
if (skipped.length) {
  console.log(`\n${skipped.length} subject(s) skipped:`)
  skipped.forEach(s => console.log(`  - ${s}`))
}
if (warnings.length) warnings.forEach(w => console.log(`  ! ${w}`))

if (failures) {
  console.error(`\n${failures} validation failure(s) — files written but DO NOT import them.`)
  process.exit(1)
}
console.log(`\nAll generated rows pass the tabs' own validation rules.`)
