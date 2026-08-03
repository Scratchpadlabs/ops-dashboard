#!/usr/bin/env python3
"""Class field inventory + class health report across EVERY school.

READ-ONLY. This script opens no write path at all — it never constructs a
batch, a set(), an update() or a delete(). Run it against production without
ceremony.

It answers the two questions the class-resolution work depends on:

  INVENTORY (task item 2)  — per school, which class-related fields actually
                             exist on student documents, and sample values.
  HEALTH    (task item 16) — per school, how many students resolve confidently
                             under the shared resolver, how many are unmapped,
                             and whether a confirmed class_map exists.

USAGE (Cloud Shell, where you already have application-default credentials):

    cd ~/ops-dashboard
    pip install --quiet google-cloud-firestore
    python3 tools/class_inventory.py --project clarified-1501

    # one school, verbose:
    python3 tools/class_inventory.py --project clarified-1501 --school NAVODAYA

    # machine-readable, for pasting back:
    python3 tools/class_inventory.py --project clarified-1501 --json > inventory.json

Large estates: --limit caps students read per school (default: no cap).
"""

import argparse
import json
import os
import sys
from collections import Counter, defaultdict

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "functions", "shared"))

from class_resolver import (  # noqa: E402
    CLASS_ID_FIELDS, GRADE_FIELDS, SECTION_FIELDS, CONF_HIGH, CONF_MEDIUM,
    build_school_context, resolve_class, raw_class_value, distinct_class_values,
)

# Every field we want to know about, plus anything else that smells class-ish.
KNOWN_FIELDS = list(CLASS_ID_FIELDS) + list(GRADE_FIELDS) + list(SECTION_FIELDS)
SUSPECT_SUBSTRINGS = ("class", "grade", "std", "standard", "section", "sec",
                      "div", "batch", "stream")


AUTH_HELP = """
Could not authenticate to Firestore.

In Cloud Shell the metadata server sometimes returns a service account with no
'email' field, which the Firestore gRPC auth plugin requires. Fix it with an
explicit application-default login:

    gcloud auth application-default login
    gcloud auth application-default set-quota-project {project}

then re-run this script. (Without this the client retries for 300s before
surfacing the error, which looks like a hang.)
"""


def connect(project):
    try:
        from google.cloud import firestore
    except ImportError:
        sys.exit("Missing dependency. Run:  pip install google-cloud-firestore")

    client = firestore.Client(project=project)

    # Preflight: one tiny read with a short timeout. Without it a credentials
    # problem surfaces only after the default 300s retry budget, five minutes
    # into what looks like a working scan.
    try:
        next(iter(client.collection("schools").select([]).limit(1).stream(timeout=20)), None)
    except StopIteration:
        pass
    except Exception as e:                                       # noqa: BLE001
        text = str(e)
        if any(m in text for m in ("email", "credential", "UNAUTHENTICATED",
                                    "Getting metadata from plugin", "403")):
            sys.exit(AUTH_HELP.format(project=project))
        sys.exit(f"Could not reach Firestore for project {project!r}:\n  {text}")

    return client


def scan_school(db, school_id, limit=None):
    """Everything we need about one school. Reads students + classes only."""
    school_ref = db.collection("schools").document(school_id)

    students = []
    query = school_ref.collection("students")
    stream = query.limit(limit).stream() if limit else query.stream()
    for d in stream:
        doc = d.to_dict() or {}
        # Doc id AFTER the spread — a student carrying its own `id` field must
        # not shadow the real one.
        students.append({**doc, "id": d.id})

    class_ids = [c.id for c in school_ref.collection("classes").select([]).stream()]

    class_map = {}
    for c in school_ref.collection("class_map").stream():
        row = c.to_dict() or {}
        class_map[row.get("raw_value", c.id)] = row

    return students, class_ids, class_map


def field_inventory(students):
    """Which class-related fields exist, how often, and what they hold."""
    present = Counter()
    samples = defaultdict(list)
    extra_fields = Counter()

    for s in students:
        for key, value in s.items():
            if key == "id":
                continue
            lowered = key.lower()
            is_known = key in KNOWN_FIELDS
            is_suspect = any(sub in lowered for sub in SUSPECT_SUBSTRINGS)
            if not (is_known or is_suspect):
                continue
            if value in (None, "", [], {}):
                present[f"{key} (empty)"] += 1
                continue
            present[key] += 1
            if not is_known:
                extra_fields[key] += 1
            if len(samples[key]) < 20 and value not in samples[key]:
                samples[key].append(value)

    return present, samples, extra_fields


