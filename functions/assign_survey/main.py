#!/usr/bin/env python3
"""
Survey assignment — day-to-day ops Cloud Functions.

Replaces the manual "push survey IDs into each student's surveyInbox by
script" step with a reviewed, batched, logged operation.

Four callables, same source directory:
  assign_survey   preview or apply an assign/unassign run over SEVERAL
                  surveys at once (the v2 UI selects N surveys x M classes
                  in the matrix and acts on all of it as one action)
  survey_matrix   the classes x surveys grid: per-cell assigned/responded/
                  total, cached, so the browser never counts 3000 students
  survey_report   class-wise / survey-wise / cumulative completion reports
                  as CSV or XLSX, respecting the caller's active filters
  class_detail    one class's students + responders, for the drill-down —
                  bounded by class size, not school size

Why server-side at all (the task is explicit, and it earns it): a school with
3000+ students is 3000 reads and up to 7 batched writes. Doing that from the
browser means a tab that must stay open, no atomic batching guarantees, and
no audit trail. Here it is one pass, chunked at 450 writes (Firestore's limit
is 500 — the margin covers the progress update sharing the batch window), with
progress streamed through the run doc so the UI can follow along.

The pure decision logic (junk filter, active check, target planning) lives in
survey_rules.py so it can be unit-tested without a Firebase environment —
main.py calls initialize_app() at import time. See tests/test_survey_rules.py.

Safety contract, all enforced here rather than trusted to the caller:
  - PREVIEW IS THE SAME CODE PATH as apply. `dryRun` stops before the writes;
    everything above it — target resolution, skip rules, counting — is
    identical, so the number shown is the number that happens.
  - arrayUnion / arrayRemove ONLY. Re-assigning is idempotent and can never
    duplicate; unassigning never touches a doc that doesn't have the survey.
  - NEVER writes to survey documents. This function assigns; it does not edit
    or delete surveys, including the junk/test docs (those are filtered from
    the UI only).
  - Inactive students are skipped, and the count is reported so the preview
    explains itself.

Deploy (see functions/DEPLOY.md):
  gcloud functions deploy assign_survey \
    --gen2 --runtime python312 --region asia-south1 \
    --source . --entry-point assign_survey \
    --trigger-http --allow-unauthenticated --project clarified-1501 \
    --memory 512MB --timeout 540s --max-instances 3

  gcloud functions deploy survey_matrix \
    --gen2 --runtime python312 --region asia-south1 \
    --source . --entry-point survey_matrix \
    --trigger-http --allow-unauthenticated --project clarified-1501 \
    --memory 1024MB --timeout 300s --max-instances 3

  gcloud functions deploy survey_report \
    --gen2 --runtime python312 --region asia-south1 \
    --source . --entry-point survey_report \
    --trigger-http --allow-unauthenticated --project clarified-1501 \
    --memory 1024MB --timeout 300s --max-instances 3

  gcloud functions deploy class_detail \
    --gen2 --runtime python312 --region asia-south1 \
    --source . --entry-point class_detail \
    --trigger-http --allow-unauthenticated --project clarified-1501 \
    --memory 512MB --timeout 120s --max-instances 3
"""
import base64
import re
from datetime import datetime, timezone

import firebase_admin
from firebase_admin import firestore
from firebase_functions import https_fn, options

from survey_rules import (
    DEFAULT_INBOX_FIELD, is_inactive, is_real_survey, student_status,
    plan_targets, plan_multi, filter_scope, build_matrix, in_active_window,
    student_sort_key,
)
from survey_reports import (
    class_wise_rows, survey_wise_rows, cumulative_rows, rows_to_csv, report_header,
)

# Same reasoning as generate_import/main.py: the on_call framework verifies
# the caller's ID token before our body runs, and that needs the Admin SDK
# already initialized.
firebase_admin.initialize_app()

# Mirrors src/config/opsAdmins.js — keep in sync. Server-side is the
# authoritative check; the frontend's isOpsAdmin() is only a UI gate.
OPS_ADMIN_EMAILS = {"sid@ops.clarified.in", "angel@ops.clarified.in"}

