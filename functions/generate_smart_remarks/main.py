"""
Cloud Function: generate_smart_remarks (+ list_smart_remarks, update_smart_remark,
bulk_update_smart_remarks — same source directory)

Generates a consolidated general-conduct remark per student from the "Smart
Sheets" remarks system, NOT the AAP survey (functions/generate_aap_remarks —
a different feature entirely, subject-scoped Awareness/Sensitivity/
Creativity ratings). This one turns a teacher's ticked checkboxes into one
written paragraph per child.

THE DATA (confirmed against real Firestore data, Hillgreen Highschool, before
writing a line of this):
  - schools/{id}/remark_categories/{docId} — the BANK of tickable statements.
    Doc id is "{band}_{category}" (band: Foundational/Preparatory/Middle/
    Secondary; no prefix = applies to every band), fields
    {label, order, classIds: [...], remarks: [{key, text,
    type: "positive"|"negative", order}]}. `key` (e.g. "preparatory_gr3") is
    UNIQUE ACROSS THE WHOLE SCHOOL by construction — School Setup's Remarks
    tab enforces this and never lets a key be renumbered once any ticking
    exists (see src/utils/remarksImport.js's module docstring). That is what
    makes resolving a ticked key an exact dict lookup here, not a fuzzy
    match like AAP's subject aliasing has to do.
  - schools/{id}/remarks_sheets/{sheetId} (+entries/{studentId}) — the ticks
    themselves, one sheet per class, created by the TEACHER APP on demand
    (this dashboard never creates one). entries/{studentId} is a flat
    {remarkKey: bool} map — no category or grade stored alongside it, since
    the key alone already means one specific statement.

THE ONE NON-OBVIOUS JOIN: a class's remark band is NOT the same string as its
`stage` field. classes/{id}.stage takes schoolSchema.js's STAGES values
('foundation'/'prepratory' [sic, live misspelling]/'middle'/'secondary'),
while remark_categories bands are capitalised and correctly spelled
('Foundational'/'Preparatory'/'Middle'/'Secondary'). Two independently
spelled taxonomies for the same four bands — mapped explicitly in
_BAND_BY_STAGE, never by case-folding or guessing they reduce to each other.

Callers are checked against the shared ops-admin allowlist server-side
(ops_admins.py, synced from functions/shared — same file every other
callable in this repo uses).
"""

import re
import time
from collections import defaultdict

from firebase_admin import initialize_app, firestore
from firebase_functions import https_fn, options
from firebase_functions.params import SecretParam
from openai import OpenAI

from class_resolver import (
    compose_class_id, grade_ordinal, normalize_section_value,
    parse_class_value, raw_class_value,
)
from ops_admins import require_ops_admin as _require_ops_admin_base

try:
    initialize_app()
except ValueError:
    pass  # already initialized in this environment

db = firestore.client()
OPENAI_API_KEY = SecretParam("OPENAI_API_KEY")

# classes/{id}.stage -> remark_categories band prefix. See module docstring —
# these are two independently spelled taxonomies for the same four bands.
_BAND_BY_STAGE = {
    "foundation": "Foundational",
    "prepratory": "Preparatory",   # sic — schoolSchema.js's STAGES constant
    "middle": "Middle",
    "secondary": "Secondary",
}
_KNOWN_BANDS = set(_BAND_BY_STAGE.values())

INACTIVE_ENROLLMENT_VALUES = {
    "inactive", "left", "tc", "tc issued", "dropped", "dropout",
    "alumni", "passed out", "transferred", "withdrawn",
}

# A student needs at least this many ticked items before the generator
# treats the data as a normal-confidence remark; below it, the prompt is
# told to hedge rather than let the model manufacture confidence the data
# doesn't support. Chosen, not derived — worth revisiting once real usage
# shows what "enough" looks like across schools.
LOW_CONFIDENCE_THRESHOLD = 3

# Style variation, same reasoning as generate_aap_remarks's SENTENCE_STARTERS:
# a whole class read off one style instruction reads as one comment with the
# names swapped.
SENTENCE_STARTERS = [
    "begins with the student's name and their strongest quality",
    "opens with what makes this student stand out day to day",
    "leads with the student's most noticeable habit this term",
    "starts by describing how the student carries themself in class",
    "opens on a specific moment that captures this student's character",
    "begins with how classmates and teachers experience this student",
    "starts with the student's approach to their work",
    "leads with the student's growth since the term began",
]
CLOSINGS = [
    "End with something the student can build on next term.",
    "End on what the teacher looks forward to seeing.",
    "End with a warm sentence about the student as a classmate.",
    "End with a specific encouragement, not a general one.",
]


