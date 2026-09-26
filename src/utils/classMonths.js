/**
 * Per-class attendance months — pure helpers for the School Setup Months tab.
 *
 * The teacher app reads a class's attendance months (and each month's working
 * days) from schools/{id}/classes/{classId}/months, one doc per month keyed
 * "YYYY-MM" (scratchpad_teacher SmartSheets.vue fetchMonths). The dashboard
 * reads/writes them through the class_months callable; everything here is
 * Firestore-free so it can be tested with `node --test`.
 */

export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December']

export const DEFAULT_WORKING_DAYS = 22

export const monthKey = (year, month) => `${year}-${String(month).padStart(2, '0')}`

export const cellId = (classId, key) => `${classId}|${key}`

/** The months an academic year spans, in order. */
export function buildAcademicYear({ startMonth, startYear, span }) {
  const out = []
  for (let i = 0; i < span; i++) {
    const month = ((startMonth - 1 + i) % 12) + 1
    const year = startYear + Math.floor((startMonth - 1 + i) / 12)
    out.push({ key: monthKey(year, month), label: `${MONTH_NAMES[month - 1]} ${year}`, month, year, order: i + 1 })
  }
  return out
}

/** "Class 10" before "Class 9" is wrong — compare names with numeric awareness. */
export function compareClasses(a, b) {
  return String(a.name || a.id).localeCompare(String(b.name || b.id), undefined, { numeric: true, sensitivity: 'base' })
}

/**
 * Month columns = the union of every class's months, by key. The first class
 * that has a key supplies its label/month/year/order, so a month added to a
 * class that lacks it gets the same metadata as everyone else.
 */
export function buildColumns(classes) {
  const byKey = new Map()
  for (const c of classes) {
    for (const m of c.months || []) {
      if (!m.key || byKey.has(m.key)) continue
      byKey.set(m.key, { key: m.key, label: m.label || m.key, month: m.month, year: m.year, order: m.order })
    }
  }
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key))
}

/** { [cellId]: monthDoc } for every month every class already has. */
export function indexMonths(classes) {
  const out = {}
  for (const c of classes) for (const m of c.months || []) out[cellId(c.id, m.key)] = m
  return out
}

/** Pick only the fields the months schema allows. */
export function monthPayload(meta, workingDays) {
  return {
    key: meta.key,
    label: meta.label,
    month: meta.month,
    year: meta.year,
    order: meta.order,
    workingDays,
  }
}

/**
 * Turn pending cell edits into class_months save rows. An edit on a month the
 * class already has keeps that doc's own label/order; an edit on a month it
 * lacks borrows the column's metadata.
 */
export function editsToRows(edits, existing, columns) {
  const colByKey = new Map(columns.map(c => [c.key, c]))
  const rows = []
  for (const [id, workingDays] of Object.entries(edits)) {
    if (workingDays == null || Number.isNaN(workingDays)) continue
    const sep = id.lastIndexOf('|')
    const classId = id.slice(0, sep)
    const key = id.slice(sep + 1)
    const meta = existing[id] || colByKey.get(key)
    if (!meta) continue
    rows.push({ classId, ...monthPayload({ ...meta, key }, workingDays) })
  }
  return rows
}

/**
 * Rows that give each target class the given months. When a class already has
 * a month, its working days are kept unless `overwriteWorkingDays` is set —
 * regenerating a calendar should not wipe numbers someone typed in.
 */
export function rowsForMonths(months, classIds, existing, { overwriteWorkingDays = false, defaultWorkingDays = DEFAULT_WORKING_DAYS } = {}) {
  const rows = []
  for (const classId of classIds) {
    for (const m of months) {
      const have = existing[cellId(classId, m.key)]
      const fallback = m.workingDays ?? defaultWorkingDays
      const workingDays = have && !overwriteWorkingDays && have.workingDays != null ? have.workingDays : fallback
      rows.push({ classId, ...monthPayload(m, workingDays) })
    }
  }
  return rows
}

/** Flat CSV rows (one per class-month), classes then months in order. */
export function toCsvRows(classes) {
  const out = []
  for (const c of [...classes].sort(compareClasses)) {
    for (const m of c.months || []) out.push({ classId: c.id, className: c.name || c.id, ...monthPayload(m, m.workingDays) })
  }
  return out
}
