#!/usr/bin/env python3
"""
ClarifiEd material intake — School Material Import Cloud Functions.

Ports the extraction/validation logic from the `extract.py` prototype into a
callable Cloud Function (`process_import`) that writes results straight into
Firestore `staging_imports/{jobId}` (job doc + `rows/{n}` subcollection),
instead of CSV files, so the review UI can stream progress and 1000+ row
imports don't have to round-trip through the browser. `commit_import` is the
second half — it takes the already-classified plan the review UI built
client-side (src/composables/useImport.js's buildCommitPlan, still plain
Firestore reads, unchanged) and performs the actual writes into
`schools/{schoolId}/...` server-side.

Both are Firebase `on_call` callables, not raw HTTP functions: the callable
protocol handles CORS/preflight itself (no manual OPTIONS branch or
Access-Control-* headers needed) and gives each function a verified,
decoded Firebase Auth ID token at `req.auth` — no custom X-Api-Key header,
which is what raw `fetch()` + a hardcoded key both required and got wrong
(a plain HTTP Cloud Function that isn't itself invokable anonymously fails
IAM auth before your CORS headers ever get a chance to be written, which the
browser reports as a CORS error).

Deploy (per function, same source directory) — this repo deploys via plain
`gcloud functions deploy`, not `firebase deploy --only functions`, so the
`@https_fn.on_call(...)` decorator's memory/timeout_sec/max_instances/secrets
arguments are NOT read at deploy time (that introspection only happens
through the Firebase CLI's own build pipeline). They still matter for the
callable *behavior* (CORS/auth), but the actual Cloud Run resource limits
come from these gcloud flags and must be kept in sync with the decorator:
  gcloud functions deploy process_import \
    --gen2 --runtime python312 --region asia-south1 \
    --source . --entry-point process_import \
    --trigger-http --allow-unauthenticated \
    --memory 1024MB --timeout 540s --max-instances 3 --project clarified-1501 \
    --set-secrets OPENAI_API_KEY=OPENAI_API_KEY:latest \
    --set-env-vars MODEL=gpt-4o
  # (bind ANTHROPIC_API_KEY=ANTHROPIC_API_KEY:latest instead — and drop the
  # MODEL override, or set it to a Claude model — to extract from .pdf
  # uploads, which the OpenAI path can't handle; see call_openai_compatible)

  gcloud functions deploy commit_import \
    --gen2 --runtime python312 --region asia-south1 \
    --source . --entry-point commit_import \
    --trigger-http --allow-unauthenticated \
    --memory 512MB --timeout 120s --max-instances 3 --project clarified-1501

`--allow-unauthenticated` is still required at the IAM layer even for
callables — that only lets the request reach the function; the function
itself then checks `req.auth` (the Firebase ID token) and the ops-admin
allowlist before doing anything. See functions/DEPLOY.md for the Secret
Manager setup.

The function's runtime service account needs `roles/datastore.user` (Firestore
read/write) and `roles/storage.objectViewer` (read uploaded source files) on
the clarified-1501 project — grant those once via the Cloud Console/gcloud,
they aren't set up by this deploy command.
"""
import base64, json, os, re, statistics
from datetime import datetime, date
from pathlib import PurePosixPath

import requests

import firebase_admin
from firebase_admin import firestore, storage
from firebase_functions import https_fn, options

# No hardcoded default here — call_anthropic/call_openai_compatible each pick
# their own provider-appropriate default when MODEL isn't set (see extract_file
# for the provider switch: OpenAI when OPENAI_API_KEY is set, else Anthropic).
MODEL = os.environ.get("MODEL")

# Mirrors src/config/opsAdmins.js — keep in sync. Server-side is the
# authoritative check; the frontend's isOpsAdmin() is only a UI gate.
OPS_ADMIN_EMAILS = {"sid@ops.clarified.in", "angel@ops.clarified.in"}


