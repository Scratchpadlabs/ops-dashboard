#!/usr/bin/env python3
"""
Education knowledge base — what a value MEANS, not just what it says.

The one place that knows a scholastic subject from a co-scholastic area,
recognizes a grade system, and spots a section naming pattern. Seeded from
education_kb.json (shared byte-for-byte with the browser side,
src/utils/educationKB.js — see that file's header for why the JSON lives in
this directory), extended at runtime by the Firestore `kb_entries` overlay.

Design contract, in priority order:
  1. DETERMINISTIC FIRST  — exact canonical hit, then alias hit, then the
     learned overlay, then fuzzy. Every one of those is free and repeatable.
  2. LLM LAST RESORT      — only an "unknown" result justifies asking a model
     (see main.py's classify_value callable). This module never calls one.
  3. HUMAN CONFIRM ALWAYS — nothing here writes to the overlay. Learned
     entries are written only by a human accepting a suggestion in the UI.
  4. CACHE FOREVER        — once written to kb_entries, a value is answered
     deterministically by step 1 and never asked again.

Pure/stdlib-only and side-effect free (the Firestore overlay is passed IN,
never fetched here), so tests import it without firebase_admin.
"""
import json
import os
import re

_DIR = os.path.dirname(os.path.abspath(__file__))

with open(os.path.join(_DIR, "education_kb.json"), encoding="utf-8") as _f:
    SEED = json.load(_f)

# ---------------------------------------------------------------- types -----
SUBJECT = "subject"
COSCHOLASTIC = "coscholastic"
GRADE = "grade"
SECTION = "section"
UNKNOWN = "unknown"
OTHER = "other"          # human/LLM said "none of the above" — cached, never re-asked

ENTITY_TYPES = (SUBJECT, COSCHOLASTIC, GRADE, SECTION)

# ---------------------------------------------------------- confidence ------
# Bands the UI keys off (Part B of the task):
#   >= HIGH   -> auto-normalize + categorize silently
#   >= MEDIUM -> inline suggestion chip, one-click accept
#   <  MEDIUM -> unknown; ask the LLM once, then a human confirms
HIGH_CONFIDENCE = 0.95
MEDIUM_CONFIDENCE = 0.80

_EXACT = 1.0
_ALIAS = 0.97
_LEARNED = 0.96
_PATTERN = 0.95


def canonicalize(s):
    """Comparison key only, never a display value: lowercase, strip
    spaces/hyphens/dots/ampersands/slashes/underscores. Mirrors
    normalize.canonicalize (which predates this module and is kept there for
    the parser's own alias maps), plus the extra separators subject names
    bring — 'Art & Craft', 'art&craft' and 'ART - CRAFT' all agree."""
    return re.sub(r"[\s\-._&/()]+", "", (s or "").strip().lower())


def _similarity(a, b):
    """Normalized Levenshtein similarity in [0, 1].

    Deliberately NOT difflib: src/utils/educationKB.js has to return the
    same number for the same pair, and Ratcliff/Obershelp is painful to
    reimplement identically in JS. Plain edit distance ports exactly, so the
    two sides agree on every band boundary — a parity fixture in
    tests/test_education_kb.py pins that.
    """
    if a == b:
        return 1.0
    if not a or not b:
        return 0.0
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return 1.0 - prev[-1] / max(len(a), len(b))


# ------------------------------------------------------------- indexes ------
def _build_index():
    """{canonicalized value: (type, canonical_display)} for every seeded
    canonical form and alias. Canonicals are inserted last so a canonical
    always wins a collision with some other entry's alias."""
    index = {}
    for kind, key in ((SUBJECT, "subjects"), (COSCHOLASTIC, "coscholastic"), (GRADE, "grades")):
        for entry in SEED[key]:
            for alias in entry.get("aliases", []):
                index.setdefault(canonicalize(alias), (kind, entry["canonical"]))
    for kind, key in ((SUBJECT, "subjects"), (COSCHOLASTIC, "coscholastic"), (GRADE, "grades")):
        for entry in SEED[key]:
            index[canonicalize(entry["canonical"])] = (kind, entry["canonical"])
    return index


_INDEX = _build_index()

# Section vocabularies are separate from _INDEX: a section name may collide
# with a subject ("Art" as a house name), and the caller's `expect` hint —
# not a fixed precedence — is what resolves that.
_SECTION_INDEX = {}
for _family, _names in SEED["section_patterns"].items():
    for _n in _names:
        _SECTION_INDEX.setdefault(canonicalize(_n), (_n, _family))

_GRADE_PREFIX_RE = re.compile(
    r"^(?:%s)(?=\d|\b)\.?\s*" % "|".join(
        re.escape(p) for p in sorted(SEED["grade_prefixes"], key=len, reverse=True)), re.IGNORECASE)