def _require_ops_admin(req: https_fn.CallableRequest) -> str:
    return _require_ops_admin_base(req, "Not authorized to generate smart remarks.")


def _is_inactive_student(data):
    """Same rule as functions/assign_survey/survey_rules.py's is_inactive —
    duplicated rather than imported because each function directory here
    deploys independently (see tools/sync_shared.py)."""
    if data.get("isActive") is False:
        return True
    status = str(data.get("enrollmentStatus") or data.get("status") or "").strip().lower()
    return status in INACTIVE_ENROLLMENT_VALUES


def _canonical_grade_section(grade_raw, section_raw):
    """Same as generate_aap_remarks's aap_rules.canonical_grade_section —
    duplicated (that module isn't in functions/shared, and this is the only
    piece of it needed here) rather than depending on a sibling function
    directory that deploys independently."""
    resolved = grade_ordinal(grade_raw)
    canonical_grade = resolved[0] if resolved else str(grade_raw or "").strip().upper()
    return canonical_grade, normalize_section_value(section_raw)


def gender_issue(student_ids, students):
    """Missing or suspiciously uniform gender across a class — same rule as
    generate_aap_remarks's aap_rules.gender_issue, duplicated for the same
    independent-deploy reason. `students` is {student_id: {"gender": ...}}."""
    total = len(student_ids)
    if total == 0:
        return None
    known = [students.get(sid, {}).get("gender", "").strip()
             for sid in student_ids if students.get(sid, {}).get("gender", "").strip()]
    missing = total - len(known)
    distinct = set(known)
    uniform_gender = next(iter(distinct)) if len(distinct) == 1 and len(known) >= 2 else None
    if missing == 0 and not uniform_gender:
        return None
    return {"missingCount": missing, "totalCount": total, "uniformGender": uniform_gender}


def get_first_name(full_name):
    parts = full_name.strip().split()
    if not parts:
        return full_name
    parts = [p.capitalize() for p in parts]
    if re.match(r"^[A-Z]\.$", parts[0]):
        return " ".join(parts[:2])
    return parts[0]


def _resolve_band(school_ref, class_id):
    """The class's remark band, or (None, raw_stage) if its `stage` field is
    missing or doesn't map to a known band — a blocking finding, same as
    generate_aap_remarks treats an unrecognised grade: there is no rubric
    text (here, no remark bank) to fall back to."""
    doc = school_ref.collection("classes").document(class_id).get()
    stage = str((doc.to_dict() or {}).get("stage") or "").strip().lower()
    return _BAND_BY_STAGE.get(stage), stage


def _fetch_remark_bank(school_ref, band):
    """key -> {category, text, type} across every remark_categories doc that
    applies to this band (doc id "{band}_{category}", or unprefixed = every
    band). Exact-key index — see module docstring for why this needs no
    fuzzy matching the way AAP's subject resolution does.

    Returns (index, categories_in_order) — categories_in_order is every
    category label that contributed at least one key, in the order
    encountered, so the prompt can group observations the same way the bank
    itself is organised.
    """
    index = {}
    categories = []
    for doc in school_ref.collection("remark_categories").stream():
        doc_band = doc.id.split("_", 1)[0] if "_" in doc.id else ""
        if doc_band not in _KNOWN_BANDS:
            doc_band = ""  # not a real band prefix — this category applies to every band
        if doc_band and doc_band != band:
            continue
        data = doc.to_dict() or {}
        label = str(data.get("label") or doc.id).strip()
        remarks = data.get("remarks") or []
        if not remarks:
            continue
        categories.append(label)
        for r in remarks:
            key = r.get("key")
            if not key:
                continue
            index[key] = {
                "category": label,
                "text": str(r.get("text") or "").strip(),
                "type": r.get("type") or "positive",
            }
    return index, categories


def _find_remarks_sheet(school_ref, class_id):
    """The remarks_sheets doc for this class. Nothing in the schema enforces
    exactly one per class, so the most recently edited wins and the count is
    returned for the caller to surface — silently picking one is fine, but
    silently HIDING that there were several is not.

    Returns (sheet_ref, sheet_count).
    """
    docs = list(school_ref.collection("remarks_sheets").where("classId", "==", class_id).stream())
    if not docs:
        return None, 0
    docs.sort(key=lambda d: (d.to_dict() or {}).get("lastEditedAt") or 0, reverse=True)
    return docs[0].reference, len(docs)


