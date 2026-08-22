# Spec: "School Setup" page — ClarifiEd Ops Dashboard

Goal: a single admin page in the ops dashboard to create/edit all per-school configuration in Firestore, replacing manual doc-by-doc entry (especially assessments, which today are entered per subject × per term × per school by hand).

Project: `clarified-1501` · All data under `schools/{schoolId}/...`
Reference school with correct schema: `schools/SAMARTH DNYANPEETH SAHAYDRI`
Consumer of this config: the teacher app's SmartSheets module (find-or-create pattern; see §6).

---

## 1. Page shell

- Route: `/school-setup` (follow existing dashboard router/layout patterns).
- Top bar: **school selector** (dropdown of `schools` collection where `isActive != false`) + academic-year/term context chip.
- Tabs: Overview · Terms & Scales · Subjects · Classes & Teachers · Assessments · Co-Scholastic · Remarks · Months · Sheets Status · Clone School.
- All writes go through Firestore `writeBatch` where multiple docs are touched; show a confirmation summary ("will create 24 docs") before committing bulk operations.
- ID convention: human-readable slugs for config docs (`term1`, `standard_scale`, `III_Maths`, `III_A`), NOT auto-IDs. Auto-IDs only where the teacher app itself generates docs (sheet instances).

## 2. Data model reference (verified from live dump + teacher-app code)

### schools/{id}
`{ id, name, isActive }`

### terms/{termId}
`{ name: "Term 1", academicYear: "2025-26", isActive: bool }`

### grading_scales/{scaleId}
`{ name, levels: [{ label: "A+", minPercent: 90, maxPercent: 100 }, ...] }`
Levels must fully cover 0–100 with no overlap (validate).

### subjects/{subjectId}   — grade-level, e.g. `III_English`
```
{ id, name,
  curricular_goals: [ { "<goal text>": ["<competency text>", ...] }, ... ],
  topics: [...],            // survey/topic machinery — display read-only, don't edit here
  assets, bannerImage, iconImage, forInternalPurpose  // nullable strings
}
```
Doc ID pattern: `{Grade}_{SubjectName}` (Roman-numeral grade). A subject used by only
one section (e.g. `III_Sanskrit`) is still just a subjects doc.
Scholastic only — a co-scholastic record is a `co_scholastic_activities` doc (§2 below),
never a subjects doc, whatever its `area` says.

### classes/{classId}   — per-section, e.g. `III_A`
```
{ id, name, clazz: "III", section: "A", stage: "foundation|prepratory|middle|secondary",
  isActive,
  subjects: [ { subjectId, teacherId: "", isCompleted, completedAt,
                topics: [{ id, topic, isCompleted, completedAt, absentList? }] } ],
  smart_sheets: {...}   // LEGACY Google-Sheets URL map — ignore, do not write, ok to hide
}
```
Note: `stage` value "prepratory" is misspelled in data — keep the existing literal, do not "fix" it.

### assessments/{assessmentId}
```
{ name, termId, subjectId, order: number,
  entryType: "marks" | "grade",
  maxMarks: number,
  gradingScaleId: string | null,
  conversionType: "none" | "marks_to_grade" | "sum_up" | "sum_down",
  conversionFactor: number | null }
```
Teacher app queries: `where termId == X && subjectId == Y`, sorts by `order` client-side.
**Composite index required: assessments(termId ASC, subjectId ASC).** (The app surfaces a
missing-index error, so verify the index exists in clarified-1501.)

### co_scholastic_activities/{id}
Same shape as assessments minus `subjectId` (term-wide): `{ name, termId, order, entryType, maxMarks, gradingScaleId, conversionType, conversionFactor }`.

### remark_categories/{id}
`{ label, order, remarks: [{ key, text, type: "positive"|"negative", order }] }`
`key` values (e.g. `r1`) are stored as entry field keys — once teachers have checked remarks, keys must not change.

### months/{id}
`{ key: "2026-04", label: "April 2026", month, year, order, workingDays }`