WRITE_CHUNK = 450


def _require_ops_admin(req: https_fn.CallableRequest) -> str:
    if req.auth is None:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.UNAUTHENTICATED, "Sign in required.")
    email = str((req.auth.token or {}).get("email") or "").strip().lower()
    if email not in OPS_ADMIN_EMAILS:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.PERMISSION_DENIED,
            "Not authorized for survey assignment.")
    return email


def _collection_for(audience: str) -> str:
    return "staffs" if audience == "staff" else "students"


def _resolve_targets(db, school_id, audience, scope):
    """Every candidate recipient for this scope, before skip rules.

    Reads the whole collection once and filters in memory rather than issuing
    per-class queries: one pass is cheaper and simpler than N queries at 14+
    classes, and the same pass feeds the counting the preview needs.
    """
    coll = db.collection("schools").document(school_id).collection(_collection_for(audience))
    docs = [(d.id, d.to_dict() or {}) for d in coll.stream()]
    try:
        return filter_scope(docs, scope, audience)
    except ValueError as e:
        raise https_fn.HttpsError(https_fn.FunctionsErrorCode.INVALID_ARGUMENT, str(e))


@https_fn.on_call(region="asia-south1", memory=options.MemoryOption.MB_512,
                   timeout_sec=540, max_instances=3)
