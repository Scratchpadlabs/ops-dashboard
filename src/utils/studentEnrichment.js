/**
 * Match a school's own CSV onto students that already exist, and fill in the
 * fields it carries — pure, no Firestore.
 *
 * DIFFERENT FROM THE ROSTER IMPORT. That one CREATES students from a file,
 * minting doc ids as `{classId}_{name}`. This one creates nobody: students are
 * registered first and authenticated second, and by the time this runs each of
 * them already has an id. A row whose id matches nothing is reported, never
 * invented.
 *
 * FILL GAPS, NEVER OVERWRITE (ops decision). A student who already has a value
 * keeps it. The CSV can only contribute fields that are absent, so a correction
 * made by hand in the dashboard cannot be silently undone by re-uploading last
 * term's export. It also makes a re-run a no-op.
 *
 * SCHEMA GROWS WITH THE DATA. Fields differ widely between schools, so any
 * column this accepts is also proposed for `config/students_schema.columns` —
 * the list the import flow shows when a roster arrives. A field missing there
 * is a field ops cannot map.
 */

/**
 * Fields never written to a student document.
 *
 * Mirrors BANNED_KEYS in functions/generate_import/main.py, which is the server
 * side of golden rule 3 and the gate that actually holds — this list is the
 * browser's half and is a UX guard, not the enforcement.
 *
 * `address` and `category` were removed from the ban on 2026-08-20 by an
 * explicit ops decision to persist them, the same way `aadhaar` was on
 * 2026-08-04. NOTE the consequence, unchanged since that earlier decision:
 * firestore.rules grants
 *   match /schools/{schoolId}/{collection}/{docId} { allow read: if isAuthenticated(); }
 * so every student document — and therefore every field this writes — is
 * readable by ANY signed-in user of the teacher and student apps. The write
 * path being ops-admin-only does not narrow that. Restricting who can READ
 * these needs a rules change, not a code change.
 */
export const BANNED_KEYS = ['sssm_id', 'sssm', 'caste', 'religion']

/** Columns that are structural, not student data — never proposed as fields. */
const NON_FIELD_COLUMNS = ['s.no', 'sno', 'sr no', 'serial', 'serial no']

/** A CSV header turned into a Firestore-safe field key. */
export function fieldKeyFor(header) {
  const cleaned = String(header || '').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  if (!cleaned) return ''
  // camelCase, matching the keys already on a student doc (firstName, dateOfBirth).
  const [head, ...rest] = cleaned
    // "EmailID"/"Email Id" both mean email; without this the key reads
    // fatherEmailid, which nothing else in the schema would match.
    .replace(/_?emailid$/, '_email')
    .replace(/_mobile_?no$/, '_mobile')
    .split('_')
  return head + rest.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('')
}

export function isBannedKey(key) {
  const k = String(key || '').toLowerCase()
  return BANNED_KEYS.some(b => k === b || k === b.replace(/_/g, ''))
}

function isBlank(v) {
  return v === undefined || v === null || String(v).trim() === ''
}

/** Guess a students_schema column type from the values a column actually holds. */
export function inferColumnType(values) {
  const seen = values.map(v => String(v ?? '').trim()).filter(Boolean)
  if (!seen.length) return 'text'
  // Real exports use "16 Jan 2024" as often as an ISO date — Hillgreen's does.
  const DATE_SHAPES = [
    /^\d{4}-\d{2}-\d{2}$/,                                  // 2024-01-16
    /^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/,                       // 16/01/2024
    /^\d{1,2}[ -][A-Za-z]{3,9}[ -]\d{2,4}$/,                  // 16 Jan 2024
    /^[A-Za-z]{3,9}[ -]\d{1,2},?[ -]\d{2,4}$/,                // Jan 16 2024
  ]
  if (seen.every(v => DATE_SHAPES.some(re => re.test(v)))) return 'date'
  // A small, repeating vocabulary is a dropdown; free text is not.
  const distinct = new Set(seen.map(v => v.toLowerCase()))
  if (distinct.size <= 8 && seen.length >= distinct.size * 3) return 'select'
  return 'text'
}