### staffs/{staffId}
```
{ id, staffId, authUid, name, firstName, lastName, email, phoneNo, sex,
  type: "teacher"|..., needsAuthCreation,
  classIds: [classId, ...],                    // gates class visibility
  assignments: { [classId]: [subjectId, ...] } // gates class+subject (academics)
}
```
Teacher-app access rules: academics requires `assignments[classId]` to include the subjectId;
co-scholastic/attendance/remarks require classId in `assignments` keys OR `classIds`.
Admins/principals: no assignments map → see everything (verify how the app distinguishes; likely `type`).

### config/{students_schema | teachers_schema}
`{ columns: [{ key, label, type: "text"|"date"|"select", editable, order, options? }] }`
`students_schema` currently hardcodes class options — must be regenerated from live classes (§3.4).

### Operational collections — NOT edited by this page
`students`, `smart_sheet_entries` (+`entries` sub), `attendance_sheets` (+`entries`),
`remarks_sheets` (+`entries`), `surveys` (+`responses`), `playbooks`, `activities`, `avatars`,
`acad_peer_feedbacks`, `subject_feedbacks`, `acad_peer_feedbacks/*/responses`, config/students_metadata.

## 3. Tabs & behavior

### 3.1 Overview
- School doc fields (name, isActive) editable.
- Hygiene panel (computed on load): stray/test docs (docs whose only field is `a`), sheet docs whose `termId` references a nonexistent term, subjects referenced by classes but missing from `subjects`, assessments referencing missing gradingScaleId/termId/subjectId, `students_schema` class options ≠ live class list. Each warning has a "fix" or "delete doc" action with confirm.

### 3.2 Terms & Scales
- CRUD tables for `terms` and `grading_scales`.
- Grading scale editor: sortable rows (label, min%, max%) with coverage/overlap validation.
- Guard: deleting a term/scale referenced by any assessment or activity is blocked (show referencing docs).

### 3.3 Subjects
- Table of subjects grouped by grade (parse grade from ID prefix).
- Create: pick grade + name → ID auto-slugged `{Grade}_{Name}`; editable before first save, locked after.
- Curricular goals editor: list of goals, each with a list of competencies (maps of goal-text → [competency texts]). Support "copy goals from another subject" and "copy from another school" (reads the same subjectId or a chosen subject in another school doc).
- `topics` shown read-only.
- **`area` routes the write, it is not just a label.** Area `Co-Scholastic` (matched on letters only, so `co scholastic`/`CO_SCHOLASTIC` count) means the record is a term-wide activity: both the Add form and the CSV import write it to `co_scholastic_activities` with that collection's schema (§3.6), never to `subjects`. The form swaps Grade for Term and collects entryType/maxMarks/gradingScaleId/conversionType/conversionFactor/order; the CSV defaults them (`marks` / 10 / null / `none` / null / appended to the term) and requires an explicit `termId` unless the school has exactly one term. Doc ID follows the co-scholastic convention `{termId}_{NameSlug}`.
- Editing an existing subject never changes its collection on its own — the Area select is locked, because flipping the label alone would leave a co-scholastic record sitting in `subjects`.
- **Move to Co-Scholastic** is the in-app diversion for anything already misfiled — a per-row `→` action, a "move all" banner over the docs whose `area` is already Co-Scholastic, and a footer action in the edit dialog. It also covers a record the knowledge base never classified (blank `area`), which is how most misfiled rows arrive. The dialog collects the term and one set of marking settings for the whole move, previews each `{subjectId} → {termId}_{NameSlug}` with what will be dropped (`curricular_goals`, `topics` — the activity schema has no field for either) and blocks a row whose target ID is already taken. On confirm, per record: write the activity, re-read it to confirm it landed, detach the subject from every `classes/{id}.subjects[]` that references it, then delete the subjects doc — in that order, so a failure can neither lose the record nor leave a class pointing at a deleted subject.
- `scripts/migrate-co-scholastic-subjects.mjs` remains the bulk, all-schools version of the same move (dry-run by default, CSV review log, `--delete-source`). It does NOT detach class references — prefer the in-app move for a single school.
- The Structure proposer (§3.2) applies the same rule: a proposed subject the KB called Co-Scholastic is written to `co_scholastic_activities` under the school's default term, and is not linked into any class's `subjects[]`.

