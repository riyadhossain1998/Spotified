"""Tests for the snapshot-keyed cache."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.storage.graph_store import GraphStore, UnsafeCacheKey


@pytest.fixture
def store(tmp_path: Path) -> GraphStore:
    return GraphStore(root=tmp_path, keep_snapshots=2)


PAYLOAD = {"nodes": [{"id": "a"}], "links": [], "tracks": {}}


def test_miss_then_hit(store):
    assert store.get("artist", "pl1", "snap1") is None

    store.put("artist", "pl1", "snap1", PAYLOAD)

    assert store.get("artist", "pl1", "snap1") == PAYLOAD


def test_new_snapshot_misses(store):
    """A changed playlist gets a new snapshot_id, so it must not hit."""
    store.put("artist", "pl1", "snap1", PAYLOAD)

    assert store.get("artist", "pl1", "snap2") is None


def test_modes_are_isolated(store):
    """Two modes over one playlist must not read each other's cache.

    The store takes the mode as an opaque path segment, so an unregistered
    name is the honest way to test the isolation rather than the registry.
    """
    store.put("artist", "pl1", "snap1", PAYLOAD)

    assert store.get("other", "pl1", "snap1") is None


def test_old_snapshots_are_pruned(store):
    for i in range(5):
        store.put("artist", "pl1", f"snap{i}", PAYLOAD)

    remaining = list((store.root / "artist" / "pl1").glob("*.json"))
    assert len(remaining) == 2  # keep_snapshots


def test_corrupt_entry_is_discarded_not_raised(store):
    store.put("artist", "pl1", "snap1", PAYLOAD)
    path = store.path_for("artist", "pl1", "snap1")
    path.write_text("{ truncated", encoding="utf-8")

    assert store.get("artist", "pl1", "snap1") is None
    assert not path.exists()  # removed so the next request rebuilds


def test_path_traversal_is_rejected(store):
    with pytest.raises(UnsafeCacheKey):
        store.path_for("artist", "../../etc", "snap1")

    with pytest.raises(UnsafeCacheKey):
        store.path_for("../artist", "pl1", "snap1")


def test_traversal_attempt_returns_none_on_read(store):
    assert store.get("artist", "../../../etc/passwd", "snap") is None


def test_invalidate_removes_every_snapshot(store):
    store.put("artist", "pl1", "snap1", PAYLOAD)
    store.put("artist", "pl1", "snap2", PAYLOAD)

    assert store.invalidate("artist", "pl1") == 2
    assert store.get("artist", "pl1", "snap1") is None


def test_disabled_store_never_reads_or_writes(tmp_path):
    store = GraphStore(root=tmp_path, enabled=False)

    assert store.put("artist", "pl1", "snap1", PAYLOAD) is None
    assert store.get("artist", "pl1", "snap1") is None


def test_entries_lists_cached_graphs(store):
    store.put("artist", "pl1", "snap1", PAYLOAD)
    store.put("artist", "pl2", "snap1", PAYLOAD)

    entries = store.entries()
    assert len(entries) == 2
    assert {e.playlist_id for e in entries} == {"pl1", "pl2"}
