"""The shared modules in this folder must match functions/shared exactly.

They are copies because `gcloud functions deploy --source .` uploads only this
folder (see tools/sync_shared.py). A copy that drifts is a second
implementation wearing the same name — precisely what the class-resolution
work exists to eliminate — so drift fails here rather than in production.

Fix a failure with:  python3 tools/sync_shared.py
"""
import hashlib
import os

import pytest

_HERE = os.path.dirname(os.path.abspath(__file__))
_FOLDER = os.path.dirname(_HERE)
_SHARED = os.path.join(_FOLDER, "..", "shared")

SHARED_FILES = ["class_resolver.py", "education_kb.json"]


def _digest(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


@pytest.mark.parametrize("name", SHARED_FILES)
def test_copy_matches_canonical(name):
    local = os.path.join(_FOLDER, name)
    canonical = os.path.join(_SHARED, name)
    assert os.path.exists(local), f"{name} missing — run tools/sync_shared.py"
    assert os.path.exists(canonical), f"canonical {name} missing from functions/shared"
    assert _digest(local) == _digest(canonical), (
        f"{name} has drifted from functions/shared/{name}. "
        "Run: python3 tools/sync_shared.py")