### 3.4 Classes & Teachers
- Grid: rows = grade (`clazz`), columns = sections; cell click opens section editor.
- Section editor: name/stage; **subject checklist** = all *scholastic* subjects of that grade (+ ability to attach any other scholastic subject, e.g. `III_Sanskrit` for section D only). Co-Scholastic records still sitting in `subjects` are excluded from the checklist and counted in a note pointing at the Subjects tab's move action — they are term-wide, not per-class. Saving regenerates the doc's `subjects` array via `src/utils/classSubjects.js`: for each checked subjectId, build `{ subjectId, teacherId: "", isCompleted: false, completedAt: null, topics: [...] }` — but PRESERVE existing entries' `isCompleted/completedAt/topics` state when the subject was already assigned (merge, don't clobber).
- **Topic template** (one place: `src/utils/classSubjects.js`, pinned by `tools/check_class_subjects.mjs`). Three topics per subject, ids `{subjectId}_Term1|_Term2|_Optional`, labels **"Term 1 Activity" / "Term 2 Activity" / "Optional Activity"** — taken from a live teacher-populated doc (SAMARTH `classes/III_A`), not from this spec's prose. `absentList` is NOT seeded: it appears only on topics a teacher has completed, so the teacher app writes it.
- **Empty subject lists.** A section created by the New School Wizard or the structure proposer starts `subjects: []`, and until it is filled the teacher app has nothing to show for that class. The grid shows each cell's subject count (amber `·` when zero) and a banner offers **Fill subject lists**, which appends each affected section's grade-matching scholastic subjects in one batch. It is additive — sections that already have subjects are untouched.
- **Teacher assignment matrix** per class: rows = staff (type teacher), columns = that class's subjects, checkboxes. Saving writes `staffs/{id}.assignments.{classId}` arrays and keeps `classIds` in sync (union of assignment keys + any manually added class-level access). Never write teacher info into `classes.subjects[].teacherId` (unused by the app).
- Bulk: "add section" (clones subject list from sibling section), "deactivate section".
- After any class add/remove/rename: regenerate `config/students_schema` column `currentClassId.options` from live class IDs.

### 3.5 Assessments (the centerpiece)
- View: matrix per term — rows = assessment name (grouped template), columns = subjects, cell = configured/missing. Secondary flat table with inline edit.
- **Bulk builder**: form { name, term, entryType, maxMarks, gradingScale, conversionType, conversionFactor, order } + subject multi-select with grade-level grouping ("all of grade III", "all grades — Maths", "everything"). Preview count → single writeBatch. Doc ID: slug `{subjectId}_{termId}_{nameSlug}` or similar deterministic slug so re-running the builder is idempotent (skip/update existing rather than duplicate).
- Edit propagation: "apply this change to the same-named assessment across N other subjects" checkbox.
- Safety: if any `smart_sheet_entries` doc exists for (termId, subjectId) whose `entries` subcollection is non-empty, editing `maxMarks`/`entryType` or deleting the assessment shows a hard warning (entered marks are stored raw under the assessment doc ID; deleting orphans them, lowering maxMarks may invalidate values). Never change an assessment's doc ID after creation.
- conversionFactor UX: show computed result label exactly as the teacher app renders it (marks_to_grade → scale labels; sum_up → out of maxMarks×factor; sum_down → out of maxMarks÷factor) so ops sees what teachers will see.

### 3.6 Co-Scholastic
Same bulk builder minus subject dimension (term-wide list, ordered).

### 3.7 Remarks
- Category CRUD with drag-order; remarks editor per category (text, type toggle, drag-order). Auto-assign `key` = next `r{n}`; keys immutable once any `remarks_sheets/*/entries` exist.
- "Copy remark bank from another school".

### 3.8 Months
- Table CRUD; "generate academic year" helper: pick start month + year span → creates all month docs with key/label/month/year/order prefilled; `workingDays` editable inline.

