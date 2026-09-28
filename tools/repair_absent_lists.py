#!/usr/bin/env python3
"""Repair one school's topic absentLists from the survey answers. DRY RUN by
default — nothing is written unless --apply is passed.

    python3 tools/repair_absent_lists.py --project clarified-1501 --school Hillgreen_Highschool
    python3 tools/repair_absent_lists.py --project clarified-1501 --school Hillgreen_Highschool --apply

Where it lives: classes/{classId}.subjects[].topics[].absentList. The teacher
app marks a student absent by their question-1 answer ("Not Applicable") and
then hides them on questions 2+, and pre-fills "Not Applicable" for anyone on
the list the next time that topic's survey is opened.

Why it drifted: until the teacher app matched topics by id within the
survey's own subject, a topic NAME such as "Term 1" was looked up across the
whole class, so every subject shared the list on whichever subject came
first (usually Computer). Marks landed on the wrong topic, a later "Present"
in any subject removed them, and the absent write was separate from the
answer save, so a failure left the two disagreeing.

What the list is set to, per topic, from that topic's own responses
(schools/{school}/surveys/*/responses/{teacherId}_{classId}_{topicId}, any
survey not marked type: "student"):
  ADD    a student answered "Not Applicable" to question 1 and no response
         for the topic rated them on it
  REMOVE a response rated the student on question 1 (not absent)
  CLEAR  the topic has no response at all: its marks came from another
         subject's survey
A student on the list with no question-1 answer in any response is kept —
nothing says whether they were absent.

With --apply each class doc is re-read in a transaction; a topic whose list
changed since the preview was computed is skipped and reported, not
overwritten. Every class doc changed is saved to
absent_repair_backup_<school>_<timestamp>.json first. To undo, restore the
`subjects` field from that backup.
"""

import argparse
import copy
import csv
import datetime
import json
import sys
from collections import defaultdict

NOT_APPLICABLE = "Not Applicable"


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


def question1_answers(school_ref, class_ids):
    """{(classId, topicId): {"responses": [path], "na": {sid: path}, "rated": {sid: (answer, path)}}}"""
    out = defaultdict(lambda: {"responses": [], "na": {}, "rated": {}})
    for survey in school_ref.collection("surveys").stream():
        if str((survey.to_dict() or {}).get("type") or "").strip().lower() == "student":
            continue
        for resp in survey.reference.collection("responses").stream():
            _teacher, _, rest = resp.id.partition("_")
            class_id = max((c for c in class_ids if rest.startswith(c + "_")), key=len, default=None)
            topic_id = rest[len(class_id) + 1:] if class_id else ""
            if not topic_id:
                continue
            entry = out[(class_id, topic_id)]
            path = f"{survey.id}/{resp.id}"
            entry["responses"].append(path)
            answers = (resp.to_dict() or {}).get("answers") or []
            first = answers[0] if answers and isinstance(answers[0], dict) else {}
            for sid, value in first.items():
                if sid == "questionText" or not value:
                    continue
                if value == NOT_APPLICABLE:
                    entry["na"][sid] = path
                else:
                    entry["rated"][sid] = (value, path)
    return out