def _fetch_students(school_ref, student_ids):
    if not student_ids:
        return {}
    refs = [school_ref.collection("students").document(sid) for sid in student_ids]
    out = {}
    for doc in db.get_all(refs):
        if not doc.exists:
            continue
        data = doc.to_dict()
        name = f"{data.get('firstName', '')} {data.get('lastName', '')}".strip() or doc.id
        out[doc.id] = {"name": name, "gender": data.get("gender", "")}
    return out


def _class_roster(school_ref, class_id):
    """Every active student in this class. Indexed equality query first (the
    common case, same fast path class_detail in functions/assign_survey
    uses); a school that doesn't key students.classId cleanly falls back to
    a full scan resolved through the SAME canonicalisation the rest of this
    file uses, so a fallback match can never land on a class_id notation
    fetch_remarks_sheet or the caller wouldn't recognise.
    """
    out = []
    try:
        for d in school_ref.collection("students").where("classId", "==", class_id).stream():
            data = d.to_dict() or {}
            if str(data.get("type") or "student") != "student" or _is_inactive_student(data):
                continue
            out.append(d.id)
    except Exception as e:
        print(f"_class_roster: indexed lookup failed, falling back to scan: {e}")

    if out:
        return out

    target_grade_raw, _, target_section_raw = class_id.partition("_")
    target = _canonical_grade_section(target_grade_raw, target_section_raw)
    for d in school_ref.collection("students").stream():
        data = d.to_dict() or {}
        if str(data.get("type") or "student") != "student" or _is_inactive_student(data):
            continue
        raw, _field = raw_class_value(data)
        parsed = parse_class_value(raw)
        if parsed["grade_ordinal"] is None:
            continue
        if _canonical_grade_section(parsed["grade_token"], parsed["section"]) == target:
            out.append(d.id)
    return out


def generate_smart_comment(ai, first_name, gender, ticked, used_openings=None):
    """One consolidated remark from a student's ticked statements.
    `ticked` is [{category, text, type}, ...] — already resolved, already
    filtered to items this student actually has ticked true.
    """
    used_openings = used_openings if used_openings is not None else set()
    pronoun = "He" if gender.strip().lower().startswith(("m", "boy")) else "She"
    his_her = "his" if pronoun == "He" else "her"

    by_category = defaultdict(list)
    for item in ticked:
        by_category[item["category"]].append(item)
    multi_category = len(by_category) > 1
    low_confidence = len(ticked) < LOW_CONFIDENCE_THRESHOLD

    lines = []
    for category, items in by_category.items():
        positives = [i["text"] for i in items if i["type"] != "negative"]
        negatives = [i["text"] for i in items if i["type"] == "negative"]
        parts = positives + [f"(growth area) {n}" for n in negatives]
        lines.append(f"- {category}: " + "; ".join(parts))
    observations = "\n".join(lines)

    structure_note = (
        "This student's observations span more than one category, listed above — "
        "structure the comment as one short clause per category, in the order given, "
        "so each category's own observations clearly come through."
        if multi_category else
        "Blend all the observations into ONE natural paragraph — do not list them mechanically."
    )
    confidence_note = (
        "\n- Only a few observations were ticked for this student so far — write in a way "
        "that reads as an early impression rather than a complete assessment, without saying "
        "so clinically (e.g. \"is beginning to show\", \"so far\")."
        if low_confidence else ""
    )

    avoid = sorted(used_openings)[:8]
    avoid_line = ("\n- Do NOT open with any of these phrasings, already used for "
                  f"other students in this class: {'; '.join(avoid)}" if avoid else "")

    prompt = f"""You are a warm, caring schoolteacher writing a general conduct/behavior remark for a report card — NOT a subject-specific comment.

Student first name: {first_name}
Pronoun: {pronoun}/{his_her}

Observations the teacher ticked for this student, grouped by category:
{observations}

Style instructions:
- The comment {SENTENCE_STARTERS[len(used_openings) % len(SENTENCE_STARTERS)]}
- {structure_note}{confidence_note}
- {CLOSINGS[len(used_openings) % len(CLOSINGS)]}
- Write like a real teacher — simple, warm, everyday language parents and children understand easily
- Use {first_name}'s name once near the start
- Use correct pronoun ({pronoun}/{his_her})
- A growth area (marked above) must be phrased constructively, never harshly
- Avoid formal/robotic phrases like "learning community", "valued member", "demonstrates proficiency"
- MUST be between 40 and 70 words
- Return only the comment, nothing else{avoid_line}"""

    comment = ""
    for _ in range(3):
        resp = ai.chat.completions.create(
            model="gpt-4o-mini", max_tokens=300, temperature=1.0,
            messages=[{"role": "user", "content": prompt}],
        )
        comment = resp.choices[0].message.content.strip()
        opening = " ".join(comment.split()[:4]).lower()
        if 40 <= len(comment.split()) <= 70 and opening not in used_openings:
            break
    used_openings.add(" ".join(comment.split()[:4]).lower())
    return comment


