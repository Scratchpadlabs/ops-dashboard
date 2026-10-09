/**
 * Match a school's own student list (the Excel they send us) against the
 * students in the teacher app, to find:
 *
 *   - students in the system who are NOT in the school's list (candidates
 *     for removal — stale, duplicate or test entries)
 *   - students in the school's list who are NOT in the system (to add)
 *   - students found in both but in a different class (kept, flagged)
 *
 * Matching, strongest first, each student used at most once:
 *   1. scholar / admission number (file "SC.NO." / "Adm No" vs student admNo)
 *   2. name + class (names compared without MISS/MASTER/MR…, spacing or
 *      punctuation; classes via a classKey function the caller supplies,
 *      so "III - A" in the file meets "III_A" in the system)
 *   3. name alone, when it is unique on both sides — a class change
 *
 * Pure functions, no Firestore: the dialog (RosterMatchDialog.vue) reads the
 * file and the roster and does the writes.
 */

const TITLE = /^(MISS|MASTER|MAST|MSTR|MAS|MR|MRS|MS|KUMARI|KUM|KU|KM|SHRI|SMT|BABY)\b\.?\s*/

/** "MISS  Girisha Rathod." → "GIRISHA RATHOD" */
export function normName(name) {
  let s = String(name ?? '').toUpperCase().replace(/[^A-Z\s]/g, ' ').replace(/\s+/g, ' ').trim()
  let prev
  do { prev = s; s = s.replace(TITLE, '').trim() } while (s !== prev)
  return s
}

