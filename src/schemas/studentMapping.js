/**
 * Import row → student document, in the shape the teacher app actually reads.
 *
 * PERSISTED (2026-08-04 decision): admNo, grEmisSts and aadhaarNumber. Every
 * other extra source column is review-only — listed in UNMAPPED_SOURCE_FIELDS
 * and reported per row.
 *
 * THE BUG THIS FIXES (AUDIT.md §3.2): buildStudentsPlan mapped extractor
 * fields 1:1 into the student doc, so every import wrote
 *   srNo, admNo, motherName, fatherName, contactNumber, rollNo, city
 * — none of which exist on ANY live student document in ANY school — while
 * omitting firstName/lastName/type, which every live document has, and writing
 * `dob` as a string beside the app's `dateOfBirth` timestamp. The lone `dob`
 * string on 1 of 25 sampled SAMARTH students is that bug's fingerprint.
 *
 * Source files vary wildly; the output of this module does not. Anything the
 * real schema has no home for is DROPPED AND REPORTED — never silently written
 * into a field nothing reads.
 */

/**
 * How a single source name column becomes firstName + lastName.
 *
 * Source files almost always carry one full-name column. There is no way to
 * split that unambiguously — Maharashtrian records in this estate use
 * surname-first ("Patole Monika Sachin"), and SAMARTH's own seed rows have
 * firstName/lastName filled inconsistently with `name`.
 *
 * So: `name` is ALWAYS the verbatim source string and is the authoritative
 * field. firstName/lastName are derived by this single rule, and the import
 * preview shows the derived values on every row so the split is reviewed
 * before anything is committed. Flip this constant to change the convention.
 */
export const NAME_ORDER = 'given-first'   // 'given-first' | 'surname-first'

export function splitName(fullName) {
  const parts = String(fullName ?? '').trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return { firstName: '', lastName: '' }
  if (parts.length === 1) return { firstName: parts[0], lastName: '' }
  return NAME_ORDER === 'surname-first'
    ? { firstName: parts[parts.length - 1], lastName: parts.slice(0, -1).join(' ') }
    : { firstName: parts[0], lastName: parts.slice(1).join(' ') }
}

/**
 * ISO date string -> Date (written as a Firestore timestamp).
 *
 * The extractor has already done the hard part: normalize.py's
 * parse_dob_flexible accepts dd/mm/yyyy, dd-mm-yyyy, dd.mm.yyyy, yyyy-mm-dd
 * and Excel serials, and emits ISO or '' for unparseable. Date parsing is NOT
 * duplicated here — that is how the two ends drift.
 *
 * Unparseable/blank -> null. A bad date of birth does not block a roster
 * import; the row is flagged in the preview instead.
 */
export function toDateOfBirth(iso) {
  const s = String(iso ?? '').trim()
  if (!s) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return null
  const [, y, mo, d] = m.map(Number)
  const dt = new Date(Date.UTC(y, mo - 1, d))
  // Rejects 2026-02-31 and friends, which Date would silently roll over.
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null
  return dt
}

/** Live docs store phoneNo as a NUMBER. Non-numeric -> null. */
export function toPhoneNo(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '')
  if (!digits) return null
  const n = Number(digits)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

/**
 * Extractor fields with no home in the student schema. Dropped deliberately,
 * and surfaced per row so an operator can see what the file carried that the
 * app has nowhere to put.
 */
export const UNMAPPED_SOURCE_FIELDS = [
  'sr_no', 'roll_no', 'mother_name', 'father_name', 'city', 'address',
  // Decision (Sid, 2026-08-04): parsed and shown in Review, deliberately NOT
  // persisted — the student document has one phoneNo/email and no parent
  // contact fields. Surfaced per row rather than dropped in silence.
  'father_mobile', 'father_email', 'mother_mobile', 'mother_email',
  'branch_name', 'board', 'enrollment_code', 'date_of_admission', 'status',
  'using_transport',
]

/** Digits only — an Aadhaar cell arrives as "1234 5678 9012" or "1234-5678-9012". */
export function toAadhaar(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '')
  return digits.length === 12 ? digits : ''
}

/**
 * @param {Object} row      extractor row (student_name, gender, dob, contact, …)
 * @param {Object} opts
 * @param {string} opts.classId  resolved class ID for currentClassId
 * @returns {{payload: Object, dropped: string[], warnings: string[]}}
 */
export function mapImportRowToStudent(row, { classId } = {}) {
  const d = row || {}
  const name = String(d.student_name ?? '').trim()
  const { firstName, lastName } = splitName(name)
  const warnings = []

  const dob = String(d.dob ?? '').trim()
  const dateOfBirth = toDateOfBirth(dob)
  if (dob && !dateOfBirth) warnings.push(`date of birth "${dob}" is unreadable — saved as empty`)

  const phoneNo = toPhoneNo(d.contact)
  if (String(d.contact ?? '').trim() && phoneNo === null) {
    warnings.push(`contact "${d.contact}" is not a usable number — saved as empty`)
  }
  if (!lastName && name) warnings.push(`"${name}" is a single word — lastName saved as empty`)

  const dropped = UNMAPPED_SOURCE_FIELDS.filter(k => String(d[k] ?? '').trim())

  // Aadhaar: 12 digits or nothing. A partial/garbled value is reported and
  // dropped rather than written half-formed.
  const aadhaarRaw = String(d.aadhaar ?? '').trim()
  const aadhaarNumber = toAadhaar(aadhaarRaw)
  if (aadhaarRaw && !aadhaarNumber) {
    warnings.push(`Aadhaar "${aadhaarRaw}" is not 12 digits — saved as empty`)
  }

  const payload = {
    name,
    firstName,
    lastName,
    gender: String(d.gender ?? '').trim(),
    email: String(d.email ?? '').trim(),
    phoneNo,
    dateOfBirth,
    currentClassId: classId || '',
    type: 'student',
    // Kept as two separate registers by explicit decision — see schoolSchema.js.
    admNo: String(d.adm_no ?? '').trim(),
    grEmisSts: String(d.gr_emis_sts ?? '').trim(),
    aadhaarNumber,
  }

  return { payload, dropped, warnings }
}
