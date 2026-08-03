#!/usr/bin/env python3
"""
School Setup wizards — server side.

Four callables, same source directory:
  school_state     current counts for a school (wizard step 1)
  archive_school   MANDATORY snapshot before any reset, with verification
  reset_preview    the itemized diff — reads only, never writes
  reset_execute    performs the reset, batched, logged, resumable

THE CONSTRAINT: the school tree has NO academic-year dimension. There is no
year field on students, classes or reports, and the teacher/student apps do
not pass one. A reset is therefore an IN-PLACE mutation of live data. We
deliberately do NOT introduce a year field — the apps would need changing —
so safety comes from archiving instead:

  - The archive is written to `archives/{schoolId}__{label}/...`, a tree the
    teacher and student apps NEVER read.
  - It is verified by row count before the reset is allowed to proceed. An
    archive that silently dropped rows is worse than no archive, because it
    reads as safety that isn't there.
  - reset_execute REFUSES to run without a verified archive id, and re-checks
    that archive server-side rather than trusting the client's word.

Everything destructive is additionally gated on the caller echoing the school
id back (checked here, not just in the UI) and carries a dry-run mode that
produces the full plan and run log without writing.

Deploy (see functions/DEPLOY.md):
  gcloud functions deploy school_state    --gen2 --runtime python312 --region asia-south1 \
    --source . --entry-point school_state --trigger-http --allow-unauthenticated \
    --memory 512MB --timeout 120s --max-instances 3 --project clarified-1501
  gcloud functions deploy archive_school  --gen2 --runtime python312 --region asia-south1 \
    --source . --entry-point archive_school --trigger-http --allow-unauthenticated \
    --memory 1024MB --timeout 540s --max-instances 3 --project clarified-1501
  gcloud functions deploy reset_preview   --gen2 --runtime python312 --region asia-south1 \
    --source . --entry-point reset_preview --trigger-http --allow-unauthenticated \
    --memory 1024MB --timeout 300s --max-instances 3 --project clarified-1501
  gcloud functions deploy reset_execute   --gen2 --runtime python312 --region asia-south1 \
    --source . --entry-point reset_execute --trigger-http --allow-unauthenticated \
    --memory 1024MB --timeout 540s --max-instances 3 --project clarified-1501
"""
import firebase_admin
from firebase_admin import firestore
from firebase_functions import https_fn, options

from reset_rules import (
    build_reset_diff, verify_archive, find_similar_schools, validate_school_id,
)
from class_resolver import (
    build_school_context, resolve_class, distinct_class_values, CONF_HIGH,
    CONF_MEDIUM,
)
from promotion import (
    ACTION_PROMOTE, ACTION_GRADUATE, plan_fingerprint, plan_to_csv,
)

firebase_admin.initialize_app()

OPS_ADMIN_EMAILS = {"sid@ops.clarified.in", "angel@ops.clarified.in"}
WRITE_CHUNK = 450
INBOX_FIELD = "surveyInbox"

# Collections snapshotted before a reset. Config (subjects, terms, scales,
# remarks, months, staffs) is deliberately NOT archived: a reset never touches
# it, so copying it would imply otherwise.
ARCHIVED_COLLECTIONS = ["students", "classes", "smart_sheet_entries"]


def _require_ops_admin(req):
    if req.auth is None:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.UNAUTHENTICATED, "Sign in required.")
    email = str((req.auth.token or {}).get("email") or "").strip().lower()
    if email not in OPS_ADMIN_EMAILS:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.PERMISSION_DENIED,
            "Not authorized for School Setup wizards.")
    return email


def _school_ref(db, school_id):
    return db.collection("schools").document(school_id)


def _active_students(school_ref):
    out = []
    for d in school_ref.collection("students").stream():
        doc = d.to_dict() or {}
        if str(doc.get("type") or "student") != "student":
            continue
        doc["id"] = d.id
        out.append(doc)
    return out


def _load_class_map(school_ref):
    """The school's confirmed class map (Part 2), keyed by raw value.

    A confirmed entry is the school's own answer and outranks anything the
    resolver can infer, which is what makes an odd school permanently fixable
    without a code change.
    """
    out = {}
    for d in school_ref.collection("class_map").stream():
        row = d.to_dict() or {}
        out[row.get("raw_value", d.id)] = row
    return out


