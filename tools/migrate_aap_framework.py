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
import sys

from google.cloud import firestore
from google.oauth2 import service_account

SERVICE_ACCOUNT_JSON = "/home/team/remark-engine/AAP REMARKS/firestore-sa.json"
PROJECT_ID = "clarified-1501"


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 migrate_aap_framework.py /path/to/framework.csv")
        sys.exit(1)

    creds = service_account.Credentials.from_service_account_file(SERVICE_ACCOUNT_JSON)
    db = firestore.Client(project=PROJECT_ID, credentials=creds)

    written = 0
    with open(sys.argv[1], newline="", encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            stage = row["Stage"].strip()
            subject = row["Subject Name"].strip()
            doc_id = f"{stage}_{subject}".replace(" ", "_")

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
            print(f"  {doc_id}")

    print(f"\nDone -- {written} stage/subject rows written to aap_framework.")


if __name__ == "__main__":
    main()
