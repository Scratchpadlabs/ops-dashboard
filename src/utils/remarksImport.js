/**
 * Remarks CSV import — row classification and per-category grouping.
 *
 * Pure functions, kept out of RemarksTab.vue so tools/check_remarks_import.mjs
 * can exercise them without a browser. There is exactly one copy of these
 * rules; the component renders, this decides.
 *
 * GRADE-BAND SCOPING (decision, 2026-08-09). Remark statements differ by band
 * (Foundational/Preparatory/Middle), but NOTHING in the live schema scopes a
 * remark by grade: remark_categories carries only label/order/remarks[], and
 * the only grade link in the whole remarks system is remarks_sheets.classId.
 * So the band is encoded as a document-ID prefix — `Foundational_Discipline` —
 * exactly as subjects already encode grade_band (useImport.js buildSubjectsPlan
 * builds `${grade_band}_${subject}` and reads it back off id.split('_')[0]).
 * No new field, so no schema-twin change.
 *
 * THE INVARIANT EVERYTHING HERE PROTECTS: remarks_sheets/{id}/entries/
 * {studentId} stores bare booleans keyed by remark key — `{r1: false}` — with
 * no category or grade qualifier. The key ALONE identifies the remark, so keys
 * must be unique across the whole school, not per category. RemarksTab's
 * nextRemarkKey() already maxes r(\d+) across every category for the same
 * reason. Per-band key namespaces that each restart at r1 would make `r1` mean
 * two different things and silently corrupt teacher checkboxes already
 * collected. The collision checks below are the point of this import, not a
 * nicety.
 */

export const REMARK_CSV_COLUMNS = [
  'grade_band', 'category', 'category_order', 'remark_key', 'remark_order', 'text', 'type',
]
export const REMARK_TYPES = ['positive', 'negative']

export function slugPart(s) {
  return (s || '').trim().replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '')
}

/** `Foundational_Discipline` -> `Foundational`; `Discipline` -> ''. */
export function bandOfId(id) {
  return String(id || '').includes('_') ? String(id).split('_')[0] : ''
}

export function categoryDocId(band, category) {
  const c = slugPart(category)
  const b = slugPart(band)
  return b ? `${b}_${c}` : c
}

function keyNumber(key) {
  // Tolerates a band prefix, so auto-allocation keeps counting past
  // `foundational_r8` and not just `r8`.
  const m = /(?:^|_)r(\d+)$/.exec(key || '')
  return m ? parseInt(m[1], 10) : 0
}

/**
 * The key as STORED, which is what remarks_sheets entries will hold.
 *
 * Real remark banks reuse keys across bands — Hillgreen's file has `gr1`
 * meaning three different things in Foundational, Preparatory and Middle, each
 * namespace internally consistent. Entries store the bare key with no band, so
 * resolving `gr1` correctly would depend on the reader going class → grade →
 * band → that band's categories. Prefixing the band into the key removes that
 * dependency entirely: the stored key is unambiguous on its own, whichever way
 * the reader looks it up.
 *
 * The full slugified band is used rather than an initial — `f` would collide
 * between "Foundational" and "Foundation". Deterministic, so re-importing the
 * same file produces the same keys, and already-prefixed keys are left alone so
 * an export → re-import round trip is stable.
 */
export function effectiveRemarkKey(band, key) {
  const prefix = slugPart(band).toLowerCase()
  if (!prefix || !key) return key
  return key.toLowerCase().startsWith(`${prefix}_`) ? key : `${prefix}_${key}`
}

/**
 * @param {Array} categories  current remark_categories docs ({id, order, remarks})
 * @returns {(raw: Object, index: number) => Object} classifier for CsvImportDialog
 *
 * Stateful across rows on purpose: a key claimed by an earlier row of the same
 * file has to be visible to a later one, because a collision inside a single
 * file is exactly as damaging as one against the database. `index === 0`
 * marks a freshly-picked file and resets that state.
 */
