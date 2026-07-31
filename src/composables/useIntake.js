/**
 * Email Intake Queue — client-side glue for `intake_files` (written
 * server-side by functions/email_intake's scheduled process_intake_emails)
 * and the school-assignment/auto-stage flow triggered from the Intake Queue
 * UI (src/views/Intake.vue).
 *
 * Auto-staging at intake time (inside process_intake_emails) has no signed-in
 * user, so it impersonates an ops admin to call process_import — see that
 * function's docstring. Assigning a school from THIS UI is simpler: it runs
 * in an already-authenticated ops-admin session, so it just calls
 * startProcessImport directly, same as uploadAndProcess in useImport.js.
 */
import {
  doc, setDoc, updateDoc, onSnapshot, query, where, orderBy, limit,
  serverTimestamp, arrayUnion,
} from 'firebase/firestore'
import { auth } from '../firebase/config'
import {
  intakeFilesCollection, intakeFileDoc, stagingImportsCollection, rootSchoolDoc,
} from '../firebase/schoolCollections.js'
import { startProcessImport } from '../utils/api.js'

// ── Live listeners ───────────────────────────────────────────────────────────
// Filtering by status happens client-side (see Intake.vue) rather than via a
// `where('status','in',[...])` + orderBy query, which would need a composite
// index that isn't provisioned for this project — a single orderBy-only
// query only needs Firestore's automatic single-field index.
export function listenIntakeFiles(cb) {
  return onSnapshot(
    query(intakeFilesCollection(), orderBy('received_at', 'desc'), limit(300)),
    (snap) => cb(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
  )
}

// Sidebar badge count — "unprocessed" = needs a human decision (no school
// match, or a school match but no confident auto-stage, or a failed
// auto-stage attempt). `status in [...]` alone (no orderBy) only needs the
// automatic single-field index, same reasoning as above.
const NEEDS_ATTENTION_STATUSES = ['unassigned', 'queued', 'error']
export function listenUnprocessedIntakeCount(cb) {
  return onSnapshot(
    query(intakeFilesCollection(), where('status', 'in', NEEDS_ATTENTION_STATUSES)),
    (snap) => cb(snap.size),
  )
}

// ── Assign / correct school ─────────────────────────────────────────────────
// Writes school_id onto the intake_files doc, remembers the sender on that
// school's intake_emails list for next time (same self-learning pattern as
// import_aliases — see useImport.js's resolveFieldValue), and — if the
// attachment was already confidently classified (entity_guess set) but
// couldn't auto-stage earlier for lack of a school — creates the staging
// import now, exactly the way a manual Import tab upload does.
export async function assignSchoolToFile(file, schoolId) {
  const senderEmail = (file.sender || '').trim().toLowerCase()
  if (senderEmail) {
    await updateDoc(rootSchoolDoc(schoolId), { intake_emails: arrayUnion(senderEmail) })
  }

  const updates = { school_id: schoolId, updated_at: serverTimestamp() }

  const canAutoStage = file.content_type_guess === 'spreadsheet' && file.entity_guess
    && file.status !== 'staged' && file.status !== 'dismissed'

  if (canAutoStage) {
    const jobRef = doc(stagingImportsCollection())
    const jobId = jobRef.id
    await setDoc(jobRef, {
      school_id: schoolId, entity: file.entity_guess,
      source_files: [file.gcs_path], status: 'processing', source: 'email',
      intake_file_id: file.id,
      created_by: auth.currentUser?.email || 'unknown', created_at: serverTimestamp(),
    })
    try {
      await startProcessImport({
        schoolId, jobId, entity: file.entity_guess,
        files: [{ path: file.gcs_path, name: file.filename }],
      })
      updates.status = 'staged'
      updates.staging_job_id = jobId
      updates.status_reason = null
    } catch (e) {
      await setDoc(jobRef, { status: 'failed', error: e.message || String(e) }, { merge: true }).catch(() => {})
      updates.status = 'error'
      updates.status_reason = e.message || String(e)
    }
  } else if (file.status === 'unassigned') {
    updates.status = 'queued'
  }

  await updateDoc(intakeFileDoc(file.id), updates)
}

export async function dismissIntakeFile(file) {
  await updateDoc(intakeFileDoc(file.id), {
    status: 'dismissed', updated_at: serverTimestamp(),
    dismissed_by: auth.currentUser?.email || 'unknown',
  })
}
