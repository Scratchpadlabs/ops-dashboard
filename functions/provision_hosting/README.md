# provision_hosting — one-time setup

Everything here is setup you do **once**. After it, provisioning a school's
hosting is a button in School Setup → Publish.

Fold the deploy commands into `functions/DEPLOY.md` when convenient — they live
here to keep this change self-contained.

---

## What you actually need, and what you don't

The feature has two halves, and **only the first is required**:

| | What it does | Needs |
| --- | --- | --- |
| **Hosting** | Creates the Hosting site, attaches the custom domain in Firebase, builds the teacher + student apps with the school id, deploys | Firebase credentials, a GitHub PAT |
| **DNS write** (opt-in) | Enters the records into Namecheap for you | Namecheap API access, a whitelisted static egress IP, a populated preserve list |

The Publish tab defaults to the first only. Firebase tells you which records it
wants and the UI prints them as a Host / Type / Value table to paste into
Namecheap → Domain List → Manage → Advanced DNS. The school is live on its
`.web.app` URL regardless; the custom domain starts serving whenever the records
land.

**If you are adding DNS by hand, skip sections 1 and 3 entirely, and drop
`--vpc-connector`, `--egress-settings` and the `NAMECHEAP_*` secrets from the
deploy commands in section 4.** Sections 2 (the GitHub PAT), 4 (deploy) and 5
(Actions secrets) are the whole prerequisite.

---

## 1. The static egress IP — only for the automatic DNS write

Skip this unless you want the function writing Namecheap for you.

Namecheap's API only answers requests from a **whitelisted IPv4**, and it checks
both the `ClientIp` parameter *and* the actual source address. Cloud Functions
egress from a rotating pool, so the function needs a pinned IP.

```bash
gcloud compute addresses create ops-egress-ip --region=asia-south1 --project=clarified-1501

gcloud compute networks vpc-access connectors create ops-egress \
  --region=asia-south1 --network=default --range=10.8.0.0/28 --project=clarified-1501

gcloud compute routers create ops-router \
  --region=asia-south1 --network=default --project=clarified-1501

gcloud compute routers nats create ops-nat \
  --router=ops-router --region=asia-south1 \
  --nat-custom-subnet-ip-ranges=ops-egress \
  --nat-external-ip-pool=ops-egress-ip --project=clarified-1501

gcloud compute addresses describe ops-egress-ip --region=asia-south1 \
  --format='value(address)' --project=clarified-1501
```

Take that address and:

1. Namecheap → Profile → Tools → Namecheap API Access → **Manage** → whitelist it.
   API access itself needs the account to hold 20+ domains, or $50 balance, or
   $50 spent in the last 2 years — check this before anything else.
2. Store it as the `NAMECHEAP_CLIENT_IP` secret below.

The functions must be deployed with `--vpc-connector ops-egress --egress-settings all`
or they will egress from the shared pool and Namecheap will reject them with
"Invalid request IP".

---

## 2. Secrets

```bash
for s in NAMECHEAP_API_KEY NAMECHEAP_API_USER NAMECHEAP_USERNAME \
         NAMECHEAP_CLIENT_IP GITHUB_DISPATCH_PAT; do
  gcloud secrets create "$s" --replication-policy=automatic --project=clarified-1501
done
# then, per secret:
printf '%s' 'VALUE' | gcloud secrets versions add NAMECHEAP_API_KEY --data-file=- --project=clarified-1501
```

`GITHUB_DISPATCH_PAT` needs `actions:write` on `Scratchpadlabs/ops-dashboard`
only — a fine-grained PAT scoped to that single repo. It does **not** need any
access to `scratchpad_teacher`; the workflow's own `CROSS_REPO_PAT` handles the
read-only checkout.

---

## 3. The DNS preserve list — only for the automatic DNS write

Skip this too if you are entering records by hand. It exists solely to protect
the zone from *our* writes; if we never write, there is nothing to protect
against.


Namecheap's `setHosts` replaces the **entire** zone, and `getHosts` does not
return records managed by Namecheap subsystems (Email Forwarding MX, URL
Redirects). A naive read-modify-write therefore deletes mail routing for
`myhpc.in` silently, with a 200 OK.

