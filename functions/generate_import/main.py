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
import base64, difflib, json, os, re, statistics
from datetime import datetime, date
from pathlib import PurePosixPath

import requests

import firebase_admin
from firebase_admin import firestore, storage
from firebase_functions import https_fn, options

# Must run at module load, not lazily inside a handler: the on_call framework
# verifies the caller's Firebase Auth ID token BEFORE our function body ever
# runs, and that verification itself needs the Admin SDK already initialized
# to decode the token. A lazy _ensure_firebase() called from inside the
# handler is too late — on a cold start with a real (non-empty) ID token,
# verification crashes with "The default Firebase app does not exist" before
# our code, including our own req.auth check, ever executes.
# storageBucket must be explicit — unlike some Admin SDKs, initialize_app()
# doesn't infer it, and storage.bucket() then fails with "Storage bucket
# name not specified" (matches src/firebase/config.js's storageBucket).
firebase_admin.initialize_app(options={"storageBucket": "clarified-1501.appspot.com"})

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

# --------------------------------------------------------------- cleaning ---
# Real school sheets are messy — typo email domains, "Garde 7,10", stray
# whitespace, "Eng" vs "English" — and without this stage nearly every row
# gets flagged/skipped even when the data is trivially recoverable. This runs
# on every parsed row BEFORE validate_*/flag generation below. Every auto-fix
# is recorded as {field, original, fixed, rule} so review stays lossless:
# originals are always visible, nothing here writes to the live DB directly,
# and anything uncertain becomes a *suggestion* (shown for one-click accept
# in review) or a hard flag — never a silent guess.

EMAIL_DOMAIN_FIXES = {
    "gamil.com": "gmail.com", "gmial.com": "gmail.com", "gmal.com": "gmail.com",
    "gmaill.com": "gmail.com", "yahooo.com": "yahoo.com",
}
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

def clean_email(raw):
    """Trim, lowercase, fix known typo domains. Returns (cleaned, fix_or_None,
    is_valid). Never guesses a missing/still-invalid address — that's always
    a hard flag for validate_teachers to raise, not an auto-fix."""
    original = raw or ""
    v = original.strip().lower()
    rule = "email_normalize"
    if "@" in v:
        local, _, domain = v.rpartition("@")
        if domain in EMAIL_DOMAIN_FIXES:
            v = f"{local}@{EMAIL_DOMAIN_FIXES[domain]}"
            rule = "email_domain_typo"
    valid = bool(_EMAIL_RE.match(v))
    fix = {"field": "email", "original": original, "fixed": v, "rule": rule} if v != original and valid else None
    return v, fix, valid


_GRADE_WORD_RE = re.compile(r"gr[ae]de", re.IGNORECASE)
_GRADE_TOKEN_RE = re.compile(
    r"\b(nursery|lkg|ukg|xii|xi|x|ix|viii|vii|vi|iv|v|iii|ii|i|\d{1,2})\b", re.IGNORECASE)

def extract_grade_tokens(raw):
    """Tolerant grade-cell parser: strips a leading 'Grade'/'Garde' (any
    case/typo/spacing) then pulls out every recognizable grade token
    regardless of separators/spacing. 'Garde 7,10' -> ['7','10']; 'Grade7,8,9'
    -> ['7','8','9']; 'Grade 8, 9 ' -> ['8','9']. Returns normalize_grade()'d
    tokens, deduped, first-seen order — empty list if nothing recognizable."""
    s = _GRADE_WORD_RE.sub(" ", raw or "")
    tokens = []
    for m in _GRADE_TOKEN_RE.finditer(s):
        norm = normalize_grade(m.group(1))
        if norm and norm not in tokens:
            tokens.append(norm)
    return tokens


_WS_RE = re.compile(r"\s+")
_INITIAL_RE = re.compile(r"^(?:[A-Za-z]\.)+$")