def _require_ops_admin(req: https_fn.CallableRequest) -> str:
    """Verifies the callable's Firebase Auth token and the ops-admin
    allowlist server-side. Returns the caller's email for use in
    created_by/updated_by fields."""
    if req.auth is None:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.UNAUTHENTICATED, "Sign in required.")
    email = str((req.auth.token or {}).get("email") or "").strip().lower()
    if email not in OPS_ADMIN_EMAILS:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.PERMISSION_DENIED,
            "Not authorized for School Material Import.")
    return email

# ---------------------------------------------------------------- schemas ---
# Kept as-is from extract.py — the prompts already forbid Aadhaar/SSSM/caste/
# religion/address (golden rule 3); since stored rows are built by reading
# ONLY these declared keys off the LLM's JSON, any hallucinated extra field
# (banned or not) is dropped automatically before it ever reaches Firestore.
SCHEMAS = {
    "students": {
        "row": ["grade", "section", "roll_no", "student_name", "gender",
                "dob", "sr_no", "mother_name", "father_name", "contact"],
        "hints": (
            "grade: Nursery/LKG/UKG or 1..12 as plain numbers (convert roman numerals). "
            "section: single letter or empty. dob: YYYY-MM-DD; Excel serial numbers are "
            "days since 1899-12-30. Strip honorifics (MAS./MISS/MRS./MR.) from names and "
            "use them to infer gender. contact: first valid 10-digit number only. "
            "DO NOT extract Aadhaar numbers, SSSM ids, caste/category, religion, or "
            "addresses even if present — omit them entirely."
        ),
        "required": ["grade", "student_name"],
    },
    "teachers": {
        "row": ["teacher_name", "email", "class_teacher_of", "subject", "grade", "section"],
        "hints": (
            "Output ONE ROW PER (teacher, subject, class-section). Expand ranges: "
            "'VI - A,B,C' becomes three rows grade=6 sections A,B,C; '3 to 8' expands "
            "each grade with empty section. In matrix layouts the column header is the "
            "subject — read column alignment carefully. If a cell's column is visually "
            "ambiguous, still output the row but append '?' to the subject."
        ),
        "required": ["teacher_name", "subject", "grade"],
    },
    "subjects": {
        "row": ["stream", "grade_band", "subject", "area"],
        "hints": "area is 'Scholastic' or 'Co-Scholastic'. stream e.g. CBSE / International / SA; empty if not stated.",
        "required": ["subject"],
    },
    "assessments": {
        "row": ["stream", "grade_band", "assessment", "date_start", "date_end",
                "instructional_days", "syllabus_covered", "exam_syllabus",
                "max_written", "activity_weight", "total", "duration"],
        "hints": "Dates as YYYY-MM-DD. Keep composite marks like '80 (40+40)' verbatim in max_written.",
        "required": ["assessment"],
    },
}

BANNED_KEYS = {"aadhaar", "sssm_id", "sssm", "caste", "category", "religion", "address"}

# ------------------------------------------------------------- preprocess ---
def xlsx_to_tsv(raw: bytes) -> str:
    import io
    from openpyxl import load_workbook
    wb = load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
    out = []
    for name in wb.sheetnames:
        out.append(f"## Sheet: {name}")
        for row in wb[name].iter_rows(values_only=True):
            if any(v is not None and str(v).strip() for v in row):
                out.append("\t".join("" if v is None else str(v) for v in row))
    return "\n".join(out)

def docx_to_text(raw: bytes) -> str:
    import io
    import docx
    d = docx.Document(io.BytesIO(raw))
    parts = [p.text for p in d.paragraphs if p.text.strip()]
    for t in d.tables:
        for r in t.rows:
            parts.append("\t".join(c.text.strip() for c in r.cells))
        parts.append("")
    return "\n".join(parts)

