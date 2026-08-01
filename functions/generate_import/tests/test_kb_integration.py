#!/usr/bin/env python3
"""
Tests for the KB's integration into the import pipeline — the Part A refactor
("refactor those to consume it, deleting any duplicate dictionaries").

These are the regressions that would otherwise only show up in production:
the parser's grade vocabulary silently drifting from the shared seed, or the
KB failing to rescue a value the school spells differently.

Deliberately does NOT import main.py — that pulls in firebase_admin and
initializes an app at module load. The functions under test that live there
(kb_match, clean_subjects_rows) are covered by re-implementing only their
inputs, so this file stays stdlib-only like its siblings.

Run with: .venv_test/bin/python -m pytest tests/test_kb_integration.py -v
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest

import education_kb as kb
from normalize import (
    ROMAN_TO_NUM, normalize_grade, extract_grade_tokens, match_value, canonicalize,
)


# ───────────────────── the deleted duplicate dictionaries ──────────────────
def test_roman_numeral_table_is_derived_from_the_shared_seed():
    """ROMAN_TO_NUM used to be a hand-written literal in normalize.py that
    could drift from education_kb.json. It is now derived — this pins that it
    still covers I..XII and agrees with the KB."""
    assert ROMAN_TO_NUM == {"I": 1, "II": 2, "III": 3, "IV": 4, "V": 5, "VI": 6,
                             "VII": 7, "VIII": 8, "IX": 9, "X": 10, "XI": 11, "XII": 12}
    for roman, num in ROMAN_TO_NUM.items():
        assert kb.classify(roman, expect=kb.GRADE)["canonical"] == str(num)


def test_normalize_grade_agrees_with_the_knowledge_base():
    """normalize_grade is now a thin wrapper — every grade the KB knows must
    round-trip through it identically, in both directions."""
    for canonical in kb.list_grades():
        assert normalize_grade(canonical) == canonical
        for alias in kb.aliases_for(canonical, kb.GRADE):
            assert normalize_grade(alias) == canonical, f"{alias} -> {normalize_grade(alias)}"


def test_normalize_grade_is_a_symmetric_comparison_key():
    """The whole point of this function: a school's live clazz value and an
    imported grade cell must land on the same key however each is spelled."""
    pairs = [("III", "3"), ("Grade 3", "3"), ("Std. III", "3"),
             ("Jr KG", "LKG"), ("Junior KG", "LKG"), ("nursery", "Nursery")]
    for a, b in pairs:
        assert normalize_grade(a) == normalize_grade(b), f"{a!r} vs {b!r}"


def test_unknown_grades_still_pass_through_uppercased():
    """Unrecognized values keep the original fallback behavior — a grade the
    KB has never seen must not become empty and silently drop a row."""
    assert normalize_grade("Batch Alpha") == "BATCH ALPHA"
    assert normalize_grade("") == ""
    assert normalize_grade(None) == ""


def test_grade_token_extraction_still_handles_the_real_world_cases():
    assert extract_grade_tokens("Garde 7,10") == ["7", "10"]
    assert extract_grade_tokens("Grade7,8,9") == ["7", "8", "9"]
    assert extract_grade_tokens("Jr. KG") == ["LKG"]
    assert extract_grade_tokens("Senior KG") == ["UKG"]
    assert extract_grade_tokens("Class-9") == ["9"]
    assert extract_grade_tokens("VI - A") == ["6"]
    assert extract_grade_tokens("no grade here") == []


# ────────────────────────── kb_match: the rescue path ──────────────────────
# Re-implements main.py's kb_match so this file stays firebase-free. Any
# change to the real one must be mirrored here — the assertions below are
# what make that worth doing.
def kb_match(raw, kind, valid_canon_to_display, aliases, kb_overlay):
    status, display, extra = match_value(raw, kind, valid_canon_to_display, aliases)
    if status == "auto":
        return status, display, extra
    expect = kb.SUBJECT if kind == "subject" else kb.SECTION
    result = kb.classify(raw, expect=expect, overlay=kb_overlay)
    canonical = result["canonical"]
    if not canonical or result["confidence"] < kb.HIGH_CONFIDENCE:
        return status, display, extra
    if result["type"] not in (kb.SUBJECT, kb.COSCHOLASTIC, kb.SECTION):
        return status, display, extra
    retry_status, retry_display, _ = match_value(canonical, kind, valid_canon_to_display, aliases)
    if retry_status == "auto":
        return "auto", retry_display, "kb_canonical_match"
    return status, display, extra


SCHOOL_SUBJECTS = {canonicalize("English"): "English",
                    canonicalize("Mathematics"): "Mathematics",
                    canonicalize("EVS"): "EVS"}


def test_kb_rescues_a_subject_the_school_spells_differently():
    """'Eng' is not in this school's configured subject list and is too far
    from 'English' for fuzzy matching — the KB is what closes the gap, with
    no learned alias needed."""
    fuzzy_status, _, _ = match_value("Eng", "subject", SCHOOL_SUBJECTS, {})
    assert fuzzy_status == "unknown", "precondition: plain matching cannot resolve this"

    status, display, rule = kb_match("Eng", "subject", SCHOOL_SUBJECTS, {}, {})
    assert status == "auto"
    assert display == "English"
    assert rule == "kb_canonical_match"


def test_kb_rescue_covers_the_real_fixture_values():
    for raw, expected in [("Maths", "Mathematics"), ("Ganit", "Mathematics"),
                          ("Environmental Studies", "EVS"), ("eng", "English")]:
        status, display, _ = kb_match(raw, "subject", SCHOOL_SUBJECTS, {}, {})
        assert (status, display) == ("auto", expected), f"{raw!r} -> {status} {display}"


def test_school_configuration_still_wins_over_the_knowledge_base():
    """A school that calls it 'Eng' in its own Subjects list must keep seeing
    'Eng' — the KB is a fallback, not an override of the school's wording."""
    school_uses_eng = {canonicalize("Eng"): "Eng"}
    status, display, rule = kb_match("Eng", "subject", school_uses_eng, {}, {})
    assert (status, display) == ("auto", "Eng")
    assert rule == "canonical_match"


