"""
Smart Sheets → spreadsheet tables, for the consolidated Academics /
Co-Scholastic / Attendance reports (the smart_sheets_export callable).

A port of the teacher app's own export (scratchpad_teacher
src/views/smart-sheets/exportSheet.ts + marksConversion.ts), so a report
downloaded here has the same columns and the same converted values as the one
a school admin downloads in the teacher app. Change one, change both.

Each builder returns a table: {"header": [[...], ...], "merges": [[r1, c1, r2, c2], ...],
"rows": [[...], ...]} — header rows and data rows the same width, merges as
0-based inclusive cell ranges within the header. The dashboard writes it to
Excel as-is.

Kept free of Firestore so it can be tested without credentials.
"""
from __future__ import annotations

import math
import re

# Identity columns every export starts with — same as the teacher app's.
STUDENT_HEADERS = ["ID", "Admission No.", "GR/EMIS No.", "Roll No.", "Student Name"]

_LEADING_NUMBER = re.compile(r"^\s*[-+]?(\d+\.?\d*|\.\d+)")


# ── values ───────────────────────────────────────────────────────────────────

def unwrap_entry(raw):
    """Legacy entries are a bare scalar; newer ones are {value, converted}."""
    if isinstance(raw, dict):
        return raw.get("value"), raw.get("converted")
    return raw, None


def _js_round2(x: float) -> float:
    # JS Math.round(x * 100) / 100 — rounds halves up, unlike Python's round().
    return math.floor(x * 100 + 0.5) / 100


def _js_str(x: float) -> str:
    """String(number) as JS prints it: 12 not 12.0."""
    return str(int(x)) if float(x).is_integer() else repr(float(x))


def _parse_float(value):
    """parseFloat(String(value)): the leading number, or None."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    m = _LEADING_NUMBER.match(str(value))
    return float(m.group(0)) if m else None


def convert_value(value, rule: dict):
    """marksConversion.ts convertValue: a raw mark -> its converted value/grade."""
    if value is None:
        return None
    if value in ("AB", "Medical"):
        return str(value)
    num = _parse_float(value)
    if num is None or math.isnan(num):
        return None
    ctype = rule.get("conversionType") or "none"
    if ctype == "none":
        return _js_str(num)
    if ctype == "marks_to_grade":
        max_marks = rule.get("maxMarks") or 0
        pct = (num / max_marks) * 100 if max_marks > 0 else 0
        levels = rule.get("gradingLevels") or []
        level = next((lv for lv in levels
                      if pct >= lv.get("minPercent", 0) and pct <= lv.get("maxPercent", 0)), None)
        if level is None:
            # A decimal % in the gap between whole-number bands (79.5) gets the
            # band it has reached.
            reached = [lv for lv in levels if pct >= lv.get("minPercent", 0)]
            level = max(reached, key=lambda lv: lv.get("minPercent", 0)) if reached else None
        return level.get("label") if level else None
    factor = rule.get("conversionFactor")
    factor = 1 if factor is None else factor
    valid = isinstance(factor, (int, float)) and not isinstance(factor, bool) \
        and math.isfinite(factor) and factor > 0
    if ctype == "sum_up":
        return _js_str(_js_round2(num * factor)) if valid else None
    if ctype == "sum_down":
        return _js_str(_js_round2(num / factor)) if valid else None
    return None


# ── column groups ────────────────────────────────────────────────────────────

def col_group(item: dict, grading_levels: list) -> dict:
    """One assessment / activity -> its column group, as the teacher app builds it."""
    max_marks = item.get("maxMarks") or 0
    ctype = item.get("conversionType") or "none"
    factor = item.get("conversionFactor")
    sub_cols = []
    if item.get("entryType") == "marks":
        sub_cols.append({"label": f"Marks (out of {_js_str(max_marks)})", "type": "marks"})
        if ctype != "none":
            label = "Converted"
            if ctype == "marks_to_grade" and grading_levels:
                label = f"Converted ({'/'.join(str(lv.get('label', '')) for lv in grading_levels)})"
            elif ctype == "sum_up" and factor:
                label = f"Converted (out of {_js_str(_js_round2(max_marks * factor))})"
            elif ctype == "sum_down" and factor:
                label = f"Converted (out of {_js_str(_js_round2(max_marks / factor))})"
            sub_cols.append({"label": label, "type": "converted"})
    else:
        sub_cols.append({"label": "Grade", "type": "grade"})
    return {
        "id": item["id"], "name": item.get("name") or item["id"],
        "rule": {"maxMarks": max_marks, "conversionType": ctype,
                 "conversionFactor": factor, "gradingLevels": grading_levels},
        "subCols": sub_cols,
    }


def _cell(entry, group, sub_col):
    value, converted = unwrap_entry(entry)
    if sub_col["type"] == "converted":
        if converted is not None:
            return converted
        conv = convert_value(value, group["rule"])
        return conv if conv is not None else "—"
    return "" if value is None else value


# ── students ─────────────────────────────────────────────────────────────────

def _roll(raw):
    if raw is None or raw == "" or isinstance(raw, bool):
        return None
    try:
        n = float(raw)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(n) else n


def student_row(student_id: str, data: dict) -> dict:
    """Identity of one student doc, as the export shows it."""
    name = data.get("name") or " ".join(
        p for p in (str(data.get("firstName") or "").strip(), str(data.get("lastName") or "").strip()) if p
    ) or student_id
    roll = data.get("rollNo")
    return {
        "id": student_id, "name": name, "rollRaw": roll,
        "rollNo": roll if roll not in (None, "") else "—",
        "admNo": data.get("admNo") or "", "grEmisSts": data.get("grEmisSts") or "",
    }


def sort_students(students: list) -> list:
    """Teacher app's compareByRollThenId: numeric roll first, then name, then id."""
    def key(s):
        r = _roll(s.get("rollRaw"))
        return (0, r, "", "") if r is not None else (1, 0, s["name"], s["id"])
    return sorted(students, key=key)


