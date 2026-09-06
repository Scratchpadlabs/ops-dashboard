"""AI Assistant — read-only chat + draft-proposal callable for the ops
dashboard.

HARD SAFETY INVARIANT (do not weaken without updating functions/DEPLOY.md's
grep check and this docstring together):
    This module NEVER writes to Firestore, under any code path, for any
    input. It only ever imports `readonly_firestore` for Firestore access
    (read_doc/read_collection — no document/collection reference is ever
    handed back, only plain dicts), and never imports anything from
    generate_import, school_reset, create_auth_accounts, provision_hosting,
    or any other write-capable function folder. A `proposal` this function
    returns is inert JSON handed back to the browser — the browser is the
    only thing that ever turns it into a real Firestore write, and only
    after a human clicks the existing Save/Confirm button on the existing
    page that proposal targets (see src/composables/usePendingAiDraft.js and
    the registry in src/components/AiAssistantPanel.vue). firestore.rules is
    never touched by this feature, in either direction.

    Verify with:  grep -nE '\\.(set|update|add|delete)\\(' functions/ai_assistant/main.py functions/shared/readonly_firestore.py
    (must return nothing).
"""
import json
import os
import re

import firebase_admin
from firebase_admin import firestore
from firebase_functions import https_fn
import requests

import readonly_firestore
import school_schema

firebase_admin.initialize_app(options={"storageBucket": "clarified-1501.appspot.com"})

MODEL = os.environ.get("MODEL")

# Mirrors src/config/opsAdmins.js — keep in sync. Server-side is the
# authoritative check; the frontend's isOpsAdmin() is only a UI gate.
OPS_ADMIN_EMAILS = {"sid@ops.clarified.in", "angel@ops.clarified.in"}


def _require_ops_admin(req: https_fn.CallableRequest) -> str:
    if req.auth is None:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.UNAUTHENTICATED, "Sign in required.")
    email = str((req.auth.token or {}).get("email") or "").strip().lower()
    if email not in OPS_ADMIN_EMAILS:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.PERMISSION_DENIED,
            "Not authorized for the AI Assistant.")
    return email


# --------------------------------------------------------- context scope ---
# Only these subcollections of a school are ever read for chat context.
# `students`/`staffs` are deliberately excluded (PII), as is every
# operational/runtime collection (smart_sheet_entries, attendance_sheets,
# remarks_sheets, surveys, staging_imports, etc.) and anything under
# operations/ (billing/CRM). Keep this list in lockstep with the plan doc and
# with §1 of the guardrails checklist — widening it is a deliberate, reviewed
# change, not something to do casually.
CONTEXT_COLLECTIONS = [
    "terms", "grading_scales", "subjects", "classes", "assessments",
    "co_scholastic_activities", "remark_categories", "months", "config",
]

_HERE = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(_HERE, "dashboard_help.md"), encoding="utf-8") as f:
    DASHBOARD_HELP = f.read()

with open(os.path.join(_HERE, "education_kb.json"), encoding="utf-8") as f:
    EDUCATION_KB = json.load(f)


def _schema_summary() -> str:
    """Renders school_schema.SCHOOL_SCHEMAS into prose, restricted to
    CONTEXT_COLLECTIONS — never describes the students/staffs field lists
    (PII-adjacent), even though school_schema.py itself documents them for
    the import pipeline's own use."""
    lines = []
    for coll in CONTEXT_COLLECTIONS:
        if coll == "config":
            continue  # config/{students_schema,teachers_schema} — described separately below
        spec = school_schema.SCHOOL_SCHEMAS.get(coll)
        if not spec:
            continue
        fields = ", ".join(spec["fields"].keys())
        lines.append(f"- schools/{{schoolId}}/{coll} — {spec['label']}: {{{fields}}}")
    lines.append(
        "- schools/{schoolId}/config/students_schema, config/teachers_schema — "
        "{columns: [{key, label, type, editable, order, options?}]}")
    return "\n".join(lines)


def _vocab_summary() -> str:
    subjects = ", ".join(s["canonical"] for s in EDUCATION_KB.get("subjects", []))
    coscholastic = ", ".join(s["canonical"] for s in EDUCATION_KB.get("coscholastic", []))
    grades = ", ".join(g["canonical"] for g in EDUCATION_KB.get("grades", []))
    return (
        f"Known subject names: {subjects}\n"
        f"Known co-scholastic activity names: {coscholastic}\n"
        f"Known grade names: {grades}"
    )


