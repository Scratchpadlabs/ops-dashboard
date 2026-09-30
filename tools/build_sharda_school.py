#!/usr/bin/env python3
"""Build a new Sharda English School branch in Firestore from the school's
material folder, cloning the academic structure of an existing branch.
DRY RUN by default — nothing is written unless --apply is passed.

    python3 tools/build_sharda_school.py --project clarified-1501 \\
        --source shardakalamb --target shardakaij \\
        --name "Sharda English School, Kaij" --city Kaij \\
        --student-prefix sskj --teacher-prefix tskj \\
        --material "path/to/rece.material kaij"

    ... same flags ... --apply

    # parse the material only (no Firestore at all) and print the report:
    python3 tools/build_sharda_school.py --target shardakaij \\
        --student-prefix sskj --teacher-prefix tskj --material DIR --offline

The Sharda branches share one report card (Per. Test 10 / Note Book 5 /
SEA 5 / Half Yearly 80 per term, 8-point scholastic and 3-point
co-scholastic scales), so the structure is cloned from --source and only the
people and sections come from the material:

  cloned from source   terms, grading_scales, months, subjects (curricular
                       goals + topics), assessments, remark_categories
                       (classIds re-pointed by stage), config/students_schema
                       (class options regenerated)
  from the material    classes (one per student sheet), students (one per
                       row), staffs (Teacher Information.xlsx), and
                       co_scholastic_activities (Class-wise Subject Details)

Subjects the source doesn't have are cloned from the nearest one: Nursery_X
from LKG_X, and {III,IV}_English_Grammar from {III,IV}_English (same goals,
same four assessments per term).

Never copied: the source's students, staffs, sheets/entries, surveys,
activities or any progress. Surveys are assigned afterwards from the
dashboard's Surveys page, logins from School Setup → Publish (every
new staff/student doc has needsAuthCreation: true; the password is the doc
id, same as create_auth_accounts).

The target school must not exist yet; --apply refuses otherwise.

Material layout this reads (as the Sharda schools send it):
  - one .xlsx per grade, one sheet per section; a title row, then a header
    row with Roll no. / Students ID / Name / Class-Section (or Class +
    Section) / Gender / DOB / Mothers Name / Address
  - Teacher Information.xlsx: one sheet per grade band, header row with
    School Unique Id / Class Teacher / Teachers Name / Mail id and one column
    per subject whose cells read "Grade 5,6"
  - Class-wise Subject Details_HPC.xlsx: per-band scholastic and
    co-scholastic subject lists
"""

import argparse
import datetime
import glob
import json
import os
import re
import sys
from collections import Counter, OrderedDict, defaultdict

SCRIPT = "tools/build_sharda_school.py"

GRADES = ["Nursery", "LKG", "UKG", "I", "II", "III", "IV", "V", "VI", "VII",
          "VIII", "IX", "X"]
NUM_TO_ROMAN = {1: "I", 2: "II", 3: "III", 4: "IV", 5: "V", 6: "VI", 7: "VII",
                8: "VIII", 9: "IX", 10: "X"}
# Same stage literals as the source school (and the teacher app) — including
# the "prepratory" misspelling, which is what the data carries.
STAGE = {"Nursery": "foundation", "LKG": "foundation", "UKG": "foundation",
         "I": "foundation", "II": "foundation", "III": "prepratory",
         "IV": "prepratory", "V": "prepratory", "VI": "middle",
         "VII": "middle", "VIII": "middle", "IX": "secondary",
         "X": "secondary"}
# remark_categories doc ids in the source start with one of these.
REMARK_STAGE_PREFIX = {"Foundational": "foundation", "Preparatory": "prepratory",
                       "Middle": "middle", "Secondary": "secondary"}

# Section names the schools spell a dozen ways ("II-Winners", "I Champions",
# "LKG-champion") → one canonical, singular section per class id.
SECTIONS = ["Winner", "Champion", "Victor", "Star", "Scholar", "Yellow"]

