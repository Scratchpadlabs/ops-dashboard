"""The register-then-enrich flow: a file that carries the school's own student
id, plus the columns this parser has no field for.

Both come from the same real failure. Hillgreen registers and authenticates
students first (schools/Hillgreen_Highschool/students/shh1612, id "shh1612"),
then imports a file whose ID column holds those very ids. STUDENT_HEADER_ALIASES
had no student_id key, so ID was an unmapped header dropped at parse time, the
commit planner had nothing to match on, and every row minted a second document
named after the class and the student — 1621 duplicates beside 1621 real ones.

The extras half is the other thing that file needed: Board, House and the rest
are real data the school wants on its students, and dropping them meant ops
could never get a school's own fields into that school.
"""
import io
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from normalize import (  # noqa: E402
    STUDENT_HEADER_ALIASES, STUDENT_SCHEMA_KEYS, build_alias_lookup, canonicalize,
)
from tabular_parser import parse_tabular_file  # noqa: E402

STUDENT_REQUIRED_FIELD = "student_name"


def _parse(text, name="roster.csv"):
    return parse_tabular_file(name, text.encode("utf-8"), STUDENT_SCHEMA_KEYS,
                              STUDENT_HEADER_ALIASES, STUDENT_REQUIRED_FIELD)


# ------------------------------------------------------------- student_id --
def test_id_column_reaches_the_row():
    r = _parse("ID,Student Name,Class,Section\nshh1612,Raj Ayush,12,COM_C\n")
    assert r["rows"][0]["data"]["student_id"] == "shh1612"


def test_every_spelling_of_the_id_header():
    lookup = build_alias_lookup(STUDENT_HEADER_ALIASES)
    for header in ("ID", "id", "Student ID", "StudentID", "Unique ID",
                   "Registration No", "Student Code"):
        assert lookup.get(canonicalize(header)) == "student_id", header


def test_id_does_not_swallow_other_headers():
    """"id" is a short, generic alias — it must not capture the columns whose
    canonicalized text merely ends in it."""
    lookup = build_alias_lookup(STUDENT_HEADER_ALIASES)
    for header, field in (("Father EmailID", "father_email"),
                          ("Mother EmailID", "mother_email"),
                          ("Email ID", "email"),
                          ("Enrollment Code", "enrollment_code"),
                          ("Admission No/Reference code", "adm_no")):
        assert lookup.get(canonicalize(header)) == field, header


def test_a_file_with_no_id_column_still_parses():
    r = _parse("Student Name,Class,Section\nRaj Ayush,12,COM_C\n")
    assert r["rows"][0]["data"]["student_id"] == ""


# ----------------------------------------------------------------- extras --
def test_unrecognized_columns_are_carried_as_extras():
    r = _parse("ID,Student Name,Board,House,Bus Route\n"
               "shh1612,Raj Ayush,CBSE,Tagore,Route 4\n")
    assert r["rows"][0]["extras"] == {"House": "Tagore", "Bus Route": "Route 4"}


def test_recognized_columns_never_appear_in_extras():
    """Board has a real field — it must arrive as data, not twice."""
    r = _parse("ID,Student Name,Board\nshh1612,Raj Ayush,CBSE\n")
    assert r["rows"][0]["data"]["board"] == "CBSE"
    assert r["rows"][0]["extras"] == {}


def test_blank_extra_cells_are_omitted_not_stored_empty():
    r = _parse("ID,Student Name,House\nshh1612,Raj Ayush,\n")
    assert r["rows"][0]["extras"] == {}


def test_duplicate_extra_headers_get_distinct_names():
    r = _parse("ID,Student Name,Remarks,Remarks\nshh1612,Raj Ayush,good,better\n")
    assert r["rows"][0]["extras"] == {"Remarks": "good", "Remarks_2": "better"}
    assert "Remarks_2" in r["unmapped_headers"]


def test_extras_are_whitespace_collapsed():
    r = _parse("ID,Student Name,House\nshh1612,Raj Ayush,  Tagore   House \n")
    assert r["rows"][0]["extras"] == {"House": "Tagore House"}


def test_short_row_does_not_crash_on_a_missing_extra_column():
    r = _parse("ID,Student Name,House\nshh1612,Raj Ayush\n")
    assert r["rows"][0]["extras"] == {}


def test_every_row_has_an_extras_key():
    """The commit planner reads row.extras unconditionally."""
    r = _parse("ID,Student Name\nshh1612,Raj Ayush\nshh1613,Asha Kumar\n")
    assert all("extras" in row for row in r["rows"])
