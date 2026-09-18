"""Genre network: the same force layout as the artist view, one zoom out.

Spotify attaches genres to *artists*, never to tracks, and it attaches a lot of
them -- Drake alone carries "canadian hip hop", "canadian pop", "hip hop",
"pop", "rap" and "toronto rap". Two problems follow, and the file is organised
around them:

1. Normalisation. Left alone, one 88-artist playlist produces 37 groups, 27 of
   which hold a single artist ("hauntology", "fluxwork", "wonky" -- all of them
   one musician). `GENRE_ALIASES` folds the long tail into a controlled
   vocabulary; `normalise_genre` explains why the match is longest-first.

2. Edge semantics. An edge means "one track spans these two genres", weighted
   by how many tracks do. `min_edge_weight` keeps a playlist that touches
   twenty genres from drawing every possible pair.

The hierarchy in `build_hierarchy` (genre -> artist -> track) is the input for
the Zoomable Circle Packing view, so it stays separate from `build` and shares
only the normalisation above.
"""

from __future__ import annotations

import logging
from collections import defaultdict
from typing import Any, Sequence

from app.graph.analytics import summarise
from app.graph.builders.base import GraphBuilder, MetadataResolver
from app.graph.models import Graph, GraphLink, GraphNode, PlaylistRef, Track

logger = logging.getLogger(__name__)

# Controlled vocabulary: a fragment that may appear anywhere in a Spotify
# label, and the bucket it implies. One "rap" entry catches "toronto rap",
# "canadian hip hop" and "pop rap" at once, which is why this stays small
# despite Spotify's several thousand labels.
#
# The longest matching fragment wins -- see normalise_genre -- so a compound
# that would otherwise be swallowed by a shorter rule gets its own entry and
# is guaranteed to beat it. Exactly five entries below depend on that, in the
# sense that first-match would send them somewhere else:
#
#   "reggaeton"    beats "reggae"  -> latin, not reggae
#   "dancehall"    beats "dance"   -> reggae, not electronic
#   "dance pop"    beats "dance"   -> pop, not electronic
#   "k-pop"        beats "pop"     -> k-pop
#   "korean pop"   beats "pop"     -> k-pop
#   "j-pop"        beats "pop"     -> j-pop
#   "nigerian pop" beats "pop"     -> afrobeats
#
# That check only sees one fragment containing another. Two unrelated
# fragments matching the same label is a separate problem, and the reason
# WEAK_ALIASES exists.
#
# test_genre_network_builder.py asserts that list is complete, so adding a
# rule that shadows another fails the suite rather than quietly reclassifying
# something.
GENRE_ALIASES: dict[str, str] = {
    # hip hop
    "hip hop": "hip hop",
    "rap": "hip hop",
    "trap": "hip hop",
    "drill": "hip hop",
    "crunk": "hip hop",
    "chopped and screwed": "hip hop",
    "grime": "hip hop",
    # r&b
    "r&b": "r&b",
    "soul": "r&b",
    "urban contemporary": "r&b",
    "new jack swing": "r&b",
    # pop
    "pop": "pop",
    "dance pop": "pop",
    # rock
    "rock": "rock",
    "metal": "rock",
    "punk": "rock",
    "grunge": "rock",
    "shoegaze": "rock",
    # electronic -- by far the biggest catchment, because Spotify splits
    # dance music into more micro-labels than everything else combined.
    "house": "electronic",
    "edm": "electronic",
    "techno": "electronic",
    "electro": "electronic",
    "tronica": "electronic",  # electronica, indietronica
    "dance": "electronic",
    "rave": "electronic",
    "dubstep": "electronic",
    "brostep": "electronic",
    "moombahton": "electronic",
    "garage": "electronic",
    "big room": "electronic",
    "future bass": "electronic",
    "bounce": "electronic",
    "trip hop": "electronic",
    "downtempo": "electronic",
    "ambient": "electronic",
    "drone": "electronic",
    "idm": "electronic",
    "intelligent dance music": "electronic",
    "basshall": "electronic",
    "baile": "electronic",
    # Spotify's genuinely strange corners, all of them experimental
    # electronic music under a name only its algorithm uses.
    "escape room": "electronic",
    "wonky": "electronic",
    "hauntology": "electronic",
    "fluxwork": "electronic",
    "vaporwave": "electronic",
    "clubbing": "electronic",
    "french touch": "electronic",
    # everything else
    "country": "country",
    "jazz": "jazz",
    "saxophone": "jazz",
    "blues": "blues",
    "folk": "folk",
    "classical": "classical",
    "reggae": "reggae",
    "dancehall": "reggae",
    "afro": "afrobeats",
    "amapiano": "afrobeats",
    "nigerian pop": "afrobeats",
    "latin": "latin",
    "reggaeton": "latin",
    "salsa": "latin",
    "bachata": "latin",
    "k-pop": "k-pop",
    "korean pop": "k-pop",
    "j-pop": "j-pop",
}

