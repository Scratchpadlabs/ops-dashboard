#!/usr/bin/env python3
"""
school_health_check — READ-ONLY structural audit of a school's Firestore
tree, checked against Hillgreen_Highschool as the known-good reference.

Why this exists: while building the training-class feature, we found that
subject topics written by the dashboard's own Subjects-tab topic editor
({topic, description, quiz}) are NOT the shape the teacher app actually
reads for loading activities/survey questions ({id, name, cost:
{case_study, materials, quiz}, survey_initiated_by}). That bug could exist
silently on any REAL subject anyone has used the topic editor on, in any
school — this audit's top finding category is built specifically to catch
that, plus the more familiar collection-presence and referential-integrity
checks.

Nothing is written. Ever. This function has no write path at all.

Checks, per school:
  1. COLLECTION PRESENCE — does it have terms, grading_scales, subjects,
     classes, assessments, co_scholastic_activities, remark_categories,
     months, staffs, students (matching AUDIT.md's existing convention)?
  2. SUBJECT TOPIC SHAPE — for every topic on every subject, is it the
     activity-loading shape (has `cost` + `survey_initiated_by`) or the
     topic-editor shape (has `topic`+`quiz`, no `cost`)? The latter is
     flagged HIGH severity — it's the exact bug that broke the demo class,
     and it means those topics likely can't load activities in the
     teacher app right now.
  3. CLASS -> SUBJECT referential integrity — every classes/{id}.subjects[]
     entry's subjectId must resolve to a real subjects/{id} doc.
  4. CLASS-SUBJECT TOPIC ALIGNMENT — every topic id in a class's
     subjects[].topics should also exist in that subject's own topics
     array (they're meant to correspond 1:1, same id convention).
  5. STAFF -> CLASS/SUBJECT referential integrity — every staffs/{id}
     .assignments[classId] must be a real class, and every subjectId
     listed for it must be one of that class's configured subjects.
  6. STUDENT currentClassId — must resolve to a real class (the known
     "garbage currentClassId" issue from AUDIT.md).

Returns a structured report: counts + a capped list of specific findings
per category, each naming the exact doc and field so it's actionable
without re-deriving anything.

Deploy:
  cd functions/school_health_check
  gcloud functions deploy school_health_check \
    --gen2 --runtime python312 --region asia-south1 \
    --source . --entry-point school_health_check \
    --trigger-http --allow-unauthenticated --project clarified-1501 \
    --memory 1024MB --timeout 300s --max-instances 3
"""
import firebase_admin
from firebase_admin import firestore
from firebase_functions import https_fn, options

firebase_admin.initialize_app()

OPS_ADMIN_EMAILS = {"sid@ops.clarified.in", "angel@ops.clarified.in"}

EXPECTED_COLLECTIONS = [
    "terms", "grading_scales", "subjects", "classes", "assessments",
    "co_scholastic_activities", "remark_categories", "months", "staffs", "students",
]

MAX_FINDINGS_PER_CATEGORY = 50


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


def _add(findings, category, severity, message):
    if len(findings[category]) < MAX_FINDINGS_PER_CATEGORY:
        findings[category].append({"severity": severity, "message": message})


def _check_collections(school_ref, findings):
    present, missing = [], []
    for name in EXPECTED_COLLECTIONS:
        has_any = any(True for _ in school_ref.collection(name).limit(1).stream())
        (present if has_any else missing).append(name)
    for name in missing:
        _add(findings, "collections", "high", f"Collection '{name}' has zero documents.")
    return present, missing


def _topic_shape(topic):
    """Classify one topic entry. Returns 'activity' (correct, teacher-app
    readable), 'editor' (topic-editor shape, likely broken for activities),
    'string' (legacy plain string, fine), or 'unknown'."""
    if isinstance(topic, str):
        return "string"
    if not isinstance(topic, dict):
        return "unknown"
    if "cost" in topic and "survey_initiated_by" in topic:
        return "activity"
    if "topic" in topic and ("quiz" in topic or "description" in topic):
        return "editor"
    return "unknown"


def _check_subjects(school_ref, findings):
    """Returns {subjectId: set(topicId)} for the class-alignment check."""
    subject_topic_ids = {}
    subjects_with_editor_shape = 0
    subjects_with_no_topics = 0
    total_subjects = 0

    for doc in school_ref.collection("subjects").stream():
        total_subjects += 1
        data = doc.to_dict() or {}
        topics = data.get("topics") or []
        subject_topic_ids[doc.id] = {
            t.get("id") for t in topics if isinstance(t, dict) and t.get("id")
        }

        if not topics:
            subjects_with_no_topics += 1
            _add(findings, "subject_topics", "medium", f"subjects/{doc.id} has no topics at all.")
            continue

        shapes = {_topic_shape(t) for t in topics}
        if "editor" in shapes and "activity" not in shapes:
            subjects_with_editor_shape += 1
            _add(findings, "subject_topics", "high",
                 f"subjects/{doc.id}: ALL topics use the topic-editor shape "
                 f"({{topic, description, quiz}}) — likely can't load activities "
                 f"in the teacher app. Same bug as the demo class.")
        elif "editor" in shapes and "activity" in shapes:
            _add(findings, "subject_topics", "medium",
                 f"subjects/{doc.id}: MIXED topic shapes — some topics use the "
                 f"working activity shape, others use the topic-editor shape. "
                 f"The editor-shaped ones likely won't load activities.")

    return subject_topic_ids, {
        "total": total_subjects,
        "with_editor_shape_only": subjects_with_editor_shape,
        "with_no_topics": subjects_with_no_topics,
    }


