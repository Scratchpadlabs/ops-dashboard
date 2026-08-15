#!/usr/bin/env python3
"""
School hosting provisioning — server side.

Three callables, same source directory:
  hosting_preview     what provisioning WOULD do. Reads only, never writes.
  hosting_provision   create the site, attach the domain, write DNS, start the build
  hosting_status      poll a run: cert state, build state, live URL

THE CONSTRAINT: the teacher repo (Scratchpad-Labs/scratchpad_teacher) is
READ-ONLY. Not one byte is committed to it — not schools.json, not .firebaserc,
not firebase.json. That rules out dispatching the teacher repo's own deploy.yml,
which resolves its target from exactly those files. Instead this dispatches
ops-dashboard's `deploy-school.yml`, which checks the teacher repo out, builds it
with the school id injected, and deploys with a firebase.json generated in the
runner. See that workflow for the details.

WHY THIS ONE IS AUTHENTICATED, when the generate_* functions are not: those
render PDFs from data the caller already has. This one creates Hosting sites,
edits the DNS of a live domain, and triggers a deploy. An anonymous endpoint
holding a GitHub PAT and Namecheap credentials is a different risk class, so it
verifies a Firebase ID token and checks the caller against the ops-admin list
server-side. Keep OPS_ADMIN_EMAILS in step with src/config/opsAdmins.js.

Provisioning is not transactional — a Hosting site can exist while DNS is still
pending. So each run is written to `hosting_runs/{runId}` step by step, and
re-running for the same school is idempotent at every stage: the site create
tolerates "already exists", the DNS merge is add-only and deduplicated, and the
build is just another deploy. Re-running a half-finished run is the recovery
path, and it is safe.

Deploy (see README.md in this directory):
  gcloud functions deploy hosting_preview   --gen2 --runtime python312 --region asia-south1 \
    --source . --entry-point hosting_preview --trigger-http --no-allow-unauthenticated \
    --memory 512MB --timeout 120s --max-instances 3 --project clarified-1501 \
    --vpc-connector ops-egress --egress-settings all \
    --set-secrets NAMECHEAP_API_KEY=NAMECHEAP_API_KEY:latest,NAMECHEAP_API_USER=NAMECHEAP_API_USER:latest,NAMECHEAP_CLIENT_IP=NAMECHEAP_CLIENT_IP:latest
  gcloud functions deploy hosting_provision --gen2 --runtime python312 --region asia-south1 \
    --source . --entry-point hosting_provision --trigger-http --no-allow-unauthenticated \
    --memory 512MB --timeout 300s --max-instances 2 --project clarified-1501 \
    --vpc-connector ops-egress --egress-settings all \
    --set-secrets NAMECHEAP_API_KEY=NAMECHEAP_API_KEY:latest,NAMECHEAP_API_USER=NAMECHEAP_API_USER:latest,NAMECHEAP_CLIENT_IP=NAMECHEAP_CLIENT_IP:latest,GITHUB_DISPATCH_PAT=GITHUB_DISPATCH_PAT:latest
  gcloud functions deploy hosting_status    --gen2 --runtime python312 --region asia-south1 \
    --source . --entry-point hosting_status --trigger-http --no-allow-unauthenticated \
    --memory 256MB --timeout 60s --max-instances 5 --project clarified-1501 \
    --set-secrets GITHUB_DISPATCH_PAT=GITHUB_DISPATCH_PAT:latest
"""
from __future__ import annotations

import os
import re
import uuid
from datetime import datetime, timezone

import firebase_admin
import google.auth
import google.auth.transport.requests
import requests
from firebase_admin import auth as fb_auth, firestore
from firebase_functions import https_fn, options

from namecheap_dns import (
    NamecheapClient,
    NamecheapError,
    Record,
    apply_records,
    records_from_firebase_dns_updates,
)

firebase_admin.initialize_app()

PROJECT_ID = "clarified-1501"
HOSTING_API = "https://firebasehosting.googleapis.com/v1beta1"
HOSTING_SCOPES = ["https://www.googleapis.com/auth/firebase.hosting"]

# Mirror of src/config/opsAdmins.js. Duplicated deliberately: the client-side
# list is a UI affordance, this one is the actual gate.
OPS_ADMIN_EMAILS = {"sid@ops.clarified.in", "angel@ops.clarified.in"}

BASE_DOMAIN = os.environ.get("HOSTING_BASE_DOMAIN", "myhpc.in")
GITHUB_OWNER = os.environ.get("GITHUB_OWNER", "Scratchpadlabs")
GITHUB_REPO = os.environ.get("GITHUB_REPO", "ops-dashboard")
GITHUB_WORKFLOW = os.environ.get("GITHUB_WORKFLOW", "deploy-school.yml")
GITHUB_REF = os.environ.get("GITHUB_REF_NAME", "main")

