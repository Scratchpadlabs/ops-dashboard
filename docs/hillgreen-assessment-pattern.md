# Hillgreen High School — assessment pattern

What the school gave us, how it maps onto `assessments` / `co_scholastic_activities`,
and what is still unanswered. The machine-readable form is
`tools/patterns/hillgreen.json`; this file is the reasoning behind it.

**Source documents** (2026-08, from the school)

| File | What it fixes |
|---|---|
| `marks_conversion.xlsx` | "Classwise Marks Distribution 2026 (For All Exams)" — the marks scheme |
| `Report_Card_Model_class_1_to_8.pdf` | Grade I sample — layout, grading scale, co-scholastic list |
| `Report_Card_Model_class_9.pdf` | Grade IX sample — adds "Scholastic Areas II" and a cross-term overall |
| `Report_Card_Model_class_10.pdf` | Grade X sample — the only one showing the theory/internal split |

**Status (2026-08-24):** grades I–X generated and ready to import (632 assessment rows,
80 subjects) — see `tools/patterns/hillgreen_subjects.csv` for the source export and §3
for the command. Co-scholastic is imported and live for Hillgreen. Grades XI–XII remain
blocked on Q5 below.

## 1. The scheme

| Exam | Classes | Written | → Converted to | Internal | Total |
|---|---|---|---|---|---|
| PT 1 | 1–2 | 20 | 40 | 10 | 50 |
| PT 1 | 3–12 | 40 | 40 | 10 | 50 |
| PT 2 | 1–2 | 40 | 80 / 70 | 20 / 30 | 100 |
| PT 2 | 3–5 | 60 | 80 / 70 | 20 / 30 | 100 |
| PT 2 | 6–12 | 80 / 70 | 80 / 70 | 20 / 30 | 100 |
| PT 3 | 1–2 | 20 | 40 | 10 | 50 |
| PT 3 | 3–12 | 40 | 40 | 10 | 50 |
| PT 4 / Prelim | 1–2 | 40 | 80 / 70 | 20 / 30 | 100 |
| PT 4 / Prelim | 3–5 | 60 | 80 / 70 | 20 / 30 | 100 |
| PT 4 / Prelim | 6–12 | 80 / 70 | 80 / 70 | 20 / 30 | 100 |

Sheet footnote: *"In some papers like IT and AI Written is 50 and internal/practical
is altogether 50."*

Term I is PT 1 + PT 2 (150). Term II is PT 3 + PT 4 (150). Grade X instead runs two
100-mark pre-boards in Term II (200), for a 350 grand total.

Grading is an 8-point scale applied to the **percentage**, at every level — each
exam, each grand total, and the all-subjects total row. Verified against the samples:
grade I English PT 1 = 35/50 = 70% → B2; the 113/150 grand total = 75.3% → B1.

## 2. How it maps

**One assessment doc per column a teacher types into.** `maxMarks` is always the real
max of the paper in front of them; the conversion is display-only. A grade 3 teacher
enters 47 out of 60 and the sheet shows "62.67 / 80" — they never convert by hand.

So `PT 2` for grades 3–5 becomes two docs:

| name | maxMarks | conversionType | conversionFactor | teacher sees |
|---|---|---|---|---|
| PT 2 Written | 60 | `sum_down` | 0.75 | out of 80 |
| PT 2 Internal | 20 | `none` | — | out of 20 |

**`sum_down`, not `sum_up`.** `conversionFactor` is capped at two decimals in the UI,
so 60 → 80 as `sum_up` needs 1.33 and yields 79.8. `sum_down` divides
(`maxMarks / factor`), so 60 ÷ 0.75 = 80 exactly. Every other Hillgreen ratio is a
clean `sum_up 2` (20→40, 40→80, 50→100) or needs no conversion at all.
`conversionFor()` in the generator picks whichever side is exact and refuses the row
if neither is.

