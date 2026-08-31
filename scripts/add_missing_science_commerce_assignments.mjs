// Adds the 76 (teacher, class, subject) assignments that were resolvable
// against the xlsx source and the current Firestore config, but were never
// actually committed — all Grade XI/XII Science/Commerce/Humanities rows
// whose subjects only got added to School Setup after the original import
// attempts had already failed on them.
//
// Additive only: merges each subjectId into staffs/{id}.assignments[classId]
// (union with whatever's already there, matching _commit_teachers's own
// convention), and adds classId to classIds if not already present. Never
// removes or overwrites an existing assignment.
//
// Idempotent: re-running only adds what's still missing.
//
// SAFETY: dry run by default. Pass --confirm to actually write.
//
// Usage:
//   node add_missing_science_commerce_assignments.mjs
//   node add_missing_science_commerce_assignments.mjs --confirm

import { initializeApp, applicationDefault } from 'firebase-admin/app'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'

const CONFIRM = process.argv.includes('--confirm')
const SCHOOL_ID = 'Hillgreen_Highschool'

// [staffId, classId, subjectId]
const ROWS = [
  ['thh0044', '11_SCI_A', 'XI Science_English'],
  ['thh0043', '11_SCI_A', 'XI Science_Hindi'],
  ['thh0053', '11_SCI_A', 'XI Science_Computer_Science'],
  ['thh0041', '11_SCI_A', 'XI Science_Physics'],
  ['thh0052', '11_SCI_A', 'XI Science_Chemistry'],
  ['thh0006', '11_SCI_A', 'XI Science_Biology'],
  ['thh0049', '11_SCI_A', 'XI Science_Maths'],
  ['thh0054', '11_SCI_A', 'XI Science_PE_Additional'],
  ['thh0036', '11_SCI_A', 'XI Science_Artificial_Intelligence'],
  ['thh0006', '11_SCI_A', 'XI Science_Biology_Additional'],
  ['thh0061', '11_SCI_A', 'XI Science_Psychology'],
  ['thh0049', '11_SCI_A', 'XI Science_Maths_Additional'],
  ['thh0054', '11_SCI_A', 'XI Science_HPE'],
  ['thh0053', '11_SCI_A', 'XI Science_Artificial_Intelligence'],
  ['thh0050', '11_SCI_B', 'XI Science_English'],
  ['thh0053', '11_SCI_B', 'XI Science_Computer_Science'],
  ['thh0041', '11_SCI_B', 'XI Science_Physics'],
  ['thh0052', '11_SCI_B', 'XI Science_Chemistry'],
  ['thh0006', '11_SCI_B', 'XI Science_Biology'],
  ['thh0054', '11_SCI_B', 'XI Science_PE_Additional'],
  ['thh0036', '11_SCI_B', 'XI Science_Artificial_Intelligence'],
  ['thh0006', '11_SCI_B', 'XI Science_Biology_Additional'],
  ['thh0054', '11_SCI_B', 'XI Science_HPE'],
  ['thh0053', '11_SCI_B', 'XI Science_Artificial_Intelligence'],
  ['thh0045', '12_SCI_A', 'XII Science_English'],
  ['thh0043', '12_SCI_A', 'XII Science_Hindi'],
  ['thh0053', '12_SCI_A', 'XII Science_Computer_Science'],
  ['thh0041', '12_SCI_A', 'XII Science_Physics'],
  ['thh0052', '12_SCI_A', 'XII Science_Chemistry'],
  ['thh0059', '12_SCI_A', 'XII Science_Maths'],
  ['thh0006', '12_SCI_A', 'XII Science_Biology'],
  ['thh0059', '12_SCI_A', 'XII Science_Maths_Additional'],
  ['thh0053', '12_SCI_A', 'XII Science_Computer_Science_Additional'],
  ['thh0006', '12_SCI_A', 'XII Science_Biology_Additional'],
  ['thh0062', '12_SCI_A', 'XII Science_PE_Additional'],
  ['thh0062', '12_SCI_A', 'XII Science_HPE'],
  ['thh0045', '12_SCI_B', 'XII Science_English'],
  ['thh0053', '12_SCI_B', 'XII Science_Computer_Science'],
  ['thh0041', '12_SCI_B', 'XII Science_Physics'],
  ['thh0052', '12_SCI_B', 'XII Science_Chemistry'],
  ['thh0006', '12_SCI_B', 'XII Science_Biology'],
  ['thh0053', '12_SCI_B', 'XII Science_Computer_Science_Additional'],
  ['thh0006', '12_SCI_B', 'XII Science_Biology_Additional'],
  ['thh0062', '12_SCI_B', 'XII Science_PE_Additional'],
  ['thh0062', '12_SCI_B', 'XII Science_HPE'],
  ['thh0050', '11_COM_C', 'XI Commerce_English'],
  ['thh0043', '11_COM_C', 'XI Commerce_Hindi'],
  ['thh0053', '11_COM_C', 'XI Commerce_Computer_Science'],
  ['thh0049', '11_COM_C', 'XI Commerce_Applied_Maths'],
  ['thh0037', '11_COM_C', 'XI Commerce_Accounts'],
  ['thh0048', '11_COM_C', 'XI Commerce_Business_Studies'],
  ['thh0048', '11_COM_C', 'XI Commerce_Economics'],
  ['thh0054', '11_COM_C', 'XI Commerce_PE_Additional'],
  ['thh0036', '11_COM_C', 'XI Commerce_Artificial_Intelligence'],
  ['thh0049', '11_COM_C', 'XI Commerce_Maths_Additional'],
  ['thh0054', '11_COM_C', 'XI Commerce_HPE'],
  ['thh0051', '11_COM_C', 'XI Commerce_Business_Studies'],
  ['thh0053', '11_COM_C', 'XI Commerce_Artificial_Intelligence'],
  ['thh0050', '12_COM_C', 'XII Commerce_English'],
  ['thh0043', '12_COM_C', 'XII Commerce_Hindi'],
  ['thh0053', '12_COM_C', 'XII Commerce_Computer_Science'],
  ['thh0049', '12_COM_C', 'XII Commerce_Maths'],
  ['thh0037', '12_COM_C', 'XII Commerce_Accounts'],
  ['thh0048', '12_COM_C', 'XII Commerce_Economics'],
  ['thh0053', '12_COM_C', 'XII Commerce_Computer_Science_Additional'],
  ['thh0062', '12_COM_C', 'XII Commerce_PE_Additional'],
  ['thh0049', '12_COM_C', 'XII Commerce_Maths_Additional'],
  ['thh0062', '12_COM_C', 'XII Commerce_HPE'],
  ['thh0050', '11_D', 'XI Humanities_English'],
  ['thh0043', '11_D', 'XI Humanities_Hindi'],
  ['thh0036', '11_D', 'XI Humanities_Artificial_Intelligence'],
  ['thh0053', '11_D', 'XI Humanities_Computer_Science'],
  ['thh0049', '11_D', 'XI Humanities_Applied_Maths'],
  ['thh0048', '11_D', 'XI Humanities_Economics'],
  ['thh0051', '11_D', 'XI Humanities_Sociology'],
  ['thh0061', '11_D', 'XI Humanities_Psychology'],
]

