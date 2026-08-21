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

That check — `_require_ops_admin` below — is the ONLY gate, and it deliberately
runs in-process rather than at the platform edge. These functions are deployed
with platform auth OPEN, which is not a weakening: it means "Cloud Run performs
no IAM check", not "anyone may provision a school".

Requiring IAM auth at the edge instead makes them unreachable from a browser,
for two independent reasons. Both are worth writing down, because the symptom in
DevTools is a misleading CORS error:

  1. The CORS preflight is anonymous BY SPEC. Browsers never attach an
     Authorization header to the OPTIONS request. Cloud Run's IAM layer rejects
     it 403 before the container starts, so the CorsOptions below never runs and
     no Access-Control-Allow-Origin header is ever emitted. The browser reports
     "Response to preflight request doesn't pass access control check" and
     "Failed to fetch" — which reads like a CORS misconfiguration and is not.
  2. Even past the preflight, IAM wants a GOOGLE-SIGNED OIDC identity token
     minted for this function's audience. The dashboard sends a FIREBASE ID
     token. Different credentials, different issuers; a Firebase ID token can
     only be validated in-process, by fb_auth.verify_id_token. IAM would reject
     every POST with a 403 as well.

So: platform auth open, application auth strict. That is the standard Firebase
pattern, and the one the rest of functions/ already follows.

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
"""
from __future__ import annotations

import json
import os
import re
import uuid
from datetime import datetime, timedelta, timezone

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

# Anchored with $ on purpose. Origin patterns are matched with re.match, which
# anchors the START only — an unanchored r"https://.*\.web\.app" also matches
# https://anything.web.app.attacker.example, which would hand a hostile page a
# passing preflight. The trailing $ is what makes these an allowlist.
CORS = options.CorsOptions(
    cors_origins=[
        r"^https://[a-z0-9-]+\.web\.app$",
        r"^https://[a-z0-9-]+\.firebaseapp\.com$",
        r"^http://localhost:\d+$",
        r"^http://127\.0\.0\.1:\d+$",
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


def _json(payload: dict, status: int = 200) -> https_fn.Response:
    """
    Serialise explicitly.

    https_fn.Response is a Flask Response, and Flask only special-cases
    str/bytes — every other object is treated as an ITERABLE OF BODY CHUNKS.
    Handing it a dict therefore iterates the dict, i.e. its KEYS, and ships them
    concatenated: {"error": "boom"} goes out as the five bytes b"error", under a
    Content-Type of application/json. A successful preview went out as
    b"school_idschool_namesite_id…". The client's JSON.parse then fails on a 200
    and the UI renders an empty plan or a nonsense error string.
    """
    return https_fn.Response(
        json.dumps(payload, default=str), status=status, mimetype="application/json"
    )


def _json_error(message: str, status: int) -> https_fn.Response:
    return _json({"error": message}, status)


def _preflight(req: https_fn.Request) -> https_fn.Response | None:
    """
    Answer the CORS preflight before any auth runs.

    The decorator normally handles OPTIONS itself, but a preflight that reached
    _require_ops_admin would come back 401 — and a 401 preflight fails the
    browser's check exactly as a 403 does. Cheap insurance.
    """
    if req.method == "OPTIONS":
        return https_fn.Response("", status=204)
    return None


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


def _parse_ts(value) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def latest_run(site_id: str, dispatched_at=None) -> dict:
    """
    The deploy-school run for THIS site, from THIS provisioning run.

    Two ways this reported the wrong build, both of which flip a school to
    "live" off the back of some other school's green tick:

      * `display_title` is the head COMMIT MESSAGE unless the workflow sets
        `run-name`, so it never contained the site id and the match never hit.
        Control fell through to "newest run of this workflow, whichever school".
        deploy-school.yml now sets run-name to carry the school and site ids, and
        the blanket fallback is gone — no match now means no build reported,
        which the UI renders honestly as "not started yet".
      * A PREVIOUS, already-successful run for the same site still matches. Runs
        created before this provisioning run are therefore filtered out;
        without that, re-publishing a live school reports "live" immediately
        while the new build is still queued.
    """
    token = os.environ.get("GITHUB_DISPATCH_PAT", "")
    if not token or not site_id:
        return {}
    resp = requests.get(
        f"https://api.github.com/repos/{GITHUB_OWNER}/{GITHUB_REPO}"
        f"/actions/workflows/{GITHUB_WORKFLOW}/runs",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
        },
        params={"per_page": 30},
        timeout=30,
    )
    if not resp.ok:
        return {}

    # A minute of slack: the run row appears a moment after the dispatch call
    # returns, and GitHub's clock is not this function's clock.
    floor = _parse_ts(dispatched_at)
    if floor:
        floor -= timedelta(minutes=1)

    # Bounded rather than a plain substring: site ids nest, so "hillgreen-high"
    # occurs inside "hillgreen-high-2" and would match that school's build.
    pattern = re.compile(rf"(?<![a-z0-9-]){re.escape(site_id)}(?![a-z0-9-])")

    for run in resp.json().get("workflow_runs", []):
        haystack = f"{run.get('display_title') or ''} {run.get('name') or ''}"
        if not pattern.search(haystack):
            continue
        created = _parse_ts(run.get("created_at"))
        if floor and created and created < floor:
            continue
        return run
    return {}


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


def _dns_rows(records: list[Record]) -> list[dict]:
    """
    Records shaped for the Namecheap dashboard's Advanced DNS table.

    The key names match the column headings ops is typing into — Host, Type,
    Value, TTL — rather than Namecheap's API field names, because the audience
    for this list is a person with the dashboard open, not the API.
    """
    return [
        {"host": r.name, "type": r.type, "value": r.address, "ttl": r.ttl}
        for r in records
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
    early = _preflight(req)
    if early:
        return early
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

    try:
        session = _hosting_session()
        existing = session.get(
            f"{HOSTING_API}/projects/{PROJECT_ID}/sites/{plan['site_id']}", timeout=30
        )
        plan["site_exists"] = existing.status_code == 200
    except Exception as exc:  # noqa: BLE001
        # An uncaught exception here becomes a 500 with an HTML body, which the
        # client cannot parse and the browser may surface as yet another opaque
        # CORS failure. Report it as JSON the UI can actually display.
        return _json_error(f"Hosting API unreachable: {exc}", 502)

    # Only reach for Namecheap when ops has actually asked us to write the zone.
    # Otherwise the preview needs no Namecheap credentials, no whitelisted egress
    # IP and no VPC connector — the whole Namecheap prerequisite drops off the
    # critical path for the common case of "put the school online".
    if body.get("withDomain", True) and body.get("writeDns", False):
        try:
            client = NamecheapClient()
            preserve = load_preserve_records(db)
            # Nothing to add yet — Firebase only issues the challenge once the
            # customDomain exists — so this previews the zone and the guardrails
            # rather than the final record set.
            write = apply_records(client, BASE_DOMAIN, desired=[], preserve=preserve, dry_run=True)
            plan["dns"] = {
                "mode": "auto",
                "zone_record_count": len(write.before),
                "preserve_count": len(preserve),
                "warnings": write.warnings,
            }
        except NamecheapError as exc:
            plan["dns"] = {"mode": "auto", "error": str(exc)}
    elif body.get("withDomain", True):
        plan["dns"] = {"mode": "manual"}

    return _json(plan)


@https_fn.on_request(cors=CORS, region="asia-south1")
def hosting_provision(req: https_fn.Request) -> https_fn.Response:
    """
    Create the site, attach the domain, optionally write DNS, dispatch the build.

    THE DNS WRITE IS OPT-IN (`writeDns`, default off), and the two halves of
    "custom domain" are deliberately separate:

      * `withDomain` attaches the domain to the Hosting site through the Firebase
        API. This is what makes Hosting serve the domain and start the
        certificate, and it needs nothing but Firebase credentials.
      * `writeDns` additionally writes the records into Namecheap for you. That
        is the half that needs API credentials, a whitelisted static egress IP
        and a populated dns_preserve list, and it is the half that can damage a
        live zone.

    With writeDns off, the records Firebase wants are recorded on the run and
    returned to the UI to be entered in the Namecheap dashboard by hand. Nothing
    about the deploy waits on them: the site is live on its .web.app URL either
    way, and the custom domain starts serving whenever the records land.

    Each step is recorded to hosting_runs/{runId} as it completes, so a failure
    halfway leaves an accurate record of what exists. Re-running is the recovery
    path and is safe at every stage.
    """
    early = _preflight(req)
    if early:
        return early
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
    write_dns = with_domain and bool(body.get("writeDns", False))
    run_id = f"{plan['site_id']}__{uuid.uuid4().hex[:8]}"
    run_ref = db.collection("hosting_runs").document(run_id)
    run: dict = {
        **plan,
        "id": run_id,
        "status": "in_progress",
        "with_domain": with_domain,
        "write_dns": write_dns,
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
                domain_doc.get("requiredDnsUpdates", {}), plan["subdomain"], BASE_DOMAIN
            )

            if not write_dns:
                # Hand the records back instead of writing them. Hosting often
                # has not computed requiredDnsUpdates by the time the
                # customDomain is created, so this can legitimately be empty
                # here — hosting_status recomputes it on every poll and the UI
                # fills the table in when Firebase catches up.
                step("dns", ok=True, mode="manual", records=_dns_rows(desired))
                run_ref.set({"manual_dns": _dns_rows(desired)}, merge=True)
            else:
                client = NamecheapClient()
                preserve = load_preserve_records(db)

                # Guardrail 4: the pre-change zone is persisted BEFORE the write,
                # so a bad write is always recoverable by hand.
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
                    mode="auto",
                    added=[r.label() for r in write.added],
                    warnings=write.warnings,
                    snapshot=run_id,
                )

        dispatch_build(plan["school_id"], plan["site_id"])
        dispatched_at = _now()
        step("build_dispatched", ok=True)

        # latest_run() only considers builds created at or after this instant,
        # so the dispatch time has to survive on the run document.
        run_ref.set(
            {"status": "awaiting_build", "dispatched_at": dispatched_at, "updated_at": _now()},
            merge=True,
        )
        return _json({"runId": run_id, "status": "awaiting_build", **plan})

    except Exception as exc:  # noqa: BLE001
        # Deliberately broad. Anything escaping here becomes a 500 with an HTML
        # body that the client cannot parse and the browser may report as one
        # more opaque CORS failure — the exact confusion this feature already
        # cost a day to. Fail as JSON, and record it on the run.
        run_ref.set({"status": "failed", "error": str(exc), "updated_at": _now()}, merge=True)
        return _json_error(str(exc), 502)


@https_fn.on_request(cors=CORS, region="asia-south1")
def hosting_status(req: https_fn.Request) -> https_fn.Response:
    """Poll a run: cert state and build state. Safe to call on a loop."""
    early = _preflight(req)
    if early:
        return early
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

            # Recomputed on every poll rather than read back from the run.
            # Firebase usually has not worked out requiredDnsUpdates at the
            # moment the customDomain is created, so the list captured during
            # provisioning is often empty — and a permanently empty "records to
            # add" table is worse than no table at all. Refresh it here, where
            # we already hold a fresh domain_doc.
            if not run.get("write_dns"):
                rows = _dns_rows(
                    records_from_firebase_dns_updates(
                        domain_doc.get("requiredDnsUpdates", {}),
                        run.get("subdomain", ""),
                        BASE_DOMAIN,
                    )
                )
                out["manual_dns"] = rows or run.get("manual_dns", [])
                if rows and rows != run.get("manual_dns"):
                    db.collection("hosting_runs").document(run["id"]).set(
                        {"manual_dns": rows, "updated_at": _now()}, merge=True
                    )
        except Exception as exc:  # noqa: BLE001 — a cert lookup must never 500 the poll
            out["cert_state"] = f"error: {exc}"
            out["manual_dns"] = run.get("manual_dns", [])

    gh = latest_run(run.get("site_id", ""), run.get("dispatched_at") or run.get("created_at"))
    if gh:
        conclusion = gh.get("conclusion")
        out["build"] = {
            "status": gh.get("status"),
            "conclusion": conclusion,
            "url": gh.get("html_url"),
        }
        # A finished build is terminal in both directions. Only "success" used to
        # be recorded, so a red build left the run stuck on "awaiting_build" and
        # the UI polled "Building" forever with nothing to click but the log.
        if run.get("status") == "awaiting_build" and gh.get("status") == "completed":
            if conclusion == "success":
                out["status"] = "live"
            else:
                out["status"] = "failed"
                out["error"] = f"Build {conclusion or 'did not succeed'} — see the build log."
            db.collection("hosting_runs").document(run["id"]).set(
                {
                    "status": out["status"],
                    "build_conclusion": conclusion,
                    "build_url": gh.get("html_url"),
                    "updated_at": _now(),
                },
                merge=True,
            )

    return _json(out)