def _check_classes(school_ref, subject_topic_ids, findings):
    total_classes = 0
    for doc in school_ref.collection("classes").stream():
        total_classes += 1
        data = doc.to_dict() or {}
        for entry in (data.get("subjects") or []):
            if not isinstance(entry, dict):
                continue
            subject_id = entry.get("subjectId")
            if not subject_id:
                _add(findings, "class_subject_refs", "medium",
                     f"classes/{doc.id}: a subjects[] entry has no subjectId.")
                continue
            if subject_id not in subject_topic_ids:
                _add(findings, "class_subject_refs", "high",
                     f"classes/{doc.id}: subjectId '{subject_id}' does not exist in subjects/.")
                continue
            real_topic_ids = subject_topic_ids[subject_id]
            for t in (entry.get("topics") or []):
                tid = t.get("id") if isinstance(t, dict) else None
                if tid and real_topic_ids and tid not in real_topic_ids:
                    _add(findings, "class_subject_refs", "low",
                         f"classes/{doc.id}: topic id '{tid}' for subject '{subject_id}' "
                         f"has no matching topic in subjects/{subject_id}.")
    return total_classes


def _check_staffs(school_ref, valid_class_ids, class_subject_ids, findings):
    total_staffs = 0
    for doc in school_ref.collection("staffs").stream():
        total_staffs += 1
        data = doc.to_dict() or {}
        assignments = data.get("assignments") or {}
        for class_id, subject_ids in assignments.items():
            if class_id not in valid_class_ids:
                _add(findings, "staff_refs", "high",
                     f"staffs/{doc.id}: assignments references classId '{class_id}' "
                     f"which does not exist in classes/.")
                continue
            configured = class_subject_ids.get(class_id, set())
            for sid in (subject_ids or []):
                if configured and sid not in configured:
                    _add(findings, "staff_refs", "medium",
                         f"staffs/{doc.id}: assigned subject '{sid}' for class '{class_id}', "
                         f"but that subject isn't configured on that class.")
    return total_staffs


def _check_students(school_ref, valid_class_ids, findings):
    total_students, bad_class = 0, 0
    for doc in school_ref.collection("students").select(["currentClassId", "type"]).stream():
        data = doc.to_dict() or {}
        if str(data.get("type") or "student") != "student":
            continue
        total_students += 1
        cid = data.get("currentClassId")
        if not cid or cid not in valid_class_ids:
            bad_class += 1
            _add(findings, "student_class_refs", "high",
                 f"students/{doc.id}: currentClassId '{cid}' does not resolve to a real class.")
    return total_students, bad_class


def _audit_school(school_id):
    db = firestore.client()
    school_ref = db.collection("schools").document(school_id)
    findings = {
        "collections": [], "subject_topics": [], "class_subject_refs": [],
        "staff_refs": [], "student_class_refs": [],
    }

    present, missing = _check_collections(school_ref, findings)
    subject_topic_ids, subject_stats = _check_subjects(school_ref, findings)
    total_classes = _check_classes(school_ref, subject_topic_ids, findings)

    valid_class_ids = {d.id for d in school_ref.collection("classes").select([]).stream()}
    class_subject_ids = {}
    for doc in school_ref.collection("classes").stream():
        entries = (doc.to_dict() or {}).get("subjects") or []
        class_subject_ids[doc.id] = {e.get("subjectId") for e in entries if isinstance(e, dict) and e.get("subjectId")}

    total_staffs = _check_staffs(school_ref, valid_class_ids, class_subject_ids, findings)
    total_students, bad_class_students = _check_students(school_ref, valid_class_ids, findings)

    total_findings = sum(len(v) for v in findings.values())
    high_count = sum(1 for cat in findings.values() for f in cat if f["severity"] == "high")

    return {
        "schoolId": school_id,
        "status": "clean" if total_findings == 0 else ("needs_attention" if high_count else "minor_issues"),
        "collectionsPresent": present,
        "collectionsMissing": missing,
        "counts": {
            "subjects": subject_stats["total"], "classes": total_classes,
            "staffs": total_staffs, "students": total_students,
            "subjectsWithBrokenTopicShape": subject_stats["with_editor_shape_only"],
            "subjectsWithNoTopics": subject_stats["with_no_topics"],
            "studentsWithBadClassRef": bad_class_students,
        },
        "findings": findings,
        "totalFindings": total_findings,
        "highSeverityFindings": high_count,
    }


@https_fn.on_call(region="asia-south1", memory=options.MemoryOption.GB_1,
                   timeout_sec=300, max_instances=3)
def school_health_check(req: https_fn.CallableRequest):
    _require_ops_admin(req)
    data = req.data or {}
    school_id = (data.get("schoolId") or "").strip()
    all_schools = bool(data.get("allSchools"))

    if not school_id and not all_schools:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT,
            "Pass schoolId for one school, or allSchools: true for every school.")

    db = firestore.client()
    school_ids = [school_id] if school_id else [
        d.id for d in db.collection("schools").select([]).stream()
    ]

    reports = [_audit_school(sid) for sid in school_ids]
    return {
        "schoolCount": len(reports),
        "reports": reports,
        "summary": {
            "clean": sum(1 for r in reports if r["status"] == "clean"),
            "needsAttention": sum(1 for r in reports if r["status"] == "needs_attention"),
            "minorIssues": sum(1 for r in reports if r["status"] == "minor_issues"),
        },
    }
