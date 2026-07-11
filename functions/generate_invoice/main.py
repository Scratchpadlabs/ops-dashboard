"""
ClarifiEd Invoice Generator — Cloud Function (ReportLab rebuild)
Clean professional invoice matching all original elements.

Deploy:
  gcloud functions deploy generate_invoice \
    --gen2 --runtime python312 --region asia-south1 \
    --source . --entry-point generate_invoice \
    --trigger-http --allow-unauthenticated \
    --memory 256MB --max-instances 3 --project clarified-1501
"""

import io
import os
from datetime import datetime, timedelta

import functions_framework
from flask import Request, Response
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_LEFT, TA_RIGHT, TA_CENTER, TA_JUSTIFY
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    HRFlowable, Image
)
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

API_KEY = "9421060748"
_DIR    = os.path.dirname(os.path.abspath(__file__))

CORS_HEADERS = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Api-Key",
}

# ── Colors ────────────────────────────────────────────────────────────────────
BEIGE     = colors.HexColor("#f5f0dc")
DARK_BG   = colors.HexColor("#2d3446")
BLACK     = colors.HexColor("#0f0f0f")
GRAY      = colors.HexColor("#64748b")
WHITE     = colors.white
LGRAY     = colors.HexColor("#e2e8f0")

# ── Company constants ─────────────────────────────────────────────────────────
COMPANY = {
    "name":    "Scratchpad Labs Pvt Ltd",
    "addr1":   "Saroornagar, Hyderabad, Telangana, India - 500079.",
    "phone":   "+919421060748",
    "email":   "scratchpadlabs@gmail.com",
    "web":     "www.scratchpadlabs.com",
    "udyam":   "UDYAM Registration Number: UDYAM-TS-09-0017913",
}

BANK = {
    "Bank":           "HDFC Bank",
    "Account Name":   "SCRATCHPAD LABS PVT LTD",
    "Account Number": "50200055780209",
    "IFSC":           "HDFC0004111",
    "Branch":         "HASTINAPURAM, HYDERABAD, TELANGANA",
}

TERMS = [
    "All payments must be made to the account details provided.",
    "If there are any discrepancies, please contact us within 7 days of receiving this invoice.",
    "No refunds will be provided once the service has been delivered.",
    "As a registered MSME under Udyam, payment is expected within 45 days as per MSMED Act.",
]

# ── Fonts ─────────────────────────────────────────────────────────────────────
try:
    pdfmetrics.registerFont(TTFont("Mont", os.path.join(_DIR, "Montserrat-Regular.ttf")))
    pdfmetrics.registerFont(TTFont("Mont-Bold", os.path.join(_DIR, "Montserrat-Bold.ttf")))
    FONT      = "Mont"
    FONT_BOLD = "Mont-Bold"
except Exception:
    FONT      = "Helvetica"
    FONT_BOLD = "Helvetica-Bold"


def _format_inr(amount):
    s = str(int(amount))
    if len(s) <= 3:
        result = s
    else:
        result = s[-3:]
        s = s[:-3]
        while s:
            result = s[-2:] + "," + result
            s = s[:-2]
        result = result.lstrip(",")
    # Add decimals if needed
    if isinstance(amount, float) and amount != int(amount):
        dec = f"{amount:.2f}".split(".")[1]
        return result + "." + dec
    return result


def _style(name, **kwargs):
    defaults = dict(fontName=FONT, fontSize=9, leading=13, textColor=BLACK)
    defaults.update(kwargs)
    return ParagraphStyle(name, **defaults)


