#!/usr/bin/env python3
"""
Shared alias dictionaries and cell/value normalizers for the School Material
Import pipeline. One module, per the parser-hardening contract: the LLM-based
cleaning path in main.py (clean_students_rows/clean_teachers_rows) and the
deterministic tabular_parser.py both import from here — never two copies of
the same normalization rule.

Everything here is pure/stdlib-only (plus difflib) and side-effect free, so
it's safe to import from a pytest file without pulling in firebase_admin.

Grade/section/subject KNOWLEDGE itself no longer lives here — it moved to
education_kb.py (seeded from education_kb.json, shared with the browser).
This module keeps the cell-level MECHANICS (name/email/phone/DOB cleanup,
fuzzy matching, header aliases) and delegates every "what does this value
mean" question to the KB, so there is exactly one roman-numeral table, one
Jr-KG spelling list, and one subject alias dictionary in the codebase.
"""
import difflib
import re
from datetime import date, datetime, timedelta

import education_kb as kb

# ------------------------------------------------------------ grade/class ---
# Derived from the KB, never hand-maintained here — this used to be a literal
# dict that drifted from the JSON seed. Kept as a module export because
# main.py and the tests import it by name.
ROMAN_TO_NUM = {
    alias.upper(): int(entry)
    for entry in kb.list_grades() if entry.isdigit()
    for alias in kb.aliases_for(entry, kb.GRADE)
    if re.fullmatch(r"[ivxIVX]+", alias)
}


def normalize_grade(g):
    """Map roman numerals / plain numbers / Nursery-LKG-UKG onto one
    comparable form, since a school's live `classes.clazz` values and
    imported `grade` values may use different conventions.

    Thin wrapper over the KB's grade classification. `expect=GRADE` is right
    here: every caller already knows this cell is a grade (it came from a
    grade column), which is exactly the context that lets a bare 'V' be read
    as 5 rather than section V. Unrecognized values pass through uppercased,
    unchanged from the original behavior."""
    g = (g or "").strip()
    if not g:
        return ""
    result = kb.classify(g, expect=kb.GRADE)
    if result["type"] == kb.GRADE and result["canonical"]:
        return result["canonical"]
    return g.upper()


def normalize_section(s):
    return (s or "").strip().upper()


def canonicalize(s):
    """Comparison key only, never a display value: lowercase, strip
    spaces/hyphens/dots. 'LKG-champion', 'LKG champion' and 'lkg.champion'
    all canonicalize the same."""
    return re.sub(r"[\s\-.]+", "", (s or "").strip().lower())


# Prefix words ('Grade', the frequent 'Garde' typo, 'Std', 'Class'...) and the
# grade token vocabulary are both built from the KB seed rather than spelled
# out here. Longest-first alternation so 'xii' wins over 'xi' over 'x'.
_GRADE_WORD_RE = re.compile(
    r"\b(?:%s)(?=\d|\b)" % "|".join(re.escape(p) for p in sorted(kb.SEED["grade_prefixes"], key=len, reverse=True)),
    re.IGNORECASE)

_MULTIWORD_GRADE_ALIASES = sorted(
    ((alias, canonical)
     for canonical in kb.list_grades()
     for alias in kb.aliases_for(canonical, kb.GRADE) + [canonical]
     if " " in alias.strip()),
    key=lambda p: -len(p[0]))

_GRADE_TOKENS = sorted(
    {alias for canonical in kb.list_grades()
     for alias in kb.aliases_for(canonical, kb.GRADE) + [canonical]
     if alias.strip() and " " not in alias and not alias.isdigit() and alias.isascii()},
    key=len, reverse=True)
_GRADE_TOKEN_RE = re.compile(
    r"\b(%s|\d{1,2})\b" % "|".join(re.escape(t) for t in _GRADE_TOKENS), re.IGNORECASE)


def extract_grade_tokens(raw):
    """Tolerant grade-cell parser: strips a leading 'Grade'/'Garde'/'Std'
    (any case/typo/spacing), collapses multi-word aliases like 'Jr. KG' /
    'Senior KG' to their canonical form, then pulls out every recognizable
    grade token regardless of separators/spacing. 'Garde 7,10' -> ['7','10'];
    'Grade7,8,9' -> ['7','8','9']; 'Jr. KG' -> ['LKG']. Returns
    normalize_grade()'d tokens, deduped, first-seen order — empty list if
    nothing recognizable.

    Multi-word aliases have to be substituted BEFORE tokenizing: 'Jr KG'
    tokenizes to nothing useful otherwise, and 'Junior KG' would strand a
    bare 'KG'."""
    s = _GRADE_WORD_RE.sub(" ", raw or "")
    for alias, canonical in _MULTIWORD_GRADE_ALIASES:
        s = re.sub(r"\b%s\b" % re.escape(alias).replace(r"\ ", r"\s*\.?\s*"),
                    f" {canonical} ", s, flags=re.IGNORECASE)
    tokens = []
    for m in _GRADE_TOKEN_RE.finditer(s):
        norm = normalize_grade(m.group(1))
        if norm and norm not in tokens:
            tokens.append(norm)
    return tokens


