#!/usr/bin/env python3
"""Emit resolver fixtures + Python results for the JS parity check.

    python3 tools/check_resolver_parity.py && node tools/check_resolver_parity.mjs

Writes tools/.resolver_fixtures.json (gitignored). See the .mjs for why.
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "functions"))

from shared.class_resolver import (  # noqa: E402
    parse_class_value, notation_of, ordinal_to_token,
)

# Every format the task names, plus the ones that caused real bugs. Keep this
# list in step with functions/shared/tests/test_class_resolver.py.
PARSE_CASES = [
    "I_Diamond", "1-B", "Grade 1 B", "I B", "STD I - B", "LKG-Winner",
    "Nursery", "UKG", "Jr KG", "Sr KG", "Pre Nursery A", "Nursery A",
    "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII",
    "1", "2", "5", "9", "10", "11", "12",
    "  I_Diamond  ", "i_diamond", "I__Diamond", "I / Diamond", "I.Diamond",
    "GRADE I DIAMOND", "std i-diamond", "Class I : Diamond",
    "1B", "10A", "1st", "2nd A", "3rd", "10th B",
    "IX-A", "X A", "XII Rose", "Class-1-B", "1/B", "1 B",
    "Batch Alpha", "", "   ", "1st Std", "LKG", "lkg", "L K G", "kg1", "KG 2",
    "VIII_Emerald", "VI-Sunflower", "Standard 4 - C", "cls 7 D",
    # Real values from the live estate (tools/class_inventory.py, 20 schools,
    # 11,617 students). The grade_*_* family was 1,836 unresolved students and
    # is the reason both implementations reorder separator/prefix handling.
    "grade_I_A", "grade_I_B", "grade_I_C", "grade_II_A", "grade_II_B",
    "grade_II_C", "grade_III_A", "grade_III_B", "grade_III_C", "grade_IV_A",
    "grade_IV_B", "grade_IV_C", "grade_IV_D", "grade_VII_A", "grade_VII_B",
    "grade_VII_C", "grade_VII_D", "grade_X_A",
    # Must stay UNRESOLVED in both languages — seed rows, opaque ids and
    # stage names. A split brain here would file real students beside fake.
    "Sample", "sample", "SampleClass", "Sample Class", "sample_middle",
    "Sample Class I", "Sample_Class_I", "Sample Class II",
    "sakc0001", "sccs1944", "ssse0001", "sss0001",
    "en6l4KUFWa3IDnWmai44", "Mm0WAY2kGmDlDwJJaGHK",
    "foundation", "middle", "prep", "Smr_Sr_A", "Smr_Jr_A", "VB",
]

NOTATION_CASES = [
    ["I_A", "II_A", "III_B"],
    ["1_A", "2_A", "3_B"],
    ["I_A", "1_A"],
    [],
    ["LKG_A", "UKG_B"],
]

ORDINAL_CASES = [
    (1, "roman"), (1, "numeric"), (2, "roman"), (2, "numeric"),
    (12, "roman"), (12, "numeric"), (0, "roman"), (-1, "roman"),
    (-2, "roman"), (-3, "roman"), (13, "roman"), (99, "numeric"),
]


def main():
    out = {"parse": [], "notation": [], "ordinal_to_token": []}

    for raw in PARSE_CASES:
        p = parse_class_value(raw)
        out["parse"].append({
            "raw": raw,
            "grade_ordinal": p["grade_ordinal"],
            "grade_canonical": p["grade_canonical"],
            "section": p["section"],
            "confidence": p["confidence"],
        })

    for ids in NOTATION_CASES:
        out["notation"].append({"class_ids": ids, "notation": notation_of(ids)})

    for ordinal, notation in ORDINAL_CASES:
        out["ordinal_to_token"].append({
            "ordinal": ordinal, "notation": notation,
            "token": ordinal_to_token(ordinal, notation),
        })

    dest = os.path.join(ROOT, "tools", ".resolver_fixtures.json")
    with open(dest, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=1)
    total = sum(len(v) for v in out.values())
    print(f"Wrote {total} fixtures to tools/.resolver_fixtures.json")
    print("Now run:  node tools/check_resolver_parity.mjs")


if __name__ == "__main__":
    main()
