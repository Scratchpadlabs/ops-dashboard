#!/usr/bin/env python3
"""
ClarifiEd material intake — Email intake -> auto-staged imports.

Schools send material by email (or forward from WhatsApp) to a dedicated
intake mailbox. This Cloud Function polls that mailbox via the Gmail API on
a Cloud Scheduler cadence (every 5 minutes — see functions/email_intake/
SETUP.md for the one-time mailbox/OAuth/scheduler setup), and for every
unprocessed message with attachments:

  1. Saves each attachment to Cloud Storage under `intake/<school-or-
     unassigned>/<date>-<msgId>-<filename>` (same bucket as generate_import,
     clarified-1501.appspot.com — a new `intake/` prefix, not a new bucket).
  2. Writes a Firestore `intake_files/{msgId}_{partId}` doc.
  3. Matches the sender against each school's `intake_emails` list (root
     `schools/{schoolId}.intake_emails`, editable in School Setup's Overview
     tab), falling back to a subject-line school-name hint. No confident
     match leaves school_id null, status "unassigned".
  4. For spreadsheet-like attachments (xlsx/xls/csv/htm-as-xls) with a
     confidently-detected entity type (tabular_parser.detect_entity_type —
     DETECTION mode: header-alias scoring only, no LLM call) AND an assigned
     school, creates a `staging_imports` job — the exact same collection and
     pipeline the Import tab uses — by invoking the existing `process_import`
     callable (see _invoke_process_import below for why/how). PDFs/images/
     docx and anything not confidently classified stay intake-queue-only;
     commit into School Setup always stays a separate, human-triggered step
     (this function never calls commit_import).
  5. Labels the Gmail message processed (idempotent: unlabeled messages are
     the only ones re-queried; a per-attachment Firestore-doc-exists check is
     the belt-and-braces guard against a crash between "attachment saved" and
     "message labeled").

Every failure — a bad attachment, a Gmail API hiccup, a failed auto-stage —
is caught and recorded as an `intake_files` doc with status "error" +
`status_reason`, never silently dropped and never left to crash the whole
run (same never-silent-fail contract as the parser-hardening task).

Deploy (self-contained source dir, same convention as every other function
in this repo — see functions/DEPLOY.md and functions/email_intake/SETUP.md
for the full one-time setup this depends on):
  gcloud functions deploy process_intake_emails \
    --gen2 --runtime python312 --region asia-south1 \
    --source . --entry-point process_intake_emails \
    --trigger-http --no-allow-unauthenticated --project clarified-1501 \
    --memory 512MB --timeout 300s --max-instances 1 \
    --set-secrets GMAIL_INTAKE_CLIENT_ID=GMAIL_INTAKE_CLIENT_ID:latest,GMAIL_INTAKE_CLIENT_SECRET=GMAIL_INTAKE_CLIENT_SECRET:latest,GMAIL_INTAKE_REFRESH_TOKEN=GMAIL_INTAKE_REFRESH_TOKEN:latest

`--no-allow-unauthenticated`: this function takes no useful input from a
caller (it always just drains the intake mailbox) and is meant to be invoked
only by Cloud Scheduler via an OIDC token — see SETUP.md. `--max-instances 1`
is deliberate: overlapping runs would race on the same unlabeled-message
query and risk double-processing before the idempotency label lands.
"""
import base64
import json
import os
import re
from datetime import datetime, timezone
from email.utils import parseaddr, parsedate_to_datetime
from pathlib import PurePosixPath

import requests

import firebase_admin
from firebase_admin import auth as fb_auth, firestore, storage
from firebase_functions import https_fn, options

from normalize import canonicalize
from tabular_parser import detect_entity_type

# See functions/generate_import/main.py for why this must run at module load.
firebase_admin.initialize_app(options={"storageBucket": "clarified-1501.appspot.com"})

# Mirrors src/config/opsAdmins.js / functions/generate_import/main.py — keep
# in sync. IMPERSONATE_EMAIL must be one of these (checked at call time by
# process_import's own _require_ops_admin, so a typo here just fails loudly
# rather than silently bypassing anything).
OPS_ADMIN_EMAILS = {"sid@ops.clarified.in", "angel@ops.clarified.in"}
IMPERSONATE_EMAIL = os.environ.get("INTAKE_IMPERSONATE_EMAIL", "sid@ops.clarified.in")

# Firebase Web API key — the same public, non-secret key already shipped in
# the browser bundle (src/firebase/config.js's apiKey). It only identifies
# the Firebase project to the Identity Toolkit REST API below; it is not a
# credential (Firebase API keys are safe to embed client-side by design).
FIREBASE_WEB_API_KEY = "AIzaSyC3q60cBqtvOytXP4O3iK99OeOlh7MgvTw"
PROCESS_IMPORT_URL = "https://asia-south1-clarified-1501.cloudfunctions.net/process_import"

GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.modify"]
INTAKE_LABEL_NAME = "ClarifiEdProcessed"  # no spaces/slashes -> safe in Gmail search queries verbatim
BATCH_SIZE = int(os.environ.get("INTAKE_BATCH_SIZE", "20"))

SPREADSHEET_EXTS = {".xlsx", ".xlsm", ".xls", ".csv", ".tsv", ".htm", ".html"}
DOC_EXTS = {".pdf", ".png", ".jpg", ".jpeg", ".webp", ".docx"}


# ---------------------------------------------------------------- gmail ----
def _gmail_service():
    """Builds an authenticated Gmail API client from a long-lived OAuth
    refresh token (Secret Manager — see SETUP.md for how it's minted once).
    A dedicated intake mailbox is a personal/shared Gmail account, not a
    Workspace domain Sid administers, so domain-wide delegation isn't an
    option here — a stored refresh token is the standard alternative."""
    from google.oauth2.credentials import Credentials
    from googleapiclient.discovery import build

    creds = Credentials(
        token=None,
        refresh_token=os.environ["GMAIL_INTAKE_REFRESH_TOKEN"],
        token_uri="https://oauth2.googleapis.com/token",
        client_id=os.environ["GMAIL_INTAKE_CLIENT_ID"],
        client_secret=os.environ["GMAIL_INTAKE_CLIENT_SECRET"],
        scopes=GMAIL_SCOPES,
    )
    return build("gmail", "v1", credentials=creds, cache_discovery=False)


def _get_or_create_label(service):
    labels = service.users().labels().list(userId="me").execute().get("labels", [])
    for l in labels:
        if l["name"] == INTAKE_LABEL_NAME:
            return l["id"]
    created = service.users().labels().create(userId="me", body={
        "name": INTAKE_LABEL_NAME, "labelListVisibility": "labelHide", "messageListVisibility": "hide",
    }).execute()
    return created["id"]


def _list_unprocessed_message_ids(service, max_results):
    q = f"has:attachment -label:{INTAKE_LABEL_NAME} in:inbox"
    resp = service.users().messages().list(userId="me", q=q, maxResults=max_results).execute()
    return [m["id"] for m in resp.get("messages", [])]


def _header(headers, name):
    for h in headers:
        if h.get("name", "").lower() == name.lower():
            return h.get("value", "")
    return ""


def _walk_parts(part):
    """Yields every MIME part with a non-empty filename (i.e. an attachment),
    recursing into multipart containers."""
    if part.get("filename"):
        yield part
    for sub in part.get("parts") or []:
        yield from _walk_parts(sub)


def _fetch_attachment_bytes(service, msg_id, part):
    body = part.get("body") or {}
    if body.get("attachmentId"):
        data = service.users().messages().attachments().get(
            userId="me", messageId=msg_id, id=body["attachmentId"]).execute()["data"]
    elif body.get("data"):
        data = body["data"]
    else:
        return b""
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


# ------------------------------------------------------------- matching ----
def _content_type_guess(filename):
    ext = PurePosixPath(filename).suffix.lower()
    if ext in SPREADSHEET_EXTS:
        return "spreadsheet"
    if ext == ".pdf":
        return "pdf"
    if ext in (".png", ".jpg", ".jpeg", ".webp"):
        return "image"
    if ext == ".docx":
        return "docx"
    return "other"


def _load_schools_cache(db):
    """{id, name, intake_emails} for every active school in the root config
    tree (the same tree Import/School Setup use) — reloaded fresh each run
    rather than cached across invocations, since intake_emails changes as
    Sid assigns unmatched senders (see the Intake Queue UI)."""
    docs = db.collection("schools").stream()
    out = []
    for d in docs:
        data = d.to_dict() or {}
        if data.get("isActive") is False:
            continue
        out.append({
            "id": d.id, "name": data.get("name") or d.id,
            "intake_emails": [e.strip().lower() for e in (data.get("intake_emails") or [])],
        })
    return out


