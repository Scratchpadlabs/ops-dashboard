# Cloud Functions — Deploy Guide

## generate_pending_letter (NEW)

One-click PDF per school listing outstanding Data Receivable checklist items
(SchoolProfile.vue's "Generate Pending Letter" button, Data Receivable tab).
Same pattern as generate_invoice/generate_agreement — raw fetch + X-Api-Key,
returns a PDF blob directly, no Firestore/Storage access in the function
itself (the frontend logs each generation to `operations/ops/pending_letters`
client-side after a successful download). Uses the Anthropic API (shares the
`ANTHROPIC_API_KEY` secret with process_import) to draft ONLY the intro/
closing prose; the pending items list itself is always rendered verbatim
from the request payload — see main.py's module docstring for the guardrail
and its fallback if the LLM call fails.

### Files needed in the folder:
- main.py ✅
- requirements.txt ✅
- logo.png ✅ (ClarifiEd letterhead mark, copied from generate_agreement/logo.png)

### Deploy:
```
cd functions/generate_pending_letter

gcloud functions deploy generate_pending_letter \
  --gen2 --runtime python312 --region asia-south1 \
  --source . --entry-point generate_pending_letter \
  --trigger-http --allow-unauthenticated --project clarified-1501 \
  --memory 256MB --timeout 60s --max-instances 3 \
  --set-secrets ANTHROPIC_API_KEY=ANTHROPIC_API_KEY:latest
```
Reuses the same `ANTHROPIC_API_KEY` Secret Manager secret as process_import
— see that section below for how to create it if it doesn't exist yet. If
the secret is missing or the Anthropic call fails for any other reason, the
function still returns a PDF with a fixed default intro/closing (by design,
not a bug) — it never blocks the button.

Update `URLS.pendingLetter` in `src/utils/api.js` if the deployed URL ever
differs from `https://asia-south1-clarified-1501.cloudfunctions.net/generate_pending_letter`.

---

## process_import + commit_import (NEW)

The two halves of the School Material Import pipeline, both Firebase
`on_call` callables (not raw HTTP functions with a hardcoded API key) — see
main.py's module docstring for why. The frontend invokes them with
`httpsCallable(functions, 'process_import' | 'commit_import')` from
`src/utils/api.js`, where `functions` is `getFunctions(app, 'asia-south1')`
(`src/firebase/config.js`) — the region must match this deploy or the client
targets us-central1 and every call fails as what looks like a CORS error.

- `process_import`: parses uploaded xlsx/docx/pdf/image files via the
  Anthropic API and writes rows straight into `staging_imports/{jobId}/rows`.
- `commit_import`: takes the plan `useImport.js`'s `buildCommitPlan` already
  built client-side (plain Firestore reads, unchanged) and performs the
  actual writes into `schools/{schoolId}/...`.

Both verify `req.auth` (the caller's Firebase Auth ID token, attached
automatically by `httpsCallable` when the user is signed in) against the
`OPS_ADMIN_EMAILS` allowlist in main.py before doing anything — keep that
list in sync with `src/config/opsAdmins.js`.

### Files needed in the folder:
- main.py ✅
- requirements.txt ✅

### One-time IAM setup:
Already satisfied on clarified-1501 — the gen2 runtime service account
(`clarified-1501@appspot.gserviceaccount.com`) holds `roles/editor`, which
covers Firestore + Storage. Nothing to grant. (If that ever changes, it
needs `roles/datastore.user` + `roles/storage.objectViewer` at minimum.)

### Deploy:
```
cd functions/generate_import

gcloud functions deploy process_import \
  --gen2 --runtime python312 --region asia-south1 \
  --source . --entry-point process_import \
  --trigger-http --allow-unauthenticated --project clarified-1501 \
  --memory 1024MB --timeout 540s --max-instances 3 \
  --set-secrets ANTHROPIC_API_KEY=ANTHROPIC_API_KEY:latest

gcloud functions deploy commit_import \
  --gen2 --runtime python312 --region asia-south1 \
  --source . --entry-point commit_import \
  --trigger-http --allow-unauthenticated --project clarified-1501 \
  --memory 512MB --timeout 120s --max-instances 3
```
This repo deploys via plain `gcloud functions deploy`, not
`firebase deploy --only functions` — that means the memory/timeout_sec/
max_instances/secrets arguments on the `@https_fn.on_call(...)` decorators in
main.py are NOT read at deploy time (only the Firebase CLI's own build
pipeline introspects those); the gcloud flags above are what actually size
the Cloud Run resource and must be kept in sync with the decorator values by
hand. `--allow-unauthenticated` is still required even though these are
callables: it only lets the request reach the function at the IAM layer, the
function itself then checks `req.auth` + the allowlist before doing anything.

`ANTHROPIC_API_KEY` must be a Secret Manager secret named `ANTHROPIC_API_KEY` —
per golden rule 4, it never lives in the Vue app, Firestore, or the repo.
Create it once with:
```
printf '%s' 'sk-ant-...' | gcloud secrets create ANTHROPIC_API_KEY --data-file=- --project clarified-1501
```

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
