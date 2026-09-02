/**
 * Type coercion for one dynamic-field CSV cell — shared by studentMapping.js
 * and teacherMapping.js (both call this for their fieldDefs loop) and
 * re-exported from useFieldSchema.js for API discoverability.
 *
 * Deliberately dependency-free of studentMapping.js/useFieldSchema.js: both
 * of those need this module, and studentMapping.js is where date parsing
 * (toDateOfBirth) already lives, so importing it FROM here would make a
 * cycle the moment studentMapping.js also needed coerceFieldValue for its
 * own dynamic-field loop. Instead the caller passes its own date parser in —
 * see parseDate below — so date parsing still exists in exactly one place
 * (studentMapping.js's toDateOfBirth) without this module depending on it.
 */

// Comparison key only — mirrors useImport.js's canonicalize() (lowercase,
// strip spaces/hyphens/dots). Kept as a local copy rather than importing
// useImport.js, which already imports mapImportRowToStudent/mapImportRowToStaff
// (studentMapping.js/teacherMapping.js) — those will import coerceFieldValue
// from here, so importing useImport.js back would be a cycle.
function canonicalize(s) {
  return (s || '').trim().toLowerCase().replace(/[\s\-.]+/g, '')
}

/**
 * A blank cell always coerces to `{value: undefined}` (never '', 0, or
 * false) so an empty column never writes noise onto a document that simply
 * doesn't have that field — callers merge with Object.assign/spread, which
 * drops undefined-valued keys the same way JSON.stringify would.
 *
 * @param {Object} fieldDef  {key, label, type, enumValues}
 * @param {*} raw            the source cell value
 * @param {Object} [opts]
 * @param {(iso: string) => Date|null} [opts.parseDate]  required for type
 *   'date' — pass studentMapping.js's toDateOfBirth (or an equivalent) so
 *   date parsing is never duplicated here.
 * @returns {{value: *, warning: string|null}}
 */
export function coerceFieldValue(fieldDef, raw, { parseDate } = {}) {
  const s = String(raw ?? '').trim()
  if (!s) return { value: undefined, warning: null }

  switch (fieldDef.type) {
    case 'string':
      return { value: s, warning: null }

    case 'number': {
      const n = Number(s)
      if (!Number.isFinite(n)) {
        return { value: undefined, warning: `${fieldDef.label} "${s}" is not a number — saved as empty` }
      }
      return { value: n, warning: null }
    }

    case 'date': {
      const d = parseDate ? parseDate(s) : null
      if (!d) {
        return { value: undefined, warning: `${fieldDef.label} "${s}" is not a readable date — saved as empty` }
      }
      return { value: d, warning: null }
    }

    case 'boolean': {
      const lower = s.toLowerCase()
      if (['true', 'yes', 'y', '1'].includes(lower)) return { value: true, warning: null }
      if (['false', 'no', 'n', '0'].includes(lower)) return { value: false, warning: null }
      return { value: undefined, warning: `${fieldDef.label} "${s}" is not yes/no — saved as empty` }
    }

    case 'enum': {
      const match = (fieldDef.enumValues || []).find(v => canonicalize(v) === canonicalize(s))
      if (!match) {
        return { value: undefined, warning: `${fieldDef.label} "${s}" is not one of the configured options — saved as empty` }
      }
      return { value: match, warning: null }
    }

    default:
      return { value: s, warning: null }
  }
}

/**
 * Runs every fieldDef in `fieldDefs` against `row[fd.key]`, returning what a
 * mapImportRowTo*() should merge into its payload plus any warnings —
 * undefined-valued keys are dropped so an empty/unparseable cell never
 * writes noise onto a document that simply doesn't have that field.
 *
 * @param {Object} row
 * @param {Array} fieldDefs
 * @param {(iso: string) => Date|null} parseDate
 * @returns {{dynamicPayload: Object, warnings: string[]}}
 */
export function coerceDynamicFields(row, fieldDefs, parseDate) {
  const dynamicPayload = {}
  const warnings = []
  for (const fd of fieldDefs) {
    const raw = row[fd.key]
    if (raw === undefined) continue
    const { value, warning } = coerceFieldValue(fd, raw, { parseDate })
    if (value !== undefined) dynamicPayload[fd.key] = value
    if (warning) warnings.push(warning)
  }
  return { dynamicPayload, warnings }
}
