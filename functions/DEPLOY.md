# Cloud Functions — Deploy Guide

## ai_assistant (NEW — read-only chat/draft-proposal panel)

Backs the AI Assistant panel (`src/components/AiAssistantPanel.vue`, header
button in `src/App.vue`). Structurally read-only — see `main.py`'s module
docstring and `functions/shared/readonly_firestore.py`. It never writes to
Firestore and `firestore.rules` is never touched by this feature.

Before deploying, always re-run the guardrail check:
```
grep -nE '\.(set|update|add|delete)\(' functions/ai_assistant/main.py functions/ai_assistant/readonly_firestore.py
```
This must return nothing (a match against the docstring's own mention of the
pattern is expected and fine — only a real `.set(`/`.update(`/`.add(`/
`.delete(` call site is a problem).

Uses the same `ANTHROPIC_API_KEY` Secret Manager secret already bound to
`generate_import`/`generate_pending_letter` — no new secret to create.

### Deploy:
```
cd functions/ai_assistant

gcloud functions deploy ai_assistant \
  --gen2 --runtime python312 --region asia-south1 \
  --source . --entry-point ai_assistant \
  --trigger-http --allow-unauthenticated --project clarified-1501 \
  --memory 512MB --timeout 60s --max-instances 3 \
  --set-secrets ANTHROPIC_API_KEY=ANTHROPIC_API_KEY:latest
```

Fast-follow (not blocking v1): split this function's runtime service account
out with `roles/datastore.viewer` only, as defense-in-depth beyond the
code-level read-only guarantee above, if the project's IAM setup allows
separating it from the broader grant other functions run under.

---

## create_auth_accounts (NEW)

Replaces the two local one-off scripts (createAuthAccountsForStudents.js /
createAuthAccountsForTeachers.js) that were run by hand against a
`serviceAccountKey.json`, hardcoded to one school. Because those never lived
in a repo, the accounts they created for that one school were the only trace
of them — this is the same logic as a proper callable, parameterized by
`schoolId`, wired to the Authentication tab on the Tools page
(`src/components/tools/AuthAccountsTool.vue`).

One callable: `create_auth_accounts`. Takes `{schoolId, roles, dryRun}` —
`roles` defaults to `["students", "staffs"]`, `dryRun` previews exactly who
would be touched without creating anything or writing to Firestore. Creates a
Firebase Auth account (email + a password derived from the Firestore document
id — see main.py's module docstring for why, not the same-named `id` field
the original scripts used) for every student/staff doc with
`needsAuthCreation == true`, then marks the doc `needsAuthCreation: false` and
stamps `authUid`. An account that already exists is treated as success (uid
looked up, doc still marked done) so re-running after a partial failure is
safe.

### Files needed in the folder:
- main.py ✅
- requirements.txt ✅

### Deploy:
```
cd functions/create_auth_accounts

gcloud functions deploy create_auth_accounts \
  --gen2 --runtime python312 --region asia-south1 \
  --source . --entry-point create_auth_accounts \
  --trigger-http --allow-unauthenticated --project clarified-1501 \
  --memory 512MB --timeout 300s --max-instances 3
```

No secrets and no new IAM beyond what the runtime service account already
has (`roles/editor` covers Firestore; Firebase Auth admin operations are
available to the Admin SDK by default on this project). `--allow-unauthenticated`
is required at the IAM layer even though this is a callable — the function
itself verifies `req.auth` against `OPS_ADMIN_EMAILS` before doing anything,
same pattern as `school_reset`'s wizards. Keep that allowlist in sync with
`src/config/opsAdmins.js`.

---

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

## assign_survey + survey_matrix + survey_report + class_detail (survey management)

Day-to-day ops. The UI is a CLASS-first matrix (classes as rows, surveys as
columns): select any set of cells — drag a range, click a row header for a
whole class, a column header for a whole survey — and assign or unassign all
of it as ONE run. Plus downloadable completion/pending reports.

Server-side because the task requires it at scale: a 3000-student school is
3000 reads plus an id-only pass per survey, and up to several batched writes
(chunked at 450), which must not depend on a browser tab staying open.

