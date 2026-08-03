"""Class resolver fixtures.

The formats in item 3 of the task, plus the ones that caused real bugs. The
NAVODAYA case is the reason this module exists: reset_rules split on "_" and
nothing else, so every non-underscore school reported 100% unmapped.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from class_resolver import (  # noqa: E402
    CONF_HIGH, CONF_MEDIUM, CONF_NONE,
    parse_class_value, resolve_class, build_school_context, raw_class_value,
    ordinal_to_token, notation_of, describe_unresolved, distinct_class_values,
)


# ── The formats item 3 names explicitly ─────────────────────────────────────
@pytest.mark.parametrize("raw,grade_ord,section", [
    ("I_Diamond", 1, "Diamond"),
    ("1-B", 1, "B"),
    ("Grade 1 B", 1, "B"),
    ("I B", 1, "B"),
    ("STD I - B", 1, "B"),
    ("LKG-Winner", -1, "Winner"),
    ("Nursery", -2, ""),
    ("UKG", 0, ""),
    ("Jr KG", -1, ""),
    ("Sr KG", 0, ""),
])
def test_documented_formats_resolve(raw, grade_ord, section):
    p = parse_class_value(raw)
    assert p["grade_ordinal"] == grade_ord, f"{raw!r} -> {p}"
    assert p["section"] == section


@pytest.mark.parametrize("roman,ordinal", [
    ("I", 1), ("II", 2), ("III", 3), ("IV", 4), ("V", 5), ("VI", 6),
    ("VII", 7), ("VIII", 8), ("IX", 9), ("X", 10), ("XI", 11), ("XII", 12),
])
def test_roman_one_to_twelve(roman, ordinal):
    assert parse_class_value(roman)["grade_ordinal"] == ordinal


@pytest.mark.parametrize("n", range(1, 13))
def test_digits_one_to_twelve(n):
    assert parse_class_value(str(n))["grade_ordinal"] == n


@pytest.mark.parametrize("raw", [
    "  I_Diamond  ", "i_diamond", "I__Diamond", "I / Diamond", "I.Diamond",
    "GRADE I DIAMOND", "std i-diamond", "Class I : Diamond",
])
def test_casing_separators_and_whitespace_do_not_matter(raw):
    p = parse_class_value(raw)
    assert p["grade_ordinal"] == 1
    assert p["section"].lower() == "diamond"


def test_glued_digit_and_letter():
    p = parse_class_value("1B")
    assert (p["grade_ordinal"], p["section"]) == (1, "B")
    p = parse_class_value("10A")
    assert (p["grade_ordinal"], p["section"]) == (10, "A")


def test_ordinal_suffixes():
    for raw, expected in [("1st", 1), ("2nd A", 2), ("3rd", 3), ("10th B", 10)]:
        assert parse_class_value(raw)["grade_ordinal"] == expected


def test_multiword_grades_beat_their_own_fragments():
    """'Jr KG' must not match on a leading fragment, and 'Pre Nursery' must
    not be read as 'Nursery'."""
    assert parse_class_value("Jr KG-Winner")["grade_ordinal"] == -1
    assert parse_class_value("Pre Nursery A")["grade_ordinal"] == -3
    assert parse_class_value("Nursery A")["grade_ordinal"] == -2


def test_ix_is_grade_nine_not_grade_one_section_x():
    """The bug a naive longest-prefix parser would introduce."""
    p = parse_class_value("IX")
    assert p["grade_ordinal"] == 9
    assert p["section"] == ""


def test_ix_with_a_section():
    p = parse_class_value("IX-A")
    assert (p["grade_ordinal"], p["section"]) == (9, "A")


# ── Ordinals make promotion arithmetic ──────────────────────────────────────
def test_pre_primary_ladder_is_plain_addition():
    """The scale is chosen so +1 walks Nursery -> LKG -> UKG -> Grade 1 with
    no special case anywhere."""
    assert parse_class_value("Nursery")["grade_ordinal"] + 1 == \
        parse_class_value("LKG")["grade_ordinal"]
    assert parse_class_value("LKG")["grade_ordinal"] + 1 == \
        parse_class_value("UKG")["grade_ordinal"]
    assert parse_class_value("UKG")["grade_ordinal"] + 1 == \
        parse_class_value("1")["grade_ordinal"] == 1


def test_ordinal_renders_back_into_the_schools_notation():
    assert ordinal_to_token(2, "roman") == "II"
    assert ordinal_to_token(2, "numeric") == "2"
    assert ordinal_to_token(-1) == "LKG"
    assert ordinal_to_token(0) == "UKG"
    assert ordinal_to_token(13, "roman") is None


def test_notation_detection_follows_the_majority():
    assert notation_of(["I_A", "II_A", "III_B"]) == "roman"
    assert notation_of(["1_A", "2_A", "3_B"]) == "numeric"
    # Ties go to roman, matching the observed data.
    assert notation_of(["I_A", "1_A"]) == "roman"
    assert notation_of([]) == "roman"


# ── Unresolvable values are reported, never guessed ─────────────────────────
def test_unrecognized_value_is_not_guessed():
    p = parse_class_value("1st Std Batch Alpha Overflow")
    # Leading token IS resolvable here; the point is it never invents an
    # ordinal it cannot justify.
    assert p["grade_ordinal"] == 1

    p2 = parse_class_value("Batch Alpha")
    assert p2["grade_ordinal"] is None
    assert p2["confidence"] == CONF_NONE
    assert "Batch Alpha" in p2["reason"]


def test_empty_value_is_reported_as_empty():
    p = parse_class_value("")
    assert p["grade_ordinal"] is None
    assert p["reason"] == "empty"


def test_unresolved_labels_are_never_blank():
    """The reset preview rendered bare arrows for these. Item 5."""
    assert describe_unresolved("", "classId") == 'classId: "" (empty)'
    assert describe_unresolved("1st Std", "class") == 'class: "1st Std" (unrecognized)'
    assert describe_unresolved(None, None) == "no class field on the student record"


# ── Reading the value off a student document ────────────────────────────────
def test_class_id_field_wins():
    assert raw_class_value({"classId": "I_A", "grade": "II"}) == ("I_A", "classId")


def test_import_pipeline_field_is_read():
    """currentClassId is what the import pipeline writes — missing it is what
    put every student in '(no class)' once already."""
    assert raw_class_value({"currentClassId": "I_A"}) == ("I_A", "currentClassId")


def test_grade_and_section_are_composed():
    raw, field = raw_class_value({"grade": "1", "section": "B"})
    assert raw == "1_B"
    assert field == "grade+section"


def test_grade_without_section_still_resolves():
    raw, field = raw_class_value({"grade": "5"})
    assert (raw, field) == ("5", "grade")


def test_student_with_no_class_fields():
    assert raw_class_value({"name": "x"}) == (None, None)


# ── Full resolution with school context ─────────────────────────────────────
def test_exact_match_against_configured_classes_is_high_confidence():
    ctx = build_school_context(["I_Diamond", "II_Diamond"])
    r = resolve_class({"classId": "I_Diamond"}, ctx)
    assert r["confidence"] == CONF_HIGH
    assert r["canonical_class_id"] == "I_Diamond"


def test_resolution_follows_the_schools_separator():
    ctx = build_school_context(["1-A", "2-A"])
    r = resolve_class({"classId": "1-B"}, ctx)
    assert r["canonical_class_id"] == "1-B"


def test_confirmed_class_map_outranks_parsing():
    """Part 2's whole point: a human answer is permanent and beats inference."""
    ctx = build_school_context(
        ["I_A"],
        class_map={"Batch Alpha": {"canonical_class_id": "I_A", "grade_ordinal": 1,
                                    "section": "A", "source": "confirmed"}})
    r = resolve_class({"classId": "Batch Alpha"}, ctx)
    assert r["canonical_class_id"] == "I_A"
    assert r["confidence"] == CONF_HIGH
    assert r["grade_ordinal"] == 1


