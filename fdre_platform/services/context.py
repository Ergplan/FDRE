"""Who is acting, in which organisation, under which request."""

from __future__ import annotations

from dataclasses import dataclass

from fdre_platform.permissions import has_permission


class PermissionDenied(Exception):
    def __init__(self, permission: str) -> None:
        super().__init__(f"permission {permission} required")
        self.permission = permission


@dataclass(frozen=True)
class Actor:
    user_id: str | None
    label: str                  # email, or a system name
    organization_id: str
    role: str                   # organisation role
    request_id: str | None = None

    def can(self, permission: str) -> bool:
        return has_permission(self.role, permission)

    def require(self, permission: str) -> None:
        if not self.can(permission):
            raise PermissionDenied(permission)


def system_actor(organization_id: str, label: str = "system", request_id: str | None = None) -> Actor:
    return Actor(user_id=None, label=label, organization_id=organization_id, role="administrator", request_id=request_id)