# Hosting site ids: lowercase letters, digits and hyphens, 6-30 chars, no
# leading/trailing hyphen. This is a Hosting constraint, not a preference — and
# it is why the existing "SAMARTH DNYANPEETH SAHAYDRI" target could never have
# been a real site id.
SITE_ID_RE = re.compile(r"^[a-z0-9]([a-z0-9-]{4,28})[a-z0-9]$")

CORS = options.CorsOptions(
    cors_origins=[
        r"https://.*\.web\.app",
        r"https://.*\.firebaseapp\.com",
        r"http://localhost:\d+",
    ],
    cors_methods=["POST", "OPTIONS"],
)


# ── helpers ──────────────────────────────────────────────────────────────────

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _require_ops_admin(req: https_fn.Request) -> str:
    """Verify the Firebase ID token and the ops-admin allowlist. Returns email."""
    header = req.headers.get("Authorization", "")
    if not header.startswith("Bearer "):
        raise PermissionError("Missing bearer token")
    try:
        decoded = fb_auth.verify_id_token(header.split(" ", 1)[1])
    except Exception as exc:  # noqa: BLE001 — any verification failure is a 401
        raise PermissionError(f"Invalid token: {exc}") from exc
    email = (decoded.get("email") or "").strip().lower()
    if email not in OPS_ADMIN_EMAILS:
        raise PermissionError(f"{email or 'caller'} is not an ops admin")
    return email


def _json_error(message: str, status: int) -> https_fn.Response:
    return https_fn.Response({"error": message}, status=status, mimetype="application/json")


def _hosting_session() -> requests.Session:
    """ADC-authenticated session for the Hosting REST API."""
    creds, _ = google.auth.default(scopes=HOSTING_SCOPES)
    creds.refresh(google.auth.transport.requests.Request())
    session = requests.Session()
    session.headers.update({"Authorization": f"Bearer {creds.token}"})
    return session


def slugify_site_id(school_id: str) -> str:
    """
    Derive a Hosting-legal site id from a Firestore school id.

    Deterministic, so re-running provisioning lands on the same site rather than
    creating a second one alongside it.
    """
    slug = re.sub(r"[^a-z0-9]+", "-", school_id.lower()).strip("-")
    slug = re.sub(r"-{2,}", "-", slug)[:30].strip("-")
    if len(slug) < 6:
        slug = (slug + "-school")[:30].strip("-")
    return slug


def validate_site_id(site_id: str) -> str | None:
    if not SITE_ID_RE.match(site_id):
        return (
            f"{site_id!r} is not a valid Hosting site id — 6-30 characters, "
            "lowercase letters, digits and hyphens only, no leading or trailing hyphen."
        )
    return None


# ── Hosting REST ─────────────────────────────────────────────────────────────

def create_site(session: requests.Session, site_id: str) -> tuple[dict, bool]:
    """Create the site. Returns (site, created_now). Existing sites are fine."""
    resp = session.post(
        f"{HOSTING_API}/projects/{PROJECT_ID}/sites",
        params={"siteId": site_id},
        json={},
        timeout=60,
    )
    if resp.status_code == 409:
        got = session.get(f"{HOSTING_API}/projects/{PROJECT_ID}/sites/{site_id}", timeout=30)
        got.raise_for_status()
        return got.json(), False
    resp.raise_for_status()
    return resp.json(), True


def create_custom_domain(session: requests.Session, site_id: str, domain: str) -> tuple[dict, bool]:
    """Attach a custom domain. Returns (customDomain, created_now)."""
    resp = session.post(
        f"{HOSTING_API}/projects/{PROJECT_ID}/sites/{site_id}/customDomains",
        params={"customDomainId": domain},
        json={},
        timeout=60,
    )
    created = True
    if resp.status_code == 409:
        created = False
    elif not resp.ok:
        resp.raise_for_status()
    return get_custom_domain(session, site_id, domain), created


def get_custom_domain(session: requests.Session, site_id: str, domain: str) -> dict:
    resp = session.get(
        f"{HOSTING_API}/projects/{PROJECT_ID}/sites/{site_id}/customDomains/{domain}",
        timeout=30,
    )
    if resp.status_code == 404:
        return {}
    resp.raise_for_status()
    return resp.json()


# ── GitHub dispatch ──────────────────────────────────────────────────────────

