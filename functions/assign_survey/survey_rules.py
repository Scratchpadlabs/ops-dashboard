#!/usr/bin/env python3
"""
Pure decision logic for survey assignment — the parts worth testing.

Split out of main.py for the same reason normalize.py is split out of
generate_import/main.py: main.py calls firebase_admin.initialize_app() at
module load, so anything living there can't be imported by a test without a
Firebase environment. Everything here is stdlib-only and side-effect free.

These three functions are where a bug is expensive:
  is_real_survey  — lets a junk/test doc reach thousands of inboxes
  is_inactive     — silently skips (or silently includes) a whole roster
  plan_targets    — writes the wrong set of documents
"""

# The array field holding a recipient's assigned survey IDs.
#
# Verified for students (schools/<id>/students/<id>.surveyInbox). For STAFF
# this mirrors the student pattern per the task's instruction — nothing in
# the ops-dashboard repo reads a staff inbox, so it could not be confirmed
# from source. The assumption is surfaced rather than buried: plan_targets
# reports `existing_field` (how many targeted docs actually carry the field),
# so a wrong guess shows in the preview as "0 already have this field"
# BEFORE any write.
DEFAULT_INBOX_FIELD = "surveyInbox"

# A record is active unless it explicitly says otherwise. Absent fields mean
# active — treating "no isActive field" as inactive would skip an entire
# roster that predates the flag.
INACTIVE_ENROLLMENT_VALUES = {
    "inactive", "left", "tc", "tc issued", "dropped", "dropout",
    "alumni", "passed out", "transferred", "withdrawn",
}


def is_inactive(doc):
    """True only when the record explicitly says so."""
    if not isinstance(doc, dict):
        return False
    if doc.get("isActive") is False:
        return True
    status = str(doc.get("enrollmentStatus") or doc.get("status") or "").strip().lower()
    return status in INACTIVE_ENROLLMENT_VALUES


def is_real_survey(doc):
    """The junk/test filter.

    The surveys collection contains test docs (ids like
    'zzzzzzzzzzzzzzzzzy1'..'y17'). A real survey has a name map with at least
    one non-empty translation AND a non-empty questions array.

    Deliberately structural rather than an id blocklist: it keeps working
    when junk arrives under a different id, and it can never delete anything
    — a doc that fails this is simply never offered for assignment.
    """
    if not isinstance(doc, dict):
        return False
    name = doc.get("name")
    if not isinstance(name, dict) or not any(str(v or "").strip() for v in name.values()):
        return False
    questions = doc.get("questions")
    return isinstance(questions, list) and len(questions) > 0


def plan_targets(docs, survey_id, mode, inbox_field=DEFAULT_INBOX_FIELD):
    """Split candidates into what changes, what is already correct, what is skipped.

    `docs` is [(doc_id, data)]. Returns
    {to_write, already, inactive, existing_field}.

    This is the SHARED half of preview and apply — the preview shows exactly
    what a subsequent apply will do because both call this, and only the
    write loop differs.
    """
    to_write, already, inactive, existing_field = [], 0, 0, 0

    for doc_id, data in docs:
        if is_inactive(data):
            inactive += 1
            continue

        inbox = (data or {}).get(inbox_field)
        is_list = isinstance(inbox, list)
        if is_list:
            existing_field += 1
        has = is_list and survey_id in inbox

        # "already" means already in the DESIRED END STATE, which is the
        # opposite condition per mode: already has it (assign) / already
        # doesn't (unassign). Either way it is what gets skipped.
        needs_change = (not has) if mode == "assign" else has
        if needs_change:
            to_write.append(doc_id)
        else:
            already += 1

    return {
        "to_write": to_write,
        "already": already,
        "inactive": inactive,
        "existing_field": existing_field,
    }


def filter_scope(docs, scope, audience):
    """Narrow candidates to the requested scope.

    `docs` is [(doc_id, data)]; scope is {type: school|classes|ids, ...}.
    Raises ValueError on an unknown scope type — callers map that to
    INVALID_ARGUMENT rather than silently assigning the whole school, which
    is the failure mode that matters here.
    """
    scope_type = (scope or {}).get("type") or "school"

    if scope_type == "classes":
        # Resolved the same way the matrix groups — a school whose students
        # key their class off currentClassId or grade+section must still be
        # assignable BY CLASS. Reading a bare `classId` here matched nothing
        # for those schools and wrote silently to zero students.
        wanted = set((scope or {}).get("classIds") or [])
        docs = [(i, d) for i, d in docs if resolve_class_key(d)[0] in wanted]
    elif scope_type == "ids":
        wanted = set((scope or {}).get("ids") or [])
        docs = [(i, d) for i, d in docs if i in wanted]
    elif scope_type != "school":
        raise ValueError(f"Unknown scope type: {scope_type}")

    # Students carry type: 'student'; tolerate the field being absent rather
    # than dropping a roster that never set it.
    if audience == "students":
        docs = [(i, d) for i, d in docs if str((d or {}).get("type") or "student") == "student"]

    return docs


