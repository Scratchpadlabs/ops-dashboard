#!/usr/bin/env python3
"""
Per-class attendance months — the pure half of the class_months callable.

The teacher app reads a class's attendance months (and each month's working
days) from schools/{id}/classes/{classId}/months, one doc per month keyed by
"YYYY-MM" (scratchpad_teacher SmartSheets.vue fetchMonths). The school-wide
schools/{id}/months collection is no longer read by it; it survives here only
as a source to copy from.

Kept free of Firestore so the row rules can be tested without credentials.
"""
from school_schema import validate_doc, format_errors

MONTH_FIELDS = ("key", "label", "month", "year", "order", "workingDays")
MAX_ROWS = 5000


def _num(v):
    """JSON numbers arrive as int or float; keep whole numbers as int."""
    if isinstance(v, float) and v.is_integer():
        return int(v)
    return v


def month_payload(row):
    """The month doc as stored — the schema's fields only, nothing else."""
    out = {}
    for f in MONTH_FIELDS:
        if f in row:
            out[f] = row[f].strip() if isinstance(row[f], str) else _num(row[f])
    return out


def plan_save(rows, class_ids):
    """Validate rows for a save.

    Returns (writes, errors): writes is [(classId, key, payload)], errors is
    [{"index", "classId", "key", "reason"}]. Any error rejects the whole save —
    a half-applied calendar is harder to spot than a refused one.
    """
    class_ids = set(class_ids)
    writes, errors, seen = [], [], set()
    if not isinstance(rows, list):
        return [], [{"index": -1, "classId": "", "key": "", "reason": "rows must be a list"}]
    if len(rows) > MAX_ROWS:
        return [], [{"index": -1, "classId": "", "key": "", "reason": f"too many rows (max {MAX_ROWS})"}]
    for i, row in enumerate(rows):
        if not isinstance(row, dict):
            errors.append({"index": i, "classId": "", "key": "", "reason": "row must be an object"})
            continue
        class_id = str(row.get("classId") or "").strip()
        payload = month_payload(row)
        key = payload.get("key") if isinstance(payload.get("key"), str) else ""
        if not class_id:
            errors.append({"index": i, "classId": "", "key": key, "reason": "classId is required"})
            continue
        if class_id not in class_ids:
            errors.append({"index": i, "classId": class_id, "key": key, "reason": f'class "{class_id}" does not exist'})
            continue
        result = validate_doc("months", payload)
        if not result["ok"]:
            errors.append({"index": i, "classId": class_id, "key": key, "reason": format_errors(result["errors"])})
            continue
        if (class_id, key) in seen:
            errors.append({"index": i, "classId": class_id, "key": key, "reason": "duplicate class + month in this save"})
            continue
        seen.add((class_id, key))
        writes.append((class_id, key, payload))
    return writes, errors


def plan_delete(rows):
    """[(classId, key)] for a delete; malformed rows are dropped, not guessed."""
    out, seen = [], set()
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict):
            continue
        class_id = str(row.get("classId") or "").strip()
        key = str(row.get("key") or "").strip()
        if class_id and key and "/" not in class_id and "/" not in key and (class_id, key) not in seen:
            seen.add((class_id, key))
            out.append((class_id, key))
    return out


def sort_months(months):
    """Same order the teacher app shows: by `order`, then key."""
    return sorted(months, key=lambda m: (m.get("order") if isinstance(m.get("order"), (int, float)) else 0,
                                         str(m.get("key") or "")))