- `assign_survey` — preview OR apply, same call with `dryRun` flipped, so the
  count on the confirm button is exactly what happens. Takes `surveyIds` (a
  LIST) so N surveys x M classes is one run with one audit entry. Uses
  arrayUnion / arrayRemove only: re-assigning never duplicates, unassigning
  never touches a record that doesn't have the survey. Refuses to ASSIGN a
  junk/test survey doc while still allowing unassign, so ids the old scripts
  pushed can be cleaned up. Never writes to survey documents, never deletes.
- `survey_matrix` — the whole grid in one call: per-cell assigned/responded/
  total, class rows sorted in grade order. Cached to
  `survey_matrix_cache/current`; `force` recomputes.
- `survey_report` — class-wise / survey-wise / cumulative reports as CSV or
  XLSX, respecting the caller's active filters and stating scope + filters +
  timestamp in a header row. Returned inline as base64 (tens to low hundreds
  of KB even at 3000 students) rather than parked in Storage.
- `class_detail` — one class's students plus who among them responded, for
  the matrix drill-down. Bounded by class size, not school size.

### Files needed in the folder:
- main.py ✅
- survey_rules.py ✅ (pure decision logic + matrix, unit-tested)
- survey_reports.py ✅ (pure report row builders, unit-tested)
- requirements.txt ✅ (includes openpyxl for XLSX)

### Deploy:
```
cd functions/assign_survey

gcloud functions deploy assign_survey \
  --gen2 --runtime python312 --region asia-south1 \
  --source . --entry-point assign_survey \
  --trigger-http --allow-unauthenticated --project clarified-1501 \
  --memory 512MB --timeout 540s --max-instances 3

gcloud functions deploy survey_matrix \
  --gen2 --runtime python312 --region asia-south1 \
  --source . --entry-point survey_matrix \
  --trigger-http --allow-unauthenticated --project clarified-1501 \
  --memory 1024MB --timeout 300s --max-instances 3

gcloud functions deploy survey_report \
  --gen2 --runtime python312 --region asia-south1 \
  --source . --entry-point survey_report \
  --trigger-http --allow-unauthenticated --project clarified-1501 \
  --memory 1024MB --timeout 300s --max-instances 3

gcloud functions deploy class_detail \
  --gen2 --runtime python312 --region asia-south1 \
  --source . --entry-point class_detail \
  --trigger-http --allow-unauthenticated --project clarified-1501 \
  --memory 512MB --timeout 120s --max-instances 3
```

No secrets and no new IAM: these are plain Firestore readers/writers, covered
by the runtime service account's existing `roles/editor`. No firestore.rules
change either — the Admin SDK bypasses rules and the dashboard only reads.

**Response attribution:** completion is derived from
`surveys/<id>/responses`, read with `select([])` so only document ids move,
and a responder is identified by the response doc id (falling back to
`studentId`/`student_id`/`uid` fields). A survey whose responses can't be
attributed is reported in `unresolved_response_surveys` and rendered as "—",
never as a misleading zero. If that list is non-empty for a survey you know
has responses, check what the response doc ids actually look like.

**BEFORE THE FIRST STAFF RUN:** the staff inbox field name is an assumption.
Students use `surveyInbox` (verified); nothing in this repo reads a staff
inbox, so staff mirrors it. The preview reports how many targeted records
actually carry the field — if it says "0 of N", stop and confirm the real
field name, then pass it as `inboxField`. Student assignment is unaffected.

---

## school_state + archive_school + reset_preview + reset_execute + check_new_school (NEW — setup wizards)

Backs the **New School** and **Reset School** wizards on the School Setup
page. Five callables in one `functions/school_reset` source folder.

**Read this before deploying:** there is NO academic-year field anywhere in
the school tree, and the teacher/student apps do not version data by year.
A "reset" is therefore an **in-place mutation of live data** — promoting
students to the next grade, clearing survey inboxes, and so on. Nothing is
copied to a new year because there is no year to copy to. That is why the
archive step exists and why it is not optional.

- `check_new_school` — validates a proposed doc id and warns about
  near-duplicate school names before one more "Samartha School" /
  "samarthaschool" pair gets created. Reads only; the wizard still lets you
  proceed past a warning deliberately.
- `school_state` — current counts (students, classes, staff, subjects, terms,
  surveys, sheet entries, how many students carry an inbox or reports).
  Reads only. Used by both wizards.
