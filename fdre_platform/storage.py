"""Object storage behind one interface. Local content-addressed files in phase 1; an S3/GCS
backend is a configuration switch with the same methods."""

from __future__ import annotations

import hashlib
import pathlib
from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class StoredObject:
    key: str
    sha256: str
    size_bytes: int


class Storage(Protocol):
    def put(self, organization_id: str, namespace: str, filename: str, data: bytes) -> StoredObject: ...
    def get(self, key: str) -> bytes: ...
    def exists(self, key: str) -> bool: ...


class LocalStorage:
    """Files under <root>/<org>/<namespace>/<sha256-prefix>/<sha256>-<filename>. The key
    carries the organisation so a cross-tenant read is refused by prefix, not by trust."""

    def __init__(self, root: pathlib.Path) -> None:
        self.root = pathlib.Path(root)

    def put(self, organization_id: str, namespace: str, filename: str, data: bytes) -> StoredObject:
        digest = hashlib.sha256(data).hexdigest()
        safe = "".join(c if c.isalnum() or c in "._-" else "_" for c in filename)[:120]
        key = f"{organization_id}/{namespace}/{digest[:2]}/{digest}-{safe}"
        path = self.root / key
        path.parent.mkdir(parents=True, exist_ok=True)
        if not path.exists():
            tmp = path.with_suffix(path.suffix + ".part")
            tmp.write_bytes(data)
            tmp.replace(path)
        return StoredObject(key=key, sha256=digest, size_bytes=len(data))

    def get(self, key: str) -> bytes:
        return (self.root / key).read_bytes()

    def exists(self, key: str) -> bool:
        return (self.root / key).exists()

    def get_for(self, organization_id: str, key: str) -> bytes:
        if not key.startswith(organization_id + "/"):
            raise PermissionError("object belongs to another organisation")
        return self.get(key)