### 3.9 Sheets Status
- Read-only ops view over `smart_sheet_entries`, `attendance_sheets`, `remarks_sheets`: class × subject × term grid showing exists / lastEditedAt / lastEditedBy (resolve via staffs) / entry count / isFrozen.
- Actions: toggle `isFrozen` (single + bulk "freeze all for term"), delete empty stray sheets (e.g. ones pointing at deleted test terms).
- Do NOT pre-create sheets — the teacher app find-or-creates them on demand.

### 3.10 Clone School
- Source school + target (new doc, name + slug ID). Checkbox groups: terms, grading_scales, subjects (with curricular_goals), remark_categories, months, co_scholastic_activities, assessments, classes (structure only — subjects arrays reset to not-completed, no teachers), config schemas.
- Never copy: students, staffs, sheet/entry collections, surveys, feedbacks, playbooks, avatars, activities (confirm playbooks/activities/avatars with Sid — they look school-copied content and MAY belong in clone; make them opt-in checkboxes, default off).
- Runs as chunked batches (500-op limit) with progress.

## 4. Validation rules (enforced in UI)
- Assessment: maxMarks > 0; conversionFactor required unless conversionType none/marks_to_grade; gradingScaleId required when conversionType = marks_to_grade or entryType = grade.
- Grading scale: levels cover 0–100, no gaps/overlaps, labels unique.
- Order fields: auto-assign next integer; drag to reorder rewrites orders.
- Referential integrity on delete everywhere (term, scale, subject, class).
- All dropdowns populated from live collections, never hardcoded.

## 5. Firestore write conventions
- Bulk = `writeBatch`, chunk at 450 ops.
- Timestamps via `serverTimestamp()`; stamp `lastEditedBy` (ops user id) + `lastEditedAt` on config docs the same way the teacher app does for sheets (add these fields to config docs; harmless additive).
- Reuse the dashboard's existing Firebase service; the teacher app uses `nsCollection/nsQuery/nsDocFromCollection` namespace helpers from `@/firebase` — mirror whatever equivalent the dashboard has for school-scoped paths.

## 6. Teacher-app consumption contract (do not break)
- Academics sheet lookup: `smart_sheet_entries` where classId+termId+subjectId (no type field on academics docs). Co-scholastic: where type=='co-scholastic'+classId+termId. Attendance: `attendance_sheets` where classId+type('month-wise'|'day-wise'). Remarks: `remarks_sheets` where classId (no term!).
- Entry docs: `smart_sheet_entries/{sheetId}/entries/{studentId}` = flat map `{ [assessmentId]: rawValue }`. Attendance entries keyed by month key or day key. Remarks entries = `{ [remarkKey]: boolean }`.
- Assessment columns render from assessments query sorted by `order`; missing assessments ⇒ teacher sees "No assessments configured for the selected term and subject."
- Subject dropdown for a class = intersection of `classes/{id}.subjects[].subjectId` with teacher's `assignments[classId]`.
- Student rows come from `students where currentClassId == classId`; `rollNo` used if present, else last-2-of-ID fallback.

## 7. Known data issues in SAMARTH (fix via Overview hygiene panel)
- `terms/63Zyu8RKgSts5VzToD2e` — junk doc (`{a: null}`), but 8 sheet docs reference it as termId.
- `grading_scales/uVzjbXmHaUsIx1SQ2953`, `assessments` docs with `a` field, `co_scholastic_activities/Pk6PNs1fu0I7gqMPgm15` — junk/partial test docs.
- `config/students_schema` class options list only 5 of 21 classes.
- `classes/Sample Class II` and students with `currentClassId: "Sample Class I"` — sample data.

## 8. Out of scope (this page)
Student/staff registration (existing app), survey/playbook content management, report generation, marks entry itself.

## 9. Open questions for Sid
1. Which existing dashboard page should the code style follow (component/composable patterns, PrimeVue vs plain)?
2. Ops-user identity for `lastEditedBy` — how does the dashboard auth identify Sid/Ruchika?
3. Are playbooks/activities/avatars/surveys per-school copies of central content (→ belong in Clone School), or synced by another pipeline?
4. Should stages be a fixed enum (foundation/prepratory/middle/secondary) or configurable?
