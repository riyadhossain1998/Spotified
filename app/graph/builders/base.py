"""Graph builder interface.

A builder turns (playlist, tracks) into a `Graph`. Making this a strategy
rather than a single function means a new way of classifying a playlist lands
as a new class plus one registry entry, with no changes to the service, cache,
API or template layers.

Contract for every builder:
  * `mode` is the stable string used in URLs and cache paths.
  * `build()` is pure with respect to the app: no Flask imports, no HTTP of
    its own. Anything it needs from Spotify arrives via `MetadataResolver`.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Protocol, Sequence

from app.graph.models import Artist, Graph, PlaylistRef, Track


class MetadataResolver(Protocol):
    """What a builder is allowed to ask the outside world for.

    Keeping this narrow means builders can be unit-tested with a dict-backed
    fake instead of a mocked HTTP client.
    """

    def artists(self, artist_ids: Sequence[str]) -> dict[str, Artist]:
        ...


class GraphBuilder(ABC):
    #: URL/cache identifier, e.g. "artist".
    mode: str = ""

    #: Shown in the UI's view switcher.
    label: str = ""
    description: str = ""

    #: Flip to True once a builder is ready for users. The view switcher
    #: renders unavailable modes as disabled rather than hiding them.
    available: bool = False

    def __init__(self, *, include_solo_artists: bool = True) -> None:
        self.include_solo_artists = include_solo_artists

    @abstractmethod
    def build(
        self,
        playlist: PlaylistRef,
        tracks: Sequence[Track],
        resolver: MetadataResolver,
    ) -> Graph:
        """Produce the graph payload for this playlist."""
        raise NotImplementedError
