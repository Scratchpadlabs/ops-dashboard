#!/usr/bin/env python3
"""
School hosting provisioning — server side.

Four callables, same source directory:
  hosting_preview     what provisioning WOULD do. Reads only, never writes.
  hosting_provision   create the site, attach the domain, write DNS, start the build
  hosting_status      poll a run: cert state, build state, live URL
  hosting_sites       every Hosting site, its domains and its school; and
                      (action "assign") correcting which school a site is

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
server-side (functions/shared/ops_admins.py — mirror of src/config/opsAdmins.js,
kept in sync by hand since the two are different runtimes).

Provisioning is not transactional — a Hosting site can exist while DNS is still
pending. So each run is written to `hosting_runs/{runId}` step by step, and
re-running for the same school is idempotent at every stage: the site create
tolerates "already exists", the DNS merge is add-only and deduplicated, and the
build is just another deploy. Re-running a half-finished run is the recovery
path, and it is safe.

Deploy (see README.md in this directory):
  gcloud functions deploy hosting_preview   --gen2 --runtime python312 --region asia-south1 \
    --source . --entry-point hosting_preview --trigger-http --allow-unauthenticated \
    --memory 512MB --timeout 120s --max-instances 3 --project clarified-1501 \
    --vpc-connector ops-egress --egress-settings all \
    --set-secrets NAMECHEAP_API_KEY=NAMECHEAP_API_KEY:latest,NAMECHEAP_API_USER=NAMECHEAP_API_USER:latest,NAMECHEAP_CLIENT_IP=NAMECHEAP_CLIENT_IP:latest
  gcloud functions deploy hosting_provision --gen2 --runtime python312 --region asia-south1 \
    --source . --entry-point hosting_provision --trigger-http --allow-unauthenticated \
    --memory 512MB --timeout 300s --max-instances 2 --project clarified-1501 \
    --vpc-connector ops-egress --egress-settings all \
    --set-secrets NAMECHEAP_API_KEY=NAMECHEAP_API_KEY:latest,NAMECHEAP_API_USER=NAMECHEAP_API_USER:latest,NAMECHEAP_CLIENT_IP=NAMECHEAP_CLIENT_IP:latest,GITHUB_DISPATCH_PAT=GITHUB_DISPATCH_PAT:latest
  gcloud functions deploy hosting_status    --gen2 --runtime python312 --region asia-south1 \
    --source . --entry-point hosting_status --trigger-http --allow-unauthenticated \
    --memory 256MB --timeout 60s --max-instances 5 --project clarified-1501 \
    --set-secrets GITHUB_DISPATCH_PAT=GITHUB_DISPATCH_PAT:latest

  gcloud functions deploy hosting_sites     --gen2 --runtime python312 --region asia-south1 \
    --source . --entry-point hosting_sites --trigger-http --allow-unauthenticated \
    --memory 256MB --timeout 120s --max-instances 3 --project clarified-1501
"""
from __future__ import annotations

import json
import os
import re
import uuid
from concurrent.futures import ThreadPoolExecutor
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
from ops_admins import OPS_ADMIN_EMAILS
from ops_team import is_ops_team
from site_registry import custom_domains, newest_run_per_site, resolve_school, site_id_from_name

firebase_admin.initialize_app()

PROJECT_ID = "clarified-1501"
HOSTING_API = "https://firebasehosting.googleapis.com/v1beta1"
HOSTING_SCOPES = ["https://www.googleapis.com/auth/firebase.hosting"]

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


def _verified_email(req: https_fn.Request) -> str:
    """Verify the Firebase ID token. Returns the caller's email (lower case)."""
    header = req.headers.get("Authorization", "")
    if not header.startswith("Bearer "):
        raise PermissionError("Missing bearer token")
    try:
        decoded = fb_auth.verify_id_token(header.split(" ", 1)[1])
    except Exception as exc:  # noqa: BLE001 — any verification failure is a 401
        raise PermissionError(f"Invalid token: {exc}") from exc
    return (decoded.get("email") or "").strip().lower()


def _require_ops_admin(req: https_fn.Request) -> str:
    """Verify the Firebase ID token and the ops-admin allowlist. Returns email."""
    email = _verified_email(req)
    if email not in OPS_ADMIN_EMAILS:
        raise PermissionError(f"{email or 'caller'} is not an ops admin")
    return email


def _require_ops_team(req: https_fn.Request) -> str:
    """Verify the Firebase ID token and that the caller is on the ops team."""
    email = _verified_email(req)
    if not is_ops_team(email):
        raise PermissionError(f"{email or 'caller'} is not on the ops team")
    return email


