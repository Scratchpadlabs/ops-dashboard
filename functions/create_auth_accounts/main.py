#!/usr/bin/env python3
"""Create Firebase Auth accounts for a school's students and staff.

Replaces two hand-run Node scripts (createauthaccounts{students,teachers}.js)
that were identical apart from the collection they read. They needed a service
account key on someone's laptop, had the school id edited into the source before
each run, and printed their results to a terminal nobody kept.

WHERE THIS SITS
    The Register tool creates the person's Firestore document with
    `needsAuthCreation: true`; the import pipeline does the same for a roster
    (useImport.js buildStaffPlan, generate_import commit). Neither can create an
    Auth account, because that is Admin SDK only and never available in a
    browser. This is that second half.

RESUMABLE BY CONSTRUCTION
    `needsAuthCreation` is the queue. A person is only cleared once their Auth
    account exists, so a run that times out or is cut short loses nothing —
    running again picks up exactly what is left. `limit` exists for that reason
    rather than as a safety rail.

WHAT IT DOES NOT DO
    It never returns or logs a password, never deletes an Auth user, and never
    touches a person whose account already exists AND is already linked.
"""

import firebase_admin
from firebase_admin import auth as fb_auth
from firebase_admin import firestore
from firebase_functions import https_fn, options

firebase_admin.initialize_app()

OPS_ADMIN_EMAILS = {"sid@ops.clarified.in", "angel@ops.clarified.in"}

COLLECTIONS = {"students", "staffs"}

# Firebase rejects anything shorter. Passwords here are the person's own id
# (see _password_for), so a short id is a data problem to report, not a reason
# to invent a different password the app would not know.
MIN_PASSWORD_LEN = 6

# Bounded so one call cannot run past its timeout. The flag makes the work
# resumable, so a big school is several runs rather than one long one.
DEFAULT_LIMIT = 200
MAX_LIMIT = 500


def _require_ops_admin(req):
    if req.auth is None:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.UNAUTHENTICATED, "Sign in required.")
    email = str((req.auth.token or {}).get("email") or "").strip().lower()
    if email not in OPS_ADMIN_EMAILS:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.PERMISSION_DENIED,
            "Not authorized to create auth accounts.")
    return email


def _password_for(data):
    """The person's own id, exactly as the hand-run scripts used.

    Not a choice made here: the teacher and student apps hand out this id as the
    first-time password, so changing it would lock everyone out. It is weak and
    guessable, which is worth fixing — but as a deliberate change to how the
    apps onboard, not as a side effect of automating the account creation.
    """
    return str(data.get("id") or "").strip()


def _display_name(data):
    name = str(data.get("name") or "").strip()
    if name:
        return name
    parts = [str(data.get("firstName") or "").strip(),
             str(data.get("lastName") or "").strip()]
    return " ".join(p for p in parts if p).strip() or None


def _clear_flag(doc_ref, uid):
    doc_ref.update({
        "needsAuthCreation": False,
        "authUid": uid,
        # Older rosters carried a plaintext password field. Nothing in this repo
        # writes one any more; removing it here cleans up what did.
        "password": firestore.DELETE_FIELD,
    })


@https_fn.on_call(region="asia-south1", memory=options.MemoryOption.MB_512,
                  timeout_sec=540, max_instances=3)
def create_auth_accounts(req: https_fn.CallableRequest):
    """{schoolId, collection, dryRun, limit} -> counts + per-person results.

    dryRun reports exactly what a real run would attempt, so the number on the
    confirm button is the number that happens — the same arrangement
    assign_survey uses.
    """
    _require_ops_admin(req)
    data = req.data or {}

    school_id = str(data.get("schoolId") or "").strip()
    collection = str(data.get("collection") or "").strip()
    dry_run = bool(data.get("dryRun", True))
    try:
        limit = int(data.get("limit") or DEFAULT_LIMIT)
    except (TypeError, ValueError):
        limit = DEFAULT_LIMIT
    limit = max(1, min(limit, MAX_LIMIT))

    if not school_id:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT, "schoolId is required.")
    if collection not in COLLECTIONS:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT,
            f"collection must be one of {sorted(COLLECTIONS)}.")

    db = firestore.client()
    col = db.collection("schools").document(school_id).collection(collection)

    pending = list(col.where("needsAuthCreation", "==", True).limit(limit + 1).stream())
    more_remaining = len(pending) > limit
    pending = pending[:limit]

    created = linked = skipped = failed = 0
    results = []

    for doc in pending:
        d = doc.to_dict() or {}
        email = str(d.get("email") or "").strip()
        person_id = str(d.get("id") or doc.id)

        if not email:
            skipped += 1
            results.append({"id": person_id, "email": "", "status": "skipped",
                            "reason": "no email on the record"})
            continue

        password = _password_for(d)
        if len(password) < MIN_PASSWORD_LEN:
            skipped += 1
            results.append({"id": person_id, "email": email, "status": "skipped",
                            "reason": f"id is shorter than {MIN_PASSWORD_LEN} characters, "
                                      "so it cannot be used as the password"})
            continue

        if dry_run:
            # Read-only probe: report whether this would create or link, without
            # touching Auth or Firestore.
            try:
                existing = fb_auth.get_user_by_email(email)
                linked += 1
                results.append({"id": person_id, "email": email, "status": "would_link",
                                "reason": "an auth account with this email already exists",
                                "uid": existing.uid})
            except fb_auth.UserNotFoundError:
                created += 1
                results.append({"id": person_id, "email": email, "status": "would_create"})
            except Exception as e:            # noqa: BLE001 — reported, not raised
                failed += 1
                results.append({"id": person_id, "email": email, "status": "error",
                                "reason": str(e)})
            continue

        try:
            user = fb_auth.create_user(email=email, password=password,
                                       display_name=_display_name(d))
            _clear_flag(doc.reference, user.uid)
            created += 1
            results.append({"id": person_id, "email": email, "status": "created",
                            "uid": user.uid})
        except fb_auth.EmailAlreadyExistsError:
            # The scripts recorded this as a failure and moved on, so the person
            # stayed flagged for ever and every later run retried them. The
            # account exists; what is missing is the link back to it.
            try:
                existing = fb_auth.get_user_by_email(email)
                _clear_flag(doc.reference, existing.uid)
                linked += 1
                results.append({"id": person_id, "email": email, "status": "linked",
                                "reason": "auth account already existed — linked to it",
                                "uid": existing.uid})
            except Exception as e:            # noqa: BLE001
                failed += 1
                results.append({"id": person_id, "email": email, "status": "failed",
                                "reason": f"exists but could not be linked: {e}"})
        except Exception as e:                # noqa: BLE001
            failed += 1
            results.append({"id": person_id, "email": email, "status": "failed",
                            "reason": str(e)})

    return {
        "schoolId": school_id,
        "collection": collection,
        "dryRun": dry_run,
        "considered": len(pending),
        "created": created,
        "linked": linked,
        "skipped": skipped,
        "failed": failed,
        "moreRemaining": more_remaining,
        "results": results,
    }
