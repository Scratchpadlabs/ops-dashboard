import { getDoc, updateDoc, serverTimestamp } from 'firebase/firestore'
import { schoolDoc } from '../firebase/schoolCollections.js'
import { auth } from '../firebase/config'

// Spec §3.4: after any class add/remove/rename, regenerate config/students_schema's
// currentClassId column options from the live class list. No-ops if the schema
// doc doesn't exist yet — this never fabricates one from scratch.
export async function regenerateStudentsSchemaClassOptions(schoolId, liveClassIds) {
  if (!schoolId) return
  try {
    const ref = schoolDoc(schoolId, 'config', 'students_schema')
    const snap = await getDoc(ref)
    if (!snap.exists()) return
    const data = snap.data()
    const columns = (data.columns || []).map(col =>
      col.key === 'currentClassId' ? { ...col, options: [...liveClassIds].sort() } : col
    )
    await updateDoc(ref, {
      columns,
      updated_at: serverTimestamp(),
      updated_by: auth.currentUser?.email || 'unknown',
    })
  } catch (e) {
    console.error('Could not regenerate students_schema class options', e)
  }
}

// A bootstrap artifact, not data: a doc whose ONLY field is `a`. These were
// written to bring a collection into existence and appear across terms,
// grading_scales, assessments and co_scholastic_activities in the reference
// school (AUDIT.md §1.5b). The Overview hygiene panel offers to delete them and
// Clone School refuses to copy them, so a new school cannot inherit them.
//
// Deliberately narrow. A doc carrying `a` ALONGSIDE real fields (SAMARTH's
// `csa1` does) is a real doc with a stray field and is left alone — dropping it
// would lose configuration. Nothing is matched on name: a class genuinely
// called "Sample House" must not vanish because of its spelling.
export function isJunkDoc(data) {
  const keys = Object.keys(data || {})
  return keys.length === 1 && keys[0] === 'a'
}
