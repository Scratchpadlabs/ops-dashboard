"""
Cloud Function: generate_aap_remarks (+ list_aap_remarks, update_aap_remark,
bulk_update_aap_remarks, save_aap_subject_mapping, generate_aap_summary_pdf,
generate_aap_summary_pdfs — same source directory)

Generates AAP (Awareness / Sensitivity / Creativity) student remarks
directly from Firestore survey responses -- no Google Sheets / Drive hop.

generate_aap_remarks is callable from the ops dashboard (httpsCallable,
region asia-south1): { school_id, class_id, student_ids?, subjects?,
scan_only?, confirm_gender_issue? }

  1. Reads AAP survey responses for that class from Firestore (survey ids
     prefixed "zzz")
  2. Resolves each student's Beginner/Proficient/Advanced rating per
     subject/trait -- same aggregation as extract_firestore.py's
     resolve_level
  3. Looks up name/gender straight from schools/{school}/students -- no
     separate Master Sheet
  4. Looks up descriptor text from the shared aap_framework collection
     (seed it once with migrate_aap_framework.py)
  5. Generates a 40-55 word comment per student/subject via OpenAI
  6. Writes to schools/{school}/students/{id}/aap_remarks/{subject}
  7. Tracks progress on schools/{school}/aap_jobs/{job_id} for the
     dashboard to poll

Skips anything already status == "approved", unless student_ids is passed
explicitly -- that's the dashboard's regenerate-this-one action.

Callers are checked against the ops-admin allowlist server-side
(functions/shared/ops_admins.py, shared with every other callable in this
repo) -- the /aap-remarks page is admin-only, but a page is not a security
boundary, and this function spends OpenAI credit and writes onto student
records.

DON'T GUESS, SURFACE AND GATE: three things that used to default silently now
block a real run (still visible read-only via scan_only) unless resolved:
  - an unrecognised grade token (no Stage to derive descriptor text from) --
    fix by adding the alias to functions/shared/education_kb.json, since
    grade bands are a fixed global taxonomy, not a per-school override
  - missing or suspiciously uniform gender across the class -- the caller
    must pass confirm_gender_issue: true, once the dashboard has shown the
    warning, to proceed anyway (there's no in-run fix; the record itself
    needs correcting)
  - a survey subject with no matching rubric row -- resolved via the
    dashboard's relate-subject dialog into aap_subject_map (subject_match.py)

Firestore access note: EVERYTHING here goes through the Admin SDK, including
listing/editing/approving remarks and confirming a subject mapping (the other
four callables below) -- deliberately, so this feature needs no
firestore.rules entry at all. `aap_jobs` progress polling is the one piece
the dashboard reads directly, and that needs no rule either since it's a path
the generic schools/{schoolId}/{collection}/{docId} rule already covers.

Still worth knowing about the schema:
  - gender on student docs is CONFIRMED: the field is "gender", canonicalised
    to "Male"/"Female" by the import pipeline (clean_gender in
    generate_import/normalize.py) and declared in src/schemas/schoolSchema.js.
    Note the silent default in generate_comment -- a student whose gender is
    blank or unrecognised is written about as "She" unless the gender-issue
    gate above catches it first.
  - fetch_survey_ratings scans every zzz-prefixed response for the school
    and filters to one class in memory. Fine for a single-class run; if
    this ever needs to run across a whole school in one go, worth adding
    a classSection field to response docs at write time so it's a real
    query instead of a scan -- that write path lives in a separate
    teacher-facing app, not in this repo, so it isn't something this
    function alone can fix.
  - Sequential, not concurrent: one OpenAI call at a time with a small pause
    between them, so a very large class risks the 540s function timeout.
    Not chunked/parallelized -- only one class has been run for real so far.
    If a class run approaches the timeout, that's the trigger to revisit
    this, not something to build ahead of evidence for.

Deploy the same way as the other functions in functions/DEPLOY.md -- same
region (asia-south1), same OPENAI_API_KEY Secret Manager pattern already
used for process_import.
"""

import base64
import datetime
import io
import math
import random
import re
import time
import zipfile
from collections import defaultdict

from firebase_admin import initialize_app, firestore
from firebase_functions import https_fn, options
from firebase_functions.params import SecretParam
from openai import OpenAI
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from aap_rules import canonical_grade_section, gender_issue as _compute_gender_issue, resolve_stage
from ops_admins import require_ops_admin as _require_ops_admin_base
from subject_match import (
    build_subject_index, normalize_subject, opening_signature, resolve_subject,
)

try:
    initialize_app()
except ValueError:
    pass  # already initialized in this environment

