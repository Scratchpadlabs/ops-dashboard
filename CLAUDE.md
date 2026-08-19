# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

ClarifiEd's internal **ops dashboard**: a Vue 3 + Vite SPA (PrimeVue + Tailwind) plus a set of
Python Cloud Functions under `functions/`. It is the admin tool the ops team uses to run schools —
CRM (quotations, invoices, agreements, tasks), school onboarding/reset wizards, roster imports,
surveys, and the **School Setup** page that authors every school's teacher-app configuration.

It is NOT the app teachers or students use. Those are separate repos (see *Related repos*).

## Read these first

Substantial docs already exist. Prefer them over re-deriving from code:

| File | What it holds |
|---|---|
| `AUDIT.md` | Live Firestore schema dump (2026-08-04), per-collection shapes, and the real data problems. Findings are tagged `[LIVE]` / `[CODE]` / `[SPEC]` / `[INFERENCE]` — respect those tags. |
| `docs/school-setup-page-spec.md` | The School Setup contract, tab by tab. **§6 is the teacher-app consumption contract** — the thing not to break. |
| `functions/DEPLOY.md` | Every Cloud Function: what it does, why, and its exact deploy command. |

## Commands

```bash
npm run dev                 # Vite dev server
npm run build               # production build into dist/

# Python tests — run from inside each function folder (each has its own pytest.ini)
cd functions/shared          && python -m pytest        # class resolver, promotion, schema
cd functions/generate_import && python -m pytest
cd functions/school_reset    && python -m pytest
cd functions/assign_survey   && python -m pytest
python -m pytest tests/test_class_resolver.py::test_name -v      # a single test

# Cross-language parity — run BOTH halves; the .py writes fixtures the .mjs verifies
python3 tools/check_resolver_parity.py && node tools/check_resolver_parity.mjs
python3 tools/check_schema_parity.py   && node tools/check_schema_parity.mjs
node tools/check_derive_classes.mjs    # class derivation behaviour
node tools/check_remarks_import.mjs

# Read-only production inspection (needs application-default credentials)
python3 tools/class_inventory.py --project clarified-1501
python3 tools/check_archive.py --project clarified-1501
```

## Architecture

### Two Firestore trees, deliberately unlinked

This is the single most important thing to internalise.

- `operations/ops/{collection}` — the ops CRM. Helpers in `src/firebase/collections.js`.
- `schools/{schoolId}/{collection}` — the teacher/student app data. Helpers in
  `src/firebase/schoolCollections.js`. Here `schoolId` is a **human-readable school name**.

They are **different ID spaces with no join between them**. A school's CRM record and its academic
data cannot be matched programmatically. This is why the reset wizard refuses to clear the
Operations / Data-Receivable checklists — guessing the mapping would wipe the wrong school's data.

A few collections are global rather than school-scoped: `config_templates`, `staging_imports`,
`import_aliases`, `kb_entries`.

### Class resolution is the spine

Reading a student's class correctly is the load-bearing problem in this codebase — three
independent parsers once disagreed and took whole schools down with them.

- `functions/shared/` is a **single Python package**, imported (never copied) by
  `generate_import`, `school_reset` and `assign_survey`. It holds `class_resolver.py`,
  `promotion.py`, `school_schema.py`, `education_kb.json`.
- `gcloud functions deploy --source .` uploads one directory, so **deploy those three with
  `tools/deploy_function.sh <folder> <gcloud args…>`**, which stages the shared package into a
  throwaway tree. Never pass `--source`, never `cd` into the function folder. Functions with no
  shared code still deploy with plain `gcloud`.
- **Grades resolve to an ordinal** (`Pre-Nursery -3 … UKG 0, Grades 1–12`) so promotion is
  `ordinal + 1` and pre-primary needs no special case.
- **A school's own notation is preserved.** A school writing `VII` gets `VIII`; one writing `7`
  gets `8`. Never normalise across notations — it creates a parallel set of classes beside the
  real ones.

### Hand-ported twins (change both, always)

Several modules exist once in Python (server) and once in JS (browser) because both sides must
agree exactly. Changing one without the other is a real bug, and the parity checks above exist to
catch it:

- `functions/shared/class_resolver.py` ⟷ `src/utils/classResolver.js`
- `functions/shared/school_schema.py` ⟷ `src/schemas/schoolSchema.js`
- `functions/generate_import/education_kb.py` ⟷ `src/utils/educationKB.js`

All three read the **same** `functions/shared/education_kb.json` — Python opens it, Vite inlines
it. One vocabulary, so the deployed parser and the shipped bundle cannot disagree.

### Cloud Functions

Two calling styles, both in `src/utils/api.js`: Firebase **callables** (`httpsCallable`, for
anything touching Firestore — auth is verified server-side against an ops-admin allowlist) and
raw **fetch + `X-Api-Key`** for the stateless PDF generators. Callables must use region
`asia-south1` or every call fails as what looks like a CORS error.

`functions/generate_import` runs a four-rung ladder for classifying an unknown value: seed KB →
learned `kb_entries` overlay → fuzzy → LLM, and **only a human confirming writes to the overlay**.
The LLM is the last resort and never writes.

## Things that will bite you

- **Grade notation mismatch.** Class-to-subject matching is exact string equality on the ID prefix
  (`parseGrade(subject.id) === class.clazz`). The manual onboarding route mints Roman grades
  (`III_A`); the "from a student file" route preserves the school's own (`1_A`). A subject filed
  under a grade token no class uses can never attach, and the teacher app's subject dropdown —
  `classes.subjects[]` ∩ `assignments[classId]` — then comes back empty.
- **Temporal dead zone in `<script setup>`.** `watch(source, …)` evaluates its source *eagerly*, so
  declaring it above the `const` it watches throws during setup and renders the **whole page
  blank**. A `computed` next to it survives only because its getter is lazy. This has taken School
  Setup down before — keep watches below their dependencies.
- **SAMARTH is the reference school but is not clean.** It carries `{a: null}` bootstrap stubs, and
  its live sheets point at a placeholder term while its assessments point at `term1` — so the
  teacher app finds zero assessments for them. Do not derive a target schema by intersecting its
  docs; you will inherit the stubs. See `AUDIT.md` §1.5 and spec §7.
- **Students parked on sentinel class values** (`Sample`, `sample_middle`) are an intentional
  convention, not broken data. They must never be silently promoted, and exclusion is always a
  human decision — never inferred from a name.
- **Deploy flags are not read from decorators.** This repo deploys with `gcloud`, not
  `firebase deploy --only functions`, so `memory`/`timeout_sec`/`secrets` on the `@https_fn`
  decorators are inert. The gcloud flags in `DEPLOY.md` are what actually apply.
- **`firestore.indexes.json` is incomplete** — it declares only the assessments index. Reconcile it
  against the live set before `firebase deploy --only firestore:indexes`, or a deploy could propose
  removing an index the teacher app depends on.

## Related repos (not in this session)

`Scratchpad-Labs/scratchpad_teacher` and `Scratchpad-Labs/scratchpad_student` — the apps that
*consume* everything School Setup writes. They are treated as **read-only**; nothing here ever
commits to them. `.github/workflows/deploy-school.yml` builds and deploys them per school with the
school id injected at build time.

## To be filled in by the team

Referenced in code and docs but written down nowhere. Please complete:

- **The "golden rules".** Cited by number (`golden rule 2/3/4`) across `generate_import` and
  `DEPLOY.md`, never listed. From context: **2** = multiple teachers on the same
  (subject, grade, section) is valid; **3** = never extract Aadhaar/SSSM/caste/religion/address;
  **4** = secrets live only in Secret Manager. Rule 1 is unknown.
- **Which term is real in SAMARTH** — `term1`, or the auto-ID term its 8 sheets reference?
  (`AUDIT.md` Q1, still open, and it blocks fixing those sheets without losing marks.)
- **Which schools are live, and the grade notation each uses** (Roman vs numeric).
- **The four open questions in spec §9** — ops identity for `lastEditedBy`, whether
  playbooks/activities/avatars belong in Clone School, whether `stage` is a fixed enum.
- **Which School Setup tabs are actually used day to day**, and which have never been run.
