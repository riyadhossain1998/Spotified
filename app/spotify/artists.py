"""Artist metadata reads.

This batched 50 ids into one `/v1/artists` call until Spotify removed every
batch endpoint in its 2026-02 migration. One request per artist is now the only
option, so the round trips run in a small thread pool instead of a sequential
loop -- that is the difference between a few seconds and the minutes gen 1 spent
here.

The disk cache in `app/storage/` is what keeps this off the hot path entirely: a
playlist is only resolved again when its snapshot_id changes.
"""

from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Sequence

import spotipy

from app.graph.models import Artist

logger = logging.getLogger(__name__)

# Enough to hide per-request latency without burst-tripping Spotify's rate
# limiter, which would cost more time in backoff than the parallelism saves.
MAX_WORKERS = 6

# Shown when an artist has no image on Spotify, so nodes never render broken.
PLACEHOLDER_IMAGE = (
    "data:image/svg+xml;utf8,"
    "<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'>"
    "<rect width='64' height='64' fill='%23333'/>"
    "<text x='32' y='40' font-size='28' text-anchor='middle' fill='%23888'>?</text>"
    "</svg>"
)


def _medium_image(images: list[dict] | None) -> str:
    """Pick a ~160px image: nodes render at 32-72px, so the 640px original
    is a waste of bandwidth times a few hundred artists."""
    if not images:
        return PLACEHOLDER_IMAGE
    ranked = sorted(images, key=lambda i: abs((i.get("width") or 320) - 160))
    return ranked[0]["url"]


def _to_artist(payload: dict[str, Any]) -> Artist:
    return Artist(
        id=payload["id"],
        name=payload.get("name") or "Unknown artist",
        popularity=int(payload.get("popularity") or 0),
        followers=int((payload.get("followers") or {}).get("total") or 0),
        genres=list(payload.get("genres") or []),
        image_url=_medium_image(payload.get("images")),
        profile_url=(payload.get("external_urls") or {}).get("spotify"),
    )


def fetch_artists(
    client: spotipy.Spotify, artist_ids: Sequence[str]
) -> dict[str, Artist]:
    """Return {artist_id: Artist} for every id, one request each.

    A failed artist degrades gracefully: it is logged and skipped, and the
    builder falls back to the name on that artist's track credit, so one bad
    id cannot sink an entire graph build.
    """
    unique_ids = list(dict.fromkeys(i for i in artist_ids if i))
    if not unique_ids:
        return {}

    def fetch_one(artist_id: str) -> Artist | None:
        try:
            return _to_artist(client.artist(artist_id))
        except spotipy.SpotifyException as exc:
            logger.warning("Artist lookup failed (%s): %s", artist_id, exc)
            return None

    with ThreadPoolExecutor(max_workers=min(MAX_WORKERS, len(unique_ids))) as pool:
        artists = pool.map(fetch_one, unique_ids)

    resolved = {a.id: a for a in artists if a is not None}

    missing = len(unique_ids) - len(resolved)
    if missing:
        logger.info("No metadata returned for %s artist id(s)", missing)

    return resolved


def search_artist(client: spotipy.Spotify, name: str) -> Artist | None:
    """Name lookup. Not used by the graph pipeline; kept for tooling/scripts."""
    results = client.search(q=f"artist:{name}", type="artist", limit=1)
    items = ((results or {}).get("artists") or {}).get("items") or []
    return _to_artist(items[0]) if items else None