def content_blocks(filename: str, raw: bytes):
    """Returns Anthropic-style content blocks for the file."""
    ext = PurePosixPath(filename).suffix.lower()
    if ext in (".xlsx", ".xlsm"):
        return [{"type": "text", "text": xlsx_to_tsv(raw)}]
    if ext == ".docx":
        return [{"type": "text", "text": docx_to_text(raw)}]
    if ext == ".pdf":
        data = base64.b64encode(raw).decode()
        return [{"type": "document",
                 "source": {"type": "base64", "media_type": "application/pdf", "data": data}}]
    if ext in (".png", ".jpg", ".jpeg", ".webp"):
        media = "image/png" if ext == ".png" else "image/jpeg"
        data = base64.b64encode(raw).decode()
        return [{"type": "image",
                 "source": {"type": "base64", "media_type": media, "data": data}}]
    return [{"type": "text", "text": raw.decode(errors="replace")}]

# -------------------------------------------------------------- llm calls ---
def build_prompt(entity: str) -> str:
    s = SCHEMAS[entity]
    return (
        "You are a data-extraction engine for an Indian school report-card platform. "
        f"Extract ALL {entity} records from the attached material.\n"
        f"Rules: {s['hints']}\n"
        "Return ONLY a JSON array of objects (no markdown, no commentary) with exactly "
        f"these keys: {json.dumps(s['row'])}. Use empty string for unknown values. "
        "Never invent data not present in the source."
    )

def call_anthropic(blocks, prompt):
    r = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={"x-api-key": os.environ["ANTHROPIC_API_KEY"],
                 "anthropic-version": "2023-06-01"},
        json={"model": MODEL or "claude-sonnet-4-6", "max_tokens": 16000,
              "messages": [{"role": "user",
                            "content": blocks + [{"type": "text", "text": prompt}]}]},
        timeout=300)
    r.raise_for_status()
    return "".join(b.get("text", "") for b in r.json()["content"])

def call_openai_compatible(blocks, prompt):
    # Defaults to the real OpenAI API; override OPENAI_BASE_URL to point at a
    # self-hosted OpenAI-compatible endpoint instead.
    content = []
    for b in blocks:
        if b["type"] == "text":
            content.append({"type": "text", "text": b["text"]})
        elif b["type"] == "image":
            url = f'data:{b["source"]["media_type"]};base64,{b["source"]["data"]}'
            content.append({"type": "image_url", "image_url": {"url": url}})
        else:
            # OpenAI's Chat Completions API has no raw-PDF content block (unlike
            # Anthropic's Messages API) — .pdf uploads aren't extractable on this
            # path without rasterizing pages to images first.
            raise RuntimeError("PDF input isn't supported via the OpenAI extraction path (rasterize pages to PNG first, or set ANTHROPIC_API_KEY instead).")
    content.append({"type": "text", "text": prompt})
    base_url = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1")
    r = requests.post(
        base_url.rstrip("/") + "/chat/completions",
        headers={"Authorization": "Bearer " + os.environ.get("OPENAI_API_KEY", "x")},
        json={"model": MODEL or "gpt-4o",
              "messages": [{"role": "user", "content": content}],
              "max_tokens": 16000},
        timeout=300)
    r.raise_for_status()
    return r.json()["choices"][0]["message"]["content"]

def extract_file(entity, filename, raw):
    blocks = content_blocks(filename, raw)
    prompt = build_prompt(entity)
    raw_text = (call_openai_compatible if os.environ.get("OPENAI_API_KEY")
                else call_anthropic)(blocks, prompt)
    raw_text = re.sub(r"^```(json)?|```$", "", raw_text.strip(), flags=re.M).strip()
    rows = json.loads(raw_text)
    schema_keys = SCHEMAS[entity]["row"]
    # Only ever keep declared schema keys — drops any hallucinated PII field
    # regardless of prompt compliance (golden rule 3, belt-and-braces).
    return [{k: str(r.get(k, "") or "") for k in schema_keys} for r in rows]

# ------------------------------------------------------- grade normalizing ---
ROMAN_TO_NUM = {"I": 1, "II": 2, "III": 3, "IV": 4, "V": 5, "VI": 6, "VII": 7,
                "VIII": 8, "IX": 9, "X": 10, "XI": 11, "XII": 12}

