"""Graph orchestration -- the seam between HTTP and the domain.

Responsibilities, in order:

    1. resolve the playlist (and therefore its snapshot_id)
    2. try the cache
    3. on a miss: fetch tracks, run the builder, cache the result

Routes call only this module. They never touch spotipy, builders or the store
directly, which keeps the "generate if absent, otherwise serve cached" rule in
exactly one place.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from typing import Any, Sequence

import spotipy
from flask import current_app

from app.graph.builders import DEFAULT_MODE, get_builder_class
from app.graph.models import LIKED_SONGS_ID, Artist, PlaylistRef, Track
from app.spotify import artists as artist_repo
from app.spotify import library as library_repo
from app.spotify import playlists as playlist_repo
from app.storage.graph_store import get_store

logger = logging.getLogger(__name__)


class SpotifyMetadataResolver:
    """Adapts the Spotify repositories to the builders' `MetadataResolver`.

    Memoised per instance so two builders in one request (or a builder that
    asks twice) do not repeat the same batched lookups.
    """

    def __init__(self, client: spotipy.Spotify):
        self._client = client
        self._artist_cache: dict[str, Artist] = {}

    def artists(self, artist_ids: Sequence[str]) -> dict[str, Artist]:
        wanted = [aid for aid in dict.fromkeys(artist_ids) if aid]
        missing = [aid for aid in wanted if aid not in self._artist_cache]

        if missing:
            self._artist_cache.update(artist_repo.fetch_artists(self._client, missing))

        return {aid: self._artist_cache[aid] for aid in wanted if aid in self._artist_cache}


@dataclass(frozen=True, slots=True)
class GraphResult:
    """A graph payload plus how we got it, so the UI can say "cached"."""

    payload: dict[str, Any]
    cached: bool
    build_seconds: float | None = None

    @property
    def playlist_name(self) -> str:
        return (self.payload.get("playlist") or {}).get("name", "Playlist")


def _load_source(
    client: spotipy.Spotify, playlist_id: str
) -> tuple[PlaylistRef, list[Track]]:
    """Resolve a playlist id to its metadata and tracks.

    The Liked Songs sentinel routes to a different endpoint but returns the
    same shape, so nothing downstream has to special-case it.
    """
    max_tracks = current_app.config["MAX_PLAYLIST_TRACKS"]

    if playlist_id == LIKED_SONGS_ID:
        return (
            library_repo.liked_songs_ref(client),
            library_repo.fetch_liked_tracks(client, max_tracks=max_tracks),
        )

    return (
        playlist_repo.get_playlist_ref(client, playlist_id),
        playlist_repo.fetch_playlist_tracks(client, playlist_id, max_tracks=max_tracks),
    )


def _resolve_ref(client: spotipy.Spotify, playlist_id: str) -> PlaylistRef:
    """Cheap metadata-only fetch, used to get snapshot_id before a cache probe."""
    if playlist_id == LIKED_SONGS_ID:
        return library_repo.liked_songs_ref(client)
    return playlist_repo.get_playlist_ref(client, playlist_id)


def get_graph(
    client: spotipy.Spotify,
    playlist_id: str,
    mode: str = DEFAULT_MODE,
    *,
    force_refresh: bool = False,
    user_id: str | None = None,
) -> GraphResult:
    """Return the graph for a playlist, building and caching it if needed.

    `user_id` is the signed-in Spotify account, used only to reject playlists
    Spotify will not hand over. Passed in rather than read from the session so
    this stays callable off a request.
    """
    builder_class = get_builder_class(mode)
    if not builder_class.available:
        from app.errors import ModeUnavailable

        raise ModeUnavailable(f"Graph mode {mode!r} is not available yet.")

    store = get_store()

    # One cheap request buys us the snapshot_id, which is the cache key. Worth
    # it: a hit then skips fetching hundreds of tracks and all artist metadata.
    ref = _resolve_ref(client, playlist_id)

    # Before the cache probe, not after: a graph cached from an earlier visit
    # cannot be refreshed once Spotify stops serving the items, so answering
    # from it would only promise a playlist that can never be rebuilt.
    if not ref.readable_by(user_id):
        from app.errors import PlaylistNotReadable

        raise PlaylistNotReadable(
            f"{ref.name!r} belongs to {ref.owner_name or 'another Spotify user'}. "
            "Since February 2026 Spotify only lets apps read playlists you own "
            "or collaborate on. To graph it, open it in Spotify, select every "
            "track, and add them to a new playlist of your own — then build the "
            "graph from that copy."
        )

    if not force_refresh:
        cached = store.get(mode, playlist_id, ref.snapshot_id)
        if cached is not None:
            return GraphResult(payload=cached, cached=True)

    started = time.perf_counter()
    playlist, tracks = _load_source(client, playlist_id)

    if not tracks:
        from app.errors import EmptyPlaylist

        raise EmptyPlaylist(f"{playlist.name!r} has no playable tracks to graph.")

    builder = builder_class(
        include_solo_artists=current_app.config["INCLUDE_SOLO_ARTISTS"]
    )
    graph = builder.build(playlist, tracks, SpotifyMetadataResolver(client))
    payload = graph.to_dict()
    elapsed = time.perf_counter() - started

    store.put(mode, playlist_id, playlist.snapshot_id, payload)

    logger.info(
        "Generated %s graph for %r in %.2fs", mode, playlist.name, elapsed
    )
    return GraphResult(payload=payload, cached=False, build_seconds=round(elapsed, 2))


def graph_is_cached(
    client: spotipy.Spotify, playlist_id: str, mode: str = DEFAULT_MODE
) -> bool:
    """Whether a current graph already exists, without building one.

    Lets the playlist grid badge which playlists render instantly.
    """
    ref = _resolve_ref(client, playlist_id)
    return get_store().get(mode, playlist_id, ref.snapshot_id) is not None
