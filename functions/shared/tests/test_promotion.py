"""Promotion engine.

Every student lands in exactly one bucket with a reason, and a plan holding
any blocked student cannot proceed — that is the guard against the failure
that prompted this task: a reset that cleared survey inboxes while promoting
nobody.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))

from shared.class_resolver import build_school_context  # noqa: E402
from shared.promotion import (  # noqa: E402
    ACTION_PROMOTE, ACTION_GRADUATE, ACTION_UNCHANGED, ACTION_BLOCKED,
    GRADUATED, build_promotion_plan, summarize, plan_to_csv, plan_fingerprint,
)


def st(sid, class_id, **extra):
    return {"id": sid, "classId": class_id, "name": f"student-{sid}", **extra}


def ctx_for(class_ids, **kw):
    return build_school_context(class_ids, **kw)


ROMAN_SCHOOL = ["I_A", "II_A", "III_A"]


def test_promotion_is_ordinal_plus_one():
    plan = build_promotion_plan([st("s1", "I_A")], ctx_for(ROMAN_SCHOOL))
    assert plan[0]["action"] == ACTION_PROMOTE
    assert plan[0]["to"] == "II_A"


def test_section_is_preserved():
    ctx = ctx_for(["I_Diamond", "II_Diamond"])
    plan = build_promotion_plan([st("s1", "I_Diamond")], ctx)
    assert plan[0]["to"] == "II_Diamond"


def test_terminal_grade_graduates_rather_than_promoting():
    """Highest CONFIGURED grade, not a hardcoded XII — a school running to
    Grade 3 graduates from 3."""
    plan = build_promotion_plan([st("s1", "III_A")], ctx_for(ROMAN_SCHOOL))
    assert plan[0]["action"] == ACTION_GRADUATE
    assert plan[0]["to"] == GRADUATED


def test_terminal_grade_follows_the_school_not_the_calendar():
    small = ctx_for(["I_A", "II_A"])
    plan = build_promotion_plan([st("s1", "II_A")], small)
    assert plan[0]["action"] == ACTION_GRADUATE


def test_pre_primary_ladder_walks_without_special_cases():
    ctx = ctx_for(["Nursery_A", "LKG_A", "UKG_A", "I_A", "II_A"])
    moves = {r["id"]: r["to"] for r in build_promotion_plan(
        [st("n", "Nursery_A"), st("l", "LKG_A"), st("u", "UKG_A")], ctx)}
    assert moves == {"n": "LKG_A", "l": "UKG_A", "u": "I_A"}


def test_ukg_hops_into_numeric_notation_when_the_school_uses_it():
    ctx = ctx_for(["UKG_A", "1_A", "2_A"])
    plan = build_promotion_plan([st("u", "UKG_A")], ctx)
    assert plan[0]["to"] == "1_A"


def test_missing_target_class_is_blocked_not_invented():
    """Item 10: if Grade 5 B has no Grade 6 B, do not create one."""
    ctx = ctx_for(["V_B", "VI_A"])
    plan = build_promotion_plan([st("s1", "V_B")], ctx)
    assert plan[0]["action"] == ACTION_BLOCKED
    assert "does not exist" in plan[0]["reason"]


def test_missing_section_names_the_sections_that_do_exist():
    """A blocked row must be actionable, not just negative."""
    ctx = ctx_for(["V_B", "VI_A", "VI_C"])
    plan = build_promotion_plan([st("s1", "V_B")], ctx)
    assert "VI_A" in plan[0]["reason"] and "VI_C" in plan[0]["reason"]


def test_section_remap_resolves_a_reshuffle():
    """Item 10: schools that renumber sections between sessions."""
    ctx = ctx_for(["V_B", "VI_A"])
    plan = build_promotion_plan([st("s1", "V_B")], ctx,
                                section_map={"5": {"B": "A"}})
    assert plan[0]["action"] == ACTION_PROMOTE
    assert plan[0]["to"] == "VI_A"


def test_inactive_students_are_excluded_and_counted_separately():
    ctx = ctx_for(ROMAN_SCHOOL)
    plan = build_promotion_plan([st("s1", "I_A", isActive=False)], ctx)
    assert plan[0]["action"] == ACTION_UNCHANGED
    assert plan[0]["reason"] == "already inactive"


def test_unresolvable_class_blocks_and_keeps_the_raw_value():
    ctx = ctx_for(ROMAN_SCHOOL)
    plan = build_promotion_plan([st("s1", "Batch Alpha")], ctx)
    assert plan[0]["action"] == ACTION_BLOCKED
    assert plan[0]["from_raw"] == "Batch Alpha"
    assert "Batch Alpha" in plan[0]["from_label"]
    assert plan[0]["to"] is None


def test_blocked_students_make_the_plan_unproceedable():
    """Item 13's hard block, expressed where it cannot be bypassed by the UI."""
    ctx = ctx_for(ROMAN_SCHOOL)
    plan = build_promotion_plan([st("s1", "I_A"), st("s2", "Batch Alpha")], ctx)
    s = summarize(plan)
    assert s["can_proceed"] is False
    assert s["counts"][ACTION_BLOCKED] == 1


