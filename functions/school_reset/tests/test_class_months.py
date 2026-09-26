#!/usr/bin/env python3
"""
Contract tests for class_months.py — the row rules behind the class_months
callable, which writes the per-class attendance months the teacher app reads
(schools/{id}/classes/{classId}/months).

Run with: .venv_test/bin/python -m pytest tests/ -v
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from class_months import plan_save, plan_delete, sort_months, month_payload

APRIL = {"classId": "c1", "key": "2026-04", "label": "April 2026", "month": 4,
         "year": 2026, "order": 1, "workingDays": 22}


def test_valid_row_is_written_with_schema_fields_only():
    writes, errors = plan_save([{**APRIL, "stray": "x"}], ["c1"])
    assert errors == []
    assert writes == [("c1", "2026-04", {"key": "2026-04", "label": "April 2026", "month": 4,
                                          "year": 2026, "order": 1, "workingDays": 22})]


def test_unknown_class_is_rejected():
    writes, errors = plan_save([APRIL], ["c2"])
    assert writes == []
    assert "does not exist" in errors[0]["reason"]


def test_schema_violations_are_rejected():
    _, errors = plan_save([{**APRIL, "workingDays": 40}], ["c1"])
    assert "workingDays" in errors[0]["reason"]
    _, errors = plan_save([{**APRIL, "month": 5}], ["c1"])
    assert "does not match key" in errors[0]["reason"]
    _, errors = plan_save([{**APRIL, "key": "April"}], ["c1"])
    assert errors


def test_duplicate_class_month_in_one_save_is_rejected():
    _, errors = plan_save([APRIL, {**APRIL, "workingDays": 20}], ["c1"])
    assert "duplicate" in errors[0]["reason"]


def test_same_month_for_two_classes_is_fine():
    writes, errors = plan_save([APRIL, {**APRIL, "classId": "c2", "workingDays": 20}], ["c1", "c2"])
    assert errors == []
    assert [(c, w["workingDays"]) for c, _, w in writes] == [("c1", 22), ("c2", 20)]


def test_whole_number_floats_become_ints():
    assert month_payload({**APRIL, "workingDays": 22.0})["workingDays"] == 22


def test_non_list_rows():
    writes, errors = plan_save("nope", ["c1"])
    assert writes == [] and errors


def test_plan_delete_drops_malformed_and_duplicates():
    assert plan_delete([{"classId": "c1", "key": "2026-04"}, {"classId": "c1", "key": "2026-04"},
                        {"classId": "", "key": "2026-05"}, {"classId": "a/b", "key": "2026-05"}, "x"]) \
        == [("c1", "2026-04")]


def test_sort_months_by_order_then_key():
    rows = [{"key": "2026-06", "order": 3}, {"key": "2026-04"}, {"key": "2026-05", "order": 2}]
    assert [m["key"] for m in sort_months(rows)] == ["2026-04", "2026-05", "2026-06"]
