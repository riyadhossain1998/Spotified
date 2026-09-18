"""The committed JS alias table must match the Python one.

The PKCE build cannot import Python, so `docs/js/graph/genreAliases.js` is a
generated copy of GENRE_ALIASES. Two copies drift; this makes the drift a test
failure at the moment a rule is added rather than a browser classifying
"moombahton" differently from the server.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

from export_genre_aliases import DESTINATION, render


def test_the_generated_alias_module_is_current():
    if not DESTINATION.exists():
        pytest.fail(f"{DESTINATION} is missing — run scripts/export_genre_aliases.py")

    assert DESTINATION.read_text(encoding="utf-8") == render(), (
        "docs/js/graph/genreAliases.js is stale — "
        "run scripts/export_genre_aliases.py and commit the result"
    )
