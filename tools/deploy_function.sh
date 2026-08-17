#!/usr/bin/env bash
#
# Deploy one Cloud Function with functions/shared/ staged into its source tree.
#
#     tools/deploy_function.sh <function-folder> <gcloud-deploy-args...>
#
# e.g.
#
#     tools/deploy_function.sh school_reset \
#       reset_execute --gen2 --runtime python312 --region asia-south1 \
#       --entry-point reset_execute --trigger-http --allow-unauthenticated \
#       --project clarified-1501 --memory 1024MB --timeout 540s --max-instances 3
#
# WHY THIS EXISTS
#     `gcloud functions deploy --source .` uploads exactly one directory, so a
#     package living outside it is not there at runtime. class_resolver.py,
#     promotion.py, school_schema.py and education_kb.json used to be COPIES in
#     each function folder, kept in step by hand — and a fix to one copy did not
#     reach the others until someone remembered to run the sync.
#
#     Now they exist once, in functions/shared/. This script assembles a
#     throwaway staging tree — the function folder plus that package — and
#     points `--source` at it. The staging tree is built fresh from the repo on
#     every deploy and deleted afterwards, so there is no copy to keep in sync
#     and no way to ship stale shared logic. Nothing is ever written back into
#     the repo.
#
# Everything after <function-folder> is passed to `gcloud functions deploy`
# untouched. Drop the `--source .` from the old commands; this script supplies
# it and rejects the flag if you pass your own.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SHARED="$ROOT/functions/shared"

if [[ $# -lt 2 ]]; then
  echo "usage: $(basename "$0") <function-folder> <gcloud-deploy-args...>" >&2
  echo "e.g.   $(basename "$0") school_reset reset_execute --gen2 --runtime python312 ..." >&2
  exit 2
fi

FOLDER_NAME="$1"; shift
SRC="$ROOT/functions/$FOLDER_NAME"

if [[ ! -d "$SRC" ]]; then
  echo "error: no such function folder: functions/$FOLDER_NAME" >&2
  exit 1
fi
if [[ ! -f "$SRC/main.py" ]]; then
  echo "error: functions/$FOLDER_NAME has no main.py — is that a deployable folder?" >&2
  exit 1
fi
if [[ ! -f "$SHARED/__init__.py" ]]; then
  echo "error: functions/shared is not a package (no __init__.py)" >&2
  exit 1
fi

# A caller-supplied --source would silently defeat the staging and deploy the
# folder without functions/shared in it — exactly the failure this prevents.
for arg in "$@"; do
  case "$arg" in
    --source|--source=*)
      echo "error: do not pass --source; this script stages the source tree itself." >&2
      exit 2
      ;;
  esac
done

STAGE="$(mktemp -d -t deployfn-XXXXXXXX)"
trap 'rm -rf "$STAGE"' EXIT

# The function's own modules, then the shared package as a subdirectory. That
# puts `shared/` at the root of the uploaded tree, which is on sys.path at
# runtime — so `import shared.class_resolver` resolves in the deployed function
# exactly as it does locally (where functions/ is on the path instead).
# Plain cp + prune rather than rsync/tar --exclude, so this runs the same on a
# bare Cloud Shell, a mac and a CI runner with no extra tooling installed.
copy_tree() {  # copy_tree <src> <dst>
  mkdir -p "$2"
  (cd "$1" && cp -R . "$2/")
  find "$2" \( -name '__pycache__' -o -name '.pytest_cache' -o -name 'tests' \
            -o -name '.venv*' \) -type d -prune -exec rm -rf {} +
  find "$2" \( -name '*.pyc' -o -name 'pytest.ini' \
            -o -name 'requirements-dev.txt' \) -type f -delete
}

copy_tree "$SRC" "$STAGE"
mkdir -p "$STAGE/shared"
copy_tree "$SHARED" "$STAGE/shared"

# Fail loudly rather than deploying a tree that would ImportError on cold start.
for required in shared/__init__.py shared/class_resolver.py shared/education_kb.json; do
  if [[ ! -f "$STAGE/$required" ]]; then
    echo "error: staging tree is missing $required" >&2
    exit 1
  fi
done

echo "staged functions/$FOLDER_NAME + functions/shared -> $STAGE"
echo "shared files:"
(cd "$STAGE/shared" && ls -1 *.py *.json | sed 's/^/  /')
echo

set -x
gcloud functions deploy "$@" --source "$STAGE"
