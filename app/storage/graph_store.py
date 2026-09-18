"""File-backed cache for generated graph JSON.

Layout::

    data/cache/graphs/<mode>/<playlist_id>/<snapshot_id>.json

The key is (mode, playlist_id, snapshot_id). Spotify changes a playlist's
`snapshot_id` on every mutation, so a stale cache entry is impossible: a
changed playlist simply misses and rebuilds. Old snapshots are pruned on
write, keeping the most recent `CACHE_KEEP_SNAPSHOTS`.

Writes go to a temp file then `os.replace`, which is atomic on POSIX. Without
that, two concurrent requests for the same uncached playlist could interleave
and leave a truncated file that every later read would choke on.

Chosen deliberately over Redis/Postgres for the MVP: the artefacts are large
opaque JSON blobs read whole and never queried by field, the previous
generation already worked this way, and it needs zero infrastructure. The
`GraphStore` surface is small enough to swap for object storage later.
"""

from __future__ import annotations

import json
import logging
import os
import re
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# Spotify ids and snapshot ids are base62/base64-ish. Anything outside this set
# is rejected rather than sanitised, so a crafted id cannot escape the cache
# directory via path traversal.
_SAFE_SEGMENT = re.compile(r"^[A-Za-z0-9_=.-]{1,128}$")


class UnsafeCacheKey(ValueError):
    """Raised when an id would produce a path outside the cache root."""


@dataclass(frozen=True, slots=True)
class CacheEntry:
    path: Path
    mode: str
    playlist_id: str
    snapshot_id: str

    @property
    def size_bytes(self) -> int:
        return self.path.stat().st_size


class GraphStore:
    def __init__(self, root: Path, keep_snapshots: int = 3, enabled: bool = True):
        self.root = Path(root)
        self.keep_snapshots = max(1, keep_snapshots)
        self.enabled = enabled

    # ------------------------------------------------------------------
    # Paths
    # ------------------------------------------------------------------

    @staticmethod
    def _check_segment(value: str, label: str) -> str:
        if not value or not _SAFE_SEGMENT.match(value):
            raise UnsafeCacheKey(f"Invalid {label} for cache path: {value!r}")
        return value

    def playlist_dir(self, mode: str, playlist_id: str) -> Path:
        return (
            self.root
            / self._check_segment(mode, "mode")
            / self._check_segment(playlist_id, "playlist id")
        )

    def path_for(self, mode: str, playlist_id: str, snapshot_id: str) -> Path:
        snapshot = self._check_segment(snapshot_id or "nosnapshot", "snapshot id")
        return self.playlist_dir(mode, playlist_id) / f"{snapshot}.json"

    # ------------------------------------------------------------------
    # Read / write
    # ------------------------------------------------------------------

    def get(self, mode: str, playlist_id: str, snapshot_id: str) -> dict[str, Any] | None:
        if not self.enabled:
            return None

        try:
            path = self.path_for(mode, playlist_id, snapshot_id)
        except UnsafeCacheKey as exc:
            logger.warning("Refusing cache read: %s", exc)
            return None

        if not path.exists():
            return None

        try:
            with path.open("r", encoding="utf-8") as handle:
                payload = json.load(handle)
        except (json.JSONDecodeError, OSError) as exc:
            # A corrupt entry should never be fatal: drop it and rebuild.
            logger.warning("Discarding unreadable cache entry %s: %s", path, exc)
            path.unlink(missing_ok=True)
            return None

        logger.info("Cache hit: %s/%s/%s", mode, playlist_id, snapshot_id)
        return payload

    def put(
        self, mode: str, playlist_id: str, snapshot_id: str, payload: dict[str, Any]
    ) -> Path | None:
        if not self.enabled:
            return None

        try:
            path = self.path_for(mode, playlist_id, snapshot_id)
        except UnsafeCacheKey as exc:
            logger.warning("Refusing cache write: %s", exc)
            return None

        path.parent.mkdir(parents=True, exist_ok=True)

        handle = tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=path.parent,
            prefix=".tmp-",
            suffix=".json",
            delete=False,
        )
        try:
            with handle:
                json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
            os.replace(handle.name, path)  # atomic
        except Exception:
            Path(handle.name).unlink(missing_ok=True)
            raise

        logger.info("Cached %s/%s/%s (%s bytes)", mode, playlist_id, snapshot_id, path.stat().st_size)
        self._prune(mode, playlist_id, keep=path)
        return path

    # ------------------------------------------------------------------
    # Maintenance
    # ------------------------------------------------------------------

    def _prune(self, mode: str, playlist_id: str, keep: Path) -> None:
        """Keep the newest N snapshots for a playlist, delete the rest."""
        directory = self.playlist_dir(mode, playlist_id)
        entries = sorted(
            (p for p in directory.glob("*.json")),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
        for stale in entries[self.keep_snapshots :]:
            if stale != keep:
                stale.unlink(missing_ok=True)
                logger.debug("Pruned stale cache entry %s", stale)

    def invalidate(self, mode: str, playlist_id: str) -> int:
        """Delete every cached snapshot for a playlist. Returns files removed."""
        try:
            directory = self.playlist_dir(mode, playlist_id)
        except UnsafeCacheKey:
            return 0

        removed = 0
        for path in directory.glob("*.json"):
            path.unlink(missing_ok=True)
            removed += 1
        return removed

    def entries(self) -> list[CacheEntry]:
        """Everything currently cached. Used by the debug endpoint."""
        found: list[CacheEntry] = []
        if not self.root.exists():
            return found

        for path in self.root.glob("*/*/*.json"):
            found.append(
                CacheEntry(
                    path=path,
                    mode=path.parent.parent.name,
                    playlist_id=path.parent.name,
                    snapshot_id=path.stem,
                )
            )
        return found


def get_store() -> GraphStore:
    """Build a store from the active Flask config."""
    from flask import current_app

    cfg = current_app.config
    return GraphStore(
        root=cfg["CACHE_DIR"],
        keep_snapshots=cfg["CACHE_KEEP_SNAPSHOTS"],
        enabled=cfg["CACHE_ENABLED"],
    )
