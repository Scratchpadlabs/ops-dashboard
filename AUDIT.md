# ClarifiEd Ops Dashboard — System Audit

**Date:** 2026-08-04 · **Repo:** `main` @ `50aeab5` · **Project:** `clarified-1501`
**Mode:** read-only. No code changed, no Firestore write path opened.
**Live data:** schema dump of 6 schools (SAMARTH + 5 old), 25-doc sample per collection.

---

## THE HEADLINE

**The old→new migration is not a data transformation. It is config authoring.**

`students`, `classes`, `staffs` and `subjects` are already **structurally identical** across old
and new schools — same doc-ID conventions, same field names, same nested shapes. What old schools
lack is the entire **assessment/config layer**, which simply does not exist for them:

| Collection | SAMARTH | A K CSchool | Aravali | Carmel | GK Gurukul | Purandar |
|---|---|---|---|---|---|---|
| `terms` | **2** | – | – | – | – | – |
| `grading_scales` | **2** | – | – | – | – | – |
| `assessments` | **2** | – | – | – | – | – |
| `co_scholastic_activities` | **2** | – | – | – | – | – |
| `remark_categories` | **2** | – | – | – | – | – |
| `months` | **2** | – | – | – | – | – |
| `smart_sheet_entries` | **8** | – | – | – | – | – |
| `attendance_sheets` | **7** | – | – | – | – | – |
| `remarks_sheets` | **2** | – | – | – | – | – |
| `config` | 3 | – | – | – | 2 (unrelated) | – |
| `students` | 756 | 196 | 999 | 1949 | 731 | 228 |
| `classes` | 23 | 12 | 32 | 44 | 20 | 13 |
| `staffs` | 35 | 14 | 46 | 96 | 51 | 16 |
| `subjects` | 64 | 71 | 65 | 54 | 23 | 64 |
| `surveys` | 97 | 154 | 91 | 98 | 65 | 154 |

There is **no old schema to convert from**. There is a *missing* schema to author. That makes this
far lower-risk than a rename-and-backfill migration — and it moves the real risk somewhere else
(see the next two findings).

**Two things genuinely are broken, and neither is what the brief assumed:**

1. **`currentClassId` contains garbage in production** — including *student IDs stored as class
   IDs* in 2 of 5 old schools. This is the one true data-quality migration. §2.3.
2. **The reference school has broken referential integrity** — its live sheets point at a
   placeholder term, not at `term1` where its assessments live. SAMARTH is not a clean template. §1.5.

---

## Provenance key

| Tag | Meaning |
|---|---|
| **[LIVE]** | Observed in the 2026-08-04 dump. Sample = 25 docs/collection unless noted. |
| **[CODE]** | Read from this repo. |
| **[SPEC]** | From `docs/school-setup-page-spec.md`. |
| **[INFERENCE]** | My reasoning. Flagged wherever it drives a recommendation. |

**Sampling caveat that matters:** field presence is out of 25 sampled docs, so a field on
doc #400 is invisible here. One confirmed instance: the co-scholastic dry-run found **154 subjects
docs carrying `area`**, yet `area` appears on **zero** sampled subjects in any school. Both are
true — `area` is on recently-imported docs outside the sample. Treat "field absent" as "absent
from the first 25", not "absent".

---

## 1. NEW SCHEMA — `schools/SAMARTH DNYANPEETH SAHAYDRI` **[LIVE]**

### 1.1 Root doc
`{ id: string, name: string, isActive: bool }` — doc ID **is** the school name.
The redundant `id` field can disagree with the doc ID; `SchoolSetup.vue:263` defeats this
deliberately **[CODE]**. Doc ID is truth.

### 1.2 Config layer (exists ONLY here)