# Scholastic subjects per grade: the source school's subject ids
# (Kalamb puts Numbers / Rhymes / Art and Craft / Sound for pre-primary under
# co-scholastic, and so do we).
SUBJECTS_BY_GRADE = {
    "Nursery": ["English", "Maths", "General_Awareness"],
    "LKG": ["English", "Maths", "General_Awareness"],
    "UKG": ["English", "Maths", "Hindi", "General_Awareness"],
    "I": ["English", "Hindi", "Marathi", "Maths", "EVS", "IT"],
    "II": ["English", "Hindi", "Marathi", "Maths", "EVS", "IT"],
    "III": ["English", "Hindi", "Marathi", "Maths", "Science", "Social_Science", "IT", "English_Grammar"],
    "IV": ["English", "Hindi", "Marathi", "Maths", "Science", "Social_Science", "IT", "English_Grammar"],
}
for _g in ["V", "VI", "VII", "VIII", "IX", "X"]:
    SUBJECTS_BY_GRADE[_g] = ["English", "Hindi", "Marathi", "Maths", "Science", "Social_Science", "IT"]
SUBJECT_DISPLAY = {"English_Grammar": "English Grammar"}

# Where a subject the source lacks is cloned from.
def source_subject_id(subject_id):
    grade, _, name = subject_id.partition("_")
    if grade == "Nursery":
        return f"LKG_{name}"
    if name == "English_Grammar":
        return f"{grade}_English"
    return subject_id

# Teacher sheet subject column headers → subject name part of the id.
TEACHER_SUBJECT_COLUMNS = {
    "english": "English", "hindi": "Hindi", "marathi": "Marathi",
    "science": "Science", "mathematics": "Maths", "social science": "Social_Science",
    "it": "IT", "evs": "EVS", "english grammar": "English_Grammar",
}

# Co-scholastic, from Class-wise Subject Details_HPC.xlsx. One doc per term,
# scoped with classIds, graded on the source's 3-point scale like Kalamb's.
PRIMARY_CO_SCHOLASTIC = ["Work Education", "Art Education",
                         "Health and Physical Education", "Scientific Skills",
                         "Thinking Skills", "Social Skills", "Sports"]
PRE_PRIMARY_CO_SCHOLASTIC = {
    "Personal Hygiene and Self-care": ["Nursery", "LKG", "UKG"],
    "Social Interaction with Peers": ["Nursery", "LKG", "UKG"],
    "Respect and Courtesy": ["Nursery", "LKG", "UKG"],
    "Sharing and Co-operation": ["Nursery", "LKG", "UKG"],
    "Communication Skills": ["Nursery", "LKG", "UKG"],
    "Punctuality and Regularity": ["Nursery", "LKG", "UKG"],
    # scholastic on the school's list, co-scholastic in the source's structure
    "Numbers": ["Nursery", "LKG", "UKG"],
    "Rhymes and Stories": ["Nursery", "LKG", "UKG"],
    "Art and Craft": ["Nursery", "LKG", "UKG"],
    "Sound": ["LKG", "UKG"],
}
CO_SCHOLASTIC_SCALE = "Sharda_3_Point_Scale"

META_KEYS = {"created_at", "created_by", "updated_at", "updated_by"}


# ─── material parsing (no Firestore) ────────────────────────────────────────

def norm(s):
    return re.sub(r"\s+", " ", str(s if s is not None else "")).strip()


def clean_text(s):
    s = str(s if s is not None else "").replace("_x000D_", " ")
    return norm(s)


def slug(text):
    return re.sub(r"[^A-Za-z0-9]+", "_", text).strip("_")


def id_text(v):
    """1071 / 1071.0 / ' 1071 ' → '1071'."""
    return str(int(v)) if isinstance(v, (int, float)) else norm(v)


def parse_grade(text):
    """'II-Winners' / 'IV -victors' / '9th Victors' / 'LKG-champion' / 'I '
    → 'II' / 'IV' / 'IX' / 'LKG' / 'I', or None."""
    t = norm(text).upper()
    for g in ["NURSERY", "LKG", "UKG"]:
        if t.startswith(g):
            return g.title() if g == "NURSERY" else g
    m = re.match(r"^(\d{1,2})\s*(ST|ND|RD|TH)?\b", t)
    if m:
        return NUM_TO_ROMAN.get(int(m.group(1)))
    m = re.match(r"^(X|IX|VIII|VII|VI|V|IV|III|II|I)\b", t)
    return m.group(1) if m else None


def parse_section(text):
    t = norm(text).lower()
    for s in SECTIONS:
        if s.lower() in t:
            return s
    return None


def class_id(grade, section):
    return f"{grade}_{section}"


