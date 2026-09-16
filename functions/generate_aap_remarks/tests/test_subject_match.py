"""Subject matching against the REAL framework.csv labels — the 15 group
labels seeded into aap_framework for clarified-1501 are used verbatim, so a
regression here is a regression against live data."""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from subject_match import (  # noqa: E402
    build_subject_index, normalize_subject, opening_signature, resolve_subject,
    singular, subject_aliases,
)

# Exactly what tools/migrate_aap_framework.py wrote, per stage.
FOUNDATION = [
    "Math / Arithmetic",
    "EVS / GK / Knowledge Time/Science/SocialScience /",
    "Rhymes / English /Phonic / Phonics",
    "Hindi / Telugu / Kannada / Urdu /Sanskrit/Marathi",
    "Drawing / Arts and Crafts",
]
PREPARATORY = [
    "L1 (Marathi / Telugu / Kannada / Hindi / Sindhi)",
    "L2 (English / French / Sanskrit / Urdu)",
    "Maths",
    "World Around Us (Science / EVS / Social Studies / Science / SST)",
]
MIDDLE = [
    "L1 (Marathi / Telugu / Kannada / Hindi / Sindhi)",
    "L2 (English)",
    "L3 (French / Sanskrit / Urdu)",
    "Maths",
    "Science (EVS)",
    "Social Science (SST)",
]


def index_for(labels):
    return build_subject_index([{"subject": label} for label in sorted(labels)])


# ----------------------------------------------------------- normalisation ---

def test_normalize_collapses_case_and_punctuation():
    assert normalize_subject("Social Science") == "socialscience"
    assert normalize_subject("SocialScience") == "socialscience"
    assert normalize_subject("social-science") == "socialscience"
    assert normalize_subject("  L1  ") == "l1"
    assert normalize_subject(None) == ""


def test_singular_leaves_short_keys_alone():
    assert singular("maths") == "math"
    assert singular("sst") == "sst"
    assert singular("evs") == "evs"


# ------------------------------------------------------------------ aliases ---

def test_parenthesised_alternatives_are_unwrapped():
    aliases = subject_aliases("World Around Us (Science / EVS / Social Studies / Science / SST)")
    assert "World Around Us" in aliases
    assert "Science" in aliases
    assert "EVS" in aliases
    assert "SST" in aliases
    # The full label survives, so an exact match on it still works.
    assert aliases[0].startswith("World Around Us (")


def test_slash_separated_label_splits():
    assert subject_aliases("Math / Arithmetic") == ["Math / Arithmetic", "Math", "Arithmetic"]


def test_and_is_not_a_separator():
    # "Arts and Crafts" is ONE subject; splitting it would invent aliases.
    assert "Arts and Crafts" in subject_aliases("Drawing / Arts and Crafts")
    assert "Arts" not in subject_aliases("Drawing / Arts and Crafts")


def test_trailing_empty_alternative_is_dropped():
    aliases = subject_aliases("EVS / GK / Knowledge Time/Science/SocialScience /")
    assert "" not in aliases
    assert "SocialScience" in aliases


# ------------------------------------------------------------------ lookups ---

@pytest.mark.parametrize("token, expected", [
    ("Maths", "Maths"),                                   # the one that already worked
    ("Math", "Maths"),                                    # plural relaxation
    ("EVS", "World Around Us (Science / EVS / Social Studies / Science / SST)"),
    ("SST", "World Around Us (Science / EVS / Social Studies / Science / SST)"),
    ("Science", "World Around Us (Science / EVS / Social Studies / Science / SST)"),
    ("English", "L2 (English / French / Sanskrit / Urdu)"),
    ("Hindi", "L1 (Marathi / Telugu / Kannada / Hindi / Sindhi)"),
    ("Marathi", "L1 (Marathi / Telugu / Kannada / Hindi / Sindhi)"),
])
def test_preparatory_tokens_resolve(token, expected):
    by_label, alias_index, _ = index_for(PREPARATORY)
    row, how = resolve_subject(token, by_label, alias_index)
    assert row is not None, f"{token} did not resolve"
    assert row["subject"] == expected
    assert how in {"exact", "alias", "plural"}


def test_the_regression_this_module_exists_for():
    """Before alias expansion, "Maths" was the ONLY reachable Preparatory row —
    the other three took every III-V subject down with them."""
    by_label, alias_index, _ = index_for(PREPARATORY)
    resolved = [t for t in ("Maths", "English", "EVS", "Hindi")
                if resolve_subject(t, by_label, alias_index)[0] is not None]
    assert resolved == ["Maths", "English", "EVS", "Hindi"]


@pytest.mark.parametrize("token, expected", [
    ("Maths", "Maths"),
    ("EVS", "Science (EVS)"),
    ("Science", "Science (EVS)"),
    ("SST", "Social Science (SST)"),
    ("English", "L2 (English)"),
    ("French", "L3 (French / Sanskrit / Urdu)"),
])
def test_middle_tokens_resolve(token, expected):
    by_label, alias_index, _ = index_for(MIDDLE)
    row, _ = resolve_subject(token, by_label, alias_index)
    assert row is not None and row["subject"] == expected


def test_foundation_science_lands_on_the_evs_row():
    by_label, alias_index, _ = index_for(FOUNDATION)
    row, _ = resolve_subject("Science", by_label, alias_index)
    assert row["subject"].startswith("EVS / GK")


def test_unknown_token_is_reported_not_guessed():
    by_label, alias_index, _ = index_for(PREPARATORY)
    assert resolve_subject("Robotics", by_label, alias_index) == (None, None)
    assert resolve_subject("", by_label, alias_index) == (None, None)


def test_confirmed_mapping_wins_over_every_other_rung():
    by_label, alias_index, _ = index_for(PREPARATORY)
    overrides = {normalize_subject("Maths"): "World Around Us (Science / EVS / Social Studies / Science / SST)"}
    row, how = resolve_subject("Maths", by_label, alias_index, overrides)
    assert how == "map"
    assert row["subject"].startswith("World Around Us")


def test_override_pointing_at_a_deleted_row_falls_through():
    by_label, alias_index, _ = index_for(PREPARATORY)
    row, how = resolve_subject("Maths", by_label, alias_index, {"maths": "Deleted Row"})
    assert how == "exact" and row["subject"] == "Maths"


def test_conflicting_alias_is_reported_and_first_row_keeps_it():
    rows = [{"subject": "Science (EVS)"}, {"subject": "World Around Us (Science)"}]
    by_label, alias_index, conflicts = build_subject_index(rows)
    assert alias_index[normalize_subject("Science")] == "Science (EVS)"
    assert any(c["alias"] == "Science" for c in conflicts)
    assert resolve_subject("Science", by_label, alias_index)[0]["subject"] == "Science (EVS)"


def test_real_stages_have_no_alias_conflicts():
    """If this ever fails, two rubric rows in one stage claim the same
    spelling and a human has to say which — the resolution must not be
    whichever doc id happens to sort first."""
    for labels in (FOUNDATION, PREPARATORY, MIDDLE):
        assert index_for(labels)[2] == []


# --------------------------------------------------------------- variation ---

def test_opening_signature_ignores_the_name():
    assert opening_signature("Aarav shows such kindness when working", "Aarav") == "shows such kindness"
    assert opening_signature("Mohit shows such kindness when working", "Mohit") == "shows such kindness"


def test_opening_signature_survives_punctuation_and_short_comments():
    assert opening_signature("Mahira, who shows creativity!", "Mahira") == "who shows creativity"
    assert opening_signature("", "Mahira") == ""
