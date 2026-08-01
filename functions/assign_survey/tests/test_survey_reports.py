#!/usr/bin/env python3
"""
Contract tests for survey_reports.py — the downloadable completion reports.

What matters here is that the numbers in a downloaded file are defensible:
"not assigned" never gets counted as "pending", completion % is measured
against who was actually assigned, and a filtered export says so in its
header instead of looking like a full one.

Run with: .venv_test/bin/python -m pytest tests/ -v
"""
import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from survey_rules import DEFAULT_INBOX_FIELD
from survey_reports import (
    class_wise_rows, survey_wise_rows, cumulative_rows, rows_to_csv, report_header,
)

FIELD = DEFAULT_INBOX_FIELD
LABELS = {"AAM1-mid": "AAM1 Mid", "SEW1": "SEW 1"}
IDS = ["AAM1-mid", "SEW1"]


def st(sid, class_id, inbox=None, roll=None, name=None):
    return {"id": sid, "name": name or sid.upper(), "classId": class_id,
            "rollNo": roll or "", FIELD: list(inbox or [])}


ROSTER = [
    st("s1", "I_Diamond", ["AAM1-mid", "SEW1"], roll="1"),
    st("s2", "I_Diamond", ["AAM1-mid"], roll="2"),
    st("s3", "I_Diamond", [], roll="3"),
    st("s4", "II_Ruby", ["AAM1-mid"], roll="1"),
]
RESP = {"AAM1-mid": {"s1", "s4"}, "SEW1": set()}


# ────────────────────────────────── class-wise ─────────────────────────────
def test_class_wise_has_one_row_per_student_with_a_column_per_survey():
    rows = class_wise_rows(ROSTER, IDS, LABELS, RESP)
    assert len(rows) == 4
    assert set(rows[0]) == {"Student", "Roll No", "Class", "AAM1 Mid", "SEW 1"}


def test_class_wise_statuses_are_the_three_distinct_values():
    rows = {r["Student"]: r for r in class_wise_rows(ROSTER, IDS, LABELS, RESP)}
    assert rows["S1"]["AAM1 Mid"] == "completed"
    assert rows["S1"]["SEW 1"] == "pending"
    assert rows["S2"]["AAM1 Mid"] == "pending"
    assert rows["S3"]["AAM1 Mid"] == "not assigned"
    assert rows["S3"]["SEW 1"] == "not assigned"


def test_class_wise_is_sorted_by_class_then_roll():
    rows = class_wise_rows(ROSTER, IDS, LABELS, RESP)
    assert [r["Class"] for r in rows] == ["I_Diamond"] * 3 + ["II_Ruby"]
    assert [r["Roll No"] for r in rows[:3]] == ["1", "2", "3"]


def test_roman_classes_sort_in_school_order_not_string_order():
    """'II_Ruby' sorts BEFORE 'I_Diamond' as a plain string, because '_'
    (0x5F) is greater than 'I'. Reports must read in grade order instead."""
    roster = [st("a", "III_Pearl"), st("b", "I_Diamond"),
              st("c", "II_Ruby"), st("d", "LKG_Rose")]
    rows = class_wise_rows(roster, IDS, LABELS, {})
    assert [r["Class"] for r in rows] == ["LKG_Rose", "I_Diamond", "II_Ruby", "III_Pearl"]


def test_numeric_classes_sort_numerically_not_lexically():
    """'10_A' sorts before '2_A' as a string."""
    roster = [st("a", "10_A"), st("b", "2_A"), st("c", "1_A")]
    rows = class_wise_rows(roster, IDS, LABELS, {})
    assert [r["Class"] for r in rows] == ["1_A", "2_A", "10_A"]


def test_same_grade_in_two_notations_ties_and_breaks_on_section():
    """'II_Ruby' and '2_A' ARE the same grade, so grade order can't separate
    them — they fall back to section name. A school uses one notation or the
    other, so this only matters for mixed/dirty data; it just has to be
    deterministic rather than correct-by-convention."""
    roster = [st("a", "II_Ruby"), st("b", "2_A")]
    rows = class_wise_rows(roster, IDS, LABELS, {})
    assert [r["Class"] for r in rows] == ["2_A", "II_Ruby"]


def test_roll_numbers_sort_numerically_not_lexically():
    roster = [st("a", "I_A", roll="10"), st("b", "I_A", roll="2"), st("c", "I_A", roll="1")]
    rows = class_wise_rows(roster, IDS, LABELS, {})
    assert [r["Roll No"] for r in rows] == ["1", "2", "10"]


# ───────────────────────────────── survey-wise ─────────────────────────────
def test_survey_wise_detail_covers_every_student():
    detail, _ = survey_wise_rows(ROSTER, "AAM1-mid", "AAM1 Mid", RESP)
    assert len(detail) == 4
    assert {r["Status"] for r in detail} == {"completed", "pending", "not assigned"}


