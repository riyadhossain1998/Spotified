"""JSON API consumed by the frontend.

    GET    /api/me
    GET    /api/playlists?limit&offset
    GET    /api/playlists/<id>
    GET    /api/playlists/<id>/graph?mode&refresh
    GET    /api/playlists/<id>/graph/status?mode
    DELETE /api/playlists/<id>/graph?mode          -> drop cached graphs
    PUT    /api/playback/track/<track_id>
    GET    /api/modes
    GET    /api/cache                              (debug builds only)
"""

from __future__ import annotations

import logging

import spotipy
from flask import Blueprint, current_app, jsonify, request

from app.auth.decorators import api_login_required
from app.errors import PlaybackError
from app.graph import service as graph_service
from app.graph.builders import DEFAULT_MODE, available_modes
from app.graph.models import LIKED_SONGS_ID
from app.spotify import playlists as playlist_repo
from app.spotify.client import require_client
from app.storage.graph_store import get_store

logger = logging.getLogger(__name__)

api_bp = Blueprint("api", __name__)


def _bool_arg(name: str, default: bool = False) -> bool:
    raw = request.args.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes"}


@api_bp.get("/me")
@api_login_required
def me():
    from app.auth.session import current_user

    return jsonify(current_user() or {})


@api_bp.get("/modes")
def modes():
    return jsonify({"modes": available_modes(), "default": DEFAULT_MODE})


@api_bp.get("/playlists")
@api_login_required
def list_playlists():
    """One page of the user's playlists, with Liked Songs pinned first."""
    client = require_client()
    limit = min(int(request.args.get("limit", 50)), 50)
    offset = max(int(request.args.get("offset", 0)), 0)

    items, total = playlist_repo.list_user_playlists(client, limit=limit, offset=offset)
    payload = [p.to_dict() for p in items]

    if offset == 0:
        from app.spotify import library as library_repo

        try:
            liked = library_repo.liked_songs_ref(client)
            payload.insert(0, {**liked.to_dict(), "is_liked_songs": True})
        except spotipy.SpotifyException as exc:
            # Missing user-library-read is not worth failing the whole page for.
            logger.info("Skipping Liked Songs entry: %s", exc)

    return jsonify(
        {
            "items": payload,
            "total": total,
            "limit": limit,
            "offset": offset,
            "has_more": offset + len(items) < total,
        }
    )


@api_bp.get("/playlists/<playlist_id>")
@api_login_required
def get_playlist(playlist_id: str):
    client = require_client()
    if playlist_id == LIKED_SONGS_ID:
        from app.spotify import library as library_repo

        return jsonify(library_repo.liked_songs_ref(client).to_dict())
    return jsonify(playlist_repo.get_playlist_ref(client, playlist_id).to_dict())


@api_bp.get("/playlists/<playlist_id>/graph")
@api_login_required
def get_graph(playlist_id: str):
    """Serve the graph, building it on first request.

    This is the endpoint that implements "create the JSON if it doesn't exist
    already, otherwise read the cached copy".
    """
    client = require_client()
    mode = request.args.get("mode", DEFAULT_MODE)
    force = _bool_arg("refresh")

    result = graph_service.get_graph(client, playlist_id, mode, force_refresh=force)

    response = jsonify(result.payload)
    # Handy in devtools for confirming the cache is doing its job.
    response.headers["X-FN-Cache"] = "hit" if result.cached else "miss"
    if result.build_seconds is not None:
        response.headers["X-FN-Build-Seconds"] = str(result.build_seconds)
    return response


@api_bp.get("/playlists/<playlist_id>/graph/status")
@api_login_required
def graph_status(playlist_id: str):
    """Whether a build is needed, so the UI can warn before a slow first load."""
    client = require_client()
    mode = request.args.get("mode", DEFAULT_MODE)
    cached = graph_service.graph_is_cached(client, playlist_id, mode)
    return jsonify({"playlist_id": playlist_id, "mode": mode, "cached": cached})


@api_bp.delete("/playlists/<playlist_id>/graph")
@api_login_required
def invalidate_graph(playlist_id: str):
    mode = request.args.get("mode", DEFAULT_MODE)
    removed = get_store().invalidate(mode, playlist_id)
    return jsonify({"invalidated": removed, "playlist_id": playlist_id, "mode": mode})


@api_bp.put("/playback/track/<track_id>")
@api_login_required
def play_track(track_id: str):
    """Start playback of one track on the user's active device.

    Requires Premium plus an already-open Spotify client; Spotify has no way
    to wake a device from the API, so 404 here means "nothing is listening".
    """
    client = require_client()
    try:
        client.start_playback(uris=[f"spotify:track:{track_id}"])
    except spotipy.SpotifyException as exc:
        if exc.http_status == 404:
            raise PlaybackError(
                "No active Spotify device. Open Spotify on any device and try again."
            ) from exc
        if exc.http_status == 403:
            raise PlaybackError(
                "Playback control requires a Spotify Premium account."
            ) from exc
        raise

    return jsonify({"status": "playing", "track_id": track_id})


@api_bp.get("/cache")
@api_login_required
def cache_report():
    if not current_app.config["DEBUG"]:
        return jsonify({"error": "not_found", "message": "Debug endpoint."}), 404

    entries = get_store().entries()
    return jsonify(
        {
            "count": len(entries),
            "total_bytes": sum(e.size_bytes for e in entries),
            "entries": [
                {
                    "mode": e.mode,
                    "playlist_id": e.playlist_id,
                    "snapshot_id": e.snapshot_id,
                    "bytes": e.size_bytes,
                }
                for e in entries
            ],
        }
    )
