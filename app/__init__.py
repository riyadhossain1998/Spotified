"""Application factory.

Everything is wired here and nowhere else: blueprints, error handlers,
logging and the graph cache. Nothing in `app.*` imports the Flask `app`
object at module scope, which keeps the package importable from tests and
scripts without spinning up a server.
"""

from __future__ import annotations

import logging
import sys

from flask import Flask

from config import BaseConfig, resolve_config


def create_app(config_name: str | None = None) -> Flask:
    app = Flask(__name__, instance_relative_config=False)

    config_class: type[BaseConfig] = resolve_config(config_name)
    app.config.from_object(config_class)

    _configure_logging(app)
    _validate_credentials(app)
    _register_blueprints(app)
    _register_error_handlers(app)
    _register_template_globals(app)

    app.config["CACHE_DIR"].mkdir(parents=True, exist_ok=True)
    app.logger.info("FeatureNetwork ready (config=%s)", config_class.__name__)
    return app


def _configure_logging(app: Flask) -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(
        logging.Formatter("[%(asctime)s] %(levelname)-7s %(name)s: %(message)s")
    )
    app.logger.handlers = [handler]
    app.logger.setLevel(app.config["LOG_LEVEL"])


def _validate_credentials(app: Flask) -> None:
    """Fail loudly at boot rather than cryptically at the OAuth redirect."""
    missing = [
        key
        for key in ("SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET")
        if not app.config.get(key)
    ]
    if missing:
        app.logger.warning(
            "Missing Spotify credentials: %s. Login will fail until these are "
            "set in your environment (see .env.example).",
            ", ".join(missing),
        )
    if app.config["SECRET_KEY"] == "dev-only-change-me" and not app.config["DEBUG"]:
        raise RuntimeError("FLASK_SECRET_KEY must be set outside of development.")


def _register_blueprints(app: Flask) -> None:
    from app.api.routes import api_bp
    from app.auth.routes import auth_bp
    from app.views.main import main_bp

    app.register_blueprint(main_bp)
    app.register_blueprint(auth_bp, url_prefix="/auth")
    app.register_blueprint(api_bp, url_prefix="/api")


def _register_error_handlers(app: Flask) -> None:
    from app.errors import register_error_handlers

    register_error_handlers(app)


def _register_template_globals(app: Flask) -> None:
    from app.auth.session import current_user

    @app.context_processor
    def inject_user() -> dict:
        return {"current_user": current_user()}
