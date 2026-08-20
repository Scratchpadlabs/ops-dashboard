"""Canonical class resolution — ONE implementation, used by every feature.

WHY THIS EXISTS
    Three separate class parsers had grown up independently: survey_rules.
    resolve_class_key (grouping), reset_rules.split_class_id (promotion), and
    structureInference.js (setup). They disagreed, and the disagreement was
    not academic — reset_rules split on "_" and nothing else, so a school
    writing "1-B" or "Grade 1 B" had 100% of its roster reported as
    unrecognized while the same roster grouped fine in the Surveys matrix.

    Every feature that needs a student's class now calls resolve_class() here.

DESIGN RULES
    - Grades are resolved to a NUMBER (grade_ordinal) so promotion is
      arithmetic rather than string matching. The scale is chosen so that
      +1 walks the pre-primary ladder for free:
          Pre-Nursery -3, Nursery -2, LKG -1, UKG 0, Grades 1..12 = 1..12
      UKG(0) + 1 == 1 == Grade 1, with no special case.
    - The school's OWN notation is preserved. A school writing roman numerals
      gets roman numerals back; one writing "7" gets "8". Mixing them would
      silently create a parallel set of classes beside the real ones.
    - Ambiguity is never guessed. A value we cannot read confidently comes
      back with confidence LOW/NONE, the raw string, and the field it came
      from — so the UI can show `class: "1st Std" (unrecognized)` rather than
      a bare arrow. Part 2's per-school class_map is how a human resolves
      those, permanently.
    - No school-specific branches. Differences live in data: the school's
      class_map and its configured classes.

VOCABULARY (education_kb.json)
    Grades, their aliases (roman numerals are aliases of the numeric
    canonicals), grade prefixes and section patterns all come from the shared
    knowledge base — the same file the browser and the import cleaner read.
    This module adds no fourth dictionary; it adds an ORDERING over the one
    that already exists.
"""

import re

from . import load_kb

# The KB ships inside this package, so it travels wherever the package does —
# including into the staged tree tools/deploy_function.sh hands to gcloud.
KB = load_kb()

# ── Ordering ────────────────────────────────────────────────────────────────
# Ordinals are the whole point: promotion is `ordinal + 1`, and the
# pre-primary ladder falls out of the arithmetic instead of being special
# cased. Anything not on this scale is unresolvable by definition.
PRE_PRIMARY_ORDINALS = {"Pre-Nursery": -3, "Nursery": -2, "LKG": -1, "UKG": 0}

GRADUATED = "__graduated__"

# Some students are parked on a deliberately meaningless class value so they
# cannot reach the app. That is a KNOWN state, not broken data: it must not
# block a reset, and it must not be silently promoted either. A class_map
# entry with excluded=True marks the value; those students are reported
# separately and left alone.
EXCLUDED = "__excluded__"

# Values that LOOK like a parking sentinel. Used only to PROPOSE exclusion in
# the scan review — never to exclude automatically. Auto-excluding on a name
# match would hide a real class called "Sample House" from someone who never
# looked at the review screen.
SENTINEL_HINTS = ("sample", "test", "demo", "dummy", "placeholder", "temp", "xxx")


def looks_like_sentinel(raw):
    """Whether a raw value resembles a deliberate parking value.

    A suggestion for the review UI. The answer is only ever acted on after a
    human confirms it, which is why a loose substring match is acceptable here
    and would not be anywhere else.
    """
    text = _norm(raw)
    if not text:
        return False
    return any(h in text for h in SENTINEL_HINTS)


CONF_HIGH = "high"      # exact match, or a human-confirmed class_map entry
CONF_MEDIUM = "medium"  # parsed cleanly but with an inferred split
CONF_LOW = "low"        # parsed, but the split is ambiguous
CONF_NONE = "none"      # not resolvable — never promoted, always reported

# Field names, widest observed first. currentClassId is what the import
# pipeline writes; classId is what the teacher app writes. Both are real.
CLASS_ID_FIELDS = ("classId", "currentClassId", "class_id", "classID", "classid",
                   "className", "class_name")
