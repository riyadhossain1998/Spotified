"""Convert a legacy (Gen 1) graph JSON into a Gen 2 demo payload.

The GitHub Pages demo has no server, so it needs a graph payload committed as a
static file. Rather than hand-writing one -- which would drift from the real
schema the moment `models.py` changes -- this runs the *actual*
ArtistNetworkBuilder over artists and tracks recovered from an old export. The
output is therefore guaranteed to be the same shape the live API returns.

    python scripts/make_demo_graph.py ../weeknd.json docs/demo-graph.json \
        --name "The Weeknd — Collaborations"

Two things are deliberately dropped:

* `preview_url` -- legacy preview links embed `?cid=<spotify client id>`, and
  this payload gets committed to a public repo.
* solo tracks -- Gen 1 only recorded a track name on *link* rows, so a track
  that never appeared in a pair has no recoverable name. Collaborations are
  what the demo is showing anyway.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path
from typing import Sequence

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.graph.builders.artist_network import ArtistNetworkBuilder
from app.graph.models import Artist, ArtistRef, PlaylistRef, Track


class DictResolver:
    """MetadataResolver backed by a dict instead of the Spotify API."""

    def __init__(self, artists: dict[str, Artist]):
        self._artists = artists

    def artists(self, artist_ids: Sequence[str]) -> dict[str, Artist]:
        return {aid: self._artists[aid] for aid in artist_ids if aid in self._artists}


def load_artists(nodes: list[dict]) -> dict[str, Artist]:
    artists: dict[str, Artist] = {}
    for node in nodes:
        artist_id = node.get("artist_id") or node.get("id")
        if not artist_id:
            continue
        artists[artist_id] = Artist(
            id=artist_id,
            name=node.get("name") or artist_id,
            popularity=node.get("popularity") or 0,
            followers=node.get("followers") or 0,
            genres=list(node.get("genres") or []),
            image_url=node.get("img_url") or node.get("image_url"),
            profile_url=node.get("profile_url"),
        )
    return artists


def load_tracks(links: list[dict], artists: dict[str, Artist]) -> list[Track]:
    """Rebuild tracks by unioning the endpoints of every link on that track."""
    credits: dict[str, set[str]] = defaultdict(set)
    meta: dict[str, dict] = {}

    for link in links:
        track_id = link.get("track_id")
        if not track_id:
            continue
        credits[track_id].update(
            value for value in (link.get("source"), link.get("target")) if value
        )
        # Every link row for one track carries the same track metadata.
        meta.setdefault(track_id, link)

    tracks = []
    for track_id, artist_ids in credits.items():
        row = meta[track_id]
        # Sort credits by follower count so the most prominent artist reads
        # first, approximating Spotify's own credit order.
        ordered = sorted(
            artist_ids,
            key=lambda aid: -(artists[aid].followers if aid in artists else 0),
        )
        tracks.append(
            Track(
                id=track_id,
                name=row.get("name") or "Unknown track",
                artists=[
                    ArtistRef(id=aid, name=artists[aid].name if aid in artists else aid)
                    for aid in ordered
                ],
                popularity=row.get("popularity") or 0,
                spotify_url=row.get("spotify_link") or row.get("spotify_url"),
                # preview_url intentionally omitted -- leaks a client id.
            )
        )
    return tracks


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="legacy graph JSON (nodes/links)")
    parser.add_argument("destination", type=Path, help="where to write the payload")
    parser.add_argument("--name", default="Demo Playlist", help="playlist display name")
    parser.add_argument(
        "--limit-artists",
        type=int,
        default=0,
        help="keep only the N best-connected artists (0 = keep all)",
    )
    args = parser.parse_args()

    legacy = json.loads(args.source.read_text(encoding="utf-8"))
    artists = load_artists(legacy.get("nodes", []))
    tracks = load_tracks(legacy.get("links", []), artists)

    if not tracks:
        print("No tracks recovered -- is this a Gen 1 graph export?", file=sys.stderr)
        return 1

    if args.limit_artists:
        appearances: dict[str, int] = defaultdict(int)
        for track in tracks:
            for artist_id in track.artist_ids:
                appearances[artist_id] += 1
        keep = {
            aid
            for aid, _ in sorted(appearances.items(), key=lambda kv: -kv[1])[
                : args.limit_artists
            ]
        }
        # Keep a track only if every credit survives, so no link dangles.
        tracks = [t for t in tracks if keep.issuperset(t.artist_ids)]

    playlist = PlaylistRef(
        id="demo",
        name=args.name,
        snapshot_id="demo",
        track_count=len(tracks),
        description="Static sample payload — the live app builds this from your own account.",
    )

    graph = ArtistNetworkBuilder().build(playlist, tracks, DictResolver(artists))
    payload = graph.to_dict()

    serialised = json.dumps(payload, separators=(",", ":"))
    if "cid=" in serialised or "client_secret" in serialised:
        print("Refusing to write: payload contains a credential.", file=sys.stderr)
        return 1

    args.destination.parent.mkdir(parents=True, exist_ok=True)
    args.destination.write_text(serialised, encoding="utf-8")

    stats = payload["stats"]
    print(
        f"Wrote {args.destination} "
        f"({len(serialised) / 1024:.0f} KB) — "
        f"{stats['artist_count']} artists, "
        f"{stats['connection_count']} connections, "
        f"{stats['track_count']} tracks"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
