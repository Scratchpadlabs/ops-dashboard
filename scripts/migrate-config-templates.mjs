#!/usr/bin/env node
/**
 * One-off migration: old `config_templates` docs (TemplatesTab.vue's
 * hand-wired, single-purpose mechanism — one doc bundling terms/
 * grading_scales/assessments/co_scholastic_activities/remark_categories/
 * months together, applied only as a whole) -> the new generic
 * `setup_templates` + `setup_bundles` system (see src/utils/setupTemplates.js).
 *
 * For each config_templates doc:
 *   - every non-empty section array becomes its own setup_templates doc
 *     (section_type + payload, same {_id, ...fields} shape the new system
 *     already uses — the old doc's arrays are byte-compatible, no reshaping
 *     needed)
 *   - if more than one section was migrated, those new template docs are
 *     grouped into one setup_bundles doc carrying the old doc's name/
 *     description, so applying "the same thing as before" still means one
 *     click (Apply Bundle) rather than N separate applies
 *   - the OLD doc is left in place but marked `{migrated: true, ...}` — this
 *     script never deletes anything; drop the old `config_templates`
 *     collection by hand once you've confirmed the new templates/bundles
 *     look right in Settings -> Templates.
 *
 * The old doc never recorded which school it was captured from (TemplatesTab
 * .vue's saveTemplate didn't store schoolId), so migrated templates get
 * created_from_school: null — "update from school" in Settings -> Templates
 * re-captures a real source school with one click after migration if you
 * want that field populated.
 *
 * Usage:
 *   npm install --no-save firebase-admin
 *   gcloud auth application-default login   # if you don't already have ADC set up
 *   node scripts/migrate-config-templates.mjs [--dry-run]
 *
 * Safe to re-run: docs already marked `migrated: true` are skipped.
 */
import { initializeApp, applicationDefault } from 'firebase-admin/app'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'

const PROJECT_ID = 'clarified-1501'
const DRY_RUN = process.argv.includes('--dry-run')

// Mirrors TemplatesTab.vue's old SECTIONS array + src/utils/setupTemplates.js's
// SETUP_SECTIONS labels — kept as a literal here so this script has no
// dependency on the Vue app's build (it's a standalone Node script).
const SECTION_LABELS = {
  terms: 'Terms',
  grading_scales: 'Grading Scales',
  assessments: 'Assessments',
  co_scholastic_activities: 'Co-Scholastic',
  remark_categories: 'Remark Categories',
  months: 'Months',
}

initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID })
const db = getFirestore()

async function main() {
  const snap = await db.collection('config_templates').get()
  const pending = snap.docs.filter(d => !(d.data() || {}).migrated)

  console.log(`Found ${snap.size} config_templates doc(s), ${pending.length} not yet migrated.`)
  if (DRY_RUN) console.log('--dry-run: no writes will be made.\n')

  let templatesCreated = 0, bundlesCreated = 0

  for (const doc of pending) {
    const data = doc.data() || {}
    const newTemplateIds = []

    console.log(`\n"${data.name || doc.id}" (${doc.id}):`)

    for (const [sectionType, label] of Object.entries(SECTION_LABELS)) {
      const items = Array.isArray(data[sectionType]) ? data[sectionType] : []
      if (!items.length) continue

      const templateRef = db.collection('setup_templates').doc()
      const templatePayload = {
        section_type: sectionType,
        name: `${data.name || doc.id} — ${label}`,
        description: data.description || '',
        payload: items,
        item_count: items.length,
        created_from_school: null, // not recorded by the old mechanism — see header comment
        migrated_from: doc.id,
        created_at: data.created_at || FieldValue.serverTimestamp(),
        created_by: data.created_by || 'migration-script',
        updated_at: FieldValue.serverTimestamp(),
        updated_by: 'migration-script',
      }
      console.log(`  -> setup_templates/${templateRef.id}  [${label}, ${items.length} item(s)]`)
      if (!DRY_RUN) await templateRef.set(templatePayload)
      newTemplateIds.push(templateRef.id)
      templatesCreated++
    }

    if (!newTemplateIds.length) {
      console.log('  (no non-empty sections — nothing to migrate)')
      continue
    }

    let bundleId = null
    if (newTemplateIds.length > 1) {
      const bundleRef = db.collection('setup_bundles').doc()
      bundleId = bundleRef.id
      console.log(`  -> setup_bundles/${bundleRef.id}  ["${data.name || doc.id}", ${newTemplateIds.length} template(s)]`)
      if (!DRY_RUN) {
        await bundleRef.set({
          name: data.name || doc.id,
          description: data.description || '',
          template_ids: newTemplateIds,
          migrated_from: doc.id,
          created_at: data.created_at || FieldValue.serverTimestamp(),
          created_by: data.created_by || 'migration-script',
          updated_at: FieldValue.serverTimestamp(),
          updated_by: 'migration-script',
        })
      }
      bundlesCreated++
    }

    if (!DRY_RUN) {
      await doc.ref.update({
        migrated: true,
        migrated_at: FieldValue.serverTimestamp(),
        migrated_to_templates: newTemplateIds,
        migrated_to_bundle: bundleId,
      })
    }
  }

  console.log(`\nDone. ${templatesCreated} template(s), ${bundlesCreated} bundle(s)${DRY_RUN ? ' would be' : ''} created.`)
  if (DRY_RUN) console.log('Re-run without --dry-run to actually write.')
}

main().catch((e) => {
  console.error('Migration failed:', e)
  process.exit(1)
})
