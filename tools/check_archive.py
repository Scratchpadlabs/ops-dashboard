#!/usr/bin/env python3
"""Verify a pre-reset archive independently of the wizard. READ-ONLY.

The wizard's own verification runs inside archive_school. This is a second
opinion from outside that code path — useful when the UI and the server
disagree, or before trusting an archive taken in an earlier session.

    python3 tools/check_archive.py --project clarified-1501
    python3 tools/check_archive.py --project clarified-1501 --school "NAVODAYA CENTRAL SCHOOL"

For each archive it re-counts BOTH sides and reports:
  - the archive doc's own status / recorded counts
  - a live re-count of the archive subcollections
  - a live count of the source school, and the delta

NOTE: archives live in FIRESTORE (top-level `archives/`), not in GCS. There is
no bucket to check — a reset copies documents, not files.
"""

import argparse
import os
import sys

ARCHIVED_COLLECTIONS = ["students", "classes", "smart_sheet_entries", "survey_responses"]
SOURCE_COLLECTIONS = ["students", "classes", "smart_sheet_entries"]


def connect(project):
    try:
        from google.cloud import firestore
    except ImportError:
        sys.exit("Missing dependency. Run:  pip install google-cloud-firestore")
    client = firestore.Client(project=project)
    try:
        next(iter(client.collection("archives").select([]).limit(1).stream(timeout=20)), None)
    except Exception as e:                                       # noqa: BLE001
        if any(m in str(e) for m in ("email", "credential", "UNAUTHENTICATED", "metadata")):
            sys.exit("Auth failed. Run:\n  gcloud auth application-default login\n"
                     f"  gcloud auth application-default set-quota-project {project}")
        sys.exit(f"Could not reach Firestore: {e}")
    return client


def count(coll_ref):
    try:
        return int(coll_ref.count().get()[0][0].value)
    except Exception:                                            # noqa: BLE001
        return sum(1 for _ in coll_ref.select([]).stream())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--project", default=os.environ.get("GCLOUD_PROJECT", "clarified-1501"))
    ap.add_argument("--school", help="Filter archives by school id substring.")
    args = ap.parse_args()

    db = connect(args.project)

    archives = list(db.collection("archives").stream())
    if args.school:
        needle = args.school.lower()
        archives = [a for a in archives if needle in a.id.lower()]

    if not archives:
        print("No archives found."
              + (f" (filter: {args.school!r})" if args.school else ""))
        print("\nIf the wizard said an archive was created, it did not persist —"
              "\nre-run the Archive step before any reset.")
        return

    for doc in sorted(archives, key=lambda d: d.id):
        data = doc.to_dict() or {}
        school_id = data.get("school_id") or doc.id.split("__")[0]
        print("=" * 74)
        print(f"archives/{doc.id}")
        print(f"  school        : {school_id}")
        print(f"  label         : {data.get('label')}")
        print(f"  status        : {data.get('status')}")
        print(f"  created_by    : {data.get('created_by')}")
        print(f"  completed_at  : {data.get('completed_at')}")
        if data.get("mismatches"):
            print(f"  MISMATCHES    : {data['mismatches']}")

        print(f"  {'collection':<22}{'recorded':>10}{'in archive':>12}{'live now':>10}")
        src_ref = db.collection("schools").document(school_id)
        recorded = data.get("archived_counts") or {}
        complete = True
        for coll in ARCHIVED_COLLECTIONS:
            in_archive = count(doc.reference.collection(coll))
            live = count(src_ref.collection(coll)) if coll in SOURCE_COLLECTIONS else "-"
            rec = recorded.get(coll, "-")
            flag = ""
            if rec != "-" and rec != in_archive:
                flag = "  <-- archive doc disagrees with actual contents"
                complete = False
            if in_archive == 0 and coll == "students":
                flag = "  <-- EMPTY, archive is not usable"
                complete = False
            print(f"  {coll:<22}{str(rec):>10}{in_archive:>12}{str(live):>10}{flag}")

        verdict = "USABLE" if (complete and data.get("status") == "verified") else "NOT USABLE"
        print(f"  verdict       : {verdict}")
        if verdict != "USABLE":
            print("  A reset must not be run against this archive. Re-run the Archive step —"
                  "\n  re-archiving the same label overwrites the snapshot rather than adding one.")


if __name__ == "__main__":
    main()