GRADE_FIELDS = ("grade", "clazz", "standard", "std", "class", "Grade", "Class")
# Board/affiliation tokens, stripped from every section and class identifier.
#
# Hillgreen's teacher file writes sections as "SCI_CBSE_A" while its configured
# classes use "SCI_A" — the same section with the board baked in. A board is
# identical for every class in a school, so it carries no information in an
# identifier while permanently coupling it to an affiliation that can change.
# Stripping here means both spellings resolve to the same class instead of the
# teacher row being flagged "not in school config".
#
# Twin of BOARD_TOKENS / stripBoardTokens in classResolver.js.
BOARD_TOKENS = ("CBSE", "ICSE", "ISC", "SSC", "HSC", "IB", "IGCSE", "CIE",
                "NIOS", "STATE")

_BOARD_SET = frozenset(BOARD_TOKENS)
_SECTION_SPLIT_RE = re.compile(r"[_\-/\s]+")


def strip_board_tokens(value):
    """Split on separators, drop board tokens, rejoin with underscores."""
    parts = [p for p in _SECTION_SPLIT_RE.split(str(value or "").strip()) if p]
    kept = [p for p in parts if p.upper() not in _BOARD_SET]
    # An all-board value ("CBSE") would otherwise vanish — keep it as-is.
    return "_".join(kept if kept else parts)


def normalize_section_value(raw):
    """THE section normalization: board stripped, upper-cased."""
    return strip_board_tokens(raw).upper()


_CLASS_ID_SEPARATORS = re.compile(r"[\s_\-/.]+")


def class_id_key(value):
    """Comparison key for a class DOCUMENT id.

    "Play_Group_A", "play group a" and "PLAY-GROUP-A" all reduce to
    "play_group_a", so an id typed into a spreadsheet can be compared with one
    School Setup wrote. Deliberately knows nothing about grades — it is not a
    parser, only a fold. Twin: classIdKey in src/utils/classResolver.js.

    Exists because a school's export can carry the class as ONE complete id
    instead of a Class + Section pair (Hillgreen's 2026-27 export), which the
    (grade, section) lookup cannot see.
    """
    folded = _CLASS_ID_SEPARATORS.sub("_", str(value if value is not None else "").strip().lower())
    return folded.strip("_")


SECTION_FIELDS = ("section", "sec", "division", "div", "Section")


def _canonical_grade_index():
    """{normalized token: (canonical, ordinal)} for every grade and alias."""
    out = {}
    for entry in KB.get("grades", []):
        canon = entry["canonical"]
        ordinal = PRE_PRIMARY_ORDINALS.get(canon)
        if ordinal is None:
            if not str(canon).isdigit():
                continue
            ordinal = int(canon)
        for token in [canon] + list(entry.get("aliases", [])):
            out[_norm(token)] = (canon, ordinal)
    return out


def _norm(value):
    """Lowercase, collapse internal whitespace, drop surrounding punctuation."""
    s = str(value or "").strip().lower()
    s = re.sub(r"\s+", " ", s)
    return s.strip(" -_/.,:")


GRADE_INDEX = _canonical_grade_index()

# Longest first so "pre nursery" is tried before "nursery" would ever match a
# leading fragment.
_MAX_GRADE_WORDS = max((len(k.split()) for k in GRADE_INDEX), default=1)

# Prefixes are stripped, not matched: "Grade 1 B", "STD I - B", "Class 5".
# The (?=\d|\b) lookahead is deliberate — \b alone does not sit between "e"
# and "7", so "Grade7" lost its 7 before this was fixed once already.
_PREFIX_RE = re.compile(
    r"^\s*(?:%s)\s*[:.\-]?\s*(?=\d|\b)" % "|".join(
        re.escape(p) for p in sorted(KB.get("grade_prefixes", []), key=len, reverse=True)
    ),
    re.IGNORECASE,
)

_SEPARATORS = re.compile(r"[_\-/,:.|]+")
# "1B" / "10A" — a digit run followed by a letter run is unambiguous.
_DIGIT_ALPHA = re.compile(r"^(\d{1,2})\s*([A-Za-z][A-Za-z0-9 ]*)$")
_ORDINAL_SUFFIX = re.compile(r"^(\d{1,2})(?:st|nd|rd|th)$", re.IGNORECASE)


