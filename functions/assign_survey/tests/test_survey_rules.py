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


# ═══════════════════════════ v2: matrix + multi-survey ═════════════════════
from survey_rules import (  # noqa: E402
    STATUS_COMPLETED, STATUS_PENDING, STATUS_NOT_ASSIGNED,
    student_status, build_matrix, plan_multi, in_active_window,
)


def st(sid, class_id, inbox=None, **kw):
    return {"id": sid, "name": sid, "classId": class_id, "type": "student",
            FIELD: list(inbox or []), **kw}


# ─────────────────────────────── student status ────────────────────────────
def test_never_assigned_is_not_pending():
    """The distinction the reports exist for: someone never asked must not
    be counted as an outstanding responder."""
    s = st("s1", "I_Diamond", [])
    assert student_status(s, "AAM1-mid", set()) == STATUS_NOT_ASSIGNED
    assert student_status(s, "AAM1-mid", {"s1"}) == STATUS_NOT_ASSIGNED


def test_assigned_without_response_is_pending():
    s = st("s1", "I_Diamond", ["AAM1-mid"])
    assert student_status(s, "AAM1-mid", set()) == STATUS_PENDING
    assert student_status(s, "AAM1-mid", {"other"}) == STATUS_PENDING


def test_assigned_with_response_is_completed():
    s = st("s1", "I_Diamond", ["AAM1-mid"])
    assert student_status(s, "AAM1-mid", {"s1"}) == STATUS_COMPLETED


def test_status_handles_a_missing_or_malformed_inbox():
    assert student_status({"id": "s1"}, "AAM1-mid", set()) == STATUS_NOT_ASSIGNED
    assert student_status({"id": "s1", FIELD: "AAM1-mid"}, "AAM1-mid", set()) == STATUS_NOT_ASSIGNED


# ──────────────────────────────── matrix build ─────────────────────────────
ROSTER_2 = [
    st("s1", "I_Diamond", ["AAM1-mid", "SEW1"]),
    st("s2", "I_Diamond", ["AAM1-mid"]),
    st("s3", "I_Diamond", []),
    st("s4", "II_Ruby", ["AAM1-mid"]),
]
RESP = {"AAM1-mid": {"s1", "s4"}, "SEW1": set()}


def test_matrix_rows_are_per_class_with_counts():
    m = build_matrix(ROSTER_2, ["AAM1-mid", "SEW1"], RESP)
    rows = {r["class_id"]: r for r in m["rows"]}
    assert set(rows) == {"I_Diamond", "II_Ruby"}
    assert rows["I_Diamond"]["student_count"] == 3
    assert rows["I_Diamond"]["cells"]["AAM1-mid"] == {"assigned": 2, "responded": 1, "total": 3}
    assert rows["I_Diamond"]["cells"]["SEW1"] == {"assigned": 1, "responded": 0, "total": 3}
    assert rows["II_Ruby"]["cells"]["AAM1-mid"] == {"assigned": 1, "responded": 1, "total": 1}


def test_matrix_totals_are_the_school_row():
    m = build_matrix(ROSTER_2, ["AAM1-mid", "SEW1"], RESP)
    assert m["totals"]["AAM1-mid"] == {"assigned": 3, "responded": 2, "total": 4}
    assert m["totals"]["SEW1"] == {"assigned": 1, "responded": 0, "total": 4}


def test_responses_from_unassigned_students_are_not_counted():
    """A stray response from someone never assigned must not push a class
    over 100% completion."""
    roster = [st("s1", "I_Diamond", [])]
    m = build_matrix(roster, ["AAM1-mid"], {"AAM1-mid": {"s1"}})
    assert m["rows"][0]["cells"]["AAM1-mid"] == {"assigned": 0, "responded": 0, "total": 1}


def test_matrix_handles_students_with_no_class():
    m = build_matrix([st("s1", None, ["AAM1-mid"])], ["AAM1-mid"], {})
    assert m["rows"][0]["class_id"] == "(no class)"


def test_matrix_is_empty_but_well_shaped_with_no_students():
    m = build_matrix([], ["AAM1-mid"], {})
    assert m["rows"] == []
    assert m["totals"] == {"AAM1-mid": {"assigned": 0, "responded": 0, "total": 0}}


# ────────────────────────────── multi-survey plan ──────────────────────────
def test_plan_multi_sums_writes_across_surveys():
    docs = [("s1", ROSTER_2[0]), ("s2", ROSTER_2[1]), ("s3", ROSTER_2[2])]
    multi = plan_multi(docs, ["AAM1-mid", "SEW1"], "assign")
    # AAM1-mid: only s3 needs it. SEW1: s2 and s3 need it.
    assert len(multi["per_survey"]["AAM1-mid"]["to_write"]) == 1
    assert len(multi["per_survey"]["SEW1"]["to_write"]) == 2
    assert multi["total_writes"] == 3
    assert multi["total_already"] == 3


def test_plan_multi_counts_inactive_once_not_once_per_survey():
    """Three surveys over ten inactive students is ten skips, not thirty —
    otherwise the preview reads as a far bigger problem than it is."""
    docs = [("s1", {"type": "student", "isActive": False}),
            ("s2", {"type": "student", "isActive": False})]
    multi = plan_multi(docs, ["A", "B", "C"], "assign")
    assert multi["inactive"] == 2
    assert multi["total_writes"] == 0


