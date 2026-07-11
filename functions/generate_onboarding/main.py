"""
ClarifiEd School Setup Guide Generator — Cloud Function
Fills Word template, converts to PDF via Google Drive API (perfect rendering).

Deploy as Cloud Run:
  gcloud run deploy generate-onboarding \
    --source . --region asia-south1 \
    --allow-unauthenticated --project clarified-1501 \
    --memory 512Mi --port 8080
"""

import io
import os
import json
import time

import functions_framework
from flask import Request, Response
from docx import Document
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseUpload, MediaIoBaseDownload
from google.oauth2 import service_account

API_KEY = "9421060748"
_DIR    = os.path.dirname(os.path.abspath(__file__))

CORS_HEADERS = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Api-Key",
}

TEMPLATE_PATH    = os.path.join(_DIR, "onboarding_template.docx")
SERVICE_ACCT_KEY = os.environ.get("SERVICE_ACCOUNT_PATH", os.path.join(_DIR, "service_account.json"))
SCOPES           = ["https://www.googleapis.com/auth/drive"]
# Shared Drive folder the service account uploads/converts through — a service
# account has no personal Drive quota, so this must live in a Shared Drive.
DRIVE_FOLDER_ID  = os.environ.get("DRIVE_FOLDER_ID", "0APtW14t1fIM9Uk9PVA")

# Template school name to replace
TEMPLATE_SCHOOL = "The Keystone Ankuram School, Pune [A.Y 2026-27]"


def _get_drive_service():
    creds = service_account.Credentials.from_service_account_file(
        SERVICE_ACCT_KEY, scopes=SCOPES
    )
    return build("drive", "v3", credentials=creds)


def _fill_template(school_name: str, city: str, academic_year: str) -> bytes:
    doc = Document(TEMPLATE_PATH)

    # Para 0: school name + AY
    para0 = doc.paragraphs[0]
    if city and city.strip():
        new_header = f"{school_name}, {city} [A.Y {academic_year}]"
    else:
        new_header = f"{school_name} [A.Y {academic_year}]"

    if para0.runs:
        para0.runs[0].text = new_header
        for run in para0.runs[1:]:
            run.text = ""

    buf = io.BytesIO()
    doc.save(buf)
    buf.seek(0)
    return buf.read()


def _docx_to_pdf_via_drive(docx_bytes: bytes, filename: str) -> bytes:
    service = _get_drive_service()

    # 1. Upload docx to Drive (into a Shared Drive — service accounts have no
    # personal Drive storage of their own to upload into)
    file_metadata = {
        "name": filename,
        "mimeType": "application/vnd.google-apps.document",  # convert to Google Doc on upload
        "parents": [DRIVE_FOLDER_ID],
    }
    media = MediaIoBaseUpload(
        io.BytesIO(docx_bytes),
        mimetype="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        resumable=False,
    )
    uploaded = service.files().create(
        body=file_metadata,
        media_body=media,
        fields="id",
        supportsAllDrives=True,
    ).execute()

    file_id = uploaded.get("id")

    try:
        # 2. Export as PDF
        request = service.files().export_media(
            fileId=file_id,
            mimeType="application/pdf"
        )
        pdf_buf = io.BytesIO()
        downloader = MediaIoBaseDownload(pdf_buf, request)
        done = False
        while not done:
            _, done = downloader.next_chunk()

        pdf_buf.seek(0)
        return pdf_buf.read()

    finally:
        # 3. Delete temp file from Drive
        try:
            service.files().delete(fileId=file_id, supportsAllDrives=True).execute()
        except Exception:
            pass


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
        safe       = "".join(ch for ch in school_name if ch not in '\\/:*?"<>|')
        filename   = f"Setup_Guide_{safe}_{academic_year}.docx"
        pdf_bytes  = _docx_to_pdf_via_drive(docx_bytes, filename)
    except Exception as e:
        return Response(
            json.dumps({"error": str(e)}), 500,
            mimetype="application/json",
            headers=CORS_HEADERS
        )

    pdf_filename = f"Setup_Guide_{safe}_{academic_year}.pdf"

    return Response(
        pdf_bytes, 200,
        mimetype="application/pdf",
        headers={
            **CORS_HEADERS,
            "Content-Disposition": f'inline; filename="{pdf_filename}"',
        },
    )
