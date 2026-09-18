"""Route guards.

Two flavours because HTML pages should redirect to the login screen while
API endpoints must return a machine-readable 401 that the frontend can act
on (it redirects to /auth/login itself).
"""

from __future__ import annotations

from functools import wraps
from typing import Callable

from flask import jsonify, redirect, request, session, url_for

from app.auth.session import is_authenticated

NEXT_URL_KEY = "post_login_redirect"


def login_required(view: Callable):
    """For HTML routes: bounce anonymous visitors to the login page."""

    @wraps(view)
    def wrapper(*args, **kwargs):
        if not is_authenticated():
            session[NEXT_URL_KEY] = request.full_path
            return redirect(url_for("auth.login"))
        return view(*args, **kwargs)

    return wrapper


def api_login_required(view: Callable):
    """For JSON routes: return 401 with a login URL instead of a redirect."""

    @wraps(view)
    def wrapper(*args, **kwargs):
        if not is_authenticated():
            return (
                jsonify(
                    {
                        "error": "not_authenticated",
                        "message": "Spotify login required.",
                        "login_url": url_for("auth.login"),
                    }
                ),
                401,
            )
        return view(*args, **kwargs)

    return wrapper
