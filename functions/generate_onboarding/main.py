"""
ClarifiEd Onboarding Document Generator - Cloud Function (ReportLab)
Generates the school onboarding setup guide PDF entirely in Python; no LibreOffice
or Word dependency. Returns PDF blob directly (same pattern as generate_agreement).

Deploy:
  gcloud functions deploy generate_onboarding \
    --gen2 --runtime python312 --region asia-south1 \
    --source functions/generate_onboarding --entry-point generate_onboarding \
    --trigger-http --allow-unauthenticated \
    --memory 256MB --max-instances 3 --project clarified-1501

Folder needs: main.py, requirements.txt, logo.png
"""

import io
import json
import os
from datetime import datetime

import functions_framework
from flask import Request, Response
from PIL import Image as PILImage
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import cm
from reportlab.platypus import (
    Image as RLImage, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle,
)

API_KEY = "9421060748"

LOGO_PATH = os.path.join(os.path.dirname(__file__), "logo.png")

# ── Brand palette (matches generate_agreement) ─────────────────────────────────
NAVY  = colors.HexColor("#1e3a5f")
BLUE  = colors.HexColor("#3b82f6")
LIGHT = colors.HexColor("#f0f7ff")
SLATE = colors.HexColor("#f8fafc")
GREY  = colors.HexColor("#64748b")
LGREY = colors.HexColor("#cbd5e1")
WHITE = colors.white
BLACK = colors.black

PAGE_W, PAGE_H = A4
L_MARGIN = 2.2 * cm
R_MARGIN = 2.2 * cm
BODY_W   = PAGE_W - L_MARGIN - R_MARGIN


# ── Styles ─────────────────────────────────────────────────────────────────────

def _make_style(name, font="Helvetica", size=9, leading=13, color=BLACK,
                 align=4, space_before=0, space_after=4):
    return ParagraphStyle(
        name,
        fontName=font,
        fontSize=size,
        leading=leading,
        textColor=color,
        alignment=align,
        spaceBefore=space_before,
        spaceAfter=space_after,
    )

BODY        = _make_style("body",        space_after=5)
BODY_SMALL  = _make_style("body_small",  size=8, leading=11, color=GREY, space_after=3)
SECTION_HEAD = _make_style("section_head", font="Helvetica-Bold", size=11.5, color=NAVY,
                            space_before=14, space_after=5)
COL_HEAD    = _make_style("col_head",    font="Helvetica-Bold", size=9.5, color=NAVY, space_after=4)
SUBCLAUSE   = _make_style("subclause",   size=8.7, leading=12.5, space_after=4)


# ── Helpers ────────────────────────────────────────────────────────────────────

def _academic_year():
    today = datetime.today()
    start = today.year if today.month >= 4 else today.year - 1
    return f"{start}-{str(start + 1)[-2:]}"


def _load_logo(target_width_cm):
    """Crop the transparent padding off logo.png and return a right-sized Image flowable."""
    im = PILImage.open(LOGO_PATH).convert("RGBA")
    bbox = im.getbbox()
    if bbox:
        im = im.crop(bbox)
    w, h = im.size
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    buf.seek(0)
    target_w = target_width_cm * cm
    target_h = target_w * h / w
    return RLImage(buf, width=target_w, height=target_h)