db = firestore.client()
OPENAI_API_KEY = SecretParam("OPENAI_API_KEY")

# Confirmed "this survey subject means this rubric row" mappings, written by
# the dashboard's relate-subject dialog. Global, not per school -- the same
# self-learning shape as import_aliases and kb_entries: one confirmation, and
# every school spelling a subject that way resolves from then on.
SUBJECT_MAP_COLLECTION = "aap_subject_map"

LEVEL_ORDER = {"Beginner": 1, "Proficient": 2, "Advanced": 3}
LEVEL_NAME = {1: "Beginner", 2: "Proficient", 3: "Advanced"}

# Prompt variation. A class of 18 comments drawn from one style instruction
# reads as 18 copies of the same sentence -- the first live run produced nine
# in a row opening "<Name> shows ...". The pools are combined independently
# (starter x focus x shape x closing), so the number of distinct instructions
# is their product rather than their length, and generate_comment additionally
# refuses an opening already used elsewhere in the same run.
SENTENCE_STARTERS = [
    "begins with the student's name and their strongest quality",
    "opens with what makes this student stand out in the subject",
    "leads with the student's creative strengths",
    "starts by highlighting how the student engages with others",
    "opens with the student's awareness and understanding",
    "begins by describing the student's sensitivity and empathy",
    "starts with the student's approach to problem-solving",
    "leads with how the student expresses original ideas",
    "opens on something the student did in class, then widens out",
    "starts with what classmates would say about this student",
    "begins with the student's curiosity and the questions they ask",
    "opens with how the student handles something difficult",
    "leads with the care the student puts into their work",
    "starts with a moment that shows this student's character",
]
FOCUS_STYLES = [
    "Focus more on the creativity descriptor, briefly mention the others.",
    "Focus more on the sensitivity descriptor, briefly mention the others.",
    "Focus more on the awareness descriptor, briefly mention the others.",
    "Give equal weight to all three descriptors.",
    "Blend all three into one seamless observation without separating them.",
    "Lead with two descriptors together, then close on the third.",
]
SENTENCE_SHAPES = [
    "Use three sentences of roughly even length.",
    "Use two longer sentences.",
    "Open with a short sentence, then two fuller ones.",
    "Use four short, warm sentences.",
    "Vary the sentence lengths noticeably across the comment.",
]
CLOSINGS = [
    "End with something the student can build on next term.",
    "End on what the teacher looks forward to seeing.",
    "End with a warm sentence about the student as a classmate.",
    "End on the student's own enjoyment of the subject.",
    "End with a specific encouragement, not a general one.",
]


def _require_ops_admin(req: https_fn.CallableRequest) -> str:
    """Verifies the callable's Firebase Auth token and the ops-admin
    allowlist server-side. Returns the caller's email, recorded on the job
    doc so a run that spent money and rewrote remarks has a name against it.

    Deployed with --allow-unauthenticated, which only lets the request reach
    the function at the IAM layer -- without this check every signed-in user
    of every app on this project, teachers included, could invoke it.
    """
    return _require_ops_admin_base(req, "Not authorized to generate AAP remarks.")


def get_first_name(full_name):
    parts = full_name.strip().split()
    if not parts:
        return full_name
    parts = [p.capitalize() for p in parts]
    if re.match(r"^[A-Z]\.$", parts[0]):
        return " ".join(parts[:2])
    return parts[0]


def resolve_level(raw_levels):
    """Same aggregation as extract_firestore.py's resolve_level, adapted to
    plain 'Beginner'/'Proficient'/'Advanced' prefixes instead of the
    '(LOW)'/'(MEDIUM)'/'(HIGH)' suffixed survey values."""
    normalised = []
    for lvl in raw_levels:
        for key in LEVEL_ORDER:
            if lvl.startswith(key):
                normalised.append(LEVEL_ORDER[key])
                break
    if not normalised:
        return "Proficient"
    if len(normalised) == 1:
        score = normalised[0]
    elif len(normalised) == 2:
        a, b = normalised
        diff = abs(a - b)
        score = a if diff == 0 else max(a, b) if diff == 1 else 2
    else:
        score = max(1, min(3, math.ceil(sum(normalised) / len(normalised))))
    return LEVEL_NAME[score]


