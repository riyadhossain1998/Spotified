"""Genre classification view -- scaffolded, not yet enabled.

The plan, recorded here so the shape of the work is settled before it starts:

Spotify attaches genres to *artists*, never to tracks. So a track's genres are
the union of its credited artists' genres, which is noisy -- one Drake feature
drags in "canadian hip hop", "rap", "hip hop", "pop rap". Two problems to solve
before this is useful:

1. Normalisation. Collapse the long tail into a controlled vocabulary
   ("canadian hip hop" -> "hip hop"). `GENRE_ALIASES` below is the seed; it
   wants to become a curated mapping plus a "rollup by last word" heuristic.

2. Edge semantics. Genre-to-genre edges should mean "a track bridges these two
   genres", weighted by how many tracks do so. Without a minimum weight the
   graph is a hairball, hence `min_edge_weight`.

The hierarchy this builds (genre -> sub-genre -> artist -> track) is also the
input for the Zoomable Circle Packing view, so `build_hierarchy` is kept
separate from `build` and will be reused there.
"""

from __future__ import annotations

from collections import defaultdict
from typing import Any, Sequence

from app.graph.builders.base import GraphBuilder, MetadataResolver
from app.graph.models import Graph, PlaylistRef, Track

# Seed vocabulary. Longest match wins, so order matters within a family.
GENRE_ALIASES: dict[str, str] = {
    "hip hop": "hip hop",
    "rap": "hip hop",
    "trap": "hip hop",
    "drill": "hip hop",
    "r&b": "r&b",
    "soul": "r&b",
    "pop": "pop",
    "rock": "rock",
    "metal": "rock",
    "house": "electronic",
    "edm": "electronic",
    "techno": "electronic",
    "country": "country",
    "jazz": "jazz",
    "reggae": "reggae",
    "afro": "afrobeats",
    "latin": "latin",
    "reggaeton": "latin",
}

UNCLASSIFIED = "unclassified"


def normalise_genre(raw: str) -> str:
    """Fold a Spotify micro-genre into a top-level bucket."""
    needle = raw.lower()
    for fragment, canonical in GENRE_ALIASES.items():
        if fragment in needle:
            return canonical
    return raw.lower()


class GenreNetworkBuilder(GraphBuilder):
    mode = "genre"
    label = "Genres"
    description = "Genres connected by tracks that span more than one of them."
    available = False  # flip once normalisation is tuned

    def __init__(self, *, include_solo_artists: bool = True, min_edge_weight: int = 2):
        super().__init__(include_solo_artists=include_solo_artists)
        self.min_edge_weight = min_edge_weight

    def build(
        self,
        playlist: PlaylistRef,
        tracks: Sequence[Track],
        resolver: MetadataResolver,
    ) -> Graph:
        raise NotImplementedError(
            "Genre mode is not implemented yet. See the module docstring for the plan."
        )

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