def _json(body: dict, status: int = 200) -> https_fn.Response:
    # Serialised here: https_fn.Response is a plain Werkzeug response, and
    # handed a dict it iterates it — the body would be the keys run together,
    # not JSON.
    return https_fn.Response(json.dumps(body, default=str), status=status, mimetype="application/json")


def _json_error(message: str, status: int) -> https_fn.Response:
    return _json({"error": message}, status)


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

    return _json(plan)


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
    # The site's school, for the School Websites page — recorded up front, since
    # the site is this school's from the moment the run starts.
    db.collection("hosting_sites").document(plan["site_id"]).set({
        "school_id": plan["school_id"],
        "updated_by": actor,
        "updated_at": _now(),
    }, merge=True)

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
        return _json({"runId": run_id, "status": "awaiting_build", **plan})

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

    return _json(out)


# ── site registry ────────────────────────────────────────────────────────────

def _paged(session: requests.Session, url: str, key: str) -> list[dict]:
    items, token = [], None
    while True:
        params = {"pageSize": 100}
        if token:
            params["pageToken"] = token
        resp = session.get(url, params=params, timeout=30)
        resp.raise_for_status()
        body = resp.json()
        items.extend(body.get(key, []))
        token = body.get("nextPageToken")
        if not token:
            return items


def _site_domains(session: requests.Session, site_id: str) -> list[dict]:
    """Both domain APIs for one site. A failure reads as "no domains" rather
    than failing the whole list — one odd site must not blank the page."""
    try:
        custom = _paged(session, f"{HOSTING_API}/projects/{PROJECT_ID}/sites/{site_id}/customDomains", "customDomains")
    except requests.RequestException:
        custom = []
    try:
        legacy = _paged(session, f"{HOSTING_API}/sites/{site_id}/domains", "domains")
    except requests.RequestException:
        legacy = []
    return custom_domains(custom, legacy)


@https_fn.on_request(cors=CORS, region="asia-south1")
def hosting_sites(req: https_fn.Request) -> https_fn.Response:
    """
    {action?: "list"} -> {sites: [{siteId, defaultUrl, domains: [{domain, live, state}],
                                   schoolId, schoolName, source}]}
    {action: "assign", siteId, schoolId} -> {ok: true}   ("" = no school)

    Reads the live Hosting API, so a domain connected by hand in the Firebase
    console shows up too. `source` says where the school match came from — see
    site_registry.py.
    """
    # Listing which website each school has is read-only and needed by every
    # ops user (Student Pamphlets prints it); assigning stays admin-only.
    body = req.get_json(silent=True) or {}
    try:
        actor = _require_ops_admin(req) if body.get("action") == "assign" else _require_ops_team(req)
    except PermissionError as exc:
        return _json_error(str(exc), 401)

    db = firestore.client()

    if body.get("action") == "assign":
        site_id = str(body.get("siteId") or "").strip()
        school_id = str(body.get("schoolId") or "").strip()
        if not site_id or "/" in site_id:
            return _json_error("siteId is required", 400)
        if school_id and ("/" in school_id or not db.collection("schools").document(school_id).get().exists):
            return _json_error(f"School {school_id!r} does not exist", 400)
        db.collection("hosting_sites").document(site_id).set({
            "school_id": school_id, "updated_by": actor, "updated_at": _now(),
        }, merge=True)
        return _json({"ok": True})

    session = _hosting_session()
    try:
        sites = _paged(session, f"{HOSTING_API}/projects/{PROJECT_ID}/sites", "sites")
    except requests.RequestException as exc:
        return _json_error(f"Could not list Hosting sites: {exc}", 502)

    assigned = {d.id: (d.to_dict() or {}).get("school_id", "") for d in db.collection("hosting_sites").stream()}
    runs = newest_run_per_site([d.to_dict() or {} for d in db.collection("hosting_runs").stream()])
    names = {d.id: (d.to_dict() or {}).get("name") or d.id
             for d in db.collection("schools").select(["name"]).stream()}

    site_ids = [site_id_from_name(s.get("name", "")) for s in sites]
    with ThreadPoolExecutor(max_workers=8) as pool:
        domains = list(pool.map(lambda sid: _site_domains(session, sid), site_ids))

    out = []
    for site, site_id, site_domains in zip(sites, site_ids, domains):
        school_id, source = resolve_school(site_id, assigned, runs)
        out.append({
            "siteId": site_id,
            "defaultUrl": site.get("defaultUrl") or f"https://{site_id}.web.app",
            "domains": site_domains,
            "schoolId": school_id,
            # Blank when the id no longer matches a school doc — the page
            # flags that rather than hiding the site.
            "schoolName": names.get(school_id, "") if school_id else "",
            "source": source,
        })
    out.sort(key=lambda s: s["siteId"])
    return _json({"sites": out})

