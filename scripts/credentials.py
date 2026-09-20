"""Client-credentials lookup for the offline build scripts.

The build scripts are the one part of this project that authenticates as the
*application* rather than as a signed-in user, so they need a client id and
secret on hand. Neither may be committed: this repository is public, and a
leaked secret is a leaked secret whether it sits in a config file or in a
comment.

Resolution order is environment first, macOS keychain second. Environment wins
so CI (or a one-off run against a different app) can override without touching
the machine's keychain, and the keychain exists so the normal case needs no
setup at all beyond a one-time store:

    security add-generic-password -a spotified -s spotify-client-id     -w '<id>'
    security add-generic-password -a spotified -s spotify-client-secret -w '<secret>'
"""

from __future__ import annotations

import os
import shutil
import subprocess

KEYCHAIN_ACCOUNT = "spotified"
ID_SERVICE = "spotify-client-id"
SECRET_SERVICE = "spotify-client-secret"


class MissingCredentials(RuntimeError):
    """Raised with instructions rather than letting Spotify answer 400."""


def _from_keychain(service: str) -> str | None:
    """Read one secret, or None if it is absent or this is not macOS.

    `check_output` rather than a shell pipeline on purpose. Piping `security`
    into another command hands the exit status to the *last* command in the
    pipe, so a failed lookup reports success -- a mistake already made once in
    this project, which produced a confident "credentials verified" for
    keychain entries that did not exist.
    """
    if not shutil.which("security"):
        return None
    try:
        value = subprocess.check_output(
            ["security", "find-generic-password", "-a", KEYCHAIN_ACCOUNT,
             "-s", service, "-w"],
            stderr=subprocess.DEVNULL,
            text=True,
        ).strip()
    except (subprocess.CalledProcessError, OSError):
        return None
    return value or None


def client_credentials() -> tuple[str, str]:
    """Return (client_id, client_secret) or raise with a usable message."""
    client_id = os.environ.get("SPOTIFY_CLIENT_ID") or _from_keychain(ID_SERVICE)
    secret = os.environ.get("SPOTIFY_CLIENT_SECRET") or _from_keychain(SECRET_SERVICE)

    missing = [
        name
        for name, value in (("SPOTIFY_CLIENT_ID", client_id),
                            ("SPOTIFY_CLIENT_SECRET", secret))
        if not value
    ]
    if missing:
        raise MissingCredentials(
            f"Missing {' and '.join(missing)}.\n"
            "Set them in the environment, or store them once in the keychain:\n"
            f"  security add-generic-password -a {KEYCHAIN_ACCOUNT} "
            f"-s {ID_SERVICE} -w '<client id>'\n"
            f"  security add-generic-password -a {KEYCHAIN_ACCOUNT} "
            f"-s {SECRET_SERVICE} -w '<client secret>'"
        )

    return client_id, secret  # type: ignore[return-value]