def clean_name(raw):
    """Collapse multiple spaces, trim, title-case — preserving initials like
    'P.B.' as-is instead of mangling them into 'P.b.'. Returns (cleaned,
    fix_or_None); caller fills in `field` on the fix dict."""
    original = raw or ""
    collapsed = _WS_RE.sub(" ", original.strip())
    words = [w if _INITIAL_RE.match(w) else (w[:1].upper() + w[1:].lower() if w else w)
             for w in collapsed.split(" ")]
    v = " ".join(words)
    fix = {"original": original, "fixed": v, "rule": "name_normalize"} if v != original else None
    return v, fix


def canonicalize(s):
    """Comparison key only, never a display value: lowercase, strip
    spaces/hyphens/dots. 'LKG-champion', 'LKG champion' and 'lkg.champion'
    all canonicalize the same."""
    return re.sub(r"[\s\-.]+", "", (s or "").strip().lower())


def load_import_aliases(db):
    """Global alias map (top-level `import_aliases` collection, not scoped to
    any one school) — {(type, canonical_from): display_to}. An exact hit here
    is an auto-fix, applied the same way for every school. Sid accepting a
    suggestion (or manually mapping a value) in review writes back here
    client-side, so later imports for ANY school auto-apply it — see
    src/composables/useImport.js's acceptSuggestion."""
    aliases = {}
    for d in db.collection("import_aliases").stream():
        a = d.to_dict() or {}
        t, frm, to = a.get("type"), a.get("from"), a.get("to")
        if t and frm and to:
            aliases[(t, frm)] = to
    return aliases


FUZZY_THRESHOLD = 0.85

def fuzzy_best_match(value_canon, candidates):
    """candidates: {canonical: display}. Returns (best_display, best_ratio),
    or (None, 0.0) if candidates is empty. difflib (stdlib) rather than
    Levenshtein/rapidfuzz — no extra pip dependency to manage in a Cloud
    Function, and Ratcliff/Obershelp similarity serves the same near-match
    purpose the task calls for."""
    best_display, best_ratio = None, 0.0
    for canon, display in candidates.items():
        ratio = difflib.SequenceMatcher(None, value_canon, canon).ratio()
        if ratio > best_ratio:
            best_display, best_ratio = display, ratio
    return best_display, best_ratio


def match_value(raw, alias_type, valid_canon_to_display, aliases):
    """Canonicalize + alias + fuzzy match for subject/section values against
    the school's configured set. Returns one of:
      ("auto", display, rule)        - exact canonical or alias hit
      ("suggestion", display, ratio) - fuzzy >= FUZZY_THRESHOLD, NOT applied
      ("unknown", None, None)        - below threshold — hard-flag territory
    Never guesses below threshold; that's the entire point of Stage 2."""
    original = (raw or "").strip()
    if not original:
        return "unknown", None, None
    canon = canonicalize(original)
    if canon in valid_canon_to_display:
        return "auto", valid_canon_to_display[canon], "canonical_match"
    alias_hit = aliases.get((alias_type, canon))
    if alias_hit:
        return "auto", alias_hit, "alias_match"
    display, ratio = fuzzy_best_match(canon, valid_canon_to_display)
    if display and ratio >= FUZZY_THRESHOLD:
        return "suggestion", display, ratio
    return "unknown", None, None


