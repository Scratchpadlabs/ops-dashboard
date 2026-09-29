"""
Cloud Function: generate_aap_remarks (+ list_aap_remarks, update_aap_remark,
bulk_update_aap_remarks, save_aap_subject_mapping, generate_aap_summary_pdf,
generate_aap_summary_pdfs — same source directory)

Generates AAP (Awareness / Sensitivity / Creativity) student remarks
directly from Firestore survey responses -- no Google Sheets / Drive hop.

generate_aap_remarks is callable from the ops dashboard (httpsCallable,
region asia-south1): { school_id, class_id, student_ids?, subjects?,
topics?, scan_only?, confirm_gender_issue? }

  1. Reads AAP survey responses for that class from Firestore (survey ids
     prefixed "zzz")
  2. Resolves each student's Beginner/Proficient/Advanced rating per
     subject/trait -- per topic first, then combined across the topics in
     scope (every topic, or the ones picked in `topics`); see
     topic_combine.py
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
import json
import random
import re
import time
import zipfile
from collections import Counter, defaultdict

from firebase_admin import initialize_app, firestore
from firebase_functions import https_fn, options
from firebase_functions.params import SecretParam
from openai import OpenAI
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import (
    BaseDocTemplate, Flowable, Frame, PageBreak, PageTemplate, Paragraph, SimpleDocTemplate,
    Spacer, Table, TableStyle,
)

from aap_rules import canonical_grade_section, gender_issue as _compute_gender_issue, resolve_stage
from class_resolver import compose_class_id, parse_class_value, raw_class_value
from ops_admins import require_ops_admin as _require_ops_admin_base
from subject_match import (
    build_subject_index, normalize_subject, opening_signature, resolve_subject,
)
from topic_combine import TRAITS, combine_topics, resolve_topic, trait_observation

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


def _parse_aap_response_id(doc_id):
    """doc id: teacherID_grade_section..._grade_subject_topic -> a dict of the
    parts, or None if the id doesn't fit the convention at all.

    The grade appears twice, but NOT necessarily spelled the same way both
    times — confirmed against real data (Hillgreen Highschool):
    "thh0028_7_KALAM_VII_Maths_Term1" has the grade as Arabic "7" the first
    time and Roman "VII" the second. Matching the second occurrence by exact
    string equality (the original approach) never finds it for a doc id like
    that, so EVERY response using this — apparently normal — convention was
    silently discarded as unparseable, for every consumer of this function
    including the already-deployed fetch_survey_ratings. Matched instead by
    canonical grade equivalence, the same comparison canonical_grade_section
    already does everywhere else grades are compared in this file.

    Shared by fetch_survey_ratings (which only needs grade/section/subject —
    it discards topic, since a remark is written per subject, not per topic)
    and the survey-completion scan below (which needs topic too, to tell two
    different topics on the same subject apart)."""
    parts = doc_id.split("_")
    if len(parts) < 5:
        return None
    teacher_id = parts[0]
    grade = parts[1]
    grade_canonical, _ = canonical_grade_section(grade, "")
    second_idx = next(
        (i for i in range(2, len(parts))
         if canonical_grade_section(parts[i], "")[0] == grade_canonical),
        None)
    if second_idx is None:
        return None
    section = "_".join(parts[2:second_idx])
    subject = parts[second_idx + 1]
    topic = "_".join(parts[second_idx + 2:]) or None
    # The teacher app builds the id as `${teacherId}_${classId}_${topicId}`,
    # where topicId is itself "{Grade}_{Subject}_{Topic}" and "{Grade}_{Subject}"
    # is the school-setup subject doc id — so both fall straight out of the
    # split. Only the completion report's editor needs these (to offer that
    # subject's curricular goals and to keep survey_initiated_by in step).
    return {"teacher_id": teacher_id, "grade": grade, "section": section,
            "subject": subject, "topic": topic,
            "subject_doc_id": f"{parts[second_idx]}_{subject}",
            "topic_id": "_".join(parts[second_idx:])}


def _topic_names(school_ref):
    """{topic_id: (display name, position)} from every class's
    subjects[].topics[] — the list the teacher app surveys from, so a
    response's topic id finds its real name ("Term 1", not "Term1") and its
    place in teaching order, which is what a trend across topics is read in.
    Topic ids are "{Grade}_{Subject}_{Topic}", so they are the same for every
    section of a grade and the first class listing one is as good as any."""
    out = {}
    for doc in school_ref.collection("classes").stream():
        for subj in (doc.to_dict() or {}).get("subjects") or []:
            if not isinstance(subj, dict):
                continue
            for pos, t in enumerate(subj.get("topics") or []):
                if not isinstance(t, dict) or not t.get("id"):
                    continue
                name = str(t.get("topic") or t.get("name") or "").strip()
                out.setdefault(str(t["id"]), (name, pos))
    return out


def fetch_survey_ratings(school_id, class_id):
    """Returns (topic_ratings, unparsed_response_count, context).

    topic_ratings is {student_id: {subject: {topic_key: {"topic", "order",
    "traits": {trait: [raw answers]}}}}} for one class — kept per TOPIC,
    because a remark can be scoped to some topics and is then combined across
    them (see topic_combine.py and subject_ratings below). topic_key is the
    normalised topic name, so the same topic lines up across the sections
    and grades of a multi-class run.

    unparsed_response_count is how many response docs across the WHOLE
    SCHOOL scan had an id this function's doc-id convention could not
    recover grade/section/subject from at all -- a structural parse
    failure, not simply "this response belongs to a different class". It is
    surfaced by scan_only rather than silently dropped, because a response
    doc naming convention this function does not control (see module
    docstring) failing silently is exactly how a class can be under-counted
    without anyone noticing.

    context is {subject: {topic_key: {"goals", "competencies", "activities"}}}
    — what the teacher ticked on each response (curricular goals and
    competencies) and the activity it was run under, each a Counter. It is
    per CLASS, not per student: every student surveyed in that response
    worked on the same goals, so it grounds the comment in what the class
    did without telling students apart (the ratings still do that).
    """
    school_ref = db.collection("schools").document(school_id)
    raw = defaultdict(lambda: defaultdict(dict))
    context = defaultdict(lambda: defaultdict(lambda: {
        "goals": Counter(), "competencies": Counter(), "activities": Counter()}))
    activity_names = {}

    def activity_name(resp_data, survey_id):
        name = str(resp_data.get("activityName") or "").strip()
        if name:
            return name
        activity_id = str(resp_data.get("activityId") or survey_id)
        if activity_id not in activity_names:
            snap = school_ref.collection("activities").document(activity_id).get()
            activity_names[activity_id] = (
                str((snap.to_dict() or {}).get("name") or "").strip() if snap.exists else "")
        return activity_names[activity_id]

    target_grade_raw, _, target_section_raw = class_id.partition("_")
    target = canonical_grade_section(target_grade_raw, target_section_raw)
    unparsed = 0
    # Subject names can contain underscores ("VII_Social_Science_Term1"), so
    # the parsed token alone would file that under "Social". The real subject
    # doc id the topic id starts with gives the full name.
    subject_names = {}
    for sdoc in school_ref.collection("subjects").stream():
        sdata = sdoc.to_dict() or {}
        subject_names[sdoc.id] = str(sdata.get("name") or "").strip()
    topic_names = _topic_names(school_ref)

    for survey_doc in school_ref.collection("surveys").stream():
        if not survey_doc.id.lower().startswith("zzz"):
            continue
        responses = (school_ref.collection("surveys").document(survey_doc.id)
                     .collection("responses").stream())
        for resp in responses:
            parsed = _parse_aap_response_id(resp.id)
            if not parsed:
                unparsed += 1
                continue
            grade, section, subject = parsed["grade"], parsed["section"], parsed["subject"]
            # Canonical comparison, not raw string equality: a response
            # spelling its grade "1" and the class doc spelling it "I" are
            # the same class once both go through the shared grade index.
            if canonical_grade_section(grade, section) != target:
                continue
            subject_doc_id, token, topic_token = _split_topic_id(parsed["topic_id"], subject_names)
            if subject_doc_id in subject_names:
                subject = subject_names[subject_doc_id] or token.replace("_", " ")
            name, order = topic_names.get(parsed["topic_id"], ("", None))
            topic = name or (topic_token or "").replace("_", " ").strip() or "General"
            topic_key = _norm_topic(topic)

            resp_data = resp.to_dict() or {}
            ctx = context[subject][topic_key]
            ctx["goals"].update(_clean_list(resp_data.get("selectedGoals")))
            ctx["competencies"].update(_clean_list(resp_data.get("selectedCompetencies")))
            name = activity_name(resp_data, survey_doc.id)
            if name:
                ctx["activities"][name] += 1

            answers = resp_data.get("answers", [])
            for q_index, trait in enumerate(TRAITS):
                if q_index >= len(answers):
                    break
                for student_id, level_str in answers[q_index].items():
                    if student_id == "questionText" or not level_str or level_str == "Not Applicable":
                        continue
                    entry = raw[student_id][subject].setdefault(topic_key, {
                        "topic": topic, "order": order,
                        "traits": {t: [] for t in TRAITS},
                    })
                    entry["traits"][trait].append(level_str)

    # A subject only reaches `raw` once at least one of its three questions was
    # answered (blank / "Not Applicable" answers are never appended above) --
    # that is what makes a student who never appeared for an optional subject
    # (Hindi/Marathi/Sanskrit split) resolve to no subject entry at all, with
    # no remark generated for it. A subject that DID get an answer but is
    # missing a trait is handled when combining (topic_combine.DEFAULT_LEVEL).
    return {sid: dict(subjects) for sid, subjects in raw.items()}, unparsed, context


def _clean_list(value):
    """A response's selectedGoals/selectedCompetencies as clean strings. The
    teacher app writes a list; an older path wrote a JSON string of one."""
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            value = [value]
    return [str(v).strip() for v in (value if isinstance(value, list) else []) if str(v).strip()]


def _strip_code(text):
    """"C-3.1 Compares past and present" -> "Compares past and present": the
    reference code is for the teacher's framework, never for a parent, so
    the model is not handed one it could echo."""
    return re.sub(r"^\s*(CG|C)\s*[-.]?\s*\d+(\.\d+)*\s*[:.)\-–]?\s*", "", str(text), flags=re.I) or str(text)


# How many goals / competencies reach the prompt: the most-ticked ones across
# the responses in scope. More than this and a 40-55 word comment can't use
# them anyway — it just starts listing.
MAX_GOALS_IN_PROMPT = 3
MAX_COMPETENCIES_IN_PROMPT = 5


def learning_context(context, subject, topic_keys):
    """The goals, competencies and activities behind one subject remark,
    pooled over the topics that fed its rating, most-ticked first."""
    goals, competencies, activities = Counter(), Counter(), Counter()
    for key in topic_keys:
        ctx = context.get(subject, {}).get(key)
        if not ctx:
            continue
        goals.update(ctx["goals"])
        competencies.update(ctx["competencies"])
        activities.update(ctx["activities"])
    top = lambda counter: [k for k, _ in counter.most_common()]  # noqa: E731
    return {"goals": top(goals), "competencies": top(competencies), "activities": top(activities)}


def _topic_sort_key(entry):
    """Teaching order: class-setup position first, name for topics setup
    doesn't list (and to break ties)."""
    return (entry["order"] is None, entry["order"] or 0, entry["topic"].lower())


