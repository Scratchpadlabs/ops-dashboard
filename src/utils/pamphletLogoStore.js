/**
 * Uploaded pamphlet logos, one per ops school, kept in
 * operations/ops/school_logos/{opsSchoolId} as base64 — a few hundred KB at
 * most (see normalizeLogo), and readable back without the Storage bucket's
 * CORS setup.
 */
import { getDoc, setDoc, deleteDoc, serverTimestamp } from 'firebase/firestore'
import { opsDoc } from '../firebase/collections.js'
import { bytesToBase64, base64ToBytes } from './pamphletLogo.js'

export async function loadSavedLogo(opsSchoolId) {
  const snap = await getDoc(opsDoc('school_logos', opsSchoolId))
  if (!snap.exists()) return null
  const d = snap.data()
  return {
    bytes: base64ToBytes(d.data), type: d.type, width: d.width, height: d.height,
    sourceWidth: d.sourceWidth ?? d.width, sourceHeight: d.sourceHeight ?? d.height,
    fileName: d.fileName || '', updatedBy: d.updated_by || '', updatedAt: d.updated_at?.toDate?.() || null,
  }
}

export async function saveLogo(opsSchoolId, logo, { fileName = '', user = 'unknown' } = {}) {
  await setDoc(opsDoc('school_logos', opsSchoolId), {
    data: bytesToBase64(logo.bytes), type: logo.type, width: logo.width, height: logo.height,
    sourceWidth: logo.sourceWidth, sourceHeight: logo.sourceHeight,
    fileName, updated_at: serverTimestamp(), updated_by: user,
  })
}

export async function deleteSavedLogo(opsSchoolId) {
  await deleteDoc(opsDoc('school_logos', opsSchoolId))
}
