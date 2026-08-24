/**
 * THE per-school Firestore schema — one definition, used by every write path.
 *
 * Hand-ported twin of functions/shared/school_schema.py, the same arrangement
 * as classResolver.js ⟷ class_resolver.py: the browser validates so a human
 * sees the problem before committing, and the Cloud Function validates because
 * commit_import writes through the Admin SDK, which bypasses Firestore rules
 * entirely. Browser-side checks alone are a UX guard, not a gate.
 *
 * The two files must be changed together. tools/check_schema_parity.mjs fails
 * if they drift.
 *
 * WHERE THESE SHAPES COME FROM: docs/school-setup-page-spec.md plus the
 * 2026-08-04 live dump (see AUDIT.md §1). They are written from the INTENDED
 * shape, deliberately not derived by intersecting SAMARTH's live documents —
 * that school carries bootstrap stub docs whose only field is `a`, in terms,
 * grading_scales, assessments and co_scholastic_activities. Validating against
 * the data would have canonicalised the stubs.
 *
 * Every school has its OWN values — different subject names, term names,
 * grading scales. Nothing here constrains values; it constrains SHAPE.
 */

export const STRING = 'string'
export const NUMBER = 'number'
export const BOOL = 'bool'
export const TIMESTAMP = 'timestamp'
export const ARRAY = 'array'
export const MAP = 'map'

export const ENTRY_TYPES = ['marks', 'grade']
export const CONVERSION_TYPES = ['none', 'marks_to_grade', 'sum_up', 'sum_down']
export const REMARK_TYPES = ['positive', 'negative']
// "prepratory" is misspelled in production data. docs/school-setup-page-spec.md
// says keep the existing literal — correcting it breaks the teacher app.
export const STAGES = ['foundation', 'prepratory', 'middle', 'secondary']
export const AREAS = ['Scholastic', 'Co-Scholastic']

const ACADEMIC_YEAR_RE = /^\d{4}-\d{2}$/
const MONTH_KEY_RE = /^\d{4}-(0[1-9]|1[0-2])$/
// Aadhaar is 12 digits. Validated for shape only — never checksummed here.
const AADHAAR_RE = /^\d{12}$/

/**
 * A student/staff document ID, e.g. ssds0001 (student) or tsds0001 (staff).
 * Used to catch a student ID that has been written into a class field —
 * observed live at A K CSchool and Carmel Convent, where currentClassId held
 * "sakc0001" / "sccs0001" (AUDIT.md §2.3).
 *
 * Safe against real class IDs: every class ID in the estate carries an
 * uppercase grade token and/or a separator (III_A, 2_C, III_A1), none of which
 * match an all-lowercase run followed by digits.
 */
export const PERSON_ID_RE = /^[a-z]{2,6}\d{3,6}$/

// ── field spec helpers ──────────────────────────────────────────────────────
const f = (type, opts = {}) => ({ type, required: opts.required !== false, ...opts })
const opt = (type, opts = {}) => f(type, { ...opts, required: false })

/**
 * Per-collection shape. `fields` is the whole known surface; anything not
 * listed is reported as `unknown` (a warning, never an error — the teacher app
 * owns fields the dashboard has no business rejecting).
 *
 * `check` runs cross-field rules that a per-field spec cannot express.
 */