def assign_survey(req: https_fn.CallableRequest):
    """Preview or apply one assign/unassign run over SEVERAL surveys.

    Request:
      {schoolId, runId, surveyIds: [...], audience: students|staff,
       mode: assign|unassign, scope: {type, classIds?, ids?},
       dryRun: bool, inboxField?: str}

    Response:
      {survey_ids, target_count, will_change, already_count, inactive_skipped,
       existing_field_count, per_survey: [...], inbox_field, applied, run_id}
    """
    email = _require_ops_admin(req)
    data = req.data or {}

    school_id = (data.get("schoolId") or "").strip()
    # v2 assigns SEVERAL surveys in one action (3 surveys x 5 classes is one
    # run, not fifteen). `surveyId` is still accepted so a single-cell action
    # doesn't need to wrap itself in a list.
    survey_ids = [str(x).strip() for x in (data.get("surveyIds") or []) if str(x).strip()]
    if not survey_ids and (data.get("surveyId") or "").strip():
        survey_ids = [(data.get("surveyId") or "").strip()]
    run_id = (data.get("runId") or "").strip()
    audience = (data.get("audience") or "students").strip()
    mode = (data.get("mode") or "assign").strip()
    scope = data.get("scope") or {"type": "school"}
    dry_run = bool(data.get("dryRun", True))
    inbox_field = (data.get("inboxField") or DEFAULT_INBOX_FIELD).strip()

    missing = []
    if not school_id:
        missing.append("schoolId")
    if not survey_ids:
        missing.append("surveyIds (or surveyId)")
    if audience not in ("students", "staff"):
        missing.append(f"audience (got {audience!r})")
    if mode not in ("assign", "unassign"):
        missing.append(f"mode (got {mode!r})")
    if not dry_run and not run_id:
        missing.append("runId (required to apply, so progress is followable)")
    if missing:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT,
            f"Missing/invalid field(s): {'; '.join(missing)}")

    db = firestore.client()
    school_ref = db.collection("schools").document(school_id)

    # Every selected survey must exist and be a real one. Assigning a
    # junk/test doc would push a broken id into thousands of inboxes;
    # unassigning is allowed regardless, so ids the old scripts pushed can
    # always be cleaned up.
    surveys = {}
    for sid in survey_ids:
        snap = school_ref.collection("surveys").document(sid).get()
        if not snap.exists:
            raise https_fn.HttpsError(
                https_fn.FunctionsErrorCode.NOT_FOUND,
                f"Survey {sid} not found for this school.")
        surveys[sid] = snap.to_dict() or {}
        if mode == "assign" and not is_real_survey(surveys[sid]):
            raise https_fn.HttpsError(
                https_fn.FunctionsErrorCode.FAILED_PRECONDITION,
                f"Survey {sid} looks like a test/incomplete document "
                "(no name translations or no questions) — refusing to assign it.")

    def label(sid):
        return (surveys.get(sid, {}).get("name") or {}).get("en") or sid

    # One roster read serves every selected survey — the expensive part is
    # the read, not the per-survey planning over it.
    docs = _resolve_targets(db, school_id, audience, scope)
    multi = plan_multi(docs, survey_ids, mode, inbox_field)

    result = {
        "run_id": run_id or None,
        "inbox_field": inbox_field,
        "survey_ids": survey_ids,
        "target_count": len(docs),
        "will_change": multi["total_writes"],
        "already_count": multi["total_already"],
        "inactive_skipped": multi["inactive"],
        "existing_field_count": max(
            (p["existing_field"] for p in multi["per_survey"].values()), default=0),
        # Per-survey breakdown so the confirm dialog can explain a mixed
        # selection ("AAM1-mid: 120 new, AAM2-prep: 8 new") instead of
        # showing one opaque total.
        "per_survey": [
            {
                "survey_id": sid,
                "label": label(sid),
                "will_change": len(multi["per_survey"][sid]["to_write"]),
                "already": multi["per_survey"][sid]["already"],
            }
            for sid in survey_ids
        ],
        "applied": False,
    }
    if dry_run:
        return result

    coll_name = _collection_for(audience)
    run_ref = school_ref.collection("survey_assignments").document(run_id)
    run_ref.set({
        "survey_ids": survey_ids,
        "survey_names": [label(sid) for sid in survey_ids],
        "audience": audience,
        "mode": mode,
        "scope_type": scope.get("type") or "school",
        "scope_value": scope.get("classIds") or scope.get("ids") or None,
        "inbox_field": inbox_field,
        "target_count": multi["total_writes"],
        "assigned_count": 0,
        "skipped_count": multi["total_already"] + multi["inactive"],
        "inactive_skipped": multi["inactive"],
        "status": "running",
        "progress": 0,
        "run_by": email,
        "run_at": firestore.SERVER_TIMESTAMP,
    })

    total = multi["total_writes"]
    written = 0
    try:
        for sid in survey_ids:
            op = (firestore.ArrayUnion([sid]) if mode == "assign"
                  else firestore.ArrayRemove([sid]))
            ids = multi["per_survey"][sid]["to_write"]
            for i in range(0, len(ids), WRITE_CHUNK):
                batch = db.batch()
                chunk = ids[i:i + WRITE_CHUNK]
                for doc_id in chunk:
                    batch.set(school_ref.collection(coll_name).document(doc_id),
                              {inbox_field: op}, merge=True)
                batch.commit()
                written += len(chunk)
                # Progress lands on the run doc after each chunk — the UI
                # streams this rather than polling, which is what makes a
                # 3000-student, multi-survey run watchable.
                run_ref.set({"assigned_count": written,
                              "progress": round(written / max(total, 1) * 100)}, merge=True)
    except Exception as e:
        run_ref.set({"status": "failed", "error": str(e), "assigned_count": written}, merge=True)
        raise https_fn.HttpsError(https_fn.FunctionsErrorCode.INTERNAL, str(e))

    run_ref.set({
        "status": "done", "progress": 100, "assigned_count": written,
        "completed_at": firestore.SERVER_TIMESTAMP,
    }, merge=True)

    result["applied"] = True
    result["written"] = written
    return result


# ─────────────────────────── shared data loading ───────────────────────────
def _load_active_students(school_ref):
    out = []
    for d in school_ref.collection("students").stream():
        doc = d.to_dict() or {}
        if str(doc.get("type") or "student") != "student" or is_inactive(doc):
            continue
        doc["id"] = d.id
        out.append(doc)
    return out