**Graded subjects skip the split — but not by reading the Subjects tab.** The Subjects
tab's CSV export has an `entryType` column, and it looks like exactly the signal needed
to tell a graded "Scholastic Areas II" subject (grade IX/X Marathi) from a marked one.
It isn't: that column is blank on every real row Hillgreen exported. It exists only for
Co-Scholastic routing (§3.3 of the spec), not to describe a scholastic subject's marking
style — a subject doc has no field for that at all. Trusting it here was only ever
validated against a hand-typed sample file; the first real export broke it silently
(everything would have generated as marked, Marathi included).

The real signal is `gradedSubjects.ids` in `tools/patterns/hillgreen.json`: an explicit
list, backed only by what a model report card actually shows. Right now that's exactly
two IDs — `IX_Marathi` and `X_Marathi` — because those are the only two subjects either
sample card prints as a letter-grade-only "Scholastic Areas II" row. Everything else,
including every subject in grades I–VIII and all of XI–XII, defaults to marked until a
card (or the school) says otherwise.

**Totalling is not modelled.** Summing, grand totals and the cross-term overall happen
in the school's Excel sheets, not in Firestore. Nothing here computes a total, which
is why the contradiction in Q1 below does not block configuration: every number a
teacher enters is captured, and Excel decides what to add.

## 3. Generating it

```
node tools/build_school_assessments.mjs \
  --pattern tools/patterns/hillgreen.json \
  --subjects tools/patterns/hillgreen_subjects.csv \
  --out build/hillgreen-config
```

`hillgreen_subjects.csv` is the Subjects tab's own **Export CSV** (All Years), covering
every grade currently in Firestore — I through XII, 135 subjects. It replaced an earlier,
hand-typed placeholder covering only X/XI/XII once the school's full Subjects tab was
populated and the real export could be pulled instead. Re-export and overwrite this file
whenever a subject is added, renamed, or removed.

Import the four files **in order** — each references doc IDs the previous one creates:

| File | Where |
|---|---|
| `1_terms.csv` | Terms & Scales → Terms → Import CSV |
| `2_grading_scales.csv` | Terms & Scales → Grading Scales → Import CSV |
| `3_assessments.csv` | Assessments → Import CSV |
| `4_co_scholastic.csv` | Co-Scholastic → Import CSV |

Doc IDs are deterministic, so the generated files can reference them before the
import runs: terms are `Term_1_2025_26` / `Term_2_2025_26`, scales are
`Hillgreen_8_Point_Scale` / `Hillgreen_Co_Scholastic_Scale`.

Assessment doc IDs keep their term segment — `X_Maths_Term_1_2025_26_PT_1_Written`.
It is the **subject** IDs that must stay free of any term (`X_Maths`, never
`X_Maths_Term_1`), which they are: nothing in the Subjects tab writes a term into a
subject ID. Confirmed 2026-08, so `AssessmentsTab.runBuilder`'s
`{subjectId}_{termId}_{slug(name)}` is unchanged.

The generator validates every row against the tabs' own rules and checks that no two
rows collide on `{subjectId}_{termId}_{slug(name)}`. A collision would silently merge
two assessments into one doc and drop a column from every teacher's sheet — and an
assessment doc ID can never be renamed once marks exist (AUDIT.md §4). It exits
non-zero rather than writing importable-looking rubbish.

## 4. Where the schema strains

**Co-scholastic had no grade dimension — fixed 2026-08.** `co_scholastic_activities`
now carries a `classIds` array (empty/absent = every class, as before; a non-empty array
scopes the activity to just those classes). Hillgreen's real activity data has been
re-imported against it. The exam dimension is unchanged: doc ID is still
`{termId}_{slug(name)}`, so an activity graded at all four exams still needs the exam
baked into the name (`ART/CRAFT PT 1`) or the second doc overwrites the first.

**Height and weight have nowhere to live.** The report card's Health & Discipline block
wants a per-term height and weight per student. No collection models it. Attendance at
least exists as sheet entries, though keyed by month or day rather than the per-term
present/total pair the card prints.