/** "R-4490" / "r 4490" → "R4490" */
export function normId(id) {
  return String(id ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
}

const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim()
const norm = (v) => clean(v).toUpperCase().replace(/[^A-Z0-9]/g, '')

function findCol(header, patterns) {
  const keys = header.map(norm)
  for (const p of patterns) {
    const i = keys.findIndex(k => p.test(k))
    if (i >= 0) return i
  }
  return -1
}

/**
 * Students from a sheet as an array of rows (arrays of cells). Handles the
 * sectioned layout schools send ("CLASS NURSERY A" line, a header row, then
 * students) and a flat one with a Class (and optional Section) column.
 */
export function parseRosterRows(rows) {
  const out = []
  let sectionClass = ''
  let cols = null
  rows.forEach((raw, idx) => {
    const cells = (raw || []).map(c => clean(c))
    if (!cells.some(Boolean)) return
    const first = cells.find(Boolean)
    const firstNorm = norm(first)

    // "CLASS NURSERY A" on its own line starts a section.
    if (/^CLASS/.test(firstNorm) && cells.filter(Boolean).length <= 2 && !/NAME/.test(firstNorm)) {
      sectionClass = clean(first.replace(/^\s*class\s*[:\-]?\s*/i, '')) || clean(cells.filter(Boolean)[1])
      return
    }
    // A header row: a name column plus at least one other usual heading.
    const nameCol = findCol(cells, [/^NAMEOFSTUDENT/, /^STUDENTNAME/, /^STUDENTSNAME/, /^NAME$/])
    const looksHeader = cells.some(c => /^(SN|SNO|SRNO|SR|ROLL|ROLLNO|GENDER|SEX|DOB|CLASS)$/.test(norm(c)))
    if (nameCol >= 0 && looksHeader) {
      cols = {
        name: nameCol,
        id: findCol(cells, [/^SCNO/, /^SCHOLARNO/, /^ADMNO/, /^ADMISSIONNO/, /^ADMISSION/, /^GRNO/]),
        cls: findCol(cells, [/^CLASS$/, /^CLASSSECTION/, /^STD$/, /^GRADE$/]),
        section: findCol(cells, [/^SECTION$/, /^SEC$/, /^DIV$/, /^DIVISION$/]),
        roll: findCol(cells, [/^ROLLNO/, /^ROLL$/]),
        gender: findCol(cells, [/^GENDER/, /^SEX$/]),
        dob: findCol(cells, [/^DOB$/, /^DATEOFBIRTH/]),
      }
      return
    }
    if (!cols) return
    const name = clean(cells[cols.name])
    if (!name || !normName(name)) return
    const cls = cols.cls >= 0 && cells[cols.cls]
      ? clean([cells[cols.cls], cols.section >= 0 ? cells[cols.section] : ''].filter(Boolean).join(' '))
      : sectionClass
    out.push({
      row: idx + 1,
      name,
      className: cls,
      scholarNo: cols.id >= 0 ? clean(cells[cols.id]) : '',
      rollNo: cols.roll >= 0 ? clean(cells[cols.roll]) : '',
      gender: cols.gender >= 0 ? clean(cells[cols.gender]) : '',
      dob: cols.dob >= 0 ? clean(cells[cols.dob]) : '',
    })
  })
  return out
}

/**
 * @param fileStudents   from parseRosterRows
 * @param systemStudents [{ id, name, currentClassId, admNo }]
 * @param classKey       (rawClass) => comparable key, e.g. "3|A"
 */
export function matchRoster(fileStudents, systemStudents, classKey = (c) => norm(c)) {
  const usedFile = new Set()
  const usedSys = new Set()
  const matched = []
  const classChanged = []

  // 1. scholar / admission number
  const sysById = new Map()
  for (const s of systemStudents) {
    const k = normId(s.admNo)
    if (!k) continue
    sysById.set(k, sysById.has(k) ? null : s)          // null = ambiguous
  }
  // A number the school's file gives to two children identifies neither.
  const fileIdCount = fileStudents.reduce((m, f) => {
    const k = normId(f.scholarNo)
    return k ? m.set(k, (m.get(k) || 0) + 1) : m
  }, new Map())
  fileStudents.forEach((f, i) => {
    const k = normId(f.scholarNo)
    if (!k || fileIdCount.get(k) > 1) return
    const s = sysById.get(k)
    // Same number but nothing in common in the names: a typo, not the same child.
    if (!s || usedSys.has(s.id) || !sharesAWord(f.name, s.name)) return
    usedFile.add(i); usedSys.add(s.id)
    const sameClass = classKey(f.className) === classKey(s.currentClassId)
    ;(sameClass ? matched : classChanged).push({ file: f, system: s, by: 'scholar no' })
  })

  // 2. name + class
  const byNameClass = new Map()
  for (const s of systemStudents) {
    if (usedSys.has(s.id)) continue
    const k = `${normName(s.name)}#${classKey(s.currentClassId)}`
    if (!byNameClass.has(k)) byNameClass.set(k, [])
    byNameClass.get(k).push(s)
  }
  fileStudents.forEach((f, i) => {
    if (usedFile.has(i)) return
    const list = byNameClass.get(`${normName(f.name)}#${classKey(f.className)}`) || []
    const s = list.find(x => !usedSys.has(x.id))
    if (!s) return
    usedFile.add(i); usedSys.add(s.id)
    matched.push({ file: f, system: s, by: 'name + class' })
  })

  // 3. name alone, only when unique on both sides
  const countBy = (list, key) => list.reduce((m, x) => m.set(key(x), (m.get(key(x)) || 0) + 1), new Map())
  const leftSys = systemStudents.filter(s => !usedSys.has(s.id))
  const leftFile = fileStudents.map((f, i) => ({ f, i })).filter(({ i }) => !usedFile.has(i))
  const sysNames = countBy(leftSys, s => normName(s.name))
  const fileNames = countBy(leftFile, x => normName(x.f.name))
  for (const { f, i } of leftFile) {
    const n = normName(f.name)
    if (!n || sysNames.get(n) !== 1 || fileNames.get(n) !== 1) continue
    const s = leftSys.find(x => normName(x.name) === n)
    usedFile.add(i); usedSys.add(s.id)
    classChanged.push({ file: f, system: s, by: 'name' })
  }

  return {
    matched,
    classChanged,
    notInFile: systemStudents.filter(s => !usedSys.has(s.id)),
    notInSystem: fileStudents.filter((_, i) => !usedFile.has(i)),
  }
}

function sharesAWord(a, b) {
  const words = new Set(normName(a).split(' ').filter(w => w.length > 1))
  return normName(b).split(' ').some(w => words.has(w))
}

/** Duplicate scholar numbers inside the school's own file (worth telling them). */
export function duplicateScholarNos(fileStudents) {
  const seen = new Map()
  for (const f of fileStudents) {
    const k = normId(f.scholarNo)
    if (!k) continue
    seen.set(k, [...(seen.get(k) || []), f])
  }
  return [...seen.values()].filter(list => list.length > 1)
}
