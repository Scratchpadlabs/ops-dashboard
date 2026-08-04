/**
 * Validated Firestore writes — the single choke point for School Setup.
 *
 * Every config write in the dashboard goes through here instead of calling
 * setDoc/updateDoc/batch.set directly, so "does this match the schema?" is
 * asked once, in one place, rather than being re-implemented per tab and
 * forgotten in the next one.
 *
 * This is the BROWSER half. It exists so a human sees the problem before
 * committing and the write never leaves the tab. It is not the gate: the gate
 * for imported data is functions/generate_import (Admin SDK writes bypass
 * Firestore rules). Both call the same schema.
 *
 * CREATE vs UPDATE matters. A create carries the whole document and is checked
 * in full; an update carries a subset of fields and is checked partially — a
 * legacy document that is already malformed must stay editable, or bad data
 * could never be fixed through the UI.
 */
import { setDoc, updateDoc } from 'firebase/firestore'
import { validateDoc, formatErrors } from './schoolSchema.js'

export const MODE_CREATE = 'create'
export const MODE_UPDATE = 'update'

export class SchemaViolation extends Error {
  constructor(collection, errors, warnings) {
    super(`${collection}: ${formatErrors(errors)}`)
    this.name = 'SchemaViolation'
    this.collection = collection
    this.errors = errors
    this.warnings = warnings || []
    // What a tab should put in its red box — already human-readable.
    this.userMessage = `This does not match the ${collection} schema — ${formatErrors(errors)}`
  }
}

/**
 * Throws SchemaViolation if the payload is malformed. Returns any warnings
 * (unknown fields) so a caller can surface them without blocking.
 */
export function assertValid(collection, payload, mode = MODE_CREATE) {
  const result = validateDoc(collection, payload, { partial: mode === MODE_UPDATE })
  if (!result.ok) throw new SchemaViolation(collection, result.errors, result.warnings)
  if (result.warnings.length) {
    // Not fatal: the teacher app owns fields the dashboard has no business
    // rejecting. Visible in the console so a stray field is still noticed.
    console.warn(`[schema] ${collection} — ${formatErrors(result.warnings)}`)
  }
  return result.warnings
}

/** setDoc, validated. `mode` defaults to create (full validation). */
export async function guardedSetDoc(collection, ref, payload, { mode = MODE_CREATE, merge = true } = {}) {
  assertValid(collection, payload, mode)
  return setDoc(ref, payload, { merge })
}

/** updateDoc, validated as a partial write. */
export async function guardedUpdateDoc(collection, ref, payload) {
  assertValid(collection, payload, MODE_UPDATE)
  return updateDoc(ref, payload)
}

/**
 * batch.set, validated. Throws before anything is staged, so a bad row cannot
 * be part of a committed batch.
 */
export function guardedBatchSet(batch, collection, ref, payload, { mode = MODE_CREATE, merge = true } = {}) {
  assertValid(collection, payload, mode)
  return batch.set(ref, payload, { merge })
}

/**
 * Validate many rows without writing — for a CSV preview, where the point is
 * to show every bad row at once rather than stop at the first.
 *
 * @returns {{valid: Array, invalid: Array<{row, reason}>}}
 */
export function partitionValid(collection, rows, { payloadOf = r => r.payload, modeOf = () => MODE_CREATE } = {}) {
  const valid = []
  const invalid = []
  for (const row of rows) {
    const result = validateDoc(collection, payloadOf(row), { partial: modeOf(row) === MODE_UPDATE })
    if (result.ok) valid.push(row)
    else invalid.push({ row, reason: formatErrors(result.errors) })
  }
  return { valid, invalid }
}
