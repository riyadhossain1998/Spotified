"""Builder registry.

The single lookup table mapping a mode string to a builder class. Adding a
visualisation means adding a class and one line here; routes, caching and
templates pick it up automatically.
"""

from __future__ import annotations

from app.graph.builders.artist_network import ArtistNetworkBuilder
from app.graph.builders.base import GraphBuilder, MetadataResolver

DEFAULT_MODE = ArtistNetworkBuilder.mode

_REGISTRY: dict[str, type[GraphBuilder]] = {
    ArtistNetworkBuilder.mode: ArtistNetworkBuilder,
}


def get_builder_class(mode: str) -> type[GraphBuilder]:
    try:
        return _REGISTRY[mode]
    except KeyError:
        from app.errors import UnknownGraphMode

        raise UnknownGraphMode(
            f"Unknown graph mode {mode!r}. Available: {', '.join(sorted(_REGISTRY))}"
        ) from None


def available_modes() -> list[dict[str, object]]:
    """Describe every mode for the UI's view switcher."""
    return [
        {
            "mode": cls.mode,
            "label": cls.label,
            "description": cls.description,
            "available": cls.available,
        }
        for cls in _REGISTRY.values()
    ]


__all__ = [
    "DEFAULT_MODE",
    "ArtistNetworkBuilder",
    "GraphBuilder",
    "MetadataResolver",
    "available_modes",
    "get_builder_class",
]