def fetch_survey_ratings(school_id, class_id):
    """Returns (ratings, unparsed_response_count).

    ratings is {student_id: {subject: {awareness, sensitivity, creativity}}}
    for one class, resolved from raw survey responses.

    unparsed_response_count is how many response docs across the WHOLE
    SCHOOL scan had an id this function's doc-id convention could not
    recover grade/section/subject from at all -- a structural parse
    failure, not simply "this response belongs to a different class". It is
    surfaced by scan_only rather than silently dropped, because a response
    doc naming convention this function does not control (see module
    docstring) failing silently is exactly how a class can be under-counted
    without anyone noticing.
    """
    school_ref = db.collection("schools").document(school_id)
    raw = defaultdict(lambda: defaultdict(lambda: defaultdict(list)))
    target_grade_raw, _, target_section_raw = class_id.partition("_")
    target = canonical_grade_section(target_grade_raw, target_section_raw)
    unparsed = 0

    for survey_doc in school_ref.collection("surveys").stream():
        if not survey_doc.id.lower().startswith("zzz"):
            continue
        responses = (school_ref.collection("surveys").document(survey_doc.id)
                     .collection("responses").stream())
        for resp in responses:
            # doc id: teacherID_grade_section..._grade_subject_topic
            parts = resp.id.split("_")
            if len(parts) < 5:
                unparsed += 1
                continue
            grade = parts[1]
            second_idx = next((i for i in range(2, len(parts)) if parts[i] == grade), None)
            if second_idx is None:
                unparsed += 1
                continue
            section = "_".join(parts[2:second_idx])
            subject = parts[second_idx + 1]
            # Canonical comparison, not raw string equality: a response
            # spelling its grade "1" and the class doc spelling it "I" are
            # the same class once both go through the shared grade index.
            if canonical_grade_section(grade, section) != target:
                continue

            answers = resp.to_dict().get("answers", [])
            for q_index, trait in enumerate(["awareness", "sensitivity", "creativity"]):
                if q_index >= len(answers):
                    break
                for student_id, level_str in answers[q_index].items():
                    if student_id == "questionText" or not level_str or level_str == "Not Applicable":
                        continue
                    raw[student_id][subject][trait].append(level_str)

    # A subject only reaches `raw` once at least one of its three questions was
    # answered (blank / "Not Applicable" answers are never appended above) --
    # that is what makes a student who never appeared for an optional subject
    # (Hindi/Marathi/Sanskrit split) resolve to no subject entry at all, with
    # no remark generated for it. But a subject that DID get at least one
    # answer may still be missing one or two of its three traits, and those
    # must not be treated as "never appeared" -- the school's convention is
    # that a trait nobody rated defaults to the most favourable level rather
    # than blocking or silently dropping the whole subject.
    ratings = {}
    for student_id, subjects in raw.items():
        ratings[student_id] = {}
        for subject, traits in subjects.items():
            resolved = {trait: resolve_level(levels) for trait, levels in traits.items()}
            for trait in ("awareness", "sensitivity", "creativity"):
                resolved.setdefault(trait, "Advanced")
            ratings[student_id][subject] = resolved
    return ratings, unparsed


def fetch_students(school_id, student_ids):
    school_ref = db.collection("schools").document(school_id)
    refs = [school_ref.collection("students").document(sid) for sid in student_ids]
    out = {}
    for doc in db.get_all(refs):
        if not doc.exists:
            continue
        data = doc.to_dict()
        name = f"{data.get('firstName', '')} {data.get('lastName', '')}".strip() or doc.id
        out[doc.id] = {"name": name, "gender": data.get("gender", "")}
    return out


def fetch_framework(stage):
    """The rubric rows for one stage, indexed for lookup by a survey's subject
    token. See subject_match.py for why a flat dict on the "subject" field
    reaches almost none of them.

    Sorted by doc id before indexing so an alias two rows both claim always
    resolves the same way run to run.
    """
    docs = sorted(db.collection("aap_framework").where("stage", "==", stage).stream(),
                  key=lambda d: d.id)
    return build_subject_index([d.to_dict() or {} for d in docs])


def fetch_subject_overrides(stage):
    """Confirmed token -> framework label mappings from the dashboard's
    "relate this subject" dialog. Keyed by stage because the same word means
    different rubric rows at different stages: "Science" is the EVS row in
    Middle and part of "World Around Us" in Preparatory.
    """
    docs = db.collection(SUBJECT_MAP_COLLECTION).where("stage", "==", stage).stream()
    out = {}
    for d in docs:
        data = d.to_dict() or {}
        token = normalize_subject(data.get("token"))
        label = str(data.get("frameworkSubject") or "").strip()
        if token and label:
            out[token] = label
    return out