def clean_students_rows(rows, cfg):
    """Stage 1 + 2 for students: name cleanup, tolerant grade parsing (first
    token only — a student has one grade; multiple tokens is itself flagged
    as ambiguous, not expanded), and section canonicalize/alias/fuzzy against
    that grade's configured sections. Returns a list of
    {data, fixes, suggestions, flags} — `flags` here only covers what
    validate_students below has no way to catch on its own (an ambiguous
    multi-grade cell); everything else it flags is appended afterward, once
    run over this (now cleaner) `data`."""
    out = []
    for r in rows:
        d = dict(r)
        fixes, suggestions, flags = [], [], []

        for field in ("student_name", "mother_name", "father_name"):
            v, fix = clean_name(d.get(field, ""))
            d[field] = v
            if fix:
                fixes.append({**fix, "field": field})

        grade_raw = d.get("grade", "")
        tokens = extract_grade_tokens(grade_raw)
        if tokens:
            grade = tokens[0]
            if grade != grade_raw.strip():
                fixes.append({"field": "grade", "original": grade_raw, "fixed": grade, "rule": "grade_parsed"})
            d["grade"] = grade
            if len(tokens) > 1:
                flags.append({"field": "grade", "message": f"multiple grades found in '{grade_raw}' — using '{grade}', please verify"})
        else:
            grade = ""

        section_raw = d.get("section", "")
        if section_raw.strip():
            candidates = cfg["sections_by_grade"].get(grade, {})
            status, display, extra = match_value(section_raw, "class", candidates, cfg["aliases"])
            if status == "auto":
                if display != section_raw.strip():
                    fixes.append({"field": "section", "original": section_raw, "fixed": display, "rule": extra})
                d["section"] = display
            elif status == "suggestion":
                suggestions.append({"field": "section", "original": section_raw, "suggested": display, "similarity": round(extra, 2)})

        out.append({"data": d, "fixes": fixes, "suggestions": suggestions, "flags": flags})
    return out


def clean_teachers_rows(rows, cfg):
    """Stage 1 + 2 for teachers. Grade is the one field that can legitimately
    EXPAND a row: a multi-grade cell ('Garde 7,10') means one teacher-subject
    assignment spanning several grades, which the LLM is supposed to expand
    into separate rows itself but doesn't always manage — this is the
    deterministic fallback. Section/subject are then canonicalized per the
    row's own (possibly newly-split) grade. Returns a list of
    {data, fixes, suggestions, flags}, one per OUTPUT row (>= len(rows));
    `flags` is always empty here — a multi-grade cell is expected/valid for
    teachers, not ambiguous, so there's nothing cleaning itself needs to flag
    (unlike students) — validate_teachers appends everything else."""
    out = []
    for r in rows:
        base_fixes = []

        v, fix = clean_name(r.get("teacher_name", ""))
        if fix:
            base_fixes.append({**fix, "field": "teacher_name"})

        email_raw = r.get("email", "")
        # Validity itself isn't checked here — validate_teachers below raises
        # the hard flag for a missing "@" or still-invalid address, same as
        # every other unresolved field, once run over this cleaned data.
        email_v, email_fix, _ = clean_email(email_raw)
        if email_fix:
            base_fixes.append(email_fix)

        grade_raw = r.get("grade", "")
        tokens = extract_grade_tokens(grade_raw)
        grades = tokens if tokens else [""]

        for grade in grades:
            d = dict(r)
            d["teacher_name"] = v
            d["email"] = email_v
            fixes = list(base_fixes)
            suggestions = []

            if grade:
                d["grade"] = grade
                if grade != grade_raw.strip() or len(tokens) > 1:
                    rule = "grade_parsed_expanded" if len(tokens) > 1 else "grade_parsed"
                    fixes.append({"field": "grade", "original": grade_raw, "fixed": grade, "rule": rule})

            section_raw = d.get("section", "")
            if section_raw.strip():
                candidates = cfg["sections_by_grade"].get(grade, {})
                status, display, extra = match_value(section_raw, "class", candidates, cfg["aliases"])
                if status == "auto":
                    if display != section_raw.strip():
                        fixes.append({"field": "section", "original": section_raw, "fixed": display, "rule": extra})
                    d["section"] = display
                elif status == "suggestion":
                    suggestions.append({"field": "section", "original": section_raw, "suggested": display, "similarity": round(extra, 2)})

            subject_raw = d.get("subject", "")
            subject_ambiguous = subject_raw.endswith("?")
            subject_clean = subject_raw.rstrip("?").strip()
            if subject_clean:
                candidates = cfg["subjects_by_grade_canon"].get(grade, {})
                status, display, extra = match_value(subject_clean, "subject", candidates, cfg["aliases"])
                if status == "auto":
                    fixed_value = display + ("?" if subject_ambiguous else "")
                    if fixed_value != subject_raw:
                        fixes.append({"field": "subject", "original": subject_raw, "fixed": fixed_value, "rule": extra})
                    d["subject"] = fixed_value
                elif status == "suggestion":
                    suggestions.append({"field": "subject", "original": subject_raw, "suggested": display, "similarity": round(extra, 2)})

            out.append({"data": d, "fixes": fixes, "suggestions": suggestions, "flags": []})
    return out

