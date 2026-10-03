"""site_registry.py decides which school a website is shown against — a wrong
match sends someone to another school's app, so the precedence is tested."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from site_registry import (  # noqa: E402
    LEGACY_SITES, custom_domains, newest_run_per_site, resolve_school, site_id_from_name,
)


def test_site_id_from_name():
    assert site_id_from_name("projects/clarified-1501/sites/samarthaschoolhyd") == "samarthaschoolhyd"
    assert site_id_from_name("") == ""


def test_assignment_beats_run_beats_legacy():
    site = "samarthaschoolhyd"
    assert resolve_school(site, {}, {}) == (LEGACY_SITES[site], "legacy")
    assert resolve_school(site, {}, {site: "other"}) == ("other", "provisioned")
    assert resolve_school(site, {site: "picked"}, {site: "other"}) == ("picked", "assigned")


def test_explicit_blank_assignment_means_no_school():
    # A test site cleared on the page must not fall back to the legacy map.
    assert resolve_school("samarthaschoolhyd", {"samarthaschoolhyd": ""}, {}) == ("", "assigned")


def test_unknown_site_is_unmatched():
    assert resolve_school("brand-new-site", {}, {}) == ("", "")


def test_newest_run_wins():
    runs = [
        {"site_id": "abc-school", "school_id": "old", "created_at": "2026-01-01T00:00:00+00:00"},
        {"site_id": "abc-school", "school_id": "new", "created_at": "2026-06-01T00:00:00+00:00"},
        {"site_id": "abc-school", "school_id": "", "created_at": "2026-09-01T00:00:00+00:00"},
        {"site_id": None, "school_id": "x"},
    ]
    assert newest_run_per_site(runs) == {"abc-school": "new"}


def test_domains_merge_and_order():
    custom = [
        {"name": "projects/p/sites/s/customDomains/b.myhpc.in", "hostState": "HOST_UNHOSTED"},
        {"name": "projects/p/sites/s/customDomains/a.myhpc.in", "hostState": "HOST_ACTIVE"},
    ]
    legacy = [
        {"domainName": "a.myhpc.in", "status": "DOMAIN_VERIFICATION_REQUIRED"},  # dup: custom wins
        {"domainName": "old.school.in", "status": "DOMAIN_ACTIVE"},
        {"domainName": "s.web.app", "status": "DOMAIN_ACTIVE"},                 # Firebase default
        {"domainName": "s.firebaseapp.com", "status": "DOMAIN_ACTIVE"},
    ]
    assert custom_domains(custom, legacy) == [
        {"domain": "a.myhpc.in", "live": True, "state": "HOST_ACTIVE"},
        {"domain": "old.school.in", "live": True, "state": "DOMAIN_ACTIVE"},
        {"domain": "b.myhpc.in", "live": False, "state": "HOST_UNHOSTED"},
    ]
