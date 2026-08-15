"""
One-time migration: loads framework.csv (the AAP Stage x Subject rubric --
Awareness/Sensitivity/Creativity descriptor text per level) into the shared
`aap_framework` Firestore collection, so generate_aap_remarks can read it
directly instead of a local CSV path. Same collection serves every school.

Run once, and again any time framework.csv changes:
  python3 migrate_aap_framework.py "/home/team/remark-engine/AAP REMARKS/framework.csv"

Uses the same service account already set up for the AAP scripts.
"""

import csv
import re
import sys
from collections import Counter

from google.cloud import firestore
from google.oauth2 import service_account

SERVICE_ACCOUNT_JSON = "/home/team/remark-engine/AAP REMARKS/firestore-sa.json"
PROJECT_ID = "clarified-1501"

# The three stages GRADE_TO_STAGE in functions/generate_aap_remarks/main.py can
# produce. A framework row spelled any other way is unreachable: fetch_framework
# queries where("stage", "==", <one of these>), so the class it belongs to would
# resolve no descriptors and every subject would be skipped without comment.
EXPECTED_STAGES = {"Foundation", "Preparatory", "Middle"}


def doc_id_for(stage, subject):
    """A Firestore document id cannot contain '/' — a subject written
    "EVS/Science" would otherwise be read as a nested path and rejected
    outright ("A document must have an even number of path elements").

    ONLY the id is normalised here. The `stage` and `subject` FIELDS keep the
    CSV's exact spelling, because those are what the function matches on:
    fetch_framework keys its result by the subject field, never by the id.
    """
    cleaned = re.sub(r"[^A-Za-z0-9_-]+", "_", f"{stage}_{subject}")
    return re.sub(r"_+", "_", cleaned).strip("_")


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 migrate_aap_framework.py /path/to/framework.csv")
        sys.exit(1)

    creds = service_account.Credentials.from_service_account_file(SERVICE_ACCOUNT_JSON)
    db = firestore.Client(project=PROJECT_ID, credentials=creds)

    written = 0
    skipped = 0
    by_stage = Counter()
    subjects_seen = set()

    with open(sys.argv[1], newline="", encoding="utf-8-sig") as f:
        for line_no, row in enumerate(csv.DictReader(f), start=2):
            stage = row["Stage"].strip()
            subject = row["Subject Name"].strip()
            # Trailing blank rows are normal in an exported CSV, and writing
            # one produces a doc keyed on nothing that no lookup can ever hit.
            if not stage or not subject:
                skipped += 1
                print(f"  line {line_no}: skipped, missing Stage or Subject Name")
                continue

            doc_id = doc_id_for(stage, subject)

            db.collection("aap_framework").document(doc_id).set({
                "stage": stage,
                "subject": subject,
                "awareness": {
                    "beginner": row["Awareness-Beginner"].strip(),
                    "proficient": row["Awareness-Proficient"].strip(),
                    "advanced": row["Awareness-Advanced"].strip(),
                },
                "sensitivity": {
                    "beginner": row["Sensitivity-Beginner"].strip(),
                    "proficient": row["Sensitivity-Proficient"].strip(),
                    "advanced": row["Sensitivity-Advanced"].strip(),
                },
                "creativity": {
                    # source CSV header has a stray space after the hyphen
                    "beginner": row["Creativity- Beginner"].strip(),
                    "proficient": row["Creativity- Proficient"].strip(),
                    "advanced": row["Creativity- Advanced"].strip(),
                },
            })
            written += 1
            by_stage[stage] += 1
            subjects_seen.add(subject)
            print(f"  {doc_id}")

    print(f"\nDone -- {written} stage/subject rows written to aap_framework"
          f"{f', {skipped} rows skipped' if skipped else ''}.")

    # The two things a wrong CSV gets wrong silently, printed so they can be
    # read off rather than discovered later as an empty remarks table: the
    # function looks rows up by stage FIRST (an unexpected spelling makes every
    # class using it resolve nothing), then by subject name EXACTLY as spelled
    # here against the token in the survey response's doc id.
    print("\nStages written (must match the spellings the function derives"
          f" from a grade -- {', '.join(sorted(EXPECTED_STAGES))}):")
    for stage, count in sorted(by_stage.items()):
        flag = "" if stage in EXPECTED_STAGES else "   <-- UNREACHABLE, nothing maps to this spelling"
        print(f"  {stage}: {count} subject(s){flag}")

    print("\nSubject names written (each must match the survey response's"
          " subject token exactly):")
    print("  " + ", ".join(sorted(subjects_seen)))


if __name__ == "__main__":
    main()