def _identity(s):
    return [s["id"], s["admNo"], s["grEmisSts"], s["rollNo"], s["name"]]


def _identity_merges(header_rows: int) -> list:
    if header_rows < 2:
        return []
    return [[0, c, header_rows - 1, c] for c in range(len(STUDENT_HEADERS))]


# ── tables ───────────────────────────────────────────────────────────────────

def flat_table(groups: list, students: list, entries: dict) -> dict:
    """Assessment/activity -> sub-column. Co-Scholastic (no subject level).
    entries: {studentId: {itemId: raw entry}}"""
    h1, h2 = list(STUDENT_HEADERS), [""] * len(STUDENT_HEADERS)
    merges = _identity_merges(2)
    col = len(STUDENT_HEADERS)
    for g in groups:
        n = len(g["subCols"])
        h1 += [g["name"]] + [""] * (n - 1)
        if n > 1:
            merges.append([0, col, 0, col + n - 1])
        h2 += [sc["label"] for sc in g["subCols"]]
        col += n
    rows = []
    for s in students:
        row = _identity(s)
        mine = entries.get(s["id"], {})
        for g in groups:
            row += [_cell(mine.get(g["id"]), g, sc) for sc in g["subCols"]]
        rows.append(row)
    return {"header": [h1, h2], "merges": merges, "rows": rows}


def subject_table(subjects: list, students: list) -> dict:
    """Subject -> assessment -> sub-column. Academics.
    subjects: [{name, groups, entries: {studentId: {assessmentId: raw}}}]"""
    h1, h2, h3 = list(STUDENT_HEADERS), [""] * len(STUDENT_HEADERS), [""] * len(STUDENT_HEADERS)
    merges = _identity_merges(3)
    col = len(STUDENT_HEADERS)
    kept = []
    for subj in subjects:
        width = sum(len(g["subCols"]) for g in subj["groups"])
        if not width:
            continue
        kept.append(subj)
        h1 += [subj["name"]] + [""] * (width - 1)
        if width > 1:
            merges.append([0, col, 0, col + width - 1])
        c = col
        for g in subj["groups"]:
            n = len(g["subCols"])
            h2 += [g["name"]] + [""] * (n - 1)
            if n > 1:
                merges.append([1, c, 1, c + n - 1])
            h3 += [sc["label"] for sc in g["subCols"]]
            c += n
        col += width
    rows = []
    for s in students:
        row = _identity(s)
        for subj in kept:
            mine = subj["entries"].get(s["id"], {})
            for g in subj["groups"]:
                row += [_cell(mine.get(g["id"]), g, sc) for sc in g["subCols"]]
        rows.append(row)
    return {"header": [h1, h2, h3], "merges": merges, "rows": rows}


def attendance_table(months: list, students: list, entries: dict) -> dict:
    """Month-wise attendance: days present per month, with working days.
    months: [{key, label, workingDays}]; entries: {studentId: {monthKey: present}}"""
    h1 = list(STUDENT_HEADERS) + [m["label"] for m in months]
    h2 = [""] * len(STUDENT_HEADERS) + [f"Working Days ({_js_str(m.get('workingDays') or 0)})" for m in months]
    rows = []
    for s in students:
        mine = entries.get(s["id"], {})
        rows.append(_identity(s) + ["" if mine.get(m["key"]) is None else mine.get(m["key"]) for m in months])
    return {"header": [h1, h2], "merges": _identity_merges(2), "rows": rows}


def pick_sheet(candidates: list, preferred_id: str):
    """Teacher app's pickSheetDoc: among duplicate sheet docs, the one with the
    most entries; ties go to the deterministic id. candidates: [(id, entry_count)]"""
    if not candidates:
        return None
    best = candidates[0]
    for cand in candidates[1:]:
        if cand[1] > best[1] or (cand[1] == best[1] and cand[0] == preferred_id):
            best = cand
    return best[0]