# Rules that describe the act rather than the music, applied only to a label
# no rule above claimed.
#
# They cannot live in the table above because the longest match wins there, and
# length is a proxy for specificity that these break: "k-pop girl group" offers
# ten characters of "girl group" against five of "k-pop", so a Korean act lands
# in pop. The two fragments do not contain one another, so this is invisible to
# the shadowing check -- it is two unrelated rules matching one label, not one
# rule swallowing another.
#
# Demoting them rather than deleting them keeps the signal: for a label like
# "british boy band" there is nothing else to go on, and pop is right.
WEAK_ALIASES: dict[str, str] = {
    "boy band": "pop",
    "girl group": "pop",
}

UNCLASSIFIED = "unclassified"

# Precomputed once: longest fragment first, so the scan in normalise_genre can
# return on its first hit and still be the longest match.
_ALIASES_BY_LENGTH: list[tuple[str, str]] = sorted(
    GENRE_ALIASES.items(), key=lambda kv: -len(kv[0])
)
_WEAK_BY_LENGTH: list[tuple[str, str]] = sorted(
    WEAK_ALIASES.items(), key=lambda kv: -len(kv[0])
)


def normalise_genre(raw: str) -> str:
    """Fold a Spotify micro-genre into a top-level bucket.

    Longest match rather than first match. Substring rules overlap constantly
    -- "reggaeton" contains "reggae", "dancehall" contains "dance" -- and with
    first-match the answer depends on dictionary ordering, which is invisible
    at the call site and silently wrong (reggaeton classified as reggae). Under
    longest-match the more specific rule always wins, so adding an entry can
    only ever refine the result, never reorder an existing one.

    Length only stands in for specificity among rules that actually name a
    genre, which is why WEAK_ALIASES is a second pass rather than more entries
    in the same table: "girl group" is longer than "k-pop" without being more
    specific about the music.

    Unrecognised labels are returned lowercased rather than bucketed, so a
    genre this vocabulary has never seen still appears instead of vanishing.
    """
    needle = raw.lower()
    for fragment, canonical in _ALIASES_BY_LENGTH:
        if fragment in needle:
            return canonical
    for fragment, canonical in _WEAK_BY_LENGTH:
        if fragment in needle:
            return canonical
    return needle


