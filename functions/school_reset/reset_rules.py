#!/usr/bin/env python3
"""
Pure decision logic for the Reset School wizard.

Split from main.py for the same reason as the other function folders: main.py
calls firebase_admin.initialize_app() at import, so nothing there is testable
without a Firebase environment. Everything here is stdlib-only and side-effect
free.

This module decides WHAT a reset would change. It never decides to do it —
main.py performs writes only after an explicit, typed confirmation and a
verified archive.

THE CONSTRAINT THAT SHAPES EVERYTHING: the school tree has no academic-year
dimension. There is no year field on students, classes or reports, and the
teacher/student apps do not pass one. A "reset" is therefore an IN-PLACE
mutation of live data, not the creation of a new year's copy. That is why
archiving is mandatory and why every operation here is expressed as an
explicit, itemized diff rather than an implied side effect.
"""

# Grade progression. Mirrors the ordering in
# functions/assign_survey/survey_rules.py and src/utils/structureInference.js —
# one sequence, three places that must agree.
PRE_PRIMARY = ["Pre-Nursery", "Nursery", "LKG", "UKG"]
ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"]
NUMERIC = [str(n) for n in range(1, 13)]

_ROMAN_UPPER = {r.upper(): i for i, r in enumerate(ROMAN)}
_PRE_UPPER = {p.upper(): i for i, p in enumerate(PRE_PRIMARY)}

GRADUATED = "__graduated__"


def split_class_id(class_id):
    """'I_Diamond' -> ('I', 'Diamond'). A class id with no separator is all
    grade and no section."""
    raw = str(class_id or "")
    grade, sep, section = raw.partition("_")
    return (grade.strip(), section.strip()) if sep else (raw.strip(), "")


def next_grade(grade):
    """The grade a student moves into, preserving the school's own notation.

    Returns (next_grade, is_graduating). A school writing roman numerals keeps
    getting roman numerals back; a school writing '7' gets '8'. Mixing the two
    would silently create a second set of classes alongside the real ones.

    The last grade in a sequence graduates rather than promoting — there is
    nothing above XII, and inventing a XIII class would be worse than saying
    so. Pre-primary flows into the primary sequence in the school's notation
    (UKG -> I or 1), which is the one place the notation has to be inferred;
    it follows whatever the rest of that school's classes use, decided by the
    caller via `numeric_hint`.
    """
    g = str(grade or "").strip()
    if not g:
        return None, False

    upper = g.upper()
    if upper in _PRE_UPPER:
        i = _PRE_UPPER[upper]
        if i + 1 < len(PRE_PRIMARY):
            return PRE_PRIMARY[i + 1], False
        return None, False   # UKG: resolved by promote_class_id with the hint

    if upper in _ROMAN_UPPER:
        i = _ROMAN_UPPER[upper]
        return (ROMAN[i + 1], False) if i + 1 < len(ROMAN) else (None, True)

    if g.isdigit():
        n = int(g)
        if 1 <= n < 12:
            return str(n + 1), False
        if n == 12:
            return None, True

    # Unrecognized grade: never guess. The caller reports it as unmapped so a
    # human decides, rather than silently promoting a student into nothing.
    return None, False


def promote_class_id(class_id, numeric_school=False):
    """Target class id for one class, preserving section.

    Returns (new_class_id_or_None, is_graduating, reason_or_None).
    """
    grade, section = split_class_id(class_id)
    if not grade:
        return None, False, "no grade in class id"

    if grade.strip().upper() == "UKG":
        nxt = "1" if numeric_school else "I"
        return (f"{nxt}_{section}" if section else nxt), False, None

    nxt, graduating = next_grade(grade)
    if graduating:
        return None, True, None
    if not nxt:
        return None, False, f"unrecognized grade '{grade}'"
    return (f"{nxt}_{section}" if section else nxt), False, None


def school_uses_numeric_grades(class_ids):
    """Whether this school writes '1'..'12' rather than roman numerals.

    Decides only the UKG -> first-grade hop, where the notation can't be read
    off the source value. Ties go to roman, matching the observed class ids
    ('I_Diamond').
    """
    numeric = roman = 0
    for cid in class_ids or []:
        grade, _ = split_class_id(cid)
        if grade.isdigit():
            numeric += 1
        elif grade.upper() in _ROMAN_UPPER:
            roman += 1
    return numeric > roman