def _resolution_context(school_ref):
    """Class ids + class map, read once, for every feature in this module."""
    class_ids = [c.id for c in school_ref.collection("classes").select([]).stream()]
    return build_school_context(class_ids, class_map=_load_class_map(school_ref))


def _count(coll_ref):
    try:
        return int(coll_ref.count().get()[0][0].value)
    except Exception:
        return sum(1 for _ in coll_ref.select([]).stream())


# ────────────────────────────── school_state ───────────────────────────────
@https_fn.on_call(region="asia-south1", memory=options.MemoryOption.MB_512,
                   timeout_sec=120, max_instances=3)
def school_state(req: https_fn.CallableRequest):
    """Current counts for a school, for the reset wizard's opening step and
    the new-school wizard's review step. Reads only."""
    _require_ops_admin(req)
    data = req.data or {}
    school_id = (data.get("schoolId") or "").strip()
    if not school_id:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT, "Missing schoolId")

    db = firestore.client()
    ref = _school_ref(db, school_id)
    snap = ref.get()
    if not snap.exists:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.NOT_FOUND, f"School {school_id} not found.")

    students = _active_students(ref)
    inbox_students = sum(1 for s in students if s.get(INBOX_FIELD))
    report_students = sum(1 for s in students if s.get("reports"))
    inactive = sum(1 for s in students if s.get("isActive") is False)

    counts = {
        "students": len(students),
        "active_students": len(students) - inactive,
        "inactive_students": inactive,
        "classes": _count(ref.collection("classes")),
        "staffs": _count(ref.collection("staffs")),
        "subjects": _count(ref.collection("subjects")),
        "terms": _count(ref.collection("terms")),
        "surveys": _count(ref.collection("surveys")),
        "students_with_surveys": inbox_students,
        "students_with_reports": report_students,
        "smart_sheet_entries": _count(ref.collection("smart_sheet_entries")),
    }
    # Class figures go through the shared resolver, not a raw classId read, so
    # step 1 of the wizard shows the same numbers the promotion step will.
    ctx = _resolution_context(ref)
    resolved_ids, unresolved = set(), 0
    for s in students:
        r = resolve_class(s, ctx)
        if r.get("canonical_class_id"):
            resolved_ids.add(r["canonical_class_id"])
        else:
            unresolved += 1
    counts["unresolved_classes"] = unresolved

    return {
        "school": {**(snap.to_dict() or {}), "id": snap.id},
        "counts": counts,
        "class_ids": sorted(resolved_ids),
        "resolution": {
            "unresolved_students": unresolved,
            "distinct_values": len(distinct_class_values(students)),
            "configured_classes": len(ctx["class_ids"]),
            "class_map_entries": len(ctx["class_map"]),
            "has_confirmed_map": any(v.get("source") == "confirmed"
                                      for v in ctx["class_map"].values()),
            "notation": ctx["notation"],
        },
    }


# ───────────────────────────── archive_school ──────────────────────────────
@https_fn.on_call(region="asia-south1", memory=options.MemoryOption.GB_1,
                   timeout_sec=540, max_instances=3)
