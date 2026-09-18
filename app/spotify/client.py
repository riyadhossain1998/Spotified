"""Spotipy client construction.

Single place where OAuth managers and `spotipy.Spotify` instances are built,
so retry/timeout policy and token refresh live in exactly one spot.
"""

from __future__ import annotations

import spotipy
from flask import current_app
from spotipy.oauth2 import SpotifyOAuth

from app.auth.session import FlaskSessionCacheHandler


def build_oauth_manager(state: str | None = None) -> SpotifyOAuth:
    cfg = current_app.config
    return SpotifyOAuth(
        client_id=cfg["SPOTIFY_CLIENT_ID"],
        client_secret=cfg["SPOTIFY_CLIENT_SECRET"],
        redirect_uri=cfg["SPOTIFY_REDIRECT_URI"],
        scope=cfg["SPOTIFY_SCOPES"],
        cache_handler=FlaskSessionCacheHandler(),
        state=state,
        show_dialog=False,
    )


def spotify_client() -> spotipy.Spotify | None:
    """Return an authenticated client for the current session, or None.

    `validate_token` transparently refreshes an expired access token using
    the stored refresh token and writes the new token back to the session.
    """
    oauth = build_oauth_manager()
    token_info = oauth.cache_handler.get_cached_token()
    if not token_info:
        return None

    token_info = oauth.validate_token(token_info)
    if not token_info:
        return None

    cfg = current_app.config
    return spotipy.Spotify(
        auth=token_info["access_token"],
        requests_timeout=cfg["SPOTIFY_REQUEST_TIMEOUT"],
        retries=cfg["SPOTIFY_MAX_RETRIES"],
    )


def require_client() -> spotipy.Spotify:
    """Like `spotify_client` but raises instead of returning None.

    Use inside routes already protected by a login decorator.
    """
    client = spotify_client()
    if client is None:
        from app.errors import AuthenticationRequired

        raise AuthenticationRequired("No valid Spotify token in session.")
    return client
