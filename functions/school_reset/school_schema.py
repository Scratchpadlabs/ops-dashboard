#!/usr/bin/env python3
"""THE per-school Firestore schema — server side.

Hand-ported twin of src/schemas/schoolSchema.js, the same arrangement as
class_resolver.py ⟷ classResolver.js. The two files must change together;
tools/check_schema_parity.mjs fails on drift.

WHY THIS EXISTS SEPARATELY FROM THE BROWSER COPY
    commit_import writes through the Admin SDK, which bypasses Firestore
    security rules entirely — _commit_simple previously wrote the browser's
    payload verbatim. Browser-side validation is therefore a UX guard, not a
    gate: this module is the gate.

WHERE THE SHAPES COME FROM
    docs/school-setup-page-spec.md plus the 2026-08-04 live dump (AUDIT.md §1).
    Written from the INTENDED shape, deliberately not derived from SAMARTH's
    live documents — that school carries bootstrap stub docs whose only field
    is `a` in terms, grading_scales, assessments and co_scholastic_activities.

Every school has its OWN values. Nothing here constrains values; only SHAPE.
"""

import re
from datetime import datetime, date

STRING = "string"
NUMBER = "number"
BOOL = "bool"
TIMESTAMP = "timestamp"
ARRAY = "array"
MAP = "map"

ENTRY_TYPES = ["marks", "grade"]
CONVERSION_TYPES = ["none", "marks_to_grade", "sum_up", "sum_down"]
REMARK_TYPES = ["positive", "negative"]
# "prepratory" is misspelled in production data and the spec says keep it.
STAGES = ["foundation", "prepratory", "middle", "secondary"]
AREAS = ["Scholastic", "Co-Scholastic"]

ACADEMIC_YEAR_RE = re.compile(r"^\d{4}-\d{2}$")
MONTH_KEY_RE = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")
# Aadhaar is 12 digits. Shape only — never checksummed here.
AADHAAR_RE = re.compile(r"^\d{12}$")

# A student/staff doc ID (ssds0001 / tsds0001). Catches a person ID written
# into a class field — live at A K CSchool and Carmel Convent (AUDIT.md §2.3).
PERSON_ID_RE = re.compile(r"^[a-z]{2,6}\d{3,6}$")

AUDIT_FIELDS = {"created_at", "created_by", "updated_at", "updated_by"}


def _f(type_, required=True, **kw):
    return dict(type=type_, required=required, **kw)


def _opt(type_, **kw):
    return _f(type_, required=False, **kw)


def _check_marked_item(doc, errors):
    """Shared by assessments and co_scholastic_activities."""
    needs_scale = doc.get("entryType") == "grade" or doc.get("conversionType") == "marks_to_grade"
    if needs_scale and not doc.get("gradingScaleId"):
        errors.append(("gradingScaleId",
                       'required when entryType is "grade" or conversionType is "marks_to_grade"'))
    conv = doc.get("conversionType")
    needs_factor = conv in ("sum_up", "sum_down")
    if needs_factor and not doc.get("conversionFactor"):
        errors.append(("conversionFactor", f'required when conversionType is "{conv}"'))
    if conv == "none" and doc.get("conversionFactor") is not None:
        errors.append(("conversionFactor", 'must be null when conversionType is "none"'))


