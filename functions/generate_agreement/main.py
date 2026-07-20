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
    ay_start      = academic_year[:4]
    ay_end        = str(int(ay_start) + 1)
    today         = _today_str()
    payment_terms = _payment_terms(plan)
    total_amount  = fee * student_count

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
        'supplied by the School for the purpose of generating the HPC, including without '
        'limitation student names and spellings, marks and grades, attendance records, '
        'photographs, videos, rubric responses, and teacher remarks.',
        '1.3 <b>Effective Date:</b> The date of execution of this Agreement by both Parties.',
        f'1.4 <b>Academic Year:</b> The academic year {academic_year} as followed by the School, '
        f'commencing June {ay_start} and concluding April {ay_end}, unless otherwise notified in '
        f'writing.',
        '1.5 <b>Deliverables:</b> The printed and digital HPCs and associated components forming '
        'part of the package selected by the School under Clause 2.2.',
        '1.6 <b>Working Days:</b> Monday to Saturday, excluding public holidays notified in '
        'Maharashtra.',
        '1.7 <b>Final Approval:</b> The School Principal\'s written approval (including approval '
        'conveyed by email) of the sample HPC under Clause 2.3.',
        '1.8 <b>Material Breach:</b> A breach of a substantive obligation under this Agreement '
        'which is not remedied within fifteen (15) days of written notice specifying the breach.',
        '1.9 <b>Force Majeure Event:</b> Any event beyond the reasonable control of the affected '
        'Party, including acts of God, natural disasters, epidemics, governmental action, war, '
        'civil disturbance, utility or telecommunications failure, or failure of third-party '
        'cloud infrastructure providers.',
    )

    clause(
        "2.  SCOPE OF SERVICES",
        f'2.1 <b>Service Delivery:</b> Subject to timely receipt of accurate and complete '
        f'Supporting Data from the School, the Company shall generate and deliver the {hpc_type} '
        f'HPC within six (6) working days from receipt of complete and validated Supporting '
        f'Data, unless otherwise agreed in writing. The Company shall customise the HPCs to '
        f'align with the specific requirements of the School and shall notify the School of any '
        f'material updates or changes.',
        '2.2 <b>Deliverables:</b> One HPC per student as per the selected package. Standard '
        'package includes: &quot;All About Me&quot; videos, SEW reports, academic rubrics, and '
        'QR-linked digital access.',
        '2.3 <b>Sample Approval:</b> Prior to mass printing, a sample copy shall be submitted to '
        'the School\'s Principal for written approval via email. No mass printing shall be '
        'initiated without such written approval. The delivery timeline under Clause 2.1 shall '
        'stand paused from the date the sample is submitted until Final Approval is received, '
        'and all subsequent delivery dates shall extend accordingly.',
        '2.4 <b>Data Submission Timelines:</b> The School shall submit Supporting Data in '
        'accordance with the data submission schedule mutually agreed at onboarding. Where the '
        'School delays submission of Supporting Data, approvals, or payments, all delivery '
        'timelines under this Agreement shall automatically extend by at least the period of '
        'such delay, without liability to the Company.',
        '2.5 <b>Acceptance:</b> Deliverables shall be deemed accepted if no written objections '
        'are received by the Company within seven (7) working days of delivery. This does not '
        'affect the Company\'s reprint obligations under Clause 5.1 for errors attributable to '
        'the Company.',
        '2.6 <b>Change Requests and Revisions:</b> One revision cycle per term is included prior '
        'to Final Approval. Changes requested after Final Approval, structural or design '
        'changes, additional report formats, or new features are outside the included scope and '
        'shall be chargeable at rates mutually agreed in writing before the work is undertaken.',
    )

    story.append(Paragraph("3.  COMMERCIAL TERMS", CLAUSE_HEAD))
    story.append(Paragraph(
        f'3.1 <b>Consideration &amp; Payment Terms:</b> The fee per student will be Rs. {_inr(fee)}/- '
        f'(inclusive of taxes at rates prevailing on the Effective Date; any subsequent change '
        f'in applicable tax rates shall be to the School\'s account). The School shall pay the '
        f'Company the agreed consideration, with the following payment schedule: {payment_terms}. '
        f'All payments shall be due and payable within forty-five (45) days of invoice and shall '
        f'be non-refundable unless otherwise agreed. Total contract value based on '
        f'{student_count} students: Rs. {_inr(total_amount)}/-.',
        SUBCLAUSE,
    ))
    story.append(Spacer(1, 4))
    story.append(_instalment_table(total_amount, plan))
    story.append(Spacer(1, 8))
    story.append(Paragraph(
        f'3.2 <b>Student Count Adjustment:</b> The total contract value stated above is based on '
        f'{student_count} students as indicated at the time of signing. The actual payable '
        f'amount shall vary proportionally at the agreed per-student rate of Rs. {_inr(fee)}/-. '
        f'The student count shall be reconciled prior to each term\'s delivery, and any students '
        f'added shall be invoiced with the immediately following instalment.',
        SUBCLAUSE,
    ))
    story.append(Paragraph(
        '3.3 <b>Late or Non-Payment:</b> Failure to make timely payments shall entitle the Company '
        'to suspend services without further notice, and the Company shall not be liable for any '
        'delay in Deliverables caused by such suspension or by the School\'s payment default. As '
        'a registered MSME under Udyam, the Company is entitled to enforce a payment deadline of '
        'forty-five (45) days from the date of invoice in accordance with Section 15 of the '
        'MSMED Act, 2006. Any payment not made within this timeline shall attract compound '
        'interest at three times the bank rate notified by the Reserve Bank of India, as '
        'stipulated under Section 16 of the MSMED Act.',
        SUBCLAUSE,
    ))
    story.append(Paragraph(
        '3.4 <b>New Admissions:</b> Students added post-contract shall be invoiced separately '
        'based on the agreed per-student rate.',
        SUBCLAUSE,
    ))

    clause(
        "4.  DATA RESPONSIBILITIES",
        '4.1 The School warrants that all Supporting Data provided shall be true, complete, and '
        'duly verified by its internal team prior to submission, including the accuracy of '
        'student name spellings, marks, attendance, photographs, videos, and rubric responses.',
        '4.2 The Company shall be entitled to rely on Supporting Data as submitted and shall not '
        'be required to independently verify its accuracy or completeness.',
        '4.3 The Company shall not be liable for errors or delays resulting from incorrect, '
        'incomplete, or inconsistent data supplied by the School.',
        '4.4 The School warrants that it has obtained all consents and permissions required '
        'under applicable law for the collection and sharing of student and parent data '
        '(including photographs and videos) with the Company for the purposes of this Agreement.',
    )

    clause(
        "5.  REPRINT & CORRECTION POLICY",
        '5.1 If errors are made by the Company (such as a mistake in formatting, layout, or data '
        'processing, provided the data submitted was correct), the Company shall bear full '
        'responsibility and reprint affected cards at no additional cost to the School.',
        '5.2 Each Party shall notify the other promptly upon discovering any error in the '
        'delivered HPCs, regardless of which Party is responsible.',
        '5.3 If errors in the printed report are due to incorrect, incomplete, or delayed data '
        'submissions by the School, or changes requested after Final Approval, the School shall '
        'be responsible for the cost of reprinting. Such reprints shall be charged at the rate '
        'of Rs. 100 per copy minimum.',
        '5.4 The School shall inspect the delivered HPCs and submit all correction requests in '
        'writing within seven (7) working days from the date of delivery. Correction requests '
        'received thereafter may be accommodated at the Company\'s discretion and shall be '
        'chargeable.',
    )

    clause(
        "6.  POST-DELIVERY SUPPORT",
        '6.1 The Company shall provide technical support through a dedicated helpline and '
        'Relationship Manager for thirty (30) days post-delivery. Included support covers: QR '
        'access issues, password resets, download issues, and basic troubleshooting of digital '
        'access. Included support does not cover: redesigns, structural changes, new features, '
        'additional report formats, or data re-processing arising from revised Supporting Data, '
        'which shall be chargeable if undertaken.',
        '6.2 In the event of renewal, such support shall be automatically extended to cover the '
        'academic year.',
        '6.3 No structural modifications to the HPC shall be permitted post-printing; only '
        'factual data corrections may be considered within the specified support period.',
    )

    clause(
        "7.  INTELLECTUAL PROPERTY",
        '7.1 The Company retains exclusive intellectual property rights in all proprietary '
        'tools, formats, designs, methodologies, software, and systems under applicable '
        'provisions of the Copyright Act, 1957. Nothing in this Agreement transfers ownership '
        'of any such intellectual property to the School.',
        '7.2 The School shall not replicate, reverse-engineer, adapt, or commercially exploit '
        'the Company\'s formats, designs, or systems, and shall not disclose them to any third '
        'party, except to the School\'s authorised service providers (including LMS or ERP '
        'vendors) solely to the extent necessary for integration, subject to confidentiality '
        'obligations no less protective than those in this Agreement.',
        '7.3 The Company has filed patent applications in respect of components of its system. '
        'Any unauthorised commercial use, adaptation, or duplication of the Company\'s '
        'proprietary materials without prior written consent shall be deemed infringement and '
        'subject to legal recourse including injunctive relief and damages.',
    )

    clause(
        "8.  CONFIDENTIALITY & DATA SECURITY",
        '8.1 Each Party shall maintain the confidentiality of all proprietary or student-related '
        'information obtained under this Agreement and shall not disclose such information to '
        'third parties without written consent, except as required by law.',
        '8.2 Student data and parent data are strictly confidential and shall remain the sole '
        'property of the School. Under no circumstances shall any student or parent data be '
        'used by the Company for commercial purposes unrelated to the Services.',
        '8.3 The Company shall employ commercially reasonable, industry-standard safeguards and '
        'shall comply with applicable data protection laws in force in India, including the '
        'Information Technology Act, 2000 and the Digital Personal Data Protection Act, 2023, '
        'in protecting School-provided data.',
        '8.4 All digital materials, including HPCs and associated files, shall be stored on the '
        'Company\'s secure cloud platform. Digital HPCs shall remain accessible to the School '
        'and parents for a minimum period of five (5) years from the date of delivery, and '
        'thereafter for so long as the School maintains an active subscription or renewal with '
        'the Company.',
        '8.5 Upon termination or non-renewal, the Company shall, on written request, provide the '
        'School with copies of the student data and generated HPC files (in PDF or other '
        'standard format). All underlying software, templates, designs, and systems remain the '
        'exclusive property of the Company and are not transferred.',
        '8.6 The Company may, upon written request and payment of agreed facility fees, continue '
        'to host such data on its cloud and application storage post-termination.',
    )

    clause(
        "9.  WARRANTIES & DISCLAIMER",
        '9.1 The Company warrants that the Services shall be performed in a professional and '
        'workmanlike manner. Except as expressly stated in this Agreement, the Services and '
        'Deliverables are provided &quot;as is&quot; and the Company disclaims all other '
        'warranties, express or implied.',
        '9.2 The Company shall use commercially reasonable efforts to maintain availability of '
        'digital HPCs but does not guarantee uninterrupted or error-free access, including where '
        'interruptions arise from third-party cloud infrastructure providers. The Company '
        'maintains reasonable backup practices for hosted data.',
    )

    clause(
        "10. LIMITATION OF LIABILITY",
        '10.1 The total aggregate liability of the Company under or in connection with this '
        'Agreement, whether in contract, tort, or otherwise, shall not exceed the total fees '
        'actually paid by the School to the Company under this Agreement.',
        '10.2 Neither Party shall be liable to the other for any indirect, incidental, '
        'consequential, or special damages, or for loss of profits, reputation, or data, '
        'arising out of or in connection with this Agreement.',
        '10.3 Nothing in this Clause limits liability for fraud, wilful misconduct, or any '
        'liability that cannot be limited under applicable law.',
    )

    clause(
        "11. INDEMNITY",
        '11.1 The School shall indemnify and hold harmless the Company against all claims, '
        'losses, and expenses arising from: (a) third-party intellectual property claims in '
        'respect of content supplied by the School; (b) incorrect, incomplete, or unauthorised '
        'student or parent data supplied by the School; (c) claims by parents, students, or '
        'authorities arising from the School\'s failure to obtain required consents; and '
        '(d) the School\'s breach of applicable law.',
    )

    clause(
        "12. TERM, TERMINATION & EFFECT",
        f'12.1 <b>Term:</b> This Agreement shall be valid and effective for the Academic Year '
        f'{academic_year}.',
        '12.2 <b>Termination for Convenience:</b> Either Party may terminate this Agreement by '
        'providing thirty (30) days\' written notice. In the event of such termination by the '
        'School, the School shall pay the Company for all work completed and costs incurred up '
        'to the effective date of termination, including printing and processing already '
        'undertaken, and instalments already invoiced shall remain payable.',
        '12.3 <b>Termination for Breach:</b> Either Party may terminate this Agreement with '
        'immediate effect by written notice in the event of a Material Breach by the other '
        'Party, or if the other Party becomes insolvent or subject to insolvency proceedings.',
        '12.4 <b>Effect of Termination:</b> Termination shall not affect accrued rights and '
        'obligations, including the School\'s obligation to pay for Services rendered up to '
        'termination.',
        '12.5 <b>Survival:</b> Clauses relating to intellectual property (Clause 7), '
        'confidentiality and data security (Clause 8), limitation of liability (Clause 10), '
        'indemnity (Clause 11), payment obligations, and dispute resolution (Clause 14) shall '
        'survive termination or expiry of this Agreement.',
    )

    clause(
        "13. PUBLICITY",
        '13.1 The Company may, with the prior written consent of the School (which may be '
        'conveyed by email and shall not be unreasonably withheld), use the School\'s name and '
        'logo in marketing materials, social media, and case studies solely for showcasing HPC '
        'implementation. The School may likewise use the Company\'s name and logo to describe '
        'its use of the Services.',
        '13.2 The Company shall not publish any student-specific or academic content without '
        'prior written approval.',
    )

    clause(
        "14. LEGAL & DISPUTE RESOLUTION",
        '14.1 This Agreement shall be governed and construed in accordance with the laws of '
        'India.',
        '14.2 Any dispute, controversy, or claim arising out of or in connection with this '
        'Agreement, which cannot be resolved amicably within thirty (30) days of written notice '
        'by either Party, shall be referred to and finally resolved by arbitration in accordance '
        'with the Arbitration and Conciliation Act, 1996. The arbitration shall be conducted by a '
        'sole arbitrator mutually appointed by the Parties. The seat and venue of arbitration '
        'shall be Pune, Maharashtra. The language of arbitration shall be English. The arbitral '
        'award shall be final and binding on both Parties.',
        '14.3 The courts at Pune, Maharashtra shall have exclusive jurisdiction solely for '
        'interim or injunctive relief in aid of arbitration and for enforcement of the arbitral '
        'award.',
    )

    clause(
        "15. MISCELLANEOUS",
        '15.1 <b>Force Majeure:</b> Neither Party shall be liable for delays or non-performance '
        'arising from a Force Majeure Event, provided the affected Party notifies the other '
        'promptly and resumes performance as soon as reasonably practicable.',
        '15.2 <b>Relationship of Parties:</b> The Parties are independent contractors. Nothing '
        'in this Agreement creates any partnership, joint venture, agency, or employment '
        'relationship between the Parties.',
        '15.3 <b>Assignment:</b> Neither Party may assign this Agreement without the prior '
        'written consent of the other, except that the Company may assign it to a successor in '
        'interest of its business.',
        '15.4 <b>Entire Agreement:</b> This Agreement constitutes the entire agreement between '
        'the Parties and supersedes all prior oral and written discussions.',
        '15.5 <b>Amendment:</b> No modification shall be effective unless in writing and signed '
        'by authorised representatives of both Parties.',
        '15.6 <b>No Waiver:</b> No delay or failure to exercise any right under this Agreement '
        'shall constitute a waiver thereof.',
        '15.7 <b>Notices:</b> All formal notices shall be sent via registered post or electronic '
        'mail to the addresses first stated herein.',
        '15.8 <b>Electronic Execution:</b> This Agreement may be executed in counterparts and by '
        'electronic signature or scanned copies, each of which shall be deemed an original.',
        '15.9 <b>Severability:</b> If any provision is held invalid, the remainder of the '
        'Agreement shall continue in full force.',
        '15.10 <b>Binding Effect:</b> This Agreement shall be binding upon and inure to the '
        'benefit of the Parties and their respective successors and permitted assigns.',
        '15.11 <b>Attribution:</b> The Holistic Progress Card (HPC) used under this Agreement is '
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