def header_index(header):
    """Map the (misspelt, inconsistently spaced) header row to field → col."""
    idx = {}
    for i, h in enumerate(header):
        k = re.sub(r"[^a-z]", "", str(h or "").lower())
        if not k:
            continue
        if k.startswith("roll"):
            idx.setdefault("roll", i)
        elif k.startswith("stud") and k.endswith("id"):
            # IX-Victor labels the name column "Students ID" too — the first
            # one is the id, a second one is the name.
            if "sid" in idx:
                idx.setdefault("name", i)
            else:
                idx["sid"] = i
        elif ("name" in k or "nme" in k or "student" in k) and "mother" not in k and "father" not in k:
            idx.setdefault("name", i)
        elif k.startswith("class") or k.startswith("clas"):
            idx.setdefault("class", i)
        elif k == "section":
            idx.setdefault("section", i)
        elif k.startswith("gender"):
            idx.setdefault("gender", i)
        elif k in ("dob", "dateofbirth"):
            idx.setdefault("dob", i)
        elif k.startswith("mother"):
            idx.setdefault("mother", i)
        elif k.startswith("ad") and "dress" in k:
            idx.setdefault("address", i)
    return idx


def find_header(rows):
    for n, r in enumerate(rows[:6]):
        cells = [re.sub(r"[^a-z]", "", str(c or "").lower()) for c in r]
        if any(c.startswith("roll") for c in cells) and any("name" in c for c in cells):
            return n
    return None


def as_excel_date(v):
    """Real Excel dates come back as datetime; a few cells hold the bare
    serial number (41334) because the column was formatted General."""
    if isinstance(v, datetime.datetime):
        return v
    if isinstance(v, (int, float)) and 20000 < v < 60000:
        return datetime.datetime(1899, 12, 30) + datetime.timedelta(days=int(v))
    return None


def sheet_dates_swapped(rows, dob_col):
    """Excel stored dd/mm typed dates as mm/dd whenever the day was ≤ 12, and
    left the rest as 'dd/mm/yyyy' text. A sheet whose real dates never have
    a day > 12 but whose text dates do was typed dd/mm → swap day/month back.
    (Class I's file holds genuine dates, days up to 31, and is left alone.)"""
    real = [d for d in (as_excel_date(r[dob_col]) for r in rows) if d]
    if not real or any(d.day > 12 for d in real):
        return False
    return True


def parse_dob(value, swapped, issues, where):
    if value in (None, ""):
        return None
    if as_excel_date(value):
        value = d = as_excel_date(value)
        if swapped:
            try:
                d = value.replace(month=value.day, day=value.month)
            except ValueError:
                issues.append(f"{where}: cannot un-swap date {value.date()} — left as is")
    else:
        m = re.match(r"^\s*(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\s*$", str(value))
        if not m:
            issues.append(f"{where}: unreadable DOB {value!r} — left blank")
            return None
        try:
            d = datetime.datetime(int(m.group(3)), int(m.group(2)), int(m.group(1)))
        except ValueError:
            issues.append(f"{where}: invalid DOB {value!r} — left blank")
            return None
    return d.replace(tzinfo=datetime.timezone.utc)


