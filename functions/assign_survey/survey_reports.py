#!/usr/bin/env python3
"""
Completion/pending report builders — pure row construction.

Three scopes, all sharing one status definition (survey_rules.student_status):
  class_wise   one row per student for the selected class(es), with a status
               column per survey
  survey_wise  one chosen survey, every student across the school, plus
               per-class summary rows
  cumulative   school-level: one row per class x survey with counts and
               completion %, plus school totals

Stdlib-only and side-effect free — main.py turns these rows into CSV/XLSX and
uploads the file. Keeping the row shapes here means the exact contents of a
report can be asserted in tests without Firebase or a spreadsheet library.

"Completed" comes from the survey's responses subcollection; "pending" is
assigned-but-no-response; a student who was never assigned is "not assigned"
and never counted as pending — that distinction is the whole point of the
report, so it lives in one function and is reused everywhere.
"""
from datetime import datetime, timezone

from survey_rules import (
    DEFAULT_INBOX_FIELD, STATUS_COMPLETED, STATUS_PENDING, STATUS_NOT_ASSIGNED,
    student_status, class_sort_key, student_sort_key, resolve_class_key,
)


def class_of(student):
    """The student's class group key — same resolution the matrix uses, so a
    downloaded report can never group differently from the grid it came
    from."""
    return resolve_class_key(student)[0]


def _pct(part, whole):
    return round(part / whole * 100, 1) if whole else 0.0


def report_header(scope, school_id, survey_labels, filters, generated_at=None):
    """The provenance line every report carries.

    A downloaded CSV outlives the screen it came from, so it has to say what
    it is: which school, which scope, which filters were active, and when it
    was generated. Without this a filtered export is indistinguishable from a
    full one three days later.
    """
    ts = (generated_at or datetime.now(timezone.utc)).strftime("%Y-%m-%d %H:%M UTC")
    bits = [f"School: {school_id}", f"Scope: {scope}", f"Generated: {ts}"]
    if survey_labels:
        bits.append(f"Surveys: {', '.join(survey_labels)}")
    active = [f"{k}={v}" for k, v in (filters or {}).items() if v not in (None, "", [], "all")]
    bits.append(f"Filters: {'; '.join(active) if active else 'none'}")
    return " | ".join(bits)


def class_wise_rows(students, survey_ids, survey_labels, responders_by_survey,
                    inbox_field=DEFAULT_INBOX_FIELD):
    """One row per student; one status column per survey."""
    rows = []
    for s in sorted(students, key=student_sort_key):
        row = {
            "Student": s.get("name") or s.get("id"),
            "Roll No": s.get("rollNo") or "",
            "Class": class_of(s),
        }
        for sid in survey_ids:
            row[survey_labels.get(sid, sid)] = student_status(
                s, sid, responders_by_survey.get(sid), inbox_field)
        rows.append(row)
    return rows


def survey_wise_rows(students, survey_id, survey_label, responders_by_survey,
                     inbox_field=DEFAULT_INBOX_FIELD):
    """Every student's status on one survey, plus per-class summary rows.

    Returns (detail_rows, summary_rows) so the caller can put them on
    separate sheets in XLSX and stack them in CSV.
    """
    responders = responders_by_survey.get(survey_id) or set()
    detail = []
    per_class = {}

    for s in sorted(students, key=student_sort_key):
        status = student_status(s, survey_id, responders, inbox_field)
        detail.append({
            "Student": s.get("name") or s.get("id"),
            "Roll No": s.get("rollNo") or "",
            "Class": class_of(s),
            "Survey": survey_label,
            "Status": status,
        })
        c = per_class.setdefault(class_of(s),
                                  {"students": 0, "assigned": 0, "completed": 0, "pending": 0})
        c["students"] += 1
        if status != STATUS_NOT_ASSIGNED:
            c["assigned"] += 1
        if status == STATUS_COMPLETED:
            c["completed"] += 1
        elif status == STATUS_PENDING:
            c["pending"] += 1

    summary = []
    for class_id in sorted(per_class, key=class_sort_key):
        c = per_class[class_id]
        summary.append({
            "Class": class_id,
            "Students": c["students"],
            "Assigned": c["assigned"],
            "Completed": c["completed"],
            "Pending": c["pending"],
            "Not Assigned": c["students"] - c["assigned"],
            # Completion is measured against ASSIGNED, not roll strength —
            # a class that was never assigned the survey is 0/0, not 0%
            # of its whole roster, and shouldn't read as a failure.
            "Completion %": _pct(c["completed"], c["assigned"]),
        })

    totals = {
        "Class": "SCHOOL TOTAL",
        "Students": sum(c["students"] for c in per_class.values()),
        "Assigned": sum(c["assigned"] for c in per_class.values()),
        "Completed": sum(c["completed"] for c in per_class.values()),
        "Pending": sum(c["pending"] for c in per_class.values()),
    }
    totals["Not Assigned"] = totals["Students"] - totals["Assigned"]
    totals["Completion %"] = _pct(totals["Completed"], totals["Assigned"])
    summary.append(totals)

    return detail, summary


def cumulative_rows(students, survey_ids, survey_labels, responders_by_survey,
                    inbox_field=DEFAULT_INBOX_FIELD):
    """One row per (class, survey) with counts and completion %, plus totals."""
    by_class = {}
    for s in students:
        by_class.setdefault(class_of(s), []).append(s)

    rows = []
    grand = {sid: {"students": 0, "assigned": 0, "completed": 0, "pending": 0} for sid in survey_ids}

    for class_id in sorted(by_class, key=class_sort_key):
        members = by_class[class_id]
        for sid in survey_ids:
            responders = responders_by_survey.get(sid) or set()
            assigned = completed = pending = 0
            for st in members:
                status = student_status(st, sid, responders, inbox_field)
                if status == STATUS_NOT_ASSIGNED:
                    continue
                assigned += 1
                if status == STATUS_COMPLETED:
                    completed += 1
                else:
                    pending += 1
            rows.append({
                "Class": class_id,
                "Survey": survey_labels.get(sid, sid),
                "Students": len(members),
                "Assigned": assigned,
                "Completed": completed,
                "Pending": pending,
                "Not Assigned": len(members) - assigned,
                "Completion %": _pct(completed, assigned),
            })
            g = grand[sid]
            g["students"] += len(members)
            g["assigned"] += assigned
            g["completed"] += completed
            g["pending"] += pending

    for sid in survey_ids:
        g = grand[sid]
        rows.append({
            "Class": "SCHOOL TOTAL",
            "Survey": survey_labels.get(sid, sid),
            "Students": g["students"],
            "Assigned": g["assigned"],
            "Completed": g["completed"],
            "Pending": g["pending"],
            "Not Assigned": g["students"] - g["assigned"],
            "Completion %": _pct(g["completed"], g["assigned"]),
        })

    return rows


def rows_to_csv(rows, header_line=None, extra_blocks=None):
    """Rows (list of dicts) -> CSV text. `extra_blocks` appends further
    (title, rows) sections after a blank line, which is how survey-wise fits
    its per-class summary into a single flat file."""
    import csv
    import io

    out = io.StringIO()
    if header_line:
        out.write(f"# {header_line}\n")

    if rows:
        writer = csv.DictWriter(out, fieldnames=list(rows[0].keys()), extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)
    else:
        out.write("(no rows matched the selected scope and filters)\n")

    for title, block in (extra_blocks or []):
        out.write("\n")
        out.write(f"# {title}\n")
        if block:
            w = csv.DictWriter(out, fieldnames=list(block[0].keys()), extrasaction="ignore")
            w.writeheader()
            w.writerows(block)

    return out.getvalue()