/**
 * @param {object[]} csvRows      parsed CSV rows, keyed by header
 * @param {string}   idColumn     which header holds the registration id
 * @param {object[]} students     existing student docs ({ id, ...fields })
 * @param {object[]} schemaColumns config/students_schema.columns
 */
export function buildEnrichmentPlan({
  csvRows = [], idColumn = '', students = [], schemaColumns = [],
} = {}) {
  const headers = csvRows.length ? Object.keys(csvRows[0]) : []
  const knownKeys = new Set((schemaColumns || []).map(c => c.key))

  // Students are looked up by document id AND by their `id` field: registration
  // and the roster import have minted both shapes over time.
  const byId = new Map()
  for (const s of students) {
    if (s.id) byId.set(String(s.id).trim(), s)
    if (s.docId) byId.set(String(s.docId).trim(), s)
    const own = s.id ?? s.docId
    if (own) byId.set(String(own).trim().toLowerCase(), s)
  }

  // ── which columns become fields ────────────────────────────────────────
  const columns = []
  for (const h of headers) {
    if (h === idColumn) continue
    const lower = String(h || '').trim().toLowerCase()
    if (!lower || NON_FIELD_COLUMNS.includes(lower)) continue
    const key = fieldKeyFor(h)
    if (!key) continue
    if (isBannedKey(key) || isBannedKey(lower)) {
      columns.push({ header: h, key, status: 'banned',
                     reason: 'golden rule 3 — never stored on a student' })
      continue
    }
    columns.push({
      header: h,
      key,
      status: knownKeys.has(key) ? 'known' : 'new',
      type: inferColumnType(csvRows.map(r => r[h])),
    })
  }
  const writable = columns.filter(c => c.status !== 'banned')

  // ── match each row ─────────────────────────────────────────────────────
  const matched = []
  const unmatched = []
  const seenIds = new Set()
  let duplicates = 0

  for (const [i, row] of csvRows.entries()) {
    const raw = String(row[idColumn] ?? '').trim()
    if (!raw) {
      unmatched.push({ row: i + 2, id: '', reason: 'no id in that column' })
      continue
    }
    const student = byId.get(raw) || byId.get(raw.toLowerCase())
    if (!student) {
      unmatched.push({ row: i + 2, id: raw, reason: 'no student with this id' })
      continue
    }
    if (seenIds.has(raw)) {
      duplicates++
      unmatched.push({ row: i + 2, id: raw, reason: 'this id appears more than once in the file' })
      continue
    }
    seenIds.add(raw)

    // Fill gaps only: a field the student already has is left exactly as it is.
    const fields = {}
    const skippedFilled = []
    for (const c of writable) {
      const value = row[c.header]
      if (isBlank(value)) continue
      if (!isBlank(student[c.key])) { skippedFilled.push(c.key); continue }
      fields[c.key] = String(value).trim()
    }
    matched.push({
      row: i + 2,
      id: raw,
      docId: student.docId || student.id,
      name: student.name || student.firstName || '',
      fields,
      fieldCount: Object.keys(fields).length,
      skippedFilled,
    })
  }

  const withChanges = matched.filter(m => m.fieldCount > 0)
  return {
    columns,
    newColumns: columns.filter(c => c.status === 'new'),
    bannedColumns: columns.filter(c => c.status === 'banned'),
    matched,
    withChanges,
    unmatched,
    duplicates,
    totals: {
      rows: csvRows.length,
      matched: matched.length,
      unmatched: unmatched.length,
      studentsToUpdate: withChanges.length,
      fieldsToWrite: withChanges.reduce((n, m) => n + m.fieldCount, 0),
      newSchemaColumns: columns.filter(c => c.status === 'new').length,
      // Columns come from the file's HEADERS, so they exist whether or not a
      // single row found a student. Callers must not offer to add them on the
      // strength of that count alone — a file that matched nothing has not been
      // shown to belong to this school at all.
      matchRate: csvRows.length ? matched.length / csvRows.length : 0,
    },
    // Adding columns to students_schema changes what ops can map on every
    // future import. Require evidence the file is even this school's.
    canAddColumns: matched.length > 0,
    isEmpty: withChanges.length === 0 && columns.filter(c => c.status === 'new').length === 0,
  }
}

