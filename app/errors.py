"""Application exceptions and their HTTP translation.

Domain code raises these; this module is the only place that decides what
status code and body a client sees. API routes get JSON, page routes get a
rendered template, decided by the request path.
"""

from __future__ import annotations

import logging

import spotipy
from flask import Flask, jsonify, redirect, render_template, request, url_for
from werkzeug.exceptions import HTTPException

logger = logging.getLogger(__name__)


class AppError(Exception):
    """Base class for expected, user-facing failures."""

    status_code = 500
    error_code = "internal_error"

    def __init__(self, message: str = "Something went wrong."):
        super().__init__(message)
        self.message = message


class AuthenticationRequired(AppError):
    status_code = 401
    error_code = "not_authenticated"


class UnknownGraphMode(AppError):
    status_code = 400
    error_code = "unknown_mode"


class ModeUnavailable(AppError):
    status_code = 409
    error_code = "mode_unavailable"


class EmptyPlaylist(AppError):
    status_code = 422
    error_code = "empty_playlist"


class PlaylistNotFound(AppError):
    status_code = 404
    error_code = "playlist_not_found"


class PlaylistNotReadable(AppError):
    """Spotify will not serve this playlist's contents to this user.

    403 rather than 404: the playlist exists and its metadata was just read
    successfully. Only the items are out of reach.
    """

    status_code = 403
    error_code = "playlist_not_readable"


class PlaybackError(AppError):
    status_code = 409
    error_code = "playback_failed"


def _wants_json() -> bool:
    return request.path.startswith("/api/") or request.accept_mimetypes.best == "application/json"


def register_error_handlers(app: Flask) -> None:
    @app.errorhandler(AppError)
    def handle_app_error(exc: AppError):
        logger.info("%s: %s", exc.error_code, exc.message)

        if isinstance(exc, AuthenticationRequired) and not _wants_json():
            return redirect(url_for("auth.login"))

        if _wants_json():
            return (
                jsonify({"error": exc.error_code, "message": exc.message}),
                exc.status_code,
            )
        return (
            render_template(
                "errors/generic.html", message=exc.message, status=exc.status_code
            ),
            exc.status_code,
        )

    @app.errorhandler(spotipy.SpotifyException)
    def handle_spotify_error(exc: spotipy.SpotifyException):
        """Translate upstream Spotify failures into something actionable."""
        status = exc.http_status or 502

        if status == 401:
            # Token rejected -- almost always a revoked grant or a scope the
            # user consented to before we started requesting it.
            message = "Your Spotify session expired. Please sign in again."
            code = "not_authenticated"
            if not _wants_json():
                return redirect(url_for("auth.logout"))
        elif status == 403:
            message = (
                "Spotify refused the request. Playback control requires a "
                "Premium account and an active device."
            )
            code = "forbidden"
        elif status == 404:
            message = "Spotify could not find that playlist or device."
            code = "not_found"
        elif status == 429:
            message = "Rate limited by Spotify. Wait a moment and retry."
            code = "rate_limited"
        else:
            message = "Spotify request failed."
            code = "spotify_error"

        logger.warning("SpotifyException %s: %s", status, exc.msg)

        if _wants_json():
            return jsonify({"error": code, "message": message}), status
        return render_template("errors/generic.html", message=message, status=status), status

    @app.errorhandler(HTTPException)
    def handle_http_error(exc: HTTPException):
        if _wants_json():
            return (
                jsonify({"error": exc.name.lower().replace(" ", "_"), "message": exc.description}),
                exc.code or 500,
            )
        template = "errors/404.html" if exc.code == 404 else "errors/generic.html"
        return (
            render_template(template, message=exc.description, status=exc.code),
            exc.code or 500,
        )

    @app.errorhandler(Exception)
    def handle_unexpected(exc: Exception):
        logger.exception("Unhandled exception: %s", exc)
        if app.config.get("DEBUG"):
            raise exc
        if _wants_json():
            return jsonify({"error": "internal_error", "message": "Unexpected error."}), 500
        return render_template("errors/generic.html", message="Unexpected error.", status=500), 500
