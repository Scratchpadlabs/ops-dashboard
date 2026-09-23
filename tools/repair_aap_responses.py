#!/usr/bin/env python3
"""Repair one school's AAP survey responses: duplicate activities and missing
curricular goals / competencies. DRY RUN by default — nothing is written
unless --apply is passed.

    python3 tools/repair_aap_responses.py --project clarified-1501 --school Hillgreen_Highschool
    python3 tools/repair_aap_responses.py --project clarified-1501 --school Hillgreen_Highschool --apply

Where responses live: schools/{school}/surveys/{activityId}/responses/{id},
id = "{teacherId}_{classId}_{topicId}", topicId = "{Grade}_{Subject}_{Topic}",
and "{Grade}_{Subject}" is the school-setup subject doc. Only zzz-prefixed
(AAP) surveys are looked at.

1. DUPLICATE ACTIVITIES — the same response id under more than one activity.
   The teacher app starts a fresh response whenever a teacher reopens a topic
   and picks a different activity, instead of moving the one they had. One is
   kept: the most recently written (the teacher's latest intent). Any
   student/question it left blank is filled from the others (newest first),
   and so are goals/competencies if it has none. The others are copied to
   schools/{school}/aap_response_archive/ and then deleted, and the topic's
   survey_initiated_by[teacher] is pointed at the kept activity, so the
   teacher app reopens the kept response. The dry run counts CONFLICTS
   (a student/question with a different non-blank answer in a dropped copy);
   remark generation currently pools answers from every copy, so a conflict
   is a place where removing the copy can change a remark.

2. MISSING GOALS / COMPETENCIES — filled by matching, in this order, and only
   with values that still exist in the subject's curricular_goals:
     a. competencies present but goals empty → the goals those competencies
        sit under in School Setup (exact, not a guess)
     b. same teacher, same subject + topic, another class
     c. any teacher, same subject + topic
     d. same teacher, same subject, any topic
     e. the subject has exactly one goal and it has exactly one competency
   A step only applies when one selection is the clear most common (a tie
   falls through to the next step). Anything still empty is listed as
   UNRESOLVED for someone to fill in via the dashboard's editor.

3. MISSING activityId / activityName — filled from the survey the response
   is under and that activity's name.

Every doc that is changed or deleted is saved to
aap_repair_backup_<school>_<timestamp>.json first (with --apply). To undo, restore
those docs from the backup or from aap_response_archive.
"""

import argparse
import datetime
import json
import sys
from collections import Counter, defaultdict

TRAITS = 3  # awareness, sensitivity, creativity — answers[0..2]


def connect(project):
    try:
        from google.cloud import firestore
    except ImportError:
        sys.exit("Missing dependency. Run:  pip install google-cloud-firestore")
    client = firestore.Client(project=project)
    try:
        next(iter(client.collection("schools").select([]).limit(1).stream(timeout=20)), None)
    except Exception as e:                                       # noqa: BLE001
        if any(m in str(e) for m in ("email", "credential", "UNAUTHENTICATED", "metadata")):
            sys.exit("Auth failed. Run:\n  gcloud auth application-default login\n"
                     f"  gcloud auth application-default set-quota-project {project}")
        sys.exit(f"Could not reach Firestore: {e}")
    return client, firestore


def goal_options(subject_data):
    out = {}
    for goal_map in (subject_data.get("curricular_goals") or []):
        if not isinstance(goal_map, dict):
            continue
        for goal, comps in goal_map.items():
            goal = str(goal or "").strip()
            if goal:
                out[goal] = [str(c).strip() for c in (comps if isinstance(comps, list) else []) if str(c).strip()]
    return out


def split_response_id(resp_id, subject_ids):
    """(teacher, class_id, subject_doc_id, topic_id) or None. Matches the
    subject doc id against the real subject docs rather than re-deriving the
    grade, so "7_KALAM_VII_Maths_Term1" → class "7_KALAM", subject "VII_Maths"."""
    parts = resp_id.split("_")
    for i in range(2, len(parts)):
        rest = "_".join(parts[i:])
        matches = [sid for sid in subject_ids if rest.startswith(sid + "_") or rest == sid]
        if matches:
            sid = max(matches, key=len)
            return parts[0], "_".join(parts[1:i]), sid, rest
    return None


