"""
ClarifiEd Quotation Generator — Combined Cloud Function source
WITH CORS HEADERS ADDED for browser-based dashboard access.

Redeploy both functions after replacing this file:

  Sheet1 (two-option):
    gcloud functions deploy generate_quotation \
      --gen2 --runtime python312 --region asia-south1 \
      --source . --entry-point generate_quotation \
      --trigger-http --allow-unauthenticated \
      --memory 256MB --max-instances 3 --project clarified-1501

  Sheet2 (single-option):
    gcloud functions deploy generate_quotation_sheet2 \
      --gen2 --runtime python312 --region asia-south1 \
      --source . --entry-point generate_quotation_sheet2 \
      --trigger-http --allow-unauthenticated \
      --memory 256MB --max-instances 3 --project clarified-1501
"""

import io
import os

import functions_framework
from flask import Request, Response
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont as ReportLabTTFont

API_KEY = "9421060748"

_DIR = os.path.dirname(os.path.abspath(__file__))
pdfmetrics.registerFont(ReportLabTTFont("Montserrat", os.path.join(_DIR, "Montserrat-Regular.ttf")))
pdfmetrics.registerFont(ReportLabTTFont("Montserrat-Bold", os.path.join(_DIR, "Montserrat-Bold.ttf")))

PAGE_W, PAGE_H = A4

CORS_HEADERS = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Api-Key",
}

# ============================================================
# SHEET1 — two-option quotation
# ============================================================
BG_PATH_S1  = os.path.join(_DIR, "quotation_background.png")
SRC_W_PX_S1 = 1414
SCALE_S1    = PAGE_W / SRC_W_PX_S1

MRP_PRINTED = 299
MRP_DIGITAL = 169

FIELDS_S1 = {
    "date":            dict(x=232,  y=362,  size=11, bold=False, align="left"),
    "schoolName":      dict(x=700,  y=510,  size=11, bold=False, semibold=True, align="left"),
    "printedDiscount": dict(cx=885, y=1050, size=13, bold=False, align="center"),
    "printedPrice":    dict(cx=1240,y=1050, size=13, bold=True,  align="center", pill="#A9E6A0"),
    "digitalDiscount": dict(cx=885, y=1300, size=13, bold=False, align="center"),
    "digitalPrice":    dict(cx=1240,y=1300, size=13, bold=True,  align="center", pill="#F6D560"),
    "studentCount":    dict(x=895,  y=1438, size=16, bold=True,  align="left"),
}


def _to_x_s1(px): return px * SCALE_S1
def _to_y_s1(px): return PAGE_H - px * SCALE_S1


def _draw_field_s1(c, field, text):
    f    = FIELDS_S1[field]
    font = "Montserrat-Bold" if f["bold"] else "Montserrat"
    y    = _to_y_s1(f["y"])
    if "pill" in f:
        cx   = _to_x_s1(f["cx"])
        w, h = 90, 22
        c.setFillColor(f["pill"])
        c.roundRect(cx - w / 2, y - 6, w, h, 6, fill=1, stroke=0)
    c.setFillColorRGB(0, 0, 0)
    c.setFont(font, f["size"])
    mode = None
    if f.get("semibold"):
        c.setStrokeColorRGB(0, 0, 0)
        c.setLineWidth(0.25)
        mode = 2
    if f["align"] == "center":
        c.drawCentredString(_to_x_s1(f["cx"]), y, text, mode=mode)
    else:
        c.drawString(_to_x_s1(f["x"]), y, text, mode=mode)


def _build_pdf_s1(data, out):
    c = canvas.Canvas(out, pagesize=A4)
    c.drawImage(BG_PATH_S1, 0, 0, width=PAGE_W, height=PAGE_H)
    _draw_field_s1(c, "date",            data["date"])
    _draw_field_s1(c, "schoolName",      data["schoolName"])
    _draw_field_s1(c, "printedDiscount", f'{data["printedDiscount"]}%')
    _draw_field_s1(c, "printedPrice",    f'{data["printedPrice"]}/- Rs')
    _draw_field_s1(c, "digitalDiscount", f'{data["digitalDiscount"]}%')
    _draw_field_s1(c, "digitalPrice",    f'{data["digitalPrice"]}/- Rs')
    _draw_field_s1(c, "studentCount",    f'{data["studentCount"]} students')
    c.save()


@functions_framework.http
def generate_quotation(request: Request):
    # CORS preflight
    if request.method == "OPTIONS":
        return Response("", 204, headers=CORS_HEADERS)

    if request.headers.get("X-Api-Key") != API_KEY:
        return Response("Unauthorized", 401, headers=CORS_HEADERS)

    data   = request.get_json(silent=True) or {}
    school = (data.get("schoolName") or "").strip()
    if not school:
        return Response("Missing schoolName", 400, headers=CORS_HEADERS)

    printed_discount = float(data.get("printedDiscount") or 0)
    digital_discount = float(data.get("digitalDiscount") or 0)

    payload = {
        "schoolName":      school,
        "date":            data.get("date") or "",
        "studentCount":    data.get("studentCount") or "",
        "printedDiscount": int(printed_discount),
        "printedPrice":    int(MRP_PRINTED * (1 - printed_discount / 100)),
        "digitalDiscount": int(digital_discount),
        "digitalPrice":    int(MRP_DIGITAL * (1 - digital_discount / 100)),
    }

    buf = io.BytesIO()
    _build_pdf_s1(payload, buf)
    buf.seek(0)

    safe = "".join(ch for ch in school if ch not in '\\/:*?"<>|')
    return Response(
        buf.read(),
        200,
        mimetype="application/pdf",
        headers={**CORS_HEADERS, "Content-Disposition": f'inline; filename="{safe}.pdf"'},
    )


