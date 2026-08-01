#!/usr/bin/env python3
"""
Survey assignment — day-to-day ops Cloud Functions.

Replaces the manual "push survey IDs into each student's surveyInbox by
script" step with a reviewed, batched, logged operation.

Two callables, same source directory:
  assign_survey    preview or apply an assign/unassign run over a scope
  survey_overview  per-survey assigned/responded counts for the list view

Why server-side at all (the task is explicit, and it earns it): a school with
3000+ students is 3000 reads and up to 7 batched writes. Doing that from the
browser means a tab that must stay open, no atomic batching guarantees, and
no audit trail. Here it is one pass, chunked at 450 writes (Firestore's limit
is 500 — the margin covers the progress update sharing the batch window), with
progress streamed through the run doc so the UI can follow along.

The pure decision logic (junk filter, active check, target planning) lives in
survey_rules.py so it can be unit-tested without a Firebase environment —
main.py calls initialize_app() at import time. See tests/test_survey_rules.py.

Safety contract, all enforced here rather than trusted to the caller:
  - PREVIEW IS THE SAME CODE PATH as apply. `dryRun` stops before the writes;
    everything above it — target resolution, skip rules, counting — is
    identical, so the number shown is the number that happens.
  - arrayUnion / arrayRemove ONLY. Re-assigning is idempotent and can never
    duplicate; unassigning never touches a doc that doesn't have the survey.
  - NEVER writes to survey documents. This function assigns; it does not edit
    or delete surveys, including the junk/test docs (those are filtered from
    the UI only).
  - Inactive students are skipped, and the count is reported so the preview
    explains itself.

Deploy (see functions/DEPLOY.md):
  gcloud functions deploy assign_survey \
    --gen2 --runtime python312 --region asia-south1 \
    --source . --entry-point assign_survey \
    --trigger-http --allow-unauthenticated --project clarified-1501 \
    --memory 512MB --timeout 540s --max-instances 3

  gcloud functions deploy survey_overview \
    --gen2 --runtime python312 --region asia-south1 \
    --source . --entry-point survey_overview \
    --trigger-http --allow-unauthenticated --project clarified-1501 \
    --memory 512MB --timeout 120s --max-instances 3
"""
import firebase_admin
from firebase_admin import firestore
from firebase_functions import https_fn, options

from survey_rules import (
    DEFAULT_INBOX_FIELD, is_inactive, is_real_survey,
    plan_targets, filter_scope,
)

# Same reasoning as generate_import/main.py: the on_call framework verifies
# the caller's ID token before our body runs, and that needs the Admin SDK
# already initialized.
firebase_admin.initialize_app()

# Mirrors src/config/opsAdmins.js — keep in sync. Server-side is the
# authoritative check; the frontend's isOpsAdmin() is only a UI gate.
OPS_ADMIN_EMAILS = {"sid@ops.clarified.in", "angel@ops.clarified.in"}

WRITE_CHUNK = 450


def _require_ops_admin(req: https_fn.CallableRequest) -> str:
    if req.auth is None:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.UNAUTHENTICATED, "Sign in required.")
    email = str((req.auth.token or {}).get("email") or "").strip().lower()
    if email not in OPS_ADMIN_EMAILS:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.PERMISSION_DENIED,
            "Not authorized for survey assignment.")
    return email


def _collection_for(audience: str) -> str:
    return "staffs" if audience == "staff" else "students"


def _resolve_targets(db, school_id, audience, scope):
    """Every candidate recipient for this scope, before skip rules.

    Reads the whole collection once and filters in memory rather than issuing
    per-class queries: one pass is cheaper and simpler than N queries at 14+
    classes, and the same pass feeds the counting the preview needs.
    """
    coll = db.collection("schools").document(school_id).collection(_collection_for(audience))
    docs = [(d.id, d.to_dict() or {}) for d in coll.stream()]
    try:
        return filter_scope(docs, scope, audience)
    except ValueError as e:
        raise https_fn.HttpsError(https_fn.FunctionsErrorCode.INVALID_ARGUMENT, str(e))


@https_fn.on_call(region="asia-south1", memory=options.MemoryOption.MB_512,
                   timeout_sec=540, max_instances=3)
