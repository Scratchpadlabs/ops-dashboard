"""
Custom import templates — lets an ops-admin define NEW import entities (e.g.
"remarks") from the dashboard UI instead of Sid hand-editing SCHEMAS in
main.py for every new template. Deliberately does NOT touch the 4 existing
hardcoded entities (students/teachers/subjects/assessments) — those keep
their own real business logic (grade/section fuzzy matching, teacher
assignment merging, KB classification...) in main.py untouched. A custom
template only ever gets the generic "assessments-shaped" pipeline: no
expansion, validate_required_fields, and a plain field-bag write via
_commit_simple.

Firestore doc shape (`import_templates/{slug}`, slug is the doc id and is
also the `entity` value used everywhere else — staging_imports.entity,
process_import's `entity` param, commit_import's `entity` param):
  name, description
  targetCollectionName: str   # leaf collection under schools/{schoolId}/...
  columns: [{key, label, required, essential, notes}, ...]
  keyField: str                # optional — column used to derive a stable
                                # docId; empty means always-CREATE (auto id)
  extractionHints: str         # appended to the LLM prompt (fallback path
                                # only — a well-formed CSV/XLSX never reaches
                                # the LLM, see tabular parsing in main.py)
  status: "active" | "archived"
  createdAt/createdBy/updatedAt/updatedBy

Nothing here is ever read or written by the browser's Firestore SDK — every
access goes through the list_import_templates/get_import_template/
save_import_template/delete_import_template callables in main.py, which run
on the Admin SDK and bypass Firestore security rules entirely. This is
deliberate: this Firestore project is shared with other applications and a
past `firestore.rules` deploy broke them, so this feature must add zero
rules surface.
"""
import re

COLLECTION = "import_templates"

# Reserved so a custom template can never collide with (or shadow) one of the
# 4 entities main.py's SCHEMAS dict already hardcodes.
RESERVED_SLUGS = {"students", "teachers", "subjects", "assessments"}

_SLUG_RE = re.compile(r"^[a-z][a-z0-9_]{1,63}$")
_KEY_RE = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_]*$")


def load_template(db, slug):
    """Returns the template dict (with 'slug' set to the doc id) or None."""
    snap = db.collection(COLLECTION).document(slug).get()
    if not snap.exists:
        return None
    data = snap.to_dict() or {}
    data["slug"] = snap.id
    return data


def load_active_template(db, slug):
    """Same as load_template, but None for an archived template too — an
    archived template must not silently keep accepting new imports."""
    tpl = load_template(db, slug)
    if not tpl or tpl.get("status") != "active":
        return None
    return tpl


def list_templates(db, include_archived=False):
    docs = db.collection(COLLECTION).stream()
    out = []
    for d in docs:
        data = d.to_dict() or {}
        data["slug"] = d.id
        if include_archived or data.get("status") == "active":
            out.append(data)
    out.sort(key=lambda t: (t.get("name") or t["slug"]).lower())
    return out


def template_to_schema(tpl):
    """Adapts a template doc into the same shape main.py's SCHEMAS[entity]
    already has, so build_prompt/extract_file don't need to know whether a
    schema came from the hardcoded dict or Firestore."""
    columns = tpl.get("columns") or []
    return {
        "row": [c["key"] for c in columns if c.get("key")],
        "hints": tpl.get("extractionHints") or "",
        "required": [c["key"] for c in columns if c.get("key") and c.get("required")],
    }


def validate_template_payload(data):
    """Raises ValueError with a human-readable reason on anything malformed.
    Deliberately strict — a template with a bad column key would otherwise
    fail obscurely deep inside extraction or commit, far from the CRUD UI
    where the mistake was made."""
    slug = (data.get("slug") or "").strip().lower()
    if not _SLUG_RE.match(slug):
        raise ValueError(
            "Template id must be lowercase letters/digits/underscore, "
            "starting with a letter, 2-64 chars.")
    if slug in RESERVED_SLUGS:
        raise ValueError(f"'{slug}' is a reserved entity name — pick a different id.")

    name = (data.get("name") or "").strip()
    if not name:
        raise ValueError("Name is required.")

    target = (data.get("targetCollectionName") or "").strip()
    if not target or "/" in target:
        raise ValueError("Target collection name is required and must be a single collection name (no '/').")

    columns = data.get("columns") or []
    if not columns:
        raise ValueError("At least one column is required.")
    seen_keys = set()
    for c in columns:
        key = (c.get("key") or "").strip()
        if not _KEY_RE.match(key):
            raise ValueError(f"Column key '{key}' must be a valid field name (letters/digits/underscore, not starting with a digit).")
        if key in seen_keys:
            raise ValueError(f"Duplicate column key '{key}'.")
        seen_keys.add(key)

    key_field = (data.get("keyField") or "").strip()
    if key_field and key_field not in seen_keys:
        raise ValueError(f"Key field '{key_field}' is not one of this template's columns.")

    return slug


def save_template(db, data, email):
    """Create or update a template. `data` is the raw payload from the CRUD
    UI; returns the saved doc (with slug)."""
    slug = validate_template_payload(data)
    existing = db.collection(COLLECTION).document(slug).get()

    payload = {
        "name": (data.get("name") or "").strip(),
        "description": (data.get("description") or "").strip(),
        "targetCollectionName": (data.get("targetCollectionName") or "").strip(),
        "columns": [
            {
                "key": (c.get("key") or "").strip(),
                "label": (c.get("label") or c.get("key") or "").strip(),
                "required": bool(c.get("required")),
                "essential": bool(c.get("essential")),
                "notes": (c.get("notes") or "").strip(),
            }
            for c in (data.get("columns") or [])
        ],
        "keyField": (data.get("keyField") or "").strip(),
        "extractionHints": (data.get("extractionHints") or "").strip(),
        "status": data.get("status") if data.get("status") in ("active", "archived") else "active",
        "updated_at": _server_ts(db),
        "updated_by": email,
    }
    if not existing.exists:
        payload["created_at"] = _server_ts(db)
        payload["created_by"] = email

    db.collection(COLLECTION).document(slug).set(payload, merge=True)
    return load_template(db, slug)


def delete_template(db, slug):
    if slug in RESERVED_SLUGS:
        raise ValueError(f"'{slug}' is a built-in entity, not a custom template.")
    db.collection(COLLECTION).document(slug).delete()


def _server_ts(db):
    from firebase_admin import firestore
    return firestore.SERVER_TIMESTAMP
