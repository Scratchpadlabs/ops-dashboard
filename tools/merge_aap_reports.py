"""
Merge AAP pages into Hillgreen report cards.

Every report PDF in the reports folder has 2 pages per student:
    page 1 = report card (has "Student's Name" and "Class & Section")
    page 2 = placeholder with only the student ID (e.g. shh0137)

For each student, the placeholder page is REPLACED by that student's AAP PDF,
found anywhere under the AAP folder. The AAP file is matched by the student ID
in its file name (shh0137.pdf, SHH0137_AAP.pdf, "AAP - shh0137.pdf" all work).

Whatever is available gets matched:
    - report card with an AAP     -> report card + AAP pages
    - report card without an AAP  -> report card only (flagged in the log)
    - AAP without a report card   -> listed in the log, not merged

Outputs (inside --out):
    combined/Grade_<n>_combined.pdf      (one per grade found)
    combined/All_Grades_combined.pdf
    individual/<Class>_<Section>/<StudentName>_<Class>-<Section>_<id>.pdf
    merge_log.csv   (one row per student + one row per unused AAP file)

Usage (Windows):
    pip install pypdf
    python merge_aap_reports.py
    python merge_aap_reports.py --reports "C:\\...\\final pdf" --aap "C:\\...\\AAP_class" --out "C:\\...\\Final"
"""

import argparse
import csv
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

from pypdf import PdfReader, PdfWriter

BASE = Path(r"C:\Users\scrat\OneDrive\Term 1 (26-27)\hillgreen")
DEFAULT_REPORTS = BASE / "final pdf"
DEFAULT_AAP = BASE / "AAP_class"
DEFAULT_OUT = BASE / "Final"

NAME_RE = re.compile(r"Student's Name:\s*(.+)")
CLASS_RE = re.compile(r"Class\s*&\s*Section:\s*(\d+)\s*-\s*([A-Za-z]+)")
ID_RE = re.compile(r"\b([A-Za-z]{2,5}\d{3,6})\b")
# looser version for file names, where the ID may be glued to "_AAP" etc.
FILE_ID_RE = re.compile(r"(?<![A-Za-z])([A-Za-z]{2,5}\d{3,6})(?!\d)")


def safe(text: str) -> str:
    """Make a string safe for Windows file names."""
    text = re.sub(r'[<>:"/\\|?*]', "", text)
    return re.sub(r"\s+", " ", text).strip()


def is_inside(path: Path, folder: Path) -> bool:
    try:
        path.resolve().relative_to(folder.resolve())
        return True
    except ValueError:
        return False


def grade_key(grade: str):
    return (0, int(grade), "") if grade.isdigit() else (1, 0, grade)


def index_aap_files(aap_root: Path) -> dict:
    """Map lowercase student id -> path of its AAP pdf (skips *_all_students files)."""
    index, dupes = {}, []
    for p in sorted(aap_root.rglob("*.pdf")):
        stem = p.stem.strip()
        if "all_students" in stem.lower():
            continue
        m = FILE_ID_RE.search(stem)
        if not m:
            print(f"WARNING: no student ID in AAP file name, skipped: {p.name}")
            continue
        key = m.group(1).lower()
        if key in index:
            dupes.append((key, index[key], p))
        index[key] = p
    for key, a, b in dupes:
        print(f"WARNING: duplicate AAP file for {key}:\n   {a}\n   {b}  (using this one)")
    return index