# ------------------------------------------------------------------ names ---
_WS_RE = re.compile(r"\s+")
_INITIAL_RE = re.compile(r"^(?:[A-Za-z]\.)+$")


def collapse_ws(raw):
    """Trim + collapse internal runs of whitespace to a single space."""
    return _WS_RE.sub(" ", (raw or "").strip())


def clean_name(raw):
    """Collapse multiple spaces, trim, title-case — preserving initials like
    'P.B.' as-is instead of mangling them into 'P.b.'. Returns (cleaned,
    fix_or_None); caller fills in `field` on the fix dict."""
    original = raw or ""
    collapsed = collapse_ws(original)
    words = [w if _INITIAL_RE.match(w) else (w[:1].upper() + w[1:].lower() if w else w)
             for w in collapsed.split(" ")]
    v = " ".join(words)
    fix = {"original": original, "fixed": v, "rule": "name_normalize"} if v != original else None
    return v, fix


# ------------------------------------------------------------------ email ---
EMAIL_DOMAIN_FIXES = {
    "gamil.com": "gmail.com", "gmial.com": "gmail.com", "gmal.com": "gmail.com",
    "gmaill.com": "gmail.com", "yahooo.com": "yahoo.com",
}
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def clean_email(raw):
    """Trim, lowercase, fix known typo domains. Returns (cleaned, fix_or_None,
    is_valid). Never guesses a missing/still-invalid address — that's always
    a hard flag for the caller to raise, not an auto-fix."""
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


# ------------------------------------------------------------------ phone ---
# Matches a 10-digit Indian mobile number, tolerating an optional +91/91/0
# prefix and spaces/dashes interspersed between digits. findall() over a cell
# naturally recovers every candidate number when more than one is present.
PHONE_RE = re.compile(r"(?:\+?91[-\s]?)?0?(\d(?:[-\s]?\d){9})")


def clean_phone(raw):
    """Strip spaces/dashes/+91/leading 0. Valid = 10 digits. Multiple numbers
    in one cell -> take first, warn. Returns (value, warning_or_None); value
    is '' when nothing valid was found (row is kept without a phone by the
    caller, per contract — this never blocks the row)."""
    text = (raw or "").strip()
    if not text:
        return "", None
    matches = [re.sub(r"\D", "", m) for m in PHONE_RE.findall(text)]
    valid = [m for m in matches if len(m) == 10]
    if not valid:
        return "", f"invalid phone number: '{text}'"
    warn = "multiple numbers found in cell, using first" if len(valid) > 1 else None
    return valid[0], warn


# ----------------------------------------------------------------- gender ---
GENDER_MAP = {
    "m": "Male", "male": "Male", "boy": "Male", "b": "Male",
    "f": "Female", "female": "Female", "girl": "Female", "g": "Female",
}


def clean_gender(raw):
    """Normalize Boy/Girl/M/F/Male/Female/B/G to canonical Male/Female.
    Returns (value, warning_or_None); unrecognized values pass through
    unchanged with a warning rather than being blanked out."""
    text = (raw or "").strip()
    if not text:
        return "", None
    canon = text.lower()
    if canon in GENDER_MAP:
        return GENDER_MAP[canon], None
    return text, f"unrecognized gender value: '{text}'"


# -------------------------------------------------------------------- dob ---
_EXCEL_EPOCH = datetime(1899, 12, 30)


