#!/usr/bin/env python3
"""
Contract tests for the pure translation layer in namecheap_dns.py.

Everything here runs without credentials and without touching the network —
these are the functions that decide WHAT gets written to a live zone, so they
are the ones worth pinning down. The guardrails around the write itself
(add-only diff, non-empty read, verify) are exercised through a fake client
rather than a real Namecheap account.

Run with: python3 -m pytest functions/provision_hosting/tests/ -v
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest

from namecheap_dns import (
    NamecheapError,
    Record,
    apply_records,
    label_for,
    merge_records,
    records_from_firebase_dns_updates,
)

BASE = "myhpc.in"


# ── label_for ────────────────────────────────────────────────────────────────

@pytest.mark.parametrize(
    "fqdn,expected",
    [
        ("hillgreen-highschool.myhpc.in", "hillgreen-highschool"),
        ("HILLGREEN-HIGHSCHOOL.MyHPC.IN", "hillgreen-highschool"),
        ("hillgreen-highschool.myhpc.in.", "hillgreen-highschool"),
        ("myhpc.in", "@"),
        ("_acme-challenge.hillgreen-highschool.myhpc.in", "_acme-challenge.hillgreen-highschool"),
    ],
)
def test_label_for_strips_the_zone(fqdn, expected):
    assert label_for(fqdn, BASE, "fallback") == expected


def test_label_for_refuses_names_outside_the_zone():
    # Not ours to write. Empty string is the caller's signal to skip.
    assert label_for("example.com", BASE, "fallback") == ""
    assert label_for("myhpc.in.evil.example", BASE, "fallback") == ""


def test_label_for_falls_back_when_the_record_names_nothing():
    assert label_for("", BASE, "hillgreen-highschool") == "hillgreen-highschool"


def test_label_for_falls_back_when_no_zone_is_given():
    # Without a base domain there is nothing to strip; returning '' here would
    # silently discard every record the caller passed.
    assert label_for("hillgreen-highschool.myhpc.in", "", "fallback") == "fallback"


# ── records_from_firebase_dns_updates ────────────────────────────────────────

def test_a_records_land_on_the_school_label():
    updates = {
        "desired": [
            {
                "domainName": "hillgreen-highschool.myhpc.in",
                "records": [
                    {
                        "domainName": "hillgreen-highschool.myhpc.in",
                        "type": "A",
                        "rdata": "199.36.158.100",
                        "requiredAction": "ADD",
                    }
                ],
            }
        ]
    }
    out = records_from_firebase_dns_updates(updates, "hillgreen-highschool", BASE)
    assert [(r.name, r.type, r.address) for r in out] == [
        ("hillgreen-highschool", "A", "199.36.158.100")
    ]


def test_challenge_record_keeps_its_own_name():
    """
    The regression this exists for: every record used to be pinned to the
    school's label, so an ownership challenge Hosting placed at a different name
    was filed under the wrong one, never found, and the certificate never
    issued — with the domain sitting in PENDING and nothing in the UI to say so.
    """
    updates = {
        "desired": [
            {
                "domainName": "hillgreen-highschool.myhpc.in",
                "records": [
                    {
                        "domainName": "_acme-challenge.hillgreen-highschool.myhpc.in",
                        "type": "TXT",
                        "rdata": "hosting-site-verification=abc123",
                        "requiredAction": "ADD",
                    },
                    {
                        "domainName": "hillgreen-highschool.myhpc.in",
                        "type": "A",
                        "rdata": "199.36.158.100",
                        "requiredAction": "ADD",
                    },
                ],
            }
        ]
    }
    out = records_from_firebase_dns_updates(updates, "hillgreen-highschool", BASE)
    by_type = {r.type: r.name for r in out}
    assert by_type["TXT"] == "_acme-challenge.hillgreen-highschool"
    assert by_type["A"] == "hillgreen-highschool"


def test_remove_actions_are_never_added():
    """This module is add-only; adding a record Hosting wants GONE is backwards."""
    updates = {
        "desired": [
            {
                "domainName": "hillgreen-highschool.myhpc.in",
                "records": [
                    {"type": "A", "rdata": "1.2.3.4", "requiredAction": "REMOVE"},
                    {"type": "A", "rdata": "199.36.158.100", "requiredAction": "ADD"},
                ],
            }
        ]
    }
    out = records_from_firebase_dns_updates(updates, "hillgreen-highschool", BASE)
    assert [r.address for r in out] == ["199.36.158.100"]


def test_records_outside_the_managed_zone_are_skipped():
    updates = {
        "desired": [
            {
                "domainName": "somewhere.example.com",
                "records": [
                    {
                        "domainName": "somewhere.example.com",
                        "type": "A",
                        "rdata": "9.9.9.9",
                        "requiredAction": "ADD",
                    }
                ],
            }
        ]
    }
    assert records_from_firebase_dns_updates(updates, "hillgreen-highschool", BASE) == []


def test_empty_and_malformed_updates_are_survivable():
    for updates in ({}, None, {"desired": []}, {"desired": [{"records": []}]}):
        assert records_from_firebase_dns_updates(updates, "hillgreen-highschool", BASE) == []
    partial = {"desired": [{"records": [{"type": "", "rdata": ""}, {"type": "A"}]}]}
    assert records_from_firebase_dns_updates(partial, "hillgreen-highschool", BASE) == []


def test_records_falls_back_to_the_school_label_when_unnamed():
    updates = {"desired": [{"records": [{"type": "A", "rdata": "199.36.158.100"}]}]}
    out = records_from_firebase_dns_updates(updates, "hillgreen-highschool", BASE)
    assert out[0].name == "hillgreen-highschool"


# ── merge + guardrails ───────────────────────────────────────────────────────

def test_merge_is_deduplicated_so_re_running_is_a_no_op():
    existing = [Record("@", "A", "1.2.3.4"), Record("www", "CNAME", "example.com")]
    merged, added = merge_records(existing, [Record("@", "A", "1.2.3.4")])
    assert added == []
    assert len(merged) == 2


def test_merge_keeps_a_second_address_on_the_same_name():
    # Firebase hands out two A records for one host; name+type alone would treat
    # the second as a replacement for the first.
    existing = [Record("school", "A", "199.36.158.100")]
    merged, added = merge_records(existing, [Record("school", "A", "199.36.158.101")])
    assert len(added) == 1
    assert len(merged) == 2


class FakeClient:
    """Stands in for NamecheapClient. Records what a write would have sent."""

    def __init__(self, hosts):
        self.hosts = list(hosts)
        self.written = None

    def get_hosts(self, domain):
        if not self.hosts:
            raise NamecheapError("getHosts returned no records")
        return list(self.hosts)

    def set_hosts(self, domain, records):
        self.written = list(records)
        self.hosts = list(records)


def test_apply_records_reasserts_preserved_mx():
    """The invisible-record hazard: MX is not in getHosts, so it must be re-sent."""
    client = FakeClient([Record("@", "A", "1.2.3.4")])
    mx = Record("@", "MX", "mx1.example.net", mx_pref="10")
    write = apply_records(client, BASE, desired=[Record("school", "A", "9.9.9.9")], preserve=[mx])

    assert write.verified
    assert mx.key() in {r.key() for r in client.written}
    assert Record("@", "A", "1.2.3.4").key() in {r.key() for r in client.written}


def test_apply_records_warns_loudly_on_an_empty_preserve_list():
    client = FakeClient([Record("@", "A", "1.2.3.4")])
    write = apply_records(client, BASE, desired=[Record("school", "A", "9.9.9.9")], preserve=[])
    assert any("dns_preserve" in w for w in write.warnings)


def test_apply_records_dry_run_writes_nothing():
    client = FakeClient([Record("@", "A", "1.2.3.4")])
    write = apply_records(
        client, BASE, desired=[Record("school", "A", "9.9.9.9")], preserve=[], dry_run=True
    )
    assert client.written is None
    assert [r.label() for r in write.added] == ["school A 9.9.9.9"]


def test_apply_records_treats_an_empty_zone_as_an_api_failure():
    # Guardrail 2. An empty read plus a blind write is how you delete a zone.
    with pytest.raises(NamecheapError):
        apply_records(FakeClient([]), BASE, desired=[Record("school", "A", "9.9.9.9")])


def test_apply_records_is_a_clean_noop_when_already_provisioned():
    existing = [Record("@", "A", "1.2.3.4"), Record("school", "A", "9.9.9.9")]
    client = FakeClient(existing)
    write = apply_records(client, BASE, desired=[Record("school", "A", "9.9.9.9")], preserve=[])
    assert write.added == []
    assert write.verified
    assert client.written is None