def _tokens(raw):
    """Split a raw class value into grade/section tokens.

    ORDER MATTERS: separators are normalized to spaces BEFORE the prefix is
    stripped. Underscore is a word character, so the \\b in _PREFIX_RE does not
    fire between "e" and "_" — stripping first left "grade_II_A" with its
    prefix intact and made it unresolvable. Observed on two live schools,
    1,836 students between them. Normalizing separators first turns it into
    "grade II A", which the prefix rule then handles like any other spelling.
    """
    cleaned = _SEPARATORS.sub(" ", str(raw or "").strip())
    return [t for t in _PREFIX_RE.sub("", cleaned).split() if t]


def parse_class_value(raw):
    """Parse one raw class string into its parts.

    Returns {grade_token, grade_canonical, grade_ordinal, section, confidence,
    reason}. grade_ordinal is None when the value cannot be resolved — that is
    a reportable state, never a promotable one.
    """
    text = str(raw or "").strip()
    blank = {"grade_token": None, "grade_canonical": None, "grade_ordinal": None,
             "section": "", "confidence": CONF_NONE, "reason": None}
    if not text:
        return {**blank, "reason": "empty"}

    toks = _tokens(text)
    if not toks:
        return {**blank, "reason": "no readable tokens"}

    # Try the longest leading token run first, so multi-word grades
    # ("Jr KG", "Pre Nursery", "Lower KG") win over their own fragments.
    for span in range(min(_MAX_GRADE_WORDS, len(toks)), 0, -1):
        candidate = _norm(" ".join(toks[:span]))
        hit = GRADE_INDEX.get(candidate)
        if hit:
            canon, ordinal = hit
            section = " ".join(toks[span:]).strip()
            return {
                "grade_token": " ".join(toks[:span]),
                "grade_canonical": canon,
                "grade_ordinal": ordinal,
                "section": section,
                # A bare grade with no section is exact; a split is an
                # inference, correct in every observed case but still an
                # inference.
                "confidence": CONF_HIGH if not section else CONF_MEDIUM,
                "reason": None,
            }

    # "1B" / "10A": glued digit+letter, unambiguous because a grade is never
    # alphabetic when it starts with a digit.
    m = _DIGIT_ALPHA.match(toks[0])
    if m and len(toks) == 1:
        hit = GRADE_INDEX.get(_norm(m.group(1)))
        if hit:
            canon, ordinal = hit
            return {"grade_token": m.group(1), "grade_canonical": canon,
                    "grade_ordinal": ordinal, "section": m.group(2).strip(),
                    "confidence": CONF_MEDIUM, "reason": None}

    # "1st" / "10th" as a standalone leading token.
    m = _ORDINAL_SUFFIX.match(toks[0])
    if m:
        hit = GRADE_INDEX.get(_norm(m.group(1)))
        if hit:
            canon, ordinal = hit
            return {"grade_token": toks[0], "grade_canonical": canon,
                    "grade_ordinal": ordinal, "section": " ".join(toks[1:]).strip(),
                    "confidence": CONF_MEDIUM, "reason": None}

    # Deliberately NOT guessed: a glued alphabetic run such as "IB" could be
    # roman I + section B, or a programme name. Splitting it on a hunch is how
    # a whole roster silently lands in the wrong grade. Report it instead —
    # the class_map review is where a human settles it once for the school.
    return {**blank, "reason": f"unrecognized grade in {text!r}"}


def _first_nonempty(doc, fields):
    """First field holding a real value.

    Strings are stripped before the emptiness check: a whitespace-only
    classId is an absent class, not a class named "   ". Skipping the strip
    grouped such students under a blank label instead of "(no class)".
    """
    for f in fields:
        v = doc.get(f)
        if v is None:
            continue
        if isinstance(v, str):
            v = v.strip()
            if not v:
                continue
            return v, f
        if v not in ("", [], {}):
            return v, f
    return None, None