export const SCHOOL_SCHEMAS = {
  terms: {
    label: 'Terms',
    fields: {
      name: f(STRING),
      academicYear: f(STRING, { pattern: ACADEMIC_YEAR_RE, hint: 'e.g. 2025-26' }),
      isActive: f(BOOL),
    },
  },

  grading_scales: {
    label: 'Grading scales',
    fields: {
      name: f(STRING),
      levels: f(ARRAY, { minLength: 1 }),
    },
    check(doc, errors) {
      const levels = Array.isArray(doc.levels) ? doc.levels : []
      levels.forEach((lv, i) => {
        if (!lv || typeof lv !== 'object') return errors.push({ field: `levels[${i}]`, reason: 'must be an object' })
        if (typeof lv.label !== 'string' || !lv.label.trim()) errors.push({ field: `levels[${i}].label`, reason: 'required string' })
        for (const k of ['minPercent', 'maxPercent']) {
          if (typeof lv[k] !== 'number' || Number.isNaN(lv[k])) errors.push({ field: `levels[${i}].${k}`, reason: 'required number' })
          else if (lv[k] < 0 || lv[k] > 100) errors.push({ field: `levels[${i}].${k}`, reason: 'must be between 0 and 100' })
        }
        if (typeof lv.minPercent === 'number' && typeof lv.maxPercent === 'number' && lv.minPercent > lv.maxPercent) {
          errors.push({ field: `levels[${i}]`, reason: 'minPercent is above maxPercent' })
        }
      })
      // Spec: levels must cover 0–100 with no overlap. Bands are INTEGER and
      // contiguous — `next.min === prev.max + 1` — which is what the editor in
      // TermsScalesTab.validateLevelsCoverage enforces. Checking only for
      // overlap was looser than the editor: a scale written 33–40 / 41–50 read
      // as valid here while leaving 40.5% with no grade at all, and grand-total
      // percentages are fractional constantly (61/150 = 40.67%).
      const sorted = levels
        .filter(lv => lv && typeof lv.minPercent === 'number' && typeof lv.maxPercent === 'number')
        .slice().sort((a, b) => a.minPercent - b.minPercent)
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i].minPercent <= sorted[i - 1].maxPercent) {
          errors.push({ field: 'levels', reason: `"${sorted[i - 1].label}" and "${sorted[i].label}" overlap` })
        } else if (sorted[i].minPercent !== sorted[i - 1].maxPercent + 1) {
          errors.push({ field: 'levels', reason: `gap between "${sorted[i - 1].label}" (ends ${sorted[i - 1].maxPercent}%) and "${sorted[i].label}" (starts ${sorted[i].minPercent}%)` })
        }
      }
      if (sorted.length) {
        if (sorted[0].minPercent > 0) errors.push({ field: 'levels', reason: 'does not cover 0% — lowest band starts above 0' })
        if (sorted[sorted.length - 1].maxPercent < 100) errors.push({ field: 'levels', reason: 'does not cover 100% — highest band ends below 100' })
      }
    },
  },

  subjects: {
    label: 'Subjects',
    fields: {
      id: f(STRING),
      name: f(STRING),
      curricular_goals: opt(ARRAY),
      topics: opt(ARRAY),
      area: opt(STRING, { enum: AREAS }),
      name_original: opt(STRING),
      assets: opt(STRING, { nullable: true }),
      bannerImage: opt(STRING, { nullable: true }),
      iconImage: opt(STRING, { nullable: true }),
      forInternalPurpose: opt(STRING, { nullable: true }),
    },
    check(doc, errors) {
      // A Co-Scholastic record is a co_scholastic_activities doc, not a
      // subjects doc (AUDIT.md §3.1).
      if (typeof doc.area === 'string' && doc.area.toLowerCase().replace(/[^a-z]/g, '') === 'coscholastic') {
        errors.push({ field: 'area', reason: 'Co-Scholastic records belong in co_scholastic_activities, not subjects' })
      }
    },
  },

  classes: {
    label: 'Classes',
    fields: {
      id: f(STRING),
      name: f(STRING),
      clazz: f(STRING),
      section: f(STRING),
      stage: f(STRING, { enum: STAGES }),
      isActive: opt(BOOL),
      subjects: opt(ARRAY),
      smart_sheets: opt(MAP),
    },
    check(doc, errors) {
      const subs = Array.isArray(doc.subjects) ? doc.subjects : []
      subs.forEach((s, i) => {
        if (!s || typeof s !== 'object') return errors.push({ field: `subjects[${i}]`, reason: 'must be an object' })
        if (typeof s.subjectId !== 'string' || !s.subjectId.trim()) {
          errors.push({ field: `subjects[${i}].subjectId`, reason: 'required string' })
        }
      })
    },
  },

  assessments: {
    label: 'Assessments',
    fields: {
      name: f(STRING),
      termId: f(STRING),
      subjectId: f(STRING),
      order: f(NUMBER, { min: 1 }),
      entryType: f(STRING, { enum: ENTRY_TYPES }),
      maxMarks: f(NUMBER, { exclusiveMin: 0 }),
      gradingScaleId: f(STRING, { nullable: true }),
      conversionType: f(STRING, { enum: CONVERSION_TYPES }),
      conversionFactor: f(NUMBER, { nullable: true }),
    },
    check: checkMarkedItem,
  },

  co_scholastic_activities: {
    label: 'Co-Scholastic activities',
    // Same as assessments minus subjectId — term-wide, PLUS classIds: an
    // activity used to apply to every class in the school by default (there
    // was no field to say otherwise). classIds scopes it — absent or empty
    // still means "every class" for backward compatibility with docs written
    // before this field existed; a non-empty array narrows it to just those
    // class doc IDs. Entries within the array are not validated against the
    // live classes collection here — a school-schema `check` has no
    // Firestore access, only the shape of the one doc it's given — so
    // CoScholasticTab.vue does that check itself before writing.
    fields: {
      name: f(STRING),
      termId: f(STRING),
      order: f(NUMBER, { min: 1 }),
      entryType: f(STRING, { enum: ENTRY_TYPES }),
      maxMarks: f(NUMBER, { exclusiveMin: 0 }),
      gradingScaleId: f(STRING, { nullable: true }),
      conversionType: f(STRING, { enum: CONVERSION_TYPES }),
      conversionFactor: f(NUMBER, { nullable: true }),
      classIds: opt(ARRAY),
    },
    check: checkMarkedItem,
  },

  remark_categories: {
    label: 'Remark categories',
    fields: {
      label: f(STRING),
      order: f(NUMBER, { min: 1 }),
      remarks: f(ARRAY, { minLength: 1 }),
    },
    check(doc, errors) {
      const remarks = Array.isArray(doc.remarks) ? doc.remarks : []
      const seen = new Set()
      remarks.forEach((r, i) => {
        if (!r || typeof r !== 'object') return errors.push({ field: `remarks[${i}]`, reason: 'must be an object' })
        // `key` is stored as an entry field key in remarks_sheets/*/entries —
        // confirmed live. Once teachers have checked remarks it must not change.
        if (typeof r.key !== 'string' || !r.key.trim()) errors.push({ field: `remarks[${i}].key`, reason: 'required string' })
        else if (seen.has(r.key)) errors.push({ field: `remarks[${i}].key`, reason: `duplicate key "${r.key}"` })
        else seen.add(r.key)
        if (typeof r.text !== 'string' || !r.text.trim()) errors.push({ field: `remarks[${i}].text`, reason: 'required string' })
        if (!REMARK_TYPES.includes(r.type)) errors.push({ field: `remarks[${i}].type`, reason: `must be one of ${REMARK_TYPES.join(', ')}` })
        if (typeof r.order !== 'number') errors.push({ field: `remarks[${i}].order`, reason: 'required number' })
      })
    },
  },

  months: {
    label: 'Months',
    fields: {
      key: f(STRING, { pattern: MONTH_KEY_RE, hint: 'e.g. 2026-04' }),
      label: f(STRING),
      month: f(NUMBER, { min: 1, max: 12 }),
      year: f(NUMBER, { min: 2000, max: 2100 }),
      order: f(NUMBER),
      workingDays: f(NUMBER, { min: 0, max: 31 }),
    },
    check(doc, errors) {
      if (typeof doc.key === 'string' && MONTH_KEY_RE.test(doc.key)) {
        const [y, m] = doc.key.split('-').map(Number)
        if (typeof doc.year === 'number' && doc.year !== y) errors.push({ field: 'year', reason: `does not match key "${doc.key}"` })
        if (typeof doc.month === 'number' && doc.month !== m) errors.push({ field: 'month', reason: `does not match key "${doc.key}"` })
      }
    },
  },

  students: {
    label: 'Students',
    fields: {
      name: f(STRING),
      firstName: f(STRING),
      lastName: f(STRING, { allowEmpty: true }),
      currentClassId: f(STRING),
      type: f(STRING, { enum: ['student'] }),
      gender: opt(STRING, { allowEmpty: true }),
      dateOfBirth: opt(TIMESTAMP, { nullable: true }),
      email: opt(STRING, { allowEmpty: true }),
      phoneNo: opt(NUMBER, { nullable: true }),
      needsAuthCreation: opt(BOOL),
      surveyInbox: opt(ARRAY),
      reports: opt(ARRAY),
      // Added 2026-08-04 by explicit decision. admNo and grEmisSts are kept
      // SEPARATE: they are different registers and a school may quote either,
      // so merging them loses which one a number came from.
      admNo: opt(STRING, { allowEmpty: true }),
      grEmisSts: opt(STRING, { allowEmpty: true }),
      // PII. Readable by every signed-in app user under the current
      // firestore.rules read grant — narrowing that needs a rules change.
      aadhaarNumber: opt(STRING, { allowEmpty: true, pattern: AADHAAR_RE, hint: '12 digits' }),
    },
  },

  staffs: {
    label: 'Staff',
    fields: {
      id: f(STRING),
      staffId: f(STRING),
      name: f(STRING),
      firstName: f(STRING),
      lastName: f(STRING, { allowEmpty: true }),
      type: f(STRING),
      email: opt(STRING, { allowEmpty: true }),
      phoneNo: opt(NUMBER, { nullable: true }),
      sex: opt(STRING, { allowEmpty: true }),
      classIds: opt(ARRAY),
      assignments: opt(MAP),
      needsAuthCreation: opt(BOOL),
      authUid: opt(STRING, { nullable: true }),
    },
  },
}