**The grading scale bands are integers.** `TermsScalesTab.validateLevelsCoverage`
requires `next.min === prev.max + 1`, so Hillgreen's scale (0–32, 33–40, 41–50, …) is
exactly what the editor wants. But that means a fractional percentage lands in no
band, and grand-total percentages are fractional constantly (61/150 = 40.67%).
**Whatever computes the grade must round or floor to an integer percentage first.**
`schoolSchema.js` used to be looser than the editor here — it checked only for overlap,
so a genuinely gapped scale passed server-side validation; it now enforces the same
contiguity rule.

## 5. Open questions for the school

1. **Do internal marks count towards the total?** `marks_conversion.xlsx` says
   Total = converted written + internal. The class 10 model card computes every total
   as **theory scaled to 100, with the internal column discarded** — Pre-Board I IT is
   printed as 34 (17/50 × 2) while theory + practical would be 65; Science is 29
   (23/80 × 1.25) not 35. The two documents contradict each other. We capture both
   numbers either way, so this blocks the Excel template, not the config.
2. **Is grade 10's Term II really two 100-mark pre-boards?** The sheet says PT 3 is
   50 marks for all of classes 3–12; the model card shows Pre-Board I and II at 100
   each and a 350 grand total. The card is assumed correct — confirm.
3. **Does the IT/AI 50+50 split apply to the 50-mark PTs too,** or only the 100-mark
   exams? The card only ever shows IT split in Term II. Currently applied to 100-mark
   exams only.
4. **Which co-scholastic activities apply to which grades?** RESOLVED at the schema
   level — `co_scholastic_activities.classIds` (added 2026-08) scopes an activity to
   specific classes instead of the whole school. Hillgreen's data has already been
   re-imported with real `classIds`.
5. **Grades 11–12 — BLOCKING, 44 of the 55 subjects supplied so far.** No model report
   card covers XI–XII, so it is unknown whether they follow the 6–12 row of the sheet
   (PT 3 + Prelim) or run two 100-mark pre-boards like grade X. The `grades-11-12` band
   is marked `"pending": true` and the generator emits **nothing** for it: a wrong doc ID
   cannot be renamed once marks exist, so the wrong docs would have to be deleted and any
   marks against them orphaned. Clear the flag once the school answers.
   Pre-Nursery and Nursery are not covered by the sheet at all and are skipped.
6. **Which subjects use 70 + 30 rather than 80 + 20?** The sheet writes "80/70" and
   "20/30" throughout without saying when. No sampled subject uses 70/30, so the
   pattern defaults to 80 + 20; add a `subjectOverrides` entry when the school answers.
7. **Grade X Marathi** is graded at PT 1, PT 2 and Pre-Board 1 on the card but not
   Pre-Board 2. Assumed an omission — the generator emits all four.
8. **Is `Seva` marked or graded?** Both `IX_Seva` and `X_Seva` read like a graded
   activity rather than a marked paper, but both are currently emitted as marked
   (Written + Internal) — no report card shows Seva at all, so there is no evidence
   either way. `HPE` and `PE_Additional` raise the same question in the pending
   XI–XII band. To switch a subject to graded, add its ID to `gradedSubjects.ids`
   in `tools/patterns/hillgreen.json` (see §2) — never the subjects CSV, which
   carries no such signal.
9. **Grade X subject list vs the model card.** The card shows a single "Science" and
   "Social studies"; the live list has `X_Biology`, `X_Chemistry`, `X_Physics` and
   `X_Social_Studies`. The live list is used. Confirm the card is simply an older
   sample and not a different reporting grouping.
10. **`II_Conc` and `*_Kaushal_Bodh` (VI–VIII) — no evidence either way.** Neither
    appears in any of the three sample report cards or the marks sheet. Both are
    currently generated as marked, on the same footing as every other subject in
    their band — the marks sheet's own title is "For All Exams," with no carve-out.
    If either is actually graded, or on a different scheme entirely, add it to
    `gradedSubjects.ids` or a new `subjectOverrides` entry.