def _hygiene_signals(school_id: str, context: dict) -> list:
    """A small subset of the School Setup Overview tab's own hygiene checks
    (docs/school-setup-page-spec.md §3.1), computed from context already
    read — so the assistant can proactively surface the same class of issue
    in conversation, not just answer when asked. Read-only; adds no new
    Firestore access beyond what _read_school_context already did."""
    issues = []
    terms_by_id = {t["_id"]: t for t in context.get("terms", [])}
    scales_by_id = {g["_id"]: g for g in context.get("grading_scales", [])}
    subjects_by_id = {s["_id"]: s for s in context.get("subjects", [])}

    for a in context.get("assessments", []):
        if a.get("termId") and a["termId"] not in terms_by_id:
            issues.append(f"assessment '{a.get('name', a['_id'])}' references a missing term ({a['termId']})")
        if a.get("subjectId") and a["subjectId"] not in subjects_by_id:
            issues.append(f"assessment '{a.get('name', a['_id'])}' references a missing subject ({a['subjectId']})")
        if a.get("gradingScaleId") and a["gradingScaleId"] not in scales_by_id:
            issues.append(f"assessment '{a.get('name', a['_id'])}' references a missing grading scale ({a['gradingScaleId']})")

    for c in context.get("classes", []):
        for entry in (c.get("subjects") or []):
            sid = entry.get("subjectId") if isinstance(entry, dict) else None
            if sid and sid not in subjects_by_id:
                issues.append(f"class '{c.get('name', c['_id'])}' references a missing subject ({sid})")

    # Stray/bootstrap-stub docs whose only real field is `a` (AUDIT.md's own
    # description of SAMARTH's known junk docs) — same signal Overview flags.
    for coll in ("terms", "grading_scales", "assessments", "co_scholastic_activities"):
        for doc in context.get(coll, []):
            keys = set(doc.keys()) - {"_id"}
            if keys == {"a"}:
                issues.append(f"{coll}/{doc['_id']} looks like a stray/bootstrap-stub doc (only field is 'a')")

    return issues[:30]  # bounded — this is a conversational nudge, not a full report


def _read_school_context(db, school_id: str) -> dict:
    context = {"school": readonly_firestore.read_doc(db, ["schools", school_id])}
    for coll in CONTEXT_COLLECTIONS:
        context[coll] = readonly_firestore.read_collection(db, ["schools", school_id, coll])
    return context


def _build_system_prompt(school_id, context) -> str:
    parts = [
        "You are the AI Assistant embedded in the ClarifiEd Ops Dashboard, an "
        "internal admin tool ops staff use to configure schools on the "
        "ClarifiEd platform. Be direct and specific; ops staff are technical "
        "and busy.",
        "",
        "## Dashboard structure",
        DASHBOARD_HELP,
        "",
        "## Firestore schema (schools/{schoolId}/... — read-only context you're given)",
        _schema_summary(),
        "",
        "## Subject/grade/co-scholastic vocabulary used for matching messy input",
        _vocab_summary(),
    ]
    if school_id and context and context.get("school"):
        parts += [
            "",
            f"## Current school: {school_id} ({context['school'].get('name', '?')})",
            "Live config for this school (read-only — you are not shown student or "
            "staff records):",
            json.dumps({k: v for k, v in context.items() if k != "school"}, default=str)[:20000],
        ]
        issues = _hygiene_signals(school_id, context)
        if issues:
            parts += [
                "",
                "## Data-hygiene issues noticed in this school's config",
                "Mention these proactively if relevant to the conversation, even if not "
                "directly asked:",
                "\n".join(f"- {i}" for i in issues),
            ]
    elif school_id:
        parts += ["", f"## Current school: {school_id} (not found or has no config yet)"]
    else:
        parts += ["", "## No school is currently selected in the dashboard."]

    parts += [
        "",
        "## Hard rules",
        "- You NEVER write to Firestore and have no ability to. Every suggestion is "
        "a draft a human must review and apply themselves through the dashboard's "
        "existing forms.",
        "- Never invent data — only use the school config you were given above.",
        "- If asked to draft one of the supported proposal kinds, respond as "
        "instructed in that request's own instructions (a strict JSON object, "
        "nothing else). Otherwise respond in plain conversational text.",
    ]
    return "\n".join(parts)


# ------------------------------------------------------------- proposals ---
# The ONLY proposal kinds this function will produce. Each maps 1:1 to an
# existing, already-safe draft-then-save form in the dashboard (see the
# registry table in the plan doc / AiAssistantPanel.vue) — adding a new kind
# here is an additive, reviewed change, never a shortcut to writing directly.
PROPOSAL_INSTRUCTIONS = {
    "import_template": (
        "Respond with ONLY a JSON object (no markdown, no commentary) shaped exactly like: "
        '{"slug": "...", "name": "...", "description": "...", "targetCollectionName": "...", '
        '"keyField": "", "columns": [{"key": "", "label": "", "notes": "", "required": false, '
        '"essential": false}], "extractionHints": ""}. '
        "slug: lowercase letters/digits/underscore. columns[].key must be a valid Firestore "
        "field name (letters/digits/underscore, not starting with a digit)."
    ),
    "subject_draft": (
        "Respond with ONLY a JSON object shaped exactly like: "
        '{"grade": "...", "name": "...", "area": "Scholastic|Co-Scholastic", '
        '"curricular_goals": [{"goal": "...", "competencies": ["..."]}]}. '
        "grade should match one of the known grade names given above."
    ),
    "assessment_bulk": (
        "Respond with ONLY a JSON object shaped exactly like: "
        '{"name": "...", "termId": "...", "entryType": "marks|grade", "maxMarks": 0, '
        '"gradingScaleId": null, "conversionType": "none|marks_to_grade|sum_up|sum_down", '
        '"conversionFactor": null, "subjectIds": ["..."]}. '
        "termId and subjectIds must be ids that actually exist in the school context given above."
    ),
}

