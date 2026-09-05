"""clean_students_rows' fallback for a glued grade+section column ("classId").

Regression test for Hillgreen Highschool, 2026-09-05: a file whose only class
column was header "classId" (not "grade"/"class") went through import with
grade AND section blank on every one of 1625 rows, because nothing in
STUDENT_HEADER_ALIASES recognized "classId" ("classid" fuzzy-matches "class"
at 0.833 — just under the 0.84 threshold — so it was dropped as an unmapped
column entirely, not merely mis-parsed). Every row was then skipped downstream
at commit time for "no class-section configured".
"""
import os
import sys
import types

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# main.py calls firebase_admin.initialize_app() at import — stub the SDK, same
# shape as test_commit_teachers.py / test_flag_dedupe.py.
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

from main import clean_students_rows  # noqa: E402


def _cfg(sections_by_grade=None):
    return {
        "sections_by_grade": sections_by_grade or {},
        "aliases": {},
        "kb_overlay": {},
    }


def test_combined_class_splits_into_grade_and_section():
    rows = [{"student_name": "Zayn Aman Arab", "combined_class": "5A"}]
    out = clean_students_rows(rows, _cfg())
    d = out[0]["data"]
    assert d["grade"] == "5"
    fixes = {f["field"]: f for f in out[0]["fixes"]}
    assert fixes["grade"]["rule"] == "combined_class_split"
    assert fixes["grade"]["original"] == "5A"


def test_combined_class_with_hyphen():
    rows = [{"student_name": "Someone", "combined_class": "10-B"}]
    out = clean_students_rows(rows, _cfg())
    assert out[0]["data"]["grade"] == "10"


def test_explicit_grade_column_wins_over_combined_class():
    # If a separate grade column DID parse, combined_class is never consulted
    # — a school that has both should never have the glued column override
    # the explicit one.
    rows = [{"student_name": "Someone", "grade": "7", "combined_class": "5A"}]
    out = clean_students_rows(rows, _cfg())
    assert out[0]["data"]["grade"] == "7"


def test_unrecognized_combined_class_flags_instead_of_guessing():
    rows = [{"student_name": "Someone", "combined_class": "IB"}]
    out = clean_students_rows(rows, _cfg())
    d = out[0]["data"]
    assert d.get("grade", "") == ""
    messages = [f["message"] for f in out[0]["flags"]]
    assert any("does not resolve to a known grade" in m for m in messages)


def test_no_class_column_at_all_leaves_grade_blank():
    rows = [{"student_name": "Someone"}]
    out = clean_students_rows(rows, _cfg())
    assert out[0]["data"].get("grade", "") == ""
    assert not out[0]["flags"]
