"""A file that names the class by its WHOLE document id, not Class + Section.

Hillgreen's 2026-27 student export dropped its Section column and put the
complete class id in Class — "Play_Group_A", "8_KALAM", "UKG_JERRY".
STUDENT_HEADER_ALIASES maps "class" onto grade, so every one of its 1621 rows
was told `grade 'PLAY_GROUP_A' not configured for this school` while the class
was configured all along. 1621 rows x 2 warnings is 3242 lines of a review
report that were simply wrong.

The other half matters just as much: the (grade, section) lookup is still
tried first and by the same key, so a two-column file flags exactly what it
flagged before, and an id the school does NOT hold is still reported.
"""
import os
import sys
import types

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

# main.py calls firebase_admin.initialize_app() at import — stub the SDK, same
# reason and same shape as test_validate_teachers.py.
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

from main import (  # noqa: E402
    drop_unrecognized_grade_flags, resolve_by_doc_id, validate_students,
    validate_teachers,
)

# A Hillgreen-shaped school, as load_school_config builds it.
LOOKUP = {("PLAY GROUP", "A"): "Play_Group_A", ("UKG", "JERRY"): "UKG_JERRY",
          ("8", "KALAM"): "8_KALAM", ("8", "RAMAN"): "8_RAMAN"}
SECTIONS = {"PLAY GROUP": {"a": "A"}, "UKG": {"jerry": "JERRY"},
            "8": {"kalam": "KALAM", "raman": "RAMAN"}}
BY_DOC_ID = {"play_group_a": "Play_Group_A", "ukg_jerry": "UKG_JERRY",
             "8_kalam": "8_KALAM", "8_raman": "8_RAMAN"}


def _student(grade, section=""):
    return {"student_name": "Zayn Aman Arab", "grade": grade, "section": section,
            "dob": "2020-01-01", "gender": "Boy", "contact": "8087867401"}


def _messages(flags):
    return [f["message"] for fl in flags for f in fl]


# ------------------------------------------------------- the whole-id file --
def test_whole_class_id_in_the_grade_cell_is_not_flagged():
    flags = validate_students([_student("Play_Group_A")], LOOKUP, SECTIONS,
                              class_by_doc_id=BY_DOC_ID)
    assert _messages(flags) == []


def test_every_hillgreen_class_id_resolves():
    rows = [_student(g) for g in ("Play_Group_A", "UKG_JERRY", "8_KALAM", "8_RAMAN")]
    flags = validate_students(rows, LOOKUP, SECTIONS, class_by_doc_id=BY_DOC_ID)
    assert _messages(flags) == []


def test_separators_and_case_do_not_matter():
    rows = [_student(g) for g in ("play group a", "8-kalam", "  UKG_Jerry  ")]
    flags = validate_students(rows, LOOKUP, SECTIONS, class_by_doc_id=BY_DOC_ID)
    assert _messages(flags) == []


def test_grade_cell_plus_section_column_spelling_a_doc_id():
    flags = validate_students([_student("Play_Group", "A")], LOOKUP, SECTIONS,
                              class_by_doc_id=BY_DOC_ID)
    assert _messages(flags) == []


# --------------------------------------------------- still reports the real --
def test_unconfigured_class_id_is_still_flagged():
    flags = validate_students([_student("9_TAGORE")], LOOKUP, SECTIONS,
                              class_by_doc_id=BY_DOC_ID)
    assert _messages(flags) == ["grade '9_TAGORE' not configured for this school"]


def test_configured_grade_with_an_unknown_section_still_names_the_section():
    flags = validate_students([_student("8", "BOSE")], LOOKUP, SECTIONS,
                              class_by_doc_id=BY_DOC_ID)
    assert _messages(flags) == ["class 'BOSE' not in school config for grade 8"]


def test_two_column_file_is_unaffected():
    flags = validate_students([_student("8", "KALAM")], LOOKUP, SECTIONS,
                              class_by_doc_id=BY_DOC_ID)
    assert _messages(flags) == []


def test_without_the_map_behaviour_is_exactly_as_before():
    """The kwarg defaults to None, so every existing caller and test keeps the
    behaviour it had — the fallback only ever adds a rung, never removes one."""
    flags = validate_students([_student("Play_Group_A")], LOOKUP, SECTIONS)
    assert _messages(flags) == ["grade 'PLAY_GROUP_A' not configured for this school"]