/** Shared by assessments and co_scholastic_activities. */
function checkMarkedItem(doc, errors) {
  const needsScale = doc.entryType === 'grade' || doc.conversionType === 'marks_to_grade'
  if (needsScale && !doc.gradingScaleId) {
    errors.push({ field: 'gradingScaleId', reason: 'required when entryType is "grade" or conversionType is "marks_to_grade"' })
  }
  const needsFactor = doc.conversionType === 'sum_up' || doc.conversionType === 'sum_down'
  if (needsFactor && !doc.conversionFactor) {
    errors.push({ field: 'conversionFactor', reason: `required when conversionType is "${doc.conversionType}"` })
  }
  if (!needsFactor && doc.conversionFactor != null && doc.conversionType === 'none') {
    errors.push({ field: 'conversionFactor', reason: 'must be null when conversionType is "none"' })
  }
}

// ── type checking ───────────────────────────────────────────────────────────
function isTimestamp(v) {
  if (v instanceof Date) return true
  // Firestore Timestamp (client SDK) and the sentinel returned by
  // serverTimestamp() both survive validation — neither is a plain value.
  if (v && typeof v === 'object') {
    if (typeof v.toDate === 'function') return true
    if (typeof v._methodName === 'string') return true   // FieldValue sentinel
  }
  return false
}