def _match_school(schools, sender_email, subject):
    """Returns (school_id_or_None, match_signal_or_None). Sender-email match
    is authoritative and unambiguous by construction (each address is added
    to exactly one school's list via the Intake Queue's assign action).
    Subject-hint matching only fires when exactly one school's name appears
    in the subject — an ambiguous multi-match is treated as no match at all,
    per the task's "no confident match -> unassigned" rule."""
    sender_norm = (sender_email or "").strip().lower()
    if sender_norm:
        for s in schools:
            if sender_norm in s["intake_emails"]:
                return s["id"], "sender_email"

    subject_canon = canonicalize(subject or "")
    if subject_canon:
        hits = [s["id"] for s in schools if len(s["name"]) >= 4 and canonicalize(s["name"]) in subject_canon]
        if len(hits) == 1:
            return hits[0], "subject_hint"

    return None, None


def _sanitize_path_segment(s):
    return re.sub(r"[^A-Za-z0-9._\-]+", "_", (s or "").strip()) or "file"


# --------------------------------------------------- process_import call ---
# email_intake has no signed-in user — it's a scheduled backend job — but the
# staging pipeline it needs (extraction, cleaning, validation, alias
# learning, LLM fallback) already lives entirely in process_import, and that
# is deliberately the ONLY place that logic is allowed to live (duplicating
# main.py's ~900 lines here would mean two pipelines silently drifting apart).
# process_import is a Firebase callable, which authenticates via a real
# Firebase Auth ID token (req.auth), not a Google Cloud IAM token — so this
# mints a short-lived custom token for an actual ops-admin account and
# exchanges it for an ID token via the Identity Toolkit REST API, the
# standard pattern for one Firebase backend calling another's callable
# functions. IMPERSONATE_EMAIL must already be a real Firebase Auth user
# (Sid/Angel's own login) — process_import's own _require_ops_admin check is
# still the authority on whether this is allowed to write anything.
_impersonate_uid_cache = None


def _impersonate_uid():
    global _impersonate_uid_cache
    if _impersonate_uid_cache is None:
        if IMPERSONATE_EMAIL not in OPS_ADMIN_EMAILS:
            raise RuntimeError(f"INTAKE_IMPERSONATE_EMAIL {IMPERSONATE_EMAIL!r} is not an ops admin")
        _impersonate_uid_cache = fb_auth.get_user_by_email(IMPERSONATE_EMAIL).uid
    return _impersonate_uid_cache


def _mint_id_token():
    custom_token = fb_auth.create_custom_token(_impersonate_uid()).decode()
    r = requests.post(
        "https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken",
        params={"key": FIREBASE_WEB_API_KEY},
        json={"token": custom_token, "returnSecureToken": True},
        timeout=30)
    r.raise_for_status()
    return r.json()["idToken"]


def _invoke_process_import(school_id, job_id, entity, files):
    id_token = _mint_id_token()
    r = requests.post(
        PROCESS_IMPORT_URL,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {id_token}"},
        json={"data": {"schoolId": school_id, "jobId": job_id, "entity": entity, "files": files}},
        timeout=540)
    body = r.json() if r.content else {}
    if "error" in body:
        raise RuntimeError(f"process_import: {body['error'].get('message', body['error'])}")
    if not r.ok:
        raise RuntimeError(f"process_import HTTP {r.status_code}: {r.text[:500]}")
    return body.get("result")