# ----------------------------------------------------------------- teachers --
def test_teacher_row_with_a_whole_class_id():
    rows = [{"teacher_name": "Asha", "email": "", "grade": "8_KALAM",
             "section": "", "subject": "Maths"}]
    flags = validate_teachers(rows, LOOKUP, SECTIONS, {"8": {"maths"}},
                              class_by_doc_id=BY_DOC_ID)
    # The class resolves; only the subject check has anything left to say.
    assert "not configured for this school" not in " ".join(_messages(flags))


# ------------------------------------------------------------- the resolver --
def test_resolve_by_doc_id_returns_the_real_id_not_the_key():
    assert resolve_by_doc_id(BY_DOC_ID, "play group a", "") == "Play_Group_A"


def test_resolve_by_doc_id_is_none_without_a_map():
    assert resolve_by_doc_id(None, "8_KALAM", "") is None
    assert resolve_by_doc_id({}, "8_KALAM", "") is None


def test_resolve_by_doc_id_never_guesses():
    assert resolve_by_doc_id(BY_DOC_ID, "9_TAGORE", "") is None
    assert resolve_by_doc_id(BY_DOC_ID, "", "") is None
    assert resolve_by_doc_id(BY_DOC_ID, "   ", "  ") is None


# ------------------------------------------- retracting the parse warning --
def _cleaned(grade, section="", flags=None):
    return {"data": {"student_name": "Zayn", "grade": grade, "section": section},
            "flags": list(flags if flags is not None else
                          [{"field": "grade", "severity": "warning",
                            "message": f"unrecognized grade value: '{grade}'"}])}


def test_unrecognized_grade_is_retracted_once_the_class_resolves():
    rows = [_cleaned("8_KALAM"), _cleaned("Play_Group_A"), _cleaned("ukg jerry")]
    drop_unrecognized_grade_flags(rows, BY_DOC_ID)
    assert [r["flags"] for r in rows] == [[], [], []]


def test_a_class_that_does_not_resolve_keeps_its_warning():
    rows = [_cleaned("9_TAGORE")]
    drop_unrecognized_grade_flags(rows, BY_DOC_ID)
    assert _messages([r["flags"] for r in rows]) == \
        ["unrecognized grade value: '9_TAGORE'"]


def test_other_grade_warnings_survive():
    """Only the "this is not a grade" verdict is retracted — a cell holding
    two grades is still ambiguous however the class resolves."""
    rows = [_cleaned("8_KALAM", flags=[
        {"field": "grade", "severity": "warning",
         "message": "multiple grades found in '8_KALAM, 9_RAMAN' — using '8_KALAM'"},
        {"field": "grade", "severity": "warning",
         "message": "unrecognized grade value: '8_KALAM'"},
        {"field": "contact", "severity": "warning", "message": "missing contact number"},
    ])]
    drop_unrecognized_grade_flags(rows, BY_DOC_ID)
    assert _messages([r["flags"] for r in rows]) == [
        "multiple grades found in '8_KALAM, 9_RAMAN' — using '8_KALAM'",
        "missing contact number",
    ]


def test_without_the_map_nothing_is_retracted():
    rows = [_cleaned("8_KALAM")]
    drop_unrecognized_grade_flags(rows, None)
    assert _messages([r["flags"] for r in rows]) == ["unrecognized grade value: '8_KALAM'"]


# ------------------------------------------------------- contact numbers --
def _with_contacts(**kw):
    row = _student("8_KALAM")
    row["contact"] = ""
    row.update(kw)
    return row


def test_a_fathers_number_is_a_contact():
    """Hillgreen's export leaves MobileNumber empty on 1472 of 1622 rows and
    fills Father Mobile No on 1620 of them. Those rows are not missing a
    contact — father_mobile is written to the student document."""
    flags = validate_students([_with_contacts(father_mobile="8087867401")],
                              LOOKUP, SECTIONS, class_by_doc_id=BY_DOC_ID)
    assert _messages(flags) == []


def test_a_mothers_number_is_a_contact():
    flags = validate_students([_with_contacts(mother_mobile="9359262211")],
                              LOOKUP, SECTIONS, class_by_doc_id=BY_DOC_ID)
    assert _messages(flags) == []


def test_no_number_anywhere_is_still_reported():
    flags = validate_students([_with_contacts()], LOOKUP, SECTIONS,
                              class_by_doc_id=BY_DOC_ID)
    assert _messages(flags) == ["no contact number in any column"]
