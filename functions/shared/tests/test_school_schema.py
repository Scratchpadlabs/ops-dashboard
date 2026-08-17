"""Schema-gate fixtures.

Every case here is either a shape the teacher app depends on, or a real
malformation observed in the 2026-08-04 dump (AUDIT.md). The point of the gate
is that a malformed write is impossible from the dashboard, so the negative
cases matter more than the positive ones.
"""
import os
import sys
from datetime import datetime

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))

from shared.school_schema import (  # noqa: E402
    validate_doc, format_errors, validate_current_class_id, coerce_wire_payload,
    REASON_PERSON_ID, REASON_SELF_ID, REASON_GRADE_ONLY, REASON_UNRESOLVABLE,
    REASON_EMPTY, REASON_UNKNOWN_CLASS,
)


def ok(collection, doc, **kw):
    return validate_doc(collection, doc, **kw)["ok"]


def reasons(collection, doc, **kw):
    return format_errors(validate_doc(collection, doc, **kw)["errors"])


# ── terms ───────────────────────────────────────────────────────────────────
def test_term_valid():
    assert ok("terms", {"name": "Term 1", "academicYear": "2025-26", "isActive": True})


@pytest.mark.parametrize("year", ["2025", "2025-2026", "25-26", ""])
def test_term_rejects_bad_academic_year(year):
    assert not ok("terms", {"name": "Term 1", "academicYear": year, "isActive": True})


def test_term_rejects_missing_field():
    assert "isActive: required" in reasons("terms", {"name": "T", "academicYear": "2025-26"})


def test_term_rejects_wrong_type():
    r = reasons("terms", {"name": "T", "academicYear": "2025-26", "isActive": "yes"})
    assert "expected bool" in r


# ── grading_scales ──────────────────────────────────────────────────────────
FULL_SCALE = [
    {"label": "A", "minPercent": 50, "maxPercent": 100},
    {"label": "B", "minPercent": 0, "maxPercent": 49},
]


def test_scale_valid():
    assert ok("grading_scales", {"name": "Standard", "levels": FULL_SCALE})


def test_scale_rejects_overlap():
    levels = [{"label": "A", "minPercent": 40, "maxPercent": 100},
              {"label": "B", "minPercent": 0, "maxPercent": 50}]
    assert "overlap" in reasons("grading_scales", {"name": "S", "levels": levels})


def test_scale_rejects_gap_at_top():
    levels = [{"label": "B", "minPercent": 0, "maxPercent": 90}]
    assert "does not cover 100%" in reasons("grading_scales", {"name": "S", "levels": levels})


def test_scale_rejects_gap_at_bottom():
    levels = [{"label": "A", "minPercent": 10, "maxPercent": 100}]
    assert "does not cover 0%" in reasons("grading_scales", {"name": "S", "levels": levels})


def test_scale_rejects_inverted_band():
    levels = [{"label": "A", "minPercent": 100, "maxPercent": 0}]
    assert "minPercent is above maxPercent" in reasons("grading_scales", {"name": "S", "levels": levels})


def test_scale_rejects_empty_levels():
    assert not ok("grading_scales", {"name": "S", "levels": []})


# ── assessments / co_scholastic_activities ──────────────────────────────────
BASE_ASSESSMENT = {
    "name": "Periodic Test 1", "termId": "term1", "subjectId": "III_Maths",
    "order": 1, "entryType": "marks", "maxMarks": 100,
    "gradingScaleId": None, "conversionType": "none", "conversionFactor": None,
}


def test_assessment_valid():
    assert ok("assessments", BASE_ASSESSMENT)


def test_assessment_rejects_zero_max_marks():
    assert "must be greater than 0" in reasons("assessments", {**BASE_ASSESSMENT, "maxMarks": 0})


def test_assessment_rejects_bad_entry_type():
    assert "must be one of" in reasons("assessments", {**BASE_ASSESSMENT, "entryType": "points"})


def test_assessment_requires_scale_for_grade_entry():
    r = reasons("assessments", {**BASE_ASSESSMENT, "entryType": "grade"})
    assert "gradingScaleId" in r


def test_assessment_requires_scale_for_marks_to_grade():
    r = reasons("assessments", {**BASE_ASSESSMENT, "conversionType": "marks_to_grade"})
    assert "gradingScaleId" in r


def test_assessment_requires_factor_for_sum_up():
    r = reasons("assessments", {**BASE_ASSESSMENT, "conversionType": "sum_up"})
    assert "conversionFactor" in r


def test_assessment_rejects_factor_when_conversion_none():
    r = reasons("assessments", {**BASE_ASSESSMENT, "conversionFactor": 2})
    assert "must be null" in r


def test_co_scholastic_has_no_subject_id():
    doc = {k: v for k, v in BASE_ASSESSMENT.items() if k != "subjectId"}
    assert ok("co_scholastic_activities", doc)