| Collection | Docs | Doc IDs | Fields **[LIVE]** |
|---|---|---|---|
| `terms` | 2 | `term1`, `63Zyu8RKgSts5VzToD2e` | `name`, `academicYear` ("2025-26"), `isActive`, **`a`** (1/2) |
| `grading_scales` | 2 | `standard_scale`, `uVzjbXmHaUsIx1SQ2953` | `name`, `levels[{label,minPercent,maxPercent}]`, **`a`** (1/2) |
| `assessments` | 2 | `assessment1`, `assessment2` | `name`, `termId`, `subjectId`, `order`, `entryType`, `maxMarks`, `gradingScaleId`, `conversionType`, `conversionFactor`, **`a`** (1/2) |
| `co_scholastic_activities` | 2 | `csa1`, `Pk6PNs1fu0I7gqMPgm15` | as assessments minus `subjectId`; **`a`** (2/2 — *including* `csa1`) |
| `remark_categories` | 2 | `remark1`, `remark2` | `label`, `order`, `remarks[{key,text,type,order}]` |
| `months` | 2 | `april26`, `march26` | `key` ("2026-04"), `label`, `month`, `year`, `order`, `workingDays` |
| `config` | 3 | `students_metadata`, `students_schema`, `teachers_schema` | `columns[{key,label,type,order,editable}]`, `lastEditedAt/By/ByName` |

### 1.3 Roster layer (identical in every school — see §2)
`students` (756), `classes` (23), `staffs` (35), `subjects` (64). Shapes in §2.2.

### 1.4 Sheet layer (exists ONLY here)

| Collection | Docs | Shape |
|---|---|---|
| `smart_sheet_entries` | 8 | `classId`, `termId`, `subjectId` (6/8), `type` (2/8 = "co-scholastic"), `isFrozen`, `lastEditedAt/By` + `entries/` |
| ↳ `entries/{studentId}` | – | `{ assessment1: number\|string, assessment2: … }` — **keyed by assessment doc ID** |
| `attendance_sheets` | 7 | `classId`, `type` ("month-wise"), `month`, `workingDays{}`, `isFrozen` + `entries/` |
| ↳ `entries/{studentId}` | – | `{ "2026-04-01": "P"\|"A"\|"H"\|null, … }` — **one field per calendar day** |
| `remarks_sheets` | 2 | `classId`, `isFrozen`, `lastEditedAt/By` + `entries/` |
| ↳ `entries/{studentId}` | – | `{ r1: bool, r2: bool, rr1: bool }` — **keyed by `remark_categories[].key`** |

Mixed types in entries (`assessment1` is number in 7, string in 2) — the app writes both **[LIVE]**.

### 1.5 🔴 The reference school is not clean

**a) Sheets point at a placeholder term.**
`smart_sheet_entries.termId` = `63Zyu8RKgSts5VzToD2e`, but `assessments.termId` = `term1` **[LIVE]**.
The teacher app queries `assessments where termId == X && subjectId == Y` **[SPEC]** — so for these
live sheets it finds **zero assessments** and shows *"No assessments configured for the selected
term and subject."* Either the auto-ID term is real and `term1` is the stub, or vice versa. **Q1.**

**b) The `a` field is a bootstrap artifact, and it is SAMARTH-only.**
`a` appears in exactly four collections — `terms`, `grading_scales`, `assessments`,
`co_scholastic_activities` — and in **no other school** **[LIVE]**. That is the signature of
placeholder docs written to bring a collection into existence. [SPEC] calls them junk. But
`csa1` — the doc the brief cited as the reference shape — **also carries `a` (2/2)**, and a stub
term is referenced by live sheets. **Do not derive the target schema by intersecting SAMARTH's
docs; you will inherit the stubs.**

### 1.6 Content collections (school-scoped copies of global content)
`activities` (89), `playbooks` (16), `avatars` (26), `surveys` (97), `acad_peer_feedbacks` (108),
`subject_feedbacks` (108). Present in old schools too, at similar counts — these are **not** part
of the migration, but note they are **duplicated per school** rather than referenced globally
**[LIVE]**. Out of scope here; flagged in §6 Q13.

