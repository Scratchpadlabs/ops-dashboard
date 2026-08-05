"""_commit_teachers assignment merging, including inferred subject lists.

A teacher row with no subject cell now arrives carrying every subject of its
grade (subjectIds), inferred by the planner. The write must merge those into
the staff document without clobbering another subject's assignment for the
same class, and must still record class-level access when the list is empty.
"""
import os
import sys
import types

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

# main.py calls firebase_admin.initialize_app() at import — stub the SDK, same
# reason and same shape as test_flag_dedupe.py.
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

from main import _commit_teachers  # noqa: E402


class FakeDoc:
    def __init__(self, store, key):
        self.store, self.key = store, key

    def get(self):
        data = self.store.get(self.key)
        return types.SimpleNamespace(exists=data is not None, to_dict=lambda: dict(data or {}))

    def set(self, payload, merge=False):
        base = dict(self.store.get(self.key) or {}) if merge else {}
        base.update(payload)
        self.store[self.key] = base


class FakeStaffs:
    def __init__(self, initial=None):
        self.store = dict(initial or {})

    def document(self, key):
        return FakeDoc(self.store, key)


def item(staff_id, class_id, subject_ids=None, subject_id=None, is_new=True, name="R K"):
    return {"staffId": staff_id, "classId": class_id, "staffIsNew": is_new,
            "subjectIds": subject_ids or [], "subjectId": subject_id,
            "staffBase": {"name": name, "email": ""}}


def test_inferred_list_writes_every_subject():
    staffs = FakeStaffs()
    _commit_teachers(staffs, [item("t1", "VI_A", ["VI_English", "VI_Maths", "VI_Science"])], "me@x")
    assert staffs.store["t1"]["assignments"]["VI_A"] == ["VI_English", "VI_Maths", "VI_Science"]
    assert staffs.store["t1"]["classIds"] == ["VI_A"]


def test_explicit_single_subject_still_works():
    staffs = FakeStaffs()
    _commit_teachers(staffs, [item("t1", "VI_A", ["VI_Maths"])], "me@x")
    assert staffs.store["t1"]["assignments"]["VI_A"] == ["VI_Maths"]


def test_falls_back_to_subject_id_from_a_stale_client():
    staffs = FakeStaffs()
    _commit_teachers(staffs, [item("t1", "VI_A", [], subject_id="VI_Maths")], "me@x")
    assert staffs.store["t1"]["assignments"]["VI_A"] == ["VI_Maths"]


def test_empty_subject_list_still_grants_class_access():
    """Attendance, remarks and co-scholastic key off classIds, not subjects."""
    staffs = FakeStaffs()
    _commit_teachers(staffs, [item("t1", "VI_A", [])], "me@x")
    assert staffs.store["t1"]["classIds"] == ["VI_A"]
    assert staffs.store["t1"]["assignments"] == {}


def test_merges_without_clobbering_an_existing_assignment():
    staffs = FakeStaffs({"t1": {"assignments": {"VI_A": ["VI_Hindi"]}, "classIds": ["VI_A"]}})
    _commit_teachers(staffs, [item("t1", "VI_A", ["VI_Maths"], is_new=False)], "me@x")
    assert staffs.store["t1"]["assignments"]["VI_A"] == ["VI_Hindi", "VI_Maths"]


def test_two_teachers_on_the_same_class_are_independent():
    staffs = FakeStaffs()
    _commit_teachers(staffs, [item("t1", "VI_A", ["VI_Maths"]),
                              item("t2", "VI_A", ["VI_Maths"], name="S P")], "me@x")
    assert staffs.store["t1"]["assignments"]["VI_A"] == ["VI_Maths"]
    assert staffs.store["t2"]["assignments"]["VI_A"] == ["VI_Maths"]


def test_one_teacher_across_several_classes():
    staffs = FakeStaffs()
    _commit_teachers(staffs, [item("t1", "VI_A", ["VI_Maths"]),
                              item("t1", "VII_A", ["VII_Maths"])], "me@x")
    # Compared as a set: plain string order puts "VII_A" before "VI_A"
    # ("I" < "_"), the same trap classResolver.classSortKey exists to avoid.
    assert set(staffs.store["t1"]["classIds"]) == {"VI_A", "VII_A"}
    assert staffs.store["t1"]["assignments"] == {"VI_A": ["VI_Maths"], "VII_A": ["VII_Maths"]}


def test_duplicate_subject_ids_are_deduped():
    staffs = FakeStaffs()
    _commit_teachers(staffs, [item("t1", "VI_A", ["VI_Maths", "VI_Maths"])], "me@x")
    assert staffs.store["t1"]["assignments"]["VI_A"] == ["VI_Maths"]


def test_row_without_a_class_is_skipped():
    staffs = FakeStaffs()
    _commit_teachers(staffs, [item("t1", None, ["VI_Maths"])], "me@x")
    assert staffs.store["t1"]["classIds"] == []