def test_explicit_leave_unchanged_unblocks_the_run():
    """The recorded decision from item 13 — the only other way forward."""
    ctx = ctx_for(ROMAN_SCHOOL)
    students = [st("s1", "I_A"), st("s2", "Batch Alpha")]
    plan = build_promotion_plan(students, ctx, leave_unchanged_ids=["s2"])
    s = summarize(plan)
    assert s["can_proceed"] is True
    row = next(r for r in plan if r["id"] == "s2")
    assert row["action"] == ACTION_UNCHANGED
    assert row["reason"] == "explicitly left unchanged"


def test_blocked_reasons_are_grouped_with_samples():
    ctx = ctx_for(ROMAN_SCHOOL)
    students = [st(f"s{i}", "Batch Alpha") for i in range(8)]
    s = summarize(build_promotion_plan(students, ctx))
    assert len(s["blocked_reasons"]) == 1
    assert s["blocked_reasons"][0]["count"] == 8
    assert len(s["blocked_reasons"][0]["sample"]) == 5


def test_every_student_appears_exactly_once():
    """One resolved roster, one row each — the 650-vs-195 guard."""
    ctx = ctx_for(ROMAN_SCHOOL)
    students = [st("a", "I_A"), st("b", "III_A"), st("c", "Batch Alpha"),
                st("d", "I_A", isActive=False)]
    plan = build_promotion_plan(students, ctx)
    assert len(plan) == len(students)
    assert sorted(r["id"] for r in plan) == ["a", "b", "c", "d"]
    assert summarize(plan)["total"] == 4


def test_counts_by_action_sum_to_the_roster():
    ctx = ctx_for(ROMAN_SCHOOL)
    students = [st("a", "I_A"), st("b", "III_A"), st("c", "Batch Alpha"),
                st("d", "I_A", isActive=False)]
    s = summarize(build_promotion_plan(students, ctx))
    assert sum(s["counts"].values()) == s["total"] == 4


# ── Dry-run CSV (item 15) ───────────────────────────────────────────────────
def test_csv_has_a_row_per_student_plus_header():
    ctx = ctx_for(ROMAN_SCHOOL)
    plan = build_promotion_plan([st("a", "I_A"), st("b", "III_A")], ctx)
    lines = plan_to_csv(plan).splitlines()
    assert len(lines) == 3
    assert lines[0].startswith("student_id,name,from_raw")


def test_csv_quotes_values_containing_commas():
    ctx = ctx_for(ROMAN_SCHOOL)
    plan = build_promotion_plan([st("a", "V_B", name="Doe, John")], ctx)
    assert '"' in plan_to_csv(plan)


