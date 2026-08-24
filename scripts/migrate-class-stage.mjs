#!/usr/bin/env node
/**
 * One-time migration: correct `stage` on
 *   schools/{schoolId}/classes/{classId}
 *
 * Background: every place that created a class doc hardcoded
 * `stage: 'foundation'` regardless of grade — the New School wizard, Propose
 * Structure, and the Classes & Teachers "add section" dialog. So a grade 10
 * section carries `stage: "foundation"` when it is secondary. The three call
 * sites now derive it from the grade ordinal via src/utils/classStage.js;
 * this script fixes the docs written before that.
 *
 * The stage a doc SHOULD have is computed by the very same module the app now
 * uses, imported directly — there is no second copy of the mapping to drift.
 *
 * A class whose grade cannot be read is never rewritten. `stageForGrade`
 * returns null there and the row is reported as SKIP with its raw value, so an
 * unreadable class is something a human looks at rather than something this
 * script guesses a stage for.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *   # 1. Dry run (default). Touches nothing, writes the review CSV.
 *   node scripts/migrate-class-stage.mjs
 *
 *   # 2. Apply.
 *   node scripts/migrate-class-stage.mjs --commit
 *
 *   # 3. One school at a time.
 *   node scripts/migrate-class-stage.mjs --school=Hillgreen_Highschool --commit
 *
 * Flags:
 *   --commit           actually write (without it nothing is written)
 *   --school=<id>      limit to one school (repeatable)
 *   --out=<path>       CSV path (default ./class-stage-migration-<stamp>.csv)
 *   --project=<id>     Firestore project (default clarified-1501, or GOOGLE_CLOUD_PROJECT)
 *
 * The review CSV is flushed to disk BEFORE any write happens, so there is
 * always a record of what was about to change. It is rewritten with the real
 * per-doc outcome once the run finishes.
 *
 * Only `stage` is ever written. Nothing else on the class doc is touched — in
 * particular the `subjects` array, which is the expensive thing to rebuild.
 *
 * Auth: application default credentials.
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json node scripts/...
 * or `gcloud auth application-default login` with access to the project.
 */
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { initializeApp, applicationDefault } from 'firebase-admin/app'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'

import { stageForGrade } from '../src/utils/classStage.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// classResolver imports its seed as a bare JSON module, which Vite resolves
// and plain Node does not. Rewrite that one line into a readFileSync, exactly
// as tools/check_derive_classes.mjs does, so the grade parsed here is the
// grade the dashboard parses.
const TMP = mkdtempSync(path.join(tmpdir(), 'clsstage-'))
writeFileSync(path.join(TMP, 'seed.json'),
  readFileSync(path.join(ROOT, 'functions/generate_import/education_kb.json'), 'utf8'))
writeFileSync(path.join(TMP, 'classResolver.js'),
  readFileSync(path.join(ROOT, 'src/utils/classResolver.js'), 'utf8')
    .replace(/import SEED from ['"][^'"]+['"]/,
      `import fs from 'node:fs'\nconst SEED = JSON.parse(fs.readFileSync('${path.join(TMP, 'seed.json')}','utf8'))`))
const { parseClassValue } = await import(path.join(TMP, 'classResolver.js'))

const DEFAULT_PROJECT = 'clarified-1501'
const BATCH_LIMIT = 400

