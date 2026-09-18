"""HTML page routes.

These render shells only. Every page fetches its data from `/api/*` on the
client side, which keeps page loads instant and means the graph page can show
a real progress state while a first-time build runs.
"""

from __future__ import annotations

from flask import Blueprint, redirect, render_template, url_for

from app.auth.decorators import login_required
from app.auth.session import is_authenticated
from app.graph.builders import DEFAULT_MODE
from app.graph.models import LIKED_SONGS_ID

main_bp = Blueprint("main", __name__)


@main_bp.route("/")
def landing():
    if is_authenticated():
        return redirect(url_for("main.playlists"))
    return render_template("main/landing.html")


@main_bp.route("/playlists")
@login_required
def playlists():
    return render_template("main/playlists.html", liked_songs_id=LIKED_SONGS_ID)


@main_bp.route("/playlists/<playlist_id>/graph")
@login_required
def graph(playlist_id: str):
    return render_template(
        "main/graph.html",
        playlist_id=playlist_id,
        default_mode=DEFAULT_MODE,
    )


@main_bp.route("/healthz")
def healthz():
    """Liveness probe for whatever runs this in production."""
    return {"status": "ok"}