def _check_grading_scale(doc, errors):
    levels = doc.get("levels") if isinstance(doc.get("levels"), list) else []
    for i, lv in enumerate(levels):
        if not isinstance(lv, dict):
            errors.append((f"levels[{i}]", "must be an object"))
            continue
        if not isinstance(lv.get("label"), str) or not lv["label"].strip():
            errors.append((f"levels[{i}].label", "required string"))
        for k in ("minPercent", "maxPercent"):
            v = lv.get(k)
            if not isinstance(v, (int, float)) or isinstance(v, bool):
                errors.append((f"levels[{i}].{k}", "required number"))
            elif v < 0 or v > 100:
                errors.append((f"levels[{i}].{k}", "must be between 0 and 100"))
        lo, hi = lv.get("minPercent"), lv.get("maxPercent")
        if isinstance(lo, (int, float)) and isinstance(hi, (int, float)) and lo > hi:
            errors.append((f"levels[{i}]", "minPercent is above maxPercent"))

    usable = [lv for lv in levels if isinstance(lv, dict)
              and isinstance(lv.get("minPercent"), (int, float))
              and isinstance(lv.get("maxPercent"), (int, float))]
    usable.sort(key=lambda lv: lv["minPercent"])
    for i in range(1, len(usable)):
        if usable[i]["minPercent"] <= usable[i - 1]["maxPercent"]:
            errors.append(("levels",
                           f'"{usable[i - 1].get("label")}" and "{usable[i].get("label")}" overlap'))
    if usable:
        if usable[0]["minPercent"] > 0:
            errors.append(("levels", "does not cover 0% — lowest band starts above 0"))
        if usable[-1]["maxPercent"] < 100:
            errors.append(("levels", "does not cover 100% — highest band ends below 100"))


def _check_subjects(doc, errors):
    area = doc.get("area")
    if isinstance(area, str) and re.sub(r"[^a-z]", "", area.lower()) == "coscholastic":
        errors.append(("area",
                       "Co-Scholastic records belong in co_scholastic_activities, not subjects"))
    _check_subject_topics(doc, errors)


def _check_subject_topics(doc, errors):
    """subjects.topics has no single shape in production — plain strings,
    {topic, description?} from the topic editor, and other structures (e.g.
    a cost/activity shape seen on at least one live subject) that nothing
    in this codebase produced. Only check the fields the editor itself
    writes; leave anything else alone so this never rejects a write that's
    passing an unrecognized shape through unmodified."""
    topics = doc.get("topics") if isinstance(doc.get("topics"), list) else []
    for i, t in enumerate(topics):
        if isinstance(t, str) or not isinstance(t, dict):
            continue
        topic = t.get("topic")
        if topic is not None and not isinstance(topic, str):
            errors.append((f"topics[{i}].topic", "must be a string"))
        description = t.get("description")
        if description is not None and not isinstance(description, str):
            errors.append((f"topics[{i}].description", "must be a string"))


def _check_classes(doc, errors):
    subs = doc.get("subjects") if isinstance(doc.get("subjects"), list) else []
    for i, s in enumerate(subs):
        if not isinstance(s, dict):
            errors.append((f"subjects[{i}]", "must be an object"))
            continue
        if not isinstance(s.get("subjectId"), str) or not s["subjectId"].strip():
            errors.append((f"subjects[{i}].subjectId", "required string"))


def _check_remark_categories(doc, errors):
    remarks = doc.get("remarks") if isinstance(doc.get("remarks"), list) else []
    seen = set()
    for i, r in enumerate(remarks):
        if not isinstance(r, dict):
            errors.append((f"remarks[{i}]", "must be an object"))
            continue
        # `key` is stored as an entry field key in remarks_sheets/*/entries.
        key = r.get("key")
        if not isinstance(key, str) or not key.strip():
            errors.append((f"remarks[{i}].key", "required string"))
        elif key in seen:
            errors.append((f"remarks[{i}].key", f'duplicate key "{key}"'))
        else:
            seen.add(key)
        if not isinstance(r.get("text"), str) or not r["text"].strip():
            errors.append((f"remarks[{i}].text", "required string"))
        if r.get("type") not in REMARK_TYPES:
            errors.append((f"remarks[{i}].type", f"must be one of {', '.join(REMARK_TYPES)}"))
        if not isinstance(r.get("order"), (int, float)) or isinstance(r.get("order"), bool):
            errors.append((f"remarks[{i}].order", "required number"))