def raw_class_value(student):
    """The raw class string for a student, and which field it came from.

    A direct class-id field wins. Failing that a grade+section pair is
    composed, so both conventions land on one value and a school using either
    behaves identically.
    """
    if not isinstance(student, dict):
        return None, None

    value, field = _first_nonempty(student, CLASS_ID_FIELDS)
    if value:
        return str(value), field

    grade, gfield = _first_nonempty(student, GRADE_FIELDS)
    if grade:
        section, sfield = _first_nonempty(student, SECTION_FIELDS)
        if section:
            return f"{grade}_{section}", f"{gfield}+{sfield}"
        return str(grade), gfield
    return None, None


def describe_unresolved(raw, field):
    """Human-readable label for a value we could not resolve.

    Never blank: the reset preview used to render bare arrows for these, which
    told Sid nothing about what to fix.
    """
    if field is None:
        return "no class field on the student record"
    if raw in (None, ""):
        return f'{field}: "" (empty)'
    return f'{field}: "{raw}" (unrecognized)'


def notation_of(class_ids):
    """'numeric' or 'roman' — how this school writes its grades.

    Decides how a resolved ordinal is rendered back into a class id. Ties go
    to roman, matching the observed data ("I_Diamond").
    """
    numeric = roman = 0
    for cid in class_ids or []:
        parsed = parse_class_value(cid)
        token = (parsed.get("grade_token") or "").strip()
        if not token:
            continue
        if token.isdigit():
            numeric += 1
        elif re.fullmatch(r"[IVXivx]+", token):
            roman += 1
    return "numeric" if numeric > roman else "roman"


_ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"]


def ordinal_to_token(ordinal, notation="roman"):
    """Render an ordinal back into the school's own notation."""
    if ordinal is None:
        return None
    for canon, o in PRE_PRIMARY_ORDINALS.items():
        if o == ordinal:
            return canon
    if 1 <= ordinal <= 12:
        return str(ordinal) if notation == "numeric" else _ROMAN[ordinal - 1]
    return None


def compose_class_id(grade_token, section, separator="_"):
    if not grade_token:
        return None
    return f"{grade_token}{separator}{section}" if section else grade_token


def build_school_context(class_ids=None, class_map=None, separator=None):
    """Everything resolution needs about ONE school, computed once per run.

    class_map is Part 2's per-school override table: {raw_value: {...}}.
    Confirmed entries beat parsing, which is what makes an odd school
    permanently fixable without a code change.
    """
    ids = list(class_ids or [])
    sep = separator
    if sep is None:
        # Follow the school's own punctuation so a written-back id looks like
        # the ones already there.
        sep = "_"
        for cid in ids:
            if "_" in cid:
                sep = "_"
                break
            if "-" in cid:
                sep = "-"
                break
    ordinals = {}
    for cid in ids:
        p = parse_class_value(cid)
        if p["grade_ordinal"] is not None:
            ordinals.setdefault(p["grade_ordinal"], []).append(cid)
    return {
        "class_ids": ids,
        "class_id_set": set(ids),
        "notation": notation_of(ids),
        "separator": sep,
        "class_map": dict(class_map or {}),
        "ordinals_present": ordinals,
        "max_ordinal": max(ordinals) if ordinals else None,
    }


