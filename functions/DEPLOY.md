# Cloud Functions — Deploy Guide

## generate_pending_letter (v2: compose dialog, draft/render modes)

PDF per school listing outstanding pending items from the Data Receivable
checklist (data pending FROM the school — Onboarding Data / per-term /
Final Term Data / Grading Scale — NEVER the Operations tab, which is
ClarifiEd's own internal task list). SchoolProfile.vue's "Generate Pending
Letter" button (Data Receivable tab) opens PendingLetterDialog.vue: select
scope -> draft -> edit -> generate. Same pattern as generate_invoice/generate_agreement —
raw fetch + X-Api-Key, no Firestore/Storage access in the function itself
(the frontend logs each generation to `operations/ops/pending_letters`
client-side after a successful download).

One endpoint, two modes via a `mode` field in the request body:
- `mode: "draft"` — LLM call only, returns `{"intro", "closing"}` JSON for
  the dialog's editable preview. Uses OpenAI (shares the `OPENAI_API_KEY`
  secret with process_import; Anthropic works as a fallback provider if
  `ANTHROPIC_API_KEY` is bound instead) to draft ONLY the intro/closing
  prose — never sees the item list.
- `mode: "render"` (default) — PURE render, NO LLM call. Takes the
  (possibly user-edited) intro/closing/extraNote plus the selected items
  (each optionally carrying a `comment`, rendered as an indented italic
  note under it) and returns the PDF exactly as previewed. See main.py's
  module docstring for the full guardrail.

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
  --set-secrets OPENAI_API_KEY=OPENAI_API_KEY:latest \
  --set-env-vars MODEL=gpt-4o-mini
```
Reuses the same `OPENAI_API_KEY` Secret Manager secret as process_import —
see that section below for how to create it if it doesn't exist yet. If the
secret is missing or the OpenAI call fails for any other reason, the
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

- `process_import`: parses uploaded xlsx/docx/pdf/image files via OpenAI
  (Anthropic as a fallback provider — see main.py's extract_file) and writes
  rows straight into `staging_imports/{jobId}/rows`. **.pdf uploads need the
  Anthropic path** — OpenAI's Chat Completions API has no raw-PDF content
  block, so with `OPENAI_API_KEY` set, .pdf extraction raises a clear error
  instead of silently mishandling the file (see call_openai_compatible).
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
  --set-secrets OPENAI_API_KEY=OPENAI_API_KEY:latest \
  --set-env-vars MODEL=gpt-4o
# (bind ANTHROPIC_API_KEY=ANTHROPIC_API_KEY:latest instead — and drop the
# MODEL override, or set it to a Claude model — to extract from .pdf
# uploads, which the OpenAI path can't handle; see call_openai_compatible)

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

`OPENAI_API_KEY` must be a Secret Manager secret named `OPENAI_API_KEY` —
per golden rule 4, it never lives in the Vue app, Firestore, or the repo.
Create it once with:
```
printf '%s' 'sk-...' | gcloud secrets create OPENAI_API_KEY --data-file=- --project clarified-1501
```
(Same for `ANTHROPIC_API_KEY` if you bind that instead, e.g. for .pdf
extraction — `printf '%s' 'sk-ant-...' | gcloud secrets create ANTHROPIC_API_KEY --data-file=- --project clarified-1501`.)

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

## process_intake_emails (NEW — Task 1: Email intake -> auto-staged imports)

Scheduled (Cloud Scheduler, every 5 min) Gmail poller — schools email/forward
material to a dedicated intake mailbox and it lands as `intake_files` docs
(and, when confidently classified + the sender's school is known, an
auto-staged `staging_imports` job using the exact same pipeline the Import
tab uses). See `functions/email_intake/main.py`'s module docstring for the
full flow and `functions/email_intake/SETUP.md` for the required one-time
setup (mailbox, OAuth refresh token, Secret Manager secrets, IAM, the
Scheduler job itself) — none of that is optional, the function does nothing
useful until it's done.

### Files needed in the folder:
- main.py ✅
- requirements.txt ✅
- normalize.py, tabular_parser.py ✅ (verbatim copies of generate_import's —
  see their header comments; keep in sync by hand)

### Deploy:
```
cd functions/email_intake

gcloud functions deploy process_intake_emails \
  --gen2 --runtime python312 --region asia-south1 \
  --source . --entry-point process_intake_emails \
  --trigger-http --no-allow-unauthenticated --project clarified-1501 \
  --memory 512MB --timeout 300s --max-instances 1 \
  --set-secrets GMAIL_INTAKE_CLIENT_ID=GMAIL_INTAKE_CLIENT_ID:latest,GMAIL_INTAKE_CLIENT_SECRET=GMAIL_INTAKE_CLIENT_SECRET:latest,GMAIL_INTAKE_REFRESH_TOKEN=GMAIL_INTAKE_REFRESH_TOKEN:latest
```

`--no-allow-unauthenticated` here (unlike every other function in this repo)
is deliberate: this function takes no useful input from a caller — it always
just drains the intake mailbox — and should only ever be invoked by Cloud
Scheduler via an OIDC token. See SETUP.md step 8 for the invoker service
account + Scheduler job creation.

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
