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
node tools/check_class_lookup.mjs      # how an import row finds its class
node tools/check_student_import_fields.mjs  # extra columns, schema growth, blank-cell rule
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
  `classes.subjects[]` ∩ `assignments[classId]` — then comes back empty. Subjects now offers the
  grade tokens the school's classes actually use, and warns on a mismatch, so this cannot be hit
  silently from that tab.
- **A roster file carrying the school's own student ids is a different import.**
  `STUDENT_HEADER_ALIASES` has a `student_id` key, and if ANY row in a file fills it,
  `buildStudentsPlan` switches to id mode for the whole file: each row updates the student
  already holding that id, an id nobody holds is an ERROR, and nothing is created. This is
  the register → authenticate → import flow, and it is why the plan also drops blank
  optional fields before writing — a merge that wrote `email: ''` would erase the address
  every auth account was created with. Columns the alias dictionary has no field for ride
  through as `extras` and become camelCase fields; `config/students_schema` is offered
  afterwards, as its own confirmation, never as part of the commit.

- **A file can name the class in one column or two.** Most exports carry `Class` +
  `Section`; some carry the whole class id in `Class` alone (`Play_Group_A`, `8_KALAM`).
  `STUDENT_HEADER_ALIASES` maps `class` onto `grade`, so the second shape reaches the
  matcher as grade `8_KALAM` with no section. `resolveClassId` (`src/utils/classLookup.js`)
  and `resolve_by_doc_id` (`generate_import/main.py`) try `(grade, section)` first and
  unchanged, then fold the value with `classIdKey`/`class_id_key` — the parity-checked twin
  in the resolver — against the real class doc ids. Both ends must keep agreeing, or the
  review screen warns about rows the commit then accepts.

- **"Always Roman" is an authoring rule, not a migration.** New classes and subjects are written
  in Roman. It does NOT license normalising a school that already holds numeric data: students
  carry `currentClassId`, the teacher app matches `students where currentClassId == classId`, and
  rewriting classes to `III_A` while students still say `1_A` orphans every one of them. The
  resolver's promotion path must keep preserving each school's existing notation — that rule
  exists because normalising mid-flight creates a parallel set of classes beside the real ones.
  Reconciling an existing numeric school is a deliberate, verified migration of classes AND
  students together, never a side effect.
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

## Domain model

```
school
 └── classes            (per section: III_A, III_B — grade is ALWAYS Roman)
      └── subjects[]    (references subjects/{id}, e.g. III_English)
           ├── topics            2–5 per subject
           └── curricular_goals  array of { "<goal>": ["<competency>", …] }
subjects/{id}
 └── subject_feedbacks   survey questions + options, per subject
```

`config/students_schema` must expose **every** field available for student data,
because it is what the import flow shows when a roster comes in from the app.
A field missing here is a field ops cannot map.

### Activity feedback — two systems, different field names

Verified against live SAMARTH data. Nothing in this repo read either collection
before, so these shapes were undocumented.

**`subject_feedbacks/{Grade}_{Subject}_{Term}`** — what the STUDENT (and a peer)
answers, e.g. `III_English_Term1`, `III_Maths_Optional`. Terms are
`Term1` / `Term2` / `Optional`.

```
{ id, isActive, questions: [ {
    answers: ["Yes","No","Maybe"],
    description:  "Think about if you were paying attention…",
    id:           "Prep-Awareness",        // {StagePrefix}-{Tag}
    is_peer:      null,                    // set for peer questions
    questionText: "Did I listen carefully when my teacher was giving instructions?",
    type:         "scq",
} ] }
```

Questions are per STAGE, not per subject — every subject at a stage carries the
same set. Tags are `AWARENESS`, `SENSITIVITY`, `CREATIVITY`, `NORMAL-1`,
`NORMAL-2`.