class GenreNetworkBuilder(GraphBuilder):
    mode = "genre"
    label = "Genres"
    description = "Genres connected by tracks that span more than one of them."
    available = True

    #: How many member faces the renderer tiles into a node. Members beyond
    #: this are still sent -- the detail panel lists them all -- but the
    #: builder uses it to pick the node's fallback single image.
    MOSAIC_SIZE = 4

    def __init__(self, *, include_solo_artists: bool = True, min_edge_weight: int = 2):
        super().__init__(include_solo_artists=include_solo_artists)
        self.min_edge_weight = min_edge_weight

    def build(
        self,
        playlist: PlaylistRef,
        tracks: Sequence[Track],
        resolver: MetadataResolver,
    ) -> Graph:
        artist_ids = {aid for track in tracks for aid in track.artist_ids}
        metadata = resolver.artists(list(artist_ids))

        # Resolve each artist once. Every later step reads this rather than
        # re-normalising, which keeps the cost linear in credits rather than
        # in credits x genres.
        artist_genres = {aid: self._buckets_for(metadata.get(aid)) for aid in artist_ids}

        genre_tracks: dict[str, set[str]] = defaultdict(set)
        genre_artists: dict[str, dict[str, set[str]]] = defaultdict(
            lambda: defaultdict(set)
        )
        raw_labels: dict[str, set[str]] = defaultdict(set)

        for track in tracks:
            for artist_id in set(track.artist_ids):
                for genre in artist_genres[artist_id]:
                    genre_tracks[genre].add(track.id)
                    genre_artists[genre][artist_id].add(track.id)

        for artist_id, buckets in artist_genres.items():
            meta = metadata.get(artist_id)
            for raw in meta.genres if meta else []:
                raw_labels[normalise_genre(raw)].add(raw)

        links = self._build_links(tracks, artist_genres)
        node_ids = self._select_node_ids(genre_tracks, links)
        degree, collabs = self._degree_and_collabs(links)
        primary_id = max(
            node_ids, key=lambda g: len(genre_tracks[g]), default=None
        )

        nodes: list[GraphNode] = []
        for genre in node_ids:
            members = self._members(genre_artists[genre], metadata)
            nodes.append(
                GraphNode(
                    id=genre,
                    label=genre,
                    track_ids=sorted(genre_tracks[genre]),
                    degree=degree.get(genre, 0),
                    collab_count=collabs.get(genre, 0),
                    # A single image so anything expecting one still has it;
                    # `members` is what the mosaic actually draws.
                    image_url=next(
                        (m["image_url"] for m in members if m["image_url"]), None
                    ),
                    # The Spotify labels that folded in here, which is the only
                    # way to see that "hip hop" absorbed "toronto rap".
                    genres=sorted(raw_labels.get(genre, ())),
                    is_primary=genre == primary_id,
                    members=members,
                )
            )

        nodes.sort(key=lambda n: (-n.track_count, n.label))

        track_index = {t.id: t for t in tracks}
        graph = Graph(
            mode=self.mode,
            playlist=playlist,
            nodes=nodes,
            links=links,
            tracks=track_index,
        )
        graph.stats = summarise(graph)

        logger.info(
            "Built genre graph for %r: %s tracks -> %s genres, %s links",
            playlist.name,
            len(tracks),
            len(nodes),
            len(links),
        )
        return graph

    # ------------------------------------------------------------------
    # Steps
    # ------------------------------------------------------------------

    @staticmethod
    def _buckets_for(artist: Any | None) -> set[str]:
        """The canonical genres one artist contributes.

        An artist with no genres is not dropped: Spotify simply has no opinion
        about roughly one in seven of them, and silently losing their tracks
        would make the genre totals disagree with the playlist length.
        """
        if artist is None or not artist.genres:
            return {UNCLASSIFIED}
        return {normalise_genre(g) for g in artist.genres}

    def _build_links(
        self,
        tracks: Sequence[Track],
        artist_genres: dict[str, set[str]],
    ) -> list[GraphLink]:
        """Edges are tracks that span two genres.

        The unit is the *track*, not the artist pair: one song credited to a
        rapper and a house producer is a single hip hop--electronic bridge no
        matter how many artists carry each label. Taking the union of the
        track's credited genres first, then pairing, is what collapses that.

        A solo artist who carries two genres bridges them on their own, which
        is deliberate -- The Weeknd being both r&b and pop is a real fact
        about the playlist, not an artefact of collaboration.
        """
        pairs: dict[tuple[str, str], set[str]] = defaultdict(set)

        for track in tracks:
            genres = sorted(
                {g for aid in set(track.artist_ids) for g in artist_genres[aid]}
            )
            for i in range(len(genres)):
                for j in range(i + 1, len(genres)):
                    pairs[(genres[i], genres[j])].add(track.id)

        return [
            GraphLink(source=source, target=target, track_ids=sorted(track_ids))
            for (source, target), track_ids in pairs.items()
            if len(track_ids) >= self.min_edge_weight
        ]

    def _select_node_ids(
        self,
        genre_tracks: dict[str, set[str]],
        links: Sequence[GraphLink],
    ) -> list[str]:
        """Which genres become nodes.

        Mirrors the artist builder: everything by default, and with
        `include_solo_artists` off, only genres an edge survived on. Note that
        a genre can be isolated here purely because `min_edge_weight` pruned
        its only bridge, not because nothing links it.
        """
        if self.include_solo_artists:
            return list(genre_tracks.keys())

        connected = {g for link in links for g in (link.source, link.target)}
        return [g for g in genre_tracks if g in connected]

    @staticmethod
    def _degree_and_collabs(
        links: Sequence[GraphLink],
    ) -> tuple[dict[str, int], dict[str, int]]:
        """degree = genres bridged to; collab_count = bridging tracks."""
        degree: dict[str, int] = defaultdict(int)
        collabs: dict[str, int] = defaultdict(int)

        for link in links:
            degree[link.source] += 1
            degree[link.target] += 1
            collabs[link.source] += link.collab_count
            collabs[link.target] += link.collab_count

        return dict(degree), dict(collabs)

    @staticmethod
    def _members(
        artists: dict[str, set[str]],
        metadata: dict[str, Any],
    ) -> list[dict[str, Any]]:
        """Artists inside one genre, biggest contributor first.

        All of them, not just the four the mosaic draws: the detail panel
        lists the genre's full membership, and a build-time cap is not
        recoverable at render time.
        """
        ordered = sorted(artists.items(), key=lambda kv: (-len(kv[1]), kv[0]))
        members = []
        for artist_id, track_ids in ordered:
            meta = metadata.get(artist_id)
            members.append(
                {
                    "id": artist_id,
                    "name": meta.name if meta else "Unknown artist",
                    "image_url": meta.image_url if meta else None,
                    "track_count": len(track_ids),
                }
            )
        return members

    # ------------------------------------------------------------------
    # Shared with the future circle-packing view
    # ------------------------------------------------------------------

    def build_hierarchy(
        self,
        tracks: Sequence[Track],
        resolver: MetadataResolver,
    ) -> dict[str, Any]:
        """Nested genre -> artist -> track structure for d3.hierarchy().

        Already usable: this is the exact shape `d3.pack()` expects, so the
        Zoomable Circle Packing view can be built on top of it before the
        force-directed genre graph is finished.
        """
        artist_ids = {aid for track in tracks for aid in track.artist_ids}
        metadata = resolver.artists(list(artist_ids))

        # genre -> artist_id -> [track]
        buckets: dict[str, dict[str, list[Track]]] = defaultdict(
            lambda: defaultdict(list)
        )

        for track in tracks:
            for artist_id in set(track.artist_ids):
                artist = metadata.get(artist_id)
                genres = (
                    {normalise_genre(g) for g in artist.genres}
                    if artist and artist.genres
                    else {UNCLASSIFIED}
                )
                for genre in genres:
                    buckets[genre][artist_id].append(track)

        return {
            "name": "playlist",
            "children": [
                {
                    "name": genre,
                    "children": [
                        {
                            "name": (
                                metadata[aid].name if aid in metadata else "Unknown"
                            ),
                            "id": aid,
                            "children": [
                                {
                                    "name": t.name,
                                    "id": t.id,
                                    "value": max(t.popularity, 1),
                                }
                                for t in tracks_for_artist
                            ],
                        }
                        for aid, tracks_for_artist in sorted(
                            artists.items(), key=lambda kv: -len(kv[1])
                        )
                    ],
                }
                for genre, artists in sorted(
                    buckets.items(), key=lambda kv: -len(kv[1])
                )
            ],
        }
