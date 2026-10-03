"""
Which Hosting site belongs to which school — the pure half of hosting_sites.

Nothing records this in one place. Sites provisioned from School Setup →
Publish leave a `hosting_runs` doc; sites set up before that exist only in the
teacher repo's schools.json + .firebaserc (READ-ONLY to us, see main.py). So a
site's school is resolved, first match wins, from:

  1. hosting_sites/{siteId}.school_id  — set by ops on the School Websites page,
                                         or by hosting_provision. An empty
                                         string means "deliberately no school"
                                         (a test or retired site).
  2. the newest hosting_runs doc for the site
  3. LEGACY_SITES below

Kept free of Firestore and HTTP so it can be tested without credentials.
"""
from __future__ import annotations

# Copied from scratchpad_teacher's schools.json (hostingTarget → schoolId) as of
# commit f534df7, minus the test sites (teachers-testapp, testapp-central), the
# placeholder (symbiosisPrabhat → TODO_CONFIRM_SCHOOL_ID), and the two
# "SAMARTH DNYANPEETH SAHAYDRI" entries whose site is unconfirmed. Anything
# wrong or missing here is fixed from the School Websites page, which writes
# rule 1 and so overrides this.
LEGACY_SITES = {
    "hillgreenhighschool": "Hillgreen_Highschool",
    "keystoneankuram": "THE_KEYSTONE_ANKURAM_SCHOOL",
    "samarthaschoolhyd": "samarthaschool",
    "ninspune": "New India National School",
    "sangamschool": "SANGAM SCHOOL OF EXCELLENCE",
    "shardakalamb": "shardakalamb",
    "shardakaij": "shardakaij",
    "shardadharur": "shardadharur",
}

# Firebase's own hostnames — every site has them; they are not "a domain the
# school was given".
_DEFAULT_SUFFIXES = (".web.app", ".firebaseapp.com")


def site_id_from_name(name: str) -> str:
    """'projects/p/sites/abc' -> 'abc'."""
    return (name or "").rstrip("/").rsplit("/", 1)[-1]


def custom_domains(custom: list[dict], legacy: list[dict]) -> list[dict]:
    """Merge the two Hosting domain APIs into [{domain, live, state}].

    customDomains is the current API; sites/{id}/domains is the older one,
    which still holds domains connected through the console before it. The
    same domain can appear in both — the customDomains entry wins.
    """
    out: dict[str, dict] = {}
    for d in custom or []:
        domain = site_id_from_name(d.get("name", ""))
        if not domain or domain.endswith(_DEFAULT_SUFFIXES):
            continue
        state = d.get("hostState") or "HOST_STATE_UNSPECIFIED"
        out[domain] = {"domain": domain, "live": state == "HOST_ACTIVE", "state": state}
    for d in legacy or []:
        domain = (d.get("domainName") or "").strip().lower()
        if not domain or domain in out or domain.endswith(_DEFAULT_SUFFIXES):
            continue
        state = d.get("status") or "DOMAIN_STATUS_UNSPECIFIED"
        out[domain] = {"domain": domain, "live": state == "DOMAIN_ACTIVE", "state": state}
    # Live first, then alphabetical — the first entry is the one to show.
    return sorted(out.values(), key=lambda d: (not d["live"], d["domain"]))


def resolve_school(site_id: str, assigned: dict, runs: dict) -> tuple[str, str]:
    """(school_id, source) for one site; ("", "") when nothing claims it.

    assigned: {siteId: school_id} from hosting_sites (may hold "")
    runs:     {siteId: school_id} from the newest hosting_runs per site
    """
    if site_id in assigned:
        return assigned[site_id] or "", "assigned"
    if runs.get(site_id):
        return runs[site_id], "provisioned"
    if LEGACY_SITES.get(site_id):
        return LEGACY_SITES[site_id], "legacy"
    return "", ""


def newest_run_per_site(runs: list[dict]) -> dict:
    """{siteId: school_id} from hosting_runs docs, newest created_at winning."""
    best: dict[str, tuple[str, str]] = {}
    for r in runs:
        site, school = r.get("site_id"), r.get("school_id")
        if not site or not school:
            continue
        created = str(r.get("created_at") or "")
        if site not in best or created > best[site][0]:
            best[site] = (created, school)
    return {site: school for site, (_, school) in best.items()}
