"""Tests for genre normalisation and the genre network.

Same dict-backed resolver approach as the artist builder tests. The
normalisation cases are written as regressions rather than examples: each one
is a pair of rules that overlap as substrings, which is the only way this
function goes wrong.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Sequence

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.graph.builders.genre_network import (
    GENRE_ALIASES,
    UNCLASSIFIED,
    GenreNetworkBuilder,
    normalise_genre,
)
from app.graph.models import Artist, ArtistRef, PlaylistRef, Track


class FakeResolver:
    def __init__(self, artists: dict[str, Artist] | None = None):
        self._artists = artists or {}
        self.calls: list[list[str]] = []

    def artists(self, artist_ids: Sequence[str]) -> dict[str, Artist]:
        self.calls.append(list(artist_ids))
        return {aid: self._artists[aid] for aid in artist_ids if aid in self._artists}


def make_track(track_id: str, *artist_ids: str) -> Track:
    return Track(
        id=track_id,
        name=f"Track {track_id}",
        artists=[ArtistRef(id=a, name=a.upper()) for a in artist_ids],
        popularity=50,
        duration_ms=180_000,
        release_date="2020-01-01",
    )


def artist(artist_id: str, *genres: str, name: str | None = None) -> Artist:
    return Artist(
        id=artist_id,
        name=name or artist_id.upper(),
        genres=list(genres),
        image_url=f"http://img/{artist_id}",
    )


@pytest.fixture
def playlist() -> PlaylistRef:
    return PlaylistRef(id="pl1", name="Test Playlist", snapshot_id="snap1", track_count=0)


@pytest.fixture
def builder() -> GenreNetworkBuilder:
    # Weight 1 so small fixtures produce edges; the default of 2 is tested
    # separately.
    return GenreNetworkBuilder(min_edge_weight=1)


def nodes_by_id(graph) -> dict:
    return {n.id: n for n in graph.nodes}


def links_by_pair(graph) -> dict[tuple[str, str], int]:
    return {(l.source, l.target): l.collab_count for l in graph.links}


# ----------------------------------------------------------------- normalise


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("toronto rap", "hip hop"),
        ("canadian hip hop", "hip hop"),
        ("pop rap", "hip hop"),
        ("canadian contemporary r&b", "r&b"),
        ("neo soul", "r&b"),
        ("progressive electro house", "electronic"),
        ("indietronica", "electronic"),
        ("melbourne bounce", "electronic"),
        ("escape room", "electronic"),
        ("POP", "pop"),  # case is not significant
    ],
)
def test_labels_fold_into_buckets(raw, expected):
    assert normalise_genre(raw) == expected


# Every rule that contains a shorter rule pointing somewhere else. Under
# first-match these depended on dict ordering and were silently wrong --
# "reggaeton" classified as reggae because "reggae" was declared first.
SHADOWING_RULES = {
    ("dance pop", "dance"),
    ("dancehall", "dance"),
    ("reggaeton", "reggae"),
    ("k-pop", "pop"),
    ("korean pop", "pop"),
    ("j-pop", "pop"),
    ("nigerian pop", "pop"),
}


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("reggaeton", "latin"),
        ("dancehall", "reggae"),
        ("dance pop", "pop"),
        ("k-pop", "k-pop"),
        ("j-pop", "j-pop"),
    ],
)
def test_longest_rule_wins_over_a_shorter_substring(raw, expected):
    assert normalise_genre(raw) == expected


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("k-pop girl group", "k-pop"),
        ("j-pop boy band", "j-pop"),
        ("korean pop", "k-pop"),
        ("nigerian pop", "afrobeats"),
    ],
)
def test_a_descriptor_never_outranks_a_genre(raw, expected):
    """Real Spotify labels stack a genre and a descriptor in one string.

    These are the case the shadowing check above cannot see: "girl group" and
    "k-pop" do not contain one another, they simply both match "k-pop girl
    group" -- and the descriptor is longer, so under a single longest-match
    pass it won and every Korean girl group landed in pop.
    """
    assert normalise_genre(raw) == expected


def test_a_descriptor_still_classifies_when_nothing_else_does():
    """Demoted, not deleted: with no genre in the label, pop is the best read."""
    assert normalise_genre("british boy band") == "pop"


def test_the_documented_shadowing_rules_are_the_only_ones():
    """Adding a rule that shadows another must be a deliberate act.

    Substring rules overlap invisibly: a new "dark pop" entry would silently
    capture everything a "pop" rule used to. Recomputing the overlaps here
    means such a rule fails this test instead of quietly reclassifying
    artists, and the fix is to confirm the intent by listing it above.
    """
    found = {
        (fragment, other)
        for fragment, bucket in GENRE_ALIASES.items()
        for other, other_bucket in GENRE_ALIASES.items()
        if other != fragment and other in fragment and other_bucket != bucket
    }

    assert found == SHADOWING_RULES


def test_unrecognised_label_survives_lowercased():
    """Unknown genres appear as themselves rather than being swallowed."""
    assert normalise_genre("Chillwave Revival") == "chillwave revival"


# ------------------------------------------------------------------- builder


def test_artists_group_into_genre_nodes(builder, playlist):
    resolver = FakeResolver(
        {"a": artist("a", "toronto rap"), "b": artist("b", "canadian hip hop")}
    )
    graph = builder.build(playlist, [make_track("t1", "a"), make_track("t2", "b")], resolver)

    assert [n.id for n in graph.nodes] == ["hip hop"]
    assert graph.nodes[0].track_count == 2


def test_an_artist_with_two_genres_counts_in_both(builder, playlist):
    """Not a double count to be fixed: the track really is both."""
    resolver = FakeResolver({"a": artist("a", "r&b", "pop")})
    graph = builder.build(playlist, [make_track("t1", "a")], resolver)
    nodes = nodes_by_id(graph)

    assert set(nodes) == {"r&b", "pop"}
    assert nodes["r&b"].track_ids == ["t1"]
    assert nodes["pop"].track_ids == ["t1"]


def test_a_track_spanning_two_genres_creates_one_link(builder, playlist):
    resolver = FakeResolver({"a": artist("a", "hip hop"), "b": artist("b", "house")})
    graph = builder.build(playlist, [make_track("t1", "a", "b")], resolver)

    assert links_by_pair(graph) == {("electronic", "hip hop"): 1}


def test_one_track_bridges_once_however_many_artists_carry_the_genre(builder, playlist):
    """The unit is the track, not the artist pair.

    Three rappers and one producer on a song is a single hip hop--electronic
    bridge, not three.
    """
    resolver = FakeResolver(
        {
            "a": artist("a", "rap"),
            "b": artist("b", "trap"),
            "c": artist("c", "drill"),
            "d": artist("d", "techno"),
        }
    )
    graph = builder.build(playlist, [make_track("t1", "a", "b", "c", "d")], resolver)

    assert links_by_pair(graph) == {("electronic", "hip hop"): 1}


def test_a_solo_artist_bridges_their_own_genres(builder, playlist):
    resolver = FakeResolver({"a": artist("a", "r&b", "pop")})
    graph = builder.build(playlist, [make_track("t1", "a")], resolver)

    assert links_by_pair(graph) == {("pop", "r&b"): 1}


def test_min_edge_weight_prunes_one_off_bridges(playlist):
    resolver = FakeResolver(
        {"a": artist("a", "hip hop"), "b": artist("b", "house"), "c": artist("c", "jazz")}
    )
    tracks = [
        make_track("t1", "a", "b"),
        make_track("t2", "a", "b"),  # hip hop--electronic twice
        make_track("t3", "a", "c"),  # hip hop--jazz once
    ]
    graph = GenreNetworkBuilder(min_edge_weight=2).build(playlist, tracks, resolver)

    assert links_by_pair(graph) == {("electronic", "hip hop"): 2}
    # The pruned genre keeps its node; only the edge goes.
    assert "jazz" in nodes_by_id(graph)
    assert nodes_by_id(graph)["jazz"].degree == 0


def test_artists_without_genres_become_unclassified(builder, playlist):
    """Spotify has no opinion on roughly one artist in seven."""
    resolver = FakeResolver({"a": artist("a")})
    graph = builder.build(playlist, [make_track("t1", "a")], resolver)

    assert [n.id for n in graph.nodes] == [UNCLASSIFIED]


def test_missing_metadata_is_unclassified_not_dropped(builder, playlist):
    graph = builder.build(playlist, [make_track("t1", "ghost")], FakeResolver())

    assert [n.id for n in graph.nodes] == [UNCLASSIFIED]
    assert graph.nodes[0].track_count == 1


def test_members_are_ordered_by_contribution(builder, playlist):
    resolver = FakeResolver(
        {
            "a": artist("a", "rap", name="Big"),
            "b": artist("b", "rap", name="Small"),
        }
    )
    tracks = [make_track("t1", "a", "b"), make_track("t2", "a"), make_track("t3", "a")]
    graph = builder.build(playlist, tracks, resolver)
    members = nodes_by_id(graph)["hip hop"].members

    assert [m["name"] for m in members] == ["Big", "Small"]
    assert [m["track_count"] for m in members] == [3, 1]
    assert members[0]["image_url"] == "http://img/a"


def test_node_image_falls_back_to_the_first_member_with_one(builder, playlist):
    resolver = FakeResolver(
        {
            "a": Artist(id="a", name="No picture", genres=["rap"], image_url=None),
            "b": artist("b", "rap"),
        }
    )
    tracks = [make_track("t1", "a"), make_track("t2", "a"), make_track("t3", "b")]
    graph = builder.build(playlist, tracks, resolver)

    # "a" contributes more and sorts first, but carries no image.
    assert nodes_by_id(graph)["hip hop"].image_url == "http://img/b"


def test_node_keeps_the_raw_labels_that_folded_into_it(builder, playlist):
    resolver = FakeResolver(
        {"a": artist("a", "toronto rap"), "b": artist("b", "canadian hip hop")}
    )
    graph = builder.build(playlist, [make_track("t1", "a", "b")], resolver)

    assert graph.nodes[0].genres == ["canadian hip hop", "toronto rap"]


def test_primary_genre_is_the_one_on_most_tracks(builder, playlist):
    resolver = FakeResolver({"a": artist("a", "rap"), "b": artist("b", "jazz")})
    tracks = [make_track("t1", "a"), make_track("t2", "a"), make_track("t3", "b")]
    graph = builder.build(playlist, tracks, resolver)

    assert [n.id for n in graph.nodes if n.is_primary] == ["hip hop"]


def test_genres_can_be_limited_to_connected_ones(playlist):
    builder = GenreNetworkBuilder(include_solo_artists=False, min_edge_weight=1)
    resolver = FakeResolver(
        {"a": artist("a", "rap"), "b": artist("b", "house"), "c": artist("c", "jazz")}
    )
    tracks = [make_track("t1", "a", "b"), make_track("t2", "c")]
    graph = builder.build(playlist, tracks, resolver)

    assert sorted(n.id for n in graph.nodes) == ["electronic", "hip hop"]


def test_payload_is_json_serialisable(builder, playlist):
    import json

    resolver = FakeResolver({"a": artist("a", "rap"), "b": artist("b", "house")})
    graph = builder.build(playlist, [make_track("t1", "a", "b")], resolver)
    payload = json.loads(json.dumps(graph.to_dict()))

    assert payload["mode"] == "genre"
    assert {"nodes", "links", "tracks", "stats"} <= payload.keys()
    assert payload["nodes"][0]["members"][0]["name"]
