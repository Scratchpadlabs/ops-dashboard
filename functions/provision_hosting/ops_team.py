"""Who counts as the ops team (as opposed to ops admins, see ops_admins.py).

Every ops-dashboard login is an @ops.clarified.in account. Teacher-app users
sign in to the same Firebase project with other emails, so the domain is what
separates "ops team" from "anyone with a login". Ops admins are on the team too.
"""
from ops_admins import OPS_ADMIN_EMAILS

OPS_TEAM_DOMAIN = "@ops.clarified.in"


def is_ops_team(email: str) -> bool:
    email = (email or "").strip().lower()
    if email in OPS_ADMIN_EMAILS:
        return True
    local = email[: -len(OPS_TEAM_DOMAIN)] if email.endswith(OPS_TEAM_DOMAIN) else ""
    return bool(local) and "@" not in local