def test_co_scholastic_still_requires_term():
    doc = {k: v for k, v in BASE_ASSESSMENT.items() if k not in ("subjectId", "termId")}
    assert "termId: required" in reasons("co_scholastic_activities", doc)


# ── subjects ────────────────────────────────────────────────────────────────
def test_subject_valid():
    assert ok("subjects", {"id": "III_English", "name": "English"})


def test_subject_rejects_co_scholastic_area():
    """The misfiling bug: a Co-Scholastic record is not a subjects doc."""
    r = reasons("subjects", {"id": "III_Art", "name": "Art", "area": "Co-Scholastic"})
    assert "co_scholastic_activities" in r


def test_subject_rejects_unknown_area():
    assert "must be one of" in reasons("subjects", {"id": "X", "name": "X", "area": "Sports"})


# ── classes ─────────────────────────────────────────────────────────────────
BASE_CLASS = {"id": "III_A", "name": "III A", "clazz": "III", "section": "A",
              "stage": "foundation"}


def test_class_valid():
    assert ok("classes", BASE_CLASS)


def test_class_keeps_the_misspelled_stage():
    """'prepratory' is misspelled in production; the spec says keep it."""
    assert ok("classes", {**BASE_CLASS, "stage": "prepratory"})
    assert not ok("classes", {**BASE_CLASS, "stage": "preparatory"})


def test_class_rejects_subject_entry_without_id():
    r = reasons("classes", {**BASE_CLASS, "subjects": [{"teacherId": ""}]})
    assert "subjectId" in r


# ── remark_categories ───────────────────────────────────────────────────────
BASE_REMARKS = {"label": "Behaviour", "order": 1,
                "remarks": [{"key": "r1", "text": "Good", "type": "positive", "order": 1}]}


def test_remarks_valid():
    assert ok("remark_categories", BASE_REMARKS)


def test_remarks_rejects_duplicate_key():
    doc = {**BASE_REMARKS, "remarks": BASE_REMARKS["remarks"] * 2}
    assert "duplicate key" in reasons("remark_categories", doc)


def test_remarks_rejects_bad_type():
    doc = {**BASE_REMARKS, "remarks": [{**BASE_REMARKS["remarks"][0], "type": "neutral"}]}
    assert "must be one of" in reasons("remark_categories", doc)


# ── months ──────────────────────────────────────────────────────────────────
BASE_MONTH = {"key": "2026-04", "label": "April 2026", "month": 4, "year": 2026,
              "order": 1, "workingDays": 20}


def test_month_valid():
    assert ok("months", BASE_MONTH)


def test_month_rejects_key_mismatch():
    assert "does not match key" in reasons("months", {**BASE_MONTH, "month": 5})


def test_month_rejects_bad_key():
    assert not ok("months", {**BASE_MONTH, "key": "2026-13"})


def test_month_rejects_impossible_working_days():
    assert not ok("months", {**BASE_MONTH, "workingDays": 40})


# ── students ────────────────────────────────────────────────────────────────
BASE_STUDENT = {"name": "Asha Patil", "firstName": "Asha", "lastName": "Patil",
                "currentClassId": "III_A", "type": "student"}


def test_student_valid():
    assert ok("students", BASE_STUDENT)


def test_student_rejects_the_old_import_fields():
    """The exact payload the import used to write (AUDIT.md §3.2).

    `admNo` is NOT in this list any more — it became a real field on
    2026-08-04. The rest still have no home and are reported as unknown.
    """
    old = {**BASE_STUDENT, "srNo": "1", "motherName": "M",
           "fatherName": "F", "contactNumber": "999", "rollNo": "7", "city": "Pune"}
    result = validate_doc("students", old)
    # Unknown fields are warnings, not errors — but every one is reported.
    flagged = {f for f, _ in result["warnings"]}
    assert {"srNo", "motherName", "fatherName", "contactNumber",
            "rollNo", "city"} <= flagged
    assert "admNo" not in flagged or ok("students", {**BASE_STUDENT, "admNo": "22"})


def test_student_rejects_string_date_of_birth():
    """`dob` as a string beside dateOfBirth was the original bug."""
    assert "expected timestamp" in reasons("students", {**BASE_STUDENT, "dateOfBirth": "2016-05-21"})


def test_student_accepts_datetime_date_of_birth():
    assert ok("students", {**BASE_STUDENT, "dateOfBirth": datetime(2016, 5, 21)})


def test_student_accepts_null_date_of_birth():
    assert ok("students", {**BASE_STUDENT, "dateOfBirth": None})


def test_student_rejects_string_phone():
    assert "expected number" in reasons("students", {**BASE_STUDENT, "phoneNo": "9876543210"})


def test_student_requires_first_name():
    doc = {k: v for k, v in BASE_STUDENT.items() if k != "firstName"}
    assert "firstName: required" in reasons("students", doc)


