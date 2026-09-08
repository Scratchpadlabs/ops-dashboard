#!/usr/bin/env python3
"""
copy_school_content — server-side copy of survey definitions between schools.

Why this exists: firestore.rules deliberately gives the ops-dashboard client
NO write path to schools/{id}/surveys — see the comment on the
schools/{schoolId}/{collection}/{docId} rule ("the dashboard only READS
surveys ... it never writes a survey document at all"). That's intentional
policy, not an oversight, so the fix isn't to loosen the rule; it's to do the
write server-side with the Admin SDK, same as every other survey-adjacent
write in this codebase (functions/assign_survey writes surveyInbox/
survey_assignments the same way).

Pairs with School Setup's Clone School tab (CloneSchoolTab.vue), "Copy Into
Existing School" mode: activities/playbooks/avatars copy fine as direct
client writes (those collections ARE in the writable list), only surveys
needed this. One callable, one collection, on purpose — expand the
ALLOWED_COLLECTIONS set here if another collection ever needs the same
treatment, rather than opening this up to arbitrary collections.

Deploy (see functions/DEPLOY.md):
  cd functions/copy_school_content
  gcloud functions deploy copy_school_content \
    --gen2 --runtime python312 --region asia-south1 \
    --source . --entry-point copy_school_content \
    --trigger-http --allow-unauthenticated --project clarified-1501 \
    --memory 512MB --timeout 300s --max-instances 3
"""
import re

import firebase_admin
from firebase_admin import firestore
from firebase_functions import https_fn, options

firebase_admin.initialize_app()

# Mirrors src/config/opsAdmins.js — keep in sync. Server-side is the
# authoritative check; the frontend's isOpsAdmin() is only a UI gate.
OPS_ADMIN_EMAILS = {"sid@ops.clarified.in", "angel@ops.clarified.in"}

WRITE_CHUNK = 450
ALLOWED_COLLECTIONS = {"surveys"}

_REF_FIELD_RE = re.compile(r"classid|subjectid", re.IGNORECASE)


def _require_ops_admin(req: https_fn.CallableRequest) -> str:
    if req.auth is None:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.UNAUTHENTICATED, "Sign in required.")
    email = str((req.auth.token or {}).get("email") or "").strip().lower()
    if email not in OPS_ADMIN_EMAILS:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.PERMISSION_DENIED,
            "Not authorized for School Setup.")
    return email


def _find_ref_fields(data, path=""):
    """Same heuristic as CloneSchoolTab.vue's findRefFields — `surveys` has
    no fixed schema in this app, so this is a structural guess (any field
    NAME containing classId/subjectId), not a shape-specific check. Flagged
    for a human to fix, never auto-remapped: a value copied verbatim from the
    source school is almost certainly a source-school ID that won't resolve
    against the target's own classes/subjects.
    """
    hits = []
    if isinstance(data, list):
        for i, v in enumerate(data):
            hits.extend(_find_ref_fields(v, f"{path}[{i}]"))
    elif isinstance(data, dict):
        for k, v in data.items():
            p = f"{path}.{k}" if path else k
            if _REF_FIELD_RE.search(k):
                hits.append(p)
            hits.extend(_find_ref_fields(v, p))
    return hits


@https_fn.on_call(region="asia-south1", memory=options.MemoryOption.MB_512,
                   timeout_sec=300, max_instances=3)
def copy_school_content(req: https_fn.CallableRequest):
    """Copy every doc in one collection from a source school into a target
    school that already exists (Clone School's "Copy Into Existing School").

    Request: {sourceSchoolId, targetSchoolId, collection}
    Response: {copied, flagged: [{id, fields}]}

    Same per-doc conflict rule as the client-side copy for activities/
    playbooks/avatars: the source doc ID is preserved unless the target
    already has a doc there, in which case it gets a fresh auto-ID rather
    than risk overwriting a doc the target already owns.
    """
    _require_ops_admin(req)
    data = req.data or {}
    source_id = str(data.get("sourceSchoolId") or "").strip()
    target_id = str(data.get("targetSchoolId") or "").strip()
    collection = str(data.get("collection") or "").strip()

    if not source_id or not target_id:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT,
            "sourceSchoolId and targetSchoolId are required.")
    if source_id == target_id:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT,
            "Source and target must be different schools.")
    if collection not in ALLOWED_COLLECTIONS:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT,
            f"collection must be one of {sorted(ALLOWED_COLLECTIONS)}.")

    db = firestore.client()
    target_school_ref = db.collection("schools").document(target_id)
    if not target_school_ref.get().exists:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.NOT_FOUND,
            f'Target school "{target_id}" does not exist — this is for '
            "copying into an ALREADY-LIVE school, not creating a new one.")

    source_docs = list(
        db.collection("schools").document(source_id).collection(collection).stream())
    if not source_docs:
        return {"copied": 0, "flagged": []}

    target_coll = target_school_ref.collection(collection)
    existing_ids = {d.id for d in target_coll.stream()}

    flagged = []
    batch = db.batch()
    ops_in_batch = 0
    copied = 0

    for src_doc in source_docs:
        doc_data = src_doc.to_dict() or {}
        use_fresh_id = src_doc.id in existing_ids
        doc_ref = target_coll.document() if use_fresh_id else target_coll.document(src_doc.id)

        fields = _find_ref_fields(doc_data)
        if fields:
            shown_id = f"{src_doc.id} -> {doc_ref.id}" if use_fresh_id else src_doc.id
            flagged.append({"id": shown_id, "fields": fields})

        batch.set(doc_ref, doc_data, merge=True)
        ops_in_batch += 1
        copied += 1
        if ops_in_batch >= WRITE_CHUNK:
            batch.commit()
            batch = db.batch()
            ops_in_batch = 0

    if ops_in_batch:
        batch.commit()

    return {"copied": copied, "flagged": flagged}
