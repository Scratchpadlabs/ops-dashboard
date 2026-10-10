"""is_ops_team: who may list school websites (hosting_sites without "assign")."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from ops_team import is_ops_team  # noqa: E402


def test_ops_team_is_any_ops_login():
    assert is_ops_team("ruchika@ops.clarified.in")
    assert is_ops_team("SID@ops.clarified.in")
    assert is_ops_team("angel@ops.clarified.in")


def test_everyone_else_is_not():
    assert not is_ops_team("teacher@gmail.com")
    assert not is_ops_team("someone@clarified.in")
    assert not is_ops_team("@ops.clarified.in")
    assert not is_ops_team("x@ops.clarified.in.evil.com")
    assert not is_ops_team("a@b@ops.clarified.in")
    assert not is_ops_team("")