def generate_comment(ai, first_name, gender, subject, aw, sen, cre, used_openings=None):
    """One comment. `used_openings` is the set of opening phrasings already
    written in THIS run — a repeat is retried rather than accepted, which is
    what stops a class reading as one sentence with the names swapped."""
    used_openings = used_openings if used_openings is not None else set()
    pronoun = "He" if gender.strip().lower().startswith(("m", "boy")) else "She"
    his_her = "his" if pronoun == "He" else "her"

    # Sampled per comment, not per run: the point is that two students in the
    # same class get different instructions.
    avoid = sorted(used_openings)[:8]
    avoid_line = ("\n- Do NOT open with any of these phrasings, already used for "
                  f"other students in this class: {'; '.join(avoid)}" if avoid else "")

    prompt = f"""You are a warm, caring schoolteacher writing a report card comment for a young student.

Student first name: {first_name}
Pronoun: {pronoun}/{his_her}
Subject: {subject}

Awareness observation: {aw}
Sensitivity observation: {sen}
Creativity observation: {cre}

Style instructions:
- The comment {random.choice(SENTENCE_STARTERS)}
- {random.choice(FOCUS_STYLES)}
- {random.choice(SENTENCE_SHAPES)}
- {random.choice(CLOSINGS)}
- Write like a real teacher -- simple, warm, everyday language parents and children understand easily
- Mention the subject '{subject}' naturally
- Use {first_name}'s name once at the start
- Use correct pronoun ({pronoun}/{his_her})
- Avoid formal/robotic phrases like "learning community", "valued member", "demonstrates proficiency"
- MUST be between 40 and 55 words
- Return only the comment, nothing else{avoid_line}"""

    comment = ""
    for _ in range(3):
        resp = ai.chat.completions.create(
            model="gpt-4o-mini", max_tokens=300, temperature=1.0,
            messages=[{"role": "user", "content": prompt}],
        )
        comment = resp.choices[0].message.content.strip()
        opening = opening_signature(comment, first_name)
        if 40 <= len(comment.split()) <= 55 and opening not in used_openings:
            break
    # Whatever the last attempt produced is still returned — a comment that
    # runs long or echoes another opening is a review note, not a reason to
    # leave a student with no remark at all.
    used_openings.add(opening_signature(comment, first_name))
    return comment


@https_fn.on_call(region="asia-south1", secrets=[OPENAI_API_KEY],
                   memory=options.MemoryOption.MB_512, timeout_sec=540)
