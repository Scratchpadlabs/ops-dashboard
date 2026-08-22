/**
 * Import row → student document, in the shape the teacher app actually reads.
 *
 * PERSISTED: everything the parser can read off the file. The 2026-08-04
 * decision persisted only admNo, grEmisSts and aadhaarNumber and left the rest
 * review-only; that was reversed on 2026-08-22 — a roster import has to land
 * ALL the data the file carried, because the source file is not kept and
 * whatever is dropped here is simply gone. Each source column now has a named
 * home on the student document (see SOURCE_FIELD_MAP), and those homes are
 * declared in schoolSchema.js / school_schema.py so they validate rather than
 * arriving as unknown fields.
 *
 * The ONE exception is `address`, still not persisted: it is in the
 * extractor's BANNED_KEYS and is not in STUDENT_SCHEMA_KEYS, so it never
 * reaches a review row in the first place. Persisting it is a privacy
 * decision, not an import one — every student doc is readable by any signed-in
 * app user under the current firestore.rules (see schoolSchema.js on
 * aadhaarNumber), so it needs a rules change first.
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
 * Source column → student document field, for every column that is carried
 * through verbatim as a trimmed string.
 *
 * Naming follows the live documents' camelCase (`admNo`, `grEmisSts`,
 * `phoneNo`), not the extractor's snake_case. Columns needing a type
 * conversion (mobiles → number, admission date → timestamp) are handled in
 * mapImportRowToStudent instead and are NOT listed here.
 */
export const SOURCE_FIELD_MAP = {
  sr_no: 'srNo',
  roll_no: 'rollNo',
  father_name: 'fatherName',
  mother_name: 'motherName',
  father_email: 'fatherEmail',
  mother_email: 'motherEmail',
  city: 'city',
  branch_name: 'branchName',
  board: 'board',
  enrollment_code: 'enrollmentCode',
  status: 'status',
  using_transport: 'usingTransport',
}

/**
 * Source columns the parser reads but that are still not written. `address` is
 * the only one — see the module header. Kept as a named list (rather than an
 * empty concept) so a row carrying one is still reported, not silently lost.
 */
export const UNMAPPED_SOURCE_FIELDS = ['address']

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

  // Parent mobiles follow phoneNo's convention (stored as a number), so an
  // unusable value is reported the same way rather than written half-formed.
  const fatherMobile = toPhoneNo(d.father_mobile)
  if (String(d.father_mobile ?? '').trim() && fatherMobile === null) {
    warnings.push(`father's mobile "${d.father_mobile}" is not a usable number — saved as empty`)
  }
  const motherMobile = toPhoneNo(d.mother_mobile)
  if (String(d.mother_mobile ?? '').trim() && motherMobile === null) {
    warnings.push(`mother's mobile "${d.mother_mobile}" is not a usable number — saved as empty`)
  }

  const doa = String(d.date_of_admission ?? '').trim()
  const dateOfAdmission = toDateOfBirth(doa)
  if (doa && !dateOfAdmission) warnings.push(`date of admission "${doa}" is unreadable — saved as empty`)

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
    fatherMobile,
    motherMobile,
    dateOfAdmission,
  }
  for (const [sourceKey, field] of Object.entries(SOURCE_FIELD_MAP)) {
    payload[field] = String(d[sourceKey] ?? '').trim()
  }

  return { payload, dropped, warnings }
}