### 1.7 Absent everywhere — including SAMARTH
**`class_map` exists in no school.** The bridge collection the resolver reads is entirely
unpopulated **[LIVE]**. Every class value in production today resolves by inference or not at all.

---

## 2. OLD SCHEMA SURVEY — 5 real schools **[LIVE]**

### 2.1 What old schools have
`students`, `classes`, `staffs`, `subjects`, `surveys` + content collections. That's it.
Aravali is the thinnest (7 collections); A K CSchool the richest (11). Two schools carry
`survey_matrix_cache` — written by `functions/assign_survey` **[CODE]**, not user data.

### 2.2 The roster layer is already identical

**`students` — every field matches across all 6 schools:**
`authUid`, `avatar`, `balance`, **`currentClassId` (25/25 in ALL six)**, `dateOfBirth` (timestamp),
`email`, `firstName`, `lastName`, `name`, `gender`, `id`, `needsAuthCreation`, `phoneNo`,
`profileUrl`, `surveyInbox`, `type`, `lastLogin`, `totalLogins`. Doc IDs `s<school>NNNN`
(`ssds0001`, `sakc0001`, …).

> **This answers the biggest open question in my earlier draft.** I expected 7 competing class-field
> spellings. In reality **`currentClassId` is universal and `classId` appears on no student doc in
> any school.** `CLASS_ID_FIELDS` in the resolver is defensive breadth, not a reflection of these
> six schools. **No student-field rename is needed.**

Old-only student fields: `reports` (4 schools, 24–25/25), `password` (A K, GK — **plaintext
credentials on student docs**, §6 Q12), `unlockedAvatars` (A K, 1/25).
SAMARTH-only: **`dob`** (string, 1/25) — see §3.2, an import bug.

**`classes` — same shape everywhere:**
`id`, `name`, `clazz`, `section`, `stage`, `subjects[]`, `smart_sheets{}`.
`subjects[]` is `{subjectId, teacherId, topics[], isCompleted, completedAt}` in all six
(Purandar omits `teacherId`/`isCompleted`/`completedAt` on some) **[LIVE]**.
Old-only: **`classId`** (duplicate of `id`, 4 of 5 old schools) and `link` (A K, Carmel).
Typo variant: **`smartsheets`** (no underscore) on 1 GK doc.
`isActive` is inconsistent everywhere — absent in A K/Carmel, 12/20 in GK, null in 20/23 of SAMARTH.

**`subjects`:** `id`, `name`, `curricular_goals`, `topics` universal.
Old-only legacy: **`cg`** (Aravali, Purandar), **`json`** + **`idName`** (Purandar).
`assets`/`bannerImage`/`iconImage`/`forInternalPurpose` only in SAMARTH + Purandar.
**`area` on zero sampled docs anywhere** — but see the sampling caveat.

**`staffs`:** identical everywhere. **`assignments` is 1/25 in SAMARTH and 0 elsewhere** — the
teacher assignment matrix is effectively unpopulated across the estate. `classIds` is 25/25 everywhere.

### 2.3 🔴 `currentClassId` is polluted — the one real data migration

Sampled values (first 25 students per school) **[LIVE]**:

| School | Example `currentClassId` | Class doc IDs | Verdict |
|---|---|---|---|
| A K CSchool | **`sakc0001`** | `III_A`, `II_A` | 🔴 **a STUDENT ID in the class field** |
| Carmel Convent | **`sccs0001`** | `III_A`…`III_D` | 🔴 **a STUDENT ID in the class field** |
| Aravali | `III` | `III_A1`, `III_A2` | 🟡 grade only, no section — ambiguous across 3 sections |
| GK Gurukul | `V_Sample` | `III_A`, `III_A_(Afternoon)` | 🟡 parking sentinel |
| SAMARTH | `Sample Class I` | `2_C`, `III_A` | 🟡 parking sentinel (matches a real class doc) |
| Purandar | `Sample Class I` | `III_A`, `II_A` | 🟡 parking sentinel |

