/**
 * All ops-dashboard data lives under:
 *   operations/ops/{subcollection}
 *
 * This keeps it completely isolated from the teacher/student app
 * collections at the root level.
 */
import { collection, doc } from 'firebase/firestore'
import { db } from '../firebase/config'

const OPS_DOC = 'operations/ops'

export function opsCollection(name) {
  return collection(db, OPS_DOC, name)
}

export function opsDoc(name, id) {
  return doc(db, OPS_DOC, name, id)
}