def dispatch_build(school_id: str, site_id: str) -> None:
    token = os.environ.get("GITHUB_DISPATCH_PAT", "")
    if not token:
        raise RuntimeError("GITHUB_DISPATCH_PAT is not configured")
    resp = requests.post(
        f"https://api.github.com/repos/{GITHUB_OWNER}/{GITHUB_REPO}"
        f"/actions/workflows/{GITHUB_WORKFLOW}/dispatches",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
        json={"ref": GITHUB_REF, "inputs": {"school_id": school_id, "site_id": site_id}},
        timeout=30,
    )
    # 204 is the documented success for workflow_dispatch — it returns no body
    # and, unhelpfully, no run id. hosting_status finds the run by recency.
    if resp.status_code != 204:
        raise RuntimeError(f"workflow_dispatch failed ({resp.status_code}): {resp.text[:300]}")


def latest_run(site_id: str) -> dict:
    """Most recent deploy-school run, used to report build state."""
    token = os.environ.get("GITHUB_DISPATCH_PAT", "")
    if not token:
        return {}
    resp = requests.get(
        f"https://api.github.com/repos/{GITHUB_OWNER}/{GITHUB_REPO}"
        f"/actions/workflows/{GITHUB_WORKFLOW}/runs",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
        },
        params={"per_page": 20},
        timeout=30,
    )
    if not resp.ok:
        return {}
    for run in resp.json().get("workflow_runs", []):
        # display_title carries the dispatch inputs for manually dispatched runs;
        # fall back to returning the newest run rather than nothing.
        if site_id in (run.get("display_title") or "") or site_id in (run.get("name") or ""):
            return run
    runs = resp.json().get("workflow_runs", [])
    return runs[0] if runs else {}


# ── preserve list ────────────────────────────────────────────────────────────

def load_preserve_records(db) -> list[Record]:
    """
    `hosting_config/dns_preserve` = {records: [{name, type, address, ttl, mxPref}]}

    Records ops declares must always exist on the base domain — MX, SPF, DKIM —
    because Namecheap's API cannot see them and setHosts would otherwise drop
    them. See namecheap_dns.py for the full explanation.
    """
    snap = db.collection("hosting_config").document("dns_preserve").get()
    if not snap.exists:
        return []
    return [
        Record(
            name=r.get("name", "@"),
            type=r.get("type", ""),
            address=r.get("address", ""),
            ttl=str(r.get("ttl") or "1799"),
            mx_pref=str(r.get("mxPref") or "10"),
        )
        for r in (snap.to_dict() or {}).get("records", [])
        if r.get("type") and r.get("address")
    ]


def _plan(db, school_id: str, site_id: str | None, subdomain: str | None) -> dict:
    """Shared resolution for preview and provision."""
    school = db.collection("schools").document(school_id).get()
    if not school.exists:
        raise ValueError(f"School {school_id!r} does not exist")
    resolved_site = (site_id or slugify_site_id(school_id)).strip().lower()
    err = validate_site_id(resolved_site)
    if err:
        raise ValueError(err)
    label = (subdomain or resolved_site).strip().lower()
    return {
        "school_id": school_id,
        "school_name": (school.to_dict() or {}).get("name", school_id),
        "site_id": resolved_site,
        "subdomain": label,
        "domain": f"{label}.{BASE_DOMAIN}",
        "default_url": f"https://{resolved_site}.web.app",
    }


# ── callables ────────────────────────────────────────────────────────────────

@https_fn.on_request(cors=CORS, region="asia-south1")
def hosting_preview(req: https_fn.Request) -> https_fn.Response:
    """Everything provisioning would do, computed against live state. No writes."""
    try:
        _require_ops_admin(req)
    except PermissionError as exc:
        return _json_error(str(exc), 401)

    body = req.get_json(silent=True) or {}
    db = firestore.client()
    try:
        plan = _plan(db, body.get("schoolId", ""), body.get("siteId"), body.get("subdomain"))
    except ValueError as exc:
        return _json_error(str(exc), 400)

    session = _hosting_session()
    existing = session.get(
        f"{HOSTING_API}/projects/{PROJECT_ID}/sites/{plan['site_id']}", timeout=30
    )
    plan["site_exists"] = existing.status_code == 200

    if body.get("withDomain", True):
        try:
            client = NamecheapClient()
            preserve = load_preserve_records(db)
            # Nothing to add yet — Firebase only issues the challenge once the
            # customDomain exists — so this previews the zone and the guardrails
            # rather than the final record set.
            write = apply_records(client, BASE_DOMAIN, desired=[], preserve=preserve, dry_run=True)
            plan["dns"] = {
                "zone_record_count": len(write.before),
                "preserve_count": len(preserve),
                "warnings": write.warnings,
            }
        except NamecheapError as exc:
            plan["dns"] = {"error": str(exc)}

    return https_fn.Response(plan, status=200, mimetype="application/json")


