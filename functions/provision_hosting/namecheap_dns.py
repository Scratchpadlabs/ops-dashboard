#!/usr/bin/env python3
"""
Namecheap DNS — additive record writes that cannot silently eat the zone.

THE HAZARD, stated plainly, because everything in this module is shaped by it:

Namecheap has no "add one record" endpoint. `domains.dns.setHosts` REPLACES
the entire host-record set for a domain. Whatever you do not send, you delete.
Worse, `domains.dns.getHosts` does NOT return records managed by Namecheap
subsystems — Email Forwarding (MX), and URL Redirect records are invisible to
the API. So the obvious read-modify-write loop still destroys mail routing for
the domain, and does it silently, with a 200 OK.

myhpc.in is a live domain. Losing its MX records to a school-provisioning
button would be a genuinely bad afternoon.

The guardrails here, in the order they fire:

  1. PRESERVE LIST. `hosting_config/dns_preserve` in Firestore holds records ops
     declares must always exist (MX, SPF, DKIM, anything the API cannot see).
     Every write re-asserts them. This is the only defence against the invisible
     records, and it is only as good as the list — see assert_preserve_configured.
  2. NON-EMPTY READ. A getHosts returning zero records is treated as an API
     failure, never as "the zone is empty". An empty zone plus a blind write is
     exactly how you delete everything.
  3. ADD-ONLY DIFF. The merged set is checked against the read set; if any
     existing record would disappear, the write is refused. This module can only
     ever grow a zone.
  4. SNAPSHOT. The pre-change zone is handed back to the caller for persisting
     before any write goes out, so a bad write is recoverable by hand.
  5. VERIFY. After the write, re-read and confirm every intended record landed
     and every prior record survived. A failed verify is reported loudly — the
     caller surfaces it rather than reporting success.

Credentials and the static-IP requirement are documented in README.md.
"""
from __future__ import annotations

import os
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from typing import Iterable

import requests

NC_NS = "{http://api.namecheap.com/xml.response}"
DEFAULT_TTL = "1799"
TIMEOUT = 30


class NamecheapError(RuntimeError):
    """Any refusal or API failure. The message is shown to ops verbatim."""


@dataclass(frozen=True)
class Record:
    """One host record. `name` is the subdomain label, '@' for the apex."""

    name: str
    type: str
    address: str
    ttl: str = DEFAULT_TTL
    mx_pref: str = "10"

    def key(self) -> tuple[str, str, str]:
        # Identity for diffing. Address is part of it: two A records on the same
        # name are a legitimate, common configuration (Firebase gives you two),
        # so name+type alone would treat the second as a replacement.
        return (self.name.lower(), self.type.upper(), self.address.lower())

    def label(self) -> str:
        return f"{self.name} {self.type} {self.address}"


@dataclass
class ZoneWrite:
    """Outcome of a write, for the run log and the UI."""

    before: list[Record]
    after: list[Record]
    added: list[Record]
    verified: bool = False
    warnings: list[str] = field(default_factory=list)


def _split_domain(domain: str) -> tuple[str, str]:
    """'myhpc.in' -> ('myhpc', 'in'). Multi-label TLDs (co.uk) are not used here."""
    parts = domain.strip(".").split(".")
    if len(parts) < 2:
        raise NamecheapError(f"Not a registrable domain: {domain!r}")
    return ".".join(parts[:-1]), parts[-1]