def parse_dob_flexible(raw):
    """Accepts dd/mm/yyyy, dd-mm-yyyy, dd.mm.yyyy, yyyy-mm-dd, Excel serial
    numbers, and datetime/date objects; normalizes to canonical YYYY-MM-DD.
    Ambiguous dd/mm-vs-mm/dd cells (both readings valid, e.g. 04/05/2020)
    accept the Indian dd/mm reading and return a low-severity warning.
    Unparseable -> ('', warning); caller keeps the row with dob blank.
    Returns (canonical_str, warning_or_None)."""
    if raw is None:
        return "", None
    if isinstance(raw, datetime):
        return raw.date().isoformat(), None
    if isinstance(raw, date):
        return raw.isoformat(), None
    if isinstance(raw, (int, float)) and not isinstance(raw, bool):
        serial = raw
        if 1 <= serial <= 60000:
            try:
                return (_EXCEL_EPOCH + timedelta(days=serial)).date().isoformat(), None
            except OverflowError:
                pass
        return "", f"unparseable date of birth: '{raw}'"

    text = (str(raw) or "").strip()
    if not text:
        return "", None

    m = re.match(r"^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})$", text)
    if m:
        y, mo, da = int(m.group(1)), int(m.group(2)), int(m.group(3))
        try:
            return date(y, mo, da).isoformat(), None
        except ValueError:
            return "", f"unparseable date of birth: '{text}'"

    m = re.match(r"^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$", text)
    if m:
        a, b, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if y < 100:
            y += 2000 if y < 50 else 1900
        warn = None
        if a > 12 and b <= 12:
            day, month = a, b
        elif b > 12 and a <= 12:
            day, month = b, a
        elif a <= 12 and b <= 12:
            day, month = a, b
            warn = f"ambiguous date '{text}' — assumed dd/mm (Indian default)"
        else:
            return "", f"unparseable date of birth: '{text}'"
        try:
            return date(y, month, day).isoformat(), warn
        except ValueError:
            return "", f"unparseable date of birth: '{text}'"

    return "", f"unparseable date of birth: '{text}'"


# --------------------------------------------------------- fuzzy matching ---
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


# -------------------------------------------------------- header aliases ---
# Column-alias dictionary for deterministic header detection (tabular_parser.
# py's _detect_header). Keys are canonical field names; values are alias
# phrases matched after canonicalize() on both sides, so spacing/punctuation/
# case never matter ("S. No", "Sr No", "SR.NO" all hit "sr_no"). Extend this
# as new real-world files arrive — it's the one place that needs to grow;
# unmapped headers seen in production get logged to Firestore
# `import_unknown_headers` (see main.py) specifically to grow this list from
# real data instead of guesswork.
STUDENT_HEADER_ALIASES = {
    "sr_no": ["sno", "sr no", "s.no", "serial", "serial no", "serial number", "sl no"],
    "adm_no": ["adm no", "admission no", "admission number", "gr no", "gr. no",
               "gr number", "general register no", "gen reg no"],
    "student_name": ["name", "student name", "students name", "name of student",
                      "name of the student", "full name", "child name", "childs name"],
    "grade": ["class", "grade", "std", "standard"],
    "section": ["sec", "section", "div", "division"],
    "roll_no": ["roll no", "roll", "roll number", "rollno"],
    "gender": ["gender", "sex"],
    "dob": ["dob", "date of birth", "birth date", "d.o.b"],
    "father_name": ["father name", "father's name", "fathers name", "father"],
    "mother_name": ["mother name", "mother's name", "mothers name", "mother"],
    "contact": ["contact", "mobile", "phone", "sms mobile", "contact no",
                "contact number", "mobile no", "mobile number", "phone no"],
    # "address" is intentionally recognized here (so header-scoring correctly
    # identifies the header row and doesn't waste an "unmapped column" slot
    # on it) but deliberately EXCLUDED from STUDENT_SCHEMA_KEYS below — main.
    # py's BANNED_KEYS already forbids extracting student addresses via the
    # LLM path (golden rule 3); the deterministic path honors the same rule
    # by only ever storing fields present in schema_keys (see
    # tabular_parser._parse_row) — a recognized-but-out-of-schema column is
    # silently dropped, never persisted, same belt-and-braces pattern as
    # extract_file()'s schema-key filter.
    "address": ["address", "residential address", "home address"],
    "city": ["city", "town"],
    "email": ["email", "e-mail", "email id", "email address"],
}

STUDENT_SCHEMA_KEYS = ["grade", "section", "roll_no", "student_name", "gender",
                        "dob", "sr_no", "adm_no", "mother_name", "father_name",
                        "contact", "email", "city"]
STUDENT_REQUIRED_FIELD = "student_name"


def build_alias_lookup(field_aliases):
    """{field: [alias phrases]} -> {canonicalized alias: field}, for exact
    lookup in header scoring."""
    lookup = {}
    for field, aliases in field_aliases.items():
        for alias in aliases:
            lookup[canonicalize(alias)] = field
    return lookup
