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
from concurrent.futures import ThreadPoolExecutor

from firebase_admin import initialize_app, firestore
from firebase_functions import https_fn, options

from ops_admins import require_ops_admin as _require_ops_admin_base
from sheet_tables import (
    attendance_table, col_group, flat_table, pick_sheet, sort_students, student_row, subject_table,
)

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


# ── consolidated Smart Sheets report ─────────────────────────────────────────
# The teacher app's "Download Consolidated Report" (SmartSheets.vue), server
# side, so ops can pull it for any school and any classes. Same reads, same
# sheet choice, same columns — see sheet_tables.py.

EXPORT_KINDS = ("academics", "co-scholastic", "attendance")
MAX_EXPORT_CLASSES = 200


def _pick_sheet_doc(school_ref, collection_name, docs, preferred_id):
    if len(docs) <= 1:
        return docs[0].id if docs else None
    counts = [(d.id, sum(1 for _ in d.reference.collection("entries").select([]).stream())) for d in docs]
    return pick_sheet(counts, preferred_id)


def _entries(school_ref, collection_name, sheet_id):
    return {d.id: d.to_dict() or {}
            for d in school_ref.collection(collection_name).document(sheet_id).collection("entries").stream()}


def _students(school_ref, class_id):
    docs = school_ref.collection("students").where("currentClassId", "==", class_id).stream()
    return sort_students([student_row(d.id, d.to_dict() or {}) for d in docs])


class _Scales:
    """grading_scales docs, read once per call."""
    def __init__(self, school_ref):
        self.ref, self.cache = school_ref, {}

    def levels(self, scale_id):
        if not scale_id:
            return []
        if scale_id not in self.cache:
            doc = self.ref.collection("grading_scales").document(scale_id).get()
            self.cache[scale_id] = ((doc.to_dict() or {}).get("levels") or []) if doc.exists else []
        return self.cache[scale_id]


def _groups(items, scales):
    items = sorted(items, key=lambda a: a.get("order") or 0)
    return [col_group(a, scales.levels(a.get("gradingScaleId"))) for a in items]


def _academics_class(school_ref, class_id, class_data, term_id, all_subjects, scales):
    wanted = [s.get("subjectId") for s in (class_data.get("subjects") or []) if isinstance(s, dict)]
    allowed = set(wanted) if wanted else {sid for sid, _ in all_subjects}
    sheets = school_ref.collection("smart_sheet_entries")
    subjects = []
    for subject_id, subject_name in all_subjects:
        if subject_id not in allowed:
            continue
        docs = list(sheets.where("classId", "==", class_id).where("termId", "==", term_id)
                    .where("subjectId", "==", subject_id).stream())
        sheet_id = _pick_sheet_doc(school_ref, "smart_sheet_entries", docs, f"{class_id}__{term_id}__{subject_id}")
        if not sheet_id:
            continue
        assessments = [{"id": d.id, **(d.to_dict() or {})} for d in school_ref.collection("assessments")
                       .where("termId", "==", term_id).where("subjectId", "==", subject_id).stream()]
        if not assessments:
            continue
        subjects.append({"name": subject_name, "groups": _groups(assessments, scales),
                         "entries": _entries(school_ref, "smart_sheet_entries", sheet_id)})
    if not subjects:
        return None
    return subject_table(subjects, _students(school_ref, class_id))


def _co_scholastic_class(school_ref, class_id, term_id, activities_all, scales):
    docs = list(school_ref.collection("smart_sheet_entries").where("type", "==", "co-scholastic")
                .where("classId", "==", class_id).where("termId", "==", term_id).stream())
    sheet_id = _pick_sheet_doc(school_ref, "smart_sheet_entries", docs, f"co-scholastic__{class_id}__{term_id}")
    if not sheet_id:
        return None
    activities = [a for a in activities_all if not a.get("classIds") or class_id in a["classIds"]]
    if not activities:
        return None
    return flat_table(_groups(activities, scales), _students(school_ref, class_id),
                      _entries(school_ref, "smart_sheet_entries", sheet_id))


