"""aap_rules.py is pure logic (no Firestore, no network) — see its module
docstring. A wrong Stage or a missed gender issue is a real report-card
mistake, so this is tested the same way subject_match.py is."""
import pytest

from aap_rules import canonical_grade_section, gender_issue, resolve_stage


@pytest.mark.parametrize("token, expected_stage", [
    ("Pre-Nursery", "Foundation"),
    ("NURSERY", "Foundation"),
    ("LKG", "Foundation"),
    ("UKG", "Foundation"),
    ("I", "Foundation"),
    ("II", "Foundation"),
    ("III", "Preparatory"),
    ("IV", "Preparatory"),
    ("V", "Preparatory"),
    ("VI", "Middle"),
    ("XII", "Middle"),
    # Aliases NOT reachable by the old hardcoded GRADE_TO_STAGE dict this
    # replaces — proving the fix, not just preserving old behavior.
    ("1", "Foundation"),
    ("2nd", "Foundation"),
    ("Grade 3", "Preparatory"),
    ("STD 6", "Middle"),
    ("10th", "Middle"),
])
def test_resolve_stage_matches_expected(token, expected_stage):
    assert resolve_stage(token) == expected_stage


def test_resolve_stage_unrecognised_grade_returns_none():
    # The old GRADE_TO_STAGE.get(grade, "Preparatory") silently guessed
    # "Preparatory" here. That silent guess is exactly what this replaces.
    assert resolve_stage("XYZ-not-a-grade") is None


@pytest.mark.parametrize("grade_a, section_a, grade_b, section_b", [
    ("III", "A", "3", "a"),
    ("1", "CBSE-B", "I", "b"),
    ("Grade 6", "ICSE-A", "VI", "A"),
])
def test_canonical_grade_section_matches_across_spellings(grade_a, section_a, grade_b, section_b):
    assert canonical_grade_section(grade_a, section_a) == canonical_grade_section(grade_b, section_b)


def test_canonical_grade_section_does_not_collapse_different_classes():
    assert canonical_grade_section("III", "A") != canonical_grade_section("III", "B")
    assert canonical_grade_section("III", "A") != canonical_grade_section("IV", "A")


def test_gender_issue_none_when_healthy():
    ratings = {"s1": {}, "s2": {}, "s3": {}}
    students = {"s1": {"gender": "Male"}, "s2": {"gender": "Female"}, "s3": {"gender": "Male"}}
    assert gender_issue(ratings, students) is None


def test_gender_issue_flags_missing_gender():
    ratings = {"s1": {}, "s2": {}, "s3": {}}
    students = {"s1": {"gender": "Male"}, "s2": {"gender": ""}, "s3": {"gender": "Female"}}
    issue = gender_issue(ratings, students)
    assert issue == {"missingCount": 1, "totalCount": 3, "uniformGender": None}


def test_gender_issue_flags_uniform_gender():
    ratings = {"s1": {}, "s2": {}, "s3": {}}
    students = {"s1": {"gender": "Male"}, "s2": {"gender": "Male"}, "s3": {"gender": "Male"}}
    issue = gender_issue(ratings, students)
    assert issue == {"missingCount": 0, "totalCount": 3, "uniformGender": "Male"}


def test_gender_issue_does_not_flag_single_known_student():
    # A regenerate-one-student run, or a genuinely tiny class, shouldn't trip
    # the uniform-gender heuristic off one data point.
    ratings = {"s1": {}}
    students = {"s1": {"gender": "Male"}}
    assert gender_issue(ratings, students) is None


def test_gender_issue_none_when_no_students():
    assert gender_issue({}, {}) is None