class NamecheapClient:
    """
    Thin Namecheap API client. Credentials come from Secret Manager via env.

    `client_ip` must be an IP whitelisted in the Namecheap account AND the IP the
    request actually egresses from — Namecheap checks both. In Cloud Functions
    that means a static egress IP (VPC connector + Cloud NAT); see README.md.
    """

    def __init__(
        self,
        api_user: str | None = None,
        api_key: str | None = None,
        username: str | None = None,
        client_ip: str | None = None,
        endpoint: str | None = None,
    ):
        self.api_user = api_user or os.environ.get("NAMECHEAP_API_USER", "")
        self.api_key = api_key or os.environ.get("NAMECHEAP_API_KEY", "")
        self.username = username or os.environ.get("NAMECHEAP_USERNAME", self.api_user)
        self.client_ip = client_ip or os.environ.get("NAMECHEAP_CLIENT_IP", "")
        # Point at api.sandbox.namecheap.com to rehearse. The sandbox is a
        # separate account with separate credentials and its own whitelist.
        self.endpoint = endpoint or os.environ.get(
            "NAMECHEAP_ENDPOINT", "https://api.namecheap.com/xml.response"
        )
        missing = [
            n
            for n, v in (
                ("NAMECHEAP_API_USER", self.api_user),
                ("NAMECHEAP_API_KEY", self.api_key),
                ("NAMECHEAP_CLIENT_IP", self.client_ip),
            )
            if not v
        ]
        if missing:
            raise NamecheapError(f"Namecheap credentials not configured: {', '.join(missing)}")

    def _call(self, command: str, extra: dict[str, str]) -> ET.Element:
        params = {
            "ApiUser": self.api_user,
            "ApiKey": self.api_key,
            "UserName": self.username,
            "ClientIp": self.client_ip,
            "Command": command,
            **extra,
        }
        try:
            resp = requests.post(self.endpoint, data=params, timeout=TIMEOUT)
        except requests.RequestException as exc:
            raise NamecheapError(f"Namecheap {command} request failed: {exc}") from exc
        if resp.status_code != 200:
            raise NamecheapError(f"Namecheap {command} HTTP {resp.status_code}: {resp.text[:400]}")

        try:
            root = ET.fromstring(resp.text)
        except ET.ParseError as exc:
            raise NamecheapError(f"Namecheap {command} returned unparseable XML: {exc}") from exc

        if root.get("Status", "").upper() != "OK":
            errors = [
                (e.text or "").strip() for e in root.iter(f"{NC_NS}Error") if (e.text or "").strip()
            ]
            detail = "; ".join(errors) or resp.text[:400]
            # The single most common cause, called out because the raw message
            # ("Invalid request IP") sends people looking in the wrong place.
            if any("ip" in e.lower() for e in errors):
                detail += (
                    " — check that NAMECHEAP_CLIENT_IP matches the function's static "
                    "egress IP and that the IP is whitelisted in the Namecheap account."
                )
            raise NamecheapError(f"Namecheap {command} failed: {detail}")
        return root

    def get_hosts(self, domain: str) -> list[Record]:
        sld, tld = _split_domain(domain)
        root = self._call("namecheap.domains.dns.getHosts", {"SLD": sld, "TLD": tld})
        records = [
            Record(
                name=h.get("Name", ""),
                type=h.get("Type", ""),
                address=h.get("Address", ""),
                ttl=h.get("TTL") or DEFAULT_TTL,
                mx_pref=h.get("MXPref") or "10",
            )
            for h in root.iter(f"{NC_NS}host")
        ]
        # Guardrail 2. An account with a real domain always has records; zero
        # means the API lied to us, and acting on that reading deletes the zone.
        if not records:
            raise NamecheapError(
                f"getHosts returned no records for {domain}. Refusing to continue — "
                "treating this as an API failure, not an empty zone."
            )
        return records

    def set_hosts(self, domain: str, records: list[Record]) -> None:
        sld, tld = _split_domain(domain)
        payload: dict[str, str] = {"SLD": sld, "TLD": tld}
        for i, rec in enumerate(records, start=1):
            payload[f"HostName{i}"] = rec.name
            payload[f"RecordType{i}"] = rec.type
            payload[f"Address{i}"] = rec.address
            payload[f"TTL{i}"] = rec.ttl
            if rec.type.upper() == "MX":
                payload[f"MXPref{i}"] = rec.mx_pref
        self._call("namecheap.domains.dns.setHosts", payload)


def merge_records(existing: Iterable[Record], to_add: Iterable[Record]) -> tuple[list[Record], list[Record]]:
    """
    Union of existing and desired records. Returns (merged, actually_added).

    Deduplicated on Record.key(), so re-running provisioning for a school that
    is already configured is a no-op rather than a duplicate-record pile-up.
    """
    merged = list(existing)
    seen = {r.key() for r in merged}
    added: list[Record] = []
    for rec in to_add:
        if rec.key() in seen:
            continue
        merged.append(rec)
        seen.add(rec.key())
        added.append(rec)
    return merged, added


def assert_preserve_configured(preserve: list[Record], existing: list[Record]) -> list[str]:
    """
    Guardrail 1, checked rather than assumed.

    Returns warnings — it does not raise. A preserve list that has drifted from
    reality is a reason to tell ops loudly, not a reason to block a deploy: the
    write is add-only either way. But an EMPTY preserve list on a domain that
    handles mail is worth shouting about, because the invisible-record hazard is
    exactly the case the list exists to cover.
    """
    warnings: list[str] = []
    if not preserve:
        warnings.append(
            "No dns_preserve records are configured. Namecheap's API cannot see "
            "Email Forwarding (MX) or URL Redirect records, so this write cannot "
            "protect them. Add them to hosting_config/dns_preserve before "
            "provisioning against a domain that handles mail."
        )
        return warnings

    have = {r.key() for r in existing}
    for rec in preserve:
        if rec.key() not in have:
            warnings.append(
                f"Preserved record {rec.label()} is not currently in the zone — "
                "it will be (re-)created by this write."
            )
    return warnings


