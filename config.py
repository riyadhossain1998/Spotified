"""Application configuration.

Config is resolved from environment variables so that nothing secret ever
lands in the repository. See `.env.example` for the required keys.
"""

from __future__ import annotations

import os
from datetime import timedelta
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent


def _env_bool(key: str, default: bool = False) -> bool:
    raw = os.environ.get(key)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


class BaseConfig:
    """Settings shared by every environment."""

    # --- Flask ---------------------------------------------------------
    SECRET_KEY = os.environ.get("FLASK_SECRET_KEY", "dev-only-change-me")
    SESSION_COOKIE_NAME = "featurenetwork_session"
    SESSION_COOKIE_HTTPONLY = True
    SESSION_COOKIE_SAMESITE = "Lax"
    PERMANENT_SESSION_LIFETIME = timedelta(days=7)
    JSON_SORT_KEYS = False

    # --- Spotify OAuth -------------------------------------------------
    SPOTIFY_CLIENT_ID = os.environ.get("SPOTIFY_CLIENT_ID")
    SPOTIFY_CLIENT_SECRET = os.environ.get("SPOTIFY_CLIENT_SECRET")
    SPOTIFY_REDIRECT_URI = os.environ.get(
        "SPOTIFY_REDIRECT_URI", "http://127.0.0.1:5000/auth/callback"
    )

    # Scopes are additive: the MVP needs playlist reads; playback and
    # library scopes are requested now so the "play track" and future
    # "liked songs" features do not require users to re-consent later.
    SPOTIFY_SCOPES = " ".join(
        [
            "user-read-private",
            "user-read-email",
            "playlist-read-private",
            "playlist-read-collaborative",
            "user-library-read",          # future: render Liked Songs
            "user-top-read",              # future: personalised weighting
            "user-read-playback-state",
            "user-modify-playback-state",
        ]
    )

    # --- Spotify HTTP behaviour ---------------------------------------
    SPOTIFY_REQUEST_TIMEOUT = int(os.environ.get("SPOTIFY_REQUEST_TIMEOUT", 20))
    SPOTIFY_MAX_RETRIES = int(os.environ.get("SPOTIFY_MAX_RETRIES", 3))

    # --- Graph cache ---------------------------------------------------
    # Graphs are keyed by (mode, playlist_id, snapshot_id). Spotify bumps
    # snapshot_id on every playlist mutation, which gives us free and exact
    # cache invalidation.
    CACHE_DIR = Path(os.environ.get("FN_CACHE_DIR", BASE_DIR / "data" / "cache" / "graphs"))
    CACHE_KEEP_SNAPSHOTS = int(os.environ.get("FN_CACHE_KEEP_SNAPSHOTS", 3))
    CACHE_ENABLED = _env_bool("FN_CACHE_ENABLED", True)

    # --- Graph building ------------------------------------------------
    # Hard ceiling so a 10k-track playlist cannot hang a request thread.
    MAX_PLAYLIST_TRACKS = int(os.environ.get("FN_MAX_PLAYLIST_TRACKS", 2000))
    # Keep artists who only appear on solo tracks. They render as isolated
    # nodes, which the UI can hide via a toggle.
    INCLUDE_SOLO_ARTISTS = _env_bool("FN_INCLUDE_SOLO_ARTISTS", True)

    LOG_LEVEL = os.environ.get("FN_LOG_LEVEL", "INFO")


class DevelopmentConfig(BaseConfig):
    DEBUG = True
    TEMPLATES_AUTO_RELOAD = True


class ProductionConfig(BaseConfig):
    DEBUG = False
    SESSION_COOKIE_SECURE = True
    PREFERRED_URL_SCHEME = "https"


class TestingConfig(BaseConfig):
    TESTING = True
    SECRET_KEY = "testing"
    CACHE_DIR = BASE_DIR / "data" / "cache" / "_test_graphs"
    SPOTIFY_CLIENT_ID = "test-client-id"
    SPOTIFY_CLIENT_SECRET = "test-client-secret"


CONFIG_MAP = {
    "development": DevelopmentConfig,
    "production": ProductionConfig,
    "testing": TestingConfig,
}


def resolve_config(name: str | None = None) -> type[BaseConfig]:
    name = name or os.environ.get("FLASK_ENV", "development")
    return CONFIG_MAP.get(name, DevelopmentConfig)
