"""Artist collaboration network -- the MVP view.

Nodes are artists. An edge exists between two artists when they are both
credited on at least one track in the playlist, and it carries the list of
tracks they share.

Algorithm
---------
For each track, sort the credited artist ids and emit every unordered pair::

    ["A", "B", "C"]  ->  (A,B) (A,C) (B,C)

Sorting first is what makes the pair canonical: without it the same
collaboration shows up as both (A,B) and (B,A) and gets drawn twice. Pairs
accumulate into a dict keyed by the pair, so `collab_count` falls out of
`len(track_ids)` for free -- no separate counting pass.

The nested loop is O(k^2) in the number of credits on a single track, where k
is almost always under six, so cost is effectively linear in playlist length.
"""

from __future__ import annotations

import logging
from collections import defaultdict
from typing import Sequence

from app.graph.analytics import summarise
from app.graph.builders.base import GraphBuilder, MetadataResolver
from app.graph.models import Graph, GraphLink, GraphNode, PlaylistRef, Track

logger = logging.getLogger(__name__)


class ArtistNetworkBuilder(GraphBuilder):
    mode = "artist"
    label = "Artists"
    description = "Artists connected by the songs they appear on together."
    available = True

    def build(
        self,
        playlist: PlaylistRef,
        tracks: Sequence[Track],
        resolver: MetadataResolver,
    ) -> Graph:
        pair_tracks = self._collect_pairs(tracks)
        artist_tracks = self._collect_artist_tracks(tracks)

        node_ids = self._select_node_ids(pair_tracks, artist_tracks)
        metadata = resolver.artists(list(node_ids))

        links = [
            GraphLink(source=source, target=target, track_ids=track_ids)
            for (source, target), track_ids in pair_tracks.items()
            if source in node_ids and target in node_ids
        ]

        degree, collabs = self._degree_and_collabs(links)
        primary_id = self._primary_artist_id(artist_tracks, node_ids)

        nodes: list[GraphNode] = []
        for artist_id in node_ids:
            meta = metadata.get(artist_id)
            fallback_name = self._fallback_name(artist_id, tracks)
            nodes.append(
                GraphNode(
                    id=artist_id,
                    label=meta.name if meta else fallback_name,
                    track_ids=sorted(artist_tracks.get(artist_id, set())),
                    degree=degree.get(artist_id, 0),
                    collab_count=collabs.get(artist_id, 0),
                    image_url=meta.image_url if meta else None,
                    profile_url=meta.profile_url if meta else None,
                    popularity=meta.popularity if meta else 0,
                    followers=meta.followers if meta else 0,
                    genres=meta.genres if meta else [],
                    is_primary=artist_id == primary_id,
                )
            )

        # Biggest contributors first: a stable order means the force
        # simulation lays the same playlist out the same way every time.
        nodes.sort(key=lambda n: (-n.track_count, n.label.lower()))

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
            "Built artist graph for %r: %s tracks -> %s nodes, %s links",
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
    def _collect_pairs(
        tracks: Sequence[Track],
    ) -> dict[tuple[str, str], list[str]]:
        """Map every canonical artist pair to the tracks they share."""
        pairs: dict[tuple[str, str], list[str]] = defaultdict(list)

        for track in tracks:
            # `set` first: an artist occasionally appears twice in the credits
            # of one track, which would otherwise create a self-loop.
            artist_ids = sorted(set(track.artist_ids))
            for i in range(len(artist_ids)):
                for j in range(i + 1, len(artist_ids)):
                    pairs[(artist_ids[i], artist_ids[j])].append(track.id)

        return dict(pairs)

    @staticmethod
    def _collect_artist_tracks(tracks: Sequence[Track]) -> dict[str, set[str]]:
        """Map every artist to the tracks they appear on."""
        artist_tracks: dict[str, set[str]] = defaultdict(set)
        for track in tracks:
            for artist_id in set(track.artist_ids):
                artist_tracks[artist_id].add(track.id)
        return dict(artist_tracks)

    def _select_node_ids(
        self,
        pair_tracks: dict[tuple[str, str], list[str]],
        artist_tracks: dict[str, set[str]],
    ) -> list[str]:
        """Decide which artists become nodes.

        Gen 1 derived nodes from the links, which silently dropped every
        artist whose tracks were all solo. We keep them by default (they
        render as isolated nodes the UI can toggle off) because dropping
        data at build time is not recoverable at render time.
        """
        if self.include_solo_artists:
            return list(artist_tracks.keys())

        connected: set[str] = set()
        for source, target in pair_tracks:
            connected.add(source)
            connected.add(target)
        return [aid for aid in artist_tracks if aid in connected]

    @staticmethod
    def _degree_and_collabs(
        links: Sequence[GraphLink],
    ) -> tuple[dict[str, int], dict[str, int]]:
        """degree = distinct collaborators; collab_count = collab tracks."""
        degree: dict[str, int] = defaultdict(int)
        collabs: dict[str, int] = defaultdict(int)

        for link in links:
            degree[link.source] += 1
            degree[link.target] += 1
            collabs[link.source] += link.collab_count
            collabs[link.target] += link.collab_count

        return dict(degree), dict(collabs)

    @staticmethod
    def _primary_artist_id(
        artist_tracks: dict[str, set[str]], node_ids: Sequence[str]
    ) -> str | None:
        """The artist on the most tracks.

        For a discography playlist this is the artist the playlist is about,
        so the UI can pin/highlight them without being told who it is.
        """
        candidates = [(aid, len(artist_tracks.get(aid, ()))) for aid in node_ids]
        if not candidates:
            return None
        return max(candidates, key=lambda pair: pair[1])[0]

    @staticmethod
    def _fallback_name(artist_id: str, tracks: Sequence[Track]) -> str:
        """Use the credit name when the artist endpoint returned nothing."""
        for track in tracks:
            for artist in track.artists:
                if artist.id == artist_id:
                    return artist.name
        return "Unknown artist"
