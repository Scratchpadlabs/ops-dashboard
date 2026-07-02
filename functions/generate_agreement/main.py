"""
ClarifiEd Agreement Generator — Cloud Function (ReportLab)
Generates a service agreement PDF entirely in Python; no LibreOffice or Word dependency.
Returns PDF blob directly (same pattern as generate_invoice / generate_quotation).

Deploy:
  gcloud functions deploy generate_agreement \
    --gen2 --runtime python312 --region asia-south1 \
    --source . --entry-point generate_agreement \
    --trigger-http --allow-unauthenticated \
    --memory 256MB --max-instances 3 --project clarified-1501

Folder needs: main.py, requirements.txt  (no extra assets required)
"""

import io
import json
import os
from datetime import datetime

import functions_framework
from flask import Request, Response
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import cm
from reportlab.lib.utils import ImageReader
from reportlab.platypus import (
    HRFlowable, Image, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle,
)

API_KEY = "9421060748"

_DIR = os.path.dirname(os.path.abspath(__file__))
LOGO_PATH = os.path.join(_DIR, "logo.png")

# ── Brand palette ──────────────────────────────────────────────────────────────
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

def _make_style(name, font="Helvetica", size=9, leading=14, color=BLACK,
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
CLAUSE_HEAD = _make_style("clause_head", font="Helvetica-Bold", size=9, color=NAVY,
                           space_before=10, space_after=3)
SIG_NAME    = _make_style("sig_name",    font="Helvetica-Bold", size=9, space_after=2)


# ── Helpers ────────────────────────────────────────────────────────────────────

def _format_inr(amount):
    s = str(int(amount))
    if len(s) <= 3:
        return s
    result, s = s[-3:], s[:-3]
    while s:
        result = s[-2:] + "," + result
        s = s[:-2]
    return result.lstrip(",")


def _academic_year():
    today = datetime.today()
    start = today.year if today.month >= 4 else today.year - 1
    return f"{start}-{str(start + 1)[-2:]}"


def _today_str():
    return datetime.today().strftime("%-d %B %Y")


def _table(*rows, col_widths, style_cmds):
    t = Table(list(rows), colWidths=col_widths)
    t.setStyle(TableStyle(style_cmds))
    return t


def _logo_flowable(height=35):
    if not os.path.exists(LOGO_PATH):
        return None
    iw, ih = ImageReader(LOGO_PATH).getSize()
    return Image(LOGO_PATH, width=height * (iw / ih), height=height)


# ── PDF builder ────────────────────────────────────────────────────────────────

def _build_pdf(data):
    school_name = data["schoolName"]
    school_addr = (data.get("schoolAddress") or "").strip() or "—"
    signatory   = (data.get("signatoryName") or "Authorised Signatory").strip()
    designation = (data.get("signatoryDesignation") or "").strip()
    hpc_type    = (data.get("hpcType") or "printed and digital").strip()
    fee         = int(data["feePerStudent"])
    students    = int(data["studentCount"])
    plan        = (data.get("installmentPlan") or "A").strip()
    agr_num     = (data.get("agreementNumber") or "").strip()

    total        = fee * students
    academic_year = _academic_year()
    today        = _today_str()
    splits       = [50, 25, 25] if plan != "B" else [25, 25, 25, 25]
    inst_amts    = [round(total * p / 100) for p in splits]

    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4,
        leftMargin=L_MARGIN, rightMargin=R_MARGIN,
        topMargin=2.6*cm, bottomMargin=2.4*cm,
    )

    story = []

    # ── Header band ───────────────────────────────────────────────────────────
    logo_cell = _logo_flowable(35) or Paragraph('<font size="17" color="white"><b>ClarifiEd</b></font>', BODY)

    header = _table(
        [
            logo_cell,
            Paragraph(
                '<font size="9" color="white"><b>AGREEMENT FOR THE PROVISION OF HOLISTIC PROGRESS CARD SERVICES</b></font>',
                _make_style("hr", size=9, leading=11, color=WHITE, align=2)),
        ],
        col_widths=[BODY_W * 0.35, BODY_W * 0.65],
        style_cmds=[
            ("BACKGROUND",    (0,0), (-1,-1), NAVY),
            ("TOPPADDING",    (0,0), (-1,-1), 14),
            ("BOTTOMPADDING", (0,0), (-1,-1), 14),
            ("LEFTPADDING",   (0,0), (0,-1),  18),
            ("RIGHTPADDING",  (-1,0),(-1,-1), 18),
            ("VALIGN",        (0,0), (-1,-1), "MIDDLE"),
        ],
    )
    story.append(header)
    story.append(Spacer(1, 4))

    # Ref / date meta strip
    meta = _table(
        [
            Paragraph(f'<font size="8" color="#64748b">Ref: <b>{agr_num}</b></font>', BODY_SMALL),
            Paragraph(f'<font size="8" color="#64748b">Date: <b>{today}</b></font>',
                      _make_style("mr", size=8, color=GREY, align=2)),
        ],
        col_widths=[BODY_W * 0.5, BODY_W * 0.5],
        style_cmds=[
            ("BACKGROUND",    (0,0), (-1,-1), LIGHT),
            ("TOPPADDING",    (0,0), (-1,-1), 6),
            ("BOTTOMPADDING", (0,0), (-1,-1), 6),
            ("LEFTPADDING",   (0,0), (-1,-1), 12),
            ("RIGHTPADDING",  (0,0), (-1,-1), 12),
        ],
    )
    story.append(meta)
    story.append(Spacer(1, 14))

    # ── Parties intro ─────────────────────────────────────────────────────────
    story.append(Paragraph(
        f'This Service Agreement ("<b>Agreement</b>") is entered into as of <b>{today}</b> '
        f'("<b>Effective Date</b>") between:', BODY,
    ))
    story.append(Spacer(1, 6))

    parties = _table(
        [
            Paragraph(
                '<b>ClarifiEd</b><br/>'
                '<font size="8" color="#64748b">(hereinafter "ClarifiEd" or the "Company")</font>',
                BODY,
            ),
            Paragraph(
                f'<b>{school_name}</b><br/>'
                f'<font size="8" color="#64748b">{school_addr}<br/>'
                f'(hereinafter the "School")</font>',
                BODY,
            ),
        ],
        col_widths=[BODY_W * 0.48, BODY_W * 0.48],
        style_cmds=[
            ("BOX",           (0,0), (0,0),   0.5, NAVY),
            ("BOX",           (1,0), (1,0),   0.5, NAVY),
            ("BACKGROUND",    (0,0), (0,0),   LIGHT),
            ("BACKGROUND",    (1,0), (1,0),   SLATE),
            ("TOPPADDING",    (0,0), (-1,-1), 10),
            ("BOTTOMPADDING", (0,0), (-1,-1), 10),
            ("LEFTPADDING",   (0,0), (-1,-1), 10),
            ("RIGHTPADDING",  (0,0), (-1,-1), 10),
        ],
    )
    story.append(parties)
    story.append(Spacer(1, 10))

    # ── Clauses ───────────────────────────────────────────────────────────────
    def clause(title, *paras):
        story.append(Paragraph(title, CLAUSE_HEAD))
        for p in paras:
            story.append(Paragraph(p, BODY))

    clause(
        "1.  DEFINITIONS",
        f'"<b>HPC</b>" means the Home Practice Content ({hpc_type}) produced and supplied by ClarifiEd under this Agreement.',
        f'"<b>Academic Year</b>" means the school academic year <b>{academic_year}</b>.',
        '"<b>Students</b>" means the enrolled students of the School who are to receive HPCs under this Agreement.',
    )

    clause(
        "2.  SCOPE OF SERVICES",
        f'ClarifiEd shall produce and deliver {hpc_type} HPC materials aligned to the School\'s curriculum for the Academic Year {academic_year}.',
        "ClarifiEd shall deliver HPCs within six (6) working days of receiving complete and confirmed student data from the School.",
        "ClarifiEd may adjust delivery timelines proportionally in the event of force majeure or delayed receipt of student data.",
    )

    clause(
        "3.  STUDENT COUNT & MID-YEAR ADMISSIONS",
        f'This Agreement covers an estimated <b>{students:,} students</b>. The School shall confirm the final count before production commences.',
        "The full per-student fee shall apply to all mid-year admissions. ClarifiEd shall invoice such additional units at the same agreed rate.",
    )

    clause(
        "4.  FEES",
        f'The agreed fee is <b>Rs. {fee}/- per student</b> (inclusive of all applicable taxes), giving a total contract value of '
        f'<b>Rs. {_format_inr(total)}/-</b> for {students:,} students.',
        "All payments shall be due and payable within forty-five (45) working days of the date of each invoice and shall be non-refundable unless otherwise agreed in writing.",
    )

    # Clause 5 — installment table
    story.append(Paragraph("5.  PAYMENT SCHEDULE", CLAUSE_HEAD))
    plan_label = "50% · 25% · 25%" if plan == "A" else "25% · 25% · 25% · 25%"
    story.append(Paragraph(
        f'Payment Plan <b>{plan}</b> ({plan_label}) applies. Instalments are due within 45 working days of the triggering event.',
        BODY,
    ))

    triggers = (
        ["Upon onboarding", "After Term 1 delivery", "After final delivery"]
        if plan == "A"
        else ["Upon onboarding", "After Term 1", "After Term 2", "After final delivery"]
    )
    tbl_data  = [["Instalment", "Trigger", "%", "Amount (Rs.)"]]
    for i, (pct, trigger, amt) in enumerate(zip(splits, triggers, inst_amts)):
        tbl_data.append([f"Instalment {i+1}", trigger, f"{pct}%", f"Rs. {_format_inr(amt)}/-"])
    tbl_data.append(["", "Total", "100%", f"Rs. {_format_inr(total)}/-"])

    row_count = len(tbl_data)
    pmt_style = [
        ("BACKGROUND",    (0,0), (-1,0),          NAVY),
        ("TEXTCOLOR",     (0,0), (-1,0),          WHITE),
        ("FONTNAME",      (0,0), (-1,0),          "Helvetica-Bold"),
        ("BACKGROUND",    (0,-1),(-1,-1),         LIGHT),
        ("FONTNAME",      (0,-1),(-1,-1),         "Helvetica-Bold"),
        ("FONTSIZE",      (0,0), (-1,-1),         8),
        ("GRID",          (0,0), (-1,-1),         0.3, LGREY),
        ("ALIGN",         (2,0), (-1,-1),         "CENTER"),
        ("ALIGN",         (0,0), (0,-1),          "CENTER"),
        ("TOPPADDING",    (0,0), (-1,-1),         5),
        ("BOTTOMPADDING", (0,0), (-1,-1),         5),
        ("LEFTPADDING",   (0,0), (-1,-1),         8),
        ("RIGHTPADDING",  (0,0), (-1,-1),         8),
    ]
    for i in range(1, row_count - 1):
        bg = SLATE if i % 2 == 1 else WHITE
        pmt_style.append(("BACKGROUND", (0,i), (-1,i), bg))

    pmt_table = Table(tbl_data, colWidths=[BODY_W*0.18, BODY_W*0.42, BODY_W*0.12, BODY_W*0.28])
    pmt_table.setStyle(TableStyle(pmt_style))
    story.append(pmt_table)

    clause(
        "6.  INTELLECTUAL PROPERTY",
        "All content, designs, and materials comprising the HPC are the exclusive intellectual property of ClarifiEd. "
        "The School is granted a non-exclusive, non-transferable licence to use the HPC solely for educational purposes "
        "within its own premises during the Academic Year.",
        "The School shall not reproduce, distribute, sell, or modify the HPC materials without prior written consent from ClarifiEd.",
    )

    clause(
        "7.  CONFIDENTIALITY",
        "Each party agrees to keep confidential any proprietary or sensitive information disclosed by the other party during the term "
        "of this Agreement and for two (2) years thereafter, and to use such information solely for the purposes of this Agreement.",
    )

    clause(
        "8.  LIMITATION OF LIABILITY",
        "ClarifiEd's aggregate liability under or in connection with this Agreement shall not exceed the total fees actually paid "
        "by the School in the twelve (12) months preceding the claim. Neither party shall be liable for indirect, incidental, "
        "special, or consequential damages.",
    )

    clause(
        "9.  TERM & TERMINATION",
        f'This Agreement is effective from the Effective Date and remains in force through the end of Academic Year {academic_year}, '
        f'unless terminated earlier by mutual written consent.',
        "Either party may terminate this Agreement with thirty (30) days' written notice if the other party commits a material "
        "breach and fails to remedy it within that notice period.",
        "On termination, the School shall pay all amounts outstanding for HPCs already delivered.",
    )

    clause(
        "10. GOVERNING LAW & DISPUTES",
        "This Agreement is governed by the laws of India. The parties shall first seek resolution through good-faith negotiations. "
        "If unresolved within thirty (30) days, disputes shall be referred to arbitration in Mumbai under the Arbitration and "
        "Conciliation Act, 1996.",
    )

    clause(
        "11. ENTIRE AGREEMENT",
        "This document constitutes the entire agreement between the parties with respect to its subject matter and supersedes all "
        "prior negotiations, representations, warranties, or agreements relating thereto. Amendments must be in writing and signed "
        "by both parties.",
    )

    # ── Signature block ───────────────────────────────────────────────────────
    story.append(Spacer(1, 22))
    story.append(HRFlowable(width=BODY_W, thickness=0.5, color=LGREY))
    story.append(Spacer(1, 12))
    story.append(Paragraph(
        "IN WITNESS WHEREOF the parties have executed this Agreement as of the Effective Date.",
        BODY,
    ))
    story.append(Spacer(1, 18))

    sig_line = "________________________________"
    sig_data = [
        [
            Paragraph("For <b>ClarifiEd</b>", BODY),
            Paragraph(f"For <b>{school_name}</b>", BODY),
        ],
        [Spacer(1, 32), Spacer(1, 32)],
        [Paragraph(sig_line, BODY_SMALL), Paragraph(sig_line, BODY_SMALL)],
        [
            Paragraph("Authorised Signatory, ClarifiEd", SIG_NAME),
            Paragraph(f'{signatory}' + (f', {designation}' if designation else ''), SIG_NAME),
        ],
        [
            Paragraph("Date: _______________", BODY_SMALL),
            Paragraph("Date: _______________", BODY_SMALL),
        ],
    ]
    sig_table = Table(sig_data, colWidths=[BODY_W * 0.48, BODY_W * 0.48])
    sig_table.setStyle(TableStyle([
        ("TOPPADDING",    (0,0), (-1,-1), 2),
        ("BOTTOMPADDING", (0,0), (-1,-1), 2),
        ("LEFTPADDING",   (0,0), (-1,-1), 0),
        ("RIGHTPADDING",  (0,0), (-1,-1), 0),
    ]))
    story.append(sig_table)

    # ── Footer on every page ──────────────────────────────────────────────────
    def _footer(canvas_obj, doc_obj):
        canvas_obj.saveState()
        canvas_obj.setFont("Helvetica", 7)
        canvas_obj.setFillColor(GREY)
        canvas_obj.drawString(
            L_MARGIN, 1.4*cm,
            f"ClarifiEd Service Agreement  |  Ref: {agr_num}  |  Academic Year {academic_year}",
        )
        canvas_obj.drawRightString(
            PAGE_W - R_MARGIN, 1.4*cm,
            f"Page {doc_obj.page}",
        )
        canvas_obj.restoreState()

    doc.build(story, onFirstPage=_footer, onLaterPages=_footer)
    buf.seek(0)
    return buf.read()


# ── HTTP handler ───────────────────────────────────────────────────────────────

@functions_framework.http
def generate_agreement(request: Request):
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
    if not data.get("feePerStudent"):
        return Response("Missing feePerStudent", 400, headers=CORS)
    if not data.get("studentCount"):
        return Response("Missing studentCount", 400, headers=CORS)

    try:
        pdf_bytes = _build_pdf(data)
    except Exception as e:
        return Response(
            json.dumps({"error": str(e)}), 500,
            mimetype="application/json",
            headers=CORS,
        )

    safe = "".join(ch for ch in school_name if ch not in '\\/:*?"<>|')
    agr_num = (data.get("agreementNumber") or "").strip()
    return Response(
        pdf_bytes, 200,
        mimetype="application/pdf",
        headers={
            **CORS,
            "Content-Disposition": f'inline; filename="Agreement_{safe}_{agr_num}.pdf"',
        },
    )