def generate_aap_remarks(req: https_fn.CallableRequest) -> dict:
    caller = _require_ops_admin(req)
    data = req.data or {}
    school_id = data.get("school_id")
    class_id = data.get("class_id")
    only_student_ids = set(data.get("student_ids", []))
    # Subject scope. Empty means every subject the survey rated, which is the
    # whole-class default; a list narrows the run without touching the rest.
    only_subjects = {normalize_subject(s) for s in (data.get("subjects") or []) if str(s).strip()}
    # Reads and resolves, writes nothing, calls no model. Backs the subject
    # picker and the "relate this subject" dialog, which both need to know
    # what the survey actually says BEFORE a run is worth starting.
    scan_only = bool(data.get("scan_only"))
    # Must be set once the dashboard has shown the gender-quality warning
    # (see _gender_issue) and the user chose to proceed anyway.
    confirm_gender_issue = bool(data.get("confirm_gender_issue"))

    if not school_id or not class_id:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT,
            "school_id and class_id are required",
        )

    grade_token = class_id.split("_")[0]
    stage = resolve_stage(grade_token)
    if stage is None:
        # No Stage means no rubric to look up -- there is nothing a real run
        # could do here that wouldn't be a guess. Reported the same way in
        # scan_only and blocked the same way for a real run, unlike subjects
        # or gender: a grade taxonomy gap has no per-run workaround, it needs
        # the alias added to education_kb.json.
        payload = {
            "stage": None, "classId": class_id, "stageIssue": grade_token,
            "students": 0, "subjects": [], "frameworkSubjects": [],
            "aliasConflicts": [], "unmatchedSubjects": [],
            "genderIssue": None, "unresolvedResponses": 0,
        }
        if scan_only:
            return payload
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT,
            f"Grade '{grade_token}' is not recognised. Add it to "
            "functions/shared/education_kb.json before running AAP remarks "
            "for this class.",
        )

    ratings, unresolved_responses = fetch_survey_ratings(school_id, class_id)
    if only_student_ids:
        ratings = {sid: s for sid, s in ratings.items() if sid in only_student_ids}

    # Needed for both the gender scan below and generation itself, so fetched
    # once, before the scan_only early return.
    students = fetch_students(school_id, list(ratings.keys()))
    gender_issue = _compute_gender_issue(ratings, students)

    by_label, alias_index, alias_conflicts = fetch_framework(stage)
    overrides = fetch_subject_overrides(stage)

    # Resolve every subject ONCE per run rather than per student: the answer
    # cannot differ between two students in the same class, and the inventory
    # is what both the scan and the unmatched report are built from.
    inventory = {}
    for subjects in ratings.values():
        for subject in subjects:
            row = inventory.setdefault(subject, {
                "subject": subject, "students": 0, "matched": None, "how": None,
            })
            row["students"] += 1
    for subject, row in inventory.items():
        fw, how = resolve_subject(subject, by_label, alias_index, overrides)
        row["matched"] = fw.get("subject") if fw else None
        row["how"] = how
        row["_fw"] = fw

    in_scope = [s for s in inventory
                if not only_subjects or normalize_subject(s) in only_subjects]
    unmatched = sorted(
        ({"subject": s, "students": inventory[s]["students"]}
         for s in in_scope if not inventory[s]["matched"]),
        key=lambda r: r["subject"],
    )
    scan_payload = {
        "stage": stage,
        "classId": class_id,
        "students": len(ratings),
        "subjects": sorted(
            ({k: v for k, v in row.items() if k != "_fw"} for row in inventory.values()),
            key=lambda r: r["subject"],
        ),
        # The rubric rows for this stage, so the dialog can offer them without
        # the browser needing to read aap_framework itself.
        "frameworkSubjects": sorted(by_label),
        "aliasConflicts": alias_conflicts,
        "unmatchedSubjects": unmatched,
        "genderIssue": gender_issue,
        "unresolvedResponses": unresolved_responses,
    }
    if scan_only:
        return scan_payload

    if gender_issue and not confirm_gender_issue:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT,
            "Gender data looks incomplete or suspicious for this class — "
            "confirm before generating (confirm_gender_issue).",
        )

    ai = OpenAI(api_key=OPENAI_API_KEY.value)

    total = sum(1 for subjects in ratings.values() for s in subjects
                if not only_subjects or normalize_subject(s) in only_subjects)
    job_ref = db.collection("schools").document(school_id).collection("aap_jobs").document()
    job_ref.set({
        "classId": class_id, "status": "running",
        "startedAt": firestore.SERVER_TIMESTAMP, "startedBy": caller,
        "totalStudents": total, "processedStudents": 0,
        "subjects": sorted(in_scope),
        "unmatchedSubjects": [r["subject"] for r in unmatched],
    })

    # Openings already used in this run, per subject: a student's Maths and
    # English comments may legitimately sound alike, but two students' Maths
    # comments must not.
    used_openings = defaultdict(set)
    processed = written = skipped_approved = skipped_no_framework = 0

    try:
        for student_id, subjects in ratings.items():
            info = students.get(student_id, {"name": student_id, "gender": ""})
            first_name = get_first_name(info["name"])

            for subject, levels in subjects.items():
                if only_subjects and normalize_subject(subject) not in only_subjects:
                    continue

                doc_ref = (db.collection("schools").document(school_id)
                           .collection("students").document(student_id)
                           .collection("aap_remarks").document(subject))
                existing = doc_ref.get()
                if (existing.exists and existing.to_dict().get("status") == "approved"
                        and not only_student_ids):
                    processed += 1
                    skipped_approved += 1
                    continue

                fw = inventory[subject]["_fw"]
                if not fw:
                    processed += 1
                    skipped_no_framework += 1
                    continue

                aw_text = fw.get("awareness", {}).get(levels["awareness"].lower(), "")
                sen_text = fw.get("sensitivity", {}).get(levels["sensitivity"].lower(), "")
                cre_text = fw.get("creativity", {}).get(levels["creativity"].lower(), "")

                comment = generate_comment(ai, first_name, info["gender"], subject,
                                           aw_text, sen_text, cre_text,
                                           used_openings=used_openings[subject])

                doc_ref.set({
                    "awareness": levels["awareness"], "sensitivity": levels["sensitivity"],
                    "creativity": levels["creativity"], "comment": comment,
                    "frameworkSubject": fw.get("subject", ""), "matchedBy": inventory[subject]["how"],
                    "status": "needs_review", "updatedAt": firestore.SERVER_TIMESTAMP,
                })
                processed += 1
                written += 1
                job_ref.update({"processedStudents": processed, "writtenRemarks": written})
                time.sleep(0.3)
    except Exception as e:
        # Without this the job doc stays "running" for ever and the dashboard's
        # progress bar has no way to know the run died.
        job_ref.update({
            "status": "failed", "error": str(e)[:500],
            "completedAt": firestore.SERVER_TIMESTAMP,
            "processedStudents": processed, "writtenRemarks": written,
        })
        raise

    job_ref.update({
        "status": "done", "completedAt": firestore.SERVER_TIMESTAMP,
        "processedStudents": processed, "writtenRemarks": written,
        "skippedApproved": skipped_approved, "skippedNoFramework": skipped_no_framework,
    })
    # `processed` counts every record CONSIDERED, `written` only those that got
    # a comment. Reporting one number for both is what made a run that wrote
    # nothing announce "126 remarks processed".
    return {
        "jobId": job_ref.id,
        "processed": processed,
        "written": written,
        "skippedApproved": skipped_approved,
        "skippedNoFramework": skipped_no_framework,
        **scan_payload,
    }