def _build_invoice(data: dict, out):
    school_name    = data.get("schoolName", "")
    school_address = data.get("schoolAddress", "")
    school_phone   = data.get("schoolPhone", "")
    invoice_number = data.get("invoiceNumber", "")
    description    = data.get("description", "")
    price          = float(data.get("pricePerStudent", 0))
    quantity       = int(data.get("quantity", 0))
    date_str       = data.get("date", datetime.today().strftime("%d/%m/%Y"))
    amount         = price * quantity

    W, H = A4
    M    = 14 * mm

    doc = SimpleDocTemplate(
        out, pagesize=A4,
        leftMargin=M, rightMargin=M,
        topMargin=0, bottomMargin=M,
    )

    story = []

    # ── HEADER (beige background) ─────────────────────────────────────────────
    logo_path = os.path.join(_DIR, "invoice_logo.png")

    # Logo + INVOICE text in a table with beige background
    try:
        # White logo on transparent bg — needs a dark chip behind it
        raw_logo = Image(logo_path, width=52*mm, height=9.6*mm)
        logo_img = Table([[raw_logo]], colWidths=[58*mm], rowHeights=[14*mm])
        logo_img.setStyle(TableStyle([
            ("BACKGROUND",   (0,0), (-1,-1), DARK_BG),
            ("ROUNDEDCORNERS", (0,0), (-1,-1), [5,5,5,5]),
            ("ALIGN",        (0,0), (-1,-1), "CENTER"),
            ("VALIGN",       (0,0), (-1,-1), "MIDDLE"),
        ]))
    except Exception:
        logo_img = Paragraph("ClarifiEd", _style("logo", fontName=FONT_BOLD, fontSize=14))

    invoice_title = Paragraph(
        "INVOICE",
        _style("inv_title", fontName=FONT_BOLD, fontSize=36, textColor=BLACK, alignment=TA_RIGHT)
    )

    # Company details
    co_lines = [
        Paragraph(f"<b>{COMPANY['name']}</b>", _style("co_name", fontName=FONT_BOLD, fontSize=9)),
        Paragraph(COMPANY["addr1"],  _style("co", fontSize=8, textColor=GRAY)),
        Paragraph(COMPANY["phone"],  _style("co", fontSize=8, textColor=GRAY)),
        Paragraph(COMPANY["email"],  _style("co", fontSize=8, textColor=GRAY)),
        Paragraph(COMPANY["web"],    _style("co", fontSize=8, textColor=GRAY)),
        Paragraph(COMPANY["udyam"],  _style("co", fontSize=8, textColor=GRAY)),
    ]

    left_col = [logo_img, Spacer(1, 3*mm)] + co_lines
    header_table = Table(
        [[left_col, invoice_title]],
        colWidths=[(W - 2*M) * 0.6, (W - 2*M) * 0.4]
    )
    header_table.setStyle(TableStyle([
        ("BACKGROUND", (0,0), (-1,-1), BEIGE),
        ("VALIGN",     (0,0), (0,0),  "TOP"),
        ("VALIGN",     (1,0), (1,0),  "MIDDLE"),
        ("LEFTPADDING",  (0,0), (-1,-1), 8),
        ("RIGHTPADDING", (0,0), (-1,-1), 8),
        ("TOPPADDING",   (0,0), (-1,-1), 8),
        ("BOTTOMPADDING",(0,0), (-1,-1), 8),
    ]))
    story.append(header_table)
    story.append(Spacer(1, 6*mm))

    # ── DATE ─────────────────────────────────────────────────────────────────
    story.append(Paragraph(
        f"<b>Date:</b> {date_str}",
        _style("date", fontSize=9, alignment=TA_RIGHT)
    ))
    story.append(Spacer(1, 3*mm))

    # ── BILLED TO ─────────────────────────────────────────────────────────────
    story.append(Paragraph(
        "Billed To:",
        _style("billed", fontName=FONT_BOLD, fontSize=18, textColor=BLACK)
    ))
    story.append(Spacer(1, 2*mm))

    # Address — wrap long addresses
    cw1 = 32*mm
    cw2 = (W - 2*M) - cw1

    bill_rows = [
        ["Customer Name", school_name],
        ["Address",       school_address],
        ["Phone",         school_phone],
        ["Invoice Number", invoice_number],
    ]

    bill_data = []
    for label, value in bill_rows:
        bill_data.append([
            Paragraph(label, _style("bl", fontSize=9, textColor=GRAY)),
            Paragraph(f":  {value}", _style("bv", fontSize=9, textColor=BLACK)),
        ])

    bill_table = Table(bill_data, colWidths=[cw1, cw2])
    bill_table.setStyle(TableStyle([
        ("VALIGN",       (0,0), (-1,-1), "TOP"),
        ("TOPPADDING",   (0,0), (-1,-1), 2),
        ("BOTTOMPADDING",(0,0), (-1,-1), 2),
        ("LEFTPADDING",  (0,0), (-1,-1), 0),
        ("RIGHTPADDING", (0,0), (-1,-1), 0),
    ]))
    story.append(bill_table)
    story.append(Spacer(1, 6*mm))

    # ── LINE ITEMS TABLE ──────────────────────────────────────────────────────
    col_w = [(W - 2*M) * x for x in [0.42, 0.18, 0.18, 0.22]]

    item_header = [
        Paragraph("<b>Description</b>", _style("th", fontName=FONT_BOLD, fontSize=9, textColor=WHITE)),
        Paragraph("<b>Price</b>",       _style("th", fontName=FONT_BOLD, fontSize=9, textColor=WHITE, alignment=TA_CENTER)),
        Paragraph("<b>Quantity</b>",    _style("th", fontName=FONT_BOLD, fontSize=9, textColor=WHITE, alignment=TA_CENTER)),
        Paragraph("<b>Amount</b>",      _style("th", fontName=FONT_BOLD, fontSize=9, textColor=WHITE, alignment=TA_RIGHT)),
    ]

    price_str  = f"Rs. {_format_inr(price)}"
    amount_str = f"Rs. {_format_inr(amount)}"

    item_row = [
        Paragraph(description, _style("td", fontSize=9)),
        Paragraph(price_str,   _style("td", fontSize=9, alignment=TA_CENTER)),
        Paragraph(str(quantity), _style("td", fontSize=9, alignment=TA_CENTER)),
        Paragraph(f"<b>{amount_str}</b>", _style("td", fontName=FONT_BOLD, fontSize=9, alignment=TA_RIGHT)),
    ]

    items_table = Table(
        [item_header, item_row],
        colWidths=col_w,
        rowHeights=[9*mm, 12*mm]
    )
    items_table.setStyle(TableStyle([
        # Header row
        ("BACKGROUND",   (0,0), (-1,0), BLACK),
        ("ROUNDEDCORNERS", (0,0), (-1,0), [4,4,0,0]),
        # Row
        ("BACKGROUND",   (0,1), (-1,1), WHITE),
        ("VALIGN",       (0,0), (-1,-1), "MIDDLE"),
        ("LEFTPADDING",  (0,0), (-1,-1), 6),
        ("RIGHTPADDING", (0,0), (-1,-1), 6),
        ("TOPPADDING",   (0,0), (-1,-1), 4),
        ("BOTTOMPADDING",(0,0), (-1,-1), 4),
    ]))
    story.append(items_table)

    # Divider line
    story.append(HRFlowable(
        width="100%", color=LGRAY, thickness=0.5,
        spaceBefore=2*mm, spaceAfter=3*mm
    ))

    # ── TOTAL BOX ─────────────────────────────────────────────────────────────
    total_table = Table(
        [[
            "",
            Paragraph(f"<b>Total &nbsp;&nbsp; {amount_str}</b>",
                      _style("total", fontName=FONT_BOLD, fontSize=10, alignment=TA_RIGHT))
        ]],
        colWidths=[(W-2*M)*0.55, (W-2*M)*0.45]
    )
    total_table.setStyle(TableStyle([
        ("BACKGROUND",   (1,0), (1,0), colors.HexColor("#f0f0f0")),
        ("BOX",          (1,0), (1,0), 0.5, LGRAY),
        ("ROUNDEDCORNERS", (1,0), (1,0), [4,4,4,4]),
        ("LEFTPADDING",  (0,0), (-1,-1), 6),
        ("RIGHTPADDING", (0,0), (-1,-1), 10),
        ("TOPPADDING",   (0,0), (-1,-1), 5),
        ("BOTTOMPADDING",(0,0), (-1,-1), 5),
        ("VALIGN",       (0,0), (-1,-1), "MIDDLE"),
    ]))
    story.append(total_table)
    story.append(Spacer(1, 8*mm))

    # ── PAYMENT DETAILS (dark section) ───────────────────────────────────────
    pay_header = Paragraph(
        "<b>Payment Detail:</b>",
        _style("pay_h", fontName=FONT_BOLD, fontSize=11, textColor=WHITE)
    )

    bank_rows = []
    for label, value in BANK.items():
        bank_rows.append([
            Paragraph(label, _style("bk_l", fontSize=8.5, textColor=colors.HexColor("#b4b9c8"))),
            Paragraph(f":  {value}", _style("bk_v", fontSize=8.5, textColor=WHITE)),
        ])

    pay_content = [[pay_header]] + [
        [Table(bank_rows, colWidths=[36*mm, (W-2*M)-36*mm-8*mm], style=TableStyle([
            ("VALIGN",       (0,0), (-1,-1), "TOP"),
            ("TOPPADDING",   (0,0), (-1,-1), 1.5),
            ("BOTTOMPADDING",(0,0), (-1,-1), 1.5),
            ("LEFTPADDING",  (0,0), (-1,-1), 0),
            ("RIGHTPADDING", (0,0), (-1,-1), 0),
        ]))]
    ]

    pay_table = Table(pay_content, colWidths=[W - 2*M])
    pay_table.setStyle(TableStyle([
        ("BACKGROUND",   (0,0), (-1,-1), DARK_BG),
        ("LEFTPADDING",  (0,0), (-1,-1), 10),
        ("RIGHTPADDING", (0,0), (-1,-1), 10),
        ("TOPPADDING",   (0,0), (-1,-1), 8),
        ("BOTTOMPADDING",(0,0), (-1,-1), 8),
    ]))
    story.append(pay_table)
    story.append(Spacer(1, 6*mm))

    # ── FOOTER: Terms + Thank you + Stamp ─────────────────────────────────────
    terms_items = [
        Paragraph("Terms & Conditions:", _style("tc_h", fontName=FONT_BOLD, fontSize=8.5)),
    ] + [
        Paragraph(f"• {t}", _style("tc", fontSize=8, textColor=GRAY, leading=12))
        for t in TERMS
    ]

    thank_you = [
        Paragraph(
            "<b>Thank you for your business!</b>",
            _style("ty", fontName=FONT_BOLD, fontSize=13, alignment=TA_RIGHT)
        ),
        Paragraph(
            "If you have any questions regarding this invoice, please contact us",
            _style("ty_sub", fontSize=7.5, textColor=GRAY, alignment=TA_RIGHT)
        ),
    ]

    # Stamp image
    stamp_path = os.path.join(_DIR, "invoice_stamp.png")
    try:
        stamp = Image(stamp_path, width=22*mm, height=22*mm)
    except Exception:
        stamp = Spacer(22*mm, 22*mm)

    right_col = thank_you + [Spacer(1, 2*mm), stamp]

    footer_table = Table(
        [[terms_items, right_col]],
        colWidths=[(W-2*M)*0.52, (W-2*M)*0.48]
    )
    footer_table.setStyle(TableStyle([
        ("VALIGN",       (0,0), (-1,-1), "TOP"),
        ("LEFTPADDING",  (0,0), (-1,-1), 0),
        ("RIGHTPADDING", (0,0), (-1,-1), 0),
        ("TOPPADDING",   (0,0), (-1,-1), 0),
        ("BOTTOMPADDING",(0,0), (-1,-1), 0),
        ("ALIGN",        (1,0), (1,0),  "RIGHT"),
    ]))
    story.append(footer_table)

    doc.build(story)


