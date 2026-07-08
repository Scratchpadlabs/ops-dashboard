"""
ClarifiEd School Setup Guide Generator — Cloud Function
Fills the setup guide Word template with school name and AY, returns PDF.
Only Para 0 changes — everything else stays exactly as designed.

Deploy as Cloud Run (needs LibreOffice):
  gcloud run deploy generate-onboarding \
    --source . --region asia-south1 \
    --allow-unauthenticated --project clarified-1501 \
    --memory 512Mi --port 8080
"""

import io
import os
import json
import subprocess
import tempfile

import functions_framework
from flask import Request, Response
from docx import Document
from docx.shared import Pt
from copy import deepcopy

API_KEY = "9421060748"
_DIR    = os.path.dirname(os.path.abspath(__file__))

CORS_HEADERS = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Api-Key",
}

TEMPLATE_PATH = os.path.join(_DIR, "onboarding_template.docx")

# The exact text in Para 0 of the template
TEMPLATE_SCHOOL = "The Keystone Ankuram School, Pune"
TEMPLATE_AY     = "A.Y 2026-27"


def _fill_template(school_name: str, city: str, academic_year: str) -> bytes:
    doc = Document(TEMPLATE_PATH)

    para0 = doc.paragraphs[0]
    full  = para0.text  # e.g. "The Keystone Ankuram School, Pune [A.Y 2026-27]"

    # Build new header text matching template format exactly
    # Template format: "{School Name}, {City} [A.Y YYYY-YY]"
    if city and city.strip():
        new_header = f"{school_name}, {city} [A.Y {academic_year}]"
    else:
        new_header = f"{school_name} [A.Y {academic_year}]"

    # Replace text in Para 0 while preserving run formatting (bold, size)
    if para0.runs:
        # Put all text in first run, preserving its formatting
        para0.runs[0].text = new_header
        # Clear remaining runs
        for run in para0.runs[1:]:
            run.text = ""

    buf = io.BytesIO()
    doc.save(buf)
    buf.seek(0)
    return buf.read()


def _docx_to_pdf(docx_bytes: bytes) -> bytes:
    with tempfile.TemporaryDirectory() as tmpdir:
        docx_path = os.path.join(tmpdir, "setup_guide.docx")
        pdf_path  = os.path.join(tmpdir, "setup_guide.pdf")

        with open(docx_path, "wb") as f:
            f.write(docx_bytes)

        result = subprocess.run(
            ["libreoffice", "--headless", "--convert-to", "pdf",
             "--outdir", tmpdir, docx_path],
            capture_output=True, text=True, timeout=60
        )

        if result.returncode != 0 or not os.path.exists(pdf_path):
            raise RuntimeError(f"LibreOffice failed: {result.stderr}")

        with open(pdf_path, "rb") as f:
            return f.read()


@functions_framework.http
def generate_onboarding(request: Request):
    if request.method == "OPTIONS":
        return Response("", 204, headers=CORS_HEADERS)

    if request.headers.get("X-Api-Key") != API_KEY:
        return Response("Unauthorized", 401, headers=CORS_HEADERS)

    data = request.get_json(silent=True) or {}

    school_name   = (data.get("schoolName") or "").strip()
    city          = (data.get("city") or "").strip()
    academic_year = (data.get("academicYear") or "2026-27").strip()

    if not school_name:
        return Response("Missing schoolName", 400, headers=CORS_HEADERS)

    try:
        docx_bytes = _fill_template(school_name, city, academic_year)
        pdf_bytes  = _docx_to_pdf(docx_bytes)
    except Exception as e:
        return Response(
            json.dumps({"error": str(e)}), 500,
            mimetype="application/json",
            headers=CORS_HEADERS
        )

    safe     = "".join(ch for ch in school_name if ch not in '\\/:*?"<>|')
    filename = f"Setup_Guide_{safe}_{academic_year}.pdf"

    return Response(
        pdf_bytes, 200,
        mimetype="application/pdf",
        headers={
            **CORS_HEADERS,
            "Content-Disposition": f'inline; filename="{filename}"',
        },
    )