if (!CONFIRM) {
  console.log('=== DRY RUN — nothing will be written. Pass --confirm to actually write. ===\n')
}

initializeApp({ credential: applicationDefault(), projectId: 'clarified-1501' })
const db = getFirestore()

async function main() {
  const staffsRef = db.collection('schools').doc(SCHOOL_ID).collection('staffs')

  // Group rows by staffId so each teacher gets exactly one write, merging
  // multiple new (classId, subjectId) pairs from ROWS at once.
  const byStaff = new Map()
  for (const [staffId, classId, subjectId] of ROWS) {
    if (!byStaff.has(staffId)) byStaff.set(staffId, [])
    byStaff.get(staffId).push([classId, subjectId])
  }

  let staffTouched = 0, pairsAdded = 0, pairsAlreadyPresent = 0

  for (const [staffId, pairs] of byStaff.entries()) {
    const snap = await staffsRef.doc(staffId).get()
    if (!snap.exists) {
      console.log(`SKIP: staff ${staffId} does not exist.`)
      continue
    }
    const data = snap.data()
    const assignments = { ...(data.assignments || {}) }
    const classIds = new Set(data.classIds || [])
    let changed = false

    for (const [classId, subjectId] of pairs) {
      const existing = new Set(assignments[classId] || [])
      if (existing.has(subjectId)) {
        pairsAlreadyPresent++
        continue
      }
      existing.add(subjectId)
      assignments[classId] = [...existing].sort()
      classIds.add(classId)
      changed = true
      pairsAdded++
      console.log(`${CONFIRM ? 'Adding' : '[DRY RUN] would add'}: ${staffId} -> ${classId} -> ${subjectId}`)
    }

    if (!changed) continue
    staffTouched++
    if (CONFIRM) {
      await staffsRef.doc(staffId).update({
        assignments,
        classIds: [...classIds],
        updated_at: FieldValue.serverTimestamp(),
        updated_by: 'add-missing-science-commerce-assignments-script',
      })
    }
  }

  console.log(`\n=== Totals ===`)
  console.log(`Staff ${CONFIRM ? 'updated' : 'that would be updated'}: ${staffTouched}`)
  console.log(`Assignment pairs ${CONFIRM ? 'added' : 'that would be added'}: ${pairsAdded}`)
  console.log(`Already present (skipped): ${pairsAlreadyPresent}`)
  if (!CONFIRM) console.log('\nDry run — nothing was written. Re-run with --confirm to apply.')
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