Two of five old schools store **student IDs** where a class ID belongs. The resolver cannot fix
that — `sakc0001` parses to nothing and lands in `ACTION_BLOCKED`. This is consistent with the
recorded history: *650 of 650 unresolved at NAVODAYA*, *793 of 944 unmapped now resolving*,
*1,836 students affected by a prefix bug* **[CODE/OBSERVED]**.

⚠️ These are the **first 25 students by doc ID** — seed/sample records. The tail may be clean.
**`tools/class_inventory.py` over the full roster is what sizes this**, and it is the single most
valuable command still unrun (§7).

### 2.4 Class ID *format* is largely a non-problem
Doc-ID patterns **[LIVE]**: `III_A` dominates everywhere. Variants: Aravali uses `III_A1`
(section suffixed with a digit), GK has `III_A_(Afternoon)`, and three schools carry one
`Sample Class I` (space-separated) doc. SAMARTH itself mixes roman (`III_A`) and numeric (`2_C`).
The resolver already handles all of these **[CODE]**. **No class-ID rename is required.**

---

## 3. CODE AUDIT

**Legend:** 🟢 works on both · 🟡 degrades safely · 🔴 breaks or misleads on old-structure schools

### 3.1 School Setup tabs

| Tab | File | Schema | Behaviour on old schools |
|---|---|---|---|
| Overview | `OverviewTab.vue` | NEW | 🟡 Hygiene panel reports all-zero. Reads as "broken" when it means "unmigrated" — **misleading, not damaging** |
| Terms & Scales | `TermsScalesTab.vue` | NEW | 🟡 Empty. **This is migration step 1** |
| Subjects | `SubjectsTab.vue` | NEW | 🔴 Writes Co-Scholastic records into `subjects` regardless of the KB's `area` verdict (fix pending on `claude/co-scholastic-subjects-collection-rnx29o`). Affects all schools |
| Classes & Teachers | `ClassesTeachersTab.vue` | NEW | 🟢 **Class shape is identical old/new** — this works today. Will drop old-only `classId`/`link` on save (§4.2) |
| Assessments | `AssessmentsTab.vue` | NEW | 🟡 Needs terms+subjects first |
| Co-Scholastic | `CoScholasticTab.vue` | NEW | 🟡 Same |
| Remarks / Months | `RemarksTab.vue`, `MonthsTab.vue` | NEW | 🟡 Empty |
| **Class Map** | `ClassMapTab.vue` | BRIDGE | 🟢 Scan read-only, writes on confirm. **The fix for §2.3.** Collection is empty in every school today |
| **Class Health** | `ClassHealthTab.vue` | BRIDGE | 🟢 Read-only cross-school scorecard. **The migration dashboard** |
| **Propose Structure** | `StructureTab.vue` + `structureInference.js` | BRIDGE | 🟢 Proposal-only until applied |
| Knowledge Base | `KnowledgeBaseTab.vue` | global | 🟢 School-independent |
| Sheets Status | `SheetsStatusTab.vue` | NEW | 🔴 Queries `smart_sheet_entries` by `classId`+`termId`+`subjectId`. Old schools have **no such collection** — renders empty and **cannot distinguish "no sheets" from "not migrated"** |
| Clone School | `CloneSchoolTab.vue` | NEW | 🟡 Cloning *from* an old school copies nothing. **Cloning *from SAMARTH* is the migration shortcut — but see §1.5, it would copy the `a` stubs** |
| Templates | `TemplatesTab.vue` | NEW | 🟡 Same, and same stub risk |
| New School | `NewSchoolWizard.vue` | NEW | 🟢 Greenfield |
| Reset School | `ResetSchoolWizard.vue` → `functions/school_reset` | BRIDGE | 🟢 Built for unmigrated schools. Archives `students`/`classes`/`smart_sheet_entries` only **[CODE]** |