def _serialize_remark(subject, data):
    """A remark doc as the callable can return it: Firestore's
    DatetimeWithNanoseconds on updatedAt isn't JSON-serializable as-is."""
    out = {"id": subject, **data}
    updated_at = out.get("updatedAt")
    if updated_at is not None and hasattr(updated_at, "isoformat"):
        out["updatedAt"] = updated_at.isoformat()
    return out


@https_fn.on_call(region="asia-south1", memory=options.MemoryOption.MB_256, timeout_sec=60)
def list_aap_remarks(req: https_fn.CallableRequest) -> dict:
    """{school_id, student_ids} -> {studentId: [remark, ...]}, one callable
    read for the whole roster instead of a direct client Firestore read —
    see module docstring for why this feature has no firestore.rules entry.
    """
    _require_ops_admin(req)
    data = req.data or {}
    school_id = data.get("school_id")
    student_ids = list(data.get("student_ids") or [])
    if not school_id or not student_ids:
        return {}

    school_ref = db.collection("schools").document(school_id)
    out = {}
    for student_id in student_ids:
        docs = (school_ref.collection("students").document(student_id)
                .collection("aap_remarks").stream())
        rows = sorted(
            (_serialize_remark(d.id, d.to_dict() or {}) for d in docs),
            key=lambda r: r["id"],
        )
        out[student_id] = rows
    return out


@https_fn.on_call(region="asia-south1", memory=options.MemoryOption.MB_256, timeout_sec=30)
def update_aap_remark(req: https_fn.CallableRequest) -> dict:
    """{school_id, student_id, subject, comment?, status?} -> {}.

    Saving an edited comment approves it in the same call: someone who has
    read the text closely enough to change it has reviewed it, and a
    separate "now approve it" click would only be a way to forget. Passing
    only `status` (no `comment`) is the plain approve/needs-review toggle.
    """
    caller = _require_ops_admin(req)
    data = req.data or {}
    school_id = data.get("school_id")
    student_id = data.get("student_id")
    subject = data.get("subject")
    if not school_id or not student_id or not subject:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT,
            "school_id, student_id and subject are required",
        )

    update = {"updatedAt": firestore.SERVER_TIMESTAMP, "updatedBy": caller}
    if data.get("comment") is not None:
        update["comment"] = data["comment"]
        update["status"] = "approved"
    if data.get("status") is not None:
        update["status"] = data["status"]

    (db.collection("schools").document(school_id).collection("students").document(student_id)
        .collection("aap_remarks").document(subject)).set(update, merge=True)
    return {}


@https_fn.on_call(region="asia-south1", memory=options.MemoryOption.MB_256, timeout_sec=120)
def bulk_update_aap_remarks(req: https_fn.CallableRequest) -> dict:
    """{school_id, targets: [{student_id, subject}], status} -> {updated}.

    Flips many remarks in one call. Batched server-side at the same 450
    chunk size the rest of this repo uses (Firestore's own cap is 500) —
    approving a 40-student class across 7 subjects is 280 documents, and a
    partially-applied bulk action is worse than one that didn't run.
    """
    caller = _require_ops_admin(req)
    data = req.data or {}
    school_id = data.get("school_id")
    targets = data.get("targets") or []
    status = data.get("status")
    if not school_id or not targets or not status:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT,
            "school_id, targets and status are required",
        )

    stamp = {"status": status, "updatedAt": firestore.SERVER_TIMESTAMP, "updatedBy": caller}
    school_ref = db.collection("schools").document(school_id)
    chunk = 450
    for i in range(0, len(targets), chunk):
        batch = db.batch()
        for t in targets[i:i + chunk]:
            doc_ref = (school_ref.collection("students").document(t["student_id"])
                       .collection("aap_remarks").document(t["subject"]))
            batch.set(doc_ref, stamp, merge=True)
        batch.commit()
    return {"updated": len(targets)}


