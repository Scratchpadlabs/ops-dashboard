#!/usr/bin/env python3
"""
add_practice_topic — one callable, backing the "Add Practice Topics" action
in School Setup.

Adds ONE "Practice Topic" to every subject in a school, and to every
classes/{id}.subjects[] entry referencing that subject — the same fix
verified manually against Hillgreen_Highschool (138 subjects, 415
class-subject entries), confirmed working in the teacher app.

Two writes per subject, using the SAME id (`{subjectId}_Practice`) so the
teacher app's class-level completion tracking and the subject-level topic
line up, same convention the app already uses for Term1/Term2/Optional:

  schools/{schoolId}/subjects/{subjectId}.topics
    -> {id, name, cost: {case_study, materials, quiz}, survey_initiated_by: {}}
  schools/{schoolId}/classes/{classId}.subjects[].topics
    -> {id, topic, isCompleted: false, completedAt: null}

Idempotent — skips a subject/class-entry that already carries a topic with
that id, so re-running (e.g. after a new school is set up, or new subjects
are added) only touches what's new.

dryRun (default true unless explicitly set false) previews counts without
writing, same convention as reset_execute/assign_survey.

Deploy (see functions/DEPLOY.md style):
  cd functions/add_practice_topic
  gcloud functions deploy add_practice_topic \
    --gen2 --runtime python312 --region asia-south1 \
    --source . --entry-point add_practice_topic \
    --trigger-http --allow-unauthenticated --project clarified-1501 \
    --memory 512MB --timeout 300s --max-instances 3
"""
import firebase_admin
from firebase_admin import firestore
from firebase_functions import https_fn, options

firebase_admin.initialize_app()

OPS_ADMIN_EMAILS = {"sid@ops.clarified.in", "angel@ops.clarified.in"}
WRITE_CHUNK = 450
TOPIC_ID_SUFFIX = "Practice"
TOPIC_NAME = "Practice Topic"


def _require_ops_admin(req):
    if req.auth is None:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.UNAUTHENTICATED, "Sign in required.")
    email = str((req.auth.token or {}).get("email") or "").strip().lower()
    if email not in OPS_ADMIN_EMAILS:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.PERMISSION_DENIED,
            "Not authorized for this action.")
    return email


def _subject_topic(subject_id):
    return {
        "id": f"{subject_id}_{TOPIC_ID_SUFFIX}",
        "name": TOPIC_NAME,
        "cost": {"case_study": 10, "materials": 10, "quiz": 10},
        "survey_initiated_by": {},
    }


def _class_topic(subject_id):
    return {
        "id": f"{subject_id}_{TOPIC_ID_SUFFIX}",
        "topic": TOPIC_NAME,
        "isCompleted": False,
        "completedAt": None,
    }


def _process_school(db, school_id, dry_run, email):
    school_ref = db.collection("schools").document(school_id)

    subjects_touched, subjects_skipped = 0, 0
    subject_writes = []
    for doc in school_ref.collection("subjects").stream():
        data = doc.to_dict() or {}
        topics = data.get("topics") or []
        topic_id = f"{doc.id}_{TOPIC_ID_SUFFIX}"
        if any(isinstance(t, dict) and t.get("id") == topic_id for t in topics):
            subjects_skipped += 1
            continue
        subjects_touched += 1
        subject_writes.append((doc.reference, topics + [_subject_topic(doc.id)]))

    class_entries_touched, class_entries_skipped = 0, 0
    class_writes = []
    for doc in school_ref.collection("classes").stream():
        data = doc.to_dict() or {}
        subjects_arr = data.get("subjects") or []
        changed = False
        new_subjects_arr = []
        for entry in subjects_arr:
            if not isinstance(entry, dict) or not entry.get("subjectId"):
                new_subjects_arr.append(entry)
                continue
            subject_id = entry["subjectId"]
            topic_id = f"{subject_id}_{TOPIC_ID_SUFFIX}"
            entry_topics = entry.get("topics") or []
            if any(isinstance(t, dict) and t.get("id") == topic_id for t in entry_topics):
                class_entries_skipped += 1
                new_subjects_arr.append(entry)
                continue
            changed = True
            class_entries_touched += 1
            new_subjects_arr.append({**entry, "topics": entry_topics + [_class_topic(subject_id)]})
        if changed:
            class_writes.append((doc.reference, new_subjects_arr))

    if not dry_run:
        for i in range(0, len(subject_writes), WRITE_CHUNK):
            batch = db.batch()
            for ref, topics in subject_writes[i:i + WRITE_CHUNK]:
                batch.update(ref, {
                    "topics": topics,
                    "updated_at": firestore.SERVER_TIMESTAMP,
                    "updated_by": email,
                })
            batch.commit()
        for i in range(0, len(class_writes), WRITE_CHUNK):
            batch = db.batch()
            for ref, subjects_arr in class_writes[i:i + WRITE_CHUNK]:
                batch.update(ref, {
                    "subjects": subjects_arr,
                    "updated_at": firestore.SERVER_TIMESTAMP,
                    "updated_by": email,
                })
            batch.commit()

    return {
        "schoolId": school_id,
        "subjectsTouched": subjects_touched, "subjectsSkipped": subjects_skipped,
        "classEntriesTouched": class_entries_touched, "classEntriesSkipped": class_entries_skipped,
    }


@https_fn.on_call(region="asia-south1", memory=options.MemoryOption.MB_512,
                   timeout_sec=300, max_instances=3)
def add_practice_topic(req: https_fn.CallableRequest):
    email = _require_ops_admin(req)
    data = req.data or {}
    school_id = (data.get("schoolId") or "").strip()
    all_schools = bool(data.get("allSchools"))
    dry_run = data.get("dryRun")
    dry_run = True if dry_run is None else bool(dry_run)

    if not school_id and not all_schools:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT,
            "Pass schoolId for one school, or allSchools: true for every school.")

    db = firestore.client()

    if school_id:
        school_ids = [school_id]
    else:
        school_ids = [d.id for d in db.collection("schools").select([]).stream()]

    results = [_process_school(db, sid, dry_run, email) for sid in school_ids]
    totals = {
        "subjectsTouched": sum(r["subjectsTouched"] for r in results),
        "classEntriesTouched": sum(r["classEntriesTouched"] for r in results),
    }
    return {"dryRun": dry_run, "schoolCount": len(school_ids), "results": results, "totals": totals}