function typeOk(type, v) {
  switch (type) {
    case STRING: return typeof v === 'string'
    case NUMBER: return typeof v === 'number' && !Number.isNaN(v)
    case BOOL: return typeof v === 'boolean'
    case ARRAY: return Array.isArray(v)
    case MAP: return !!v && typeof v === 'object' && !Array.isArray(v) && !isTimestamp(v)
    case TIMESTAMP: return isTimestamp(v)
    default: return false
  }
}

// Written by every dashboard save; never part of the teacher app's schema, so
// they are not "unknown" fields worth warning about.
const AUDIT_FIELDS = new Set(['created_at', 'created_by', 'updated_at', 'updated_by'])

/**
 * Validate one document payload.
 *
 * @param {string} collection  key of SCHOOL_SCHEMAS
 * @param {Object} doc         the payload about to be written
 * @param {Object} [options]
 * @param {boolean} [options.partial]  true for a merge/update write: only the
 *   fields PRESENT are checked, missing required fields are not an error. This
 *   is what lets a legacy malformed doc still be edited through the UI —
 *   validating the whole stored doc would make bad data unfixable.
 * @returns {{ok: boolean, errors: Array, warnings: Array}}
 */
export function validateDoc(collection, doc, options = {}) {
  const schema = SCHOOL_SCHEMAS[collection]
  if (!schema) return { ok: true, errors: [], warnings: [{ field: '', reason: `no schema defined for "${collection}"` }] }
  const partial = !!options.partial
  const errors = []
  const warnings = []

  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, errors: [{ field: '', reason: 'payload must be an object' }], warnings }
  }

  for (const [name, spec] of Object.entries(schema.fields)) {
    const present = Object.prototype.hasOwnProperty.call(doc, name)
    const v = doc[name]

    if (!present) {
      if (spec.required && !partial) errors.push({ field: name, reason: 'required' })
      continue
    }
    if (v === null || v === undefined) {
      if (spec.nullable) continue
      if (spec.required) errors.push({ field: name, reason: 'must not be null' })
      continue
    }
    if (!typeOk(spec.type, v)) {
      errors.push({ field: name, reason: `expected ${spec.type}, got ${Array.isArray(v) ? 'array' : typeof v}` })
      continue
    }
    if (spec.type === STRING) {
      if (!v.trim() && !spec.allowEmpty && spec.required) errors.push({ field: name, reason: 'must not be empty' })
      if (spec.enum && !spec.enum.includes(v)) errors.push({ field: name, reason: `must be one of ${spec.enum.join(', ')}` })
      if (spec.pattern && v && !spec.pattern.test(v)) errors.push({ field: name, reason: `malformed${spec.hint ? ` — ${spec.hint}` : ''}` })
    }
    if (spec.type === NUMBER) {
      if (spec.min !== undefined && v < spec.min) errors.push({ field: name, reason: `must be at least ${spec.min}` })
      if (spec.max !== undefined && v > spec.max) errors.push({ field: name, reason: `must be at most ${spec.max}` })
      if (spec.exclusiveMin !== undefined && v <= spec.exclusiveMin) errors.push({ field: name, reason: `must be greater than ${spec.exclusiveMin}` })
    }
    if (spec.type === ARRAY && spec.minLength && v.length < spec.minLength) {
      errors.push({ field: name, reason: `needs at least ${spec.minLength} item(s)` })
    }
  }

  for (const name of Object.keys(doc)) {
    if (!schema.fields[name] && !AUDIT_FIELDS.has(name)) {
      warnings.push({ field: name, reason: 'not part of the known schema — it will be written but nothing reads it' })
    }
  }

  if (typeof schema.check === 'function') schema.check(doc, errors)

  return { ok: errors.length === 0, errors, warnings }
}

/** One-line human summary, for a toast or an import row. */
export function formatErrors(errors) {
  return (errors || []).map(e => (e.field ? `${e.field}: ${e.reason}` : e.reason)).join('; ')
}