# ------------------------------------------------------------ per-file -----
def _process_attachment(db, bucket, service, schools, msg_id, subject, sender, received_at, part, job_diag):
    filename = part.get("filename") or "attachment"
    part_id = part.get("partId") or "0"
    file_id = f"{msg_id}_{_sanitize_path_segment(part_id)}"
    file_ref = db.collection("intake_files").document(file_id)

    existing = file_ref.get()
    if existing.exists and (existing.to_dict() or {}).get("status") != "error":
        job_diag["skipped"] += 1
        return  # already processed on a prior (possibly interrupted) run

    school_id, match_signal = _match_school(schools, sender, subject)
    content_type_guess = _content_type_guess(filename)
    date_prefix = received_at.strftime("%Y-%m-%d")
    gcs_path = (f"intake/{school_id or 'unassigned'}/"
                f"{date_prefix}-{msg_id}-{_sanitize_path_segment(filename)}")

    base_doc = {
        "school_id": school_id, "match_signal": match_signal,
        "sender": sender, "subject": subject, "received_at": received_at,
        "gcs_path": gcs_path, "filename": filename, "msg_id": msg_id,
        "content_type_guess": content_type_guess,
        "updated_at": firestore.SERVER_TIMESTAMP,
    }

    try:
        raw = _fetch_attachment_bytes(service, msg_id, part)
        blob = bucket.blob(gcs_path)
        blob.upload_from_string(raw, content_type=None)
        base_doc["size"] = len(raw)
    except Exception as e:
        file_ref.set({
            **base_doc, "status": "error", "status_reason": f"could not save attachment: {e}",
            "created_at": firestore.SERVER_TIMESTAMP,
        }, merge=True)
        job_diag["errors"] += 1
        return

    entity_guess = None
    if content_type_guess == "spreadsheet":
        try:
            entity_guess, score, _sheet = detect_entity_type(filename, raw)
        except Exception as e:
            print(f"_process_attachment: detect_entity_type failed for {filename}: {e}")
            entity_guess = None

    if content_type_guess == "spreadsheet" and entity_guess and school_id:
        job_id = f"intake_{file_id}"
        try:
            db.collection("staging_imports").document(job_id).set({
                "school_id": school_id, "entity": entity_guess, "source_files": [gcs_path],
                "status": "processing", "source": "email", "intake_file_id": file_id,
                "created_by": "email-intake", "created_at": firestore.SERVER_TIMESTAMP,
            }, merge=True)
            _invoke_process_import(school_id, job_id, entity_guess, [{"path": gcs_path, "name": filename}])
            file_ref.set({
                **base_doc, "status": "staged", "entity_guess": entity_guess,
                "staging_job_id": job_id, "status_reason": None,
                "created_at": firestore.SERVER_TIMESTAMP,
            }, merge=True)
            job_diag["staged"] += 1
        except Exception as e:
            file_ref.set({
                **base_doc, "status": "error", "entity_guess": entity_guess,
                "staging_job_id": job_id, "status_reason": f"auto-stage failed: {e}",
                "created_at": firestore.SERVER_TIMESTAMP,
            }, merge=True)
            job_diag["errors"] += 1
        return

    # Unknown type, non-spreadsheet, or no assigned school — queue-only, per
    # rule 4/5: never auto-stage without a confident classification AND a
    # known school.
    status = "queued" if school_id else "unassigned"
    file_ref.set({
        **base_doc, "status": status, "entity_guess": entity_guess, "status_reason": None,
        "created_at": firestore.SERVER_TIMESTAMP,
    }, merge=True)
    job_diag[status] = job_diag.get(status, 0) + 1


def _received_at(service, msg_id, headers, internal_date_ms):
    date_hdr = _header(headers, "Date")
    if date_hdr:
        try:
            dt = parsedate_to_datetime(date_hdr)
            return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
        except Exception:
            pass
    try:
        return datetime.fromtimestamp(int(internal_date_ms) / 1000, tz=timezone.utc)
    except Exception:
        return datetime.now(timezone.utc)


def _process_message(db, bucket, service, schools, msg_id, job_diag):
    msg = service.users().messages().get(userId="me", id=msg_id, format="full").execute()
    payload = msg.get("payload") or {}
    headers = payload.get("headers") or []
    _, sender = parseaddr(_header(headers, "From"))
    subject = _header(headers, "Subject")
    received_at = _received_at(service, msg_id, headers, msg.get("internalDate"))

    attachments = list(_walk_parts(payload))
    for part in attachments:
        _process_attachment(db, bucket, service, schools, msg_id, subject, sender, received_at, part, job_diag)


# ------------------------------------------------------------------ main ---
@https_fn.on_request(
    region="asia-south1", memory=options.MemoryOption.MB_512, timeout_sec=300, max_instances=1,
    secrets=["GMAIL_INTAKE_CLIENT_ID", "GMAIL_INTAKE_CLIENT_SECRET", "GMAIL_INTAKE_REFRESH_TOKEN"],
)
def process_intake_emails(req: https_fn.Request) -> https_fn.Response:
    job_diag = {"messages": 0, "skipped": 0, "staged": 0, "queued": 0, "unassigned": 0, "errors": 0}
    try:
        db = firestore.client()
        bucket = storage.bucket()
        service = _gmail_service()
        label_id = _get_or_create_label(service)
        message_ids = _list_unprocessed_message_ids(service, BATCH_SIZE)
        schools = _load_schools_cache(db)

        for msg_id in message_ids:
            job_diag["messages"] += 1
            try:
                _process_message(db, bucket, service, schools, msg_id, job_diag)
                service.users().messages().modify(
                    userId="me", id=msg_id, body={"addLabelIds": [label_id]}).execute()
            except Exception as e:
                # Leave unlabeled so the message is retried on the next run —
                # never silently drop a whole message on a transient failure.
                print(f"process_intake_emails: message {msg_id} failed, will retry next run: {e}")

        print(f"process_intake_emails: {json.dumps(job_diag)}")
        return https_fn.Response(json.dumps(job_diag), status=200, content_type="application/json")
    except Exception as e:
        print(f"process_intake_emails: run failed: {e}")
        return https_fn.Response(json.dumps({"error": str(e), **job_diag}), status=500, content_type="application/json")