def normalize_grade(g):
    """Map roman numerals / plain numbers / Nursery-LKG-UKG onto one comparable
    form, since a school's live `classes.clazz` values and the LLM's extracted
    `grade` values may use different conventions (extract.py normalizes to
    plain numbers, but existing classes were hand-entered as e.g. 'III')."""
    g = (g or "").strip()
    if not g:
        return ""
    upper = g.upper()
    if upper in ("NURSERY", "LKG", "UKG"):
        return upper
    if upper in ROMAN_TO_NUM:
        return str(ROMAN_TO_NUM[upper])
    if g.isdigit():
        return str(int(g))
    return upper

def normalize_section(s):
    return (s or "").strip().upper()

# -------------------------------------------------------------- validate ----
def parse_dob(d):
    d = (d or "").strip()
    if not d or not re.match(r"^\d{4}-\d{2}-\d{2}$", d):
        return None
    try:
        return datetime.strptime(d, "%Y-%m-%d").date()
    except ValueError:
        return None

def validate_students(rows, class_lookup):
    flags_by_row = [[] for _ in rows]
    seen_names = {}
    dobs_by_grade = {}
    parsed_dobs = [None] * len(rows)

    for i, r in enumerate(rows):
        if not r.get("student_name", "").strip():
            flags_by_row[i].append("missing student_name")
        if not r.get("grade", "").strip():
            flags_by_row[i].append("missing grade")
        dob_raw = r.get("dob", "").strip()
        if not dob_raw:
            flags_by_row[i].append("missing dob")
        else:
            d = parse_dob(dob_raw)
            if d is None:
                flags_by_row[i].append(f"unparseable dob: {dob_raw}")
            else:
                parsed_dobs[i] = d
                dobs_by_grade.setdefault(r.get("grade", ""), []).append(d)
        if not r.get("gender", "").strip():
            flags_by_row[i].append("missing gender")
        if not r.get("contact", "").strip():
            flags_by_row[i].append("missing contact")

        key = (normalize_grade(r.get("grade")), normalize_section(r.get("section")),
               r.get("student_name", "").strip().lower())
        if key[2]:
            if key in seen_names:
                flags_by_row[i].append("duplicate student name in class-section")
            seen_names[key] = True

        gkey = (normalize_grade(r.get("grade")), normalize_section(r.get("section")))
        if gkey not in class_lookup:
            flags_by_row[i].append("class-section not present in school's configured structure")

    # DOB implausible for grade: >3 years off the grade's median.
    medians = {g: statistics.median([d.toordinal() for d in ds]) for g, ds in dobs_by_grade.items() if ds}
    for i, r in enumerate(rows):
        d = parsed_dobs[i]
        if d is None:
            continue
        med = medians.get(r.get("grade", ""))
        if med is None:
            continue
        years_off = abs(d.toordinal() - med) / 365.25
        if years_off > 3:
            flags_by_row[i].append(f"dob implausible for grade ({years_off:.1f}y off class median)")

    return flags_by_row

def validate_teachers(rows, class_lookup, subject_names_by_grade):
    flags_by_row = [[] for _ in rows]

    # Group by normalized teacher identity to find zero-assignment teachers.
    by_teacher = {}
    for i, r in enumerate(rows):
        tkey = (r.get("teacher_name", "").strip().lower(), r.get("email", "").strip().lower())
        by_teacher.setdefault(tkey, []).append(i)

    for i, r in enumerate(rows):
        if not r.get("teacher_name", "").strip():
            flags_by_row[i].append("missing teacher_name")
        gkey = (normalize_grade(r.get("grade")), normalize_section(r.get("section")))
        if r.get("grade", "").strip() and gkey not in class_lookup:
            flags_by_row[i].append("grade/section not present in school's configured structure")

        subject = r.get("subject", "").strip().rstrip("?")
        if subject:
            allowed = subject_names_by_grade.get(normalize_grade(r.get("grade")))
            if allowed is not None and subject.lower() not in allowed:
                flags_by_row[i].append(f"subject '{subject}' not in school's subject list for this grade")
        # NOTE: deliberately NOT flagging multiple teachers assigned to the
        # same (subject, grade, section) — golden rule 2, that's valid.

    for tkey, idxs in by_teacher.items():
        if all(not rows[i].get("subject", "").strip() for i in idxs):
            for i in idxs:
                flags_by_row[i].append("teacher has zero subject assignments")

    return flags_by_row

