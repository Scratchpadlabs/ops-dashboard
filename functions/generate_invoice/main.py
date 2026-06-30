"""
ClarifiEd Invoice Generator — Cloud Function
Overlays variable fields onto the blank invoice PDF template using pymupdf.

Deploy:
  gcloud functions deploy generate_invoice \
    --gen2 --runtime python312 --region asia-south1 \
    --source . --entry-point generate_invoice \
    --trigger-http --allow-unauthenticated \
    --memory 256MB --max-instances 3 --project clarified-1501

Folder needs: main.py, requirements.txt, invoice_template.pdf,
Montserrat-Regular.ttf, Montserrat-Bold.ttf
"""

import io
import os
from datetime import datetime, timedelta

import fitz  # pymupdf
import functions_framework
from flask import Request, Response

API_KEY = "9421060748"
_DIR = os.path.dirname(os.path.abspath(__file__))
TEMPLATE_PATH = os.path.join(_DIR, "invoice_template.pdf")

# Exact coordinates extracted from filled invoice (x, y from top-left)
# pymupdf uses top-left origin, so y is from top
COORDS = {
    "date":          dict(x=425.2, y=142.4, size=13, bold=False),
    "school_name":   dict(x=151.3, y=192.9, size=12, bold=False),
    "school_address":dict(x=151.3, y=210.4, size=10, bold=False),
    "school_phone":  dict(x=152.4, y=227.1, size=12, bold=False),
    "invoice_number":dict(x=152.4, y=242.5, size=12, bold=False),
    "desc_line1":    dict(x=38.3,  y=324.2, size=13, bold=False),
    "desc_line2":    dict(x=38.3,  y=342.2, size=11, bold=False),
    "price":         dict(x=223.6, y=331.1, size=13, bold=False),
    "quantity":      dict(x=339.3, y=331.0, size=13, bold=False),
    "amount":        dict(x=476.9, y=331.7, size=13, bold=True),
    "total":         dict(x=476.9, y=406.1, size=13, bold=True),
}

FONT_REGULAR = os.path.join(_DIR, "Montserrat-Regular.ttf")
FONT_BOLD    = os.path.join(_DIR, "Montserrat-Bold.ttf")


def _format_inr(amount):
    """Format number as Indian number system: 68,127"""
    s = str(int(amount))
    if len(s) <= 3:
        return s
    # Indian format: last 3 digits, then groups of 2
    result = s[-3:]
    s = s[:-3]
    while s:
        result = s[-2:] + "," + result
        s = s[:-2]
    return result.lstrip(",")


def _overlay_text(page, text, x, y, size, bold, font_reg, font_bold):
    """Insert text at exact (x, y from top) coordinates."""
    font = font_bold if bold else font_reg
    page.insert_text(
        fitz.Point(x, y + size),  # pymupdf y is baseline
        text,
        fontname=font,
        fontsize=size,
        color=(0, 0, 0),
    )


@functions_framework.http
def generate_invoice(request: Request):
    # CORS preflight
    if request.method == "OPTIONS":
        return Response("", 204, headers={
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST",
            "Access-Control-Allow-Headers": "Content-Type, X-Api-Key",
        })

    if request.headers.get("X-Api-Key") != API_KEY:
        return Response("Unauthorized", 401, headers={"Access-Control-Allow-Origin": "*"})

    data = request.get_json(silent=True) or {}

    # Required fields
    school_name    = (data.get("schoolName") or "").strip()
    invoice_number = (data.get("invoiceNumber") or "").strip()
    description    = (data.get("description") or "").strip()
    price          = int(data.get("pricePerStudent") or 0)
    quantity       = int(data.get("quantity") or 0)

    if not school_name:
        return Response("Missing schoolName", 400, headers={"Access-Control-Allow-Origin": "*"})
    if not invoice_number:
        return Response("Missing invoiceNumber", 400, headers={"Access-Control-Allow-Origin": "*"})
    if price <= 0 or quantity <= 0:
        return Response("Invalid price or quantity", 400, headers={"Access-Control-Allow-Origin": "*"})

    # Optional fields
    school_address = (data.get("schoolAddress") or "").strip()
    school_phone   = (data.get("schoolPhone") or "").strip()
    date_str       = data.get("date") or datetime.today().strftime("%-d %B, %Y")

    amount = price * quantity
    amount_str = _format_inr(amount)

    # Split description into 2 lines if needed
    desc_lines = description.split("\n") if "\n" in description else [description, ""]
    desc_line1 = desc_lines[0]
    desc_line2 = desc_lines[1] if len(desc_lines) > 1 else ""

    # Load template
    doc = fitz.open(TEMPLATE_PATH)
    page = doc[0]

    # Register fonts
    page.insert_font(fontname="Mont",     fontfile=FONT_REGULAR)
    page.insert_font(fontname="MontBold", fontfile=FONT_BOLD)

    def draw(key, text):
        c = COORDS[key]
        font = "MontBold" if c["bold"] else "Mont"
        page.insert_text(
            fitz.Point(c["x"], c["y"] + c["size"]),
            text,
            fontname=font,
            fontsize=c["size"],
            color=(0, 0, 0),
        )

    draw("date",           date_str)
    draw("school_name",    school_name)
    draw("school_address", school_address)
    draw("school_phone",   school_phone)
    draw("invoice_number", invoice_number)
    draw("desc_line1",     desc_line1)
    if desc_line2:
        draw("desc_line2", desc_line2)
    draw("price",          str(price))
    draw("quantity",       str(quantity))
    draw("amount",         amount_str)
    draw("total",          amount_str)

    # Save to bytes
    buf = io.BytesIO()
    doc.save(buf)
    buf.seek(0)

    safe_name = "".join(ch for ch in school_name if ch not in '\\/:*?"<>|')
    return Response(
        buf.read(),
        200,
        mimetype="application/pdf",
        headers={
            "Content-Disposition": f'inline; filename="Invoice_{invoice_number}_{safe_name}.pdf"',
            "Access-Control-Allow-Origin": "*",
        },
    )
