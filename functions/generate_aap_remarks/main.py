"""
Cloud Function: generate_aap_remarks

Generates AAP (Awareness / Sensitivity / Creativity) student remarks
directly from Firestore survey responses -- no Google Sheets / Drive hop.

Callable from the ops dashboard (httpsCallable, region asia-south1):
  { school_id, class_id, student_ids? }

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

Callers are checked against the ops-admin allowlist server-side, the same as
every other callable in this repo -- the /aap-remarks page is admin-only, but
a page is not a security boundary, and this function spends OpenAI credit and
writes onto student records.

Still worth knowing about the schema:
  - gender on student docs is CONFIRMED: the field is "gender", canonicalised
    to "Male"/"Female" by the import pipeline (clean_gender in
    generate_import/normalize.py) and declared in src/schemas/schoolSchema.js.
    Note the silent default in generate_comment -- a student whose gender is
    blank or unrecognised is written about as "She".
  - fetch_survey_ratings scans every zzz-prefixed response for the school
    and filters to one class in memory. Fine for a single-class run; if
    this ever needs to run across a whole school in one go, worth adding
    a classSection field to response docs at write time so it's a real
    query instead of a scan.

Deploy the same way as the other functions in functions/DEPLOY.md -- same
region (asia-south1), same OPENAI_API_KEY Secret Manager pattern already
used for process_import.
"""

import math
import random
import re
import time
from collections import defaultdict

from firebase_admin import initialize_app, firestore
from firebase_functions import https_fn, options
from firebase_functions.params import SecretParam
from openai import OpenAI

from subject_match import (
    build_subject_index, normalize_subject, opening_signature, resolve_subject,
)

try:
    initialize_app()
except ValueError:
    pass  # already initialized in this environment

db = firestore.client()
OPENAI_API_KEY = SecretParam("OPENAI_API_KEY")

# Keep in sync with src/config/opsAdmins.js and the allowlists in
# assign_survey/main.py and generate_import/main.py.
OPS_ADMIN_EMAILS = {"sid@ops.clarified.in", "angel@ops.clarified.in"}

# Confirmed "this survey subject means this rubric row" mappings, written by
# the dashboard's relate-subject dialog. Global, not per school -- the same
# self-learning shape as import_aliases and kb_entries: one confirmation, and
# every school spelling a subject that way resolves from then on.
SUBJECT_MAP_COLLECTION = "aap_subject_map"

GRADE_TO_STAGE = {
    "NURSERY": "Foundation", "LKG": "Foundation", "UKG": "Foundation",
    "I": "Foundation", "II": "Foundation",
    "III": "Preparatory", "IV": "Preparatory", "V": "Preparatory",
    "VI": "Middle", "VII": "Middle", "VIII": "Middle",
    "IX": "Middle", "X": "Middle", "XI": "Middle", "XII": "Middle",
}
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
    if req.auth is None:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.UNAUTHENTICATED, "Sign in required.")
    email = str((req.auth.token or {}).get("email") or "").strip().lower()
    if email not in OPS_ADMIN_EMAILS:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.PERMISSION_DENIED,
            "Not authorized to generate AAP remarks.")
    return email


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
    """Returns {student_id: {subject: {awareness, sensitivity, creativity}}}
    for one class, resolved from raw survey responses."""
    school_ref = db.collection("schools").document(school_id)
    raw = defaultdict(lambda: defaultdict(lambda: defaultdict(list)))

    for survey_doc in school_ref.collection("surveys").stream():
        if not survey_doc.id.lower().startswith("zzz"):
            continue
        responses = (school_ref.collection("surveys").document(survey_doc.id)
                     .collection("responses").stream())
        for resp in responses:
            # doc id: teacherID_grade_section..._grade_subject_topic
            parts = resp.id.split("_")
            if len(parts) < 5:
                continue
            grade = parts[1]
            second_idx = next((i for i in range(2, len(parts)) if parts[i] == grade), None)
            if second_idx is None:
                continue
            section = "_".join(parts[2:second_idx])
            subject = parts[second_idx + 1]
            if f"{grade}_{section}" != class_id:
                continue

            answers = resp.to_dict().get("answers", [])
            for q_index, trait in enumerate(["awareness", "sensitivity", "creativity"]):
                if q_index >= len(answers):
                    break
                for student_id, level_str in answers[q_index].items():
                    if student_id == "questionText" or not level_str or level_str == "Not Applicable":
                        continue
                    raw[student_id][subject][trait].append(level_str)

    return {
        student_id: {
            subject: {trait: resolve_level(levels) for trait, levels in traits.items()}
            for subject, traits in subjects.items()
        }
        for student_id, subjects in raw.items()
    }


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

    if not school_id or not class_id:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT,
            "school_id and class_id are required",
        )

    ratings = fetch_survey_ratings(school_id, class_id)
    if only_student_ids:
        ratings = {sid: s for sid, s in ratings.items() if sid in only_student_ids}

    grade = class_id.split("_")[0].upper()
    stage = GRADE_TO_STAGE.get(grade, "Preparatory")
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
    }
    if scan_only:
        return scan_payload

    ai = OpenAI(api_key=OPENAI_API_KEY.value)
    students = fetch_students(school_id, list(ratings.keys()))

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