- `archive_school` — snapshots students, classes, smart_sheet_entries and
  survey responses to `archives/{schoolId}__{label}`, then **re-reads the
  copy and compares row counts**. Writes only to `archives/` — it cannot
  touch a school document. `label` names the session, e.g. `2025-26`, so
  re-archiving the same session overwrites that snapshot instead of piling
  up copies.
- `reset_preview` — the itemized diff: who is promoted, who graduates, who
  can't be mapped, what gets cleared. Reads only; this function has no write
  path at all.
- `reset_execute` — the only one that can modify live school data, behind
  three gates enforced server-side rather than trusted to the UI:
  1. an `archiveId` whose counts the function re-verifies itself,
  2. `confirmSchoolId` echoed back exactly, and
  3. `dryRun`, which produces the full run log and writes nothing.
  Writes are batched at 450 and each student's changes are merged into ONE
  write. Graduating and leaving students are marked inactive, never deleted.
  Every run is logged to `schools/{id}/resets/{runId}`.

### Files needed in the folder:
- main.py ✅
- reset_rules.py ✅ (pure promotion/diff/id logic, 44 unit tests)
- requirements.txt ✅

### Deploy:
```
cd functions/school_reset

gcloud functions deploy check_new_school \
  --gen2 --runtime python312 --region asia-south1 \
  --source . --entry-point check_new_school \
  --trigger-http --allow-unauthenticated --project clarified-1501 \
  --memory 512MB --timeout 60s --max-instances 3

gcloud functions deploy school_state \
  --gen2 --runtime python312 --region asia-south1 \
  --source . --entry-point school_state \
  --trigger-http --allow-unauthenticated --project clarified-1501 \
  --memory 512MB --timeout 120s --max-instances 3

gcloud functions deploy archive_school \
  --gen2 --runtime python312 --region asia-south1 \
  --source . --entry-point archive_school \
  --trigger-http --allow-unauthenticated --project clarified-1501 \
  --memory 1024MB --timeout 540s --max-instances 3

gcloud functions deploy reset_preview \
  --gen2 --runtime python312 --region asia-south1 \
  --source . --entry-point reset_preview \
  --trigger-http --allow-unauthenticated --project clarified-1501 \
  --memory 1024MB --timeout 300s --max-instances 3

gcloud functions deploy reset_execute \
  --gen2 --runtime python312 --region asia-south1 \
  --source . --entry-point reset_execute \
  --trigger-http --allow-unauthenticated --project clarified-1501 \
  --memory 1024MB --timeout 540s --max-instances 3
```

No secrets and no new IAM — plain Firestore readers/writers under the runtime
service account's existing `roles/editor`.

### firestore.rules
Two new top-level collections, both in `firestore.rules`:
- `setup_wizard_runs/{runId}` — ops-admin read/write. Written by the BROWSER
  as each wizard step completes, which is what makes a half-finished setup
  resumable after closing the tab. Top-level rather than under a school
  because the New School wizard starts a run before the school exists.
- `archives/{archiveId}/**` — ops-admin **read, write denied outright**.
  Written only by `archive_school` via the Admin SDK, which bypasses rules.
  Client writes are denied rather than granted because `reset_execute`
  treats archive counts as proof; nothing in the UI should be able to edit
  the thing it verifies against.

`schools/{id}/resets` is deliberately absent from the writable-collection
list on the `schools/{schoolId}/{collection}/{docId}` rule, so the audit log
can be read but not forged from the client.

### scan_classes + save_class_map + class_health (universal class resolution)

Three more callables in the SAME `functions/school_reset` folder, so they
deploy from the same source directory:

```
cd ~/ops-dashboard/functions/school_reset

gcloud functions deploy scan_classes \
  --gen2 --runtime python312 --region asia-south1 \
  --source . --entry-point scan_classes \
  --trigger-http --allow-unauthenticated --project clarified-1501 \
  --memory 1024MB --timeout 300s --max-instances 3

gcloud functions deploy save_class_map \
  --gen2 --runtime python312 --region asia-south1 \
  --source . --entry-point save_class_map \
  --trigger-http --allow-unauthenticated --project clarified-1501 \
  --memory 512MB --timeout 120s --max-instances 3

gcloud functions deploy class_health \
  --gen2 --runtime python312 --region asia-south1 \
  --source . --entry-point class_health \
  --trigger-http --allow-unauthenticated --project clarified-1501 \
  --memory 1024MB --timeout 540s --max-instances 2
```

