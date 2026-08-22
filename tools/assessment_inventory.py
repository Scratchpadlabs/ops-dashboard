#!/usr/bin/env python3
"""What a school's assessments actually look like — and what a school is
missing before any can be created.

READ-ONLY. This script opens no write path at all: it never constructs a
batch, a set(), an update() or a delete(). Run it against production without
ceremony.

Two questions, because setting up a school's assessments needs both:

  TEMPLATE   — what does the reference school do? Every distinct assessment
               shape per term (name, entryType, maxMarks, conversion, scale),
               and how consistently it is applied across that term's subjects.
               A shape on 39 of 39 subjects is a template; one on 2 of 39 is
               somebody's experiment, and the difference is invisible in the
               dashboard's matrix view.

  READINESS  — what does the target school have? Assessments reference a term
               and (usually) a grading scale by id, and hang off a subject id.
               A school with no terms cannot have assessments at all, and one
               with subjects the teacher app never queries gets "No assessments
               configured" no matter how many are created.

USAGE (Cloud Shell, where you already have application-default credentials):

    cd ~/ops-dashboard
    pip install --quiet google-cloud-firestore
    python3 tools/assessment_inventory.py --project clarified-1501

    # the reference school's template, in detail:
    python3 tools/assessment_inventory.py --project clarified-1501 \
        --school "SAMARTH DNYANPEETH SAHAYDRI"

    # machine-readable, for pasting back:
    python3 tools/assessment_inventory.py --project clarified-1501 \
        --school "SAMARTH DNYANPEETH SAHAYDRI" --json > samarth_assessments.json
"""

import argparse
import json
import os
import sys
from collections import Counter, defaultdict

# Fields that define an assessment's SHAPE — everything except which subject it
# is attached to. Two assessments sharing all of these are the same template
# applied twice; the doc id and subjectId are what make them distinct rows.
SHAPE_FIELDS = ("name", "entryType", "maxMarks", "gradingScaleId",
                "conversionType", "conversionFactor", "order")


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
    return client


def read(school_ref, name):
    return [{"id": d.id, **(d.to_dict() or {})} for d in school_ref.collection(name).stream()]


def parse_grade(subject_id):
    return subject_id.split("_", 1)[0] if "_" in subject_id else ""


def survey(client, school_id):
    school = client.collection("schools").document(school_id)
    terms = read(school, "terms")
    scales = read(school, "grading_scales")
    subjects = read(school, "subjects")
    assessments = read(school, "assessments")
    coscho = read(school, "co_scholastic_activities")

    term_ids = {t["id"] for t in terms}
    scale_ids = {s["id"] for s in scales}
    subject_ids = {s["id"] for s in subjects}

    # ── shapes per term ──────────────────────────────────────────────────
    by_term = defaultdict(lambda: defaultdict(list))
    for a in assessments:
        shape = tuple(a.get(f) for f in SHAPE_FIELDS)
        by_term[a.get("termId")][shape].append(a.get("subjectId"))

    subjects_per_term = {t: len({s for subs in shapes.values() for s in subs})
                         for t, shapes in by_term.items()}

    # ── dangling references — the reason a teacher sees nothing ──────────
    dangling = {
        "termId": sorted({a.get("termId") for a in assessments
                          if a.get("termId") not in term_ids}),
        "subjectId": sorted({a.get("subjectId") for a in assessments
                             if a.get("subjectId") not in subject_ids}),
        "gradingScaleId": sorted({a.get("gradingScaleId") for a in assessments
                                  if a.get("gradingScaleId")
                                  and a.get("gradingScaleId") not in scale_ids}),
    }

    # A subject with no assessment in a term is exactly what the teacher app
    # reports as "No assessments configured for the selected term and subject".
    uncovered = {}
    for t in terms:
        covered = {s for subs in by_term.get(t["id"], {}).values() for s in subs}
        missing = sorted(subject_ids - covered)
        if missing:
            uncovered[t["id"]] = missing

    return {
        "school": school_id,
        "terms": [{"id": t["id"], "name": t.get("name"), "isActive": t.get("isActive")}
                  for t in terms],
        "grading_scales": [{"id": s["id"], "name": s.get("name")} for s in scales],
        "subject_count": len(subjects),
        "subjects_by_grade": dict(sorted(Counter(parse_grade(s["id"]) for s in subjects).items())),
        "assessment_count": len(assessments),
        "co_scholastic_count": len(coscho),
        "by_term": {
            term: {
                "subjects_with_assessments": subjects_per_term.get(term, 0),
                "shapes": sorted(
                    ({**dict(zip(SHAPE_FIELDS, shape)),
                      "subject_count": len(subs),
                      "sample_subjects": sorted(subs)[:5]}
                     for shape, subs in shapes.items()),
                    key=lambda s: (s.get("order") or 0, s.get("name") or "")),
            }
            for term, shapes in by_term.items()
        },
        "dangling": {k: v for k, v in dangling.items() if v},
        "subjects_with_no_assessment": uncovered,
    }