def parse_students(material, issues):
    import openpyxl
    students, sheets = [], []
    for path in sorted(glob.glob(os.path.join(material, "*.xlsx"))):
        base = os.path.basename(path).lower()
        if "teacher" in base or "subject" in base:
            continue
        wb = openpyxl.load_workbook(path, data_only=True)
        for ws in wb.worksheets:
            rows = [list(r) for r in ws.iter_rows(values_only=True)]
            rows = [r for r in rows if any(c not in (None, "") for c in r)]
            if not rows:
                continue
            h = find_header(rows)
            if h is None:
                issues.append(f"{os.path.basename(path)} [{ws.title}]: no header row found — sheet skipped")
                continue
            idx = header_index(rows[h])
            data = [r + [None] * (len(rows[h]) - len(r)) for r in rows[h + 1:]]
            data = [r for r in data if r[idx["name"]] not in (None, "")]
            title = ws.title if ws.title.lower() not in ("sheet1",) else os.path.splitext(os.path.basename(path))[0]
            grade = parse_grade(title)
            section = parse_section(title) or ("A" if grade == "Nursery" else None)
            if not grade or not section:
                issues.append(f"{os.path.basename(path)} [{ws.title}]: cannot tell grade/section — sheet skipped")
                continue
            cid = class_id(grade, section)
            swapped = "dob" in idx and sheet_dates_swapped(data, idx["dob"])
            sheets.append({"file": os.path.basename(path), "sheet": ws.title, "classId": cid,
                           "rows": len(data), "datesSwapped": swapped})
            for r in data:
                where = f"{ws.title} row '{norm(r[idx['name']])}'"
                # The sheet is the class; a disagreeing Class/Section cell is flagged.
                cell = " ".join(norm(r[idx[k]]) for k in ("class", "section") if k in idx)
                if cell and grade != "Nursery":
                    cg, cs = parse_grade(cell), parse_section(cell)
                    if (cg and cg != grade) or (cs and cs != section):
                        issues.append(f"{where}: Class/Section cell says {cell!r} but it is on the {cid} sheet — kept in {cid}")
                raw_gender = norm(r[idx["gender"]]) if "gender" in idx else ""
                # "Mle" / "Feamle" / "Feamale" — the first letter is reliable.
                gender = {"m": "Male", "f": "Female"}.get(raw_gender[:1].lower(), "")
                if raw_gender and not gender:
                    issues.append(f"{where}: gender {raw_gender!r} not understood — left blank")
                dob = parse_dob(r[idx["dob"]], swapped, issues, where) if "dob" in idx else None
                if dob and not (2008 <= dob.year <= 2024):
                    issues.append(f"{where}: DOB {dob.date()} can't be right for {grade} — left blank")
                    dob = None
                sid = r[idx["sid"]] if "sid" in idx else None
                students.append({
                    "name": norm(r[idx["name"]]),
                    "currentClassId": cid,
                    "rollNo": id_text(r[idx["roll"]]) if "roll" in idx else "",
                    "admNo": id_text(sid),
                    "gender": gender,
                    "dateOfBirth": dob,
                    "address": clean_text(r[idx["address"]]) if "address" in idx else "",
                })
    # admNo is informational only (doc ids are generated), so a reused
    # Students ID is reported per pair of sheets, not per student.
    by_id = defaultdict(list)
    for s in students:
        if s["admNo"]:
            by_id[s["admNo"]].append(s["currentClassId"])
    clashes = defaultdict(list)
    for k, cids in by_id.items():
        if len(cids) > 1:
            clashes[" & ".join(sorted(set(cids)))].append(int(k) if k.isdigit() else k)
    for pair, ids in sorted(clashes.items()):
        ids.sort(key=str)
        issues.append(f"Students ID reused across {pair}: {len(ids)} ids ({ids[0]}…{ids[-1]}) — kept as admNo, doc ids are unaffected")
    return students, sheets


def parse_teacher_class(text):
    """'8th Victor' / 'IV -Victor' / 'II-Scholars' / 'Nursery ' → class id;
    'Principal' → 'PRINCIPAL'; blank → None."""
    t = norm(text)
    if not t:
        return None
    if t.lower() == "principal":
        return "PRINCIPAL"
    g = parse_grade(t)
    if not g:
        return "?" + t
    s = parse_section(t) or ("A" if g == "Nursery" else None)
    return class_id(g, s) if s else "?" + t


def parse_grade_list(text):
    """'Grade 5,6' / 'Garde 7,10' / 'Grade7,8,9' / 'Grdae 1' → ['V','VI',...]."""
    return [NUM_TO_ROMAN[int(n)] for n in re.findall(r"\d{1,2}", str(text or "")) if int(n) in NUM_TO_ROMAN]


def clean_email(raw):
    v = norm(raw).lower()
    for bad, good in {"gamil.com": "gmail.com", "gmial.com": "gmail.com", "gmal.com": "gmail.com",
                      "gmaill.com": "gmail.com", "yahooo.com": "yahoo.com"}.items():
        if v.endswith("@" + bad):
            v = v[: -len(bad)] + good
    # "x@485gmail.com" passes a shape check but no real domain starts with digits
    return v, bool(re.match(r"^[^@\s]+@[a-z][^@\s]*\.[a-z]{2,}$", v))


