# Email Intake — one-time setup

`process_intake_emails` (this folder) polls a dedicated Gmail mailbox every 5
minutes via Cloud Scheduler and turns attachments into `intake_files` docs
(and, when confidently classified + the sender's school is known, a staged
import in the same `staging_imports` collection/pipeline the Import tab
uses). None of this is wired up automatically — it needs the one-time setup
below before the first deploy. Everything here is done once; ordinary
day-to-day use needs nothing further from Sid beyond working the Intake
Queue in the dashboard.

## 1. Create the intake mailbox

Create a Gmail address dedicated to material intake, e.g.
`clarified.intake@gmail.com` (or a Workspace alias if ClarifiEd has one —
either works, this function only needs Gmail API access to it, not admin
rights over a domain). Point schools at this address for material
submission; forwarded WhatsApp attachments work too as long as they land in
this inbox as a normal email with attachments.

## 2. Enable the Gmail API + create an OAuth client

In the `clarified-1501` Google Cloud project:

1. APIs & Services → Library → enable **Gmail API**.
2. APIs & Services → OAuth consent screen → configure it (External is fine;
   Testing mode is enough as long as the intake mailbox itself is added as a
   test user — no need to publish).
3. APIs & Services → Credentials → Create Credentials → OAuth client ID →
   Application type **Desktop app**. Note the Client ID and Client Secret.

## 3. Mint a refresh token (one-time, run locally)

A personal/shared Gmail mailbox isn't a Workspace domain Sid administers, so
domain-wide delegation isn't available — a stored OAuth refresh token is the
standard alternative for a long-running backend job like this. Run once,
locally, signed in as the **intake mailbox** (not your own account):

```bash
pip install google-auth-oauthlib
python3 - <<'EOF'
from google_auth_oauthlib.flow import InstalledAppFlow

flow = InstalledAppFlow.from_client_config({
    "installed": {
        "client_id": "YOUR_CLIENT_ID",
        "client_secret": "YOUR_CLIENT_SECRET",
        "auth_uri": "https://accounts.google.com/o/oauth2/auth",
        "token_uri": "https://oauth2.googleapis.com/token",
        "redirect_uris": ["http://localhost"],
    }
}, scopes=["https://www.googleapis.com/auth/gmail.modify"])

creds = flow.run_local_server(port=0)
print("Refresh token:", creds.refresh_token)
EOF
```

This opens a browser — sign in as the intake mailbox and approve. Copy the
printed refresh token; you won't be able to retrieve it again (mint a new
one by re-running the flow if it's lost).

## 4. Store the three secrets

```bash
printf '%s' 'YOUR_CLIENT_ID'     | gcloud secrets create GMAIL_INTAKE_CLIENT_ID     --data-file=- --project clarified-1501
printf '%s' 'YOUR_CLIENT_SECRET' | gcloud secrets create GMAIL_INTAKE_CLIENT_SECRET --data-file=- --project clarified-1501
printf '%s' 'YOUR_REFRESH_TOKEN' | gcloud secrets create GMAIL_INTAKE_REFRESH_TOKEN --data-file=- --project clarified-1501
```

(Use `gcloud secrets versions add ... --data-file=-` instead of `create` if
any of these already exist, e.g. rotating the refresh token later.)

## 5. IAM for the function's runtime service account

The gen2 runtime service account is `clarified-1501@appspot.gserviceaccount.com`
(same as every other function here). It needs:

- `roles/datastore.user` — read/write `intake_files` and `staging_imports`
  (may already be granted from generate_import's setup).
- `roles/storage.objectAdmin` — generate_import only ever *reads* uploaded
  files (`objectViewer` was enough there); this function *writes* attachments
  into `intake/`, so it needs create/overwrite too.
- `roles/iam.serviceAccountTokenCreator` **on itself** — `_invoke_process_import`
  in main.py mints a Firebase custom token via `firebase_admin.auth.create_custom_token()`,
  which on Cloud Functions/Cloud Run signs via the IAM SignBlob API rather
  than a local private key; without this role that call fails with a
  permission error (surfaces as every auto-stage attempt landing in
  `intake_files` with `status: "error"`, not a hard crash — but nothing will
  auto-stage until this is granted):
  ```bash
  gcloud iam service-accounts add-iam-policy-binding \
    clarified-1501@appspot.gserviceaccount.com \
    --member="serviceAccount:clarified-1501@appspot.gserviceaccount.com" \
    --role="roles/iam.serviceAccountTokenCreator" \
    --project clarified-1501
  ```

Grant the storage/datastore roles once via Cloud Console or `gcloud
projects add-iam-policy-binding clarified-1501 --member=serviceAccount:clarified-1501@appspot.gserviceaccount.com --role=roles/storage.objectAdmin` (skip if already broader, e.g. `roles/editor`).

## 6. Confirm the impersonation account exists

`IMPERSONATE_EMAIL` (defaults to `sid@ops.clarified.in`, see main.py) must
already be a real signed-up Firebase Auth user — it's how this function
authenticates to `process_import` as an ops admin (see main.py's docstring
above `_invoke_process_import`). If Sid's account doesn't exist yet in
Firebase Auth, auto-staging will fail every time (again: degrades to
`intake_files.status = "error"`, never a crash) until it does.

## 7. Deploy the function

```bash
cd functions/email_intake

gcloud functions deploy process_intake_emails \
  --gen2 --runtime python312 --region asia-south1 \
  --source . --entry-point process_intake_emails \
  --trigger-http --no-allow-unauthenticated --project clarified-1501 \
  --memory 512MB --timeout 300s --max-instances 1 \
  --set-secrets GMAIL_INTAKE_CLIENT_ID=GMAIL_INTAKE_CLIENT_ID:latest,GMAIL_INTAKE_CLIENT_SECRET=GMAIL_INTAKE_CLIENT_SECRET:latest,GMAIL_INTAKE_REFRESH_TOKEN=GMAIL_INTAKE_REFRESH_TOKEN:latest
```

Note this folder needs its own copies of `normalize.py`/`tabular_parser.py`
(already committed here) — see the header comment in each for why, and keep
them in sync by hand if `functions/generate_import`'s originals change.

## 8. Create the invoker service account + Cloud Scheduler job

`--no-allow-unauthenticated` means only callers with `roles/run.invoker` on
the underlying Cloud Run service can hit this function — Cloud Scheduler
needs its own service account for that, it can't use the default one:

```bash
gcloud iam service-accounts create intake-scheduler-invoker \
  --display-name="Cloud Scheduler invoker for process_intake_emails" \
  --project clarified-1501

gcloud functions add-invoker-policy-binding process_intake_emails \
  --region asia-south1 --project clarified-1501 \
  --member="serviceAccount:intake-scheduler-invoker@clarified-1501.iam.gserviceaccount.com"

FUNCTION_URL=$(gcloud functions describe process_intake_emails --region asia-south1 --project clarified-1501 --format='value(serviceConfig.uri)')

gcloud scheduler jobs create http intake-email-poll \
  --schedule="*/5 * * * *" \
  --uri="$FUNCTION_URL" \
  --http-method=POST \
  --oidc-service-account-email="intake-scheduler-invoker@clarified-1501.iam.gserviceaccount.com" \
  --oidc-token-audience="$FUNCTION_URL" \
  --location=asia-south1 \
  --project clarified-1501
```

## 9. Verify

1. Send a test email with a small attachment (e.g. a one-row students xlsx)
   to the intake mailbox from an address NOT yet in any school's
   `intake_emails` — it should show up `unassigned` within 5 minutes.
2. Or trigger a run immediately instead of waiting:
   `gcloud scheduler jobs run intake-email-poll --location=asia-south1 --project clarified-1501`.
3. Check Cloud Functions logs for `process_intake_emails` for the run
   summary line (`{"messages": N, "staged": N, ...}`).
4. Check the **Intake** tab in the dashboard (ops-admin only) — the file
   should be listed; assigning it a school should trigger auto-stage if the
   attachment classified confidently, landing it in the existing Import
   review screen.
5. Check Cloud Storage under `intake/` and Firestore `intake_files` directly
   if anything looks off.

Nothing above needs repeating for new schools — once a sender's address is
in a school's `intake_emails` (whether added here, or learned automatically
the first time Sid assigns that sender in the Intake Queue), every future
email from them auto-matches.