def subject_ratings(topic_ratings, only_topics=None):
    """topic_ratings (fetch_survey_ratings) -> {student_id: {subject:
    combined}}, where combined is topic_combine.combine_topics' result.

    only_topics, when given, is {normalized subject: {topic_key, ...}}: a
    subject named there is built from those topics alone, and a subject not
    named there is left out — picking topics narrows the run to them. A
    student who was rated in none of the chosen topics gets no entry for
    that subject, the same "never appeared" rule as an unrated subject.
    """
    out = {}
    for student_id, subjects in topic_ratings.items():
        for subject, topics in subjects.items():
            entries = list(topics.items())
            if only_topics is not None:
                keep = only_topics.get(normalize_subject(subject))
                if not keep:
                    continue
                entries = [(k, e) for k, e in entries if k in keep]
            if not entries:
                continue
            entries.sort(key=lambda kv: _topic_sort_key(kv[1]))
            rows = [{"topic": e["topic"], "levels": resolve_topic(e["traits"])} for _, e in entries]
            combined = combine_topics(rows)
            # Which topics fed this rating, so the goals/competencies the
            # teacher ticked for exactly those topics can be looked up.
            combined["topicKeys"] = [k for k, _ in entries]
            out.setdefault(student_id, {})[subject] = combined
    return out


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


