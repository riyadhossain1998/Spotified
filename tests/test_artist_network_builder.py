"""Tests for the pair-generation algorithm.

These use a dict-backed resolver rather than a mocked HTTP client, which is
the payoff of keeping builders free of Flask and spotipy imports.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Sequence

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.graph.builders.artist_network import ArtistNetworkBuilder
from app.graph.models import Artist, ArtistRef, PlaylistRef, Track


class FakeResolver:
    def __init__(self, artists: dict[str, Artist] | None = None):
        self._artists = artists or {}
        self.calls: list[list[str]] = []

    def artists(self, artist_ids: Sequence[str]) -> dict[str, Artist]:
        self.calls.append(list(artist_ids))
        return {aid: self._artists[aid] for aid in artist_ids if aid in self._artists}


def make_track(track_id: str, *artist_ids: str, popularity: int = 50) -> Track:
    return Track(
        id=track_id,
        name=f"Track {track_id}",
        artists=[ArtistRef(id=a, name=a.upper()) for a in artist_ids],
        popularity=popularity,
        duration_ms=180_000,
        release_date="2020-01-01",
    )


@pytest.fixture
def playlist() -> PlaylistRef:
    return PlaylistRef(id="pl1", name="Test Playlist", snapshot_id="snap1", track_count=0)


@pytest.fixture
def builder() -> ArtistNetworkBuilder:
    return ArtistNetworkBuilder()


def links_by_pair(graph) -> dict[tuple[str, str], int]:
    return {(l.source, l.target): l.collab_count for l in graph.links}


def test_three_artists_produce_three_pairs(builder, playlist):
    graph = builder.build(playlist, [make_track("t1", "a", "b", "c")], FakeResolver())

    assert links_by_pair(graph) == {("a", "b"): 1, ("a", "c"): 1, ("b", "c"): 1}


def test_pairs_are_canonical_and_not_duplicated(builder, playlist):
    """Credit order must not create both (a,b) and (b,a)."""
    tracks = [make_track("t1", "b", "a"), make_track("t2", "a", "b")]
    graph = builder.build(playlist, tracks, FakeResolver())

    assert len(graph.links) == 1
    link = graph.links[0]
    assert (link.source, link.target) == ("a", "b")
    assert link.collab_count == 2
    assert sorted(link.track_ids) == ["t1", "t2"]


def test_solo_track_creates_no_link_but_keeps_the_node(builder, playlist):
    graph = builder.build(playlist, [make_track("t1", "a")], FakeResolver())

    assert graph.links == []
    assert [n.id for n in graph.nodes] == ["a"]
    assert graph.nodes[0].degree == 0


def test_solo_artists_can_be_excluded(playlist):
    builder = ArtistNetworkBuilder(include_solo_artists=False)
    tracks = [make_track("t1", "a", "b"), make_track("t2", "c")]

    graph = builder.build(playlist, tracks, FakeResolver())

    assert sorted(n.id for n in graph.nodes) == ["a", "b"]


def test_duplicate_credit_on_one_track_creates_no_self_loop(builder, playlist):
    graph = builder.build(playlist, [make_track("t1", "a", "a", "b")], FakeResolver())

    assert links_by_pair(graph) == {("a", "b"): 1}
    assert all(l.source != l.target for l in graph.links)


def test_node_tracklist_and_degree(builder, playlist):
    tracks = [
        make_track("t1", "a", "b"),
        make_track("t2", "a", "c"),
        make_track("t3", "a"),
    ]
    graph = builder.build(playlist, tracks, FakeResolver())
    nodes = {n.id: n for n in graph.nodes}

    assert sorted(nodes["a"].track_ids) == ["t1", "t2", "t3"]
    assert nodes["a"].track_count == 3
    assert nodes["a"].degree == 2       # distinct collaborators
    assert nodes["a"].collab_count == 2  # collaborative tracks
    assert nodes["b"].degree == 1


def test_primary_artist_is_the_one_on_most_tracks(builder, playlist):
    tracks = [
        make_track("t1", "a", "b"),
        make_track("t2", "a", "c"),
        make_track("t3", "a", "d"),
        make_track("t4", "b", "c"),
    ]
    graph = builder.build(playlist, tracks, FakeResolver())

    primary = [n.id for n in graph.nodes if n.is_primary]
    assert primary == ["a"]


def test_metadata_is_requested_once_and_applied(builder, playlist):
    resolver = FakeResolver(
        {
            "a": Artist(
                id="a",
                name="Artist A",
                popularity=80,
                followers=1_000,
                genres=["hip hop"],
                image_url="http://img/a",
            )
        }
    )
    graph = builder.build(playlist, [make_track("t1", "a", "b")], resolver)
    nodes = {n.id: n for n in graph.nodes}

    assert len(resolver.calls) == 1  # batched, not per-artist
    assert nodes["a"].label == "Artist A"
    assert nodes["a"].followers == 1_000
    assert nodes["a"].genres == ["hip hop"]
    # Missing metadata falls back to the credit name instead of dropping the node.
    assert nodes["b"].label == "B"


def test_tracks_are_stored_once_and_referenced_by_id(builder, playlist):
    graph = builder.build(playlist, [make_track("t1", "a", "b", "c")], FakeResolver())

    assert set(graph.tracks) == {"t1"}
    assert len(graph.links) == 3
    assert all(l.track_ids == ["t1"] for l in graph.links)


def test_stats_are_computed(builder, playlist):
    tracks = [
        make_track("t1", "a", "b", popularity=90),
        make_track("t2", "a", popularity=10),
    ]
    graph = builder.build(playlist, tracks, FakeResolver())

    assert graph.stats["track_count"] == 2
    assert graph.stats["artist_count"] == 2
    assert graph.stats["connection_count"] == 1
    assert graph.stats["collaboration_track_count"] == 1


def test_payload_is_json_serialisable(builder, playlist):
    import json

    graph = builder.build(playlist, [make_track("t1", "a", "b")], FakeResolver())
    payload = json.loads(json.dumps(graph.to_dict()))

    assert payload["mode"] == "artist"
    assert payload["playlist"]["id"] == "pl1"
    assert {"nodes", "links", "tracks", "stats"} <= payload.keys()
