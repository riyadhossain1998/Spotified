"""Artist metadata reads.

Gen 1 called `sp.artist(id)` once per artist -- a 156-node graph meant 156
sequential HTTP round trips, which is most of why generation took minutes.
Spotify's `/v1/artists` endpoint accepts 50 ids per call, so the same graph
now costs 4 requests.
"""

from __future__ import annotations

import logging
from typing import Any, Iterable, Sequence

import spotipy

from app.graph.models import Artist

logger = logging.getLogger(__name__)

BATCH_SIZE = 50

# Shown when an artist has no image on Spotify, so nodes never render broken.
PLACEHOLDER_IMAGE = (
    "data:image/svg+xml;utf8,"
    "<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'>"
    "<rect width='64' height='64' fill='%23333'/>"
    "<text x='32' y='40' font-size='28' text-anchor='middle' fill='%23888'>?</text>"
    "</svg>"
)


def _chunk(items: Sequence[str], size: int) -> Iterable[Sequence[str]]:
    for i in range(0, len(items), size):
        yield items[i : i + size]


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
    """Return {artist_id: Artist} for every id, batched 50 at a time.

    A failed batch degrades gracefully: we log it and carry on, so one bad
    id cannot sink an entire graph build.
    """
    unique_ids = list(dict.fromkeys(i for i in artist_ids if i))
    resolved: dict[str, Artist] = {}

    for batch in _chunk(unique_ids, BATCH_SIZE):
        try:
            response = client.artists(list(batch))
        except spotipy.SpotifyException as exc:
            logger.warning("Artist batch failed (%s ids): %s", len(batch), exc)
            continue

        for payload in response.get("artists") or []:
            if payload and payload.get("id"):
                resolved[payload["id"]] = _to_artist(payload)

    missing = set(unique_ids) - resolved.keys()
    if missing:
        logger.info("No metadata returned for %s artist id(s)", len(missing))

    return resolved


def search_artist(client: spotipy.Spotify, name: str) -> Artist | None:
    """Name lookup. Not used by the graph pipeline; kept for tooling/scripts."""
    results = client.search(q=f"artist:{name}", type="artist", limit=1)
    items = ((results or {}).get("artists") or {}).get("items") or []
    return _to_artist(items[0]) if items else None
