#!/usr/bin/env python3
"""
create_auth_accounts — server side.

Replaces the two one-off local scripts (createAuthAccountsForStudents.js /
createAuthAccountsForTeachers.js) that were run by hand against a
serviceAccountKey.json, hardcoded to one school. Those never lived in a repo,
so nothing about them could be redeployed or recovered — this is that logic,
parameterized by schoolId and committed where it can't quietly disappear.

One callable, gated to ops-admins the same way the school_reset wizards are:

  create_auth_accounts   creates Firebase Auth accounts for students/staff
                          flagged needsAuthCreation == true, then marks them
                          done. dryRun previews exactly who would be touched
                          without creating anything.

Password: the Firestore DOCUMENT id, not a same-named "id" field. The
original student script used a "studentData.id" field that students don't
actually carry in the schema (functions/shared/school_schema.py has no `id`
field under "students" — only "staffs" does, where it's set equal to the doc
id at creation). Using the doc id directly works for both collections and
never depends on an optional field being present.

An account that already exists (re-running after a partial failure, or a
doc that was already flagged from a previous run) is treated as success: the
existing uid is looked up and the doc is still marked done, so retries are
safe and idempotent.

Deploy (see functions/DEPLOY.md):
  gcloud functions deploy create_auth_accounts --gen2 --runtime python312 \
    --region asia-south1 --source . --entry-point create_auth_accounts \
    --trigger-http --allow-unauthenticated --project clarified-1501 \
    --memory 512MB --timeout 300s --max-instances 3
"""
import firebase_admin
from firebase_admin import auth as fb_auth, firestore
from firebase_functions import https_fn, options

firebase_admin.initialize_app()

# Mirror of src/config/opsAdmins.js. Duplicated deliberately, same as every
# other admin-gated callable in this repo — the client-side list is a UI
# affordance, this one is the actual gate.
OPS_ADMIN_EMAILS = {"sid@ops.clarified.in", "angel@ops.clarified.in"}

WRITE_CHUNK = 450

ROLE_COLLECTIONS = {"students": "students", "staffs": "staffs"}


def _require_ops_admin(req: https_fn.CallableRequest) -> str:
    if req.auth is None:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.UNAUTHENTICATED, "Sign in required.")
    email = str((req.auth.token or {}).get("email") or "").strip().lower()
    if email not in OPS_ADMIN_EMAILS:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.PERMISSION_DENIED,
            "Not authorized to create auth accounts.")
    return email


def _display_name(doc: dict) -> str:
    name = (doc.get("name") or "").strip()
    if name:
        return name
    first = (doc.get("firstName") or "").strip()
    last = (doc.get("lastName") or "").strip()
    return f"{first} {last}".strip()


def _process_role(db, school_ref, role: str, dry_run: bool) -> dict:
    collection = ROLE_COLLECTIONS[role]
    candidates = list(
        school_ref.collection(collection).where("needsAuthCreation", "==", True).stream()
    )

    created, existing, failed, skipped = [], [], [], []
    batch = db.batch()
    pending = 0

    def commit_if_full():
        nonlocal batch, pending
        if pending >= WRITE_CHUNK:
            batch.commit()
            batch = db.batch()
            pending = 0

    for doc_snap in candidates:
        doc = doc_snap.to_dict() or {}
        email = (doc.get("email") or "").strip().lower()
        label = _display_name(doc) or doc_snap.id

        if not email:
            skipped.append({"id": doc_snap.id, "name": label, "reason": "no email on record"})
            continue

        if dry_run:
            created.append({"id": doc_snap.id, "name": label, "email": email})
            continue

        password = doc_snap.id
        uid = None
        status = None
        try:
            user_record = fb_auth.create_user(
                email=email, password=password, display_name=label or None,
            )
            uid = user_record.uid
            status = "created"
        except fb_auth.EmailAlreadyExistsError:
            try:
                uid = fb_auth.get_user_by_email(email).uid
                status = "existing"
            except Exception as exc:  # noqa: BLE001 — report, don't crash the run
                failed.append({"id": doc_snap.id, "name": label, "email": email, "error": str(exc)})
                continue
        except Exception as exc:  # noqa: BLE001 — one bad row must not abort the rest
            failed.append({"id": doc_snap.id, "name": label, "email": email, "error": str(exc)})
            continue

        batch.update(doc_snap.reference, {
            "needsAuthCreation": False,
            "authUid": uid,
            "password": firestore.DELETE_FIELD,
        })
        pending += 1
        commit_if_full()

        entry = {"id": doc_snap.id, "name": label, "email": email, "uid": uid}
        (created if status == "created" else existing).append(entry)

    if pending:
        batch.commit()

    return {
        "found": len(candidates),
        "created": created,
        "existing": existing,
        "failed": failed,
        "skipped": skipped,
    }


@https_fn.on_call(region="asia-south1", memory=options.MemoryOption.MB_512,
                   timeout_sec=300, max_instances=3)
def create_auth_accounts(req: https_fn.CallableRequest):
    """
    Create Firebase Auth accounts for students/staff flagged
    needsAuthCreation == true. dryRun previews who would be touched — no
    accounts are created and no documents are written.
    """
    _require_ops_admin(req)
    data = req.data or {}

    school_id = (data.get("schoolId") or "").strip()
    if not school_id:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT, "schoolId is required.")

    roles = data.get("roles") or ["students", "staffs"]
    bad = [r for r in roles if r not in ROLE_COLLECTIONS]
    if bad:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT, f"Unknown role(s): {bad}")

    dry_run = bool(data.get("dryRun", False))

    db = firestore.client()
    school_ref = db.collection("schools").document(school_id)
    if not school_ref.get().exists:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.NOT_FOUND, f"School {school_id!r} does not exist.")

    results = {role: _process_role(db, school_ref, role, dry_run) for role in roles}

    return {"schoolId": school_id, "dryRun": dry_run, "results": results}
