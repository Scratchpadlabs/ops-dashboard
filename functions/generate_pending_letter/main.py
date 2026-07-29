"""
ClarifiEd Pending Items Letter Generator — Cloud Function (ReportLab)

v2: a compose dialog (scope selection -> editable preview -> generate)
replaced v1's one-click flow, so this now has two modes instead of always
drafting-then-rendering in one shot:
  mode="draft"  — LLM call ONLY, returns {"intro", "closing"} as JSON.
                  Called once per "Draft letter"/"Regenerate draft" click.
  mode="render" (default) — PURE render, NO LLM call. Takes the (possibly
                  user-edited) intro/closing/extraNote and the selected
                  items (each optionally carrying a `comment`) and returns
                  the PDF. What was previewed in the dialog is exactly what
                  gets rendered — see SchoolProfile.vue / PendingLetterDialog.vue.

GUARDRAIL unchanged from v1: the pending items list is rendered verbatim —
render mode never calls an LLM at all, so there's no path by which prose
generation could touch item text. draft mode's _draft_paragraphs never sees
the item list either way. If that call fails, or neither provider's key is
configured, _draft_paragraphs falls back to DEFAULT_INTRO/DEFAULT_CLOSING so
"Draft letter" always produces something editable (task requirement).

Provider: OpenAI if OPENAI_API_KEY is set (the active provider — same
switch as functions/generate_import/main.py's extract_file), else Anthropic
if ANTHROPIC_API_KEY is set instead, else the fallback prose above.

Deploy:
  gcloud functions deploy generate_pending_letter \
    --gen2 --runtime python312 --region asia-south1 \
    --source . --entry-point generate_pending_letter \
    --trigger-http --allow-unauthenticated \
    --memory 256MB --timeout 60s --max-instances 3 --project clarified-1501 \
    --set-secrets OPENAI_API_KEY=OPENAI_API_KEY:latest \
    --set-env-vars MODEL=gpt-4o-mini

Folder needs: main.py, requirements.txt, logo.png (copied from
functions/generate_agreement/logo.png — same ClarifiEd letterhead mark).
"""

import io
import json
import os
import re
from datetime import datetime

import requests
import functions_framework
from flask import Request, Response
from PIL import Image as PILImage
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import cm
from reportlab.platypus import (
    Image as RLImage, ListFlowable, ListItem, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle,
)

API_KEY = "9421060748"
# No hardcoded default — _call_openai/_call_anthropic each pick their own
# provider-appropriate default when MODEL isn't set.
MODEL = os.environ.get("MODEL")
LOGO_PATH = os.path.join(os.path.dirname(__file__), "logo.png")

CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Api-Key",
}

# ── Brand palette — matches generate_agreement's ClarifiEd letterhead ───────────
NAVY  = colors.HexColor("#1e3a5f")
LIGHT = colors.HexColor("#f0f7ff")
GREY  = colors.HexColor("#64748b")
WHITE = colors.white
BLACK = colors.black
AMBER_HEX = "#b45309"  # note-date highlight — inline <font> tags need a hex string, not a Color

PAGE_W, PAGE_H = A4
L_MARGIN = 2.2 * cm
R_MARGIN = 2.2 * cm
BODY_W   = PAGE_W - L_MARGIN - R_MARGIN


def _make_style(name, font="Helvetica", size=9, leading=13, color=BLACK,
                 align=4, space_before=0, space_after=4, left_indent=0):
    return ParagraphStyle(
        name, fontName=font, fontSize=size, leading=leading, textColor=color,
        alignment=align, spaceBefore=space_before, spaceAfter=space_after,
        leftIndent=left_indent,
    )


BODY       = _make_style("body", size=9.5, leading=14, space_after=6)
BODY_LEFT  = _make_style("body_left",  size=8, leading=11, color=GREY, align=0, space_after=0)
BODY_RIGHT = _make_style("body_right", size=8, leading=11, color=GREY, align=2, space_after=0)
SALUTATION = _make_style("salutation", font="Helvetica-Bold", size=10, space_after=8)
SECTION_H  = _make_style("section_h", font="Helvetica-Bold", size=9, color=GREY, space_before=8, space_after=3)
ITEM_STYLE = _make_style("item", size=9, leading=13, space_after=2)
COMMENT_STYLE = _make_style("comment", font="Helvetica-Oblique", size=8, leading=11,
                             color=GREY, space_after=2, left_indent=10)
SIGN_NAME  = _make_style("sign_name", font="Helvetica-Bold", size=9.5, color=NAVY, space_after=1)
SIGN_SUB   = _make_style("sign_sub", size=8.5, color=GREY, space_after=0)


