"""
ClarifiEd Onboarding Document Generator — Cloud Function
Fills the onboarding Word template with school-specific data and returns PDF.

Deploy:
  gcloud functions deploy generate_onboarding \
    --gen2 --runtime python312 --region asia-south1 \
    --source . --entry-point generate_onboarding \
    --trigger-http --allow-unauthenticated \
    --memory 512MB --max-instances 3 --project clarified-1501
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
from docx.oxml.ns import qn

API_KEY = "9421060748"
_DIR    = os.path.dirname(os.path.abspath(__file__))

CORS_HEADERS = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Api-Key",
}

TEMPLATE_PATH   = os.path.join(_DIR, "onboarding_template.docx")


def _fill_template(school_name: str, academic_year: str) -> bytes:
    """
    Open the template, replace the school name and academic year,
    and return the filled .docx as bytes.
    """
    doc = Document(TEMPLATE_PATH)

    # Para 0 contains "ANGEL INTERNATIONAL SCHOOL\nA.Y 2026-27"
    # We need to replace while preserving formatting
    for para in doc.paragraphs:
        full = para.text
        if "ANGEL INTERNATIONAL SCHOOL" in full:
            # Rebuild runs: keep formatting of first run, replace text
            new_text = full.replace(
                "ANGEL INTERNATIONAL SCHOOL",
                school_name.upper()
            ).replace(
                "A.Y 2026-27",
                f"A.Y {academic_year}"
            )
            # Clear all runs and put new text in first run
            for run in para.runs:
                run.text = ""
            if para.runs:
                para.runs[0].text = new_text
            break

    buf = io.BytesIO()
    doc.save(buf)
    buf.seek(0)
    return buf.read()


def _docx_to_pdf(docx_bytes: bytes) -> bytes:
    """Convert docx bytes to PDF using LibreOffice headless."""
    with tempfile.TemporaryDirectory() as tmpdir:
        docx_path = os.path.join(tmpdir, "onboarding.docx")
        pdf_path  = os.path.join(tmpdir, "onboarding.pdf")

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
    # CORS preflight
    if request.method == "OPTIONS":
        return Response("", 204, headers=CORS_HEADERS)

    if request.headers.get("X-Api-Key") != API_KEY:
        return Response("Unauthorized", 401, headers=CORS_HEADERS)

    data = request.get_json(silent=True) or {}

    school_name   = (data.get("schoolName") or "").strip()
    academic_year = (data.get("academicYear") or "2026-27").strip()

    if not school_name:
        return Response("Missing schoolName", 400, headers=CORS_HEADERS)

    try:
        docx_bytes = _fill_template(school_name, academic_year)
        pdf_bytes  = _docx_to_pdf(docx_bytes)
    except Exception as e:
        return Response(
            json.dumps({"error": str(e)}), 500,
            mimetype="application/json",
            headers=CORS_HEADERS
        )

    safe = "".join(ch for ch in school_name if ch not in '\\/:*?"<>|')
    filename = f"Onboarding_{safe}_{academic_year}.pdf"

    return Response(
        pdf_bytes,
        200,
        mimetype="application/pdf",
        headers={
            **CORS_HEADERS,
            "Content-Disposition": f'inline; filename="{filename}"',
        },
    )