def parse_teachers(material, class_ids, issues):
    import openpyxl
    path = next(iter(glob.glob(os.path.join(material, "Teacher*.xlsx"))), None)
    if not path:
        issues.append("No Teacher Information.xlsx found — no staff built")
        return []
    classes_by_grade = defaultdict(list)
    for cid in class_ids:
        classes_by_grade[cid.split("_")[0]].append(cid)
    teachers = []
    wb = openpyxl.load_workbook(path, data_only=True)
    for ws in wb.worksheets:
        rows = [list(r) for r in ws.iter_rows(values_only=True)]
        header_row = next((n for n, r in enumerate(rows)
                           if any("teacher" in str(c or "").lower() and "name" in str(c or "").lower() for c in r)), None)
        if header_row is None:
            continue
        header = [norm(c).lower() for c in rows[header_row]]
        col = {h: i for i, h in enumerate(header) if h}
        c_id = next(i for h, i in col.items() if "unique" in h)
        c_ct = next(i for h, i in col.items() if "class teacher" in h)
        c_name = next(i for h, i in col.items() if "teachers name" in h)
        c_mail = next(i for h, i in col.items() if "mail" in h)
        subj_cols = {i: TEACHER_SUBJECT_COLUMNS[h] for h, i in col.items() if h in TEACHER_SUBJECT_COLUMNS}
        pre_primary = False
        for r in rows[header_row + 1:]:
            r = r + [None] * (len(header) - len(r))
            if any("nursery to ukg" in str(c or "").lower() for c in r):
                # The pre-primary block under the 1–2 sheet: column E lists the
                # subjects of the teacher's own class ("Eng, math, GA").
                pre_primary = True
                continue
            name = norm(r[c_name])
            if not name:
                continue
            uid = r[c_id]
            where = f"Teacher {uid} {name}"
            ct = parse_teacher_class(r[c_ct])
            classTeacherOf = ""
            admin = False
            if ct == "PRINCIPAL":
                admin = True
            elif ct and ct.startswith("?"):
                issues.append(f"{where}: class teacher cell {ct[1:]!r} not understood — ignored")
            elif ct and ct not in class_ids:
                issues.append(f"{where}: class teacher of {ct}, which has no student sheet — ignored")
            elif ct:
                classTeacherOf = ct
            assignments = defaultdict(set)
            own_grade = classTeacherOf.split("_")[0] if classTeacherOf else None
            if pre_primary:
                if classTeacherOf:
                    for s in SUBJECTS_BY_GRADE[own_grade]:
                        assignments[classTeacherOf].add(f"{own_grade}_{s}")
            else:
                for i, subj in subj_cols.items():
                    grades = parse_grade_list(r[i])
                    for g in grades:
                        if subj not in SUBJECTS_BY_GRADE.get(g, []):
                            issues.append(f"{where}: {subj} for grade {g} — not a {g} subject, ignored")
                            continue
                        if g not in classes_by_grade:
                            issues.append(f"{where}: {subj} for grade {g} — no {g} classes (no student sheets), ignored")
                            continue
                        # Grades I–II are taught by their class teacher: a class
                        # teacher's "Grade N" there means their own section.
                        if own_grade in ("I", "II") and g in ("I", "II"):
                            if g != own_grade:
                                issues.append(f"{where}: class teacher of {classTeacherOf} but listed {subj} for grade {g} — assigned to {classTeacherOf}")
                            assignments[classTeacherOf].add(f"{own_grade}_{subj}")
                        else:
                            for cid in classes_by_grade[g]:
                                assignments[cid].add(f"{g}_{subj}")
            email, ok = clean_email(r[c_mail])
            if r[c_mail] and not ok:
                issues.append(f"{where}: e-mail {norm(r[c_mail])!r} is invalid — stored as contactEmail anyway, please correct")
            if not r[c_mail]:
                issues.append(f"{where}: no e-mail given")
            if not admin and not classTeacherOf and not assignments:
                issues.append(f"{where}: no class or subject could be assigned")
            teachers.append({
                "schoolUniqueId": str(uid) if uid is not None else "",
                "name": name,
                "contactEmail": email,
                "admin": admin,
                "classTeacherOf": classTeacherOf,
                "assignments": {k: sorted(v) for k, v in sorted(assignments.items())},
            })
    names = Counter(re.sub(r"[^a-z]", "", t["name"].lower()) for t in teachers)
    for t in teachers:
        if names[re.sub(r"[^a-z]", "", t["name"].lower())] > 1:
            issues.append(f"Teacher name {t['name']!r} appears more than once")
    return teachers


