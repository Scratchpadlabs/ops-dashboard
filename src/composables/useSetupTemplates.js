/**
 * Firestore glue for the School Setup template system — template/bundle CRUD
 * and metadata. The diff/apply engine and section registry live in
 * src/utils/setupTemplates.js (pure, reusable from both SectionTemplateActions.vue
 * and the Settings > Templates management page).
 */
import {
  getDocs, getDoc, addDoc, updateDoc, deleteDoc, query, orderBy, where,
  serverTimestamp,
} from 'firebase/firestore'
import { auth } from '../firebase/config'
import { setupTemplatesCollection, setupTemplateDoc, setupBundlesCollection, setupBundleDoc } from '../firebase/schoolCollections.js'
import { captureSectionPayload, sectionByType } from '../utils/setupTemplates.js'

// ── Templates ────────────────────────────────────────────────────────────────
export async function listTemplatesBySectionType(sectionType) {
  const snap = await getDocs(query(setupTemplatesCollection(), orderBy('name')))
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(t => t.section_type === sectionType && !t.deleted)
}

export async function listAllTemplates() {
  const snap = await getDocs(query(setupTemplatesCollection(), orderBy('name')))
  return snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(t => !t.deleted)
}

export async function saveTemplateFromSchool({ schoolId, sectionType, name, description }) {
  const payload = await captureSectionPayload(schoolId, sectionType)
  const email = auth.currentUser?.email || 'unknown'
  const ref = await addDoc(setupTemplatesCollection(), {
    section_type: sectionType,
    name: name.trim(),
    description: (description || '').trim(),
    payload,
    item_count: payload.length,
    created_from_school: schoolId,
    created_at: serverTimestamp(), created_by: email,
    updated_at: serverTimestamp(), updated_by: email,
  })
  return ref.id
}

export async function renameTemplate(templateId, name) {
  await updateDoc(setupTemplateDoc(templateId), {
    name: name.trim(), updated_at: serverTimestamp(), updated_by: auth.currentUser?.email || 'unknown',
  })
}

export async function updateTemplateDescription(templateId, description) {
  await updateDoc(setupTemplateDoc(templateId), {
    description: (description || '').trim(),
    updated_at: serverTimestamp(), updated_by: auth.currentUser?.email || 'unknown',
  })
}

// Re-captures the payload from a (possibly different) school's current
// section state — same shape as a fresh save, just overwriting an existing
// template doc instead of creating a new one.
export async function updateTemplateFromSchool(template, schoolId) {
  const payload = await captureSectionPayload(schoolId, template.section_type)
  await updateDoc(setupTemplateDoc(template.id), {
    payload, item_count: payload.length, created_from_school: schoolId,
    updated_at: serverTimestamp(), updated_by: auth.currentUser?.email || 'unknown',
  })
}

// Bundles referencing this template — the delete-guard the UI uses to block
// or warn before a soft-delete.
export async function bundlesReferencingTemplate(templateId) {
  const snap = await getDocs(query(setupBundlesCollection(), where('template_ids', 'array-contains', templateId)))
  return snap.docs.map(d => ({ id: d.id, ...d.data() }))
}

export async function softDeleteTemplate(templateId) {
  await updateDoc(setupTemplateDoc(templateId), {
    deleted: true, deleted_at: serverTimestamp(), deleted_by: auth.currentUser?.email || 'unknown',
  })
}

// ── Bundles ──────────────────────────────────────────────────────────────────
export async function listBundles() {
  const snap = await getDocs(query(setupBundlesCollection(), orderBy('name')))
  return snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(b => !b.deleted)
}

export async function getBundleWithTemplates(bundleId) {
  const bundleSnap = await getDoc(setupBundleDoc(bundleId))
  if (!bundleSnap.exists()) return null
  const bundle = { id: bundleSnap.id, ...bundleSnap.data() }
  const templates = await Promise.all(
    (bundle.template_ids || []).map(async (id) => {
      const snap = await getDoc(setupTemplateDoc(id))
      return snap.exists() ? { id: snap.id, ...snap.data() } : null
    }),
  )
  return { ...bundle, templates: templates.filter(Boolean) }
}

export async function createBundle({ name, description, templateIds }) {
  const email = auth.currentUser?.email || 'unknown'
  const ref = await addDoc(setupBundlesCollection(), {
    name: name.trim(), description: (description || '').trim(), template_ids: templateIds,
    created_at: serverTimestamp(), created_by: email,
    updated_at: serverTimestamp(), updated_by: email,
  })
  return ref.id
}

export async function deleteBundle(bundleId) {
  await deleteDoc(setupBundleDoc(bundleId))
}

export function sectionLabel(sectionType) {
  return sectionByType(sectionType)?.label || sectionType
}
