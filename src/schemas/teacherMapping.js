/**
 * Import row → new staff document, the synthetic record buildTeachersPlan
 * (useImport.js) creates when a row doesn't match any existing staff.
 *
 * Mirrors src/schemas/studentMapping.js's mapImportRowToStudent: one function
 * owns the shape, extracted out of buildTeachersPlan's inline object literal
 * so a dynamic field (src/composables/useFieldSchema.js) has somewhere to
 * travel through for staff the same way it already does for students.
 *
 * Only covers a NEW staff's base fields (name/email/id/staffId/dynamic
 * fields) — an EXISTING matched staff's assignments/classIds are merged
 * server-side in functions/generate_import/main.py's _commit_teachers,
 * which reads the live doc first. This module never touches assignments.
 *
 * ONLY WRITTEN ON A NEW STAFF, NOT AN UPDATE (a deliberate scope boundary,
 * matching the existing name/email behavior below): _commit_teachers only
 * ever sets base fields — now including dynamic ones — when staffIsNew. An
 * existing matched staff only gets assignments/classIds merged; its base
 * fields, dynamic fields included, are never overwritten by a later import.
 * Retrofitting existing-staff updates would be a bigger behavior change than
 * "give dynamic fields somewhere to travel through" — not done here.
 */
import { toDateOfBirth } from './studentMapping.js'
import { coerceDynamicFields } from './fieldCoercion.js'

/**
 * @param {Object} row      extractor row (teacher_name, email, ...)
 * @param {Object} opts
 * @param {string} opts.staffId  resolved doc ID for this staff — from the
 *   file's Staff ID column when given, else a name-derived fallback
 *   (buildTeachersPlan computes which). Written to both `id` and `staffId`:
 *   both are required fields on every staffs doc (schoolSchema.js), and this
 *   is also what the NEXT import matches against (indexExistingStaffIds).
 * @param {Array} [opts.fieldDefs]  active dynamic fields for kind 'staff'
 *   (src/composables/useFieldSchema.js's loadFieldDefs).
 * @returns {{payload: Object, dropped: string[], warnings: string[]}}
 */
export function mapImportRowToStaff(row, { staffId, fieldDefs = [] } = {}) {
  const d = row || {}
  const id = String(staffId ?? '').trim()

  const payload = {
    id,
    staffId: id,
    name: String(d.teacher_name ?? '').trim(),
    email: String(d.email ?? '').trim(),
    type: 'teacher',
    assignments: {},
    classIds: [],
    needsAuthCreation: true,
    authUid: null,
  }

  const { dynamicPayload, warnings } = coerceDynamicFields(d, fieldDefs, toDateOfBirth)
  Object.assign(payload, dynamicPayload)

  return { payload, dropped: [], warnings }
}
