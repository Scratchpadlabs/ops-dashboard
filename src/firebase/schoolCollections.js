/**
 * The teacher app's per-school config lives at the Firestore root:
 *   schools/{schoolId}/{subcollection}
 *
 * This is a completely different tree from operations/ops (see collections.js) —
 * schoolId here is a human-readable school name, not an ops-dashboard doc ID.
 */
import { collection, doc } from 'firebase/firestore'
import { db } from './config'

export const rootSchoolsCollection = () => collection(db, 'schools')
export const rootSchoolDoc = (schoolId) => doc(db, 'schools', schoolId)
export const schoolCollection = (schoolId, name) => collection(db, 'schools', schoolId, name)
export const schoolDoc = (schoolId, name, id) => doc(db, 'schools', schoolId, name, id)

// Config templates are top-level — NOT scoped under any school.
export const configTemplatesCollection = () => collection(db, 'config_templates')
export const configTemplateDoc = (id) => doc(db, 'config_templates', id)

// Import staging is also top-level (a job belongs to one school, recorded
// via school_id on the doc) — see functions/generate_import and
// src/composables/useImport.js.
export const stagingImportsCollection = () => collection(db, 'staging_imports')
export const stagingImportDoc = (jobId) => doc(db, 'staging_imports', jobId)
export const stagingImportRowsCollection = (jobId) => collection(db, 'staging_imports', jobId, 'rows')

// Global alias map (NOT scoped to any school) the cleaning stage learns over
// time — see functions/generate_import/main.py's load_import_aliases.
export const importAliasesCollection = () => collection(db, 'import_aliases')
export const importAliasDoc = (id) => doc(db, 'import_aliases', id)

// Email intake queue (also top-level, not scoped to any school — school_id
// is null until matched/assigned) — written server-side by
// functions/email_intake's process_intake_emails, read/corrected here by
// the Intake Queue UI. See src/composables/useIntake.js.
export const intakeFilesCollection = () => collection(db, 'intake_files')
export const intakeFileDoc = (id) => doc(db, 'intake_files', id)
