// Adds the 23 assignments whose sheet subject name didn't literally match a
// configured subject, but clearly should have (spelling/abbreviation
// mismatches, not genuinely missing subjects):
//   "Bio" -> Biology, "PHY" -> Physics (Grade IX, X)
//   "PE" -> HPE (XI/XII Science, XI/XII Commerce — NOT Humanities, which has
//     no HPE subject configured yet, so that one row is left out)
//   "Bussiness Studies" -> Business Studies (XII Commerce, misspelled in sheet)
//
// Same additive-merge convention as add_missing_science_commerce_assignments.mjs:
// merges into staffs/{id}.assignments[classId], adds classId to classIds only
// if missing, never removes/overwrites an existing assignment. Idempotent.
//
// SAFETY: dry run by default. Pass --confirm to actually write.
//
// Usage:
//   node add_renamed_subject_assignments.mjs
//   node add_renamed_subject_assignments.mjs --confirm

import { initializeApp, applicationDefault } from 'firebase-admin/app'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'

const CONFIRM = process.argv.includes('--confirm')
const SCHOOL_ID = 'Hillgreen_Highschool'

// [staffId, classId, subjectId]
const ROWS = [
  ['thh0040', '9_EINSTEIN', 'IX_Physics'],
  ['thh0046', '9_EINSTEIN', 'IX_Biology'],
  ['thh0041', '9_KALAM', 'IX_Physics'],
  ['thh0046', '9_KALAM', 'IX_Biology'],
  ['thh0041', '9_NEWTON', 'IX_Physics'],
  ['thh0046', '9_NEWTON', 'IX_Biology'],
  ['thh0040', '9_RAMAN', 'IX_Physics'],
  ['thh0046', '9_RAMAN', 'IX_Biology'],
  ['thh0041', '10_EINSTEIN', 'X_Physics'],
  ['thh0046', '10_EINSTEIN', 'X_Biology'],
  ['thh0040', '10_KALAM', 'X_Physics'],
  ['thh0046', '10_KALAM', 'X_Biology'],
  ['thh0041', '10_NEWTON', 'X_Physics'],
  ['thh0046', '10_NEWTON', 'X_Biology'],
  ['thh0040', '10_RAMAN', 'X_Physics'],
  ['thh0046', '10_RAMAN', 'X_Biology'],
  ['thh0054', '11_SCI_A', 'XI Science_HPE'],
  ['thh0054', '11_SCI_B', 'XI Science_HPE'],
  ['thh0062', '12_SCI_A', 'XII Science_HPE'],
  ['thh0062', '12_SCI_B', 'XII Science_HPE'],
  ['thh0054', '11_COM_C', 'XI Commerce_HPE'],
  ['thh0062', '12_COM_C', 'XII Commerce_HPE'],
  ['thh0048', '12_COM_C', 'XII Commerce_Business_Studies'],
]

if (!CONFIRM) {
  console.log('=== DRY RUN — nothing will be written. Pass --confirm to actually write. ===\n')
}

initializeApp({ credential: applicationDefault(), projectId: 'clarified-1501' })
const db = getFirestore()

async function main() {
  const staffsRef = db.collection('schools').doc(SCHOOL_ID).collection('staffs')

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
        updated_by: 'add-renamed-subject-assignments-script',
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
