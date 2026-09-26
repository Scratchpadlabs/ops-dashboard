/**
 * Freeze / unfreeze logic for the teacher app's four Smart Sheet types, kept free of Firestore
 * and Vue so it can be tested on its own (tests/sheetFreeze.test.mjs). SheetsStatusTab.vue does
 * the reads and writes; everything here works on plain `{ id, data }` sheet docs.
 *
 * Where each type lives (as the teacher app writes them — src/views/smart-sheets/SmartSheets.vue):
 *   - Academics:     smart_sheet_entries, one per class + term + subject (has subjectId)
 *   - Co-Scholastic: smart_sheet_entries with type "co-scholastic", one per class + term (no subjectId)
 *   - Attendance:    attendance_sheets, per class — one month-wise sheet plus one day-wise sheet per
 *                    month. NOT per term.
 *   - Remarks:       remarks_sheets, one per class. NOT per term.
 *
 * Duplicates exist in real data (functions/sheets_overview found 3-4 sheets of one type for some
 * classes). The teacher app opens whichever duplicate holds the most entries, so freezing only one
 * of them could leave the one teachers actually open unfrozen. Every row here therefore stands for
 * ALL the sheet docs of that class (+ subject), and freezing a row freezes each of them.
 */

export const SHEET_TYPES = [
  { key: 'academics', label: 'Academics', collection: 'smart_sheet_entries', termScoped: true },
  { key: 'co-scholastic', label: 'Co-Scholastic', collection: 'smart_sheet_entries', termScoped: true },
  { key: 'attendance', label: 'Attendance', collection: 'attendance_sheets', termScoped: false },
  { key: 'remarks', label: 'Remarks', collection: 'remarks_sheets', termScoped: false },
]

export function sheetType(key) {
  const t = SHEET_TYPES.find(t => t.key === key)
  if (!t) throw new Error(`Unknown sheet type "${key}"`)
  return t
}

const isCoScholastic = data => data?.type === 'co-scholastic'

/**
 * Which row a sheet doc belongs to for this type, or null if it isn't a sheet of this type.
 * Academics and co-scholastic docs share a collection, so each must skip the other's docs.
 */
export function rowKeyFor(typeKey, data) {
  if (!data || !data.classId) return null
  switch (typeKey) {
    case 'academics':
      return !isCoScholastic(data) && data.subjectId ? `${data.classId}__${data.subjectId}` : null
    case 'co-scholastic':
      return isCoScholastic(data) ? data.classId : null
    case 'attendance':
    case 'remarks':
      return data.classId
    default:
      throw new Error(`Unknown sheet type "${typeKey}"`)
  }
}

function toMillis(ts) {
  if (!ts) return 0
  if (typeof ts.toMillis === 'function') return ts.toMillis()
  if (typeof ts.toDate === 'function') return ts.toDate().getTime()
  const n = new Date(ts).getTime()
  return Number.isNaN(n) ? 0 : n
}

/**
 * One row per class (per class + subject for academics) that the school has set up, plus a row for
 * any sheet whose class/subject is no longer set up — so a sheet frozen before its class was
 * removed can still be found and unfrozen.
 *
 * docs: sheet docs from the type's collection (for term-scoped types, already filtered to the term).
 * Row fields:
 *   sheets       [{ id, isFrozen }] — every doc behind the row
 *   exists       at least one doc (a teacher has opened this sheet)
 *   isFrozen     exists and every doc is frozen
 *   partlyFrozen some docs frozen and some not
 *   configured   false for a row that only exists because of an orphaned sheet
 */
export function buildRows(typeKey, classes, docs) {
  sheetType(typeKey)
  const byKey = new Map()
  for (const d of docs) {
    const key = rowKeyFor(typeKey, d.data)
    if (key === null) continue
    if (!byKey.has(key)) byKey.set(key, [])
    byKey.get(key).push(d)
  }

  const expected = []
  for (const cls of classes) {
    if (typeKey === 'academics') {
      for (const s of cls.subjects || []) {
        if (s?.subjectId) expected.push({ key: `${cls.id}__${s.subjectId}`, classId: cls.id, subjectId: s.subjectId })
      }
    } else {
      expected.push({ key: cls.id, classId: cls.id, subjectId: null })
    }
  }
  const expectedKeys = new Set(expected.map(e => e.key))
  const orphans = [...byKey.keys()]
    .filter(k => !expectedKeys.has(k))
    .map(k => {
      const data = byKey.get(k)[0].data
      return { key: k, classId: data.classId, subjectId: typeKey === 'academics' ? data.subjectId : null, orphan: true }
    })

  return [...expected, ...orphans].map(({ key, classId, subjectId, orphan }) => {
    const matched = byKey.get(key) || []
    const sheets = matched.map(d => ({ id: d.id, isFrozen: d.data.isFrozen === true }))
    const frozenCount = sheets.filter(s => s.isFrozen).length
    // Most recent edit wins; on a tie (including sheets with no timestamp at all) prefer one that
    // at least names an editor, so "By" isn't blanked for older sheets without lastEditedAt.
    let last = null
    for (const d of matched) {
      const t = toMillis(d.data.lastEditedAt)
      const lastT = toMillis(last?.lastEditedAt)
      if (!last || t > lastT || (t === lastT && !last.lastEditedBy && d.data.lastEditedBy)) last = d.data
    }
    return {
      key, classId, subjectId,
      configured: !orphan,
      sheets,
      exists: sheets.length > 0,
      isFrozen: sheets.length > 0 && frozenCount === sheets.length,
      partlyFrozen: frozenCount > 0 && frozenCount < sheets.length,
      lastEditedAt: last?.lastEditedAt || null,
      lastEditedBy: last?.lastEditedBy || null,
    }
  })
}

/** Sheet doc ids that need writing to bring these rows to `frozen` — docs already there are skipped. */
export function idsToWrite(rows, frozen) {
  const ids = new Set()
  for (const r of rows) {
    for (const s of r.sheets || []) {
      if (s.isFrozen !== frozen) ids.add(s.id)
    }
  }
  return [...ids]
}

/** Firestore batches take at most 500 writes; stay under it. */
export function chunk(items, size = 450) {
  if (!(size > 0)) throw new Error('chunk size must be positive')
  const out = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** Mirror a successful write in the rows without reloading them. */
export function applyFrozen(rows, ids, frozen) {
  const changed = new Set(ids)
  for (const r of rows) {
    let touched = false
    for (const s of r.sheets) {
      if (changed.has(s.id)) { s.isFrozen = frozen; touched = true }
    }
    if (touched) {
      const n = r.sheets.filter(s => s.isFrozen).length
      r.isFrozen = r.sheets.length > 0 && n === r.sheets.length
      r.partlyFrozen = n > 0 && n < r.sheets.length
    }
  }
}

export function sortRows(rows, className = id => id, subjectName = id => id) {
  return [...rows].sort((a, b) =>
    String(className(a.classId)).localeCompare(String(className(b.classId)), undefined, { numeric: true }) ||
    String(subjectName(a.subjectId) ?? '').localeCompare(String(subjectName(b.subjectId) ?? '')) ||
    a.key.localeCompare(b.key))
}