def test_plan_multi_unassign_only_touches_holders():
    docs = [("s1", ROSTER_2[0]), ("s3", ROSTER_2[2])]
    multi = plan_multi(docs, ["AAM1-mid", "SEW1"], "unassign")
    assert multi["per_survey"]["AAM1-mid"]["to_write"] == ["s1"]
    assert multi["per_survey"]["SEW1"]["to_write"] == ["s1"]


def test_plan_multi_with_no_surveys_is_a_clean_no_op():
    multi = plan_multi([("s1", ROSTER_2[0])], [], "assign")
    assert multi["total_writes"] == 0
    assert multi["per_survey"] == {}


# ─────────────────────────────── active window ─────────────────────────────
class _TS:
    """Stand-in for a Firestore timestamp — only comparison is used."""
    def __init__(self, v):
        self.v = v
    def __lt__(self, o):
        return self.v < (o.v if isinstance(o, _TS) else o)
    def __gt__(self, o):
        return self.v > (o.v if isinstance(o, _TS) else o)


def test_active_window_treats_missing_bounds_as_open_ended():
    now = _TS(50)
    assert in_active_window({}, now)
    assert in_active_window({"startAt": _TS(10)}, now)
    assert in_active_window({"expiresAt": _TS(90)}, now)
    assert in_active_window({"startAt": _TS(10), "expiresAt": _TS(90)}, now)


def test_active_window_excludes_future_and_expired():
    now = _TS(50)
    assert not in_active_window({"startAt": _TS(80)}, now)
    assert not in_active_window({"expiresAt": _TS(20)}, now)


# ═════════════════ class key resolution (the "(no class)" bug) ═════════════
from survey_rules import (  # noqa: E402
    resolve_class_key, class_field_report, NO_CLASS,
)


def test_classid_is_used_when_present():
    assert resolve_class_key({"classId": "I_Diamond"}) == ("I_Diamond", "classId")


def test_current_class_id_is_honoured():
    """This repo's OWN import pipeline writes currentClassId, not classId
    (src/composables/useImport.js buildStudentsPlan). Reading only classId
    put every such student into '(no class)'."""
    assert resolve_class_key({"currentClassId": "II_Ruby"}) == ("II_Ruby", "currentClassId")


def test_snake_case_variant_is_honoured():
    assert resolve_class_key({"class_id": "III_Pearl"}) == ("III_Pearl", "class_id")


def test_grade_and_section_compose_into_one_key():
    """Both conventions must land on the SAME group key, or a school using
    separate fields renders as a different set of rows.

    The source field now names BOTH contributing fields ("grade+section")
    rather than just the grade one. class_field_report exists to make a
    future "everything is (no class)" diagnosable from the response alone,
    and naming only half the source defeats that.
    """
    assert resolve_class_key({"grade": "I", "section": "Diamond"}) == ("I_Diamond", "grade+section")
    assert resolve_class_key({"clazz": "II", "sec": "Ruby"}) == ("II_Ruby", "clazz+sec")
    # Grade alone still reports the single field it came from.
    assert resolve_class_key({"grade": "V"}) == ("V", "grade")


def test_grade_without_a_section_still_groups_by_grade():
    """A partially-populated roster is more useful grouped by grade than
    dumped whole into '(no class)'."""
    assert resolve_class_key({"grade": "V"}) == ("V", "grade")


def test_a_direct_class_id_beats_grade_and_section():
    student = {"classId": "I_Diamond", "grade": "II", "section": "Ruby"}
    assert resolve_class_key(student)[0] == "I_Diamond"


def test_no_class_only_when_genuinely_absent():
    assert resolve_class_key({"name": "A"}) == (NO_CLASS, None)
    assert resolve_class_key({"classId": ""}) == (NO_CLASS, None)
    assert resolve_class_key({"classId": "   "}) == (NO_CLASS, None)
    assert resolve_class_key(None) == (NO_CLASS, None)


def test_non_string_class_values_are_coerced_not_dropped():
    assert resolve_class_key({"classId": 7})[0] == "7"


def test_matrix_groups_a_mixed_school_correctly():
    """The regression this whole resolver exists for: three students, three
    different field shapes, one class each — none should be '(no class)'."""
    roster = [
        {"id": "a", "classId": "I_Diamond", FIELD: []},
        {"id": "b", "currentClassId": "I_Diamond", FIELD: []},
        {"id": "c", "grade": "I", "section": "Diamond", FIELD: []},
    ]
    m = build_matrix(roster, ["AAM1-mid"], {})
    assert [r["class_id"] for r in m["rows"]] == ["I_Diamond"]
    assert m["rows"][0]["student_count"] == 3


def test_class_scope_matches_students_of_every_shape():
    """filter_scope is the WRITE path — if it reads only classId, assigning
    by class silently writes to zero students for affected schools."""
    docs = [
        ("a", {"type": "student", "classId": "I_Diamond"}),
        ("b", {"type": "student", "currentClassId": "I_Diamond"}),
        ("c", {"type": "student", "grade": "I", "section": "Diamond"}),
        ("d", {"type": "student", "classId": "II_Ruby"}),
    ]
    out = filter_scope(docs, {"type": "classes", "classIds": ["I_Diamond"]}, "students")
    assert [i for i, _ in out] == ["a", "b", "c"]


def test_class_field_report_names_the_field_actually_used():
    report = class_field_report([
        {"classId": "I_A"}, {"classId": "I_B"}, {"currentClassId": "II_A"}, {"name": "orphan"},
    ])
    assert report["sources"] == {"classId": 2, "currentClassId": 1, NO_CLASS: 1}
    assert report["unresolved_sample_fields"] == [["name"]]