def _load_real_surveys(school_ref, active_window_only=False):
    """Real (non-junk) surveys, optionally limited to the live window."""
    now = datetime.now(timezone.utc)
    out = []
    for d in school_ref.collection("surveys").stream():
        doc = d.to_dict() or {}
        if not is_real_survey(doc):
            continue
        doc["id"] = d.id
        if active_window_only and not in_active_window(doc, now):
            continue
        out.append(doc)
    out.sort(key=lambda x: ((x.get("name") or {}).get("en") or x["id"]).lower())
    return out


def _load_responders(school_ref, survey_ids):
    """{survey_id: set(student_id)} — who has actually responded.

    Per-CLASS completion needs to know WHICH students responded, not just how
    many, so a count() aggregation isn't enough on its own. The compromise
    that keeps this affordable is `select([])`: it streams document
    references with NO field data, so a 27k-response school transfers ids
    rather than full response bodies.

    Response identity is read from the doc id first (the observed layout),
    falling back to common student-id field names. A survey whose responses
    can't be attributed lands as an empty set and is reported via
    `unresolved_response_surveys` — visibly "not measurable", never silently
    "nobody responded".
    """
    responders = {}
    unresolved = []
    for sid in survey_ids:
        ids = set()
        got_any = False
        try:
            for r in school_ref.collection("surveys").document(sid).collection(
                    "responses").select(["studentId", "student_id", "uid"]).stream():
                got_any = True
                data = r.to_dict() or {}
                ids.add(str(data.get("studentId") or data.get("student_id")
                             or data.get("uid") or r.id))
        except Exception as e:
            print(f"_load_responders: {sid}: {e}")
            unresolved.append(sid)
            responders[sid] = set()
            continue
        if got_any and not ids:
            unresolved.append(sid)
        responders[sid] = ids
    return responders, unresolved


@https_fn.on_call(region="asia-south1", memory=options.MemoryOption.GB_1,
                   timeout_sec=300, max_instances=3)
def survey_matrix(req: https_fn.CallableRequest):
    """The classes x surveys grid for one school.

    Returns {surveys, rows, totals, active_student_count,
             unresolved_response_surveys, generated_at}, where each row is
    {class_id, student_count, cells: {survey_id: {assigned, responded, total}}}.

    Computed server-side in one roster pass plus one id-only pass per survey,
    rather than pulling 3000 student docs into the browser to count them
    there. Results are cached to survey_matrix_cache/current so revisiting
    the tab is instant; `force` recomputes.
    """
    _require_ops_admin(req)
    data = req.data or {}
    school_id = (data.get("schoolId") or "").strip()
    inbox_field = (data.get("inboxField") or DEFAULT_INBOX_FIELD).strip()
    active_window_only = bool(data.get("activeWindowOnly"))
    force = bool(data.get("force"))
    if not school_id:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT, "Missing schoolId")

    db = firestore.client()
    school_ref = db.collection("schools").document(school_id)
    cache_ref = school_ref.collection("survey_matrix_cache").document("current")

    if not force:
        snap = cache_ref.get()
        if snap.exists:
            cached = snap.to_dict() or {}
            if cached.get("active_window_only") == active_window_only:
                cached["from_cache"] = True
                return cached

    surveys = _load_real_surveys(school_ref, active_window_only)
    survey_ids = [s["id"] for s in surveys]
    students = _load_active_students(school_ref)
    responders, unresolved = _load_responders(school_ref, survey_ids)

    matrix = build_matrix(students, survey_ids, responders, inbox_field)

    payload = {
        "surveys": [
            {
                "id": s["id"],
                "label": (s.get("name") or {}).get("en") or s["id"],
                # Timestamps are returned as epoch millis so the browser
                # doesn't have to deal with two different serializations.
                "start_at": _millis(s.get("startAt")),
                "expires_at": _millis(s.get("expiresAt")),
                "segment": s.get("segmentForInternalPurpose") or "",
            }
            for s in surveys
        ],
        "rows": matrix["rows"],
        "totals": matrix["totals"],
        "active_student_count": len(students),
        "unresolved_response_surveys": unresolved,
        "active_window_only": active_window_only,
        "generated_at": firestore.SERVER_TIMESTAMP,
    }
    cache_ref.set(payload)
    payload["generated_at"] = None  # SERVER_TIMESTAMP sentinel isn't serializable
    payload["from_cache"] = False
    return payload


