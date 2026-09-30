"""topic_combine.py is pure logic (no Firestore, no network) — see its module
docstring. A wrong combined level is a wrong level on a report card, so it is
tested the same way aap_rules.py and subject_match.py are."""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from topic_combine import (  # noqa: E402
    DEFAULT_LEVEL, combine_topics, resolve_level, resolve_topic, trait_observation,
)

B, P, A = "Beginner", "Proficient", "Advanced"


def row(topic, aw=None, sen=None, cre=None):
    return {"topic": topic, "levels": {"awareness": aw, "sensitivity": sen, "creativity": cre}}


@pytest.mark.parametrize("raw, expected", [
    ([], P),
    (["Advanced"], A),
    (["Beginner (LOW)"], B),
    ([B, B], B),
    ([P, A], A),          # one apart -> the higher
    ([B, A], P),          # two apart -> Proficient
    ([B, B, P], P),       # 3+: ceil of the mean, as before
    (["nonsense", A], A),  # unrecognised answers are ignored
])
def test_resolve_level_unchanged(raw, expected):
    assert resolve_level(raw) == expected


def test_resolve_topic_keeps_unrated_traits_as_none():
    levels = resolve_topic({"awareness": [A], "sensitivity": [], "creativity": ["Not Applicable"]})
    assert levels == {"awareness": A, "sensitivity": None, "creativity": None}


def test_single_topic_is_that_topics_rubric():
    out = combine_topics([row("Term 1", A, P, B)])
    assert out["levels"] == {"awareness": A, "sensitivity": P, "creativity": B}
    assert out["trends"]["awareness"] == "single"
    assert out["topics"] == ["Term 1"]


@pytest.mark.parametrize("levels, expected", [
    ([A, A], A),
    ([P, A], A),       # two topics resolve exactly as the old pooled rule did
    ([A, P], A),
    ([B, P], P),
    ([B, A], P),
    ([B, B, A], P),    # mean 1.67 -> Proficient
    ([B, B, P], B),    # mean 1.33 -> Beginner (one Proficient doesn't outvote two Beginners)
    ([P, P, A, A], A),  # 2.5 rounds half UP, not to even
    ([B, B, P, P], P),  # 1.5 rounds half up
])
def test_combined_level_is_mean_rounded_half_up(levels, expected):
    out = combine_topics([row(f"T{i}", aw=lvl) for i, lvl in enumerate(levels)])
    assert out["levels"]["awareness"] == expected


def test_duplicate_responses_within_a_topic_do_not_outweigh_other_topics():
    # Term 1 was surveyed three times (Advanced each time), Terms 2 and 3 once
    # each (Beginner). Pooled flat that is A, A, A, B, B -> Advanced, purely
    # because Term 1 got surveyed more often. Per topic it is A, B, B.
    t1 = resolve_topic({"awareness": [A, A, A]})
    t2 = resolve_topic({"awareness": [B]})
    t3 = resolve_topic({"awareness": [B]})
    out = combine_topics([{"topic": n, "levels": lv}
                          for n, lv in (("Term 1", t1), ("Term 2", t2), ("Term 3", t3))])
    assert resolve_level([A, A, A, B, B]) == A
    assert out["levels"]["awareness"] == P


def test_topic_that_skipped_a_trait_is_left_out_of_that_trait():
    out = combine_topics([row("Term 1", aw=B, sen=B), row("Term 2", aw=B)])
    # Term 2 never rated sensitivity: it must not count as Advanced (or
    # anything) against Term 1's Beginner.
    assert out["levels"]["sensitivity"] == B
    assert out["trends"]["sensitivity"] == "single"


def test_trait_no_topic_rated_falls_back_to_default():
    out = combine_topics([row("Term 1", aw=B), row("Term 2", aw=P)])
    assert out["levels"]["creativity"] == DEFAULT_LEVEL
    assert out["trends"]["creativity"] is None


@pytest.mark.parametrize("levels, trend", [
    ([P, P], "steady"),
    ([B, P, A], "improving"),
    ([B, B, A], "improving"),
    ([A, P], "declining"),
    ([P, A, B], "mixed"),
])
def test_trends(levels, trend):
    out = combine_topics([row(f"T{i}", aw=lvl) for i, lvl in enumerate(levels)])
    assert out["trends"]["awareness"] == trend


def test_topic_levels_are_reported_per_topic():
    out = combine_topics([row("Term 1", B, P, A), row("Term 2", P, P, A), row("Unrated")])
    assert out["topics"] == ["Term 1", "Term 2"]
    assert out["topicLevels"][0] == {"topic": "Term 1", "awareness": B, "sensitivity": P, "creativity": A}


DESCRIPTORS = {"beginner": "Begins to notice.", "proficient": "Notices well.", "advanced": "Notices deeply."}


def test_observation_is_plain_descriptor_when_topics_agree():
    out = combine_topics([row("Term 1", aw=P), row("Term 2", aw=P)])
    assert trait_observation(DESCRIPTORS, "awareness", out) == "Notices well."


def test_observation_carries_growth_when_improving():
    out = combine_topics([row("Term 1", aw=B), row("Term 2", aw=A)])
    text = trait_observation(DESCRIPTORS, "awareness", out)
    assert text.startswith("Notices well.")          # combined level: Proficient
    assert "Improved" in text and "Notices deeply." in text
    assert "Beginner -> Advanced" in text
    assert "Term" not in text          # topic names never reach the prompt


def test_observation_for_declining_and_mixed():
    down = combine_topics([row("Term 1", aw=A), row("Term 2", aw=P)])
    assert "earlier" in trait_observation(DESCRIPTORS, "awareness", down).lower()
    mixed = combine_topics([row("A", aw=P), row("B", aw=A), row("C", aw=B)])
    assert "Varied" in trait_observation(DESCRIPTORS, "awareness", mixed)


def test_observation_does_not_repeat_the_combined_descriptor():
    # Proficient then Advanced combines to Advanced: the "most recently"
    # descriptor would be the same sentence again.
    out = combine_topics([row("Term 1", aw=P), row("Term 2", aw=A)])
    text = trait_observation(DESCRIPTORS, "awareness", out)
    assert text.count("Notices deeply.") == 1
    assert "Improved" in text