def _format_note_date(raw):
    """Items only carry `date` from when they were last marked received (see
    DataReceivableSectionCard.vue) — for a currently-unchecked item that's
    almost always empty, but can go stale (ISO timestamp) if an item was
    checked and later unchecked again. Render it readably if so; pass through
    anything else (e.g. a future plain-text deadline) unchanged."""
    raw = (raw or "").strip()
    if not raw:
        return ""
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        return f"{dt.day} {dt.strftime('%b %Y')}"  # avoids non-portable %-d/%#d strftime flags
    except ValueError:
        return raw


def _load_logo(height=None, width=None):
    """Crop the transparent padding off logo.png and return a right-sized Image flowable."""
    im = PILImage.open(LOGO_PATH).convert("RGBA")
    bbox = im.getbbox()
    if bbox:
        im = im.crop(bbox)
    w, h = im.size
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    buf.seek(0)
    if height is not None:
        target_h, target_w = height, height * w / h
    else:
        target_w, target_h = width, width * h / w
    return RLImage(buf, width=target_w, height=target_h)


# ── LLM-drafted prose (intro/closing ONLY — see module docstring guardrail) ────
DEFAULT_INTRO = (
    "We hope this note finds you well. As we continue working together on {school_name}'s "
    "Holistic Progress Cards, we wanted to share a quick update on a few items that are "
    "still pending from your end."
)
DEFAULT_CLOSING = (
    "We'd be grateful if these could be shared with us at the earliest so we can stay on "
    "track with the delivery timeline. Please don't hesitate to reach out if you have any "
    "questions — thank you for your continued support and partnership."
)


def _build_prompt(school_name):
    return (
        "You are drafting a short, warm, professional letter from ClarifiEd (a school "
        f"report-card platform) to {school_name}, a partner school. The letter separately "
        "lists data/items still pending from the school — you do not see that list and must "
        "not reference specific item names or counts. Address the school generally — do NOT "
        "name or refer to any individual person (no principal, contact, or staff name/title) "
        "anywhere in the text. A salutation ('Dear ...') is already rendered separately above "
        "your intro, and a sign-off ('Warm regards, Team ClarifiEd') is already rendered "
        "separately below your closing — do NOT include a greeting or sign-off yourself, start "
        "straight into the body text. Write exactly two short paragraphs:\n"
        "1. intro — a courteous opening (2-3 sentences) introducing that a few items are "
        "still pending from their end.\n"
        "2. closing — a short closing (1-2 sentences) with a gentle nudge on timeline and a "
        "thank-you.\n"
        "Vary tone/phrasing naturally so it doesn't read like a rigid template, but stay "
        "professional and warm. Return ONLY a JSON object with exactly these two keys: "
        '"intro", "closing" (plain text values, no markdown, no extra keys, no greeting/sign-off text).'
    )


def _call_anthropic(prompt):
    r = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={"x-api-key": os.environ["ANTHROPIC_API_KEY"], "anthropic-version": "2023-06-01"},
        json={"model": MODEL or "claude-sonnet-4-6", "max_tokens": 600,
              "messages": [{"role": "user", "content": prompt}]},
        timeout=30,
    )
    r.raise_for_status()
    return "".join(b.get("text", "") for b in r.json()["content"])