def _millis(ts):
    if ts is None:
        return None
    try:
        return int(ts.timestamp() * 1000)
    except AttributeError:
        return None


@https_fn.on_call(region="asia-south1", memory=options.MemoryOption.MB_512,
                   timeout_sec=120, max_instances=3)
def class_detail(req: https_fn.CallableRequest):
    """One class's students plus who among them has responded.

    Exists so the matrix drill-down doesn't have to pull a 3000-student
    roster into the browser to show 30 rows: the response lookup is scoped to
    this class's student ids, so both the read and the payload stay bounded by
    class size rather than school size.
    """
    _require_ops_admin(req)
    data = req.data or {}
    school_id = (data.get("schoolId") or "").strip()
    class_id = (data.get("classId") or "").strip()
    inbox_field = (data.get("inboxField") or DEFAULT_INBOX_FIELD).strip()
    if not school_id or not class_id:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT, "Missing schoolId or classId")

    db = firestore.client()
    school_ref = db.collection("schools").document(school_id)

    students = []
    for d in school_ref.collection("students").where("classId", "==", class_id).stream():
        doc = d.to_dict() or {}
        if str(doc.get("type") or "student") != "student" or is_inactive(doc):
            continue
        students.append({
            "id": d.id,
            "name": doc.get("name") or d.id,
            "rollNo": doc.get("rollNo") or "",
            "classId": doc.get("classId") or "",
            inbox_field: doc.get(inbox_field) or [],
        })
    students.sort(key=student_sort_key)

    survey_ids = [s["id"] for s in _load_real_surveys(school_ref)]
    responders, _ = _load_responders(school_ref, survey_ids)
    member_ids = {s["id"] for s in students}
    scoped = {sid: sorted(ids & member_ids) for sid, ids in responders.items()}

    return {"students": students, "responders": scoped}


@https_fn.on_call(region="asia-south1", memory=options.MemoryOption.GB_1,
                   timeout_sec=300, max_instances=3)
