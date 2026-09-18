"""Token storage backed by the Flask session.

The previous generation of this project used spotipy's default file cache
(`.cache-<user_id>` on disk), which meant one hardcoded user per server and
a live OAuth token committed next to the source. Storing the token in the
signed session cookie instead makes the app genuinely multi-user and keeps
credentials out of the filesystem.

If/when this moves behind a real deployment, swap `FlaskSessionCacheHandler`
for a Redis-backed handler -- the interface is the same and nothing else in
the codebase needs to change.
"""

from __future__ import annotations

from typing import Any

from flask import session
from spotipy.cache_handler import CacheHandler

TOKEN_KEY = "spotify_token"
PROFILE_KEY = "spotify_profile"


class FlaskSessionCacheHandler(CacheHandler):
    """Persists the spotipy token dict inside the Flask session."""

    def get_cached_token(self) -> dict[str, Any] | None:
        return session.get(TOKEN_KEY)

    def save_token_to_cache(self, token_info: dict[str, Any]) -> None:
        session[TOKEN_KEY] = token_info
        session.permanent = True


def store_profile(profile: dict[str, Any]) -> None:
    """Cache the display fields we need so every page render isn't an API call."""
    images = profile.get("images") or []
    session[PROFILE_KEY] = {
        "id": profile.get("id"),
        "display_name": profile.get("display_name") or profile.get("id"),
        "email": profile.get("email"),
        "product": profile.get("product"),  # "premium" gates playback control
        "image_url": images[0]["url"] if images else None,
        "profile_url": (profile.get("external_urls") or {}).get("spotify"),
    }


def current_user() -> dict[str, Any] | None:
    return session.get(PROFILE_KEY)


def is_authenticated() -> bool:
    return TOKEN_KEY in session


def clear_session() -> None:
    session.pop(TOKEN_KEY, None)
    session.pop(PROFILE_KEY, None)
