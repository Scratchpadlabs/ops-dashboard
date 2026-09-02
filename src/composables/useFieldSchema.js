/**
 * Dynamic field registry — lets an ops admin add a new student/staff field
 * (e.g. "Blood Group") at runtime, no code deploy, via the Manage Fields
 * screen (src/views/ManageFields.vue). The registry lives in the global
 * `field_defs` Firestore collection (src/firebase/schoolCollections.js).
 *
 * These are ADDITIVE to the fixed field set in src/schemas/schoolSchema.js —
 * that file still owns the core fields (name, firstName, currentClassId,
 * staffId, ...). A dynamic field can never reuse a core field's key (see
 * validateFieldKey), and is always optional — a school whose roster predates
 * the field must never fail validation because of it.
 *
 * Consumed by:
 *   - src/views/ManageFields.vue (CRUD)
 *   - src/composables/useImport.js's buildStudentsPlan/buildTeachersPlan
 *     (loadFieldDefs, to thread into the row mappers)
 *   - src/views/ImportReview.vue (loadFieldDefs, for column labels)
 *   - functions/generate_import/main.py's load_field_defs (server-side twin,
 *     read via the Admin SDK — bypasses firestore.rules, kept in sync by
 *     hand since it's a different language, same as every other
 *     school-schema piece in this repo)
 */
import { getDocs, setDoc, updateDoc, onSnapshot, serverTimestamp } from 'firebase/firestore'
import { auth } from '../firebase/config'
import { fieldDefsCollection, fieldDefDoc } from '../firebase/schoolCollections.js'
import { SCHOOL_SCHEMAS } from '../schemas/schoolSchema.js'
// Re-exported below rather than implemented here: coerceFieldValue is also
// needed by studentMapping.js/teacherMapping.js, and studentMapping.js is
// where date parsing already lives (toDateOfBirth) — implementing the
// coercion here and importing that in would create studentMapping.js ->
// useFieldSchema.js -> studentMapping.js. See fieldCoercion.js's own
// docstring for the full reasoning.
export { coerceFieldValue } from '../schemas/fieldCoercion.js'

export const FIELD_KINDS = ['student', 'staff']
export const FIELD_TYPES = ['string', 'number', 'date', 'boolean', 'enum']
export const FIELD_TYPE_LABELS = {
  string: 'Text', number: 'Number', date: 'Date', boolean: 'Yes/No', enum: 'Choice list',
}

// kind -> the SCHOOL_SCHEMAS collection it extends, for the built-in-field
// collision check in validateFieldKey.
const KIND_TO_COLLECTION = { student: 'students', staff: 'staffs' }

const KEY_RE = /^[a-z][a-zA-Z0-9]{0,63}$/

export function fieldDocId(kind, key) {
  return `${kind}_${key}`
}

/**
 * @param {string} key
 * @param {'student'|'staff'} kind
 * @param {string[]} existingKeys  active dynamic keys already registered for this kind (excluding the one being edited)
 */
export function validateFieldKey(key, kind, existingKeys = []) {
  const k = String(key || '').trim()
  if (!KEY_RE.test(k)) {
    return { ok: false, message: 'Key must start with a lowercase letter and contain only letters/digits (camelCase) — e.g. "bloodGroup".' }
  }
  const collection = KIND_TO_COLLECTION[kind]
  const staticFields = SCHOOL_SCHEMAS[collection]?.fields || {}
  if (staticFields[k]) {
    return { ok: false, message: `"${k}" is already a built-in ${collection} field — pick a different key.` }
  }
  if (existingKeys.includes(k)) {
    return { ok: false, message: `"${k}" is already registered.` }
  }
  return { ok: true, message: '' }
}

/** Live listener, scoped to one kind — for the Manage Fields screen. */
export function listenFieldDefs(kind, cb) {
  return onSnapshot(fieldDefsCollection(), (snap) => {
    const all = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    cb(all.filter(f => f.kind === kind).sort((a, b) => (a.label || '').localeCompare(b.label || '')))
  })
}

/**
 * One-shot fetch of ACTIVE fields for one kind — for the import plan
 * builders and ImportReview.vue, which want a snapshot at plan-build time,
 * not a live subscription.
 */
export async function loadFieldDefs(kind) {
  const snap = await getDocs(fieldDefsCollection())
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(f => f.kind === kind && f.active !== false)
}

/** @param {Object} def {kind, key, label, type, enumValues?, aliases, isNew} */
export async function saveFieldDef(def) {
  const id = fieldDocId(def.kind, def.key)
  const email = auth.currentUser?.email || 'unknown'
  await setDoc(fieldDefDoc(id), {
    kind: def.kind,
    key: def.key,
    label: def.label,
    type: def.type,
    enumValues: def.type === 'enum' ? (def.enumValues || []) : [],
    aliases: def.aliases || [],
    active: true,
    updated_at: serverTimestamp(),
    updated_by: email,
    ...(def.isNew ? { created_at: serverTimestamp(), created_by: email } : {}),
  }, { merge: true })
  return id
}

export async function deactivateFieldDef(id) {
  await updateDoc(fieldDefDoc(id), {
    active: false, updated_at: serverTimestamp(), updated_by: auth.currentUser?.email || 'unknown',
  })
}

export async function reactivateFieldDef(id) {
  await updateDoc(fieldDefDoc(id), {
    active: true, updated_at: serverTimestamp(), updated_by: auth.currentUser?.email || 'unknown',
  })
}

/** {fieldKey: [alias phrases]} — same shape as normalize.py's *_HEADER_ALIASES, for column labeling and header-matching display. */
export function buildAliasLookup(fieldDefs) {
  const out = {}
  for (const fd of fieldDefs) out[fd.key] = fd.aliases || []
  return out
}