@https_fn.on_call(region="asia-south1", memory=options.MemoryOption.MB_256, timeout_sec=30)
def save_aap_subject_mapping(req: https_fn.CallableRequest) -> dict:
    """{stage, token, framework_subject} -> {}.

    Confirms that a survey's subject token means a particular rubric row.
    Global by decision: one confirmation resolves that spelling for every
    school, the same self-learning shape as import_aliases/kb_entries. Keyed
    by stage as well as token because "Science" is a different rubric row in
    Middle than in Preparatory. `token` is normalised the same way
    subject_match.py's matcher normalises it, so the id this writes and the
    id fetch_subject_overrides reads back can never drift apart.
    """
    caller = _require_ops_admin(req)
    data = req.data or {}
    stage = str(data.get("stage") or "").strip()
    token = str(data.get("token") or "").strip()
    framework_subject = str(data.get("framework_subject") or "").strip()
    if not stage or not token or not framework_subject:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT,
            "stage, token and framework_subject are required",
        )

    doc_id = f"{stage}_{normalize_subject(token)}"
    db.collection(SUBJECT_MAP_COLLECTION).document(doc_id).set({
        "stage": stage,
        "token": token,
        "frameworkSubject": framework_subject,
        "confirmedBy": caller,
        "confirmedAt": firestore.SERVER_TIMESTAMP,
    }, merge=True)
    return {}


# ── Per-student summary PDF ─────────────────────────────────────────────────
# One page per child: "Summary For The Academic Year" — a table of every
# subject the student has an aap_remarks doc for, its three trait levels and
# the written comment. A subject the student never appeared for (an optional
# language stream, say) has no aap_remarks doc at all (see fetch_survey_ratings
# above), so it never reaches this table — nothing here has to re-check that.

_NAVY = colors.HexColor("#1c3a5e")
_GOLD = colors.HexColor("#f2b632")
_ROW_BG = colors.HexColor("#f7f8f9")
_BORDER = colors.HexColor("#d6dbe0")
_LEVEL_COLOR = {
    "Beginner": colors.HexColor("#d97706"),
    "Proficient": colors.HexColor("#16a34a"),
    "Advanced": colors.HexColor("#15803d"),
}


def _pdf_style(name, **kwargs):
    defaults = dict(fontName="Helvetica", fontSize=9.5, leading=13, textColor=colors.HexColor("#0f172a"))
    defaults.update(kwargs)
    return ParagraphStyle(name, **defaults)


def _watermark(student_id):
    """Stamped at the bottom of the page so a loose printout or a file that
    gets separated from the rest can still be traced back to a child."""
    def draw(canvas_obj, doc):
        canvas_obj.saveState()
        canvas_obj.setFont("Helvetica", 7.5)
        canvas_obj.setFillColor(colors.HexColor("#9ca3af"))
        canvas_obj.drawCentredString(A4[0] / 2, 10 * mm, f"Student ID: {student_id}")
        canvas_obj.restoreState()
    return draw


def _build_student_summary_pdf(student_id, remarks):
    """remarks: [{ id (subject), awareness, sensitivity, creativity, comment }],
    already limited to subjects this student actually has a remark doc for.
    Returns the PDF as bytes."""
    W, H = A4
    M = 12 * mm
    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, leftMargin=M, rightMargin=M,
                             topMargin=0, bottomMargin=18 * mm)
    story = []

    header = Table(
        [[Paragraph("Summary For The Academic Year",
                     _pdf_style("hdr", fontName="Helvetica-Bold", fontSize=18,
                                textColor=colors.white, alignment=TA_CENTER))]],
        colWidths=[W - 2 * M], rowHeights=[16 * mm],
    )
    header.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), _NAVY),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ]))
    story.append(header)

    gold = Table([[""]], colWidths=[W - 2 * M], rowHeights=[3 * mm])
    gold.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), _GOLD)]))
    story.append(gold)
    story.append(Spacer(1, 6 * mm))

    col_w = [(W - 2 * M) * x for x in [0.16, 0.14, 0.20, 0.50]]
    rows = [[
        Paragraph("<b>Subjects</b>", _pdf_style("th", fontSize=11)),
        Paragraph("<b>Abilities</b>", _pdf_style("th", fontSize=11)),
        Paragraph("<b>Performance Level Descriptors</b>", _pdf_style("th", fontSize=11)),
        Paragraph("<b>Summary</b>", _pdf_style("th", fontSize=11)),
    ]]
    spans, shading = [], []
    r = 1
    for remark in remarks:
        subject = remark.get("id", "")
        comment = remark.get("comment", "")
        start = r
        for trait, label in (("awareness", "Awareness"), ("sensitivity", "Sensitivity"),
                              ("creativity", "Creativity")):
            level = remark.get(trait) or ""
            rows.append([
                Paragraph(f"<b>{subject}</b>", _pdf_style("subj")) if trait == "awareness" else "",
                Paragraph(label, _pdf_style("ab")),
                Paragraph(f"<b>{level}</b>", _pdf_style("lvl", textColor=_LEVEL_COLOR.get(level, colors.black))),
                Paragraph(comment, _pdf_style("cm")) if trait == "awareness" else "",
            ])
            r += 1
        spans.append(("SPAN", (0, start), (0, start + 2)))
        spans.append(("SPAN", (3, start), (3, start + 2)))
        if len(shading) % 2 == 0:
            shading.append(("BACKGROUND", (0, start), (-1, start + 2), _ROW_BG))
        else:
            shading.append(("BACKGROUND", (0, start), (-1, start + 2), colors.white))

    table = Table(rows, colWidths=col_w, repeatRows=1)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), _GOLD),
        ("GRID", (0, 0), (-1, -1), 0.5, _BORDER),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE" if len(rows) == 1 else "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        *spans,
        *shading,
    ]))
    story.append(table)

    if not remarks:
        story.append(Spacer(1, 6 * mm))
        story.append(Paragraph("No AAP remarks found for this student.", _pdf_style("empty", textColor=colors.grey)))

    doc.build(story, onFirstPage=_watermark(student_id), onLaterPages=_watermark(student_id))
    return buf.getvalue()