- `scan_classes` — resolves every DISTINCT class value in a school's roster
  and proposes grade + section per value. READ-ONLY. Returns a few dozen rows
  even for a 3000-student school.
- `save_class_map` — the only writer. Writes to `schools/{id}/class_map`
  only, never to a student document, and stamps `confirmed_by`/`confirmed_at`.
  Also feeds confirmed grade corrections back to `import_aliases` so the next
  school with the same odd value resolves without anyone confirming it again.
- `class_health` — read-only resolution report across every active school;
  the in-app twin of `tools/class_inventory.py`.

**IMPORTANT — `functions/shared` is mirrored, not imported.** `gcloud
functions deploy --source .` uploads one folder, so `class_resolver.py`,
`promotion.py` and `education_kb.json` are COPIES kept in step by
`tools/sync_shared.py`. Before deploying, always:

```
python3 tools/sync_shared.py            # copy canonical -> function folders
python3 tools/sync_shared.py --check    # verify (exit 1 on drift)
```

A test in each function folder (`tests/test_shared_sync.py`) fails on drift,
so a stale copy cannot reach production silently. Editing the copy instead of
`functions/shared/` is the mistake to avoid — the sync overwrites it.

### Students deliberately parked outside the app

Some students carry a meaningless class value ("Sample", "sample_middle") so
they cannot reach the app. That is an intentional convention, not broken data,
and it must not stop a reset — 153 students across the estate were in this
state when the resolver was built.

Mark those values as **Exclude** in the Class Map tab. Excluded students are
then reported as `unchanged / excluded from the app by class value`: never
promoted, never counted as unmapped, and they do not trigger the hard block.

Exclusion is ALWAYS a confirmed decision. `scan_classes` will *suggest* it for
values that look like parking sentinels (sample/test/demo/dummy…), but nothing
is excluded until someone ticks the box — otherwise a genuine class called
"Sample House" would silently vanish. Exclusions are also never shared to
`import_aliases`: they are per-school parking values, not grade spellings.

### Verifying the estate before and after

```
pip install --quiet google-cloud-firestore
python3 tools/class_inventory.py --project clarified-1501            # all schools
python3 tools/class_inventory.py --project clarified-1501 --school NAVODAYA
```

Read-only; it constructs no write path at all. Prints the per-school field
inventory (which class fields exist and sample values) and the class-health
table (how many students resolve, how many are unmapped, whether a confirmed
class map exists).

Cross-language drift between `class_resolver.py` and `classResolver.js`:

```
python3 tools/check_resolver_parity.py && node tools/check_resolver_parity.mjs
```

### What the reset deliberately CANNOT do
The Operations and Data-Receivable checklists are **not** resettable from this
wizard, and this is not an oversight. They live in the ops CRM tree
(`operations/ops/school_operations/<id>`, `.../school_data_receivable/<id>`),
keyed by the **ops CRM school doc id** — a different id space from the root
`schools/<id>` the reset operates on, with no link between the two trees.
Offering the option would mean guessing which CRM school matches, and a wrong
guess silently clears a different school's delivery checklist. Reset those
from that school's profile page, where the id is unambiguous.

`build_reset_diff` will not echo an option it cannot perform (there is a test
for this), so the preview can never claim an effect `reset_execute` doesn't
deliver. If these are ever wired up, add them to BOTH the diff and
`reset_execute`, and resolve the CRM id explicitly.

### FIRST RUN — do this on TEST_SCHOOL
The Reset wizard has a **dry run** toggle on the execute step. Use it:
1. Run the whole wizard against `TEST_SCHOOL` with dry run ON. Read the run
   log — it lists every intended write.
2. Repeat with dry run OFF on TEST_SCHOOL and check the post-reset counts.
3. Only then run it on a real school, and re-read the preview before
   confirming. The archive is what makes step 3 recoverable.

The inbox field assumption from the survey section applies here too:
clearing survey inboxes targets `surveyInbox`. The preview reports how many
students actually carry the field — if it says 0 of N on a school you know
has assignments, stop and confirm the field name before executing.

