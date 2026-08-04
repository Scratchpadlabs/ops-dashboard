"""One failure must produce one message.

A cell the parser cannot read is blanked and reported ("unparseable date of
birth: '16 Jan 2024'"). The row-level pass then saw the blank and added
"missing date of birth" — two flags for one problem, and the second one is
wrong: the file did have a date. Same collision existed for gender and
contact.
"""
import os
import sys
import types

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

# main.py calls firebase_admin.initialize_app() at import, which needs a
# Firebase environment this test has no business requiring — the same reason
# school_reset splits its pure logic into reset_rules.py. The functions under
# test are pure, so stub the SDK rather than refactor production code for a
# bug fix.
for name in ("firebase_admin", "firebase_functions"):
    if name not in sys.modules:
        sys.modules[name] = types.ModuleType(name)
sys.modules["firebase_admin"].initialize_app = lambda *a, **k: None
sys.modules["firebase_admin"].firestore = types.SimpleNamespace(
    client=lambda *a, **k: None, SERVER_TIMESTAMP=None, Increment=lambda n: n)
sys.modules["firebase_admin"].storage = types.SimpleNamespace(bucket=lambda *a, **k: None)


def _passthrough_decorator(*a, **k):
    def wrap(fn):
        return fn
    return wrap


sys.modules["firebase_functions"].https_fn = types.SimpleNamespace(
    on_call=_passthrough_decorator, CallableRequest=object,
    HttpsError=type("HttpsError", (Exception,), {}),
    FunctionsErrorCode=types.SimpleNamespace(
        INVALID_ARGUMENT="invalid-argument", UNAUTHENTICATED="unauthenticated",
        PERMISSION_DENIED="permission-denied", INTERNAL="internal"))
sys.modules["firebase_functions"].options = types.SimpleNamespace(
    MemoryOption=types.SimpleNamespace(MB_256="256", MB_512="512", GB_1="1024"))

from main import validate_students, _already_flagged  # noqa: E402

LOOKUP = {"iii|a": "III_A"}
SECTIONS = {"iii": ["A"]}


def flags_for(row, prior=None):
    out = validate_students([row], LOOKUP, SECTIONS,
                            existing_flags=[prior or []])
    return [(f["field"], f["message"]) for f in out[0]]


BASE = {"student_name": "Asha Patil", "grade": "III", "section": "A",
        "gender": "Female", "dob": "2016-05-21", "contact": "9876543210"}


def test_unparseable_dob_is_not_also_reported_as_missing():
    prior = [{"field": "dob", "message": "unparseable date of birth: '16 Jan 2024'",
              "severity": "warning"}]
    messages = [m for f, m in flags_for({**BASE, "dob": ""}, prior)]
    assert not any("missing date of birth" in m for m in messages)


def test_genuinely_empty_dob_is_still_reported_as_missing():
    messages = [m for f, m in flags_for({**BASE, "dob": ""})]
    assert any("missing date of birth" in m for m in messages)


def test_invalid_contact_is_not_also_reported_as_missing():
    prior = [{"field": "contact", "message": "invalid phone number: 'N/A'",
              "severity": "warning"}]
    messages = [m for f, m in flags_for({**BASE, "contact": ""}, prior)]
    assert not any("missing contact" in m for m in messages)


def test_genuinely_empty_contact_is_still_reported_as_missing():
    messages = [m for f, m in flags_for({**BASE, "contact": ""})]
    assert any("missing contact" in m for m in messages)


def test_unrecognized_gender_is_not_also_reported_as_missing():
    prior = [{"field": "gender", "message": "unrecognized gender: 'X'",
              "severity": "warning"}]
    messages = [m for f, m in flags_for({**BASE, "gender": ""}, prior)]
    assert not any("missing gender" in m for m in messages)


def test_one_failure_yields_exactly_one_dob_message():
    """The whole point: count them."""
    prior = [{"field": "dob", "message": "unparseable date of birth: '16 Jan 2024'",
              "severity": "warning"}]
    row_flags = flags_for({**BASE, "dob": ""}, prior)
    total = len(prior) + len([1 for f, _ in row_flags if f == "dob"])
    assert total == 1


def test_prior_flag_on_another_field_does_not_suppress_dob():
    prior = [{"field": "contact", "message": "invalid phone number: 'x'",
              "severity": "warning"}]
    messages = [m for f, m in flags_for({**BASE, "dob": ""}, prior)]
    assert any("missing date of birth" in m for m in messages)


def test_already_flagged_helper():
    assert _already_flagged([{"field": "dob"}], "dob")
    assert not _already_flagged([{"field": "dob"}], "gender")
    assert not _already_flagged([], "dob")
    assert not _already_flagged(None, "dob")


def test_grade_warning_is_untouched():
    """Hillgreen's missing Pre-Nursery/Nursery must keep surfacing."""
    messages = [m for f, m in flags_for({**BASE, "grade": "Nursery", "section": ""})]
    assert any("nursery" in m.lower() or "not configured" in m.lower()
               or "class" in m.lower() for m in messages)