def _fetch_student_remarks(school_ref, student_id):
    docs = (school_ref.collection("students").document(student_id)
            .collection("aap_remarks").stream())
    return sorted((_serialize_remark(d.id, d.to_dict() or {}) for d in docs),
                  key=lambda rmk: rmk["id"])


def _fetch_student_name(school_ref, student_id):
    doc = school_ref.collection("students").document(student_id).get()
    if not doc.exists:
        return student_id
    data = doc.to_dict() or {}
    return f"{data.get('firstName', '')} {data.get('lastName', '')}".strip() or student_id


@https_fn.on_call(region="asia-south1", memory=options.MemoryOption.MB_256, timeout_sec=60)
def generate_aap_summary_pdf(req: https_fn.CallableRequest) -> dict:
    """{school_id, student_id} -> {filename, mime, content_base64}.

    One "Summary For The Academic Year" page for one child, built from
    whatever aap_remarks docs already exist for them — nothing here calls the
    model or writes anything. Same ops-admin gate as the rest of this feature.
    """
    _require_ops_admin(req)
    data = req.data or {}
    school_id = data.get("school_id")
    student_id = data.get("student_id")
    if not school_id or not student_id:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT,
            "school_id and student_id are required",
        )

    school_ref = db.collection("schools").document(school_id)
    remarks = _fetch_student_remarks(school_ref, student_id)
    pdf_bytes = _build_student_summary_pdf(student_id, remarks)

    return {
        "filename": f"{student_id}.pdf",
        "mime": "application/pdf",
        "content_base64": base64.b64encode(pdf_bytes).decode("ascii"),
    }


@https_fn.on_call(region="asia-south1", memory=options.MemoryOption.MB_512, timeout_sec=300)
def generate_aap_summary_pdfs(req: https_fn.CallableRequest) -> dict:
    """{school_id, student_ids} -> {filename, mime, content_base64} (a zip).

    Bulk form of generate_aap_summary_pdf — one PDF per student inside a zip,
    each named "<student_id>.pdf" so the caller can match files back to
    children for whatever merge/print step they run next, outside this
    dashboard.
    """
    _require_ops_admin(req)
    data = req.data or {}
    school_id = data.get("school_id")
    student_ids = list(data.get("student_ids") or [])
    if not school_id or not student_ids:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT,
            "school_id and student_ids are required",
        )

    school_ref = db.collection("schools").document(school_id)
    zip_buf = io.BytesIO()
    with zipfile.ZipFile(zip_buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for student_id in student_ids:
            remarks = _fetch_student_remarks(school_ref, student_id)
            pdf_bytes = _build_student_summary_pdf(student_id, remarks)
            zf.writestr(f"{student_id}.pdf", pdf_bytes)

    date_str = datetime.date.today().isoformat()
    return {
        "filename": f"AAP_summary_pdfs_{school_id}_{date_str}.zip",
        "mime": "application/zip",
        "content_base64": base64.b64encode(zip_buf.getvalue()).decode("ascii"),
    }