REQUIRED_PROPOSAL_KEYS = {
    "import_template": ["slug", "name", "targetCollectionName", "columns"],
    "subject_draft": ["grade", "name", "area"],
    "assessment_bulk": ["name", "termId", "entryType", "maxMarks", "subjectIds"],
}


def _strip_json_fences(text: str) -> str:
    return re.sub(r"^```(json)?|```$", "", text.strip(), flags=re.M).strip()


def call_anthropic_chat(system_prompt: str, messages: list) -> str:
    r = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={"x-api-key": os.environ["ANTHROPIC_API_KEY"],
                 "anthropic-version": "2023-06-01"},
        json={"model": MODEL or "claude-sonnet-4-6", "max_tokens": 4000,
              "system": system_prompt, "messages": messages},
        timeout=60)
    r.raise_for_status()
    return "".join(b.get("text", "") for b in r.json()["content"])


def call_openai_chat(system_prompt: str, messages: list) -> str:
    base_url = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1")
    r = requests.post(
        base_url.rstrip("/") + "/chat/completions",
        headers={"Authorization": "Bearer " + os.environ["OPENAI_API_KEY"]},
        json={"model": MODEL or "gpt-4o",
              "messages": [{"role": "system", "content": system_prompt}] + messages,
              "max_tokens": 4000},
        timeout=60)
    r.raise_for_status()
    return r.json()["choices"][0]["message"]["content"]


def call_llm_chat(system_prompt: str, messages: list) -> str:
    # Same provider switch as generate_import/main.py's extract_file: OpenAI
    # when OPENAI_API_KEY is bound, else Anthropic. Only bind the secret this
    # project actually provisions in the `secrets=[...]` list below.
    if os.environ.get("OPENAI_API_KEY"):
        return call_openai_chat(system_prompt, messages)
    return call_anthropic_chat(system_prompt, messages)


def _sanitize_messages(raw_messages) -> list:
    """Keeps only well-formed {role, content} turns, last 20, content capped
    — this is untrusted client input forwarded into an LLM prompt, not
    Firestore, but still worth bounding."""
    out = []
    for m in (raw_messages or [])[-20:]:
        role = m.get("role") if isinstance(m, dict) else None
        content = m.get("content") if isinstance(m, dict) else None
        if role in ("user", "assistant") and isinstance(content, str) and content.strip():
            out.append({"role": role, "content": content[:8000]})
    return out


@https_fn.on_call(region="asia-south1", memory=512, timeout_sec=60, max_instances=3,
                   secrets=["OPENAI_API_KEY"])
def ai_assistant(req: https_fn.CallableRequest):
    _require_ops_admin(req)

    school_id = req.data.get("schoolId") or None
    messages = _sanitize_messages(req.data.get("messages"))
    proposal_kind = req.data.get("proposalKind") or None

    if not messages:
        raise https_fn.HttpsError(
            https_fn.FunctionsErrorCode.INVALID_ARGUMENT, "messages is required.")

    if proposal_kind and proposal_kind not in PROPOSAL_INSTRUCTIONS:
        # Not a hard error — just tell the user (and the model) this kind
        # isn't wired up as a structured draft yet, so it can still explain
        # things conversationally, per "don't omit any existing page."
        return {"type": "text",
                "content": (f"I don't yet have a structured draft for '{proposal_kind}'. "
                            "Ask me in plain language and I can point you to the right "
                            "page and what to fill in there.")}

    db = firestore.client()
    context = _read_school_context(db, school_id) if school_id else None
    system_prompt = _build_system_prompt(school_id, context)

    if proposal_kind:
        system_prompt += "\n\n## This request\n" + PROPOSAL_INSTRUCTIONS[proposal_kind]

    try:
        raw_text = call_llm_chat(system_prompt, messages)
    except Exception as e:
        raise https_fn.HttpsError(https_fn.FunctionsErrorCode.INTERNAL, str(e))

    if not proposal_kind:
        return {"type": "text", "content": raw_text}

    try:
        proposal = json.loads(_strip_json_fences(raw_text))
        missing = [k for k in REQUIRED_PROPOSAL_KEYS[proposal_kind] if not proposal.get(k)]
        if missing:
            raise ValueError(f"missing required field(s): {', '.join(missing)}")
    except Exception as e:
        # Never return malformed data as a proposal — fall back to text so
        # the human sees what went wrong instead of a broken pre-filled form.
        return {"type": "text",
                "content": f"I couldn't produce a valid draft ({e}). Here's what I have:\n\n{raw_text}"}

    return {"type": "proposal", "proposalKind": proposal_kind, "proposal": proposal}