# -------------------------------------------------------------- validate ----
def parse_dob(d):
    d = (d or "").strip()
    if not d or not re.match(r"^\d{4}-\d{2}-\d{2}$", d):
        return None
    try:
        return datetime.strptime(d, "%Y-%m-%d").date()
    except ValueError:
        return None

def _flag(field, message):
    """Structured flag: {field, message}. `field` is None for row-level
    checks not tied to one cell (duplicate name, DOB-vs-median) — lets the
    review UI clear only the flags a specific accepted suggestion resolves,
    instead of guessing from message text."""
    return {"field": field, "message": message}

def validate_students(rows, class_lookup, sections_by_grade):
    flags_by_row = [[] for _ in rows]
    seen_names = {}
    dobs_by_grade = {}
    parsed_dobs = [None] * len(rows)

    for i, r in enumerate(rows):
        if not r.get("student_name", "").strip():
            flags_by_row[i].append(_flag("student_name", "missing student name"))
        if not r.get("grade", "").strip():
            flags_by_row[i].append(_flag("grade", "missing grade"))
        dob_raw = r.get("dob", "").strip()
        if not dob_raw:
            flags_by_row[i].append(_flag("dob", "missing date of birth"))
        else:
            d = parse_dob(dob_raw)
            if d is None:
                flags_by_row[i].append(_flag("dob", f"unparseable date of birth: '{dob_raw}'"))
            else:
                parsed_dobs[i] = d
                dobs_by_grade.setdefault(r.get("grade", ""), []).append(d)
        if not r.get("gender", "").strip():
            flags_by_row[i].append(_flag("gender", "missing gender"))
        if not r.get("contact", "").strip():
            flags_by_row[i].append(_flag("contact", "missing contact number"))

        key = (normalize_grade(r.get("grade")), normalize_section(r.get("section")),
               r.get("student_name", "").strip().lower())
        if key[2]:
            if key in seen_names:
                flags_by_row[i].append(_flag("student_name", "duplicate student name in this class-section"))
            seen_names[key] = True

        grade = normalize_grade(r.get("grade"))
        section = normalize_section(r.get("section"))
        gkey = (grade, section)
        if gkey not in class_lookup:
            if grade and grade not in sections_by_grade:
                flags_by_row[i].append(_flag("grade", f"grade '{grade}' not configured for this school"))
            elif section:
                flags_by_row[i].append(_flag("section", f"class '{r.get('section','').strip()}' not in school config for grade {grade}"))

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
            flags_by_row[i].append(_flag("dob", f"date of birth implausible for grade ({years_off:.1f}y off class median)"))

    return flags_by_row

def validate_teachers(rows, class_lookup, sections_by_grade, subject_names_by_grade):
    flags_by_row = [[] for _ in rows]

    # Group by normalized teacher identity to find zero-assignment teachers.
    by_teacher = {}
    for i, r in enumerate(rows):
        tkey = (r.get("teacher_name", "").strip().lower(), r.get("email", "").strip().lower())
        by_teacher.setdefault(tkey, []).append(i)

    for i, r in enumerate(rows):
        if not r.get("teacher_name", "").strip():
            flags_by_row[i].append(_flag("teacher_name", "missing teacher name"))

        email = r.get("email", "").strip()
        if email and not _EMAIL_RE.match(email):
            flags_by_row[i].append(_flag("email", f"invalid email: '{email}'"))

        grade = normalize_grade(r.get("grade"))
        section = normalize_section(r.get("section"))
        gkey = (grade, section)
        if grade and gkey not in class_lookup:
            if grade not in sections_by_grade:
                flags_by_row[i].append(_flag("grade", f"grade '{grade}' not configured for this school"))
            elif section:
                flags_by_row[i].append(_flag("section", f"class '{r.get('section','').strip()}' not in school config for grade {grade}"))

        subject = r.get("subject", "").strip().rstrip("?")
        if subject:
            allowed = subject_names_by_grade.get(grade)
            if allowed is not None and subject.lower() not in allowed:
                flags_by_row[i].append(_flag("subject", f"unknown subject '{subject}' for grade {grade}"))
        # NOTE: deliberately NOT flagging multiple teachers assigned to the
        # same (subject, grade, section) — golden rule 2, that's valid.

    for tkey, idxs in by_teacher.items():
        if all(not rows[i].get("subject", "").strip() for i in idxs):
            for i in idxs:
                flags_by_row[i].append(_flag("subject", "teacher has zero subject assignments"))

    return flags_by_row