def archive_school(req: https_fn.CallableRequest):
    """Snapshot a school's mutable data, then VERIFY it by row count.

    Writes to `archives/{schoolId}__{label}` — a top-level tree the teacher
    and student apps never read. Survey responses are copied too, since a
    reset clears the inbox state that gives them meaning.

    Returns the archive location and a verified flag. reset_execute refuses to
    run unless this returned verified=True, and re-checks the counts itself
    rather than trusting the client.
    """
    email = _require_ops_admin(req)
    data = req.data or {}
    school_id = (data.get("schoolId") or "").strip()
    label = (data.get("label") or "").strip()
    if not school_id or not label:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT,
            "Missing schoolId or label (the session being archived, e.g. 2025-26).")
    if "/" in label:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT, "Label cannot contain '/'.")

    db = firestore.client()
    src = _school_ref(db, school_id)
    if not src.get().exists:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.NOT_FOUND, f"School {school_id} not found.")

    archive_id = f"{school_id}__{label}"
    dst = db.collection("archives").document(archive_id)

    source_counts, archived_counts = {}, {}
    try:
        dst.set({
            "school_id": school_id, "label": label, "status": "running",
            "created_by": email, "created_at": firestore.SERVER_TIMESTAMP,
        })

        for coll in ARCHIVED_COLLECTIONS:
            docs = list(src.collection(coll).stream())
            source_counts[coll] = len(docs)
            written = 0
            for i in range(0, len(docs), WRITE_CHUNK):
                batch = db.batch()
                for d in docs[i:i + WRITE_CHUNK]:
                    batch.set(dst.collection(coll).document(d.id), d.to_dict() or {})
                batch.commit()
                written += len(docs[i:i + WRITE_CHUNK])
            archived_counts[coll] = written

        # Survey responses live one level deeper; flatten them so the archive
        # stays a shallow, countable tree.
        resp_docs = []
        for survey in src.collection("surveys").stream():
            for r in src.collection("surveys").document(survey.id).collection("responses").stream():
                resp_docs.append((f"{survey.id}__{r.id}", {"survey_id": survey.id,
                                                            "response_id": r.id,
                                                            **(r.to_dict() or {})}))
        source_counts["survey_responses"] = len(resp_docs)
        written = 0
        for i in range(0, len(resp_docs), WRITE_CHUNK):
            batch = db.batch()
            for doc_id, payload in resp_docs[i:i + WRITE_CHUNK]:
                batch.set(dst.collection("survey_responses").document(doc_id), payload)
            batch.commit()
            written += len(resp_docs[i:i + WRITE_CHUNK])
        archived_counts["survey_responses"] = written

    except Exception as e:
        dst.set({"status": "failed", "error": str(e)}, merge=True)
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INTERNAL, f"Archive failed: {e}")

    # Verify by RE-READING the archive, not by trusting the write loop's own
    # tally — a batch that silently dropped a doc would otherwise self-certify.
    reread = {c: _count(dst.collection(c)) for c in list(ARCHIVED_COLLECTIONS) + ["survey_responses"]}
    ok, mismatches = verify_archive(source_counts, reread)

    dst.set({
        "status": "verified" if ok else "mismatch",
        "source_counts": source_counts,
        "archived_counts": reread,
        "mismatches": mismatches,
        "completed_at": firestore.SERVER_TIMESTAMP,
    }, merge=True)

    return {
        "archive_id": archive_id,
        "location": f"archives/{archive_id}",
        "verified": ok,
        "source_counts": source_counts,
        "archived_counts": reread,
        "mismatches": mismatches,
    }


# ───────────────────────────── reset_preview ───────────────────────────────
@https_fn.on_call(region="asia-south1", memory=options.MemoryOption.GB_1,
                   timeout_sec=300, max_instances=3)
def reset_preview(req: https_fn.CallableRequest):
    """The itemized diff. Reads only — this function cannot write."""
    _require_ops_admin(req)
    data = req.data or {}
    school_id = (data.get("schoolId") or "").strip()
    options_in = data.get("options") or {}
    if not school_id:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT, "Missing schoolId")

    db = firestore.client()
    ref = _school_ref(db, school_id)
    students = _active_students(ref)
    ctx = _resolution_context(ref)

    diff = build_reset_diff(students, options_in, ctx["class_ids"], INBOX_FIELD,
                            class_map=ctx["class_map"])

    # Samples per bucket, so the preview is inspectable without shipping 3000
    # rows to the browser. Every bucket is expandable in the UI; `blocked` is
    # capped higher because that is the one the user has to act on.
    plan = diff.pop("plan", []) or []
    buckets = {}
    for row in plan:
        buckets.setdefault(row["action"], []).append(row)
    diff["sample"] = {
        action: rows[:100 if action == "blocked" else 25]
        for action, rows in buckets.items()
    }
    diff["bucket_totals"] = {action: len(rows) for action, rows in buckets.items()}
    return diff


# ───────────────────────────── reset_execute ───────────────────────────────
@https_fn.on_call(region="asia-south1", memory=options.MemoryOption.GB_1,
                   timeout_sec=540, max_instances=3)
