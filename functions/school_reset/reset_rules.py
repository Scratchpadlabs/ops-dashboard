#!/usr/bin/env python3
"""
Pure decision logic for the Reset School wizard.

Split from main.py for the same reason as the other function folders: main.py
calls firebase_admin.initialize_app() at import, so nothing there is testable
without a Firebase environment. Everything here is stdlib-only and side-effect
free.

This module decides WHAT a reset would change. It never decides to do it —
main.py performs writes only after an explicit, typed confirmation and a
verified archive.

THE CONSTRAINT THAT SHAPES EVERYTHING: the school tree has no academic-year
dimension. There is no year field on students, classes or reports, and the
teacher/student apps do not pass one. A "reset" is therefore an IN-PLACE
mutation of live data, not the creation of a new year's copy. That is why
archiving is mandatory and why every operation here is expressed as an
explicit, itemized diff rather than an implied side effect.
"""

# ── Class resolution and promotion now live in ONE place ────────────────────
# functions/shared/class_resolver.py + promotion.py, mirrored into this folder
# by tools/sync_shared.py (gcloud uploads only `--source .`).
#
# What used to be here — split_class_id, next_grade, promote_class_id,
# school_uses_numeric_grades, build_promotion_plan — was the second of three
# independent class parsers in this repo, and the one with the narrowest
# reading of the data: it split class ids on "_" and nothing else, and read
# only the `classId` field. A school writing "1-B", or one whose roster came
# from the import pipeline (which writes `currentClassId`), had 100% of its
# students reported as "class the promotion rules do not recognize" —
# observed on NAVODAYA CENTRAL SCHOOL, 650 of 650.
#
# Nothing about promotion is decided in this module any more.
from class_resolver import (  # noqa: F401
    GRADUATED, build_school_context, resolve_class,
)
from promotion import (
    ACTION_PROMOTE, ACTION_GRADUATE, ACTION_UNCHANGED, ACTION_BLOCKED,
    build_promotion_plan, summarize, plan_fingerprint, plan_to_csv,  # noqa: F401
)


def build_reset_diff(students, options, existing_class_ids=None,
                     inbox_field="surveyInbox", class_map=None):
    """The itemized diff shown before anything is written.

    `options` are explicit booleans — nothing is implied. Every count here is
    of students that would ACTUALLY change: a student with an empty inbox is
    not counted under "inbox cleared", because a preview that overstates its
    effect trains people to ignore it.
    """
    opts = options or {}
    ctx = build_school_context(existing_class_ids, class_map=class_map)

    # ONE resolved roster per run (task item 12). `students` is passed in
    # already read, and every count below is derived from THAT list — there is
    # no second query anywhere in this function, and none may be added. The
    # promotion plan covers every student, including the ones no option
    # touches, so the buckets always sum to the roster.
    plan = build_promotion_plan(
        students, ctx,
        section_map=opts.get("section_map"),
        leave_unchanged_ids=opts.get("leave_unchanged_ids"),
    )
    plan_summary = summarize(plan)
    promoting = bool(opts.get("promote"))

    inbox_to_clear = [s for s in students if s.get(inbox_field)] if opts.get("clear_inbox") else []
    reports_to_detach = [s for s in students if s.get("reports")] if opts.get("clear_reports") else []
    to_remove = []
    if opts.get("remove_ids"):
        wanted = set(opts["remove_ids"])
        to_remove = [s for s in students if s.get("id") in wanted]

    counts = plan_summary["counts"]
    diff = {
        "total_students": len(students),
        "promote": promoting,
        "promoted_count": counts[ACTION_PROMOTE] if promoting else 0,
        "graduating_count": counts[ACTION_GRADUATE] if promoting else 0,
        "unmapped_count": counts[ACTION_BLOCKED] if promoting else 0,
        "unchanged_count": counts[ACTION_UNCHANGED] if promoting else 0,
        "blocked_reasons": plan_summary["blocked_reasons"] if promoting else [],
        # The hard block from item 13. Promotion cannot run while any student
        # is unresolvable: a reset that clears survey inboxes while promoting
        # nobody is the exact outcome this engine exists to prevent. The only
        # ways forward are a class_map fix or an explicit, recorded decision
        # to leave those students alone.
        "can_proceed": (not promoting) or plan_summary["can_proceed"],
        "missing_target_classes": sorted({
            r["reason"].split("'")[1] for r in plan
            if r["action"] == ACTION_BLOCKED and r.get("reason")
            and "does not exist" in r["reason"] and "'" in r["reason"]
        }) if promoting else [],
        # Denominators, so the preview can never again read as two different
        # counts of the same roster. "195 of 650" is unambiguous where a bare
        # "195" alongside a bare "650" was not.
        "inbox_total": sum(1 for s in students if s.get(inbox_field)),
        "reports_total": sum(1 for s in students if s.get("reports")),
        "inbox_cleared_count": len(inbox_to_clear),
        "reports_detached_count": len(reports_to_detach),
        "removed_count": len(to_remove),
        "resolution": {
            "notation": ctx["notation"],
            "configured_classes": len(ctx["class_ids"]),
            "class_map_entries": len(ctx["class_map"]),
        },
        "clear_sheets": bool(opts.get("clear_sheets")),
        # NOTE: there is deliberately no reset_operations / reset_receivables
        # option. Those checklists live in the ops CRM tree
        # (operations/ops/school_operations, .../school_data_receivable),
        # keyed by the OPS school doc id — a different id space from the root
        # schools/<id> this resets, with no link between them. Echoing such a
        # flag back here would make the preview claim an effect reset_execute
        # cannot deliver. If they are ever added, add them to BOTH this diff
        # and reset_execute, and resolve the id explicitly rather than
        # assuming the two ids match.
        # Named explicitly so the confirm screen can state what is NOT touched.
        "kept": ["subjects", "terms", "grading scales", "remark categories",
                  "months", "teachers/staff", "school details",
                  "operations & data-receivable checklists (ops CRM)"],
    }
    diff["plan"] = plan
    # The digest of the per-student decisions. reset_execute recomputes the
    # plan and compares this; a roster that moved between preview and confirm
    # changes the digest and the run is refused rather than applying something
    # the user never saw (item 14).
    diff["plan_fingerprint"] = plan_fingerprint(plan) if promoting else None
    diff["write_estimate"] = (
        diff["promoted_count"] + diff["graduating_count"]
        + diff["inbox_cleared_count"] + diff["reports_detached_count"]
        + diff["removed_count"]
    )
    return diff