def is_answered(v):
    return bool(v) and v != "Not Applicable"


def clean_selection(goals, comps, options):
    """Keep only goals that exist, and competencies under a kept goal."""
    goals = [g for g in goals if g in options]
    allowed = {c for g in goals for c in options[g]}
    comps = [c for c in comps if c in allowed]
    return goals, comps


def most_common(selections):
    """The single most common (goals, comps) pair, or None on a tie/empty."""
    counts = Counter((tuple(g), tuple(c)) for g, c in selections if g and c)
    if not counts:
        return None
    ranked = counts.most_common(2)
    if len(ranked) > 1 and ranked[0][1] == ranked[1][1]:
        return None
    g, c = ranked[0][0]
    return list(g), list(c)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--project", required=True)
    ap.add_argument("--school", required=True)
    ap.add_argument("--apply", action="store_true", help="write the changes (default: dry run)")
    args = ap.parse_args()

    client, firestore = connect(args.project)
    school_ref = client.collection("schools").document(args.school)
    if not school_ref.get().exists:
        sys.exit(f"School {args.school!r} not found")

    subjects = {d.id: d.to_dict() or {} for d in school_ref.collection("subjects").stream()}
    options_by_subject = {sid: goal_options(d) for sid, d in subjects.items()}
    activity_names = {d.id: str((d.to_dict() or {}).get("name") or "")
                      for d in school_ref.collection("activities").stream()}

    # Every AAP response, grouped by response id (duplicates share the id).
    by_id = defaultdict(list)
    unparsed = []
    for survey in school_ref.collection("surveys").stream():
        if not survey.id.lower().startswith("zzz"):
            continue
        # The teacher app looks a survey up by its `id` field (normally equal
        # to the doc id) — that is the activity id a response should carry.
        activity_id = str((survey.to_dict() or {}).get("id") or survey.id)
        for resp in survey.reference.collection("responses").stream():
            split = split_response_id(resp.id, subjects)
            if not split:
                unparsed.append(f"{survey.id}/{resp.id}")
                continue
            data = resp.to_dict() or {}
            teacher, class_id, subject_id, topic_id = split
            by_id[resp.id].append({
                "ref": resp.reference, "surveyId": survey.id, "activityId": activity_id, "id": resp.id,
                "teacher": teacher, "classId": class_id, "subjectId": subject_id, "topicId": topic_id,
                "updated": resp.update_time, "data": data,
            })

    backup = []          # original docs, before any change
    writes = []          # (label, callable)
    report = defaultdict(list)

    def answered_count(data):
        return sum(1 for q in (data.get("answers") or [])[:TRAITS]
                   for k, v in q.items() if k != "questionText" and is_answered(v))

    # ── 1. duplicates ────────────────────────────────────────────────────
    final = {}  # response id -> the doc dict that survives (with merged data)
    for resp_id, docs in sorted(by_id.items()):
        docs.sort(key=lambda d: d["updated"], reverse=True)
        keep = docs[0]
        merged = json.loads(json.dumps(keep["data"], default=str))
        if len(docs) > 1:
            answers = merged.setdefault("answers", [])
            filled = conflicts = 0
            for other in docs[1:]:
                for q, other_q in enumerate((other["data"].get("answers") or [])[:TRAITS]):
                    while len(answers) <= q:
                        answers.append({"questionText": other_q.get("questionText", "")})
                    for sid, v in other_q.items():
                        if sid == "questionText" or not is_answered(v):
                            continue
                        mine = answers[q].get(sid)
                        if not is_answered(mine):
                            answers[q][sid] = v
                            filled += 1
                        elif mine != v:
                            conflicts += 1
                if not merged.get("selectedGoals") and not merged.get("selectedCompetencies") \
                        and (other["data"].get("selectedGoals") or other["data"].get("selectedCompetencies")):
                    merged["selectedGoals"] = list(other["data"].get("selectedGoals") or [])
                    merged["selectedCompetencies"] = list(other["data"].get("selectedCompetencies") or [])
            dropped = [f"{activity_names.get(d['activityId']) or d['activityId']} ({answered_count(d['data'])} answers)"
                       for d in docs[1:]]
            report["duplicates"].append(
                f"{resp_id}: keep {activity_names.get(keep['activityId']) or keep['activityId']} "
                f"({answered_count(keep['data'])} answers, newest) · drop {', '.join(dropped)} · "
                f"{filled} blanks filled from dropped · {conflicts} conflicting answers")
        final[resp_id] = {**keep, "merged": merged, "dropped": docs[1:]}

    # ── 2. missing goals / competencies ──────────────────────────────────
    def selection(entry):
        return (list(entry["merged"].get("selectedGoals") or []),
                list(entry["merged"].get("selectedCompetencies") or []))

    # Pools of existing complete selections, validated against School Setup.
    pools = defaultdict(list)
    for e in final.values():
        g, c = clean_selection(*selection(e), options_by_subject.get(e["subjectId"], {}))
        if g and c:
            pools[("tt", e["teacher"], e["subjectId"], e["topicId"])].append((g, c, e["id"]))
            pools[("st", e["subjectId"], e["topicId"])].append((g, c, e["id"]))
            pools[("ts", e["teacher"], e["subjectId"])].append((g, c, e["id"]))

    for e in final.values():
        goals, comps = selection(e)
        if goals and comps:
            continue
        options = options_by_subject.get(e["subjectId"], {})
        how = None
        new = None
        if comps and not goals:
            derived = [g for g, cs in options.items() if any(c in cs for c in comps)]
            if derived:
                new, how = (derived, comps), "goals derived from the selected competencies"
        if new is None and goals and not comps:
            cands = [(g, c) for key in (("tt", e["teacher"], e["subjectId"], e["topicId"]),
                                        ("st", e["subjectId"], e["topicId"]),
                                        ("ts", e["teacher"], e["subjectId"]))
                     for g, c, src in pools[key] if src != e["id"] and set(g) & set(goals)]
            comps_ok = [c for _, cs in cands for c in cs if any(c in options.get(g, []) for g in goals)]
            if comps_ok:
                top = Counter(comps_ok).most_common(2)
                if len(top) == 1 or top[0][1] > top[1][1]:
                    new, how = (goals, [top[0][0]]), "competency matched from other responses with the same goal"
        if new is None and not goals and not comps:
            for key, label in ((("tt", e["teacher"], e["subjectId"], e["topicId"]), "same teacher, same topic, another class"),
                               (("st", e["subjectId"], e["topicId"]), "same subject + topic, another teacher"),
                               (("ts", e["teacher"], e["subjectId"]), "same teacher, same subject, another topic")):
                pick = most_common([(g, c) for g, c, src in pools[key] if src != e["id"]])
                if pick:
                    new, how = pick, label
                    break
            if new is None and len(options) == 1:
                (only_goal, only_comps), = options.items()
                if len(only_comps) == 1:
                    new, how = ([only_goal], only_comps), "subject has a single goal and competency"
        if new is None:
            report["unresolved"].append(
                f"{e['id']} [{activity_names.get(e['activityId']) or e['activityId']}]: "
                f"goals={goals or '—'} competencies={comps or '—'} "
                f"({'no curricular goals in School Setup' if not options else 'no unambiguous match'})")
            continue
        e["merged"]["selectedGoals"], e["merged"]["selectedCompetencies"] = new
        report["filled"].append(f"{e['id']}: {how} → goals={new[0]} competencies={new[1]}")

    # ── 3. activity fields ───────────────────────────────────────────────
    for e in final.values():
        m = e["merged"]
        aid = e["activityId"]
        name = activity_names.get(aid, "")
        if m.get("activityId") != aid or (name and m.get("activityName") != name):
            report["activity"].append(
                f"{e['id']}: activity {m.get('activityId') or '—'} / {m.get('activityName') or '—'} → {aid} / {name or '—'}"
                " (the survey it is filed under)")
            m["activityId"] = aid
            m["activityName"] = name or m.get("activityName") or ""

    # ── plan writes ──────────────────────────────────────────────────────
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    subject_topic_updates = defaultdict(dict)  # subjectId -> {(topicId, teacher): activityId}
    for e in final.values():
        original = e["data"]
        m = e["merged"]
        changed = any(json.dumps(original.get(k), default=str, sort_keys=True) != json.dumps(m.get(k), default=str, sort_keys=True)
                      for k in ("answers", "selectedGoals", "selectedCompetencies", "activityId", "activityName"))
        if changed:
            backup.append({"path": e["ref"].path, "data": original})
            update = {k: m.get(k) for k in ("answers", "selectedGoals", "selectedCompetencies", "activityId", "activityName")
                      if m.get(k) is not None}
            update["opsRepairedAt"] = stamp
            writes.append((f"update {e['ref'].path}", lambda ref=e["ref"], u=update: ref.update(u)))
        for d in e["dropped"]:
            backup.append({"path": d["ref"].path, "data": d["data"]})
            archive_ref = school_ref.collection("aap_response_archive").document(f"{d['surveyId']}__{d['id']}")
            writes.append((f"archive+delete {d['ref'].path}",
                           lambda a=archive_ref, r=d["ref"], data=d["data"], sid=d["surveyId"], kid=e["surveyId"]: (
                               a.set({**data, "archivedFromSurvey": sid, "keptUnderSurvey": kid, "archivedAt": stamp}),
                               r.delete())))
            subject_topic_updates[e["subjectId"]][(e["topicId"], e["teacher"])] = e["activityId"]

    topic_changes = 0
    for subject_id, wanted in subject_topic_updates.items():
        data = subjects.get(subject_id) or {}
        topics = json.loads(json.dumps(data.get("topics") or [], default=str))
        changed = False
        for t in topics:
            if not isinstance(t, dict):
                continue
            for (topic_id, teacher), activity in wanted.items():
                sib = t.get("survey_initiated_by")
                if t.get("id") == topic_id and isinstance(sib, dict) and sib.get(teacher) != activity:
                    sib[teacher] = activity
                    changed = True
                    topic_changes += 1
        if changed:
            ref = school_ref.collection("subjects").document(subject_id)
            backup.append({"path": ref.path, "data": data})
            writes.append((f"survey_initiated_by {ref.path}", lambda r=ref, tp=topics: r.update({"topics": tp})))

    # ── report ───────────────────────────────────────────────────────────
    total = sum(len(v) for v in by_id.values())
    print(f"\n{args.school}: {total} AAP response docs, {len(by_id)} distinct class/topic responses")
    for title, key in (("DUPLICATE ACTIVITIES (resolved)", "duplicates"),
                       ("GOALS/COMPETENCIES FILLED", "filled"),
                       ("ACTIVITY ID CORRECTED", "activity"),
                       ("UNRESOLVED — fill in via the dashboard", "unresolved")):
        rows = report.get(key, [])
        print(f"\n== {title}: {len(rows)}")
        for r in rows:
            print("  " + r)
    if unparsed:
        print(f"\n== UNPARSEABLE response ids (left alone): {len(unparsed)}")
        for u in unparsed:
            print("  " + u)
    print(f"\n{len(writes)} write operations planned ({topic_changes} survey_initiated_by entries).")

    if not args.apply:
        print("\nDRY RUN — nothing written. Re-run with --apply to make these changes.")
        return

    backup_file = f"aap_repair_backup_{args.school}_{stamp}.json"
    with open(backup_file, "w") as f:
        json.dump(backup, f, default=str, indent=1)
    print(f"\nBackup of {len(backup)} original docs written to {backup_file}")
    for label, fn in writes:
        fn()
        print("  done: " + label)
    print(f"\nApplied {len(writes)} writes.")


if __name__ == "__main__":
    main()