def health(students, class_ids, class_map):
    """How well this school resolves under the shared resolver."""
    ctx = build_school_context(class_ids, class_map=class_map)
    distinct = distinct_class_values(students)

    confident = unmapped = 0
    unmapped_values = Counter()
    for s in students:
        r = resolve_class(s, ctx)
        if r["confidence"] in (CONF_HIGH, CONF_MEDIUM) and r["grade_ordinal"] is not None:
            confident += 1
        else:
            unmapped += 1
            unmapped_values[r.get("label") or "(no class field)"] += 1

    confirmed = sum(1 for v in class_map.values() if v.get("source") == "confirmed")
    return {
        "students": len(students),
        "distinct_class_values": len(distinct),
        "resolve_confidently": confident,
        "unmapped": unmapped,
        "pct_resolved": round(confident / len(students) * 100, 1) if students else 0.0,
        "configured_classes": len(class_ids),
        "class_map_entries": len(class_map),
        "class_map_confirmed": confirmed,
        "has_confirmed_map": confirmed > 0,
        "notation": ctx["notation"],
        "top_unmapped": unmapped_values.most_common(10),
        "distinct_values": sorted(distinct.keys())[:60],
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--project", default=os.environ.get("GCLOUD_PROJECT", "clarified-1501"))
    ap.add_argument("--school", help="One school id (substring match). Default: all.")
    ap.add_argument("--limit", type=int, help="Max students read per school.")
    ap.add_argument("--json", action="store_true", help="Emit JSON only.")
    args = ap.parse_args()

    db = connect(args.project)

    school_ids = [d.id for d in db.collection("schools").select([]).stream()]
    if args.school:
        needle = args.school.lower()
        school_ids = [s for s in school_ids if needle in s.lower()]
    school_ids.sort()

    report = {}
    for sid in school_ids:
        try:
            students, class_ids, class_map = scan_school(db, sid, args.limit)
        except Exception as e:                                # noqa: BLE001
            report[sid] = {"error": str(e)}
            continue
        present, samples, extra = field_inventory(students)
        report[sid] = {
            "fields_present": dict(present.most_common()),
            "field_samples": {k: v for k, v in samples.items()},
            "unexpected_fields": dict(extra),
            "health": health(students, class_ids, class_map),
        }

    if args.json:
        print(json.dumps(report, indent=2, default=str))
        return

    _print_human(report)


def _print_human(report):
    print("=" * 78)
    print("CLASS FIELD INVENTORY")
    print("=" * 78)
    for sid, data in report.items():
        if "error" in data:
            print(f"\n{sid}\n  ERROR: {data['error']}")
            continue
        h = data["health"]
        print(f"\n{sid}   ({h['students']} students, {h['configured_classes']} classes, "
              f"notation={h['notation']})")
        for field, count in data["fields_present"].items():
            vals = data["field_samples"].get(field, [])
            shown = ", ".join(repr(v) for v in vals[:20])
            print(f"    {field:<20} {count:>6}   {shown[:150]}")
        if data["unexpected_fields"]:
            print(f"    ** fields not in the resolver's list: "
                  f"{', '.join(data['unexpected_fields'])}")

    print("\n" + "=" * 78)
    print("CLASS HEALTH  (item 16)")
    print("=" * 78)
    hdr = f"{'school':<34}{'stud':>6}{'distinct':>9}{'ok':>7}{'unmapped':>9}{'%':>7}  map"
    print(hdr)
    print("-" * 78)
    total_students = total_ok = total_unmapped = 0
    problem_schools = []
    for sid, data in report.items():
        if "error" in data:
            print(f"{sid[:33]:<34}{'ERROR':>6}")
            continue
        h = data["health"]
        total_students += h["students"]
        total_ok += h["resolve_confidently"]
        total_unmapped += h["unmapped"]
        flag = "confirmed" if h["has_confirmed_map"] else (
            f"auto({h['class_map_entries']})" if h["class_map_entries"] else "none")
        print(f"{sid[:33]:<34}{h['students']:>6}{h['distinct_class_values']:>9}"
              f"{h['resolve_confidently']:>7}{h['unmapped']:>9}{h['pct_resolved']:>6}%  {flag}")
        if h["unmapped"]:
            problem_schools.append((sid, h))

    print("-" * 78)
    pct = round(total_ok / total_students * 100, 1) if total_students else 0.0
    print(f"{'TOTAL':<34}{total_students:>6}{'':>9}{total_ok:>7}{total_unmapped:>9}{pct:>6}%")

    if problem_schools:
        print("\n" + "=" * 78)
        print("SCHOOLS NEEDING A CLASS MAP  (exactly what to confirm)")
        print("=" * 78)
        for sid, h in problem_schools:
            print(f"\n{sid}  — {h['unmapped']} unmapped of {h['students']}")
            for label, count in h["top_unmapped"]:
                print(f"    {count:>6}  {label}")
    else:
        print("\nEvery active school resolves cleanly.")


if __name__ == "__main__":
    main()
