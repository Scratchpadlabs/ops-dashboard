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

# Words that make a report-card comment read as machine-written or too
# formal for parents. A draft containing any of them is regenerated (the
# last attempt is kept if all fail, so a class never stalls on this).
FANCY_WORDS = (
    "demonstrate", "exemplary", "commendable", "exceptional", "remarkable",
    "showcase", "foster", "journey", "thrive", "vibrant", "meticulous",
    "delve", "testament", "nurture", "embrace", "strive", "endeavor",
    "endeavour", "diligent", "proficien", "invaluable", "unwavering",
    "commitment", "dedication", "enthusiasm", "eagerness", "keen",
    "learning community", "valued member", "positive attitude", "holistic",
    "a joy to", "delight", "shines", "blossom", "flourish", "impressive",
    "truly", "consistently", "noteworthy", "admirable", "aptitude",
)

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


def _fetch_remark_bank(school_ref, band, class_id):
    """key -> {category, categorySlug, text, type} across every
    remark_categories doc that applies to this class. Exact-key index — see
    module docstring for why this needs no fuzzy matching the way AAP's
    subject resolution does.

    A category applies if its `classIds` contains this class — the exact
    rule the teacher app uses to decide which checkboxes it shows
    (SmartSheets.vue fetchRemarkCategories: `classIds array-contains`) — OR
    its doc-id band prefix matches this class's band (unprefixed = every
    band). Scoping by band alone dropped real ticks whenever the two
    disagreed (a class's `stage` edited after the bank was imported, a
    category assigned to extra classes in School Setup, a missing `stage`):
    the teacher saw and ticked the box, but its key was never in this index,
    so every such tick was silently counted as "nothing ticked". Keys are
    unique school-wide, so taking the union can never make one key mean two
    things. `band` may be None (stage unset/unknown) — then only `classIds`
    decides.

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
        data = doc.to_dict() or {}
        in_class_ids = class_id in (data.get("classIds") or [])
        in_band = band is not None and (not doc_band or doc_band == band)
        if not (in_class_ids or in_band):
            continue
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


def _fetch_merged_entries(school_ref, class_id):
    """Every remarks_sheets doc for this class, merged into one
    {studentId: {remarkKey: bool}} map per student.

    Nothing enforces one sheet per class (see module docstring), so this
    reads ALL of them rather than guessing which one is "the" sheet. Sheets
    are processed oldest-edited to newest-edited, updating (not replacing)
    each student's dict as we go — a key that only ever appears in one sheet
    survives untouched, and a key ticked differently across sheets resolves
    to whatever the most-recently-edited sheet says, which is the closest
    read of "what a teacher most recently intended" available from this data.

    Every entries doc in each sheet is read, not just the ones for a
    precomputed roster: the teacher app lists students by `currentClassId`,
    so a student can have ticks here that a roster built another way would
    never look up. The caller unions these ids into the roster.

    Returns (entries_by_student, sheet_refs, sheet_count).
    """
    docs = list(school_ref.collection("remarks_sheets").where("classId", "==", class_id).stream())
    if not docs:
        return {}, [], 0
    docs.sort(key=lambda d: _edited_at_key((d.to_dict() or {}).get("lastEditedAt")))  # oldest first

    entries_by_student = defaultdict(dict)
    for doc in docs:
        for entry_doc in doc.reference.collection("entries").stream():
            entries_by_student[entry_doc.id].update(entry_doc.to_dict() or {})
    return dict(entries_by_student), [d.reference for d in docs], len(docs)


def _edited_at_key(value):
    """Sortable seconds for a sheet's lastEditedAt. The teacher app creates
    every sheet with lastEditedAt: null and only stamps a server timestamp
    on the first save, so a class with one untouched sheet next to an edited
    one mixes None and datetimes — sorting those raw raised TypeError and
    failed the whole call for exactly the classes with several sheets."""
    if value is None:
        return 0.0
    if hasattr(value, "timestamp"):
        try:
            return float(value.timestamp())
        except Exception:
            return 0.0
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _roster_sort_key(sid, info):
    """Roll number (numeric first), then name — the order the teacher app
    lists a remarks sheet in."""
    info = info or {}
    roll = str(info.get("rollNo") or "").strip()
    try:
        roll_key = (0, float(roll), "")
    except ValueError:
        roll_key = (1, 0.0, roll.lower()) if roll else (2, 0.0, "")
    return roll_key + (str(info.get("name") or sid).lower(), sid)


def _fetch_students(school_ref, student_ids):
    if not student_ids:
        return {}
    refs = [school_ref.collection("students").document(sid) for sid in student_ids]
    out = {}
    for doc in db.get_all(refs):
        if not doc.exists:
            continue
        data = doc.to_dict()
        # The teacher app and import pipeline write a single `name`;
        # firstName/lastName is kept as a fallback for older records.
        name = (str(data.get("name") or "").strip()
                or f"{data.get('firstName', '')} {data.get('lastName', '')}".strip()
                or doc.id)
        out[doc.id] = {
            "name": name, "gender": str(data.get("gender") or ""),
            "rollNo": data.get("rollNo") or "",
            "active": str(data.get("type") or "student") == "student" and not _is_inactive_student(data),
        }
    return out


def _class_roster(school_ref, class_id):
    """Every active student in this class. Indexed equality queries first:
    `currentClassId` — the exact field the teacher app lists a remarks sheet's
    students by (SmartSheets.vue: where('currentClassId', '==', classId)), so
    the students whose ticks we read are the students the teacher ticked —
    then `classId`, which on some records is a stale previous-year class and
    so must never win over currentClassId. A school that keys neither cleanly
    falls back to a full scan resolved through the SAME canonicalisation the
    rest of this file uses, so a fallback match can never land on a class_id
    notation fetch_remarks_sheet or the caller wouldn't recognise.
    """
    for field in ("currentClassId", "classId"):
        out = []
        try:
            for d in school_ref.collection("students").where(field, "==", class_id).stream():
                data = d.to_dict() or {}
                if str(data.get("type") or "student") != "student" or _is_inactive_student(data):
                    continue
                out.append(d.id)
        except Exception as e:
            print(f"_class_roster: indexed lookup on {field} failed: {e}")
        if out:
            return out

    out = []

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


def _word_limits(n_ticked):
    """Length follows the teacher's input: about one short sentence per
    ticked statement. A fixed 40-70 words forced the model to pad a one- or
    two-tick student with invented detail."""
    return max(8, 8 * n_ticked), 14 * n_ticked + 6


def _looks_fancy(comment):
    lowered = comment.lower()
    return any(w in lowered for w in FANCY_WORDS)


def generate_smart_comment(ai, first_name, gender, category_label, ticked, used_openings=None):
    """One remark, scoped to a SINGLE remark category, from a student's
    ticked statements in that category. `ticked` is [{text, type}, ...] —
    already resolved, already filtered to items this student actually has
    ticked true, all belonging to `category_label`.

    The comment must say what the teacher ticked and nothing else — plain
    enough for any parent to read, about one short sentence per ticked
    statement. No invented examples, feelings, predictions or praise the
    teacher didn't tick.

    Categories are written up independently rather than blended into one
    combined paragraph — see module docstring for why (different teachers,
    different tabs, different sheets, different times).
    """
    used_openings = used_openings if used_openings is not None else set()
    pronoun = "He" if gender.strip().lower().startswith(("m", "boy")) else "She"
    his_her = "his" if pronoun == "He" else "her"

    positives = [i["text"] for i in ticked if i["type"] != "negative"]
    negatives = [i["text"] for i in ticked if i["type"] == "negative"]
    lines = [f"- {t}" for t in positives] + [f"- (needs to improve) {t}" for t in negatives]
    observations = "\n".join(lines)
    min_words, max_words = _word_limits(len(ticked))

    avoid = sorted(used_openings)[:8]
    avoid_line = ("\n- Do not start with any of these openings, already used for other "
                  f"students: {'; '.join(avoid)}" if avoid else "")

    prompt = f"""Write a short "{category_label}" remark for a school report card.