def reset_execute(req: https_fn.CallableRequest):
    """Perform the reset. Batched, logged, and refusable.

    Three gates, all enforced HERE rather than trusted to the UI:
      1. a verified archive id, re-checked against the archive doc
      2. the caller echoing back the exact school id
      3. dryRun, which produces the full run log and writes nothing
    """
    email = _require_ops_admin(req)
    data = req.data or {}
    school_id = (data.get("schoolId") or "").strip()
    confirm_id = (data.get("confirmSchoolId") or "").strip()
    archive_id = (data.get("archiveId") or "").strip()
    run_id = (data.get("runId") or "").strip()
    options_in = data.get("options") or {}
    dry_run = bool(data.get("dryRun"))

    if not school_id or not run_id:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT, "Missing schoolId or runId")
    if confirm_id != school_id:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT,
            "Confirmation does not match the school id.")

    db = firestore.client()
    ref = _school_ref(db, school_id)

    # An unverified archive blocks a real run. A dry run is allowed without
    # one, which is what makes it usable for rehearsal.
    if not dry_run:
        if not archive_id:
            raise https_fn.HttpsError(
                https_fn.FunctionsErrorCode.FAILED_PRECONDITION,
                "A verified archive is required before a reset can run.")
        arch = db.collection("archives").document(archive_id).get()
        if not arch.exists or (arch.to_dict() or {}).get("status") != "verified":
            raise https_fn.HttpsError(
                https_fn.FunctionsErrorCode.FAILED_PRECONDITION,
                f"Archive {archive_id} is missing or not verified. Re-run the archive step.")
        if (arch.to_dict() or {}).get("school_id") != school_id:
            raise https_fn.HttpsError(
                https_fn.FunctionsErrorCode.FAILED_PRECONDITION,
                "That archive belongs to a different school.")

    # ONE resolved roster for the whole run (item 12). Every step below —
    # promotion, inbox clearing, report detaching, removals — reads THIS list.
    # There is no second query, and none may be added.
    students = _active_students(ref)
    ctx = _resolution_context(ref)
    diff = build_reset_diff(students, options_in, ctx["class_ids"], INBOX_FIELD,
                            class_map=ctx["class_map"])
    plan = diff.get("plan") or []

    # ── Gate: no student may be left blocked ────────────────────────────────
    # Item 13. Enforced HERE, not in the wizard, so no client can route round
    # it. A reset that clears survey inboxes while promoting nobody is exactly
    # the outcome this refuses.
    if not diff.get("can_proceed", True):
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.FAILED_PRECONDITION,
            f"{diff['unmapped_count']} student(s) have a class that cannot be "
            "resolved. Fix the class map for this school, or explicitly choose "
            "to leave those students unchanged, then preview again.")

    # ── Gate: the plan must be the one that was confirmed ───────────────────
    # Item 14. The preview IS the plan; this recomputes it from fresh data and
    # refuses if the roster moved underneath — a student imported or a class
    # edited between preview and confirm — rather than applying something the
    # user never saw. Recomputing (instead of replaying a client-held copy)
    # also means the client cannot hand us a doctored plan.
    expected_fp = (data.get("planFingerprint") or "").strip()
    actual_fp = plan_fingerprint(plan) if options_in.get("promote") else None
    if expected_fp and actual_fp and expected_fp != actual_fp:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.FAILED_PRECONDITION,
            "The roster changed since this preview was built. Re-run the "
            "preview and confirm the new numbers before executing.")

    run_ref = ref.collection("resets").document(run_id)
    run_ref.set({
        "school_id": school_id, "archive_id": archive_id or None,
        "options": options_in, "dry_run": dry_run,
        "expected_writes": diff["write_estimate"],
        "promoted_count": diff["promoted_count"],
        "graduating_count": diff["graduating_count"],
        "inbox_cleared_count": diff["inbox_cleared_count"],
        "reports_detached_count": diff["reports_detached_count"],
        "removed_count": diff["removed_count"],
        "status": "running", "progress": 0, "written": 0,
        "run_by": email, "run_at": firestore.SERVER_TIMESTAMP,
    })

    if dry_run:
        run_ref.set({"status": "dry_run_complete", "progress": 100,
                      "completed_at": firestore.SERVER_TIMESTAMP}, merge=True)
        # Item 15: the dry run returns the FULL per-student plan as CSV, not a
        # sample — the point of a rehearsal is being able to read every row.
        import base64
        csv_bytes = plan_to_csv(plan).encode("utf-8")
        return {"applied": False, "dry_run": True, "run_id": run_id,
                "would_write": diff["write_estimate"],
                "plan_fingerprint": actual_fp,
                "csv": {
                    "filename": f"reset-plan-{school_id}-{run_id[:8]}.csv",
                    "mime": "text/csv",
                    "content_base64": base64.b64encode(csv_bytes).decode("ascii"),
                    "rows": len(plan),
                },
                "diff": _slim(diff)}

    # Per-student updates are merged into ONE write each, so a student who is
    # promoted AND has their inbox cleared costs one write, not three.
    updates = {}

    def upd(sid):
        return updates.setdefault(sid, {})

    if options_in.get("promote"):
        for row in plan:
            if row["action"] == ACTION_PROMOTE:
                upd(row["id"])["classId"] = row["to"]
            elif row["action"] == ACTION_GRADUATE:
                u = upd(row["id"])
                # Graduating students are marked inactive, never deleted — the
                # task is explicit, and their records stay readable.
                u["isActive"] = False
                u["graduated"] = True
    if options_in.get("clear_inbox"):
        for s in students:
            if s.get(INBOX_FIELD):
                upd(s["id"])[INBOX_FIELD] = []
    if options_in.get("clear_reports"):
        for s in students:
            if s.get("reports"):
                upd(s["id"])["reports"] = []

    remove_ids = set(options_in.get("remove_ids") or [])
    written = 0
    failures = []
    total = len(updates) + len(remove_ids)

    try:
        items = list(updates.items())
        for i in range(0, len(items), WRITE_CHUNK):
            batch = db.batch()
            for sid, payload in items[i:i + WRITE_CHUNK]:
                batch.set(ref.collection("students").document(sid),
                          {**payload, "updated_at": firestore.SERVER_TIMESTAMP,
                           "updated_by": email}, merge=True)
            batch.commit()
            written += len(items[i:i + WRITE_CHUNK])
            run_ref.set({"written": written,
                          "progress": round(written / max(total, 1) * 100)}, merge=True)

        # Leavers are marked inactive rather than deleted: the archive holds a
        # copy, but a live record that vanishes is unrecoverable from the UI.
        rem = list(remove_ids)
        for i in range(0, len(rem), WRITE_CHUNK):
            batch = db.batch()
            for sid in rem[i:i + WRITE_CHUNK]:
                batch.set(ref.collection("students").document(sid),
                          {"isActive": False, "left": True,
                           "updated_at": firestore.SERVER_TIMESTAMP, "updated_by": email},
                          merge=True)
            batch.commit()
            written += len(rem[i:i + WRITE_CHUNK])
            run_ref.set({"written": written,
                          "progress": round(written / max(total, 1) * 100)}, merge=True)

        if options_in.get("clear_sheets"):
            deleted = 0
            sheets = list(ref.collection("smart_sheet_entries").select([]).stream())
            for i in range(0, len(sheets), WRITE_CHUNK):
                batch = db.batch()
                for d in sheets[i:i + WRITE_CHUNK]:
                    batch.delete(ref.collection("smart_sheet_entries").document(d.id))
                batch.commit()
                deleted += len(sheets[i:i + WRITE_CHUNK])
            run_ref.set({"sheets_deleted": deleted}, merge=True)

    except Exception as e:
        failures.append(str(e))
        run_ref.set({"status": "failed", "error": str(e), "written": written},
                     merge=True)
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INTERNAL,
            f"Reset stopped after {written} of {total} writes: {e}")

    run_ref.set({"status": "done", "progress": 100, "written": written,
                  "failures": failures, "completed_at": firestore.SERVER_TIMESTAMP},
                 merge=True)

    return {"applied": True, "dry_run": False, "run_id": run_id,
            "written": written, "failures": failures, "diff": _slim(diff)}