def build_promotion_plan(students, existing_class_ids, inbox_field="surveyInbox"):
    """Per-student promotion mapping.

    Returns {promoted, graduating, unmapped, missing_target_classes} where
    each entry is {id, name, from, to, reason}. `missing_target_classes` is
    the set of target class ids the school does not have yet — promoting into
    a class that doesn't exist would strand those students, so the preview
    surfaces it rather than the execute step discovering it.
    """
    existing = set(existing_class_ids or [])
    numeric = school_uses_numeric_grades(existing)

    promoted, graduating, unmapped = [], [], []
    missing_targets = set()

    for s in students:
        cid = s.get("classId") or ""
        entry = {"id": s.get("id"), "name": s.get("name") or s.get("id"), "from": cid}
        target, grads, reason = promote_class_id(cid, numeric)
        if grads:
            graduating.append({**entry, "to": GRADUATED, "reason": None})
        elif target:
            promoted.append({**entry, "to": target, "reason": None})
            if target not in existing:
                missing_targets.add(target)
        else:
            unmapped.append({**entry, "to": None, "reason": reason or "no class"})

    return {
        "promoted": promoted,
        "graduating": graduating,
        "unmapped": unmapped,
        "missing_target_classes": sorted(missing_targets),
    }


def build_reset_diff(students, options, existing_class_ids=None, inbox_field="surveyInbox"):
    """The itemized diff shown before anything is written.

    `options` are explicit booleans — nothing is implied. Every count here is
    of students that would ACTUALLY change: a student with an empty inbox is
    not counted under "inbox cleared", because a preview that overstates its
    effect trains people to ignore it.
    """
    opts = options or {}
    plan = build_promotion_plan(students, existing_class_ids, inbox_field) if opts.get("promote") else None

    inbox_to_clear = [s for s in students if s.get(inbox_field)] if opts.get("clear_inbox") else []
    reports_to_detach = [s for s in students if s.get("reports")] if opts.get("clear_reports") else []
    to_remove = []
    if opts.get("remove_ids"):
        wanted = set(opts["remove_ids"])
        to_remove = [s for s in students if s.get("id") in wanted]

    diff = {
        "total_students": len(students),
        "promote": bool(opts.get("promote")),
        "promoted_count": len(plan["promoted"]) if plan else 0,
        "graduating_count": len(plan["graduating"]) if plan else 0,
        "unmapped_count": len(plan["unmapped"]) if plan else 0,
        "missing_target_classes": plan["missing_target_classes"] if plan else [],
        "inbox_cleared_count": len(inbox_to_clear),
        "reports_detached_count": len(reports_to_detach),
        "removed_count": len(to_remove),
        "clear_sheets": bool(opts.get("clear_sheets")),
        "reset_operations": bool(opts.get("reset_operations")),
        "reset_receivables": bool(opts.get("reset_receivables")),
        # Named explicitly so the confirm screen can state what is NOT touched.
        "kept": ["subjects", "terms", "grading scales", "remark categories",
                  "months", "teachers/staff", "school details"],
    }
    diff["plan"] = plan
    diff["write_estimate"] = (
        diff["promoted_count"] + diff["graduating_count"]
        + diff["inbox_cleared_count"] + diff["reports_detached_count"]
        + diff["removed_count"]
    )
    return diff


def verify_archive(source_counts, archive_counts):
    """Row-count check between source and archive.

    Returns (ok, mismatches). The reset is blocked unless this passes: an
    archive that silently dropped rows is worse than no archive, because it
    reads as safety that isn't there.
    """
    mismatches = []
    for key, expected in (source_counts or {}).items():
        actual = (archive_counts or {}).get(key)
        if actual != expected:
            mismatches.append({"collection": key, "expected": expected, "archived": actual})
    return (not mismatches), mismatches