def assign_survey(req: https_fn.CallableRequest):
    """Preview or apply one assign/unassign run.

    Request:
      {schoolId, runId, surveyId, audience: students|staff,
       mode: assign|unassign, scope: {type, classIds?, ids?},
       dryRun: bool, inboxField?: str}

    Response:
      {target_count, will_change, already_count, inactive_skipped,
       existing_field_count, inbox_field, applied: bool, run_id}
    """
    email = _require_ops_admin(req)
    data = req.data or {}

    school_id = (data.get("schoolId") or "").strip()
    survey_id = (data.get("surveyId") or "").strip()
    run_id = (data.get("runId") or "").strip()
    audience = (data.get("audience") or "students").strip()
    mode = (data.get("mode") or "assign").strip()
    scope = data.get("scope") or {"type": "school"}
    dry_run = bool(data.get("dryRun", True))
    inbox_field = (data.get("inboxField") or DEFAULT_INBOX_FIELD).strip()

    missing = []
    if not school_id:
        missing.append("schoolId")
    if not survey_id:
        missing.append("surveyId")
    if audience not in ("students", "staff"):
        missing.append(f"audience (got {audience!r})")
    if mode not in ("assign", "unassign"):
        missing.append(f"mode (got {mode!r})")
    if not dry_run and not run_id:
        missing.append("runId (required to apply, so progress is followable)")
    if missing:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT,
            f"Missing/invalid field(s): {'; '.join(missing)}")

    db = firestore.client()
    school_ref = db.collection("schools").document(school_id)

    # The survey must exist and be a real one. Assigning a junk/test doc
    # would push a broken id into thousands of inboxes; unassigning is
    # allowed regardless, so a bad id pushed by the old scripts can always
    # be cleaned up.
    survey_snap = school_ref.collection("surveys").document(survey_id).get()
    if not survey_snap.exists:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.NOT_FOUND,
            f"Survey {survey_id} not found for this school.")
    survey = survey_snap.to_dict() or {}
    if mode == "assign" and not is_real_survey(survey):
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.FAILED_PRECONDITION,
            f"Survey {survey_id} looks like a test/incomplete document "
            "(no name translations or no questions) — refusing to assign it.")

    docs = _resolve_targets(db, school_id, audience, scope)
    plan = plan_targets(docs, survey_id, mode, inbox_field)

    result = {
        "run_id": run_id or None,
        "inbox_field": inbox_field,
        "target_count": len(docs),
        "will_change": len(plan["to_write"]),
        "already_count": plan["already"],
        "inactive_skipped": plan["inactive"],
        "existing_field_count": plan["existing_field"],
        "applied": False,
    }
    if dry_run:
        return result

    coll_name = _collection_for(audience)
    run_ref = school_ref.collection("survey_assignments").document(run_id)
    run_ref.set({
        "survey_id": survey_id,
        "survey_name": (survey.get("name") or {}).get("en") or survey_id,
        "audience": audience,
        "mode": mode,
        "scope_type": scope.get("type") or "school",
        "scope_value": scope.get("classIds") or scope.get("ids") or None,
        "inbox_field": inbox_field,
        "target_count": len(docs),
        "assigned_count": 0,
        "skipped_count": plan["already"] + plan["inactive"],
        "inactive_skipped": plan["inactive"],
        "status": "running",
        "progress": 0,
        "run_by": email,
        "run_at": firestore.SERVER_TIMESTAMP,
    })

    op = firestore.ArrayUnion([survey_id]) if mode == "assign" else firestore.ArrayRemove([survey_id])
    written = 0
    try:
        ids = plan["to_write"]
        for i in range(0, len(ids), WRITE_CHUNK):
            batch = db.batch()
            chunk = ids[i:i + WRITE_CHUNK]
            for doc_id in chunk:
                batch.set(school_ref.collection(coll_name).document(doc_id),
                          {inbox_field: op}, merge=True)
            batch.commit()
            written += len(chunk)
            # Progress lands on the run doc after each chunk — the UI streams
            # this rather than polling the callable, which is what makes a
            # 3000-student run watchable instead of a spinner.
            run_ref.set({"assigned_count": written,
                          "progress": round(written / max(len(ids), 1) * 100)}, merge=True)
    except Exception as e:
        run_ref.set({"status": "failed", "error": str(e), "assigned_count": written}, merge=True)
        raise https_fn.HttpsError(https_fn.FunctionsErrorCode.INTERNAL, str(e))

    run_ref.set({
        "status": "done", "progress": 100, "assigned_count": written,
        "completed_at": firestore.SERVER_TIMESTAMP,
    }, merge=True)

    result["applied"] = True
    result["written"] = written
    return result


@https_fn.on_call(region="asia-south1", memory=options.MemoryOption.MB_512,
                   timeout_sec=120, max_instances=3)
def survey_overview(req: https_fn.CallableRequest):
    """Per-survey assigned counts for one school, plus response counts.

    Assigned counts need a single pass over the roster (there is no index on
    "array contains X" per survey without querying once per survey), so it is
    done here rather than pulling 3000 student docs into the browser.

    Response counts use Firestore's count() aggregation over
    surveys/<id>/responses — cheap, and it degrades to null (not zero) when
    the subcollection or the aggregation is unavailable, so the UI can tell
    "none yet" from "not measurable here".
    """
    _require_ops_admin(req)
    data = req.data or {}
    school_id = (data.get("schoolId") or "").strip()
    inbox_field = (data.get("inboxField") or DEFAULT_INBOX_FIELD).strip()
    if not school_id:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT, "Missing schoolId")

    db = firestore.client()
    school_ref = db.collection("schools").document(school_id)

    assigned = {}
    active_total = 0
    for d in school_ref.collection("students").stream():
        doc = d.to_dict() or {}
        if str(doc.get("type") or "student") != "student" or is_inactive(doc):
            continue
        active_total += 1
        for sid in doc.get(inbox_field) or []:
            assigned[sid] = assigned.get(sid, 0) + 1

    staff_assigned = {}
    for d in school_ref.collection("staffs").stream():
        doc = d.to_dict() or {}
        if is_inactive(doc):
            continue
        for sid in doc.get(inbox_field) or []:
            staff_assigned[sid] = staff_assigned.get(sid, 0) + 1

    responses = {}
    for d in school_ref.collection("surveys").stream():
        try:
            agg = school_ref.collection("surveys").document(d.id).collection("responses").count().get()
            responses[d.id] = int(agg[0][0].value)
        except Exception:
            responses[d.id] = None  # seam: not measurable, not "zero"

    return {
        "assigned": assigned,
        "staff_assigned": staff_assigned,
        "responses": responses,
        "active_student_count": active_total,
    }