def parse_students(reader: PdfReader, source: Path) -> list:
    """Walk one report PDF and pair each report page with the ID page after it."""
    students, i, n = [], 0, len(reader.pages)
    while i < n:
        text = reader.pages[i].extract_text() or ""
        name_m, class_m = NAME_RE.search(text), CLASS_RE.search(text)
        if not name_m:
            if text.strip():
                print(f"WARNING: {source.name} page {i + 1} is not a report page and not paired; skipped")
            i += 1
            continue

        sid = None
        if i + 1 < n:
            id_text = (reader.pages[i + 1].extract_text() or "").strip()
            id_m = ID_RE.search(id_text)
            if id_m and not NAME_RE.search(id_text):
                sid = id_m.group(1)

        students.append({
            "reader": reader,
            "source": source,
            "page": i,
            "name": safe(name_m.group(1)),
            "grade": class_m.group(1) if class_m else "NA",
            "section": class_m.group(2).upper() if class_m else "NA",
            "id": sid,
        })
        i += 2 if sid else 1
    return students


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--reports", default=str(DEFAULT_REPORTS), help="Folder with the report card PDFs")
    ap.add_argument("--aap", default=str(DEFAULT_AAP), help="Folder with the AAP PDFs (searched recursively)")
    ap.add_argument("--out", default=str(DEFAULT_OUT), help="Output folder")
    args = ap.parse_args()

    reports_dir, aap_dir, out = Path(args.reports), Path(args.aap), Path(args.out)
    for label, d in (("Reports", reports_dir), ("AAP", aap_dir)):
        if not d.is_dir():
            print(f"ERROR: {label} folder not found: {d}")
            return 1

    (out / "combined").mkdir(parents=True, exist_ok=True)
    (out / "individual").mkdir(parents=True, exist_ok=True)

    # read every report PDF (skip anything inside the output folder)
    students = []
    report_files = [p for p in sorted(reports_dir.rglob("*.pdf")) if not is_inside(p, out)]
    for rp in report_files:
        try:
            found = parse_students(PdfReader(str(rp)), rp)
        except Exception as e:
            print(f"WARNING: could not read report {rp.name}: {e}")
            continue
        print(f"  {rp.name}: {len(found)} students")
        students.extend(found)

    aap_index = index_aap_files(aap_dir)
    print(f"Found {len(students)} students in {len(report_files)} report PDFs, {len(aap_index)} AAP files")

    # combined PDFs go grade -> section -> original order
    students.sort(key=lambda s: (grade_key(s["grade"]), s["section"]))
    id_counts = Counter(s["id"].lower() for s in students if s["id"])

    grade_writers = defaultdict(PdfWriter)
    all_writer = PdfWriter()
    aap_cache = {}
    log, used_ids, used_names = [], set(), set()

    for s in students:
        warn = []
        pages = [s["reader"].pages[s["page"]]]
        sid = s["id"].lower() if s["id"] else None

        aap_path = aap_index.get(sid) if sid else None
        if not sid:
            warn.append("no ID page found")
        elif not aap_path:
            warn.append("AAP file missing")
        else:
            used_ids.add(sid)
            try:
                if aap_path not in aap_cache:
                    aap_cache[aap_path] = PdfReader(str(aap_path))
                pages.extend(aap_cache[aap_path].pages)
            except Exception as e:
                warn.append(f"AAP file unreadable: {e}")
                aap_path = None
        if sid and id_counts[sid] > 1:
            warn.append(f"ID appears {id_counts[sid]} times in reports")

        # individual file
        cls = f"{s['grade']}-{s['section']}"
        folder = out / "individual" / f"{s['grade']}_{s['section']}"
        folder.mkdir(parents=True, exist_ok=True)
        base = f"{s['name']}_{cls}_{s['id'] or 'NOID'}"
        fname, k = f"{base}.pdf", 2
        while (folder / fname).as_posix().lower() in used_names:
            fname, k = f"{base}_{k}.pdf", k + 1
        used_names.add((folder / fname).as_posix().lower())
        w = PdfWriter()
        for p in pages:
            w.add_page(p)
        with open(folder / fname, "wb") as f:
            w.write(f)

        # combined files
        for p in pages:
            grade_writers[s["grade"]].add_page(p)
            all_writer.add_page(p)

        if warn:
            print(f"WARNING: {s['name']} ({cls}, {s['id']}): {'; '.join(warn)}")
        log.append([s["name"], cls, s["id"] or "", s["source"].name, str(aap_path or ""),
                    len(pages), "; ".join(warn)])

    for grade, w in sorted(grade_writers.items(), key=lambda kv: grade_key(kv[0])):
        with open(out / "combined" / f"Grade_{grade}_combined.pdf", "wb") as f:
            w.write(f)
    if students:
        with open(out / "combined" / "All_Grades_combined.pdf", "wb") as f:
            all_writer.write(f)

    unused = sorted(set(aap_index) - used_ids)
    if unused:
        print(f"NOTE: {len(unused)} AAP files had no matching report card: {', '.join(unused)}")
    for sid in unused:
        log.append(["", "", sid, "", str(aap_index[sid]), 0, "AAP has no matching report card"])

    with open(out / "merge_log.csv", "w", newline="", encoding="utf-8") as f:
        cw = csv.writer(f)
        cw.writerow(["name", "class", "id", "report_file", "aap_file", "pages", "warnings"])
        cw.writerows(log)

    matched = sum(1 for r in log if r[5] > 1)
    print(f"\nDone. {len(students)} students: {matched} with AAP, {len(students) - matched} without; "
          f"{len(unused)} unused AAP files. See {out / 'merge_log.csv'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