`namecheap_dns.py` is built to make that impossible, but one guardrail depends
on you: records the API cannot see must be declared so they are re-asserted on
every write.

Create `hosting_config/dns_preserve` in Firestore:

```json
{
  "records": [
    { "name": "@", "type": "MX",  "address": "mx1.example.net", "mxPref": "10" },
    { "name": "@", "type": "TXT", "address": "v=spf1 include:example.net ~all" }
  ]
}
```

Get the real values from the Namecheap dashboard (Domain List → Manage → Advanced
DNS, plus the Email Forwarding tab) **before** provisioning. `hosting_preview`
warns loudly when the list is empty.

### Rehearse against the sandbox

Set `NAMECHEAP_ENDPOINT=https://api.sandbox.namecheap.com/xml.response` and use
sandbox credentials for the first run. The sandbox is a separate account with its
own whitelist.

---

## 4. Deploy

### Hosting only (no Namecheap) — the shorter path

Nothing here depends on section 1 or 3. This is enough to make Publish work.

```bash
cd functions/provision_hosting

COMMON="--gen2 --runtime python312 --region asia-south1 --source . \
  --trigger-http --allow-unauthenticated --project clarified-1501"

gcloud functions deploy hosting_preview $COMMON \
  --entry-point hosting_preview --memory 512MB --timeout 120s --max-instances 3

gcloud functions deploy hosting_provision $COMMON \
  --entry-point hosting_provision --memory 512MB --timeout 300s --max-instances 2 \
  --set-secrets GITHUB_DISPATCH_PAT=GITHUB_DISPATCH_PAT:latest

gcloud functions deploy hosting_status $COMMON \
  --entry-point hosting_status --memory 256MB --timeout 60s --max-instances 5 \
  --set-secrets GITHUB_DISPATCH_PAT=GITHUB_DISPATCH_PAT:latest
```

Leaving the `NAMECHEAP_*` secrets unbound is safe: the credentials are only read
when a run is started with the DNS-write box ticked, and `NamecheapClient()`
refuses to construct without them rather than half-working.

### With the automatic DNS write

Requires sections 1 and 3 first.

```bash
cd functions/provision_hosting

COMMON="--gen2 --runtime python312 --region asia-south1 --source . \
  --trigger-http --allow-unauthenticated --project clarified-1501 \
  --vpc-connector ops-egress --egress-settings all"

NC="NAMECHEAP_API_KEY=NAMECHEAP_API_KEY:latest,\
NAMECHEAP_API_USER=NAMECHEAP_API_USER:latest,\
NAMECHEAP_USERNAME=NAMECHEAP_USERNAME:latest,\
NAMECHEAP_CLIENT_IP=NAMECHEAP_CLIENT_IP:latest"

gcloud functions deploy hosting_preview $COMMON \
  --entry-point hosting_preview --memory 512MB --timeout 120s --max-instances 3 \
  --set-secrets "$NC"

gcloud functions deploy hosting_provision $COMMON \
  --entry-point hosting_provision --memory 512MB --timeout 300s --max-instances 2 \
  --set-secrets "$NC,GITHUB_DISPATCH_PAT=GITHUB_DISPATCH_PAT:latest"

gcloud functions deploy hosting_status $COMMON \
  --entry-point hosting_status --memory 256MB --timeout 60s --max-instances 5 \
  --set-secrets GITHUB_DISPATCH_PAT=GITHUB_DISPATCH_PAT:latest
```

The service account these run as needs **Firebase Hosting Admin** on
`clarified-1501` to create sites and custom domains.

These endpoints create Hosting sites, edit live DNS and trigger deploys, so they
are gated — but the gate is `_require_ops_admin` **inside** `main.py`, which
verifies a Firebase ID token and checks the caller against `OPS_ADMIN_EMAILS`.
Keep that set in step with `src/config/opsAdmins.js`.

### Why `--allow-unauthenticated`, on endpoints that hold a GitHub PAT

Because it does not mean "public". It means "Cloud Run runs no IAM check of its
own", leaving the application's check as the only one — which is what we want,
and what the rest of `functions/` already does.

Deploying these `--no-allow-unauthenticated` instead does not add a second layer;
it makes the feature unreachable from a browser entirely, and it does so with an
error message that points at the wrong thing:

```
Access to fetch at '…/hosting_preview' from origin 'https://clarified-1501.web.app'
has been blocked by CORS policy: Response to preflight request doesn't pass access
control check: No 'Access-Control-Allow-Origin' header is present…
```

That is not a CORS misconfiguration. Two separate things are broken:

1. **The preflight is anonymous by specification.** Browsers never attach an
   `Authorization` header to the `OPTIONS` request. Cloud Run's IAM layer
   rejects it `403` before the container starts, so the `CorsOptions` in
   `main.py` never executes and no `Access-Control-Allow-Origin` header is ever
   emitted. The browser can only report the missing header.
2. **The token is the wrong kind anyway.** IAM wants a *Google-signed OIDC
   identity token* minted for the function's audience. The dashboard sends a
   *Firebase ID token* — a different credential from a different issuer, which
   can only be verified in-process by `fb_auth.verify_id_token`. Even past the
   preflight, every `POST` would be rejected `403`.

If you ever need platform-level auth here, the browser cannot be the caller: it
would have to go through a callable (`firebase-functions` `on_call`) or a
backend that can mint an OIDC token.

Verify a deploy is actually reachable before touching the UI — the preflight is
the thing to test, and it must come back `204` with the header:

```bash
curl -i -X OPTIONS \
  -H 'Origin: https://clarified-1501.web.app' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: authorization,content-type' \
  https://asia-south1-clarified-1501.cloudfunctions.net/hosting_preview
```

A `403` here is the IAM flag, every time. Then confirm the gate still bites — an
unauthenticated POST must be `401` **from the function**, with a JSON body:

```bash
curl -i -X POST -H 'Content-Type: application/json' -d '{}' \
  https://asia-south1-clarified-1501.cloudfunctions.net/hosting_preview
# {"error": "Missing bearer token"}
```

If that returns `403 Forbidden` with an HTML body, IAM answered, not the
function, and the origin allowlist never ran.

---

## 5. GitHub Actions secrets

`deploy-school.yml` (in this repo) needs:

| Secret | Purpose |
| --- | --- |
| `CROSS_REPO_PAT` | read-only checkout of `scratchpad_teacher` and `scratchpad_student` |
| `FIREBASE_SERVICE_ACCOUNT` | JSON key with Hosting deploy rights on `clarified-1501` |

---

## 6. Publishing a school that already has a site

Read this before the first run against a real school — it is the one place the
button can quietly do the wrong thing.

Schools onboarded by hand today go through the teacher repo: add a target to
`.firebaserc`, add a matching `hosting` entry to `firebase.json`, commit, then
run `deploy.yml` from the Actions tab. Publish replaces all of that — it
generates the Hosting config in the runner and never commits to the teacher repo
— but it has to be told **which Hosting site to deploy to**, and it defaults to a
site id derived from the Firestore school id.

Those two rarely agree. The sites created by hand are, from `.firebaserc`:

```
hillgreenhighschool   sds-teacher   sangamschool   symbiosis-prabhat
testapp-central       sse           SAMARTH DNYANPEETH SAHAYDRI
```

For a school doc id of `Hillgreen_Highschool`, the default site id is
`hillgreen-highschool` — **not** the existing `hillgreenhighschool`. Publishing
with the default would create a second site and deploy there, leaving the live
one untouched and the school apparently unchanged.

So: **for a school that is already live, type its existing site id into the
Hosting site id field.** The preview says `already exists, will be reused` when
you have it right, and warns when it is about to create a new site. Only take
the default for a genuinely new school.

(`SAMARTH DNYANPEETH SAHAYDRI` is not a legal Hosting site id — spaces and
capitals are not permitted — so that target could never have resolved to a real
site. It needs a real id before it can be published this way.)

---

## What this never does

Nothing in this feature writes to `Scratchpad-Labs/scratchpad_teacher`. No commit
to `schools.json`, `.firebaserc` or `firebase.json`. The workflow checks the repo
out read-only and generates its Hosting config inside the runner, which is then
discarded. The teacher repo's own `deploy.yml` is untouched and still works
exactly as before for the schools already configured there.

It also never writes DNS unless you tick the box. With that box clear, no
Namecheap call is made at all — not even a read.
