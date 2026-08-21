# Onboarding a school

Where each thing a school hands you goes, and in what order.

Written after Hillgreen, where most of a week went on discovering the order the
hard way. Every "why" below is a real failure, not a hypothetical.

---

## The order, and why it is an order

The New School wizard (School Setup → **New School**) enforces the first half of
this with live Firestore counts rather than tick-boxes. The gates are real: a
student import against a school with no classes does not fail, it writes rows
that reference nothing, and the roster then exists while no class-scoped feature
can see it.

| # | Step | Where | Blocks |
|---|---|---|---|
| 1 | Create the school | New School wizard | everything — the id is permanent |
| 2 | School details | New School wizard | generated documents |
| 3 | **Grades & sections** | wizard, or Classes & Teachers | subjects, students, everything class-scoped |
| 4 | **Subjects** | wizard, or Subjects tab | curriculum, assessments, the teacher app's dropdown |
| 5 | **Terms & grading scales** | Terms & Scales | assessments — they reference a `termId` |
| 6 | Curriculum (goals, competencies) | Curriculum tab | nothing, but easier before rosters land |
| 7 | Assessments | Assessments tab | mark entry |
| 8 | Teachers | Import → Teachers | the subject dropdown, which is `classes.subjects[] ∩ staffs.assignments[classId]` |
| 9 | Register students | Tools → Register | authentication |
| 10 | Authenticate them | Tools → Auth Accounts | the ID-matched import |
| 11 | Student details | Import → Students | — |
| 12 | Surveys | Surveys | — |

Steps 3–5 are the ones people skip and regret. 9–11 are an order, not a
preference: see *A roster file is two different imports* below.

---

## Where each artefact goes

### Spreadsheets and rosters → **Import**

Accepts `.xlsx .xls .csv .tsv .htm .html .docx .pdf .png .jpg`, several at once,
for four entities: **Students, Teachers, Subjects, Assessments**.

Spreadsheets go through the deterministic parser. PDFs and images fall back to
the LLM path, which is slower and less reliable and never writes to the learned
knowledge base on its own. **If a thing exists as a spreadsheet, use the
spreadsheet** — a PDF of the same table is strictly worse.

### Curriculum documents → **Curriculum tab**

The NCF stage frameworks are already extracted into
`src/data/curriculumTemplates.json`. The tab matches a school's own subject
names against them (Maths/Mathematics/Numeracy all land on the same template)
and shows every match before writing. Nothing per-school to supply.

### Exam scheme (marks sheet + report card models) → **currently a code change**

Hillgreen's scheme lives in `src/data/assessmentTemplates.json`, extracted from
its `marks_conversion.xlsx` and four report card PDFs. A school that examines
differently has nowhere to put that today — the documents come to Claude, get
extracted, and the app is redeployed.

**This is the known gap.** An in-app exam-scheme editor is the fix and is the
next thing to build. Until then, send the marks sheet and one report card model
per grade band that differs.

### Another school's setup → **Clone School**

Terms, scales, subjects with curricular goals, remark categories, months,
co-scholastic activities, assessments, class structure. Playbooks and
activities are copied by default; avatars are opt-in.

---

## A roster file is two different imports

This is the one that cost the most time.

**Registering** students creates `schools/{id}/students/{docId}` and mints the
auth account. **Filling them in** matches an existing student by id and writes
fields onto them.

The importer decides which it is doing by whether the file carries a
`student_id` column — `ID`, `Student ID`, `Unique ID`, `Registration No` and
friends. If ANY row has one, the whole file is in id mode:

- each row updates the student already holding that id
- an id nobody holds is an **error**, never a new student
- blank optional fields are dropped, so a merge cannot erase what registration
  wrote (Hillgreen's export has an empty `Email` column on all 1622 rows while
  every student has a real address)

So: **register → authenticate → import**. A file with ids imported before
registration matches nothing; a file without ids imported after registration
creates a second copy of every student under a minted `{classId}_{name}` id.
Hillgreen got 1621 duplicates that way.

Columns the alias dictionary has no field for ride through as `extras` and
become camelCase fields. `config/students_schema` is offered afterwards as its
own confirmation — never as part of the commit, because that array is what the
mapper shows on every future roster and what the teacher app reads.

---

## Traps

**Grade notation.** A school writing `VII` gets `VIII` on promotion; one writing
`7` gets `8`. Never normalise across notations — it creates a parallel set of
classes beside the real ones and orphans every student pointing at the old ones.
"Always Roman" is an authoring rule for NEW classes, not a licence to migrate.

**One column or two.** Most exports carry `Class` + `Section`. Some put the
whole class id in `Class` alone (`Play_Group_A`, `8_KALAM`). Both work now, but
if rows are rejected as *"grade X has no classes at all"*, check whether the
export dropped its Section column.

**Subjects that can never attach.** Class-to-subject matching is exact string
equality on the id prefix. A subject filed under a grade token no class uses can
never attach, and the teacher app's dropdown comes back empty. The Subjects tab
offers the grade tokens the school's classes actually use and warns on a
mismatch.

**Assessments the teacher app cannot find.** It queries
`where termId == X && subjectId == Y`. No match ⇒ *"No assessments configured
for the selected term and subject."* Run
`tools/assessment_inventory.py --school <id>` — it lists dangling references and
every subject with no assessment in a term.

**Do not derive a schema from SAMARTH.** It is the reference school for
structure and carries `{a: null}` bootstrap stubs. For assessments it is not a
reference at all: 2 assessments across 64 subjects, on one subject.

---

## Checking a school before you hand it over

Both are read-only. Neither opens a write path.

```bash
python3 tools/assessment_inventory.py --project clarified-1501 --school <id>
node    tools/preview_assessments.mjs --project clarified-1501 --school <id>
python3 tools/class_inventory.py      --project clarified-1501 --school <id>
```

The inventory names the blockers (no terms, no subjects, no scales), the
dangling references, and every subject a teacher would open to an empty sheet.