@https_fn.on_call(region="asia-south1", secrets=[OPENAI_API_KEY],
                   memory=options.MemoryOption.MB_512, timeout_sec=540)
def generate_smart_remarks(req: https_fn.CallableRequest) -> dict:
    caller = _require_ops_admin(req)
    data = req.data or {}
    school_id = data.get("school_id")
    class_id = data.get("class_id")
    only_student_ids = set(data.get("student_ids", []))
    scan_only = bool(data.get("scan_only"))
    confirm_gender_issue = bool(data.get("confirm_gender_issue"))

    if not school_id or not class_id:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT,
            "school_id and class_id are required",
        )

    school_ref = db.collection("schools").document(school_id)

    band, raw_stage = _resolve_band(school_ref, class_id)
    if band is None:
        payload = {
            "band": None, "stageIssue": raw_stage, "classId": class_id,
            "students": 0, "categories": [], "sheetFound": False,
            "multipleSheetsFound": False, "genderIssue": None,
        }
        if scan_only:
            return payload
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT,
            f"This class's stage ('{raw_stage or 'not set'}') doesn't map to a known remark "
            "band (Foundational/Preparatory/Middle/Secondary). Set classes/{id}.stage before "
            "running smart remarks for this class.",
        )

    remark_bank, categories = _fetch_remark_bank(school_ref, band)
    sheet_ref, sheet_count = _find_remarks_sheet(school_ref, class_id)
    roster_ids = _class_roster(school_ref, class_id)
    if only_student_ids:
        roster_ids = [sid for sid in roster_ids if sid in only_student_ids]

    if sheet_ref is None:
        payload = {
            "band": band, "classId": class_id, "students": len(roster_ids),
            "categories": categories, "sheetFound": False,
            "multipleSheetsFound": False, "genderIssue": None,
        }
        if scan_only:
            return payload
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT,
            "No remarks sheet exists yet for this class — nothing has been ticked by a teacher.",
        )

    entries_by_student = {}
    for sid in roster_ids:
        doc = sheet_ref.collection("entries").document(sid).get()
        entries_by_student[sid] = doc.to_dict() if doc.exists else {}

    students = _fetch_students(school_ref, roster_ids)
    g_issue = gender_issue(roster_ids, students)

    scan_payload = {
        "band": band, "classId": class_id, "students": len(roster_ids),
        "categories": categories, "sheetFound": True,
        "multipleSheetsFound": sheet_count > 1, "genderIssue": g_issue,
    }
    if scan_only:
        return scan_payload

    if g_issue and not confirm_gender_issue:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT,
            "Gender data looks incomplete or suspicious for this class — confirm before "
            "generating (confirm_gender_issue).",
        )

    ai = OpenAI(api_key=OPENAI_API_KEY.value)

    job_ref = school_ref.collection("smart_remarks_jobs").document()
    job_ref.set({
        "classId": class_id, "band": band, "status": "running",
        "startedAt": firestore.SERVER_TIMESTAMP, "startedBy": caller,
        "totalStudents": len(roster_ids), "processedStudents": 0,
    })

    used_openings = set()
    processed = written = skipped_approved = skipped_no_ticks = 0

    try:
        for sid in roster_ids:
            info = students.get(sid, {"name": sid, "gender": ""})
            first_name = get_first_name(info["name"])

            doc_ref = (school_ref.collection("students").document(sid)
                       .collection("smart_remarks").document("current"))
            existing = doc_ref.get()
            if (existing.exists and existing.to_dict().get("status") == "approved"
                    and not only_student_ids):
                processed += 1
                skipped_approved += 1
                continue

            entry = entries_by_student.get(sid) or {}
            ticked_keys = [k for k, v in entry.items() if v and k in remark_bank]
            ticked = [remark_bank[k] for k in ticked_keys]
            if not ticked:
                processed += 1
                skipped_no_ticks += 1
                continue

            comment = generate_smart_comment(ai, first_name, info["gender"], ticked,
                                              used_openings=used_openings)

            doc_ref.set({
                "classId": class_id, "band": band, "sheetId": sheet_ref.id,
                "tickedKeys": ticked_keys, "tickedCount": len(ticked),
                "lowConfidence": len(ticked) < LOW_CONFIDENCE_THRESHOLD,
                "comment": comment, "status": "needs_review",
                "updatedAt": firestore.SERVER_TIMESTAMP,
            })
            processed += 1
            written += 1
            job_ref.update({"processedStudents": processed, "writtenRemarks": written})
            time.sleep(0.3)
    except Exception as e:
        job_ref.update({
            "status": "failed", "error": str(e)[:500],
            "completedAt": firestore.SERVER_TIMESTAMP,
            "processedStudents": processed, "writtenRemarks": written,
        })
        raise

    job_ref.update({
        "status": "done", "completedAt": firestore.SERVER_TIMESTAMP,
        "processedStudents": processed, "writtenRemarks": written,
        "skippedApproved": skipped_approved, "skippedNoTicks": skipped_no_ticks,
    })
    return {
        "jobId": job_ref.id, "processed": processed, "written": written,
        "skippedApproved": skipped_approved, "skippedNoTicks": skipped_no_ticks,
        **scan_payload,
    }


