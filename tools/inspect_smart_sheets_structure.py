"""
Read-only structure dump for the four "Smart Sheets" collections this repo
has incomplete or zero visibility into today:
  - smart_sheet_entries (academics: has subjectId; co-scholastic: type == "co-scholastic")
  - attendance_sheets
  - remarks_sheets
(plus a quick look at `classes`, since every sheet type keys off classId).

Prints real field shapes and counts, NOT a full data export — a handful of
representative docs per bucket, one entries/ doc sample each, and totals.
Meant to be pasted back so the actual field names/types can be confirmed
before building against them, the same way earlier features here were
verified against real Firestore data before writing code.

Run in Cloud Shell (uses Application Default Credentials — no service
account file needed there):

    pip install --quiet google-cloud-firestore
    python3 tools/inspect_smart_sheets_structure.py Hillgreen_Highschool
    python3 tools/inspect_smart_sheets_structure.py Hillgreen_Highschool --project clarified-1501

Or anywhere else with `gcloud auth application-default login` already run.
"""

import argparse
import json
from collections import Counter, defaultdict

from google.cloud import firestore


def jsonable(value):
    """Firestore timestamps/refs aren't JSON-serializable as-is."""
    if hasattr(value, "isoformat"):
        return value.isoformat()
    if hasattr(value, "path"):
        return f"<ref:{value.path}>"
    if isinstance(value, dict):
        return {k: jsonable(v) for k, v in value.items()}
    if isinstance(value, list):
        return [jsonable(v) for v in value]
    return value


def dump(label, data):
    print(f"\n--- {label} ---")
    print(json.dumps(jsonable(data), indent=2, ensure_ascii=False, default=str))


def sample_entries(doc_ref, n=2):
    """Up to n docs from doc_ref's `entries` subcollection, id + fields."""
    out = []
    for d in doc_ref.collection("entries").limit(n).stream():
        out.append({"id": d.id, **d.to_dict()})
    return out


def inspect_classes(school_ref):
    docs = list(school_ref.collection("classes").stream())
    print(f"\n=== classes ({len(docs)} total) ===")
    stage_counts = Counter((d.to_dict() or {}).get("stage") for d in docs)
    print("stage value counts:", dict(stage_counts))
    if docs:
        dump("sample class doc", {"id": docs[0].id, **docs[0].to_dict()})
    return [d.id for d in docs]


def inspect_smart_sheet_entries(school_ref):
    docs = list(school_ref.collection("smart_sheet_entries").stream())
    print(f"\n=== smart_sheet_entries ({len(docs)} total) ===")

    academic, co_scholastic, other = [], [], []
    for d in docs:
        data = d.to_dict() or {}
        t = str(data.get("type") or "").strip().lower()
        if t == "co-scholastic":
            co_scholastic.append((d, data))
        elif data.get("subjectId"):
            academic.append((d, data))
        else:
            other.append((d, data))

    print(f"academic (has subjectId): {len(academic)}")
    print(f"co-scholastic (type == 'co-scholastic'): {len(co_scholastic)}")
    print(f"other/unclassified: {len(other)}")

    if academic:
        d, data = academic[0]
        dump("sample ACADEMIC smart_sheet_entries doc", {"id": d.id, **data})
        dump("  -> sample entries/ doc(s)", sample_entries(d.reference))
    if co_scholastic:
        d, data = co_scholastic[0]
        dump("sample CO-SCHOLASTIC smart_sheet_entries doc", {"id": d.id, **data})
        dump("  -> sample entries/ doc(s)", sample_entries(d.reference))
    if other:
        d, data = other[0]
        dump("sample OTHER/UNCLASSIFIED smart_sheet_entries doc", {"id": d.id, **data})
        dump("  -> sample entries/ doc(s)", sample_entries(d.reference))

    # Per-class counts, split by kind — the raw material an overview would sum.
    by_class = defaultdict(lambda: {"academic": 0, "co_scholastic": 0, "other": 0})
    for d, data in academic:
        by_class[data.get("classId", "?")]["academic"] += 1
    for d, data in co_scholastic:
        by_class[data.get("classId", "?")]["co_scholastic"] += 1
    for d, data in other:
        by_class[data.get("classId", "?")]["other"] += 1
    dump("sheet counts per class (not entry counts, SHEET counts)", dict(by_class))


def inspect_attendance_sheets(school_ref):
    docs = list(school_ref.collection("attendance_sheets").stream())
    print(f"\n=== attendance_sheets ({len(docs)} total) ===")
    if not docs:
        print("(none found for this school)")
        return
    d = docs[0]
    data = d.to_dict() or {}
    dump("sample attendance_sheets doc", {"id": d.id, **data})
    dump("  -> sample entries/ doc(s)", sample_entries(d.reference))

    by_class = Counter((doc.to_dict() or {}).get("classId", "?") for doc in docs)
    dump("sheet counts per class", dict(by_class))
    by_month = Counter((doc.to_dict() or {}).get("month", "?") for doc in docs)
    dump("sheet counts per month value", dict(by_month))


def inspect_remarks_sheets(school_ref):
    docs = list(school_ref.collection("remarks_sheets").stream())
    print(f"\n=== remarks_sheets ({len(docs)} total) ===")
    if not docs:
        print("(none found for this school)")
        return
    d = docs[0]
    data = d.to_dict() or {}
    dump("sample remarks_sheets doc", {"id": d.id, **data})
    dump("  -> sample entries/ doc(s)", sample_entries(d.reference))

    by_class = Counter((doc.to_dict() or {}).get("classId", "?") for doc in docs)
    dump("sheet counts per class", dict(by_class))

    # Entry counts per sheet — the number that actually answers "how many
    # entries have been made" for this type.
    counts = {}
    for doc in docs:
        counts[doc.id] = sum(1 for _ in doc.reference.collection("entries").stream())
    dump("entry COUNT per sheet (this is the expensive read — one per sheet)", counts)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("school_id", help='Firestore school doc id, e.g. "Hillgreen_Highschool"')
    ap.add_argument("--project", default="clarified-1501")
    args = ap.parse_args()

    db = firestore.Client(project=args.project)
    school_ref = db.collection("schools").document(args.school_id)
    if not school_ref.get().exists:
        raise SystemExit(f"No such school doc: schools/{args.school_id}")

    inspect_classes(school_ref)
    inspect_smart_sheet_entries(school_ref)
    inspect_attendance_sheets(school_ref)
    inspect_remarks_sheets(school_ref)

    print("\nDone. Paste this whole output back for review.")


if __name__ == "__main__":
    main()