### 3.2 Import pipeline

| Piece | Schema | Notes |
|---|---|---|
| Upload → extract → stage | N/A | `staging_imports` (top-level); `.pdf` needs the Anthropic path **[CODE]** |
| Students plan `useImport.js:buildStudentsPlan` | NEW | 🔴 **Blocker:** requires a `classes` lookup; without a matching class every row errors *"Class-section not configured"*. Old schools **do** have `classes`, so this works — **unless** the roster's `currentClassId` is polluted (§2.3) |
| Students write | NEW | 🔴 **Field mismatch confirmed by live data.** Import writes `name, gender, dob, srNo, admNo, motherName, fatherName, contactNumber, rollNo, email, city, currentClassId` **[CODE]**. Live docs have **none of** `srNo, admNo, motherName, fatherName, contactNumber, rollNo, city` and use `dateOfBirth` (timestamp) + `firstName`/`lastName` **[LIVE]**. So an import **writes 7 fields nothing reads, omits `firstName`/`lastName`/`type`/`authUid`/`needsAuthCreation`, and writes `dob` as a string beside the app's `dateOfBirth`.** The lone `dob` on 1/25 SAMARTH students is this bug's fingerprint |
| Subjects plan | NEW | 🔴 Writes `{name, area}` into `subjects` — origin of the 154 misfiled co-scholastic docs |
| Teachers plan | NEW | Writes `staffs.assignments[classId]` — a field that is 0–1/25 populated estate-wide **[LIVE]** |
| Commit | NEW | Auth-gated on `OPS_ADMIN_EMAILS` |

### 3.3 Surveys
`Surveys.vue`, `useSurveys.js`, `functions/assign_survey/` — server-side matrix/assign/report;
client never writes a survey doc **[CODE]**. Groups by **resolved** class → 🟢 works on old schools,
degrading to "(no class)". Writes only `surveyInbox`. **`surveyInbox` type is inconsistent in live
data — string on 1 SAMARTH student, array on the rest [LIVE]**; a string there is a latent bug.

### 3.4 Ops CRM tree — `operations/ops/*`
`invoices`, `payment_plans`, `agreements`, `quotations`, `expenses`, `school_operations`,
`school_data_receivable`, `pending_letters`, `tasks`, `links`, `expense_categories`, `schools` **[CODE]**.
🟢 Untouched by this migration.

### 3.5 🔴 STRUCTURAL: two disjoint school identity spaces

| | Ops CRM | Teacher app |
|---|---|---|
| Path | `operations/ops/schools/{opsId}` | `schools/{SCHOOL NAME}` |
| Loaded by | `useAllSchools.js:10` | `SchoolSetup.vue:259` |
| Owns | invoices, receivables, operations | students, classes, config, sheets |

`reset_rules.py` states it outright **[CODE]**: *"a different id space from the root `schools/<id>`
this resets, **with no link between them**."* No feature can join a school's commercial record to
its academic data. **Q9.**

### 3.6 Shared class resolution — the compatibility layer
`src/utils/classResolver.js` ⟷ `functions/shared/class_resolver.py`, hand-ported twins kept in step
by `tools/check_resolver_parity.{mjs,py}` and mirrored by `tools/sync_shared.py` **[CODE]**.
Two earlier independent parsers were deleted for the failures in §2.3. 🟢 **Any migration must go
through this module, not around it.**

---

## 4. GAP LIST

### 4.1 In NEW, absent from OLD → needs authoring or a rule