# ─────────────────────────── matrix + status (v2) ──────────────────────────
# The v2 UI is CLASS-first: a classes x surveys grid, multi-survey selection,
# and completion reports. Everything below is the pure half of that.

# Class ids encode the grade ("I_Diamond", "II_Ruby", "10_A"), and plain
# string sorting gets them WRONG: '_' (0x5F) sorts after 'I', so "II_Ruby"
# lands before "I_Diamond", and "10_A" before "2_A". Every class list in the
# matrix and in the reports goes through class_sort_key so rows read in
# school order. Mirrors the grade ordering in src/utils/structureInference.js
# and the education KB's grade canon (Nursery < LKG < UKG < 1..12).
_PRE_PRIMARY_ORDER = {"PRE-NURSERY": -4, "NURSERY": -3, "LKG": -2, "UKG": -1}
_ROMAN_ORDER = {"I": 1, "II": 2, "III": 3, "IV": 4, "V": 5, "VI": 6,
                 "VII": 7, "VIII": 8, "IX": 9, "X": 10, "XI": 11, "XII": 12}


def grade_order(grade):
    """Sortable position for a grade token. Unknown grades sort last rather
    than raising — an unrecognized class must still appear in the matrix."""
    g = str(grade or "").strip().upper()
    if g in _PRE_PRIMARY_ORDER:
        return _PRE_PRIMARY_ORDER[g]
    if g in _ROMAN_ORDER:
        return _ROMAN_ORDER[g]
    if g.isdigit():
        return int(g)
    return 999


def class_sort_key(class_id):
    """('I_Diamond') -> (1, 'diamond', 'i_diamond'). Grade first, then
    section, with the raw id as a final tiebreak so ordering is stable."""
    raw = str(class_id or "")
    parsed = parse_class_value(raw)
    ordinal = parsed["grade_ordinal"]
    # Unresolvable values sort last but stay stable among themselves, so an
    # odd class is visible at the end of the list rather than scattered.
    return (ordinal if ordinal is not None else 99,
            (parsed["section"] or "").lower(), raw.lower())


def student_sort_key(student):
    """Class order, then roll number NUMERICALLY (so 2 precedes 10), then
    name. A non-numeric roll sorts after the numeric ones rather than
    breaking the comparison."""
    roll = str((student or {}).get("rollNo") or "").strip()
    roll_num = (0, int(roll)) if roll.isdigit() else (1, 0)
    raw, _ = raw_class_value(student or {})
    return (class_sort_key(raw), roll_num, roll.lower(),
            str((student or {}).get("name") or "").lower())


STATUS_NOT_ASSIGNED = "not assigned"
STATUS_PENDING = "pending"
STATUS_COMPLETED = "completed"

SCHOOL_TOTAL_KEY = "__school__"


def student_status(student, survey_id, responder_ids, inbox_field=DEFAULT_INBOX_FIELD):
    """One student's position on one survey.

    Three distinct outcomes, never collapsed (the task is explicit): a
    student who was never assigned is "not assigned", NOT "pending" —
    conflating them would inflate every pending report with people who were
    never asked in the first place.
    """
    inbox = (student or {}).get(inbox_field)
    if not isinstance(inbox, list) or survey_id not in inbox:
        return STATUS_NOT_ASSIGNED
    return STATUS_COMPLETED if (student or {}).get("id") in (responder_ids or set()) else STATUS_PENDING


