"""Promotion engine — one plan, built once, replayed on execution.

Promotion is `grade_ordinal + 1`. Because the ordinal scale puts
Nursery/-2, LKG/-1, UKG/0 below Grade 1, the pre-primary ladder needs no
special case: UKG(0) + 1 == Grade 1.

Every student lands in exactly one bucket, and every bucket carries a reason:

    promote   — target class exists (or section mapping resolves it)
    graduate  — at the school's highest configured grade; marked inactive
    unchanged — deliberately excluded: already inactive, parked on an
                excluded class value so they cannot reach the app, or a
                recorded "leave these alone" decision
    blocked   — cannot be resolved or has no target class. NEVER written.
                A run containing blocked students cannot proceed until a human
                resolves them, because a reset that clears survey inboxes
                while promoting nobody is the exact failure this engine exists
                to prevent.

The plan this returns IS the preview and IS the execution input. There is no
second implementation to drift.
"""

from .class_resolver import (  # noqa: F401  (re-exported for callers)
    GRADUATED, EXCLUDED, CONF_NONE, resolve_class, build_school_context,
    ordinal_to_token, compose_class_id, describe_unresolved,
)

ACTION_PROMOTE = "promote"
ACTION_GRADUATE = "graduate"
ACTION_UNCHANGED = "unchanged"
ACTION_BLOCKED = "blocked"


def _target_for(resolved, ctx, section_map=None):
    """(target_class_id, action, reason) for one resolved student."""
    ordinal = resolved.get("grade_ordinal")
    if ordinal is None:
        return None, ACTION_BLOCKED, resolved.get("label") or "unresolved class"

    # Terminal grade is the school's OWN highest configured grade, not a
    # hardcoded XII. A school running up to Grade 8 graduates from 8.
    if ctx.get("max_ordinal") is not None and ordinal >= ctx["max_ordinal"]:
        return None, ACTION_GRADUATE, None

    section = resolved.get("section") or ""
    # Optional per-grade section remap, for schools that reshuffle sections
    # between sessions. Keyed by the SOURCE ordinal.
    if section_map:
        remap = section_map.get(str(ordinal)) or section_map.get(ordinal) or {}
        section = remap.get(section, section)

    token = ordinal_to_token(ordinal + 1, ctx.get("notation", "roman"))
    if not token:
        return None, ACTION_BLOCKED, f"no grade above ordinal {ordinal}"

    target = compose_class_id(token, section, ctx.get("separator", "_"))

    # The target must EXIST. Inventing a class silently detaches students from
    # every class-scoped feature in both apps.
    if ctx["class_id_set"] and target not in ctx["class_id_set"]:
        # A same-grade class with a different section proves the grade exists
        # and only the section is missing — a much more actionable message.
        siblings = ctx.get("ordinals_present", {}).get(ordinal + 1, [])
        if siblings:
            return None, ACTION_BLOCKED, (
                f"target class '{target}' does not exist; grade has "
                f"{len(siblings)} other section(s): {', '.join(sorted(siblings)[:4])}")
        return None, ACTION_BLOCKED, f"target class '{target}' does not exist"

    return target, ACTION_PROMOTE, None


def build_promotion_plan(students, ctx, section_map=None, leave_unchanged_ids=None):
    """The full per-student plan.

    `leave_unchanged_ids` records an explicit human decision to skip students
    (Part 4's escape hatch). Those move to `unchanged` with that reason
    attached, rather than staying blocked — the decision is part of the plan
    and therefore part of the audit trail.
    """
    leave = set(leave_unchanged_ids or [])
    rows = []
    for s in students or []:
        sid = s.get("id")
        resolved = resolve_class(s, ctx)
        raw = resolved.get("raw")

        if s.get("isActive") is False:
            rows.append(_row(sid, s, raw, resolved, None, ACTION_UNCHANGED,
                             "already inactive"))
            continue
        # Parked on a confirmed exclusion value. A known state, so it must
        # never block the run — but it is not promoted either, because the
        # student is deliberately outside the app.
        if resolved.get("excluded"):
            rows.append(_row(sid, s, raw, resolved, None, ACTION_UNCHANGED,
                             "excluded from the app by class value"))
            continue
        if sid in leave:
            rows.append(_row(sid, s, raw, resolved, None, ACTION_UNCHANGED,
                             "explicitly left unchanged"))
            continue

        target, action, reason = _target_for(resolved, ctx, section_map)
        rows.append(_row(sid, s, raw, resolved, target, action, reason))
    return rows


