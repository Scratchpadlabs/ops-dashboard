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