| Target | Rule | Automatable? |
|---|---|---|
| `terms` | Per-school decision: count, names, academicYear | 🔴 human (Q3) |
| `grading_scales` | Clone `standard_scale` — **not** the `uVzjbXmHa…` stub | 🟢 once Q4 answered |
| `assessments` | Per subject × term. Bulk builder exists **[SPEC §3.5]** | 🟡 semi |
| `co_scholastic_activities` | Term-wide list; bulk builder exists | 🟡 semi |
| `remark_categories` | Clone from SAMARTH. **`key` values freeze once teachers check remarks [SPEC]** | 🟢 |
| `months` | Derive from academicYear + working-days policy | 🟢 |
| `config/students_schema` | Regenerated from class list — `schoolSetupHelpers.js` **[CODE]** | 🟢 auto |
| `config/students_metadata`, `teachers_schema` | Present only in SAMARTH; purpose unconfirmed | 🔴 Q7 |
| `smart_sheet_entries` / `attendance_sheets` / `remarks_sheets` | **Created by the teacher app on demand** (find-or-create **[SPEC §6]**) — do **not** pre-create | 🟢 none needed |
| `class_map` | `ClassMapTab` scan → confirm. **Empty in all 6 schools today** | 🟢 tooling exists |
| `students.currentClassId` hygiene | Resolver + class_map. **The real migration** (§2.3) | 🟡 needs review per school |
| `staffs.assignments` | Teachers import, or the assignment matrix UI | 🟡 |

### 4.2 In OLD, no home in NEW → decision needed

| Item | Where | Recommendation **[INFERENCE]** |
|---|---|---|
| `students.password` (plaintext) | A K, GK — 24–25/25 | 🔴 **Delete.** Security issue independent of migration — Q12 |
| `students.reports` | 4 schools | Keep — reset already clears it optionally **[CODE]** |
| `students.unlockedAvatars` | A K, 1/25 | Keep (app feature) |
| `classes.classId` | 4 old schools, duplicate of `id` | Drop — SAMARTH already has none |
| `classes.link` | A K, Carmel | Q6 |
| `classes.smartsheets` (typo) | GK, 1 doc | Fold into `smart_sheets` or drop with it |
| `classes.smart_sheets` | all 6 | [SPEC] says ignore/don't write. **Present on SAMARTH too** — Q5 |
| `subjects.cg` | Aravali, Purandar | Likely a `curricular_goals` predecessor — Q6 |
| `subjects.json`, `idName` | Purandar only | Q6 |

### 4.3 Traps
- **`stage: "prepratory"` is misspelled in production. [SPEC] says keep the literal.** "Fixing" it breaks the app.
- **`remark_categories[].key` (`r1`) is a stored entry field key** — confirmed live in `remarks_sheets/*/entries` **[LIVE]**. Never change after teachers check remarks.
- **Assessment doc IDs are stored as entry field keys** — `entries` docs are `{assessment1: 100}` **[LIVE]**. Never rename an assessment doc.
- **`attendance_sheets` entries are one field per calendar date** (`"2026-04-01": "P"`) **[LIVE]** — an unusual shape; any tooling must not assume a fixed schema.
- **No academic-year dimension exists anywhere.** Reset is an in-place mutation, which is why archiving is mandatory **[CODE]**. Q2.

---

## 5. LOGIC MAP

