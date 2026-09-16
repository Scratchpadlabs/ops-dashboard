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

// Learned overlay for the education knowledge base — global, same
// self-learning pattern as import_aliases but for MEANING (is this value a
// subject, a co-scholastic area, a grade, a section?) rather than spelling.
// Seeded knowledge lives in code (functions/generate_import/education_kb.json);
// only human-confirmed additions land here. Doc id is the canonicalized value.
export const kbEntriesCollection = () => collection(db, 'kb_entries')
export const kbEntryDoc = (id) => doc(db, 'kb_entries', id)

// Surveys and their assignment runs live under the teacher-app school tree.
// Survey docs themselves are READ-ONLY from this dashboard — assignment only
// ever writes each recipient's inbox array (see functions/assign_survey).
export const surveysCollection = (schoolId) => collection(db, 'schools', schoolId, 'surveys')
export const surveyDoc = (schoolId, surveyId) => doc(db, 'schools', schoolId, 'surveys', surveyId)
export const surveyAssignmentsCollection = (schoolId) => collection(db, 'schools', schoolId, 'survey_assignments')
export const surveyAssignmentDoc = (schoolId, runId) => doc(db, 'schools', schoolId, 'survey_assignments', runId)

// AAP remarks (Awareness / Sensitivity / Creativity report-card comments).
//
// Generation runs server-side (functions/generate_aap_remarks) and logs its
// progress to schools/{id}/aap_jobs/{jobId}, which the dashboard only READS —
// the run doc is the function's own record of what it did. This is the ONE
// piece of the feature that is a direct client read: it needs no
// firestore.rules entry because it's a 4-segment path already covered by the
// generic schools/{schoolId}/{collection}/{docId} authenticated-read rule.
//
// Everything else — the remarks themselves (a level deeper, under the
// student), and the global subject-mapping confirmations — goes through
// callables (list_aap_remarks, update_aap_remark, bulk_update_aap_remarks,
// save_aap_subject_mapping in utils/api.js) instead of client Firestore
// access, on purpose: it keeps this feature off the firestore.rules surface
// entirely. There is deliberately no studentAapRemarkDoc/aapSubjectMapDoc
// helper here — those paths are only ever touched via the Admin SDK now.
export const aapJobsCollection = (schoolId) => collection(db, 'schools', schoolId, 'aap_jobs')
export const aapJobDoc = (schoolId, jobId) => doc(db, 'schools', schoolId, 'aap_jobs', jobId)

// Setup wizard runs — top-level, resumable progress for the New School and
// Reset School wizards. Not read by the teacher/student apps.
export const wizardRunsCollection = () => collection(db, 'setup_wizard_runs')
export const wizardRunDoc = (runId) => doc(db, 'setup_wizard_runs', runId)

// Reset run log lives under the school it reset, so the audit trail travels
// with the school. Archives are top-level and deliberately OUTSIDE the school
// tree — the teacher/student apps must never read them.
export const schoolResetsCollection = (schoolId) => collection(db, 'schools', schoolId, 'resets')
export const archivesCollection = () => collection(db, 'archives')
export const archiveDoc = (archiveId) => doc(db, 'archives', archiveId)