def _check_months(doc, errors):
    key = doc.get("key")
    if isinstance(key, str) and MONTH_KEY_RE.match(key):
        y, m = key.split("-")
        if isinstance(doc.get("year"), (int, float)) and int(doc["year"]) != int(y):
            errors.append(("year", f'does not match key "{key}"'))
        if isinstance(doc.get("month"), (int, float)) and int(doc["month"]) != int(m):
            errors.append(("month", f'does not match key "{key}"'))


SCHOOL_SCHEMAS = {
    "terms": {
        "label": "Terms",
        "fields": {
            "name": _f(STRING),
            "academicYear": _f(STRING, pattern=ACADEMIC_YEAR_RE, hint="e.g. 2025-26"),
            "isActive": _f(BOOL),
        },
    },
    "grading_scales": {
        "label": "Grading scales",
        "fields": {"name": _f(STRING), "levels": _f(ARRAY, minLength=1)},
        "check": _check_grading_scale,
    },
    "subjects": {
        "label": "Subjects",
        "fields": {
            "id": _f(STRING),
            "name": _f(STRING),
            "curricular_goals": _opt(ARRAY),
            "topics": _opt(ARRAY),
            "area": _opt(STRING, enum=AREAS),
            "name_original": _opt(STRING),
            "assets": _opt(STRING, nullable=True),
            "bannerImage": _opt(STRING, nullable=True),
            "iconImage": _opt(STRING, nullable=True),
            "forInternalPurpose": _opt(STRING, nullable=True),
        },
        "check": _check_subjects,
    },
    "classes": {
        "label": "Classes",
        "fields": {
            "id": _f(STRING),
            "name": _f(STRING),
            "clazz": _f(STRING),
            "section": _f(STRING),
            "stage": _f(STRING, enum=STAGES),
            "isActive": _opt(BOOL),
            "subjects": _opt(ARRAY),
            "smart_sheets": _opt(MAP),
        },
        "check": _check_classes,
    },
    "assessments": {
        "label": "Assessments",
        "fields": {
            "name": _f(STRING),
            "termId": _f(STRING),
            "subjectId": _f(STRING),
            "order": _f(NUMBER, min=1),
            "entryType": _f(STRING, enum=ENTRY_TYPES),
            "maxMarks": _f(NUMBER, exclusiveMin=0),
            "gradingScaleId": _f(STRING, nullable=True),
            "conversionType": _f(STRING, enum=CONVERSION_TYPES),
            "conversionFactor": _f(NUMBER, nullable=True),
        },
        "check": _check_marked_item,
    },
    "co_scholastic_activities": {
        "label": "Co-Scholastic activities",
        "fields": {
            "name": _f(STRING),
            "termId": _f(STRING),
            "order": _f(NUMBER, min=1),
            "entryType": _f(STRING, enum=ENTRY_TYPES),
            "maxMarks": _f(NUMBER, exclusiveMin=0),
            "gradingScaleId": _f(STRING, nullable=True),
            "conversionType": _f(STRING, enum=CONVERSION_TYPES),
            "conversionFactor": _f(NUMBER, nullable=True),
        },
        "check": _check_marked_item,
    },
    "remark_categories": {
        "label": "Remark categories",
        "fields": {
            "label": _f(STRING), "order": _f(NUMBER, min=1), "remarks": _f(ARRAY, minLength=1),
            "classIds": _opt(ARRAY),
        },
        "check": _check_remark_categories,
    },
    "months": {
        "label": "Months",
        "fields": {
            "key": _f(STRING, pattern=MONTH_KEY_RE, hint="e.g. 2026-04"),
            "label": _f(STRING),
            "month": _f(NUMBER, min=1, max=12),
            "year": _f(NUMBER, min=2000, max=2100),
            "order": _f(NUMBER),
            "workingDays": _f(NUMBER, min=0, max=31),
        },
        "check": _check_months,
    },
    "students": {
        "label": "Students",
        "fields": {
            "name": _f(STRING),
            "firstName": _f(STRING),
            "lastName": _f(STRING, allowEmpty=True),
            "currentClassId": _f(STRING),
            "type": _f(STRING, enum=["student"]),
            "gender": _opt(STRING, allowEmpty=True),
            "dateOfBirth": _opt(TIMESTAMP, nullable=True),
            "email": _opt(STRING, allowEmpty=True),
            "phoneNo": _opt(NUMBER, nullable=True),
            "needsAuthCreation": _opt(BOOL),
            "surveyInbox": _opt(ARRAY),
            "reports": _opt(ARRAY),
            # Added 2026-08-04 by explicit decision. admNo and grEmisSts stay
            # SEPARATE — different registers, and merging loses which one a
            # number came from.
            "admNo": _opt(STRING, allowEmpty=True),
            "grEmisSts": _opt(STRING, allowEmpty=True),
            # PII. Readable by every signed-in app user under the current
            # firestore.rules read grant — narrowing that needs a rules change.
            "aadhaarNumber": _opt(STRING, allowEmpty=True, pattern=AADHAAR_RE,
                                  hint="12 digits"),
        },
    },
    "staffs": {
        "label": "Staff",
        "fields": {
            "id": _f(STRING),
            "staffId": _f(STRING),
            "name": _f(STRING),
            "firstName": _f(STRING),
            "lastName": _f(STRING, allowEmpty=True),
            "type": _f(STRING),
            "email": _opt(STRING, allowEmpty=True),
            "phoneNo": _opt(NUMBER, nullable=True),
            "sex": _opt(STRING, allowEmpty=True),
            "classIds": _opt(ARRAY),
            "assignments": _opt(MAP),
            "needsAuthCreation": _opt(BOOL),
            "authUid": _opt(STRING, nullable=True),
        },
    },
}