export function makeRemarkRowClassifier(categories) {
  let claimedKeys = new Map()   // key -> docId claiming it in THIS file
  let autoKeyCounter = 0

  const existingKeyOwners = () => {
    const owners = new Map()
    categories.forEach(c => (c.remarks || []).forEach(r => {
      if (r.key) owners.set(r.key, c.id)
    }))
    return owners
  }
  const highestKeyNumber = () => {
    let max = 0
    categories.forEach(c => (c.remarks || []).forEach(r => {
      max = Math.max(max, keyNumber(r.key))
    }))
    return max
  }

  return function classifyRemarkRow(raw, index) {
    if (index === 0) {
      claimedKeys = new Map()
      autoKeyCounter = highestKeyNumber()
    }

    const band = (raw.grade_band || '').trim()
    const category = (raw.category || '').trim()
    const text = (raw.text || '').trim()
    if (!category) return { raw, _status: 'ERROR', _reason: 'Missing category' }
    if (!text) return { raw, _status: 'ERROR', _reason: 'Missing text' }

    const type = (raw.type || '').trim().toLowerCase()
    if (!REMARK_TYPES.includes(type)) {
      return { raw, _status: 'ERROR', _reason: `type must be "positive" or "negative" (got "${raw.type || ''}")` }
    }

    const catOrderRaw = (raw.category_order ?? '').toString().trim()
    const categoryOrder = catOrderRaw ? Number(catOrderRaw) : null
    if (catOrderRaw && (!Number.isFinite(categoryOrder) || categoryOrder < 1)) {
      return { raw, _status: 'ERROR', _reason: 'category_order must be a number >= 1' }
    }
    const remOrderRaw = (raw.remark_order ?? '').toString().trim()
    const remarkOrder = remOrderRaw ? Number(remOrderRaw) : null
    if (remOrderRaw && (!Number.isFinite(remarkOrder) || remarkOrder < 1)) {
      return { raw, _status: 'ERROR', _reason: 'remark_order must be a number >= 1' }
    }

    const docId = categoryDocId(band, category)
    const notes = []

    // A blank key is allocated from the school-wide sequence rather than
    // rejected — the same rule RemarksTab's nextRemarkKey() follows.
    const authoredKey = (raw.remark_key || '').trim()
    let key = authoredKey
    if (!key) {
      autoKeyCounter += 1
      key = `r${autoKeyCounter}`
      notes.push(`key auto-assigned (${key})`)
    } else {
      autoKeyCounter = Math.max(autoKeyCounter, keyNumber(key))
    }

    // Everything from here on works with the STORED key — the one that lands in
    // remarks_sheets entries — so the collision checks guard what is actually
    // written, not what the file happened to type.
    key = effectiveRemarkKey(band, key)
    if (authoredKey && key !== authoredKey) {
      notes.push(`key stored as "${key}" — band prefixed so it stays unique school-wide`)
    }

    const dbOwner = existingKeyOwners().get(key)
    if (dbOwner && dbOwner !== docId) {
      return { raw, _status: 'ERROR', _reason: `remark_key "${key}" already belongs to category "${dbOwner}" — keys are school-wide and cannot be reused` }
    }
    const fileOwner = claimedKeys.get(key)
    if (fileOwner === docId) {
      return { raw, _status: 'ERROR', _reason: `remark_key "${key}" appears twice in category "${docId}"` }
    }
    if (fileOwner) {
      return { raw, _status: 'ERROR', _reason: `remark_key "${key}" is used by two categories in this file ("${fileOwner}" and "${docId}")` }
    }
    claimedKeys.set(key, docId)

    const existing = categories.find(c => c.id === docId)
    if (existing && (existing.remarks || []).some(r => r.key === key)) {
      notes.push('replaces the existing text for this key')
    }
    if (!band) notes.push('no grade band — category applies to all grades')

    return {
      raw,
      _status: existing ? 'UPDATE' : 'CREATE',
      _warning: notes.join('; ') || undefined,
      docId, band, label: category, categoryOrder,
      remark: { key, text, type, order: remarkOrder },
    }
  }
}

/**
 * Rows are per-remark; documents are per-category. Returns one payload per
 * category doc, ready to write.
 *
 * Existing categories are merged BY KEY, not replaced: a remark already in
 * Firestore whose key the file doesn't mention is kept. Replacing the array
 * wholesale would delete remarks that teachers' entries still reference by key
 * — and a Firestore array field is overwritten, never merged element-wise.
 */
export function groupRemarkRows(validRows, categories) {
  const byDoc = new Map()
  for (const r of validRows) {
    if (!byDoc.has(r.docId)) {
      byDoc.set(r.docId, { docId: r.docId, label: r.label, order: r.categoryOrder, remarks: [] })
    }
    const g = byDoc.get(r.docId)
    if (g.order == null && r.categoryOrder != null) g.order = r.categoryOrder
    g.remarks.push(r.remark)
  }

  let nextOrder = categories.length ? Math.max(...categories.map(c => c.order || 0)) : 0
  const out = []
  for (const g of byDoc.values()) {
    const existing = categories.find(c => c.id === g.docId)
    const kept = (existing?.remarks || []).filter(r => !g.remarks.some(n => n.key === r.key))
    const merged = [...kept, ...g.remarks]
    // An explicit remark_order wins; anything without one sorts after the
    // remarks that have one, so the result is always fully ordered.
    merged.sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER))
    out.push({
      docId: g.docId,
      isNew: !existing,
      label: g.label,
      order: g.order ?? existing?.order ?? (nextOrder += 1),
      remarks: merged.map((r, i) => ({ key: r.key, text: r.text, type: r.type, order: i + 1 })),
    })
  }
  return out
}

/**
 * Rows for the Sample CSV button — shaped after Hillgreen's real remark bank.
 *
 * Deliberately reuses `gr1` across bands, exactly as a real bank does, so the
 * sample demonstrates the band-prefixing rather than hiding it behind keys that
 * happen not to collide.
 */
export function sampleRemarkRows() {
  return [
    { grade_band: 'Foundational', category: 'General Remarks', category_order: 1, remark_key: 'gr1', remark_order: 1, text: 'Enjoys learning new things', type: 'positive' },
    { grade_band: 'Foundational', category: 'General Remarks', category_order: 1, remark_key: 'gr2', remark_order: 2, text: 'Encouraged to pay more attention in class', type: 'negative' },
    { grade_band: 'Foundational', category: 'Physical Development', category_order: 2, remark_key: 'phys1', remark_order: 1, text: 'Practices basic hygiene habits like washing hands before and after meals.', type: 'positive' },
    { grade_band: 'Foundational', category: 'Physical Development', category_order: 2, remark_key: 'phys2', remark_order: 2, text: 'Still developing awareness of basic safety rules.', type: 'negative' },
    { grade_band: 'Preparatory', category: 'General Remarks', category_order: 1, remark_key: 'gr1', remark_order: 1, text: 'Always submits work on time', type: 'positive' },
    { grade_band: 'Preparatory', category: 'General Remarks', category_order: 1, remark_key: 'gr2', remark_order: 2, text: 'Encouraged to finish work on time', type: 'negative' },
    { grade_band: 'Middle', category: 'General Remarks', category_order: 1, remark_key: 'gr1', remark_order: 1, text: 'Regular in submissions', type: 'positive' },
    { grade_band: 'Middle', category: 'General Remarks', category_order: 1, remark_key: 'gr2', remark_order: 2, text: 'Encouraged to improve time management', type: 'negative' },
  ]
}
