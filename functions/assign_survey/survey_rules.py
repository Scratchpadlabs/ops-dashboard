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
        wanted = set((scope or {}).get("classIds") or [])
        docs = [(i, d) for i, d in docs if str((d or {}).get("classId") or "") in wanted]
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
