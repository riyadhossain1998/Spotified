"""Build the static graph payloads the homepage serves.

Reads a list of Spotify playlist ids and writes one graph JSON per playlist
into `docs/graphs/`, plus an `index.json` manifest the homepage uses to render
its picker.

    python scripts/build_graphs.py                    # everything in playlists.json
    python scripts/build_graphs.py --only drake       # one entry, by slug
    python scripts/build_graphs.py --dry-run          # fetch and report, write nothing

Why this authenticates as the app, not as a user
------------------------------------------------
Measured 2026-09-20: a **client-credentials** token reads any *public*
playlist's items in full -- name, duration, popularity, album art, release
date, and every artist credit -- including playlists the app does not own.
This was previously recorded in project notes as impossible, on the strength of
a 403 that only ever occurred on a PKCE *user* token. It is not impossible, and
the distinction matters enormously here: it means these payloads are built
with no login, no redirect, and no exposure to the 5-user cap that Spotify's
Development Mode imposes forever on this app.

Why it reuses the live code path
--------------------------------
`fetch_playlist_tracks`, `fetch_artists` and `ArtistNetworkBuilder` are the
same functions the Flask app runs against a signed-in user. Nothing here
reimplements them, so a static payload cannot drift from the shape the
renderer expects -- the failure mode that hand-written fixtures invite. This
follows `make_demo_graph.py`, which established the pattern.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Sequence

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import spotipy
from spotipy.oauth2 import SpotifyClientCredentials

from app.graph.builders.artist_network import ArtistNetworkBuilder
from app.graph.models import Artist
from app.spotify.artists import fetch_artists
from app.spotify.playlists import fetch_playlist_tracks, get_playlist_ref
from scripts.credentials import MissingCredentials, client_credentials

ROOT = Path(__file__).resolve().parents[1]
CONFIG = Path(__file__).resolve().parent / "playlists.json"
OUTPUT_DIR = ROOT / "docs" / "graphs"

REQUEST_TIMEOUT = 20
MAX_RETRIES = 5


# ----------------------------------------------------------------------
# Schema trimming
# ----------------------------------------------------------------------
#
# The builder emits a superset of what the renderer reads, because the same
# payload also feeds the live app. For a file committed to a public repo and
# downloaded by every visitor, anything nothing reads is dead weight, so it is
# stripped on the way out.
#
# Trimming happens *after* `summarise()` rather than by changing the
# dataclasses, for two reasons. The statistics are computed from fields that
# are themselves dropped -- `release_year_histogram` reads `release_year`, and
# `explicit_ratio` reads `explicit` -- so removing them upstream would silently
# empty the very numbers they produce. And `PlaylistRef.to_dict()` is shared
# with the playlist picker in the Flask app, which does read `collaborative`.
#
# Each entry is dropped for one of two reasons, and the distinction is worth
# keeping straight: DERIVABLE means the renderer can rebuild it from data still
# present, so the capability survives the removal; UNUSED means nothing reads it
# anywhere.

DROP_FROM_PLAYLIST = (
    "public",        # UNUSED -- meaningless for a file already published
    "collaborative", # UNUSED -- same
    "owner_id",      # UNUSED, and a personal identifier with no business here
)

DROP_FROM_STATS = (
    "top_collaborators",  # DERIVABLE -- nodes sorted by collab_count
    "top_pairs",          # DERIVABLE -- links sorted by collab_count
)

DROP_FROM_NODE = (
    "profile_url",  # DERIVABLE -- "https://open.spotify.com/artist/" + node.id
)

DROP_FROM_TRACK = (
    "release_year",  # DERIVABLE -- release_date[:4], which is what the UI shows
    "preview_url",   # UNUSED, and Spotify embeds the app's client id in it
)


def trim(payload: dict[str, Any]) -> dict[str, Any]:
    """Strip fields no renderer reads. See the note above for the rationale."""
    for key in DROP_FROM_PLAYLIST:
        payload["playlist"].pop(key, None)
    for key in DROP_FROM_STATS:
        payload["stats"].pop(key, None)
    for node in payload["nodes"]:
        for key in DROP_FROM_NODE:
            node.pop(key, None)
    for track in payload["tracks"].values():
        for key in DROP_FROM_TRACK:
            track.pop(key, None)
    return payload


# ----------------------------------------------------------------------
# Build
# ----------------------------------------------------------------------


class ApiResolver:
    """MetadataResolver backed by the live batch endpoint."""

    def __init__(self, client: spotipy.Spotify):
        self._client = client

    def artists(self, artist_ids: Sequence[str]) -> dict[str, Artist]:
        return fetch_artists(self._client, artist_ids)


def build_client() -> spotipy.Spotify:
    client_id, client_secret = client_credentials()
    auth = SpotifyClientCredentials(
        client_id=client_id, client_secret=client_secret
    )
    return spotipy.Spotify(
        auth_manager=auth,
        requests_timeout=REQUEST_TIMEOUT,
        # Higher than the app's default: this walks thousands of items in one
        # run against a per-*app* rate limit, and a retry costs seconds here
        # versus a failed build.
        retries=MAX_RETRIES,
    )


def build_one(client: spotipy.Spotify, entry: dict[str, str]) -> dict[str, Any]:
    """Fetch one playlist and return its trimmed graph payload."""
    playlist = get_playlist_ref(client, entry["playlist_id"])
    tracks = fetch_playlist_tracks(client, entry["playlist_id"])
    if not tracks:
        raise RuntimeError(f"{entry['slug']}: playlist returned no playable tracks")

    # The display name comes from the config, not from Spotify: these
    # playlists are titled for the owner's own library ("Beatdrops - RH"),
    # which is not what a visitor should see on a picker.
    playlist.name = entry["name"]

    graph = ArtistNetworkBuilder().build(playlist, tracks, ApiResolver(client))
    return trim(graph.to_dict())


def serialise(payload: dict[str, Any], slug: str) -> str:
    """Minify, and refuse to emit anything carrying a credential.

    Inherited from `make_demo_graph.py` and kept deliberately: legacy preview
    links embed `?cid=<client id>`, and this file is committed to a public
    repository. The check is cheap and the failure it prevents is not.
    """
    text = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
    if "cid=" in text or "client_secret" in text:
        raise RuntimeError(f"{slug}: refusing to write, payload contains a credential")
    return text


def manifest_entry(entry: dict[str, str], payload: dict[str, Any]) -> dict[str, Any]:
    """One picker tile: enough to render it without loading the graph itself.

    `image_url` is the playlist's own cover rather than an artist photo, so the
    homepage needs no extra API call and compilation playlists (which have no
    single artist) still get a tile.
    """
    stats = payload["stats"]
    primary = next((n for n in payload["nodes"] if n.get("is_primary")), None)
    return {
        "slug": entry["slug"],
        "name": entry["name"],
        "file": f"{entry['slug']}.json",
        "image_url": payload["playlist"].get("image_url"),
        "primary_artist": primary["label"] if primary else None,
        "track_count": stats["track_count"],
        "artist_count": stats["artist_count"],
        "connection_count": stats["connection_count"],
        "collaboration_track_count": stats["collaboration_track_count"],
        # Lets a later run tell whether the stored graph is stale without
        # re-walking the whole playlist.
        "snapshot_id": payload["playlist"].get("snapshot_id"),
        "generated_at": payload["generated_at"],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=CONFIG)
    parser.add_argument("--output", type=Path, default=OUTPUT_DIR)
    parser.add_argument("--only", action="append", help="slug to build (repeatable)")
    parser.add_argument("--dry-run", action="store_true", help="fetch but write nothing")
    args = parser.parse_args()

    entries = json.loads(args.config.read_text(encoding="utf-8"))
    if args.only:
        wanted = set(args.only)
        entries = [e for e in entries if e["slug"] in wanted]
        unknown = wanted - {e["slug"] for e in entries}
        if unknown:
            print(f"Unknown slug(s): {', '.join(sorted(unknown))}", file=sys.stderr)
            return 1
    if not entries:
        print("Nothing to build.", file=sys.stderr)
        return 1

    try:
        client = build_client()
    except MissingCredentials as exc:
        print(exc, file=sys.stderr)
        return 1

    args.output.mkdir(parents=True, exist_ok=True)

    manifest: list[dict[str, Any]] = []
    failures: list[str] = []

    for entry in entries:
        slug = entry["slug"]
        try:
            payload = build_one(client, entry)
            text = serialise(payload, slug)
        except Exception as exc:  # noqa: BLE001 -- one bad playlist must not sink the run
            failures.append(f"{slug}: {exc}")
            print(f"  {slug:18} FAILED  {exc}", file=sys.stderr)
            continue

        stats = payload["stats"]
        if not args.dry_run:
            (args.output / f"{slug}.json").write_text(text, encoding="utf-8")
        manifest.append(manifest_entry(entry, payload))

        print(
            f"  {slug:18} {len(text)/1024:6.0f} KB  "
            f"{stats['artist_count']:4} artists  "
            f"{stats['connection_count']:5} links  "
            f"{stats['track_count']:4} tracks"
        )

    # Only rewrite the manifest on a full, successful run. A partial manifest
    # would silently remove working tiles from the homepage because one
    # unrelated playlist happened to fail.
    if not args.dry_run and manifest and not failures:
        (args.output / "index.json").write_text(
            json.dumps(manifest, separators=(",", ":"), ensure_ascii=False),
            encoding="utf-8",
        )

    total = sum(len(json.dumps(m)) for m in manifest)
    print(f"\n{len(manifest)} built, manifest {total/1024:.1f} KB", end="")
    if failures:
        print(f", {len(failures)} FAILED -- manifest not rewritten")
        return 1
    print(" -- manifest written" if not args.dry_run else " (dry run)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
