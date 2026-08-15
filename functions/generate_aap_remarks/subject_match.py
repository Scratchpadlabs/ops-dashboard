"""Pure subject-matching logic for generate_aap_remarks — no Firestore, no
network, unit-tested in tests/test_subject_match.py.

THE PROBLEM THIS SOLVES
-----------------------
framework.csv's "Subject Name" column does not hold subject names. It holds
GROUP LABELS, each listing every school-specific spelling that maps to one
rubric row:

    Math / Arithmetic
    L1 (Marathi / Telugu / Kannada / Hindi / Sindhi)
    World Around Us (Science / EVS / Social Studies / Science / SST)
    Science (EVS)

A survey response, meanwhile, carries ONE token: "Maths", "EVS", "SST". The
first version of this function looked the token up with a flat dict.get() on
the label, so the only rows reachable in the entire framework were the two
spelled as a single plain word ("Maths"). Every other subject was skipped
silently, which read on the dashboard as a class that generated nothing.

So a label is expanded into its alternatives, and lookup goes through four
rungs, cheapest and most certain first:

  1. a CONFIRMED mapping someone made in the dashboard (aap_subject_map) —
     always wins, because a human said so about this exact token
  2. the label matched exactly
  3. an alias of the label, compared with punctuation and case removed
  4. the same, allowing a trailing plural ("Maths" -> "Math")

Anything still unmatched is REPORTED, never guessed at. The dashboard shows
those tokens and asks someone to relate them, and that confirmation becomes a
rung-1 entry. Guessing is what would put the wrong rubric text on a child's
report card, which is the one outcome worth failing loudly to avoid.
"""

import re

# Separators INSIDE a group label. Deliberately not " and ": "Arts and Crafts"
# is one subject, and splitting it invents "Arts" and "Crafts" as aliases that
# could collide with a real row elsewhere in the stage.
_ALTERNATIVE_SPLIT_RE = re.compile(r"[/,;]")
_PARENTHESISED_RE = re.compile(r"\(([^)]*)\)")


def normalize_subject(text):
    """Comparison key: lowercase, everything but letters and digits removed.

    Collapsing punctuation is what lets "Social Science", "social-science" and
    "SocialScience" (all three appear in this CSV) compare equal.
    """
    return re.sub(r"[^a-z0-9]+", "", str(text or "").lower())


def singular(key):
    """"maths" -> "math". A trailing plural is the single most common way a
    school's spelling misses the rubric's, and it is safe to relax because the
    result still has to match an alias exactly. Short keys are left alone so
    "sst" does not become "ss"."""
    return key[:-1] if len(key) > 3 and key.endswith("s") else key


def subject_aliases(label):
    """Every spelling one group label offers, the full label included.

    "L1 (Marathi / Telugu)" -> ["L1 (Marathi / Telugu)", "L1", "Marathi",
    "Telugu"] — the parenthesised part is unwrapped and split, and so is what
    is left outside it.
    """
    label = str(label or "").strip()
    if not label:
        return []

    aliases = [label]
    inner = _PARENTHESISED_RE.findall(label)
    outer = _PARENTHESISED_RE.sub(" ", label)
    for chunk in [outer, *inner]:
        for piece in _ALTERNATIVE_SPLIT_RE.split(chunk):
            piece = piece.strip()
            if piece:
                aliases.append(piece)

    # Order-preserving dedupe: the full label stays first, which is what makes
    # index building deterministic.
    seen = set()
    return [a for a in aliases if not (a in seen or seen.add(a))]


def build_subject_index(framework_rows):
    """framework_rows: the aap_framework docs for ONE stage, each a dict with
    at least a "subject" field, ALREADY in a stable order (sort by doc id).

    Returns (by_label, alias_index, conflicts):
      by_label     {exact "subject" field: row}
      alias_index  {normalized alias: exact "subject" field}
      conflicts    aliases two rows both claim — reported, not resolved
                   silently; the first row in the given order keeps the alias.
    """
    by_label = {}
    alias_index = {}
    conflicts = []

    for row in framework_rows:
        label = str((row or {}).get("subject") or "").strip()
        if not label:
            continue
        by_label[label] = row

        for alias in subject_aliases(label):
            for key in (normalize_subject(alias), singular(normalize_subject(alias))):
                if not key:
                    continue
                owner = alias_index.get(key)
                if owner is None:
                    alias_index[key] = label
                elif owner != label:
                    conflicts.append({"alias": alias, "kept": owner, "ignored": label})

    return by_label, alias_index, conflicts


def resolve_subject(token, by_label, alias_index, overrides=None):
    """(row, how) for one survey subject token, or (None, None).

    `how` is which rung answered — "map", "exact", "alias" or "plural" — so
    the dashboard can say why a subject resolved the way it did rather than
    presenting a guess and a match as the same thing.
    """
    overrides = overrides or {}
    key = normalize_subject(token)
    if not key:
        return None, None

    mapped = overrides.get(key)
    if mapped and mapped in by_label:
        return by_label[mapped], "map"

    label = str(token or "").strip()
    if label in by_label:
        return by_label[label], "exact"

    if key in alias_index:
        return by_label[alias_index[key]], "alias"

    relaxed = singular(key)
    if relaxed != key and relaxed in alias_index:
        return by_label[alias_index[relaxed]], "plural"

    return None, None


def opening_signature(comment, first_name):
    """The first few words AFTER the student's name, as a comparison key.

    Every comment opens with the name by instruction, so the repetition a
    reader actually notices is what follows it — a class where nine comments
    in a row read "<Name> shows ...". This is what the generator checks a new
    comment against before accepting it.
    """
    words = re.sub(r"[^a-z\s]", " ", str(comment or "").lower()).split()
    first = str(first_name or "").strip().lower()
    if words and first and words[0] == first:
        words = words[1:]
    return " ".join(words[:3])
