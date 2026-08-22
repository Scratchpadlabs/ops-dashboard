import { getDoc, setDoc, updateDoc, serverTimestamp } from 'firebase/firestore'
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

// ── config/students_schema ──────────────────────────────────────────────────
// The doc the teacher/student app reads to lay out its student table:
//   { columns: [{ key, label, type, editable, order, options? }] }
//
// Nothing generated it before — it was only ever patched (class options
// above), so a school set up through the wizard either had no schema doc at
// all or one that predated the roster columns an import now writes. Two rules
// come out of that:
//
//   1. `ID` is ALWAYS the first column. It is how a row is identified in the
//      app, and a schema that buries it (or omits it) makes the table unusable.
//   2. Every field an import can write has a column, so imported data is
//      actually visible instead of sitting unreferenced on the document.
//
// Existing columns are preserved as-is — label, type and editable are a
// human's choices and are never overwritten; only ordering is normalized and
// missing columns are appended.

// Key → default column definition, in the order the app should show them.
// `ID` first by rule 1; `currentClassId` carries live class IDs as options.
export const STUDENT_SCHEMA_COLUMNS = [
  { key: 'id', label: 'ID', type: 'text', editable: false },
  { key: 'name', label: 'Name', type: 'text', editable: true },
  { key: 'firstName', label: 'First Name', type: 'text', editable: true },
  { key: 'lastName', label: 'Last Name', type: 'text', editable: true },
  { key: 'currentClassId', label: 'Class', type: 'select', editable: true },
  { key: 'rollNo', label: 'Roll No', type: 'text', editable: true },
  { key: 'srNo', label: 'Sr No', type: 'text', editable: true },
  { key: 'admNo', label: 'Admission No', type: 'text', editable: true },
  { key: 'grEmisSts', label: 'GR / EMIS / STS No', type: 'text', editable: true },
  { key: 'enrollmentCode', label: 'Enrollment Code', type: 'text', editable: true },
  { key: 'gender', label: 'Gender', type: 'text', editable: true },
  { key: 'dateOfBirth', label: 'Date of Birth', type: 'date', editable: true },
  { key: 'dateOfAdmission', label: 'Date of Admission', type: 'date', editable: true },
  { key: 'phoneNo', label: 'Contact', type: 'text', editable: true },
  { key: 'email', label: 'Email', type: 'text', editable: true },
  { key: 'fatherName', label: "Father's Name", type: 'text', editable: true },
  { key: 'fatherMobile', label: "Father's Mobile", type: 'text', editable: true },
  { key: 'fatherEmail', label: "Father's Email", type: 'text', editable: true },
  { key: 'motherName', label: "Mother's Name", type: 'text', editable: true },
  { key: 'motherMobile', label: "Mother's Mobile", type: 'text', editable: true },
  { key: 'motherEmail', label: "Mother's Email", type: 'text', editable: true },
  { key: 'city', label: 'City', type: 'text', editable: true },
  { key: 'branchName', label: 'Branch', type: 'text', editable: true },
  { key: 'board', label: 'Board', type: 'text', editable: true },
  { key: 'usingTransport', label: 'Transport', type: 'text', editable: true },
  { key: 'status', label: 'Status', type: 'text', editable: true },
  { key: 'aadhaarNumber', label: 'Aadhaar', type: 'text', editable: true },
]

const DEFAULT_ORDER = STUDENT_SCHEMA_COLUMNS.map(c => c.key)

/**
 * Build the corrected `columns` array from whatever is stored today.
 *
 * Pure and exported so tools/check_students_schema.mjs can pin the rules
 * without a Firestore round-trip.
 *
 * @param {Array}  existingColumns  columns as stored (may be empty/undefined)
 * @param {Array}  liveClassIds     class IDs for the currentClassId options
 * @returns {{columns: Array, added: string[], reordered: boolean}}
 */
export function buildStudentsSchemaColumns(existingColumns, liveClassIds = []) {
  const existing = (existingColumns || []).filter(c => c && c.key)
  const byKey = new Map(existing.map(c => [c.key, c]))

  // Preserve a column the school added by hand that this list knows nothing
  // about — it keeps its relative position after the known ones.
  const extraKeys = existing.map(c => c.key).filter(k => !DEFAULT_ORDER.includes(k))
  const order = [...DEFAULT_ORDER, ...extraKeys]

  const added = []
  const columns = []
  for (const key of order) {
    const stored = byKey.get(key)
    const preset = STUDENT_SCHEMA_COLUMNS.find(c => c.key === key)
    // A column no school has and no import writes isn't invented — only `id`
    // is mandatory, the rest appear once they exist or are known presets.
    if (!stored && !preset) continue
    if (!stored) added.push(key)
    const col = stored
      ? { ...stored }
      : { key, label: preset.label, type: preset.type, editable: preset.editable }
    col.order = columns.length + 1
    if (key === 'currentClassId') col.options = [...liveClassIds].sort()
    columns.push(col)
  }

  const reordered = existing.length !== columns.length
    || existing.some((c, i) => c.key !== columns[i]?.key)
  return { columns, added, reordered }
}

/**
 * Create or repair `config/students_schema`.
 *
 * Unlike regenerateStudentsSchemaClassOptions above, this DOES create the doc
 * when it is missing — a school with no schema doc has no student table at
 * all, which is the state every wizard-created school starts in.
 */
export async function ensureStudentsSchema(schoolId, liveClassIds = []) {
  if (!schoolId) return null
  const ref = schoolDoc(schoolId, 'config', 'students_schema')
  const snap = await getDoc(ref)
  const result = buildStudentsSchemaColumns(snap.exists() ? snap.data().columns : [], liveClassIds)
  await setDoc(ref, {
    columns: result.columns,
    updated_at: serverTimestamp(),
    updated_by: auth.currentUser?.email || 'unknown',
    ...(snap.exists() ? {} : {
      created_at: serverTimestamp(),
      created_by: auth.currentUser?.email || 'unknown',
    }),
  }, { merge: true })
  return { ...result, created: !snap.exists() }
}