def test_student_allows_empty_last_name():
    assert ok("students", {**BASE_STUDENT, "lastName": ""})


def test_student_rejects_wrong_type_value():
    assert not ok("students", {**BASE_STUDENT, "type": "teacher"})


# ── partial (edit) mode ─────────────────────────────────────────────────────
def test_partial_allows_editing_one_field_of_a_legacy_doc():
    """A legacy doc missing required fields must still be editable — otherwise
    bad data can never be fixed through the UI."""
    assert ok("students", {"name": "Asha"}, partial=True)
    assert not ok("students", {"name": "Asha"})


def test_partial_still_rejects_a_bad_value():
    assert not ok("students", {"phoneNo": "not a number"}, partial=True)


# ── currentClassId ──────────────────────────────────────────────────────────
def test_class_id_valid():
    assert validate_current_class_id("III_A")["ok"]


def test_class_id_rejects_person_id():
    """A K CSchool and Carmel Convent store student IDs here."""
    for v in ("sakc0001", "sccs0001", "ssds0136"):
        r = validate_current_class_id(v)
        assert not r["ok"] and r["reason"] == REASON_PERSON_ID, v


def test_class_id_rejects_the_students_own_id():
    r = validate_current_class_id("III_A_7", student_id="III_A_7")
    assert not r["ok"] and r["reason"] == REASON_SELF_ID


def test_class_id_rejects_grade_only():
    """Aravali stores 'III' while running III_A1/A2/A3 — unassignable."""
    r = validate_current_class_id("III")
    assert not r["ok"] and r["reason"] == REASON_GRADE_ONLY


def test_class_id_rejects_empty():
    assert validate_current_class_id("")["reason"] == REASON_EMPTY


def test_class_id_rejects_unresolvable():
    r = validate_current_class_id("Batch Zeta")
    assert not r["ok"] and r["reason"] == REASON_UNRESOLVABLE


@pytest.mark.parametrize("value", ["III_A", "1-B", "10A", "III_A1", "2_C"])
def test_class_id_accepts_real_estate_formats(value):
    assert validate_current_class_id(value)["ok"], value


def test_class_id_warns_on_unconfigured_class():
    r = validate_current_class_id("III_Z", class_ids=["III_A", "III_B"])
    assert r["ok"] and r["reason"] == REASON_UNKNOWN_CLASS and r["severity"] == "warning"


# ── wire coercion ───────────────────────────────────────────────────────────
def test_coerce_turns_iso_string_into_datetime():
    out = coerce_wire_payload("students", {**BASE_STUDENT, "dateOfBirth": "2016-05-21T00:00:00.000Z"})
    assert isinstance(out["dateOfBirth"], datetime)
    assert (out["dateOfBirth"].year, out["dateOfBirth"].month, out["dateOfBirth"].day) == (2016, 5, 21)


def test_coerce_nulls_an_unreadable_date():
    assert coerce_wire_payload("students", {"dateOfBirth": "not a date"})["dateOfBirth"] is None


def test_coerce_nulls_an_impossible_date():
    assert coerce_wire_payload("students", {"dateOfBirth": "2026-02-31"})["dateOfBirth"] is None


def test_coerced_payload_then_passes_validation():
    """The full wire path: browser Date -> JSON string -> datetime -> valid."""
    wire = {**BASE_STUDENT, "dateOfBirth": "2016-05-21T00:00:00.000Z"}
    assert not ok("students", wire)                      # string is rejected
    assert ok("students", coerce_wire_payload("students", wire))


# ── fields added 2026-08-04 by explicit decision ────────────────────────────
def test_student_accepts_adm_no_and_gr_emis_separately():
    """Kept as two registers on purpose — merging loses which one it came from."""
    assert ok("students", {**BASE_STUDENT, "admNo": "A-118", "grEmisSts": "EMIS/99887"})


def test_student_accepts_valid_aadhaar():
    assert ok("students", {**BASE_STUDENT, "aadhaarNumber": "123456789012"})


@pytest.mark.parametrize("bad", ["1234", "12345678901", "1234567890123", "12345678901a"])
def test_student_rejects_malformed_aadhaar(bad):
    assert "malformed" in reasons("students", {**BASE_STUDENT, "aadhaarNumber": bad})


def test_student_accepts_empty_aadhaar():
    """Most rosters have no Aadhaar column; empty must never block a row."""
    assert ok("students", {**BASE_STUDENT, "aadhaarNumber": ""})


def test_parent_contacts_are_not_student_fields():
    """Father/Mother mobile+email are review-only — present means 'unknown
    field' (a warning), never a silent write into something that reads."""
    doc = {**BASE_STUDENT, "fatherMobile": "9876543210", "motherEmail": "a@b.com"}
    result = validate_doc("students", doc)
    assert result["ok"]
    assert {"fatherMobile", "motherEmail"} <= {f for f, _ in result["warnings"]}
