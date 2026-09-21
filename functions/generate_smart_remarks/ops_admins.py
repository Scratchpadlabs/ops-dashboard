"""Single source of truth for the ops-admin allowlist used by every callable
in this repo that needs one.

WHY THIS EXISTS
    Before this file, the same literal set was copy-pasted independently into
    assign_survey, create_auth_accounts, generate_import, provision_hosting,
    school_reset and generate_aap_remarks — six places to remember to update
    together. `provision_hosting/main.py` even had a comment admitting the
    duplication was a known problem ("Keep OPS_ADMIN_EMAILS in step with
    src/config/opsAdmins.js"). Mirrors `src/config/opsAdmins.js`, the
    frontend's own single source of truth (used by src/App.vue's nav
    filtering and src/router/index.js's route guard) — keep the two in sync
    by hand, since a Python module and a JS module cannot literally share one
    file across this repo's two runtimes.

HOW IT'S DEPLOYED
    Like every other functions/shared/ module, this is mirrored into each
    consuming function's folder by tools/sync_shared.py, because
    `gcloud functions deploy --source .` only uploads that one folder. Run
    `python3 tools/sync_shared.py` after editing this file, before deploying
    or committing. Each consuming folder's tests/test_shared_sync.py asserts
    its copy is byte-identical to this one.

USAGE
    Callable functions (`@https_fn.on_call`) call `require_ops_admin(req)`,
    which verifies `req.auth` and the allowlist, and returns the caller's
    email for stamping onto whatever the callable writes (startedBy,
    updatedBy, confirmedBy, ...).

    `provision_hosting` is a plain HTTP function, not a callable, so it
    verifies the bearer token itself with `firebase_admin.auth.verify_id_token`
    — it imports OPS_ADMIN_EMAILS from here rather than using
    `require_ops_admin`, which assumes the callable protocol's `req.auth`.
"""

OPS_ADMIN_EMAILS = {"sid@ops.clarified.in", "angel@ops.clarified.in"}


def is_ops_admin(email):
    return bool(email) and str(email).strip().lower() in OPS_ADMIN_EMAILS


def require_ops_admin(req, message="Not authorized for this operation."):
    """Verifies a callable request's Firebase Auth token and the ops-admin
    allowlist. Returns the caller's lowercased email on success.

    `req` is an `https_fn.CallableRequest` — this only works for
    `@https_fn.on_call` functions, not plain HTTP ones (see module docstring).
    Imported lazily so this module has no hard dependency on
    `firebase_functions` for callers (like provision_hosting) that only need
    `OPS_ADMIN_EMAILS`.
    """
    from firebase_functions import https_fn

    if req.auth is None:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.UNAUTHENTICATED, "Sign in required.")
    email = str((req.auth.token or {}).get("email") or "").strip().lower()
    if email not in OPS_ADMIN_EMAILS:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.PERMISSION_DENIED, message)
    return email