/**
 * The school's own extra columns, as {key, label, value} triples.
 *
 * The importer maps a fixed vocabulary (name, gender, dob, class, admNo…) and
 * every school's file carries more than that — House, Bus Route, Blood Group.
 * Those used to be dropped, so ops could never get a school's own data into
 * that school. `extras` is what the parser carried through under the header
 * text; this turns each into the camelCase key the rest of a student doc uses,
 * keeping the header as the label config/students_schema will show.
 *
 * Golden rule 3 is enforced twice on purpose: the Cloud Function drops a
 * caste/religion/SSSM column before it is ever staged, and this drops it again
 * on the way out, so neither end alone is load-bearing.
 */
export function extraColumnsFor(extras) {
  const out = []
  for (const [header, value] of Object.entries(extras || {})) {
    const v = String(value ?? '').trim()
    if (!v) continue
    const key = fieldKeyFor(header)
    if (!key || isBannedKey(key)) continue
    out.push({ key, label: header, value: v })
  }
  return out
}

/** Same thing flattened into a payload fragment. */
export function extraFieldsFor(extras) {
  return Object.fromEntries(extraColumnsFor(extras).map(c => [c.key, c.value]))
}

/**
 * The students_schema columns a committed plan would need, minus the ones the
 * school already has.
 *
 * config/students_schema is what the import mapper offers ops on every future
 * roster, and the teacher app reads it too — so growing it is a bigger
 * decision than filling in one student, and gets its own confirmation rather
 * than riding along with the commit.
 *
 * The TYPE is inferred from the values this file actually carried in that
 * column, not from the header text: "16 Jan 2024" is a date whatever the
 * column is called.
 */
export function newSchemaColumnsFor(plan, schemaColumns = []) {
  const known = new Set((schemaColumns || []).map(c => c.key))
  const valuesByKey = new Map()
  const labelByKey = new Map()
  for (const item of plan?.items || []) {
    for (const c of item.extraColumns || []) {
      if (!c.key || known.has(c.key) || isBannedKey(c.key)) continue
      if (!labelByKey.has(c.key)) labelByKey.set(c.key, c.label || c.key)
      if (!valuesByKey.has(c.key)) valuesByKey.set(c.key, [])
      valuesByKey.get(c.key).push(c.value)
    }
  }
  const columns = [...labelByKey.entries()].map(([key, label]) => ({
    key, header: label, type: inferColumnType(valuesByKey.get(key) || []),
  }))
  return schemaColumnsFor(columns, schemaColumns)
}

/** New students_schema columns, ordered after the ones already there. */
export function schemaAdditionsFor(plan, schemaColumns = []) {
  return schemaColumnsFor(plan.newColumns, schemaColumns)
}

/**
 * {key, header, type}[] -> students_schema column entries, numbered after the
 * ones a school already has.
 *
 * Shared by the two screens that can grow this array — the enrichment screen
 * and the roster import — because a column added by one has to look exactly
 * like a column added by the other. The teacher app reads this list, and two
 * shapes for the same idea is how it ends up reading half of it.
 */
export function schemaColumnsFor(columns, schemaColumns = []) {
  let order = Math.max(0, ...schemaColumns.map(c => Number(c.order) || 0))
  return (columns || []).map(c => ({
    key: c.key,
    label: c.header ?? c.label ?? c.key,
    type: c.type || 'text',
    editable: true,
    order: ++order,
  }))
}