def order_class_ids(ids):
    return sorted(ids, key=lambda c: (GRADES.index(c.split("_")[0]),
                                      SECTIONS.index(c.split("_", 1)[1]) if c.split("_", 1)[1] in SECTIONS else -1))


def split_name(name):
    parts = name.split(" ", 1)
    return parts[0], (parts[1] if len(parts) > 1 else "")


def build_people(args, issues):
    students, sheets = parse_students(args.material, issues)
    class_ids = order_class_ids({s["currentClassId"] for s in students})
    teachers = parse_teachers(args.material, class_ids, issues)

    order = {cid: n for n, cid in enumerate(class_ids)}
    students.sort(key=lambda s: (order[s["currentClassId"]],
                                 int(s["rollNo"]) if s["rollNo"].isdigit() else 10**6, s["name"]))
    student_docs = OrderedDict()
    for n, s in enumerate(students, 1):
        sid = f"{args.student_prefix}{n:04d}"
        first, last = split_name(s["name"])
        student_docs[sid] = {
            "id": sid, "type": "student", "name": s["name"], "firstName": first, "lastName": last,
            "currentClassId": s["currentClassId"], "rollNo": s["rollNo"], "admNo": s["admNo"],
            "gender": s["gender"], "dateOfBirth": s["dateOfBirth"], "address": s["address"],
            "email": f"{sid}@{args.target}.com", "phoneNo": None, "aadhaarNumber": "",
            "grEmisSts": "", "balance": None, "avatar": None, "profileUrl": "",
            "authUid": None, "needsAuthCreation": True,
        }

    all_subjects = {cid: [f"{cid.split('_')[0]}_{s}" for s in SUBJECTS_BY_GRADE[cid.split("_")[0]]] for cid in class_ids}
    staff_docs = OrderedDict()
    for n, t in enumerate(teachers, 1):
        tid = f"{args.teacher_prefix}{n:04d}"
        first, last = split_name(t["name"])
        if t["admin"]:
            assignments = dict(all_subjects)
            class_list = list(class_ids)
            co = list(class_ids)
        else:
            assignments = t["assignments"]
            class_list = order_class_ids(set(assignments) | ({t["classTeacherOf"]} if t["classTeacherOf"] else set()))
            co = [t["classTeacherOf"]] if t["classTeacherOf"] else []
        staff_docs[tid] = {
            "id": tid, "staffId": tid, "type": "teacher", "name": t["name"],
            "firstName": first, "lastName": last, "admin": t["admin"],
            "classTeacherOf": t["classTeacherOf"], "classIds": class_list,
            "coScholasticClassIds": co, "assignments": assignments,
            "email": f"{tid}@{args.target}.com", "contactEmail": t["contactEmail"],
            "schoolUniqueId": t["schoolUniqueId"], "phoneNo": None, "sex": "",
            "profileUrl": "", "authUid": None, "needsAuthCreation": True,
        }
    return class_ids, student_docs, staff_docs, sheets


# ─── structure (reads the source school) ────────────────────────────────────

def strip_meta(d):
    return {k: v for k, v in d.items() if k not in META_KEYS}


def rename_prefix(value, old, new):
    """Deep-replace the subject id prefix in topic ids etc."""
    if isinstance(value, str):
        return new + value[len(old):] if value == old or value.startswith(old + "_") else value
    if isinstance(value, list):
        return [rename_prefix(v, old, new) for v in value]
    if isinstance(value, dict):
        return {k: rename_prefix(v, old, new) for k, v in value.items()}
    return value


