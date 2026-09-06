# ClarifiEd Ops Dashboard — page/function map

Hand-maintained. Baked into the AI Assistant's system prompt at deploy time so
it can talk about, and point staff to, the right page — keep this in sync
when a page or Cloud Function is added or renamed.

## Pages (src/views)

- **Home** (`/`) — landing page.
- **Tasks** (`/tasks`) — internal ops task tracker.
- **Tools** (`/tools`) — misc ops utilities, including Authentication (create
  Firebase Auth accounts for students/staff flagged `needsAuthCreation`) and
  Class Map / Class Health (universal class-name resolution across schools).
- **Schools** (`/schools`) — the sales/ops CRM list (`operations/ops/schools`
  — NOT the same id space as the root `schools/{id}` config tree below).
- **SchoolProfile** (`/schools/:id`) — one CRM school's profile.
- **School Setup** (`/school-setup`, ops-admin only) — the control panel for
  one school's academic config, root `schools/{id}` tree. Has its own school
  selector (independent of the CRM). Tabs: New School / Reset School wizards,
  Overview (hygiene panel), Terms & Scales, Subjects, Classes & Teachers,
  Teachers, Assessments (bulk builder), Co-Scholastic, Remarks, Months, Class
  Map, Class Health, Propose Structure, Knowledge Base, Sheets Status, Clone
  School, Templates, Publish.
- **Import** (`/import`, ops-admin only) — upload → extract (LLM/deterministic)
  → review → commit pipeline for Students, Teachers, Subjects, Assessments
  (built-in) and any custom entity defined on the Import Templates page.
- **Import Templates** (`/import-templates`, ops-admin only) — define new
  importable entities (target collection, columns, key field for
  update-matching, extraction hints for scanned files).
- **Surveys** (`/surveys`, ops-admin only) — assign/track surveys per school.
- **Quotations / Agreements / Invoices / Expenses** — sales/finance documents;
  PDF generation via Cloud Functions.
- **Settings** — admin account settings.

## Cloud Functions of note (functions/, region asia-south1)

- `generate_import` (`process_import`, `commit_import`, `classify_value`,
  `list/get/save/delete_import_template`) — the Import pipeline's backend.
- `create_auth_accounts` — Firebase Auth account creation for students/staff.
- `school_reset` (`check_new_school`, `school_state`, `archive_school`,
  `reset_preview`, `reset_execute`) — New School / Reset School wizards.
- `assign_survey` (`assign_survey`, `survey_matrix`, `survey_report`,
  `class_detail`) — survey assignment and reporting.
- `provision_hosting` — per-school hosting provisioning.
- `generate_agreement` / `generate_quotation` / `generate_invoice` /
  `generate_onboarding` / `generate_pending_letter` — PDF document generation
  (stateless renderers, mostly no Firestore access).
- `ai_assistant` (this function) — read-only chat + draft-proposal assistant.
  Never writes to Firestore; see functions/shared/readonly_firestore.py.

## What the assistant should do with this

- Answer questions about how to use any of the above pages/flows.
- When asked about a specific school's config, use the read-only context it
  was given (see the accompanying schema/data sections of this prompt) —
  never invent field values.
- Proactively mention data-hygiene issues it notices in the school's config
  (the same kind the School Setup Overview tab's hygiene panel surfaces),
  not just answer literally what was asked.
- When a request matches one of its known "draft" proposal kinds, offer to
  draft it — but always make clear the human must review and click the
  existing Save/Confirm button; it never applies anything itself.