def validate_required_fields(entity, rows):
    required = SCHEMAS[entity]["required"]
    flags_by_row = []
    for r in rows:
        flags = []
        for k in required:
            if not r.get(k, "").strip():
                flags.append(_flag(k, f"missing {k.replace('_', ' ')}"))
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
    """Returns a dict bundle (not a tuple — too many fields now that cleaning
    needs canonical-keyed lookups alongside the original membership checks):
      class_lookup            (grade, section) -> classId, unchanged
      subjects_by_class       classId -> [subjectId, ...], unchanged
      sections_by_grade       grade -> {canonical_section: display_section},
                               for match_value() in clean_students_rows/
                               clean_teachers_rows, and to tell "grade not
                               configured at all" from "grade configured but
                               not this section" in validate_students/teachers
      subject_names_by_grade  grade -> {lowercased name, ...}, unchanged
                               (validate_teachers' existing membership check)
      subjects_by_grade_canon grade -> {canonical_subject: display_subject},
                               for match_value() in clean_teachers_rows
      core_subjects_by_grade  unchanged
      aliases                 global import_aliases map, see load_import_aliases
    """
    classes_ref = db.collection("schools").document(school_id).collection("classes")
    classes = [{"id": d.id, **d.to_dict()} for d in classes_ref.stream()]
    class_lookup = {}
    subjects_by_class = {}
    sections_by_grade = {}
    for c in classes:
        grade = normalize_grade(c.get("clazz"))
        section_display = (c.get("section") or "").strip()
        section_norm = normalize_section(section_display)
        class_lookup[(grade, section_norm)] = c["id"]
        subjects_by_class[c["id"]] = [s.get("subjectId") for s in (c.get("subjects") or []) if s.get("subjectId")]
        if section_display:
            sections_by_grade.setdefault(grade, {})[canonicalize(section_display)] = section_norm

    subject_names_by_grade = None
    subjects_by_grade_canon = {}
    core_subjects_by_grade = {}
    if entity == "teachers":
        subjects_ref = db.collection("schools").document(school_id).collection("subjects")
        subject_docs = [{"id": d.id, **d.to_dict()} for d in subjects_ref.stream()]
        subject_names_by_grade = {}
        has_area = any("area" in s for s in subject_docs)
        for s in subject_docs:
            grade = normalize_grade(s["id"].split("_", 1)[0]) if "_" in s["id"] else ""
            name = (s.get("name") or "").strip()
            subject_names_by_grade.setdefault(grade, set()).add(name.lower())
            if name:
                subjects_by_grade_canon.setdefault(grade, {})[canonicalize(name)] = name
            if has_area and (s.get("area") or "").strip().lower() == "scholastic":
                core_subjects_by_grade.setdefault(grade, set()).add(s["id"])

    return {
        "class_lookup": class_lookup,
        "subjects_by_class": subjects_by_class,
        "sections_by_grade": sections_by_grade,
        "subject_names_by_grade": subject_names_by_grade,
        "subjects_by_grade_canon": subjects_by_grade_canon,
        "core_subjects_by_grade": core_subjects_by_grade,
        "aliases": load_import_aliases(db),
    }

