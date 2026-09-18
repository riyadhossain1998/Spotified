"""Playlist reads: the user's playlists, and the tracks inside one.

One notable difference from the previous generation: the `fields` mask below
requests album data (`release_date`, `images`) and `duration_ms` in the same
call that fetches the tracks. Gen 1 used a narrower mask and then made one
extra `sp.track()` call per track to backfill those fields -- a second pass
over hundreds of tracks. Asking for them up front removes that entire step.
"""

from __future__ import annotations

import logging
from typing import Any, Iterator

import spotipy

from app.graph.models import ArtistRef, PlaylistRef, Track

logger = logging.getLogger(__name__)

PAGE_SIZE = 50            # Spotify's max for playlist listings
TRACK_PAGE_SIZE = 100     # Spotify's max for playlist items

TRACK_FIELDS = (
    "next,items("
    "added_at,"
    "track("
    "id,name,popularity,duration_ms,explicit,preview_url,"
    "external_urls(spotify),"
    "artists(id,name),"
    "album(name,release_date,images)"
    ")"
    ")"
)


def _first_image(images: list[dict] | None) -> str | None:
    return images[0]["url"] if images else None


def _smallest_image(images: list[dict] | None) -> str | None:
    """Album art is only shown as a thumbnail, so take the cheapest size."""
    if not images:
        return None
    return min(images, key=lambda i: i.get("width") or 10_000)["url"]


def to_playlist_ref(payload: dict[str, Any]) -> PlaylistRef:
    return PlaylistRef(
        id=payload["id"],
        name=payload.get("name") or "Untitled playlist",
        snapshot_id=payload.get("snapshot_id", ""),
        track_count=(payload.get("tracks") or {}).get("total", 0),
        owner_name=(payload.get("owner") or {}).get("display_name"),
        description=payload.get("description") or None,
        image_url=_first_image(payload.get("images")),
        spotify_url=(payload.get("external_urls") or {}).get("spotify"),
        public=payload.get("public"),
        collaborative=bool(payload.get("collaborative")),
    )


def list_user_playlists(
    client: spotipy.Spotify, limit: int = PAGE_SIZE, offset: int = 0
) -> tuple[list[PlaylistRef], int]:
    """Return one page of the current user's playlists plus the grand total."""
    page = client.current_user_playlists(limit=min(limit, PAGE_SIZE), offset=offset)
    items = [to_playlist_ref(p) for p in page.get("items", []) if p]
    return items, page.get("total", len(items))


def list_all_user_playlists(client: spotipy.Spotify) -> list[PlaylistRef]:
    """Walk every page. Most accounts are a handful of requests."""
    playlists: list[PlaylistRef] = []
    offset = 0
    while True:
        page, total = list_user_playlists(client, limit=PAGE_SIZE, offset=offset)
        playlists.extend(page)
        offset += len(page)
        if not page or offset >= total:
            break
    return playlists


def get_playlist_ref(client: spotipy.Spotify, playlist_id: str) -> PlaylistRef:
    payload = client.playlist(
        playlist_id,
        fields="id,name,snapshot_id,description,public,collaborative,"
        "images,external_urls(spotify),owner(display_name),tracks(total)",
    )
    return to_playlist_ref(payload)


def _to_track(item: dict[str, Any]) -> Track | None:
    """Map one playlist item to a Track, or None if it isn't usable.

    Items get skipped when they are local files, podcast episodes, or tracks
    removed from the catalogue -- all of which arrive with a null id.
    """
    raw = item.get("track")
    if not raw or not raw.get("id"):
        return None

    artists = [
        ArtistRef(id=a["id"], name=a.get("name", "Unknown"))
        for a in (raw.get("artists") or [])
        if a and a.get("id")
    ]
    if not artists:
        return None

    album = raw.get("album") or {}
    return Track(
        id=raw["id"],
        name=raw.get("name") or "Untitled",
        artists=artists,
        popularity=int(raw.get("popularity") or 0),
        duration_ms=int(raw.get("duration_ms") or 0),
        explicit=bool(raw.get("explicit")),
        preview_url=raw.get("preview_url"),
        spotify_url=(raw.get("external_urls") or {}).get("spotify"),
        album_name=album.get("name"),
        album_art_url=_smallest_image(album.get("images")),
        release_date=album.get("release_date"),
        added_at=item.get("added_at"),
    )


def iter_playlist_tracks(
    client: spotipy.Spotify, playlist_id: str, max_tracks: int | None = None
) -> Iterator[Track]:
    """Stream every playable track in a playlist.

    Pagination follows the `next` field rather than comparing an accumulated
    offset against a total. Gen 1 used `while offset != pl_length`, which
    could overshoot and loop forever if the playlist changed mid-fetch.
    """
    offset = 0
    yielded = 0
    while True:
        page = client.playlist_items(
            playlist_id,
            limit=TRACK_PAGE_SIZE,
            offset=offset,
            fields=TRACK_FIELDS,
            additional_types=("track",),
        )
        items = page.get("items") or []
        if not items:
            return

        for item in items:
            track = _to_track(item)
            if track is None:
                continue
            yield track
            yielded += 1
            if max_tracks and yielded >= max_tracks:
                logger.info("Hit MAX_PLAYLIST_TRACKS ceiling (%s)", max_tracks)
                return

        offset += len(items)
        if not page.get("next"):
            return


def fetch_playlist_tracks(
    client: spotipy.Spotify, playlist_id: str, max_tracks: int | None = None
) -> list[Track]:
    """Materialise all tracks, de-duplicated by track id.

    Discography playlists routinely contain the same song twice (album cut
    plus a deluxe/remaster). Counting it once keeps collab weights honest.
    """
    seen: dict[str, Track] = {}
    for track in iter_playlist_tracks(client, playlist_id, max_tracks=max_tracks):
        seen.setdefault(track.id, track)
    return list(seen.values())
