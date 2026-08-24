import { getDocs, query, where, collection, limit } from 'firebase/firestore'
import { schoolCollection } from '../firebase/schoolCollections.js'

// Spec §3.5 safety check: true if any smart_sheet_entries doc for this
// (termId, subjectId) has a non-empty `entries` subcollection — i.e. teachers
// have already entered marks. Callers must treat a thrown error as "unknown,
// do not proceed" rather than assuming it's safe.
export async function checkEnteredMarks(schoolId, termId, subjectId) {
  const snap = await getDocs(query(
    schoolCollection(schoolId, 'smart_sheet_entries'),
    where('termId', '==', termId),
    where('subjectId', '==', subjectId),
  ))
  if (snap.empty) return false
  const checks = await Promise.all(snap.docs.map(async sheetDoc => {
    const entriesSnap = await getDocs(query(collection(sheetDoc.ref, 'entries'), limit(1)))
    return !entriesSnap.empty
  }))
  return checks.some(Boolean)
}

// Same safety check for co-scholastic: sheets are smart_sheet_entries docs
// with type=='co-scholastic' + termId (no subjectId dimension — term-wide).
export async function checkEnteredMarksCoScholastic(schoolId, termId) {
  const snap = await getDocs(query(
    schoolCollection(schoolId, 'smart_sheet_entries'),
    where('termId', '==', termId),
    where('type', '==', 'co-scholastic'),
  ))
  if (snap.empty) return false
  const checks = await Promise.all(snap.docs.map(async sheetDoc => {
    const entriesSnap = await getDocs(query(collection(sheetDoc.ref, 'entries'), limit(1)))
    return !entriesSnap.empty
  }))
  return checks.some(Boolean)
}

/**
 * Parse a "classIds" CSV cell into a clean array of class doc IDs.
 *
 * A cell holding several IDs has to be quoted in the source file to survive
 * CSV parsing as one field at all — Papa/csv already strips exactly one
 * layer of that quoting. But a value typed straight into an Excel cell to
 * protect an internal comma, then exported to CSV, picks up a SECOND layer:
 * Excel's own export quoting wraps the literal quote characters the person
 * typed, so what Papa hands back after ITS unwrap still has one leftover
 * quote character on each end — "III_A,IV_B" as a literal five-plus-char
 * string, not a clean III_A,IV_B. Stripping quote characters in a loop
 * (rather than once) makes this forgiving of either layering without
 * silently keeping a stray quote INSIDE a real class ID.
 */
export function parseClassIdsCell(raw) {
  let text = (raw ?? '').toString().trim()
  while (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    text = text.slice(1, -1).trim()
  }
  if (!text) return []
  return Array.from(new Set(
    text.split(/[,;]/).map(s => s.trim()).filter(Boolean)
  ))
}

export function slugify(text) {
  return (text || '').trim().replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '')
}

// A subject's `area` tag decides which collection it belongs in: anything that
// normalises to "coscholastic" is a co_scholastic_activities doc, not a
// subjects doc. Imported data spells it every which way ("Co-Scholastic",
// "co scholastic", "CO_SCHOLASTIC"), so compare on letters only.
// NOTE: scripts/migrate-co-scholastic-subjects.mjs repeats this rule — keep
// the two in sync (it runs under firebase-admin and can't import this file).
export function isCoScholasticArea(area) {
  return (area ?? '').toString().toLowerCase().replace(/[^a-z]/g, '') === 'coscholastic'
}