def validate_required_fields(entity, rows):
    required = SCHEMAS[entity]["required"]
    flags_by_row = []
    for r in rows:
        flags = []
        for k in required:
            if not r.get(k, "").strip():
                flags.append(f"missing {k}")
        flags_by_row.append(flags)
    return flags_by_row

def core_subject_coverage_flags(rows, class_lookup, subjects_by_class, core_subjects_by_grade):
    """Job-level (not per-row) check: any (class, core subject) with zero
    teacher rows covering it. Best-effort — 'core' comes from live subjects'
    `area` field when present, else falls back to every subject already
    attached to the class in `classes/{id}.subjects[]` (no area data to
    narrow it further)."""
    covered = set()
    for r in rows:
        gkey = (normalize_grade(r.get("grade")), normalize_section(r.get("section")))
        classId = class_lookup.get(gkey)
        subject = r.get("subject", "").strip().rstrip("?")
        if classId and subject:
            covered.add((classId, subject.lower()))

    out = []
    for classId, subject_ids in subjects_by_class.items():
        grade = classId.split("_")[0] if "_" in classId else classId
        core = core_subjects_by_grade.get(grade)
        candidates = core if core is not None else subject_ids
        for subjectId in candidates:
            subj_name = subjectId.split("_", 1)[-1].replace("_", " ")
            if (classId, subj_name.lower()) not in covered and (classId, subjectId.lower()) not in covered:
                out.append(f"{classId}: no teacher assigned for core subject '{subjectId}'")
    return out

# --------------------------------------------------------- school config ----
def load_school_config(db, school_id, entity):
    classes_ref = db.collection("schools").document(school_id).collection("classes")
    classes = [{"id": d.id, **d.to_dict()} for d in classes_ref.stream()]
    class_lookup = {}
    subjects_by_class = {}
    for c in classes:
        gkey = (normalize_grade(c.get("clazz")), normalize_section(c.get("section")))
        class_lookup[gkey] = c["id"]
        subjects_by_class[c["id"]] = [s.get("subjectId") for s in (c.get("subjects") or []) if s.get("subjectId")]

    subject_names_by_grade = None
    core_subjects_by_grade = {}
    if entity == "teachers":
        subjects_ref = db.collection("schools").document(school_id).collection("subjects")
        subject_docs = [{"id": d.id, **d.to_dict()} for d in subjects_ref.stream()]
        subject_names_by_grade = {}
        has_area = any("area" in s for s in subject_docs)
        for s in subject_docs:
            grade = normalize_grade(s["id"].split("_", 1)[0]) if "_" in s["id"] else ""
            name = (s.get("name") or "").strip().lower()
            subject_names_by_grade.setdefault(grade, set()).add(name)
            if has_area and (s.get("area") or "").strip().lower() == "scholastic":
                core_subjects_by_grade.setdefault(grade, set()).add(s["id"])

    return class_lookup, subjects_by_class, subject_names_by_grade, core_subjects_by_grade

# ------------------------------------------------------------------ main ----
_app_initialized = False
def _ensure_firebase():
    global _app_initialized
    if not _app_initialized:
        firebase_admin.initialize_app()
        _app_initialized = True

