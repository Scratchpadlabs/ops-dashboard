/**
 * Curricular-goals library shared across schools: a new subject is pre-filled
 * with the goal set another school already keeps for the same grade + subject.
 */
import { getDocs } from 'firebase/firestore'
import { schoolCollection, rootSchoolsCollection } from '../firebase/schoolCollections.js'
import { classify, GRADE } from './educationKB.js'

// Grade normalization delegates to the shared education knowledge base, so
// 'V', '5' and 'Grade 5' all key the same library entry.
export function normalizeGrade(g) {
  const s = (g || '').trim()
  if (!s) return ''
  // expect: GRADE is correct here — every caller already knows this value
  // came from a grade column, the context that lets a bare 'V' read as 5.
  const r = classify(s, { expect: GRADE })
  return r.type === GRADE && r.canonical ? r.canonical : s.toUpperCase()
}

// Curricular goals for a brand-new subject aren't typed by hand — they're the
// same goal set another school already keeps for the same grade + subject
// (e.g. Grade III English). Every other school's subjects collection is
// scanned once per call and indexed by that grade|name key, then a new
// subject row is auto-filled from it. Only CREATE rows are touched — an
// existing subject's own curricular_goals are never overwritten.
export async function loadGoalsLibrary(schoolId) {
  const goalsByKey = new Map() // `${normGrade}|${normName}` -> curricular_goals
  try {
    const schoolsSnap = await getDocs(rootSchoolsCollection())
    const otherSchoolIds = schoolsSnap.docs.map(d => d.id).filter(id => id !== schoolId)
    const subjectSnaps = await Promise.all(
      otherSchoolIds.map(id => getDocs(schoolCollection(id, 'subjects')).catch(() => null))
    )
    subjectSnaps.forEach(snap => {
      if (!snap) return
      snap.docs.forEach(d => {
        const data = d.data()
        const goals = data.curricular_goals || []
        if (!goals.length) return
        const grade = d.id.includes('_') ? d.id.split('_')[0] : ''
        const name = (data.name || '').trim().toLowerCase()
        if (!name) return
        const key = `${normalizeGrade(grade)}|${name}`
        // Keep the richest match seen so far if more than one school has it.
        const existing = goalsByKey.get(key)
        if (!existing || goals.length > existing.length) goalsByKey.set(key, goals)
      })
    })
  } catch (e) {
    console.error('Could not load curricular goals library', e)
  }
  return goalsByKey
}
