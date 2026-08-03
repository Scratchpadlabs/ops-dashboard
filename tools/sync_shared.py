#!/usr/bin/env python3
"""Mirror functions/shared/* into every function folder that deploys it.

WHY A COPY RATHER THAN AN IMPORT
    Each Cloud Function deploys with `gcloud functions deploy --source .`,
    which uploads that one folder. A module living outside it simply is not
    there at runtime, and Python's flat imports inside the function folder
    give us nowhere to point. So the canonical file lives in
    functions/shared/ and is mirrored, with a test in each consuming folder
    asserting the copy is byte-identical. Drift fails a test rather than
    surviving to production.

    Run this after ANY edit to functions/shared/, before committing:

        python3 tools/sync_shared.py           # copy
        python3 tools/sync_shared.py --check   # verify only (exit 1 on drift)
"""

import argparse
import hashlib
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHARED = os.path.join(ROOT, "functions", "shared")

# Which shared files each deployable folder needs.
TARGETS = {
    "school_reset": ["class_resolver.py", "promotion.py", "education_kb.json"],
    "assign_survey": ["class_resolver.py", "education_kb.json"],
}


def digest(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true",
                    help="Verify copies match; do not write.")
    args = ap.parse_args()

    drift = []
    copied = 0
    for folder, files in TARGETS.items():
        dest_dir = os.path.join(ROOT, "functions", folder)
        if not os.path.isdir(dest_dir):
            sys.exit(f"No such function folder: {dest_dir}")
        for name in files:
            src = os.path.join(SHARED, name)
            dst = os.path.join(dest_dir, name)
            if not os.path.exists(src):
                sys.exit(f"Missing canonical file: {src}")
            if args.check:
                if not os.path.exists(dst) or digest(src) != digest(dst):
                    drift.append(f"{folder}/{name}")
                continue
            if not os.path.exists(dst) or digest(src) != digest(dst):
                shutil.copy2(src, dst)
                copied += 1
                print(f"  synced  functions/{folder}/{name}")

    if args.check:
        if drift:
            print("OUT OF SYNC with functions/shared:", file=sys.stderr)
            for d in drift:
                print(f"  {d}", file=sys.stderr)
            print("\nRun: python3 tools/sync_shared.py", file=sys.stderr)
            sys.exit(1)
        print("All shared copies match functions/shared.")
        return

    print(f"Done. {copied} file(s) updated." if copied else "Already up to date.")


if __name__ == "__main__":
    main()
