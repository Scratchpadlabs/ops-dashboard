"""Dynamic field registry (`field_defs` collection) — load_field_defs' fail-
soft behavior and the extra_row_keys/extra_hints merge into both extraction
paths (build_prompt/extract_file for the LLM path; _process_one_file's
student-side schema_keys/header_aliases merge is exercised indirectly through
those same helpers, since parse_tabular_file itself is untouched and already
covered by test_tabular_parser.py).

See src/composables/useFieldSchema.js (writes field_defs) and
src/views/ManageFields.vue (the admin UI) for the client side.
"""
import os
import sys
import types

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

# main.py calls firebase_admin.initialize_app() at import — stub the SDK,
# same reasoning as test_flag_dedupe.py: the functions under test are pure
# (or take an injected `db`), so there's no reason to require a real
# Firebase environment just to import the module.
for name in ("firebase_admin", "firebase_functions"):
    if name not in sys.modules:
        sys.modules[name] = types.ModuleType(name)
sys.modules["firebase_admin"].initialize_app = lambda *a, **k: None
sys.modules["firebase_admin"].firestore = types.SimpleNamespace(
    client=lambda *a, **k: None, SERVER_TIMESTAMP=None, Increment=lambda n: n)
sys.modules["firebase_admin"].storage = types.SimpleNamespace(bucket=lambda *a, **k: None)


def _passthrough_decorator(*a, **k):
    def wrap(fn):
        return fn
    return wrap


sys.modules["firebase_functions"].https_fn = types.SimpleNamespace(
    on_call=_passthrough_decorator, CallableRequest=object,
    HttpsError=type("HttpsError", (Exception,), {}),
    FunctionsErrorCode=types.SimpleNamespace(
        INVALID_ARGUMENT="invalid-argument", UNAUTHENTICATED="unauthenticated",
        PERMISSION_DENIED="permission-denied", INTERNAL="internal"))
sys.modules["firebase_functions"].options = types.SimpleNamespace(
    MemoryOption=types.SimpleNamespace(MB_256="256", MB_512="512", GB_1="1024"))
sys.modules["firebase_functions"].params = types.SimpleNamespace(SecretParam=lambda *a, **k: None)

import main  # noqa: E402


class _FakeCollection:
    def __init__(self, docs):
        self._docs = docs

    def stream(self):
        return iter(self._docs)


class _FakeDoc:
    def __init__(self, data):
        self._data = data

    def to_dict(self):
        return self._data


class _FakeDb:
    def __init__(self, collections):
        self._collections = {k: [_FakeDoc(d) for d in v] for k, v in collections.items()}

    def collection(self, name):
        return _FakeCollection(self._collections.get(name, []))


# ── load_field_defs ──────────────────────────────────────────────────────────
def test_load_field_defs_filters_by_kind_and_active():
    db = _FakeDb({"field_defs": [
        {"kind": "student", "key": "bloodGroup", "label": "Blood Group", "type": "enum",
         "enumValues": ["A+", "B+"], "aliases": ["blood group"], "active": True},
        {"kind": "student", "key": "oldField", "label": "Old", "type": "string", "active": False},
        {"kind": "staff", "key": "empCode", "label": "Emp Code", "type": "string", "active": True},
    ]})
    fields = main.load_field_defs(db, "students")
    assert [f["key"] for f in fields] == ["bloodGroup"]

    staff_fields = main.load_field_defs(db, "teachers")
    assert [f["key"] for f in staff_fields] == ["empCode"]


def test_load_field_defs_does_not_duplicate_label_already_in_aliases():
    db = _FakeDb({"field_defs": [
        {"kind": "student", "key": "bloodGroup", "label": "Blood Group", "type": "string",
         "aliases": ["blood group"], "active": True},
    ]})
    assert main.load_field_defs(db, "students")[0]["aliases"] == ["blood group"]


def test_load_field_defs_defaults_alias_to_label_when_none_configured():
    db = _FakeDb({"field_defs": [
        {"kind": "student", "key": "houseName", "label": "House Name", "type": "string", "active": True},
    ]})
    assert main.load_field_defs(db, "students")[0]["aliases"] == ["House Name"]


def test_load_field_defs_skips_a_doc_with_no_key():
    db = _FakeDb({"field_defs": [{"kind": "student", "key": "", "label": "Nameless", "active": True}]})
    assert main.load_field_defs(db, "students") == []


def test_load_field_defs_fails_soft_on_firestore_error():
    """A missing/unreadable registry must never take down an import — the
    fixed field set alone still extracts everything it always did."""
    class BrokenDb:
        def collection(self, name):
            raise RuntimeError("boom")
    assert main.load_field_defs(BrokenDb(), "students") == []


def test_load_field_defs_unknown_entity_returns_empty():
    assert main.load_field_defs(_FakeDb({}), "subjects") == []