def survey_report(req: https_fn.CallableRequest):
    """Generate a completion/pending report and return it for download.

    Scopes: class_wise | survey_wise | cumulative. Formats: csv | xlsx.
    Respects the caller's active filters (classIds, statuses, search,
    activeWindowOnly) so a filtered view downloads filtered data, and states
    the scope/filters/timestamp in a header row.

    Generated server-side for the same reason the matrix is, and returned as
    base64 rather than written to Storage: these files are tens to low
    hundreds of KB even for a 3000-student school, comfortably inside the
    callable response limit, and it avoids leaving report files lying around
    in a bucket with their own lifecycle to manage.
    """
    _require_ops_admin(req)
    data = req.data or {}
    school_id = (data.get("schoolId") or "").strip()
    scope = (data.get("scope") or "class_wise").strip()
    fmt = (data.get("format") or "csv").strip().lower()
    inbox_field = (data.get("inboxField") or DEFAULT_INBOX_FIELD).strip()
    filters = data.get("filters") or {}
    class_ids = [str(c) for c in (filters.get("classIds") or [])]
    wanted_survey_ids = [str(s) for s in (data.get("surveyIds") or [])]
    active_window_only = bool(filters.get("activeWindowOnly"))
    search = str(filters.get("search") or "").strip().lower()
    status_filter = str(filters.get("status") or "all").strip()

    if not school_id:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT, "Missing schoolId")
    if scope not in ("class_wise", "survey_wise", "cumulative"):
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT, f"Unknown scope: {scope}")
    if fmt not in ("csv", "xlsx"):
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT, f"Unknown format: {fmt}")
    if scope == "survey_wise" and len(wanted_survey_ids) != 1:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT,
            "Survey-wise reports need exactly one survey.")

    db = firestore.client()
    school_ref = db.collection("schools").document(school_id)

    surveys = _load_real_surveys(school_ref, active_window_only)
    if wanted_survey_ids:
        surveys = [s for s in surveys if s["id"] in set(wanted_survey_ids)]
    if not surveys:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.FAILED_PRECONDITION,
            "No surveys matched the selected filters.")
    survey_ids = [s["id"] for s in surveys]
    labels = {s["id"]: ((s.get("name") or {}).get("en") or s["id"]) for s in surveys}

    students = _load_active_students(school_ref)
    if class_ids:
        students = [s for s in students if str(s.get("classId") or "") in set(class_ids)]
    if search:
        students = [s for s in students
                    if search in str(s.get("name") or "").lower()
                    or search in str(s.get("rollNo") or "").lower()]

    responders, unresolved = _load_responders(school_ref, survey_ids)

    # Status filter applies to the STUDENT rows of the detail scopes. A
    # cumulative report is a count summary, so filtering individual students
    # out of it would silently misreport the totals it exists to show.
    if status_filter != "all" and scope in ("class_wise", "survey_wise"):
        students = [
            s for s in students
            if any(student_status(s, sid, responders.get(sid), inbox_field) == status_filter
                   for sid in survey_ids)
        ]

    header = report_header(scope, school_id, [labels[i] for i in survey_ids],
                            {"classes": ",".join(class_ids) if class_ids else None,
                             "status": status_filter,
                             "search": search or None,
                             "active_window_only": active_window_only})

    if scope == "class_wise":
        rows = class_wise_rows(students, survey_ids, labels, responders, inbox_field)
        blocks = [("Students", rows)]
    elif scope == "survey_wise":
        detail, summary = survey_wise_rows(students, survey_ids[0], labels[survey_ids[0]],
                                            responders, inbox_field)
        rows = detail
        blocks = [("Students", detail), ("Per-class summary", summary)]
    else:
        rows = cumulative_rows(students, survey_ids, labels, responders, inbox_field)
        blocks = [("Class x survey summary", rows)]

    if fmt == "csv":
        extra = blocks[1:] if len(blocks) > 1 else []
        content = rows_to_csv(rows, header, extra)
        payload = base64.b64encode(content.encode("utf-8")).decode("ascii")
        mime = "text/csv"
    else:
        payload = base64.b64encode(_build_xlsx(header, blocks, scope, students, survey_ids,
                                                labels, responders, inbox_field)).decode("ascii")
        mime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

    return {
        "filename": f"{school_id}_{scope}_{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M')}.{fmt}",
        "mime": mime,
        "content_base64": payload,
        "row_count": len(rows),
        "unresolved_response_surveys": unresolved,
    }


def _build_xlsx(header, blocks, scope, students, survey_ids, labels, responders, inbox_field):
    """XLSX bytes. Class-wise gets one sheet per class (the task asks for it,
    and a 40-class school is unreadable as one flat sheet); everything else
    gets a sheet per block."""
    import io
    from openpyxl import Workbook

    wb = Workbook()
    wb.remove(wb.active)

    def write_sheet(title, rows):
        # Excel sheet names: 31 chars max, and []:*?/\ are illegal.
        safe = re.sub(r"[\\/*?:\[\]]", "-", title)[:31] or "Sheet"
        ws = wb.create_sheet(safe)
        ws.append([header])
        if rows:
            ws.append(list(rows[0].keys()))
            for r in rows:
                ws.append(list(r.values()))
        else:
            ws.append(["(no rows matched the selected scope and filters)"])
        return ws

    if scope == "class_wise":
        by_class = {}
        for s in students:
            by_class.setdefault(s.get("classId") or "(no class)", []).append(s)
        if not by_class:
            write_sheet("Students", [])
        for class_id in sorted(by_class):
            write_sheet(class_id, class_wise_rows(
                by_class[class_id], survey_ids, labels, responders, inbox_field))
    else:
        for title, rows in blocks:
            write_sheet(title, rows)

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()
