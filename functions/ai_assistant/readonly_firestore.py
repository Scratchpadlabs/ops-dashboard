"""Read-only Firestore access for the AI Assistant (functions/ai_assistant).

WHY THIS FILE EXISTS
    The AI Assistant callable must be structurally incapable of writing to
    Firestore — not "well-behaved," incapable. Since the Admin SDK's Firestore
    client object always has .set/.update/.add/.delete regardless of intent,
    the real guarantee has to be enforced by code shape, not by trusting the
    caller: this module's only public surface is read calls, and nothing
    calling into it ever gets a document/collection reference back — only
    plain dicts. functions/ai_assistant/main.py imports ONLY from this module
    for Firestore access; it never calls firestore.client().collection(...)
    itself. A grep for '.set(' / '.update(' / '.add(' / '.delete(' across
    this file and ai_assistant/main.py must always come back empty — see the
    check in tools/sync_shared.py's neighbor test and functions/DEPLOY.md.

Mirrored into functions/ai_assistant/ by tools/sync_shared.py — edit the
canonical copy here, then run `python3 tools/sync_shared.py`.
"""


def read_doc(db, path_parts):
    """path_parts: e.g. ["schools", schoolId]. Returns a plain dict (with
    '_id' set to the doc id) or None if it doesn't exist. Read-only: calls
    only .document(...).get()."""
    ref = db
    for i, part in enumerate(path_parts):
        ref = ref.collection(part) if i % 2 == 0 else ref.document(part)
    if len(path_parts) % 2 == 1:
        # last part was a collection segment count mismatch; caller error
        raise ValueError(f"read_doc path must end on a document segment: {path_parts}")
    snap = ref.get()
    if not snap.exists:
        return None
    data = snap.to_dict() or {}
    data["_id"] = snap.id
    return data


def read_collection(db, path_parts, limit=200):
    """path_parts: e.g. ["schools", schoolId, "subjects"]. Returns a list of
    plain dicts (each with '_id' set to the doc id), capped at `limit` to
    bound LLM prompt size/cost. Read-only: calls only .collection(...).limit(...).stream()."""
    ref = db
    for i, part in enumerate(path_parts):
        ref = ref.collection(part) if i % 2 == 0 else ref.document(part)
    docs = ref.limit(limit).stream()
    out = []
    for d in docs:
        data = d.to_dict() or {}
        data["_id"] = d.id
        out.append(data)
    return out
