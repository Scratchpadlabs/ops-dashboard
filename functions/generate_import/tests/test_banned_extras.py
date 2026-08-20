"""Golden rule 3 at the header level.

The deterministic path now carries columns the alias dictionary has no field
for, so the rule that used to be enforced by "only schema keys are ever
stored" needs stating explicitly: a column naming caste, religion or an SSSM
id is dropped before it reaches Firestore at all, and the row says so.
"""
import os
import sys
import types

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

for name in ("firebase_admin", "firebase_functions"):
    if name not in sys.modules:
        sys.modules[name] = types.ModuleType(name)
sys.modules["firebase_admin"].initialize_app = lambda *a, **k: None
sys.modules["firebase_admin"].firestore = types.SimpleNamespace(
    client=lambda *a, **k: None, SERVER_TIMESTAMP="TS", Increment=lambda n: n)
sys.modules["firebase_admin"].storage = types.SimpleNamespace(bucket=lambda *a, **k: None)
_d = lambda *a, **k: (lambda f: f)  # noqa: E731
sys.modules["firebase_functions"].https_fn = types.SimpleNamespace(
    on_call=_d, CallableRequest=object, HttpsError=type("E", (Exception,), {}),
    FunctionsErrorCode=types.SimpleNamespace(
        INVALID_ARGUMENT="x", UNAUTHENTICATED="x", PERMISSION_DENIED="x", INTERNAL="x"))
sys.modules["firebase_functions"].options = types.SimpleNamespace(
    MemoryOption=types.SimpleNamespace(MB_256="256", MB_512="512", GB_1="1024"))

import pytest  # noqa: E402

from main import is_banned_extra  # noqa: E402


@pytest.mark.parametrize("header", [
    "Caste", "caste", "CASTE", "Caste Category", "Student Caste (SC/ST)",
    "Sub-Caste", "Religion", "religion of student", "SSSM", "SSSM ID",
    "SSSM-ID", "sssm id no",
])
def test_forbidden_headers_are_dropped(header):
    assert is_banned_extra(header) is True


@pytest.mark.parametrize("header", [
    "House", "Board", "Bus Route", "Blood Group", "Remarks", "Category",
    "Address", "Mother Tongue", "Nationality", "", "   ",
])
def test_everything_else_is_carried(header):
    """"Category" and "Address" are allowed by the 2026-08-20 decision — the
    ban is caste, religion and SSSM, not everything that sounds sensitive."""
    assert is_banned_extra(header) is False