def generate_comment(ai, first_name, gender, subject, aw, sen, cre, used_openings=None,
                     varied=False, learning=None):
    """One comment. `used_openings` is the set of opening phrasings already
    written in THIS run — a repeat is retried rather than accepted, which is
    what stops a class reading as one sentence with the names swapped.

    `varied` says the topics disagreed for at least one trait — the
    observations then carry the movement across topics
    (topic_combine.trait_observation), and the prompt asks for it to be
    described as progress rather than averaged away.

    `learning` is learning_context()'s {goals, competencies, activities}:
    what the class worked on, given to the model as background so the
    comment can be concrete. Topic and activity names are data points only —
    the prompt forbids naming them, since "Term 1" or an activity title
    means nothing to a parent reading a report card."""
    used_openings = used_openings if used_openings is not None else set()
    pronoun = "He" if gender.strip().lower().startswith(("m", "boy")) else "She"
    his_her = "his" if pronoun == "He" else "her"

    # Sampled per comment, not per run: the point is that two students in the
    # same class get different instructions.
    avoid = sorted(used_openings)[:8]
    avoid_line = ("\n- Do NOT open with any of these phrasings, already used for "
                  f"other students in this class: {'; '.join(avoid)}" if avoid else "")

    varied_line = ("\n- The observations describe how the student changed over the term: reflect "
                   "that journey naturally (growth, or a gentle nudge to regain earlier form) "
                   "without naming levels" if varied else "")

    learning = learning or {}
    goals = [_strip_code(g) for g in learning.get("goals", [])[:MAX_GOALS_IN_PROMPT]]
    competencies = [_strip_code(c) for c in learning.get("competencies", [])[:MAX_COMPETENCIES_IN_PROMPT]]
    activities = learning.get("activities", [])[:2]
    context_lines = []
    if goals:
        context_lines.append(f"- Curricular goals the class worked towards: {'; '.join(goals)}")
    if competencies:
        context_lines.append(f"- Competencies the class practised: {'; '.join(competencies)}")
    if activities:
        context_lines.append(f"- Classroom activity: {'; '.join(activities)}")
    context_block = ("\n\nLearning context (background for you -- NOT to be quoted):\n"
                     + "\n".join(context_lines)) if context_lines else ""
    context_rules = ("\n- Ground one sentence in what the student worked on, drawing on the "
                     "curricular goals/competencies above, paraphrased in simple everyday words "
                     "-- never quote or list them"
                     "\n- Say the student is developing or working on a skill; never claim they "
                     "have mastered a competency"
                     if goals or competencies else "")

    prompt = f"""You are a warm, caring schoolteacher writing a report card comment for a young student.

Student first name: {first_name}
Pronoun: {pronoun}/{his_her}
Subject: {subject}

Awareness observation: {aw}
Sensitivity observation: {sen}
Creativity observation: {cre}{context_block}

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
- Do NOT mention any activity name, topic name, unit name or term name{context_rules}
- Return only the comment, nothing else{varied_line}{avoid_line}"""

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
    # Topic scope: [{subject, topic}] by NAME, so one selection means the same
    # topic in every section and grade of a multi-class run. Empty means every
    # topic. Picking topics narrows the run to the subjects they belong to,
    # each built from its picked topics only; several topics of one subject
    # are combined into one rubric (topic_combine.py).
    only_topics = None
    for t in (data.get("topics") or []):
        if not isinstance(t, dict):
            continue
        subject_key = normalize_subject(t.get("subject"))
        topic_key = _norm_topic(t.get("topic"))
        if subject_key and topic_key:
            only_topics = only_topics or {}
            only_topics.setdefault(subject_key, set()).add(topic_key)
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

    topic_ratings, unresolved_responses, context = fetch_survey_ratings(school_id, class_id)
    if only_student_ids:
        topic_ratings = {sid: s for sid, s in topic_ratings.items() if sid in only_student_ids}
    ratings = subject_ratings(topic_ratings, only_topics)

    # Needed for both the gender scan below and generation itself, so fetched
    # once, before the scan_only early return.
    students = fetch_students(school_id, list(topic_ratings.keys()))
    gender_issue = _compute_gender_issue(topic_ratings, students)

    by_label, alias_index, alias_conflicts = fetch_framework(stage)
    overrides = fetch_subject_overrides(stage)

    # Resolve every subject ONCE per run rather than per student: the answer
    # cannot differ between two students in the same class, and the inventory
    # is what both the scan and the unmatched report are built from.
    # Built from every topic, not just the picked ones, so the pickers always
    # offer the whole class's subjects and topics.
    inventory = {}
    topic_rows = defaultdict(dict)
    for subjects in topic_ratings.values():
        for subject, topics in subjects.items():
            row = inventory.setdefault(subject, {
                "subject": subject, "students": 0, "matched": None, "how": None,
            })
            row["students"] += 1
            for key, entry in topics.items():
                t = topic_rows[subject].setdefault(key, {
                    "topic": entry["topic"], "order": entry["order"], "students": 0})
                t["students"] += 1
    for subject, row in inventory.items():
        row["topics"] = [{"topic": t["topic"], "students": t["students"]}
                         for t in sorted(topic_rows[subject].values(), key=_topic_sort_key)]
        fw, how = resolve_subject(subject, by_label, alias_index, overrides)
        row["matched"] = fw.get("subject") if fw else None
        row["how"] = how
        row["_fw"] = fw

    in_scope = [s for s in inventory
                if (not only_subjects or normalize_subject(s) in only_subjects)
                and (only_topics is None or normalize_subject(s) in only_topics)]
    unmatched = sorted(
        ({"subject": s, "students": inventory[s]["students"]}
         for s in in_scope if not inventory[s]["matched"]),
        key=lambda r: r["subject"],
    )
    scan_payload = {
        "stage": stage,
        "classId": class_id,
        "students": len(topic_ratings),
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
        "topics": sorted(f"{t.get('subject')} / {t.get('topic')}" for t in (data.get("topics") or [])
                         if isinstance(t, dict)),
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

            for subject, combined in subjects.items():
                if only_subjects and normalize_subject(subject) not in only_subjects:
                    continue
                levels = combined["levels"]

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

                # The combined rubric: each trait's descriptor at its combined
                # level, plus how the student moved when the topics disagreed.
                aw_text, sen_text, cre_text = (
                    trait_observation(fw.get(trait) or {}, trait, combined) for trait in TRAITS)
                varied = any(combined["trends"][t] in ("improving", "declining", "mixed")
                             for t in TRAITS)

                learning = learning_context(context, subject, combined["topicKeys"])
                comment = generate_comment(ai, first_name, info["gender"], subject,
                                           aw_text, sen_text, cre_text,
                                           used_openings=used_openings[subject],
                                           varied=varied, learning=learning)

                doc_ref.set({
                    "awareness": levels["awareness"], "sensitivity": levels["sensitivity"],
                    "creativity": levels["creativity"], "comment": comment,
                    "frameworkSubject": fw.get("subject", ""), "matchedBy": inventory[subject]["how"],
                    # Which topics this remark stands on and how each rated,
                    # so a reviewer can see why a level came out as it did.
                    "topics": combined["topics"], "topicLevels": combined["topicLevels"],
                    "trends": combined["trends"],
                    # What the class worked on, as the prompt saw it — so a
                    # reviewer can check a comment's claim against it.
                    "curricularGoals": learning["goals"][:MAX_GOALS_IN_PROMPT],
                    "competencies": learning["competencies"][:MAX_COMPETENCIES_IN_PROMPT],
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
_BORDER = colors.HexColor("#d6dbe0")
_LEVEL_COLOR = {
    "Beginner": colors.HexColor("#d97706"),
    "Proficient": colors.HexColor("#16a34a"),
    "Advanced": colors.HexColor("#15803d"),
}
# Row tint keyed by TRAIT, not alternated per subject block — every
# Awareness row across every subject gets the same tint, same for
# Sensitivity/Creativity, matching the reference sample exactly.
_TRAIT_BG = {
    "awareness": colors.HexColor("#fdf1e6"),
    "sensitivity": colors.HexColor("#f2f8ee"),
    "creativity": colors.HexColor("#eef2fb"),
}


def _pdf_style(name, **kwargs):
    defaults = dict(fontName="Helvetica", fontSize=9.5, leading=13, textColor=colors.HexColor("#0f172a"))
    defaults.update(kwargs)
    return ParagraphStyle(name, **defaults)


def _centered(name, **kwargs):
    return _pdf_style(name, alignment=TA_CENTER, **kwargs)


def _watermark(student_id):
    """Stamped at the bottom of the page so a loose printout or a file that
    gets separated from the rest can still be traced back to a child."""
    def draw(canvas_obj, doc):
        canvas_obj.saveState()
        canvas_obj.setFont("Helvetica", 7.5)
        canvas_obj.setFillColor(colors.HexColor("#9ca3af"))
        canvas_obj.drawCentredString(A4[0] / 2, 10 * mm, student_id)
        canvas_obj.restoreState()
    return draw


_PDF_MARGIN = 12 * mm
_PDF_BOTTOM = 18 * mm


def _build_student_summary_pdf(student_id, remarks):
    """remarks: [{ id (subject), awareness, sensitivity, creativity, comment }],
    already limited to subjects this student actually has a remark doc for.
    Returns the PDF as bytes."""
    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, leftMargin=_PDF_MARGIN, rightMargin=_PDF_MARGIN,
                             topMargin=0, bottomMargin=_PDF_BOTTOM)
    doc.build(_student_story(remarks),
              onFirstPage=_watermark(student_id), onLaterPages=_watermark(student_id))
    return buf.getvalue()


class _StudentMark(Flowable):
    """Zero-size marker at the start of each student in a combined PDF: it
    records whose pages follow, so the page-END hook stamps the right id."""

    def __init__(self, student_id):
        super().__init__()
        self.student_id = student_id

    def wrap(self, *_):
        return 0, 0

    def draw(self):
        self.canv._aap_student_id = self.student_id


def _build_combined_summary_pdf(students):
    """One PDF holding every student's summary page(s), each starting on a new
    page — the file a school prints for a whole class. `students` is
    [(student_id, remarks)]. Each page carries its own student's id, stamped
    at page END (by then the marker for that page's student has been drawn)."""
    buf = io.BytesIO()
    doc = BaseDocTemplate(buf, pagesize=A4)
    frame = Frame(_PDF_MARGIN, _PDF_BOTTOM, A4[0] - 2 * _PDF_MARGIN, A4[1] - _PDF_BOTTOM,
                  leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)

    def stamp(canvas_obj, _doc):
        student_id = getattr(canvas_obj, "_aap_student_id", "")
        if student_id:
            _watermark(student_id)(canvas_obj, _doc)

    doc.addPageTemplates([PageTemplate(id="summary", frames=[frame], onPageEnd=stamp)])
    story = []
    for i, (student_id, remarks) in enumerate(students):
        if i:
            story.append(PageBreak())
        story.append(_StudentMark(student_id))
        story.extend(_student_story(remarks))
    doc.build(story)
    return buf.getvalue()


def _student_story(remarks):
    """The flowables of one student's summary page(s)."""
    W, H = A4
    M = _PDF_MARGIN
    story = []

    header = Table(
        [[Paragraph("Summary For The Academic Year",
                     _pdf_style("hdr", fontName="Helvetica-Bold", fontSize=18,
                                textColor=colors.white, alignment=TA_CENTER))]],
        colWidths=[W - 2 * M], rowHeights=[16 * mm],
    )
    header.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), _NAVY),
        ("ROUNDEDCORNERS", (0, 0), (-1, -1), [10, 10, 10, 10]),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ]))
    story.append(header)

    gold = Table([[""]], colWidths=[W - 2 * M], rowHeights=[3 * mm])
    gold.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), _GOLD),
        ("ROUNDEDCORNERS", (0, 0), (-1, -1), [4, 4, 4, 4]),
    ]))
    story.append(gold)
    story.append(Spacer(1, 6 * mm))

    col_w = [(W - 2 * M) * x for x in [0.16, 0.14, 0.20, 0.50]]
    rows = [[
        Paragraph("<b>Subjects</b>", _centered("th", fontSize=11)),
        Paragraph("<b>Abilities</b>", _centered("th", fontSize=11)),
        Paragraph("<b>Performance Level Descriptors</b>", _centered("th", fontSize=11)),
        Paragraph("<b>Summary</b>", _centered("th", fontSize=11)),
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
                Paragraph(f"<b>{subject}</b>", _centered("subj")) if trait == "awareness" else "",
                Paragraph(label, _centered("ab")),
                Paragraph(f"<b>{level}</b>", _centered("lvl", textColor=_LEVEL_COLOR.get(level, colors.black))),
                Paragraph(comment, _pdf_style("cm", alignment=TA_JUSTIFY)) if trait == "awareness" else "",
            ])
            # Tint keyed by trait, restricted to the Abilities/Descriptors
            # columns — the Subject and Summary columns (spanned across all
            # three trait rows) stay plain white, matching the reference.
            shading.append(("BACKGROUND", (1, r), (2, r), _TRAIT_BG[trait]))
            r += 1
        spans.append(("SPAN", (0, start), (0, start + 2)))
        spans.append(("SPAN", (3, start), (3, start + 2)))

    table = Table(rows, colWidths=col_w, repeatRows=1)
    table.setStyle(TableStyle([
        # Only the "Performance Level Descriptors" header cell is gold —
        # the other three headers stay white with a bottom border, matching
        # the reference sample rather than a solid gold header row.
        ("BACKGROUND", (2, 0), (2, 0), _GOLD),
        ("LINEBELOW", (0, 0), (-1, 0), 1, _NAVY),
        ("GRID", (0, 0), (-1, -1), 0.5, _BORDER),
        ("ALIGN", (0, 0), (-1, -1), "CENTER"),
        # Every cell centers horizontally by default (ALIGN above); the
        # Summary column overrides back to justified text (set per-Paragraph,
        # TA_JUSTIFY) since centering multi-line prose reads worse, not
        # better. Vertically, the subject-name and summary cells span all
        # three trait rows, so they're centered in that merged block rather
        # than pinned to its top.
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE" if len(rows) == 1 else "TOP"),
        ("VALIGN", (0, 1), (0, -1), "MIDDLE"),
        ("VALIGN", (3, 1), (3, -1), "MIDDLE"),
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
    return story


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
    """{school_id, student_ids | classes, approved_only?} ->
    {filename, mime, content_base64, students, skipped} (a zip).

    Bulk form of generate_aap_summary_pdf — one PDF per student inside a zip,
    each named "<student_id>.pdf" so the caller can match files back to
    children for whatever merge/print step they run next.

    `classes` ([{class_id, label?, student_ids}]) is the multi-class form:
    one folder per class, each holding the per-student PDFs AND one combined
    "<class>_all_students.pdf" with every child's page in roster order —
    the file a school actually prints. `approved_only` leaves out remarks
    not yet approved, and a student left with none gets no page at all.
    """
    _require_ops_admin(req)
    data = req.data or {}
    school_id = data.get("school_id")
    approved_only = bool(data.get("approved_only"))
    groups = []
    for c in data.get("classes") or []:
        if not isinstance(c, dict):
            continue
        ids = [str(sid) for sid in (c.get("student_ids") or []) if sid]
        label = str(c.get("label") or c.get("class_id") or "").strip()
        if ids:
            groups.append((_safe_filename(label) or "class", ids))
    if not groups and data.get("student_ids"):
        groups = [(None, [str(sid) for sid in data["student_ids"]])]
    if not school_id or not groups:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT,
            "school_id and student_ids (or classes) are required",
        )

    school_ref = db.collection("schools").document(school_id)
    zip_buf = io.BytesIO()
    written = skipped = 0
    with zipfile.ZipFile(zip_buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for folder, student_ids in groups:
            prefix = f"{folder}/" if folder else ""
            pages = []
            for student_id in student_ids:
                remarks = _fetch_student_remarks(school_ref, student_id)
                if approved_only:
                    remarks = [r for r in remarks if r.get("status") == "approved"]
                    if not remarks:
                        skipped += 1
                        continue
                zf.writestr(f"{prefix}{student_id}.pdf", _build_student_summary_pdf(student_id, remarks))
                pages.append((student_id, remarks))
                written += 1
            if folder and pages:
                zf.writestr(f"{prefix}{folder}_all_students.pdf", _build_combined_summary_pdf(pages))

    date_str = datetime.date.today().isoformat()
    scope = "classes" if groups[0][0] else "pdfs"
    return {
        "filename": f"AAP_summary_{scope}_{school_id}_{date_str}.zip",
        "mime": "application/zip",
        "content_base64": base64.b64encode(zip_buf.getvalue()).decode("ascii"),
        "students": written,
        "skipped": skipped,
    }


def _safe_filename(text):
    return re.sub(r"[^A-Za-z0-9]+", "_", str(text or "")).strip("_")


# ── Whole-school survey completion ──────────────────────────────────────────
# Which class/subject/topic has a teacher submitted an AAP survey for, which
# are still missing entirely, and — within a submitted one — which specific
# students/questions are still blank. This is a different question from
# generate_aap_remarks's own scan_only: that one only ever looks at ONE class
# and only cares whether a subject resolves to a rubric row, not whether a
# topic exists at all or who on the roster never got rated.

INACTIVE_ENROLLMENT_VALUES = {
    "inactive", "left", "tc", "tc issued", "dropped", "dropout",
    "alumni", "passed out", "transferred", "withdrawn",
}


def _is_inactive_student(data):
    """Same rule as functions/assign_survey/survey_rules.py's is_inactive —
    duplicated rather than imported because each function directory here
    deploys independently (see tools/sync_shared.py)."""
    if data.get("isActive") is False:
        return True
    status = str(data.get("enrollmentStatus") or data.get("status") or "").strip().lower()
    return status in INACTIVE_ENROLLMENT_VALUES


def _subject_has_competencies(data):
    """True if this subject's curricular_goals carries at least one non-blank
    competency. curricular_goals is a list of single-key maps, {goalText:
    [competencyText, ...]} (School Setup's "Curricular goals" editor).

    A subject with nothing here is treated as not yet configured for AAP
    tracking — ignored rather than shown as "not started" for every class,
    which would otherwise clutter the report with subjects nobody has set up
    to assess yet.
    """
    for goal in (data.get("curricular_goals") or []):
        if not isinstance(goal, dict):
            continue
        for competencies in goal.values():
            if isinstance(competencies, list) and any(str(c).strip() for c in competencies):
                return True
    return False


def _goal_options(data):
    """A subject doc's curricular_goals as [{"goal", "competencies"}] — the
    same goal -> competency choices the teacher app's Curricular Goals and
    Competencies dialogs offer, so the dashboard's editor can offer them too."""
    out = []
    for goal_map in (data.get("curricular_goals") or []):
        if not isinstance(goal_map, dict):
            continue
        for goal, competencies in goal_map.items():
            goal = str(goal or "").strip()
            if not goal:
                continue
            comps = [str(c).strip() for c in (competencies if isinstance(competencies, list) else [])]
            out.append({"goal": goal, "competencies": [c for c in comps if c]})
    return out


def _expected_subjects_by_grade(school_id):
    """(by_grade, merged_stream_grades, skipped_blank_competencies, goals_by_doc) —
    school-setup's OWN subject configuration (schools/{id}/subjects, doc id
    "{Grade}_{Name}"), independent of anything any survey response claims.
    A subject with no non-blank curricular_goals competency is left out of
    by_grade entirely (see _subject_has_competencies) and named instead in
    skipped_blank_competencies. This is the "what
    SHOULD exist" side of the completion report.
    by_grade: {grade_token: [{"subject": name, "topics": [str, ...]}]}

    The grade token is parsed with parse_class_value (class_resolver), the
    SAME tokenizer the roster side uses, before being canonicalized — not a
    direct canonical_grade_section call on the raw id prefix. Some schools
    fold a stream into the grade token itself ("XI Commerce", "XII Science"),
    and canonical_grade_section has no multi-word fallback: fed "XI Commerce"
    directly it cannot resolve a grade at all, so every subject filed under a
    stream-qualified grade silently matched nothing. parse_class_value DOES
    shrink from the full token down to "XI" + section "Commerce", so this
    still lands on the same grade a plain "XI_..." class resolves to.

    That comes at a real cost, surfaced rather than hidden: the stream
    ("Commerce") is discarded for matching purposes, since neither the roster
    nor a class id carries a stream field to match it back against. A
    Commerce-only subject will therefore show as "expected" for every
    section of that grade, streams included. merged_stream_grades lists every
    raw grade token this happened to, so that tradeoff is visible rather than
    a second silent mismatch.
    """
    school_ref = db.collection("schools").document(school_id)
    out = defaultdict(list)
    merged_streams = set()
    skipped_blank_competencies = []
    goals_by_doc = {}
    for doc in school_ref.collection("subjects").stream():
        data = doc.to_dict() or {}
        # Every subject doc, including ones skipped below — a response can
        # still point at a subject whose goals were blanked after the fact.
        goals_by_doc[doc.id] = _goal_options(data)
        raw_grade = doc.id.split("_", 1)[0]
        parsed = parse_class_value(raw_grade)
        if parsed["grade_ordinal"] is None:
            continue  # doesn't resolve to any grade at all (e.g. a non-grade bucket like "Training")
        if parsed["section"]:
            merged_streams.add(raw_grade)
        grade, _ = canonical_grade_section(parsed["grade_token"], parsed["section"] or "")
        name = str(data.get("name") or "").strip()
        if not name:
            continue
        if not _subject_has_competencies(data):
            skipped_blank_competencies.append(f"{grade} {name}")
            continue
        topics = []
        for t in (data.get("topics") or []):
            # Real subject docs vary: SubjectsTab.vue's own editor writes
            # {topic, description, quiz}, but topics written by another path
            # (seen in production — cost/survey_initiated_by-bearing entries)
            # use {id, name, ...} instead, with no "topic" key at all. Tried
            # in this order so the display name always wins when both exist.
            topic_name = (t.get("name") or t.get("topic")) if isinstance(t, dict) else t
            topic_name = str(topic_name or "").strip()
            if topic_name:
                topics.append(topic_name)
        out[grade].append({"subject": name, "topics": topics})
    return out, sorted(merged_streams), sorted(skipped_blank_competencies), goals_by_doc


def _canonical_class_id(raw):
    """Canonical class_id (the notation the roster and reports key on) for a
    raw class value such as a classes/{id} doc id, or None if no grade
    resolves."""
    parsed = parse_class_value(raw)
    if parsed["grade_ordinal"] is None:
        return None
    grade, section = canonical_grade_section(parsed["grade_token"], parsed["section"])
    return compose_class_id(grade, section)


def _longest_prefix(text, candidates):
    """Longest c in candidates with text == c or text starting with c + "_"."""
    best = None
    for c in candidates:
        if (text == c or text.startswith(c + "_")) and (best is None or len(c) > len(best)):
            best = c
    return best


def _split_topic_id(topic_id, subject_doc_ids):
    """(subject_doc_id, subject_name_part, topic_part) for a topic id shaped
    "{Grade}_{Subject}_{Topic}". Subject and topic names can both contain
    underscores ("VII_Social_Science_Term1"), so a plain split guessed the
    subject as "Social" and the topic as "Science_Term1". The subject is
    instead the longest real subject doc id the topic id starts with."""
    doc_id = _longest_prefix(topic_id, subject_doc_ids)
    if doc_id:
        rest = topic_id[len(doc_id) + 1:]
        return doc_id, doc_id.split("_", 1)[1] if "_" in doc_id else doc_id, rest or None
    parts = topic_id.split("_")
    if len(parts) >= 3:
        return f"{parts[0]}_{parts[1]}", parts[1], "_".join(parts[2:])
    return None, parts[1] if len(parts) > 1 else topic_id, None


def _scan_school_aap_completion(school_id, class_doc_ids=(), subject_doc_ids=()):
    """Whole-school scan of zzz-prefixed AAP survey responses.

    The teacher app names every response `${teacherId}_${classDocId}_${topicId}`
    (AcadSurvey.vue / ActivityDialog.vue), where classDocId is the classes/{id}
    doc and topicId is that class's own topic id. So a response is matched
    by finding the real class doc id right after the teacher id — exact, not
    parsed — and everything after it IS the topic id. Only an id that starts
    with no known class doc falls back to the old parse
    (_parse_aap_response_id), which has to guess where the grade repeats.

    Returns (by_key, unparsed_count). Keys are:
      ("topic", class_id, topic_id)  — matched to a real class doc
      ("parsed", class_id, subject_token, topic) — fallback parse
    and each value is
    {"teacher_id", "class_doc_id", "topic_id", "subject_doc_id",
     "subject_token", "topic", "students": {student_id: {trait: answered}},
     "notApplicable": int, "responses": [...]}.

    "responses" is a list, not one doc, because the activity IS the survey
    doc a response lives under: a teacher who picked activity A and later B
    for the same class/topic leaves one response under each. Showing both
    is the honest answer; picking one would hide the other from the editor.

    "Not Applicable" counts as answered: it is a choice the teacher made for
    that child (absent, not relevant), not a blank. Counting it as missing
    meant a class with one N/A child could never show Complete.
    """
    school_ref = db.collection("schools").document(school_id)
    by_key = {}
    unparsed = 0
    class_doc_ids = list(class_doc_ids)
    subject_doc_ids = list(subject_doc_ids)

    for survey_doc in school_ref.collection("surveys").stream():
        if not survey_doc.id.lower().startswith("zzz"):
            continue
        responses = (school_ref.collection("surveys").document(survey_doc.id)
                     .collection("responses").stream())
        for resp in responses:
            teacher_id, _, rest = resp.id.partition("_")
            class_doc = _longest_prefix(rest, class_doc_ids) if rest else None
            topic_id = rest[len(class_doc) + 1:] if class_doc else ""
            if class_doc and topic_id:
                class_id = _canonical_class_id(class_doc) or class_doc
                subject_doc_id, subject_token, topic = _split_topic_id(topic_id, subject_doc_ids)
                key = ("topic", class_id, topic_id)
            else:
                parsed = _parse_aap_response_id(resp.id)
                if not parsed:
                    unparsed += 1
                    continue
                grade, section = canonical_grade_section(parsed["grade"], parsed["section"])
                class_id = compose_class_id(grade, section)
                topic_id = parsed["topic_id"]
                subject_doc_id, subject_token, topic = _split_topic_id(topic_id, subject_doc_ids)
                class_doc = None
                key = ("parsed", class_id, subject_token, topic)
            entry = by_key.setdefault(key, {
                "teacher_id": teacher_id, "class_id": class_id, "class_doc_id": class_doc,
                "topic_id": topic_id, "subject_doc_id": subject_doc_id,
                "subject_token": subject_token, "topic": topic,
                "students": {}, "notApplicable": 0, "responses": [],
            })

            resp_data = resp.to_dict() or {}
            entry["responses"].append({
                "surveyId": survey_doc.id,
                "responseId": resp.id,
                "subjectDocId": subject_doc_id,
                "topicId": topic_id,
                "activityId": resp_data.get("activityId") or survey_doc.id,
                "activityName": resp_data.get("activityName") or "",
                "selectedGoals": [str(g) for g in (resp_data.get("selectedGoals") or [])],
                "selectedCompetencies": [str(c) for c in (resp_data.get("selectedCompetencies") or [])],
            })

            answers = resp_data.get("answers", [])
            for q_index, trait in enumerate(["awareness", "sensitivity", "creativity"]):
                if q_index >= len(answers) or not isinstance(answers[q_index], dict):
                    continue
                for student_id, level_str in answers[q_index].items():
                    if student_id == "questionText":
                        continue
                    row = entry["students"].setdefault(student_id, {})
                    # Last response doc standing wins for a given key — only
                    # relevant if a topic was genuinely resubmitted, in which
                    # case the newer submission IS the current truth.
                    row[trait] = bool(level_str)
                    if level_str == "Not Applicable":
                        entry["notApplicable"] += 1
    return by_key, unparsed


def _whole_school_roster(school_id):
    """(roster, unresolved) — roster is {class_id: [{"id", "name"}, ...]} for
    every active student whose class resolved; unresolved is
    [{"studentId", "studentName", "rawClassValue"}] for every one that didn't.

    raw_class_value/parse_class_value (class_resolver) do the robust part —
    finding the class field a school actually uses and splitting it into
    grade/section however it's punctuated — but the final class_id is
    composed through canonical_grade_section, not class_resolver's own
    canonical_class_id. Those two disagree on notation (e.g. "III" vs "3"),
    and this report needs to land on the SAME class_id fetch_survey_ratings
    and _scan_school_aap_completion already use, or a submitted response and
    its own class's roster would silently never match.

    A student whose class doesn't resolve at all used to just vanish from the
    roster with nothing said about it — which, if it hit every student in a
    grade, made every subject/topic configured for that grade disappear from
    the report with no explanation. Returned instead of swallowed, same
    "surface, don't guess" rule the rest of this file already follows for an
    unrecognised grade or an unmatched subject.
    """
    school_ref = db.collection("schools").document(school_id)
    roster = defaultdict(list)
    unresolved = []
    for doc in school_ref.collection("students").stream():
        data = doc.to_dict() or {}
        if str(data.get("type") or "student") != "student" or _is_inactive_student(data):
            continue
        raw, _field = raw_class_value(data)
        parsed = parse_class_value(raw)
        name = (str(data.get("name") or "").strip()
                or f"{data.get('firstName', '')} {data.get('lastName', '')}".strip() or doc.id)
        if parsed["grade_ordinal"] is None:
            unresolved.append({"studentId": doc.id, "studentName": name, "rawClassValue": raw})
            continue
        grade, section = canonical_grade_section(parsed["grade_token"], parsed["section"])
        class_id = compose_class_id(grade, section)
        roster[class_id].append({"id": doc.id, "name": name})
    return roster, unresolved


def _aap_survey_ids_by_activity(school_ref):
    """{activity_id: survey_doc_id} for every zzz-prefixed (AAP) survey. The
    teacher app finds an activity's survey by its `id` field, which is
    normally also the doc id — both are indexed so either spelling resolves."""
    out = {}
    for survey_doc in school_ref.collection("surveys").stream():
        if not survey_doc.id.lower().startswith("zzz"):
            continue
        out.setdefault(survey_doc.id, survey_doc.id)
        field_id = (survey_doc.to_dict() or {}).get("id")
        if field_id:
            out[str(field_id)] = survey_doc.id
    return out


def _aap_activities(school_id):
    """Every activity the teacher app would offer that has an AAP survey
    behind it: [{"id", "name", "stage"}]. An activity with no zzz survey is
    left out — a response moved under it would fall out of this report."""
    school_ref = db.collection("schools").document(school_id)
    survey_ids = _aap_survey_ids_by_activity(school_ref)
    out = []
    for doc in school_ref.collection("activities").stream():
        if doc.id not in survey_ids:
            continue
        data = doc.to_dict() or {}
        out.append({"id": doc.id, "name": str(data.get("name") or doc.id),
                    "stage": data.get("stage") or None})
    out.sort(key=lambda a: a["name"].lower())
    return out


def _class_stages(school_id):
    """{class_id: stage} from schools/{id}/classes — the same `stage` field
    the teacher app filters its activity list by — keyed by the canonical
    class_id this report uses, so a row can look its class up directly."""
    out = {}
    for doc in db.collection("schools").document(school_id).collection("classes").stream():
        stage = (doc.to_dict() or {}).get("stage")
        if not stage:
            continue
        parsed = parse_class_value(doc.id)
        if parsed["grade_ordinal"] is None:
            continue
        grade, section = canonical_grade_section(parsed["grade_token"], parsed["section"])
        out[compose_class_id(grade, section)] = stage
    return out


def _iso(value):
    if value is not None and hasattr(value, "isoformat"):
        try:
            return value.isoformat()
        except Exception:
            return None
    return None


def _class_topic_setup(school_id, subject_docs):
    """What each class actually teaches, from classes/{id}.subjects[] — the
    same per-class list the teacher app's Mark Lesson screen shows and
    surveys from (subjectId + topics[{id, topic, isCompleted, completedAt}]).

    Returns (by_class, class_doc_ids, classes_without_subjects):
      by_class: {class_id: {"classDocId", "topics": [{subjectDocId, subject,
                 topicId, topic, taught, completedAt}]}} — only subjects whose
                 school-setup doc has a curricular competency (the teacher app
                 only surveys those).
      class_doc_ids: every class doc id, for matching response ids.
      classes_without_subjects: class_ids with no subjects array at all —
                 those fall back to the grade-wide school-setup list.
    """
    by_class = {}
    class_doc_ids = []
    without = []
    for doc in db.collection("schools").document(school_id).collection("classes").stream():
        data = doc.to_dict() or {}
        class_doc_ids.append(doc.id)
        if data.get("isActive") is False:
            continue
        class_id = _canonical_class_id(doc.id)
        if not class_id:
            continue
        subjects = data.get("subjects") or []
        if not subjects:
            without.append(class_id)
            continue
        topics = []
        for subj in subjects:
            if not isinstance(subj, dict):
                continue
            sdoc = str(subj.get("subjectId") or "")
            info = subject_docs.get(sdoc)
            if not info or not info["hasCompetencies"]:
                continue
            for t in subj.get("topics") or []:
                if not isinstance(t, dict) or not t.get("id"):
                    continue
                topics.append({
                    "subjectDocId": sdoc, "subject": info["name"],
                    "topicId": str(t["id"]),
                    "topic": str(t.get("topic") or t.get("name") or t["id"]).strip(),
                    "taught": bool(t.get("isCompleted")),
                    "completedAt": _iso(t.get("completedAt")),
                })
        by_class[class_id] = {"classDocId": doc.id, "topics": topics}
    return by_class, class_doc_ids, without


def _subject_docs(school_id):
    """{subject doc id: {"name", "hasCompetencies"}} from schools/{id}/subjects."""
    out = {}
    for doc in db.collection("schools").document(school_id).collection("subjects").stream():
        data = doc.to_dict() or {}
        name = str(data.get("name") or "").strip() or (doc.id.split("_", 1)[1] if "_" in doc.id else doc.id)
        out[doc.id] = {"name": name, "hasCompetencies": _subject_has_competencies(data)}
    return out


def _norm_topic(value):
    return re.sub(r"[^a-z0-9]", "", str(value or "").lower())


@https_fn.on_call(region="asia-south1", memory=options.MemoryOption.GB_1, timeout_sec=300)
def aap_survey_completion(req: https_fn.CallableRequest) -> dict:
    """{school_id} -> whole-school AAP survey completion report. Read-only —
    no model calls, no writes, same as scan_only.

    Cross-references three independent sources: what school-setup says
    SHOULD exist (subjects + topics per grade), what teachers have actually
    submitted (zzz-prefixed responses, per class/subject/topic), and who is
    actually on each class's roster (class_resolver). A survey subject token
    and a school-setup subject name are two independently-spelled fields, so
    they are reconciled through the same alias matcher generate_aap_remarks
    uses for the rubric (subject_match.py) rather than compared as strings —
    anything that still doesn't resolve is reported, never guessed at.

    Returns:
      rows: one per (classId, subject, topic) that is either expected
        (school-setup) or actually submitted (a response doc) — the union of
        both, so a submission for a topic school-setup doesn't list still
        shows up rather than being silently dropped.
        { classId, subject, topic, teacherId, expectedStudents,
          respondedStudents, status: "not_started"|"partial"|"complete",
          gaps: [{ studentId, studentName, missing: [trait, ...] }],
          responses: [{ surveyId, responseId, subjectDocId, topicId,
            activityId, activityName, selectedGoals, selectedCompetencies }] }
        responses is empty for a not_started row; usually one entry
        otherwise, more only if the teacher filed the same class/topic under
        more than one activity (see _scan_school_aap_completion).
        respondedStudents is roster students with EVERY question answered
        (expectedStudents - len(gaps)) — never the raw count of distinct
        student ids in the response payload, which can equal the roster size
        by coincidence while naming a different set of students than the
        gaps list.
      unmatchedSubjectTokens: survey subject tokens that resolved to no
        school-setup subject in their grade at all.
      unparsedResponses: response doc ids that don't fit the naming
        convention (same meaning as generate_aap_remarks's scan_only field).
      diagnostics: { unresolvedStudents, gradesWithNoResolvedClasses,
        mergedStreamGrades } — why a subject/topic that IS configured in
        school-setup can still be entirely absent, or over-broad, in `rows`:
        gradesWithNoResolvedClasses is every student in that grade failing to
        resolve to a class at all (the grade never appears in the roster, so
        nothing can be built for it); mergedStreamGrades is every raw subject
        grade token that folded a stream into the grade ("XI Commerce") and
        had to be collapsed to its base grade to match anything at all — a
        stream-only subject will over-report as "expected" for every section
        of that grade as a result. Surfaced rather than silently producing
        wrong or missing rows, same principle as generate_aap_remarks's own
        scan_only diagnostics.
      goalOptions: { subjectDocId: [{ goal, competencies: [...] }] } for
        every subject a response points at — what the editor offers.
      activities: [{ id, name, stage }] — AAP activities a response can be
        moved to (see update_aap_survey_response).
      classStages: { classId: stage } — to narrow `activities` to the ones
        the teacher app would have offered that class.
    """
    _require_ops_admin(req)
    data = req.data or {}
    school_id = data.get("school_id")
    if not school_id:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT, "school_id is required")

    expected_by_grade, merged_stream_grades, skipped_blank_competencies, goals_by_doc = (
        _expected_subjects_by_grade(school_id))
    subject_docs = _subject_docs(school_id)
    class_setup, class_doc_ids, classes_without_subjects = _class_topic_setup(school_id, subject_docs)
    responses_by_key, unparsed = _scan_school_aap_completion(
        school_id, class_doc_ids=class_doc_ids, subject_doc_ids=list(subject_docs))
    roster_by_class, unresolved_students = _whole_school_roster(school_id)
    grades_with_no_classes = sorted(
        grade for grade in expected_by_grade
        if not any(cid.split("_", 1)[0] == grade for cid in roster_by_class))

    # One subject-alias index per grade, built the same way generate_aap_remarks
    # builds one per stage from aap_framework — here from school-setup's own
    # subject names instead, since that (not the rubric) is the "expected"
    # source of truth for this report.
    index_by_grade = {
        grade: build_subject_index([{"subject": s["subject"]} for s in subjects])
        for grade, subjects in expected_by_grade.items()
    }

    def make_gaps(roster, responded_students):
        gaps = []
        for student in roster:
            sid = student["id"]
            traits = responded_students.get(sid)
            if not traits:
                gaps.append({"studentId": sid, "studentName": student["name"],
                             "missing": ["awareness", "sensitivity", "creativity"]})
                continue
            missing = [t for t in ("awareness", "sensitivity", "creativity") if not traits.get(t)]
            if missing:
                gaps.append({"studentId": sid, "studentName": student["name"], "missing": missing})
        return gaps

    def build_row(class_id, subject, topic, entries, *, topic_id=None, subject_doc_id=None,
                  taught=None, completed_at=None, source="class", subject_token=None):
        roster = roster_by_class.get(class_id, [])
        students = {}
        responses = []
        teacher_ids = []
        not_applicable = 0
        for e in entries:
            for sid, traits in e["students"].items():
                merged = students.setdefault(sid, {})
                for t, v in traits.items():
                    merged[t] = merged.get(t, False) or v
            responses.extend(e["responses"])
            not_applicable += e["notApplicable"]
            if e["teacher_id"] not in teacher_ids:
                teacher_ids.append(e["teacher_id"])
        gaps = make_gaps(roster, students)
        # NOT len(students) — that counts every distinct student id appearing
        # anywhere in the response payload, which can equal the roster size
        # by coincidence while naming a different set of students. Counted
        # against the roster, so this number can never contradict the gaps.
        status = "complete" if roster and not gaps else ("partial" if students else "not_started")
        return {
            "classId": class_id, "subject": subject, "subjectToken": subject_token,
            "topic": topic, "topicId": topic_id, "subjectDocId": subject_doc_id,
            "teacherId": ", ".join(teacher_ids) or None,
            "expectedStudents": len(roster), "respondedStudents": len(roster) - len(gaps),
            "status": status, "gaps": gaps, "responses": responses,
            "taught": taught, "completedAt": completed_at, "source": source,
            "notApplicable": not_applicable,
        }

    rows = []
    unmatched_tokens = set()
    used = set()

    # Responses indexed for lookup: exact (class_id, topic_id), and a looser
    # (class_id, subject doc, normalized topic) for responses that had to be
    # parsed or whose topic id was renamed since.
    by_topic_id = defaultdict(list)
    by_loose = defaultdict(list)
    for key, entry in responses_by_key.items():
        by_topic_id[(entry["class_id"], entry["topic_id"])].append(key)
        by_loose[(entry["class_id"], entry["subject_doc_id"], _norm_topic(entry["topic"]))].append(key)

    # 1. Every topic each class actually teaches (classes/{id}.subjects).
    for class_id, setup in sorted(class_setup.items()):
        if class_id not in roster_by_class and not any(
                by_topic_id.get((class_id, t["topicId"])) for t in setup["topics"]):
            continue  # no students and no responses: an unused class doc
        for t in setup["topics"]:
            keys = [k for k in by_topic_id.get((class_id, t["topicId"]), []) if k not in used]
            if not keys:
                keys = [k for k in by_loose.get((class_id, t["subjectDocId"], _norm_topic(t["topic"])), [])
                        if k not in used]
            used.update(keys)
            rows.append(build_row(
                class_id, t["subject"], t["topic"], [responses_by_key[k] for k in keys],
                topic_id=t["topicId"], subject_doc_id=t["subjectDocId"],
                taught=t["taught"], completed_at=t["completedAt"], source="class"))

    # 2. Classes with no subjects array: the grade-wide school-setup list, as
    #    before, matched on subject name + normalized topic.
    fallback_classes = set(classes_without_subjects) | (set(roster_by_class) - set(class_setup))
    for grade, subjects in expected_by_grade.items():
        by_label, alias_index, _conflicts = index_by_grade.get(grade, ({}, {}, []))
        for class_id in sorted(c for c in fallback_classes if c.split("_", 1)[0] == grade):
            for subj in subjects:
                for topic in (subj["topics"] or [None]):
                    keys = []
                    for key, entry in responses_by_key.items():
                        if key in used or entry["class_id"] != class_id:
                            continue
                        fw, _how = resolve_subject(entry["subject_token"], by_label, alias_index)
                        if fw and fw["subject"] == subj["subject"] and _norm_topic(entry["topic"]) == _norm_topic(topic):
                            keys.append(key)
                    used.update(keys)
                    rows.append(build_row(
                        class_id, subj["subject"], topic, [responses_by_key[k] for k in keys],
                        source="school_setup"))

    # 3. Responses that matched nothing configured — shown, never dropped.
    for key, entry in responses_by_key.items():
        if key in used:
            continue
        grade = entry["class_id"].split("_", 1)[0]
        by_label, alias_index, _conflicts = index_by_grade.get(grade, ({}, {}, []))
        fw, _how = resolve_subject(entry["subject_token"], by_label, alias_index)
        info = subject_docs.get(entry["subject_doc_id"] or "")
        subject = (info or {}).get("name") or (fw["subject"] if fw else None)
        if not subject:
            unmatched_tokens.add(entry["subject_token"])
        rows.append(build_row(
            entry["class_id"], subject or entry["subject_token"], entry["topic"], [entry],
            topic_id=entry["topic_id"], subject_doc_id=entry["subject_doc_id"],
            source="response_only", subject_token=entry["subject_token"]))

    rows.sort(key=lambda r: (r["classId"], r["subject"], r["topic"] or ""))

    referenced_subject_docs = {resp["subjectDocId"] for r in rows for resp in r["responses"] if resp["subjectDocId"]}

    return {
        "rows": rows,
        "goalOptions": {doc_id: goals_by_doc.get(doc_id, []) for doc_id in sorted(referenced_subject_docs)},
        "activities": _aap_activities(school_id),
        "classStages": _class_stages(school_id),
        "unmatchedSubjectTokens": sorted(unmatched_tokens),
        "unparsedResponses": unparsed,
        "diagnostics": {
            "unresolvedStudents": unresolved_students,
            "gradesWithNoResolvedClasses": grades_with_no_classes,
            "mergedStreamGrades": merged_stream_grades,
            "skippedBlankCompetencies": skipped_blank_competencies,
            "classesWithoutSubjects": sorted(classes_without_subjects),
            "responsesNotInSetup": sum(1 for r in rows if r["source"] == "response_only"),
        },
    }


def _clean_str_list(values):
    """Non-blank strings, trimmed, de-duplicated in first-seen order."""
    if values is None:
        return None
    if not isinstance(values, list):
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT, "goals/competencies must be lists")
    out = []
    for v in values:
        v = str(v or "").strip()
        if v and v not in out:
            out.append(v)
    return out


@https_fn.on_call(region="asia-south1", memory=options.MemoryOption.MB_256, timeout_sec=60)
def update_aap_survey_response(req: https_fn.CallableRequest) -> dict:
    """{school_id, survey_id, response_id, activity_id?, selected_goals?,
    selected_competencies?} -> the response's new
    {surveyId, responseId, activityId, activityName, selectedGoals,
     selectedCompetencies}.

    The completion report's editor for what a teacher picked before answering
    the questions: the activity and the curricular goals/competencies. Only
    the fields passed are changed; the answers themselves are never touched.

    Goals/competencies are a plain field update on the response doc.

    The activity is not: in the teacher app the activity IS the survey doc a
    response lives under (surveys/{activityId}/responses/{id}), so changing it
    means moving the doc there, same id, answers and all. Done in one
    transaction with the delete of the old doc, so a failure can't leave the
    response in both places or in neither. Refused if the target activity
    already holds a response with the same id (the teacher filed this
    class/topic under both) — merging two sets of answers is a judgement call,
    not something to do silently. The topic's survey_initiated_by[teacher] is
    moved along with it when it still named the old activity, so "Continue
    Survey" in the teacher app reopens the response where it now lives
    instead of starting an empty one under the old activity.
    """
    caller = _require_ops_admin(req)
    data = req.data or {}
    school_id = data.get("school_id")
    survey_id = data.get("survey_id")
    response_id = data.get("response_id")
    if not school_id or not survey_id or not response_id:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT,
            "school_id, survey_id and response_id are required")
    if not str(survey_id).lower().startswith("zzz"):
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT, "Not an AAP survey")

    goals = _clean_str_list(data.get("selected_goals"))
    competencies = _clean_str_list(data.get("selected_competencies"))
    activity_id = str(data.get("activity_id") or "").strip() or None

    school_ref = db.collection("schools").document(school_id)
    source_ref = school_ref.collection("surveys").document(survey_id).collection("responses").document(response_id)

    update = {"opsEditedBy": caller, "opsEditedAt": firestore.SERVER_TIMESTAMP}
    if goals is not None:
        update["selectedGoals"] = goals
    if competencies is not None:
        update["selectedCompetencies"] = competencies

    target_survey_id = survey_id
    activity_name = None
    if activity_id:
        target_survey_id = _aap_survey_ids_by_activity(school_ref).get(activity_id)
        if not target_survey_id:
            raise https_fn.HttpsError(
                https_fn.FunctionsErrorCode.FAILED_PRECONDITION,
                f"Activity {activity_id} has no AAP survey to move this response under")
        activity_snap = school_ref.collection("activities").document(activity_id).get()
        activity_name = str((activity_snap.to_dict() or {}).get("name") or "") if activity_snap.exists else ""
        update["activityId"] = activity_id
        update["activityName"] = activity_name

    parsed = _parse_aap_response_id(response_id)
    target_ref = (school_ref.collection("surveys").document(target_survey_id)
                  .collection("responses").document(response_id))
    moving = target_survey_id != survey_id
    subject_ref = school_ref.collection("subjects").document(parsed["subject_doc_id"]) if parsed else None

    @firestore.transactional
    def apply(transaction):
        source_snap = source_ref.get(transaction=transaction)
        if not source_snap.exists:
            raise https_fn.HttpsError(
                https_fn.FunctionsErrorCode.NOT_FOUND,
                "That survey response no longer exists — re-run the completion check")
        current = source_snap.to_dict() or {}
        old_activity_id = current.get("activityId") or survey_id

        subject_snap = None
        if moving:
            if target_ref.get(transaction=transaction).exists:
                raise https_fn.HttpsError(
                    https_fn.FunctionsErrorCode.ALREADY_EXISTS,
                    "The teacher already has a response for this class/topic under that activity. "
                    "Edit that one instead, or clear one of them first.")
            if subject_ref is not None:
                subject_snap = subject_ref.get(transaction=transaction)

        merged = {**current, **update}
        if moving:
            transaction.set(target_ref, merged)
            transaction.delete(source_ref)
            if subject_snap is not None and subject_snap.exists and parsed:
                topics = list((subject_snap.to_dict() or {}).get("topics") or [])
                changed = False
                for topic in topics:
                    if not isinstance(topic, dict) or topic.get("id") != parsed["topic_id"]:
                        continue
                    initiated = topic.get("survey_initiated_by")
                    if isinstance(initiated, dict) and initiated.get(parsed["teacher_id"]) == old_activity_id:
                        initiated[parsed["teacher_id"]] = activity_id
                        changed = True
                if changed:
                    transaction.update(subject_ref, {"topics": topics})
        else:
            transaction.update(source_ref, update)
        return merged

    merged = apply(db.transaction())
    return {
        "surveyId": target_survey_id,
        "responseId": response_id,
        "activityId": merged.get("activityId") or target_survey_id,
        "activityName": merged.get("activityName") or "",
        "selectedGoals": [str(g) for g in (merged.get("selectedGoals") or [])],
        "selectedCompetencies": [str(c) for c in (merged.get("selectedCompetencies") or [])],
    }
