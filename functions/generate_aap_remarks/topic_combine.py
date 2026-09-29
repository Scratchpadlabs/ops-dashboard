"""Pure rating logic for generate_aap_remarks — no Firestore, no network,
unit-tested in tests/test_topic_combine.py (same shape as aap_rules.py and
subject_match.py: logic that can put the wrong level on a report card belongs
somewhere it can be tested without a Firebase environment).

A remark is written per SUBJECT, but teachers rate per TOPIC: one AAP survey
response per class/subject/topic. So a subject remark built from several
topics needs its rubric combined, in two steps:

  1. Per topic, per trait: every rating that topic got (usually one; two if
     the same topic was surveyed twice, e.g. by two teachers) resolves to one
     level with resolve_level. Doing this BEFORE combining is what stops a
     topic that happened to be surveyed twice from counting double against
     the others.
  2. Across topics, per trait: the per-topic levels combine by their mean,
     rounded half up. For two topics that is exactly the old pooled rule
     (same -> that level, one apart -> the higher, Beginner vs Advanced ->
     Proficient), so a two-topic subject resolves as it always has. A topic
     that left a trait unrated is left out of that trait rather than counted
     as anything; only a trait NO selected topic rated falls back to the
     school's convention of the most favourable level.

Alongside the level, each trait gets a trend across the topics in teaching
order ("steady", "improving", "declining", "mixed", or "single" for one
topic), which the prompt uses to describe progress honestly instead of
reading a Beginner-then-Advanced student as a flat Proficient.
"""

import math

TRAITS = ("awareness", "sensitivity", "creativity")
LEVEL_ORDER = {"Beginner": 1, "Proficient": 2, "Advanced": 3}
LEVEL_NAME = {1: "Beginner", 2: "Proficient", 3: "Advanced"}

# A trait no topic rated. The school's convention (see fetch_survey_ratings):
# an unrated trait defaults to the most favourable level rather than blocking
# or silently dropping the whole subject.
DEFAULT_LEVEL = "Advanced"


def _score(level_str):
    for key, score in LEVEL_ORDER.items():
        if str(level_str or "").startswith(key):
            return score
    return None


def resolve_level(raw_levels):
    """Several raw survey answers for ONE trait -> one level name.

    Same aggregation as extract_firestore.py's resolve_level, adapted to
    plain 'Beginner'/'Proficient'/'Advanced' prefixes instead of the
    '(LOW)'/'(MEDIUM)'/'(HIGH)' suffixed survey values."""
    normalised = [s for s in (_score(lvl) for lvl in raw_levels) if s is not None]
    if not normalised:
        return "Proficient"
    if len(normalised) == 1:
        score = normalised[0]
    elif len(normalised) == 2:
        a, b = normalised
        diff = abs(a - b)
        score = a if diff == 0 else max(a, b) if diff == 1 else 2
    else:
        score = max(1, min(3, math.ceil(sum(normalised) / len(normalised))))
    return LEVEL_NAME[score]


def resolve_topic(raw_traits):
    """{trait: [raw answers]} for one topic -> {trait: level or None}.
    None means this topic never rated that trait — kept distinct from a
    default so the combine step can leave it out rather than count it."""
    out = {}
    for trait in TRAITS:
        answers = [a for a in (raw_traits.get(trait) or []) if _score(a) is not None]
        out[trait] = resolve_level(answers) if answers else None
    return out


def _trend(scores):
    if len(scores) == 1:
        return "single"
    if len(set(scores)) == 1:
        return "steady"
    rising = all(b >= a for a, b in zip(scores, scores[1:]))
    falling = all(b <= a for a, b in zip(scores, scores[1:]))
    if rising:
        return "improving"
    if falling:
        return "declining"
    return "mixed"


def combine_topics(topic_rows):
    """Per-topic levels -> one subject rubric.

    topic_rows: [{"topic": name, "levels": {trait: level or None}}], in
    teaching order (the order the class setup lists the topics).

    Returns {
      "levels":  {trait: level},              the combined level per trait
      "trends":  {trait: trend or None},      None when no topic rated it
      "range":   {trait: [low, high] or None} lowest/highest topic level
      "topics":  [name, ...],                 topics that rated anything
      "topicLevels": [{"topic", trait: level or None, ...}],
    }
    """
    levels, trends, ranges = {}, {}, {}
    for trait in TRAITS:
        scores = [LEVEL_ORDER[row["levels"][trait]] for row in topic_rows
                  if row["levels"].get(trait) in LEVEL_ORDER]
        if not scores:
            levels[trait] = DEFAULT_LEVEL
            trends[trait] = None
            ranges[trait] = None
            continue
        # Round half up, not Python's banker's round(): 1.5 must be
        # Proficient and 2.5 Advanced, the same way the two-answer rule
        # always resolved a one-apart pair to the higher level.
        levels[trait] = LEVEL_NAME[int(math.floor(sum(scores) / len(scores) + 0.5))]
        trends[trait] = _trend(scores)
        ranges[trait] = [LEVEL_NAME[min(scores)], LEVEL_NAME[max(scores)]]
    rated = [row for row in topic_rows
             if any(row["levels"].get(t) for t in TRAITS)]
    return {
        "levels": levels,
        "trends": trends,
        "range": ranges,
        "topics": [row["topic"] for row in rated],
        "topicLevels": [{"topic": row["topic"], **{t: row["levels"].get(t) for t in TRAITS}}
                        for row in rated],
    }


def trait_observation(descriptors, trait, combined):
    """The observation text the prompt gets for one trait: the rubric
    descriptor for the combined level, plus — when the topics disagreed —
    how the student moved across them, and the descriptor at the far end of
    that movement so the comment can say where they are heading or what
    they showed earlier. `descriptors` is the rubric row's {level_lower:
    text} for this trait."""
    level = combined["levels"][trait]
    text = descriptors.get(level.lower(), "")
    trend = combined["trends"].get(trait)
    low, high = combined["range"].get(trait) or (level, level)
    if trend in (None, "single", "steady") or low == high:
        return text

    per_topic = ", ".join(
        f"{row['topic']}: {row[trait]}" for row in combined["topicLevels"] if row.get(trait))
    # The best topic's descriptor only when it says something the combined
    # level's doesn't — repeating the same sentence adds nothing.
    best = descriptors.get(high.lower(), "") if high != level else ""
    if trend == "improving":
        note = f"Improved across topics ({per_topic})." + (f" Most recently: {best}" if best else "")
    elif trend == "declining":
        note = f"Was stronger in earlier topics ({per_topic})." + (f" Earlier they showed: {best}" if best else "")
    else:
        note = f"Varied from topic to topic ({per_topic})." + (f" At best: {best}" if best else "")
    return f"{text} {note}".strip()