def _row(sid, student, raw, resolved, target, action, reason):
    return {
        "id": sid,
        "name": student.get("name") or student.get("studentName") or "",
        "from": resolved.get("canonical_class_id") or raw or "",
        "from_raw": raw,
        "from_field": resolved.get("raw_field"),
        "from_label": resolved.get("label"),
        "to": target if action == ACTION_PROMOTE else (
            GRADUATED if action == ACTION_GRADUATE else None),
        "action": action,
        "reason": reason,
        "confidence": resolved.get("confidence"),
        "grade_ordinal": resolved.get("grade_ordinal"),
        "section": resolved.get("section", ""),
    }


def summarize(plan):
    """Counts by action, plus the blocked detail the UI must surface."""
    counts = {ACTION_PROMOTE: 0, ACTION_GRADUATE: 0,
              ACTION_UNCHANGED: 0, ACTION_BLOCKED: 0}
    for r in plan:
        counts[r["action"]] = counts.get(r["action"], 0) + 1

    excluded = sum(1 for r in plan
                   if r["action"] == ACTION_UNCHANGED
                   and r.get("reason") == "excluded from the app by class value")

    blocked_reasons = {}
    for r in plan:
        if r["action"] != ACTION_BLOCKED:
            continue
        key = r.get("from_label") or r.get("reason") or "unknown"
        b = blocked_reasons.setdefault(key, {"label": key, "count": 0, "sample": []})
        b["count"] += 1
        if len(b["sample"]) < 5:
            b["sample"].append({"id": r["id"], "name": r["name"], "from": r["from_raw"]})

    return {
        "total": len(plan),
        "counts": counts,
        # Surfaced separately so "unchanged" does not read as one
        # undifferentiated bucket in the preview.
        "excluded_count": excluded,
        "blocked_reasons": sorted(blocked_reasons.values(), key=lambda x: -x["count"]),
        "can_proceed": counts[ACTION_BLOCKED] == 0,
    }


def plan_to_csv(plan):
    """Dry-run download (item 15). Written by hand rather than via csv module
    so the Cloud Function has no extra dependency and the quoting is explicit."""
    header = ["student_id", "name", "from_raw", "from_field", "from_resolved",
              "to", "action", "confidence", "reason"]
    lines = [",".join(header)]
    for r in plan:
        lines.append(",".join(_csv_cell(v) for v in [
            r.get("id"), r.get("name"), r.get("from_raw"), r.get("from_field"),
            r.get("from"), r.get("to"), r.get("action"), r.get("confidence"),
            r.get("reason"),
        ]))
    return "\n".join(lines)


def _csv_cell(value):
    s = "" if value is None else str(value)
    if any(c in s for c in [',', '"', "\n", "\r"]):
        return '"' + s.replace('"', '""') + '"'
    return s


def plan_fingerprint(plan):
    """A stable digest of the per-student decisions.

    Execution recomputes the plan and compares this against the fingerprint
    the preview recorded. If the roster moved underneath — a student imported,
    a class edited — the digests differ and the run is refused rather than
    applying a plan the user never saw. This is what "the preview IS the plan"
    means in practice without trusting a client-held copy.
    """
    import hashlib
    parts = []
    for r in sorted(plan, key=lambda x: str(x.get("id") or "")):
        parts.append("|".join([
            str(r.get("id") or ""), str(r.get("from") or ""),
            str(r.get("to") or ""), str(r.get("action") or ""),
        ]))
    return hashlib.sha256("\n".join(parts).encode("utf-8")).hexdigest()
