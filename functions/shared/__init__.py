"""Class-resolution logic shared by every Cloud Function that needs it.

ONE COPY, IMPORTED — NOT MIRRORED
    class_resolver.py, promotion.py, school_schema.py and education_kb.json
    live here and nowhere else. `functions/generate_import`,
    `functions/school_reset` and `functions/assign_survey` import them as
    `shared.<module>`; there are no per-folder copies to keep in step, and
    therefore nothing that can drift.

    `gcloud functions deploy --source .` uploads a single directory, so this
    package has to be INSIDE the uploaded tree at deploy time. That is what
    `tools/deploy_function.sh` does: it stages the function folder plus this
    package into a throwaway directory and points `--source` at it. The
    staged copy exists for the length of one deploy and is never written back
    into the repo, so every deploy necessarily ships current shared logic.
    Deploy with that script, never with a bare `gcloud functions deploy`
    (see functions/DEPLOY.md).

    Locally the package resolves because `functions/` is on sys.path — each
    function folder's pytest.ini adds it (`pythonpath = . ..`), and the
    scripts in tools/ insert it explicitly.
"""

import json
import os

#: The education knowledge base seed, shared byte-for-byte with the browser
#: (`src/utils/educationKB.js` and `src/utils/classResolver.js` import this
#: very file). One file, one vocabulary — the deployed parser and the shipped
#: frontend cannot disagree about what a grade or a subject is.
KB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       "education_kb.json")


def load_kb():
    """Parse education_kb.json. Callers keep their own module-level copy."""
    with open(KB_PATH, encoding="utf-8") as f:
        return json.load(f)
