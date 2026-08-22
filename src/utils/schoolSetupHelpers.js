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

// ── config/students_schema ──────────────────────────────────────────────────
// The doc the teacher/student app reads to lay out its student table:
//   { columns: [{ key, label, type, editable, order, options? }] }
//
// WHO OWNS WHAT. Which columns a school HAS is decided by the enrichment flow
// (src/utils/studentEnrichment.js + the "Add columns to students_schema"
// dialog in ImportReview): it derives them from that school's own CSV headers
// and appends, never rewriting, so nothing a hand edit or the teacher app put
// there is lost. This file does NOT second-guess that and never invents a
// column for an existing schema.
//
// What was missing, and all this adds:
//   1. The doc was never CREATED. A wizard-built school had none at all, so
//      its student table had no columns to render.
//   2. `ID` was not guaranteed first. It is how a row is identified in the
//      app; a schema that buries it (or omits it) makes the table unusable.
//
// So: create from the defaults when absent; otherwise move `id` to the front
// and leave every other column exactly as stored — same order, same labels,
// same types.

// Used ONLY when creating a schema from nothing, and for the `id` column's
// definition. Not a canonical list an existing schema is conformed to.
export const STUDENT_SCHEMA_COLUMNS = [
  { key: 'id', label: 'ID', type: 'text', editable: false },
  { key: 'name', label: 'Name', type: 'text', editable: true },
  { key: 'firstName', label: 'First Name', type: 'text', editable: true },
  { key: 'lastName', label: 'Last Name', type: 'text', editable: true },
  { key: 'currentClassId', label: 'Class', type: 'select', editable: true },
  { key: 'gender', label: 'Gender', type: 'text', editable: true },
  { key: 'dateOfBirth', label: 'Date of Birth', type: 'date', editable: true },
  { key: 'phoneNo', label: 'Contact', type: 'text', editable: true },
  { key: 'email', label: 'Email', type: 'text', editable: true },
  { key: 'admNo', label: 'Admission No', type: 'text', editable: true },
  { key: 'grEmisSts', label: 'GR / EMIS / STS No', type: 'text', editable: true },
  { key: 'aadhaarNumber', label: 'Aadhaar', type: 'text', editable: true },
]

const ID_COLUMN = STUDENT_SCHEMA_COLUMNS[0]

/**
 * The corrected `columns` array for what is stored today.
 *
 * Pure and exported so tools/check_students_schema.mjs can pin the rules
 * without a Firestore round-trip.
 *
 * @param {Array} existingColumns  columns as stored (may be empty/undefined)
 * @param {Array} liveClassIds     class IDs for the currentClassId options
 * @returns {{columns: Array, created: boolean, addedId: boolean, movedId: boolean}}
 */
export function buildStudentsSchemaColumns(existingColumns, liveClassIds = []) {
  const existing = (existingColumns || []).filter(c => c && c.key)
  const fromScratch = !existing.length

  let columns
  let addedId = false
  if (fromScratch) {
    columns = STUDENT_SCHEMA_COLUMNS.map(c => ({ ...c }))
  } else {
    const idCol = existing.find(c => c.key === 'id')
    addedId = !idCol
    // Everything else keeps the order it is stored in — this only lifts `id`.
    const rest = existing.filter(c => c.key !== 'id')
    columns = [idCol ? { ...idCol } : { ...ID_COLUMN }, ...rest.map(c => ({ ...c }))]
  }

  columns.forEach((c, i) => {
    c.order = i + 1
    if (c.key === 'currentClassId') c.options = [...liveClassIds].sort()
  })

  const movedId = !fromScratch && !addedId && existing[0]?.key !== 'id'
  return { columns, created: fromScratch, addedId, movedId }
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
  return result
}