@functions_framework.http
def generate_invoice(request: Request):
    if request.method == "OPTIONS":
        return Response("", 204, headers=CORS_HEADERS)

    if request.headers.get("X-Api-Key") != API_KEY:
        return Response("Unauthorized", 401, headers=CORS_HEADERS)

    data = request.get_json(silent=True) or {}

    school_name = (data.get("schoolName") or "").strip()
    if not school_name:
        return Response("Missing schoolName", 400, headers=CORS_HEADERS)

    price    = float(data.get("pricePerStudent") or 0)
    quantity = int(data.get("quantity") or 0)
    if price <= 0 or quantity <= 0:
        return Response("Invalid price or quantity", 400, headers=CORS_HEADERS)

    if not (data.get("schoolAddress") or "").strip():
        return Response("Missing schoolAddress", 400, headers=CORS_HEADERS)

    # Format date as DD/MM/YYYY
    raw_date = data.get("date", "")
    try:
        # Parse various formats and reformat
        for fmt in ["%d %B, %Y", "%B %d, %Y", "%d/%m/%Y", "%Y-%m-%d"]:
            try:
                dt = datetime.strptime(raw_date, fmt)
                data["date"] = dt.strftime("%d/%m/%Y")
                break
            except ValueError:
                continue
        else:
            data["date"] = datetime.today().strftime("%d/%m/%Y")
    except Exception:
        data["date"] = datetime.today().strftime("%d/%m/%Y")

    buf = io.BytesIO()
    try:
        _build_invoice(data, buf)
    except Exception as e:
        return Response(f"Generation error: {e}", 500, headers=CORS_HEADERS)

    buf.seek(0)
    safe = "".join(ch for ch in school_name if ch not in '\\/:*?"<>|')
    inv_num = data.get("invoiceNumber", "")

    return Response(
        buf.read(), 200,
        mimetype="application/pdf",
        headers={
            **CORS_HEADERS,
            "Content-Disposition": f'inline; filename="Invoice_{inv_num}_{safe}.pdf"',
        },
    )