_SINGLE_LETTER_RE = re.compile(r"^[A-Za-z]$")
_NUMERIC_RE = re.compile(r"^\d{1,2}$")
# "A1", "B-2", "9 A" style compound section labels.
_COMPOUND_SECTION_RE = re.compile(r"^[A-Za-z]\s*[-]?\s*\d{1,2}$")


def _strip_grade_prefix(value):
    return _GRADE_PREFIX_RE.sub("", (value or "").strip()).strip()


# ------------------------------------------------------------- overlay ------
def build_overlay(entries):
    """Turn raw `kb_entries` docs into the lookup classify() takes.

    Each doc: {value, type, canonical, confirmed_by, ...} where `value` is
    already canonicalized (it is also the doc id). `type` may be OTHER, which
    is exactly as useful as a positive answer: it stops the LLM being asked
    about that value ever again.
    """
    if isinstance(entries, dict):
        entries = list(entries.values())
    overlay = {}
    for e in entries or []:
        value = canonicalize(e.get("value") or "")
        kind = (e.get("type") or "").strip().lower()
        if not value or kind not in ENTITY_TYPES + (OTHER,):
            continue
        overlay[value] = (kind, (e.get("canonical") or "").strip() or None)
    return overlay


def _result(kind, canonical, confidence, source, alternatives=None):
    return {
        "type": kind,
        "canonical": canonical,
        "confidence": round(float(confidence), 4),
        "source": source,
        "alternatives": alternatives or [],
    }


# ------------------------------------------------------------ classify ------
def classify(value, expect=None, overlay=None):
    """Classify one raw value.

    Returns {type, canonical, confidence, source, alternatives}:
      type         one of subject | coscholastic | grade | section | other | unknown
      canonical    the normalized display form (None when unknown)
      confidence   1.0 exact, .97 alias, .96 learned, .95 pattern, else fuzzy ratio
      source       exact | alias | learned | pattern | fuzzy | none
      alternatives [{type, canonical, confidence}] runners-up, for the UI's chip

    `expect` is a context hint from the caller — 'section' when the user is
    adding a section, 'subject' when typing a subject name, and so on. It is
    the tie-breaker for genuinely ambiguous values ('Art' the house name vs
    Art & Craft the activity; 'V' the section letter vs roman five), never an
    override of a confident answer in another family.

    `overlay` is the learned kb_entries map from build_overlay() — checked
    before fuzzy, after exact/alias, so a human's confirmed answer always
    beats a guess but never contradicts the seeded canon.
    """
    raw = (value or "").strip()
    if not raw:
        return _result(UNKNOWN, None, 0.0, "none")

    canon = canonicalize(raw)

    # 1 — expected-family exact hits first, so the caller's context wins ties
    #     without letting it invent an answer it didn't earn.
    if expect == SECTION:
        hit = _section_lookup(raw, canon)
        if hit:
            return hit
    if expect in (SUBJECT, COSCHOLASTIC) and canon in _INDEX:
        kind, canonical = _INDEX[canon]
        if kind in (SUBJECT, COSCHOLASTIC):
            src = "exact" if canonicalize(canonical) == canon else "alias"
            return _result(kind, canonical, _EXACT if src == "exact" else _ALIAS, src)

    # 2 — grade, including 'Grade III' / 'Std. 4' / 'Class-9' prefixed forms
    grade_hit = _grade_lookup(raw, canon, expect)
    if grade_hit:
        return grade_hit

    # 3 — seeded subject / co-scholastic. Grades are deliberately excluded:
    #     step 2 owns grade resolution end-to-end, and when it declines (a
    #     bare 'V' with no grade context) this lookup must not silently
    #     re-admit the reading it just rejected.
    if canon in _INDEX and _INDEX[canon][0] != GRADE:
        kind, canonical = _INDEX[canon]
        src = "exact" if canonicalize(canonical) == canon else "alias"
        return _result(kind, canonical, _EXACT if src == "exact" else _ALIAS, src)

    # 4 — section vocabularies/patterns
    section_hit = _section_lookup(raw, canon)
    if section_hit:
        return section_hit

    # 5 — learned overlay (human-confirmed, includes cached "other")
    if overlay and canon in overlay:
        kind, canonical = overlay[canon]
        return _result(kind, canonical or raw, _LEARNED, "learned")

    # 6 — fuzzy against subjects + co-scholastic (and sections when expected)
    best_kind, best_canonical, best_ratio = None, None, 0.0
    alternatives = []
    for cand_canon, (kind, canonical) in _INDEX.items():
        if kind == GRADE:
            continue  # grades are exact-or-nothing; a fuzzy grade is a bad guess
        ratio = _similarity(canon, cand_canon)
        if ratio >= MEDIUM_CONFIDENCE:
            alternatives.append({"type": kind, "canonical": canonical, "confidence": round(ratio, 4)})
        if ratio > best_ratio:
            best_kind, best_canonical, best_ratio = kind, canonical, ratio
    if expect == SECTION:
        for cand_canon, (name, _family) in _SECTION_INDEX.items():
            ratio = _similarity(canon, cand_canon)
            if ratio > best_ratio:
                best_kind, best_canonical, best_ratio = SECTION, name, ratio

    if best_ratio >= MEDIUM_CONFIDENCE:
        alternatives = [a for a in sorted(alternatives, key=lambda a: -a["confidence"])
                        if a["canonical"] != best_canonical][:3]
        return _result(best_kind, best_canonical, best_ratio, "fuzzy", alternatives)

    return _result(UNKNOWN, None, round(best_ratio, 4), "none")