@https_fn.on_call(
    region="asia-south1",
    memory=options.MemoryOption.GB_1,
    timeout_sec=540,
    max_instances=3,
    # OPENAI_API_KEY is the active provider (see extract_file's provider
    # switch above); ANTHROPIC_API_KEY still works if bound instead — e.g.
    # for .pdf uploads, which the OpenAI path can't extract from directly.
    secrets=["OPENAI_API_KEY"],
)
def process_import(req: https_fn.CallableRequest):
    _require_ops_admin(req)

    data = req.data or {}
    school_id = (data.get("schoolId") or "").strip()
    job_id = (data.get("jobId") or "").strip()
    entity = (data.get("entity") or "").strip()
    files = data.get("files") or []

    if not school_id or not job_id or entity not in SCHEMAS or not files:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT,
            "Missing schoolId, jobId, valid entity, or files")

    _ensure_firebase()
    db = firestore.client()
    bucket = storage.bucket()
    job_ref = db.collection("staging_imports").document(job_id)

    try:
        job_ref.set({
            "school_id": school_id, "entity": entity,
            "source_files": [f["path"] for f in files],
            "status": "processing", "model_used": MODEL,
        }, merge=True)

        all_rows = []
        for f in files:
            blob = bucket.blob(f["path"])
            raw = blob.download_as_bytes()
            all_rows.extend(extract_file(entity, f.get("name", f["path"]), raw))

        class_lookup, subjects_by_class, subject_names_by_grade, core_subjects_by_grade = \
            load_school_config(db, school_id, entity)

        if entity == "students":
            flags_by_row = validate_students(all_rows, class_lookup)
            class_level_flags = []
        elif entity == "teachers":
            flags_by_row = validate_teachers(all_rows, class_lookup, subject_names_by_grade)
            class_level_flags = core_subject_coverage_flags(
                all_rows, class_lookup, subjects_by_class, core_subjects_by_grade)
        else:
            flags_by_row = validate_required_fields(entity, all_rows)
            class_level_flags = []

        rows_ref = job_ref.collection("rows")
        flag_count = 0
        for i in range(0, len(all_rows), 450):
            batch = db.batch()
            for j in range(i, min(i + 450, len(all_rows))):
                row_flags = flags_by_row[j]
                flag_count += len(row_flags)
                batch.set(rows_ref.document(str(j)), {
                    "data": all_rows[j], "flags": row_flags,
                    "edited": False, "excluded": False,
                })
            batch.commit()

        job_ref.set({
            "status": "ready", "row_count": len(all_rows), "flag_count": flag_count,
            "class_level_flags": class_level_flags,
            "completed_at": firestore.SERVER_TIMESTAMP,
        }, merge=True)

        return {"status": "ready", "rowCount": len(all_rows), "flagCount": flag_count}

    except https_fn.HttpsError:
        raise
    except Exception as e:
        job_ref.set({"status": "failed", "error": str(e)}, merge=True)
        raise https_fn.HttpsError(https_fn.FunctionsErrorCode.INTERNAL, str(e))


# --------------------------------------------------------------- commit -----
# Takes the plan the review UI already built client-side (useImport.js's
# buildCommitPlan — plain Firestore reads against classes/subjects/staffs,
# unchanged) and performs the actual writes into schools/{schoolId}/... here,
# server-side, so the write path gets the same req.auth + allowlist check as
# extraction instead of relying on the client's own Firestore permissions.
# `items` mirrors plan.items from useImport.js, trimmed to just what's needed
# to write: {status, docId, payload} for students/subjects/assessments, or
# {status, staffId, staffIsNew, classId, subjectId, staffBase} for teachers.
@https_fn.on_call(region="asia-south1", memory=options.MemoryOption.MB_512,
                   timeout_sec=120, max_instances=3)