def _is_number(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _type_ok(type_, v):
    if type_ == STRING:
        return isinstance(v, str)
    if type_ == NUMBER:
        return _is_number(v)
    if type_ == BOOL:
        return isinstance(v, bool)
    if type_ == ARRAY:
        return isinstance(v, list)
    if type_ == MAP:
        return isinstance(v, dict)
    if type_ == TIMESTAMP:
        return isinstance(v, (datetime, date))
    return False


def validate_doc(collection, doc, partial=False):
    """Validate one payload.

    `partial=True` (a merge/update write) checks only the fields PRESENT, so a
    legacy malformed document can still be edited through the UI — validating
    the whole stored doc would make bad data unfixable.

    Returns {"ok": bool, "errors": [(field, reason)], "warnings": [(field, reason)]}.
    """
    schema = SCHOOL_SCHEMAS.get(collection)
    if not schema:
        return {"ok": True, "errors": [],
                "warnings": [("", f'no schema defined for "{collection}"')]}
    errors, warnings = [], []

    if not isinstance(doc, dict):
        return {"ok": False, "errors": [("", "payload must be an object")], "warnings": warnings}

    for name, spec in schema["fields"].items():
        if name not in doc:
            if spec["required"] and not partial:
                errors.append((name, "required"))
            continue
        v = doc[name]
        if v is None:
            if spec.get("nullable"):
                continue
            if spec["required"]:
                errors.append((name, "must not be null"))
            continue
        if not _type_ok(spec["type"], v):
            errors.append((name, f"expected {spec['type']}, got {type(v).__name__}"))
            continue
        if spec["type"] == STRING:
            if not v.strip() and not spec.get("allowEmpty") and spec["required"]:
                errors.append((name, "must not be empty"))
            if spec.get("enum") and v not in spec["enum"]:
                errors.append((name, f"must be one of {', '.join(spec['enum'])}"))
            if spec.get("pattern") and v and not spec["pattern"].match(v):
                hint = f" — {spec['hint']}" if spec.get("hint") else ""
                errors.append((name, f"malformed{hint}"))
        if spec["type"] == NUMBER:
            if spec.get("min") is not None and v < spec["min"]:
                errors.append((name, f"must be at least {spec['min']}"))
            if spec.get("max") is not None and v > spec["max"]:
                errors.append((name, f"must be at most {spec['max']}"))
            if spec.get("exclusiveMin") is not None and v <= spec["exclusiveMin"]:
                errors.append((name, f"must be greater than {spec['exclusiveMin']}"))
        if spec["type"] == ARRAY and spec.get("minLength") and len(v) < spec["minLength"]:
            errors.append((name, f"needs at least {spec['minLength']} item(s)"))

    for name in doc:
        if name not in schema["fields"] and name not in AUDIT_FIELDS:
            warnings.append((name, "not part of the known schema — it will be written but nothing reads it"))

    check = schema.get("check")
    if check:
        check(doc, errors)

    return {"ok": not errors, "errors": errors, "warnings": warnings}


def format_errors(errors):
    return "; ".join(f"{f}: {r}" if f else r for f, r in (errors or []))


# ── currentClassId ──────────────────────────────────────────────────────────
# Mirrors src/schemas/currentClassId.js. Parsing is delegated to
# class_resolver.parse_class_value — never re-implemented here.
REASON_EMPTY = "empty"
REASON_PERSON_ID = "person_id"
REASON_SELF_ID = "self_id"
REASON_UNRESOLVABLE = "unresolvable"
REASON_GRADE_ONLY = "grade_only"
REASON_UNKNOWN_CLASS = "unknown_class"


def validate_current_class_id(value, student_id=None, class_ids=None):
    """Returns {"ok", "reason", "severity", "message"}."""
    raw = str(value or "").strip()
    if not raw:
        return {"ok": False, "reason": REASON_EMPTY, "severity": "error",
                "message": "currentClassId is empty"}

    if student_id and raw == str(student_id).strip():
        return {"ok": False, "reason": REASON_SELF_ID, "severity": "error",
                "message": f'currentClassId "{raw}" is the student\'s own ID, not a class'}
    if PERSON_ID_RE.match(raw):
        return {"ok": False, "reason": REASON_PERSON_ID, "severity": "error",
                "message": f'currentClassId "{raw}" looks like a student/staff ID, not a class'}

    from class_resolver import parse_class_value          # local: mirrored per folder
    parsed = parse_class_value(raw)

    if parsed.get("grade_ordinal") is None:
        return {"ok": False, "reason": REASON_UNRESOLVABLE, "severity": "error",
                "message": f'currentClassId "{raw}" does not resolve to a grade — '
                           "confirm it in Class Map first"}
    if not parsed.get("section"):
        return {"ok": False, "reason": REASON_GRADE_ONLY, "severity": "error",
                "message": f'currentClassId "{raw}" has a grade but no section — '
                           "a section is required"}

    if class_ids and raw not in class_ids:
        return {"ok": True, "reason": REASON_UNKNOWN_CLASS, "severity": "warning",
                "message": f'currentClassId "{raw}" is not one of this school\'s configured classes'}

    return {"ok": True, "reason": None, "severity": None, "message": ""}


# ── wire-format coercion ────────────────────────────────────────────────────
# httpsCallable serializes the browser payload to JSON, so a JS Date arrives
# here as an ISO-8601 STRING. Writing it verbatim would put a string where the
# app expects a timestamp — the exact class of bug this module exists to stop.
# Coerce BEFORE validating, so validation sees what will actually be written.
_ISO_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})")

TIMESTAMP_FIELDS = {
    "students": ["dateOfBirth"],
}


def coerce_wire_payload(collection, doc):
    """Convert JSON wire types to the Firestore types the schema requires."""
    if not isinstance(doc, dict):
        return doc
    out = dict(doc)
    for field in TIMESTAMP_FIELDS.get(collection, []):
        v = out.get(field)
        if isinstance(v, str):
            m = _ISO_RE.match(v.strip())
            if not m:
                out[field] = None
                continue
            try:
                out[field] = datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)))
            except ValueError:
                out[field] = None
    return out