def test_unresolved_student_carries_the_field_and_raw_value():
    r = resolve_class({"classId": "Batch Alpha"}, build_school_context([]))
    assert r["canonical_class_id"] is None
    assert r["raw"] == "Batch Alpha"
    assert r["raw_field"] == "classId"
    assert "Batch Alpha" in r["label"]


def test_resolve_accepts_a_bare_string():
    """The class_map scanner works on distinct values, not documents."""
    r = resolve_class("I_Diamond", build_school_context(["I_Diamond"]))
    assert r["grade_ordinal"] == 1


def test_distinct_values_summarizes_a_roster_without_touching_it():
    students = [
        {"id": "a", "classId": "I_A"}, {"id": "b", "classId": "I_A"},
        {"id": "c", "classId": "II_B"}, {"id": "d", "name": "no class"},
    ]
    out = distinct_class_values(students)
    assert out["I_A"]["count"] == 2
    assert out["II_B"]["count"] == 1
    assert out[""]["count"] == 1
    assert out["I_A"]["sample_ids"] == ["a", "b"]


# ── The regression that started this task ───────────────────────────────────
@pytest.mark.parametrize("raw", [
    "1-B", "Grade 1 B", "I B", "STD I - B", "1 B", "Class-1-B", "1/B",
])
def test_non_underscore_formats_are_no_longer_unmapped(raw):
    """reset_rules.split_class_id used partition('_') only, so every one of
    these resolved to a single unrecognized grade token and the whole school
    reported 'class the promotion rules do not recognize'."""
    p = parse_class_value(raw)
    assert p["grade_ordinal"] == 1, f"{raw!r} still unmapped: {p}"
    assert p["section"] == "B"
