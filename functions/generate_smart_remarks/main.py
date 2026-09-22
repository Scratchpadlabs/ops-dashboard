"""
Cloud Function: generate_smart_remarks (+ list_smart_remarks, update_smart_remark,
bulk_update_smart_remarks — same source directory)

Generates one general-conduct remark PER CATEGORY per student from the
"Smart Sheets" remarks system, NOT the AAP survey (functions/generate_aap_remarks —
a different feature entirely, subject-scoped Awareness/Sensitivity/
Creativity ratings). This one turns a teacher's ticked checkboxes into a
written paragraph per child, one per remark category (General Remarks,
Physical Development, Socio-Emotional Development, Cognitive Development,
Aesthetic and Cultural Development, ...) — never blended into a single
combined paragraph. Categories are independent write-ups because they are
commonly ticked by different teachers at different times (see below).

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
    match like AAP's subject aliasing has to do. The bank doc's own id
    (e.g. "Foundational_General") is used as the stable `categorySlug` that
    ties a ticked key back to one written remark — never the human-editable
    `label`, which can be renamed in School Setup.
  - schools/{id}/remarks_sheets/{sheetId} (+entries/{studentId}) — the ticks
    themselves, created by the TEACHER APP on demand (this dashboard never
    creates one). entries/{studentId} is a flat {remarkKey: bool} map — no
    category or grade stored alongside it, since the key alone already means
    one specific statement.

    Nothing in the schema enforces exactly one sheet per class — confirmed
    by functions/sheets_overview: some classes had 3-4 remarks_sheets docs
    (different tabs/teachers ticking different categories at different
    times, or plain duplicates). Earlier code picked only the single
    most-recently-edited sheet and silently discarded every other sheet's
    ticks — a real data-loss bug (a teacher's ticks in an older sheet would
    vanish the moment any other sheet for the class was touched, even a
    near-empty one). This file now reads and merges entries from EVERY
    remarks_sheets doc for the class instead: sheets are folded together
    oldest-to-newest so a more-recently-edited sheet's value for a given key
    wins if sheets actually disagree, but a key that exists in only one
    sheet is never lost because a different sheet happened to be edited more
    recently. See _fetch_merged_entries.

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
    """key -> {category, categorySlug, text, type} across every
    remark_categories doc that applies to this band (doc id
    "{band}_{category}", or unprefixed = every band). Exact-key index — see
    module docstring for why this needs no fuzzy matching the way AAP's
    subject resolution does.

    `categorySlug` is the remark_categories doc's own id — a stable
    identifier for "which category this key belongs to" that survives the
    category being relabelled in School Setup (the `label` doesn't).

    Returns (index, categories_in_order) — categories_in_order is
    [{slug, label, order}, ...] for every category that contributed at
    least one key, in the order encountered, so per-category remarks can be
    listed/sorted the same way the bank itself is organised.
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
        categories.append({"slug": doc.id, "label": label, "order": data.get("order") or 0})
        for r in remarks:
            key = r.get("key")
            if not key:
                continue
            index[key] = {
                "category": label,
                "categorySlug": doc.id,
                "text": str(r.get("text") or "").strip(),
                "type": r.get("type") or "positive",
            }
    return index, categories


def _fetch_merged_entries(school_ref, class_id, roster_ids):
    """Every remarks_sheets doc for this class, merged into one
    {studentId: {remarkKey: bool}} map per student.

    Nothing enforces one sheet per class (see module docstring), so this
    reads ALL of them rather than guessing which one is "the" sheet. Sheets
    are processed oldest-edited to newest-edited, updating (not replacing)
    each student's dict as we go — a key that only ever appears in one sheet
    survives untouched, and a key ticked differently across sheets resolves
    to whatever the most-recently-edited sheet says, which is the closest
    read of "what a teacher most recently intended" available from this data.

    Returns (entries_by_student, sheet_refs, sheet_count).
    """
    docs = list(school_ref.collection("remarks_sheets").where("classId", "==", class_id).stream())
    if not docs:
        return {sid: {} for sid in roster_ids}, [], 0
    docs.sort(key=lambda d: (d.to_dict() or {}).get("lastEditedAt") or 0)  # oldest first

    entries_by_student = {sid: {} for sid in roster_ids}
    for doc in docs:
        for sid in roster_ids:
            entry_doc = doc.reference.collection("entries").document(sid).get()
            if entry_doc.exists:
                entries_by_student[sid].update(entry_doc.to_dict() or {})
    return entries_by_student, [d.reference for d in docs], len(docs)


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


def generate_smart_comment(ai, first_name, gender, category_label, ticked, used_openings=None):
    """One remark, scoped to a SINGLE remark category, from a student's
    ticked statements in that category. `ticked` is [{text, type}, ...] —
    already resolved, already filtered to items this student actually has
    ticked true, all belonging to `category_label`.

    Categories are written up independently rather than blended into one
    combined paragraph — see module docstring for why (different teachers,
    different tabs, different sheets, different times).
    """
    used_openings = used_openings if used_openings is not None else set()
    pronoun = "He" if gender.strip().lower().startswith(("m", "boy")) else "She"
    his_her = "his" if pronoun == "He" else "her"

    low_confidence = len(ticked) < LOW_CONFIDENCE_THRESHOLD

    positives = [i["text"] for i in ticked if i["type"] != "negative"]
    negatives = [i["text"] for i in ticked if i["type"] == "negative"]
    parts = positives + [f"(growth area) {n}" for n in negatives]
    observations = "; ".join(parts)

    confidence_note = (
        "\n- Only a few observations were ticked for this student so far — write in a way "
        "that reads as an early impression rather than a complete assessment, without saying "
        "so clinically (e.g. \"is beginning to show\", \"so far\")."
        if low_confidence else ""
    )

    avoid = sorted(used_openings)[:8]
    avoid_line = ("\n- Do NOT open with any of these phrasings, already used for "
                  f"other students in this class: {'; '.join(avoid)}" if avoid else "")

    prompt = f"""You are a warm, caring schoolteacher writing a "{category_label}" remark for a report card.

Student first name: {first_name}
Pronoun: {pronoun}/{his_her}

Observations the teacher ticked for this student under "{category_label}":
{observations}

Style instructions:
- The comment {SENTENCE_STARTERS[len(used_openings) % len(SENTENCE_STARTERS)]}
- Blend all the observations into ONE natural paragraph — do not list them mechanically.{confidence_note}
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
    category_labels = [c["label"] for c in categories]
    roster_ids = _class_roster(school_ref, class_id)
    if only_student_ids:
        roster_ids = [sid for sid in roster_ids if sid in only_student_ids]

    entries_by_student, sheet_refs, sheet_count = _fetch_merged_entries(school_ref, class_id, roster_ids)
    sheet_ids = [s.id for s in sheet_refs]

    if not sheet_refs:
        payload = {
            "band": band, "classId": class_id, "students": len(roster_ids),
            "categories": category_labels, "sheetFound": False,
            "multipleSheetsFound": False, "genderIssue": None,
        }
        if scan_only:
            return payload
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT,
            "No remarks sheet exists yet for this class — nothing has been ticked by a teacher.",
        )

    students = _fetch_students(school_ref, roster_ids)
    g_issue = gender_issue(roster_ids, students)

    scan_payload = {
        "band": band, "classId": class_id, "students": len(roster_ids),
        "categories": category_labels, "sheetFound": True,
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

    used_openings_by_category = defaultdict(set)
    processed = written = skipped_approved = skipped_no_ticks = 0

    try:
        for sid in roster_ids:
            info = students.get(sid, {"name": sid, "gender": ""})
            first_name = get_first_name(info["name"])

            entry = entries_by_student.get(sid) or {}
            ticked_keys = [k for k, v in entry.items() if v and k in remark_bank]

            # Group this student's ticked keys by category — one remark per
            # category, never one blended remark across categories.
            by_category = defaultdict(list)
            for key in ticked_keys:
                item = remark_bank[key]
                by_category[item["categorySlug"]].append({**item, "key": key})

            student_remarks_ref = school_ref.collection("students").document(sid).collection("smart_remarks")

            for cat in categories:
                slug = cat["slug"]
                cat_ticked = by_category.get(slug) or []
                doc_ref = student_remarks_ref.document(slug)

                if not cat_ticked:
                    skipped_no_ticks += 1
                    continue

                existing = doc_ref.get()
                if (existing.exists and existing.to_dict().get("status") == "approved"
                        and not only_student_ids):
                    skipped_approved += 1
                    continue

                comment = generate_smart_comment(
                    ai, first_name, info["gender"], cat["label"], cat_ticked,
                    used_openings=used_openings_by_category[slug],
                )

                doc_ref.set({
                    "classId": class_id, "band": band, "sheetIds": sheet_ids,
                    "category": cat["label"], "categorySlug": slug, "categoryOrder": cat["order"],
                    "tickedKeys": [i["key"] for i in cat_ticked], "tickedCount": len(cat_ticked),
                    "lowConfidence": len(cat_ticked) < LOW_CONFIDENCE_THRESHOLD,
                    "comment": comment, "status": "needs_review",
                    "updatedAt": firestore.SERVER_TIMESTAMP,
                })
                written += 1
                time.sleep(0.3)

            processed += 1
            job_ref.update({"processedStudents": processed, "writtenRemarks": written})
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
    """{school_id, student_ids} -> {studentId: [remark, ...]}.

    One entry per category doc found in students/{sid}/smart_remarks —
    sorted by categoryOrder then category label, same order the remark bank
    itself is organised in. A student with nothing generated yet gets [].
    The legacy pre-category "current" doc (single blended remark, from
    before this file wrote one doc per category) is skipped — it has no
    categorySlug and would sort/display as a broken row.
    """
    _require_ops_admin(req)
    data = req.data or {}
    school_id = data.get("school_id")
    student_ids = list(data.get("student_ids") or [])
    if not school_id or not student_ids:
        return {}

    school_ref = db.collection("schools").document(school_id)
    out = {}
    for sid in student_ids:
        docs = school_ref.collection("students").document(sid).collection("smart_remarks").stream()
        remarks = [_serialize_remark(d.to_dict()) for d in docs if (d.to_dict() or {}).get("categorySlug")]
        remarks.sort(key=lambda r: (r.get("categoryOrder") or 0, r.get("category") or ""))
        out[sid] = remarks
    return out


@https_fn.on_call(region="asia-south1", memory=options.MemoryOption.MB_256, timeout_sec=30)
def update_smart_remark(req: https_fn.CallableRequest) -> dict:
    """{school_id, student_id, category_slug, comment?, status?} -> {}. Same
    shape as AAP's update_aap_remark — saving an edited comment approves it
    in the same call. `category_slug` picks which of the student's
    per-category remark docs this call targets."""
    caller = _require_ops_admin(req)
    data = req.data or {}
    school_id = data.get("school_id")
    student_id = data.get("student_id")
    category_slug = data.get("category_slug")
    if not school_id or not student_id or not category_slug:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT,
            "school_id, student_id and category_slug are required",
        )

    update = {"updatedAt": firestore.SERVER_TIMESTAMP, "updatedBy": caller}
    if data.get("comment") is not None:
        update["comment"] = data["comment"]
        update["status"] = "approved"
    if data.get("status") is not None:
        update["status"] = data["status"]

    (db.collection("schools").document(school_id).collection("students").document(student_id)
        .collection("smart_remarks").document(category_slug)).set(update, merge=True)
    return {}


@https_fn.on_call(region="asia-south1", memory=options.MemoryOption.MB_256, timeout_sec=120)
def bulk_update_smart_remarks(req: https_fn.CallableRequest) -> dict:
    """{school_id, items: [{student_id, category_slug}, ...], status} -> {updated}."""
    caller = _require_ops_admin(req)
    data = req.data or {}
    school_id = data.get("school_id")
    items = data.get("items") or []
    status = data.get("status")
    if not school_id or not items or not status:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT,
            "school_id, items and status are required",
        )

    stamp = {"status": status, "updatedAt": firestore.SERVER_TIMESTAMP, "updatedBy": caller}
    school_ref = db.collection("schools").document(school_id)
    chunk = 450
    for i in range(0, len(items), chunk):
        batch = db.batch()
        for item in items[i:i + chunk]:
            sid = item.get("student_id")
            slug = item.get("category_slug")
            if not sid or not slug:
                continue
            doc_ref = (school_ref.collection("students").document(sid)
                       .collection("smart_remarks").document(slug))
            batch.set(doc_ref, stamp, merge=True)
        batch.commit()
    return {"updated": len(items)}
