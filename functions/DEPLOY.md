# Cloud Functions — Deploy Guide

## process_import (NEW)

Extraction half of the School Material Import pipeline (see docs/task_import
context) — parses uploaded xlsx/docx/pdf/image files via the Anthropic API
and writes rows straight into `staging_imports/{jobId}/rows`. The commit
half (`staging_imports` → live `schools/{schoolId}/...`) is NOT a Cloud
Function — it's client-side batched writes in `src/composables/useImport.js`,
same pattern as every other School Setup CSV import.

### Files needed in the folder:
- main.py ✅
- requirements.txt ✅

### One-time IAM setup (not covered by the deploy command):
The runtime service account needs Firestore + Storage access:
```
gcloud projects add-iam-policy-binding clarified-1501 \
  --member="serviceAccount:clarified-1501@appspot.gserviceaccount.com" \
  --role="roles/datastore.user"
gcloud projects add-iam-policy-binding clarified-1501 \
  --member="serviceAccount:clarified-1501@appspot.gserviceaccount.com" \
  --role="roles/storage.objectViewer"
```
(Confirm the actual runtime service account email from the function's
details page — gen2 functions default to the App Engine default SA above.)

### Deploy:
```
cd functions/generate_import

gcloud functions deploy process_import \
  --gen2 --runtime python312 --region asia-south1 \
  --source . --entry-point process_import \
  --trigger-http --allow-unauthenticated \
  --memory 1024MB --timeout 540s --max-instances 3 --project clarified-1501 \
  --set-env-vars MODEL=claude-sonnet-4-6 \
  --set-secrets ANTHROPIC_API_KEY=anthropic-api-key:latest
```
`ANTHROPIC_API_KEY` must be a Secret Manager secret (`anthropic-api-key`) —
per golden rule 4, it never lives in the Vue app, Firestore, or the repo.
Create it once with:
```
printf '%s' 'sk-ant-...' | gcloud secrets create anthropic-api-key --data-file=- --project clarified-1501
```
Update the URL in `src/utils/api.js` (`URLS.processImport`) after deploy.

---

## generate_invoice (NEW)

### Files needed in the folder:
- main.py ✅
- requirements.txt ✅
- invoice_template.pdf ← copy from your blank invoice Canva export
- Montserrat-Regular.ttf ← same font files from existing quotation function
- Montserrat-Bold.ttf ← same font files from existing quotation function

### Deploy:
```
cd functions/generate_invoice

gcloud functions deploy generate_invoice \
  --gen2 --runtime python312 --region asia-south1 \
  --source . --entry-point generate_invoice \
  --trigger-http --allow-unauthenticated \
  --memory 256MB --max-instances 3 --project clarified-1501
```

---

## generate_agreement (NEW)

### Files needed in the folder:
- main.py ✅
- requirements.txt ✅
- agreement_template.docx ← your existing HPC_agreement_.docx

### Note on LibreOffice:
The agreement function uses LibreOffice headless to convert .docx → PDF.
Cloud Run (gen2) supports this via apt packages. Add a Dockerfile:

```dockerfile
FROM python:3.12-slim
RUN apt-get update && apt-get install -y libreoffice --no-install-recommends && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY . .
CMD exec functions-framework --target=generate_agreement --port=$PORT
```

Then deploy using Cloud Run instead:
```
cd functions/generate_agreement

gcloud run deploy generate-agreement \
  --source . --region asia-south1 \
  --allow-unauthenticated --project clarified-1501 \
  --memory 512Mi
```

Update the URL in src/utils/api.js to the Cloud Run URL after deploy.

---

## generate_quotation (EXISTING — no changes needed)

Already deployed at:
https://asia-south1-clarified-1501.cloudfunctions.net/generate_quotation

Just needs CORS headers added. Add this at the top of the existing function:

```python
@functions_framework.http
def generate_quotation(request: Request):
    if request.method == "OPTIONS":
        return Response("", 204, headers={
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST",
            "Access-Control-Allow-Headers": "Content-Type, X-Api-Key",
        })
    # ... rest of existing code ...
    # Add to final Response:
    # headers={"Access-Control-Allow-Origin": "*"}
```

Redeploy after adding CORS.