---

## classify_value (NEW — education knowledge base LLM fallback)

Third callable in the `generate_import` source folder. Classifies ONE
unrecognized value — "is this a scholastic subject, a co-scholastic area, a
grade, a section, or something else?" — for the Smart School Setup knowledge
base.

It is the LAST rung of a four-rung ladder, and the other three cost nothing:

1. `education_kb.py` / `src/utils/educationKB.js` answer deterministically
   from the shared seed (`education_kb.json`) plus the learned `kb_entries`
   overlay. This handles the overwhelming majority.
2. Only an `unknown` result reaches this function, once per value.
3. The answer is returned as a **suggestion**. This function NEVER writes to
   Firestore.
4. A human confirming that suggestion writes `kb_entries/{canonicalValue}`
   client-side — and from then on rung 1 answers it forever. Confirmed
   "other" answers are cached too, precisely so the model is never asked
   about that value again.

Shares the `OPENAI_API_KEY` secret and provider switch with `process_import`
(Anthropic works as a fallback provider if `ANTHROPIC_API_KEY` is bound
instead). If no model is reachable it returns `type: "unknown"` with a reason
rather than a guess — the UI then just asks the human to pick the type.

### Deploy:
```
cd functions/generate_import

gcloud functions deploy classify_value \
  --gen2 --runtime python312 --region asia-south1 \
  --source . --entry-point classify_value \
  --trigger-http --allow-unauthenticated --project clarified-1501 \
  --memory 512MB --timeout 60s --max-instances 3 \
  --set-secrets OPENAI_API_KEY=OPENAI_API_KEY:latest \
  --set-env-vars MODEL=gpt-4o-mini
```

**`education_kb.json` must be deployed with this folder** — it is the single
seed file the browser bundle imports too (`src/utils/educationKB.js`), which
is exactly why it lives here rather than in `src/`: `--source .` picks it up
automatically, so the deployed parser and the shipped frontend can never
disagree about what a subject is. Redeploy `process_import` as well after
editing it, since its cleaning stage reads the same file.

Firestore: `kb_entries` is a new top-level collection (ops-admin read/write,
see firestore.rules). No IAM changes — the runtime service account's existing
`roles/editor` already covers it.

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

## list_import_templates + get_import_template + save_import_template + delete_import_template (NEW)

Four more callables in the SAME `functions/generate_import` source folder,
backing the "Manage Templates" screen (`src/views/ImportTemplates.vue`) that
`Import.vue` links to. Deliberately callable-only, never a direct Firestore
read/write from the browser — see `import_templates.py`'s module docstring
for why `import_templates` has no `firestore.rules` entry at all.

256MB is not enough here: the first deploy of `list_import_templates` failed
Cloud Run's startup health check because every function in `main.py` pays
for the module's top-level imports (firebase_admin, openpyxl, python-docx,
xlrd, requests) regardless of which entry point is deployed, and those
didn't finish before the probe timeout at 256MB. Deploy at 512MB, same as
`commit_import`.

### Deploy:
```
cd functions/generate_import

gcloud functions deploy list_import_templates \
  --gen2 --runtime python312 --region asia-south1 \
  --source . --entry-point list_import_templates \
  --trigger-http --allow-unauthenticated --project clarified-1501 \
  --memory 512MB --timeout 30s --max-instances 3

gcloud functions deploy get_import_template \
  --gen2 --runtime python312 --region asia-south1 \
  --source . --entry-point get_import_template \
  --trigger-http --allow-unauthenticated --project clarified-1501 \
  --memory 512MB --timeout 30s --max-instances 3

gcloud functions deploy save_import_template \
  --gen2 --runtime python312 --region asia-south1 \
  --source . --entry-point save_import_template \
  --trigger-http --allow-unauthenticated --project clarified-1501 \
  --memory 512MB --timeout 30s --max-instances 3

gcloud functions deploy delete_import_template \
  --gen2 --runtime python312 --region asia-south1 \
  --source . --entry-point delete_import_template \
  --trigger-http --allow-unauthenticated --project clarified-1501 \
  --memory 512MB --timeout 30s --max-instances 3
```

No secrets, no firestore.rules change (see above), no new IAM — plain
Firestore reads/writes under the runtime service account's existing
`roles/editor`.

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
