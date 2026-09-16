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

Two things to double check against the real schema before deploying:
  - gender field name/values on student docs (assumed "gender" -- the old
    Master Sheet just had a "Gender" column, never confirmed the Firestore
    field)
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

try:
    initialize_app()
except ValueError:
    pass  # already initialized in this environment

db = firestore.client()
OPENAI_API_KEY = SecretParam("OPENAI_API_KEY")

GRADE_TO_STAGE = {
    "NURSERY": "Foundation", "LKG": "Foundation", "UKG": "Foundation",
    "I": "Foundation", "II": "Foundation",
    "III": "Preparatory", "IV": "Preparatory", "V": "Preparatory",
    "VI": "Middle", "VII": "Middle", "VIII": "Middle",
    "IX": "Middle", "X": "Middle", "XI": "Middle", "XII": "Middle",
}
LEVEL_ORDER = {"Beginner": 1, "Proficient": 2, "Advanced": 3}
LEVEL_NAME = {1: "Beginner", 2: "Proficient", 3: "Advanced"}

SENTENCE_STARTERS = [
    "begins with the student's name and their strongest quality",
    "opens with what makes this student stand out in the subject",
    "leads with the student's creative strengths",
    "starts by highlighting how the student engages with others",
    "opens with the student's awareness and understanding",
    "begins by describing the student's sensitivity and empathy",
    "starts with the student's approach to problem-solving",
    "leads with how the student expresses original ideas",
]
FOCUS_STYLES = [
    "Focus more on the creativity descriptor, briefly mention the others.",
    "Focus more on the sensitivity descriptor, briefly mention the others.",
    "Focus more on the awareness descriptor, briefly mention the others.",
    "Give equal weight to all three descriptors.",
    "Blend all three into one seamless observation without separating them.",
]


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
    docs = db.collection("aap_framework").where("stage", "==", stage).stream()
    return {d.to_dict()["subject"]: d.to_dict() for d in docs}


def generate_comment(ai, first_name, gender, subject, aw, sen, cre):
    pronoun = "He" if gender.strip().lower().startswith(("m", "boy")) else "She"
    his_her = "his" if pronoun == "He" else "her"
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
- Write like a real teacher -- simple, warm, everyday language parents and children understand easily
- Mention the subject '{subject}' naturally
- Use {first_name}'s name once at the start
- Use correct pronoun ({pronoun}/{his_her})
- Avoid formal/robotic phrases like "learning community", "valued member", "demonstrates proficiency"
- MUST be between 40 and 55 words
- Return only the comment, nothing else"""

    comment = ""
    for _ in range(3):
        resp = ai.chat.completions.create(
            model="gpt-4o-mini", max_tokens=300, temperature=1.0,
            messages=[{"role": "user", "content": prompt}],
        )
        comment = resp.choices[0].message.content.strip()
        if 40 <= len(comment.split()) <= 55:
            break
    return comment


@https_fn.on_call(region="asia-south1", secrets=[OPENAI_API_KEY],
                   memory=options.MemoryOption.MB_512, timeout_sec=540)
def generate_aap_remarks(req: https_fn.CallableRequest) -> dict:
    data = req.data or {}
    school_id = data.get("school_id")
    class_id = data.get("class_id")
    only_student_ids = set(data.get("student_ids", []))

    if not school_id or not class_id:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT,
            "school_id and class_id are required",
        )

    ai = OpenAI(api_key=OPENAI_API_KEY.value)

    ratings = fetch_survey_ratings(school_id, class_id)
    if only_student_ids:
        ratings = {sid: s for sid, s in ratings.items() if sid in only_student_ids}

    students = fetch_students(school_id, list(ratings.keys()))
    grade = class_id.split("_")[0].upper()
    stage = GRADE_TO_STAGE.get(grade, "Preparatory")
    framework = fetch_framework(stage)

    total = sum(len(subjects) for subjects in ratings.values())
    job_ref = db.collection("schools").document(school_id).collection("aap_jobs").document()
    job_ref.set({
        "classId": class_id, "status": "running",
        "startedAt": firestore.SERVER_TIMESTAMP,
        "totalStudents": total, "processedStudents": 0,
    })

    processed = 0
    for student_id, subjects in ratings.items():
        info = students.get(student_id, {"name": student_id, "gender": ""})
        first_name = get_first_name(info["name"])

        for subject, levels in subjects.items():
            doc_ref = (db.collection("schools").document(school_id)
                       .collection("students").document(student_id)
                       .collection("aap_remarks").document(subject))
            existing = doc_ref.get()
            if (existing.exists and existing.to_dict().get("status") == "approved"
                    and not only_student_ids):
                processed += 1
                continue

            fw = framework.get(subject)
            if not fw:
                processed += 1
                continue

            aw_text = fw.get("awareness", {}).get(levels["awareness"].lower(), "")
            sen_text = fw.get("sensitivity", {}).get(levels["sensitivity"].lower(), "")
            cre_text = fw.get("creativity", {}).get(levels["creativity"].lower(), "")

            comment = generate_comment(ai, first_name, info["gender"], subject, aw_text, sen_text, cre_text)

            doc_ref.set({
                "awareness": levels["awareness"], "sensitivity": levels["sensitivity"],
                "creativity": levels["creativity"], "comment": comment,
                "status": "needs_review", "updatedAt": firestore.SERVER_TIMESTAMP,
            })
            processed += 1
            job_ref.update({"processedStudents": processed})
            time.sleep(0.3)

    job_ref.update({"status": "done", "completedAt": firestore.SERVER_TIMESTAMP})
    return {"jobId": job_ref.id, "processed": processed}
