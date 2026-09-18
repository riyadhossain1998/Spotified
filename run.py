"""Development entry point.

    python run.py

For production use a WSGI server instead:

    gunicorn "app:create_app()" --bind 0.0.0.0:8000
"""

from __future__ import annotations

import os

from dotenv import load_dotenv

load_dotenv()  # must run before `create_app` reads config from the environment

from app import create_app  # noqa: E402  (import after env is loaded)

app = create_app()


if __name__ == "__main__":
    app.run(
        host=os.environ.get("FN_HOST", "127.0.0.1"),
        port=int(os.environ.get("FN_PORT", 5000)),
        debug=app.config["DEBUG"],
    )