def test_survey_wise_summary_has_per_class_rows_and_a_school_total():
    _, summary = survey_wise_rows(ROSTER, "AAM1-mid", "AAM1 Mid", RESP)
    by_class = {r["Class"]: r for r in summary}
    assert set(by_class) == {"I_Diamond", "II_Ruby", "SCHOOL TOTAL"}

    d = by_class["I_Diamond"]
    assert (d["Students"], d["Assigned"], d["Completed"], d["Pending"], d["Not Assigned"]) == (3, 2, 1, 1, 1)
    assert d["Completion %"] == 50.0

    t = by_class["SCHOOL TOTAL"]
    assert (t["Students"], t["Assigned"], t["Completed"], t["Pending"]) == (4, 3, 2, 1)
    assert t["Completion %"] == 66.7


def test_completion_is_measured_against_assigned_not_roll_strength():
    """A class never assigned the survey is 0/0 — it must not read as 0% of
    its whole roster, which would look like a failure rather than a no-op."""
    roster = [st("s1", "III_Pearl", []), st("s2", "III_Pearl", [])]
    _, summary = survey_wise_rows(roster, "AAM1-mid", "AAM1 Mid", {})
    row = {r["Class"]: r for r in summary}["III_Pearl"]
    assert row["Assigned"] == 0
    assert row["Not Assigned"] == 2
    assert row["Completion %"] == 0.0
    assert row["Pending"] == 0   # nobody is outstanding — nobody was asked


# ────────────────────────────────── cumulative ─────────────────────────────
def test_cumulative_has_a_row_per_class_survey_pair_plus_totals():
    rows = cumulative_rows(ROSTER, IDS, LABELS, RESP)
    pairs = [(r["Class"], r["Survey"]) for r in rows]
    assert ("I_Diamond", "AAM1 Mid") in pairs
    assert ("II_Ruby", "SEW 1") in pairs
    totals = [r for r in rows if r["Class"] == "SCHOOL TOTAL"]
    assert len(totals) == len(IDS)


def test_cumulative_totals_match_the_detail_rows():
    rows = cumulative_rows(ROSTER, IDS, LABELS, RESP)
    for sid in IDS:
        label = LABELS[sid]
        detail = [r for r in rows if r["Survey"] == label and r["Class"] != "SCHOOL TOTAL"]
        total = next(r for r in rows if r["Survey"] == label and r["Class"] == "SCHOOL TOTAL")
        for key in ("Students", "Assigned", "Completed", "Pending"):
            assert total[key] == sum(r[key] for r in detail), f"{label} {key}"


def test_cumulative_counts_never_exceed_the_class_size():
    rows = cumulative_rows(ROSTER, IDS, LABELS, RESP)
    for r in rows:
        assert r["Assigned"] <= r["Students"]
        assert r["Completed"] <= r["Assigned"]
        assert r["Assigned"] == r["Completed"] + r["Pending"]
        assert r["Students"] == r["Assigned"] + r["Not Assigned"]


# ─────────────────────────────── header + csv ──────────────────────────────
def test_header_states_scope_filters_and_timestamp():
    h = report_header("class_wise", "TEST_SCHOOL", ["AAM1 Mid"],
                       {"classes": "I_Diamond", "status": "pending", "search": None},
                       generated_at=datetime(2026, 8, 1, 9, 30, tzinfo=timezone.utc))
    assert "School: TEST_SCHOOL" in h
    assert "Scope: class_wise" in h
    assert "2026-08-01 09:30 UTC" in h
    assert "classes=I_Diamond" in h
    assert "status=pending" in h
    assert "search" not in h          # empty filters are omitted, not printed as blank


def test_header_says_none_when_nothing_is_filtered():
    h = report_header("cumulative", "S", [], {"status": "all", "classes": None})
    assert "Filters: none" in h


def test_csv_round_trips_rows_with_a_header_comment():
    csv_text = rows_to_csv(class_wise_rows(ROSTER, IDS, LABELS, RESP), "HEADER LINE")
    lines = csv_text.strip().splitlines()
    assert lines[0] == "# HEADER LINE"
    assert lines[1].startswith("Student,Roll No,Class")
    assert len(lines) == 2 + len(ROSTER)


def test_csv_with_extra_blocks_stacks_them_after_a_blank_line():
    detail, summary = survey_wise_rows(ROSTER, "AAM1-mid", "AAM1 Mid", RESP)
    csv_text = rows_to_csv(detail, "H", [("Per-class summary", summary)])
    assert "# Per-class summary" in csv_text
    assert "SCHOOL TOTAL" in csv_text


def test_csv_says_so_when_nothing_matched_instead_of_emitting_an_empty_file():
    csv_text = rows_to_csv([], "H")
    assert "no rows matched" in csv_text