def _slim(diff):
    """The diff without the per-student plan — counts and samples only, so a
    3000-student run doesn't return 3000 rows."""
    out = {k: v for k, v in diff.items() if k != "plan"}
    return out


# ─────────────────────── new-school duplicate checking ─────────────────────
@https_fn.on_call(region="asia-south1", memory=options.MemoryOption.MB_512,
                   timeout_sec=60, max_instances=3)
def check_new_school(req: https_fn.CallableRequest):
    """Validate a proposed school id and warn about near-duplicate names.

    The schools collection already holds 'Samartha International School'
    beside 'samarthaschool' and 'sampleschool'. Id uniqueness alone permitted
    all of those, so this also compares names and returns warnings — the
    wizard shows them and still lets the user proceed deliberately.
    """
    _require_ops_admin(req)
    data = req.data or {}
    school_id = (data.get("schoolId") or "").strip()
    name = (data.get("name") or "").strip()

    ok, err = validate_school_id(school_id)

    db = firestore.client()
    # NOTE the ordering: the doc id is assigned AFTER the spread, so a school
    # document carrying its own `id` field cannot shadow the real doc id. The
    # select(["name"]) projection happens to prevent that today, but relying
    # on the projection is how this bug reached production once already —
    # see the "(no class)" grouping fix in functions/assign_survey.
    existing = [{**(d.to_dict() or {}), "id": d.id}
                for d in db.collection("schools").select(["name"]).stream()]

    return {
        "id_valid": ok,
        "id_error": err,
        "id_taken": any(s["id"] == school_id for s in existing),
        "similar": find_similar_schools(name, existing),
        "school_count": len(existing),
    }