@https_fn.on_request(cors=CORS, region="asia-south1")
def hosting_provision(req: https_fn.Request) -> https_fn.Response:
    """
    Create the site, attach the domain, write DNS, dispatch the build.

    Each step is recorded to hosting_runs/{runId} as it completes, so a failure
    halfway leaves an accurate record of what exists. Re-running is the recovery
    path and is safe at every stage.
    """
    try:
        actor = _require_ops_admin(req)
    except PermissionError as exc:
        return _json_error(str(exc), 401)

    body = req.get_json(silent=True) or {}
    db = firestore.client()
    try:
        plan = _plan(db, body.get("schoolId", ""), body.get("siteId"), body.get("subdomain"))
    except ValueError as exc:
        return _json_error(str(exc), 400)

    with_domain = bool(body.get("withDomain", True))
    run_id = f"{plan['site_id']}__{uuid.uuid4().hex[:8]}"
    run_ref = db.collection("hosting_runs").document(run_id)
    run: dict = {
        **plan,
        "id": run_id,
        "status": "in_progress",
        "with_domain": with_domain,
        "created_by": actor,
        "created_at": _now(),
        "steps": {},
    }
    run_ref.set(run)

    def step(name: str, **data) -> None:
        run["steps"][name] = {"at": _now(), **data}
        run_ref.set({"steps": run["steps"], "updated_at": _now()}, merge=True)

    try:
        session = _hosting_session()

        site, created = create_site(session, plan["site_id"])
        step("site", ok=True, created=created, name=site.get("name", ""))

        if with_domain:
            domain_doc, created_domain = create_custom_domain(
                session, plan["site_id"], plan["domain"]
            )
            step(
                "custom_domain",
                ok=True,
                created=created_domain,
                state=domain_doc.get("state", "UNKNOWN"),
            )

            desired = records_from_firebase_dns_updates(
                domain_doc.get("requiredDnsUpdates", {}), plan["subdomain"]
            )
            client = NamecheapClient()
            preserve = load_preserve_records(db)

            # Guardrail 4: the pre-change zone is persisted BEFORE the write, so
            # a bad write is always recoverable by hand.
            pre = client.get_hosts(BASE_DOMAIN)
            db.collection("hosting_dns_snapshots").document(run_id).set(
                {
                    "domain": BASE_DOMAIN,
                    "taken_at": _now(),
                    "run_id": run_id,
                    "records": [r.__dict__ for r in pre],
                }
            )

            write = apply_records(client, BASE_DOMAIN, desired=desired, preserve=preserve)
            step(
                "dns",
                ok=write.verified,
                added=[r.label() for r in write.added],
                warnings=write.warnings,
                snapshot=run_id,
            )

        dispatch_build(plan["school_id"], plan["site_id"])
        step("build_dispatched", ok=True)

        run_ref.set({"status": "awaiting_build", "updated_at": _now()}, merge=True)
        return https_fn.Response(
            {"runId": run_id, "status": "awaiting_build", **plan},
            status=200,
            mimetype="application/json",
        )

    except (NamecheapError, RuntimeError, requests.HTTPError) as exc:
        run_ref.set({"status": "failed", "error": str(exc), "updated_at": _now()}, merge=True)
        return _json_error(str(exc), 502)


@https_fn.on_request(cors=CORS, region="asia-south1")
def hosting_status(req: https_fn.Request) -> https_fn.Response:
    """Poll a run: cert state and build state. Safe to call on a loop."""
    try:
        _require_ops_admin(req)
    except PermissionError as exc:
        return _json_error(str(exc), 401)

    body = req.get_json(silent=True) or {}
    db = firestore.client()
    snap = db.collection("hosting_runs").document(body.get("runId", "")).get()
    if not snap.exists:
        return _json_error("Unknown run", 404)
    run = snap.to_dict() or {}

    out = {
        "runId": run.get("id"),
        "status": run.get("status"),
        "steps": run.get("steps", {}),
        "default_url": run.get("default_url"),
        "domain": run.get("domain"),
    }

    if run.get("with_domain"):
        try:
            domain_doc = get_custom_domain(_hosting_session(), run["site_id"], run["domain"])
            out["cert_state"] = domain_doc.get("state", "UNKNOWN")
            out["required_dns_updates"] = domain_doc.get("requiredDnsUpdates", {})
        except requests.HTTPError as exc:
            out["cert_state"] = f"error: {exc}"

    gh = latest_run(run.get("site_id", ""))
    if gh:
        out["build"] = {
            "status": gh.get("status"),
            "conclusion": gh.get("conclusion"),
            "url": gh.get("html_url"),
        }
        if gh.get("conclusion") == "success" and run.get("status") == "awaiting_build":
            db.collection("hosting_runs").document(run["id"]).set(
                {"status": "live", "updated_at": _now()}, merge=True
            )
            out["status"] = "live"

    return https_fn.Response(out, status=200, mimetype="application/json")
