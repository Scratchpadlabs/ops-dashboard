#!/usr/bin/env python3
"""Emit the Python side of the school-schema parity check.

Writes tools/.schema_fixtures.json — the declared shape plus a verdict for
every fixture — which tools/check_schema_parity.mjs then reproduces in JS.

    python3 tools/check_schema_parity.py
    node    tools/check_schema_parity.mjs

See check_schema_parity.mjs for why the two implementations exist.
"""
import json
import os
import sys
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "functions", "shared"))

from school_schema import SCHOOL_SCHEMAS, validate_doc  # noqa: E402

OUT = os.path.join(ROOT, "tools", ".schema_fixtures.json")

# A timestamp cannot survive JSON, so it travels tagged and the JS side revives
# it. Everything else is plain JSON.
TS = {"__timestamp__": "2016-05-21T00:00:00.000Z"}

BASE = {
    "terms": {"name": "Term 1", "academicYear": "2025-26", "isActive": True},
    "grading_scales": {"name": "Standard", "levels": [
        {"label": "A", "minPercent": 50, "maxPercent": 100},
        {"label": "B", "minPercent": 0, "maxPercent": 49}]},
    "subjects": {"id": "III_English", "name": "English"},
    "classes": {"id": "III_A", "name": "III A", "clazz": "III", "section": "A",
                "stage": "foundation"},
    "assessments": {"name": "PT1", "termId": "term1", "subjectId": "III_Maths",
                    "order": 1, "entryType": "marks", "maxMarks": 100,
                    "gradingScaleId": None, "conversionType": "none",
                    "conversionFactor": None},
    "co_scholastic_activities": {"name": "Art", "termId": "term1", "order": 1,
                                 "entryType": "marks", "maxMarks": 10,
                                 "gradingScaleId": None, "conversionType": "none",
                                 "conversionFactor": None},
    "remark_categories": {"label": "Behaviour", "order": 1, "remarks": [
        {"key": "r1", "text": "Good", "type": "positive", "order": 1}]},
    "months": {"key": "2026-04", "label": "April 2026", "month": 4, "year": 2026,
               "order": 1, "workingDays": 20},
    "students": {"name": "Asha Patil", "firstName": "Asha", "lastName": "Patil",
                 "currentClassId": "III_A", "type": "student"},
    "staffs": {"id": "t1", "staffId": "t1", "name": "R K", "firstName": "R",
               "lastName": "K", "type": "teacher"},
}


def mutate(collection, label, **changes):
    doc = dict(BASE[collection])
    for k, v in changes.items():
        if v is ...:
            doc.pop(k, None)
        else:
            doc[k] = v
    return {"collection": collection, "label": label, "doc": doc}


FIXTURES = [{"collection": c, "label": "baseline", "doc": dict(d)} for c, d in BASE.items()] + [
    mutate("terms", "bad academicYear", academicYear="2025"),
    mutate("terms", "missing isActive", isActive=...),
    mutate("terms", "isActive wrong type", isActive="yes"),
    mutate("grading_scales", "overlapping bands", levels=[
        {"label": "A", "minPercent": 40, "maxPercent": 100},
        {"label": "B", "minPercent": 0, "maxPercent": 50}]),
    mutate("grading_scales", "gap at top", levels=[
        {"label": "B", "minPercent": 0, "maxPercent": 90}]),
    mutate("grading_scales", "empty levels", levels=[]),
    mutate("subjects", "co-scholastic area", area="Co-Scholastic"),
    mutate("subjects", "unknown area", area="Sports"),
    mutate("classes", "misspelled stage kept", stage="prepratory"),
    mutate("classes", "corrected spelling rejected", stage="preparatory"),
    mutate("classes", "subject without id", subjects=[{"teacherId": ""}]),
    mutate("assessments", "zero maxMarks", maxMarks=0),
    mutate("assessments", "grade entry without scale", entryType="grade"),
    mutate("assessments", "sum_up without factor", conversionType="sum_up"),
    mutate("assessments", "factor with conversion none", conversionFactor=2),
    mutate("assessments", "bad entryType", entryType="points"),
    mutate("co_scholastic_activities", "missing termId", termId=...),
    mutate("remark_categories", "duplicate keys", remarks=[
        {"key": "r1", "text": "A", "type": "positive", "order": 1},
        {"key": "r1", "text": "B", "type": "negative", "order": 2}]),
    mutate("months", "key/month mismatch", month=5),
    mutate("months", "impossible workingDays", workingDays=40),
    mutate("students", "string dateOfBirth", dateOfBirth="2016-05-21"),
    mutate("students", "timestamp dateOfBirth", dateOfBirth=TS),
    mutate("students", "null dateOfBirth", dateOfBirth=None),
    mutate("students", "string phoneNo", phoneNo="9876543210"),
    mutate("students", "missing firstName", firstName=...),
    mutate("students", "empty lastName", lastName=""),
    mutate("students", "wrong type value", type="teacher"),
    mutate("students", "legacy import fields", srNo="1", admNo="2",
           motherName="M", fatherName="F", contactNumber="9", rollNo="7", city="Pune"),
    {"collection": "students", "label": "partial edit of legacy doc",
     "doc": {"name": "Asha"}, "partial": True},
    {"collection": "students", "label": "partial with bad value",
     "doc": {"phoneNo": "nope"}, "partial": True},
]


def revive(doc):
    """Tagged timestamp -> datetime, for the Python run only."""
    out = {}
    for k, v in doc.items():
        if isinstance(v, dict) and "__timestamp__" in v:
            out[k] = datetime(2016, 5, 21)
        else:
            out[k] = v
    return out


def main():
    shape = {}
    for collection, schema in SCHOOL_SCHEMAS.items():
        shape[collection] = {
            name: {
                "type": spec["type"],
                "required": bool(spec.get("required")),
                "nullable": bool(spec.get("nullable")),
                "enum": list(spec.get("enum") or []),
            }
            for name, spec in schema["fields"].items()
        }

    verdicts = []
    for fx in FIXTURES:
        result = validate_doc(fx["collection"], revive(fx["doc"]),
                              partial=bool(fx.get("partial")))
        verdicts.append({
            "collection": fx["collection"],
            "label": fx["label"],
            "doc": fx["doc"],
            "partial": bool(fx.get("partial")),
            "ok": result["ok"],
            "error_fields": sorted({f for f, _ in result["errors"]}),
        })

    with open(OUT, "w") as f:
        json.dump({"shape": shape, "verdicts": verdicts}, f, indent=2)
    print(f"Wrote {len(verdicts)} verdicts across {len(shape)} collections -> {OUT}")
    print("Now run:  node tools/check_schema_parity.mjs")


if __name__ == "__main__":
    main()