| Feature | What it does | Files | Assumes |
|---|---|---|---|
| **School Setup** | 17-tab per-school config authoring | `views/SchoolSetup.vue`, `components/school-setup/*` | NEW (3 bridge tabs) |
| **Import** | Upload → AI extract → stage → review → commit | `views/Import.vue`, `ImportReview.vue`, `useImport.js`, `functions/generate_import/` | NEW; field mismatch §3.2 |
| **Structure inference** | Proposes grades/sections/subjects from import rows; never writes | `utils/structureInference.js`, `StructureTab.vue` | BRIDGE |
| **Class Map** | Raw class value → canonical class ID | `ClassMapTab.vue`, `utils/classResolver.js` | BRIDGE |
| **Class Health** | Cross-school resolution scorecard | `ClassHealthTab.vue` → `classHealthRemote()` | BRIDGE, read-only |
| **Reset School** | Archive → promote → clear, typed confirmation | `ResetSchoolWizard.vue`, `functions/school_reset/`, `shared/promotion.py` | BRIDGE |
| **New School** | Greenfield creation | `NewSchoolWizard.vue`, `useWizardRun.js` | NEW |
| **Surveys** | Class×survey matrix, assignment, reports | `views/Surveys.vue`, `useSurveys.js`, `functions/assign_survey/` | BRIDGE via resolver |
| **Invoices** | Invoicing, installments, payment position | `views/Invoices.vue`, `usePaymentPlans.js`, `paymentMath.js`, `functions/generate_invoice/` | OPS tree |
| **Receivables** | Per-school/term data-received checklist | `views/SchoolProfile.vue`, `DataReceivableSectionCard.vue` | OPS tree |
| **Pending Letters** | LLM-drafted outstanding-items PDF | `PendingLetterDialog.vue`, `functions/generate_pending_letter/` | OPS tree |
| **Knowledge Base** | Global subject/grade/section classification | `utils/educationKB.js`, `kb_entries` | Global |

---

## 6. OPEN QUESTIONS — Sid

### Reference schema integrity *(blocks using SAMARTH as a template)*
1. **`smart_sheet_entries` point at term `63Zyu8RKgSts5VzToD2e` while assessments are on `term1` — which is the real term?**
2. Should migration add an **academic-year dimension**, or keep the in-place no-year model?
3. How many terms per school, and what doc IDs — `term1`/`term2`, or named?
4. One shared house grading scale, or per-school?
5. Can `classes.smart_sheets` (legacy Google Sheets URLs) be dropped from **all** schools including SAMARTH?
6. Drop `subjects.cg`, `subjects.json`, `subjects.idName`, `classes.link`, `classes.classId` — or preserve any?
7. What are `config/students_metadata` and `config/teachers_schema` for, and do old schools need them?

### Class data quality *(the real migration)*
8. **A K CSchool and Carmel store student IDs (`sakc0001`) in `currentClassId` — is that the whole roster or just seed rows?** (`class_inventory.py` answers this)
9. Do we add an explicit link field joining `operations/ops/schools/{opsId}` ↔ `schools/{name}`, and which side owns it?
10. For students that never resolve — confirm each in `class_map`, or mark `excluded`?
11. Aravali's `currentClassId: "III"` is grade-only across 3 sections (`III_A1/A2/A3`) — how do we assign a section?

### Hygiene & security
12. **`students.password` holds plaintext credentials on A K and GK (24–25/25 sampled) — delete now, independent of migration?**
13. `activities`, `playbooks`, `avatars`, `surveys`, `*_feedbacks` are duplicated per school. Leave as-is, or centralise?
14. Delete the `a`-field stub docs in SAMARTH once Q1 resolves?

### Sequencing
15. Pilot one school end-to-end, or all schools per-collection? **(Recommend pilot — §8)**
16. Which schools are live vs dormant? Aravali (999 students) and Carmel (1949) are the big ones.
17. Freeze window, or must migration be live-safe?
18. For the co-scholastic dry run: **154 found, 20 movable, 134 skipped** — what does the skip-reason tally say?

---

## 7. INPUTS NEEDED

| # | Input | Unblocks | Priority |
|---|---|---|---|
| 1 | `python3 tools/class_inventory.py --project clarified-1501 --json > /tmp/inventory.json` — **full roster, all schools** | Q8, Q10, Q11 — sizes the *only* real data migration | 🔴 **highest** |
| 2 | Which of `term1` / `63Zyu8RKgSts5VzToD2e` the teacher app treats as live | Q1 | 🔴 |
| 3 | Teacher-app source (or its read paths) for `students`/`classes` | Confirms §3.2 field mismatch and which fields are actually read | 🟡 |
| 4 | Skip-reason tally: `awk -F',' 'NR>1 && $4=="SKIP"{print $NF}' <csv> \| sort \| uniq -c \| sort -rn` | Q18 | 🟡 |
| 5 | Live vs dormant school list + freeze window | Q15–Q17 | 🟡 |
| 6 | Decision on `students.password` | Q12 | 🔴 security |

