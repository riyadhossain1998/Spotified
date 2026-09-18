"""Spotify OAuth 2.0 Authorization Code flow.

    /auth/login     -> redirect to Spotify's consent screen
    /auth/callback  -> exchange ?code for tokens, store in session
    /auth/logout    -> drop the session
"""

from __future__ import annotations

import secrets

from flask import (
    Blueprint,
    current_app,
    flash,
    redirect,
    render_template,
    request,
    session,
    url_for,
)

from app.auth.decorators import NEXT_URL_KEY
from app.auth.session import clear_session, store_profile
from app.spotify.client import build_oauth_manager, spotify_client

auth_bp = Blueprint("auth", __name__, template_folder="../templates/auth")

STATE_KEY = "oauth_state"


@auth_bp.route("/login")
def login():
    """Kick off the OAuth dance.

    `state` is a CSRF guard: we generate it, hand it to Spotify, and refuse
    the callback if what comes back doesn't match what we stored.
    """
    state = secrets.token_urlsafe(24)
    session[STATE_KEY] = state

    oauth = build_oauth_manager(state=state)
    return redirect(oauth.get_authorize_url())


@auth_bp.route("/callback")
def callback():
    error = request.args.get("error")
    if error:
        current_app.logger.warning("Spotify denied authorisation: %s", error)
        flash("Spotify login was cancelled or denied.", "error")
        return redirect(url_for("main.landing"))

    expected_state = session.pop(STATE_KEY, None)
    returned_state = request.args.get("state")
    if not expected_state or expected_state != returned_state:
        current_app.logger.warning("OAuth state mismatch - possible CSRF attempt.")
        flash("Login failed a security check. Please try again.", "error")
        return redirect(url_for("main.landing"))

    code = request.args.get("code")
    if not code:
        flash("Spotify did not return an authorisation code.", "error")
        return redirect(url_for("main.landing"))

    oauth = build_oauth_manager()
    # `as_dict=False` returns the access token string; the full token dict is
    # written to our session cache handler as a side effect.
    oauth.get_access_token(code, as_dict=False, check_cache=False)

    client = spotify_client()
    if client is None:
        flash("Could not establish a Spotify session.", "error")
        return redirect(url_for("main.landing"))

    store_profile(client.current_user())

    destination = session.pop(NEXT_URL_KEY, None) or url_for("main.playlists")
    return redirect(destination)


@auth_bp.route("/logout")
def logout():
    clear_session()
    flash("Signed out.", "info")
    return redirect(url_for("main.landing"))