def slugify_school_id(name):
    """Suggest a Firestore-safe doc id from a school name.

    Only a SUGGESTION — the wizard lets it be overridden, because the id is
    also how humans refer to the school and Sid needs control of it.
    """
    out = []
    for ch in str(name or "").strip():
        if ch.isalnum():
            out.append(ch)
        elif ch in " -_" and out and out[-1] != "_":
            out.append("_")
    return "".join(out).strip("_")[:64]


# Firestore doc ids cannot contain / and cannot be '.' or '..'; the wizard also
# forbids whitespace so ids stay copy-pasteable into paths and URLs.
INVALID_ID_CHARS = set('/\\ \t\n.#$[]')


def validate_school_id(school_id):
    """(ok, error_or_None) for a user-supplied Firestore doc id."""
    sid = str(school_id or "").strip()
    if not sid:
        return False, "School ID is required."
    if len(sid) > 64:
        return False, "School ID must be 64 characters or fewer."
    bad = sorted({c for c in sid if c in INVALID_ID_CHARS})
    if bad:
        shown = ", ".join(repr(c) for c in bad)
        return False, f"School ID cannot contain: {shown}"
    if not sid[0].isalnum():
        return False, "School ID must start with a letter or number."
    return True, None


def _norm_name(name):
    return "".join(c for c in str(name or "").lower() if c.isalnum())


# Words that appear in half the school names in the country and therefore
# carry no identifying signal. Comparing on the DISTINCTIVE tokens is what
# catches "Samartha International School" vs "Samartha School" — plain edit
# distance cannot, because the shared word is buried among different ones.
NAME_STOPWORDS = {
    "school", "schools", "intl", "international", "public", "academy",
    "high", "higher", "secondary", "primary", "pre", "the", "of", "and",
    "english", "medium", "convent", "vidyalaya", "vidya", "mandir",
    "education", "educational", "society", "trust", "campus", "branch",
    "college", "institute", "junior", "senior", "central", "global", "world",
}


def _tokens(name):
    raw = [t for t in "".join(c if c.isalnum() else " " for c in str(name or "").lower()).split() if t]
    distinctive = [t for t in raw if t not in NAME_STOPWORDS and len(t) > 2]
    # A name made ENTIRELY of stopwords still needs something to compare on.
    return set(distinctive or raw)


def find_similar_schools(name, existing, threshold=0.82, token_threshold=0.3):
    """Near-duplicate names, so the wizard makes duplicates HARDER.

    The collection already carries 'Samartha International School' alongside
    'samarthaschool'. Exact-id uniqueness alone would have allowed every one
    of those, so this compares NAMES two ways and warns on either:

      - distinctive-token overlap (Jaccard), which catches the real pattern
        of the same school re-entered with different filler words
      - whole-string edit distance, which catches typos and abbreviations

    It warns, never blocks: two genuinely different schools can share a name
    stem ("St Mary's, Pune" and "St Mary's, Mumbai"), and that is the user's
    call to make, not this function's.
    """
    target = _norm_name(name)
    target_tokens = _tokens(name)
    if not target:
        return []

    hits = []
    for s in existing or []:
        label = s.get("name") or s.get("id")
        other = _norm_name(label)
        if not other:
            continue

        if other == target or other in target or target in other:
            ratio, why = 1.0, "same name"
        else:
            ratio, why = _similarity(target, other), "similar spelling"

        other_tokens = _tokens(label)
        shared = target_tokens & other_tokens
        jaccard = len(shared) / len(target_tokens | other_tokens) if (target_tokens | other_tokens) else 0.0
        if shared and jaccard >= token_threshold and jaccard > ratio:
            ratio, why = jaccard, f"shares “{'”, “'.join(sorted(shared))}”"

        if ratio >= threshold or (shared and jaccard >= token_threshold):
            hits.append({"id": s.get("id"), "name": label,
                          "similarity": round(ratio, 3), "reason": why})
    return sorted(hits, key=lambda h: -h["similarity"])[:5]


def _similarity(a, b):
    """Normalized Levenshtein, same metric as the education KB so the app's
    two fuzzy-matching surfaces behave consistently."""
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
