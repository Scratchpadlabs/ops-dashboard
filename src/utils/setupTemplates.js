/**
 * School Setup — generic template system.
 *
 * ONE registry (SETUP_SECTIONS below) is the single place that knows about
 * individual School Setup sections. Everything else — capture, diff, apply,
 * the UI in SectionTemplateActions.vue, bundle apply — is generic and reads
 * this registry; adding template support to a future section means adding
 * one entry here, nothing else.
 *
 * Each entry:
 *   type        section_type stored on setup_templates docs
 *   label       display name
 *   collection  the schools/{schoolId}/{collection} subcollection this
 *               section lives in — payload capture is *always* "read every
 *               doc in this collection, verbatim" (see captureSectionPayload)
 *   matchKey    (item) => string — identifies "the same item" across a
 *               template payload and a school's live collection, for diffing.
 *               Defaults to the doc id, which is stable/deterministic for
 *               every section except remark_categories/months (both use
 *               Firestore auto-ids via addDoc) — those two override it with
 *               a content-derived key so re-applying (even to the same
 *               school) can actually detect "this already exists" instead of
 *               creating duplicates forever.
 *   note        optional hint shown in the apply dialog (e.g. sections that
 *               reference another section's docs by id)
 */
import { getDocs, writeBatch, serverTimestamp, doc, setDoc } from 'firebase/firestore'
import { db, auth } from '../firebase/config'
import { schoolCollection, schoolDoc } from '../firebase/schoolCollections.js'
import { slugify } from './assessmentHelpers.js'

const byId = (item) => item._id

export const SETUP_SECTIONS = [
  { type: 'terms', label: 'Terms', collection: 'terms', matchKey: byId },
  { type: 'grading_scales', label: 'Grading Scales', collection: 'grading_scales', matchKey: byId },
  { type: 'subjects', label: 'Subjects', collection: 'subjects', matchKey: byId },
  { type: 'classes', label: 'Classes & Teachers', collection: 'classes', matchKey: byId },
  {
    type: 'assessments', label: 'Assessments', collection: 'assessments', matchKey: byId,
    note: 'References Terms and Subjects by id — apply Terms/Subjects templates first if this school doesn’t already have matching ones, or these may land unattached to a real term.',
  },
  {
    type: 'co_scholastic_activities', label: 'Co-Scholastic', collection: 'co_scholastic_activities', matchKey: byId,
    note: 'References Terms by id — apply a Terms template first if this school doesn’t already have matching ones.',
  },
  {
    type: 'remark_categories', label: 'Remark Categories', collection: 'remark_categories',
    matchKey: (item) => slugify(item.label || ''),
  },
  {
    type: 'months', label: 'Months', collection: 'months',
    matchKey: (item) => item.key || slugify(item.label || ''),
  },
]

export function sectionByType(type) {
  return SETUP_SECTIONS.find(s => s.type === type) || null
}

// ── Capture ──────────────────────────────────────────────────────────────────
// "The section's config data in the same shape School Setup stores it" — no
// per-field transformation, ever. Whatever's live is the payload.
export async function captureSectionPayload(schoolId, sectionType) {
  const section = sectionByType(sectionType)
  if (!section) throw new Error(`Unknown section_type: ${sectionType}`)
  const snap = await getDocs(schoolCollection(schoolId, section.collection))
  return snap.docs.map(d => ({ _id: d.id, ...d.data() }))
}

// ── Diff ─────────────────────────────────────────────────────────────────────
const AUDIT_FIELDS = ['_id', 'created_at', 'created_by', 'updated_at', 'updated_by']

function stripAudit(item) {
  const out = {}
  for (const k of Object.keys(item || {})) {
    if (!AUDIT_FIELDS.includes(k)) out[k] = item[k]
  }
  return out
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object' && typeof value.toDate !== 'function') {
    return Object.keys(value).sort().reduce((acc, k) => { acc[k] = canonical(value[k]); return acc }, {})
  }
  if (value && typeof value.toDate === 'function') return value.toDate().toISOString()
  return value
}

function itemsEqual(a, b) {
  return JSON.stringify(canonical(stripAudit(a))) === JSON.stringify(canonical(stripAudit(b)))
}

/**
 * Returns { added, matching, conflicting }:
 *   added       template items with no matching live item -> will be created
 *   matching    template items whose live counterpart is byte-identical
 *               (post audit-field-stripping) -> no-op either way
 *   conflicting template items whose live counterpart differs -> MERGE keeps
 *               the school's version, REPLACE overwrites with the template's
 * Each entry is { key, templateItem, liveItem (null for added) }.
 */
export function diffSection(templatePayload, liveItems, matchKeyFn) {
  const liveByKey = new Map(liveItems.map(item => [matchKeyFn(item), item]))
  const added = [], matching = [], conflicting = []
  for (const templateItem of templatePayload) {
    const key = matchKeyFn(templateItem)
    const liveItem = liveByKey.get(key)
    if (!liveItem) {
      added.push({ key, templateItem, liveItem: null })
    } else if (itemsEqual(templateItem, liveItem)) {
      matching.push({ key, templateItem, liveItem })
    } else {
      conflicting.push({ key, templateItem, liveItem })
    }
  }
  return { added, matching, conflicting }
}

// ── Apply ────────────────────────────────────────────────────────────────────
// strategy: 'merge' (add missing, keep school's value on conflict) or
// 'replace' (template wins on conflict). Matching items are always no-ops.
// Provenance is recorded once at the SECTION level (not per item) — a single
// audit fact "this section had template X applied at time Y" — subsequent
// manual edits to individual items are fine and intentionally don't need to
// stay linked to it.
export async function applySection({ schoolId, sectionType, templateId, diff, strategy }) {
  const section = sectionByType(sectionType)
  if (!section) throw new Error(`Unknown section_type: ${sectionType}`)
  const email = auth.currentUser?.email || 'unknown'

  const toWrite = [
    ...diff.added.map(e => ({ ...e, isNew: true })),
    ...(strategy === 'replace' ? diff.conflicting.map(e => ({ ...e, isNew: false })) : []),
  ]

  for (let i = 0; i < toWrite.length; i += 450) {
    const chunk = toWrite.slice(i, i + 450)
    const batch = writeBatch(db)
    chunk.forEach(({ templateItem, isNew }) => {
      const { _id, ...data } = templateItem
      const payload = { ...data, updated_at: serverTimestamp(), updated_by: email }
      if (isNew) {
        payload.created_at = serverTimestamp()
        payload.created_by = email
      }
      batch.set(schoolDoc(schoolId, section.collection, _id), payload, { merge: true })
    })
    await batch.commit()
  }

  await recordProvenance(schoolId, sectionType, templateId, email)
  return { written: toWrite.length, skipped: diff.matching.length + (strategy === 'merge' ? diff.conflicting.length : 0) }
}

async function recordProvenance(schoolId, sectionType, templateId, email) {
  await setDoc(doc(db, 'schools', schoolId, 'config', 'template_provenance'), {
    [sectionType]: { applied_template_id: templateId, applied_at: serverTimestamp(), applied_by: email },
  }, { merge: true })
}