def resolve_class(student, context=None):
    """THE entry point. One student document -> canonical class structure.

    Accepts a student dict, or a bare class string for callers that already
    have one (the class_map scanner works on distinct values, not documents).
    """
    ctx = context or build_school_context()

    if isinstance(student, str):
        raw, field = student, "value"
    else:
        raw, field = raw_class_value(student)

    if raw in (None, ""):
        return {"raw": raw, "raw_field": field, "grade_token": None,
                "grade_canonical": None, "grade_ordinal": None, "section": "",
                "canonical_class_id": None, "confidence": CONF_NONE,
                "reason": "no class value", "label": describe_unresolved(raw, field)}

    # A confirmed class_map entry is the school's own answer and outranks
    # anything this module can infer.
    entry = ctx["class_map"].get(raw) or ctx["class_map"].get(_norm(raw))

    # Confirmed as a parking value: a known, deliberate state. Resolved with
    # high confidence to EXCLUDED, so the promotion engine leaves the student
    # alone instead of blocking the whole run on them.
    if entry and entry.get("excluded"):
        return {
            "raw": raw, "raw_field": field, "grade_token": None,
            "grade_canonical": None, "grade_ordinal": None, "section": "",
            "canonical_class_id": EXCLUDED, "excluded": True,
            "confidence": CONF_HIGH, "reason": "excluded from the app by class value",
            "label": f'{raw} (excluded)', "from_map": entry.get("source", "confirmed"),
        }

    if entry and entry.get("canonical_class_id"):
        return {
            "raw": raw, "raw_field": field,
            "grade_token": entry.get("grade_token"),
            "grade_canonical": entry.get("grade_canonical"),
            "grade_ordinal": entry.get("grade_ordinal"),
            "section": entry.get("section", ""),
            "canonical_class_id": entry["canonical_class_id"],
            "confidence": CONF_HIGH if entry.get("source") == "confirmed" else CONF_MEDIUM,
            "reason": None,
            "label": entry["canonical_class_id"],
            "from_map": entry.get("source", "auto"),
        }

    parsed = parse_class_value(raw)
    if parsed["grade_ordinal"] is None:
        # Last resort, and only with EVIDENCE: a glued alphabetic value like
        # "VB" could be roman V + section B, or a programme name. We accept the
        # split only when the composed id matches a class the school actually
        # has configured — that is the school's own data confirming the
        # reading, not this module guessing. Without a match it stays
        # unresolved and goes to the class map like anything else.
        split = _split_glued_with_evidence(raw, ctx)
        if split:
            return {"raw": raw, "raw_field": field, **split,
                    "canonical_class_id": split["_canonical"],
                    "label": split["_canonical"]}
        return {"raw": raw, "raw_field": field, **parsed,
                "canonical_class_id": None,
                "label": describe_unresolved(raw, field)}

    canonical = compose_class_id(parsed["grade_token"], parsed["section"],
                                 ctx["separator"])
    # An exact hit against a configured class is the strongest signal there
    # is — it means this value names a class the school actually has.
    confidence = parsed["confidence"]
    if raw in ctx["class_id_set"] or canonical in ctx["class_id_set"]:
        confidence = CONF_HIGH
    return {"raw": raw, "raw_field": field, **parsed,
            "confidence": confidence,
            "canonical_class_id": canonical,
            "label": canonical}


def _split_glued_with_evidence(raw, ctx):
    """Split a glued value like "VB" ONLY if the result names a real class.

    parse_class_value deliberately refuses these, because "IB" is as likely to
    be a programme name as roman I + section B, and a wrong split puts a whole
    roster in the wrong grade. Here we have something it doesn't: the school's
    configured class list. If exactly one split lands on a class that exists,
    that is the school confirming the reading.

    Ambiguity still loses — two candidate splits both matching means we cannot
    tell, so neither is used.
    """
    text = str(raw or "").strip()
    if not text or not text.isalnum() or not ctx.get("class_id_set"):
        return None

    hits = []
    for i in range(1, len(text)):
        head, tail = text[:i], text[i:]
        entry = GRADE_INDEX.get(_norm(head))
        if not entry:
            continue
        canonical = compose_class_id(head, tail, ctx.get("separator", "_"))
        if canonical in ctx["class_id_set"]:
            canon, ordinal = entry
            hits.append({
                "grade_token": head, "grade_canonical": canon,
                "grade_ordinal": ordinal, "section": tail,
                "confidence": CONF_MEDIUM,
                "reason": f"split matched configured class {canonical!r}",
                "_canonical": canonical,
            })

    return hits[0] if len(hits) == 1 else None


def distinct_class_values(students):
    """{raw_value: {count, field, sample_student_ids}} across a roster.

    The input to the class_map scanner. Read-only by construction — it takes
    documents that are already in memory and returns a summary.
    """
    out = {}
    for s in students or []:
        raw, field = raw_class_value(s)
        key = raw if raw not in (None, "") else ""
        row = out.setdefault(key, {"raw": raw, "field": field, "count": 0,
                                    "sample_ids": []})
        row["count"] += 1
        if len(row["sample_ids"]) < 5 and s.get("id"):
            row["sample_ids"].append(s["id"])
    return out
