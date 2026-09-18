"""Artist metadata reads.

One `/v1/artists` call carries 50 ids, so a 100-artist playlist is two round
trips.

This was briefly rewritten to one request per artist, on the belief that the
2026-02 migration had withdrawn the batch endpoints along with
`/playlists/{id}/tracks`. It had not, and ~60 requests per graph is enough to
exhaust an app's rate limit -- at which point Spotify returns a long
`Retry-After` and every lookup fails, not merely some. Batching is a
correctness fix, not an optimisation. See docs/js/spotify/artists.js, which had
the same regression and the visible symptoms.

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

# Spotify's documented ceiling for /v1/artists.
MAX_IDS_PER_REQUEST = 50

# Batches in flight at once. Two cover most playlists, so this only bites on
# large ones -- and past a handful of concurrent batches the rate limit is back
# in play, which is the failure this module exists to avoid.
MAX_WORKERS = 3

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
    """Return {artist_id: Artist} for every id, 50 ids per request.

    An unresolved artist degrades gracefully: it is logged and skipped, and the
    builder falls back to the name on that artist's track credit, so one bad
    id cannot sink an entire graph build.
    """
    unique_ids = list(dict.fromkeys(i for i in artist_ids if i))
    if not unique_ids:
        return {}

    batches = [
        unique_ids[i : i + MAX_IDS_PER_REQUEST]
        for i in range(0, len(unique_ids), MAX_IDS_PER_REQUEST)
    ]

    def fetch_batch(ids: list[str]) -> list[Artist]:
        try:
            payload = client.artists(ids) or {}
        except spotipy.SpotifyException as exc:
            logger.warning("Artist batch of %s failed: %s", len(ids), exc)
            return []
        # Spotify answers positionally and writes null where an id resolved to
        # nothing, so one bad id costs that artist rather than the batch.
        return [_to_artist(p) for p in (payload.get("artists") or []) if p and p.get("id")]

    with ThreadPoolExecutor(max_workers=min(MAX_WORKERS, len(batches))) as pool:
        results = pool.map(fetch_batch, batches)

    resolved = {a.id: a for batch in results for a in batch}

    missing = len(unique_ids) - len(resolved)
    if missing:
        logger.info("No metadata returned for %s artist id(s)", missing)

    return resolved


def search_artist(client: spotipy.Spotify, name: str) -> Artist | None:
    """Name lookup. Not used by the graph pipeline; kept for tooling/scripts."""
    results = client.search(q=f"artist:{name}", type="artist", limit=1)
    items = ((results or {}).get("artists") or {}).get("items") or []
    return _to_artist(items[0]) if items else None