def _attendance_class(school_ref, class_id):
    month_docs = sorted((d.to_dict() or {} for d in school_ref.collection("classes").document(class_id)
                         .collection("months").stream()), key=lambda m: m.get("order") or 0)
    months = [{"key": m.get("key"), "label": m.get("label") or m.get("key"),
               "workingDays": m.get("workingDays") or 0} for m in month_docs]
    if not months:
        return None
    docs = list(school_ref.collection("attendance_sheets").where("classId", "==", class_id)
                .where("type", "==", "month-wise").stream())
    sheet_id = _pick_sheet_doc(school_ref, "attendance_sheets", docs, f"{class_id}__month-wise")
    if not sheet_id:
        return None
    return attendance_table(months, _students(school_ref, class_id),
                            _entries(school_ref, "attendance_sheets", sheet_id))


@https_fn.on_call(region="asia-south1", memory=options.MemoryOption.GB_1, timeout_sec=300)
def smart_sheets_export(req: https_fn.CallableRequest) -> dict:
    """{school_id, kind, class_ids, term_id?} -> the consolidated report's tables.

    kind: "academics" | "co-scholastic" (both need term_id) | "attendance"
    (month-wise, the whole year). Read-only: a class with no sheet yet is
    listed under `skipped`, never created.

    Returns {classes: [{classId, className, header, merges, rows}],
             skipped: [{classId, className, reason}], termName}
    """
    _require_ops_admin(req)
    data = req.data or {}
    school_id = data.get("school_id")
    kind = data.get("kind")
    # Attendance is month-wise for the whole year — a term means nothing to it.
    term_id = (data.get("term_id") or "") if kind != "attendance" else ""
    class_ids = [str(c) for c in (data.get("class_ids") or []) if c and "/" not in str(c)]
    if not school_id or kind not in EXPORT_KINDS or not class_ids:
        raise https_fn.HttpsError(https_fn.FunctionsErrorCode.INVALID_ARGUMENT,
                                  f"school_id, class_ids and kind ({', '.join(EXPORT_KINDS)}) are required")
    if kind != "attendance" and not term_id:
        raise https_fn.HttpsError(https_fn.FunctionsErrorCode.INVALID_ARGUMENT, "term_id is required")
    if len(class_ids) > MAX_EXPORT_CLASSES:
        raise https_fn.HttpsError(https_fn.FunctionsErrorCode.INVALID_ARGUMENT,
                                  f"At most {MAX_EXPORT_CLASSES} classes at a time")

    school_ref = db.collection("schools").document(school_id)
    class_docs = {d.id: d.to_dict() or {} for d in school_ref.collection("classes").stream()}
    scales = _Scales(school_ref)
    term_name = ""
    if term_id:
        term = school_ref.collection("terms").document(term_id).get()
        term_name = (term.to_dict() or {}).get("name", term_id) if term.exists else term_id

    if kind == "academics":
        subjects = [(d.id, (d.to_dict() or {}).get("name") or d.id)
                    for d in school_ref.collection("subjects").stream()]
        build = lambda cid: _academics_class(school_ref, cid, class_docs.get(cid, {}), term_id, subjects, scales)
    elif kind == "co-scholastic":
        activities = [{"id": d.id, **(d.to_dict() or {})} for d in school_ref.collection("co_scholastic_activities")
                      .where("termId", "==", term_id).stream()]
        build = lambda cid: _co_scholastic_class(school_ref, cid, term_id, activities, scales)
    else:
        build = lambda cid: _attendance_class(school_ref, cid)

    with ThreadPoolExecutor(max_workers=6) as pool:
        tables = list(pool.map(build, class_ids))

    out, skipped = [], []
    for class_id, table in zip(class_ids, tables):
        name = class_docs.get(class_id, {}).get("name") or class_id
        if table is None:
            reason = {"academics": "no academics sheet for this term",
                      "co-scholastic": "no co-scholastic sheet or activities for this term",
                      "attendance": "no attendance months or month-wise sheet"}[kind]
            skipped.append({"classId": class_id, "className": name, "reason": reason})
        else:
            out.append({"classId": class_id, "className": name, **table})
    return {"classes": out, "skipped": skipped, "termName": term_name}