const argv = process.argv.slice(2)
const flag = name => argv.includes(`--${name}`)
const value = (name, fallback = null) => {
  const hit = argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const values = name => argv.filter(a => a.startsWith(`--${name}=`)).map(a => a.slice(name.length + 3))

const commit = flag('commit')
const onlySchools = values('school')
const projectId = value('project', process.env.GOOGLE_CLOUD_PROJECT || DEFAULT_PROJECT)
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const outPath = value('out', `./class-stage-migration-${stamp}.csv`)

const COLUMNS = ['school', 'classId', 'clazz', 'gradeOrdinal', 'stage_before', 'stage_after', 'action', 'note']

function writeReport(rows) {
  const esc = v => {
    const s = v === null || v === undefined ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  writeFileSync(outPath, [COLUMNS.join(','), ...rows.map(r => COLUMNS.map(c => esc(r[c])).join(','))].join('\n') + '\n')
}

async function buildPlan(db) {
  const rows = []
  const schoolDocs = onlySchools.length
    ? await Promise.all(onlySchools.map(id => db.collection('schools').doc(id).get()))
    : (await db.collection('schools').get()).docs

  for (const school of schoolDocs) {
    if (!school.exists) { console.warn(`! no such school: ${school.id}`); continue }
    const classes = await db.collection('schools').doc(school.id).collection('classes').get()
    for (const cls of classes.docs) {
      const data = cls.data()
      const before = data.stage ?? ''
      // Prefer the doc's own clazz field; fall back to the doc ID's prefix for
      // a class written before clazz existed.
      const rawGrade = data.clazz || cls.id.split('_')[0]
      const ordinal = parseClassValue(rawGrade).gradeOrdinal
      const after = stageForGrade(ordinal)

      const row = {
        school: school.id, classId: cls.id, clazz: rawGrade,
        gradeOrdinal: ordinal === null ? '' : ordinal,
        stage_before: before, stage_after: after ?? '', action: '', note: '',
      }
      if (after === null) {
        row.action = 'SKIP'
        row.note = `grade "${rawGrade}" not recognised — left as "${before}" for a human to check`
      } else if (after === before) {
        row.action = 'OK'
      } else {
        row.action = 'FIX'
      }
      rows.push(row)
    }
  }
  return rows
}

async function applyPlan(db, plan) {
  const todo = plan.filter(r => r.action === 'FIX')
  for (let i = 0; i < todo.length; i += BATCH_LIMIT) {
    const chunk = todo.slice(i, i + BATCH_LIMIT)
    const batch = db.batch()
    for (const row of chunk) {
      batch.update(
        db.collection('schools').doc(row.school).collection('classes').doc(row.classId),
        { stage: row.stage_after, updated_at: FieldValue.serverTimestamp(), updated_by: 'migrate-class-stage' },
      )
    }
    try {
      await batch.commit()
      chunk.forEach(r => { r.action = 'FIXED' })
    } catch (e) {
      chunk.forEach(r => { r.note = [r.note, `write failed: ${e.message}`].filter(Boolean).join('; ') })
    }
    console.log(`  updated ${Math.min(i + chunk.length, todo.length)}/${todo.length} class doc(s)`)
  }
}

async function main() {
  initializeApp({ credential: applicationDefault(), projectId })
  const db = getFirestore()

  console.log(`Project: ${projectId}`)
  console.log(`Mode:    ${commit ? 'COMMIT' : 'DRY RUN (no writes)'}`)
  if (onlySchools.length) console.log(`Schools: ${onlySchools.join(', ')}`)
  console.log('')

  const plan = await buildPlan(db)
  const fixes = plan.filter(r => r.action === 'FIX').length
  const skips = plan.filter(r => r.action === 'SKIP').length
  const ok = plan.filter(r => r.action === 'OK').length
  const schools = new Set(plan.map(r => r.school)).size

  writeReport(plan)
  console.log(`${plan.length} class doc(s) across ${schools} school(s): ${fixes} to fix, ${ok} already correct, ${skips} skipped.`)
  console.log(`Report: ${outPath}`)

  if (skips) console.log(`\n${skips} class(es) have an unreadable grade and are left alone — see the CSV.`)
  if (!fixes) return
  if (!commit) {
    console.log('\nDry run — nothing written. Review the CSV, then re-run with --commit.')
    return
  }

  console.log('')
  await applyPlan(db, plan)
  writeReport(plan)

  const tally = plan.reduce((acc, r) => ({ ...acc, [r.action]: (acc[r.action] || 0) + 1 }), {})
  console.log('\nDone: ' + Object.entries(tally).map(([k, v]) => `${k}=${v}`).join(' '))
  console.log(`Report: ${outPath}`)
}

function fail(err) {
  if (/default credentials/i.test(err?.message || '')) {
    console.error('\nCould not authenticate to Firestore.')
    console.error('Set GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json,')
    console.error('or run `gcloud auth application-default login` with access to the project.')
  } else {
    console.error(err)
  }
  process.exit(1)
}

process.on('unhandledRejection', fail)
main().catch(fail)
