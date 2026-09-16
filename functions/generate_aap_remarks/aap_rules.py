"""Pure decision logic for generate_aap_remarks — no Firestore, no network,
unit-tested in tests/test_aap_rules.py. Same shape as subject_match.py:
logic that can be wrong in a way that matters (a wrong Stage puts the wrong
rubric text on a report card; a missed gender issue misgenders a child in
print) belongs somewhere it can be tested without a Firebase environment.

Stage resolution goes through the shared class_resolver's grade taxonomy
(GRADE_INDEX, built from functions/shared/education_kb.json) rather than a
second, divergent grade-name dict of our own — that duplication is exactly
what class_resolver.py's own docstring says it replaced elsewhere in this
repo, and a hardcoded dict here silently mishandled any school spelling a
grade differently ("1"/"2" instead of "I"/"II", "Pre-Nursery" not being in
the old dict at all).
"""

from class_resolver import grade_ordinal, normalize_section_value

# Stage bands by grade ORDINAL. Pre-primary ordinals are negative (see
# PRE_PRIMARY_ORDINALS in class_resolver.py), so `<=` bands still work.
STAGE_ORDINAL_BANDS = [
    (2, "Foundation"),    # Pre-Nursery..II
    (5, "Preparatory"),   # III..V
    (12, "Middle"),       # VI..XII
]


def resolve_stage(grade_token):
    """Grade token -> Stage, or None if the token matches nothing in
    class_resolver's GRADE_INDEX. Callers must treat None as a blocking
    finding, not default to a guess — an unrecognised grade has no Stage to
    derive descriptor text from."""
    resolved = grade_ordinal(grade_token)
    if resolved is None:
        return None
    _, ordinal = resolved
    for max_ordinal, stage in STAGE_ORDINAL_BANDS:
        if ordinal <= max_ordinal:
            return stage
    return None


def canonical_grade_section(grade_raw, section_raw):
    """Normalizes a (grade, section) pair the same way regardless of which
    school's spelling produced it, so a survey response can be matched to a
    class by MEANING rather than exact string equality. Falls back to the
    raw (uppercased) grade when it doesn't resolve — unresolved grades still
    compare consistently with each other, they just won't match a resolved
    one, which is the correct (fail-closed) behavior here."""
    resolved = grade_ordinal(grade_raw)
    canonical_grade = resolved[0] if resolved else str(grade_raw or "").strip().upper()
    return canonical_grade, normalize_section_value(section_raw)


def gender_issue(ratings, students):
    """Missing or suspiciously uniform gender across the class's rated
    students — a class where every student resolves to the same gender is
    far more likely an import/mapping bug than a real roster, and a blank
    gender is silently written about as "She" downstream unless this is
    caught first. Returns None when nothing looks wrong.

    `ratings` is {student_id: ...} (only the keys matter here); `students`
    is {student_id: {"gender": ..., ...}}.

    The uniform check needs at least 2 students with a KNOWN gender to fire —
    a single-student regenerate run, or a two-student class that's genuinely
    single-gender, shouldn't trip it.
    """
    total = len(ratings)
    if total == 0:
        return None
    known = [students.get(sid, {}).get("gender", "").strip()
             for sid in ratings if students.get(sid, {}).get("gender", "").strip()]
    missing = total - len(known)
    distinct = set(known)
    uniform_gender = next(iter(distinct)) if len(distinct) == 1 and len(known) >= 2 else None
    if missing == 0 and not uniform_gender:
        return None
    return {"missingCount": missing, "totalCount": total, "uniformGender": uniform_gender}
