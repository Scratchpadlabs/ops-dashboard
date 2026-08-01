#!/usr/bin/env python3
"""
Contract tests for survey_rules.py — the decision logic behind assignment.

These cover the three ways this feature could do real damage:
  - assigning a junk/test survey doc into thousands of inboxes
  - silently skipping (or silently including) an entire roster via the
    active/inactive check
  - writing the wrong set of documents, or making preview disagree with apply

Run with: .venv_test/bin/python -m pytest tests/ -v
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest

from survey_rules import (
    DEFAULT_INBOX_FIELD, is_inactive, is_real_survey, plan_targets, filter_scope,
)

FIELD = DEFAULT_INBOX_FIELD


def student(doc_id, **kw):
    return (doc_id, {"name": doc_id, "type": "student", **kw})


# ────────────────────────────── junk survey filter ─────────────────────────
def test_real_survey_accepted():
    assert is_real_survey({"name": {"en": "AAM1 Prep", "mr": "..."}, "questions": [{"q": 1}]})
    # One non-empty translation is enough — mr-only surveys are real.
    assert is_real_survey({"name": {"en": "", "mr": "प्रश्नावली"}, "questions": [{"q": 1}]})


@pytest.mark.parametrize("doc", [
    {},
    None,
    {"name": {}, "questions": [{"q": 1}]},                    # no translations
    {"name": {"en": "   "}, "questions": [{"q": 1}]},         # blank translation
    {"name": {"en": "Test"}, "questions": []},                # no questions
    {"name": {"en": "Test"}},                                  # questions missing
    {"name": "Test", "questions": [{"q": 1}]},                # name not a map
    {"name": {"en": "Test"}, "questions": "many"},            # questions not a list
])
def test_junk_survey_rejected(doc):
    assert not is_real_survey(doc)


def test_the_known_junk_docs_are_rejected_structurally():
    """The real junk in this collection is 'zzzzzzzzzzzzzzzzzy1'..'y17'.
    The filter is structural, not an id blocklist — it must reject them on
    shape alone, so it keeps working when junk arrives under a new id."""
    for n in range(1, 18):
        junk = {"id": f"zzzzzzzzzzzzzzzzzy{n}"}
        assert not is_real_survey(junk)


# ───────────────────────────── active / inactive ───────────────────────────
def test_records_are_active_unless_they_say_otherwise():
    """The critical default: a roster with no isActive field at all must NOT
    be treated as entirely inactive, or every assignment silently no-ops."""
    assert not is_inactive({})
    assert not is_inactive({"name": "A"})
    assert not is_inactive({"isActive": True})
    assert not is_inactive(None)


@pytest.mark.parametrize("doc", [
    {"isActive": False},
    {"enrollmentStatus": "left"},
    {"enrollmentStatus": "TC Issued"},
    {"status": "inactive"},
    {"enrollmentStatus": "Alumni"},
    {"status": "  Dropped  "},
])
def test_explicitly_inactive_records_are_skipped(doc):
    assert is_inactive(doc)


def test_unknown_status_values_stay_active():
    """An unrecognized status must not silently exclude a student."""
    assert not is_inactive({"enrollmentStatus": "promoted"})
    assert not is_inactive({"status": "active"})


# ──────────────────────────────── scope filter ─────────────────────────────
ROSTER = [
    student("s1", classId="I_Diamond"),
    student("s2", classId="I_Diamond"),
    student("s3", classId="II_Ruby"),
    ("t1", {"name": "A Teacher", "type": "teacher"}),
]


def test_school_scope_takes_every_student_but_not_staff_docs():
    out = filter_scope(ROSTER, {"type": "school"}, "students")
    assert [i for i, _ in out] == ["s1", "s2", "s3"]


def test_class_scope():
    out = filter_scope(ROSTER, {"type": "classes", "classIds": ["I_Diamond"]}, "students")
    assert [i for i, _ in out] == ["s1", "s2"]


def test_class_scope_with_no_classes_selected_matches_nothing():
    """Must not silently widen to the whole school."""
    assert filter_scope(ROSTER, {"type": "classes", "classIds": []}, "students") == []


def test_id_scope():
    out = filter_scope(ROSTER, {"type": "ids", "ids": ["s2", "s3", "missing"]}, "students")
    assert [i for i, _ in out] == ["s2", "s3"]


def test_students_without_a_type_field_are_still_students():
    roster = [("s9", {"name": "No type"})]
    assert len(filter_scope(roster, {"type": "school"}, "students")) == 1


def test_staff_audience_keeps_staff_docs():
    staff = [("t1", {"name": "T", "type": "teacher"}), ("t2", {"name": "U"})]
    assert len(filter_scope(staff, {"type": "school"}, "staff")) == 2


def test_unknown_scope_type_raises_rather_than_defaulting_to_the_whole_school():
    with pytest.raises(ValueError):
        filter_scope(ROSTER, {"type": "everyone"}, "students")


# ─────────────────────────────── target planning ───────────────────────────
def test_assign_skips_those_who_already_have_it():
    docs = [
        student("s1", **{FIELD: ["AAM1-mid"]}),
        student("s2", **{FIELD: ["SEW1"]}),
        student("s3"),
    ]
    plan = plan_targets(docs, "AAM1-mid", "assign")
    assert plan["to_write"] == ["s2", "s3"]
    assert plan["already"] == 1
    assert plan["inactive"] == 0


def test_unassign_only_touches_those_who_have_it():
    """The task is explicit: removal must never touch students without it."""
    docs = [
        student("s1", **{FIELD: ["AAM1-mid", "SEW1"]}),
        student("s2", **{FIELD: ["SEW1"]}),
        student("s3"),
    ]
    plan = plan_targets(docs, "AAM1-mid", "unassign")
    assert plan["to_write"] == ["s1"]
    assert plan["already"] == 2


def test_inactive_students_are_skipped_and_counted_separately():
    docs = [
        student("s1"),
        student("s2", isActive=False),
        student("s3", enrollmentStatus="left"),
    ]
    plan = plan_targets(docs, "AAM1-mid", "assign")
    assert plan["to_write"] == ["s1"]
    assert plan["inactive"] == 2
    assert plan["already"] == 0


def test_inactive_students_are_skipped_for_unassign_too():
    """An inactive student keeps whatever they have — this operation is not
    a cleanup pass, and touching them would be a surprise."""
    docs = [student("s1", isActive=False, **{FIELD: ["AAM1-mid"]})]
    plan = plan_targets(docs, "AAM1-mid", "unassign")
    assert plan["to_write"] == []
    assert plan["inactive"] == 1


def test_existing_field_count_surfaces_a_wrong_inbox_field_assumption():
    """The staff-inbox field name is an assumption. This count is what makes
    a wrong guess visible in the preview instead of after 300 writes."""
    docs = [("t1", {"name": "A"}), ("t2", {"name": "B"})]
    plan = plan_targets(docs, "TEACHERAAM", "assign", inbox_field="surveyInbox")
    assert plan["existing_field"] == 0
    assert plan["to_write"] == ["t1", "t2"]

    docs = [("t1", {"name": "A", "surveyInbox": []})]
    assert plan_targets(docs, "TEACHERAAM", "assign")["existing_field"] == 1


def test_a_non_list_inbox_is_treated_as_absent_not_as_a_crash():
    docs = [student("s1", **{FIELD: "AAM1-mid"}), student("s2", **{FIELD: None})]
    plan = plan_targets(docs, "AAM1-mid", "assign")
    assert plan["to_write"] == ["s1", "s2"]
    assert plan["existing_field"] == 0


def test_assign_is_idempotent_across_repeated_runs():
    """Re-running an assignment must plan zero writes the second time —
    this is what makes arrayUnion + re-assignment safe."""
    docs = [student("s1"), student("s2")]
    first = plan_targets(docs, "AAM1-mid", "assign")
    assert len(first["to_write"]) == 2

    # Simulate the writes having happened.
    after = [student(i, **{FIELD: ["AAM1-mid"]}) for i in first["to_write"]]
    second = plan_targets(after, "AAM1-mid", "assign")
    assert second["to_write"] == []
    assert second["already"] == 2


def test_counts_always_partition_the_candidate_set():
    """to_write + already + inactive must equal the number of candidates —
    the preview's arithmetic has to add up or the numbers shown are a lie."""
    docs = [
        student("s1"), student("s2", **{FIELD: ["AAM1-mid"]}),
        student("s3", isActive=False), student("s4", **{FIELD: []}),
        student("s5", enrollmentStatus="alumni"),
    ]
    for mode in ("assign", "unassign"):
        plan = plan_targets(docs, "AAM1-mid", mode)
        assert len(plan["to_write"]) + plan["already"] + plan["inactive"] == len(docs)


def test_empty_candidate_set_is_a_clean_no_op():
    plan = plan_targets([], "AAM1-mid", "assign")
    assert plan == {"to_write": [], "already": 0, "inactive": 0, "existing_field": 0}