def _empty_form_table(headers, col_widths, n_rows, row_height=0.85 * cm):
    data = [headers] + [[""] * len(headers) for _ in range(n_rows)]
    t = Table(data, colWidths=col_widths, rowHeights=[None] + [row_height] * n_rows)
    t.setStyle(TableStyle([
        ("BACKGROUND",      (0, 0), (-1, 0), NAVY),
        ("TEXTCOLOR",       (0, 0), (-1, 0), WHITE),
        ("FONTNAME",        (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE",        (0, 0), (-1, 0), 8.5),
        ("GRID",            (0, 0), (-1, -1), 0.5, LGREY),
        ("VALIGN",          (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING",      (0, 0), (-1, 0), 7),
        ("BOTTOMPADDING",   (0, 0), (-1, 0), 7),
        ("LEFTPADDING",     (0, 0), (-1, -1), 8),
        ("RIGHTPADDING",    (0, 0), (-1, -1), 8),
        ("ROWBACKGROUNDS",  (0, 1), (-1, -1), [WHITE, SLATE]),
    ]))
    return t


def _checkbox_row(*labels):
    text = "&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;".join(f"[&nbsp;&nbsp;]&nbsp; {lbl}" for lbl in labels)
    return Paragraph(text, BODY)


# ── PDF builder ────────────────────────────────────────────────────────────────

def _build_pdf(data):
    school_name   = data["schoolName"]
    academic_year = (data.get("academicYear") or "").strip() or _academic_year()
    city          = (data.get("city") or "").strip()
    poc_name      = (data.get("pocName") or "").strip()
    poc_phone     = (data.get("pocPhone") or "").strip()

    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4,
        leftMargin=L_MARGIN, rightMargin=R_MARGIN,
        topMargin=2.6 * cm, bottomMargin=2.4 * cm,
    )

    story = []

    # ── Header band ───────────────────────────────────────────────────────────
    logo_img = _load_logo(4.0)

    header = Table(
        [[
            logo_img,
            Paragraph(
                '<font size="13" color="white"><b>ONBOARDING SETUP GUIDE</b></font>',
                _make_style("hr_title", size=13, leading=16, color=WHITE, align=2)),
        ]],
        colWidths=[BODY_W * 0.42, BODY_W * 0.58],
    )
    header.setStyle(TableStyle([
        ("BACKGROUND",    (0, 0), (-1, -1), NAVY),
        ("BACKGROUND",    (0, 0), (0, 0),   WHITE),
        ("TOPPADDING",    (0, 0), (-1, -1), 14),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 14),
        ("LEFTPADDING",   (0, 0), (0, -1),  18),
        ("RIGHTPADDING",  (-1, 0), (-1, -1), 18),
        ("VALIGN",        (0, 0), (-1, -1), "MIDDLE"),
    ]))
    story.append(header)

    # Light blue school / academic year strip
    strip = Table(
        [[Paragraph(
            f'<font size="11" color="#1e3a5f"><b>{school_name} | A.Y {academic_year}</b></font>',
            _make_style("strip", size=11, color=NAVY, align=1))]],
        colWidths=[BODY_W],
    )
    strip.setStyle(TableStyle([
        ("BACKGROUND",    (0, 0), (-1, -1), LIGHT),
        ("TOPPADDING",    (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
    ]))
    story.append(strip)
    story.append(Spacer(1, 12))

    # Optional meta line (city / primary POC)
    meta_parts = []
    if city:
        meta_parts.append(f"City: {city}")
    if poc_name:
        meta_parts.append(f"Primary POC: {poc_name}" + (f" ({poc_phone})" if poc_phone else ""))
    if meta_parts:
        story.append(Paragraph(" &nbsp;|&nbsp; ".join(meta_parts), BODY_SMALL))
        story.append(Spacer(1, 6))

    # ── Intro ─────────────────────────────────────────────────────────────────
    story.append(Paragraph(
        f"This document outlines all the information we need to set up the HPC App for "
        f"{school_name}. Please share the requested details with your ClarifiEd Relationship "
        f"Manager.",
        BODY,
    ))

    def section(title, intro=None):
        story.append(Paragraph(title, SECTION_HEAD))
        if intro:
            story.append(Paragraph(intro, BODY))

    # ── Section 1 — Academic Data Entry ─────────────────────────────────────
    section(
        "1. Academic Data Entry",
        "Please choose one of the following methods for submitting academic marks, grades, "
        "and attendance data:",
    )
    col1 = [
        Paragraph("Direct Entry in Our App (Highly Recommended)", COL_HEAD),
        Paragraph(
            "The app supports all activities required for creating the HPC. All academic "
            "marks, attendance and co-scholastic grades can be directly entered in our system. "
            "Training will be provided.",
            SUBCLAUSE,
        ),
    ]
    col2 = [
        Paragraph("Use Existing ERP/LMS", COL_HEAD),
        Paragraph(
            "If you use an existing ERP/LMS, you may export the required data and share it in "
            "Excel format. Data must be shared in its final form with all mark conversions and "
            "weightages already applied.",
            SUBCLAUSE,
        ),
    ]
    two_col = Table([[col1, col2]], colWidths=[BODY_W * 0.49, BODY_W * 0.49])
    two_col.setStyle(TableStyle([
        ("BOX",           (0, 0), (0, 0), 0.6, LGREY),
        ("BOX",           (1, 0), (1, 0), 0.6, LGREY),
        ("BACKGROUND",    (0, 0), (0, 0), LIGHT),
        ("BACKGROUND",    (1, 0), (1, 0), SLATE),
        ("VALIGN",        (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING",    (0, 0), (-1, -1), 10),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
        ("LEFTPADDING",   (0, 0), (-1, -1), 10),
        ("RIGHTPADDING",  (0, 0), (-1, -1), 10),
    ]))
    story.append(two_col)

    # ── Section 2 — Assessment Pattern ──────────────────────────────────────
    section(
        "2. Assessment Pattern",
        "Please share the list of assessments that appear on your school's report card for "
        "each grade.",
    )
    story.append(_empty_form_table(
        ["Grade", "Assessment Names (e.g. FA1, FA2, PT1, Half-Yearly, Annual)"],
        [BODY_W * 0.2, BODY_W * 0.8], 6,
    ))

    # ── Section 3 — Class-wise Subject Details ──────────────────────────────
    section(
        "3. Class-wise Subject Details",
        "Please share the complete list of subjects for each grade. If a subject is divided "
        "(e.g. Science into Physics, Chemistry, Biology), mention them separately.",
    )
    story.append(_empty_form_table(
        ["Grade", "Subjects"], [BODY_W * 0.2, BODY_W * 0.8], 6,
    ))

    # ── Section 4 — Co-Scholastic Subject Details ───────────────────────────
    section(
        "4. Co-Scholastic Subject Details",
        "Names of all non-academic subjects included in the report card, along with the "
        "grading scale used.",
    )
    story.append(_empty_form_table(
        ["Grade", "Co-Scholastic Subjects", "Grading Scale"],
        [BODY_W * 0.18, BODY_W * 0.52, BODY_W * 0.30], 4,
    ))

    # ── Section 5 — Teacher Information ─────────────────────────────────────
    section("5. Teacher Information", "Please share the following details for all teachers:")
    for i, text in enumerate([
        "Teacher's Name",
        "Subjects taught and corresponding grades",
        "If Class Teacher, mention grade and section",
        "Unique Teacher ID (employee code for app login)",
    ], start=1):
        story.append(Paragraph(f"{i}. {text}", SUBCLAUSE))
    story.append(Spacer(1, 6))
    story.append(_empty_form_table(
        ["Teacher Name", "Subjects & Grades", "Class Teacher (Grade/Section)", "Teacher ID"],
        [BODY_W * 0.25, BODY_W * 0.30, BODY_W * 0.27, BODY_W * 0.18], 8,
    ))

    # ── Section 6 — Student Information ─────────────────────────────────────
    section("6. Student Information", "The following details are mandatory for each student:")
    left_items  = ["1. Name", "2. Gender", "3. Roll Number"]
    right_items = ["4. Grade/Class", "5. Section", "6. Student ID / Admission Number"]
    rows = [[Paragraph(l, SUBCLAUSE), Paragraph(r, SUBCLAUSE)] for l, r in zip(left_items, right_items)]
    list_table = Table(rows, colWidths=[BODY_W * 0.49, BODY_W * 0.49])
    list_table.setStyle(TableStyle([
        ("VALIGN",        (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING",    (0, 0), (-1, -1), 2),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
        ("LEFTPADDING",   (0, 0), (-1, -1), 0),
        ("RIGHTPADDING",  (0, 0), (-1, -1), 0),
    ]))
    story.append(list_table)
    story.append(Spacer(1, 6))
    story.append(Paragraph(
        "<i>Please share the complete Student Information file from your Admission Register "
        "or ERP/LMS.</i>",
        BODY_SMALL,
    ))

    # ── Section 7 — Previous Report Card Sample ─────────────────────────────
    section(
        "7. Previous Report Card Sample",
        "Please share the previous academic year's report card for each grade in any format "
        "(PDF, scanned copy, or photographs).",
    )
    story.append(_checkbox_row("Shared via WhatsApp", "Shared via Email", "Shared via Google Drive"))

    # ── Section 8 — School Logo ──────────────────────────────────────────────
    section(
        "8. School Logo",
        "Please share your school logo in HD quality (PNG format preferred, minimum 500x500 "
        "pixels).",
    )
    story.append(_checkbox_row("Shared via WhatsApp", "Shared via Email", "Shared via Google Drive"))

    # ── Footer on every page ──────────────────────────────────────────────────
    def _footer(canvas_obj, doc_obj):
        canvas_obj.saveState()
        canvas_obj.setFont("Helvetica", 7)
        canvas_obj.setFillColor(GREY)
        canvas_obj.drawString(
            L_MARGIN, 1.2 * cm,
            "ClarifiEd by Scratchpad Labs | team@scratchpadlabs.com | +91-9421060748",
        )
        canvas_obj.drawRightString(
            PAGE_W - R_MARGIN, 1.2 * cm,
            f"Page {doc_obj.page}",
        )
        canvas_obj.restoreState()

    doc.build(story, onFirstPage=_footer, onLaterPages=_footer)
    buf.seek(0)
    return buf.read()


# ── HTTP handler ───────────────────────────────────────────────────────────────

@functions_framework.http
def generate_onboarding(request: Request):
    CORS = {"Access-Control-Allow-Origin": "*"}

    if request.method == "OPTIONS":
        return Response("", 204, headers={
            **CORS,
            "Access-Control-Allow-Methods": "POST",
            "Access-Control-Allow-Headers": "Content-Type, X-Api-Key",
        })

    if request.headers.get("X-Api-Key") != API_KEY:
        return Response("Unauthorized", 401, headers=CORS)

    data        = request.get_json(silent=True) or {}
    school_name = (data.get("schoolName") or "").strip()

    if not school_name:
        return Response("Missing schoolName", 400, headers=CORS)

    try:
        pdf_bytes = _build_pdf(data)
    except Exception as e:
        return Response(
            json.dumps({"error": str(e)}), 500,
            mimetype="application/json",
            headers=CORS,
        )

    safe = "".join(ch for ch in school_name if ch not in '\\/:*?"<>|')
    return Response(
        pdf_bytes, 200,
        mimetype="application/pdf",
        headers={
            **CORS,
            "Content-Disposition": f'inline; filename="Onboarding_{safe}.pdf"',
        },
    )