**Secondary asks the same questions as middle** (ops decided), so a secondary
document's question ids still read `Middle-…` — one question identity across
both stages rather than a parallel `Secondary-…` id for identical wording.
**Foundation has no question set yet.** The doc id is the SUBJECT's own doc id
plus the term, so it carries the school's spelling: `III_Maths_Term1`, not
`III_Mathematics_Term1`.

**`surveys/{id}`** — what the TEACHER answers about a learner. Paired 1:1 with
**`activities/{id}`** by a SHARED doc id; the activity holds `{id, name, stage}`.

```
{ id, clazzId, name, desc, card_desc, card_image, parameter,
  isLiveInternal, peer_survey,
  questions: [ {
    options:      ["Beginner (LOW)","Proficient (MEDIUM)","Advanced (HIGH)","Not Applicable"],
    questionText: "To what extent did the learner stay attentive…",
    summaryMap:   { "Beginner (LOW)": "…", "Proficient (MEDIUM)": "…", "Advanced (HIGH)": "…" },
    tag:          "AWARENESS",
} ] }
```

Note the collections disagree on names for the same ideas — `answers` vs
`options`, `description` vs `summaryMap`, `id` vs `tag`. Do not write one
shape into the other.

`summaryMap` text is authored per ACTIVITY, not per stage, so teacher surveys
cannot be generated from a stage template the way `subject_feedbacks` can.

## Team decisions (answered — do not re-litigate)

- **Grades are written in Roman numerals. Always, everywhere.** `III_A`, not `3_A`.
  This is the house convention for authoring classes and subjects, and it is what
  makes `parseGrade(subject.id) === class.clazz` line up in
  `ClassesTeachersTab`. See the caveat in *Things that will bite you* — it does not
  license rewriting an existing school's data.
- **`SAMARTH DNYANPEETH SAHAYDRI` is the reference school.** Treat its structure as
  the real deal. It is still not pristine — see `AUDIT.md` §1.5 — so clean before
  copying, and never derive a schema by intersecting its docs.
- **`term1` is the real term in SAMARTH.** This answers `AUDIT.md` Q1. The 8
  `smart_sheet_entries` pointing at `63Zyu8RKgSts5VzToD2e` are therefore **wrong and
  must be repointed to `term1`, never deleted** — they hold entered marks. The
  Overview hygiene panel only offers Delete today, which is the wrong action here.
- **Playbooks and activities are copied to every new school.** This answers spec §9
  Q3; they are default-on in Clone School. Avatars stay opt-in — not confirmed.
- **Nobody works the dashboard daily.** School Setup is an onboarding-time tool;
  ongoing writes come from teacher/student activity in the apps. So a bug here is
  discovered late, by a teacher, not by ops — which is the argument for guardrails
  in the UI over documentation.

## What the teacher app reads

It is the consumer of nearly everything School Setup writes: **subjects, survey
questions, smart-sheet entries, term details, grading scales** — the whole data-entry
surface. Spec §6 holds the exact contract. Two consequences worth remembering:

- The subject dropdown for a class is `classes/{id}.subjects[]` ∩ `staffs.assignments[classId]`.
  Either side empty ⇒ the teacher sees nothing at all.
- Assessment columns come from `assessments where termId == X && subjectId == Y`.
  No match ⇒ "No assessments configured for the selected term and subject."

## Still to be filled in by the team

- **The "golden rules".** Cited by number (`golden rule 2/3/4`) across `generate_import` and
  `DEPLOY.md`, never listed. From context: **2** = multiple teachers on the same
  (subject, grade, section) is valid; **3** = never extract Aadhaar/SSSM/caste/religion/address;
  **4** = secrets live only in Secret Manager. Rule 1 is unknown.
- **The remaining spec §9 questions** — ops identity for `lastEditedBy`, and whether
  `stage` is a fixed enum.
- **Whether any live school stores grades numerically.** The Roman rule is now the
  convention for authoring; whether legacy data already violates it is unverified, and
  it decides whether a migration is needed.