def plan(school_ref, classes):
    """One change per (class, topic) whose absentList should differ."""
    answers = question1_answers(school_ref, list(classes))
    changes = []
    for class_id, data in sorted(classes.items()):
        for subject in data.get("subjects") or []:
            for topic in subject.get("topics") or []:
                if not isinstance(topic, dict) or not topic.get("id"):
                    continue
                q1 = answers.get((class_id, topic["id"]))
                current = [str(s) for s in (topic.get("absentList") or [])]
                rows = []
                if not q1:
                    rows = [(sid, "remove", "no survey response for this topic — mark came from another subject's survey")
                            for sid in current]
                    target = []
                else:
                    target = [s for s in current if s not in q1["rated"]]
                    rows += [(sid, "remove", f'rated "{q1["rated"][sid][0]}" on question 1 in {q1["rated"][sid][1]}')
                             for sid in current if sid in q1["rated"]]
                    for sid, path in sorted(q1["na"].items()):
                        if sid not in q1["rated"] and sid not in target:
                            target.append(sid)
                            rows.append((sid, "add", f'"Not Applicable" on question 1 in {path}'))
                if rows:
                    changes.append({
                        "classId": class_id, "subjectId": subject.get("subjectId"),
                        "topicId": topic["id"], "topic": topic.get("topic"),
                        "taught": bool(topic.get("isCompleted")),
                        "responses": q1["responses"] if q1 else [],
                        "current": current, "target": target, "rows": rows,
                    })
    return changes


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--project", required=True)
    ap.add_argument("--school", required=True)
    ap.add_argument("--apply", action="store_true", help="write the changes (default: dry run)")
    args = ap.parse_args()

    client, firestore = connect(args.project)
    school_ref = client.collection("schools").document(args.school)
    classes = {d.id: d.to_dict() or {} for d in school_ref.collection("classes").stream()}
    names = {d.id: str((d.to_dict() or {}).get("name") or d.id)
             for d in school_ref.collection("students").select(["name"]).stream()}
    changes = plan(school_ref, classes)

    stamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    preview_file = f"absent_repair_preview_{args.school}_{stamp}.csv"
    with open(preview_file, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Class", "Subject", "Topic id", "Topic", "Taught", "Responses", "Change",
                    "Student id", "Student", "Why", "List before", "List after"])
        for c in changes:
            for sid, change, why in c["rows"]:
                w.writerow([c["classId"], c["subjectId"], c["topicId"], c["topic"], "Yes" if c["taught"] else "No",
                            len(c["responses"]), change, sid, names.get(sid, sid), why,
                            len(c["current"]), len(c["target"])])

    adds = sum(1 for c in changes for r in c["rows"] if r[1] == "add")
    removes = sum(1 for c in changes for r in c["rows"] if r[1] == "remove")
    print(f"{args.school}: {len(changes)} topics to change — {adds} students to add, {removes} to remove")
    for c in changes:
        print(f'  {c["classId"]:<14} {c["topicId"]:<28} {len(c["current"])} -> {len(c["target"])}'
              f'  (+{sum(r[1] == "add" for r in c["rows"])} -{sum(r[1] == "remove" for r in c["rows"])})')
    print(f"Preview, one row per student: {preview_file}")

    if not args.apply:
        print("DRY RUN — nothing written. Re-run with --apply to write.")
        return

    by_class = defaultdict(list)
    for c in changes:
        by_class[c["classId"]].append(c)
    backup, skipped, written = [], [], 0
    for class_id, class_changes in by_class.items():
        ref = school_ref.collection("classes").document(class_id)

        @firestore.transactional
        def apply(tx, ref=ref, class_changes=class_changes):
            snap = ref.get(transaction=tx)
            data = snap.to_dict() or {}
            original = copy.deepcopy(data.get("subjects"))
            subjects = data.get("subjects") or []
            by_id = {t.get("id"): t for s in subjects for t in (s.get("topics") or []) if isinstance(t, dict)}
            done, stale = [], []
            for c in class_changes:
                topic = by_id.get(c["topicId"])
                if topic is None or [str(s) for s in (topic.get("absentList") or [])] != c["current"]:
                    stale.append(c["topicId"])
                    continue
                topic["absentList"] = c["target"]
                done.append(c["topicId"])
            if done:
                tx.update(ref, {"subjects": subjects})
            return original, done, stale

        original, done, stale = apply(client.transaction())
        if done:
            backup.append({"path": ref.path, "subjects": original})
            written += len(done)
        skipped += [f"{class_id}/{t}" for t in stale]

    backup_file = f"absent_repair_backup_{args.school}_{stamp}.json"
    with open(backup_file, "w") as f:
        json.dump(backup, f, default=str, indent=1)
    print(f"Wrote {written} topic lists. Backup of every changed class doc: {backup_file}")
    if skipped:
        print(f"Skipped {len(skipped)} topics changed since the preview (re-run to pick them up): {', '.join(skipped)}")


if __name__ == "__main__":
    main()