def build_matrix(students, survey_ids, responders_by_survey, inbox_field=DEFAULT_INBOX_FIELD):
    """The classes x surveys grid.

    `students` is [{id, classId, ...}] already filtered to active students.
    `responders_by_survey` is {survey_id: set(student_id)}.

    Returns {rows: [...], totals: {...}} where each row is
      {class_id, student_count, cells: {survey_id: {assigned, responded, total}}}
    and totals is the same cell shape keyed by survey for the pinned
    school-total row. Counting responded only among ASSIGNED students keeps
    completion % meaningful — a stray response from someone who was never
    assigned can't push a class over 100%.
    """
    by_class = {}
    for s in students:
        key, _ = resolve_class_key(s)
        by_class.setdefault(key, []).append(s)

    rows = []
    totals = {sid: {"assigned": 0, "responded": 0, "total": 0} for sid in survey_ids}

    for class_id in sorted(by_class, key=class_sort_key):
        members = by_class[class_id]
        cells = {}
        for sid in survey_ids:
            responders = responders_by_survey.get(sid) or set()
            assigned = 0
            responded = 0
            for st in members:
                inbox = st.get(inbox_field)
                if isinstance(inbox, list) and sid in inbox:
                    assigned += 1
                    if st.get("id") in responders:
                        responded += 1
            cells[sid] = {"assigned": assigned, "responded": responded, "total": len(members)}
            totals[sid]["assigned"] += assigned
            totals[sid]["responded"] += responded
            totals[sid]["total"] += len(members)
        rows.append({"class_id": class_id, "student_count": len(members), "cells": cells})

    return {"rows": rows, "totals": totals}


def plan_multi(docs, survey_ids, mode, inbox_field=DEFAULT_INBOX_FIELD):
    """Target plan across SEVERAL surveys at once.

    v2 assigns N surveys x M classes as one action, so the unit of work is a
    (survey, doc) pair rather than a doc. Returns
      {per_survey: {survey_id: plan_targets(...)},
       total_writes, total_already, inactive, pairs}
    `inactive` is counted ONCE per document, not once per survey — otherwise
    a 3-survey run over 10 inactive students would report 30 skips and read
    as a much bigger problem than it is.
    """
    per_survey = {}
    total_writes = 0
    total_already = 0
    for sid in survey_ids:
        plan = plan_targets(docs, sid, mode, inbox_field)
        per_survey[sid] = plan
        total_writes += len(plan["to_write"])
        total_already += plan["already"]

    inactive = sum(1 for _, d in docs if is_inactive(d))
    return {
        "per_survey": per_survey,
        "total_writes": total_writes,
        "total_already": total_already,
        "inactive": inactive,
        "pairs": len(survey_ids) * max(len(docs) - inactive, 0),
    }


def in_active_window(survey, now):
    """True when now falls inside [startAt, expiresAt]. A missing bound is
    treated as open-ended, which is how these docs are actually used —
    requiring both would hide every survey that never set an end date."""
    start = (survey or {}).get("startAt")
    end = (survey or {}).get("expiresAt")
    if start is not None and now < start:
        return False
    if end is not None and now > end:
        return False
    return True


# ──────────────────────── class key resolution (bugfix) ────────────────────
# Students do NOT all carry `classId`. Verified shapes in this codebase:
#   - classId          the shape the survey spec documents
#   - currentClassId   what THIS repo's own import pipeline writes
#                      (src/composables/useImport.js buildStudentsPlan)
#   - grade + section  as separate fields, needing composition
# Class resolution is NOT decided here. It lives in the shared resolver
# (functions/shared/class_resolver.py, imported — no copy in this folder) so
# surveys, promotion, import review and reports all read a student's class the
# same way. This module previously had its own copy — one of three in the repo
# — and the three disagreed.
from shared.class_resolver import (  # noqa: E402
    CLASS_ID_FIELDS, GRADE_FIELDS, SECTION_FIELDS,  # noqa: F401 (re-exported)
    raw_class_value, parse_class_value,
)

NO_CLASS = "(no class)"


def resolve_class_key(student):
    """(class_key, source_field) for one student doc.

    Grouping deliberately keys on the RAW value rather than the canonical
    class id: a school whose roster says "1-B" should group under "1-B", not
    under a normalized form nobody there recognizes. Resolution is still what
    orders and promotes those groups.

    "(no class)" is reserved for a student genuinely carrying no class field —
    an unrecognized value groups under itself, because collapsing it into one
    bucket is what hid a whole school's roster once already.
    """
    if not isinstance(student, dict):
        return NO_CLASS, None
    raw, field = raw_class_value(student)
    if raw in (None, ""):
        return NO_CLASS, None
    return raw, field


def class_field_report(students):
    """Which field each student's class came from, as counts.

    Returned by survey_matrix so a future "everything is (no class)" is
    diagnosable from the response itself instead of by guesswork: it names
    the field actually used, and lists the keys present on unresolved docs.
    """
    sources = {}
    unresolved_samples = []
    for s in students:
        _, field = resolve_class_key(s)
        key = field or NO_CLASS
        sources[key] = sources.get(key, 0) + 1
        if field is None and len(unresolved_samples) < 5:
            unresolved_samples.append(sorted(k for k in (s or {}) if k != "id")[:25])
    return {"sources": sources, "unresolved_sample_fields": unresolved_samples}
