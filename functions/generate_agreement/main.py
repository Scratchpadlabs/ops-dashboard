"""
Scratchpad Labs Agreement Generator — Cloud Function (ReportLab)
Generates the HPC service agreement PDF entirely in Python; no LibreOffice or Word dependency.
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
from datetime import datetime

import functions_framework
from flask import Request, Response
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import cm
from reportlab.platypus import (
    HRFlowable, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle,
)

API_KEY = "9421060748"

COMPANY_NAME = "Scratchpad Labs Pvt Ltd"
COMPANY_BLOCK = (
    "Scratchpad Labs Pvt Ltd, a company incorporated under the Companies Act, 2013 and having its "
    "principal place of business at SCEI, Sus, Pune - 411021, and registered office at Karmanghat, "
    "Saroornagar, Hyderabad, Telangana - 500079"
)

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
CLAUSE_HEAD = _make_style("clause_head", font="Helvetica-Bold", size=9.5, color=NAVY,
                           space_before=11, space_after=3)
SUBCLAUSE   = _make_style("subclause",   size=8.7, leading=12.5, space_after=4)
SIG_NAME    = _make_style("sig_name",    font="Helvetica-Bold", size=9, space_after=2)


# ── Helpers ────────────────────────────────────────────────────────────────────

def _academic_year():
    today = datetime.today()
    start = today.year if today.month >= 4 else today.year - 1
    return f"{start}-{str(start + 1)[-2:]}"


def _today_str():
    return datetime.today().strftime("%-d %B %Y")


def _payment_terms(plan):
    """Human-readable instalment schedule matching the agreed installment plan."""
    if plan == "B":
        return "25% upon signing of this Agreement, 25% after Term 1, 25% after Term 2, and the final 25% after final delivery of the HPC"
    return "50% upon signing of this Agreement, 25% after Term 1 delivery, and the final 25% after final delivery of the HPC"


# ── PDF builder ────────────────────────────────────────────────────────────────

def _build_pdf(data):
    school_name = data["schoolName"]
    school_addr = (data.get("schoolAddress") or "").strip() or "—"
    hpc_type    = (data.get("hpcType") or "printed and digital").strip()
    fee         = int(data["feePerStudent"])
    plan        = (data.get("installmentPlan") or "A").strip()
    agr_num     = (data.get("agreementNumber") or "").strip()

    academic_year  = _academic_year()
    today          = _today_str()
    payment_terms  = _payment_terms(plan)

    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4,
        leftMargin=L_MARGIN, rightMargin=R_MARGIN,
        topMargin=2.6*cm, bottomMargin=2.4*cm,
    )

    story = []

    # ── Header band ───────────────────────────────────────────────────────────
    # No Scratchpad Labs logo asset is available yet, so use a text lockup
    # rather than the stale ClarifiEd logo.png shipped in this folder.
    logo_cell = Paragraph('<font size="15" color="white"><b>Scratchpad Labs</b></font>', BODY)

    header = Table(
        [[
            logo_cell,
            Paragraph(
                '<font size="9" color="white"><b>AGREEMENT FOR THE PROVISION OF HOLISTIC PROGRESS CARD (HPC) SERVICES</b></font>',
                _make_style("hr", size=9, leading=11, color=WHITE, align=2)),
        ]],
        colWidths=[BODY_W * 0.35, BODY_W * 0.65],
    )
    header.setStyle(TableStyle([
        ("BACKGROUND",    (0,0), (-1,-1), NAVY),
        ("TOPPADDING",    (0,0), (-1,-1), 14),
        ("BOTTOMPADDING", (0,0), (-1,-1), 14),
        ("LEFTPADDING",   (0,0), (0,-1),  18),
        ("RIGHTPADDING",  (-1,0),(-1,-1), 18),
        ("VALIGN",        (0,0), (-1,-1), "MIDDLE"),
    ]))
    story.append(header)
    story.append(Spacer(1, 4))

    # Ref / date meta strip
    meta = Table(
        [[
            Paragraph(f'<font size="8" color="#64748b">Ref: <b>{agr_num}</b></font>', BODY_SMALL),
            Paragraph(f'<font size="8" color="#64748b">Date: <b>{today}</b></font>',
                      _make_style("mr", size=8, color=GREY, align=2)),
        ]],
        colWidths=[BODY_W * 0.5, BODY_W * 0.5],
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

    # ── Parties / preamble ────────────────────────────────────────────────────
    story.append(Paragraph(
        f'This Agreement ("<b>Agreement</b>") is entered into on <b>{today}</b> ("<b>Effective Date</b>") by and between:',
        BODY,
    ))
    story.append(Spacer(1, 6))

    parties = Table(
        [[
            Paragraph(
                f'<b>{COMPANY_BLOCK}</b> (hereinafter referred to as the "<b>Company</b>")',
                BODY,
            ),
        ], [
            Paragraph(
                f'AND',
                _make_style("and", font="Helvetica-Bold", size=8, color=GREY, align=1, space_before=4, space_after=4),
            ),
        ], [
            Paragraph(
                f'<b>{school_name}</b>, an educational institution located at {school_addr} and represented herein '
                f'by its authorised signatory (hereinafter referred to as the "<b>School</b>")',
                BODY,
            ),
        ]],
        colWidths=[BODY_W],
    )
    parties.setStyle(TableStyle([
        ("BOX",           (0,0), (0,0),  0.5, NAVY),
        ("BOX",           (0,2), (0,2),  0.5, NAVY),
        ("BACKGROUND",    (0,0), (0,0),  LIGHT),
        ("BACKGROUND",    (0,2), (0,2),  SLATE),
        ("TOPPADDING",    (0,0), (-1,-1), 9),
        ("BOTTOMPADDING", (0,0), (-1,-1), 9),
        ("LEFTPADDING",   (0,0), (-1,-1), 10),
        ("RIGHTPADDING",  (0,0), (-1,-1), 10),
    ]))
    story.append(parties)
    story.append(Spacer(1, 10))

    story.append(Paragraph(
        'The Company and the School are hereinafter individually referred to as a "<b>Party</b>" and collectively as the "<b>Parties</b>".',
        BODY_SMALL,
    ))
    story.append(Spacer(1, 4))

    story.append(Paragraph(
        f'<b>WHEREAS</b> the Company is engaged in the business of designing, producing and delivering Holistic Progress '
        f'Card (HPC) services to educational institutions, incorporating academic and non-academic assessments in line '
        f'with the National Education Policy (NEP) 2020;', BODY,
    ))
    story.append(Paragraph(
        f'<b>WHEREAS</b> the School desires to avail the HPC services offered by the Company for its students for the '
        f'Academic Year {academic_year}, and the Company has agreed to provide the same on the terms and conditions '
        f'set out in this Agreement;', BODY,
    ))
    story.append(Paragraph(
        '<b>NOW THEREFORE</b>, in consideration of the mutual covenants and agreements contained herein, and for other '
        'good and valuable consideration, the receipt and sufficiency of which is hereby acknowledged, the Parties '
        'agree as follows:', BODY,
    ))
    story.append(Spacer(1, 4))

    # ── Clauses ───────────────────────────────────────────────────────────────
    def clause(title, *paras, style=BODY):
        story.append(Paragraph(title, CLAUSE_HEAD))
        for p in paras:
            story.append(Paragraph(p, style))

    clause(
        "1.  DEFINITIONS",
        '1.1 <b>"HPC"</b> means a comprehensive report incorporating academic scores, Social Emotional Wellbeing '
        '(SEW) assessments, All About Me videos, rubric-based surveys, and QR-code linked digital reports, prepared '
        'in accordance with the National Education Policy (NEP) 2020.',
        '1.2 <b>"Supporting Data"</b> means all academic and non-academic inputs, information and data supplied by '
        'the School to the Company for the purpose of preparing the HPC.',
        '1.3 <b>"Effective Date"</b> means the date on which this Agreement is executed by both Parties.',
        style=SUBCLAUSE,
    )

    clause(
        "2.  SCOPE OF SERVICES",
        f'2.1 <b>Service Delivery:</b> The Company shall deliver the {hpc_type} HPC within six (6) working days, '
        f'shall customise the HPC to the School\'s specific requirements, and shall proactively notify the School '
        f'of any updates concerning delivery.',
        '2.2 <b>Deliverables:</b> The Company shall deliver one (1) HPC per student. The standard package includes '
        'All About Me videos, SEW reports, rubric-based assessments, and QR-code based access.',
        '2.3 <b>Sample Approval:</b> A sample HPC shall be submitted to the Principal of the School for written '
        'approval by email prior to commencement of mass printing. No mass printing shall commence without such '
        'written approval.',
        style=SUBCLAUSE,
    )

    clause(
        "3.  COMMERCIAL TERMS",
        f'3.1 The fee payable per student shall be Rs. {fee}/- (inclusive of all applicable taxes). Payment: '
        f'{payment_terms}. All payments shall be due and payable within forty-five (45) working days of the date '
        f'of the corresponding invoice and shall be non-refundable.',
        '3.2 In the event of late payment, the Company may suspend its services under this Agreement. The Company, '
        'being a registered Micro, Small and Medium Enterprise (MSME) under Udyam, the 45-day payment rule shall '
        'apply, and delayed payments shall attract compound interest at three (3) times the prevailing Reserve '
        'Bank of India (RBI) rate, as per Section 16 of the MSMED Act.',
        '3.3 New admissions occurring after the Effective Date shall be invoiced separately by the Company at the '
        'agreed rate.',
        style=SUBCLAUSE,
    )

    clause(
        "4.  DATA RESPONSIBILITIES",
        '4.1 The School warrants that all Supporting Data provided to the Company is true, complete, and duly '
        'verified.',
        '4.2 The Company shall not be liable for any errors arising from incorrect or incomplete Supporting Data '
        'furnished by the School.',
        style=SUBCLAUSE,
    )

    clause(
        "5.  REPRINT & CORRECTION POLICY",
        '5.1 Where an error is attributable to the Company despite receipt of correct Supporting Data, the Company '
        'shall reprint the affected HPC(s) at no cost to the School.',
        '5.3 Where an error arises due to School error, or where changes are requested after sample approval, '
        'reprints shall be charged at a minimum of Rs. 100/- per copy.',
        '5.4 All requests for correction must be submitted in writing within thirty (30) calendar days of delivery.',
        style=SUBCLAUSE,
    )

    clause(
        "6.  POST-DELIVERY SUPPORT",
        '6.1 The Company shall provide technical support for thirty (30) days post-delivery, through a dedicated '
        'helpline and Relationship Manager (RM).',
        '6.2 On renewal, such support shall automatically be extended for the Academic Year.',
        '6.3 No structural modifications shall be made to the HPC post-printing; only factual corrections shall be '
        'permitted within the support period.',
        style=SUBCLAUSE,
    )

    clause(
        "7.  INTELLECTUAL PROPERTY & NON-COMPETE",
        '7.1 The Company retains all intellectual property rights in the HPC under the Copyright Act, 1957.',
        '7.2 The School shall not replicate, reverse-engineer, adapt, disclose, or share the HPC with any Learning '
        'Management System (LMS), Enterprise Resource Planning (ERP) system, or any third party.',
        '7.3 The Company has filed patents in respect of its processes. Unauthorised use shall be subject to '
        'injunctive relief and damages.',
        style=SUBCLAUSE,
    )

    clause(
        "8.  CONFIDENTIALITY & DATA SECURITY",
        '8.1 Both Parties shall maintain confidentiality of proprietary and student-related information disclosed '
        'under this Agreement.',
        '8.2 Student and parent data shall be strictly confidential, shall remain the sole property of the School, '
        'and shall not be used for commercial purposes.',
        '8.3 The Company complies with the Information Technology Act, 2000.',
        '8.4 Digital materials shall be stored on a secure cloud, with copies provided to the School, and shall '
        'be made available for lifetime access to the School and parents.',
        '8.5 The Company shall retain digital copies for the duration of this Agreement and any renewals.',
        '8.6 On termination, digital ownership shall irrevocably transfer to the School.',
        '8.7 The Company may retain data post-termination upon the School\'s written request and agreed facility fees.',
        style=SUBCLAUSE,
    )

    clause(
        "9.  TERM, TERMINATION & EFFECT",
        f'9.1 This Agreement is valid for the Academic Year {academic_year}.',
        '9.2 Either Party may terminate this Agreement with thirty (30) days\' written notice.',
        '9.3 Termination shall not affect accrued rights. Confidentiality, IP, data, and dispute resolution clauses '
        'shall survive termination.',
        style=SUBCLAUSE,
    )

    clause(
        "10. PUBLICITY",
        '10.1 The School authorises the Company to use its name and logo in marketing materials and case studies '
        'for HPC success showcasing. The School may likewise use the Company\'s logo where required.',
        '10.2 The Company shall not publish student-specific or academic content without the School\'s prior '
        'written approval.',
        style=SUBCLAUSE,
    )

    clause(
        "11. LEGAL & DISPUTE RESOLUTION",
        '11.1 This Agreement is governed by the laws of India.',
        '11.2 The courts of competent jurisdiction at Pune, Maharashtra shall have exclusive jurisdiction.',
        '11.3 Disputes shall first be resolved amicably within thirty (30) days. Unresolved disputes shall be '
        'referred to arbitration under the Arbitration and Conciliation Act, 1996, before a sole arbitrator mutually '
        'appointed by the Parties. The seat and venue of arbitration shall be Pune, Maharashtra, and the language '
        'of arbitration shall be English. The award shall be final and binding on both Parties.',
        style=SUBCLAUSE,
    )

    clause(
        "12. MISCELLANEOUS",
        '12.1 <b>Force Majeure:</b> Neither Party shall be liable for delays arising from causes beyond its '
        'reasonable control.',
        '12.2 <b>Entire Agreement:</b> This Agreement supersedes all prior oral and written discussions.',
        '12.3 <b>Amendment:</b> Only in writing, signed by authorised representatives of both Parties.',
        '12.4 <b>No Waiver:</b> No delay or failure to exercise any right shall constitute a waiver.',
        '12.5 <b>Notices:</b> Via registered post or electronic mail to the addresses first stated herein.',
        '12.6 <b>Severability:</b> If any provision is held invalid, the remainder shall continue in full force.',
        '12.7 <b>Binding Effect:</b> Binding on the successors and assigns of both Parties.',
        '12.8 <b>Attribution:</b> The HPC is an adapted version developed by PARAKH, NCERT. All copyrights and IP '
        'rights remain with their respective original owners.',
        style=SUBCLAUSE,
    )

    # ── Signature block ───────────────────────────────────────────────────────
    story.append(Spacer(1, 18))
    story.append(HRFlowable(width=BODY_W, thickness=0.5, color=LGREY))
    story.append(Spacer(1, 12))
    story.append(Paragraph(
        "By signing below, the Parties agree to be bound by the terms and conditions set forth in this Agreement.",
        BODY,
    ))
    story.append(Spacer(1, 18))

    def _sig_box(label):
        return [
            Paragraph(f'<b>{label} :</b>', SIG_NAME),
            Spacer(1, 14),
            Paragraph('Name: ________________________________', BODY_SMALL),
            Spacer(1, 8),
            Paragraph('Designation: ___________________________', BODY_SMALL),
            Spacer(1, 8),
            Paragraph('Date: _________________________________', BODY_SMALL),
            Spacer(1, 8),
            Paragraph('Signature: ____________________________', BODY_SMALL),
        ]

    company_box = _sig_box(f"For {COMPANY_NAME}")
    school_box  = _sig_box(f"For {school_name}")

    sig_table = Table(
        [[company_box, school_box]],
        colWidths=[BODY_W * 0.48, BODY_W * 0.48],
    )
    sig_table.setStyle(TableStyle([
        ("VALIGN",        (0,0), (-1,-1), "TOP"),
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
            f"{COMPANY_NAME} — HPC Service Agreement  |  Ref: {agr_num}  |  Academic Year {academic_year}",
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