Re-run the schema dump with `--sample 200` if you want the `area`-field question settled directly.

---

## 8. MIGRATION PATHWAY

Because there is no schema to convert, this is **authoring config + cleaning class values**, in that
order, per school.

### Phase 0 — Measure *(read-only, do now)*
1. `tools/class_inventory.py` across all schools → the real `currentClassId` damage.
2. Open **Class Health** — it already scores every school.
3. Output: per-school table of *students · resolution % · unmapped values*. **That is the backlog, ordered by effort.**

### Phase 1 — Decide *(blocks everything)*
4. **Q1** (which term is real) — otherwise you clone a broken reference.
5. **Q12** (plaintext passwords) — independent of migration, do it regardless.
6. **Q15** — recommend **pilot one school end-to-end**. Suggested pilot: **Purandar (228 students,
   13 classes)** — smallest roster, cleanest class IDs, and it has the legacy `subjects` fields so
   it exercises the drop-decisions. Not Aravali/Carmel — 999 and 1,949 students is not a pilot.

### Phase 2 — Per school, in order
7. **Class map first.** `ClassMapTab` scan → confirm every raw value. Nothing downstream is correct
   until this is 100%. Unresolvable → `excluded` (Q10). **For A K and Carmel this is the whole job.**
8. **Terms + grading scales.** Everything academic hangs off `termId`.
9. **Subjects + classes** already exist and are correctly shaped — **verify, don't recreate.** Use
   `StructureTab` only to fill gaps.
10. **Assessments + co-scholastic + remarks + months.** Clone from SAMARTH (Q4) *after* Q14 removes
    the stubs, then adjust per school.
11. **`config/students_schema`** regenerates from the class list automatically.
12. **Do not pre-create sheet collections** — the teacher app creates them find-or-create **[SPEC §6]**.

### Phase 3 — Verify before declaring a school done
13. Class Health = 100% resolved.
14. Overview hygiene panel clean.
15. Sheets Status renders a real grid.
16. **A teacher logs in and sees their classes and assessments.** No dashboard check substitutes.

### Phase 4 — Cleanup
17. Run the co-scholastic migration (`--commit`, then `--delete-source`) once Q18 resolves.
18. Drop legacy fields per Q5/Q6 — as a **separate, reviewed pass**, not folded into migration.
19. Delete `students.password` (Q12).
20. **Keep the resolver's `CLASS_ID_FIELDS` breadth regardless.** It costs nothing and is the only
    thing standing between a stray legacy doc and silent data loss.

### Deliberately not planned
- **No big-bang script.** Every step runs through reviewed UI with preview + confirm. There is no
  bulk transformation to justify one — the work is authoring and judgement.
- **No ops-tree migration.** `operations/ops/*` is untouched.
- **No student/class field rename.** §2.2 proves it is unnecessary. This is the single biggest
  scope reduction in this audit.

---

## Appendix — method & limits

Read `src/` (85 files), `functions/` (9 folders + `shared/`), `tools/` (5 scripts),
`docs/school-setup-page-spec.md`; mapped every `schoolCollection`/`schoolDoc`/`opsCollection`/
`collection()` call site to a feature. Live schema from a read-only dump of 6 schools.
No repo file modified, nothing committed, no Firestore write path opened.

**Limits:** 25-doc sample per collection — "field absent" means "absent from the first 25"
(the `area` field is a proven case of this). Only 5 of the estate's old schools were dumped; the
`class_inventory.py` run in §7 is what generalises §2.3 to the whole estate. Field *semantics*
(what the teacher app actually reads) remain inferred from this repo and the spec, not from the
app itself — input #3.