def _call_openai(prompt):
    # Defaults to the real OpenAI API; override OPENAI_BASE_URL to point at a
    # self-hosted OpenAI-compatible endpoint instead.
    base_url = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1")
    r = requests.post(
        base_url.rstrip("/") + "/chat/completions",
        headers={"Authorization": "Bearer " + os.environ.get("OPENAI_API_KEY", "x")},
        json={"model": MODEL or "gpt-4o-mini", "max_tokens": 600,
              "messages": [{"role": "user", "content": prompt}]},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["choices"][0]["message"]["content"]


def _draft_paragraphs(school_name):
    """Calls whichever LLM provider is configured for just the intro/closing
    prose. Never sees the item list, never returns anything that gets
    rendered as the item list — see _build_pdf, which renders `items` from
    the request payload directly. Never told a contact person's name either
    — the letter addresses the school generally (see _build_prompt)."""
    fallback = (DEFAULT_INTRO.format(school_name=school_name), DEFAULT_CLOSING)

    if os.environ.get("OPENAI_API_KEY"):
        call = _call_openai
    elif os.environ.get("ANTHROPIC_API_KEY"):
        call = _call_anthropic
    else:
        return fallback

    prompt = _build_prompt(school_name)
    try:
        text = call(prompt)
        text = re.sub(r"^```(json)?|```$", "", text.strip(), flags=re.M).strip()
        parsed = json.loads(text)
        intro = str(parsed.get("intro") or "").strip()
        closing = str(parsed.get("closing") or "").strip()
        if not intro or not closing:
            return fallback
        return intro, closing
    except Exception:
        return fallback


# ── PDF builder ──────────────────────────────────────────────────────────────
# render mode ONLY — no LLM call here. intro/closing/extra_note come straight
# from the request (the dialog's editable preview); if either text field is
# blank (e.g. a render call made without ever drafting) the same fallback
# prose from draft mode is used, so render never produces an empty letter.
def _build_pdf(data):
    # contactName/contactDesignation are deliberately never read here — the
    # letter never names or refers to an individual (see _build_prompt).
    school_name          = (data.get("schoolName") or "").strip()
    items                = data.get("items") or []
    date_str             = (data.get("date") or "").strip() or datetime.today().strftime("%d/%m/%Y")
    intro                = (data.get("intro") or "").strip() or DEFAULT_INTRO.format(school_name=school_name)
    closing              = (data.get("closing") or "").strip() or DEFAULT_CLOSING
    extra_note           = (data.get("extraNote") or "").strip()

    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4,
        leftMargin=L_MARGIN, rightMargin=R_MARGIN,
        topMargin=2.4*cm, bottomMargin=2.2*cm,
    )
    story = []

    # ── Header band ──────────────────────────────────────────────────────────
    logo_cell = _load_logo(height=30)
    header = Table(
        [[
            logo_cell,
            Paragraph(
                '<font size="10" color="white"><b>PENDING ITEMS &mdash; DATA REQUEST</b></font>',
                _make_style("hd", size=10, leading=13, color=WHITE, align=2)),
        ]],
        colWidths=[BODY_W * 0.32, BODY_W * 0.68],
    )
    header.setStyle(TableStyle([
        ("BACKGROUND",    (0,0), (-1,-1), NAVY),
        ("BACKGROUND",    (0,0), (0,0),   WHITE),
        ("TOPPADDING",    (0,0), (-1,-1), 18),
        ("BOTTOMPADDING", (0,0), (-1,-1), 18),
        ("LEFTPADDING",   (0,0), (0,-1),  10),
        ("RIGHTPADDING",  (0,0), (0,-1),  14),
        ("LEFTPADDING",   (1,0), (1,-1),  4),
        ("RIGHTPADDING",  (1,0), (1,-1),  10),
        ("VALIGN",        (0,0), (-1,-1), "MIDDLE"),
    ]))
    story.append(header)
    story.append(Spacer(1, 12))

    # ── To / Date meta strip ─────────────────────────────────────────────────
    meta = Table(
        [[
            Paragraph(f'To: <b>{school_name}</b>', BODY_LEFT),
            Paragraph(f'Date: <b>{date_str}</b>', BODY_RIGHT),
        ]],
        colWidths=[BODY_W * 0.6, BODY_W * 0.4],
    )
    meta.setStyle(TableStyle([
        ("BACKGROUND",    (0,0), (-1,-1), LIGHT),
        ("TOPPADDING",    (0,0), (-1,-1), 6),
        ("BOTTOMPADDING", (0,0), (-1,-1), 6),
        ("LEFTPADDING",   (0,0), (-1,-1), 12),
        ("RIGHTPADDING",  (0,0), (-1,-1), 12),
    ]))
    story.append(meta)
    story.append(Spacer(1, 14))

    # ── Salutation + intro (LLM, or fallback) ────────────────────────────────
    # Always the generic school greeting — the contact person's name/position
    # is never printed in the letter itself, even when known.
    salutation = f"Dear {school_name} Team,"
    story.append(Paragraph(salutation, SALUTATION))
    story.append(Paragraph(intro, BODY))
    story.append(Spacer(1, 4))

    # ── Pending items — rendered verbatim from the payload (labels are never
    # touched, comments are free text — see module docstring guardrail),
    # grouped by section if the frontend supplied one. An item's optional
    # comment renders as an indented italic note directly under it. ─────────
    story.append(Paragraph("Pending Items", _make_style(
        "items_h", font="Helvetica-Bold", size=10.5, color=NAVY, space_before=4, space_after=6)))

    sections, order = {}, []
    for it in items:
        label = (it.get("label") or "").strip()
        if not label:
            continue
        sec = (it.get("section") or "").strip() or "General"
        if sec not in sections:
            sections[sec] = []
            order.append(sec)
        sections[sec].append(it)

    for sec in order:
        if len(order) > 1:
            story.append(Paragraph(sec, SECTION_H))
        list_items = []
        for it in sections[sec]:
            label = it["label"].strip()
            note = _format_note_date(it.get("date") or it.get("deadline") or "")
            text = label if not note else f'{label} <font color="{AMBER_HEX}">(noted: {note})</font>'
            flowables = [Paragraph(text, ITEM_STYLE)]
            comment = (it.get("comment") or "").strip()
            if comment:
                flowables.append(Paragraph(comment, COMMENT_STYLE))
            list_items.append(ListItem(flowables, leftIndent=6, spaceAfter=2))
        story.append(ListFlowable(
            list_items, bulletType="bullet", start="•",
            leftIndent=14, bulletFontSize=8, bulletColor=NAVY,
        ))
        story.append(Spacer(1, 4))

    # ── Extra note (optional, free text) — between items and closing ────────
    if extra_note:
        story.append(Spacer(1, 4))
        for line in extra_note.split("\n"):
            story.append(Paragraph(line.strip() or "&nbsp;", BODY))

    # ── Closing (edited or fallback) + sign-off ──────────────────────────────
    story.append(Spacer(1, 8))
    story.append(Paragraph(closing, BODY))
    story.append(Spacer(1, 16))
    story.append(Paragraph("Warm regards,", _make_style("sign1", size=9, space_after=2)))
    story.append(Paragraph("Team ClarifiEd", SIGN_NAME))
    story.append(Paragraph("Scratchpad Labs Pvt Ltd", SIGN_SUB))

    story.append(Spacer(1, 20))
    closing_logo = _load_logo(width=70)
    closing_logo.hAlign = "CENTER"
    story.append(closing_logo)

    def _footer(canvas_obj, doc_obj):
        canvas_obj.saveState()
        canvas_obj.setFont("Helvetica", 7)
        canvas_obj.setFillColor(GREY)
        canvas_obj.drawString(L_MARGIN, 1.3*cm, f"ClarifiEd — Pending Items Letter — {school_name}")
        canvas_obj.drawRightString(PAGE_W - R_MARGIN, 1.3*cm, f"Page {doc_obj.page}")
        canvas_obj.restoreState()

    doc.build(story, onFirstPage=_footer, onLaterPages=_footer)
    buf.seek(0)
    return buf.read()


