"""sheet_tables.py must lay reports out exactly like the teacher app's export
(scratchpad_teacher src/views/smart-sheets/exportSheet.ts) — a school gets the
same file whether ops or their own admin downloads it."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sheet_tables import (  # noqa: E402
    STUDENT_HEADERS, attendance_table, col_group, convert_value, flat_table, pick_sheet,
    sort_students, student_row, subject_table,
)

LEVELS = [{"label": "C", "minPercent": 0, "maxPercent": 59},
          {"label": "B", "minPercent": 60, "maxPercent": 79},
          {"label": "A", "minPercent": 80, "maxPercent": 100}]
ID_COLS = len(STUDENT_HEADERS)


def test_convert_value_matches_teacher_rules():
    rule = {"maxMarks": 20, "conversionType": "marks_to_grade", "gradingLevels": LEVELS}
    assert convert_value(17, rule) == "A"
    assert convert_value(15.9, rule) == "B"      # 79.5% falls in the 79/80 gap -> band reached
    assert convert_value("AB", rule) == "AB"
    assert convert_value(None, rule) is None
    assert convert_value(15, {"maxMarks": 20, "conversionType": "sum_down", "conversionFactor": 2}) == "7.5"
    assert convert_value(12, {"maxMarks": 20, "conversionType": "sum_up", "conversionFactor": 0}) is None
    assert convert_value(12, {"maxMarks": 20, "conversionType": "none"}) == "12"


def test_col_group_labels():
    marks = col_group({"id": "a1", "name": "UT1", "entryType": "marks", "maxMarks": 20,
                       "conversionType": "marks_to_grade"}, LEVELS)
    assert [sc["label"] for sc in marks["subCols"]] == ["Marks (out of 20)", "Converted (C/B/A)"]
    down = col_group({"id": "a2", "name": "T", "entryType": "marks", "maxMarks": 80,
                      "conversionType": "sum_down", "conversionFactor": 4}, [])
    assert down["subCols"][1]["label"] == "Converted (out of 20)"
    grade = col_group({"id": "a3", "name": "Art", "entryType": "grades"}, LEVELS)
    assert [sc["label"] for sc in grade["subCols"]] == ["Grade"]


def test_students_sorted_by_roll_then_name():
    rows = [student_row("s3", {"name": "Zed"}), student_row("s1", {"name": "Bo", "rollNo": "10"}),
            student_row("s2", {"firstName": "Al", "lastName": "K", "rollNo": 2}), student_row("s4", {"name": "Al"})]
    assert [s["id"] for s in sort_students(rows)] == ["s2", "s1", "s4", "s3"]
    assert rows[2]["name"] == "Al K" and rows[0]["rollNo"] == "—"


def test_subject_table_layout_and_values():
    ut = col_group({"id": "ut", "name": "UT1", "entryType": "marks", "maxMarks": 20,
                    "conversionType": "marks_to_grade"}, LEVELS)
    art = col_group({"id": "ar", "name": "Project", "entryType": "grades"}, [])
    students = [student_row("s1", {"name": "Asha", "rollNo": 1, "admNo": "A1"})]
    t = subject_table([
        {"name": "English", "groups": [ut], "entries": {"s1": {"ut": {"value": 17, "converted": None}}}},
        {"name": "Empty", "groups": [], "entries": {}},       # no columns -> left out
        {"name": "Art", "groups": [art], "entries": {}},
    ], students)
    h1, h2, h3 = t["header"]
    assert h1[ID_COLS:] == ["English", "", "Art"]
    assert h2[ID_COLS:] == ["UT1", "", "Project"]
    assert h3[ID_COLS:] == ["Marks (out of 20)", "Converted (C/B/A)", "Grade"]
    assert [0, ID_COLS, 0, ID_COLS + 1] in t["merges"] and [1, ID_COLS, 1, ID_COLS + 1] in t["merges"]
    assert [0, 0, 2, 0] in t["merges"]                     # identity labels merged down
    assert t["rows"] == [["s1", "A1", "", 1, "Asha", 17, "A", ""]]


def test_flat_table_missing_entry_and_legacy_scalar():
    g = col_group({"id": "x", "name": "Sports", "entryType": "marks", "maxMarks": 10,
                   "conversionType": "sum_up", "conversionFactor": 2}, [])
    students = [student_row("s1", {"name": "A", "rollNo": 1}), student_row("s2", {"name": "B", "rollNo": 2})]
    t = flat_table([g], students, {"s1": {"x": 4}})
    assert t["header"][0][ID_COLS:] == ["Sports", ""]
    assert t["rows"][0][ID_COLS:] == [4, "8"]
    assert t["rows"][1][ID_COLS:] == ["", "—"]


def test_attendance_table():
    months = [{"key": "2026-06", "label": "June 2026", "workingDays": 12},
              {"key": "2026-07", "label": "July 2026", "workingDays": 25}]
    t = attendance_table(months, [student_row("s1", {"name": "A", "rollNo": 1})], {"s1": {"2026-06": 11}})
    assert t["header"][0][ID_COLS:] == ["June 2026", "July 2026"]
    assert t["header"][1][ID_COLS:] == ["Working Days (12)", "Working Days (25)"]
    assert t["rows"][0][ID_COLS:] == [11, ""]


def test_pick_sheet_prefers_most_entries_then_deterministic_id():
    assert pick_sheet([], "x") is None
    assert pick_sheet([("old", 5), ("x", 3)], "x") == "old"
    assert pick_sheet([("old", 3), ("x", 3)], "x") == "x"
