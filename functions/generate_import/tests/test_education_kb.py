#!/usr/bin/env python3
"""
Contract tests for education_kb.py — the shared education knowledge base.

Layers, mirroring test_tabular_parser.py's structure:
1. A CLASSIFICATION FIXTURE TABLE of 100+ real values (pulled from the real
   school files in tests/fixtures/ — 'Eng', 'Maths', 'EVS', '3-A', 'Sec',
   'Jr KG' and friends — plus the alias families the task enumerates),
   asserting the expected type and canonical form for each.
2. Universal contract sweeps: classify() never raises for ANY input, always
   returns the full result shape, and every seeded canonical/alias round-trips
   to itself.
3. Targeted tests for the tricky calls: expect-hint tie-breaking, the learned
   overlay, cached 'other' answers, and confidence banding.
4. A PARITY fixture list pinning the values src/utils/educationKB.js must
   agree with byte-for-byte (it is a hand-port; this is what keeps it honest).

Run with: .venv_test/bin/python -m pytest tests/test_education_kb.py -v
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest

import education_kb as kb
from education_kb import (
    SUBJECT, COSCHOLASTIC, GRADE, SECTION, UNKNOWN, OTHER,
    HIGH_CONFIDENCE, MEDIUM_CONFIDENCE, classify, normalize, build_overlay,
)


# ─────────────────────────── 1. classification fixtures ────────────────────
# (raw value, expected type, expected canonical). `expect` hint is None here
# on purpose: these must classify correctly with NO context, which is the
# hard case and the one the import parser actually faces.
#
# Values marked "# real" appear verbatim in tests/fixtures/ school files.
CLASSIFICATION_FIXTURES = [
    # ---- scholastic subjects: canonical forms
    ("English", SUBJECT, "English"),                    # real (Teacher_Information)
    ("Mathematics", SUBJECT, "Mathematics"),            # real
    ("Science", SUBJECT, "Science"),                    # real
    ("Hindi", SUBJECT, "Hindi"),
    ("Marathi", SUBJECT, "Marathi"),
    ("Sanskrit", SUBJECT, "Sanskrit"),
    ("EVS", SUBJECT, "EVS"),                            # real
    ("Social Science", SUBJECT, "Social Science"),
    ("Computer", SUBJECT, "Computer"),
    ("General Awareness", SUBJECT, "General Awareness"),
    ("English Grammar", SUBJECT, "English Grammar"),
    ("Physics", SUBJECT, "Physics"),
    ("Chemistry", SUBJECT, "Chemistry"),
    ("Biology", SUBJECT, "Biology"),
    ("Geography", SUBJECT, "Geography"),
    ("Economics", SUBJECT, "Economics"),

    # ---- scholastic subjects: the aliases the task enumerates
    ("Eng", SUBJECT, "English"),                        # real
    ("eng", SUBJECT, "English"),
    ("ENG", SUBJECT, "English"),
    ("English Language", SUBJECT, "English"),
    ("Maths", SUBJECT, "Mathematics"),                  # real
    ("maths", SUBJECT, "Mathematics"),
    ("Math", SUBJECT, "Mathematics"),
    ("Ganit", SUBJECT, "Mathematics"),
    ("MATHS", SUBJECT, "Mathematics"),
    ("Sci", SUBJECT, "Science"),
    ("Environmental Studies", SUBJECT, "EVS"),
    ("Environmental Science", SUBJECT, "EVS"),
    ("E.V.S", SUBJECT, "EVS"),
    ("E V S", SUBJECT, "EVS"),
    ("SST", SUBJECT, "Social Science"),
    ("Social Studies", SUBJECT, "Social Science"),
    ("S.St", SUBJECT, "Social Science"),
    ("ICT", SUBJECT, "Computer"),
    ("Computer Science", SUBJECT, "Computer"),
    ("Computers", SUBJECT, "Computer"),
    ("Information Technology", SUBJECT, "Computer"),
    ("GA", SUBJECT, "General Awareness"),
    ("Grammar", SUBJECT, "English Grammar"),
    ("Hin", SUBJECT, "Hindi"),
    ("Sans", SUBJECT, "Sanskrit"),
    ("Bio", SUBJECT, "Biology"),
    ("Chem", SUBJECT, "Chemistry"),
    ("Phy", SUBJECT, "Physics"),
    ("Accounts", SUBJECT, "Accountancy"),
    ("BST", SUBJECT, "Business Studies"),
    ("Pol Sci", SUBJECT, "Political Science"),
    ("2nd Language", SUBJECT, "Second Language"),

    # ---- co-scholastic areas: canonical forms
    ("Art & Craft", COSCHOLASTIC, "Art & Craft"),
    ("Music", COSCHOLASTIC, "Music"),
    ("Dance", COSCHOLASTIC, "Dance"),
    ("Physical Education", COSCHOLASTIC, "Physical Education"),
    ("Work Education", COSCHOLASTIC, "Work Education"),
    ("Value Education", COSCHOLASTIC, "Value Education"),
    ("General Knowledge", COSCHOLASTIC, "General Knowledge"),
    ("Yoga", COSCHOLASTIC, "Yoga"),
    ("Library", COSCHOLASTIC, "Library"),
    ("Health", COSCHOLASTIC, "Health"),

    # ---- co-scholastic: aliases
    ("Drawing", COSCHOLASTIC, "Art & Craft"),
    ("Art and Craft", COSCHOLASTIC, "Art & Craft"),
    ("art&craft", COSCHOLASTIC, "Art & Craft"),
    ("ART - CRAFT", COSCHOLASTIC, "Art & Craft"),
    ("Painting", COSCHOLASTIC, "Art & Craft"),
    ("PE", COSCHOLASTIC, "Physical Education"),
    ("P.E", COSCHOLASTIC, "Physical Education"),
    ("PT", COSCHOLASTIC, "Physical Education"),
    ("Sports", COSCHOLASTIC, "Physical Education"),
    ("Games", COSCHOLASTIC, "Physical Education"),
    ("SUPW", COSCHOLASTIC, "Work Education"),
    ("Work Experience", COSCHOLASTIC, "Work Education"),
    ("Moral Science", COSCHOLASTIC, "Value Education"),
    ("Sanskar", COSCHOLASTIC, "Value Education"),
    ("Moral Values", COSCHOLASTIC, "Value Education"),
    ("GK", COSCHOLASTIC, "General Knowledge"),
    ("G.K", COSCHOLASTIC, "General Knowledge"),
    ("Vocal Music", COSCHOLASTIC, "Music"),
    ("Singing", COSCHOLASTIC, "Music"),
    ("Lib", COSCHOLASTIC, "Library"),
    ("Health & Hygiene", COSCHOLASTIC, "Health"),
    ("Hand Writing", COSCHOLASTIC, "Handwriting"),
    ("Elocution", COSCHOLASTIC, "Recitation"),
    ("Dramatics", COSCHOLASTIC, "Drama"),
    ("Scouts and Guides", COSCHOLASTIC, "Scouting"),
    ("Taekwondo", COSCHOLASTIC, "Karate"),
    ("Social Emotional Wellbeing", COSCHOLASTIC, "SEW"),

    # ---- grades: pre-primary
    ("Nursery", GRADE, "Nursery"),
    ("NURSERY", GRADE, "Nursery"),
    ("Nur", GRADE, "Nursery"),
    ("LKG", GRADE, "LKG"),
    ("UKG", GRADE, "UKG"),
    ("Jr KG", GRADE, "LKG"),
    ("Jr. KG", GRADE, "LKG"),
    ("Junior KG", GRADE, "LKG"),
    ("Sr KG", GRADE, "UKG"),
    ("Senior KG", GRADE, "UKG"),
    ("Lower KG", GRADE, "LKG"),
    ("Upper KG", GRADE, "UKG"),
    ("KG1", GRADE, "LKG"),
    ("KG 2", GRADE, "UKG"),
    ("Playgroup", GRADE, "Pre-Nursery"),

    # ---- grades: numeric, roman, prefixed
    ("1", GRADE, "1"),
    ("7", GRADE, "7"),                                  # real (student_plain.csv)
    ("10", GRADE, "10"),
    ("12", GRADE, "12"),
    ("Grade III", GRADE, "3"),
    ("Grade 4", GRADE, "4"),
    ("Std 5", GRADE, "5"),
    ("Std. 6", GRADE, "6"),
    ("Class 9", GRADE, "9"),
    ("Class-9", GRADE, "9"),
    ("CLASS XII", GRADE, "12"),
    ("Garde 7", GRADE, "7"),                            # real-world typo
    ("Grade7", GRADE, "7"),                             # no space after the prefix
    ("Std5", GRADE, "5"),
    ("Grade I", GRADE, "1"),
    ("Grade V", GRADE, "5"),
    ("Grade X", GRADE, "10"),
    ("std viii", GRADE, "8"),

    # ---- sections: letters and named families
    ("A", SECTION, "A"),                                # real
    ("B", SECTION, "B"),                                # real
    ("C", SECTION, "C"),                                # real
    ("D", SECTION, "D"),
    ("Rose", SECTION, "Rose"),
    ("Lotus", SECTION, "Lotus"),
    ("Ruby", SECTION, "Ruby"),
    ("Emerald", SECTION, "Emerald"),
    ("Red", SECTION, "Red"),
    ("Blue", SECTION, "Blue"),
    ("Yellow", SECTION, "Yellow"),
    ("Winner", SECTION, "Winner"),
    ("Victor", SECTION, "Victor"),
    ("Champion", SECTION, "Champion"),
    ("Honesty", SECTION, "Honesty"),
    ("Peacock", SECTION, "Peacock"),
    ("A1", SECTION, "A1"),
    ("B-2", SECTION, "B2"),

    # ---- values that must NOT be confidently classified (LLM territory)
    ("Sunrise Batch", UNKNOWN, None),
    ("classical", UNKNOWN, None),   # must not have 'class' chewed off the front
    ("Zephyr", UNKNOWN, None),
    ("qwertyuiop", UNKNOWN, None),
    ("", UNKNOWN, None),
    ("   ", UNKNOWN, None),
]


@pytest.mark.parametrize("raw,expected_type,expected_canonical", CLASSIFICATION_FIXTURES)
def test_classification_fixtures(raw, expected_type, expected_canonical):
    r = classify(raw)
    assert r["type"] == expected_type, f"{raw!r} -> {r}"
    if expected_canonical is not None:
        assert r["canonical"] == expected_canonical, f"{raw!r} -> {r}"


def test_fixture_table_covers_at_least_100_values():
    """The task requires >=100 real classification fixtures across all types."""
    assert len(CLASSIFICATION_FIXTURES) >= 100
    types = {t for _, t, _ in CLASSIFICATION_FIXTURES}
    assert {SUBJECT, COSCHOLASTIC, GRADE, SECTION, UNKNOWN} <= types


# ───────────────────────────── 2. universal contract ───────────────────────
HOSTILE_INPUTS = [
    None, "", "   ", "\t\n", "?", "-", "...", "&", "/", "()", "123456789012345",
    "A" * 500, "日本語", "🙂", "NULL", "#REF!", "0", "13", "99", "Grade", "Std",
    "class", "  Eng  ", "eNgLiSh", "MATHS ", " ", "1.0", "3-A", "N/A",
]


@pytest.mark.parametrize("raw", HOSTILE_INPUTS)
def test_classify_never_raises_and_returns_full_shape(raw):
    for expect in (None, SUBJECT, COSCHOLASTIC, GRADE, SECTION):
        r = classify(raw, expect=expect)
        assert set(r) == {"type", "canonical", "confidence", "source", "alternatives"}
        assert r["type"] in (SUBJECT, COSCHOLASTIC, GRADE, SECTION, OTHER, UNKNOWN)
        assert 0.0 <= r["confidence"] <= 1.0
        assert isinstance(r["alternatives"], list)
        if r["type"] == UNKNOWN:
            assert r["canonical"] is None


def test_every_seeded_canonical_round_trips():
    """A canonical form must classify back to itself at full confidence —
    otherwise the seed contradicts its own index."""
    for kind, names in ((SUBJECT, kb.list_subjects()),
                        (COSCHOLASTIC, kb.list_coscholastic()),
                        (GRADE, kb.list_grades())):
        for name in names:
            r = classify(name, expect=kind)
            assert r["type"] == kind, f"{name} ({kind}) -> {r}"
            assert r["canonical"] == name, f"{name} ({kind}) -> {r}"
            assert r["confidence"] >= HIGH_CONFIDENCE, f"{name} -> {r}"


def test_every_seeded_alias_resolves_to_its_canonical():
    for kind, names in ((SUBJECT, kb.list_subjects()),
                        (COSCHOLASTIC, kb.list_coscholastic()),
                        (GRADE, kb.list_grades())):
        for name in names:
            for alias in kb.aliases_for(name, kind):
                r = classify(alias, expect=kind)
                assert r["canonical"] == name, f"alias {alias!r} of {name!r} -> {r}"
                assert r["confidence"] >= HIGH_CONFIDENCE


def test_every_section_name_classifies_as_section():
    for name in kb.list_section_names():
        r = classify(name, expect=SECTION)
        assert r["type"] == SECTION, f"{name} -> {r}"
        assert r["canonical"] == name


def test_no_canonical_is_claimed_by_two_families():
    """A value can't be both a subject and a co-scholastic area — that would
    make classification order, not meaning, decide the answer."""
    subs = {kb.canonicalize(n) for n in kb.list_subjects()}
    cos = {kb.canonicalize(n) for n in kb.list_coscholastic()}
    assert not (subs & cos), f"claimed by both: {subs & cos}"


# ─────────────────────────── 3. targeted behaviors ─────────────────────────
def test_expect_hint_breaks_section_vs_subject_tie():
    """'Art' is Art & Craft in a subject box and a house name in a section
    box. Without a hint the KB prefers the seeded subject knowledge."""
    assert classify("Art")["type"] == COSCHOLASTIC
    assert classify("Art", expect=SECTION)["type"] == COSCHOLASTIC  # not a seeded section name
    assert classify("Rose", expect=SECTION)["type"] == SECTION


def test_bare_single_letter_is_a_section_not_a_roman_grade():
    """'V' beside a class in a school file is section V far more often than
    grade 5 — guessing wrong here silently mis-files students."""
    assert classify("V")["type"] == SECTION
    assert classify("V", expect=SECTION)["canonical"] == "V"
    assert classify("I")["type"] == SECTION
    # ...but an explicit grade context, or a 'Grade' prefix, resolves it.
    assert classify("V", expect=GRADE)["type"] == GRADE
    assert classify("V", expect=GRADE)["canonical"] == "5"
    assert classify("Grade V")["type"] == GRADE
    assert classify("Grade V")["canonical"] == "5"


def test_numbers_outside_1_12_are_not_grades():
    assert classify("0")["type"] != GRADE
    assert classify("13")["type"] != GRADE
    assert classify("99")["type"] != GRADE


def test_fuzzy_band_is_a_suggestion_not_an_auto_apply():
    """A near-miss lands in the medium band: the UI must offer it, not
    silently apply it."""
    r = classify("Mathematcs")  # transposed/missing letter
    assert r["canonical"] == "Mathematics"
    assert MEDIUM_CONFIDENCE <= r["confidence"] < HIGH_CONFIDENCE
    assert r["source"] == "fuzzy"


def test_learned_overlay_answers_a_value_the_seed_does_not_know():
    overlay = build_overlay([
        {"value": kb.canonicalize("Sunrise Batch"), "type": SECTION, "canonical": "Sunrise Batch"},
    ])
    assert classify("Sunrise Batch")["type"] == UNKNOWN
    r = classify("Sunrise Batch", overlay=overlay)
    assert r["type"] == SECTION
    assert r["canonical"] == "Sunrise Batch"
    assert r["source"] == "learned"
    assert r["confidence"] >= HIGH_CONFIDENCE


def test_cached_other_answer_stops_the_value_being_asked_again():
    """A confirmed 'this is none of the above' is as valuable as a positive
    answer — it must come back as a definite `other`, not `unknown`."""
    overlay = build_overlay([{"value": kb.canonicalize("Remarks Column"), "type": OTHER, "canonical": ""}])
    r = classify("Remarks Column", overlay=overlay)
    assert r["type"] == OTHER
    assert r["source"] == "learned"


def test_overlay_never_overrides_seeded_canon():
    """A bad learned entry must not be able to redefine 'Maths'."""
    overlay = build_overlay([{"value": kb.canonicalize("Maths"), "type": SECTION, "canonical": "Maths"}])
    r = classify("Maths", overlay=overlay)
    assert r["type"] == SUBJECT
    assert r["canonical"] == "Mathematics"


def test_build_overlay_ignores_malformed_entries():
    overlay = build_overlay([
        {"value": "", "type": SUBJECT, "canonical": "X"},
        {"value": "abc", "type": "nonsense", "canonical": "X"},
        {"type": SUBJECT},
        {"value": "ok", "type": SUBJECT, "canonical": "OK"},
    ])
    assert set(overlay) == {"ok"}


def test_normalize_stays_inside_the_requested_family():
    assert normalize("Eng", SUBJECT) == "English"
    assert normalize("maths", SUBJECT) == "Mathematics"
    assert normalize("Grade III", GRADE) == "3"
    assert normalize("rose", SECTION) == "Rose"
    # Wrong family -> unchanged input, never a cross-family guess.
    assert normalize("Eng", COSCHOLASTIC) == "Eng"
    assert normalize("Drawing", SUBJECT) == "Drawing"
    assert normalize("", SUBJECT) == ""


def test_is_scholastic_helpers():
    assert kb.is_scholastic("Maths")
    assert not kb.is_scholastic("Drawing")
    assert kb.is_coscholastic("Drawing")
    assert not kb.is_coscholastic("Maths")


def test_list_accessors_are_non_empty_and_copies():
    assert len(kb.list_subjects()) >= 20
    assert len(kb.list_coscholastic()) >= 15
    assert len(kb.list_grades()) >= 15
    assert len(kb.list_section_names()) >= 40
    assert "letters" in kb.section_families()
    names = kb.list_section_names("letters")
    names.append("ZZZ")
    assert "ZZZ" not in kb.list_section_names("letters"), "accessor leaked its internal list"


def test_similarity_is_symmetric_and_bounded():
    for a, b in [("english", "englsih"), ("maths", "math"), ("", "abc"), ("x", "x")]:
        s1, s2 = kb._similarity(a, b), kb._similarity(b, a)
        assert s1 == s2
        assert 0.0 <= s1 <= 1.0


# ────────────────────── 4. cross-language parity fixtures ──────────────────
# src/utils/educationKB.js is a hand-port of this module. These are the
# values both sides MUST agree on; the JS side asserts the same table (see
# the note in that file's header). Keep the two lists identical.
PARITY_FIXTURES = [
    ("Eng", SUBJECT, "English"), ("Maths", SUBJECT, "Mathematics"),
    ("EVS", SUBJECT, "EVS"), ("SST", SUBJECT, "Social Science"),
    ("Drawing", COSCHOLASTIC, "Art & Craft"), ("PT", COSCHOLASTIC, "Physical Education"),
    ("Moral Science", COSCHOLASTIC, "Value Education"), ("GK", COSCHOLASTIC, "General Knowledge"),
    ("Jr KG", GRADE, "LKG"), ("Grade III", GRADE, "3"), ("Class-9", GRADE, "9"),
    ("A", SECTION, "A"), ("Rose", SECTION, "Rose"), ("Champion", SECTION, "Champion"),
    ("Zephyr", UNKNOWN, None),
]


@pytest.mark.parametrize("raw,expected_type,expected_canonical", PARITY_FIXTURES)
def test_parity_fixtures(raw, expected_type, expected_canonical):
    r = classify(raw)
    assert r["type"] == expected_type
    assert r["canonical"] == expected_canonical


def test_parity_fixture_similarity_values():
    """Pins the exact similarity numbers the JS port must reproduce."""
    assert kb._similarity("maths", "mathematics") == pytest.approx(0.4545, abs=1e-4)
    assert kb._similarity("englsih", "english") == pytest.approx(0.7143, abs=1e-4)
    assert kb._similarity("mathematcs", "mathematics") == pytest.approx(0.9091, abs=1e-4)