# ── Fingerprint (item 14) ───────────────────────────────────────────────────
def test_fingerprint_is_stable_across_row_order():
    ctx = ctx_for(ROMAN_SCHOOL)
    a = build_promotion_plan([st("a", "I_A"), st("b", "II_A")], ctx)
    b = build_promotion_plan([st("b", "II_A"), st("a", "I_A")], ctx)
    assert plan_fingerprint(a) == plan_fingerprint(b)


def test_fingerprint_changes_when_a_student_moves():
    ctx = ctx_for(ROMAN_SCHOOL)
    before = build_promotion_plan([st("a", "I_A")], ctx)
    after = build_promotion_plan([st("a", "II_A")], ctx)
    assert plan_fingerprint(before) != plan_fingerprint(after)


def test_fingerprint_changes_when_a_student_is_added():
    """The stale-roster case: someone imports a student between preview and
    execute, and the run must refuse rather than apply a plan nobody saw."""
    ctx = ctx_for(ROMAN_SCHOOL)
    before = build_promotion_plan([st("a", "I_A")], ctx)
    after = build_promotion_plan([st("a", "I_A"), st("b", "I_A")], ctx)
    assert plan_fingerprint(before) != plan_fingerprint(after)


# ══════════════════════════════════════════════════════════════════════════
# EXCLUDED STUDENTS
#
# Some students are parked on a deliberately meaningless class value so they
# cannot reach the app — confirmed as an intentional convention across the
# live estate (153 students at the time of writing). That is a KNOWN state,
# and treating it as broken data would block a reset on nearly every school.
# ══════════════════════════════════════════════════════════════════════════

def ctx_excluding(*raw_values, class_ids=ROMAN_SCHOOL):
    return build_school_context(class_ids, class_map={
        v: {"excluded": True, "source": "confirmed"} for v in raw_values})


def test_excluded_students_do_not_block_the_run():
    """The whole point. Without this, six 'Sample' rows stop a reset for a
    1,949-student school."""
    ctx = ctx_excluding("Sample")
    plan = build_promotion_plan([st("s1", "I_A"), st("s2", "Sample")], ctx)
    s = summarize(plan)
    assert s["can_proceed"] is True
    assert s["counts"][ACTION_BLOCKED] == 0


def test_excluded_students_are_left_alone_not_promoted():
    ctx = ctx_excluding("Sample")
    plan = build_promotion_plan([st("s2", "Sample")], ctx)
    assert plan[0]["action"] == ACTION_UNCHANGED
    assert plan[0]["reason"] == "excluded from the app by class value"
    assert plan[0]["to"] is None


def test_excluded_count_is_reported_separately_from_other_unchanged():
    """'unchanged' must not read as one undifferentiated bucket — an inactive
    student and a parked student are different things."""
    ctx = ctx_excluding("Sample")
    plan = build_promotion_plan(
        [st("s1", "Sample"), st("s2", "I_A", isActive=False), st("s3", "I_A")], ctx)
    s = summarize(plan)
    assert s["counts"][ACTION_UNCHANGED] == 2
    assert s["excluded_count"] == 1


def test_an_unconfirmed_sentinel_still_blocks():
    """Exclusion is only ever a confirmed decision. A value that merely LOOKS
    like a parking value is still blocked until someone says so — otherwise a
    real class named 'Sample House' would be silently dropped."""
    ctx = build_school_context(ROMAN_SCHOOL)
    plan = build_promotion_plan([st("s1", "Sample")], ctx)
    assert plan[0]["action"] == ACTION_BLOCKED


def test_excluded_students_still_appear_in_the_plan_exactly_once():
    ctx = ctx_excluding("Sample", "sample_middle")
    students = [st("a", "I_A"), st("b", "Sample"), st("c", "sample_middle")]
    plan = build_promotion_plan(students, ctx)
    assert len(plan) == 3
    assert summarize(plan)["total"] == 3
