"""_link_subjects_to_classes: a subjects CSV import must also add each
grade-scoped subject into every matching class's `subjects[]` array, the way
manual entry and Structure inference already do — not just write the
`subjects/{id}` doc.
"""
import os
import sys
import types

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

# main.py calls firebase_admin.initialize_app() at import — stub the SDK, same
# reason and same shape as test_commit_teachers.py.
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

from main import _link_subjects_to_classes  # noqa: E402


class FakeDoc:
    def __init__(self, snapshots, store, key):
        self.snapshots, self.store, self.key = snapshots, store, key

    def get(self):
        return self.snapshots[self.key]

    def set(self, payload, merge=False):
        base = dict(self.store.get(self.key) or {}) if merge else {}
        base.update(payload)
        self.store[self.key] = base


class FakeClasses:
    """`.stream()` yields the ORIGINAL docs (as loaded); `.document(id).set()`
    writes land in `store`, kept separate so a test can assert on the delta
    without re-deriving what was already there."""
    def __init__(self, docs):
        self.docs = docs  # {id: {clazz, subjects}}
        self.store = {}
        self.snapshots = {
            k: types.SimpleNamespace(id=k, to_dict=lambda d=v: dict(d))
            for k, v in docs.items()
        }

    def stream(self):
        return [self.snapshots[k] for k in self.docs]

    def document(self, key):
        return FakeDoc(self.snapshots, self.store, key)


class FakeSchoolRef:
    def __init__(self, classes):
        self._classes = classes

    def collection(self, name):
        assert name == "classes"
        return self._classes


class FakeDB:
    def __init__(self):
        self.batches = []

    def batch(self):
        b = FakeBatch()
        self.batches.append(b)
        return b


class FakeBatch:
    def __init__(self):
        self.ops = []

    def set(self, doc_ref, payload, merge=False):
        self.ops.append((doc_ref, payload, merge))
        doc_ref.set(payload, merge=merge)

    def commit(self):
        pass


def item(doc_id):
    return {"docId": doc_id, "status": "CREATE", "payload": {}}


def test_links_new_subject_into_every_section_of_its_grade():
    classes = FakeClasses({
        "VI_A": {"clazz": "VI", "section": "A", "subjects": []},
        "VI_B": {"clazz": "VI", "section": "B", "subjects": []},
        "VII_A": {"clazz": "VII", "section": "A", "subjects": []},
    })
    db = FakeDB()
    _link_subjects_to_classes(db, FakeSchoolRef(classes), [item("VI_English")], "me@x")

    assert [s["subjectId"] for s in classes.store["VI_A"]["subjects"]] == ["VI_English"]
    assert [s["subjectId"] for s in classes.store["VI_B"]["subjects"]] == ["VI_English"]
    assert "VII_A" not in classes.store

    added = classes.store["VI_A"]["subjects"][0]
    assert added["teacherId"] == "" and added["isCompleted"] is False
    assert [t["topic"] for t in added["topics"]] == ["Term 1", "Term 2", "Optional"]


def test_does_not_duplicate_an_already_linked_subject():
    classes = FakeClasses({
        "VI_A": {"clazz": "VI", "section": "A", "subjects": [{"subjectId": "VI_English", "teacherId": "t1"}]},
    })
    db = FakeDB()
    _link_subjects_to_classes(db, FakeSchoolRef(classes), [item("VI_English")], "me@x")

    # No write at all — the addition list was empty, so nothing landed in .store.
    assert "VI_A" not in classes.store


def test_roman_numeral_grade_matches_class_clazz():
    classes = FakeClasses({"VI_A": {"clazz": "VI", "section": "A", "subjects": []}})
    db = FakeDB()
    # docId prefix uses a plain-number grade; class clazz uses roman — both
    # normalize to the same canonical grade.
    _link_subjects_to_classes(db, FakeSchoolRef(classes), [item("6_English")], "me@x")
    assert [s["subjectId"] for s in classes.store["VI_A"]["subjects"]] == ["6_English"]


def test_unspecified_grade_is_skipped():
    classes = FakeClasses({"VI_A": {"clazz": "VI", "section": "A", "subjects": []}})
    db = FakeDB()
    _link_subjects_to_classes(db, FakeSchoolRef(classes), [item("UNSPECIFIED_Art")], "me@x")
    assert "VI_A" not in classes.store


def test_existing_subjects_are_preserved_not_clobbered():
    classes = FakeClasses({
        "VI_A": {"clazz": "VI", "section": "A", "subjects": [{"subjectId": "VI_Maths", "teacherId": "t1"}]},
    })
    db = FakeDB()
    _link_subjects_to_classes(db, FakeSchoolRef(classes), [item("VI_English")], "me@x")
    ids = [s["subjectId"] for s in classes.store["VI_A"]["subjects"]]
    assert ids == ["VI_Maths", "VI_English"]