def verify_archive(source_counts, archive_counts):
    """Row-count check between source and archive.

    Returns (ok, mismatches). The reset is blocked unless this passes: an
    archive that silently dropped rows is worse than no archive, because it
    reads as safety that isn't there.
    """
    mismatches = []
    for key, expected in (source_counts or {}).items():
        actual = (archive_counts or {}).get(key)
        if actual != expected:
            mismatches.append({"collection": key, "expected": expected, "archived": actual})
    return (not mismatches), mismatches


def slugify_school_id(name):
    """Suggest a Firestore-safe doc id from a school name.

    Only a SUGGESTION — the wizard lets it be overridden, because the id is
    also how humans refer to the school and Sid needs control of it.
    """
    out = []
    for ch in str(name or "").strip():
        if ch.isalnum():
            out.append(ch)
        elif ch in " -_" and out and out[-1] != "_":
            out.append("_")
    return "".join(out).strip("_")[:64]


# Firestore doc ids cannot contain / and cannot be '.' or '..'; the wizard also
# forbids whitespace so ids stay copy-pasteable into paths and URLs.
INVALID_ID_CHARS = set('/\\ \t\n.#$[]')


def validate_school_id(school_id):
    """(ok, error_or_None) for a user-supplied Firestore doc id."""
    sid = str(school_id or "").strip()
    if not sid:
        return False, "School ID is required."
    if len(sid) > 64:
        return False, "School ID must be 64 characters or fewer."
    bad = sorted({c for c in sid if c in INVALID_ID_CHARS})
    if bad:
        shown = ", ".join(repr(c) for c in bad)
        return False, f"School ID cannot contain: {shown}"
    if not sid[0].isalnum():
        return False, "School ID must start with a letter or number."
    return True, None


def _norm_name(name):
    return "".join(c for c in str(name or "").lower() if c.isalnum())


# Words that appear in half the school names in the country and therefore
# carry no identifying signal. Comparing on the DISTINCTIVE tokens is what
# catches "Samartha International School" vs "Samartha School" — plain edit
# distance cannot, because the shared word is buried among different ones.
NAME_STOPWORDS = {
    "school", "schools", "intl", "international", "public", "academy",
    "high", "higher", "secondary", "primary", "pre", "the", "of", "and",
    "english", "medium", "convent", "vidyalaya", "vidya", "mandir",
    "education", "educational", "society", "trust", "campus", "branch",
    "college", "institute", "junior", "senior", "central", "global", "world",
}


def _tokens(name):
    raw = [t for t in "".join(c if c.isalnum() else " " for c in str(name or "").lower()).split() if t]
    distinctive = [t for t in raw if t not in NAME_STOPWORDS and len(t) > 2]
    # A name made ENTIRELY of stopwords still needs something to compare on.
    return set(distinctive or raw)


def find_similar_schools(name, existing, threshold=0.82, token_threshold=0.3):
    """Near-duplicate names, so the wizard makes duplicates HARDER.

    The collection already carries 'Samartha International School' alongside
    'samarthaschool'. Exact-id uniqueness alone would have allowed every one
    of those, so this compares NAMES two ways and warns on either:

      - distinctive-token overlap (Jaccard), which catches the real pattern
        of the same school re-entered with different filler words
      - whole-string edit distance, which catches typos and abbreviations

    It warns, never blocks: two genuinely different schools can share a name
    stem ("St Mary's, Pune" and "St Mary's, Mumbai"), and that is the user's
    call to make, not this function's.
    """
    target = _norm_name(name)
    target_tokens = _tokens(name)
    if not target:
        return []

    hits = []
    for s in existing or []:
        label = s.get("name") or s.get("id")
        other = _norm_name(label)
        if not other:
            continue

        if other == target or other in target or target in other:
            ratio, why = 1.0, "same name"
        else:
            ratio, why = _similarity(target, other), "similar spelling"

        other_tokens = _tokens(label)
        shared = target_tokens & other_tokens
        jaccard = len(shared) / len(target_tokens | other_tokens) if (target_tokens | other_tokens) else 0.0
        if shared and jaccard >= token_threshold and jaccard > ratio:
            ratio, why = jaccard, f"shares “{'”, “'.join(sorted(shared))}”"

        if ratio >= threshold or (shared and jaccard >= token_threshold):
            hits.append({"id": s.get("id"), "name": label,
                          "similarity": round(ratio, 3), "reason": why})
    return sorted(hits, key=lambda h: -h["similarity"])[:5]


def _similarity(a, b):
    """Normalized Levenshtein, same metric as the education KB so the app's
    two fuzzy-matching surfaces behave consistently."""
    if a == b:
        return 1.0
    if not a or not b:
        return 0.0
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return 1.0 - prev[-1] / max(len(a), len(b))
