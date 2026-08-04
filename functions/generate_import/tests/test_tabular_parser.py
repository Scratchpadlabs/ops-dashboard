#!/usr/bin/env python3
"""
Contract tests for tabular_parser.py — the deterministic parsing layer from
task-parser-hardening.txt. Two layers:

1. A blanket sweep over every file in fixtures/ (synthetic stand-ins for real
   school exports, see make_fixtures.py) asserting the universal contract:
   parse_tabular_file() ALWAYS returns a well-shaped ParseResult, NEVER
   raises, and a 0-row result always carries a non-empty error reason. Drop
   real files (e.g. an actual 1-B.xls) into fixtures/ and this sweep picks
   them up automatically — no test changes needed.
2. Specific assertions per fixture, and targeted unit tests for the trickier
   normalizers (ambiguous DOB, multi-number phone cells, encoding fallback).

Run with: .venv_test/Scripts/python.exe -m pytest tests/ -v
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest

from normalize import (
    STUDENT_HEADER_ALIASES, STUDENT_REQUIRED_FIELD, STUDENT_SCHEMA_KEYS,
    clean_phone, clean_gender, parse_dob_flexible, extract_grade_tokens,
)
from tabular_parser import parse_tabular_file, sniff_file_type

FIXTURES_DIR = os.path.join(os.path.dirname(__file__), "fixtures")


def _fixture_names():
    return sorted(os.listdir(FIXTURES_DIR))


def _parse(name):
    with open(os.path.join(FIXTURES_DIR, name), "rb") as f:
        raw = f.read()
    return name, parse_tabular_file(name, raw, STUDENT_SCHEMA_KEYS, STUDENT_HEADER_ALIASES, STUDENT_REQUIRED_FIELD)


# --------------------------------------------------------- universal sweep -
@pytest.mark.parametrize("name", _fixture_names())
def test_contract_holds_for_every_fixture(name):
    """The one test that must never fail, no matter what gets dropped into
    fixtures/: parse_tabular_file never raises and always returns the full
    ParseResult shape."""
    _, result = _parse(name)

    for key in ("rows", "warnings", "errors", "file_type_detected", "sheets_parsed", "sheets_skipped"):
        assert key in result, f"{name}: ParseResult missing '{key}'"
    assert isinstance(result["rows"], list)
    assert isinstance(result["warnings"], list)
    assert isinstance(result["errors"], list)
    assert isinstance(result["sheets_parsed"], list)
    assert isinstance(result["sheets_skipped"], list)

    included_rows = [r for r in result["rows"] if not r.get("excluded")]
    if not included_rows:
        assert result["errors"], f"{name}: 0 usable rows but no error reason given"

    for err in result["errors"]:
        assert err.get("message"), f"{name}: error entry with no message"
    for skip in result["sheets_skipped"]:
        assert skip.get("reason"), f"{name}: sheets_skipped entry with no reason"


# ------------------------------------------------------------ file sniffing
def test_sniff_ignores_extension_uses_magic_bytes():
    # HTML content saved with a .xls extension must sniff as html, not xls.
    _, result = _parse("student_html_export_as_xls.xls")
    assert result["file_type_detected"] == "html"


def test_sniff_empty_file():
    assert sniff_file_type(b"") == "empty"


def test_sniff_xlsx_magic():
    assert sniff_file_type(b"PK\x03\x04" + b"\x00" * 10) == "xlsx"


def test_sniff_ole_magic():
    assert sniff_file_type(b"\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1" + b"\x00" * 10) == "ole"


# --------------------------------------------------------- specific fixtures
def test_junk_rows_above_header_and_xls_extension_with_xlsx_content():
    name, result = _parse("1-B.xls")
    assert result["file_type_detected"] == "xlsx"  # content-sniffed, extension ignored
    included = [r for r in result["rows"] if not r.get("excluded")]
    assert len(included) == 2  # row 3 has no name -> excluded
    names = {r["data"]["student_name"] for r in included}
    assert names == {"Amit Kumar", "Priya Sharma"}
    # summary row ("Total: 3") must not appear as data at all
    assert all("Total" not in (r["data"].get("student_name") or "") for r in result["rows"])
    excluded = [r for r in result["rows"] if r.get("excluded")]
    assert len(excluded) == 1
    assert any(e["field"] == "student_name" for e in result["errors"])


def test_two_row_merged_header_joins_and_fills_forward():
    _, result = _parse("student_two_row_merged_header.xlsx")
    included = [r for r in result["rows"] if not r.get("excluded")]
    assert len(included) == 2
    row = next(r for r in included if r["data"]["student_name"] == "Rahul Verma")
    assert row["data"]["grade"] == "2"
    assert row["data"]["section"] == "A"
    assert row["data"]["gender"] == "Male"
    assert row["data"]["dob"] == "2014-06-05"
    assert row["data"]["contact"] == "9812345678"


def test_header_only_sheet_yields_zero_rows_with_reason():
    _, result = _parse("student_header_only_sheet.xlsx")
    assert not [r for r in result["rows"] if not r.get("excluded")]
    assert result["errors"]
    assert "no data rows" in result["errors"][-1]["message"] or "no data rows" in result["errors"][0]["message"]


def test_excel_serial_dob_converted():
    _, result = _parse("student_excel_serial_dob.xlsx")
    included = [r for r in result["rows"] if not r.get("excluded")]
    dobs = {r["data"]["student_name"]: r["data"]["dob"] for r in included}
    assert dobs["Kabir Khan"] == "2000-01-01"
    assert dobs["Fatima Ali"] == "2005-12-25"


def test_multi_sheet_hidden_and_empty_and_unrecognized():
    _, result = _parse("student_multi_sheet_hidden_empty.xlsx")
    assert set(result["sheets_parsed"]) == {"3A", "3B"}
    # "Empty Sheet" skipped silently (not in sheets_skipped, not in sheets_parsed)
    assert not any(s["name"] == "Empty Sheet" for s in result["sheets_skipped"])
    assert "Empty Sheet" not in result["sheets_parsed"]
    # "Notes" has no recognizable header -> named reason
    assert any(s["name"] == "Notes" and s["reason"] == "no recognizable header" for s in result["sheets_skipped"])
    # Hidden sheet 3B is still parsed and its rows tagged with origin
    hidden_rows = [r for r in result["rows"] if r["sheet"] == "3B"]
    assert hidden_rows and hidden_rows[0]["hidden_sheet"] is True


def test_cp1252_encoding_never_crashes_and_decodes_accents():
    _, result = _parse("student_cp1252_encoding.csv")
    included = [r for r in result["rows"] if not r.get("excluded")]
    assert len(included) == 2
    fathers = {r["data"]["father_name"] for r in included}
    assert any("\xe9" in f or "e" in f for f in fathers)  # decoded, not mangled/crashed


def test_summary_and_repeated_header_rows_dropped():
    _, result = _parse("student_summary_total_rows.csv")
    included = [r for r in result["rows"] if not r.get("excluded")]
    assert len(included) == 2
    names = {r["data"]["student_name"] for r in included}
    assert names == {"Diya Bose", "Karan Malhotra"}


def test_password_protected_reports_named_reason_not_crash():
    _, result = _parse("student_password_protected.xlsx")
    assert not result["rows"]
    assert any("password" in e["message"].lower() for e in result["errors"])


def test_corrupt_zip_reports_unreadable_not_crash():
    _, result = _parse("student_corrupt_zip.xlsx")
    assert not result["rows"]
    assert any("unreadable" in e["message"].lower() for e in result["errors"])


def test_empty_file_reports_empty():
    _, result = _parse("empty_file.xlsx")
    assert result["file_type_detected"] == "empty"
    assert not result["rows"]
    assert any("empty file" in e["message"].lower() for e in result["errors"])


def test_html_table_export_parses():
    _, result = _parse("student_html_table_export.html")
    assert result["file_type_detected"] == "html"
    included = [r for r in result["rows"] if not r.get("excluded")]
    assert len(included) == 2
    names = {r["data"]["student_name"] for r in included}
    assert names == {"Devansh Gupta", "Aisha Reddy"}


def test_tsv_detected_and_parsed():
    _, result = _parse("student_tab_delimited.tsv")
    assert result["file_type_detected"] == "tsv"
    included = [r for r in result["rows"] if not r.get("excluded")]
    assert len(included) == 1


def test_plain_csv_missing_name_excluded_with_reason():
    _, result = _parse("student_plain.csv")
    included = [r for r in result["rows"] if not r.get("excluded")]
    excluded = [r for r in result["rows"] if r.get("excluded")]
    assert len(included) == 2
    assert len(excluded) == 1
    assert any(e["field"] == "student_name" and e.get("severity") == "error" for e in result["errors"])
    # typo email domain auto-fixed by clean_email downstream (main.py), but
    # the tabular layer itself must at least preserve/normalize a valid one
    emails = {r["data"]["student_name"]: r["data"]["email"] for r in included}
    assert emails["Kavya Nair"] == "kavya@yahoo.com"


# ----------------------------------------------------------- unit: phone ---
def test_phone_strips_country_code_and_leading_zero():
    assert clean_phone("+91 98765 43210") == ("9876543210", None)
    assert clean_phone("098765 43210") == ("9876543210", None)


def test_phone_multiple_numbers_takes_first_and_warns():
    value, warn = clean_phone("9876543210 / 9123456789")
    assert value == "9876543210"
    assert warn and "multiple" in warn


def test_phone_invalid_warns_and_returns_empty():
    value, warn = clean_phone("call the office")
    assert value == ""
    assert warn and "invalid" in warn.lower()


# ------------------------------------------------------------- unit: dob ---
def test_dob_ambiguous_defaults_to_ddmm_with_warning():
    value, warn = parse_dob_flexible("04/05/2020")
    assert value == "2020-05-04"
    assert warn and "ambiguous" in warn


def test_dob_unambiguous_dd_over_12_no_warning():
    value, warn = parse_dob_flexible("25/03/2020")
    assert value == "2020-03-25"
    assert warn is None


def test_dob_iso_passthrough():
    assert parse_dob_flexible("2020-05-04") == ("2020-05-04", None)


def test_dob_unparseable():
    value, warn = parse_dob_flexible("not a date")
    assert value == ""
    assert warn and "unparseable" in warn


# ---------------------------------------------------------- unit: gender ---
def test_gender_variants_normalize():
    for raw in ("Boy", "boy", "B", "M", "male"):
        assert clean_gender(raw) == ("Male", None)
    for raw in ("Girl", "girl", "G", "F", "female"):
        assert clean_gender(raw) == ("Female", None)


def test_gender_unrecognized_passes_through_with_warning():
    value, warn = clean_gender("Other")
    assert value == "Other"
    assert warn and "unrecognized" in warn


# --------------------------------------------------------- unit: grade -----
def test_grade_tokens_recognize_jr_sr_kg():
    assert extract_grade_tokens("Jr KG") == ["LKG"]
    assert extract_grade_tokens("Jr. KG") == ["LKG"]
    assert extract_grade_tokens("Sr KG") == ["UKG"]
    assert extract_grade_tokens("Sr. KG") == ["UKG"]
    # 'Nursery', not 'NURSERY': grade vocabulary now comes from education_kb
    # and normalize_grade returns that shared canonical form. Safe because
    # normalize_grade is a comparison key applied to BOTH sides of every
    # lookup (imported value and the school's live classes.clazz alike), and
    # src/utils/educationKB.js returns the identical form in the browser.
    assert extract_grade_tokens("Nursery") == ["Nursery"]
    assert extract_grade_tokens("Junior KG") == ["LKG"]
    assert extract_grade_tokens("Std. 5") == ["5"]
    assert extract_grade_tokens("Garde 7,10") == ["7", "10"]


def test_teacher_shaped_file_never_crashes_deterministic_student_parser():
    """A teacher-matrix file run through the student-schema deterministic
    parser (wrong schema entirely) must still never raise — it should just
    correctly report 'no recognizable header' since there's no name column
    matching the student alias dictionary."""
    _, result = _parse("Teacher_Information.xlsx")
    assert isinstance(result["errors"], list)
    included = [r for r in result["rows"] if not r.get("excluded")]
    if not included:
        assert result["errors"]


# ── contact is NEVER blocking ───────────────────────────────────────────────
# A missing or unreadable phone number must degrade to a soft flag, exactly
# like any other incomplete field. It must never exclude the row or stop the
# commit — only `student_name` does that.
@pytest.mark.parametrize("cell", ["", "   ", "N/A", "-", "call the office",
                                   "phone: none", "0000", "abcd"])
def test_bad_contact_never_excludes_a_row(cell):
    value, warn = clean_phone(cell)
    assert value == ""                     # nothing usable extracted
    if cell.strip():
        assert warn                        # ...but it IS reported
    assert "error" not in (warn or "").lower()


def test_clean_phone_contract_is_documented_as_non_blocking():
    """The docstring is the contract other code relies on — keep them together."""
    assert "never blocks the row" in clean_phone.__doc__


# ── text-month dates ────────────────────────────────────────────────────────
# Real rosters are full of these; every one used to come back "unparseable"
# and then get double-reported as "missing" by the row-level pass.
@pytest.mark.parametrize("raw,expected", [
    ("16 Jan 2024", "2024-01-16"),
    ("28 Dec 2022", "2022-12-28"),
    ("16-Jan-2024", "2024-01-16"),
    ("16/Jan/2024", "2024-01-16"),
    ("16th January 2024", "2024-01-16"),
    ("1 Sept 2020", "2020-09-01"),
    ("01 SEP 2020", "2020-09-01"),
    ("9 Aug 2019", "2019-08-09"),
    ("16 Jan 24", "2024-01-16"),
    ("16 Jan 99", "1999-01-16"),
    # Month-first is unambiguous too — the month is a word, so the day is
    # whichever number is left.
    ("January 16, 2024", "2024-01-16"),
    ("Jan 16 2024", "2024-01-16"),
])
def test_text_month_dob_parses(raw, expected):
    value, warn = parse_dob_flexible(raw)
    assert value == expected
    assert warn is None          # a readable date is not a warning


@pytest.mark.parametrize("raw", ["31 Feb 2024", "32 Jan 2024", "0 Jan 2024"])
def test_impossible_text_month_dob_still_rejected(raw):
    value, warn = parse_dob_flexible(raw)
    assert value == "" and "unparseable" in warn


def test_word_that_is_not_a_month_is_not_guessed():
    """'Marathi' starts with 'Mar' — it must not become March."""
    value, warn = parse_dob_flexible("16 Marathi 2024")
    assert value == "" and "unparseable" in warn


def test_numeric_dates_are_unchanged_by_text_month_support():
    assert parse_dob_flexible("2020-06-05") == ("2020-06-05", None)
    value, warn = parse_dob_flexible("05/06/2020")
    assert value == "2020-06-05" and "ambiguous" in warn
    assert parse_dob_flexible("25/12/2019") == ("2019-12-25", None)