def test_kb_does_not_invent_a_subject_the_school_has_not_configured():
    """The KB knowing what 'Drawing' means doesn't make it a valid value for
    a school whose Subjects list has no equivalent — that's a School Setup
    gap for structure inference to propose, not something to auto-apply."""
    status, display, _ = kb_match("Drawing", "subject", SCHOOL_SUBJECTS, {}, {})
    assert status != "auto"
    assert display != "Art & Craft"


def test_kb_match_respects_the_learned_overlay():
    overlay = kb.build_overlay([
        {"value": kb.canonicalize("Ganita"), "type": kb.SUBJECT, "canonical": "Mathematics"},
    ])
    status, display, rule = kb_match("Ganita", "subject", SCHOOL_SUBJECTS, {}, overlay)
    assert (status, display, rule) == ("auto", "Mathematics", "kb_canonical_match")


def test_kb_match_resolves_named_sections():
    school_sections = {canonicalize("Rose"): "ROSE", canonicalize("Lotus"): "LOTUS"}
    status, display, _ = kb_match("rose", "class", school_sections, {}, {})
    assert (status, display) == ("auto", "ROSE")


# ──────────────────── subject rows: scholastic vs co-scholastic ────────────
def area_for(name, overlay=None):
    """The classification clean_subjects_rows applies to the `area` column."""
    r = kb.classify(name, overlay=overlay)
    if r["type"] == kb.SUBJECT and r["confidence"] >= kb.HIGH_CONFIDENCE:
        return "Scholastic"
    if r["type"] == kb.COSCHOLASTIC and r["confidence"] >= kb.HIGH_CONFIDENCE:
        return "Co-Scholastic"
    return ""


@pytest.mark.parametrize("name,expected", [
    ("English", "Scholastic"), ("Maths", "Scholastic"), ("EVS", "Scholastic"),
    ("SST", "Scholastic"), ("Computer", "Scholastic"), ("Physics", "Scholastic"),
    ("Art & Craft", "Co-Scholastic"), ("Drawing", "Co-Scholastic"),
    ("PT", "Co-Scholastic"), ("Yoga", "Co-Scholastic"), ("GK", "Co-Scholastic"),
    ("Moral Science", "Co-Scholastic"), ("Library", "Co-Scholastic"),
    # Unknown names get no area at all rather than a coin-flip guess.
    ("Zephyr Studies", ""), ("", ""),
])
def test_subject_area_inference(name, expected):
    assert area_for(name) == expected
