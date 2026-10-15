"""Roles and the explicit permission matrix. Authorisation is decided here and in
`api/deps.py`, never in React buttons."""

from __future__ import annotations

ROLES = ("administrator", "bid_manager", "engineer", "finance_reviewer", "approver", "viewer")

PERMISSIONS = (
    "org.manage",        # rename the organisation, change settings
    "members.manage",    # invite users, change roles, add tender members
    "tender.create",
    "tender.read",
    "tender.edit",
    "requirement.review",  # accept, correct or reject extracted requirements
    "scenario.create",
    "scenario.edit",     # technical inputs
    "scenario.lock",
    "finance.edit",      # financing and tariff assumptions
    "finance.review",    # mark finance reviewed
    "run.launch",
    "run.cancel",
    "bid.approve",       # approve a bid baseline / award record
    "dpr.edit",
    "comment.write",
    "audit.read",
)

_ALL = frozenset(PERMISSIONS)
ROLE_PERMISSIONS: dict[str, frozenset[str]] = {
    "administrator": _ALL,
    "bid_manager": frozenset(
        {
            "members.manage", "tender.create", "tender.read", "tender.edit", "requirement.review",
            "scenario.create", "scenario.edit", "scenario.lock", "finance.edit",
            "run.launch", "run.cancel", "dpr.edit", "comment.write", "audit.read",
        }
    ),
    "engineer": frozenset(
        {"tender.read", "requirement.review", "scenario.create", "scenario.edit", "run.launch", "run.cancel", "dpr.edit", "comment.write"}
    ),
    "finance_reviewer": frozenset(
        {"tender.read", "requirement.review", "scenario.create", "finance.edit", "finance.review", "run.launch", "comment.write", "audit.read"}
    ),
    "approver": frozenset({"tender.read", "requirement.review", "bid.approve", "finance.review", "comment.write", "audit.read"}),
    "viewer": frozenset({"tender.read"}),
}

# Roles that see every tender of the organisation without a tender membership row.
ORG_WIDE_TENDER_ACCESS = frozenset({"administrator"})


def permissions_for(role: str) -> frozenset[str]:
    try:
        return ROLE_PERMISSIONS[role]
    except KeyError as exc:
        raise ValueError(f"unknown role {role!r}") from exc


def has_permission(role: str, permission: str) -> bool:
    if permission not in _ALL:
        raise ValueError(f"unknown permission {permission!r}")
    return permission in permissions_for(role)