def build_structure(src, class_ids, issues):
    """src: {collection: {doc_id: dict}} read from the source school."""
    docs = defaultdict(OrderedDict)
    for col in ("terms", "grading_scales", "months"):
        for did, d in src[col].items():
            docs[col][did] = strip_meta(d)
    term_ids = sorted(docs["terms"])

    # Subjects and their per-class topic lists.
    class_topics = {}  # source subject id → topics list as the source classes carry it
    for d in src["classes"].values():
        for s in d.get("subjects", []):
            class_topics.setdefault(s["subjectId"], s.get("topics", []))
    grades = []
    for cid in class_ids:
        g = cid.split("_")[0]
        if g not in grades:
            grades.append(g)
    subject_ids = [f"{g}_{s}" for g in grades for s in SUBJECTS_BY_GRADE[g]]
    for sid in subject_ids:
        srcid = source_subject_id(sid)
        if srcid not in src["subjects"]:
            issues.append(f"Subject {sid}: source subject {srcid} not found in the source school — skipped")
            continue
        d = rename_prefix(strip_meta(src["subjects"][srcid]), srcid, sid)
        d["id"] = sid
        name = sid.split("_", 1)[1]
        if name in SUBJECT_DISPLAY:
            d["name"] = SUBJECT_DISPLAY[name]
        for t in d.get("topics", []) or []:
            if isinstance(t, dict) and "survey_initiated_by" in t:
                t["survey_initiated_by"] = {}
        docs["subjects"][sid] = d
        n = 0
        for aid, a in src["assessments"].items():
            if a.get("subjectId") == srcid:
                new_id = sid + aid[len(srcid):] if aid.startswith(srcid + "_") else f"{sid}_{aid}"
                docs["assessments"][new_id] = dict(strip_meta(a), subjectId=sid)
                n += 1
        if not n:
            issues.append(f"Subject {sid}: source {srcid} has no assessments")

    for cid in class_ids:
        g, sec = cid.split("_", 1)
        subjects = []
        for sid in subject_ids:
            if not sid.startswith(g + "_") or sid not in docs["subjects"]:
                continue
            srcid = source_subject_id(sid)
            topics = [{"id": rename_prefix(t["id"], srcid, sid), "topic": t.get("topic", ""),
                       "isCompleted": False, "survey_initiated_by": {}}
                      for t in class_topics.get(srcid, [])]
            subjects.append({"subjectId": sid, "teacherId": "", "isCompleted": False,
                             "completedAt": None, "topics": topics})
        docs["classes"][cid] = {"id": cid, "name": f"{g} {sec}", "clazz": g, "section": sec,
                                "stage": STAGE[g], "isActive": True, "subjects": subjects}

    # Remark categories: same remarks, classIds re-pointed at this school's
    # classes of the same stage.
    for did, d in src["remark_categories"].items():
        d = strip_meta(d)
        stage = next((st for p, st in REMARK_STAGE_PREFIX.items() if did.startswith(p)), None)
        if "classIds" in d:
            if stage:
                d["classIds"] = [c for c in class_ids if STAGE[c.split("_")[0]] == stage]
            else:
                issues.append(f"Remark category {did}: can't tell its stage — classIds cleared (applies to every class)")
                d["classIds"] = []
        docs["remark_categories"][did] = d

    # Co-scholastic, from the school's own list.
    for term in term_ids:
        order = 0
        primary = [c for c in class_ids if c.split("_")[0] not in ("Nursery", "LKG", "UKG")]
        items = [(n, primary) for n in PRIMARY_CO_SCHOLASTIC]
        items += [(n, [c for c in class_ids if c.split("_")[0] in gs]) for n, gs in PRE_PRIMARY_CO_SCHOLASTIC.items()]
        for name, cids in items:
            if not cids:
                continue
            order += 1
            docs["co_scholastic_activities"][f"{term}_{slug(name)}"] = {
                "name": name, "termId": term, "order": order, "entryType": "grade",
                "maxMarks": 10, "gradingScaleId": CO_SCHOLASTIC_SCALE,
                "conversionType": "none", "conversionFactor": None, "classIds": cids,
            }
    if CO_SCHOLASTIC_SCALE not in docs["grading_scales"]:
        issues.append(f"Grading scale {CO_SCHOLASTIC_SCALE} not in the source — co-scholastic activities point at a missing scale")

    schema = src["config"].get("students_schema")
    if schema:
        schema = strip_meta(schema)
        for c in schema.get("columns", []):
            if c.get("key") == "currentClassId":
                c["options"] = list(class_ids)
        docs["config"]["students_schema"] = schema
    return docs


def read_source(db, source):
    base = db.collection("schools").document(source)
    if not base.get().exists:
        sys.exit(f"Source school {source!r} not found")
    out = {}
    for col in ("terms", "grading_scales", "months", "subjects", "assessments",
                "remark_categories", "classes", "config"):
        out[col] = {d.id: d.to_dict() for d in base.collection(col).stream()}
    return out