def commit_import(req: https_fn.CallableRequest):
    email = _require_ops_admin(req)

    data = req.data or {}
    school_id = (data.get("schoolId") or "").strip()
    job_id = (data.get("jobId") or "").strip()
    entity = (data.get("entity") or "").strip()
    items = data.get("items") or []
    overwrite_existing = bool(data.get("overwriteExisting"))

    if not school_id or not job_id or entity not in ("students", "teachers", "subjects", "assessments"):
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT,
            "Missing schoolId, jobId, or valid entity")

    _ensure_firebase()
    db = firestore.client()
    school_ref = db.collection("schools").document(school_id)
    job_ref = db.collection("staging_imports").document(job_id)

    writable = [it for it in items if it.get("status") == "CREATE"
                or (it.get("status") == "UPDATE_CHANGED" and overwrite_existing)]

    try:
        if entity in ("students", "subjects"):
            _commit_simple(db, school_ref.collection(entity), writable, email)
        elif entity == "assessments":
            _commit_assessments(db, school_ref.collection("assessments"), writable, email)
        elif entity == "teachers":
            _commit_teachers(school_ref.collection("staffs"), writable, email)

        job_ref.set({
            "status": "committed", "committed_at": firestore.SERVER_TIMESTAMP,
            "committed_by": email,
        }, merge=True)

        return {"written": len(writable), "skipped": len(items) - len(writable)}

    except https_fn.HttpsError:
        raise
    except Exception as e:
        raise https_fn.HttpsError(https_fn.FunctionsErrorCode.INTERNAL, str(e))


def _commit_simple(db, collection_ref, writable, email):
    """students / subjects: one doc per item, merge-set."""
    for i in range(0, len(writable), 450):
        batch = db.batch()
        for item in writable[i:i + 450]:
            payload = dict(item.get("payload") or {})
            payload["updated_at"] = firestore.SERVER_TIMESTAMP
            payload["updated_by"] = email
            if item.get("status") == "CREATE":
                payload["created_at"] = firestore.SERVER_TIMESTAMP
                payload["created_by"] = email
            batch.set(collection_ref.document(item["docId"]), payload, merge=True)
        batch.commit()


def _commit_assessments(db, collection_ref, writable, email):
    """Assessments are always CREATE (buildAssessmentsPlan never emits
    UPDATE_* — see its comment in useImport.js), but always stamp both
    created_* and updated_* to match the original client-side behavior."""
    for i in range(0, len(writable), 450):
        batch = db.batch()
        for item in writable[i:i + 450]:
            payload = dict(item.get("payload") or {})
            payload["updated_at"] = firestore.SERVER_TIMESTAMP
            payload["updated_by"] = email
            payload["created_at"] = firestore.SERVER_TIMESTAMP
            payload["created_by"] = email
            batch.set(collection_ref.document(item["docId"]), payload, merge=True)
        batch.commit()


def _commit_teachers(staffs_ref, writable, email):
    """Group by staff so each teacher gets exactly one write with a merged
    assignments map — never overwrite another subject's assignment for the
    same class, and never drop a second teacher on the same
    (subject, grade, section): that's staffs/{idA} and staffs/{idB} each
    separately gaining the same classId+subjectId in their own doc."""
    by_staff = {}
    for item in writable:
        staff_id = item.get("staffId")
        if staff_id not in by_staff:
            by_staff[staff_id] = {
                "staffIsNew": item.get("staffIsNew"),
                "staffBase": item.get("staffBase") or {},
                "adds": [],
            }
        by_staff[staff_id]["adds"].append(item)

    for staff_id, group in by_staff.items():
        assignments = {}
        class_ids = []
        if not group["staffIsNew"]:
            snap = staffs_ref.document(staff_id).get()
            if snap.exists:
                d = snap.to_dict() or {}
                assignments = dict(d.get("assignments") or {})
                class_ids = list(d.get("classIds") or [])
        class_id_set = set(class_ids)
        for item in group["adds"]:
            subject_id = item.get("subjectId")
            if not subject_id:
                continue
            class_id = item.get("classId")
            existing = set(assignments.get(class_id) or [])
            existing.add(subject_id)
            assignments[class_id] = list(existing)
            class_id_set.add(class_id)

        payload = {
            "assignments": assignments, "classIds": list(class_id_set),
            "updated_at": firestore.SERVER_TIMESTAMP, "updated_by": email,
        }
        if group["staffIsNew"]:
            base = group["staffBase"]
            payload.update({
                "id": staff_id, "name": base.get("name") or "", "email": base.get("email") or "",
                "type": "teacher", "needsAuthCreation": True, "authUid": None,
                "created_at": firestore.SERVER_TIMESTAMP, "created_by": email,
            })
        staffs_ref.document(staff_id).set(payload, merge=True)