def _draft_response(data):
    """mode="draft" — LLM call only, no PDF. Called once per "Draft letter"/
    "Regenerate draft" click in the compose dialog. contactName is
    deliberately never read here either — see _build_prompt."""
    school_name = (data.get("schoolName") or "").strip()
    intro, closing = _draft_paragraphs(school_name)
    return {"intro": intro, "closing": closing}


# ── HTTP handler ─────────────────────────────────────────────────────────────
@functions_framework.http
def generate_pending_letter(request: Request):
    if request.method == "OPTIONS":
        return Response("", 204, headers=CORS_HEADERS)

    if request.headers.get("X-Api-Key") != API_KEY:
        return Response("Unauthorized", 401, headers=CORS_HEADERS)

    data = request.get_json(silent=True) or {}
    mode = (data.get("mode") or "render").strip().lower()
    school_name = (data.get("schoolName") or "").strip()

    if not school_name:
        return Response("Missing schoolName", 400, headers=CORS_HEADERS)

    if mode == "draft":
        try:
            result = _draft_response(data)
        except Exception as e:
            return Response(json.dumps({"error": str(e)}), 500,
                             mimetype="application/json", headers=CORS_HEADERS)
        return Response(json.dumps(result), 200, mimetype="application/json", headers=CORS_HEADERS)

    # mode == "render" (default) — pure render, no LLM call (see _build_pdf).
    items = data.get("items") or []
    if not items:
        return Response("No pending items to include", 400, headers=CORS_HEADERS)

    try:
        pdf_bytes = _build_pdf(data)
    except Exception as e:
        return Response(json.dumps({"error": str(e)}), 500,
                         mimetype="application/json", headers=CORS_HEADERS)

    safe = re.sub(r"[^a-zA-Z0-9]+", "-", school_name).strip("-").lower() or "school"
    filename = f"pending-items-{safe}-{datetime.today().strftime('%Y%m%d')}.pdf"

    return Response(
        pdf_bytes, 200,
        mimetype="application/pdf",
        headers={**CORS_HEADERS, "Content-Disposition": f'inline; filename="{filename}"'},
    )