# ─────────────────────────────── scan_classes ──────────────────────────────
@https_fn.on_call(region="asia-south1", memory=options.MemoryOption.GB_1,
                   timeout_sec=300, max_instances=3)
def scan_classes(req: https_fn.CallableRequest):
    """Resolve every distinct class value in a school's roster. READ-ONLY.

    Backs the "Scan classes" review table (task Part 2). It writes nothing —
    the review is where a human confirms or corrects each row, and only that
    confirmation writes. Returns one row per DISTINCT raw value, not per
    student, so a 3000-student school comes back as a few dozen rows.
    """
    _require_ops_admin(req)
    data = req.data or {}
    school_id = (data.get("schoolId") or "").strip()
    if not school_id:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT, "Missing schoolId")

    db = firestore.client()
    ref = _school_ref(db, school_id)
    students = _active_students(ref)
    ctx = _resolution_context(ref)

    rows = []
    for raw, info in distinct_class_values(students).items():
        resolved = resolve_class(raw if raw else {}, ctx)
        existing = ctx["class_map"].get(raw)
        rows.append({
            "raw_value": raw,
            "field": info["field"],
            "student_count": info["count"],
            "sample_ids": info["sample_ids"],
            "proposed_class_id": resolved.get("canonical_class_id"),
            "grade_token": resolved.get("grade_token"),
            "grade_canonical": resolved.get("grade_canonical"),
            "grade_ordinal": resolved.get("grade_ordinal"),
            "section": resolved.get("section", ""),
            "confidence": resolved.get("confidence"),
            "label": resolved.get("label"),
            "source": (existing or {}).get("source"),
            "confirmed_by": (existing or {}).get("confirmed_by"),
        })

    rows.sort(key=lambda r: (r["grade_ordinal"] if r["grade_ordinal"] is not None else 99,
                              str(r["section"]), str(r["raw_value"])))
    unresolved = sum(1 for r in rows if r["grade_ordinal"] is None)
    return {
        "rows": rows,
        "student_count": len(students),
        "distinct_count": len(rows),
        "unresolved_count": unresolved,
        "configured_classes": sorted(ctx["class_ids"]),
        "notation": ctx["notation"],
        "separator": ctx["separator"],
    }


# ───────────────────────────── save_class_map ──────────────────────────────
@https_fn.on_call(region="asia-south1", memory=options.MemoryOption.MB_512,
                   timeout_sec=120, max_instances=3)
