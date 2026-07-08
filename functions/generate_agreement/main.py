"""
Scratchpad Labs Agreement Generator - Cloud Function (ReportLab)
Generates the HPC service agreement PDF entirely in Python; no LibreOffice or Word dependency.
Returns PDF blob directly (same pattern as generate_invoice / generate_quotation).

Deploy:
  gcloud functions deploy generate_agreement \
    --gen2 --runtime python312 --region asia-south1 \
    --source functions/generate_agreement --entry-point generate_agreement \
    --trigger-http --allow-unauthenticated \
    --memory 256MB --max-instances 3 --project clarified-1501

Folder needs: main.py, requirements.txt (no extra assets required)
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
    HRFlowable, Image as RLImage, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle,
)

API_KEY = "9421060748"

COMPANY_NAME = "Scratchpad Labs Pvt Ltd"

LOGO_PATH = os.path.join(os.path.dirname(__file__), "logo.png")

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
    now = datetime.today()
    return f"{now.day} {now.strftime('%B %Y')}"


def _load_logo(height=None, width=None):
    """Crop the transparent padding off logo.png and return a right-sized Image flowable.

    Pass exactly one of height/width (in points); the other is derived from the
    logo's aspect ratio.
    """
    im = PILImage.open(LOGO_PATH).convert("RGBA")
    bbox = im.getbbox()
    if bbox:
        im = im.crop(bbox)
    w, h = im.size
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    buf.seek(0)
    if height is not None:
        target_h = height
        target_w = target_h * w / h
    else:
        target_w = width
        target_h = target_w * h / w
    return RLImage(buf, width=target_w, height=target_h)


def _inr(n):
    """Indian-style digit grouping, e.g. 1234567 -> 12,34,567."""
    n = int(round(n))
    s = str(abs(n))
    if len(s) <= 3:
        grouped = s
    else:
        last3 = s[-3:]
        rest = s[:-3]
        parts = []
        while len(rest) > 2:
            parts.insert(0, rest[-2:])
            rest = rest[:-2]
        if rest:
            parts.insert(0, rest)
        grouped = ",".join(parts) + "," + last3
    return f"-{grouped}" if n < 0 else grouped


def _instalment_rows(plan):
    """(label, percentage) pairs matching the installment plan."""
    if plan == "B":
        return [
            ("Onboarding", 25),
            ("after Term 1 delivery", 25),
            ("after Term 2 delivery", 25),
            ("after final delivery", 25),
        ]
    return [
        ("Onboarding", 50),
        ("after Term 1 delivery", 25),
        ("after final delivery", 25),
    ]


def _payment_terms(plan):
    """Percentage-only payment schedule description matching the installment plan."""
    rows = _instalment_rows(plan)
    parts = [f"{label} ({pct}%)" for label, pct in rows]
    if len(parts) > 1:
        return ", ".join(parts[:-1]) + ", and " + parts[-1]
    return parts[0]


def _instalment_breakdown(total, plan):
    """Rupee-figure instalment breakdown matching the installment plan."""
    rows = _instalment_rows(plan)
    parts = [f"Rs. {_inr(total * pct / 100)}/- - {label} ({pct}%)" for label, pct in rows]
    return ", ".join(parts)


def _instalment_table(total, plan):
    """Bordered instalment breakdown table matching the installment plan."""
    rows = _instalment_rows(plan)
    data = [["Instalment", "%", "Amount"]]
    for label, pct in rows:
        amt = total * pct / 100
        data.append([label[0].upper() + label[1:], f"{pct}%", f"Rs. {_inr(amt)}/-"])
    t = Table(data, colWidths=[BODY_W * 0.5, BODY_W * 0.15, BODY_W * 0.35])
    t.setStyle(TableStyle([
        ("BACKGROUND",     (0, 0), (-1, 0), NAVY),
        ("TEXTCOLOR",      (0, 0), (-1, 0), WHITE),
        ("FONTNAME",       (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE",       (0, 0), (-1, -1), 8.3),
        ("GRID",           (0, 0), (-1, -1), 0.5, LGREY),
        ("VALIGN",         (0, 0), (-1, -1), "MIDDLE"),
        ("ALIGN",          (1, 0), (-1, -1), "CENTER"),
        ("TOPPADDING",     (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING",  (0, 0), (-1, -1), 5),
        ("LEFTPADDING",    (0, 0), (-1, -1), 8),
        ("RIGHTPADDING",   (0, 0), (-1, -1), 8),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [WHITE, SLATE]),
    ]))
    return t


# ── PDF builder ────────────────────────────────────────────────────────────────

def _build_pdf(data):
    school_name   = data["schoolName"]
    school_addr   = (data.get("schoolAddress") or "").strip() or "-"
    hpc_type      = (data.get("hpcType") or "printed and digital").strip()
    fee           = int(data["feePerStudent"])
    student_count = int(data["studentCount"])
    plan          = (data.get("installmentPlan") or "A").strip()
    agr_num       = (data.get("agreementNumber") or "").strip()

    academic_year = _academic_year()
    today         = _today_str()
    payment_terms = _payment_terms(plan)
    total_amount  = fee * student_count
    instalment_breakdown = _instalment_breakdown(total_amount, plan)

    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4,
        leftMargin=L_MARGIN, rightMargin=R_MARGIN,
        topMargin=2.6*cm, bottomMargin=2.4*cm,
    )

    story = []

    # ── Header band ───────────────────────────────────────────────────────────
    logo_cell = _load_logo(height=32)

    header = Table(
        [[
            logo_cell,
            Paragraph(
                '<font size="9" color="white"><b>AGREEMENT FOR THE PROVISION OF '
                'HOLISTIC PROGRESS CARD SERVICES</b></font>',
                _make_style("hr", size=9, leading=11, color=WHITE, align=2)),
        ]],
        colWidths=[BODY_W * 0.32, BODY_W * 0.68],
    )
    header.setStyle(TableStyle([
        ("BACKGROUND",    (0,0), (-1,-1), NAVY),
        ("BACKGROUND",    (0,0), (0,0),   WHITE),
        ("TOPPADDING",    (0,0), (-1,-1), 20),
        ("BOTTOMPADDING", (0,0), (-1,-1), 20),
        ("LEFTPADDING",   (0,0), (0,-1),  10),
        ("RIGHTPADDING",  (0,0), (0,-1),  14),
        ("LEFTPADDING",   (1,0), (1,-1),  4),
        ("RIGHTPADDING",  (1,0), (1,-1),  10),
        ("VALIGN",        (0,0), (-1,-1), "MIDDLE"),
    ]))
    story.append(header)
    story.append(Spacer(1, 12))

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
    parties = Table(
        [[
            Paragraph(
                'Scratchpad Labs Pvt Ltd, a company incorporated under the Companies Act, 2013 '
                'and having its principal place of business at SCEI, Sus, Pune - 411021, and '
                'registered office at Karmanghat, Saroornagar, Hyderabad, Telangana - 500079, '
                'bearing UDYAM Registration Number UDYAM-TS-09-0017913 '
                '(hereinafter referred to as the &quot;Company,&quot; which expression shall, unless '
                'repugnant to the context or meaning thereof, include its successors and assigns);',
                BODY,
            ),
        ], [
            Paragraph(
                'And',
                _make_style("and", font="Helvetica-Bold", size=8, color=GREY, align=1, space_before=4, space_after=4),
            ),
        ], [
            Paragraph(
                f'{school_name}, an educational institution located at {school_addr} and represented '
                f'herein by its authorised signatory (hereinafter referred to as the &quot;School,&quot; '
                f'which expression shall, unless repugnant to the context or meaning thereof, include '
                f'its successors and permitted assigns).',
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
        'The Company and the School shall collectively be referred to as the &quot;Parties&quot; '
        'and individually as a &quot;Party.&quot;',
        BODY_SMALL,
    ))
    story.append(Spacer(1, 4))

    story.append(Paragraph(
        'WHEREAS: The Company is engaged in the business of developing and delivering customised '
        'academic progress reporting systems, including Holistic Progress Cards (HPC);', BODY,
    ))
    story.append(Paragraph(
        'AND WHEREAS: The School is desirous of availing the services of the Company in relation '
        'to the development and provision of Holistic Progress Cards for its students;', BODY,
    ))
    story.append(Paragraph(
        'NOW, THEREFORE, in consideration of the mutual promises and covenants contained herein, '
        'the Parties agree as follows:', BODY,
    ))
    story.append(Spacer(1, 4))

    # ── Clauses ───────────────────────────────────────────────────────────────
    def clause(title, *paras, style=SUBCLAUSE):
        story.append(Paragraph(title, CLAUSE_HEAD))
        for p in paras:
            story.append(Paragraph(p, style))

    clause(
        "1.  DEFINITIONS",
        '1.1 <b>Holistic Progress Card (HPC):</b> A comprehensive report developed by the Company '
        'incorporating academic scores, social-emotional wellbeing (SEW), &quot;All About Me&quot; '
        'videos, academic rubric surveys, QR-linked digital reports, and other relevant elements '
        'as per NEP.',
        '1.2 <b>Supporting Data:</b> All academic and non-academic inputs, materials, or data '
        'supplied by the School for the purpose of generating the HPC.',
        '1.3 <b>Effective Date:</b> The date of execution of this Agreement by both Parties.',
    )

    clause(
        "2.  SCOPE OF SERVICES",
        f'2.1 <b>Service Delivery:</b> Subject to timely receipt of accurate and complete '
        f'Supporting Data from the School, the Company shall generate and deliver the {hpc_type} '
        f'HPC within the mutually agreed timeline, typically six (6) working days from receipt '
        f'of complete Supporting Data. The Company shall customize the HPCs to align with the '
        f'specific requirements of the School and shall proactively notify the School of any '
        f'updates or changes.',
        '2.2 <b>Deliverables:</b> One HPC per student as per the selected package. Standard '
        'package includes: &quot;All About Me&quot; videos, SEW reports, academic rubrics, '
        'QR-linked digital access.',
        '2.3 <b>Sample Approval:</b> Prior to mass printing, a sample copy shall be submitted to '
        'the School\'s Principal for written approval via email. No mass printing shall be '
        'initiated without such written approval.',
    )

    story.append(Paragraph("3.  COMMERCIAL TERMS", CLAUSE_HEAD))
    story.append(Paragraph(
        f'3.1 <b>Consideration &amp; Payment Terms:</b> The fee per student will be Rs. {_inr(fee)}/- '
        f'(including all taxes). The School shall pay the Company the agreed consideration, with '
        f'the following payment schedule: {payment_terms}. All payments shall be due and payable '
        f'within forty-five (45) working days of invoice and shall be non-refundable unless '
        f'otherwise agreed. Total contract value based on {student_count} students: '
        f'Rs. {_inr(total_amount)}/-. Instalment breakdown: {instalment_breakdown}. '
        f'Please note that the total contract value stated above is based on {student_count} '
        f'students as indicated at the time of signing. The actual payable amount may vary '
        f'proportionally if the student count increases or decreases during the academic year, '
        f'and shall be invoiced accordingly at the agreed per-student rate of Rs. {_inr(fee)}/-.',
        SUBCLAUSE,
    ))
    story.append(Spacer(1, 4))
    story.append(_instalment_table(total_amount, plan))
    story.append(Spacer(1, 8))
    story.append(Paragraph(
        '3.2 <b>Late or Non-Payment:</b> Failure to make timely payments shall entitle the Company '
        'to suspend services without further notice. As a registered MSME under Udyam, the '
        'Company is entitled to enforce a payment deadline of forty-five (45) days from the date '
        'of invoice in accordance with Section 15 of the MSMED Act, 2006. Any payment not made '
        'within this timeline shall attract compound interest at three times the bank rate '
        'notified by the Reserve Bank of India, as stipulated under Section 16 of the MSMED Act.',
        SUBCLAUSE,
    ))
    story.append(Paragraph(
        '3.3 <b>New Admissions:</b> Students added post-contract shall be invoiced separately '
        'based on the agreed per-student rate.',
        SUBCLAUSE,
    ))

    clause(
        "4.  DATA RESPONSIBILITIES",
        '4.1 The School warrants that all data provided shall be true, complete, and duly '
        'verified by its internal team.',
        '4.2 The Company shall not be liable for errors or delays resulting from incorrect, '
        'incomplete, or inconsistent data supplied by the School.',
    )

    clause(
        "5.  REPRINT & CORRECTION POLICY",
        '5.1 If errors are made by the Company (such as a mistake in formatting, layout, or data '
        'processing, provided the data submitted was correct), the Company shall bear full '
        'responsibility and reprint affected cards at no additional cost to the School.',
        '5.2 The Company shall notify the School within forty-eight (48) hours of identifying '
        'any error in the delivered HPCs, regardless of which Party is responsible.',
        '5.3 If errors in the printed report are due to incorrect, incomplete, or delayed data '
        'submissions by the School, or changes requested after final sample approval, the School '
        'shall be responsible for the cost of reprinting. Such reprints shall be charged at the '
        'rate of Rs. 100 per copy minimum.',
        '5.4 All correction requests must be submitted in writing within thirty (30) calendar '
        'days from the date of delivery of the HPCs.',
    )

    clause(
        "6.  POST-DELIVERY SUPPORT",
        '6.1 The Company shall offer full technical support for QR access, downloading, and basic '
        'troubleshooting through a dedicated helpline and Relationship Manager for thirty (30) '
        'days post-delivery.',
        '6.2 In the event of renewal, such support shall be automatically extended to cover the '
        'academic year.',
        '6.3 No structural modifications to the HPC shall be permitted post-printing; only '
        'factual data corrections may be considered within the specified support period.',
    )

    clause(
        "7.  INTELLECTUAL PROPERTY & NON-COMPETE",
        '7.1 The Company retains exclusive intellectual property rights in all proprietary '
        'tools, formats, designs, methodologies, and systems under applicable provisions of the '
        'Copyright Act, 1957.',
        '7.2 The School shall not replicate, reverse-engineer, adapt, disclose, or share the '
        'Company\'s formats, designs, or systems with any third party, including any LMS or ERP '
        'platform.',
        '7.3 The Company has filed patents protecting multiple components of its system. Any '
        'unauthorised commercial use, adaptation, or duplication without prior written consent '
        'shall be deemed infringement and subject to legal recourse including injunctive relief '
        'and damages.',
    )

    clause(
        "8.  CONFIDENTIALITY & DATA SECURITY",
        '8.1 Each Party shall maintain the confidentiality of all proprietary or student-related '
        'information obtained under this Agreement and shall not disclose such information to '
        'third parties without written consent.',
        '8.2 The student data and parent data are strictly confidential and shall remain the sole '
        'property of the School. Under no circumstances shall any student or parent data be used '
        'for commercial purposes.',
        '8.3 The Company shall employ industry-standard safeguards and comply with the '
        'Information Technology Act, 2000 in protecting School-provided data.',
        '8.4 All digital materials, including HPCs and associated files, shall be stored on the '
        'Company\'s secure cloud platform. The soft copies of the HPCs shall be accessible to the '
        'School and parents for a lifetime.',
        '8.5 The Company shall retain digital copies for the duration of the Agreement and its '
        'renewals.',
        '8.6 Upon termination or non-renewal, digital ownership shall irrevocably transfer to the '
        'School.',
        '8.7 The Company may, upon written request and agreed facility fees, retain such data on '
        'its cloud and application storage post-termination.',
    )

    clause(
        "9.  TERM, TERMINATION & EFFECT",
        f'9.1 This Agreement shall be valid and effective for the Academic Year {academic_year}.',
        '9.2 Either Party may terminate this Agreement by providing thirty (30) days\' written '
        'notice.',
        '9.3 Termination shall not affect accrued rights and obligations. Clauses relating to '
        'confidentiality, IP, data handling, and dispute resolution shall survive termination.',
    )

    clause(
        "10. PUBLICITY",
        '10.1 The School authorises the Company to use its name and logo in marketing materials, '
        'social media, and case studies solely for showcasing HPC implementation success. '
        'Similarly, the school may also use the Company\'s logo if required.',
        '10.2 The Company shall not publish any student-specific or academic content without '
        'prior written approval.',
    )

    clause(
        "11. LEGAL & DISPUTE RESOLUTION",
        '11.1 This Agreement shall be governed and construed in accordance with the laws of '
        'India.',
        '11.2 Subject to Clause 11.3, the Parties agree to submit to the exclusive jurisdiction '
        'of competent courts in Pune, Maharashtra or such other mutually agreed forum.',
        '11.3 Any dispute, controversy, or claim arising out of or in connection with this '
        'Agreement, which cannot be resolved amicably within thirty (30) days of written notice '
        'by either Party, shall be referred to and finally resolved by arbitration in accordance '
        'with the Arbitration and Conciliation Act, 1996. The arbitration shall be conducted by a '
        'sole arbitrator mutually appointed by the Parties. The seat and venue of arbitration '
        'shall be Pune, Maharashtra. The language of arbitration shall be English. The arbitral '
        'award shall be final and binding on both Parties.',
    )

    clause(
        "12. MISCELLANEOUS",
        '12.1 <b>Force Majeure:</b> Neither Party shall be liable for delays or non-performance '
        'arising from causes beyond reasonable control.',
        '12.2 <b>Entire Agreement:</b> This Agreement constitutes the entire agreement between '
        'the Parties and supersedes all prior oral and written discussions.',
        '12.3 <b>Amendment:</b> No modification shall be effective unless in writing and signed '
        'by authorised representatives of both Parties.',
        '12.4 <b>No Waiver:</b> No delay or failure to exercise any right under this Agreement '
        'shall constitute a waiver thereof.',
        '12.5 <b>Notices:</b> All formal notices shall be sent via registered post or electronic '
        'mail to the addresses first stated herein.',
        '12.6 <b>Severability:</b> If any provision is held invalid, the remainder of the '
        'Agreement shall continue in full force.',
        '12.7 <b>Binding Effect:</b> This Agreement shall be binding upon and inure to the '
        'benefit of the Parties and their respective successors and assigns.',
        '12.8 <b>Attribution:</b> The Holistic Progress Card (HPC) used under this Agreement is '
        'an adapted version of the HPC developed by PARAKH, NCERT. All copyrights, trademarks, '
        'and other intellectual property rights remain the sole property of the respective '
        'original owners.',
    )

    # ── Signature block ───────────────────────────────────────────────────────
    story.append(Spacer(1, 18))
    story.append(HRFlowable(width=BODY_W, thickness=0.5, color=LGREY))
    story.append(Spacer(1, 12))
    story.append(Paragraph(
        "By signing below, the Parties agree to be bound by the terms and conditions set forth "
        "in this Agreement.",
        BODY,
    ))
    story.append(Spacer(1, 18))

    def _sig_box(label):
        return [
            Paragraph(f'{label} :', SIG_NAME),
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

    # ── Closing logo (bottom of last page) ────────────────────────────────────
    story.append(Spacer(1, 24))
    closing_logo = _load_logo(width=80)
    closing_logo.hAlign = 'CENTER'
    story.append(closing_logo)
    story.append(Spacer(1, 4))
    story.append(Paragraph(
        'ClarifiEd by Scratchpad Labs Pvt Ltd',
        _make_style("closing_caption", size=7.5, color=GREY, align=1, space_after=0),
    ))

    # ── Footer on every page ──────────────────────────────────────────────────
    def _footer(canvas_obj, doc_obj):
        canvas_obj.saveState()
        canvas_obj.setFont("Helvetica", 7)
        canvas_obj.setFillColor(GREY)
        canvas_obj.drawString(
            L_MARGIN, 1.4*cm,
            f"{COMPANY_NAME}, HPC Service Agreement, Ref: {agr_num}, Academic Year {academic_year}",
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
