"""
Cloud Function: sheets_overview

A whole-school, per-class rollup across all four "Smart Sheets" areas —
academics, co-scholastic, attendance, remarks — answering "how many entries
have been made" for each. Read-only, no writes, no model calls.

Confirmed against real Firestore data (Hillgreen Highschool) before writing
any of this, via tools/inspect_smart_sheets_structure.py:

  - Academics: classes/{id}.subjects[].topics[] already carries an
    `isCompleted` flag per topic, set by the teacher app. That is a free
    signal — no entries subcollection reads needed for this one area, unlike
    the other three. It is coarser than an entry count (a topic is marked
    complete as a whole, not per student), and that asymmetry is left
    visible rather than papered over: academics reports topic completion,
    the other three report entry counts.
  - Co-scholastic: schools/{id}/smart_sheet_entries docs with
    `type == "co-scholastic"` (no subjectId) — same collection as academics,
    split by this field. 82 of 414 real docs were this type.
  - Attendance: schools/{id}/attendance_sheets. Real docs did NOT match
    the shape documented elsewhere in this repo (AUDIT.md) — no `month`
    field on 47 of 58 real sheets, and the one entries doc inspected was
    keyed by YYYY-MM (not YYYY-MM-DD) with every value null. What a FILLED
    value looks like is still unconfirmed, so this only counts whether a
    student has an entries doc at all, not whether any month inside it is
    actually filled in.
  - Remarks: schools/{id}/remarks_sheets. No term/subject dimension —
    already used by functions/generate_smart_remarks.

Nothing here enforces exactly one sheet per class for co-scholastic,
attendance, or remarks (confirmed — some classes had 3-4 of the same sheet
type). Entry counts are SUMMED across every sheet found for a class, since
that is what "how many entries have been made" actually asks; the sheet
count is reported alongside so a class with an unusually high sheet count
(possibly duplicates from a reset) is visible rather than silently blended
into one number.
"""

from collections import defaultdict

from firebase_admin import initialize_app, firestore
from firebase_functions import https_fn, options

from ops_admins import require_ops_admin as _require_ops_admin_base

try:
    initialize_app()
except ValueError:
    pass  # already initialized in this environment

db = firestore.client()


def _require_ops_admin(req: https_fn.CallableRequest) -> str:
    return _require_ops_admin_base(req, "Not authorized to view the sheets overview.")


def _blank_row(class_id, class_name):
    return {
        "classId": class_id,
        "className": class_name,
        "academics": {"completedTopics": 0, "totalTopics": 0, "subjectCount": 0},
        "coScholastic": {"sheetCount": 0, "entryCount": 0},
        "attendance": {"sheetCount": 0, "entryCount": 0},
        "remarks": {"sheetCount": 0, "entryCount": 0},
    }


def _academics_from_classes(school_ref, rows):
    """No entries reads — classes/{id}.subjects[].topics[].isCompleted is
    already the completion signal the teacher app maintains."""
    for doc in school_ref.collection("classes").stream():
        data = doc.to_dict() or {}
        if data.get("isActive") is False:
            continue
        row = rows.setdefault(doc.id, _blank_row(doc.id, data.get("name") or doc.id))
        row["className"] = data.get("name") or doc.id
        subjects = data.get("subjects") or []
        total = completed = 0
        for subject in subjects:
            for topic in (subject.get("topics") or []):
                total += 1
                if topic.get("isCompleted"):
                    completed += 1
        row["academics"] = {
            "completedTopics": completed, "totalTopics": total, "subjectCount": len(subjects),
        }


def _count_entries(doc_ref):
    return sum(1 for _ in doc_ref.collection("entries").stream())


def _roll_up_sheets(school_ref, collection_name, rows, area_key, classify=None):
    """Sums sheetCount/entryCount into rows[classId][area_key] for every doc
    in `collection_name`. `classify`, if given, is (data) -> bool | None —
    None means "skip this doc" (e.g. it's the other sub-type of a shared
    collection like smart_sheet_entries)."""
    unknown_classes = defaultdict(int)
    for doc in school_ref.collection(collection_name).stream():
        data = doc.to_dict() or {}
        if classify is not None and not classify(data):
            continue
        class_id = data.get("classId")
        if not class_id:
            continue
        if class_id not in rows:
            unknown_classes[class_id] += 1
            continue
        entry_count = _count_entries(doc.reference)
        area = rows[class_id][area_key]
        area["sheetCount"] += 1
        area["entryCount"] += entry_count
    return dict(unknown_classes)


@https_fn.on_call(region="asia-south1", memory=options.MemoryOption.GB_1, timeout_sec=300)
def sheets_overview(req: https_fn.CallableRequest) -> dict:
    """{school_id} -> whole-school per-class rollup.

    Returns:
      rows: one per active class —
        { classId, className,
          academics: { completedTopics, totalTopics, subjectCount },
          coScholastic: { sheetCount, entryCount },
          attendance: { sheetCount, entryCount },
          remarks: { sheetCount, entryCount } }
      diagnostics: { unknownClassSheets: { area: {classId: sheetCount} } } —
        sheets whose classId doesn't match any active class doc (deleted or
        renamed class, or a genuinely stray sheet) — reported, not silently
        dropped from the totals with no trace.
    """
    _require_ops_admin(req)
    data = req.data or {}
    school_id = data.get("school_id")
    if not school_id:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT, "school_id is required")

    school_ref = db.collection("schools").document(school_id)

    rows = {}
    _academics_from_classes(school_ref, rows)

    unknown = {}
    unknown["coScholastic"] = _roll_up_sheets(
        school_ref, "smart_sheet_entries", rows, "coScholastic",
        classify=lambda d: str(d.get("type") or "").strip().lower() == "co-scholastic")
    unknown["attendance"] = _roll_up_sheets(school_ref, "attendance_sheets", rows, "attendance")
    unknown["remarks"] = _roll_up_sheets(school_ref, "remarks_sheets", rows, "remarks")

    return {
        "rows": sorted(rows.values(), key=lambda r: r["classId"]),
        "diagnostics": {"unknownClassSheets": {k: v for k, v in unknown.items() if v}},
    }