def _grade_lookup(raw, canon, expect):
    """Grade tokens, with the 'Grade'/'Std'/'Class' prefix family stripped.

    A bare single letter is NEVER read as a roman-numeral grade unless the
    caller explicitly expects a grade: in a school file 'V' next to a class
    is far more often section V than grade 5, and guessing wrong here
    silently mis-files students.
    """
    stripped = _strip_grade_prefix(raw)
    had_prefix = canonicalize(stripped) != canon
    scanon = canonicalize(stripped)
    if not scanon:
        return None

    if scanon in _INDEX and _INDEX[scanon][0] == GRADE:
        canonical = _INDEX[scanon][1]
        if _SINGLE_LETTER_RE.match(stripped) and not had_prefix and expect != GRADE:
            return None
        src = "exact" if canonicalize(canonical) == scanon else "alias"
        conf = _EXACT if (src == "exact" or had_prefix) else _ALIAS
        return _result(GRADE, canonical, conf, src)

    if _NUMERIC_RE.match(stripped):
        n = int(stripped)
        if 1 <= n <= 12:
            return _result(GRADE, str(n), _EXACT if had_prefix else _PATTERN,
                           "exact" if had_prefix else "pattern")
    return None


def _section_lookup(raw, canon):
    """Named section vocabularies first (Rose / Ruby / Champion), then the
    structural patterns (single letter, 'A1'). Anything else is not a section
    as far as this module is concerned — a school inventing 'Sunrise' as a
    section is exactly the unknown the LLM fallback exists for."""
    if canon in _SECTION_INDEX:
        name, family = _SECTION_INDEX[canon]
        return _result(SECTION, name, _EXACT if raw.strip() == name else _ALIAS,
                       "exact" if raw.strip() == name else "alias")
    stripped = raw.strip()
    if _SINGLE_LETTER_RE.match(stripped):
        return _result(SECTION, stripped.upper(), _PATTERN, "pattern")
    if _COMPOUND_SECTION_RE.match(stripped):
        return _result(SECTION, re.sub(r"[\s-]+", "", stripped).upper(), _PATTERN, "pattern")
    return None


# ----------------------------------------------------------- normalize ------
def normalize(value, kind, overlay=None):
    """Canonical display form of `value` when read as `kind`, else the
    trimmed input unchanged. Never guesses across families: normalize('Eng',
    'coscholastic') is 'Eng', not 'English' — ask classify() if you want the
    family decided for you."""
    result = classify(value, expect=kind, overlay=overlay)
    if result["type"] == kind and result["canonical"]:
        return result["canonical"]
    return (value or "").strip()


def is_scholastic(value, overlay=None):
    return classify(value, overlay=overlay)["type"] == SUBJECT


def is_coscholastic(value, overlay=None):
    return classify(value, overlay=overlay)["type"] == COSCHOLASTIC


# ------------------------------------------------------- list accessors -----
def list_subjects():
    return [e["canonical"] for e in SEED["subjects"]]


def list_coscholastic():
    return [e["canonical"] for e in SEED["coscholastic"]]


def list_grades():
    return [e["canonical"] for e in SEED["grades"]]


def list_section_names(family=None):
    if family:
        return list(SEED["section_patterns"].get(family, []))
    out = []
    for names in SEED["section_patterns"].values():
        out.extend(names)
    return out


def section_families():
    return list(SEED["section_patterns"].keys())


def aliases_for(canonical, kind):
    key = {SUBJECT: "subjects", COSCHOLASTIC: "coscholastic", GRADE: "grades"}.get(kind)
    if not key:
        return []
    for entry in SEED[key]:
        if entry["canonical"] == canonical:
            return list(entry.get("aliases", []))
    return []