def connect(args):
    try:
        from google.cloud import firestore
    except ImportError:
        sys.exit("Missing dependency. Run:  pip install google-cloud-firestore openpyxl")
    if args.key:
        return firestore.Client.from_service_account_json(args.key, project=args.project)
    return firestore.Client(project=args.project)


# ─── main ───────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--project", default="clarified-1501")
    ap.add_argument("--key", help="service-account JSON (default: application-default credentials)")
    ap.add_argument("--source", default="shardakalamb", help="school to clone the structure from")
    ap.add_argument("--target", required=True, help="new school doc id, e.g. shardakaij")
    ap.add_argument("--name", help='school name, e.g. "Sharda English School, Kaij"')
    ap.add_argument("--city", default="")
    ap.add_argument("--material", required=True, help="folder with the school's .xlsx files")
    ap.add_argument("--student-prefix", required=True, help="student doc id prefix, e.g. sskj → sskj0001")
    ap.add_argument("--teacher-prefix", required=True, help="staff doc id prefix, e.g. tskj → tskj0001")
    ap.add_argument("--offline", action="store_true", help="parse the material only; no Firestore")
    ap.add_argument("--out", help="write the full preview (every doc) as JSON here")
    ap.add_argument("--apply", action="store_true", help="write to Firestore (default: dry run)")
    args = ap.parse_args()
    if {args.student_prefix, args.teacher_prefix} & {"ssk", "tsk"}:
        sys.exit("ssk/tsk are Kalamb's id prefixes — pick different ones")

    issues = []
    class_ids, students, staffs, sheets = build_people(args, issues)
    print(f"Material: {len(sheets)} student sheets → {len(class_ids)} classes, {len(students)} students, {len(staffs)} staff")
    per_class = Counter(s["currentClassId"] for s in students.values())
    for sh in sheets:
        print(f"  {sh['classId']:<16} {per_class[sh['classId']]:>3} students  ← {sh['file']} [{sh['sheet']}]"
              + ("  (Excel dates un-swapped dd/mm)" if sh["datesSwapped"] else ""))
    print(f"Ids: students {next(iter(students), '-')}…, staff {next(iter(staffs), '-')}…  "
          f"(login e-mail {{id}}@{args.target}.com, password = id once Publish creates the logins)")

    docs = defaultdict(OrderedDict)
    if not args.offline:
        db = connect(args)
        src = read_source(db, args.source)
        docs = build_structure(src, class_ids, issues)
    docs["students"] = students
    docs["staffs"] = staffs
    school = {"id": args.target, "name": args.name or args.target, "city": args.city,
              "state": "Maharashtra", "board": "CBSE", "stage": "Onboarding", "isActive": True}

    print("\nDocs to create under schools/%s:" % args.target)
    for col, d in docs.items():
        print(f"  {col:<26} {len(d)}")

    print(f"\n{len(issues)} thing(s) to check in the material:")
    for i in issues:
        print("  - " + i)

    if args.out:
        with open(args.out, "w") as f:
            json.dump({"school": school, **{k: v for k, v in docs.items()}}, f, indent=1, default=str, ensure_ascii=False)
        print(f"\nFull preview written to {args.out}")

    if not args.apply:
        print("\nDRY RUN — nothing written. Re-run with --apply to create the school.")
        return
    if args.offline:
        sys.exit("--apply needs Firestore; drop --offline")

    from google.cloud import firestore
    base = db.collection("schools").document(args.target)
    if base.get().exists or any(True for _ in base.collections()):
        sys.exit(f"schools/{args.target} already exists — refusing to write over it")
    now = firestore.SERVER_TIMESTAMP
    stamp = {"created_at": now, "created_by": SCRIPT, "updated_at": now, "updated_by": SCRIPT}
    ops = [(base, dict(school, **stamp))]
    for col, d in docs.items():
        for did, body in d.items():
            ops.append((base.collection(col).document(did), dict(body, **stamp)))
    for i in range(0, len(ops), 400):
        batch = db.batch()
        for ref, body in ops[i:i + 400]:
            batch.create(ref, body)
        batch.commit()
        print(f"  wrote {min(i + 400, len(ops))}/{len(ops)}")
    print(f"Done. Next: School Setup → {args.target} → Publish (create logins), then assign surveys.")


if __name__ == "__main__":
    main()