# ------------------------------------------------------------------ main ----
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

    # Everything below is inside the try — including client/bucket/job_ref
    # construction, which used to sit outside it and could throw an
    # exception the on_call framework catches on its own and redacts to a
    # bare INTERNAL error with no message. job_ref may still be None in the
    # except block if that construction itself is what failed.
    job_ref = None
    try:
        db = firestore.client()
        bucket = storage.bucket()
        job_ref = db.collection("staging_imports").document(job_id)

        job_ref.set({
            "school_id": school_id, "entity": entity,
            "source_files": [f["path"] for f in files],
            "status": "processing", "model_used": MODEL,
        }, merge=True)

        raw_rows = []
        for f in files:
            blob = bucket.blob(f["path"])
            raw = blob.download_as_bytes()
            raw_rows.extend(extract_file(entity, f.get("name", f["path"]), raw))

        cfg = load_school_config(db, school_id, entity)

        # Cleaning (Stage 1 deterministic + Stage 2 alias/fuzzy) runs before
        # validation, on every parsed row — see the "cleaning" section above.
        # Teachers can come out LONGER than raw_rows: a multi-grade cell
        # ('Garde 7,10') expands into one row per grade. Students/teachers
        # get real cleaning; subjects/assessments pass through unchanged
        # (nothing in their schema needs config-matching against themselves).
        if entity == "students":
            cleaned = clean_students_rows(raw_rows, cfg)
        elif entity == "teachers":
            cleaned = clean_teachers_rows(raw_rows, cfg)
        else:
            cleaned = [{"data": r, "fixes": [], "suggestions": [], "flags": []} for r in raw_rows]

        cleaned_data = [c["data"] for c in cleaned]
        if entity == "students":
            validation_flags = validate_students(cleaned_data, cfg["class_lookup"], cfg["sections_by_grade"])
            class_level_flags = []
        elif entity == "teachers":
            validation_flags = validate_teachers(
                cleaned_data, cfg["class_lookup"], cfg["sections_by_grade"], cfg["subject_names_by_grade"])
            class_level_flags = core_subject_coverage_flags(
                cleaned_data, cfg["class_lookup"], cfg["subjects_by_class"], cfg["core_subjects_by_grade"])
        else:
            validation_flags = validate_required_fields(entity, cleaned_data)
            class_level_flags = []

        for c, v_flags in zip(cleaned, validation_flags):
            c["flags"] = c["flags"] + v_flags

        rows_ref = job_ref.collection("rows")
        flag_count = fixed_count = suggestion_count = 0
        for i in range(0, len(cleaned), 450):
            batch = db.batch()
            for j in range(i, min(i + 450, len(cleaned))):
                c = cleaned[j]
                flag_count += len(c["flags"])
                if c["fixes"]:
                    fixed_count += 1
                if c["suggestions"]:
                    suggestion_count += 1
                batch.set(rows_ref.document(str(j)), {
                    "data": c["data"], "flags": c["flags"],
                    "fixes": c["fixes"], "suggestions": c["suggestions"],
                    "edited": False, "excluded": False,
                })
            batch.commit()

        job_ref.set({
            "status": "ready", "row_count": len(cleaned), "flag_count": flag_count,
            "fixed_count": fixed_count, "suggestion_count": suggestion_count,
            "class_level_flags": class_level_flags,
            "completed_at": firestore.SERVER_TIMESTAMP,
        }, merge=True)

        return {"status": "ready", "rowCount": len(cleaned), "flagCount": flag_count,
                "fixedCount": fixed_count, "suggestionCount": suggestion_count}

    except https_fn.HttpsError:
        raise
    except Exception as e:
        if job_ref is not None:
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

    # Everything below is inside the try — including client/ref construction,
    # which used to sit outside it and could throw an exception the on_call
    # framework catches on its own and redacts to a bare INTERNAL error with
    # no message (see process_import's identical fix above).
    try:
        db = firestore.client()
        school_ref = db.collection("schools").document(school_id)
        job_ref = db.collection("staging_imports").document(job_id)

        writable = [it for it in items if it.get("status") == "CREATE"
                    or (it.get("status") == "UPDATE_CHANGED" and overwrite_existing)]

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
