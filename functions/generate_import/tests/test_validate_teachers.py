"""validate_teachers: subject inference from the class assignment, and board
tokens in the section cell.

Both come from the same real file — Hillgreen's "Class Teachers List", a
class-teacher roster with no subject column at all. Every one of its 134 rows
was flagged "teacher has zero subject assignments", and 16 more were flagged
"class 'SCI_CBSE_A' not in school config for grade 11" because the file writes
the board into the section cell while the configured class is SCI_A.
"""
import os
import sys
import types

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

# main.py calls firebase_admin.initialize_app() at import — stub the SDK, same
# reason and same shape as test_flag_dedupe.py.
for name in ("firebase_admin", "firebase_functions"):
    if name not in sys.modules:
        sys.modules[name] = types.ModuleType(name)
sys.modules["firebase_admin"].initialize_app = lambda *a, **k: None
sys.modules["firebase_admin"].firestore = types.SimpleNamespace(
    client=lambda *a, **k: None, SERVER_TIMESTAMP="TS", Increment=lambda n: n)
sys.modules["firebase_admin"].storage = types.SimpleNamespace(bucket=lambda *a, **k: None)
_d = lambda *a, **k: (lambda f: f)  # noqa: E731
sys.modules["firebase_functions"].https_fn = types.SimpleNamespace(
    on_call=_d, CallableRequest=object, HttpsError=type("E", (Exception,), {}),
    FunctionsErrorCode=types.SimpleNamespace(
        INVALID_ARGUMENT="x", UNAUTHENTICATED="x", PERMISSION_DENIED="x", INTERNAL="x"))
sys.modules["firebase_functions"].options = types.SimpleNamespace(
    MemoryOption=types.SimpleNamespace(MB_256="256", MB_512="512", GB_1="1024"))

from main import validate_teachers  # noqa: E402


def _row(name, grade, section="", subject="", email=""):
    return {"teacher_name": name, "email": email, "grade": grade,
            "section": section, "subject": subject}


def _messages(flags):
    return [f["message"] for fl in flags for f in fl]


# ---------------------------------------------------------------- inference --
def test_zero_subject_teacher_with_configured_grade_reports_inference():
    rows = [_row("Asha", "6", "A")]
    flags = validate_teachers(
        rows, {("6", "A"): "6_A"}, {"6": {"A": "A"}},
        {"6": {"english", "maths", "science"}})
    assert _messages(flags) == [
        "subjects inferred from class assignment — verify "
        "(3 subject(s) configured for grade 6)"]


def test_zero_subject_teacher_without_configured_subjects_asks_for_manual():
    """Hillgreen's pre-primary grades: the class exists, the Subjects tab for
    it does not. Inference has nothing to infer, so the flag must say so
    instead of promising subjects that will never be written."""
    rows = [_row("Disha", "Nursery", "Tom")]
    flags = validate_teachers(
        rows, {("Nursery", "TOM"): "Nursery_TOM"}, {"Nursery": {"TOM": "TOM"}}, {})
    assert _messages(flags) == [
        "no subjects configured for grade Nursery — "
        "assign manually after configuring the Subjects tab"]


def test_teacher_with_a_subject_somewhere_is_not_inferred_anywhere():
    """Grouping is per teacher, not per row. A subject specialist who has one
    blank row has NOT delegated that row to inference — the blank is a gap in
    the file, and inventing a full subject list for it would be wrong."""
    rows = [_row("Ravi", "6", "A", subject="Maths"), _row("Ravi", "7", "A")]
    flags = validate_teachers(
        rows, {("6", "A"): "6_A", ("7", "A"): "7_A"},
        {"6": {"A": "A"}, "7": {"A": "A"}},
        {"6": {"maths"}, "7": {"maths"}})
    assert _messages(flags) == []


def test_inference_flag_is_distinct_from_a_source_file_subject():
    """The flag must not read like the file stated these subjects."""
    rows = [_row("Asha", "6", "A")]
    flags = validate_teachers(
        rows, {("6", "A"): "6_A"}, {"6": {"A": "A"}}, {"6": {"english"}})
    msg = _messages(flags)[0]
    assert "inferred from class assignment" in msg and "verify" in msg


# ------------------------------------------------------- board-token section --
@pytest.mark.parametrize("raw,cid", [
    ("SCI_CBSE_A", "XI_Science_SCI_A"),
    ("SCI_CBSE_B", "XI_Science_SCI_B"),
    ("COM_CBSE_C", "XI_Commerce_COM_C"),
])
def test_board_token_in_section_resolves_to_the_configured_class(raw, cid):
    lookup = {("11", "SCI_A"): "XI_Science_SCI_A",
              ("11", "SCI_B"): "XI_Science_SCI_B",
              ("11", "COM_C"): "XI_Commerce_COM_C"}
    sections = {"11": {"SCI_A": "SCI_A", "SCI_B": "SCI_B", "COM_C": "COM_C"}}
    rows = [_row("Asha", "11", raw, subject="Physics")]
    flags = validate_teachers(rows, lookup, sections, {"11": {"physics"}})
    assert _messages(flags) == []


def test_a_genuinely_unconfigured_section_is_still_flagged():
    """Stripping the board must not turn the check into a rubber stamp."""
    rows = [_row("Asha", "11", "SCI_CBSE_Z", subject="Physics")]
    flags = validate_teachers(
        rows, {("11", "SCI_A"): "XI_Science_SCI_A"}, {"11": {"SCI_A": "SCI_A"}},
        {"11": {"physics"}})
    assert _messages(flags) == [
        "class 'SCI_CBSE_Z' not in school config for grade 11"]