def apply_records(
    client: NamecheapClient,
    domain: str,
    desired: list[Record],
    preserve: list[Record] | None = None,
    dry_run: bool = False,
) -> ZoneWrite:
    """
    Add `desired` (and re-assert `preserve`) to the zone, additively.

    Raises NamecheapError rather than performing any write it cannot prove is
    non-destructive. On dry_run, everything up to the write is executed and the
    planned result returned — the preview ops sees is the real diff.
    """
    preserve = preserve or []
    before = client.get_hosts(domain)
    warnings = assert_preserve_configured(preserve, before)

    merged, added = merge_records(before, [*preserve, *desired])

    # Guardrail 3. Nothing this module does may remove a record. If the diff
    # says otherwise, the merge is wrong and the zone is not the place to find
    # out.
    before_keys = {r.key() for r in before}
    after_keys = {r.key() for r in merged}
    dropped = before_keys - after_keys
    if dropped:
        raise NamecheapError(
            "Refusing to write: the merged record set would remove "
            f"{len(dropped)} existing record(s). This is a bug in the merge, "
            "not a condition to override."
        )

    if not added:
        # Already provisioned. Report it as a clean no-op.
        return ZoneWrite(before=before, after=before, added=[], verified=True, warnings=warnings)

    if dry_run:
        return ZoneWrite(before=before, after=merged, added=added, verified=False, warnings=warnings)

    client.set_hosts(domain, merged)

    # Guardrail 5. Trust the read-back, not the 200.
    after = client.get_hosts(domain)
    after_keys = {r.key() for r in after}
    missing_new = [r for r in added if r.key() not in after_keys]
    lost_old = [r for r in before if r.key() not in after_keys]
    verified = not missing_new and not lost_old
    if missing_new:
        warnings.append(
            "Records that did not appear after the write: "
            + ", ".join(r.label() for r in missing_new)
        )
    if lost_old:
        warnings.append(
            "PRE-EXISTING RECORDS DISAPPEARED — restore them from the snapshot: "
            + ", ".join(r.label() for r in lost_old)
        )
    return ZoneWrite(before=before, after=after, added=added, verified=verified, warnings=warnings)


def label_for(fqdn: str, base_domain: str, fallback: str) -> str:
    """
    Namecheap host label for a fully-qualified name: 'x.myhpc.in' -> 'x'.

    Namecheap host records carry the LABEL, not the FQDN, and the apex is '@'.
    A name outside the zone is not ours to write, and returns ''.
    """
    fqdn = (fqdn or "").strip().rstrip(".").lower()
    base = (base_domain or "").strip().rstrip(".").lower()
    if not fqdn or not base:
        # Without a zone to measure against there is nothing to strip, and
        # returning '' would silently discard every record. Defer to the caller.
        return fallback
    if fqdn == base:
        return "@"
    if fqdn.endswith(f".{base}"):
        return fqdn[: -(len(base) + 1)]
    return ""


def records_from_firebase_dns_updates(
    dns_updates: dict, host_label: str, base_domain: str = ""
) -> list[Record]:
    """
    Translate Firebase Hosting's `requiredDnsUpdates` into Namecheap records.

    Firebase returns the records it wants under desired/discovered sets; we only
    ever act on what it asks us to ADD. Record data is taken from the API
    response rather than hardcoded, because Hosting's serving IPs and the TXT
    challenge are not ours to guess.

    TWO THINGS THIS GETS RIGHT, both of which silently break certificate issue:

      * THE LABEL COMES FROM THE RECORD, not from the school. Every record used
        to be written at `host_label`, on the assumption that Hosting only ever
        asks for A records at the subdomain being provisioned. It does not — the
        ownership challenge is a TXT at a name Hosting chooses, which is not
        always the same label. Pinning them all to `host_label` files the
        challenge under the wrong name, so it is never found, and the domain sits
        in PENDING until it expires. `host_label` remains the fallback for a
        record that names nothing.
      * A record marked `requiredAction: REMOVE` is one Hosting wants GONE. This
        module is add-only by design, so adding it would be precisely backwards
        and would leave a stale record contradicting the live one. Those are
        dropped here rather than merged; removals stay a human decision.
    """
    out: list[Record] = []
    desired = (dns_updates or {}).get("desired", []) or []
    for entry in desired:
        entry_name = entry.get("domainName") or ""
        for rec in entry.get("records", []) or []:
            rtype = (rec.get("type") or "").upper()
            rdata = rec.get("rdata") or ""
            if not rtype or not rdata:
                continue
            if (rec.get("requiredAction") or "").upper() == "REMOVE":
                continue
            name = label_for(rec.get("domainName") or entry_name, base_domain, host_label)
            if not name:
                # Outside the zone we manage. Writing it would be a no-op at
                # best and a wrong record at worst.
                continue
            out.append(Record(name=name, type=rtype, address=rdata))
    return out