def _serialize_remark(data):
    out = dict(data)
    updated_at = out.get("updatedAt")
    if updated_at is not None and hasattr(updated_at, "isoformat"):
        out["updatedAt"] = updated_at.isoformat()
    return out


@https_fn.on_call(region="asia-south1", memory=options.MemoryOption.MB_256, timeout_sec=60)
def list_smart_remarks(req: https_fn.CallableRequest) -> dict:
    """{school_id, student_ids} -> {studentId: remark|null}."""
    _require_ops_admin(req)
    data = req.data or {}
    school_id = data.get("school_id")
    student_ids = list(data.get("student_ids") or [])
    if not school_id or not student_ids:
        return {}

    school_ref = db.collection("schools").document(school_id)
    out = {}
    for sid in student_ids:
        doc = (school_ref.collection("students").document(sid)
               .collection("smart_remarks").document("current").get())
        out[sid] = _serialize_remark(doc.to_dict()) if doc.exists else None
    return out


@https_fn.on_call(region="asia-south1", memory=options.MemoryOption.MB_256, timeout_sec=30)
def update_smart_remark(req: https_fn.CallableRequest) -> dict:
    """{school_id, student_id, comment?, status?} -> {}. Same shape as AAP's
    update_aap_remark — saving an edited comment approves it in the same
    call."""
    caller = _require_ops_admin(req)
    data = req.data or {}
    school_id = data.get("school_id")
    student_id = data.get("student_id")
    if not school_id or not student_id:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT,
            "school_id and student_id are required",
        )

    update = {"updatedAt": firestore.SERVER_TIMESTAMP, "updatedBy": caller}
    if data.get("comment") is not None:
        update["comment"] = data["comment"]
        update["status"] = "approved"
    if data.get("status") is not None:
        update["status"] = data["status"]

    (db.collection("schools").document(school_id).collection("students").document(student_id)
        .collection("smart_remarks").document("current")).set(update, merge=True)
    return {}


@https_fn.on_call(region="asia-south1", memory=options.MemoryOption.MB_256, timeout_sec=120)
def bulk_update_smart_remarks(req: https_fn.CallableRequest) -> dict:
    """{school_id, student_ids, status} -> {updated}."""
    caller = _require_ops_admin(req)
    data = req.data or {}
    school_id = data.get("school_id")
    student_ids = data.get("student_ids") or []
    status = data.get("status")
    if not school_id or not student_ids or not status:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT,
            "school_id, student_ids and status are required",
        )

    stamp = {"status": status, "updatedAt": firestore.SERVER_TIMESTAMP, "updatedBy": caller}
    school_ref = db.collection("schools").document(school_id)
    chunk = 450
    for i in range(0, len(student_ids), chunk):
        batch = db.batch()
        for sid in student_ids[i:i + chunk]:
            doc_ref = (school_ref.collection("students").document(sid)
                       .collection("smart_remarks").document("current"))
            batch.set(doc_ref, stamp, merge=True)
        batch.commit()
    return {"updated": len(student_ids)}
