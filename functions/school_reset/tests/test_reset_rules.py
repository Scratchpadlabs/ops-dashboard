#!/usr/bin/env python3
"""
Contract tests for reset_rules.py.

A reset is an IN-PLACE mutation of live school data with no year dimension to
fall back on, so these cover the ways it could quietly destroy or misfile a
roster:
  - promoting into a notation the school doesn't use (creating a shadow set
    of classes alongside the real ones)
  - promoting the top grade into a class that cannot exist
  - guessing at a grade it doesn't recognize instead of reporting it
  - a preview whose counts overstate or understate what will happen
  - accepting an archive that dropped rows

Run with: .venv_test/bin/python -m pytest tests/ -v
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest

from reset_rules import (
    build_reset_diff, verify_archive, slugify_school_id, validate_school_id,
    find_similar_schools,
)

# Grade progression, class parsing and the promotion plan itself moved to
# functions/shared (class_resolver.py, promotion.py) and are tested there
# against a much wider fixture set — see functions/shared/tests/. What remains
# here is what this module still decides: the itemized reset diff.


def st(sid, class_id, **kw):
    return {"id": sid, "name": sid.upper(), "classId": class_id, **kw}


def test_diff_counts_only_students_that_would_actually_change():
    """A preview that overstates its effect trains people to ignore it: a
    student with an empty inbox is not counted under 'inbox cleared'."""
    roster = [
        st("s1", "I_A", surveyInbox=["AAM1-mid"], reports=["r1"]),
        st("s2", "I_A", surveyInbox=[], reports=[]),
        st("s3", "I_A"),
    ]
    diff = build_reset_diff(roster, {"clear_inbox": True, "clear_reports": True}, ["I_A", "II_A"])
    assert diff["inbox_cleared_count"] == 1
    assert diff["reports_detached_count"] == 1
    assert diff["total_students"] == 3


def test_diff_reports_zero_for_options_not_selected():
    """Nothing is implied — an unchecked option contributes nothing."""
    roster = [st("s1", "I_A", surveyInbox=["x"], reports=["r"])]
    diff = build_reset_diff(roster, {}, ["I_A"])
    assert diff["promoted_count"] == 0
    assert diff["inbox_cleared_count"] == 0
    assert diff["reports_detached_count"] == 0
    assert diff["removed_count"] == 0
    assert diff["write_estimate"] == 0
    # The plan is now always built — every student appears in it exactly once,
    # even when no option is selected — so the buckets can be shown alongside
    # the counts and can never disagree with them.
    assert len(diff["plan"]) == len(roster)


def test_diff_separates_graduating_from_promoted():
    """The task is explicit: the highest grade is marked inactive, not
    promoted, and its count is shown SEPARATELY."""
    roster = [st("s1", "XI_A"), st("s2", "XII_A"), st("s3", "XII_A")]
    diff = build_reset_diff(roster, {"promote": True}, ["XI_A", "XII_A"])
    assert diff["promoted_count"] == 1
    assert diff["graduating_count"] == 2


def test_diff_counts_removals_only_for_students_that_exist():
    roster = [st("s1", "I_A"), st("s2", "I_A")]
    diff = build_reset_diff(roster, {"remove_ids": ["s2", "ghost"]}, ["I_A"])
    assert diff["removed_count"] == 1


def test_diff_names_what_is_kept():
    diff = build_reset_diff([], {}, [])
    for kept in ("subjects", "teachers/staff", "school details"):
        assert kept in diff["kept"]


def test_diff_says_the_ops_crm_checklists_are_untouched():
    """The Operations and Data-Receivable checklists live in the ops CRM tree,
    keyed by a DIFFERENT id space than the root school this resets. The reset
    cannot touch them, so the confirm screen must say so rather than leave it
    to be assumed either way."""
    diff = build_reset_diff([], {}, [])
    assert any("ops CRM" in k for k in diff["kept"])


def test_diff_never_echoes_an_option_it_cannot_perform():
    """Guards the bug this test was written for: the wizard once offered
    'reset the operations checklist' and reset_execute had no code for it, so
    the preview reported an effect that never happened. A flag must not appear
    in the diff just because the caller sent it."""
    diff = build_reset_diff([], {"reset_operations": True,
                                  "reset_receivables": True,
                                  "some_future_option": True}, [])
    for ghost in ("reset_operations", "reset_receivables", "some_future_option"):
        assert ghost not in diff
    assert diff["write_estimate"] == 0


def test_write_estimate_is_the_sum_of_the_itemized_counts():
    roster = [st("s1", "I_A", surveyInbox=["x"]), st("s2", "XII_A", reports=["r"])]
    diff = build_reset_diff(roster, {
        "promote": True, "clear_inbox": True, "clear_reports": True,
    }, ["I_A", "II_A", "XII_A"])
    assert diff["write_estimate"] == (
        diff["promoted_count"] + diff["graduating_count"]
        + diff["inbox_cleared_count"] + diff["reports_detached_count"]
        + diff["removed_count"])


# ─────────────────────────────── archive verify ────────────────────────────
def test_archive_verifies_when_counts_match():
    ok, mismatches = verify_archive({"students": 342, "classes": 14}, {"students": 342, "classes": 14})
    assert ok and mismatches == []


def test_archive_fails_loudly_when_rows_were_dropped():
    """An archive that silently lost rows is worse than no archive — it reads
    as safety that isn't there."""
    ok, mismatches = verify_archive({"students": 342}, {"students": 341})
    assert not ok
    assert mismatches == [{"collection": "students", "expected": 342, "archived": 341}]


def test_archive_fails_when_a_collection_is_missing_entirely():
    ok, mismatches = verify_archive({"students": 10, "classes": 2}, {"students": 10})
    assert not ok
    assert mismatches[0]["collection"] == "classes"
    assert mismatches[0]["archived"] is None


# ─────────────────────────── school id + duplicates ────────────────────────
def test_slug_suggestion():
    assert slugify_school_id("Samartha International School") == "Samartha_International_School"
    assert slugify_school_id("  A N T School  ") == "A_N_T_School"
    assert slugify_school_id("St. Mary's!!") == "St_Marys"


@pytest.mark.parametrize("bad", ["", "  ", "has space", "has/slash", "has.dot", "_leading", "a"*65])
def test_invalid_school_ids_are_rejected(bad):
    assert validate_school_id(bad)[0] is False


@pytest.mark.parametrize("good", ["TEST_SCHOOL", "samarthaschool", "school-01", "A1"])
def test_valid_school_ids_are_accepted(good):
    ok, err = validate_school_id(good)
    assert ok, err


def test_near_duplicate_names_are_surfaced():
    """The collection already holds 'Samartha International School' next to
    'samarthaschool'. Id uniqueness alone allowed every one of those."""
    existing = [
        {"id": "Samartha International School", "name": "Samartha International School"},
        {"id": "samarthaschool", "name": "Samartha School"},
        {"id": "TEST_SCHOOL", "name": "TEST_SCHOOL"},
    ]
    hits = find_similar_schools("Samartha Intl School", existing)
    assert any("Samartha" in h["name"] for h in hits)


def test_unrelated_names_do_not_warn():
    existing = [{"id": "abc", "name": "Greenwood High"}]
    assert find_similar_schools("Riverdale Academy", existing) == []


def test_similarity_catches_a_substring_rename():
    existing = [{"id": "samarthaschool", "name": "Samartha School"}]
    hits = find_similar_schools("Samartha School Charholi", existing)
    assert hits and hits[0]["id"] == "samarthaschool"