# ── build_prompt / extract_file merge ───────────────────────────────────────
def test_build_prompt_with_no_extras_is_byte_identical_to_before():
    """The no-op case: every EXISTING caller (none of which pass these new
    args) must see exactly the same prompt as before this feature."""
    assert main.build_prompt("students") == main.build_prompt("students", extra_row_keys=None, extra_hints="")


def test_build_prompt_merges_extra_row_keys_and_hints():
    prompt = main.build_prompt("students", extra_row_keys=["bloodGroup"], extra_hints="bloodGroup: one of A+, B+.")
    assert '"bloodGroup"' in prompt
    assert "bloodGroup: one of A+, B+." in prompt


def test_extract_file_keeps_dynamic_key_and_still_drops_a_hallucinated_one(monkeypatch):
    monkeypatch.setattr(main, "content_blocks", lambda filename, raw: [])
    monkeypatch.setattr(
        main, "call_anthropic",
        lambda blocks, prompt: (
            '[{"student_name": "Asha", "grade": "3", "bloodGroup": "A+", '
            '"hallucinated_field": "should never appear"}]'
        ),
    )
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)

    rows = main.extract_file("students", "f.csv", b"", extra_row_keys=["bloodGroup"])

    assert len(rows) == 1
    assert rows[0]["student_name"] == "Asha"
    assert rows[0]["grade"] == "3"
    assert rows[0]["bloodGroup"] == "A+"
    assert "hallucinated_field" not in rows[0]


def test_field_defs_extra_hints_covers_every_type():
    field_defs = [
        {"key": "bloodGroup", "type": "enum", "enumValues": ["A+", "B+"]},
        {"key": "joinedOn", "type": "date", "enumValues": []},
        {"key": "siblingCount", "type": "number", "enumValues": []},
        {"key": "isBoarder", "type": "boolean", "enumValues": []},
        {"key": "houseName", "type": "string", "enumValues": []},
    ]
    hints = main.field_defs_extra_hints(field_defs)
    assert "bloodGroup: one of A+, B+" in hints
    assert "joinedOn: a date, YYYY-MM-DD." in hints
    assert "siblingCount: a number." in hints
    assert "isBoarder: yes/no." in hints
    assert "houseName: free text." in hints


def test_field_defs_extra_row_keys_is_just_the_key_list():
    assert main.field_defs_extra_row_keys(
        [{"key": "bloodGroup"}, {"key": "houseName"}]
    ) == ["bloodGroup", "houseName"]


# ── _validate_writable (commit_import's schema gate) ────────────────────────
BASE_STUDENT = {"name": "Asha Patil", "firstName": "Asha", "lastName": "Patil",
                "currentClassId": "III_A", "type": "student"}


def test_validate_writable_accepts_a_registered_dynamic_student_field():
    db = _FakeDb({"field_defs": [
        {"kind": "student", "key": "bloodGroup", "label": "Blood Group", "type": "string", "active": True},
    ]})
    writable = [{"docId": "s1", "status": "CREATE", "payload": {**BASE_STUDENT, "bloodGroup": "O+"}}]
    accepted, rejected = main._validate_writable(db, "students", writable)
    assert not rejected
    assert accepted[0]["payload"]["bloodGroup"] == "O+"


def test_validate_writable_rejects_a_dynamic_field_type_mismatch():
    db = _FakeDb({"field_defs": [
        {"kind": "student", "key": "siblingCount", "label": "Sibling Count", "type": "number", "active": True},
    ]})
    writable = [{"docId": "s1", "status": "CREATE", "payload": {**BASE_STUDENT, "siblingCount": "two"}}]
    accepted, rejected = main._validate_writable(db, "students", writable)
    assert not accepted
    assert "does not match the students schema" in rejected[0]["reason"]


def test_validate_writable_coerces_a_dynamic_date_field():
    db = _FakeDb({"field_defs": [
        {"kind": "student", "key": "joinedOn", "label": "Joined On", "type": "date", "active": True},
    ]})
    writable = [{"docId": "s1", "status": "CREATE", "payload": {**BASE_STUDENT, "joinedOn": "2020-06-15"}}]
    accepted, rejected = main._validate_writable(db, "students", writable)
    assert not rejected
    from datetime import datetime
    assert accepted[0]["payload"]["joinedOn"] == datetime(2020, 6, 15)


def test_validate_writable_ignores_field_defs_for_a_different_kind():
    """A 'staff' field must never leak into student validation as a
    real typed field — it should fall back to the ordinary unknown-field
    warning path (never blocking) instead."""
    db = _FakeDb({"field_defs": [
        {"kind": "staff", "key": "empCode", "label": "Emp Code", "type": "string", "active": True},
    ]})
    writable = [{"docId": "s1", "status": "CREATE", "payload": {**BASE_STUDENT, "empCode": "E123"}}]
    accepted, rejected = main._validate_writable(db, "students", writable)
    assert not rejected
    assert accepted[0]["payload"]["empCode"] == "E123"