def blockers(s):
    """What stops assessments being created for this school at all."""
    out = []
    if not s["terms"]:
        out.append("no terms — assessments reference a termId, so none can be created")
    if not s["subject_count"]:
        out.append("no subjects — assessments hang off a subjectId")
    if not s["grading_scales"]:
        out.append("no grading scales — only needed for grade entry or marks_to_grade, "
                   "but every such assessment will be blocked without one")
    return out


def render(s, verbose):
    print(f"\n=== {s['school']} " + "=" * max(0, 60 - len(s["school"])))
    for b in blockers(s):
        print(f"  BLOCKER  {b}")
    print(f"  terms          {len(s['terms'])}: " +
          ", ".join(f"{t['id']}({t['name']})" for t in s["terms"]))
    print(f"  grading scales {len(s['grading_scales'])}: " +
          ", ".join(f"{g['id']}({g['name']})" for g in s["grading_scales"]))
    print(f"  subjects       {s['subject_count']}  " +
          " ".join(f"{g or '(no grade)'}:{n}" for g, n in s["subjects_by_grade"].items()))
    print(f"  assessments    {s['assessment_count']}   co-scholastic {s['co_scholastic_count']}")

    for term, info in s["by_term"].items():
        print(f"\n  -- term {term}  ({info['subjects_with_assessments']} subject(s) covered)")
        for shape in info["shapes"]:
            bits = [f"maxMarks={shape['maxMarks']}", f"entry={shape['entryType']}"]
            if shape.get("conversionType") not in (None, "none"):
                bits.append(f"{shape['conversionType']}({shape.get('conversionFactor')})")
            if shape.get("gradingScaleId"):
                bits.append(f"scale={shape['gradingScaleId']}")
            print(f"     order {str(shape.get('order')):>3}  {str(shape.get('name')):<28} "
                  f"x{shape['subject_count']:<4} {'  '.join(bits)}")
            if verbose:
                print(f"          {', '.join(shape['sample_subjects'])}")

    if s["dangling"]:
        print("\n  DANGLING REFERENCES — the teacher app finds nothing for these:")
        for field, values in s["dangling"].items():
            print(f"     {field}: {', '.join(str(v) for v in values[:10])}"
                  + (f" …(+{len(values) - 10})" if len(values) > 10 else ""))

    for term, missing in s["subjects_with_no_assessment"].items():
        print(f"\n  {len(missing)} subject(s) have NO assessment in term {term} — "
              f'teachers see "No assessments configured"')
        if verbose:
            for m in missing:
                print(f"     {m}")
        else:
            print(f"     {', '.join(missing[:12])}"
                  + (f" …(+{len(missing) - 12})" if len(missing) > 12 else ""))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--project", default=os.environ.get("GCLOUD_PROJECT", "clarified-1501"))
    ap.add_argument("--school", action="append",
                    help="school id; repeatable. Default: every school.")
    ap.add_argument("--json", action="store_true", help="machine-readable, for pasting back")
    ap.add_argument("--verbose", action="store_true", help="list every subject, not a sample")
    args = ap.parse_args()

    client = connect(args.project)
    school_ids = args.school or [d.id for d in client.collection("schools").select([]).stream()]

    results = []
    for sid in school_ids:
        try:
            results.append(survey(client, sid))
        except Exception as e:                                   # noqa: BLE001
            print(f"  ERROR reading {sid}: {e}", file=sys.stderr)

    if args.json:
        print(json.dumps(results, indent=1, default=str))
        return
    for s in results:
        render(s, args.verbose)
    print()


if __name__ == "__main__":
    main()