def save_class_map(req: https_fn.CallableRequest):
    """Persist confirmed/corrected class-map rows for one school.

    Writes ONLY to schools/{id}/class_map — never to a student document. The
    map is what every feature consults afterwards, so correcting a school here
    fixes surveys, reports, exports and promotion at once.

    Confirmed corrections are also offered back to the shared alias dictionary
    (import_aliases), so the next school with the same odd value resolves
    without anyone confirming it again.
    """
    email = _require_ops_admin(req)
    data = req.data or {}
    school_id = (data.get("schoolId") or "").strip()
    rows = data.get("rows") or []
    share_aliases = data.get("shareAliases", True)
    if not school_id or not isinstance(rows, list):
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT, "Missing schoolId or rows")

    db = firestore.client()
    ref = _school_ref(db, school_id)
    written = 0
    shared = 0

    for i in range(0, len(rows), WRITE_CHUNK):
        batch = db.batch()
        for row in rows[i:i + WRITE_CHUNK]:
            raw = str(row.get("raw_value") or "")
            if not raw:
                continue
            # A Firestore doc id cannot contain "/" and cannot be empty; the
            # raw value is kept intact in the document body regardless.
            doc_id = raw.replace("/", "∕")[:1500]
            batch.set(ref.collection("class_map").document(doc_id), {
                "raw_value": raw,
                "canonical_class_id": row.get("canonical_class_id"),
                "grade_token": row.get("grade_token"),
                "grade_canonical": row.get("grade_canonical"),
                "grade_ordinal": row.get("grade_ordinal"),
                "section": row.get("section") or "",
                "student_count": row.get("student_count"),
                "source": "confirmed",
                "confirmed_by": email,
                "confirmed_at": firestore.SERVER_TIMESTAMP,
            }, merge=True)
            written += 1
        batch.commit()

    # Feed corrections back to the shared dictionary so other schools benefit
    # (task item 7). Best-effort: a failure here must not lose the class map,
    # which is the thing the user actually asked to save.
    if share_aliases:
        try:
            for row in rows:
                canon = row.get("grade_canonical")
                raw = str(row.get("raw_value") or "")
                if not canon or not raw:
                    continue
                db.collection("import_aliases").document(
                    f"grade::{raw.lower().replace('/', '_')[:200]}"
                ).set({
                    "kind": "grade",
                    "raw": raw,
                    "canonical": canon,
                    "learned_from_school": school_id,
                    "confirmed_by": email,
                    "confirmed_at": firestore.SERVER_TIMESTAMP,
                }, merge=True)
                shared += 1
        except Exception as e:                                   # noqa: BLE001
            print(f"alias sharing failed (class map saved regardless): {e}")

    return {"written": written, "aliases_shared": shared}


# ───────────────────────────── class_health ────────────────────────────────
@https_fn.on_call(region="asia-south1", memory=options.MemoryOption.GB_1,
                   timeout_sec=540, max_instances=2)
def class_health(req: https_fn.CallableRequest):
    """Read-only class-resolution health across EVERY school (task Part 5).

    The in-app twin of tools/class_inventory.py, so the estate can be checked
    without a shell. Reads students id-and-class only where possible; a large
    estate is the reason for the 540s timeout.
    """
    _require_ops_admin(req)
    db = firestore.client()

    out = []
    for school in db.collection("schools").select(["name", "isActive"]).stream():
        sdata = school.to_dict() or {}
        if sdata.get("isActive") is False:
            continue
        ref = db.collection("schools").document(school.id)
        try:
            students = _active_students(ref)
            ctx = _resolution_context(ref)
        except Exception as e:                                   # noqa: BLE001
            out.append({"school_id": school.id, "name": sdata.get("name"),
                        "error": str(e)})
            continue

        confident = 0
        unmapped_labels = {}
        for s in students:
            r = resolve_class(s, ctx)
            if r["grade_ordinal"] is not None and r["confidence"] in (CONF_HIGH, CONF_MEDIUM):
                confident += 1
            else:
                key = r.get("label") or "(no class field)"
                unmapped_labels[key] = unmapped_labels.get(key, 0) + 1

        confirmed = sum(1 for v in ctx["class_map"].values()
                        if v.get("source") == "confirmed")
        total = len(students)
        out.append({
            "school_id": school.id,
            "name": sdata.get("name") or school.id,
            "students": total,
            "distinct_class_values": len(distinct_class_values(students)),
            "resolved": confident,
            "unmapped": total - confident,
            "pct_resolved": round(confident / total * 100, 1) if total else 100.0,
            "configured_classes": len(ctx["class_ids"]),
            "class_map_entries": len(ctx["class_map"]),
            "has_confirmed_map": confirmed > 0,
            "notation": ctx["notation"],
            "top_unmapped": sorted(unmapped_labels.items(), key=lambda x: -x[1])[:10],
        })

    out.sort(key=lambda r: (r.get("unmapped", 0) * -1, r.get("school_id", "")))
    totals = {
        "schools": len(out),
        "students": sum(r.get("students", 0) for r in out),
        "resolved": sum(r.get("resolved", 0) for r in out),
        "unmapped": sum(r.get("unmapped", 0) for r in out),
        "schools_needing_attention": sum(1 for r in out if r.get("unmapped")),
    }
    return {"schools": out, "totals": totals}
