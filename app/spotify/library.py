"""Saved ("Liked Songs") library reads.

Liked Songs are not a playlist: different endpoint, no `snapshot_id`, and the
contents change whenever the user hearts a track. This module adapts them into
the same `PlaylistRef` + `list[Track]` shape the builders already consume, so
the future "render my Liked Songs" feature needs no changes to the graph layer.

Cache invalidation is the only real difference. Without a snapshot_id we
synthesise one from (total_tracks, most_recent_added_at) -- both change on any
save or removal, which is good enough to detect staleness.
"""

from __future__ import annotations

import logging

import spotipy

from app.graph.models import LIKED_SONGS_ID, PlaylistRef, Track
from app.spotify.playlists import TRACK_PAGE_SIZE, _to_track

logger = logging.getLogger(__name__)

LIKED_FIELDS = (
    "next,total,items("
    "added_at,"
    "track("
    "id,name,popularity,duration_ms,explicit,preview_url,"
    "external_urls(spotify),artists(id,name),album(name,release_date,images)"
    ")"
    ")"
)


def fetch_liked_tracks(
    client: spotipy.Spotify, max_tracks: int | None = None
) -> list[Track]:
    tracks: dict[str, Track] = {}
    offset = 0
    while True:
        page = client.current_user_saved_tracks(limit=TRACK_PAGE_SIZE, offset=offset)
        items = page.get("items") or []
        if not items:
            break

        for item in items:
            track = _to_track(item)
            if track is not None:
                tracks.setdefault(track.id, track)

        offset += len(items)
        if max_tracks and len(tracks) >= max_tracks:
            break
        if not page.get("next"):
            break

    return list(tracks.values())


def liked_songs_ref(client: spotipy.Spotify) -> PlaylistRef:
    """Build a PlaylistRef standing in for the Liked Songs collection."""
    head = client.current_user_saved_tracks(limit=1)
    total = head.get("total", 0)
    items = head.get("items") or []
    latest = items[0].get("added_at") if items else "none"

    return PlaylistRef(
        id=LIKED_SONGS_ID,
        name="Liked Songs",
        snapshot_id=f"{total}-{latest}",  # synthetic; see module docstring
        track_count=total,
        owner_name="You",
        description="Every track you have saved.",
        image_url=None,
        spotify_url="https://open.spotify.com/collection/tracks",
        public=False,
    )
