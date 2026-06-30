import functions_framework
import fitz  # pymupdf
import os
import json
from flask import Request, Response
from datetime import datetime, timedelta

API_KEY = '9421060748'
TEMPLATE_PATH = os.path.join(os.path.dirname(__file__), 'invoice_template.pdf')

# Exact coordinates from blank template (PDF coordinate space, y from bottom)
# Page height = 842.25 pts
H = 842.25

# Variable field positions (x, y_from_top, fontsize)
FIELDS = {
    'date':           (425.2, 142.4, 13),
    'school_name':    (151.3, 192.9, 12),
    'school_address': (151.3, 210.4, 10),
    'school_phone':   (152.4, 227.1, 12),
    'invoice_number': (152.4, 242.5, 12),
    'description_1':  (38.3,  324.2, 13),
    'description_2':  (38.3,  342.2, 11),
    'price':          (223.6, 331.1, 13),
    'quantity':       (339.3, 331.0, 13),
    'amount':         (None,  331.7, 13),  # right-aligned
    'total':          (None,  406.1, 13),  # right-aligned
}

# Right-align boundary for amount/total
AMOUNT_RIGHT = 558.0


def format_inr(amount):
    """Format number in Indian number system"""
    s = str(int(amount))
    if len(s) <= 3:
        return s
    result = s[-3:]
    s = s[:-3]
    while len(s) > 2:
        result = s[-2:] + ',' + result
        s = s[:-2]
    if s:
        result = s + ',' + result
    return result


def format_date(date_str=None):
    if date_str:
        try:
            d = datetime.strptime(date_str, '%Y-%m-%d')
            return d.strftime('%-d %B, %Y')
        except:
            return date_str
    return datetime.now().strftime('%-d %B, %Y')


@functions_framework.http
def generate_invoice(request: Request):
    # CORS
    if request.method == 'OPTIONS':
        return Response('', 204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST',
            'Access-Control-Allow-Headers': 'Content-Type, X-Api-Key',
        })

    headers = {
        'Access-Control-Allow-Origin': '*',
    }

    # Auth
    if request.headers.get('X-Api-Key') != API_KEY:
        return Response('Unauthorized', 401, headers)

    # Parse body
    try:
        data = request.get_json(force=True)
    except Exception:
        return Response('Invalid JSON', 400, headers)

    school_name    = data.get('schoolName', '')
    school_address = data.get('schoolAddress', '')
    school_phone   = data.get('schoolPhone', '')
    invoice_number = data.get('invoiceNumber', '')
    description    = data.get('description', '')
    price          = int(data.get('pricePerStudent', 0))
    quantity       = int(data.get('quantity', 0))
    date_str       = data.get('date', None)
    amount         = price * quantity

    # Split description into 2 lines if needed
    desc_parts = description.split('\n') if '\n' in description else [description, '']
    desc_line1 = desc_parts[0]
    desc_line2 = desc_parts[1] if len(desc_parts) > 1 else ''

    # Load template
    doc = fitz.open(TEMPLATE_PATH)
    page = doc[0]

    # Font
    font_regular = fitz.Font('helv')
    font_bold    = fitz.Font('hebo')

    def draw(text, x, y_from_top, size, bold=False):
        font = font_bold if bold else font_regular
        # pymupdf: y is from bottom of page
        y = H - y_from_top - size * 0.3  # small baseline adjustment
        page.insert_text((x, y), text, fontsize=size, font=font, color=(0, 0, 0))

    def draw_right(text, right_x, y_from_top, size, bold=False):
        font = font_bold if bold else font_regular
        text_width = font.text_length(text, fontsize=size)
        x = right_x - text_width
        y = H - y_from_top - size * 0.3
        page.insert_text((x, y), text, fontsize=size, font=font, color=(0, 0, 0))

    # Draw all fields
    draw(format_date(date_str),  425.2, 142.4, 13)
    draw(school_name,            151.3, 192.9, 12)
    draw(school_address,         151.3, 210.4, 10)
    draw(school_phone,           152.4, 227.1, 12)
    draw(invoice_number,         152.4, 242.5, 12)
    draw(desc_line1,             38.3,  324.2, 13)
    if desc_line2:
        draw(desc_line2,         38.3,  342.2, 11)
    draw(str(price),             223.6, 331.1, 13)
    draw(str(quantity),          339.3, 331.0, 13)
    draw_right(format_inr(amount), AMOUNT_RIGHT, 331.7, 13, bold=True)
    draw_right(format_inr(amount), AMOUNT_RIGHT, 406.1, 13, bold=True)

    # Save to bytes
    pdf_bytes = doc.tobytes()
    doc.close()

    filename = f"Invoice_{invoice_number}_{school_name}.pdf"
    return Response(
        pdf_bytes,
        200,
        {
            **headers,
            'Content-Type': 'application/pdf',
            'Content-Disposition': f'attachment; filename="{filename}"',
        }
    )