Student: {first_name} ({pronoun}/{his_her})

The teacher ticked ONLY these statements for this student:
{observations}

Rules:
- Say only what the ticked statements say. Do not add anything else: no examples, no events, no feelings, no predictions, no extra praise, no advice the teacher did not tick.
- Keep close to the teacher's own words. One short sentence for each statement, or join two related ones.
- Use very simple, everyday English that any parent can understand. Short sentences. No fancy or formal words.
- Start with {first_name}'s name. After that use {pronoun}/{his_her}.
- A "(needs to improve)" statement should be written kindly and simply, e.g. "{pronoun} needs to work on ..." or "{pronoun} should try to ...".
- Between {min_words} and {max_words} words.
- Return only the remark.{avoid_line}"""

    comment = ""
    for _ in range(3):
        resp = ai.chat.completions.create(
            model="gpt-4o-mini", max_tokens=200, temperature=0.4,
            messages=[{"role": "user", "content": prompt}],
        )
        comment = resp.choices[0].message.content.strip().strip('"')
        words = len(comment.split())
        opening = " ".join(comment.split()[:4]).lower()
        if (min_words <= words <= max_words and not _looks_fancy(comment)
                and opening not in used_openings):
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
    remark_bank, categories = _fetch_remark_bank(school_ref, band, class_id)
    category_labels = [c["label"] for c in categories]

    # No band is only blocking when it leaves this class with no remark bank
    # at all. Categories assigned to the class by classIds (what the teacher
    # app shows) still apply without one.
    if band is None and not categories:
        payload = {
            "band": None, "stageIssue": raw_stage, "classId": class_id,
            "students": 0, "roster": [], "categories": [], "sheetFound": False,
            "multipleSheetsFound": False, "genderIssue": None,
            "tickedStudents": 0, "unmatchedTicks": 0,
        }
        if scan_only:
            return payload
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT,
            f"This class's stage ('{raw_stage or 'not set'}') doesn't map to a known remark "
            "band (Foundational/Preparatory/Middle/Secondary), and no remark category lists "
            "this class. Set classes/{id}.stage before running smart remarks for this class.",
        )

    entries_by_student, sheet_refs, sheet_count = _fetch_merged_entries(school_ref, class_id)
    sheet_ids = [s.id for s in sheet_refs]

    # Anyone with an entries doc in this class's sheets was listed under this
    # class by the teacher app, so they belong on the roster even if the
    # roster queries resolved the class some other way.
    base_roster = _class_roster(school_ref, class_id)
    base_set = set(base_roster)
    candidate_ids = base_roster + sorted(sid for sid in entries_by_student if sid not in base_set)
    if only_student_ids:
        candidate_ids = [sid for sid in candidate_ids if sid in only_student_ids]
    students = _fetch_students(school_ref, candidate_ids)
    roster_ids = [sid for sid in candidate_ids
                  if sid in base_set or students.get(sid, {}).get("active")]
    roster_ids.sort(key=lambda sid: _roster_sort_key(sid, students.get(sid)))
    # tickedCount: boxes ticked true that resolve to a statement in this
    # class's remark bank — what generation will actually use. Lets the
    # dashboard tell "ticked, not generated yet" apart from "nothing ticked".
    roster = [{"id": sid, "name": students.get(sid, {}).get("name") or sid,
               "rollNo": students.get(sid, {}).get("rollNo") or "",
               "tickedCount": sum(1 for k, v in (entries_by_student.get(sid) or {}).items()
                                  if v and k in remark_bank)}
              for sid in roster_ids]

    if not sheet_refs:
        payload = {
            "band": band, "classId": class_id, "students": len(roster_ids), "roster": roster,
            "categories": category_labels, "sheetFound": False,
            "multipleSheetsFound": False, "genderIssue": None,
            "tickedStudents": 0, "unmatchedTicks": 0,
        }
        if scan_only:
            return payload
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT,
            "No remarks sheet exists yet for this class — nothing has been ticked by a teacher.",
        )

    g_issue = gender_issue(roster_ids, students)

    ticked_students = unmatched_ticks = 0
    for sid in roster_ids:
        true_keys = [k for k, v in (entries_by_student.get(sid) or {}).items() if v]
        if any(k in remark_bank for k in true_keys):
            ticked_students += 1
        unmatched_ticks += sum(1 for k in true_keys if k not in remark_bank)
    if unmatched_ticks:
        print(f"generate_smart_remarks: {school_id}/{class_id}: {unmatched_ticks} ticked key(s) "
              "match no remark_categories statement for this class")

    scan_payload = {
        "band": band, "classId": class_id, "students": len(roster_ids), "roster": roster,
        "categories": category_labels, "sheetFound": True,
        "multipleSheetsFound": sheet_count > 1, "genderIssue": g_issue,
        "tickedStudents": ticked_students, "unmatchedTicks": unmatched_ticks,
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