# ============================================================
# SHEET2 — single-option quotation
# ============================================================
BG_PATH_S2  = os.path.join(_DIR, "quotation_background_sheet2.png")
SRC_W_PX_S2 = 1414
SCALE_S2    = PAGE_W / SRC_W_PX_S2

ITEM_OPTIONS = {
    "Printed+Digital HPC": dict(mrp=299, pill="#A9E6A0", line1="Printed+Digital", line2="HPC"),
    "Only Digital HPC":    dict(mrp=169, pill="#FDE056", line1="Only Digital",    line2="HPC"),
}

FIELDS_S2 = {
    "date":         dict(x=232,  y=365,  size=11, bold=False, align="left"),
    "schoolName":   dict(x=695,  y=600,  size=11, bold=False, semibold=True, align="left"),
    "itemLine1":    dict(x=85,   y=965,  size=15, bold=False, align="left"),
    "itemLine2":    dict(x=85,   y=1023, size=15, bold=False, align="left"),
    "mrp":          dict(cx=510, y=993,  size=13, bold=False, align="center"),
    "discount":     dict(cx=885, y=993,  size=13, bold=False, align="center"),
    "price":        dict(cx=1240,y=993,  size=13, bold=True,  align="center"),
    "studentCount": dict(x=888,  y=1192, size=16, bold=True,  align="left"),
}


def _to_x_s2(px): return px * SCALE_S2
def _to_y_s2(px): return PAGE_H - px * SCALE_S2


def _draw_field_s2(c, field, text, pill=None):
    f    = FIELDS_S2[field]
    font = "Montserrat-Bold" if f["bold"] else "Montserrat"
    y    = _to_y_s2(f["y"])
    if pill:
        cx   = _to_x_s2(f["cx"])
        w, h = 95, 22
        c.setFillColor(pill)
        c.roundRect(cx - w / 2, y - 6, w, h, 6, fill=1, stroke=0)
    c.setFillColorRGB(0, 0, 0)
    c.setFont(font, f["size"])
    mode = None
    if f.get("semibold"):
        c.setStrokeColorRGB(0, 0, 0)
        c.setLineWidth(0.25)
        mode = 2
    if f["align"] == "center":
        c.drawCentredString(_to_x_s2(f["cx"]), y, text, mode=mode)
    else:
        c.drawString(_to_x_s2(f["x"]), y, text, mode=mode)


def _build_pdf_s2(data, out):
    opt      = ITEM_OPTIONS[data["item"]]
    discount = data["discount"]
    price    = int(opt["mrp"] * (1 - discount / 100))
    c        = canvas.Canvas(out, pagesize=A4)
    c.drawImage(BG_PATH_S2, 0, 0, width=PAGE_W, height=PAGE_H)
    _draw_field_s2(c, "date",         data["date"])
    _draw_field_s2(c, "schoolName",   data["schoolName"])
    _draw_field_s2(c, "itemLine1",    opt["line1"])
    _draw_field_s2(c, "itemLine2",    opt["line2"])
    _draw_field_s2(c, "mrp",          f'{opt["mrp"]}/- Rs')
    _draw_field_s2(c, "discount",     f'{discount}%')
    _draw_field_s2(c, "price",        f'{price}/- Rs', pill=opt["pill"])
    _draw_field_s2(c, "studentCount", f'{data["studentCount"]} students')
    c.save()


@functions_framework.http
def generate_quotation_sheet2(request: Request):
    if request.method == "OPTIONS":
        return Response("", 204, headers=CORS_HEADERS)

    if request.headers.get("X-Api-Key") != API_KEY:
        return Response("Unauthorized", 401, headers=CORS_HEADERS)

    data   = request.get_json(silent=True) or {}
    school = (data.get("schoolName") or "").strip()
    item   = data.get("item") or ""

    if not school:
        return Response("Missing schoolName", 400, headers=CORS_HEADERS)
    if item not in ITEM_OPTIONS:
        return Response(f"item must be one of {list(ITEM_OPTIONS.keys())}", 400, headers=CORS_HEADERS)

    payload = {
        "schoolName":   school,
        "date":         data.get("date") or "",
        "item":         item,
        "discount":     float(data.get("discount") or 0),
        "studentCount": data.get("studentCount") or "",
    }

    buf = io.BytesIO()
    _build_pdf_s2(payload, buf)
    buf.seek(0)

    safe = "".join(ch for ch in school if ch not in '\\/:*?"<>|')
    return Response(
        buf.read(),
        200,
        mimetype="application/pdf",
        headers={**CORS_HEADERS, "Content-Disposition": f'inline; filename="{safe}.pdf"'},
    )
